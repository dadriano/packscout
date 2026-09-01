import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  PROVIDER_RELEASE_PUBLIC_SCHEMA_VERSION,
  canonicalJson,
  providerReleaseMutationRequestSchema,
  providerReleaseReceiptDigest,
  providerReleaseReceiptSchema,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseBatch,
  type ProviderReleaseDescriptor,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseReceipt,
  type ProviderReleaseStatusNotFoundReceipt,
  type ProviderReleaseStatusRequest,
} from "@packscout/contracts";
import type {
  DistributedProviderPublicationIntent,
  DistributedProviderPublicationOperation,
  DistributedProviderPublicationReceiptEvidence,
  DistributedProviderPublisherLease,
  ProviderReleaseAssemblyResult,
  ProviderReleasePublicationSource,
} from "@packscout/database";
import {
  PublicationClientError,
  type PublicationClientFailureCode,
} from "./convex-publication-http-client.ts";
import {
  DistributedProviderReleasePublicationService,
  type DistributedProviderReleasePublicationStore,
  type DistributedProviderReleasePublicationTransport,
} from "./distributed-provider-release-publication-service.ts";
import { buildProviderCatalogReleasePublishPlan } from
  "./provider-catalog-release-artifacts.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";
import { projectProviderCatalogRelease } from
  "./provider-catalog-release-public-projection.ts";
import type { ProviderReleasePublicationResult } from
  "./provider-promotion-types.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function activePlan(): Promise<ProviderCatalogReleasePublishPlanV1> {
  const configuration = providerFixtureApprovedConfiguration();
  const snapshot = providerFixtureSnapshot({ configuration });
  const projection = projectProviderCatalogRelease({
    configuration,
    platformKey: snapshot.checkpoint.platformKey,
    revisions: snapshot.revisions,
    assetPackAssociations: snapshot.assetPackAssociations,
    repackIdentities: snapshot.repackIdentities,
  });
  return buildProviderCatalogReleasePublishPlan({
    checkpoint: snapshot.checkpoint,
    configuration: snapshot.configuration,
    projection,
    lastSuccessfulObservationAt:
      snapshot.observation.lastSuccessfulObservationAt,
  });
}

function localBatch(
  batchOrdinal: number,
  batchKind: string,
  records: readonly unknown[],
): ProviderReleaseBatch {
  return {
    batchOrdinal,
    batchKind,
    batchIndex: 0,
    records,
    recordCount: records.length,
    byteCount: 1,
    bodyHash: HASH_A,
  } as unknown as ProviderReleaseBatch;
}

