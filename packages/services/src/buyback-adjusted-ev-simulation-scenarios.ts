import {
  buildPublicCollectibleSearchText,
  normalizePublicSearchText,
  parsePackScoutBuybackEvTimestampMillisV1,
  type PackScoutBuybackEvConfidenceLimitationCodeV1,
  type PackScoutBuybackEvEvidenceOutcomeV1,
  type PackScoutBuybackEvPublicReasonCodeV1,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
} from "@packscout/contracts";
import type { PackScoutBuybackEvRecomputationCommandV1 } from "./buyback-adjusted-ev-recomputation-contracts.ts";
import type {
  DataReleaseV3CanonicalProduct,
  DataReleaseV3CanonicalSnapshot,
} from "./buyback-adjusted-ev-release-types.ts";
import {
  assertPackScoutBuybackEvSimulationFrameIndexV1,
  packScoutBuybackEvSimulatedUuidV1,
  packScoutBuybackEvSimulationDigestV1,
  packScoutBuybackEvSimulationFrameClockV1,
  packScoutBuybackEvSimulationRunIdV1,
  validatePackScoutBuybackEvSimulationControlsV1,
  type PackScoutBuybackEvSimulationControlsV1,
} from "./buyback-adjusted-ev-simulation-contracts.ts";
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
  normalizeCourtyardBuybackEvEvidenceV1,
  type CourtyardBuybackEvSourceV1,
} from "./providers/courtyard/buyback-ev-evidence.ts";
import {
  normalizeGamestopBuybackEvEvidenceV1,
  type GamestopBuybackEvSourceV1,
} from "./providers/gamestop/buyback-ev-evidence.ts";
import {
  normalizeTroveBuybackEvEvidenceV1,
  type TroveBuybackEvSourceV1,
} from "./providers/trove/buyback-ev-evidence.ts";

/**
 * Versioned scenario set for the buyback-adjusted EV simulation
 * (task buyback-adjusted-ev/009), scenario version
 * `packscout-buyback-ev-simulation-scenarios-v1`.
 *
 * Every frame derives purely from the explicit controls. Each scenario mints
 * one bounded synthetic provider-like source revision in the exact typed
 * sanitized shape its real provider module consumes, normalizes it through
 * that real provider module (no simulation-only vocabulary), and pairs it
 * with one sanitized canonical catalog product for the release read. Raw
 * synthetic source revisions exist only inside the returned frame value and
 * are never persisted, published, or logged by the runner.
 *
 * Approved state coverage across the roster (frame clocks advance; observed
 * event time never moves past the frame's calculation clock):
 *
 * - positive, neutral, negative, and valid zero-payout available estimates;
 * - uniform and outcome-specific buyback, fixed guaranteed offers, final
 *   payout values (never re-discounted), explicit ineligibility, closed-range
 *   midpoints, published-odds fallback, and current-pool odds with
 *   deterministic pull-driven depletion plus a restock;
 * - per-pack and per-draw unit bases and USDC stablecoin-parity pricing;
 * - no-buyback, odds-conflict, and incomplete-evidence unavailable states;
 * - delayed evidence in both the 15–30 and 30–60 minute penalty bands, a
 *   fixed observation that expires as the calculation clock advances, and a
 *   sold-out product frozen as explicit history;
 * - price-, buyback-, value-, and pull-driven transitions, at least two of
 *   which visibly change public bytes between successive frames.
 */

export const PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_KEYS_V1 = Object.freeze([
  "courtyard-uniform-price-shift",
  "clutchpacks-pool-pulls",
  "gamestop-fixed-offers",
  "trove-per-draw-final-payout",
  "beezie-usdc-parity",
  "courtyard-zero-payout",
  "courtyard-no-buyback",
  "clutchpacks-odds-conflict",
  "courtyard-incomplete-values",
  "courtyard-delayed-20m",
  "courtyard-delayed-45m",
  "trove-sold-out-historical",
  "courtyard-source-age-expiry",
] as const);

export type PackScoutBuybackEvSimulationScenarioKeyV1 =
  (typeof PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_KEYS_V1)[number];

export type PackScoutBuybackEvSimulatedSourceRevisionV1 =
  | Readonly<{ providerKey: "courtyard"; source: CourtyardBuybackEvSourceV1 }>
  | Readonly<{ providerKey: "clutchpacks"; source: ClutchpacksBuybackEvSourceV1 }>
  | Readonly<{ providerKey: "gamestop"; source: GamestopBuybackEvSourceV1 }>
  | Readonly<{ providerKey: "trove"; source: TroveBuybackEvSourceV1 }>
  | Readonly<{ providerKey: "beezie"; source: BeezieBuybackEvSourceV1 }>;

/** Bounded per-frame expectation; never a precomputed final metric. */
export interface PackScoutBuybackEvSimulationExpectationV1 {
  readonly publicState: "current" | "sold_out_historical" | "unavailable";
  readonly publicReason: PackScoutBuybackEvPublicReasonCodeV1 | null;
  readonly limitationCodes:
    readonly PackScoutBuybackEvConfidenceLimitationCodeV1[];
}

export interface PackScoutBuybackEvSimulationScenarioFrameV1 {
  readonly scenarioKey: PackScoutBuybackEvSimulationScenarioKeyV1;
  readonly providerKey: string;
  readonly purpose: string;
  readonly expectation: PackScoutBuybackEvSimulationExpectationV1;
  readonly sourceRevision: PackScoutBuybackEvSimulatedSourceRevisionV1;
  readonly evidence: PackScoutBuybackEvEvidenceOutcomeV1;
  readonly command: PackScoutBuybackEvRecomputationCommandV1;
  readonly product: DataReleaseV3CanonicalProduct;
}

