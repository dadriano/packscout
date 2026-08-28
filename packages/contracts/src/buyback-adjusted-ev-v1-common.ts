import { z } from "zod";

export const PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION =
  "packscout_buyback_ev_v1" as const;
export const PACKSCOUT_BUYBACK_EV_METHOD_VERSION =
  "packscout-buyback-adjusted-ev-v1" as const;
export const PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION =
  "packscout-buyback-adjusted-ev-confidence-v1" as const;
export const PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY =
  "protected_internal" as const;

export const PACKSCOUT_BUYBACK_EV_MAX_OUTCOMES = 2_000 as const;
export const PACKSCOUT_BUYBACK_EV_MAX_DRAW_COUNT = 100 as const;
export const PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_DENOMINATOR =
  1_000_000_000 as const;
export const PACKSCOUT_BUYBACK_EV_PROBABILITY_TOLERANCE_DENOMINATOR =
  1_000_000 as const;
export const PACKSCOUT_BUYBACK_EV_MAX_CANONICAL_USD_CENTS =
  1_000_000_000_000 as const;
export const PACKSCOUT_BUYBACK_EV_MAX_SOURCE_PRECISION = 6 as const;

export const PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1 = Object.freeze([
  "rated_offer",
  "percentage_fee",
  "fixed_fee",
  "zero_clamp",
  "floor",
  "cap",
] as const);

export const PACKSCOUT_BUYBACK_EV_FORMULAS_V1 = Object.freeze({
  underlyingOutcomeEv:
    "sum(probability * supported_stated_value) * draw_multiplier",
  grossEv:
    "sum(probability * final_guaranteed_buyback_payout) * draw_multiplier",
  grossReturnBasisPoints:
    "round_half_up(gross_ev_usd_cents / pack_price_usd_cents * 10000)",
  evDollars: "gross_ev_usd_cents - pack_price_usd_cents",
  evPercentBasisPoints: "gross_return_basis_points - 10000",
} as const);

const safeIntegerSchema = z.number().int().safe();
const nonNegativeSafeIntegerSchema = safeIntegerSchema.min(0);
const positiveSafeIntegerSchema = safeIntegerSchema.positive();

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let currentLeft = left < 0n ? -left : left;
  let currentRight = right < 0n ? -right : right;
  while (currentRight !== 0n) {
    const remainder = currentLeft % currentRight;
    currentLeft = currentRight;
    currentRight = remainder;
  }
  return currentLeft;
}

export interface PackScoutBuybackEvRationalV1 {
  readonly numerator: number;
  readonly denominator: number;
}

export function isReducedPackScoutBuybackEvRationalV1(
  value: PackScoutBuybackEvRationalV1,
): boolean {
  return greatestCommonDivisor(
    BigInt(value.numerator),
    BigInt(value.denominator),
  ) === 1n;
}

export const packScoutBuybackEvRationalV1Schema = z
  .object({
    numerator: nonNegativeSafeIntegerSchema.max(
      PACKSCOUT_BUYBACK_EV_MAX_CANONICAL_USD_CENTS,
    ),
    denominator: positiveSafeIntegerSchema.max(
      PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_DENOMINATOR,
    ),
  })
  .strict()
  .refine(isReducedPackScoutBuybackEvRationalV1, {
    path: ["denominator"],
    message: "packscout_buyback_ev.rational_not_reduced",
  });

export const packScoutBuybackEvProbabilityV1Schema = z
  .object({
    numerator: nonNegativeSafeIntegerSchema,
    denominator: positiveSafeIntegerSchema.max(
      PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_DENOMINATOR,
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.numerator > value.denominator) {
      context.addIssue({
        code: "custom",
        path: ["numerator"],
        message: "packscout_buyback_ev.probability_above_one",
      });
    }
    if (!isReducedPackScoutBuybackEvRationalV1(value)) {
      context.addIssue({
        code: "custom",
        path: ["denominator"],
        message: "packscout_buyback_ev.probability_not_reduced",
      });
    }
  });

export function parsePackScoutBuybackEvTimestampMillisV1(
  value: string,
): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

export const packScoutBuybackEvTimestampV1Schema = z
  .string()
  .refine(
    (value) => parsePackScoutBuybackEvTimestampMillisV1(value) !== null,
    { message: "packscout_buyback_ev.timestamp_not_canonical" },
  );