async function fixture(): Promise<Readonly<{
  assembly: ProviderReleaseAssemblyResult;
  source: ProviderReleasePublicationSource;
}>> {
  const plan = await activePlan();
  const records = (
    kind: ProviderCatalogReleasePublishPlanV1["batches"][number]["kind"],
  ): readonly unknown[] => plan.batches
    .filter((batch) => batch.kind === kind)
    .flatMap((batch) => batch.records as readonly unknown[]);
  const batches = [
    localBatch(0, "provider", records("vendors")),
    localBatch(1, "category", records("categories")),
    localBatch(2, "collectible", records("collectibles")),
    localBatch(3, "repack", records("repacks")),
    localBatch(4, "chase", records("repack_chases")),
    localBatch(5, "retired-repack", []),
    localBatch(6, "search-index", []),
  ];
  const descriptor: ProviderReleaseDescriptor = {
    providerReleaseId: "30000000-0000-5000-8000-000000000001",
    predecessorCompleteReleaseId: null,
    providerId: "30000000-0000-4000-8000-000000000001",
    providerKey: plan.platformKey,
    publicProviderId: (records("vendors")[0] as { publicVendorId: string })
      .publicVendorId,
    throughChangeSequence: "20",
    catalogVersionId: "40000000-0000-4000-8000-000000000001",
    catalogContentHash: HASH_A,
    centralSchemaVersion: "distributed-central-v1",
    correlationEventSequence: "7",
    correlationSnapshotHash: HASH_B,
    publicProfileVersionId: "50000000-0000-4000-8000-000000000001",
    publicProfileHash: HASH_C,
    providerSchemaVersion: "distributed-provider-v1",
    publicSchemaVersion: PROVIDER_RELEASE_PUBLIC_SCHEMA_VERSION,
    categoryCount: records("categories").length,
    collectibleReferenceCount: records("collectibles").length,
    repackCount: records("repacks").length,
    chaseCount: records("repack_chases").length,
    retiredRepackCount: 0,
    batchCount: batches.length,
    contentHash: HASH_D,
    indexHash: HASH_A,
    dataAsOf: plan.dataAsOf,
    lastSuccessfulObservationAt:
      plan.observation.lastSuccessfulObservationAt,
    staleAt: plan.observation.staleAt,
    freshness: plan.observation.freshness,
  };
  const release = {
    id: descriptor.providerReleaseId,
    predecessorId: null,
    throughChangeSequence: 20n,
    lifecycle: "assembled" as const,
    contentHash: descriptor.contentHash,
    indexHash: descriptor.indexHash,
    batchCount: descriptor.batchCount,
    descriptor,
  };
  return {
    assembly: {
      release,
      selectedThroughChangeSequence: 20n,
      publicEquivalenceHash: HASH_B,
      reusedCompleteRelease: false,
      resumedExistingAssembly: false,
    },
    source: {
      release,
      descriptor,
      batches,
      publicEquivalenceHash: HASH_B,
    },
  };
}

type MutableIntent = {
  operation: DistributedProviderPublicationOperation;
  providerReleaseId: string;
  leaseFence: bigint;
  state: "pending" | "accepted" | "ambiguous" | "failed";
  attemptCount: number;
  evidence: DistributedProviderPublicationReceiptEvidence | null;
  failureCode: string | null;
};

