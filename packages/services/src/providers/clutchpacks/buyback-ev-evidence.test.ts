import assert from "node:assert/strict";
import { test } from "node:test";
import { packScoutBuybackEvInputV1Schema } from "@packscout/contracts";
import {
  BUYBACK_EV_FIXTURE_HOMOGENEITY_SHA256,
  BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
  BUYBACK_EV_FIXTURE_OBSERVED_AT,
  buildBuybackEvFixtureContext,
  expectBuybackEvCompleteV1,
  expectBuybackEvUnavailableV1,
} from "../buyback-ev-evidence.fixture.ts";
import {
  normalizeClutchpacksBuybackEvEvidenceV1,
  type ClutchpacksBuybackEvSourceV1,
} from "./buyback-ev-evidence.ts";

const context = buildBuybackEvFixtureContext();

type Bucket = ClutchpacksBuybackEvSourceV1["buckets"][number];

function bucket(overrides: Partial<Bucket> & Pick<Bucket, "bucketId">): Bucket {
  return {
    name: null,
    minPriceText: "20.00",
    maxPriceText: "80.00",
    buybackPercentText: "90",
    buybackEligible: true,
    memberCount: 60,
    homogeneityAttestationSha256: BUYBACK_EV_FIXTURE_HOMOGENEITY_SHA256,
    publishedPoolPercentText: "60",
    ...overrides,
  };
}

function baseSource(
  overrides: Partial<ClutchpacksBuybackEvSourceV1> = {},
): ClutchpacksBuybackEvSourceV1 {
  return {
    packId: "PACK-42",
    packRevisionId: "pack-rev-5",
    siteRevisionId: "site-rev-800",
    sourceManifestSha256: BUYBACK_EV_FIXTURE_MANIFEST_SHA256,
    observedAt: BUYBACK_EV_FIXTURE_OBSERVED_AT,
    packPriceText: "$149.99",
    buckets: [
      bucket({ bucketId: "common" }),
      bucket({
        bucketId: "rare",
        minPriceText: "100.00",
        maxPriceText: "400.00",
        buybackPercentText: "92.5",
        memberCount: 30,
        publishedPoolPercentText: "30",
      }),
      bucket({
        bucketId: "chase",
        minPriceText: "1,000.00",
        maxPriceText: "5,000.00",
        buybackPercentText: null,
        buybackEligible: false,
        memberCount: 10,
        publishedPoolPercentText: "10",
      }),
    ],
    livePool: {
      poolRevisionId: "site-rev-800",
      snapshotKind: "atomic_revision",
      countsChangedDuringCollection: false,
      coversAllBuckets: true,
      remainingByBucket: [
        { bucketId: "common", remaining: 60 },
        { bucketId: "rare", remaining: 30 },
        { bucketId: "chase", remaining: 10 },
      ],
    },
    pullLedger: null,
    publishedOddsRoundingPercentDecimals: 0,
    ...overrides,
  };
}

