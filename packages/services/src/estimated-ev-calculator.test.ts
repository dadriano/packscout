import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculatePackScoutEstimatedEv,
  PACKSCOUT_ESTIMATED_EV_METHOD,
  PACKSCOUT_ESTIMATED_EV_METHOD_VERSION,
  PACKSCOUT_ESTIMATED_EV_PROBABILITY_TOLERANCE_RATIO,
  PACKSCOUT_ESTIMATED_EV_ROUNDING,
  PACKSCOUT_ESTIMATED_EV_UNAVAILABLE_REASON_ORDER,
  PackScoutEstimatedEvConfigurationError,
  type CalculatePackScoutEstimatedEvInput,
  type PackScoutEstimatedEvBucketInput,
  type PackScoutEstimatedEvUnavailableReason,
} from "./estimated-ev-calculator.ts";

const sourceAt = "2026-08-06T12:00:00.000Z";
const calculatedAt = "2026-08-06T12:05:00.000Z";

function bucket(
  overrides: Partial<PackScoutEstimatedEvBucketInput> = {},
): PackScoutEstimatedEvBucketInput {
  return {
    probability: 1,
    lowerValueMinor: 100,
    upperValueMinor: 100,
    sourceRevisionId: "bucket-revision-1",
    ...overrides,
  };
}

function validInput(
  overrides: Partial<CalculatePackScoutEstimatedEvInput> = {},
): CalculatePackScoutEstimatedEvInput {
  return {
    packPrice: {
      valueMinor: 1_000,
      currency: "USD",
      sourceRevisionId: "price-revision-1",
    },
    distributionCurrency: "USD",
    unitBasis: "per_pack",
    drawCount: 1,
    buckets: [bucket()],
    sourceAt,
    calculatedAt,
    currencyPolicy: { verifiedUsdStablecoins: [] },
    ...overrides,
  };
}

test("per-pack midpoint EV is deterministic and ignores draw count multiplication", () => {
  const input = validInput({
    drawCount: 4,
    buckets: [
      bucket({
        probability: 0.25,
        lowerValueMinor: 400,
        upperValueMinor: 800,
        sourceRevisionId: "bucket-revision-1",
      }),
      bucket({
        probability: 0.75,
        lowerValueMinor: 1_000,
        upperValueMinor: 1_400,
        sourceRevisionId: "bucket-revision-2",
      }),
    ],
  });
  const first = calculatePackScoutEstimatedEv(input);
  const second = calculatePackScoutEstimatedEv(input);
  assert.deepEqual(first, second);
  assert.equal(first.status, "estimated");
  if (first.status !== "estimated") assert.fail("Expected an estimate.");
  assert.deepEqual(
    {
      grossValueMinor: first.grossValueMinor,
      evPercent: first.evPercent,
      currency: first.currency,
      method: first.method,
      methodVersion: first.methodVersion,
      coveragePercent: first.coveragePercent,
      inputCount: first.inputCount,
      sourceAt: first.sourceAt,
      calculatedAt: first.calculatedAt,
      reasonCodes: first.reasonCodes,
    },
    {
      grossValueMinor: 1_050,
      evPercent: 105,
      currency: "USD",
      method: PACKSCOUT_ESTIMATED_EV_METHOD,
      methodVersion: PACKSCOUT_ESTIMATED_EV_METHOD_VERSION,
      coveragePercent: 100,
      inputCount: 2,
      sourceAt,
      calculatedAt,
      reasonCodes: [],
    },
  );
  assert.equal(first.evidence.appliedDrawMultiplier, 1);
  assert.deepEqual(first.evidence.sourceRevisionIds, [
    "price-revision-1",
    "bucket-revision-1",
    "bucket-revision-2",
  ]);
  assert.deepEqual(first.evidence.rounding, PACKSCOUT_ESTIMATED_EV_ROUNDING);
});

test("per-draw EV applies the positive draw count before comparing with pack price", () => {
  const result = calculatePackScoutEstimatedEv(
    validInput({
      packPrice: {
        valueMinor: 600,
        currency: "USD",
        sourceRevisionId: "price-revision-1",
      },
      unitBasis: "per_draw",
      drawCount: 3,
      buckets: [
        bucket({
          probability: 0.5,
          lowerValueMinor: 100,
          upperValueMinor: 300,
        }),
        bucket({
          probability: 0.5,
          lowerValueMinor: 300,
          upperValueMinor: 500,
          sourceRevisionId: "bucket-revision-2",
        }),
      ],
    }),
  );
  assert.equal(result.status, "estimated");
  if (result.status !== "estimated") assert.fail("Expected an estimate.");
  assert.equal(result.grossValueMinor, 900);
  assert.equal(result.evPercent, 150);
  assert.equal(result.evidence.unitBasis, "per_draw");
  assert.equal(result.evidence.appliedDrawMultiplier, 3);
});