export interface PackScoutBuybackEvSimulationFrameV1 {
  readonly scenarioVersion: PackScoutBuybackEvSimulationControlsV1["scenarioVersion"];
  readonly simulationRunId: string;
  readonly frameIndex: number;
  /** The frame's calculation and release read clock. */
  readonly readAt: string;
  readonly organizationId: string;
  readonly configurationRevisionId: string;
  readonly scenarios: readonly PackScoutBuybackEvSimulationScenarioFrameV1[];
  readonly snapshot: DataReleaseV3CanonicalSnapshot;
}

const MINUTE = 60_000;
const FRESHNESS_WINDOW_MILLISECONDS = 60 * MINUTE;
const PARITY_WINDOW_BEFORE_MILLISECONDS = 365 * 86_400_000;
const PARITY_WINDOW_AFTER_MILLISECONDS = 15 * 365 * 86_400_000;

function usd(minorUnits: number) {
  return { minorUnits, currency: "USD" as const };
}

function isoMinus(clock: string, milliseconds: number): string {
  return new Date(Date.parse(clock) - milliseconds).toISOString();
}

interface ScenarioBuildContext {
  readonly controls: PackScoutBuybackEvSimulationControlsV1;
  readonly frameIndex: number;
  readonly readAt: string;
  readonly seedTag: string;
  readonly organizationId: string;
  readonly configurationRevisionId: string;
  readonly categoryId: string;
  readonly evidenceContext: (evaluatedAt: string) =>
    PackScoutBuybackEvEvidenceContextV1;
}

function sourceRevisionId(
  build: ScenarioBuildContext,
  scenarioKey: string,
  frameTag: string,
): string {
  return `sim-${build.seedTag}-${scenarioKey}-${frameTag}`;
}

function manifestSha(
  build: ScenarioBuildContext,
  scenarioKey: string,
  frameTag: string,
): string {
  return packScoutBuybackEvSimulationDigestV1("source-manifest", {
    seedTag: build.seedTag,
    scenarioKey,
    frameTag,
  });
}

function providerId(build: ScenarioBuildContext, providerKey: string): string {
  return packScoutBuybackEvSimulatedUuidV1("provider", {
    seedTag: build.seedTag,
    providerKey,
  });
}

interface ProductShape {
  readonly scenarioKey: PackScoutBuybackEvSimulationScenarioKeyV1;
  readonly providerKey: string;
  readonly productKey: string;
  readonly name: string;
  readonly description: string;
  readonly priceUsdCents: number;
  readonly buyback: DataReleaseV3CanonicalProduct["buyback"];
  readonly availability: "active" | "sold_out";
  readonly soldOutAt: string | null;
  readonly sourceUpdatedAt: string;
  readonly vendorReportedEv?: DataReleaseV3CanonicalProduct["vendorReportedEv"];
  readonly topChase?: PublicRepackChase | null;
  readonly knownCollectibleCount?: number;
}

function buildProduct(
  build: ScenarioBuildContext,
  shape: ProductShape,
): DataReleaseV3CanonicalProduct {
  return {
    platformKey: shape.providerKey,
    productKey: shape.productKey,
    publicRepackId: packScoutBuybackEvSimulatedUuidV1("repack", {
      seedTag: build.seedTag,
      scenarioKey: shape.scenarioKey,
    }),
    publicVendorId: packScoutBuybackEvSimulatedUuidV1("vendor", {
      seedTag: build.seedTag,
      providerKey: shape.providerKey,
    }),
    vendorKey: `simulated-${shape.providerKey}`,
    vendorDisplayName: `Simulated ${shape.providerKey} vendor`,
    vendorLogoUrl: null,
    name: `[Simulated] ${shape.name}`,
    format: "repack",
    contentMode: "focused",
    categories: [
      { publicCategoryId: build.categoryId, label: "Simulated Cards" },
    ],
    collectibleTypes: ["card"],
    availability: shape.availability,
    soldOutAt: shape.soldOutAt,
    price: {
      displayMoney: usd(shape.priceUsdCents),
      usdComparison: { status: "available", value: usd(shape.priceUsdCents) },
    },
    buyback: shape.buyback,
    vendorReportedEv: shape.vendorReportedEv ?? {
      status: "unavailable",
      sourceMoney: null,
      usdComparison: null,
      observedAt: null,
      reason: "NOT_REPORTED",
    },
    primaryImage: null,
    topChase: shape.topChase ?? null,
    contentSummary: {
      knownCollectibleCount: shape.knownCollectibleCount ?? 0,
      chaseCount: shape.topChase ? 1 : 0,
      categoryCount: 1,
      collectibleTypeCount: 1,
      evidenceCompleteness: "complete",
      probabilityCoverageBasisPoints: 10_000,
    },
    actionAvailability: { promo: false, repackLink: false },
    sourceUpdatedAt: shape.sourceUpdatedAt,
    description: `Simulated scenario: ${shape.description}`,
    actions: {},
  };
}

