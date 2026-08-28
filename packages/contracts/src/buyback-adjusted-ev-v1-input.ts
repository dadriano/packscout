import { z } from "zod";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_MAX_DRAW_COUNT,
  PACKSCOUT_BUYBACK_EV_MAX_OUTCOMES,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROBABILITY_TOLERANCE_DENOMINATOR,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
  isStrictlyCodeUnitSortedUnique,
  packScoutBuybackEvConfidencePolicyVersionV1Schema,
  packScoutBuybackEvDataAsOfV1Schema,
  packScoutBuybackEvInternalReasonsV1Schema,
  packScoutBuybackEvMethodVersionV1Schema,
  packScoutBuybackEvMoneyEvidenceV1Schema,
  packScoutBuybackEvOutcomeKeyV1Schema,
  packScoutBuybackEvProbabilityV1Schema,
  packScoutBuybackEvProductKeyV1Schema,
  packScoutBuybackEvProviderKeyV1Schema,
  packScoutBuybackEvSchemaVersionV1Schema,
  packScoutBuybackEvSha256V1Schema,
  packScoutBuybackEvSourceRevisionV1Schema,
  packScoutBuybackEvTimestampV1Schema,
  packScoutBuybackEvPublicReasonCodeV1Schema,
  packScoutBuybackEvPublicReasonForInternalReasonsV1,
  type PackScoutBuybackEvMoneyEvidenceV1,
  type PackScoutBuybackEvProbabilityV1,
  type PackScoutBuybackEvRationalV1,
} from "./buyback-adjusted-ev-v1-common.ts";

const nonNegativeSafeIntegerSchema = z.number().int().safe().min(0);
const positiveSafeIntegerSchema = z.number().int().safe().positive();
const basisPointsSchema = z.number().int().min(0).max(10_000);
export const PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_ACCUMULATOR_BITS =
  4_096 as const;

function compareRationals(
  left: PackScoutBuybackEvRationalV1,
  right: PackScoutBuybackEvRationalV1,
): number {
  const leftScaled = BigInt(left.numerator) * BigInt(right.denominator);
  const rightScaled = BigInt(right.numerator) * BigInt(left.denominator);
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

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

function addProbabilities(
  left: { readonly numerator: bigint; readonly denominator: bigint },
  right: PackScoutBuybackEvProbabilityV1,
): { readonly numerator: bigint; readonly denominator: bigint } | null {
  const rightNumerator = BigInt(right.numerator);
  const rightDenominator = BigInt(right.denominator);
  const sharedDivisor = greatestCommonDivisor(
    left.denominator,
    rightDenominator,
  );
  const leftMultiplier = rightDenominator / sharedDivisor;
  const rightMultiplier = left.denominator / sharedDivisor;
  const numerator =
    left.numerator * leftMultiplier + rightNumerator * rightMultiplier;
  const denominator = left.denominator * leftMultiplier;
  const reduction = greatestCommonDivisor(numerator, denominator);
  const reduced = {
    numerator: numerator / reduction,
    denominator: denominator / reduction,
  };
  if (
    reduced.numerator.toString(2).length >
      PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_ACCUMULATOR_BITS ||
    reduced.denominator.toString(2).length >
      PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_ACCUMULATOR_BITS
  ) {
    return null;
  }
  return reduced;
}

export function isPackScoutBuybackEvProbabilityCoverageCompleteV1(
  probabilities: readonly PackScoutBuybackEvProbabilityV1[],
): boolean {
  let total: { readonly numerator: bigint; readonly denominator: bigint } = {
    numerator: 0n,
    denominator: 1n,
  };
  for (const probability of probabilities) {
    const next = addProbabilities(total, probability);
    if (next === null) return false;
    total = next;
  }
  const difference = total.numerator >= total.denominator
    ? total.numerator - total.denominator
    : total.denominator - total.numerator;
  return difference *
      BigInt(PACKSCOUT_BUYBACK_EV_PROBABILITY_TOLERANCE_DENOMINATOR) <=
    total.denominator;
}

export const packScoutBuybackEvStatedValueV1Schema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("exact"),
        amount: packScoutBuybackEvMoneyEvidenceV1Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("closed_range"),
        lower: packScoutBuybackEvMoneyEvidenceV1Schema,
        upper: packScoutBuybackEvMoneyEvidenceV1Schema,
      })
      .strict()
      .refine(
        ({ lower, upper }) =>
          compareRationals(
            lower.canonicalUsdCents,
            upper.canonicalUsdCents,
          ) < 0,
        {
          path: ["upper"],
          message: "packscout_buyback_ev.value_range_not_increasing",
        },
      ),
  ],
);