test("clutchpacks: a complete atomic pool takes priority over published odds", () => {
  const input = expectBuybackEvCompleteV1(
    normalizeClutchpacksBuybackEvEvidenceV1(baseSource(), context),
  );
  packScoutBuybackEvInputV1Schema.parse(input);
  assert.deepEqual(input.product, {
    productKey: "clutchpacks:pack-42",
    productRevisionId: "pack-rev-5",
  });
  assert.deepEqual(input.packPrice.canonicalUsdCents, {
    numerator: 14_999,
    denominator: 1,
  });
  assert.deepEqual(input.oddsEvidence, {
    sourceKind: "current_remaining_inventory",
    poolKind: "finite",
    currentPoolCompleteness: "complete",
    probabilityCoverage: "complete",
    publishedOddsComparison: {
      status: "within_tolerance",
      maximumAbsoluteDifferencePartsPerMillion: 0,
      documentedRoundingPrecisionPartsPerMillion: 10_000,
    },
  });
  assert.deepEqual(
    input.outcomes.map(({ outcomeKey, probability }) => ({
      outcomeKey,
      probability,
    })),
    [
      { outcomeKey: "chase", probability: { numerator: 1, denominator: 10 } },
      { outcomeKey: "common", probability: { numerator: 3, denominator: 5 } },
      { outcomeKey: "rare", probability: { numerator: 3, denominator: 10 } },
    ],
  );
  const chase = input.outcomes[0]!;
  // An explicitly ineligible bucket keeps its probability and pays zero.
  assert.deepEqual(chase.buyback, { eligibility: "ineligible", payout: null });
  const common = input.outcomes[1]!;
  assert.equal(common.buyback.eligibility, "eligible");
  assert.deepEqual(
    common.buyback.eligibility === "eligible" &&
      common.buyback.payout.kind === "outcome_specific_rate"
      ? common.buyback.payout.terms.rateBasisPoints
      : null,
    9_000,
  );
  assert.deepEqual(common.representation, {
    kind: "homogeneous_bucket",
    memberCount: { state: "known", value: 60 },
    eligibilityHomogeneity: "verified_same",
    payoutFunctionHomogeneity: "verified_same",
    homogeneityEvidenceSha256: BUYBACK_EV_FIXTURE_HOMOGENEITY_SHA256,
  });
  assert.equal(input.uniformBuybackRate, null);
});

test("clutchpacks: normalization is deterministic and order-independent", () => {
  const base = baseSource();
  const shuffled = baseSource({
    buckets: [...base.buckets].reverse(),
    livePool: {
      ...base.livePool!,
      remainingByBucket: [...base.livePool!.remainingByBucket].reverse(),
    },
  });
  assert.deepStrictEqual(
    normalizeClutchpacksBuybackEvEvidenceV1(shuffled, context),
    normalizeClutchpacksBuybackEvEvidenceV1(base, context),
  );
});

test("clutchpacks: rounded published odds agree within documented precision", () => {
  const source = baseSource({
    buckets: [
      bucket({ bucketId: "common", publishedPoolPercentText: "33" }),
      bucket({
        bucketId: "rare",
        memberCount: 30,
        publishedPoolPercentText: "33",
      }),
      bucket({
        bucketId: "chase",
        buybackEligible: false,
        buybackPercentText: null,
        memberCount: 10,
        publishedPoolPercentText: "34",
      }),
    ],
    livePool: {
      poolRevisionId: "site-rev-800",
      snapshotKind: "atomic_revision",
      countsChangedDuringCollection: false,
      coversAllBuckets: true,
      remainingByBucket: [
        { bucketId: "common", remaining: 333 },
        { bucketId: "rare", remaining: 333 },
        { bucketId: "chase", remaining: 334 },
      ],
    },
  });
  const input = expectBuybackEvCompleteV1(
    normalizeClutchpacksBuybackEvEvidenceV1(source, context),
  );
  assert.deepEqual(
    input.oddsEvidence.sourceKind === "current_remaining_inventory"
      ? input.oddsEvidence.publishedOddsComparison
      : null,
    {
      status: "within_tolerance",
      maximumAbsoluteDifferencePartsPerMillion: 6_000,
      documentedRoundingPrecisionPartsPerMillion: 10_000,
    },
  );
});

test("clutchpacks: a material odds conflict never picks the better source", () => {
  const source = baseSource({
    buckets: [
      bucket({ bucketId: "common", publishedPoolPercentText: "70" }),
      bucket({
        bucketId: "rare",
        memberCount: 30,
        publishedPoolPercentText: "20",
      }),
      bucket({
        bucketId: "chase",
        buybackEligible: false,
        buybackPercentText: null,
        memberCount: 10,
        publishedPoolPercentText: "10",
      }),
    ],
  });
  const outcome = expectBuybackEvUnavailableV1(
    normalizeClutchpacksBuybackEvEvidenceV1(source, context),
  );
  assert.deepEqual(outcome.internalReasons, ["ODDS_CONFLICT"]);
  assert.equal(outcome.publicPrimaryReason, "ODDS_UNAVAILABLE");
});

