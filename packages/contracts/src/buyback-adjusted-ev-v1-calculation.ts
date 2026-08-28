import { z } from "zod";
import {
  PACKSCOUT_BUYBACK_EV_FORMULAS_V1,
  PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1,
  PACKSCOUT_BUYBACK_EV_PROBABILITY_TOLERANCE_DENOMINATOR,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  packScoutBuybackEvCanonicalUsdMoneyV1Schema,
  packScoutBuybackEvConfidencePolicyVersionV1Schema,
  packScoutBuybackEvDataAsOfV1Schema,
  packScoutBuybackEvInternalReasonsV1Schema,
  packScoutBuybackEvMethodVersionV1Schema,
  packScoutBuybackEvProviderKeyV1Schema,
  packScoutBuybackEvProductKeyV1Schema,
  packScoutBuybackEvPublicReasonCodeV1Schema,
  packScoutBuybackEvPublicReasonForInternalReasonsV1,
  packScoutBuybackEvSchemaVersionV1Schema,
  packScoutBuybackEvSha256V1Schema,
  packScoutBuybackEvSignedCanonicalUsdMoneyV1Schema,
  packScoutBuybackEvSourceRevisionV1Schema,
  packScoutBuybackEvTimestampV1Schema,
  type PackScoutBuybackEvInternalReasonCodeV1,
} from "./buyback-adjusted-ev-v1-common.ts";
import { packScoutBuybackEvConfidenceInputV1Schema } from "./buyback-adjusted-ev-v1-input.ts";

const signedBasisPointsSchema = z.number().int().safe();

export const packScoutBuybackEvProtectedProvenanceV1Schema = z
  .object({
    providerKey: packScoutBuybackEvProviderKeyV1Schema,
    productKey: packScoutBuybackEvProductKeyV1Schema,
    productRevisionId: packScoutBuybackEvSourceRevisionV1Schema,
    sourceRevisionId: packScoutBuybackEvSourceRevisionV1Schema,
    sourceManifestSha256: packScoutBuybackEvSha256V1Schema.nullable(),
    observationCoherence: z.enum([
      "provider_revision",
      "guarded_collection",
    ]),
    oddsSource: z.enum([
      "current_remaining_inventory",
      "platform_published",
    ]),
    usedClosedRangeMidpoint: z.boolean(),
  })
  .strict();

export const packScoutBuybackEvProtectedCalculationEvidenceV1Schema = z
  .object({
    packPriceMoney: packScoutBuybackEvCanonicalUsdMoneyV1Schema,
    underlyingOutcomeEvMoney: packScoutBuybackEvCanonicalUsdMoneyV1Schema,
    drawMultiplier: z.number().int().positive().max(100),
    acceptedProbabilityCoverage: z.literal("within_one_part_per_million"),
    probabilityToleranceDenominator: z.literal(
      PACKSCOUT_BUYBACK_EV_PROBABILITY_TOLERANCE_DENOMINATOR,
    ),
    probabilityWasRenormalized: z.literal(false),
    payoutFormula: z.literal(PACKSCOUT_BUYBACK_EV_FORMULAS_V1.grossEv),
    payoutOrder: z.tuple([
      z.literal(PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1[0]),
      z.literal(PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1[1]),
      z.literal(PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1[2]),
      z.literal(PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1[3]),
      z.literal(PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1[4]),
      z.literal(PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1[5]),
    ]),
  })
  .strict();

function roundNonNegativeRationalHalfUp(
  numerator: bigint,
  denominator: bigint,
): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export interface PackScoutBuybackEvMetricInvariantInputV1 {
  readonly grossEvMinorUnits: number;
  readonly grossReturnBasisPoints: number;
  readonly evDollarsMinorUnits: number;
  readonly evPercentBasisPoints: number;
  readonly packPriceMinorUnits: number;
}

export function packScoutBuybackEvMetricsAreConsistentV1(
  input: PackScoutBuybackEvMetricInvariantInputV1,
): boolean {
  if (input.packPriceMinorUnits <= 0) return false;
  const expectedReturn = Number(
    roundNonNegativeRationalHalfUp(
      BigInt(input.grossEvMinorUnits) * 10_000n,
      BigInt(input.packPriceMinorUnits),
    ),
  );
  return (
    input.evDollarsMinorUnits ===
      input.grossEvMinorUnits - input.packPriceMinorUnits &&
    input.grossReturnBasisPoints === expectedReturn &&
    input.evPercentBasisPoints === expectedReturn - 10_000
  );
}

