import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  PRODUCTION_PROVIDER_RELEASE_PATHS,
  buildProviderCatalogSourceWatermarkV1,
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  catalogManifestReceiptDigest,
  derivePublicCatalogReleaseIdV1,
  providerCatalogReleaseBatchByteCount,
  providerReleaseReceiptDigest,
  recomputeGlobalCatalogCompositionProofHashV1,
  recomputeGlobalCatalogIdentityMappingsHashV1,
  recomputeGlobalCatalogManifestContentHashV1,
  recomputeGlobalCatalogManifestEntityHashesV1,
  recomputeGlobalCatalogManifestFingerprintV1,
  recomputeGlobalCatalogManifestOriginSetHashV1,
  recomputeGlobalCatalogManifestSearchIndexHashV1,
  recomputeGlobalCatalogProviderConfigurationsHashV1,
  recomputeGlobalCatalogProviderReferenceSetHashV1,
  recomputeGlobalCatalogSharedCategoriesHashV1,
  verifyGlobalCatalogManifestV1,
  type ActiveCatalogManifestStateV1,
  type ApprovedPublicCatalogConfigurationV1,
  type CatalogManifestReceipt,
  type GlobalCatalogManifestV1,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseImmutableProofV1,
  type ProviderReleaseReceipt,
} from "@packscout/contracts";
import { PrismaCatalogReleaseSourceRepository } from
  "./catalog-release-source-repository.ts";
import { PrismaCatalogPromotionBootstrapProofRepository } from
  "./catalog-promotion-bootstrap-proof-repository.ts";
import type { MigratedTestDatabase } from "./test-support.ts";
import {
  promotionV2Sha256,
  providerCheckpointIdentityBody,
  type CatalogPromotionBootstrapProviderProof,
  type ExactPromotionOperationInput,
  type ExactPromotionReceiptEvidence,
  type ManifestPromotionPreparedSummary,
  type ProviderPromotionCheckpointIdentity,
  type ProviderPromotionPreparedSummary,
} from "./promotion-v2-types.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

const releaseIds = Object.freeze({
  alpha: "61000000-0000-5000-8000-000000000001",
  beta: "62000000-0000-5000-8000-000000000001",
});

const vendorIds = Object.freeze({
  alpha: "61000000-0000-5000-8000-000000000101",
  beta: "62000000-0000-5000-8000-000000000101",
});

function approvedConfiguration(
  platformKeys: readonly string[],
  revision: number,
  approvedAt: Date,
): ApprovedPublicCatalogConfigurationV1 {
  const origins = platformKeys.map((key) => `https://${key}.example`);
  return {
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: `promotion-v2-${revision}`,
    revision,
    approvedAt: approvedAt.toISOString(),
    staleAfterSeconds: 900,
    confidencePolicy: {
      version: "confidence-v1",
      completeScoreBasisPoints: 9_000,
      partialScoreBasisPoints: 6_000,
      unknownScoreBasisPoints: 3_000,
      limitationPenaltyBasisPoints: 500,
    },
    publicAssetOrigins: origins,
    verifiedUsdStablecoins: [],
    categories: [],
    platforms: platformKeys.map((key, index) => ({
      platformKey: key,
      vendor: {
        publicVendorId:
          `71000000-0000-5000-8000-${String(index + 1).padStart(12, "0")}`,
        vendorKey: key,
        displayName: key,
        logoUrl: null,
        websiteUrl: origins[index]!,
        listingHosts: [`${key}.example`],
        imageOrigins: [origins[index]!],
        referralParameters: [],
        publicPromo: null,
      },
      format: "repack",
      defaultPublicCategoryIds: [],
      categoryMappings: [],
      collectibleTypeMappings: [],
    })),
    repacks: [],
    collectibles: [],
  };
}

export async function seedPromotionV2AuthoritativeConfiguration(
  harness: MigratedTestDatabase,
  organizationId: string,
  platformKeys: readonly string[],
  approvedAt: Date,
  revision = 1,
): Promise<void> {
  await harness.client.provider_sources.createMany({
    data: platformKeys.map((key) => ({
      organization_id: organizationId,
      platform_key: key,
      display_name: key,
    })),
    skipDuplicates: true,
  });
  const approved = await new PrismaCatalogReleaseSourceRepository(
    harness.client,
    organizationId,
  ).approveConfiguration(
    approvedConfiguration(platformKeys, revision, approvedAt),
    {
      async materializeApprovedMappings(_database, input) {
        if (input.mappings.length !== 0) {
          throw new TypeError("Promotion fixture expects no repack mappings.");
        }
      },
    },
  );
  await harness.client.catalog_manifest_lifecycle_checkpoints.upsert({
    where: { organization_id: organizationId },
    create: {
      organization_id: organizationId,
      settled_sequence: approved.publicChangeSequence,
      source_head_sequence: approved.publicChangeSequence,
      settled_at: approvedAt,
      source_head_at: approvedAt,
      updated_at: approvedAt,
    },
    update: {
      settled_sequence: approved.publicChangeSequence,
      source_head_sequence: approved.publicChangeSequence,
      settled_at: approvedAt,
      source_head_at: approvedAt,
      updated_at: approvedAt,
    },
  });
}