export const packScoutBuybackEvSchemaVersionV1Schema = z.literal(
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
);
export const packScoutBuybackEvMethodVersionV1Schema = z.literal(
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
);
export const packScoutBuybackEvConfidencePolicyVersionV1Schema = z.literal(
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
);

export const packScoutBuybackEvProviderKeyV1Schema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u);
export const packScoutBuybackEvSourceRevisionV1Schema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:@/-]{0,126}[A-Za-z0-9])?$/u);
export const packScoutBuybackEvOutcomeKeyV1Schema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/u);
export const packScoutBuybackEvProductKeyV1Schema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/u);
export const packScoutBuybackEvSha256V1Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u);

export function isStrictlyCodeUnitSortedUnique(
  values: readonly string[],
): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1]! < value,
  );
}

export const packScoutBuybackEvSourceAmountV1Schema = z
  .object({
    minorUnits: nonNegativeSafeIntegerSchema,
    currency: z.string().regex(/^[A-Z0-9]{2,12}$/u),
    precision: z
      .number()
      .int()
      .min(0)
      .max(PACKSCOUT_BUYBACK_EV_MAX_SOURCE_PRECISION),
  })
  .strict();

export const packScoutBuybackEvStablecoinParityApprovalV1Schema = z
  .object({
    currency: z.string().regex(/^[A-Z0-9]{2,12}$/u),
    parityNumerator: z.literal(1),
    parityDenominator: z.literal(1),
    effectiveAt: packScoutBuybackEvTimestampV1Schema,
    expiresAt: packScoutBuybackEvTimestampV1Schema,
    configurationRevision: packScoutBuybackEvSourceRevisionV1Schema,
  })
  .strict()
  .refine(
    ({ effectiveAt, expiresAt }) =>
      Date.parse(effectiveAt) < Date.parse(expiresAt),
    {
      path: ["expiresAt"],
      message: "packscout_buyback_ev.parity_window_invalid",
    },
  );

export const packScoutBuybackEvMoneyNormalizationV1Schema =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("usd_direct") }).strict(),
    z
      .object({
        kind: z.literal("usd_equivalent_stablecoin"),
        parity: packScoutBuybackEvStablecoinParityApprovalV1Schema,
      })
      .strict(),
  ]);

function expectedCanonicalUsdCents(
  sourceAmount: z.infer<typeof packScoutBuybackEvSourceAmountV1Schema>,
): PackScoutBuybackEvRationalV1 | null {
  const rawNumerator = BigInt(sourceAmount.minorUnits) * 100n;
  const rawDenominator = 10n ** BigInt(sourceAmount.precision);
  const divisor = greatestCommonDivisor(rawNumerator, rawDenominator);
  const numerator = rawNumerator / divisor;
  const denominator = rawDenominator / divisor;
  if (
    numerator > BigInt(PACKSCOUT_BUYBACK_EV_MAX_CANONICAL_USD_CENTS) ||
    denominator > BigInt(PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_DENOMINATOR)
  ) {
    return null;
  }
  return { numerator: Number(numerator), denominator: Number(denominator) };
}

export const packScoutBuybackEvMoneyEvidenceV1Schema = z
  .object({
    sourceAmount: packScoutBuybackEvSourceAmountV1Schema,
    canonicalUsdCents: packScoutBuybackEvRationalV1Schema,
    normalization: packScoutBuybackEvMoneyNormalizationV1Schema,
  })
  .strict()
  .superRefine((money, context) => {
    const expected = expectedCanonicalUsdCents(money.sourceAmount);
    if (
      expected === null ||
      expected.numerator !== money.canonicalUsdCents.numerator ||
      expected.denominator !== money.canonicalUsdCents.denominator
    ) {
      context.addIssue({
        code: "custom",
        path: ["canonicalUsdCents"],
        message: "packscout_buyback_ev.currency_normalization_mismatch",
      });
    }
    if (
      money.normalization.kind === "usd_direct" &&
      (money.sourceAmount.currency !== "USD" ||
        money.sourceAmount.precision !== 2)
    ) {
      context.addIssue({
        code: "custom",
        path: ["normalization"],
        message: "packscout_buyback_ev.usd_direct_invalid",
      });
    }
    if (
      money.normalization.kind === "usd_equivalent_stablecoin" &&
      (money.sourceAmount.currency === "USD" ||
        money.normalization.parity.currency !== money.sourceAmount.currency)
    ) {
      context.addIssue({
        code: "custom",
        path: ["normalization", "parity", "currency"],
        message: "packscout_buyback_ev.stablecoin_parity_mismatch",
      });
    }
  });

