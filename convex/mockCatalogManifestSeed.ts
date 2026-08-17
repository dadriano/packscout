import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestPublicationRequestDigest,
  derivePublicCatalogReleaseIdV1,
  globalCatalogProviderReferenceV1Schema,
  providerReleaseCompletionReceiptSchema,
  providerReleasePublicationRequestDigest,
  providerReleaseTerminalReceiptSha256,
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
  verifyProviderCatalogReleasePlanV1,
  type GlobalCatalogManifestV1,
  type GlobalCatalogProviderActiveObservationV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseImmutableProofV1,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
  type PublicRepackDetail,
  type PublicVendor,
} from "@packscout/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { activateCatalogManifestRequest } from "./catalogManifestActivate";
import { refuseCatalogManifest } from "./catalogManifestErrors";
import {
  loadActiveCatalogManifestState,
  loadValidatedCatalogManifest,
} from "./catalogManifestState";
import {
  writeProviderCategories,
  writeProviderCollectibles,
  writeProviderRepacks,
  writeProviderVendors,
} from "./providerCatalogEntityWrites";
import {
  writeProviderRepackChases,
  writeProviderSearchShards,
} from "./providerCatalogDependentWrites";
import {
  buildProviderReleaseReceipt,
  loadProviderOperationById,
  storeProviderReleaseReceipt,
} from "./providerReleaseOperations";
import {
  assertStoredProviderReleaseCompletion,
  providerReleaseProofMatches,
} from "./providerReleaseProof";
import { oneProviderCompletedHead, oneProviderRelease } from "./providerReleaseState";

const COMPLETE_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

export type SeedMockCatalogManifestGraphResult = Readonly<{
  status: "created" | "unchanged";
  publicReleaseId: string;
  manifestId: Id<"globalCatalogManifests">;
  stateId: Id<"activeCatalogManifestState">;
  providerReleaseIds: readonly Id<"providerCatalogReleases">[];
  manifest: GlobalCatalogManifestV1;
}>;

function immutableProof(
  plan: ProviderCatalogReleasePublishPlanV1,
): ProviderReleaseImmutableProofV1 {
  return {
    platformKey: plan.platformKey,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
    providerReleaseFingerprint: plan.providerReleaseFingerprint,
    contentHash: plan.contentHash,
    publicAssetOrigins: plan.publicAssetOrigins,
    governingHashes: plan.governingHashes,
    entityHashes: plan.entityHashes,
    counts: plan.counts,
    searchAlgorithmVersion: plan.searchAlgorithmVersion,
    providerSearchIndexHash: plan.providerSearchIndexHash,
    batchCount: plan.batchCount,
    batchChainHash: plan.batchChainHash,
    dataAsOf: plan.dataAsOf,
  };
}

function recordsForKind<T>(
  plan: ProviderCatalogReleasePublishPlanV1,
  kind: ProviderCatalogReleasePublishPlanV1["batches"][number]["kind"],
): readonly T[] {
  return plan.batches
    .filter((batch) => batch.kind === kind)
    .flatMap((batch) => batch.records as unknown as readonly T[]);
}

async function writeProviderEntities(
  ctx: MutationCtx,
  release: Doc<"providerCatalogReleases">,
  plan: ProviderCatalogReleasePublishPlanV1,
): Promise<void> {
  const approvedOrigins = new Set(plan.publicAssetOrigins);
  await writeProviderVendors(
    ctx,
    release._id,
    recordsForKind<PublicVendor>(plan, "vendors"),
    approvedOrigins,
  );
  await writeProviderCategories(
    ctx,
    release._id,
    recordsForKind<PublicCategory>(plan, "categories"),
  );
  await writeProviderCollectibles(
    ctx,
    release,
    recordsForKind<PublicCollectible>(plan, "collectibles"),
    approvedOrigins,
  );
  const settledAt = plan.providerCheckpoint.settledAt;
  if (settledAt === null) {
    refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_RELEASE_INVALID");
  }
  await writeProviderRepacks(
    ctx,
    release,
    recordsForKind<PublicRepackDetail>(plan, "repacks"),
    {
      lastSuccessfulObservationAt:
        plan.observation.lastSuccessfulObservationAt,
      checkpointSettledAt: settledAt,
    },
  );
  await writeProviderRepackChases(
    ctx,
    release,
    recordsForKind<PublicRepackChase>(plan, "repack_chases"),
  );
  await writeProviderSearchShards(
    ctx,
    release._id,
    recordsForKind(plan, "search_shards"),
    0,
    null,
  );
}

