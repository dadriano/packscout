import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1,
  containsProtectedEvPublicationKeyV3,
  type PackScoutBuybackEvInputV1,
} from "@packscout/contracts";
import {
  assertPackScoutBuybackEvProjectionLeaksNoProtectedFieldV1,
  computePackScoutBuybackEvCalculationIdentityKeyV1,
  computePackScoutBuybackEvEffectiveFingerprintV1,
  computePackScoutBuybackEvFailureKeyV1,
  computePackScoutBuybackEvResultHashV1,
  sanitizePackScoutBuybackEvRevisionForPublicationV1,
  PackScoutBuybackEvRevisionProjectionError,
  type PackScoutBuybackEvCalculationIdentityV1,
  type PackScoutBuybackEvRevisionRecordV1,
} from "./buyback-adjusted-ev-revision-contracts.ts";
import { calculatePackScoutBuybackAdjustedEvV1 } from "./buyback-adjusted-ev-calculator.ts";
import {
  BUYBACK_EV_TEST_CALCULATED_AT,
  BUYBACK_EV_TEST_OBSERVED_AT,
  buildBuybackEvInput,
  buildOutcome,
  buildUsdEvidence,
} from "./buyback-adjusted-ev-calculator.test-support.ts";
import { evaluatePackScoutBuybackEvConfidenceV1 } from "./buyback-adjusted-ev-confidence.ts";

const CONFIGURATION_REVISION_ID = "40000000-0000-4000-8000-000000000003";

function identityFor(
  input: PackScoutBuybackEvInputV1,
): PackScoutBuybackEvCalculationIdentityV1 {
  return {
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    platformKey: input.observation.providerKey,
    productKey: input.product.productKey,
    productRevisionId: input.product.productRevisionId,
    sourceRevisionId: input.observation.sourceRevisionId,
    sourceManifestSha256: input.observation.sourceManifestSha256,
    observationCoherence: input.observation.coherenceKind,
    configurationRevisionId: CONFIGURATION_REVISION_ID,
  };
}

function fingerprintFor(input: PackScoutBuybackEvInputV1): string {
  return computePackScoutBuybackEvEffectiveFingerprintV1({
    identity: identityFor(input),
    evidence: { kind: "complete_input", input },
  });
}

function availableRecord(): PackScoutBuybackEvRevisionRecordV1 {
  return {
    revisionId: "40000000-0000-4000-8000-0000000000aa",
    organizationId: "40000000-0000-4000-8000-000000000001",
    providerId: "40000000-0000-4000-8000-000000000002",
    configurationRevisionId: CONFIGURATION_REVISION_ID,
    platformKey: "courtyard",
    productKey: "courtyard-ironman-repack",
    productRevisionId: "product-revision-42",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    lifecycle: "completed",
    status: "available",
    revisionNumber: 1,
    calculationKey: "a".repeat(64),
    effectiveFingerprint: "b".repeat(64),
    resultHash: "c".repeat(64),
    sourceRevisionId: "catalog-revision-100",
    sourceManifestSha256: "1".repeat(64),
    observationCoherence: "provider_revision",
    oddsSource: "current_remaining_inventory",
    usedClosedRangeMidpoint: false,
    calculatedAt: BUYBACK_EV_TEST_CALCULATED_AT,
    dataAsOf: { state: "known", observedAt: BUYBACK_EV_TEST_OBSERVED_AT },
    metrics: {
      packPriceMinorUnits: 10_000,
      underlyingOutcomeEvMinorUnits: 10_000,
      drawMultiplier: 1,
      grossEvMinorUnits: 8_500,
      grossReturnBasisPoints: 8_500,
      evDollarsMinorUnits: -1_500,
      evPercentBasisPoints: -1_500,
    },
    confidence: { scoreBasisPoints: 10_000, band: "high", limitationCodes: [] },
    freshness: {
      state: "current",
      sourceAgeMilliseconds: 5 * 60_000,
      expiresAt: "2026-08-19T19:00:00.000Z",
    },
    internalReasons: [],
    publicPrimaryReason: null,
    createdAt: BUYBACK_EV_TEST_CALCULATED_AT,
  };
}

