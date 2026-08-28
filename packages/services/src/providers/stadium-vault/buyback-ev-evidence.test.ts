import assert from "node:assert/strict";
import { test } from "node:test";
import { packScoutBuybackEvInputV1Schema } from "@packscout/contracts";
import {
  BUYBACK_EV_FIXTURE_GUARD_SHA256,
  BUYBACK_EV_FIXTURE_HOMOGENEITY_SHA256,
  BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
  BUYBACK_EV_FIXTURE_OBSERVED_AT,
  buildBuybackEvFixtureContext,
  expectBuybackEvCompleteV1,
  expectBuybackEvUnavailableV1,
} from "../buyback-ev-evidence.fixture.ts";
import {
  normalizeStadiumVaultBuybackEvEvidenceV1,
  type StadiumVaultBuybackEvSourceV1,
} from "./buyback-ev-evidence.ts";

const context = buildBuybackEvFixtureContext();

function baseSource(
  overrides: Partial<StadiumVaultBuybackEvSourceV1> = {},
): StadiumVaultBuybackEvSourceV1 {
  return {
    caseId: "Case-3",
    caseRevisionId: "case-rev-4",
    catalogEndpointRevisionId: "sv-rev-12",
    oddsEndpointRevisionId: "sv-rev-12",
    collectionGuardSha256: null,
    sourceManifestSha256: BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
    observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
    priceUsd: 199,
    instantSellPercent: 80,
    instantSellDocumentedForAllTiers: true,
    oddsTiers: [
      {
        tierLabel: "Jersey Bucket",
        oddsPercent: 20,
        minValueUsd: 100,
        maxValueUsd: 300,
        redemptionOnly: false,
        bucket: {
          memberCount: 40,
          homogeneity: "verified_same",
          attestationSha256: BUYBACK_EV_FIXTURE_HOMOGENEITY_SHA256,
        },
      },
      {
        tierLabel: "Autograph",
        oddsPercent: 5,
        minValueUsd: 500,
        maxValueUsd: 1_500,
        redemptionOnly: true,
        bucket: null,
      },
      {
        tierLabel: "Base Card",
        oddsPercent: 75,
        minValueUsd: 10,
        maxValueUsd: 40,
        redemptionOnly: false,
        bucket: null,
      },
    ],
    ...overrides,
  };
}

test("stadium vault: one provider revision across endpoints is coherent", () => {
  const input = expectBuybackEvCompleteV1(
    normalizeStadiumVaultBuybackEvEvidenceV1(baseSource(), context),
  );
  packScoutBuybackEvInputV1Schema.parse(input);
  assert.deepEqual(input.product, {
    productKey: "stadium-vault:case-3",
    productRevisionId: "case-rev-4",
  });
  assert.equal(input.observation.coherenceKind, "provider_revision");
  assert.equal(input.observation.sourceRevisionId, "sv-rev-12");
  const jersey = input.outcomes.find(
    ({ outcomeKey }) => outcomeKey === "jersey-bucket",
  )!;
  assert.deepEqual(jersey.representation, {
    kind: "homogeneous_bucket",
    memberCount: { state: "known", value: 40 },
    eligibilityHomogeneity: "verified_same",
    payoutFunctionHomogeneity: "verified_same",
    homogeneityEvidenceSha256: BUYBACK_EV_FIXTURE_HOMOGENEITY_SHA256,
  });
  const autograph = input.outcomes.find(
    ({ outcomeKey }) => outcomeKey === "autograph",
  )!;
  // Redemption-only outcomes stay in the distribution with zero payout.
  assert.deepEqual(autograph.buyback, {
    eligibility: "ineligible",
    payout: null,
  });
  assert.deepEqual(autograph.probability, { numerator: 1, denominator: 20 });
  assert.equal(input.uniformBuybackRate?.terms.rateBasisPoints, 8_000);
});

test("stadium vault: a guarded collection proves two-endpoint coherence", () => {
  const input = expectBuybackEvCompleteV1(
    normalizeStadiumVaultBuybackEvEvidenceV1(
      baseSource({
        oddsEndpointRevisionId: "sv-rev-13",
        collectionGuardSha256: BUYBACK_EV_FIXTURE_GUARD_SHA256,
      }),
      context,
    ),
  );
  assert.equal(input.observation.coherenceKind, "guarded_collection");
  assert.equal(input.observation.sourceRevisionId, "sv-rev-12@sv-rev-13");
  assert.equal(
    input.observation.coherenceKind === "guarded_collection"
      ? input.observation.collectionGuardSha256
      : null,
    BUYBACK_EV_FIXTURE_GUARD_SHA256,
  );
});

test("stadium vault: timestamp coincidence alone is a non-atomic observation", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeStadiumVaultBuybackEvEvidenceV1(
      baseSource({
        oddsEndpointRevisionId: "sv-rev-13",
        collectionGuardSha256: null,
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, [
    "MISSING_PROVENANCE",
    "NON_ATOMIC_OBSERVATION",
  ]);
  assert.equal(outcome.publicPrimaryReason, "SOURCE_EVIDENCE_UNAVAILABLE");
  assert.equal(outcome.observation, null);
});

test("stadium vault: a mixed-content bucket is heterogeneous and fails", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeStadiumVaultBuybackEvEvidenceV1(
      baseSource({
        oddsTiers: base.oddsTiers.map((tier) =>
          tier.tierLabel === "Jersey Bucket"
            ? {
                ...tier,
                bucket: {
                  memberCount: 40,
                  homogeneity: "mixed" as const,
                  attestationSha256: null,
                },
              }
            : tier,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["HETEROGENEOUS_OUTCOME_BUCKET"]);
  assert.equal(outcome.publicPrimaryReason, "SOURCE_EVIDENCE_UNAVAILABLE");
});

test("stadium vault: a tier without any value range is incomplete", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeStadiumVaultBuybackEvEvidenceV1(
      baseSource({
        oddsTiers: base.oddsTiers.map((tier) =>
          tier.tierLabel === "Base Card"
            ? { ...tier, minValueUsd: null, maxValueUsd: null }
            : tier,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INCOMPLETE_VALUES"]);
});

test("stadium vault: no documented instant-sell program has no EV", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeStadiumVaultBuybackEvEvidenceV1(
      baseSource({ instantSellPercent: null }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["MISSING_BUYBACK"]);
  assert.equal(outcome.product.state, "known");
});