class MemoryPublicationStore
implements DistributedProviderReleasePublicationStore {
  readonly intents = new Map<string, MutableIntent>();
  readonly accepted: string[] = [];
  completed = 0;
  fence = 0n;
  expectedHead: ProviderReleaseExpectedCompletedHeadV1;

  constructor(readonly platformKey: string) {
    this.expectedHead = {
      platformKey,
      publicProviderReleaseId: null,
      sharedConfigurationEpoch: null,
      providerCheckpoint: { settledSequence: "0" as const, settledAt: null },
      observation: null,
      terminalReceiptSha256: null,
    };
  }

  claimLease(owner: string): Promise<DistributedProviderPublisherLease> {
    this.fence += 1n;
    return Promise.resolve({
      owner,
      operationFence: this.fence,
      checkpointFence: this.fence,
      expiresAt: new Date("2026-09-01T01:00:00.000Z"),
    });
  }

  renewLease(
    lease: DistributedProviderPublisherLease,
  ): Promise<DistributedProviderPublisherLease> {
    return Promise.resolve(lease);
  }

  releaseLease(): Promise<void> {
    return Promise.resolve();
  }

  loadExpectedCompletedHead() {
    return Promise.resolve(this.expectedHead);
  }

  recordIntent(input: {
    lease: DistributedProviderPublisherLease;
    providerReleaseId: string;
    operation: DistributedProviderPublicationOperation;
  }): Promise<DistributedProviderPublicationIntent> {
    const existing = this.intents.get(input.operation.operationId);
    if (existing !== undefined) {
      assert.equal(
        existing.operation.canonicalRequestBody,
        input.operation.canonicalRequestBody,
      );
      assert.equal(existing.operation.requestSha256, input.operation.requestSha256);
      return Promise.resolve(this.intent(existing));
    }
    const created: MutableIntent = {
      operation: input.operation,
      providerReleaseId: input.providerReleaseId,
      leaseFence: input.lease.operationFence,
      state: "pending",
      attemptCount: 0,
      evidence: null,
      failureCode: null,
    };
    this.intents.set(input.operation.operationId, created);
    return Promise.resolve(this.intent(created));
  }

  recordAttempt(input: { idempotencyKey: string }): Promise<void> {
    this.intents.get(input.idempotencyKey)!.attemptCount += 1;
    return Promise.resolve();
  }

  markAmbiguous(input: { idempotencyKey: string }): Promise<void> {
    const intent = this.intents.get(input.idempotencyKey)!;
    if (intent.state === "pending") intent.state = "ambiguous";
    return Promise.resolve();
  }

  fail(input: { idempotencyKey: string; failureCode: string }): Promise<void> {
    const intent = this.intents.get(input.idempotencyKey)!;
    intent.state = "failed";
    intent.failureCode = input.failureCode;
    return Promise.resolve();
  }

  accept(input: {
    providerReleaseId: string;
    operation: DistributedProviderPublicationOperation;
    evidence: DistributedProviderPublicationReceiptEvidence;
  }): Promise<Readonly<{ receipt: ProviderReleaseReceipt; completed: boolean }>> {
    const intent = this.intents.get(input.operation.operationId)!;
    intent.state = "accepted";
    intent.evidence = input.evidence;
    if (!this.accepted.includes(input.operation.operationId)) {
      this.accepted.push(input.operation.operationId);
    }
    const receipt = providerReleaseReceiptSchema.parse(
      JSON.parse(input.evidence.canonicalReceiptBody),
    );
    const completed = receipt.operationKind === "finalize"
      || receipt.operationKind === "confirmReuse";
    if (completed) {
      this.completed += 1;
      this.expectedHead = {
        platformKey: receipt.platformKey,
        publicProviderReleaseId: receipt.publicProviderReleaseId,
        sharedConfigurationEpoch: receipt.sharedConfigurationEpoch,
        providerCheckpoint: receipt.providerCheckpoint,
        observation: receipt.details.observation,
        terminalReceiptSha256: input.evidence.receiptSha256,
      };
    }
    return Promise.resolve({ receipt, completed });
  }

  private intent(value: MutableIntent): DistributedProviderPublicationIntent {
    return {
      id: value.operation.operationId,
      providerReleaseId: value.providerReleaseId,
      operationKind: value.operation.operationKind,
      idempotencyKey: value.operation.operationId,
      requestDigest: value.operation.requestSha256,
      canonicalRequestBody: value.operation.canonicalRequestBody,
      leaseFence: value.leaseFence,
      state: value.state,
      attemptCount: value.attemptCount,
      canonicalReceiptBody: value.evidence?.canonicalReceiptBody ?? null,
      receiptSha256: value.evidence?.receiptSha256 ?? null,
      failureCode: value.failureCode,
    };
  }
}

class MemoryTransport implements DistributedProviderReleasePublicationTransport {
  readonly receipts = new Map<string, ProviderReleasePublicationResult>();
  readonly sends = new Map<string, string[]>();
  readonly statuses = new Map<string, number>();
  loseAfterStore: string | null = null;
  loseBeforeStore: string | null = null;
  terminalFailure: PublicationClientFailureCode | null = null;

