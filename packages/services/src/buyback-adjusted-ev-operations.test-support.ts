import { createHash, randomUUID } from "node:crypto";
import type { ApprovedPublicCatalogConfigurationV1 } from "@packscout/contracts";
import type { PackScoutBuybackEvEvidenceOutcomeV1 } from "@packscout/contracts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
  prismaApprovedPublicRepackIdentityMaterializer,
  PrismaCatalogReleaseSourceRepository,
} from "@packscout/database";
import type { MigratedTestDatabase } from "@packscout/database/test-support";
import type { CanonicalAvailability } from "./catalog-projection-contracts.ts";
import {
  finalizePackScoutBuybackEvEvidenceV1,
  type PackScoutBuybackEvEvidenceDraftV1,
  type PackScoutBuybackEvMoneyClaimV1,
  type PackScoutBuybackEvOddsClaimV1,
  type PackScoutBuybackEvUnitBasisClaimV1,
} from "./providers/buyback-ev-evidence.ts";
import type { PackScoutBuybackEvRecomputationCommandV1 } from "./buyback-adjusted-ev-recomputation-contracts.ts";

/**
 * Shared seeding and evidence synthesis for the task-012 operational
 * readiness tests. Canonical rows are seeded through the same governed tables
 * the production adapter reads (approved configuration, provider lifecycle,
 * append-only canonical revisions, settled public watermark); evidence flows
 * through the real task-004 provider normalization boundary.
 */

export const OPERATIONS_PLATFORM_KEY = "vendor";
export const OPERATIONS_TIMELINE = Object.freeze({
  configApprovedAt: "2026-08-18T01:00:00.000Z",
  lifecycleAt: "2026-08-18T01:20:00.000Z",
  backfillFinishedAt: "2026-08-18T01:10:00.000Z",
  staleObservedAt: "2026-08-18T00:30:00.000Z",
  soldOutObservedAt: "2026-08-18T01:30:00.000Z",
  soldOutCalculatedAt: "2026-08-18T01:45:00.000Z",
  activeObservedAt: "2026-08-18T01:50:00.000Z",
  soldOutAt: "2026-08-18T01:55:00.000Z",
  calculatedAt: "2026-08-18T01:56:00.000Z",
  projectionAt: "2026-08-18T01:58:00.000Z",
  readAt: "2026-08-18T02:00:00.000Z",
});

export const OPERATIONS_PACKS = Object.freeze({
  available: "pack-available",
  noBuyback: "pack-nobuyback",
  staleEvidence: "pack-stale",
  noEvidence: "pack-noevidence",
  soldOut: "pack-soldout",
});

export interface OperationsPublicIdentity {
  readonly publicVendorId: string;
  readonly publicCategoryId: string;
  readonly publicCollectibleId: string;
  readonly repackIds: Readonly<Record<keyof typeof OPERATIONS_PACKS, string>>;
}

