import { sha256CanonicalJson } from "@packscout/contracts";
import {
  DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
  DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
  type DataReleaseV3ActiveState,
  type DataReleaseV3PublicationPort,
  type DataReleaseV3PublishPlan,
  type DataReleaseV3Receipt,
} from "./buyback-adjusted-ev-release-types.ts";

/**
 * data_release_v3 release publisher (task buyback-adjusted-ev/008).
 *
 * Drives one assembled plan through the transport port: start, deterministic
 * batches, finalize with full reconciliation, verification read-back, and the
 * single atomic activation that changes the public pointer. Every operation
 * id is a pure function of the release identity, so an identical replay of
 * the same plan converges without new writes, while any conflicting replay is
 * refused server-side before the active pointer can move. A failed publish
 * never activates; the previously active release stays retained for the
 * environment-scoped rollback this publisher also drives.
 */

export type DataReleaseV3PublishOutcome =
  | Readonly<{
      outcome: "unchanged";
      publicReleaseId: string;
      releaseFingerprint: string;
    }>
  | Readonly<{
      outcome: "activated";
      publicReleaseId: string;
      releaseFingerprint: string;
      generation: number;
      previousPublicReleaseId: string | null;
      receipts: Readonly<{
        start: DataReleaseV3Receipt;
        finalize: DataReleaseV3Receipt;
        activate: DataReleaseV3Receipt;
      }>;
    }>;

export type DataReleaseV3PublisherErrorStage =
  | "active_state"
  | "start"
  | "apply_batch"
  | "finalize"
  | "read_back"
  | "activate"
  | "activation_read_back"
  | "rollback";

export class DataReleaseV3PublisherError extends Error {
  constructor(
    readonly stage: DataReleaseV3PublisherErrorStage,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? `${stage}:${code}`);
    this.name = "DataReleaseV3PublisherError";
  }
}

function fail(
  stage: DataReleaseV3PublisherErrorStage,
  code: string,
  message?: string,
): never {
  throw new DataReleaseV3PublisherError(stage, code, message);
}

/** Wraps transport failures with the publish stage they interrupted. */
async function step<T>(
  stage: DataReleaseV3PublisherErrorStage,
  operation: Promise<T>,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof DataReleaseV3PublisherError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    fail(stage, "PORT_REFUSED", message);
  }
}

async function verifyReceipt(
  stage: DataReleaseV3PublisherErrorStage,
  receipt: DataReleaseV3Receipt,
  expected: Readonly<{ operationKind: string; operationId: string }>,
): Promise<DataReleaseV3Receipt> {
  const { receiptDigest, ...body } = receipt;
  const recomputed = await sha256CanonicalJson(
    DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
    body,
  );
  if (
    recomputed !== receiptDigest ||
    receipt.operationKind !== expected.operationKind ||
    receipt.operationId !== expected.operationId ||
    receipt.schemaVersion !== DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION
  ) {
    fail(stage, "RECEIPT_INTEGRITY_FAILED");
  }
  return receipt;
}

export class DataReleaseV3ReleasePublisher {
  constructor(private readonly port: DataReleaseV3PublicationPort) {}

