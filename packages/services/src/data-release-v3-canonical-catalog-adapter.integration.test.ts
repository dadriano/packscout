import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  containsProtectedPublicationField,
  packAvailabilityIsPurchasableV3,
  publicRepackDetailV3Schema,
  repackEvSortRowV3FromDetail,
  type ApprovedPublicCatalogConfigurationV1,
  type PublicPackAvailability,
  type PublicRepackDetailV3,
} from "@packscout/contracts";
import {
  DataReleaseV3CanonicalSourceError,
  PrismaDataReleaseV3CanonicalCatalogSource,
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
  prismaApprovedPublicRepackIdentityMaterializer,
  PrismaCatalogReleaseSourceRepository,
} from "@packscout/database";
import {
  createMigratedTestDatabase,
  type MigratedTestDatabase,
} from "@packscout/database/test-support";
import { DataReleaseV3ReleaseAssembler } from "./buyback-adjusted-ev-release-assembler.ts";
import { buildPublishableEligibility } from "./buyback-adjusted-ev-release.test-support.ts";
import type { DataReleaseV3CanonicalCatalogPort } from "./buyback-adjusted-ev-release-types.ts";
import {
  DataReleaseV3CanonicalCatalogAdapter,
  DataReleaseV3CanonicalCatalogError,
  type DataReleaseV3CanonicalSourcePort,
} from "./data-release-v3-canonical-catalog-adapter.ts";

const organizationId = "83000000-0000-4000-8000-000000000001";
const shadowOrganizationId = "83000000-0000-4000-8000-000000000002";
const publicVendorId = "83111111-1111-5111-8111-111111111111";
const publicCategoryId = "83222222-2222-5222-8222-222222222222";
const publicCollectibleId = "83333333-3333-5333-8333-333333333333";
const publicRepackIdActive = "83444444-4444-5444-8444-444444444444";
const publicRepackIdSoldOut = "83555555-5555-5555-8555-555555555555";
const publicRepackIdUnavailable = "83666666-6666-5666-8666-666666666666";
const publicRepackIdUnknown = "83777777-7777-5777-8777-777777777777";
const publicRepackIdLegacyActive = "83888888-8888-5888-8888-888888888888";
const publicRepackIdLegacyDisabled = "83999999-9999-5999-8999-999999999999";

const CONFIG_APPROVED_AT = "2026-08-18T01:00:00.000Z";
const LIFECYCLE_AT = "2026-08-18T01:20:00.000Z";
const BACKFILL_FINISHED_AT = "2026-08-18T01:10:00.000Z";
const ACTIVE_UPDATED_AT = "2026-08-18T01:50:00.000Z";
const PRE_SOLD_OUT_UPDATED_AT = "2026-08-18T01:40:00.000Z";
const SOLD_OUT_AT = "2026-08-18T01:55:00.000Z";
const SOLD_OUT_REOBSERVED_AT = "2026-08-18T01:58:00.000Z";
const ASSET_UPDATED_AT = "2026-08-18T01:45:00.000Z";
const PROJECTION_AT = "2026-08-18T02:00:00.000Z";
const READ_AT = "2026-08-18T02:00:00.000Z";
const LATER_AT = "2026-08-18T03:00:00.000Z";
const LATER_UPDATED_AT = "2026-08-18T02:50:00.000Z";

function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

/** Prisma Json inputs without importing Prisma types into this package. */
function json(value: unknown): never {
  return JSON.parse(JSON.stringify(value)) as never;
}

