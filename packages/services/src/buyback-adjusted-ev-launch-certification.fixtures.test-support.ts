import type { PackScoutBuybackEvEvidenceOutcomeV1 } from "@packscout/contracts";
import {
  type PackScoutBuybackEvLaunchProviderV1,
  type PackScoutBuybackEvLaunchScenarioClassV1,
  type PackScoutBuybackEvTraceConfidenceV1,
  type PackScoutBuybackEvTraceMetricsV1,
} from "./buyback-adjusted-ev-launch-certification.ts";
import type { PackScoutBuybackEvEvidenceContextV1 } from "./providers/buyback-ev-evidence.ts";
import {
  normalizeBeezieBuybackEvEvidenceV1,
  type BeezieBuybackEvSourceV1,
} from "./providers/beezie/buyback-ev-evidence.ts";
import {
  normalizeClutchpacksBuybackEvEvidenceV1,
  type ClutchpacksBuybackEvSourceV1,
} from "./providers/clutchpacks/buyback-ev-evidence.ts";
import {
  normalizeCollectorCryptBuybackEvEvidenceV1,
  type CollectorCryptBuybackEvSourceV1,
} from "./providers/collector-crypt/buyback-ev-evidence.ts";
import {
  normalizeCourtyardBuybackEvEvidenceV1,
  type CourtyardBuybackEvSourceV1,
} from "./providers/courtyard/buyback-ev-evidence.ts";
import {
  normalizeGamestopBuybackEvEvidenceV1,
  type GamestopBuybackEvSourceV1,
} from "./providers/gamestop/buyback-ev-evidence.ts";
import {
  normalizePhygitalsBuybackEvEvidenceV1,
  type PhygitalsBuybackEvSourceV1,
} from "./providers/phygitals/buyback-ev-evidence.ts";
import {
  normalizeStadiumVaultBuybackEvEvidenceV1,
  type StadiumVaultBuybackEvSourceV1,
} from "./providers/stadium-vault/buyback-ev-evidence.ts";
import {
  normalizeTroveBuybackEvEvidenceV1,
  type TroveBuybackEvSourceV1,
} from "./providers/trove/buyback-ev-evidence.ts";

/**
 * The eight sanitized launch-provider examples for the task-013 certification
 * (fixtures for `buyback-adjusted-ev-launch-certification.test-support.ts`).
 * Every expectation is computed by hand from the sanitized source numbers —
 * exact integers only, no rounding — so equality against the pipeline proves
 * the pipeline rather than replaying it.
 */

export const CERTIFICATION_EVIDENCE_SHAS = Object.freeze({
  manifest: "c0de5eed".repeat(8),
  homogeneity: "a77e57ed".repeat(8),
  collectionGuard: "9ded9ded".repeat(8),
});

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export const CERTIFICATION_TIMELINE = Object.freeze({
  configApprovedAt: "2026-08-19T17:00:00.000Z",
  lifecycleAt: "2026-08-19T17:10:00.000Z",
  backfillFinishedAt: "2026-08-19T17:05:00.000Z",
  /** Trove observes 25 minutes before calculation: the delayed example. */
  troveObservedAt: "2026-08-19T18:00:00.000Z",
  observedAt: "2026-08-19T18:20:00.000Z",
  calculatedAt: "2026-08-19T18:25:00.000Z",
  projectionAt: "2026-08-19T18:26:00.000Z",
  readAt: "2026-08-19T18:30:00.000Z",
  pullsObservedAt: "2026-08-19T18:35:00.000Z",
  pullsCalculatedAt: "2026-08-19T18:40:00.000Z",
  readAtAfterPulls: "2026-08-19T18:45:00.000Z",
  unprovenObservedAt: "2026-08-19T18:50:00.000Z",
  unprovenCalculatedAt: "2026-08-19T18:55:00.000Z",
  watermarkAt: "2026-08-19T18:50:00.000Z",
});

export const CERTIFICATION_ASSET_ORIGIN = "https://certified-vendor.example";