export const packScoutBuybackEvRateTermsV1Schema = z
  .object({
    rateBasisPoints: basisPointsSchema,
    percentageFeeBasisPoints: basisPointsSchema,
    fixedFee: packScoutBuybackEvMoneyEvidenceV1Schema,
    floor: packScoutBuybackEvMoneyEvidenceV1Schema.nullable(),
    cap: packScoutBuybackEvMoneyEvidenceV1Schema.nullable(),
  })
  .strict()
  .superRefine(({ floor, cap }, context) => {
    if (
      floor !== null &&
      cap !== null &&
      compareRationals(floor.canonicalUsdCents, cap.canonicalUsdCents) > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["cap"],
        message: "packscout_buyback_ev.floor_above_cap",
      });
    }
  });

export const packScoutBuybackEvEligiblePayoutV1Schema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("product_uniform_rate") }).strict(),
    z
      .object({
        kind: z.literal("outcome_specific_rate"),
        terms: packScoutBuybackEvRateTermsV1Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("exact_final_payout"),
        evidenceKind: z.enum([
          "fixed_guaranteed_offer",
          "documented_final_payout",
        ]),
        amount: packScoutBuybackEvMoneyEvidenceV1Schema,
      })
      .strict(),
  ],
);

export const packScoutBuybackEvBuybackV1Schema = z.discriminatedUnion(
  "eligibility",
  [
    z
      .object({
        eligibility: z.literal("ineligible"),
        payout: z.null(),
      })
      .strict(),
    z
      .object({
        eligibility: z.literal("eligible"),
        payout: packScoutBuybackEvEligiblePayoutV1Schema,
      })
      .strict(),
  ],
);

export const packScoutBuybackEvOutcomeRepresentationV1Schema =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("atomic_outcome") }).strict(),
    z
      .object({
        kind: z.literal("homogeneous_bucket"),
        memberCount: z.discriminatedUnion("state", [
          z
            .object({
              state: z.literal("known"),
              value: positiveSafeIntegerSchema.max(100_000),
            })
            .strict(),
          z
            .object({
              state: z.literal("not_published"),
              value: z.null(),
            })
            .strict(),
        ]),
        eligibilityHomogeneity: z.literal("verified_same"),
        payoutFunctionHomogeneity: z.literal("verified_same"),
        homogeneityEvidenceSha256: packScoutBuybackEvSha256V1Schema,
      })
      .strict(),
  ]);

export const packScoutBuybackEvOutcomeV1Schema = z
  .object({
    outcomeKey: packScoutBuybackEvOutcomeKeyV1Schema,
    representation: packScoutBuybackEvOutcomeRepresentationV1Schema,
    probability: packScoutBuybackEvProbabilityV1Schema,
    statedValue: packScoutBuybackEvStatedValueV1Schema,
    buyback: packScoutBuybackEvBuybackV1Schema,
  })
  .strict();

export const packScoutBuybackEvUnitBasisV1Schema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("per_pack"),
        drawCount: z.literal(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("per_draw"),
        drawCount: positiveSafeIntegerSchema.max(
          PACKSCOUT_BUYBACK_EV_MAX_DRAW_COUNT,
        ),
      })
      .strict(),
  ],
);

const publishedOddsComparisonV1Schema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_available") }).strict(),
  z
    .object({
      status: z.literal("within_tolerance"),
      maximumAbsoluteDifferencePartsPerMillion:
        nonNegativeSafeIntegerSchema.max(1_000_000),
      documentedRoundingPrecisionPartsPerMillion:
        nonNegativeSafeIntegerSchema.max(100_000),
    })
    .strict()
    .refine(
      ({
        maximumAbsoluteDifferencePartsPerMillion,
        documentedRoundingPrecisionPartsPerMillion,
      }) =>
        maximumAbsoluteDifferencePartsPerMillion <=
        Math.max(100, documentedRoundingPrecisionPartsPerMillion),
      {
        path: ["maximumAbsoluteDifferencePartsPerMillion"],
        message: "packscout_buyback_ev.odds_comparison_outside_tolerance",
      },
    ),
]);