function configuration(): ApprovedPublicCatalogConfigurationV1 {
  return {
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: "catalog-v3-r1",
    revision: 1,
    approvedAt: CONFIG_APPROVED_AT,
    staleAfterSeconds: 900,
    confidencePolicy: {
      version: "confidence-v1",
      completeScoreBasisPoints: 9_000,
      partialScoreBasisPoints: 6_000,
      unknownScoreBasisPoints: 3_000,
      limitationPenaltyBasisPoints: 500,
    },
    publicAssetOrigins: ["https://vendor.example"],
    verifiedUsdStablecoins: [],
    categories: [{
      publicCategoryId,
      parentPublicCategoryId: null,
      categoryKey: "cards",
      name: "Cards",
      kind: "vertical",
      depth: 0,
      pathPublicCategoryIds: [publicCategoryId],
      displayOrder: 0,
    }],
    platforms: [{
      platformKey: "vendor",
      vendor: {
        publicVendorId,
        vendorKey: "vendor",
        displayName: "Vendor",
        logoUrl: "https://vendor.example/logo.webp",
        websiteUrl: "https://vendor.example",
        listingHosts: ["vendor.example"],
        imageOrigins: ["https://vendor.example"],
        referralParameters: [],
        publicPromo: null,
      },
      format: "repack",
      defaultPublicCategoryIds: [publicCategoryId],
      categoryMappings: [],
      collectibleTypeMappings: [],
    }],
    // Strictly sorted by `platformKey` then `packExternalId`, as the approved
    // configuration contract requires. The availability-coverage identities sit
    // in that order alongside the baseline two; a configured repack with no
    // canonical revision projects nothing, so they leave the baseline untouched.
    repacks: [
      {
        platformKey: "vendor",
        packExternalId: "pack-active",
        publicRepackId: publicRepackIdActive,
      },
      {
        platformKey: "vendor",
        packExternalId: "pack-legacy-active",
        publicRepackId: publicRepackIdLegacyActive,
      },
      {
        platformKey: "vendor",
        packExternalId: "pack-legacy-disabled",
        publicRepackId: publicRepackIdLegacyDisabled,
      },
      {
        platformKey: "vendor",
        packExternalId: "pack-soldout",
        publicRepackId: publicRepackIdSoldOut,
      },
      {
        platformKey: "vendor",
        packExternalId: "pack-unavailable",
        publicRepackId: publicRepackIdUnavailable,
      },
      {
        platformKey: "vendor",
        packExternalId: "pack-unknown",
        publicRepackId: publicRepackIdUnknown,
      },
    ],
    collectibles: [{
      platformKey: "vendor",
      externalId: "asset-1",
      publicCollectibleId,
      aliases: [],
      collectibleType: "card",
      publicCategoryIds: [publicCategoryId],
      year: null,
      brand: null,
      setOrSeries: null,
      cardNumber: null,
      referenceNumber: null,
      subject: null,
      grade: null,
      grader: null,
      probabilityBucketId: "grail",
      matchConfidenceBasisPoints: 9_500,
      chaseEvidenceKinds: ["vendor_inventory"],
    }],
  };
}

function packContent(input: {
  name: string;
  /**
   * Widened past the public union on purpose: canonical rows persisted before
   * the rename still carry `active`/`disabled`, and a row outside both
   * vocabularies is exactly what the adapter has to refuse.
   */
  availability: PublicPackAvailability | "active" | "disabled" | "retired";
  priceValueMinor: number | null;
  buybackPercent: number | null;
  providerReportedEvValueMinor?: number | null;
  sourceStatus?: string | null;
}) {
  return {
    schemaVersion: "catalog-projection-v1",
    entityType: "pack",
    parentExternalId: null,
    name: input.name,
    category: null,
    description: "A governed canonical pack.",
    availability: input.availability,
    sourceStatus: input.sourceStatus ?? null,
    priceValueMinor: input.priceValueMinor,
    priceCurrency: input.priceValueMinor === null ? null : "USD",
    providerReportedEvValueMinor: input.providerReportedEvValueMinor ?? null,
    providerReportedEvCurrency:
      (input.providerReportedEvValueMinor ?? null) === null ? null : "USD",
    buybackPercent: input.buybackPercent,
    drawCount: 1,
    imageUrls: ["https://vendor.example/repack.webp"],
    dataQualityEvidence: [],
  };
}

function assetContent() {
  return {
    schemaVersion: "catalog-projection-v1",
    entityType: "catalog_asset",
    assetType: "card",
    relatedPackExternalId: "pack-active",
    parentExternalId: null,
    name: "Charizard ex #199",
    category: null,
    availability: "available",
    sourceStatus: null,
    providerValueMinor: 85_000,
    providerValueCurrency: "USD",
    valueSource: "market",
    imageUrls: ["https://vendor.example/charizard.webp"],
    dataQualityEvidence: [],
  };
}

function evInputContent() {
  return {
    schemaVersion: "catalog-projection-v1",
    entityType: "ev_input",
    packExternalId: "pack-active",
    currency: "USD",
    unitBasis: "per_pack",
    drawCount: 1,
    evidenceCompleteness: "complete",
    coverage: {
      declaredCoverage: 1,
      calculatedCoverage: 1,
      tolerance: 0.000_001,
      probabilityBucketCount: 1,
      topChaseCount: 1,
    },
    probabilityBuckets: [{
      bucketId: "grail",
      label: "Grail",
      probability: 0.005,
      lowerValueMinor: 50_000,
      upperValueMinor: 90_000,
    }],
    topChases: [{
      bucketId: "grail",
      label: "Grail",
      probability: 0.005,
      lowerValueMinor: 50_000,
      upperValueMinor: 90_000,
    }],
    readiness: { status: "ready", reasons: [] },
    dataQualityEvidence: [],
  };
}