export const CERTIFICATION_USDC_PARITY = Object.freeze({
  currency: "USDC",
  parityNumerator: 1 as const,
  parityDenominator: 1 as const,
  effectiveAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-09-01T00:00:00.000Z",
  configurationRevision: "usdc-parity-2026-08",
});

export function certificationEvidenceContext(): PackScoutBuybackEvEvidenceContextV1 {
  return {
    evaluatedAt: CERTIFICATION_TIMELINE.calculatedAt,
    stablecoinParityApprovals: [CERTIFICATION_USDC_PARITY],
  };
}

// ---------------------------------------------------------------------------
// Sanitized source fixtures and independent expectations
// ---------------------------------------------------------------------------

export interface CertificationExpectationV1 {
  readonly status: "current" | "unavailable";
  readonly metrics: PackScoutBuybackEvTraceMetricsV1 | null;
  readonly confidence: PackScoutBuybackEvTraceConfidenceV1 | null;
  readonly publicReason:
    | "BUYBACK_UNAVAILABLE"
    | "SOURCE_EVIDENCE_UNAVAILABLE"
    | null;
  readonly sourceAgeState:
    | "fresh_within_15_minutes"
    | "delayed_over_15_through_30_minutes"
    | null;
  readonly rendered: Readonly<{
    statusLabel: string;
    grossEvDollars: string;
    grossEvPercent: string;
    evDollars: string;
    evPercent: string;
    confidenceDisplay: string;
    reasonCopy: string | null;
    semanticState: "positive" | "neutral" | "negative" | "unavailable";
  }>;
}

export interface CertificationProviderFixtureV1 {
  readonly providerKey: PackScoutBuybackEvLaunchProviderV1;
  readonly productKey: string;
  readonly packName: string;
  readonly scenario: string;
  readonly scenarioClasses:
    readonly PackScoutBuybackEvLaunchScenarioClassV1[];
  readonly sourceRevisionId: string;
  readonly observedAt: string;
  /** Canonical public pack price in USD cents (must equal the evidence). */
  readonly packPriceMinorUnits: number;
  /** Catalog-side uniform buyback percent, or null when not documented. */
  readonly catalogBuybackPercent: number | null;
  /** Independent vendor-reported EV in USD cents, or null. */
  readonly vendorReportedEvMinorUnits: number | null;
  readonly normalize: () => PackScoutBuybackEvEvidenceOutcomeV1;
  readonly expected: CertificationExpectationV1;
}

const availableRendered = (input: {
  grossEvDollars: string;
  grossEvPercent: string;
  evDollars: string;
  evPercent: string;
  confidenceDisplay: string;
  semanticState: "positive" | "neutral" | "negative";
}) => ({
  statusLabel: "Current estimate",
  reasonCopy: null,
  ...input,
});

const unavailableRendered = (reasonCopy: string) => ({
  statusLabel: "Unavailable",
  grossEvDollars: "Unavailable",
  grossEvPercent: "Unavailable",
  evDollars: "Unavailable",
  evPercent: "Unavailable",
  confidenceDisplay: "Unavailable",
  reasonCopy,
  semanticState: "unavailable" as const,
});

const COURTYARD_SOURCE: CourtyardBuybackEvSourceV1 = {
  listingId: "cert-listing-1",
  productRevisionId: "cert-court-product-r4",
  catalogRevisionId: "cert-court-rev-9",
  sourceManifestSha256: CERTIFICATION_EVIDENCE_SHAS.manifest,
  observedAt: CERTIFICATION_TIMELINE.observedAt,
  salePriceUsd: 100,
  buybackRatio: 0.85,
  buybackScopeDocumented: true,
  oddsBuckets: [
    { tier: "Standard", oddsPercent: 98, minValueUsd: 50, maxValueUsd: 90 },
    { tier: "Grail", oddsPercent: 2, minValueUsd: 1_000, maxValueUsd: 3_000 },
  ],
};