export async function seedPromotionV2VerifiedEmptyBootstrap(
  harness: MigratedTestDatabase,
  organizationId: string,
  deploymentKey: string,
  providerKeys: readonly string[],
  verifiedAt: Date,
): Promise<void> {
  const evidence = await emptyCatalogPromotionBootstrapEvidence({
    platformKeys: providerKeys,
    operationTag: `seed-${organizationId.slice(-12)}-${deploymentKey.slice(0, 32)}`,
    observedAt: verifiedAt,
  });
  await new PrismaCatalogPromotionBootstrapProofRepository(harness.client, {
    organizationId,
    deploymentKey,
  }).verifyEmpty({ ...evidence, verifiedAt });
}

export interface ProviderPublicationFixture {
  readonly checkpoint: ProviderPromotionCheckpointIdentity;
  readonly summary: ProviderPromotionPreparedSummary;
  readonly operations: readonly ExactPromotionOperationInput[];
  readonly evidence: readonly ExactPromotionReceiptEvidence[];
  readonly terminalReceiptSha256: string;
}

export interface ManifestActivationFixture {
  readonly manifest: GlobalCatalogManifestV1;
  readonly summary: ManifestPromotionPreparedSummary;
  readonly operation: ExactPromotionOperationInput;
  readonly evidence: ExactPromotionReceiptEvidence;
  readonly activeState: ActiveCatalogManifestStateV1;
  readonly snapshotBody: string;
  readonly snapshotSha256: string;
}

export interface ManifestPreparedFixture {
  readonly summary: ManifestPromotionPreparedSummary;
  readonly operation: ExactPromotionOperationInput;
  readonly snapshotBody: string;
  readonly snapshotSha256: string;
}

function instant(sequence: bigint): Date {
  return new Date(Date.UTC(2026, 7, 16, 12, 0, Number(sequence)));
}

function epoch() {
  return {
    configurationKey: "catalog-v1",
    revision: 1,
    publicChangeSequence: "1",
    configurationHash: HASH_A,
  } as const;
}

function proof(
  platformKey: "alpha" | "beta",
  publicProviderReleaseId: string,
  sequence: bigint,
): ProviderReleaseImmutableProofV1 {
  const observedAt = instant(sequence);
  return {
    platformKey,
    sharedConfigurationEpoch: epoch(),
    dataAsOf: new Date(observedAt.getTime() - 2_000).toISOString(),
    publicProviderReleaseId,
    providerReleaseFingerprint: platformKey === "alpha" ? HASH_A : HASH_B,
    contentHash: HASH_C,
    publicAssetOrigins: [`https://${platformKey}.example`],
    governingHashes: {
      providerConfigurationHash: HASH_A,
      sharedCategoriesHash: HASH_B,
      identityMappingsHash: HASH_C,
      originSetHash: HASH_D,
      confidencePolicyHash: HASH_A,
    },
    entityHashes: {
      vendors: HASH_A,
      categories: HASH_B,
      collectibles: HASH_C,
      repacks: HASH_D,
      repack_chases: HASH_A,
      search_shards: HASH_B,
    },
    counts: {
      vendors: 1,
      categories: 0,
      collectibles: 0,
      repacks: 0,
      repackChases: 0,
      searchShards: 0,
    },
    searchAlgorithmVersion: "repack_search_v2",
    providerSearchIndexHash: HASH_C,
    batchCount: 1,
    batchChainHash: HASH_D,
  };
}

function emptyHead(platformKey: string): ProviderReleaseExpectedCompletedHeadV1 {
  return {
    platformKey,
    publicProviderReleaseId: null,
    sharedConfigurationEpoch: null,
    providerCheckpoint: { settledSequence: "0", settledAt: null },
    observation: null,
    terminalReceiptSha256: null,
  };
}

export function completedExpectedHead(
  fixture: ProviderPublicationFixture,
): ProviderReleaseExpectedCompletedHeadV1 {
  return {
    platformKey: fixture.summary.platformKey,
    publicProviderReleaseId: fixture.summary.publicProviderReleaseId,
    sharedConfigurationEpoch:
      fixture.summary.immutableProof.sharedConfigurationEpoch,
    providerCheckpoint: fixture.summary.providerCheckpoint,
    observation: fixture.summary.observation,
    terminalReceiptSha256: fixture.terminalReceiptSha256,
  };
}