interface SeededCanonicalIngestion {
  readonly providerId: string;
  readonly runId: string;
  readonly pageId: string;
}

async function seedProviderIngestion(
  harness: MigratedTestDatabase,
  targetOrganizationId: string,
  activeRevisionId: string,
): Promise<SeededCanonicalIngestion> {
  const providerId = randomUUID();
  const runId = randomUUID();
  const pageId = randomUUID();
  await harness.client.provider_sources.create({
    data: {
      id: providerId,
      organization_id: targetOrganizationId,
      platform_key: "vendor",
      display_name: "Vendor",
    },
  });
  await harness.client.provider_config_revisions.create({
    data: {
      id: activeRevisionId,
      organization_id: targetOrganizationId,
      provider_id: providerId,
      version: 1,
      adapter_key: "http-cursor-v1",
      endpoint_url: "https://vendor.example/protected-feed",
      auth_mode: "none",
      created_by_actor_key: "operator:protected-actor",
    },
  });
  await harness.client.provider_sources.update({
    where: { id: providerId },
    data: { state: "active", active_revision_id: activeRevisionId },
  });
  await harness.client.import_runs.create({
    data: {
      id: runId,
      organization_id: targetOrganizationId,
      provider_id: providerId,
      config_revision_id: activeRevisionId,
      trigger: "scheduled",
      state: "succeeded",
      started_at: new Date("2026-08-18T01:05:00.000Z"),
      finished_at: new Date(BACKFILL_FINISHED_AT),
      reached_provider_head: true,
    },
  });
  await harness.client.import_pages.create({
    data: {
      id: pageId,
      organization_id: targetOrganizationId,
      provider_id: providerId,
      run_id: runId,
      page_number: 1,
      has_more: false,
      payload_hash: "a".repeat(64),
      record_counts_json: json({}),
      expires_at: new Date("2026-11-18T01:00:00.000Z"),
    },
  });
  return { providerId, runId, pageId };
}

interface CanonicalRevisionSeed {
  readonly recordKind: "pack" | "catalog_asset" | "ev_input";
  readonly externalId: string;
  readonly revisionNumber: number;
  readonly content: unknown;
  readonly sourceUpdatedAt: string;
  readonly occurredAt: string;
}

async function seedCanonicalRevisions(
  harness: MigratedTestDatabase,
  targetOrganizationId: string,
  ingestion: SeededCanonicalIngestion,
  seeds: readonly CanonicalRevisionSeed[],
  settledAt: string,
): Promise<void> {
  const sourceRecordIds = seeds.map(() => randomUUID());
  for (const [index, seed] of seeds.entries()) {
    await harness.client.source_records.create({
      data: {
        id: sourceRecordIds[index]!,
        organization_id: targetOrganizationId,
        provider_id: ingestion.providerId,
        first_run_id: ingestion.runId,
        first_page_id: ingestion.pageId,
        record_kind: "catalog",
        external_id: `${seed.externalId}:${seed.revisionNumber}`,
        source_time: new Date(seed.sourceUpdatedAt),
        collected_at: new Date(seed.sourceUpdatedAt),
        payload_json: json({ rawPayload: "protected-raw-vendor-bytes" }),
        content_hash: sha256Json([seed.externalId, seed.revisionNumber]),
        expires_at: new Date("2026-11-18T01:00:00.000Z"),
      },
    });
  }
  await harness.client.$transaction(async (transaction) => {
    const causes = await allocatePublicChangeCauses(transaction, {
      organizationId: targetOrganizationId,
      changes: seeds.map((seed) => ({
        changeKind: "provider_projection" as const,
        entityKey:
          `canonical:v1:vendor:${seed.recordKind}:${seed.externalId}:${seed.revisionNumber}`,
        sourceKey: "vendor",
        sourceRevisionKey: `${seed.externalId}:${seed.revisionNumber}`,
        occurredAt: new Date(seed.occurredAt),
        catalogImpact: {
          kind: "catalog" as const,
          providerPlatformKeys: ["vendor"],
        },
      })),
    });
    for (const [index, seed] of seeds.entries()) {
      const existing = await transaction.canonical_entities.findFirst({
        where: {
          organization_id: targetOrganizationId,
          platform_key: "vendor",
          record_kind: seed.recordKind,
          external_id: seed.externalId,
        },
      });
      const entityId = existing?.id ?? randomUUID();
      if (existing === null) {
        await transaction.canonical_entities.create({
          data: {
            id: entityId,
            organization_id: targetOrganizationId,
            platform_key: "vendor",
            record_kind: seed.recordKind,
            external_id: seed.externalId,
          },
        });
      }
      const revisionId = randomUUID();
      await transaction.canonical_revisions.create({
        data: {
          id: revisionId,
          organization_id: targetOrganizationId,
          entity_id: entityId,
          revision_number: seed.revisionNumber,
          source_record_id: sourceRecordIds[index]!,
          content_json: json(seed.content),
          content_hash: sha256Json(seed.content),
          provenance_json: json({
            providerId: ingestion.providerId,
            internalRunId: ingestion.runId,
          }),
          provenance_hash: sha256Json({
            providerId: ingestion.providerId,
            internalRunId: ingestion.runId,
          }),
          actor_key: "operator:protected-projection-actor",
          source_updated_at: new Date(seed.sourceUpdatedAt),
          source_collected_at: new Date(seed.sourceUpdatedAt),
          accepted_at: new Date(seed.occurredAt),
          public_change_sequence: causes[index]!.sequence,
        },
      });
      await transaction.canonical_entities.update({
        where: { id: entityId },
        data: { current_revision_id: revisionId },
      });
    }
    await advanceSettledPublicWatermark(transaction, {
      organizationId: targetOrganizationId,
      settledAt: new Date(settledAt),
    });
  });
}