function scenarioFrame(input: {
  readonly build: ScenarioBuildContext;
  readonly scenarioKey: PackScoutBuybackEvSimulationScenarioKeyV1;
  readonly purpose: string;
  readonly expectation: PackScoutBuybackEvSimulationExpectationV1;
  readonly sourceRevision: PackScoutBuybackEvSimulatedSourceRevisionV1;
  readonly calculatedAt: string;
  readonly product: DataReleaseV3CanonicalProduct;
}): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const context = input.build.evidenceContext(input.calculatedAt);
  const revision = input.sourceRevision;
  const evidence =
    revision.providerKey === "courtyard"
      ? normalizeCourtyardBuybackEvEvidenceV1(revision.source, context)
      : revision.providerKey === "clutchpacks"
        ? normalizeClutchpacksBuybackEvEvidenceV1(revision.source, context)
        : revision.providerKey === "gamestop"
          ? normalizeGamestopBuybackEvEvidenceV1(revision.source, context)
          : revision.providerKey === "trove"
            ? normalizeTroveBuybackEvEvidenceV1(revision.source, context)
            : normalizeBeezieBuybackEvEvidenceV1(revision.source, context);
  return {
    scenarioKey: input.scenarioKey,
    providerKey: revision.providerKey,
    purpose: input.purpose,
    expectation: input.expectation,
    sourceRevision: revision,
    evidence,
    command: {
      organizationId: input.build.organizationId,
      providerId: providerId(input.build, revision.providerKey),
      configurationRevisionId: input.build.configurationRevisionId,
      evidence,
      calculatedAt: input.calculatedAt,
    },
    product: input.product,
  };
}

function courtyardBucket(
  tier: string,
  oddsPercent: number,
  minValueUsd: number | null,
  maxValueUsd: number | null,
) {
  return { tier, oddsPercent, minValueUsd, maxValueUsd };
}

function courtyardSource(input: {
  readonly build: ScenarioBuildContext;
  readonly scenarioKey: PackScoutBuybackEvSimulationScenarioKeyV1;
  readonly frameTag: string;
  readonly observedAt: string;
  readonly salePriceUsd: number;
  readonly buybackRatio: number | null;
  readonly oddsBuckets: CourtyardBuybackEvSourceV1["oddsBuckets"];
}): PackScoutBuybackEvSimulatedSourceRevisionV1 {
  return {
    providerKey: "courtyard",
    source: {
      listingId: `sim-${input.scenarioKey}`,
      productRevisionId: `sim-${input.build.seedTag}-${input.scenarioKey}-product-1`,
      catalogRevisionId: sourceRevisionId(
        input.build,
        input.scenarioKey,
        input.frameTag,
      ),
      sourceManifestSha256: manifestSha(
        input.build,
        input.scenarioKey,
        input.frameTag,
      ),
      observedAt: input.observedAt,
      salePriceUsd: input.salePriceUsd,
      buybackRatio: input.buybackRatio,
      buybackScopeDocumented: true,
      oddsBuckets: input.oddsBuckets,
    },
  };
}

const CURRENT: PackScoutBuybackEvSimulationExpectationV1 = {
  publicState: "current",
  publicReason: null,
  limitationCodes: ["platform_published_odds"],
};

function unavailable(
  publicReason: PackScoutBuybackEvPublicReasonCodeV1,
): PackScoutBuybackEvSimulationExpectationV1 {
  return { publicState: "unavailable", publicReason, limitationCodes: [] };
}

/**
 * The `$100 outcome EV / 85% uniform buyback / $100 price` walk-through with
 * a price-driven transition: frame 0 prices the pack at $100 (Gross EV $85,
 * 85%, EV -$15, -15%), later frames reprice it to $80 under a fresh source
 * revision so the same buyback terms turn positive.
 */
function courtyardUniformPriceShift(
  build: ScenarioBuildContext,
  chase: PublicRepackChase,
): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const scenarioKey = "courtyard-uniform-price-shift";
  const observedAt = isoMinus(build.readAt, 5 * MINUTE);
  const salePriceUsd = build.frameIndex === 0 ? 100 : 80;
  const sourceRevision = courtyardSource({
    build,
    scenarioKey,
    frameTag: `r${build.frameIndex}`,
    observedAt,
    salePriceUsd,
    buybackRatio: 0.85,
    oddsBuckets: [
      courtyardBucket("grail", 25, 220, 220),
      courtyardBucket("common", 75, 60, 60),
    ],
  });
  return scenarioFrame({
    build,
    scenarioKey,
    purpose:
      "uniform documented buyback with published-odds fallback and a price-driven transition",
    expectation: CURRENT,
    sourceRevision,
    calculatedAt: build.readAt,
    product: buildProduct(build, {
      scenarioKey,
      providerKey: "courtyard",
      productKey: `courtyard:sim-${scenarioKey}`,
      name: "Uniform Buyback Price Shift",
      description:
        "the $100/85% methodology example, repriced to $80 from frame 1 onward",
      priceUsdCents: salePriceUsd * 100,
      buyback: { kind: "uniform_rate", rateBasisPoints: 8_500 },
      availability: "active",
      soldOutAt: null,
      sourceUpdatedAt: observedAt,
      topChase: chase,
      knownCollectibleCount: 1,
    }),
  });
}