export const packScoutBuybackEvOddsEvidenceV1Schema = z.discriminatedUnion(
  "sourceKind",
  [
    z
      .object({
        sourceKind: z.literal("current_remaining_inventory"),
        poolKind: z.literal("finite"),
        currentPoolCompleteness: z.literal("complete"),
        probabilityCoverage: z.literal("complete"),
        publishedOddsComparison: publishedOddsComparisonV1Schema,
      })
      .strict(),
    z
      .object({
        sourceKind: z.literal("platform_published"),
        poolKind: z.enum(["finite", "non_finite"]),
        currentPoolEvidence: z.enum(["unavailable", "not_applicable"]),
        probabilityCoverage: z.literal("complete"),
      })
      .strict()
      .refine(
        ({ poolKind, currentPoolEvidence }) =>
          (poolKind === "finite" && currentPoolEvidence === "unavailable") ||
          (poolKind === "non_finite" &&
            currentPoolEvidence === "not_applicable"),
        {
          path: ["currentPoolEvidence"],
          message: "packscout_buyback_ev.current_pool_priority_invalid",
        },
      ),
  ],
);

export const packScoutBuybackEvObservationV1Schema = z.discriminatedUnion(
  "coherenceKind",
  [
    z
      .object({
        coherenceKind: z.literal("provider_revision"),
        providerKey: packScoutBuybackEvProviderKeyV1Schema,
        sourceRevisionId: packScoutBuybackEvSourceRevisionV1Schema,
        sourceManifestSha256: packScoutBuybackEvSha256V1Schema.nullable(),
        observedAt: packScoutBuybackEvTimestampV1Schema,
      })
      .strict(),
    z
      .object({
        coherenceKind: z.literal("guarded_collection"),
        providerKey: packScoutBuybackEvProviderKeyV1Schema,
        sourceRevisionId: packScoutBuybackEvSourceRevisionV1Schema,
        sourceManifestSha256: packScoutBuybackEvSha256V1Schema.nullable(),
        observedAt: packScoutBuybackEvTimestampV1Schema,
        collectionGuardSha256: packScoutBuybackEvSha256V1Schema,
      })
      .strict(),
  ],
);

export const packScoutBuybackEvProductReferenceV1Schema = z
  .object({
    productKey: packScoutBuybackEvProductKeyV1Schema,
    productRevisionId: packScoutBuybackEvSourceRevisionV1Schema,
  })
  .strict();

function moneyEvidenceInValue(
  value: z.infer<typeof packScoutBuybackEvStatedValueV1Schema>,
): readonly PackScoutBuybackEvMoneyEvidenceV1[] {
  return value.kind === "exact" ? [value.amount] : [value.lower, value.upper];
}

function moneyEvidenceInTerms(
  terms: z.infer<typeof packScoutBuybackEvRateTermsV1Schema>,
): readonly PackScoutBuybackEvMoneyEvidenceV1[] {
  return [
    terms.fixedFee,
    ...(terms.floor === null ? [] : [terms.floor]),
    ...(terms.cap === null ? [] : [terms.cap]),
  ];
}

function allMoneyEvidence(input: {
  readonly packPrice: PackScoutBuybackEvMoneyEvidenceV1;
  readonly uniformBuybackRate:
    | { readonly terms: z.infer<typeof packScoutBuybackEvRateTermsV1Schema> }
    | null;
  readonly outcomes: readonly z.infer<typeof packScoutBuybackEvOutcomeV1Schema>[];
}): readonly PackScoutBuybackEvMoneyEvidenceV1[] {
  return [
    input.packPrice,
    ...(input.uniformBuybackRate === null
      ? []
      : moneyEvidenceInTerms(input.uniformBuybackRate.terms)),
    ...input.outcomes.flatMap((outcome) => [
      ...moneyEvidenceInValue(outcome.statedValue),
      ...(outcome.buyback.eligibility === "ineligible"
        ? []
        : outcome.buyback.payout.kind === "product_uniform_rate"
          ? []
          : outcome.buyback.payout.kind === "outcome_specific_rate"
            ? moneyEvidenceInTerms(outcome.buyback.payout.terms)
            : [outcome.buyback.payout.amount]),
    ]),
  ];
}