async function seedGovernedCatalog(
  harness: MigratedTestDatabase,
  extraRevisions: readonly CanonicalRevisionSeed[] = [],
): Promise<SeededCanonicalIngestion> {
  await harness.client.organizations.create({
    data: { id: organizationId, slug: "v3-canonical", name: "V3 Canonical" },
  });
  const activeRevisionId = randomUUID();
  const ingestion = await seedProviderIngestion(
    harness,
    organizationId,
    activeRevisionId,
  );
  await new PrismaCatalogReleaseSourceRepository(
    harness.client,
    organizationId,
  ).approveConfiguration(
    configuration(),
    prismaApprovedPublicRepackIdentityMaterializer,
  );
  await harness.client.$transaction(async (transaction) => {
    await allocatePublicChangeCauses(transaction, {
      organizationId,
      changes: [{
        changeKind: "provider_lifecycle",
        entityKey: `provider:v1:${ingestion.providerId}`,
        sourceKey: "vendor",
        sourceRevisionKey: activeRevisionId,
        metadata: {
          providerId: ingestion.providerId,
          platformKey: "vendor",
          state: "active",
          configurationRevisionId: activeRevisionId,
        },
        occurredAt: new Date(LIFECYCLE_AT),
        catalogImpact: {
          kind: "catalog",
          providerPlatformKeys: ["vendor"],
          manifestLifecycle: { platformKey: "vendor", state: "active" },
        },
      }],
    });
    await advanceSettledPublicWatermark(transaction, {
      organizationId,
      settledAt: new Date(LIFECYCLE_AT),
    });
  });
  await seedCanonicalRevisions(harness, organizationId, ingestion, [
    {
      recordKind: "pack",
      externalId: "pack-active",
      revisionNumber: 1,
      content: packContent({
        name: "Pokemon Grail Gacha",
        availability: "available",
        priceValueMinor: 10_000,
        buybackPercent: 85,
        providerReportedEvValueMinor: 12_000,
      }),
      sourceUpdatedAt: ACTIVE_UPDATED_AT,
      occurredAt: PROJECTION_AT,
    },
    {
      recordKind: "pack",
      externalId: "pack-soldout",
      revisionNumber: 1,
      content: packContent({
        name: "Pokemon Vault Repack",
        availability: "available",
        priceValueMinor: 20_000,
        buybackPercent: null,
      }),
      sourceUpdatedAt: PRE_SOLD_OUT_UPDATED_AT,
      occurredAt: PROJECTION_AT,
    },
    {
      recordKind: "pack",
      externalId: "pack-soldout",
      revisionNumber: 2,
      content: packContent({
        name: "Pokemon Vault Repack",
        availability: "sold_out",
        priceValueMinor: 20_000,
        buybackPercent: null,
        sourceStatus: "sold-out",
      }),
      sourceUpdatedAt: SOLD_OUT_AT,
      occurredAt: PROJECTION_AT,
    },
    {
      recordKind: "pack",
      externalId: "pack-soldout",
      revisionNumber: 3,
      content: packContent({
        name: "Pokemon Vault Repack",
        availability: "sold_out",
        priceValueMinor: 20_000,
        buybackPercent: null,
        sourceStatus: "sold-out-reconfirmed",
      }),
      sourceUpdatedAt: SOLD_OUT_REOBSERVED_AT,
      occurredAt: PROJECTION_AT,
    },
    {
      recordKind: "catalog_asset",
      externalId: "asset-1",
      revisionNumber: 1,
      content: assetContent(),
      sourceUpdatedAt: ASSET_UPDATED_AT,
      occurredAt: PROJECTION_AT,
    },
    {
      recordKind: "ev_input",
      externalId: "ev-input-1",
      revisionNumber: 1,
      content: evInputContent(),
      sourceUpdatedAt: ASSET_UPDATED_AT,
      occurredAt: PROJECTION_AT,
    },
    ...extraRevisions,
  ], READ_AT);
  return ingestion;
}