test("clutchpacks: a partial pool falls back to complete published odds", () => {
  const base = baseSource();
  const source = baseSource({
    livePool: {
      ...base.livePool!,
      coversAllBuckets: false,
      remainingByBucket: base.livePool!.remainingByBucket.slice(0, 2),
    },
  });
  const input = expectBuybackEvCompleteV1(
    normalizeClutchpacksBuybackEvEvidenceV1(source, context),
  );
  assert.deepEqual(input.oddsEvidence, {
    sourceKind: "platform_published",
    poolKind: "finite",
    currentPoolEvidence: "unavailable",
    probabilityCoverage: "complete",
  });
});

test("clutchpacks: assembled pages without revision proof are non-atomic", () => {
  const base = baseSource();
  for (const livePool of [
    { ...base.livePool!, snapshotKind: "assembled_pages" as const },
    { ...base.livePool!, poolRevisionId: "site-rev-799" },
    { ...base.livePool!, countsChangedDuringCollection: true },
  ]) {
    const outcome = expectBuybackEvUnavailableV1(
      normalizeClutchpacksBuybackEvEvidenceV1(baseSource({ livePool }), context),
    );
    assert.deepEqual(outcome.internalReasons, ["NON_ATOMIC_OBSERVATION"]);
    assert.equal(outcome.publicPrimaryReason, "SOURCE_EVIDENCE_UNAVAILABLE");
  }
});