export async function seedProviderCatalogPublishPlanGraph(
  ctx: MutationCtx,
  plan: ProviderCatalogReleasePublishPlanV1,
  serverTime: string,
): Promise<Readonly<{
  release: Doc<"providerCatalogReleases">;
  selection: GlobalCatalogProviderActiveObservationV1;
}>> {
  const proof = immutableProof(plan);
  const existing = await oneProviderRelease(
    ctx,
    plan.platformKey,
    plan.publicProviderReleaseId,
  );
  if (existing !== null) {
    if (!providerReleaseProofMatches(existing, proof)) {
      refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_RELEASE_INVALID");
    }
    try {
      await assertStoredProviderReleaseCompletion(ctx, existing);
    } catch {
      refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_RELEASE_INCOMPLETE");
    }
    const head = await oneProviderCompletedHead(ctx, plan.platformKey);
    const terminal = head === null
      ? null
      : await loadProviderOperationById(ctx, head.terminalOperationId);
    if (
      head === null || terminal === null || head.releaseId !== existing._id ||
      (terminal.receipt.operationKind !== "finalize" &&
        terminal.receipt.operationKind !== "confirmReuse")
    ) {
      refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
    }
    return {
      release: existing,
      selection: {
        platformKey: existing.platformKey,
        publicProviderReleaseId: existing.publicProviderReleaseId,
        terminalOperationKind: terminal.receipt.operationKind,
        terminalOperationId: head.terminalOperationId,
        terminalReceiptSha256: head.terminalReceiptSha256,
        selectedProviderCheckpoint: head.providerCheckpoint,
        selectedDataAsOf: existing.dataAsOf,
        latestAffectedSettledSequence: head.providerCheckpoint.settledSequence,
        latestAffectedSourceHeadSequence: head.observation.sourceHeadSequence,
        initialBackfillComplete: true,
        affectedDerivationsSettled: true,
        settledSourceFreshness: head.observation.freshness,
        lastSuccessfulObservationAt:
          head.observation.lastSuccessfulObservationAt,
        staleAt: head.observation.staleAt,
      },
    };
  }

  const operationId = `mock.provider.finalize:${plan.platformKey}`;
  const idempotencyKey = `mock.provider.finalize:${plan.platformKey}`;
  const requestDigest = await providerReleasePublicationRequestDigest({
    kind: "mock_provider_finalize",
    release: proof,
    providerCheckpoint: plan.providerCheckpoint,
    observation: plan.observation,
  });
  const expectedCompletedHead = {
    platformKey: plan.platformKey,
    publicProviderReleaseId: null,
    sharedConfigurationEpoch: null,
    providerCheckpoint: { settledSequence: "0", settledAt: null },
    observation: null,
    terminalReceiptSha256: null,
  } as const;
  const completedHead = {
    platformKey: plan.platformKey,
    release: proof,
    providerCheckpoint: plan.providerCheckpoint,
    observation: plan.observation,
  };
  const receipt = await buildProviderReleaseReceipt(
    (value) => providerReleaseCompletionReceiptSchema.parse(value),
    {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      operationKind: "finalize",
      operationId,
      idempotencyKey,
      platformKey: plan.platformKey,
      publicProviderReleaseId: plan.publicProviderReleaseId,
      sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
      providerCheckpoint: plan.providerCheckpoint,
      terminalState: "complete",
      result: "completed",
      serverTime,
      requestDigest,
      details: {
        release: proof,
        providerCheckpoint: plan.providerCheckpoint,
        sourceWatermark: plan.sourceWatermark,
        observation: plan.observation,
        expectedCompletedHead,
        completedHead,
      },
    },
  );
  const terminalReceiptSha256 =
    await providerReleaseTerminalReceiptSha256(receipt);
  const releaseId = await ctx.db.insert("providerCatalogReleases", {
    ...proof,
    lifecycle: "complete",
    createdAt: serverTime,
    completedAt: serverTime,
    completionOperationId: operationId,
    completionReceiptSha256: terminalReceiptSha256,
    retentionEligibleAt: new Date(
      Date.parse(serverTime) + COMPLETE_RETENTION_MILLISECONDS,
    ).toISOString(),
  });
  const release = await ctx.db.get("providerCatalogReleases", releaseId);
  if (release === null) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  await writeProviderEntities(ctx, release, plan);
  await storeProviderReleaseReceipt(ctx, receipt);
  await ctx.db.insert("providerCatalogCompletedHeads", {
    platformKey: plan.platformKey,
    releaseId,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
    providerCheckpoint: plan.providerCheckpoint,
    observation: plan.observation,
    terminalReceiptSha256,
    terminalOperationId: operationId,
    terminalOperationKind: "finalize",
    updatedAt: serverTime,
  });
  return {
    release,
    selection: {
      platformKey: plan.platformKey,
      publicProviderReleaseId: plan.publicProviderReleaseId,
      terminalOperationKind: "finalize",
      terminalOperationId: operationId,
      terminalReceiptSha256,
      selectedProviderCheckpoint: plan.providerCheckpoint,
      selectedDataAsOf: plan.dataAsOf,
      latestAffectedSettledSequence: plan.providerCheckpoint.settledSequence,
      latestAffectedSourceHeadSequence: plan.observation.sourceHeadSequence,
      initialBackfillComplete: true,
      affectedDerivationsSettled: true,
      settledSourceFreshness: plan.observation.freshness,
      lastSuccessfulObservationAt: plan.observation.lastSuccessfulObservationAt,
      staleAt: plan.observation.staleAt,
    },
  };
}

