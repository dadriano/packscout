import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { packScoutBuybackEvInputV1Schema } from "@packscout/contracts";
import {
  PACKSCOUT_BUYBACK_EV_CAPABILITY_KEYS_V1,
  finalizePackScoutBuybackEvEvidenceV1,
  packScoutBuybackEvBasisPointsFromPercentV1,
  packScoutBuybackEvBasisPointsFromRatioNumberV1,
  packScoutBuybackEvCanonicalTimestampV1,
  packScoutBuybackEvMoneyClaimFromDecimalTextV1,
  packScoutBuybackEvOutcomeKeyFromLabelV1,
  packScoutBuybackEvProbabilityFromPercentTextV1,
  packScoutBuybackEvSanitizedIdentifierV1,
  type PackScoutBuybackEvEvidenceDraftV1,
  type PackScoutBuybackEvProviderCapabilityProfileV1,
} from "./buyback-ev-evidence.ts";
import {
  BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
  BUYBACK_EV_FIXTURE_OBSERVED_AT,
  buildBuybackEvFixtureContext,
  buybackEvEconomicProjectionV1,
  expectBuybackEvCompleteV1,
  expectBuybackEvUnavailableV1,
} from "./buyback-ev-evidence.fixture.ts";
import { BEEZIE_BUYBACK_EV_CAPABILITY_PROFILE_V1 } from "./beezie/buyback-ev-evidence.ts";
import { CLUTCHPACKS_BUYBACK_EV_CAPABILITY_PROFILE_V1 } from "./clutchpacks/buyback-ev-evidence.ts";
import { COLLECTOR_CRYPT_BUYBACK_EV_CAPABILITY_PROFILE_V1 } from "./collector-crypt/buyback-ev-evidence.ts";
import {
  COURTYARD_BUYBACK_EV_CAPABILITY_PROFILE_V1,
  normalizeCourtyardBuybackEvEvidenceV1,
} from "./courtyard/buyback-ev-evidence.ts";
import { GAMESTOP_BUYBACK_EV_CAPABILITY_PROFILE_V1 } from "./gamestop/buyback-ev-evidence.ts";
import {
  PHYGITALS_BUYBACK_EV_CAPABILITY_PROFILE_V1,
  normalizePhygitalsBuybackEvEvidenceV1,
} from "./phygitals/buyback-ev-evidence.ts";
import { STADIUM_VAULT_BUYBACK_EV_CAPABILITY_PROFILE_V1 } from "./stadium-vault/buyback-ev-evidence.ts";
import { TROVE_BUYBACK_EV_CAPABILITY_PROFILE_V1 } from "./trove/buyback-ev-evidence.ts";

const context = buildBuybackEvFixtureContext();

const LAUNCH_PROFILES: readonly PackScoutBuybackEvProviderCapabilityProfileV1[] =
  [
    BEEZIE_BUYBACK_EV_CAPABILITY_PROFILE_V1,
    CLUTCHPACKS_BUYBACK_EV_CAPABILITY_PROFILE_V1,
    COLLECTOR_CRYPT_BUYBACK_EV_CAPABILITY_PROFILE_V1,
    COURTYARD_BUYBACK_EV_CAPABILITY_PROFILE_V1,
    GAMESTOP_BUYBACK_EV_CAPABILITY_PROFILE_V1,
    PHYGITALS_BUYBACK_EV_CAPABILITY_PROFILE_V1,
    STADIUM_VAULT_BUYBACK_EV_CAPABILITY_PROFILE_V1,
    TROVE_BUYBACK_EV_CAPABILITY_PROFILE_V1,
  ];

const LAUNCH_PROVIDER_KEYS = [
  "beezie",
  "clutchpacks",
  "collector_crypt",
  "courtyard",
  "gamestop",
  "phygitals",
  "stadium_vault",
  "trove",
] as const;

test("every launch provider declares an explicit capability outcome for every required input", () => {
  assert.deepEqual(
    LAUNCH_PROFILES.map(({ providerKey }) => providerKey).sort(),
    [...LAUNCH_PROVIDER_KEYS],
  );
  for (const profile of LAUNCH_PROFILES) {
    for (const key of PACKSCOUT_BUYBACK_EV_CAPABILITY_KEYS_V1) {
      const support = profile.capabilities[key];
      assert.ok(
        support === "supported" || support === "unsupported",
        `${profile.providerKey} must classify ${key}`,
      );
    }
    assert.equal(
      Object.keys(profile.capabilities).length,
      PACKSCOUT_BUYBACK_EV_CAPABILITY_KEYS_V1.length,
      `${profile.providerKey} must not add unknown capability keys`,
    );
    assert.ok(
      [
        "complete_current_remaining_inventory",
        "complete_platform_published",
        "unavailable",
      ].includes(profile.oddsClassification),
    );
    assert.ok(
      ["stated_collectible_value", "final_guaranteed_payout"].includes(
        profile.sourceValueBasis,
      ),
    );
    assert.ok(Object.isFrozen(profile));
    assert.ok(Object.isFrozen(profile.capabilities));
  }
});

