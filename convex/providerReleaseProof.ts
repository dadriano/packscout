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
import type { MutationCtx } from "./_generated/server";
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
  ctx: MutationCtx,
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