/** Deterministic pull-driven depletion of an atomic live pool, plus restock. */
function clutchpacksPoolPulls(
  build: ScenarioBuildContext,
): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const scenarioKey = "clutchpacks-pool-pulls";
  const observedAt = isoMinus(build.readAt, 4 * MINUTE);
  const restocked = build.frameIndex >= 3;
  const pullRounds = restocked
    ? (build.frameIndex - 3) % 8
    : build.frameIndex % 3;
  const remaining = restocked
    ? { hit: 10, base: 60, dud: 80 }
    : { hit: 5, base: 45, dud: 50 };
  const siteRevisionId = sourceRevisionId(
    build,
    scenarioKey,
    `r${build.frameIndex}`,
  );
  const attestation = (bucketId: string) =>
    packScoutBuybackEvSimulationDigestV1("clutchpacks-attestation", {
      seedTag: build.seedTag,
      scenarioKey,
      bucketId,
    });
  const bucket = (
    bucketId: string,
    minPriceText: string,
    maxPriceText: string,
    buybackPercentText: string | null,
    buybackEligible: boolean,
    memberCount: number,
  ) => ({
    bucketId,
    name: `Simulated ${bucketId} bucket`,
    minPriceText,
    maxPriceText,
    buybackPercentText,
    buybackEligible,
    memberCount,
    homogeneityAttestationSha256: attestation(bucketId),
    publishedPoolPercentText: null,
  });
  const sourceRevision: PackScoutBuybackEvSimulatedSourceRevisionV1 = {
    providerKey: "clutchpacks",
    source: {
      packId: `sim-${scenarioKey}`,
      packRevisionId: `sim-${build.seedTag}-${scenarioKey}-product-1`,
      siteRevisionId,
      sourceManifestSha256: manifestSha(
        build,
        scenarioKey,
        `r${build.frameIndex}`,
      ),
      observedAt,
      packPriceText: "50.00",
      buckets: [
        bucket("hit", "40.00", "160.00", "80", true, 4),
        bucket("base", "10.00", "30.00", "75", true, 40),
        bucket("dud", "1.00", "3.00", null, false, 80),
      ],
      livePool: {
        poolRevisionId: siteRevisionId,
        snapshotKind: "atomic_revision",
        countsChangedDuringCollection: false,
        coversAllBuckets: true,
        remainingByBucket: [
          { bucketId: "hit", remaining: remaining.hit },
          { bucketId: "base", remaining: remaining.base },
          { bucketId: "dud", remaining: remaining.dud },
        ],
      },
      pullLedger:
        pullRounds === 0
          ? null
          : [
              {
                bucketId: "hit",
                pulls: pullRounds,
                ledgerRevisionId: siteRevisionId,
              },
              {
                bucketId: "base",
                pulls: 3 * pullRounds,
                ledgerRevisionId: siteRevisionId,
              },
              {
                bucketId: "dud",
                pulls: 6 * pullRounds,
                ledgerRevisionId: siteRevisionId,
              },
            ],
      publishedOddsRoundingPercentDecimals: null,
    },
  };
  return scenarioFrame({
    build,
    scenarioKey,
    purpose:
      "current-pool odds with outcome-specific rates, explicit ineligibility, midpoint ranges, pull-driven depletion, and a restock at frame 3",
    expectation: {
      publicState: "current",
      publicReason: null,
      limitationCodes: ["closed_range_midpoint"],
    },
    sourceRevision,
    calculatedAt: build.readAt,
    product: buildProduct(build, {
      scenarioKey,
      providerKey: "clutchpacks",
      productKey: `clutchpacks:sim-${scenarioKey}`,
      name: "Live Pool Pull Tracker",
      description:
        "verified remaining inventory depleted deterministically by the pull ledger",
      priceUsdCents: 5_000,
      buyback: { kind: "varies_by_outcome" },
      availability: "active",
      soldOutAt: null,
      sourceUpdatedAt: observedAt,
    }),
  });
}

/** Fixed guaranteed cash offers with a buyback-driven neutral transition. */
function gamestopFixedOffers(
  build: ScenarioBuildContext,
): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const scenarioKey = "gamestop-fixed-offers";
  const observedAt = isoMinus(build.readAt, 3 * MINUTE);
  const midOfferUsd = build.frameIndex >= 2 ? 95 : 80;
  const sourceRevision: PackScoutBuybackEvSimulatedSourceRevisionV1 = {
    providerKey: "gamestop",
    source: {
      skuId: `sim-${scenarioKey}`,
      skuRevisionId: `sim-${build.seedTag}-${scenarioKey}-product-1`,
      storefrontRevisionId: sourceRevisionId(
        build,
        scenarioKey,
        `r${build.frameIndex}`,
      ),
      sourceManifestSha256: manifestSha(
        build,
        scenarioKey,
        `r${build.frameIndex}`,
      ),
      observedAt,
      listPriceUsd: 50,
      hitTiers: [
        {
          tierLabel: "chase",
          oddsPercent: 10,
          estimatedValueUsd: 200,
          tradeCredit: { kind: "guaranteed_cash_offer", offerUsd: 120 },
        },
        {
          tierLabel: "mid",
          oddsPercent: 40,
          estimatedValueUsd: 50,
          tradeCredit: { kind: "guaranteed_cash_offer", offerUsd: midOfferUsd },
        },
        {
          tierLabel: "floor",
          oddsPercent: 50,
          estimatedValueUsd: 10,
          tradeCredit: { kind: "not_offered", offerUsd: null },
        },
      ],
    },
  };
  return scenarioFrame({
    build,
    scenarioKey,
    purpose:
      "fixed guaranteed offers, an explicitly ineligible zero-payout tier, and a buyback-driven transition to neutral EV at frame 2",
    expectation: CURRENT,
    sourceRevision,
    calculatedAt: build.readAt,
    product: buildProduct(build, {
      scenarioKey,
      providerKey: "gamestop",
      productKey: `gamestop:sim-${scenarioKey}`,
      name: "Guaranteed Trade Credit Box",
      description:
        "exact stated values with tier-level guaranteed cash offers beside an independent vendor-reported EV",
      priceUsdCents: 5_000,
      buyback: { kind: "fixed_or_final_payout" },
      availability: "active",
      soldOutAt: null,
      sourceUpdatedAt: observedAt,
      vendorReportedEv: {
        status: "available",
        sourceMoney: { minorUnits: 6_000, currency: "USD" },
        usdComparison: { status: "available", value: usd(6_000) },
        observedAt,
      },
    }),
  });
}