const COLLECTOR_CRYPT_SOURCE: CollectorCryptBuybackEvSourceV1 = {
  boxId: "cert-box-1",
  boxRevisionId: "cert-crypt-product-r2",
  feedRevisionId: "cert-crypt-rev-5",
  sourceManifestSha256: CERTIFICATION_EVIDENCE_SHAS.manifest,
  observedAt: CERTIFICATION_TIMELINE.observedAt,
  priceUsd: 200,
  cardsPerBox: 2,
  instantBuyback: {
    percentageOfValue: 90,
    processingFeeUsd: 5,
    minimumPayoutUsd: 10,
    maximumPayoutUsd: 500,
    appliesToEveryCard: true,
    marketConditionsClause: false,
  },
  slots: [
    { slotLabel: "Common", oddsPercent: 90, insuredValueUsd: 40 },
    { slotLabel: "Mid", oddsPercent: 5, insuredValueUsd: 10 },
    { slotLabel: "Grail", oddsPercent: 5, insuredValueUsd: 1_000 },
  ],
};

const PHYGITALS_SOURCE: PhygitalsBuybackEvSourceV1 = {
  dropId: "cert-drop-1",
  dropRevisionId: "cert-phyg-product-r3",
  marketplaceRevisionId: "cert-phyg-rev-7",
  sourceManifestSha256: CERTIFICATION_EVIDENCE_SHAS.manifest,
  observedAt: CERTIFICATION_TIMELINE.observedAt,
  priceUsd: 50,
  drawsPerPack: 1,
  buybackPercentRatio: null,
  buybackDocumentedForAllRarities: false,
  rarities: [
    { rarity: "Standard", oddsPercent: 100, fairMarketValueUsd: 30 },
  ],
};

export function clutchpacksCertificationSource(frame: {
  readonly siteRevisionId: string;
  readonly observedAt: string;
  readonly remainingAlpha: number;
  readonly remainingBeta: number;
  readonly publishedPercents: readonly [string, string] | null;
  readonly pullLedger: ClutchpacksBuybackEvSourceV1["pullLedger"];
}): ClutchpacksBuybackEvSourceV1 {
  return {
    packId: "cert-pack-1",
    packRevisionId: "cert-clutch-product-r6",
    siteRevisionId: frame.siteRevisionId,
    sourceManifestSha256: CERTIFICATION_EVIDENCE_SHAS.manifest,
    observedAt: frame.observedAt,
    packPriceText: "$25.00",
    buckets: [
      {
        bucketId: "alpha",
        name: "Alpha",
        minPriceText: "20.00",
        maxPriceText: "20.00",
        buybackPercentText: "90",
        buybackEligible: true,
        memberCount: 10,
        homogeneityAttestationSha256: CERTIFICATION_EVIDENCE_SHAS.homogeneity,
        publishedPoolPercentText: frame.publishedPercents?.[0] ?? null,
      },
      {
        bucketId: "beta",
        name: "Beta",
        minPriceText: "100.00",
        maxPriceText: "100.00",
        buybackPercentText: "80",
        buybackEligible: true,
        memberCount: 4,
        homogeneityAttestationSha256: CERTIFICATION_EVIDENCE_SHAS.homogeneity,
        publishedPoolPercentText: frame.publishedPercents?.[1] ?? null,
      },
    ],
    livePool: {
      poolRevisionId: frame.siteRevisionId,
      snapshotKind: "atomic_revision",
      countsChangedDuringCollection: false,
      coversAllBuckets: true,
      remainingByBucket: [
        { bucketId: "alpha", remaining: frame.remainingAlpha },
        { bucketId: "beta", remaining: frame.remainingBeta },
      ],
    },
    pullLedger: frame.pullLedger,
    publishedOddsRoundingPercentDecimals: 2,
  };
}

const CLUTCHPACKS_SOURCE = clutchpacksCertificationSource({
  siteRevisionId: "cert-clutch-rev-1",
  observedAt: CERTIFICATION_TIMELINE.observedAt,
  remainingAlpha: 3,
  remainingBeta: 1,
  publishedPercents: ["75.00", "25.00"],
  pullLedger: null,
});