function unavailableRecord(): PackScoutBuybackEvRevisionRecordV1 {
  return {
    ...availableRecord(),
    status: "unavailable",
    metrics: null,
    confidence: null,
    freshness: {
      state: "unknown_source_time",
      sourceAgeMilliseconds: null,
      expiresAt: null,
    },
    dataAsOf: { state: "unknown_source_time", observedAt: null },
    internalReasons: ["MISSING_SOURCE_TIME"],
    publicPrimaryReason: "SOURCE_EVIDENCE_UNAVAILABLE",
  };
}

function deepKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(deepKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    key,
    ...deepKeys(nested),
  ]);
}

test("the calculation identity key is deterministic and covers every identity component", () => {
  const identity = identityFor(buildBuybackEvInput());
  const permuted = JSON.parse(
    JSON.stringify(identity, Object.keys(identity).sort()),
  ) as PackScoutBuybackEvCalculationIdentityV1;
  assert.equal(
    computePackScoutBuybackEvCalculationIdentityKeyV1(identity),
    computePackScoutBuybackEvCalculationIdentityKeyV1(permuted),
  );
  const variants: readonly Partial<PackScoutBuybackEvCalculationIdentityV1>[] = [
    { platformKey: "beezie" },
    { productKey: "another-product" },
    { productRevisionId: "product-revision-43" },
    { sourceRevisionId: "catalog-revision-101" },
    { sourceManifestSha256: null },
    { observationCoherence: "guarded_collection" },
    { configurationRevisionId: "40000000-0000-4000-8000-000000000004" },
  ];
  const baseline = computePackScoutBuybackEvCalculationIdentityKeyV1(identity);
  for (const variant of variants) {
    assert.notEqual(
      computePackScoutBuybackEvCalculationIdentityKeyV1({
        ...identity,
        ...variant,
      }),
      baseline,
      JSON.stringify(variant),
    );
  }
});

test("the effective fingerprint is replay-stable and changes with every governing input", () => {
  const input = buildBuybackEvInput();
  const replayed = JSON.parse(JSON.stringify(input)) as PackScoutBuybackEvInputV1;
  assert.equal(fingerprintFor(input), fingerprintFor(replayed));

  const governingVariants: readonly [string, PackScoutBuybackEvInputV1][] = [
    ["price", buildBuybackEvInput({ packPrice: buildUsdEvidence(12_000) })],
    [
      "odds source",
      buildBuybackEvInput({
        oddsEvidence: {
          sourceKind: "platform_published",
          poolKind: "finite",
          currentPoolEvidence: "unavailable",
          probabilityCoverage: "complete",
        },
      }),
    ],
    [
      "stated value",
      buildBuybackEvInput({
        outcomes: [
          buildOutcome({
            statedValue: { kind: "exact", amount: buildUsdEvidence(9_000) },
          }),
        ],
      }),
    ],
    [
      "payout terms",
      buildBuybackEvInput({
        uniformBuybackRate: {
          scope: "every_eligible_outcome",
          terms: {
            rateBasisPoints: 9_000,
            percentageFeeBasisPoints: 0,
            fixedFee: buildUsdEvidence(0),
            floor: null,
            cap: null,
          },
        },
      }),
    ],
    [
      "eligibility",
      buildBuybackEvInput({
        uniformBuybackRate: null,
        outcomes: [
          buildOutcome({
            buyback: { eligibility: "ineligible", payout: null },
          }),
        ],
      }),
    ],
    [
      "draw semantics",
      buildBuybackEvInput({ unitBasis: { kind: "per_draw", drawCount: 5 } }),
    ],
    [
      "observation freshness",
      buildBuybackEvInput({
        observation: {
          ...buildBuybackEvInput().observation,
          observedAt: "2026-08-19T17:00:00.000Z",
        },
      }),
    ],
  ];
  const baseline = fingerprintFor(input);
  for (const [label, variant] of governingVariants) {
    assert.notEqual(fingerprintFor(variant), baseline, label);
  }

  const identity = identityFor(input);
  assert.notEqual(
    computePackScoutBuybackEvEffectiveFingerprintV1({
      identity: {
        ...identity,
        configurationRevisionId: "40000000-0000-4000-8000-000000000004",
      },
      evidence: { kind: "complete_input", input },
    }),
    baseline,
    "approved configuration",
  );

  const unavailableEvidence = computePackScoutBuybackEvEffectiveFingerprintV1({
    identity,
    evidence: {
      kind: "unavailable_evidence",
      dataAsOf: { state: "known", observedAt: BUYBACK_EV_TEST_OBSERVED_AT },
      internalReasons: ["MISSING_BUYBACK"],
    },
  });
  assert.notEqual(unavailableEvidence, baseline);
  assert.equal(
    unavailableEvidence,
    computePackScoutBuybackEvEffectiveFingerprintV1({
      identity,
      evidence: {
        kind: "unavailable_evidence",
        dataAsOf: { state: "known", observedAt: BUYBACK_EV_TEST_OBSERVED_AT },
        internalReasons: ["MISSING_BUYBACK"],
      },
    }),
  );
});