test("the shared evidence rulebook never branches on launch provider identity", () => {
  const sharedSource = readFileSync(
    fileURLToPath(new URL("./buyback-ev-evidence.ts", import.meta.url)),
    "utf8",
  ).toLowerCase();
  for (const providerKey of LAUNCH_PROVIDER_KEYS) {
    for (const variant of [
      providerKey,
      providerKey.replaceAll("_", "-"),
      providerKey.replaceAll("_", ""),
    ]) {
      assert.ok(
        !sharedSource.includes(variant),
        `shared rulebook must not mention ${variant}`,
      );
    }
  }
});

test("equivalent evidence from two providers normalizes to deep-equal economics", () => {
  const courtyard = expectBuybackEvCompleteV1(
    normalizeCourtyardBuybackEvEvidenceV1(
      {
        listingId: "Vault-Classic",
        productRevisionId: "listing-rev-1",
        catalogRevisionId: "cy-rev-1",
        sourceManifestSha256: BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
        observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
        salePriceUsd: 100,
        buybackRatio: 0.85,
        buybackScopeDocumented: true,
        oddsBuckets: [
          { tier: "Hit", oddsPercent: 20, minValueUsd: 250, maxValueUsd: 250 },
          { tier: "Base", oddsPercent: 80, minValueUsd: 62.5, maxValueUsd: 62.5 },
        ],
      },
      context,
    ),
  );
  const phygitals = expectBuybackEvCompleteV1(
    normalizePhygitalsBuybackEvEvidenceV1(
      {
        dropId: "vault-classic-drop",
        dropRevisionId: "drop-rev-1",
        marketplaceRevisionId: "ph-rev-1",
        sourceManifestSha256: BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
        observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
        priceUsd: 100,
        drawsPerPack: 1,
        buybackPercentRatio: 0.85,
        buybackDocumentedForAllRarities: true,
        rarities: [
          { rarity: "Hit", oddsPercent: 20, fairMarketValueUsd: 250 },
          { rarity: "Base", oddsPercent: 80, fairMarketValueUsd: 62.5 },
        ],
      },
      context,
    ),
  );
  assert.deepStrictEqual(
    buybackEvEconomicProjectionV1(courtyard),
    buybackEvEconomicProjectionV1(phygitals),
  );
  assert.equal(courtyard.observation.providerKey, "courtyard");
  assert.equal(phygitals.observation.providerKey, "phygitals");
  assert.notEqual(courtyard.product.productKey, phygitals.product.productKey);
  // A same-bound closed range and an exact value are the same semantic claim.
  assert.deepStrictEqual(courtyard.outcomes[0]!.statedValue, {
    kind: "exact",
    amount: {
      sourceAmount: { minorUnits: 6250, currency: "USD", precision: 2 },
      canonicalUsdCents: { numerator: 6250, denominator: 1 },
      normalization: { kind: "usd_direct" },
    },
  });
});

