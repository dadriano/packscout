import type { ApprovedPublicCatalogConfigurationV1 } from "@packscout/contracts";
import type {
  CatalogCanonicalRevisionSnapshot,
  CatalogReleaseSourceSnapshot,
} from "./catalog-release-types.ts";
import { calculatePackScoutEstimatedEv } from "./estimated-ev-calculator.ts";
import {
  estimatedEvCalculationFingerprint,
  type EstimatedEvInputManifest,
} from "./estimated-ev-projection-contracts.ts";
import type { PublicChangeCheckpoint } from "./public-change-settlement-service.ts";

export const fixtureIds = {
  rootCategory: "11111111-1111-5111-8111-111111111111",
  childCategory: "12222222-2222-5222-8222-222222222222",
  alphaVendor: "21111111-1111-5111-8111-111111111111",
  betaVendor: "22222222-2222-5222-8222-222222222222",
  alphaRepack: "31111111-1111-5111-8111-111111111111",
  betaRepack: "32222222-2222-5222-8222-222222222222",
  alphaCollectible: "41111111-1111-5111-8111-111111111111",
  betaCollectible: "42222222-2222-5222-8222-222222222222",
} as const;

const observed = new Date("2026-08-15T02:00:00.000Z");
const settled = new Date("2026-08-15T03:00:00.000Z");

const vendor = (input: {
  id: string;
  key: string;
  name: string;
  host: string;
}) => ({
  publicVendorId: input.id,
  vendorKey: input.key,
  displayName: input.name,
  logoUrl: `https://${input.host}/logo.png`,
  websiteUrl: `https://${input.host}`,
  listingHosts: [input.host],
  imageOrigins: [`https://${input.host}`],
  referralParameters: [],
  publicPromo: { code: "PACKSCOUT", label: "PackScout offer" },
});

export const fixtureConfiguration: ApprovedPublicCatalogConfigurationV1 = {
  schemaVersion: "approved_public_catalog_v1",
  configurationKey: "catalog-v1",
  revision: 1,
  approvedAt: "2026-08-15T01:00:00.000Z",
  staleAfterSeconds: 900,
  confidencePolicy: {
    version: "confidence-v1",
    completeScoreBasisPoints: 9_000,
    partialScoreBasisPoints: 6_500,
    unknownScoreBasisPoints: 3_500,
    limitationPenaltyBasisPoints: 500,
  },
  publicAssetOrigins: ["https://alpha.example", "https://beta.example"],
  verifiedUsdStablecoins: [],
  categories: [
    {
      publicCategoryId: fixtureIds.rootCategory,
      parentPublicCategoryId: null,
      categoryKey: "cards",
      name: "Cards",
      kind: "vertical",
      depth: 0,
      pathPublicCategoryIds: [fixtureIds.rootCategory],
      displayOrder: 0,
    },
    {
      publicCategoryId: fixtureIds.childCategory,
      parentPublicCategoryId: fixtureIds.rootCategory,
      categoryKey: "baseball",
      name: "Baseball",
      kind: "sport",
      depth: 1,
      pathPublicCategoryIds: [fixtureIds.rootCategory, fixtureIds.childCategory],
      displayOrder: 1,
    },
  ],
  platforms: [
    {
      platformKey: "alpha",
      vendor: vendor({ id: fixtureIds.alphaVendor, key: "alpha", name: "Alpha", host: "alpha.example" }),
      format: "repack",
      defaultPublicCategoryIds: [fixtureIds.rootCategory, fixtureIds.childCategory],
      categoryMappings: [{
        sourceValue: "Baseball",
        publicCategoryIds: [fixtureIds.rootCategory, fixtureIds.childCategory],
      }],
      collectibleTypeMappings: [],
    },
    {
      platformKey: "beta",
      vendor: vendor({ id: fixtureIds.betaVendor, key: "beta", name: "Beta", host: "beta.example" }),
      format: "gacha",
      defaultPublicCategoryIds: [fixtureIds.rootCategory, fixtureIds.childCategory],
      categoryMappings: [{
        sourceValue: "Baseball",
        publicCategoryIds: [fixtureIds.rootCategory, fixtureIds.childCategory],
      }],
      collectibleTypeMappings: [],
    },
  ],
  repacks: [
    {
      platformKey: "alpha",
      packExternalId: "alpha-pack",
      publicRepackId: fixtureIds.alphaRepack,
    },
    {
      platformKey: "beta",
      packExternalId: "beta-pack",
      publicRepackId: fixtureIds.betaRepack,
    },
  ],
  collectibles: [
    {
      platformKey: "alpha",
      externalId: "alpha-card",
      publicCollectibleId: fixtureIds.alphaCollectible,
      aliases: ["Alpha Chase"],
      collectibleType: "card",
      publicCategoryIds: [fixtureIds.rootCategory, fixtureIds.childCategory],
      year: 2025,
      brand: "Topps",
      setOrSeries: null,
      cardNumber: null,
      referenceNumber: null,
      subject: "Alpha Player",
      grade: null,
      grader: null,
      probabilityBucketId: "alpha-card",
      matchConfidenceBasisPoints: 10_000,
      chaseEvidenceKinds: ["packscout_resolved", "vendor_inventory"],
    },
    {
      platformKey: "beta",
      externalId: "beta-card",
      publicCollectibleId: fixtureIds.betaCollectible,
      aliases: ["Beta Chase"],
      collectibleType: "card",
      publicCategoryIds: [fixtureIds.rootCategory, fixtureIds.childCategory],
      year: 2024,
      brand: "Panini",
      setOrSeries: null,
      cardNumber: null,
      referenceNumber: null,
      subject: "Beta Player",
      grade: null,
      grader: null,
      probabilityBucketId: "beta-card",
      matchConfidenceBasisPoints: 10_000,
      chaseEvidenceKinds: ["packscout_resolved", "vendor_inventory"],
    },
  ],
};