  /**
   * Publishes one plan end to end. Activation is the only step that changes
   * public visibility, and it runs only after finalize reconciliation and an
   * explicit status read-back both prove the staged release is the complete
   * plan — never a partial or divergent one.
   */
  async publish(plan: DataReleaseV3PublishPlan): Promise<DataReleaseV3PublishOutcome> {
    const state = await this.port.activeState().catch((error: unknown) => {
      fail("active_state", "PORT_UNAVAILABLE", String(error));
    });
    if (
      state.activeRelease?.releaseFingerprint === plan.releaseFingerprint &&
      state.activeRelease.publicReleaseId === plan.publicReleaseId
    ) {
      return {
        outcome: "unchanged",
        publicReleaseId: plan.publicReleaseId,
        releaseFingerprint: plan.releaseFingerprint,
      };
    }
    const expectedActivePublicReleaseId =
      state.activeRelease?.publicReleaseId ?? null;
    if (expectedActivePublicReleaseId === plan.publicReleaseId) {
      // Same identity with a different fingerprint can only be a conflicting
      // replay; refuse before any staging write.
      fail("start", "CONFLICTING_REPLAY");
    }

    const startReceipt = await verifyReceipt(
      "start",
      await step("start", this.port.start({
        schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
        operationId: `${plan.publicReleaseId}:start`,
        idempotencyKey: `${plan.publicReleaseId}:start`,
        publicReleaseId: plan.publicReleaseId,
        releaseFingerprint: plan.releaseFingerprint,
        manifest: plan.manifest,
      })),
      { operationKind: "start", operationId: `${plan.publicReleaseId}:start` },
    );
    if (startReceipt.result !== "already_complete") {
      for (const batch of plan.batches) {
        const operationId = `${plan.publicReleaseId}:batch:${batch.batchIndex}`;
        await verifyReceipt(
          "apply_batch",
          await step("apply_batch", this.port.applyBatch({
            schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
            operationId,
            idempotencyKey: operationId,
            publicReleaseId: plan.publicReleaseId,
            batchIndex: batch.batchIndex,
            kind: batch.kind,
            batchHash: batch.batchHash,
            records: batch.records,
          } as Parameters<DataReleaseV3PublicationPort["applyBatch"]>[0])),
          { operationKind: "applyBatch", operationId },
        );
      }
    }
    // Finalize is idempotent under its deterministic operation identity: a
    // fresh staging completes here, and an already-complete release replays
    // the stored completion receipt byte for byte.
    const finalizeReceipt = await verifyReceipt(
      "finalize",
      await step("finalize", this.port.finalize({
        schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
        operationId: `${plan.publicReleaseId}:finalize`,
        idempotencyKey: `${plan.publicReleaseId}:finalize`,
        publicReleaseId: plan.publicReleaseId,
        releaseFingerprint: plan.releaseFingerprint,
        expectedCounts: plan.manifest.counts,
        expectedEntityChainHashes: plan.manifest.entityChainHashes,
        expectedTopChaseCount: plan.manifest.topChaseCount,
        expectedBatchCount: plan.manifest.batchCount,
        expectedBatchChainHash: plan.manifest.batchChainHash,
      })),
      {
        operationKind: "finalize",
        operationId: `${plan.publicReleaseId}:finalize`,
      },
    );
    const status = await step("read_back", this.port.status(plan.publicReleaseId));
    if (
      status === null ||
      status.lifecycle !== "complete" ||
      status.releaseFingerprint !== plan.releaseFingerprint ||
      status.acceptedBatchCount !== plan.manifest.batchCount ||
      status.acceptedBatchChainHash !== plan.manifest.batchChainHash ||
      status.acceptedTopChaseCount !== plan.manifest.topChaseCount ||
      status.acceptedSearchRowCount !== plan.manifest.counts.repacks ||
      JSON.stringify(status.acceptedCounts) !==
        JSON.stringify(plan.manifest.counts) ||
      JSON.stringify(status.acceptedEntityChainHashes) !==
        JSON.stringify(plan.manifest.entityChainHashes) ||
      status.completedAt === null
    ) {
      fail("read_back", "STAGED_RELEASE_DIVERGENT");
    }

    const activateOperationId = `${plan.publicReleaseId}:activate:${expectedActivePublicReleaseId ?? "genesis"}`;
    const activateReceipt = await verifyReceipt(
      "activate",
      await step("activate", this.port.activate({
        schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
        operationId: activateOperationId,
        idempotencyKey: activateOperationId,
        publicReleaseId: plan.publicReleaseId,
        releaseFingerprint: plan.releaseFingerprint,
        expectedActivePublicReleaseId,
      })),
      { operationKind: "activate", operationId: activateOperationId },
    );
    const activated = await this.readBackActivation(plan, expectedActivePublicReleaseId);
    return {
      outcome: "activated",
      publicReleaseId: plan.publicReleaseId,
      releaseFingerprint: plan.releaseFingerprint,
      generation: activated.generation,
      previousPublicReleaseId:
        activated.previousRelease?.publicReleaseId ?? null,
      receipts: {
        start: startReceipt,
        finalize: finalizeReceipt,
        activate: activateReceipt,
      },
    };
  }

  private async readBackActivation(
    plan: DataReleaseV3PublishPlan,
    expectedPreviousPublicReleaseId: string | null,
  ): Promise<DataReleaseV3ActiveState> {
    const state = await this.port.activeState();
    if (
      state.activeRelease === null ||
      state.activeRelease.publicReleaseId !== plan.publicReleaseId ||
      state.activeRelease.releaseFingerprint !== plan.releaseFingerprint ||
      (state.previousRelease?.publicReleaseId ?? null) !==
        expectedPreviousPublicReleaseId
    ) {
      fail("activation_read_back", "ACTIVATION_NOT_OBSERVED");
    }
    return state;
  }

  /**
   * Environment-scoped rollback to the retained previous release. Refused
   * server-side unless the expected active release still holds the pointer
   * and the target is exactly the retained coherent predecessor.
   */
  async rollback(input: {
    readonly expectedActivePublicReleaseId: string;
    readonly targetPublicReleaseId: string;
  }): Promise<DataReleaseV3Receipt> {
    const operationId = `rollback:${input.expectedActivePublicReleaseId}:${input.targetPublicReleaseId}`;
    const receipt = await verifyReceipt(
      "rollback",
      await step("rollback", this.port.rollback({
        schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
        operationId,
        idempotencyKey: operationId,
        expectedActivePublicReleaseId: input.expectedActivePublicReleaseId,
        targetPublicReleaseId: input.targetPublicReleaseId,
      })),
      { operationKind: "rollback", operationId },
    );
    const state = await this.port.activeState();
    if (
      state.activeRelease?.publicReleaseId !== input.targetPublicReleaseId
    ) {
      fail("rollback", "ROLLBACK_NOT_OBSERVED");
    }
    return receipt;
  }
}