test("clutchpacks: a sold-out pool has no derivable odds", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeClutchpacksBuybackEvEvidenceV1(
      baseSource({
        buckets: base.buckets.map((entry) => ({
          ...entry,
          publishedPoolPercentText: null,
        })),
        livePool: {
          ...base.livePool!,
          remainingByBucket: base.livePool!.remainingByBucket.map((row) => ({
            ...row,
            remaining: 0,
          })),
        },
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INCOMPLETE_PROBABILITIES"]);
  assert.equal(outcome.publicPrimaryReason, "ODDS_UNAVAILABLE");
});

test("clutchpacks: same-revision pulls deterministically deplete inventory", () => {
  const base = baseSource();
  const source = baseSource({
    buckets: base.buckets.map((entry) => ({
      ...entry,
      publishedPoolPercentText: null,
    })),
    pullLedger: [
      { bucketId: "common", pulls: 8, ledgerRevisionId: "site-rev-800" },
      { bucketId: "common", pulls: 2, ledgerRevisionId: "site-rev-800" },
      { bucketId: "chase", pulls: 5, ledgerRevisionId: "site-rev-800" },
    ],
  });
  const input = expectBuybackEvCompleteV1(
    normalizeClutchpacksBuybackEvEvidenceV1(source, context),
  );
  // Remaining 50/30/5 of 85 total.
  assert.deepEqual(
    input.outcomes.map(({ outcomeKey, probability }) => ({
      outcomeKey,
      probability,
    })),
    [
      { outcomeKey: "chase", probability: { numerator: 1, denominator: 17 } },
      { outcomeKey: "common", probability: { numerator: 10, denominator: 17 } },
      { outcomeKey: "rare", probability: { numerator: 6, denominator: 17 } },
    ],
  );
  assert.deepEqual(
    input.oddsEvidence.sourceKind === "current_remaining_inventory"
      ? input.oddsEvidence.publishedOddsComparison
      : null,
    { status: "not_available" },
  );
});

test("clutchpacks: pulls from another revision never update inventory", () => {
  const input = expectBuybackEvCompleteV1(
    normalizeClutchpacksBuybackEvEvidenceV1(
      baseSource({
        pullLedger: [
          { bucketId: "common", pulls: 10, ledgerRevisionId: "site-rev-799" },
        ],
      }),
      context,
    ),
  );
  assert.deepEqual(
    input.outcomes.map(({ probability }) => probability),
    [
      { numerator: 1, denominator: 10 },
      { numerator: 3, denominator: 5 },
      { numerator: 3, denominator: 10 },
    ],
  );
});

test("clutchpacks: an overdrawing pull ledger proves unstable counts", () => {
  const outcome = expectBuybackEvUnavailableV1(
    normalizeClutchpacksBuybackEvEvidenceV1(
      baseSource({
        pullLedger: [
          { bucketId: "chase", pulls: 11, ledgerRevisionId: "site-rev-800" },
        ],
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["NON_ATOMIC_OBSERVATION"]);
});

test("clutchpacks: a restock is a new evidence revision, not a merge", () => {
  const before = expectBuybackEvCompleteV1(
    normalizeClutchpacksBuybackEvEvidenceV1(baseSource(), context),
  );
  const base = baseSource();
  const after = expectBuybackEvCompleteV1(
    normalizeClutchpacksBuybackEvEvidenceV1(
      baseSource({
        siteRevisionId: "site-rev-801",
        buckets: base.buckets.map((entry) => ({
          ...entry,
          publishedPoolPercentText: null,
        })),
        livePool: {
          poolRevisionId: "site-rev-801",
          snapshotKind: "atomic_revision",
          countsChangedDuringCollection: false,
          coversAllBuckets: true,
          remainingByBucket: [
            { bucketId: "common", remaining: 80 },
            { bucketId: "rare", remaining: 40 },
            { bucketId: "chase", remaining: 20 },
          ],
        },
      }),
      context,
    ),
  );
  assert.notEqual(
    before.observation.sourceRevisionId,
    after.observation.sourceRevisionId,
  );
  assert.notDeepStrictEqual(
    before.outcomes.map(({ probability }) => probability),
    after.outcomes.map(({ probability }) => probability),
  );
});

test("clutchpacks: unknown bucket eligibility fails closed", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeClutchpacksBuybackEvEvidenceV1(
      baseSource({
        buckets: base.buckets.map((entry) =>
          entry.bucketId === "rare"
            ? { ...entry, buybackEligible: null }
            : entry,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["UNKNOWN_BUYBACK_ELIGIBILITY"]);
  assert.equal(outcome.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
});

test("clutchpacks: an eligible bucket without terms has no product fallback", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeClutchpacksBuybackEvEvidenceV1(
      baseSource({
        buckets: base.buckets.map((entry) =>
          entry.bucketId === "rare"
            ? { ...entry, buybackPercentText: null }
            : entry,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["MISSING_BUYBACK"]);
});

test("clutchpacks: a buyback rate above 100% is invalid terms", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeClutchpacksBuybackEvEvidenceV1(
      baseSource({
        buckets: base.buckets.map((entry) =>
          entry.bucketId === "rare"
            ? { ...entry, buybackPercentText: "105" }
            : entry,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_BUYBACK_TERMS"]);
});

test("clutchpacks: a negative stated value is an invalid range", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeClutchpacksBuybackEvEvidenceV1(
      baseSource({
        buckets: base.buckets.map((entry) =>
          entry.bucketId === "common"
            ? { ...entry, minPriceText: "-20.00" }
            : entry,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_VALUE_RANGE"]);
});

test("clutchpacks: an and-up bucket is an open-ended range", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeClutchpacksBuybackEvEvidenceV1(
      baseSource({
        buckets: base.buckets.map((entry) =>
          entry.bucketId === "chase"
            ? { ...entry, maxPriceText: null }
            : entry,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["INVALID_VALUE_RANGE"]);
});

test("clutchpacks: a bucket without a homogeneity attestation fails closed", () => {
  const base = baseSource();
  const outcome = expectBuybackEvUnavailableV1(
    normalizeClutchpacksBuybackEvEvidenceV1(
      baseSource({
        buckets: base.buckets.map((entry) =>
          entry.bucketId === "common"
            ? { ...entry, homogeneityAttestationSha256: null }
            : entry,
        ),
      }),
      context,
    ),
  );
  assert.deepEqual(outcome.internalReasons, ["HETEROGENEOUS_OUTCOME_BUCKET"]);
  assert.equal(outcome.publicPrimaryReason, "SOURCE_EVIDENCE_UNAVAILABLE");
});