test("rounding is aggregate half-up for money and half-up to two percent decimals", () => {
  const result = calculatePackScoutEstimatedEv(
    validInput({
      packPrice: {
        valueMinor: 300,
        currency: "USD",
        sourceRevisionId: "price-revision-1",
      },
      buckets: [bucket({ lowerValueMinor: 100, upperValueMinor: 101 })],
    }),
  );
  assert.equal(result.status, "estimated");
  if (result.status !== "estimated") assert.fail("Expected an estimate.");
  assert.equal(result.grossValueMinor, 101);
  assert.equal(result.evPercent, 33.67);
});

test("coverage tolerance is explicit and accepted distributions are not renormalized", () => {
  const withinTolerance = calculatePackScoutEstimatedEv(
    validInput({
      buckets: [
        bucket({
          probability: 0.5,
          lowerValueMinor: 0,
          upperValueMinor: 0,
        }),
        bucket({
          probability: 0.499_999_1,
          lowerValueMinor: 1_000_000,
          upperValueMinor: 1_000_000,
          sourceRevisionId: "bucket-revision-2",
        }),
      ],
    }),
  );
  assert.equal(
    PACKSCOUT_ESTIMATED_EV_PROBABILITY_TOLERANCE_RATIO,
    0.000_001,
  );
  assert.equal(withinTolerance.status, "estimated");
  if (withinTolerance.status !== "estimated") assert.fail("Expected an estimate.");
  assert.equal(withinTolerance.coveragePercent, 99.99991);
  assert.equal(withinTolerance.grossValueMinor, 499_999);

  const outsideTolerance = calculatePackScoutEstimatedEv(
    validInput({
      buckets: [
        bucket({ probability: 0.5 }),
        bucket({
          probability: 0.499_998,
          sourceRevisionId: "bucket-revision-2",
        }),
      ],
    }),
  );
  assert.equal(outsideTolerance.status, "unavailable");
  assert.deepEqual(outsideTolerance.reasonCodes, [
    "incomplete_probability_coverage",
  ]);
});

test("USD-stablecoin parity requires exact membership in the verified policy", () => {
  const verifiedCurrency = "stablecoin:verified-usd";
  const verified = calculatePackScoutEstimatedEv(
    validInput({
      packPrice: {
        valueMinor: 1_000,
        currency: verifiedCurrency,
        sourceRevisionId: "price-revision-1",
      },
      distributionCurrency: verifiedCurrency,
      currencyPolicy: { verifiedUsdStablecoins: [verifiedCurrency] },
    }),
  );
  assert.equal(verified.status, "estimated");
  assert.equal(verified.currency, "USD");
  assert.equal(
    verified.evidence.priceCurrencyTreatment,
    "verified_usd_stablecoin",
  );
  assert.deepEqual(verified.evidence.limitations, [
    "midpoint_value_ranges",
    "provider_supplied_probabilities",
    "verified_usd_stablecoin_at_parity",
  ]);

  for (const currency of ["stablecoin:unknown", "EUR", "usd"] as const) {
    const unavailable = calculatePackScoutEstimatedEv(
      validInput({
        distributionCurrency: currency,
        currencyPolicy: { verifiedUsdStablecoins: [verifiedCurrency] },
      }),
    );
    assert.equal(unavailable.status, "unavailable", currency);
    assert.deepEqual(unavailable.reasonCodes, ["unsupported_currency"], currency);
  }
});

interface ReasonCase {
  readonly name: string;
  readonly reason: PackScoutEstimatedEvUnavailableReason;
  readonly input: CalculatePackScoutEstimatedEvInput;
}