  async sendExact(input: {
    kind: "start" | "applyBatch" | "finalize" | "confirmReuse" | "block";
    canonicalRequestBody: string;
  }): Promise<ProviderReleasePublicationResult> {
    const request = providerReleaseMutationRequestSchema.parse(
      JSON.parse(input.canonicalRequestBody),
    );
    assert.ok("release" in request);
    const bodies = this.sends.get(request.operationId) ?? [];
    bodies.push(input.canonicalRequestBody);
    this.sends.set(request.operationId, bodies);
    if (this.terminalFailure !== null && input.kind !== "block") {
      const code = this.terminalFailure;
      this.terminalFailure = null;
      throw new PublicationClientError(code, "terminal", false);
    }
    if (this.loseBeforeStore === input.kind) {
      this.loseBeforeStore = null;
      throw new PublicationClientError(
        "PUBLICATION_NETWORK_ERROR",
        "retryable",
        true,
      );
    }
    const common = {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      operationKind: input.kind,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.release.platformKey,
      publicProviderReleaseId: request.release.publicProviderReleaseId,
      sharedConfigurationEpoch: request.release.sharedConfigurationEpoch,
      providerCheckpoint: request.providerCheckpoint,
      serverTime: "2026-08-15T03:00:01.000Z",
      requestDigest: sha256(input.canonicalRequestBody),
    };
    const context = {
      release: request.release,
      providerCheckpoint: request.providerCheckpoint,
      sourceWatermark: request.sourceWatermark,
      observation: request.observation,
      expectedCompletedHead: request.expectedCompletedHead,
    };
    let body: Record<string, unknown>;
    if (input.kind === "start") {
      body = {
        ...common,
        terminalState: "staging",
        result: "created",
        details: { ...context, acceptedBatchCount: 0 },
      };
    } else if (input.kind === "applyBatch" && "batch" in request) {
      body = {
        ...common,
        terminalState: "staging",
        result: "accepted",
        details: {
          ...context,
          batchIndex: request.batch.batchIndex,
          kind: request.batch.kind,
          batchHash: request.batch.batchHash,
          recordCount: request.batch.records.length,
          byteCount: request.batch.byteCount,
          acceptedBatchCount: request.batch.batchIndex + 1,
          acceptedCounts: request.release.counts,
          acceptedEntityHashes: request.release.entityHashes,
          acceptedBatchChainHash: request.release.batchChainHash,
        },
      };
    } else if (input.kind === "block" && "reason" in request) {
      body = {
        ...common,
        terminalState: "blocked",
        result: "blocked",
        details: {
          ...context,
          blockSequence: request.blockSequence,
          reason: request.reason,
        },
      };
    } else {
      body = {
        ...common,
        terminalState: "complete",
        result: input.kind === "finalize" ? "completed" : "reused",
        details: {
          ...context,
          completedHead: {
            platformKey: request.release.platformKey,
            release: request.release,
            providerCheckpoint: request.providerCheckpoint,
            observation: request.observation,
          },
        },
      };
    }
    const receipt = providerReleaseReceiptSchema.parse({
      ...body,
      receiptDigest: await providerReleaseReceiptDigest(body),
    });
    const canonicalReceiptBody = canonicalJson(receipt);
    const result = {
      receipt,
      canonicalReceiptBody,
      receiptSha256: sha256(canonicalReceiptBody),
    } satisfies ProviderReleasePublicationResult;
    this.receipts.set(request.operationId, result);
    if (this.loseAfterStore === input.kind) {
      this.loseAfterStore = null;
      throw new PublicationClientError(
        "PUBLICATION_NETWORK_ERROR",
        "retryable",
        true,
      );
    }
    return result;
  }

  status(request: ProviderReleaseStatusRequest): Promise<
    ProviderReleasePublicationResult<
      ProviderReleaseReceipt | ProviderReleaseStatusNotFoundReceipt
    >
  > {
    const id = request.target.operationId;
    this.statuses.set(id, (this.statuses.get(id) ?? 0) + 1);
    const found = this.receipts.get(id);
    if (found !== undefined) return Promise.resolve(found);
    const receipt: ProviderReleaseStatusNotFoundReceipt = {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      target: request.target,
      terminalState: "not_found",
      result: "not_found",
      serverTime: "2026-08-15T03:00:02.000Z",
      requestDigest: request.target.requestDigest,
      details: {},
      receiptDigest: null,
    };
    const canonicalReceiptBody = canonicalJson(receipt);
    return Promise.resolve({
      receipt,
      canonicalReceiptBody,
      receiptSha256: sha256(canonicalReceiptBody),
    });
  }
}