test("the result hash pins the exact calculation and confidence evaluation outputs", () => {
  const input = buildBuybackEvInput();
  const calculation = calculatePackScoutBuybackAdjustedEvV1({
    input,
    calculatedAt: BUYBACK_EV_TEST_CALCULATED_AT,
  });
  assert.equal(calculation.status, "available");
  const evaluation = evaluatePackScoutBuybackEvConfidenceV1(
    calculation.confidenceInput,
  );
  const baseline = computePackScoutBuybackEvResultHashV1({
    calculation,
    confidenceEvaluation: evaluation,
  });
  assert.equal(
    baseline,
    computePackScoutBuybackEvResultHashV1({
      calculation: JSON.parse(JSON.stringify(calculation)),
      confidenceEvaluation: JSON.parse(JSON.stringify(evaluation)),
    }),
  );
  const laterCalculation = calculatePackScoutBuybackAdjustedEvV1({
    input,
    calculatedAt: "2026-08-19T18:06:00.000Z",
  });
  assert.notEqual(
    computePackScoutBuybackEvResultHashV1({
      calculation: laterCalculation,
      confidenceEvaluation: evaluation,
    }),
    baseline,
  );
  assert.notEqual(
    computePackScoutBuybackEvResultHashV1({
      calculation,
      confidenceEvaluation: null,
    }),
    baseline,
  );
});

test("failure keys dedupe by fingerprint and bounded reason", () => {
  const first = computePackScoutBuybackEvFailureKeyV1({
    effectiveFingerprint: "b".repeat(64),
    reasonCode: "UNBINDABLE_RESULT",
  });
  assert.equal(
    first,
    computePackScoutBuybackEvFailureKeyV1({
      effectiveFingerprint: "b".repeat(64),
      reasonCode: "UNBINDABLE_RESULT",
    }),
  );
  assert.notEqual(
    first,
    computePackScoutBuybackEvFailureKeyV1({
      effectiveFingerprint: "b".repeat(64),
      reasonCode: "IDENTITY_REUSE_CONFLICT",
    }),
  );
});