/**
 * One pack per availability state the four-state vocabulary can hold, plus one
 * per retired `active`/`disabled` value. Every pack is priced at 10_000 USD
 * with a documented buyback so a publishable estimate stays contract-valid
 * against `buildPublishableEligibility()`.
 */
const AVAILABILITY_COVERAGE_PACKS: readonly CanonicalRevisionSeed[] = [
  {
    recordKind: "pack",
    externalId: "pack-unavailable",
    revisionNumber: 1,
    content: packContent({
      name: "Vendor Withdrew This Pack",
      availability: "unavailable",
      priceValueMinor: 10_000,
      buybackPercent: 85,
    }),
    sourceUpdatedAt: ACTIVE_UPDATED_AT,
    occurredAt: PROJECTION_AT,
  },
  {
    recordKind: "pack",
    externalId: "pack-unknown",
    revisionNumber: 1,
    content: packContent({
      name: "Vendor Reported No Availability",
      availability: "unknown",
      priceValueMinor: 10_000,
      buybackPercent: 85,
    }),
    sourceUpdatedAt: ACTIVE_UPDATED_AT,
    occurredAt: PROJECTION_AT,
  },
  {
    recordKind: "pack",
    externalId: "pack-legacy-active",
    revisionNumber: 1,
    content: packContent({
      name: "Legacy Active Vocabulary",
      availability: "active",
      priceValueMinor: 10_000,
      buybackPercent: 85,
    }),
    sourceUpdatedAt: ACTIVE_UPDATED_AT,
    occurredAt: PROJECTION_AT,
  },
  {
    recordKind: "pack",
    externalId: "pack-legacy-disabled",
    revisionNumber: 1,
    content: packContent({
      name: "Legacy Disabled Vocabulary",
      availability: "disabled",
      priceValueMinor: 10_000,
      buybackPercent: 85,
    }),
    sourceUpdatedAt: ACTIVE_UPDATED_AT,
    occurredAt: PROJECTION_AT,
  },
];

const OUTBOUND_REPACK_LINK = {
  listingUrl: "https://vendor.example/listings/pack",
  listingHost: "vendor.example",
  referralParameters: [],
} as const;

async function seedShadowTenant(harness: MigratedTestDatabase): Promise<void> {
  await harness.client.organizations.create({
    data: {
      id: shadowOrganizationId,
      slug: "v3-canonical-shadow",
      name: "V3 Canonical Shadow",
    },
  });
  const ingestion = await seedProviderIngestion(
    harness,
    shadowOrganizationId,
    randomUUID(),
  );
  await seedCanonicalRevisions(harness, shadowOrganizationId, ingestion, [{
    recordKind: "pack",
    externalId: "pack-b",
    revisionNumber: 1,
    content: packContent({
      name: "Shadow Tenant Pack",
      availability: "available",
      priceValueMinor: 5_000,
      buybackPercent: 50,
    }),
    sourceUpdatedAt: ACTIVE_UPDATED_AT,
    occurredAt: PROJECTION_AT,
  }], READ_AT);
}