function service(input: Awaited<ReturnType<typeof fixture>>, inputStore?: {
  store?: MemoryPublicationStore;
  transport?: MemoryTransport;
}) {
  const store = inputStore?.store
    ?? new MemoryPublicationStore(input.source.descriptor.providerKey);
  const transport = inputStore?.transport ?? new MemoryTransport();
  const publisher = new DistributedProviderReleasePublicationService({
    workerId: "provider-publication-test",
    releases: {
      publicationSource: () => Promise.resolve(input.source),
    },
    publications: store,
    transport,
  });
  return { publisher, store, transport };
}

test("lost final response is recovered by signed exact status before checkpoint completion", async () => {
  const input = await fixture();
  const runtime = service(input);
  runtime.transport.loseAfterStore = "finalize";

  const result = await runtime.publisher.publish(input.assembly);

  const finalize = [...runtime.store.intents.values()].find(
    ({ operation }) => operation.operationKind === "finalize",
  )!;
  assert.equal(runtime.transport.sends.get(finalize.operation.operationId)?.length, 1);
  assert.equal(runtime.transport.statuses.get(finalize.operation.operationId), 1);
  assert.equal(runtime.store.completed, 1);
  assert.equal(result.confirmedThroughChangeSequence, 20n);
  assert.equal(result.terminalReceiptSha256, finalize.evidence?.receiptSha256);
});

test("signed status miss authorizes one byte-identical exact resend", async () => {
  const input = await fixture();
  const runtime = service(input);
  runtime.transport.loseBeforeStore = "applyBatch";

  await runtime.publisher.publish(input.assembly);

  const batch = [...runtime.store.intents.values()].find(
    ({ operation }) => operation.operationKind === "applyBatch",
  )!;
  const sends = runtime.transport.sends.get(batch.operation.operationId)!;
  assert.equal(sends.length, 2);
  assert.equal(sends[0], sends[1]);
  assert.equal(runtime.transport.statuses.get(batch.operation.operationId), 1);
  assert.equal(runtime.store.completed, 1);
});

test("unchanged reuse retains the immutable release while advancing only its checkpoint", async () => {
  const input = await fixture();
  const runtime = service(input);
  const published = await runtime.publisher.publish(input.assembly);
  const completeRelease = {
    ...input.assembly.release,
    lifecycle: "complete" as const,
  };
  const reuseInput = {
    source: { ...input.source, release: completeRelease },
    assembly: {
      ...input.assembly,
      release: completeRelease,
      selectedThroughChangeSequence: 21n,
      reusedCompleteRelease: true,
    },
  };
  const reuseRuntime = service(reuseInput, {
    store: runtime.store,
    transport: runtime.transport,
  });

  const reused = await reuseRuntime.publisher.publish(reuseInput.assembly);

  assert.equal(reused.publicProviderReleaseId, published.publicProviderReleaseId);
  assert.equal(reused.providerReleaseId, published.providerReleaseId);
  assert.equal(reused.confirmedThroughChangeSequence, 21n);
  assert.equal(reused.reusedCompleteRelease, true);
  assert.equal(runtime.store.completed, 2);
  assert.equal(
    [...runtime.store.intents.values()].filter(
      ({ operation }) => operation.operationKind === "confirmReuse",
    ).length,
    1,
  );
});

test("terminal rejection preserves the completed head and records an exact remote block", async () => {
  const input = await fixture();
  const runtime = service(input);
  runtime.transport.terminalFailure = "PROVIDER_RELEASE_PREDECESSOR_CONFLICT";

  await assert.rejects(
    () => runtime.publisher.publish(input.assembly),
    (error: unknown) => error instanceof Error
      && error.message.includes("PROVIDER_RELEASE_PREDECESSOR_CONFLICT"),
  );

  const failed = [...runtime.store.intents.values()].find(
    ({ state }) => state === "failed",
  );
  const blocked = [...runtime.store.intents.values()].find(
    ({ operation }) => operation.operationKind === "block",
  );
  assert.equal(failed?.operation.operationKind, "start");
  assert.equal(blocked?.state, "accepted");
  assert.equal(runtime.store.completed, 0);
  assert.equal(runtime.store.expectedHead.publicProviderReleaseId, null);
});