export const packScoutBuybackEvCanonicalUsdMoneyV1Schema = z
  .object({
    minorUnits: nonNegativeSafeIntegerSchema.max(
      PACKSCOUT_BUYBACK_EV_MAX_CANONICAL_USD_CENTS,
    ),
    currency: z.literal("USD"),
  })
  .strict();

export const packScoutBuybackEvSignedCanonicalUsdMoneyV1Schema = z
  .object({
    minorUnits: safeIntegerSchema
      .min(-PACKSCOUT_BUYBACK_EV_MAX_CANONICAL_USD_CENTS)
      .max(PACKSCOUT_BUYBACK_EV_MAX_CANONICAL_USD_CENTS),
    currency: z.literal("USD"),
  })
  .strict();

export const PACKSCOUT_BUYBACK_EV_INTERNAL_REASON_CODES_V1 = Object.freeze([
  "MISSING_PROVENANCE",
  "MISSING_PRODUCT_IDENTITY",
  "MISSING_SOURCE_TIME",
  "NON_ATOMIC_OBSERVATION",
  "INVALID_PRICE",
  "UNSUPPORTED_CURRENCY",
  "UNSUPPORTED_MONEY_PRECISION",
  "EXPIRED_PARITY_APPROVAL",
  "MIXED_CURRENCY_BASIS",
  "AMBIGUOUS_DRAW_SEMANTICS",
  "INCOMPLETE_PROBABILITIES",
  "ODDS_CONFLICT",
  "INCOMPLETE_VALUES",
  "INVALID_VALUE_RANGE",
  "UNKNOWN_BUYBACK_ELIGIBILITY",
  "MISSING_BUYBACK",
  "INVALID_BUYBACK_TERMS",
  "CONDITIONAL_BUYBACK_TERMS",
  "HETEROGENEOUS_OUTCOME_BUCKET",
  "STALE_EVIDENCE",
  "ARITHMETIC_OVERFLOW",
] as const);

export type PackScoutBuybackEvInternalReasonCodeV1 =
  (typeof PACKSCOUT_BUYBACK_EV_INTERNAL_REASON_CODES_V1)[number];

export const packScoutBuybackEvInternalReasonCodeV1Schema = z.enum(
  PACKSCOUT_BUYBACK_EV_INTERNAL_REASON_CODES_V1,
);

const internalReasonOrder = new Map<PackScoutBuybackEvInternalReasonCodeV1, number>(
  PACKSCOUT_BUYBACK_EV_INTERNAL_REASON_CODES_V1.map((reason, index) => [
    reason,
    index,
  ]),
);

export function canonicalizePackScoutBuybackEvInternalReasonsV1(
  reasons: readonly PackScoutBuybackEvInternalReasonCodeV1[],
): readonly PackScoutBuybackEvInternalReasonCodeV1[] {
  return Object.freeze(
    [...new Set(reasons)].sort(
      (left, right) => internalReasonOrder.get(left)! - internalReasonOrder.get(right)!,
    ),
  );
}

export const packScoutBuybackEvInternalReasonsV1Schema = z
  .array(packScoutBuybackEvInternalReasonCodeV1Schema)
  .min(1)
  .max(PACKSCOUT_BUYBACK_EV_INTERNAL_REASON_CODES_V1.length)
  .refine(
    (reasons) =>
      reasons.every(
        (reason, index) =>
          index === 0 ||
          internalReasonOrder.get(reasons[index - 1]!)! <
            internalReasonOrder.get(reason)!,
      ),
    { message: "packscout_buyback_ev.internal_reasons_not_canonical" },
  );