function canonicalUnique<T>(
  values: readonly T[],
  id: (value: T) => string,
  allowByteIdenticalDuplicates: boolean,
): readonly T[] {
  const byId = new Map<string, T>();
  for (const value of values) {
    const key = id(value);
    const existing = byId.get(key);
    if (
      existing !== undefined &&
      (!allowByteIdenticalDuplicates ||
        canonicalJson(existing) !== canonicalJson(value))
    ) {
      refuseCatalogManifest("CATALOG_MANIFEST_OWNERSHIP_MISMATCH");
    }
    byId.set(key, value);
  }
  return [...byId.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, value]) => value);
}

export async function buildCatalogManifestFromProviderPlans(
  plans: readonly ProviderCatalogReleasePublishPlanV1[],
  confidencePolicyVersion: string,
  dataSource: "canonical" | "mock" = "mock",
): Promise<GlobalCatalogManifestV1> {
  const providerReferences = plans.map((plan) =>
    globalCatalogProviderReferenceV1Schema.parse(immutableProof(plan)),
  );
  const vendors = plans.flatMap((plan) =>
    recordsForKind<PublicVendor>(plan, "vendors"),
  );
  const categories = canonicalUnique(
    plans.flatMap((plan) =>
      recordsForKind<PublicCategory>(plan, "categories"),
    ),
    ({ publicCategoryId }) => publicCategoryId,
    true,
  );
  const collectibles = canonicalUnique(
    plans.flatMap((plan) =>
      recordsForKind<PublicCollectible>(plan, "collectibles"),
    ),
    ({ publicCollectibleId }) => publicCollectibleId,
    true,
  );
  const repacks = plans.flatMap((plan) =>
    recordsForKind<PublicRepackDetail>(plan, "repacks"),
  );
  canonicalUnique(vendors, ({ publicVendorId }) => publicVendorId, false);
  canonicalUnique(repacks, ({ publicRepackId }) => publicRepackId, false);
  const publicAssetOrigins = providerReferences[0]!.publicAssetOrigins;
  if (
    providerReferences.some((reference) =>
      canonicalJson(reference.publicAssetOrigins) !==
        canonicalJson(publicAssetOrigins)
    ) ||
    providerReferences.some((reference) =>
      reference.governingHashes.confidencePolicyHash !==
        providerReferences[0]!.governingHashes.confidencePolicyHash
    )
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_HASH_MISMATCH");
  }
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
    recomputeGlobalCatalogProviderReferenceSetHashV1(providerReferences),
    recomputeGlobalCatalogProviderConfigurationsHashV1(providerReferences),
    recomputeGlobalCatalogSharedCategoriesHashV1(providerReferences),
    recomputeGlobalCatalogIdentityMappingsHashV1(providerReferences),
    recomputeGlobalCatalogManifestOriginSetHashV1(publicAssetOrigins),
    recomputeGlobalCatalogManifestEntityHashesV1(providerReferences),
    recomputeGlobalCatalogManifestSearchIndexHashV1(providerReferences),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "shared_category_identity_bytes",
      canonicalProof: categories,
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "shared_collectible_identity_bytes",
      canonicalProof: collectibles,
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "unique_vendor_ownership",
      canonicalProof: plans.flatMap((plan) =>
        recordsForKind<PublicVendor>(plan, "vendors").map((vendor) => ({
          platformKey: plan.platformKey,
          publicVendorId: vendor.publicVendorId,
        })),
      ),
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "unique_repack_ownership",
      canonicalProof: plans.flatMap((plan) =>
        recordsForKind<PublicRepackDetail>(plan, "repacks").map((repack) => ({
          platformKey: plan.platformKey,
          publicRepackId: repack.publicRepackId,
        })),
      ),
    }),
    recomputeGlobalCatalogCompositionProofHashV1({
      kind: "cross_reference_graph",
      canonicalProof: plans.map((plan) => ({
        platformKey: plan.platformKey,
        categories: recordsForKind<PublicCategory>(plan, "categories").map(
          ({ publicCategoryId, parentPublicCategoryId }) => ({
            publicCategoryId,
            parentPublicCategoryId,
          }),
        ),
        repacks: recordsForKind<PublicRepackDetail>(plan, "repacks").map(
          ({ publicRepackId, publicVendorId, categories: projections }) => ({
            publicRepackId,
            publicVendorId,
            publicCategoryIds: projections.map(({ publicCategoryId }) =>
              publicCategoryId
            ),
          }),
        ),
        chases: recordsForKind<PublicRepackChase>(plan, "repack_chases").map(
          ({ publicRepackId, publicCollectibleId }) => ({
            publicRepackId,
            publicCollectibleId,
          }),
        ),
      })),
    }),
  ]);
  const contentHash = await recomputeGlobalCatalogManifestContentHashV1({
    entityHashes,
  });
  const identity = {
    schemaVersion: "global_catalog_manifest_v1" as const,
    dataSource,
    sharedConfigurationEpoch: providerReferences[0]!.sharedConfigurationEpoch,
    enabledPlatformKeys: providerReferences.map(({ platformKey }) => platformKey),
    providerReferenceSetHash,
    providerReferences,
    governingHashes: {
      providerConfigurationsHash,
      sharedCategoriesHash,
      identityMappingsHash,
      originSetHash,
      confidencePolicyHash:
        providerReferences[0]!.governingHashes.confidencePolicyHash,
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
      vendors: vendors.length,
      categories: categories.length,
      collectibles: collectibles.length,
      repacks: repacks.length,
      repackChases: plans.reduce(
        (sum, plan) => sum + plan.counts.repackChases,
        0,
      ),
      searchShards: plans.reduce(
        (sum, plan) => sum + plan.counts.searchShards,
        0,
      ),
    },
    contentHash,
    publicAssetOrigins,
    searchAlgorithmVersion: "repack_search_v2" as const,
    repackSearchIndexHash,
    confidencePolicyVersion,
  };
  const [publicReleaseId, manifestFingerprint] = await Promise.all([
    derivePublicCatalogReleaseIdV1(identity),
    recomputeGlobalCatalogManifestFingerprintV1(identity),
  ]);
  return await verifyGlobalCatalogManifestV1({
    ...identity,
    publicReleaseId,
    manifestFingerprint,
  });
}