test("the sanitized publication projection exposes only the public allowlist", () => {
  const projection = sanitizePackScoutBuybackEvRevisionForPublicationV1(
    availableRecord(),
  );
  assert.equal(projection.status, "available");
  assert.deepEqual(projection.metrics, {
    grossEvMoney: { minorUnits: 8_500, currency: "USD" },
    grossReturnBasisPoints: 8_500,
    evDollars: { minorUnits: -1_500, currency: "USD" },
    evPercentBasisPoints: -1_500,
  });
  assert.equal(containsProtectedEvPublicationKeyV3(projection), false);
  const protectedLeafKeys = new Set(
    PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1.flatMap((path) =>
      path.split("."),
    ),
  );
  const forbiddenIdentifierKeys = [
    "organizationId",
    "providerId",
    "platformKey",
    "productKey",
    "productRevisionId",
    "sourceRevisionId",
    "sourceManifestSha256",
    "calculationKey",
    "effectiveFingerprint",
    "resultHash",
    "rawPayload",
    "credential",
  ];
  for (const key of deepKeys(projection)) {
    assert.equal(protectedLeafKeys.has(key), false, key);
    assert.equal(forbiddenIdentifierKeys.includes(key), false, key);
  }
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /courtyard|product-revision|catalog-revision/);

  const unavailable = sanitizePackScoutBuybackEvRevisionForPublicationV1(
    unavailableRecord(),
  );
  assert.equal(unavailable.status, "unavailable");
  assert.equal(
    unavailable.status === "unavailable" ? unavailable.publicReason : null,
    "SOURCE_EVIDENCE_UNAVAILABLE",
  );
  assert.equal(unavailable.metrics, null);
  assert.equal(containsProtectedEvPublicationKeyV3(unavailable), false);
  for (const key of deepKeys(unavailable)) {
    assert.equal(protectedLeafKeys.has(key), false, key);
  }
});

test("corrupted stored metrics or confidence fail projection validation", () => {
  const corruptArithmetic = availableRecord();
  assert.throws(
    () =>
      sanitizePackScoutBuybackEvRevisionForPublicationV1({
        ...corruptArithmetic,
        metrics: {
          ...corruptArithmetic.metrics!,
          grossEvMinorUnits: 8_501,
        },
      }),
    (error: unknown) =>
      error instanceof PackScoutBuybackEvRevisionProjectionError &&
      error.code === "ROW_INVALID",
  );
  assert.throws(
    () =>
      sanitizePackScoutBuybackEvRevisionForPublicationV1({
        ...availableRecord(),
        confidence: {
          scoreBasisPoints: 9_999,
          band: "high",
          limitationCodes: [],
        },
      }),
    (error: unknown) =>
      error instanceof PackScoutBuybackEvRevisionProjectionError &&
      error.code === "ROW_INVALID",
  );
  assert.throws(
    () =>
      sanitizePackScoutBuybackEvRevisionForPublicationV1({
        ...unavailableRecord(),
        publicPrimaryReason: null,
      }),
    (error: unknown) =>
      error instanceof PackScoutBuybackEvRevisionProjectionError &&
      error.code === "ROW_INVALID",
  );
});

test("a projection carrying any protected spelling fails closed as PROTECTED_FIELD_LEAKED", () => {
  const sanitized = sanitizePackScoutBuybackEvRevisionForPublicationV1(
    availableRecord(),
  );
  assert.doesNotThrow(() =>
    assertPackScoutBuybackEvProjectionLeaksNoProtectedFieldV1(sanitized),
  );
  assert.equal(sanitized.status, "available");
  if (sanitized.status !== "available") return;
  // Drifted projections that re-expose the protected value under the
  // task-001 spelling or either revision-layer spelling must fail closed.
  const driftedProjections: readonly Record<string, unknown>[] = [
    {
      ...sanitized,
      metrics: { ...sanitized.metrics, underlyingOutcomeEvMinorUnits: 10_000 },
    },
    { ...sanitized, metrics: { ...sanitized.metrics, drawMultiplier: 1 } },
    {
      ...sanitized,
      metrics: {
        ...sanitized.metrics,
        underlyingOutcomeEvMoney: { minorUnits: 10_000, currency: "USD" },
      },
    },
    { ...sanitized, protectedEvidence: { payoutFormula: "leak" } },
  ];
  for (const drifted of driftedProjections) {
    assert.throws(
      () =>
        assertPackScoutBuybackEvProjectionLeaksNoProtectedFieldV1(
          drifted as Parameters<
            typeof assertPackScoutBuybackEvProjectionLeaksNoProtectedFieldV1
          >[0],
        ),
      (error: unknown) =>
        error instanceof PackScoutBuybackEvRevisionProjectionError &&
        error.code === "PROTECTED_FIELD_LEAKED",
      JSON.stringify(Object.keys(drifted)),
    );
  }
});