export const PACKSCOUT_BUYBACK_EV_PUBLIC_REASON_CODES_V1 = Object.freeze([
  "SOURCE_EVIDENCE_UNAVAILABLE",
  "PRICE_UNAVAILABLE",
  "CURRENCY_UNSUPPORTED",
  "ODDS_UNAVAILABLE",
  "VALUE_UNAVAILABLE",
  "BUYBACK_UNAVAILABLE",
  "SOURCE_DATA_STALE",
  "CALCULATION_UNAVAILABLE",
] as const);

export type PackScoutBuybackEvPublicReasonCodeV1 =
  (typeof PACKSCOUT_BUYBACK_EV_PUBLIC_REASON_CODES_V1)[number];

export const packScoutBuybackEvPublicReasonCodeV1Schema = z.enum(
  PACKSCOUT_BUYBACK_EV_PUBLIC_REASON_CODES_V1,
);

const publicReasonByInternalReason: Readonly<
  Record<
    PackScoutBuybackEvInternalReasonCodeV1,
    PackScoutBuybackEvPublicReasonCodeV1
  >
> = Object.freeze({
  MISSING_PROVENANCE: "SOURCE_EVIDENCE_UNAVAILABLE",
  MISSING_PRODUCT_IDENTITY: "SOURCE_EVIDENCE_UNAVAILABLE",
  MISSING_SOURCE_TIME: "SOURCE_EVIDENCE_UNAVAILABLE",
  NON_ATOMIC_OBSERVATION: "SOURCE_EVIDENCE_UNAVAILABLE",
  INVALID_PRICE: "PRICE_UNAVAILABLE",
  UNSUPPORTED_CURRENCY: "CURRENCY_UNSUPPORTED",
  UNSUPPORTED_MONEY_PRECISION: "CURRENCY_UNSUPPORTED",
  EXPIRED_PARITY_APPROVAL: "CURRENCY_UNSUPPORTED",
  MIXED_CURRENCY_BASIS: "CURRENCY_UNSUPPORTED",
  AMBIGUOUS_DRAW_SEMANTICS: "SOURCE_EVIDENCE_UNAVAILABLE",
  INCOMPLETE_PROBABILITIES: "ODDS_UNAVAILABLE",
  ODDS_CONFLICT: "ODDS_UNAVAILABLE",
  INCOMPLETE_VALUES: "VALUE_UNAVAILABLE",
  INVALID_VALUE_RANGE: "VALUE_UNAVAILABLE",
  UNKNOWN_BUYBACK_ELIGIBILITY: "BUYBACK_UNAVAILABLE",
  MISSING_BUYBACK: "BUYBACK_UNAVAILABLE",
  INVALID_BUYBACK_TERMS: "BUYBACK_UNAVAILABLE",
  CONDITIONAL_BUYBACK_TERMS: "BUYBACK_UNAVAILABLE",
  HETEROGENEOUS_OUTCOME_BUCKET: "SOURCE_EVIDENCE_UNAVAILABLE",
  STALE_EVIDENCE: "SOURCE_DATA_STALE",
  ARITHMETIC_OVERFLOW: "CALCULATION_UNAVAILABLE",
});

export function packScoutBuybackEvPublicReasonForInternalReasonsV1(
  reasons: readonly PackScoutBuybackEvInternalReasonCodeV1[],
): PackScoutBuybackEvPublicReasonCodeV1 {
  const canonical = canonicalizePackScoutBuybackEvInternalReasonsV1(reasons);
  const primary = canonical[0];
  if (primary === undefined) {
    throw new Error("At least one PackScout EV unavailable reason is required.");
  }
  return publicReasonByInternalReason[primary];
}

export const packScoutBuybackEvDataAsOfV1Schema = z.discriminatedUnion(
  "state",
  [
    z
      .object({
        state: z.literal("known"),
        observedAt: packScoutBuybackEvTimestampV1Schema,
      })
      .strict(),
    z
      .object({
        state: z.literal("unknown_source_time"),
        observedAt: z.null(),
      })
      .strict(),
  ],
);

export type PackScoutBuybackEvMoneyEvidenceV1 = z.infer<
  typeof packScoutBuybackEvMoneyEvidenceV1Schema
>;
export type PackScoutBuybackEvProbabilityV1 = z.infer<
  typeof packScoutBuybackEvProbabilityV1Schema
>;
export type PackScoutBuybackEvDataAsOfV1 = z.infer<
  typeof packScoutBuybackEvDataAsOfV1Schema
>;