test("every insufficient-input condition returns one constrained unavailable reason", () => {
  const cases: readonly ReasonCase[] = [
    { name: "missing price", reason: "missing_pack_price", input: validInput({ packPrice: null }) },
    {
      name: "invalid price",
      reason: "invalid_pack_price",
      input: validInput({
        packPrice: { valueMinor: 0, currency: "USD", sourceRevisionId: "price-revision-1" },
      }),
    },
    {
      name: "unsupported currency",
      reason: "unsupported_currency",
      input: validInput({ distributionCurrency: "token:unknown" }),
    },
    {
      name: "missing buckets",
      reason: "missing_probability_buckets",
      input: validInput({ buckets: [] }),
    },
    {
      name: "missing probability",
      reason: "missing_probability",
      input: validInput({ buckets: [bucket({ probability: null })] }),
    },
    {
      name: "invalid probability",
      reason: "invalid_probability",
      input: validInput({ buckets: [bucket({ probability: Number.NaN })] }),
    },
    {
      name: "incomplete coverage",
      reason: "incomplete_probability_coverage",
      input: validInput({ buckets: [bucket({ probability: 0.5 })] }),
    },
    {
      name: "missing bound",
      reason: "missing_value_bound",
      input: validInput({ buckets: [bucket({ lowerValueMinor: undefined })] }),
    },
    {
      name: "open range",
      reason: "open_ended_value_range",
      input: validInput({ buckets: [bucket({ upperValueMinor: null })] }),
    },
    {
      name: "invalid bound",
      reason: "invalid_value_bound",
      input: validInput({ buckets: [bucket({ lowerValueMinor: -1 })] }),
    },
    {
      name: "inverted range",
      reason: "invalid_value_range",
      input: validInput({
        buckets: [bucket({ lowerValueMinor: 200, upperValueMinor: 100 })],
      }),
    },
    {
      name: "ambiguous basis",
      reason: "ambiguous_unit_basis",
      input: validInput({ unitBasis: "mixed" }),
    },
    {
      name: "invalid draw count",
      reason: "invalid_draw_count",
      input: validInput({ drawCount: 0 }),
    },
    {
      name: "missing revision",
      reason: "missing_source_evidence",
      input: validInput({ buckets: [bucket({ sourceRevisionId: null })] }),
    },
    {
      name: "missing source time",
      reason: "missing_source_time",
      input: validInput({ sourceAt: null }),
    },
    {
      name: "invalid source time",
      reason: "invalid_source_time",
      input: validInput({ sourceAt: "not-an-instant" }),
    },
    {
      name: "overflow",
      reason: "calculation_overflow",
      input: validInput({
        packPrice: { valueMinor: 1, currency: "USD", sourceRevisionId: "price-revision-1" },
        unitBasis: "per_draw",
        drawCount: 2,
        buckets: [
          bucket({
            lowerValueMinor: Number.MAX_SAFE_INTEGER,
            upperValueMinor: Number.MAX_SAFE_INTEGER,
          }),
        ],
      }),
    },
  ];
  const coveredReasons = new Set<PackScoutEstimatedEvUnavailableReason>();
  for (const scenario of cases) {
    const result = calculatePackScoutEstimatedEv(scenario.input);
    assert.equal(result.status, "unavailable", scenario.name);
    assert.equal(result.grossValueMinor, null, scenario.name);
    assert.equal(result.evPercent, null, scenario.name);
    assert.deepEqual(result.reasonCodes, [scenario.reason], scenario.name);
    coveredReasons.add(scenario.reason);
  }
  assert.deepEqual(
    [...coveredReasons],
    [...PACKSCOUT_ESTIMATED_EV_UNAVAILABLE_REASON_ORDER],
  );
});

test("multiple unavailable reasons retain one documented deterministic order", () => {
  const result = calculatePackScoutEstimatedEv(
    validInput({
      packPrice: null,
      distributionCurrency: "EUR",
      unitBasis: "ambiguous",
      drawCount: 0,
      buckets: [],
      sourceAt: null,
    }),
  );
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.reasonCodes, [
    "missing_pack_price",
    "unsupported_currency",
    "missing_probability_buckets",
    "ambiguous_unit_basis",
    "invalid_draw_count",
    "missing_source_time",
  ]);
});

test("the calculator is synchronous, provider-neutral, and never substitutes provider EV", () => {
  const providerReportedEv = Object.freeze({ valueMinor: 999_999, currency: "USD" });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("External valuation must not be called.");
  }) as typeof fetch;
  try {
    const beezieInput = {
      ...validInput(),
      platform: "beezie",
      providerReportedEv,
    };
    const troveInput = { ...beezieInput, platform: "trove" };
    const beezie = calculatePackScoutEstimatedEv(beezieInput);
    const trove = calculatePackScoutEstimatedEv(troveInput);
    assert.deepEqual(beezie, trove);
    assert.equal("then" in beezie, false);
    assert.equal(Object.hasOwn(beezie, "providerReportedEv"), false);
    assert.doesNotMatch(JSON.stringify(beezie), /exact/i);
    assert.deepEqual(providerReportedEv, { valueMinor: 999_999, currency: "USD" });
    assert.equal(fetchCalls, 0);

    const unavailable = calculatePackScoutEstimatedEv({
      ...beezieInput,
      buckets: [],
    });
    assert.equal(unavailable.status, "unavailable");
    assert.equal(Object.hasOwn(unavailable, "providerReportedEv"), false);
    assert.deepEqual(providerReportedEv, { valueMinor: 999_999, currency: "USD" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an invalid caller-supplied calculation timestamp fails as configuration", () => {
  assert.throws(
    () => calculatePackScoutEstimatedEv(validInput({ calculatedAt: "not-an-instant" })),
    (error) =>
      error instanceof PackScoutEstimatedEvConfigurationError &&
      error.code === "INVALID_CALCULATED_AT",
  );
});