test("the Prisma canonical adapter serves one repeatable, sanitized, assembler-compatible snapshot", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedGovernedCatalog(harness);
    await seedShadowTenant(harness);
    const source = new PrismaDataReleaseV3CanonicalCatalogSource(
      harness.client,
      organizationId,
    );
    const sourcePort: DataReleaseV3CanonicalSourcePort = source;
    const adapter = new DataReleaseV3CanonicalCatalogAdapter(sourcePort);
    const catalogPort: DataReleaseV3CanonicalCatalogPort = adapter;

    const snapshot = await catalogPort.loadCatalogSnapshot({ readAt: READ_AT });
    assert.equal(snapshot.organizationId, organizationId);
    assert.deepEqual(
      snapshot.products.map(({ publicRepackId }) => publicRepackId),
      [publicRepackIdActive, publicRepackIdSoldOut].sort(),
    );

    const active = snapshot.products.find(
      ({ publicRepackId }) => publicRepackId === publicRepackIdActive,
    )!;
    assert.equal(active.platformKey, "vendor");
    assert.equal(active.productKey, "pack-active");
    assert.equal(active.availability, "available");
    assert.equal(active.soldOutAt, null);
    assert.deepEqual(active.price.usdComparison, {
      status: "available",
      value: { minorUnits: 10_000, currency: "USD" },
    });
    assert.deepEqual(active.buyback, {
      kind: "uniform_rate",
      rateBasisPoints: 8_500,
    });
    assert.deepEqual(active.vendorReportedEv, {
      status: "available",
      sourceMoney: { minorUnits: 12_000, currency: "USD" },
      usdComparison: {
        status: "available",
        value: { minorUnits: 12_000, currency: "USD" },
      },
      observedAt: ACTIVE_UPDATED_AT,
    });
    assert.equal(active.topChase?.role, "top_chase");
    assert.equal(active.topChase?.publicCollectibleId, publicCollectibleId);
    assert.equal(active.topChase?.probabilityBasisPoints, 50);
    assert.deepEqual(active.topChase?.evidenceKinds, [
      "vendor_inventory",
      "vendor_odds",
    ]);
    assert.equal(active.contentSummary.evidenceCompleteness, "complete");
    assert.equal(active.contentSummary.probabilityCoverageBasisPoints, 10_000);
    assert.deepEqual(active.actions, {});
    assert.deepEqual(active.actionAvailability, {
      promo: false,
      repackLink: false,
    });

    const soldOut = snapshot.products.find(
      ({ publicRepackId }) => publicRepackId === publicRepackIdSoldOut,
    )!;
    assert.equal(soldOut.availability, "sold_out");
    // The freeze timestamp is the start of the trailing sold_out run, not the
    // latest sold_out re-observation.
    assert.equal(soldOut.soldOutAt, SOLD_OUT_AT);
    assert.deepEqual(soldOut.buyback, { kind: "not_documented" });
    assert.deepEqual(soldOut.vendorReportedEv, {
      status: "unavailable",
      sourceMoney: null,
      usdComparison: null,
      observedAt: null,
      reason: "NOT_REPORTED",
    });
    assert.equal(soldOut.topChase, null);

    assert.equal(snapshot.categories.length, 1);
    assert.equal(snapshot.collectibles.length, 1);
    assert.equal(
      snapshot.collectibles[0]!.publicCollectibleId,
      publicCollectibleId,
    );
    assert.ok(snapshot.collectibles[0]!.searchText.length > 0);
    assert.equal(snapshot.chases.length, 1);

    // Same readAt, byte-equal replay.
    const replay = await catalogPort.loadCatalogSnapshot({ readAt: READ_AT });
    assert.equal(JSON.stringify(replay), JSON.stringify(snapshot));

    // The real release assembler accepts the adapter as its canonical port
    // and emits a coherent publish plan from this snapshot.
    const assembler = new DataReleaseV3ReleaseAssembler(catalogPort, {
      async getPublicationEligibleRevision() {
        return null;
      },
    });
    const plan = await assembler.assemble({ readAt: READ_AT });
    assert.equal(plan.classification, "publish");
    if (plan.classification !== "publish") return;
    assert.deepEqual(plan.manifest.counts, {
      categories: 1,
      collectibles: 1,
      repacks: 2,
      chases: 1,
      searchShards: 1,
    });
    assert.equal(plan.manifest.topChaseCount, 1);
    assert.equal(plan.manifest.batchCount, 4);
  } finally {
    await harness.close();
  }
});

