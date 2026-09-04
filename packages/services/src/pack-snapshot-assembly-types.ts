import { PACK_SNAPSHOT_BATCH_MAX_BYTES, type PackBuildRequest, type PackSnapshotEvidence,
  type ProviderPackBuildInputs, type PublicationReasonCode, type PublicPackSnapshot,
  type PublicPackSnapshotBatch, type PublicPackSnapshotDescriptor } from "@packscout/contracts";

export interface AssembleProviderPackSnapshotInput {
  readonly request: PackBuildRequest;
  readonly inputs: ProviderPackBuildInputs;
  readonly existingSnapshot?: PublicPackSnapshot | null;
}

export interface BuiltPublicPackSnapshot {
  readonly snapshot: PublicPackSnapshot;
  readonly descriptor: PublicPackSnapshotDescriptor;
  readonly batches: PublicPackSnapshotBatch[];
  readonly evidence: PackSnapshotEvidence;
  readonly disposition: "created" | "reused";
  /** Canonical JSON; byte sizes and hashes always use its UTF-8 encoding. */
  readonly canonicalBytes: string;
  readonly payloadSha256: string;
}

export const packSnapshotAssemblyLimits = Object.freeze({
  maximumInputBytes: 48_000_000, // candidate plus complete lifecycle/reuse references
  maximumSnapshotBytes: 16_000_000,
  maximumDocumentBytes: PACK_SNAPSHOT_BATCH_MAX_BYTES,
  maximumBatches: 32,
  maximumDepth: 16,
  // 8,000 members across capture/baseline/reuse plus 10,000 shared dependencies
  // in capture and request require about 593,000 nodes; byte/depth bounds still apply.
  maximumNodes: 650_000,
});

export class PackSnapshotAssemblyError extends Error {
  readonly code = "PACK_SNAPSHOT_INPUT_INVALID";
  constructor(readonly reasonCode: PublicationReasonCode = "INVALID_DOMAIN_DATA") {
    super("PACK_SNAPSHOT_INPUT_INVALID");
    this.name = "PackSnapshotAssemblyError";
  }
}

export function requireAssembly(condition: unknown, reason?: PublicationReasonCode): asserts condition {
  if (!condition) throw new PackSnapshotAssemblyError(reason);
}