/** Per-draw final guaranteed payouts with a value-driven transition. */
function trovePerDrawFinalPayout(
  build: ScenarioBuildContext,
): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const scenarioKey = "trove-per-draw-final-payout";
  const observedAt = isoMinus(build.readAt, 6 * MINUTE);
  const commonValueUsd = build.frameIndex === 0 ? 4.5 : 4;
  const sourceRevision: PackScoutBuybackEvSimulatedSourceRevisionV1 = {
    providerKey: "trove",
    source: {
      packId: `sim-${scenarioKey}`,
      packRevisionId: `sim-${build.seedTag}-${scenarioKey}-product-1`,
      catalogRevisionId: sourceRevisionId(
        build,
        scenarioKey,
        `r${build.frameIndex}`,
      ),
      sourceManifestSha256: manifestSha(
        build,
        scenarioKey,
        `r${build.frameIndex}`,
      ),
      observedAt,
      priceUsd: 25,
      cardsPerPack: 5,
      valueBasis: "guaranteed_instant_payout",
      tiers: [
        { tierLabel: "rare", oddsPercent: 4, valueUsd: 50 },
        { tierLabel: "common", oddsPercent: 96, valueUsd: commonValueUsd },
      ],
    },
  };
  return scenarioFrame({
    build,
    scenarioKey,
    purpose:
      "per-draw final guaranteed payouts that are never re-discounted, with a value-driven transition at frame 1",
    expectation: CURRENT,
    sourceRevision,
    calculatedAt: build.readAt,
    product: buildProduct(build, {
      scenarioKey,
      providerKey: "trove",
      productKey: `trove:sim-${scenarioKey}`,
      name: "Five Draw Instant Payout Pack",
      description: "five draws per pack priced on guaranteed instant payouts",
      priceUsdCents: 2_500,
      buyback: { kind: "fixed_or_final_payout" },
      availability: "active",
      soldOutAt: null,
      sourceUpdatedAt: observedAt,
    }),
  });
}

/** Supported USDC stablecoin parity normalized to rational USD cents. */
function beezieUsdcParity(
  build: ScenarioBuildContext,
): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const scenarioKey = "beezie-usdc-parity";
  const observedAt = isoMinus(build.readAt, 7 * MINUTE);
  const sourceRevision: PackScoutBuybackEvSimulatedSourceRevisionV1 = {
    providerKey: "beezie",
    source: {
      machineId: `sim-${scenarioKey}`,
      machineRevisionId: `sim-${build.seedTag}-${scenarioKey}-product-1`,
      catalogRevisionId: sourceRevisionId(
        build,
        scenarioKey,
        `r${build.frameIndex}`,
      ),
      sourceManifestSha256: manifestSha(
        build,
        scenarioKey,
        `r${build.frameIndex}`,
      ),
      observedAt,
      settlementCurrency: "USDC",
      priceMicroUnits: 20_000_000,
      swapFeePercents: [0],
      swapDocumentedForAllTiers: true,
      oddsTiers: [
        {
          tier: "gold",
          oddsPercent: 5,
          fromMicroUnits: 100_000_000,
          toMicroUnits: 100_000_000,
        },
        {
          tier: "silver",
          oddsPercent: 95,
          fromMicroUnits: 10_000_000,
          toMicroUnits: 10_000_000,
        },
      ],
    },
  };
  return scenarioFrame({
    build,
    scenarioKey,
    purpose: "approved USDC parity normalized to rational USD cents",
    expectation: CURRENT,
    sourceRevision,
    calculatedAt: build.readAt,
    product: buildProduct(build, {
      scenarioKey,
      providerKey: "beezie",
      productKey: `beezie:sim-${scenarioKey}`,
      name: "USDC Settlement Machine",
      description: "USDC-priced machine compared at documented 1:1 parity",
      priceUsdCents: 2_000,
      buyback: { kind: "uniform_rate", rateBasisPoints: 10_000 },
      availability: "active",
      soldOutAt: null,
      sourceUpdatedAt: observedAt,
    }),
  });
}

/** A documented 0% uniform rate: an available estimate with a $0 payout. */
function courtyardZeroPayout(
  build: ScenarioBuildContext,
): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const scenarioKey = "courtyard-zero-payout";
  const observedAt = isoMinus(build.readAt, 8 * MINUTE);
  return scenarioFrame({
    build,
    scenarioKey,
    purpose: "a documented zero uniform rate is a valid zero-payout estimate",
    expectation: CURRENT,
    sourceRevision: courtyardSource({
      build,
      scenarioKey,
      frameTag: `r${build.frameIndex}`,
      observedAt,
      salePriceUsd: 15,
      buybackRatio: 0,
      oddsBuckets: [courtyardBucket("only", 100, 30, 30)],
    }),
    calculatedAt: build.readAt,
    product: buildProduct(build, {
      scenarioKey,
      providerKey: "courtyard",
      productKey: `courtyard:sim-${scenarioKey}`,
      name: "Zero Payout Listing",
      description: "a documented 0% uniform buyback rate",
      priceUsdCents: 1_500,
      buyback: { kind: "uniform_rate", rateBasisPoints: 0 },
      availability: "active",
      soldOutAt: null,
      sourceUpdatedAt: observedAt,
    }),
  });
}