export const packScoutBuybackEvInputV1Schema = z
  .object({
    schemaVersion: packScoutBuybackEvSchemaVersionV1Schema,
    methodVersion: packScoutBuybackEvMethodVersionV1Schema,
    confidencePolicyVersion:
      packScoutBuybackEvConfidencePolicyVersionV1Schema,
    visibility: z.literal(PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY),
    product: packScoutBuybackEvProductReferenceV1Schema,
    observation: packScoutBuybackEvObservationV1Schema,
    packPrice: packScoutBuybackEvMoneyEvidenceV1Schema,
    unitBasis: packScoutBuybackEvUnitBasisV1Schema,
    oddsEvidence: packScoutBuybackEvOddsEvidenceV1Schema,
    uniformBuybackRate: z
      .object({
        scope: z.literal("every_eligible_outcome"),
        terms: packScoutBuybackEvRateTermsV1Schema,
      })
      .strict()
      .nullable(),
    outcomes: z
      .array(packScoutBuybackEvOutcomeV1Schema)
      .min(1)
      .max(PACKSCOUT_BUYBACK_EV_MAX_OUTCOMES),
  })
  .strict()
  .superRefine((input, context) => {
    const outcomeKeys = input.outcomes.map(({ outcomeKey }) => outcomeKey);
    if (!isStrictlyCodeUnitSortedUnique(outcomeKeys)) {
      context.addIssue({
        code: "custom",
        path: ["outcomes"],
        message: "packscout_buyback_ev.outcomes_not_canonical",
      });
    }
    if (
      !isPackScoutBuybackEvProbabilityCoverageCompleteV1(
        input.outcomes.map(({ probability }) => probability),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcomes"],
        message: "packscout_buyback_ev.probability_coverage_incomplete",
      });
    }
    if (
      input.packPrice.canonicalUsdCents.numerator === 0 ||
      input.packPrice.canonicalUsdCents.denominator !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["packPrice", "canonicalUsdCents"],
        message: "packscout_buyback_ev.pack_price_not_positive_usd_cents",
      });
    }
    input.outcomes.forEach((outcome, index) => {
      if (
        outcome.buyback.eligibility === "eligible" &&
        outcome.buyback.payout.kind === "product_uniform_rate" &&
        input.uniformBuybackRate === null
      ) {
        context.addIssue({
          code: "custom",
          path: ["outcomes", index, "buyback", "payout"],
          message: "packscout_buyback_ev.uniform_rate_missing",
        });
      }
    });
    const usesUniformRate = input.outcomes.some(
      (outcome) =>
        outcome.buyback.eligibility === "eligible" &&
        outcome.buyback.payout.kind === "product_uniform_rate",
    );
    if (input.uniformBuybackRate !== null && !usesUniformRate) {
      context.addIssue({
        code: "custom",
        path: ["uniformBuybackRate"],
        message: "packscout_buyback_ev.uniform_rate_unused",
      });
    }
    const observedAt = Date.parse(input.observation.observedAt);
    allMoneyEvidence(input).forEach((money, index) => {
      if (
        money.normalization.kind === "usd_equivalent_stablecoin" &&
        (observedAt < Date.parse(money.normalization.parity.effectiveAt) ||
          observedAt >= Date.parse(money.normalization.parity.expiresAt))
      ) {
        context.addIssue({
          code: "custom",
          path: ["currencyEvidence", index],
          message: "packscout_buyback_ev.parity_not_effective_at_observation",
        });
      }
    });
  });

/**
 * Provider normalization returns this outcome. Only the complete branch may be
 * passed to the calculator; bounded missing-evidence states remain explicit
 * rather than being represented as partial calculator inputs.
 */