const GAMESTOP_SOURCE: GamestopBuybackEvSourceV1 = {
  skuId: "cert-sku-1",
  skuRevisionId: "cert-gs-product-r8",
  storefrontRevisionId: "cert-gs-rev-3",
  sourceManifestSha256: CERTIFICATION_EVIDENCE_SHAS.manifest,
  observedAt: CERTIFICATION_TIMELINE.observedAt,
  listPriceUsd: 60,
  hitTiers: [
    {
      tierLabel: "Hit",
      oddsPercent: 10,
      estimatedValueUsd: 200,
      tradeCredit: { kind: "guaranteed_cash_offer", offerUsd: 150 },
    },
    {
      tierLabel: "Base",
      oddsPercent: 90,
      estimatedValueUsd: 5,
      tradeCredit: { kind: "not_offered", offerUsd: null },
    },
  ],
};

const BEEZIE_SOURCE: BeezieBuybackEvSourceV1 = {
  machineId: "cert-machine-1",
  machineRevisionId: "cert-beezie-product-r5",
  catalogRevisionId: "cert-beezie-rev-2",
  sourceManifestSha256: CERTIFICATION_EVIDENCE_SHAS.manifest,
  observedAt: CERTIFICATION_TIMELINE.observedAt,
  settlementCurrency: "USDC",
  priceMicroUnits: 78_000_000,
  swapFeePercents: [1, 1.5],
  swapDocumentedForAllTiers: true,
  oddsTiers: [
    {
      tier: "Low",
      oddsPercent: 80,
      fromMicroUnits: 10_000_000,
      toMicroUnits: 30_000_000,
    },
    {
      tier: "High",
      oddsPercent: 20,
      fromMicroUnits: 100_000_000,
      toMicroUnits: 100_000_000,
    },
  ],
};

const TROVE_SOURCE: TroveBuybackEvSourceV1 = {
  packId: "cert-trove-1",
  packRevisionId: "cert-trove-product-r9",
  catalogRevisionId: "cert-trove-rev-4",
  sourceManifestSha256: CERTIFICATION_EVIDENCE_SHAS.manifest,
  observedAt: CERTIFICATION_TIMELINE.troveObservedAt,
  priceUsd: 96,
  cardsPerPack: 3,
  valueBasis: "guaranteed_instant_payout",
  tiers: [
    { tierLabel: "Standard", oddsPercent: 96, valueUsd: 25 },
    { tierLabel: "Chase", oddsPercent: 4, valueUsd: 200 },
  ],
};

const STADIUM_VAULT_SOURCE: StadiumVaultBuybackEvSourceV1 = {
  caseId: "cert-case-1",
  caseRevisionId: "cert-vault-product-r1",
  catalogEndpointRevisionId: "cert-vault-catalog-rev-6",
  oddsEndpointRevisionId: "cert-vault-odds-rev-6b",
  collectionGuardSha256: CERTIFICATION_EVIDENCE_SHAS.collectionGuard,
  sourceManifestSha256: CERTIFICATION_EVIDENCE_SHAS.manifest,
  observedAt: CERTIFICATION_TIMELINE.observedAt,
  priceUsd: 40,
  instantSellPercent: 70,
  instantSellDocumentedForAllTiers: true,
  oddsTiers: [
    {
      tierLabel: "VIP",
      oddsPercent: 10,
      minValueUsd: 100,
      maxValueUsd: 100,
      redemptionOnly: false,
      // The unverified bucket is the sanitized unavailable-evidence example.
      bucket: {
        memberCount: 5,
        homogeneity: "unverified",
        attestationSha256: null,
      },
    },
    {
      tierLabel: "Base",
      oddsPercent: 90,
      minValueUsd: 5,
      maxValueUsd: 15,
      redemptionOnly: true,
      bucket: null,
    },
  ],
};

/**
 * The eight sanitized launch examples in canonical provider order. Every
 * expectation below is computed by hand from the sanitized source numbers —
 * exact integers only, no rounding — so equality against the pipeline proves
 * the pipeline rather than replaying it.
 */