function exactResponse(receipt: ProviderReleaseReceipt): string {
  return JSON.stringify({
    responseAuth: {
      signature: HASH_D,
      receiptDigest: receipt.receiptDigest,
      keyId: "publisher.v1",
      signatureVersion: "v1",
    },
    receipt,
    ok: true,
  }, null, 2);
}

async function receiptEvidence(
  body: Omit<ProviderReleaseReceipt, "receiptDigest">,
): Promise<ExactPromotionReceiptEvidence> {
  const receipt = {
    ...body,
    receiptDigest: await providerReleaseReceiptDigest(body),
  } as ProviderReleaseReceipt;
  return {
    canonicalReceiptBody: canonicalJson(receipt),
    exactResponseBody: exactResponse(receipt),
  };
}

export async function providerPublicationFixture(input: Readonly<{
  platformKey?: "alpha" | "beta";
  sequence?: bigint;
  classification?: "publish" | "reuse";
  predecessor?: ProviderReleaseExpectedCompletedHeadV1;
  publicProviderReleaseId?: string;
  immutableProof?: ProviderReleaseImmutableProofV1;
  operationTag?: string;
}> = {}): Promise<ProviderPublicationFixture> {
  const platformKey = input.platformKey ?? "alpha";
  const sequence = input.sequence ?? 10n;
  const classification = input.classification ?? "publish";
  const operationTag = input.operationTag ?? String(sequence);
  const publicProviderReleaseId = input.immutableProof
    ?.publicProviderReleaseId ?? input.publicProviderReleaseId ??
      releaseIds[platformKey];
  const generatedProof = proof(platformKey, publicProviderReleaseId, sequence);
  const release = input.immutableProof ?? {
    ...generatedProof,
    governingHashes: {
      ...generatedProof.governingHashes,
      originSetHash: await recomputeGlobalCatalogManifestOriginSetHashV1(
        generatedProof.publicAssetOrigins,
      ),
    },
  };
  const settledAt = instant(sequence);
  const observedAt = settledAt;
  const providerCheckpoint = {
    settledSequence: String(sequence),
    settledAt: settledAt.toISOString(),
  };
  const observation = {
    sourceHeadSequence: String(sequence),
    lastSuccessfulObservationAt: observedAt.toISOString(),
    staleAt: new Date(observedAt.getTime() + 900_000).toISOString(),
    freshness: "fresh" as const,
  };
  const expectedCompletedHead = input.predecessor ?? emptyHead(platformKey);
  const context = {
    release,
    providerCheckpoint,
    sourceWatermark: buildProviderCatalogSourceWatermarkV1(
      platformKey,
      String(sequence),
    ),
    observation,
    expectedCompletedHead,
  };
  const checkpoint: ProviderPromotionCheckpointIdentity = {
    platformKey,
    sharedConfigurationEpoch: {
      configurationKey: release.sharedConfigurationEpoch.configurationKey,
      revision: release.sharedConfigurationEpoch.revision,
      publicChangeSequence: BigInt(
        release.sharedConfigurationEpoch.publicChangeSequence,
      ),
      configurationHash: release.sharedConfigurationEpoch.configurationHash,
    },
    settledSequence: sequence,
    sourceHeadSequence: sequence,
    settledAt,
    sourceHeadAt: settledAt,
    lastSuccessfulObservationAt: observedAt,
    staleAt: new Date(observedAt.getTime() + 900_000),
    freshness: "fresh",
    blockedState: { kind: "ready" },
  };
  const operations: ExactPromotionOperationInput[] = [];
  if (classification === "reuse") {
    const operationId = `provider:reuse:${platformKey}:${operationTag}`;
    const request = {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      operationId,
      idempotencyKey: operationId,
      ...context,
    };
    operations.push({
      operationIndex: 0,
      operationId,
      operationKind: "confirmReuse",
      requestPath: PRODUCTION_PROVIDER_RELEASE_PATHS.confirmReuse,
      canonicalRequestBody: canonicalJson(request),
    });
  } else {
    const vendor = {
      publicVendorId: vendorIds[platformKey],
      vendorKey: platformKey,
      displayName: platformKey.toUpperCase(),
      logoUrl: null,
      websiteUrl: `https://${platformKey}.example`,
      listingHosts: [`${platformKey}.example`],
      imageOrigins: [`https://${platformKey}.example`],
      referralParameters: [],
      publicPromo: null,
    };
    const batch = {
      batchIndex: 0,
      kind: "vendors" as const,
      batchHash: HASH_A,
      byteCount: providerCatalogReleaseBatchByteCount([vendor]),
      records: [vendor],
    };
    const definitions = [
      {
        operationKind: "start",
        requestPath: PRODUCTION_PROVIDER_RELEASE_PATHS.start,
        operationId: `provider:start:${platformKey}:${operationTag}`,
        request: context,
      },
      {
        operationKind: "applyBatch",
        requestPath: PRODUCTION_PROVIDER_RELEASE_PATHS.applyBatch,
        operationId: `provider:batch:${platformKey}:${operationTag}:0`,
        request: { ...context, batch },
      },
      {
        operationKind: "finalize",
        requestPath: PRODUCTION_PROVIDER_RELEASE_PATHS.finalize,
        operationId: `provider:finalize:${platformKey}:${operationTag}`,
        request: context,
      },
    ] as const;
    definitions.forEach((definition, operationIndex) => {
      operations.push({
        operationIndex,
        operationId: definition.operationId,
        operationKind: definition.operationKind,
        requestPath: definition.requestPath,
        canonicalRequestBody: canonicalJson({
          schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
          operationId: definition.operationId,
          idempotencyKey: definition.operationId,
          ...definition.request,
        }),
      });
    });
  }
  const summary: ProviderPromotionPreparedSummary = {
    classification,
    platformKey,
    targetCheckpoint: sequence,
    checkpointSha256: promotionV2Sha256(
      providerCheckpointIdentityBody(checkpoint),
    ),
    publicProviderReleaseId,
    providerReleaseFingerprint: release.providerReleaseFingerprint,
    immutableProof: release,
    providerCheckpoint,
    observation,
    expectedCompletedHead,
    operationCount: operations.length,
  };
  const evidence: ExactPromotionReceiptEvidence[] = [];
  for (const operation of operations) {
    const common = {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      operationId: operation.operationId,
      idempotencyKey: operation.operationId,
      platformKey,
      publicProviderReleaseId,
      sharedConfigurationEpoch: release.sharedConfigurationEpoch,
      providerCheckpoint,
      serverTime: settledAt.toISOString(),
      requestDigest: promotionV2Sha256(operation.canonicalRequestBody),
    } as const;
    const completedHead = {
      platformKey,
      release,
      providerCheckpoint,
      observation,
    };
    let body: Omit<ProviderReleaseReceipt, "receiptDigest">;
    if (operation.operationKind === "start") {
      body = {
        ...common,
        operationKind: "start",
        terminalState: "staging",
        result: "created",
        details: { ...context, acceptedBatchCount: 0 },
      };
    } else if (operation.operationKind === "applyBatch") {
      const request = JSON.parse(operation.canonicalRequestBody) as {
        batch: { batchIndex: number; kind: "vendors"; batchHash: string;
          byteCount: number; records: readonly unknown[] };
      };
      body = {
        ...common,
        operationKind: "applyBatch",
        terminalState: "staging",
        result: "accepted",
        details: {
          ...context,
          batchIndex: request.batch.batchIndex,
          kind: request.batch.kind,
          batchHash: request.batch.batchHash,
          recordCount: request.batch.records.length,
          byteCount: request.batch.byteCount,
          acceptedBatchCount: 1,
          acceptedCounts: release.counts,
          acceptedEntityHashes: release.entityHashes,
          acceptedBatchChainHash: release.batchChainHash,
        },
      };
    } else if (operation.operationKind === "finalize") {
      body = {
        ...common,
        operationKind: "finalize",
        terminalState: "complete",
        result: "completed",
        details: { ...context, completedHead },
      };
    } else {
      body = {
        ...common,
        operationKind: "confirmReuse",
        terminalState: "complete",
        result: "reused",
        details: { ...context, completedHead },
      };
    }
    evidence.push(await receiptEvidence(body));
  }
  return {
    checkpoint,
    summary,
    operations,
    evidence,
    terminalReceiptSha256: promotionV2Sha256(
      evidence.at(-1)!.canonicalReceiptBody,
    ),
  };
}