/** No documented buyback: PackScout EV is unavailable, never assumed 100%. */
function courtyardNoBuyback(
  build: ScenarioBuildContext,
): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const scenarioKey = "courtyard-no-buyback";
  const observedAt = isoMinus(build.readAt, 9 * MINUTE);
  return scenarioFrame({
    build,
    scenarioKey,
    purpose: "no documented buyback program fails closed as unavailable",
    expectation: unavailable("BUYBACK_UNAVAILABLE"),
    sourceRevision: courtyardSource({
      build,
      scenarioKey,
      frameTag: `r${build.frameIndex}`,
      observedAt,
      salePriceUsd: 25,
      buybackRatio: null,
      oddsBuckets: [courtyardBucket("prize", 100, 40, 40)],
    }),
    calculatedAt: build.readAt,
    product: buildProduct(build, {
      scenarioKey,
      providerKey: "courtyard",
      productKey: `courtyard:sim-${scenarioKey}`,
      name: "No Buyback Listing",
      description: "discoverable listing without any documented buyback",
      priceUsdCents: 2_500,
      buyback: { kind: "not_documented" },
      availability: "active",
      soldOutAt: null,
      sourceUpdatedAt: observedAt,
    }),
  });
}

/** Same-revision published odds materially conflict with the atomic pool. */
function clutchpacksOddsConflict(
  build: ScenarioBuildContext,
): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const scenarioKey = "clutchpacks-odds-conflict";
  const observedAt = isoMinus(build.readAt, 10 * MINUTE);
  const siteRevisionId = sourceRevisionId(
    build,
    scenarioKey,
    `r${build.frameIndex}`,
  );
  const attestation = (bucketId: string) =>
    packScoutBuybackEvSimulationDigestV1("clutchpacks-attestation", {
      seedTag: build.seedTag,
      scenarioKey,
      bucketId,
    });
  const sourceRevision: PackScoutBuybackEvSimulatedSourceRevisionV1 = {
    providerKey: "clutchpacks",
    source: {
      packId: `sim-${scenarioKey}`,
      packRevisionId: `sim-${build.seedTag}-${scenarioKey}-product-1`,
      siteRevisionId,
      sourceManifestSha256: manifestSha(
        build,
        scenarioKey,
        `r${build.frameIndex}`,
      ),
      observedAt,
      packPriceText: "30.00",
      buckets: [
        {
          bucketId: "hit",
          name: "Simulated hit bucket",
          minPriceText: "50.00",
          maxPriceText: "70.00",
          buybackPercentText: "80",
          buybackEligible: true,
          memberCount: 5,
          homogeneityAttestationSha256: attestation("hit"),
          publishedPoolPercentText: "90",
        },
        {
          bucketId: "base",
          name: "Simulated base bucket",
          minPriceText: "5.00",
          maxPriceText: "9.00",
          buybackPercentText: "75",
          buybackEligible: true,
          memberCount: 5,
          homogeneityAttestationSha256: attestation("base"),
          publishedPoolPercentText: "10",
        },
      ],
      livePool: {
        poolRevisionId: siteRevisionId,
        snapshotKind: "atomic_revision",
        countsChangedDuringCollection: false,
        coversAllBuckets: true,
        remainingByBucket: [
          { bucketId: "hit", remaining: 50 },
          { bucketId: "base", remaining: 50 },
        ],
      },
      pullLedger: null,
      publishedOddsRoundingPercentDecimals: 2,
    },
  };
  return scenarioFrame({
    build,
    scenarioKey,
    purpose: "a material same-revision odds conflict fails closed",
    expectation: unavailable("ODDS_UNAVAILABLE"),
    sourceRevision,
    calculatedAt: build.readAt,
    product: buildProduct(build, {
      scenarioKey,
      providerKey: "clutchpacks",
      productKey: `clutchpacks:sim-${scenarioKey}`,
      name: "Conflicting Odds Pack",
      description: "published odds materially disagree with the verified pool",
      priceUsdCents: 3_000,
      buyback: { kind: "varies_by_outcome" },
      availability: "active",
      soldOutAt: null,
      sourceUpdatedAt: observedAt,
    }),
  });
}

/** A bucket without any stated value bound makes the estimate unavailable. */
function courtyardIncompleteValues(
  build: ScenarioBuildContext,
): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const scenarioKey = "courtyard-incomplete-values";
  const observedAt = isoMinus(build.readAt, 11 * MINUTE);
  return scenarioFrame({
    build,
    scenarioKey,
    purpose: "incomplete stated-value evidence fails closed",
    expectation: unavailable("VALUE_UNAVAILABLE"),
    sourceRevision: courtyardSource({
      build,
      scenarioKey,
      frameTag: `r${build.frameIndex}`,
      observedAt,
      salePriceUsd: 40,
      buybackRatio: 0.8,
      oddsBuckets: [
        courtyardBucket("known", 60, 20, 20),
        courtyardBucket("mystery", 40, null, null),
      ],
    }),
    calculatedAt: build.readAt,
    product: buildProduct(build, {
      scenarioKey,
      providerKey: "courtyard",
      productKey: `courtyard:sim-${scenarioKey}`,
      name: "Incomplete Evidence Listing",
      description: "one bucket publishes no value bounds",
      priceUsdCents: 4_000,
      buyback: { kind: "uniform_rate", rateBasisPoints: 8_000 },
      availability: "active",
      soldOutAt: null,
      sourceUpdatedAt: observedAt,
    }),
  });
}