export const packScoutBuybackEvEvidenceOutcomeV1Schema =
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("complete"),
        input: packScoutBuybackEvInputV1Schema,
      })
      .strict(),
    z
      .object({
        schemaVersion: packScoutBuybackEvSchemaVersionV1Schema,
        methodVersion: packScoutBuybackEvMethodVersionV1Schema,
        confidencePolicyVersion:
          packScoutBuybackEvConfidencePolicyVersionV1Schema,
        visibility: z.literal(PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY),
        status: z.literal("unavailable"),
        product: z.discriminatedUnion("state", [
          z
            .object({
              state: z.literal("known"),
              reference: packScoutBuybackEvProductReferenceV1Schema,
            })
            .strict(),
          z
            .object({
              state: z.literal("unknown"),
              reference: z.null(),
            })
            .strict(),
        ]),
        evaluatedAt: packScoutBuybackEvTimestampV1Schema,
        dataAsOf: packScoutBuybackEvDataAsOfV1Schema,
        observation: packScoutBuybackEvObservationV1Schema.nullable(),
        internalReasons: packScoutBuybackEvInternalReasonsV1Schema,
        publicPrimaryReason: packScoutBuybackEvPublicReasonCodeV1Schema,
      })
      .strict()
      .superRefine((outcome, context) => {
        const expectedPublicReason =
          packScoutBuybackEvPublicReasonForInternalReasonsV1(
            outcome.internalReasons,
          );
        if (outcome.publicPrimaryReason !== expectedPublicReason) {
          context.addIssue({
            code: "custom",
            path: ["publicPrimaryReason"],
            message: "packscout_buyback_ev.public_reason_mismatch",
          });
        }
        const reasons = new Set(outcome.internalReasons);
        if (
          (outcome.product.state === "unknown") !==
          reasons.has("MISSING_PRODUCT_IDENTITY")
        ) {
          context.addIssue({
            code: "custom",
            path: ["product"],
            message: "packscout_buyback_ev.product_reason_mismatch",
          });
        }
        if (
          (outcome.observation === null) !== reasons.has("MISSING_PROVENANCE")
        ) {
          context.addIssue({
            code: "custom",
            path: ["observation"],
            message: "packscout_buyback_ev.provenance_reason_mismatch",
          });
        }
        if (
          (outcome.dataAsOf.state === "unknown_source_time") !==
          reasons.has("MISSING_SOURCE_TIME")
        ) {
          context.addIssue({
            code: "custom",
            path: ["dataAsOf"],
            message: "packscout_buyback_ev.source_time_reason_mismatch",
          });
        }
        if (
          outcome.observation !== null &&
          outcome.dataAsOf.state === "known" &&
          outcome.observation.observedAt !== outcome.dataAsOf.observedAt
        ) {
          context.addIssue({
            code: "custom",
            path: ["dataAsOf"],
            message: "packscout_buyback_ev.observation_time_mismatch",
          });
        }
      }),
  ]);

export const packScoutBuybackEvConfidenceInputV1Schema = z
  .object({
    schemaVersion: z.literal(PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION),
    methodVersion: z.literal(PACKSCOUT_BUYBACK_EV_METHOD_VERSION),
    confidencePolicyVersion: z.literal(
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    ),
    visibility: z.literal(PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY),
    oddsSource: z
      .enum(["current_remaining_inventory", "platform_published"])
      .nullable(),
    usedClosedRangeMidpoint: z.boolean(),
    oldestEssentialObservedAt:
      packScoutBuybackEvTimestampV1Schema.nullable(),
    calculatedAt: packScoutBuybackEvTimestampV1Schema,
    availabilityGate: z.discriminatedUnion("status", [
      z.object({ status: z.literal("passed") }).strict(),
      z
        .object({
          status: z.literal("failed"),
          internalReasons: packScoutBuybackEvInternalReasonsV1Schema,
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.availabilityGate.status === "passed" &&
      (input.oddsSource === null || input.oldestEssentialObservedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["availabilityGate"],
        message: "packscout_buyback_ev.confidence_gate_missing_evidence",
      });
    }
    if (
      input.oldestEssentialObservedAt !== null &&
      Date.parse(input.calculatedAt) <
        Date.parse(input.oldestEssentialObservedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["calculatedAt"],
        message: "packscout_buyback_ev.calculation_precedes_evidence",
      });
    }
  });

export type PackScoutBuybackEvInputV1 = z.infer<
  typeof packScoutBuybackEvInputV1Schema
>;
export type PackScoutBuybackEvOutcomeV1 = z.infer<
  typeof packScoutBuybackEvOutcomeV1Schema
>;
export type PackScoutBuybackEvRateTermsV1 = z.infer<
  typeof packScoutBuybackEvRateTermsV1Schema
>;
export type PackScoutBuybackEvConfidenceInputV1 = z.infer<
  typeof packScoutBuybackEvConfidenceInputV1Schema
>;
export type PackScoutBuybackEvEvidenceOutcomeV1 = z.infer<
  typeof packScoutBuybackEvEvidenceOutcomeV1Schema
>;