export const CERTIFICATION_PROVIDER_FIXTURES: readonly CertificationProviderFixtureV1[] =
  Object.freeze([
    {
      providerKey: "beezie",
      productKey: "beezie:cert-machine-1",
      packName: "Beezie Certification Machine",
      scenario:
        "USDC micro-unit machine with mandatory swap fees and midpoint " +
        "tier ranges over published odds",
      scenarioClasses: ["mandatory_adjustment", "midpoint", "published_fallback"],
      sourceRevisionId: "cert-beezie-rev-2",
      observedAt: CERTIFICATION_TIMELINE.observedAt,
      packPriceMinorUnits: 7_800,
      catalogBuybackPercent: 97.5,
      vendorReportedEvMinorUnits: null,
      normalize: () =>
        normalizeBeezieBuybackEvEvidenceV1(BEEZIE_SOURCE, certificationEvidenceContext()),
      expected: {
        status: "current",
        // 0.8 x (2000c x 0.975) + 0.2 x (10000c x 0.975) = 1560 + 1950.
        metrics: {
          grossEvMinorUnits: 3_510,
          grossReturnBasisPoints: 4_500,
          evDollarsMinorUnits: -4_290,
          evPercentBasisPoints: -5_500,
        },
        confidence: {
          scoreBasisPoints: 6_500,
          band: "medium",
          limitationCodes: ["closed_range_midpoint", "platform_published_odds"],
        },
        publicReason: null,
        sourceAgeState: "fresh_within_15_minutes",
        rendered: availableRendered({
          grossEvDollars: "$35.10",
          grossEvPercent: "45.00%",
          evDollars: "-$42.90",
          evPercent: "-55.00%",
          confidenceDisplay: "Medium · 65%",
          semanticState: "negative",
        }),
      },
    },
    {
      providerKey: "clutchpacks",
      productKey: "clutchpacks:cert-pack-1",
      packName: "ClutchPacks Certification Pool",
      scenario:
        "outcome-specific bucket rates over verified current remaining " +
        "inventory with a within-tolerance published comparison",
      scenarioClasses: ["outcome_specific_rate", "current_pool"],
      sourceRevisionId: "cert-clutch-rev-1",
      observedAt: CERTIFICATION_TIMELINE.observedAt,
      packPriceMinorUnits: 2_500,
      catalogBuybackPercent: 90,
      vendorReportedEvMinorUnits: null,
      normalize: () =>
        normalizeClutchpacksBuybackEvEvidenceV1(
          CLUTCHPACKS_SOURCE,
          certificationEvidenceContext(),
        ),
      expected: {
        status: "current",
        // (3/4) x (2000c x 0.9) + (1/4) x (10000c x 0.8) = 1350 + 2000.
        metrics: {
          grossEvMinorUnits: 3_350,
          grossReturnBasisPoints: 13_400,
          evDollarsMinorUnits: 850,
          evPercentBasisPoints: 3_400,
        },
        confidence: {
          scoreBasisPoints: 10_000,
          band: "high",
          limitationCodes: [],
        },
        publicReason: null,
        sourceAgeState: "fresh_within_15_minutes",
        rendered: availableRendered({
          grossEvDollars: "$33.50",
          grossEvPercent: "134.00%",
          evDollars: "+$8.50",
          evPercent: "+34.00%",
          confidenceDisplay: "High · 100%",
          semanticState: "positive",
        }),
      },
    },
    {
      providerKey: "collector_crypt",
      productKey: "collector-crypt:cert-box-1",
      packName: "Collector Crypt Certification Box",
      scenario:
        "uniform instant-buyback rate with mandatory processing fee, " +
        "payout floor, and payout cap across two draws",
      scenarioClasses: ["uniform_rate", "mandatory_adjustment"],
      sourceRevisionId: "cert-crypt-rev-5",
      observedAt: CERTIFICATION_TIMELINE.observedAt,
      packPriceMinorUnits: 20_000,
      catalogBuybackPercent: 90,
      vendorReportedEvMinorUnits: null,
      normalize: () =>
        normalizeCollectorCryptBuybackEvEvidenceV1(
          COLLECTOR_CRYPT_SOURCE,
          certificationEvidenceContext(),
        ),
      expected: {
        status: "current",
        // Payout order rated -> fee -> floor -> cap:
        // 40 -> 31; 10 -> 4 -> floor 10; 1000 -> 895 -> cap 500.
        // Per draw 0.9x3100 + 0.05x1000 + 0.05x50000 = 5340c; x2 draws.
        metrics: {
          grossEvMinorUnits: 10_680,
          grossReturnBasisPoints: 5_340,
          evDollarsMinorUnits: -9_320,
          evPercentBasisPoints: -4_660,
        },
        confidence: {
          scoreBasisPoints: 8_500,
          band: "high",
          limitationCodes: ["platform_published_odds"],
        },
        publicReason: null,
        sourceAgeState: "fresh_within_15_minutes",
        rendered: availableRendered({
          grossEvDollars: "$106.80",
          grossEvPercent: "53.40%",
          evDollars: "-$93.20",
          evPercent: "-46.60%",
          confidenceDisplay: "High · 85%",
          semanticState: "negative",
        }),
      },
    },
    {
      providerKey: "courtyard",
      productKey: "courtyard:cert-listing-1",
      packName: "Courtyard Certification Listing",
      scenario:
        "documented uniform rate over platform-published odds with " +
        "closed-range midpoints and an independent vendor-reported EV",
      scenarioClasses: ["uniform_rate", "published_fallback", "midpoint"],
      sourceRevisionId: "cert-court-rev-9",
      observedAt: CERTIFICATION_TIMELINE.observedAt,
      packPriceMinorUnits: 10_000,
      catalogBuybackPercent: 85,
      vendorReportedEvMinorUnits: 11_111,
      normalize: () =>
        normalizeCourtyardBuybackEvEvidenceV1(
          COURTYARD_SOURCE,
          certificationEvidenceContext(),
        ),
      expected: {
        status: "current",
        // 0.98 x (7000c x 0.85) + 0.02 x (200000c x 0.85) = 5831 + 3400.
        metrics: {
          grossEvMinorUnits: 9_231,
          grossReturnBasisPoints: 9_231,
          evDollarsMinorUnits: -769,
          evPercentBasisPoints: -769,
        },
        confidence: {
          scoreBasisPoints: 6_500,
          band: "medium",
          limitationCodes: ["closed_range_midpoint", "platform_published_odds"],
        },
        publicReason: null,
        sourceAgeState: "fresh_within_15_minutes",
        rendered: availableRendered({
          grossEvDollars: "$92.31",
          grossEvPercent: "92.31%",
          evDollars: "-$7.69",
          evPercent: "-7.69%",
          confidenceDisplay: "Medium · 65%",
          semanticState: "negative",
        }),
      },
    },
    {
      providerKey: "gamestop",
      productKey: "gamestop:cert-sku-1",
      packName: "GameStop Certification Repack",
      scenario:
        "fixed guaranteed cash offer beside an explicitly ineligible tier " +
        "that contributes zero payout with retained probability",
      scenarioClasses: ["fixed_payout", "ineligibility"],
      sourceRevisionId: "cert-gs-rev-3",
      observedAt: CERTIFICATION_TIMELINE.observedAt,
      packPriceMinorUnits: 6_000,
      catalogBuybackPercent: 75,
      vendorReportedEvMinorUnits: null,
      normalize: () =>
        normalizeGamestopBuybackEvEvidenceV1(GAMESTOP_SOURCE, certificationEvidenceContext()),
      expected: {
        status: "current",
        // 0.1 x 15000c + 0.9 x 0c (ineligible, probability retained).
        metrics: {
          grossEvMinorUnits: 1_500,
          grossReturnBasisPoints: 2_500,
          evDollarsMinorUnits: -4_500,
          evPercentBasisPoints: -7_500,
        },
        confidence: {
          scoreBasisPoints: 8_500,
          band: "high",
          limitationCodes: ["platform_published_odds"],
        },
        publicReason: null,
        sourceAgeState: "fresh_within_15_minutes",
        rendered: availableRendered({
          grossEvDollars: "$15.00",
          grossEvPercent: "25.00%",
          evDollars: "-$45.00",
          evPercent: "-75.00%",
          confidenceDisplay: "High · 85%",
          semanticState: "negative",
        }),
      },
    },
    {
      providerKey: "phygitals",
      productKey: "phygitals:cert-drop-1",
      packName: "Phygitals Certification Drop",
      scenario:
        "no documented buyback program: PackScout EV fails closed as " +
        "unavailable and never assumes a rate",
      scenarioClasses: ["no_buyback"],
      sourceRevisionId: "cert-phyg-rev-7",
      observedAt: CERTIFICATION_TIMELINE.observedAt,
      packPriceMinorUnits: 5_000,
      catalogBuybackPercent: null,
      vendorReportedEvMinorUnits: null,
      normalize: () =>
        normalizePhygitalsBuybackEvEvidenceV1(
          PHYGITALS_SOURCE,
          certificationEvidenceContext(),
        ),
      expected: {
        status: "unavailable",
        metrics: null,
        confidence: null,
        publicReason: "BUYBACK_UNAVAILABLE",
        sourceAgeState: null,
        rendered: unavailableRendered(
          "Unavailable: documented buyback terms are unavailable.",
        ),
      },
    },
    {
      providerKey: "stadium_vault",
      productKey: "stadium-vault:cert-case-1",
      packName: "Stadium Vault Certification Case",
      scenario:
        "guarded two-endpoint observation whose unverified aggregate bucket " +
        "makes the evidence unavailable end to end",
      scenarioClasses: ["unavailable_evidence", "ineligibility"],
      sourceRevisionId: "cert-vault-catalog-rev-6@cert-vault-odds-rev-6b",
      observedAt: CERTIFICATION_TIMELINE.observedAt,
      packPriceMinorUnits: 4_000,
      catalogBuybackPercent: 70,
      vendorReportedEvMinorUnits: null,
      normalize: () =>
        normalizeStadiumVaultBuybackEvEvidenceV1(
          STADIUM_VAULT_SOURCE,
          certificationEvidenceContext(),
        ),
      expected: {
        status: "unavailable",
        metrics: null,
        confidence: null,
        publicReason: "SOURCE_EVIDENCE_UNAVAILABLE",
        sourceAgeState: null,
        rendered: unavailableRendered(
          "Unavailable: source evidence is incomplete or unsupported.",
        ),
      },
    },
    {
      providerKey: "trove",
      productKey: "trove:cert-trove-1",
      packName: "Trove Certification Pack",
      scenario:
        "documented final guaranteed payouts across three draws, never " +
        "discounted again, with a delayed source observation",
      scenarioClasses: ["fixed_payout", "published_fallback"],
      sourceRevisionId: "cert-trove-rev-4",
      observedAt: CERTIFICATION_TIMELINE.troveObservedAt,
      packPriceMinorUnits: 9_600,
      catalogBuybackPercent: 100,
      vendorReportedEvMinorUnits: null,
      normalize: () =>
        normalizeTroveBuybackEvEvidenceV1(TROVE_SOURCE, certificationEvidenceContext()),
      expected: {
        status: "current",
        // Per draw 0.96 x 2500c + 0.04 x 20000c = 3200c; x3 draws = 9600c.
        metrics: {
          grossEvMinorUnits: 9_600,
          grossReturnBasisPoints: 10_000,
          evDollarsMinorUnits: 0,
          evPercentBasisPoints: 0,
        },
        confidence: {
          scoreBasisPoints: 7_500,
          band: "medium",
          limitationCodes: [
            "platform_published_odds",
            "source_age_over_15_through_30_minutes",
          ],
        },
        publicReason: null,
        sourceAgeState: "delayed_over_15_through_30_minutes",
        rendered: availableRendered({
          grossEvDollars: "$96.00",
          grossEvPercent: "100.00%",
          evDollars: "$0.00",
          evPercent: "0.00%",
          confidenceDisplay: "Medium · 75%",
          semanticState: "neutral",
        }),
      },
    },
  ]);