function revision(input: {
  platformKey: string;
  recordKind: CatalogCanonicalRevisionSnapshot["recordKind"];
  externalId: string;
  content: unknown;
  sequence: bigint;
}): CatalogCanonicalRevisionSnapshot {
  return {
    entityId: `${input.platformKey}-${input.recordKind}-${input.externalId}`,
    platformKey: input.platformKey,
    recordKind: input.recordKind,
    externalId: input.externalId,
    content: input.content,
    sourceUpdatedAt: observed,
    sourceCollectedAt: observed,
    acceptedAt: observed,
    publicChangeSequence: input.sequence,
  };
}

function platformRevisions(platform: "alpha" | "beta", sequence: bigint) {
  const soldOut = platform === "beta";
  const packExternalId = `${platform}-pack`;
  const assetExternalId = `${platform}-card`;
  const inputManifest: EstimatedEvInputManifest = {
    packRevisionId: `${platform}-pack-revision`,
    evInputRevisionId: `${platform}-ev-input-revision`,
    packPriceValueMinor: 1_000,
    packPriceCurrency: "USD",
    distributionCurrency: "USD",
    unitBasis: "per_pack",
    drawCount: 1,
    declaredCoverage: 1,
    evidenceCompleteness: "complete",
    buckets: [{
      bucketId: assetExternalId,
      probability: 1,
      lowerValueMinor: 1_200,
      upperValueMinor: 1_200,
      sourceRevisionId: `${platform}-ev-input-revision`,
    }],
    sourceAt: observed.toISOString(),
    verifiedUsdStablecoins: [],
  };
  const estimatedEv = calculatePackScoutEstimatedEv({
    packPrice: {
      valueMinor: inputManifest.packPriceValueMinor,
      currency: inputManifest.packPriceCurrency,
      sourceRevisionId: inputManifest.packRevisionId!,
    },
    distributionCurrency: inputManifest.distributionCurrency,
    unitBasis: inputManifest.unitBasis,
    drawCount: inputManifest.drawCount,
    declaredCoverage: inputManifest.declaredCoverage,
    evidenceCompleteness: inputManifest.evidenceCompleteness,
    buckets: inputManifest.buckets,
    sourceAt: inputManifest.sourceAt,
    calculatedAt: observed.toISOString(),
    currencyPolicy: { verifiedUsdStablecoins: [] },
  });
  return [
    revision({
      platformKey: platform,
      recordKind: "pack",
      externalId: packExternalId,
      sequence,
      content: {
        schemaVersion: "catalog-projection-v1",
        entityType: "pack",
        evInputStatus: "ready",
        parentExternalId: null,
        name: `${platform === "alpha" ? "Alpha" : "Beta"} Pack`,
        category: "Baseball",
        description: "A governed catalog listing",
        availability: soldOut ? "sold_out" : "available",
        sourceStatus: soldOut ? "sold out" : "available",
        priceValueMinor: 1_000,
        priceCurrency: "USD",
        providerReportedEvValueMinor: 1_100,
        providerReportedEvCurrency: "USD",
        buybackPercent: 70,
        drawCount: 1,
        imageUrls: [`https://${platform}.example/pack.png`, "https://unapproved.example/raw.png"],
        dataQualityEvidence: [],
      },
    }),
    revision({
      platformKey: platform,
      recordKind: "catalog_asset",
      externalId: assetExternalId,
      sequence,
      content: {
        schemaVersion: "catalog-projection-v1",
        entityType: "catalog_asset",
        assetType: "card",
        relatedPackExternalId: packExternalId,
        parentExternalId: null,
        name: `${platform === "alpha" ? "Alpha" : "Beta"} Chase Card`,
        category: "Baseball",
        availability: "available",
        sourceStatus: "available",
        providerValueMinor: soldOut ? 2_000 : 3_000,
        providerValueCurrency: "USD",
        valueSource: "vendor_reported",
        imageUrls: [`https://${platform}.example/card.png`],
        dataQualityEvidence: [],
      },
    }),
    revision({
      platformKey: platform,
      recordKind: "ev_input",
      externalId: `${packExternalId}:odds`,
      sequence,
      content: {
        schemaVersion: "catalog-projection-v1",
        entityType: "ev_input",
        packExternalId,
        currency: "USD",
        unitBasis: "per_pack",
        drawCount: 1,
        buybackPercent: null,
        inventory: null,
        evidenceCompleteness: "complete",
        coverage: {
          declaredCoverage: 1,
          calculatedCoverage: 1,
          tolerance: 0.000001,
          probabilityBucketCount: 1,
          topChaseCount: 0,
        },
        probabilityBuckets: [{
          bucketId: assetExternalId,
          label: null,
          probability: 1,
          lowerValueMinor: 1_200,
          upperValueMinor: 1_200,
        }],
        topChases: [],
        readiness: { status: "ready", reasons: [] },
        dataQualityEvidence: [],
      },
    }),
    revision({
      platformKey: platform,
      recordKind: "estimated_ev",
      externalId: packExternalId,
      sequence,
      content: {
        schemaVersion: "packscout-estimated-ev-projection-v1",
        label: "PackScout Estimated EV",
        calculationFingerprint:
          estimatedEvCalculationFingerprint(inputManifest),
        ...estimatedEv,
        inputManifest,
      },
    }),
  ];
}