function courtyardDelayed(
  build: ScenarioBuildContext,
  scenarioKey: Extract<
    PackScoutBuybackEvSimulationScenarioKeyV1,
    "courtyard-delayed-20m" | "courtyard-delayed-45m"
  >,
  delayMinutes: 20 | 45,
  limitation: PackScoutBuybackEvConfidenceLimitationCodeV1,
): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const observedAt = isoMinus(build.readAt, delayMinutes * MINUTE);
  return scenarioFrame({
    build,
    scenarioKey,
    purpose: `source evidence delayed by ${delayMinutes} minutes at its calculation clock`,
    expectation: {
      publicState: "current",
      publicReason: null,
      limitationCodes: ["platform_published_odds", limitation],
    },
    sourceRevision: courtyardSource({
      build,
      scenarioKey,
      frameTag: `r${build.frameIndex}`,
      observedAt,
      salePriceUsd: 40,
      buybackRatio: 0.85,
      oddsBuckets: [courtyardBucket("only", 100, 50, 50)],
    }),
    calculatedAt: build.readAt,
    product: buildProduct(build, {
      scenarioKey,
      providerKey: "courtyard",
      productKey: `courtyard:sim-${scenarioKey}`,
      name: `Delayed ${delayMinutes} Minute Listing`,
      description: `evidence observed ${delayMinutes} minutes before its calculation clock`,
      priceUsdCents: 4_000,
      buyback: { kind: "uniform_rate", rateBasisPoints: 8_500 },
      availability: "active",
      soldOutAt: null,
      sourceUpdatedAt: observedAt,
    }),
  });
}

/**
 * A sold-out product frozen as explicit history: the estimate that was
 * current at sellout keeps its original confidence forever. The work item's
 * calculation clock is pinned to the sellout instant, so every frame replays
 * the identical revision and the frame clock only advances around it.
 */
function troveSoldOutHistorical(
  build: ScenarioBuildContext,
): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const scenarioKey = "trove-sold-out-historical";
  const soldOutAt = build.controls.startAt;
  const observedAt = isoMinus(soldOutAt, 10 * MINUTE);
  const sourceRevision: PackScoutBuybackEvSimulatedSourceRevisionV1 = {
    providerKey: "trove",
    source: {
      packId: `sim-${scenarioKey}`,
      packRevisionId: `sim-${build.seedTag}-${scenarioKey}-product-1`,
      catalogRevisionId: sourceRevisionId(build, scenarioKey, "r0"),
      sourceManifestSha256: manifestSha(build, scenarioKey, "r0"),
      observedAt,
      priceUsd: 30,
      cardsPerPack: 1,
      valueBasis: "guaranteed_instant_payout",
      tiers: [
        { tierLabel: "hit", oddsPercent: 10, valueUsd: 100 },
        { tierLabel: "base", oddsPercent: 90, valueUsd: 20 },
      ],
    },
  };
  return scenarioFrame({
    build,
    scenarioKey,
    purpose: "a sold-out repack freezes its last valid estimate as history",
    expectation: {
      publicState: "sold_out_historical",
      publicReason: null,
      limitationCodes: ["platform_published_odds"],
    },
    sourceRevision,
    calculatedAt: soldOutAt,
    product: buildProduct(build, {
      scenarioKey,
      providerKey: "trove",
      productKey: `trove:sim-${scenarioKey}`,
      name: "Sold Out Instant Payout Pack",
      description: "sold out at the run start with a frozen historical estimate",
      priceUsdCents: 3_000,
      buyback: { kind: "fixed_or_final_payout" },
      availability: "sold_out",
      soldOutAt,
      sourceUpdatedAt: observedAt,
    }),
  });
}

/**
 * A fixed observation whose fingerprint never changes: later frames replay
 * `unchanged` while the advancing read clock alone carries the estimate
 * across the 60-minute boundary into the deterministic stale public state.
 */
function courtyardSourceAgeExpiry(
  build: ScenarioBuildContext,
): PackScoutBuybackEvSimulationScenarioFrameV1 {
  const scenarioKey = "courtyard-source-age-expiry";
  const observedAt = isoMinus(build.controls.startAt, 5 * MINUTE);
  const expiresAtMillis =
    Date.parse(observedAt) + FRESHNESS_WINDOW_MILLISECONDS;
  const stale = Date.parse(build.readAt) > expiresAtMillis;
  return scenarioFrame({
    build,
    scenarioKey,
    purpose:
      "advancing the calculation clock over a fixed observation expires the estimate without new evidence",
    expectation: stale
      ? unavailable("SOURCE_DATA_STALE")
      : CURRENT,
    sourceRevision: courtyardSource({
      build,
      scenarioKey,
      frameTag: "frozen",
      observedAt,
      salePriceUsd: 50,
      buybackRatio: 0.9,
      oddsBuckets: [courtyardBucket("only", 100, 70, 70)],
    }),
    calculatedAt: build.readAt,
    product: buildProduct(build, {
      scenarioKey,
      providerKey: "courtyard",
      productKey: `courtyard:sim-${scenarioKey}`,
      name: "Source Age Expiry Listing",
      description: "one frozen observation aging past the 60-minute window",
      priceUsdCents: 5_000,
      buyback: { kind: "uniform_rate", rateBasisPoints: 9_000 },
      availability: "active",
      soldOutAt: null,
      sourceUpdatedAt: observedAt,
    }),
  });
}

function buildCategory(build: ScenarioBuildContext): PublicCategory {
  return {
    publicCategoryId: build.categoryId,
    parentPublicCategoryId: null,
    categoryKey: "simulated-cards",
    name: "Simulated Cards",
    kind: "vertical",
    depth: 0,
    pathPublicCategoryIds: [build.categoryId],
    displayOrder: 0,
  };
}

