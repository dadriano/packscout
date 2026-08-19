import { createHash } from "node:crypto";
import { canonicalJson } from "@packscout/contracts";
import {
  parseProviderPromotionOperation,
  reconstructVerifiedProviderPromotionPlan,
  validateProviderPromotionReceipt,
} from "./provider-promotion-operations.ts";
import type {
  ManifestProviderPlanResolver,
} from "./manifest-promotion-types.ts";
import type {
  ProviderPromotionPreparedSummary,
  ProviderPromotionReleaseArtifact,
} from "./provider-promotion-types.ts";

export interface ProviderPromotionArtifactPort {
  loadReleaseArtifact(input: Readonly<{
    publicProviderReleaseId: string;
  }>): Promise<ProviderPromotionReleaseArtifact | null>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Reconstructs retained publish plans solely from exact acknowledged bytes. */
export class ProviderPromotionArtifactPlanResolver
implements ManifestProviderPlanResolver {
  readonly #providers: ReadonlyMap<string, ProviderPromotionArtifactPort>;

  constructor(providers: readonly Readonly<{
    platformKey: string;
    artifacts: ProviderPromotionArtifactPort;
  }>[]) {
    const canonical = [...providers].sort((left, right) =>
      left.platformKey < right.platformKey
        ? -1 : left.platformKey > right.platformKey ? 1 : 0);
    if (canonical.length > 8 || canonical.some((provider, index) =>
      provider !== providers[index] ||
      (index > 0 && canonical[index - 1]!.platformKey ===
        provider.platformKey))) {
      throw new RangeError("Provider artifact resolver scope is invalid.");
    }
    this.#providers = new Map(canonical.map(({ platformKey, artifacts }) => [
      platformKey, artifacts,
    ]));
  }

  async loadPublishPlan(input: Readonly<{
    platformKey: string;
    publicProviderReleaseId: string;
    providerReleaseFingerprint: string;
    publishArtifactAttemptId: string;
  }>) {
    const repository = this.#providers.get(input.platformKey);
    if (repository === undefined) return null;
    const artifact = await repository.loadReleaseArtifact({
      publicProviderReleaseId: input.publicProviderReleaseId,
    });
    if (artifact === null || artifact.platformKey !== input.platformKey ||
        artifact.publicProviderReleaseId !== input.publicProviderReleaseId ||
        artifact.providerReleaseFingerprint !== input.providerReleaseFingerprint ||
        artifact.publishAttemptId !== input.publishArtifactAttemptId ||
        canonicalJson(artifact.immutableProof) !== artifact.immutableProofBody ||
        sha256(artifact.immutableProofBody) !== artifact.immutableProofSha256 ||
        artifact.operations.length < 2) return null;
    const firstOperation = artifact.operations[0]!;
    const first = parseProviderPromotionOperation(firstOperation);
    if (firstOperation.operationKind !== "start" || !("release" in first)) {
      return null;
    }
    const terminal = artifact.operations.at(-1)!;
    if (terminal.operationKind !== "finalize" ||
        terminal.canonicalReceiptBody === null ||
        terminal.receiptSha256 === null ||
        terminal.canonicalReceiptBody !== artifact.terminalReceiptBody ||
        terminal.receiptSha256 !== artifact.terminalReceiptSha256) return null;
    for (const operation of artifact.operations) {
      if (operation.state !== "acknowledged" ||
          operation.canonicalReceiptBody === null ||
          operation.receiptSha256 === null) return null;
      validateProviderPromotionReceipt({
        operation,
        receipt: JSON.parse(operation.canonicalReceiptBody) as unknown,
        canonicalReceiptBody: operation.canonicalReceiptBody,
        receiptSha256: operation.receiptSha256,
      });
    }
    const summary: ProviderPromotionPreparedSummary = {
      classification: "publish",
      platformKey: input.platformKey,
      targetCheckpoint: BigInt(first.providerCheckpoint.settledSequence),
      publicProviderReleaseId: input.publicProviderReleaseId,
      providerReleaseFingerprint: input.providerReleaseFingerprint,
      immutableProof: artifact.immutableProof,
      providerCheckpoint: first.providerCheckpoint,
      observation: first.observation,
      expectedCompletedHead: first.expectedCompletedHead,
      operationCount: artifact.operations.length,
      // Historical artifact reconstruction does not claim a live evaluation.
      checkpointSha256: "0".repeat(64),
    };
    const plan = await reconstructVerifiedProviderPromotionPlan({
      summary,
      operations: artifact.operations,
    });
    return plan.classification === "publish" ? plan : null;
  }
}