export async function seedMockCatalogManifestGraph(
  ctx: MutationCtx,
  input: Readonly<{
    plans: readonly ProviderCatalogReleasePublishPlanV1[];
    confidencePolicyVersion: string;
    serverTime: string;
    observationSequence?: number;
  }>,
): Promise<SeedMockCatalogManifestGraphResult> {
  if (input.plans.length < 1 || input.plans.length > 8) {
    refuseCatalogManifest("CATALOG_MANIFEST_AGGREGATE_LIMIT_EXCEEDED");
  }
  const plans = await Promise.all(input.plans.map(async (plan) => {
    const verified = await verifyProviderCatalogReleasePlanV1(plan);
    if (verified.classification !== "publish") {
      refuseCatalogManifest("CATALOG_MANIFEST_PROVIDER_RELEASE_INVALID");
    }
    return verified;
  }));
  plans.sort((left, right) =>
    left.platformKey < right.platformKey
      ? -1
      : left.platformKey > right.platformKey
      ? 1
      : 0
  );
  if (
    new Set(plans.map(({ platformKey }) => platformKey)).size !== plans.length ||
    !Number.isFinite(Date.parse(input.serverTime))
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_PLATFORM_SET_MISMATCH");
  }
  const completed = [];
  for (const plan of plans) {
    completed.push(
      await seedProviderCatalogPublishPlanGraph(ctx, plan, input.serverTime),
    );
  }
  const manifest = await buildCatalogManifestFromProviderPlans(
    plans,
    input.confidencePolicyVersion,
    "mock",
  );
  const current = await loadActiveCatalogManifestState(ctx);
  if (current.state.activeManifest !== null) {
    if (
      current.state.activeManifest.publicReleaseId !== manifest.publicReleaseId ||
      current.state.activeManifest.manifestFingerprint !==
        manifest.manifestFingerprint
    ) {
      refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
    }
    const active = await loadValidatedCatalogManifest(ctx);
    if (active === null) {
      refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
    }
    return {
      status: "unchanged",
      publicReleaseId: manifest.publicReleaseId,
      manifestId: active.manifestDocument._id,
      stateId: active.stateDocument._id,
      providerReleaseIds: active.providerReleases.map(({ _id }) => _id),
      manifest,
    };
  }
  const observation = buildGlobalCatalogAggregateObservationV1({
    observationSequence: input.observationSequence ??
      Math.max(1, current.state.generation + 1),
    publicReleaseId: manifest.publicReleaseId,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    providerSelections: completed.map(({ selection }) => selection),
  });
  const operationId =
    `mock.catalog.activate:${current.state.generation}:${manifest.publicReleaseId}`;
  const request = catalogManifestActivateRequestSchema.parse({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId,
    idempotencyKey: operationId,
    manifest,
    observation,
    expectedActiveState: current.state,
  });
  const requestDigest = await catalogManifestPublicationRequestDigest(request);
  await activateCatalogManifestRequest(
    ctx,
    request,
    requestDigest,
    { allowMock: true },
  );
  const active = await loadValidatedCatalogManifest(ctx);
  if (active === null) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  return {
    status: "created",
    publicReleaseId: manifest.publicReleaseId,
    manifestId: active.manifestDocument._id,
    stateId: active.stateDocument._id,
    providerReleaseIds: active.providerReleases.map(({ _id }) => _id),
    manifest,
  };
}