export async function manifestActivationFixture(input: Readonly<{
  publication: ProviderPublicationFixture;
  organizationId: string;
  evaluationSequence: bigint;
  publishArtifactAttemptId: string;
  operationTag?: string;
}>): Promise<ManifestActivationFixture> {
  const release = input.publication.summary.immutableProof;
  const reference = { ...release };
  const references = [reference];
  const [
    providerReferenceSetHash,
    providerConfigurationsHash,
    sharedCategoriesHash,
    identityMappingsHash,
    originSetHash,
    entityHashes,
    repackSearchIndexHash,
    sharedCategoryIdentityBytesHash,
    sharedCollectibleIdentityBytesHash,
    uniqueVendorOwnershipHash,
    uniqueRepackOwnershipHash,
    crossReferenceGraphHash,
  ] = await Promise.all([
    recomputeGlobalCatalogProviderReferenceSetHashV1(references),
    recomputeGlobalCatalogProviderConfigurationsHashV1(references),
    recomputeGlobalCatalogSharedCategoriesHashV1(references),
    recomputeGlobalCatalogIdentityMappingsHashV1(references),
    recomputeGlobalCatalogManifestOriginSetHashV1(
      reference.publicAssetOrigins,
    ),
    recomputeGlobalCatalogManifestEntityHashesV1(references),
    recomputeGlobalCatalogManifestSearchIndexHashV1(references),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "shared_category_identity_bytes", canonicalProof: [],
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "shared_collectible_identity_bytes", canonicalProof: [],
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "unique_vendor_ownership",
      canonicalProof: [`${reference.platformKey}:${reference.publicProviderReleaseId}`],
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "unique_repack_ownership", canonicalProof: [],
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "cross_reference_graph", canonicalProof: [],
    }),
  ]);
  const contentHash = await recomputeGlobalCatalogManifestContentHashV1({
    entityHashes,
  });
  const identity = {
    schemaVersion: "global_catalog_manifest_v1" as const,
    dataSource: "canonical" as const,
    sharedConfigurationEpoch: reference.sharedConfigurationEpoch,
    enabledPlatformKeys: [reference.platformKey],
    providerReferenceSetHash,
    providerReferences: references,
    governingHashes: {
      providerConfigurationsHash,
      sharedCategoriesHash,
      identityMappingsHash,
      originSetHash,
      confidencePolicyHash: reference.governingHashes.confidencePolicyHash,
    },
    compositionProof: {
      sharedCategoryIdentityBytesHash,
      sharedCollectibleIdentityBytesHash,
      uniqueVendorOwnershipHash,
      uniqueRepackOwnershipHash,
      crossReferenceGraphHash,
    },
    entityHashes,
    counts: {
      vendors: 1,
      categories: reference.counts.categories,
      collectibles: reference.counts.collectibles,
      repacks: reference.counts.repacks,
      repackChases: reference.counts.repackChases,
      searchShards: reference.counts.searchShards,
    },
    contentHash,
    publicAssetOrigins: reference.publicAssetOrigins,
    searchAlgorithmVersion: reference.searchAlgorithmVersion,
    repackSearchIndexHash,
    confidencePolicyVersion: "confidence-v1",
  };
  const manifest = await verifyGlobalCatalogManifestV1({
    ...identity,
    publicReleaseId: await derivePublicCatalogReleaseIdV1(identity),
    manifestFingerprint: await recomputeGlobalCatalogManifestFingerprintV1(
      identity,
    ),
  });
  const terminal = input.publication.operations.at(-1)!;
  const completedHeadBody = canonicalJson({
    platformKey: reference.platformKey,
    release: reference,
    providerCheckpoint: input.publication.summary.providerCheckpoint,
    observation: input.publication.summary.observation,
  });
  const providerSelection = {
    platformKey: reference.platformKey,
    publicProviderReleaseId: reference.publicProviderReleaseId,
    terminalOperationKind: terminal.operationKind === "finalize"
      ? "finalize" as const : "confirmReuse" as const,
    terminalOperationId: terminal.operationId,
    terminalReceiptSha256: input.publication.terminalReceiptSha256,
    selectedProviderCheckpoint: input.publication.summary.providerCheckpoint,
    selectedDataAsOf: reference.dataAsOf,
    latestAffectedSettledSequence:
      input.publication.summary.providerCheckpoint.settledSequence,
    latestAffectedSourceHeadSequence:
      input.publication.summary.observation.sourceHeadSequence,
    initialBackfillComplete: true,
    affectedDerivationsSettled: true,
    settledSourceFreshness: "fresh" as const,
    lastSuccessfulObservationAt:
      input.publication.summary.observation.lastSuccessfulObservationAt,
    staleAt: input.publication.summary.observation.staleAt,
  };
  const observation = buildGlobalCatalogAggregateObservationV1({
    observationSequence: 1,
    publicReleaseId: manifest.publicReleaseId,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    providerSelections: [providerSelection],
  });
  const emptyState: ActiveCatalogManifestStateV1 = {
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  };
  const completedAt = instant(
    BigInt(input.publication.summary.providerCheckpoint.settledSequence),
  ).toISOString();
  const pointer = {
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    createdAt: completedAt,
    completedAt,
  };
  const operationId = `manifest:activate:${input.operationTag ??
    String(input.evaluationSequence)}`;
  const request = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId,
    idempotencyKey: operationId,
    manifest,
    observation,
    expectedActiveState: emptyState,
  };
  const operation: ExactPromotionOperationInput = {
    operationIndex: 0,
    operationId,
    operationKind: "activateManifest",
    requestPath: PRODUCTION_CATALOG_MANIFEST_PATHS.activateManifest,
    canonicalRequestBody: canonicalJson(request),
  };
  const receiptWithoutDigest = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationKind: "activateManifest" as const,
    operationId,
    idempotencyKey: operationId,
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    terminalState: "complete" as const,
    result: "activated" as const,
    serverTime: completedAt,
    requestDigest: promotionV2Sha256(operation.canonicalRequestBody),
    details: {
      expectedActiveState: emptyState,
      activeState: {
        generation: 1,
        activeManifest: pointer,
        previousManifest: null,
        observation,
      },
    },
  };
  const receipt = {
    ...receiptWithoutDigest,
    receiptDigest: await catalogManifestReceiptDigest(receiptWithoutDigest),
  } satisfies CatalogManifestReceipt;
  const receiptBody = canonicalJson(receipt);
  const evidence = {
    canonicalReceiptBody: receiptBody,
    exactResponseBody: JSON.stringify({
      responseAuth: {
        signature: HASH_D,
        receiptDigest: receipt.receiptDigest,
        keyId: "publisher.v1",
        signatureVersion: "v1",
      },
      receipt,
      ok: true,
    }, null, 2),
  };
  const activeState: ActiveCatalogManifestStateV1 = {
    ...receipt.details.activeState,
    terminalReceiptSha256: promotionV2Sha256(receiptBody),
  };
  const completedHeadSha256 = promotionV2Sha256(completedHeadBody);
  const snapshotBody = canonicalJson({
    schemaVersion: 1,
    evaluationSequence: String(input.evaluationSequence),
    eligibility: {
      organizationId: input.organizationId,
      sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
      confidencePolicyVersion: manifest.confidencePolicyVersion,
      staleAfterSeconds: 900,
      configuredPlatformKeys: [reference.platformKey],
      enabledPlatformKeys: [reference.platformKey],
      lifecycleDecisionSequence:
        manifest.sharedConfigurationEpoch.publicChangeSequence,
      checkpointDigests: [{
        platformKey: reference.platformKey,
        settledSequence:
          input.publication.summary.providerCheckpoint.settledSequence,
        sourceHeadSequence:
          input.publication.summary.observation.sourceHeadSequence,
        checkpointDigest: HASH_A,
      }],
    },
    providerFacts: [{
      platformKey: reference.platformKey,
      minimumEligibleCheckpoint:
        manifest.sharedConfigurationEpoch.publicChangeSequence,
      initialBackfillComplete: true,
      completedBackfillAt: input.publication.summary.providerCheckpoint.settledAt,
      lastSuccessfulObservationAt:
        input.publication.summary.observation.lastSuccessfulObservationAt,
      staleAt: input.publication.summary.observation.staleAt,
      latestAffectedSettledSequence:
        input.publication.summary.providerCheckpoint.settledSequence,
      latestAffectedSourceHeadSequence:
        input.publication.summary.observation.sourceHeadSequence,
      affectedDerivationsSettled: true,
      settledSourceFreshness: "fresh",
      completedHead: {
        publicProviderReleaseId: reference.publicProviderReleaseId,
        providerReleaseFingerprint: reference.providerReleaseFingerprint,
        selectedCheckpoint:
          input.publication.summary.providerCheckpoint.settledSequence,
        proofDigest: completedHeadSha256,
        terminalReceiptSha256: input.publication.terminalReceiptSha256,
        publishArtifactAttemptId: input.publishArtifactAttemptId,
        terminalOperationKind: providerSelection.terminalOperationKind,
        terminalOperationId: providerSelection.terminalOperationId,
        selectedProviderCheckpoint:
          input.publication.summary.providerCheckpoint,
        selectedDataAsOf: reference.dataAsOf,
      },
      activeFallback: null,
    }],
    activeStateBody: canonicalJson(emptyState),
    activeStateSha256: promotionV2Sha256(canonicalJson(emptyState)),
  });
  const snapshotSha256 = promotionV2Sha256(snapshotBody);
  return {
    manifest,
    operation,
    evidence,
    activeState,
    snapshotBody,
    snapshotSha256,
    summary: {
      operationKind: "activateManifest",
      evaluationSnapshotSha256: snapshotSha256,
      expectedActiveState: emptyState,
      sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
      enabledPlatformKeys: [reference.platformKey],
      providerSelections: [{
        platformKey: reference.platformKey,
        source: "completed_head",
        proofDigest: completedHeadSha256,
        publicProviderReleaseId: reference.publicProviderReleaseId,
        providerReleaseFingerprint: reference.providerReleaseFingerprint,
        selectedCheckpoint:
          input.publication.summary.providerCheckpoint.settledSequence,
        terminalReceiptSha256: input.publication.terminalReceiptSha256,
      }],
      manifestIdentity: {
        publicReleaseId: manifest.publicReleaseId,
        manifestFingerprint: manifest.manifestFingerprint,
        sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
        providerReferenceSetHash: manifest.providerReferenceSetHash,
      },
    },
  };
}