export function operationsPublicIdentity(
  prefix: string,
): OperationsPublicIdentity {
  return {
    publicVendorId: `${prefix}111111-1111-5111-8111-111111111111`,
    publicCategoryId: `${prefix}222222-2222-5222-8222-222222222222`,
    publicCollectibleId: `${prefix}333333-3333-5333-8333-333333333333`,
    repackIds: {
      available: `${prefix}444444-4444-5444-8444-444444444441`,
      noBuyback: `${prefix}444444-4444-5444-8444-444444444442`,
      staleEvidence: `${prefix}444444-4444-5444-8444-444444444443`,
      noEvidence: `${prefix}444444-4444-5444-8444-444444444444`,
      soldOut: `${prefix}444444-4444-5444-8444-444444444445`,
    },
  };
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** Prisma Json inputs without importing Prisma types into this package. */
function json(value: unknown): never {
  return JSON.parse(JSON.stringify(value)) as never;
}

function approvedConfiguration(
  identity: OperationsPublicIdentity,
): ApprovedPublicCatalogConfigurationV1 {
  return {
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: "buyback-ev-operations-r1",
    revision: 1,
    approvedAt: OPERATIONS_TIMELINE.configApprovedAt,
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
      publicCategoryId: identity.publicCategoryId,
      parentPublicCategoryId: null,
      categoryKey: "cards",
      name: "Cards",
      kind: "vertical",
      depth: 0,
      pathPublicCategoryIds: [identity.publicCategoryId],
      displayOrder: 0,
    }],
    platforms: [{
      platformKey: OPERATIONS_PLATFORM_KEY,
      vendor: {
        publicVendorId: identity.publicVendorId,
        vendorKey: OPERATIONS_PLATFORM_KEY,
        displayName: "Vendor",
        logoUrl: "https://vendor.example/logo.webp",
        websiteUrl: "https://vendor.example",
        listingHosts: ["vendor.example"],
        imageOrigins: ["https://vendor.example"],
        referralParameters: [],
        publicPromo: null,
      },
      format: "repack",
      defaultPublicCategoryIds: [identity.publicCategoryId],
      categoryMappings: [],
      collectibleTypeMappings: [],
    }],
    repacks: (Object.keys(OPERATIONS_PACKS) as (keyof typeof OPERATIONS_PACKS)[])
      .map((key) => ({
        platformKey: OPERATIONS_PLATFORM_KEY,
        packExternalId: OPERATIONS_PACKS[key],
        publicRepackId: identity.repackIds[key],
      }))
      .sort((left, right) =>
        left.packExternalId < right.packExternalId ? -1 : 1,
      ),
    collectibles: [{
      platformKey: OPERATIONS_PLATFORM_KEY,
      externalId: "asset-1",
      publicCollectibleId: identity.publicCollectibleId,
      aliases: [],
      collectibleType: "card",
      publicCategoryIds: [identity.publicCategoryId],
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
  readonly name: string;
  readonly availability: CanonicalAvailability;
  readonly priceValueMinor: number | null;
  readonly buybackPercent: number | null;
  readonly sourceStatus?: string | null;
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
    providerReportedEvValueMinor: null,
    providerReportedEvCurrency: null,
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
    relatedPackExternalId: OPERATIONS_PACKS.available,
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
    packExternalId: OPERATIONS_PACKS.available,
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

export interface SeededOperationsIngestion {
  readonly providerId: string;
  readonly configurationRevisionId: string;
}

interface CanonicalRevisionSeed {
  readonly recordKind: "pack" | "catalog_asset" | "ev_input";
  readonly externalId: string;
  readonly revisionNumber: number;
  readonly content: unknown;
  readonly sourceUpdatedAt: string;
}

async function seedCanonicalRevisions(
  harness: MigratedTestDatabase,
  organizationId: string,
  ingestion: { providerId: string; runId: string; pageId: string },
  seeds: readonly CanonicalRevisionSeed[],
  settledAt: string,
): Promise<void> {
  const sourceRecordIds = seeds.map(() => randomUUID());
  for (const [index, seed] of seeds.entries()) {
    await harness.client.source_records.create({
      data: {
        id: sourceRecordIds[index]!,
        organization_id: organizationId,
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
      organizationId,
      changes: seeds.map((seed) => ({
        changeKind: "provider_projection" as const,
        entityKey:
          `canonical:v1:${OPERATIONS_PLATFORM_KEY}:${seed.recordKind}:${seed.externalId}:${seed.revisionNumber}`,
        sourceKey: OPERATIONS_PLATFORM_KEY,
        sourceRevisionKey: `${seed.externalId}:${seed.revisionNumber}`,
        occurredAt: new Date(OPERATIONS_TIMELINE.projectionAt),
        catalogImpact: {
          kind: "catalog" as const,
          providerPlatformKeys: [OPERATIONS_PLATFORM_KEY],
        },
      })),
    });
    for (const [index, seed] of seeds.entries()) {
      const existing = await transaction.canonical_entities.findFirst({
        where: {
          organization_id: organizationId,
          platform_key: OPERATIONS_PLATFORM_KEY,
          record_kind: seed.recordKind,
          external_id: seed.externalId,
        },
      });
      const entityId = existing?.id ?? randomUUID();
      if (existing === null) {
        await transaction.canonical_entities.create({
          data: {
            id: entityId,
            organization_id: organizationId,
            platform_key: OPERATIONS_PLATFORM_KEY,
            record_kind: seed.recordKind,
            external_id: seed.externalId,
          },
        });
      }
      const revisionId = randomUUID();
      await transaction.canonical_revisions.create({
        data: {
          id: revisionId,
          organization_id: organizationId,
          entity_id: entityId,
          revision_number: seed.revisionNumber,
          source_record_id: sourceRecordIds[index]!,
          content_json: json(seed.content),
          content_hash: sha256Json(seed.content),
          provenance_json: json({ providerId: ingestion.providerId }),
          provenance_hash: sha256Json({ providerId: ingestion.providerId }),
          actor_key: "operator:protected-projection-actor",
          source_updated_at: new Date(seed.sourceUpdatedAt),
          source_collected_at: new Date(seed.sourceUpdatedAt),
          accepted_at: new Date(OPERATIONS_TIMELINE.projectionAt),
          public_change_sequence: causes[index]!.sequence,
        },
      });
      await transaction.canonical_entities.update({
        where: { id: entityId },
        data: { current_revision_id: revisionId },
      });
    }
    await advanceSettledPublicWatermark(transaction, {
      organizationId,
      settledAt: new Date(settledAt),
    });
  });
}

/**
 * Seeds one governed canonical catalog with five packs covering every
 * classification the backfill must reconcile: available, deterministically
 * unavailable (missing buyback), stale evidence, missing evidence, and a
 * frozen sold-out product.
 */
export async function seedBuybackEvOperationsCatalog(
  harness: MigratedTestDatabase,
  input: {
    readonly organizationId: string;
    readonly slug: string;
    readonly identity: OperationsPublicIdentity;
  },
): Promise<SeededOperationsIngestion> {
  await harness.client.organizations.create({
    data: { id: input.organizationId, slug: input.slug, name: input.slug },
  });
  const providerId = randomUUID();
  const configurationRevisionId = randomUUID();
  const runId = randomUUID();
  const pageId = randomUUID();
  await harness.client.provider_sources.create({
    data: {
      id: providerId,
      organization_id: input.organizationId,
      platform_key: OPERATIONS_PLATFORM_KEY,
      display_name: "Vendor",
    },
  });
  await harness.client.provider_config_revisions.create({
    data: {
      id: configurationRevisionId,
      organization_id: input.organizationId,
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
    data: { state: "active", active_revision_id: configurationRevisionId },
  });
  await harness.client.import_runs.create({
    data: {
      id: runId,
      organization_id: input.organizationId,
      provider_id: providerId,
      config_revision_id: configurationRevisionId,
      trigger: "scheduled",
      state: "succeeded",
      started_at: new Date("2026-08-18T01:05:00.000Z"),
      finished_at: new Date(OPERATIONS_TIMELINE.backfillFinishedAt),
      reached_provider_head: true,
    },
  });
  await harness.client.import_pages.create({
    data: {
      id: pageId,
      organization_id: input.organizationId,
      provider_id: providerId,
      run_id: runId,
      page_number: 1,
      has_more: false,
      payload_hash: "a".repeat(64),
      record_counts_json: json({}),
      expires_at: new Date("2026-11-18T01:00:00.000Z"),
    },
  });
  await new PrismaCatalogReleaseSourceRepository(
    harness.client,
    input.organizationId,
  ).approveConfiguration(
    approvedConfiguration(input.identity),
    prismaApprovedPublicRepackIdentityMaterializer,
  );
  await harness.client.$transaction(async (transaction) => {
    await allocatePublicChangeCauses(transaction, {
      organizationId: input.organizationId,
      changes: [{
        changeKind: "provider_lifecycle",
        entityKey: `provider:v1:${providerId}`,
        sourceKey: OPERATIONS_PLATFORM_KEY,
        sourceRevisionKey: configurationRevisionId,
        metadata: {
          providerId,
          platformKey: OPERATIONS_PLATFORM_KEY,
          state: "active",
          configurationRevisionId,
        },
        occurredAt: new Date(OPERATIONS_TIMELINE.lifecycleAt),
        catalogImpact: {
          kind: "catalog",
          providerPlatformKeys: [OPERATIONS_PLATFORM_KEY],
          manifestLifecycle: {
            platformKey: OPERATIONS_PLATFORM_KEY,
            state: "active",
          },
        },
      }],
    });
    await advanceSettledPublicWatermark(transaction, {
      organizationId: input.organizationId,
      settledAt: new Date(OPERATIONS_TIMELINE.lifecycleAt),
    });
  });
  await seedCanonicalRevisions(
    harness,
    input.organizationId,
    { providerId, runId, pageId },
    [
      {
        recordKind: "pack",
        externalId: OPERATIONS_PACKS.available,
        revisionNumber: 1,
        content: packContent({
          name: "Pokemon Grail Gacha",
          availability: "available",
          priceValueMinor: 10_000,
          buybackPercent: 85,
        }),
        sourceUpdatedAt: OPERATIONS_TIMELINE.activeObservedAt,
      },
      {
        recordKind: "pack",
        externalId: OPERATIONS_PACKS.noBuyback,
        revisionNumber: 1,
        content: packContent({
          name: "Vault Repack Without Buyback",
          availability: "available",
          priceValueMinor: 20_000,
          buybackPercent: null,
        }),
        sourceUpdatedAt: OPERATIONS_TIMELINE.activeObservedAt,
      },
      {
        recordKind: "pack",
        externalId: OPERATIONS_PACKS.staleEvidence,
        revisionNumber: 1,
        content: packContent({
          name: "Slow Feed Repack",
          availability: "available",
          priceValueMinor: 15_000,
          buybackPercent: 80,
        }),
        sourceUpdatedAt: OPERATIONS_TIMELINE.staleObservedAt,
      },
      {
        recordKind: "pack",
        externalId: OPERATIONS_PACKS.noEvidence,
        revisionNumber: 1,
        content: packContent({
          name: "Fresh Listing Repack",
          availability: "available",
          priceValueMinor: 5_000,
          buybackPercent: 90,
        }),
        sourceUpdatedAt: OPERATIONS_TIMELINE.activeObservedAt,
      },
      {
        recordKind: "pack",
        externalId: OPERATIONS_PACKS.soldOut,
        revisionNumber: 1,
        content: packContent({
          name: "Frozen Sellout Repack",
          availability: "available",
          priceValueMinor: 12_000,
          buybackPercent: 85,
        }),
        sourceUpdatedAt: OPERATIONS_TIMELINE.soldOutObservedAt,
      },
      {
        recordKind: "pack",
        externalId: OPERATIONS_PACKS.soldOut,
        revisionNumber: 2,
        content: packContent({
          name: "Frozen Sellout Repack",
          availability: "sold_out",
          priceValueMinor: 12_000,
          buybackPercent: 85,
          sourceStatus: "sold-out",
        }),
        sourceUpdatedAt: OPERATIONS_TIMELINE.soldOutAt,
      },
      {
        recordKind: "catalog_asset",
        externalId: "asset-1",
        revisionNumber: 1,
        content: assetContent(),
        sourceUpdatedAt: OPERATIONS_TIMELINE.activeObservedAt,
      },
      {
        recordKind: "ev_input",
        externalId: "ev-input-1",
        revisionNumber: 1,
        content: evInputContent(),
        sourceUpdatedAt: OPERATIONS_TIMELINE.activeObservedAt,
      },
    ],
    OPERATIONS_TIMELINE.readAt,
  );
  return { providerId, configurationRevisionId };
}

export interface OperationsEvidenceDraftInput {
  readonly productKey: string;
  readonly sourceRevisionId: string;
  readonly observedAt: string;
  readonly priceMinorUnits?: number;
  readonly priceCurrency?: string;
  readonly pricePrecision?: number;
  readonly buybackDocumented?: boolean;
  readonly unitBasis?: PackScoutBuybackEvUnitBasisClaimV1;
  readonly odds?: PackScoutBuybackEvOddsClaimV1;
  readonly statedValues?: readonly {
    readonly outcomeKey: string;
    readonly amount: PackScoutBuybackEvMoneyClaimV1;
  }[];
}

const DEFAULT_OUTCOMES: readonly {
  readonly outcomeKey: string;
  readonly amount: PackScoutBuybackEvMoneyClaimV1;
}[] = [
  {
    outcomeKey: "common-hit",
    amount: { minorUnits: 5_000, currency: "USD", precision: 2 },
  },
  {
    outcomeKey: "rare-hit",
    amount: { minorUnits: 30_000, currency: "USD", precision: 2 },
  },
];

export function operationsEvidenceDraft(
  input: OperationsEvidenceDraftInput,
): PackScoutBuybackEvEvidenceDraftV1 {
  const outcomes = input.statedValues ?? DEFAULT_OUTCOMES;
  return {
    observation: {
      providerKey: OPERATIONS_PLATFORM_KEY,
      sourceRevisionId: input.sourceRevisionId,
      sourceManifestSha256: null,
      observedAt: input.observedAt,
      coherence: { kind: "provider_revision" },
    },
    product: {
      productKey: input.productKey,
      productRevisionId: `${input.productKey}-revision-1`,
    },
    packPrice: {
      minorUnits: input.priceMinorUnits ?? 10_000,
      currency: input.priceCurrency ?? "USD",
      precision: input.pricePrecision ?? 2,
    },
    unitBasis: input.unitBasis ?? { kind: "per_pack" },
    odds: input.odds ?? {
      poolKind: "finite",
      currentPool: {
        completeness: "complete",
        snapshotAtomicity: "atomic",
        countsStability: "stable",
        remainingUnits: outcomes.map(({ outcomeKey }, index) => ({
          outcomeKey,
          units: index === 0 ? 3 : 1,
        })),
      },
      published: null,
    },
    uniformBuybackRate:
      (input.buybackDocumented ?? true)
        ? {
          kind: "documented",
          scope: "every_eligible_outcome",
          terms: {
            rateBasisPoints: 8_500,
            percentageFeeBasisPoints: 0,
            fixedFee: null,
            floor: null,
            cap: null,
          },
        }
        : { kind: "none_documented" },
    outcomes: outcomes.map(({ outcomeKey, amount }) => ({
      outcomeKey,
      representation: { kind: "atomic_outcome" },
      valueBasis: "stated_collectible_value",
      statedValue: { kind: "exact", amount },
      buyback: { kind: "defer_to_product_terms" },
    })),
  };
}

export function operationsEvidence(
  input: OperationsEvidenceDraftInput,
): PackScoutBuybackEvEvidenceOutcomeV1 {
  return finalizePackScoutBuybackEvEvidenceV1(operationsEvidenceDraft(input), {
    evaluatedAt: new Date(
      Date.parse(input.observedAt) + 30_000,
    ).toISOString(),
    stablecoinParityApprovals: [],
  });
}

export function operationsCommand(input: {
  readonly organizationId: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly evidence: PackScoutBuybackEvEvidenceOutcomeV1;
  readonly calculatedAt: string;
}): PackScoutBuybackEvRecomputationCommandV1 {
  return {
    organizationId: input.organizationId,
    providerId: input.providerId,
    configurationRevisionId: input.configurationRevisionId,
    evidence: input.evidence,
    calculatedAt: input.calculatedAt,
  };
}