function buildCollectible(build: ScenarioBuildContext): PublicCollectible {
  const name = "Simulated Chase Card #1";
  const publicCollectibleId = packScoutBuybackEvSimulatedUuidV1("collectible", {
    seedTag: build.seedTag,
    name,
  });
  return {
    publicCollectibleId,
    name,
    normalizedName: normalizePublicSearchText(name),
    aliases: [],
    normalizedAliases: [],
    collectibleType: "card",
    publicCategoryIds: [build.categoryId],
    year: 2024,
    brand: "Simulated",
    setOrSeries: "Simulation Set",
    cardNumber: "1",
    referenceNumber: null,
    subject: "Simulated Chase",
    grade: null,
    grader: null,
    primaryImage: {
      url: "https://simulated.invalid/chase-card.webp",
      alt: "Simulated chase card",
    },
    valuation: {
      displayMoney: usd(85_000),
      usdComparison: { status: "available", value: usd(85_000) },
      valuationType: "market_estimate",
      observedAt: build.controls.startAt,
    },
    searchText: buildPublicCollectibleSearchText({
      name,
      aliases: [],
      year: 2024,
      brand: "Simulated",
      setOrSeries: "Simulation Set",
      cardNumber: "1",
      referenceNumber: null,
      subject: "Simulated Chase",
      grade: null,
      grader: null,
    }),
    dataAsOf: build.controls.startAt,
  };
}

function buildChase(
  build: ScenarioBuildContext,
  publicRepackId: string,
  collectible: PublicCollectible,
): PublicRepackChase {
  return {
    publicRepackId,
    publicCollectibleId: collectible.publicCollectibleId,
    role: "top_chase",
    evidenceKinds: ["vendor_inventory", "vendor_odds"],
    probabilityBasisPoints: 50,
    collectible: {
      publicCollectibleId: collectible.publicCollectibleId,
      name: collectible.name,
      collectibleType: collectible.collectibleType,
      publicCategoryIds: collectible.publicCategoryIds,
      primaryImage: collectible.primaryImage,
      valuation: collectible.valuation,
    },
    matchConfidence: { scoreBasisPoints: 9_500, band: "high" },
    observedAt: build.controls.startAt,
    displayOrder: 0,
  };
}

/**
 * Builds one deterministic frame: bounded synthetic source revisions, their
 * normalized evidence, per-scenario recomputation commands, and the sanitized
 * canonical snapshot the release assembler reads at the frame clock.
 */
export function buildPackScoutBuybackEvSimulationFrameV1(
  controls: PackScoutBuybackEvSimulationControlsV1,
  frameIndex: number,
): PackScoutBuybackEvSimulationFrameV1 {
  const validated = validatePackScoutBuybackEvSimulationControlsV1(controls);
  assertPackScoutBuybackEvSimulationFrameIndexV1(frameIndex);
  const readAt = packScoutBuybackEvSimulationFrameClockV1(validated, frameIndex);
  const startAtMillis = parsePackScoutBuybackEvTimestampMillisV1(
    validated.startAt,
  )!;
  const seedTag = packScoutBuybackEvSimulationDigestV1("seed", {
    seed: validated.seed,
    scenarioVersion: validated.scenarioVersion,
  }).slice(0, 8);
  const parityApproval = {
    currency: "USDC",
    parityNumerator: 1 as const,
    parityDenominator: 1 as const,
    effectiveAt: new Date(
      startAtMillis - PARITY_WINDOW_BEFORE_MILLISECONDS,
    ).toISOString(),
    expiresAt: new Date(
      startAtMillis + PARITY_WINDOW_AFTER_MILLISECONDS,
    ).toISOString(),
    configurationRevision: `sim-${seedTag}-usdc-parity-1`,
  };
  const build: ScenarioBuildContext = {
    controls: validated,
    frameIndex,
    readAt,
    seedTag,
    organizationId: packScoutBuybackEvSimulatedUuidV1("organization", {
      seedTag,
    }),
    configurationRevisionId: packScoutBuybackEvSimulatedUuidV1(
      "configuration",
      { seedTag, scenarioVersion: validated.scenarioVersion },
    ),
    categoryId: packScoutBuybackEvSimulatedUuidV1("category", {
      seedTag,
      categoryKey: "simulated-cards",
    }),
    evidenceContext: (evaluatedAt: string) => ({
      evaluatedAt,
      stablecoinParityApprovals: [parityApproval],
    }),
  };
  const collectible = buildCollectible(build);
  const chase = buildChase(
    build,
    packScoutBuybackEvSimulatedUuidV1("repack", {
      seedTag,
      scenarioKey: "courtyard-uniform-price-shift",
    }),
    collectible,
  );
  const scenarios: readonly PackScoutBuybackEvSimulationScenarioFrameV1[] = [
    courtyardUniformPriceShift(build, chase),
    clutchpacksPoolPulls(build),
    gamestopFixedOffers(build),
    trovePerDrawFinalPayout(build),
    beezieUsdcParity(build),
    courtyardZeroPayout(build),
    courtyardNoBuyback(build),
    clutchpacksOddsConflict(build),
    courtyardIncompleteValues(build),
    courtyardDelayed(
      build,
      "courtyard-delayed-20m",
      20,
      "source_age_over_15_through_30_minutes",
    ),
    courtyardDelayed(
      build,
      "courtyard-delayed-45m",
      45,
      "source_age_over_30_through_60_minutes",
    ),
    troveSoldOutHistorical(build),
    courtyardSourceAgeExpiry(build),
  ];
  return {
    scenarioVersion: validated.scenarioVersion,
    simulationRunId: packScoutBuybackEvSimulationRunIdV1(validated),
    frameIndex,
    readAt,
    organizationId: build.organizationId,
    configurationRevisionId: build.configurationRevisionId,
    scenarios,
    snapshot: {
      organizationId: build.organizationId,
      products: scenarios.map(({ product }) => product),
      categories: [buildCategory(build)],
      collectibles: [collectible],
      chases: [chase],
    },
  };
}