test("every availability state stays discoverable in the release while only `available` can rank or link out", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const ingestion = await seedGovernedCatalog(
      harness,
      AVAILABILITY_COVERAGE_PACKS,
    );
    const adapter = new DataReleaseV3CanonicalCatalogAdapter(
      new PrismaDataReleaseV3CanonicalCatalogSource(
        harness.client,
        organizationId,
      ),
    );
    const snapshot = await adapter.loadCatalogSnapshot({ readAt: READ_AT });

    // All four states survive the projection with their exact value, and the
    // retired vocabulary lands on its renamed state rather than being dropped.
    assert.deepEqual(
      Object.fromEntries(
        snapshot.products.map(({ productKey, availability }) => [
          productKey,
          availability,
        ]),
      ),
      {
        "pack-active": "available",
        "pack-soldout": "sold_out",
        "pack-unavailable": "unavailable",
        "pack-unknown": "unknown",
        "pack-legacy-active": "available",
        "pack-legacy-disabled": "unavailable",
      },
    );
    for (const product of snapshot.products) {
      // Only an authoritative sellout freezes a timestamp, and the canonical
      // projection never proposes an outbound purchase action for any state.
      assert.equal(
        product.soldOutAt !== null,
        product.availability === "sold_out",
        `${product.productKey} froze the wrong sold-out timestamp`,
      );
      assert.equal(product.actionAvailability.repackLink, false);
      assert.equal(product.actions.repackLink, undefined);
    }

    // The two axes are independent: a pack that is not purchasable may still
    // hold a current PackScout estimate. Give the non-purchasable packs one, so
    // the downstream guards are exercised against real published rows instead
    // of being assumed.
    const eligibleProductKeys = new Set([
      "pack-active",
      "pack-unavailable",
      "pack-unknown",
    ]);
    const plan = await new DataReleaseV3ReleaseAssembler(adapter, {
      async getPublicationEligibleRevision({ productKey }) {
        return eligibleProductKeys.has(productKey)
          ? buildPublishableEligibility()
          : null;
      },
    }).assemble({ readAt: READ_AT });
    assert.equal(plan.classification, "publish");
    if (plan.classification !== "publish") return;
    assert.equal(plan.manifest.counts.repacks, 6);

    const details = plan.batches
      .filter(({ kind }) => kind === "repacks")
      .flatMap(({ records }) => records as readonly PublicRepackDetailV3[]);
    const detailById = new Map(
      details.map((detail) => [detail.publicRepackId, detail]),
    );
    const unavailable = detailById.get(publicRepackIdUnavailable)!;
    const available = detailById.get(publicRepackIdActive)!;
    assert.equal(unavailable.availability, "unavailable");
    assert.equal(unavailable.evEstimates.packScout.status, "current");
    assert.equal(available.evEstimates.packScout.status, "current");

    // Published, estimated, and still unrankable: the sort row materializes
    // nulls for every EV value the dashboard could order or total by.
    assert.equal(packAvailabilityIsPurchasableV3(unavailable.availability), false);
    const unavailableRow = repackEvSortRowV3FromDetail(unavailable);
    assert.deepEqual(
      [
        unavailableRow.packScoutEvDollarsMinor,
        unavailableRow.packScoutGrossEvMinor,
        unavailableRow.packScoutEvPercentBasisPoints,
        unavailableRow.packScoutConfidenceBasisPoints,
        unavailableRow.packScoutConfidenceBand,
        unavailableRow.vendorReportedEvUsdMinor,
      ],
      [null, null, null, null, null, null],
    );
    assert.equal(unavailableRow.packScoutEvDollarsNullRank, 1);
    // The purchasable pack with the identical estimate does rank, so the nulls
    // above come from the availability gate and not from a missing estimate.
    assert.notEqual(
      repackEvSortRowV3FromDetail(available).packScoutEvDollarsMinor,
      null,
    );

    // The outbound purchase link is refused on the published non-purchasable
    // pack and accepted on the purchasable one, so the refusal is the
    // availability rule rather than the link shape.
    const withOutboundLink = (detail: PublicRepackDetailV3) => ({
      ...detail,
      actionAvailability: { ...detail.actionAvailability, repackLink: true },
      actions: { ...detail.actions, repackLink: OUTBOUND_REPACK_LINK },
    });
    assert.equal(
      publicRepackDetailV3Schema.safeParse(withOutboundLink(unavailable)).success,
      false,
    );
    assert.equal(
      publicRepackDetailV3Schema.safeParse(withOutboundLink(available)).success,
      true,
    );

    // A value outside both vocabularies is still refused rather than coerced
    // into a publishable state.
    await seedCanonicalRevisions(harness, organizationId, ingestion, [{
      recordKind: "pack",
      externalId: "pack-active",
      revisionNumber: 2,
      content: packContent({
        name: "Pokemon Grail Gacha",
        availability: "retired",
        priceValueMinor: 10_000,
        buybackPercent: 85,
      }),
      sourceUpdatedAt: LATER_UPDATED_AT,
      occurredAt: LATER_AT,
    }], LATER_AT);
    await assert.rejects(
      adapter.loadCatalogSnapshot({ readAt: LATER_AT }),
      (error: unknown) =>
        error instanceof DataReleaseV3CanonicalCatalogError &&
        error.code === "CANONICAL_PROJECTION_INVALID",
    );
  } finally {
    await harness.close();
  }
});