export async function manifestActiveStateEvidence(input: Readonly<{
  state: ActiveCatalogManifestStateV1;
  operationTag: string;
}>): Promise<ExactPromotionReceiptEvidence & { readonly requestBody: string }> {
  const operationId = `manifest:active-state:${input.operationTag}`;
  const requestBody = canonicalJson({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId,
  });
  const withoutDigest = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationKind: "activeState" as const,
    operationId,
    terminalState: "observed" as const,
    result: "active_state" as const,
    serverTime: instant(40n).toISOString(),
    requestDigest: promotionV2Sha256(requestBody),
    details: { activeState: input.state },
  };
  const receipt = {
    ...withoutDigest,
    receiptDigest: await catalogManifestReceiptDigest(withoutDigest),
  } satisfies CatalogManifestReceipt;
  return { requestBody, canonicalReceiptBody: canonicalJson(receipt) };
}

export async function emptyCatalogPromotionBootstrapEvidence(input: Readonly<{
  platformKeys: readonly string[];
  operationTag: string;
  observedAt: Date;
}>): Promise<Readonly<{
  activeStateRequestBody: string;
  activeStateReceiptBody: string;
  providers: readonly CatalogPromotionBootstrapProviderProof[];
}>> {
  const activeState = {
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  } as const;
  const activeOperationId = `manifest:active-state:${input.operationTag}`;
  const activeStateRequestBody = canonicalJson({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: activeOperationId,
  });
  const activeReceiptWithoutDigest = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationKind: "activeState" as const,
    operationId: activeOperationId,
    terminalState: "observed" as const,
    result: "active_state" as const,
    serverTime: input.observedAt.toISOString(),
    requestDigest: promotionV2Sha256(activeStateRequestBody),
    details: { activeState },
  };
  const activeStateReceiptBody = canonicalJson({
    ...activeReceiptWithoutDigest,
    receiptDigest: await catalogManifestReceiptDigest(
      activeReceiptWithoutDigest,
    ),
  });
  const providers: CatalogPromotionBootstrapProviderProof[] = [];
  for (const platformKey of input.platformKeys) {
    const operationId = `provider:completed-head:${platformKey}:${input.operationTag}`;
    const requestBody = canonicalJson({
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      operationId,
      platformKey,
    });
    const remoteHead = {
      platformKey,
      release: null,
      providerCheckpoint: { settledSequence: "0", settledAt: null },
      observation: null,
      terminalReceiptSha256: null,
    } as const;
    const receiptWithoutDigest = {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      operationKind: "completedHead" as const,
      operationId,
      platformKey,
      publicProviderReleaseId: null,
      terminalState: "observed" as const,
      result: "completed_head" as const,
      serverTime: input.observedAt.toISOString(),
      requestDigest: promotionV2Sha256(requestBody),
      details: { head: remoteHead },
    };
    providers.push({
      platformKey,
      activeReference: null,
      completedHeadProbe: {
        requestBody,
        receiptBody: canonicalJson({
          ...receiptWithoutDigest,
          receiptDigest: await providerReleaseReceiptDigest(
            receiptWithoutDigest,
          ),
        }),
        remoteHead,
      },
      localCompletedHead: null,
    });
  }
  return { activeStateRequestBody, activeStateReceiptBody, providers };
}