export function fixtureSnapshot(options: {
  alphaName?: string;
  betaBackfill?: boolean;
  configuration?: ApprovedPublicCatalogConfigurationV1 | null;
} = {}): CatalogReleaseSourceSnapshot {
  const revisions = [...platformRevisions("alpha", 5n), ...platformRevisions("beta", 6n)]
    .map((candidate) => options.alphaName !== undefined &&
        candidate.platformKey === "alpha" && candidate.recordKind === "pack"
      ? {
          ...candidate,
          content: {
            ...(candidate.content as Record<string, unknown>),
            name: options.alphaName,
          },
        }
      : candidate);
  const configuration = options.configuration === undefined
    ? fixtureConfiguration : options.configuration;
  return {
    configuration: configuration === null ? null : {
      id: "50000000-0000-4000-8000-000000000001",
      configuration,
      configurationHash: "a".repeat(64),
      publicChangeSequence: 1n,
    },
    revisions,
    providers: [
      {
        platformKey: "alpha",
        state: "active",
        lifecycleSequence: 2n,
        configurationRevisionId: "60000000-0000-4000-8000-000000000001",
        completedBackfillAt: observed,
      },
      {
        platformKey: "beta",
        state: "active",
        lifecycleSequence: 3n,
        configurationRevisionId: "60000000-0000-4000-8000-000000000002",
        completedBackfillAt: options.betaBackfill === false ? null : observed,
      },
    ],
    repackIdentities: [
      {
        platformKey: "alpha",
        packExternalId: "alpha-pack",
        publicRepackId: fixtureIds.alphaRepack,
        approvedConfigurationKey: "catalog-v1",
        publicChangeSequence: 4n,
        approvedAt: observed,
      },
      {
        platformKey: "beta",
        packExternalId: "beta-pack",
        publicRepackId: fixtureIds.betaRepack,
        approvedConfigurationKey: "catalog-v1",
        publicChangeSequence: 4n,
        approvedAt: observed,
      },
    ],
  };
}

export function fixtureCheckpoint(options: { delayedBeta?: boolean; sequence?: bigint } = {}): PublicChangeCheckpoint {
  const sequence = options.sequence ?? 20n;
  return {
    organizationId: "70000000-0000-4000-8000-000000000001",
    settledSequence: sequence,
    settledAt: settled,
    sourceHeadSequence: options.delayedBeta ? sequence + 1n : sequence,
    sourceHeadAt: settled,
    sourceHeads: [
      {
        sourceKey: "alpha",
        sourceRevisionKey: "alpha-revision",
        sequence,
        occurredAt: settled,
        settled: true,
      },
      {
        sourceKey: "beta",
        sourceRevisionKey: "beta-revision",
        sequence: options.delayedBeta ? sequence + 1n : sequence,
        occurredAt: settled,
        settled: !options.delayedBeta,
      },
    ],
  };
}