test("the same readAt stays byte-equal after later canonical writes and moves only with a later readAt", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const ingestion = await seedGovernedCatalog(harness);
    const adapter = new DataReleaseV3CanonicalCatalogAdapter(
      new PrismaDataReleaseV3CanonicalCatalogSource(
        harness.client,
        organizationId,
      ),
    );
    const before = await adapter.loadCatalogSnapshot({ readAt: READ_AT });

    await seedCanonicalRevisions(harness, organizationId, ingestion, [{
      recordKind: "pack",
      externalId: "pack-active",
      revisionNumber: 2,
      content: packContent({
        name: "Pokemon Grail Gacha",
        availability: "available",
        priceValueMinor: 20_000,
        buybackPercent: 85,
        providerReportedEvValueMinor: 12_000,
      }),
      sourceUpdatedAt: LATER_UPDATED_AT,
      occurredAt: LATER_AT,
    }], LATER_AT);

    const replay = await adapter.loadCatalogSnapshot({ readAt: READ_AT });
    assert.equal(JSON.stringify(replay), JSON.stringify(before));
    const activeBefore = replay.products.find(
      ({ productKey }) => productKey === "pack-active",
    )!;
    assert.equal(activeBefore.price.usdComparison.value?.minorUnits, 10_000);

    const after = await adapter.loadCatalogSnapshot({ readAt: LATER_AT });
    const activeAfter = after.products.find(
      ({ productKey }) => productKey === "pack-active",
    )!;
    assert.equal(activeAfter.price.usdComparison.value?.minorUnits, 20_000);
    assert.equal(activeAfter.sourceUpdatedAt, LATER_UPDATED_AT);
  } finally {
    await harness.close();
  }
});

test("unsettled, invalid, or unapproved reads refuse instead of degrading, and tenant scope holds", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedGovernedCatalog(harness);
    await seedShadowTenant(harness);
    const source = new PrismaDataReleaseV3CanonicalCatalogSource(
      harness.client,
      organizationId,
    );
    const adapter = new DataReleaseV3CanonicalCatalogAdapter(source);

    await assert.rejects(
      adapter.loadCatalogSnapshot({ readAt: "2026-08-18T02:00:01.000Z" }),
      (error: unknown) =>
        error instanceof DataReleaseV3CanonicalSourceError &&
        error.code === "CANONICAL_STATE_UNSETTLED",
    );
    await assert.rejects(
      adapter.loadCatalogSnapshot({ readAt: "not-a-timestamp" }),
      (error: unknown) =>
        error instanceof DataReleaseV3CanonicalSourceError &&
        error.code === "CANONICAL_READ_AT_INVALID",
    );

    // The shadow tenant's rows never cross the organization boundary.
    const shadowSource = new PrismaDataReleaseV3CanonicalCatalogSource(
      harness.client,
      shadowOrganizationId,
    );
    const shadowRaw = await shadowSource.loadSourceSnapshot({ readAt: READ_AT });
    assert.deepEqual(
      shadowRaw.revisions.map(({ externalId }) => externalId),
      ["pack-b"],
    );
    assert.equal(shadowRaw.configuration, null);
    await assert.rejects(
      new DataReleaseV3CanonicalCatalogAdapter(shadowSource)
        .loadCatalogSnapshot({ readAt: READ_AT }),
      (error: unknown) =>
        error instanceof DataReleaseV3CanonicalCatalogError &&
        error.code === "CANONICAL_CONFIGURATION_UNAPPROVED",
    );

    const snapshot = await adapter.loadCatalogSnapshot({ readAt: READ_AT });
    assert.equal(
      snapshot.products.some(({ productKey }) => productKey === "pack-b"),
      false,
    );

    // No protected, raw, or provenance bytes reach the projected snapshot.
    assert.equal(
      containsProtectedPublicationField({
        products: snapshot.products,
        categories: snapshot.categories,
        collectibles: snapshot.collectibles,
        chases: snapshot.chases,
      }),
      false,
    );
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      "rawPayload",
      "protected-raw-vendor-bytes",
      "protected-projection-actor",
      "protected-feed",
      "provenance",
      "internalRunId",
    ]) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        `snapshot leaked ${forbidden}`,
      );
    }
  } finally {
    await harness.close();
  }
});