export function manifestRefreshFixture(input: Readonly<{
  publication: ProviderPublicationFixture;
  manifest: GlobalCatalogManifestV1;
  activeState: ActiveCatalogManifestStateV1;
  organizationId: string;
  evaluationSequence: bigint;
  publishArtifactAttemptId: string;
  operationTag: string;
}>): ManifestPreparedFixture {
  if (input.activeState.observation === null) {
    throw new TypeError("Refresh fixture requires active observation.");
  }
  const reference = input.publication.summary.immutableProof;
  const terminal = input.publication.operations.at(-1)!;
  const completedHeadSha256 = promotionV2Sha256(canonicalJson({
    platformKey: reference.platformKey,
    release: reference,
    providerCheckpoint: input.publication.summary.providerCheckpoint,
    observation: input.publication.summary.observation,
  }));
  const providerSelection = {
    platformKey: reference.platformKey,
    publicProviderReleaseId: reference.publicProviderReleaseId,
    terminalOperationKind: terminal.operationKind === "finalize"
      ? "finalize" as const : "confirmReuse" as const,
    terminalOperationId: terminal.operationId,
    terminalReceiptSha256: input.publication.terminalReceiptSha256,
    selectedProviderCheckpoint: input.publication.summary.providerCheckpoint,
    selectedDataAsOf: reference.dataAsOf,
    latestAffectedSettledSequence:
      input.publication.summary.providerCheckpoint.settledSequence,
    latestAffectedSourceHeadSequence:
      input.publication.summary.observation.sourceHeadSequence,
    initialBackfillComplete: true,
    affectedDerivationsSettled: true,
    settledSourceFreshness: "fresh" as const,
    lastSuccessfulObservationAt:
      input.publication.summary.observation.lastSuccessfulObservationAt,
    staleAt: input.publication.summary.observation.staleAt,
  };
  const observation = buildGlobalCatalogAggregateObservationV1({
    observationSequence: input.activeState.observation.observationSequence + 1,
    publicReleaseId: input.manifest.publicReleaseId,
    providerReferenceSetHash: input.manifest.providerReferenceSetHash,
    providerSelections: [providerSelection],
  });
  const snapshotBody = canonicalJson({
    schemaVersion: 1,
    evaluationSequence: String(input.evaluationSequence),
    eligibility: {
      organizationId: input.organizationId,
      sharedConfigurationEpoch: input.manifest.sharedConfigurationEpoch,
      confidencePolicyVersion: input.manifest.confidencePolicyVersion,
      staleAfterSeconds: 900,
      configuredPlatformKeys: [reference.platformKey],
      enabledPlatformKeys: [reference.platformKey],
      lifecycleDecisionSequence:
        input.manifest.sharedConfigurationEpoch.publicChangeSequence,
      checkpointDigests: [{
        platformKey: reference.platformKey,
        settledSequence:
          input.publication.summary.providerCheckpoint.settledSequence,
        sourceHeadSequence:
          input.publication.summary.observation.sourceHeadSequence,
        checkpointDigest: HASH_A,
      }],
    },
    providerFacts: [{
      platformKey: reference.platformKey,
      minimumEligibleCheckpoint:
        input.manifest.sharedConfigurationEpoch.publicChangeSequence,
      initialBackfillComplete: true,
      completedBackfillAt: input.publication.summary.providerCheckpoint.settledAt,
      lastSuccessfulObservationAt:
        input.publication.summary.observation.lastSuccessfulObservationAt,
      staleAt: input.publication.summary.observation.staleAt,
      latestAffectedSettledSequence:
        input.publication.summary.providerCheckpoint.settledSequence,
      latestAffectedSourceHeadSequence:
        input.publication.summary.observation.sourceHeadSequence,
      affectedDerivationsSettled: true,
      settledSourceFreshness: "fresh",
      completedHead: {
        publicProviderReleaseId: reference.publicProviderReleaseId,
        providerReleaseFingerprint: reference.providerReleaseFingerprint,
        selectedCheckpoint:
          input.publication.summary.providerCheckpoint.settledSequence,
        proofDigest: completedHeadSha256,
        terminalReceiptSha256: input.publication.terminalReceiptSha256,
        publishArtifactAttemptId: input.publishArtifactAttemptId,
        terminalOperationKind: providerSelection.terminalOperationKind,
        terminalOperationId: providerSelection.terminalOperationId,
        selectedProviderCheckpoint:
          input.publication.summary.providerCheckpoint,
        selectedDataAsOf: reference.dataAsOf,
      },
      activeFallback: null,
    }],
    activeStateBody: canonicalJson(input.activeState),
    activeStateSha256: promotionV2Sha256(canonicalJson(input.activeState)),
  });
  const snapshotSha256 = promotionV2Sha256(snapshotBody);
  const manifestIdentity = {
    publicReleaseId: input.manifest.publicReleaseId,
    manifestFingerprint: input.manifest.manifestFingerprint,
    sharedConfigurationEpoch: input.manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: input.manifest.providerReferenceSetHash,
  };
  const summary: ManifestPromotionPreparedSummary = {
    operationKind: "refreshActiveState",
    evaluationSnapshotSha256: snapshotSha256,
    expectedActiveState: input.activeState,
    sharedConfigurationEpoch: input.manifest.sharedConfigurationEpoch,
    enabledPlatformKeys: [reference.platformKey],
    providerSelections: [{
      platformKey: reference.platformKey,
      source: "completed_head",
      proofDigest: completedHeadSha256,
      publicProviderReleaseId: reference.publicProviderReleaseId,
      providerReleaseFingerprint: reference.providerReleaseFingerprint,
      selectedCheckpoint:
        input.publication.summary.providerCheckpoint.settledSequence,
      terminalReceiptSha256: input.publication.terminalReceiptSha256,
    }],
    manifestIdentity,
  };
  const operationId = `manifest:refresh:${input.operationTag}`;
  const operation: ExactPromotionOperationInput = {
    operationIndex: 0,
    operationId,
    operationKind: "refreshActiveState",
    requestPath: PRODUCTION_CATALOG_MANIFEST_PATHS.refreshActiveState,
    canonicalRequestBody: canonicalJson({
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationId,
      idempotencyKey: operationId,
      manifest: manifestIdentity,
      observation,
      expectedActiveState: input.activeState,
    }),
  };
  return { summary, operation, snapshotBody, snapshotSha256 };
}