const availableCalculationResultV1Schema = z
  .object({
    schemaVersion: packScoutBuybackEvSchemaVersionV1Schema,
    methodVersion: packScoutBuybackEvMethodVersionV1Schema,
    confidencePolicyVersion:
      packScoutBuybackEvConfidencePolicyVersionV1Schema,
    visibility: z.literal(PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY),
    status: z.literal("available"),
    grossEvMoney: packScoutBuybackEvCanonicalUsdMoneyV1Schema,
    grossReturnBasisPoints: signedBasisPointsSchema,
    evDollars: packScoutBuybackEvSignedCanonicalUsdMoneyV1Schema,
    evPercentBasisPoints: signedBasisPointsSchema,
    calculatedAt: packScoutBuybackEvTimestampV1Schema,
    dataAsOf: z
      .object({
        state: z.literal("known"),
        observedAt: packScoutBuybackEvTimestampV1Schema,
      })
      .strict(),
    provenance: packScoutBuybackEvProtectedProvenanceV1Schema,
    protectedEvidence:
      packScoutBuybackEvProtectedCalculationEvidenceV1Schema,
    confidenceInput: packScoutBuybackEvConfidenceInputV1Schema,
  })
  .strict()
  .superRefine((result, context) => {
    if (
      !packScoutBuybackEvMetricsAreConsistentV1({
        grossEvMinorUnits: result.grossEvMoney.minorUnits,
        grossReturnBasisPoints: result.grossReturnBasisPoints,
        evDollarsMinorUnits: result.evDollars.minorUnits,
        evPercentBasisPoints: result.evPercentBasisPoints,
        packPriceMinorUnits:
          result.protectedEvidence.packPriceMoney.minorUnits,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["grossEvMoney"],
        message: "packscout_buyback_ev.metric_invariants_failed",
      });
    }
    if (
      result.confidenceInput.availabilityGate.status !== "passed" ||
      result.confidenceInput.calculatedAt !== result.calculatedAt ||
      result.confidenceInput.oldestEssentialObservedAt !==
        result.dataAsOf.observedAt ||
      result.confidenceInput.oddsSource !== result.provenance.oddsSource ||
      result.confidenceInput.usedClosedRangeMidpoint !==
        result.provenance.usedClosedRangeMidpoint
    ) {
      context.addIssue({
        code: "custom",
        path: ["confidenceInput"],
        message: "packscout_buyback_ev.confidence_input_mismatch",
      });
    }
  });

const unavailableCalculationResultV1Schema = z
  .object({
    schemaVersion: packScoutBuybackEvSchemaVersionV1Schema,
    methodVersion: packScoutBuybackEvMethodVersionV1Schema,
    confidencePolicyVersion:
      packScoutBuybackEvConfidencePolicyVersionV1Schema,
    visibility: z.literal(PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY),
    status: z.literal("unavailable"),
    grossEvMoney: z.null(),
    grossReturnBasisPoints: z.null(),
    evDollars: z.null(),
    evPercentBasisPoints: z.null(),
    calculatedAt: packScoutBuybackEvTimestampV1Schema,
    dataAsOf: packScoutBuybackEvDataAsOfV1Schema,
    provenance: packScoutBuybackEvProtectedProvenanceV1Schema.nullable(),
    protectedEvidence: z.null(),
    confidenceInput: packScoutBuybackEvConfidenceInputV1Schema,
    internalReasons: packScoutBuybackEvInternalReasonsV1Schema,
    publicPrimaryReason: packScoutBuybackEvPublicReasonCodeV1Schema,
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.confidenceInput.availabilityGate.status !== "failed" ||
      result.confidenceInput.calculatedAt !== result.calculatedAt ||
      result.confidenceInput.availabilityGate.internalReasons.length !==
        result.internalReasons.length ||
      result.internalReasons.some(
        (reason, index) =>
          reason !==
            (result.confidenceInput.availabilityGate.status === "failed"
              ? result.confidenceInput.availabilityGate.internalReasons[index]
              : undefined),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["confidenceInput"],
        message: "packscout_buyback_ev.failed_confidence_input_mismatch",
      });
    }
    if (
      result.publicPrimaryReason !==
      packScoutBuybackEvPublicReasonForInternalReasonsV1(
        result.internalReasons,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["publicPrimaryReason"],
        message: "packscout_buyback_ev.public_reason_mismatch",
      });
    }
    const reasons = new Set<PackScoutBuybackEvInternalReasonCodeV1>(
      result.internalReasons,
    );
    if ((result.provenance === null) !== reasons.has("MISSING_PROVENANCE")) {
      context.addIssue({
        code: "custom",
        path: ["provenance"],
        message: "packscout_buyback_ev.provenance_reason_mismatch",
      });
    }
    if (
      (result.dataAsOf.state === "unknown_source_time") !==
      reasons.has("MISSING_SOURCE_TIME")
    ) {
      context.addIssue({
        code: "custom",
        path: ["dataAsOf"],
        message: "packscout_buyback_ev.source_time_reason_mismatch",
      });
    }
  });

/** Pure task-002 output. Confidence is an input, never a fabricated score. */
export const packScoutBuybackEvProtectedCalculationResultV1Schema =
  z.discriminatedUnion("status", [
    availableCalculationResultV1Schema,
    unavailableCalculationResultV1Schema,
  ]);

export type PackScoutBuybackEvProtectedProvenanceV1 = z.infer<
  typeof packScoutBuybackEvProtectedProvenanceV1Schema
>;
export type PackScoutBuybackEvProtectedCalculationEvidenceV1 = z.infer<
  typeof packScoutBuybackEvProtectedCalculationEvidenceV1Schema
>;
export type PackScoutBuybackEvProtectedCalculationResultV1 = z.infer<
  typeof packScoutBuybackEvProtectedCalculationResultV1Schema
>;
