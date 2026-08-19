import {
  canonicalJson,
  derivePublicProviderReleaseIdV1,
  providerCatalogCompletedReleaseProofV1Schema,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  type ProviderCatalogCompletedReleaseProofV1,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { refuseProviderRelease } from "./providerReleaseErrors";
import { loadProviderOperationById } from "./providerReleaseOperations";

export type ProviderReleaseImmutableProof = Omit<
  ProviderCatalogCompletedReleaseProofV1,
  "state"
>;

export function storedProviderReleaseProof(
  release: Doc<"providerCatalogReleases">,
): ProviderReleaseImmutableProof {
  return {
    platformKey: release.platformKey,
    sharedConfigurationEpoch: release.sharedConfigurationEpoch,
    dataAsOf: release.dataAsOf,
    publicProviderReleaseId: release.publicProviderReleaseId,
    providerReleaseFingerprint: release.providerReleaseFingerprint,
    contentHash: release.contentHash,
    publicAssetOrigins: release.publicAssetOrigins,
    governingHashes: release.governingHashes,
    entityHashes: release.entityHashes,
    counts: release.counts as ProviderReleaseImmutableProof["counts"],
    searchAlgorithmVersion: release.searchAlgorithmVersion,
    providerSearchIndexHash: release.providerSearchIndexHash,
    batchCount: release.batchCount,
    batchChainHash: release.batchChainHash,
  };
}

export function providerReleaseProofMatches(
  release: Doc<"providerCatalogReleases">,
  proof: ProviderReleaseImmutableProof,
): boolean {
  return canonicalJson(storedProviderReleaseProof(release)) ===
    canonicalJson(proof);
}

async function sha256Utf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function providerReleaseImmutableProofSha256(
  proof: unknown,
): Promise<string> {
  return await sha256Utf8(canonicalJson(proof));
}

export async function storeProviderReleaseCompletionProof(
  ctx: MutationCtx,
  input: Readonly<{
    releaseId: Doc<"providerCatalogReleases">["_id"];
    releaseProof: ProviderReleaseImmutableProof;
    operationId: string;
    completedAt: string;
    terminalReceiptSha256: string;
    receiptDigest: string;
  }>,
): Promise<void> {
  const [byRelease, byOperation] = await Promise.all([
    ctx.db.query("providerCatalogReleaseCompletionProofs")
      .withIndex("by_release_id", (index) =>
        index.eq("releaseId", input.releaseId)
      )
      .take(1),
    ctx.db.query("providerCatalogReleaseCompletionProofs")
      .withIndex("by_operation_id", (index) =>
        index.eq("operationId", input.operationId)
      )
      .take(1),
  ]);
  if (byRelease.length !== 0 || byOperation.length !== 0) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  await ctx.db.insert("providerCatalogReleaseCompletionProofs", {
    releaseId: input.releaseId,
    operationId: input.operationId,
    platformKey: input.releaseProof.platformKey,
    publicProviderReleaseId: input.releaseProof.publicProviderReleaseId,
    providerReleaseFingerprint:
      input.releaseProof.providerReleaseFingerprint,
    completedAt: input.completedAt,
    terminalReceiptSha256: input.terminalReceiptSha256,
    receiptDigest: input.receiptDigest,
    immutableProofSha256: await providerReleaseImmutableProofSha256(
      input.releaseProof,
    ),
  });
}

export async function storeProviderTerminalReceiptProof(
  ctx: MutationCtx,
  input: Readonly<{
    releaseId: Doc<"providerCatalogReleases">["_id"];
    releaseProof: ProviderReleaseImmutableProof;
    operationId: string;
    operationKind: "finalize" | "confirmReuse";
    requestDigest: string;
    completedAt: string;
    terminalReceiptSha256: string;
    receiptDigest: string;
  }>,
): Promise<void> {
  const existing = await ctx.db.query("providerCatalogTerminalReceiptProofs")
    .withIndex("by_operation_id", (index) =>
      index.eq("operationId", input.operationId)
    )
    .take(1);
  if (existing.length !== 0) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  await ctx.db.insert("providerCatalogTerminalReceiptProofs", {
    releaseId: input.releaseId,
    operationId: input.operationId,
    operationKind: input.operationKind,
    requestDigest: input.requestDigest,
    platformKey: input.releaseProof.platformKey,
    publicProviderReleaseId: input.releaseProof.publicProviderReleaseId,
    providerReleaseFingerprint:
      input.releaseProof.providerReleaseFingerprint,
    completedAt: input.completedAt,
    terminalReceiptSha256: input.terminalReceiptSha256,
    receiptDigest: input.receiptDigest,
  });
}

export async function loadProviderTerminalReceiptProof(
  ctx: MutationCtx | QueryCtx,
  operationId: string,
): Promise<Doc<"providerCatalogTerminalReceiptProofs"> | null> {
  const rows = await ctx.db.query("providerCatalogTerminalReceiptProofs")
    .withIndex("by_operation_id", (index) =>
      index.eq("operationId", operationId)
    )
    .take(2);
  if (rows.length > 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  return rows[0] ?? null;
}

export async function loadProviderReleaseCompletionProof(
  ctx: MutationCtx | QueryCtx,
  releaseId: Doc<"providerCatalogReleases">["_id"],
): Promise<Doc<"providerCatalogReleaseCompletionProofs">> {
  const rows = await ctx.db.query("providerCatalogReleaseCompletionProofs")
    .withIndex("by_release_id", (index) => index.eq("releaseId", releaseId))
    .take(2);
  if (rows.length !== 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  return rows[0]!;
}

export async function assertCompactProviderReleaseCompletion(
  ctx: MutationCtx | QueryCtx,
  release: Doc<"providerCatalogReleases">,
): Promise<void> {
  if (
    release.lifecycle !== "complete" ||
    release.completedAt === null ||
    release.completionOperationId === null ||
    release.completionReceiptSha256 === null
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  const proof = await loadProviderReleaseCompletionProof(ctx, release._id);
  if (
    proof.operationId !== release.completionOperationId ||
    proof.platformKey !== release.platformKey ||
    proof.publicProviderReleaseId !== release.publicProviderReleaseId ||
    proof.providerReleaseFingerprint !==
      release.providerReleaseFingerprint ||
    proof.completedAt !== release.completedAt ||
    proof.terminalReceiptSha256 !== release.completionReceiptSha256 ||
    proof.immutableProofSha256 !==
      await providerReleaseImmutableProofSha256(
        storedProviderReleaseProof(release),
      )
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
}

export async function providerReleaseProofIsValid(
  proof: ProviderReleaseImmutableProof,
): Promise<boolean> {
  const parsed = providerCatalogCompletedReleaseProofV1Schema.safeParse({
    state: "complete",
    ...proof,
  });
  if (!parsed.success) return false;
  return proof.governingHashes.originSetHash ===
      await recomputeProviderCatalogReleaseOriginSetHashV1(
        proof.publicAssetOrigins,
      ) &&
    proof.contentHash === await recomputeProviderCatalogReleaseContentHashV1({
      entityHashes: proof.entityHashes,
    }) &&
    proof.providerReleaseFingerprint ===
      await recomputeProviderCatalogReleaseFingerprintV1(proof) &&
    proof.publicProviderReleaseId ===
      await derivePublicProviderReleaseIdV1(proof);
}

export async function assertStoredProviderReleaseCompletion(
  ctx: MutationCtx | QueryCtx,
  release: Doc<"providerCatalogReleases">,
): Promise<void> {
  if (
    release.lifecycle !== "complete" ||
    release.completedAt === null ||
    release.completionOperationId === null ||
    release.completionReceiptSha256 === null
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  const terminal = await loadProviderOperationById(
    ctx,
    release.completionOperationId,
  );
  if (
    terminal === null ||
    terminal.receipt.operationKind !== "finalize" ||
    terminal.operation.platformKey !== release.platformKey ||
    terminal.operation.publicProviderReleaseId !==
      release.publicProviderReleaseId ||
    terminal.receipt.serverTime !== release.completedAt ||
    terminal.terminalReceiptSha256 !== release.completionReceiptSha256 ||
    !providerReleaseProofMatches(release, terminal.receipt.details.release)
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
}