test("unavailable evidence carries bounded reasons and no raw source fields", () => {
  const unavailable = expectBuybackEvUnavailableV1(
    normalizeCourtyardBuybackEvEvidenceV1(
      {
        listingId: "vault-classic",
        productRevisionId: "listing-rev-1",
        catalogRevisionId: "cy-rev-1",
        sourceManifestSha256: BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
        observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
        salePriceUsd: 100,
        buybackRatio: null,
        buybackScopeDocumented: false,
        oddsBuckets: [
          { tier: "Base", oddsPercent: 100, minValueUsd: 10, maxValueUsd: 90 },
        ],
      },
      context,
    ),
  );
  assert.deepEqual(unavailable.internalReasons, ["MISSING_BUYBACK"]);
  assert.equal(unavailable.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
  const serialized = JSON.stringify(unavailable);
  for (const rawField of [
    "salePriceUsd",
    "buybackRatio",
    "oddsBuckets",
    "minValueUsd",
    "oddsPercent",
  ]) {
    assert.ok(
      !serialized.includes(rawField),
      `unavailable evidence must not expose ${rawField}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Shared parsing helpers
// ---------------------------------------------------------------------------

test("shared money and percent parsing is exact and fails closed", () => {
  assert.deepEqual(
    packScoutBuybackEvMoneyClaimFromDecimalTextV1("$1,234.56", "USD", 2),
    { minorUnits: 123456, currency: "USD", precision: 2 },
  );
  assert.equal(
    packScoutBuybackEvMoneyClaimFromDecimalTextV1("12.345", "USD", 2),
    null,
  );
  assert.equal(
    packScoutBuybackEvMoneyClaimFromDecimalTextV1("not-money", "USD", 2),
    null,
  );
  assert.equal(packScoutBuybackEvBasisPointsFromPercentV1(85), 8_500);
  assert.equal(packScoutBuybackEvBasisPointsFromPercentV1("92.5"), 9_250);
  assert.equal(packScoutBuybackEvBasisPointsFromPercentV1(33.333), null);
  assert.equal(packScoutBuybackEvBasisPointsFromRatioNumberV1(0.85), 8_500);
  assert.equal(packScoutBuybackEvBasisPointsFromRatioNumberV1(1.2), 12_000);
  assert.deepEqual(packScoutBuybackEvProbabilityFromPercentTextV1("33.4"), {
    numerator: 167,
    denominator: 500,
  });
  assert.equal(packScoutBuybackEvProbabilityFromPercentTextV1("-1"), null);
});

test("shared identifier, key, and timestamp helpers bound their outputs", () => {
  assert.equal(
    packScoutBuybackEvCanonicalTimestampV1("2026-08-19T17:55:00Z"),
    "2026-08-19T17:55:00.000Z",
  );
  assert.equal(packScoutBuybackEvCanonicalTimestampV1("yesterday"), null);
  assert.equal(packScoutBuybackEvSanitizedIdentifierV1("  Pack-42  "), "pack-42");
  assert.equal(packScoutBuybackEvSanitizedIdentifierV1("x".repeat(101)), null);
  assert.equal(packScoutBuybackEvSanitizedIdentifierV1("   "), null);
  const longKey = packScoutBuybackEvOutcomeKeyFromLabelV1(
    `Ultra ${"very ".repeat(60)}rare`,
    "fallback",
  );
  assert.ok(longKey.length <= 120);
  assert.equal(packScoutBuybackEvOutcomeKeyFromLabelV1("###", "fallback"), "fallback");
});

// ---------------------------------------------------------------------------
// Shared finalization edge cases exercised through a provider-neutral draft
// ---------------------------------------------------------------------------

function specDraft(
  overrides: Partial<PackScoutBuybackEvEvidenceDraftV1> = {},
): PackScoutBuybackEvEvidenceDraftV1 {
  return {
    observation: {
      providerKey: "spec-provider",
      sourceRevisionId: "spec-rev-1",
      sourceManifestSha256: BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
      observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
      coherence: { kind: "provider_revision" },
    },
    product: { productKey: "spec:pack-1", productRevisionId: "spec-rev-1" },
    packPrice: { minorUnits: 10_000, currency: "USD", precision: 2 },
    unitBasis: { kind: "per_pack" },
    odds: {
      poolKind: "finite",
      currentPool: null,
      published: {
        entries: [
          { outcomeKey: "base", probability: { numerator: 1, denominator: 1 } },
        ],
        documentedRoundingPrecisionPartsPerMillion: 100,
        revisionAgreement: "same_source_revision",
      },
    },
    uniformBuybackRate: {
      kind: "documented",
      scope: "every_eligible_outcome",
      terms: {
        rateBasisPoints: 8_500,
        percentageFeeBasisPoints: 0,
        fixedFee: null,
        floor: null,
        cap: null,
      },
    },
    outcomes: [
      {
        outcomeKey: "base",
        representation: { kind: "atomic_outcome" },
        valueBasis: "stated_collectible_value",
        statedValue: {
          kind: "exact",
          amount: { minorUnits: 10_000, currency: "USD", precision: 2 },
        },
        buyback: { kind: "defer_to_product_terms" },
      },
    ],
    ...overrides,
  };
}

test("the golden $100/85% draft finalizes into a valid calculator input", () => {
  const input = expectBuybackEvCompleteV1(
    finalizePackScoutBuybackEvEvidenceV1(specDraft(), context),
  );
  packScoutBuybackEvInputV1Schema.parse(input);
  assert.deepEqual(input.packPrice.canonicalUsdCents, {
    numerator: 10_000,
    denominator: 1,
  });
  assert.equal(input.uniformBuybackRate?.terms.rateBasisPoints, 8_500);
});

test("a mixed-currency closed range fails closed as mixed currency basis", () => {
  const outcome = expectBuybackEvUnavailableV1(
    finalizePackScoutBuybackEvEvidenceV1(
      specDraft({
        outcomes: [
          {
            outcomeKey: "base",
            representation: { kind: "atomic_outcome" },
            valueBasis: "stated_collectible_value",
            statedValue: {
              kind: "closed_range",
              lower: { minorUnits: 1_000, currency: "USD", precision: 2 },
              upper: { minorUnits: 2_000_000, currency: "USDC", precision: 6 },
            },
            buyback: { kind: "defer_to_product_terms" },
          },
        ],
      }),
      context,
    ),
  );
  assert.ok(outcome.internalReasons.includes("MIXED_CURRENCY_BASIS"));
  assert.equal(outcome.publicPrimaryReason, "CURRENCY_UNSUPPORTED");
});

test("an unknown pool kind and duplicate outcome keys fail closed", () => {
  const unknownPool = expectBuybackEvUnavailableV1(
    finalizePackScoutBuybackEvEvidenceV1(
      specDraft({ odds: { poolKind: "unknown" } }),
      context,
    ),
  );
  assert.ok(unknownPool.internalReasons.includes("INCOMPLETE_PROBABILITIES"));
  const base = specDraft();
  const duplicated = expectBuybackEvUnavailableV1(
    finalizePackScoutBuybackEvEvidenceV1(
      specDraft({ outcomes: [base.outcomes[0]!, base.outcomes[0]!] }),
      context,
    ),
  );
  assert.ok(
    duplicated.internalReasons.includes("HETEROGENEOUS_OUTCOME_BUCKET"),
  );
});

test("an empty outcome list reports missing probabilities and values", () => {
  const outcome = expectBuybackEvUnavailableV1(
    finalizePackScoutBuybackEvEvidenceV1(specDraft({ outcomes: [] }), context),
  );
  assert.deepEqual(outcome.internalReasons, [
    "INCOMPLETE_PROBABILITIES",
    "INCOMPLETE_VALUES",
  ]);
});

test("a zero pack price is an invalid price, never a free pack", () => {
  const outcome = expectBuybackEvUnavailableV1(
    finalizePackScoutBuybackEvEvidenceV1(
      specDraft({
        packPrice: { minorUnits: 0, currency: "USD", precision: 2 },
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_PRICE"]);
  assert.equal(outcome.publicPrimaryReason, "PRICE_UNAVAILABLE");
});

test("a final-payout value never receives a second buyback adjustment", () => {
  const rateOnFinalPayout = expectBuybackEvUnavailableV1(
    finalizePackScoutBuybackEvEvidenceV1(
      specDraft({
        uniformBuybackRate: { kind: "none_documented" },
        outcomes: [
          {
            outcomeKey: "base",
            representation: { kind: "atomic_outcome" },
            valueBasis: "final_guaranteed_payout",
            statedValue: {
              kind: "exact",
              amount: { minorUnits: 8_500, currency: "USD", precision: 2 },
            },
            buyback: {
              kind: "outcome_specific_rate",
              terms: {
                rateBasisPoints: 8_500,
                percentageFeeBasisPoints: 0,
                fixedFee: null,
                floor: null,
                cap: null,
              },
            },
          },
        ],
      }),
      context,
    ),
  );
  assert.ok(
    rateOnFinalPayout.internalReasons.includes("INVALID_BUYBACK_TERMS"),
  );
  const reflectedStatedValue = expectBuybackEvUnavailableV1(
    finalizePackScoutBuybackEvEvidenceV1(
      specDraft({
        uniformBuybackRate: { kind: "none_documented" },
        outcomes: [
          {
            outcomeKey: "base",
            representation: { kind: "atomic_outcome" },
            valueBasis: "stated_collectible_value",
            statedValue: {
              kind: "exact",
              amount: { minorUnits: 10_000, currency: "USD", precision: 2 },
            },
            buyback: { kind: "reflected_in_value" },
          },
        ],
      }),
      context,
    ),
  );
  assert.ok(
    reflectedStatedValue.internalReasons.includes("INVALID_BUYBACK_TERMS"),
  );
});

test("a non-canonical evaluation clock is a programmer error, not evidence", () => {
  assert.throws(
    () =>
      finalizePackScoutBuybackEvEvidenceV1(
        specDraft(),
        buildBuybackEvFixtureContext({ evaluatedAt: "2026-08-19T18:00:00Z" }),
      ),
    TypeError,
  );
});
