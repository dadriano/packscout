import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  REPACK_SEARCH_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  derivePublicProviderReleaseIdV1,
  extendProviderCatalogReleaseBatchChainV1,
  extendProviderCatalogReleaseEntityHashV1,
  globalCatalogProviderActiveObservationV1Schema,
  initializeProviderCatalogReleaseEntityHashV1,
  packscoutPublicIdentityUuid,
  providerCatalogReleaseBatchByteCount,
  providerReleaseCompletedHeadV1Schema,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  recomputeProviderCatalogSearchIndexHashV1,
  verifyProviderCatalogReleasePlanV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleasePublishPlanV1,
} from "@packscout/contracts";
import type { ProviderCompletedPublishPlanRelayProof } from
  "./provider-completion-plan-contract.ts";

/** Small cryptographically valid public plan for focused cache/relay tests. */
export async function buildProviderCompletionPlanProofFixture(input: Readonly<{
  providerId: string;
  providerKey: string;
  providerReleaseId: string;
  catalogVersionId: string;
  catalogContentHash: string;
  artifactAttemptId: string;
  releaseSequence: bigint;
  completionSequence?: bigint;
  terminalOperationKind?: "finalize" | "confirmReuse";
  terminalReceiptSha256?: string;
  confidencePolicyHash?: string;
}>): Promise<ProviderCompletedPublishPlanRelayProof> {
  const origins = [`https://${input.providerKey}.example`];
  const vendor = {
    publicVendorId: packscoutPublicIdentityUuid(`provider:${input.providerId}`),
    vendorKey: input.providerKey,
    displayName: `Provider ${input.providerKey}`,
    logoUrl: null,
    websiteUrl: origins[0]!,
    listingHosts: [`${input.providerKey}.example`],
    imageOrigins: origins,
    referralParameters: [],
    publicPromo: null,
  };
  const batchHash = await recomputeProviderCatalogReleaseBatchHashV1({
    kind: "vendors",
    records: [vendor],
  });
  const byteCount = providerCatalogReleaseBatchByteCount([vendor]);
  const batch = {
    batchIndex: 0,
    kind: "vendors" as const,
    batchHash,
    byteCount,
    records: [vendor],
  };
  const entityHashes = {} as Record<ProviderCatalogReleaseBatchKindV1, string>;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    entityHashes[kind] = await initializeProviderCatalogReleaseEntityHashV1(kind);
  }
  entityHashes.vendors = await extendProviderCatalogReleaseEntityHashV1({
    previousHash: entityHashes.vendors,
    kind: "vendors",
    batchHash,
    recordCount: 1,
    byteCount,
  });
  const batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
    previousHash: EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
    batchIndex: 0,
    kind: "vendors",
    batchHash,
    recordCount: 1,
    byteCount,
  });
  const contentHash = await recomputeProviderCatalogReleaseContentHashV1({
    entityHashes,
  });
  const releaseSequence = input.releaseSequence.toString();
  const identity = {
    platformKey: input.providerKey,
    sharedConfigurationEpoch: {
      configurationKey: `catalog-version:${input.catalogVersionId}`,
      revision: 1,
      publicChangeSequence: releaseSequence,
      configurationHash: input.catalogContentHash,
    },
    dataAsOf: "2026-09-01T19:59:00.000Z",
    contentHash,
    publicAssetOrigins: origins,
    governingHashes: {
      providerConfigurationHash: "1".repeat(64),
      sharedCategoriesHash: input.catalogContentHash,
      identityMappingsHash: "2".repeat(64),
      originSetHash: await recomputeProviderCatalogReleaseOriginSetHashV1(origins),
      confidencePolicyHash: input.confidencePolicyHash ?? "3".repeat(64),
    },
    entityHashes,
    counts: {
      vendors: 1 as const,
      categories: 0,
      collectibles: 0,
      repacks: 0,
      repackChases: 0,
      searchShards: 0,
    },
    searchAlgorithmVersion: REPACK_SEARCH_VERSION,
    providerSearchIndexHash:
      await recomputeProviderCatalogSearchIndexHashV1([]),
    batchCount: 1,
    batchChainHash,
  } as const;
  const publicProviderReleaseId = await derivePublicProviderReleaseIdV1(identity);
  const providerReleaseFingerprint =
    await recomputeProviderCatalogReleaseFingerprintV1(identity);
  const planCandidate: ProviderCatalogReleasePublishPlanV1 = {
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    classification: "publish",
    ...identity,
    publicProviderReleaseId,
    providerReleaseFingerprint,
    providerCheckpoint: {
      settledSequence: releaseSequence,
      settledAt: "2026-09-01T20:00:00.000Z",
    },
    sourceWatermark: buildProviderCatalogSourceWatermarkV1(
      input.providerKey,
      releaseSequence,
    ),
    batches: [batch],
    observation: {
      sourceHeadSequence: releaseSequence,
      lastSuccessfulObservationAt: "2026-09-01T20:00:00.000Z",
      staleAt: "2026-09-01T21:00:00.000Z",
      freshness: "fresh",
    },
  };
  const verified = await verifyProviderCatalogReleasePlanV1(planCandidate);
  if (verified.classification !== "publish") {
    throw new Error("Provider completion test plan is invalid.");
  }
  const completionSequence = input.completionSequence ?? input.releaseSequence;
  const terminalReceiptSha256 = input.terminalReceiptSha256 ?? "4".repeat(64);
  const terminalOperationKind = input.terminalOperationKind ?? "finalize";
  const completedHead = providerReleaseCompletedHeadV1Schema.parse({
    platformKey: input.providerKey,
    release: {
      platformKey: verified.platformKey,
      sharedConfigurationEpoch: verified.sharedConfigurationEpoch,
      dataAsOf: verified.dataAsOf,
      publicProviderReleaseId: verified.publicProviderReleaseId,
      providerReleaseFingerprint: verified.providerReleaseFingerprint,
      contentHash: verified.contentHash,
      publicAssetOrigins: verified.publicAssetOrigins,
      governingHashes: verified.governingHashes,
      entityHashes: verified.entityHashes,
      counts: verified.counts,
      searchAlgorithmVersion: verified.searchAlgorithmVersion,
      providerSearchIndexHash: verified.providerSearchIndexHash,
      batchCount: verified.batchCount,
      batchChainHash: verified.batchChainHash,
    },
    providerCheckpoint: {
      settledSequence: completionSequence.toString(),
      settledAt: "2026-09-01T20:00:00.000Z",
    },
    observation: {
      sourceHeadSequence: completionSequence.toString(),
      lastSuccessfulObservationAt: "2026-09-01T20:00:00.000Z",
      staleAt: "2026-09-01T21:00:00.000Z",
      freshness: "fresh",
    },
    terminalReceiptSha256,
  });
  const terminalOperationId =
    `terminal:${input.providerKey}:${completionSequence}`;
  const activeObservation =
    globalCatalogProviderActiveObservationV1Schema.parse({
      platformKey: input.providerKey,
      publicProviderReleaseId,
      terminalOperationKind,
      terminalOperationId,
      terminalReceiptSha256,
      selectedProviderCheckpoint: completedHead.providerCheckpoint,
      selectedDataAsOf: completedHead.release.dataAsOf,
      latestAffectedSettledSequence: completionSequence.toString(),
      latestAffectedSourceHeadSequence: completionSequence.toString(),
      initialBackfillComplete: true,
      affectedDerivationsSettled: true,
      settledSourceFreshness: "fresh",
      lastSuccessfulObservationAt: "2026-09-01T20:00:00.000Z",
      staleAt: "2026-09-01T21:00:00.000Z",
    });
  return {
    providerId: input.providerId,
    providerKey: input.providerKey,
    providerReleaseId: input.providerReleaseId,
    publicProviderReleaseId,
    providerReleaseFingerprint,
    catalogVersionId: input.catalogVersionId,
    catalogContentHash: input.catalogContentHash,
    providerReleaseContentHash: "5".repeat(64),
    completedThroughChangeSequence: completionSequence,
    artifactAttemptId: input.artifactAttemptId,
    terminalOperationKind,
    terminalOperationId,
    terminalReceiptSha256,
    plan: verified,
    completedHead,
    activeObservation,
  };
}
