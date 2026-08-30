import {
  packScoutBuybackEvEvidenceOutcomeV1Schema,
  parsePackScoutBuybackEvTimestampMillisV1,
  type PackScoutBuybackEvEvidenceOutcomeV1,
} from "@packscout/contracts";
import { calculatePackScoutBuybackAdjustedEvV1 } from "./buyback-adjusted-ev-calculator.ts";
import { evaluatePackScoutBuybackEvConfidenceV1 } from "./buyback-adjusted-ev-confidence.ts";
import {
  alignPackScoutBuybackEvCalculationFreshnessV1,
  derivePackScoutBuybackEvRecomputationBindingV1,
  packScoutBuybackEvEvaluationIsResolvableV1,
  synthesizePackScoutBuybackEvUnavailableCalculationV1,
} from "./buyback-adjusted-ev-recomputation-contracts.ts";
import {
  MAX_DATA_RELEASE_V3_REPACKS,
  type DataReleaseV3EligibilityPort,
  type PackScoutBuybackEvPromotionEligibilityV1,
} from "./buyback-adjusted-ev-release-types.ts";
import { sanitizePackScoutBuybackEvRevisionForPublicationV1 } from "./buyback-adjusted-ev-revision-contracts.ts";
import { composePackScoutBuybackEvCompletedCalculationV1 } from "./buyback-adjusted-ev-revision-store.ts";

export interface PackScoutBuybackEvPromotionSnapshotV1 {
  readonly organizationId: string;
  /** One promotion clock; this must never replace the evidence's observedAt. */
  readonly readAt: string;
  readonly products: readonly Readonly<{
    readonly platformKey: string;
    readonly productKey: string;
    /** Provider-normalized evidence bound to this catalog snapshot by the caller. */
    readonly evidence: unknown;
  }>[];
}

export class PackScoutBuybackEvPromotionError extends Error {
  constructor(readonly code:
    | "SNAPSHOT_INVALID"
    | "EVIDENCE_INVALID"
    | "EVIDENCE_SCOPE_MISMATCH"
    | "PUBLICATION_SCOPE_MISMATCH") {
    super("PackScout promotion-time EV calculation was refused safely.");
    this.name = "PackScoutBuybackEvPromotionError";
  }
}

function productKey(platform: string, product: string): string {
  return JSON.stringify([platform, product]);
}

function calculate(
  evidence: PackScoutBuybackEvEvidenceOutcomeV1,
  readAt: string,
): PackScoutBuybackEvPromotionEligibilityV1 {
  const calculation = alignPackScoutBuybackEvCalculationFreshnessV1(
    evidence.status === "complete"
      ? calculatePackScoutBuybackAdjustedEvV1({ input: evidence.input, calculatedAt: readAt })
      : synthesizePackScoutBuybackEvUnavailableCalculationV1({
          evidence,
          calculatedAt: readAt,
          binding: derivePackScoutBuybackEvRecomputationBindingV1(evidence),
        }),
  );
  const evaluation = packScoutBuybackEvEvaluationIsResolvableV1(calculation)
    ? evaluatePackScoutBuybackEvConfidenceV1(calculation.confidenceInput)
    : null;
  const completed = composePackScoutBuybackEvCompletedCalculationV1(calculation, evaluation);
  const projection = sanitizePackScoutBuybackEvRevisionForPublicationV1({
    ...completed,
    methodVersion: calculation.methodVersion,
    confidencePolicyVersion: calculation.confidencePolicyVersion,
    calculatedAt: calculation.calculatedAt,
  });
  return {
    calculationSource: "promotion",
    projection,
    readState: {
      state: "publishable",
      availability: projection.status === "available" ? "AVAILABLE" : "UNAVAILABLE",
    },
    evaluatedAt: readAt,
  };
}

/**
 * Calculate a bounded, repeatable promotion snapshot through the existing EV
 * rulebook, confidence evaluation, composition, and public sanitizer. Nothing
 * is persisted and no database revision identity is synthesized. Each new
 * promotion re-evaluates source freshness at its own readAt; source observation
 * timestamps remain unchanged. The returned port can only serve this snapshot.
 */
export function createPackScoutBuybackEvPromotionEligibilityV1(
  input: PackScoutBuybackEvPromotionSnapshotV1,
): DataReleaseV3EligibilityPort {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.organizationId) ||
    parsePackScoutBuybackEvTimestampMillisV1(input.readAt) === null ||
    input.products.length > MAX_DATA_RELEASE_V3_REPACKS
  ) throw new PackScoutBuybackEvPromotionError("SNAPSHOT_INVALID");
  const { organizationId, readAt } = input;
  const results = new Map<string, PackScoutBuybackEvPromotionEligibilityV1>();
  for (const product of input.products) {
    const key = productKey(product.platformKey, product.productKey);
    if (
      [product.platformKey, product.productKey].some((value) =>
        value.trim() !== value || value.length === 0 || value.length > 256 || /[\r\n\0]/u.test(value)) ||
      results.has(key)
    ) throw new PackScoutBuybackEvPromotionError("SNAPSHOT_INVALID");
    const parsed = packScoutBuybackEvEvidenceOutcomeV1Schema.safeParse(product.evidence);
    if (!parsed.success) throw new PackScoutBuybackEvPromotionError("EVIDENCE_INVALID");
    const evidence = parsed.data;
    const observation = evidence.status === "complete" ? evidence.input.observation : evidence.observation;
    const identity = evidence.status === "complete"
      ? evidence.input.product
      : evidence.product.state === "known" ? evidence.product.reference : null;
    if (
      (observation !== null && observation.providerKey !== product.platformKey) ||
      (identity !== null && identity.productKey !== product.productKey)
    ) throw new PackScoutBuybackEvPromotionError("EVIDENCE_SCOPE_MISMATCH");
    results.set(key, calculate(evidence, readAt));
  }
  return {
    async getPublicationEligibleRevision(query) {
      if (query.organizationId !== organizationId || query.readAt !== readAt) {
        throw new PackScoutBuybackEvPromotionError("PUBLICATION_SCOPE_MISMATCH");
      }
      return structuredClone(results.get(productKey(query.platformKey, query.productKey)) ?? null);
    },
  };
}
