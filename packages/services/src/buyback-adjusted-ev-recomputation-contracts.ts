import { createHash } from "node:crypto";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
  canonicalJson,
  canonicalizePackScoutBuybackEvInternalReasonsV1,
  packScoutBuybackEvProtectedCalculationResultV1Schema,
  packScoutBuybackEvPublicReasonForInternalReasonsV1,
  parsePackScoutBuybackEvTimestampMillisV1,
  type PackScoutBuybackEvEvidenceOutcomeV1,
  type PackScoutBuybackEvInternalReasonCodeV1,
  type PackScoutBuybackEvProtectedCalculationResultV1,
  type PackScoutBuybackEvPublicReasonCodeV1,
} from "@packscout/contracts";
import {
  computePackScoutBuybackEvEffectiveFingerprintV1,
  type PackScoutBuybackEvCalculationIdentityV1,
  type PackScoutBuybackEvGoverningEvidenceV1,
  type PackScoutBuybackEvRevisionIdentityRecordV1,
  type PackScoutBuybackEvRevisionPublicationProjectionV1,
} from "./buyback-adjusted-ev-revision-contracts.ts";
import { PACKSCOUT_BUYBACK_EV_SOURCE_AGE_EXPIRY_MILLISECONDS } from "./buyback-adjusted-ev-confidence.ts";

/**
 * Contracts and pure derivations for the buyback-adjusted EV recomputation
 * boundary (task buyback-adjusted-ev/006).
 *
 * ## Change matrix
 *
 * One recomputation fingerprint governs invalidation. It is the task-005
 * effective fingerprint: a domain-separated digest over the calculation
 * identity (method version, confidence-policy version, product revision, one
 * coherent observation set, approved configuration revision) plus the
 * governing evidence (the complete canonical calculator input, or the bounded
 * unavailability facts). {@link PACKSCOUT_BUYBACK_EV_CHANGE_MATRIX_V1} maps
 * every change class to its effect; the matrix test proves each mapping by
 * mutation.
 *
 * Governing changes always land in a fingerprint component, so they always
 * recalculate. Display-only source changes (names, images, descriptions,
 * marketing fields) are structurally excluded: neither the provider evidence
 * vocabulary, the canonical calculator input, nor the calculation identity
 * can carry them, so they cannot alter the fingerprint. Restocks, pool
 * replacements, and supported deterministic depletion arrive as a new
 * coherent observation (new source revision and essential source time) and
 * therefore always produce a new fingerprint even when the product identity
 * and economics are otherwise unchanged.
 *
 * ## Stale-transition resolution
 *
 * The task-005 fingerprint deliberately excludes the calculation clock, and
 * the immutable store admits exactly one completed revision per calculation
 * identity and per fingerprint. A later clock over the same evidence is
 * therefore *not* new work: freshness and availability recomputation at the
 * 15/30/60-minute boundaries replays to the existing completed revision
 * (`unchanged`) and never mutates or re-scores it. The 60-minute availability
 * boundary for unchanged evidence is enforced at read time: the
 * publication-eligibility read compares the immutable revision's `expiresAt`
 * with the caller's read clock and reports `expired_since_calculation`, which
 * the publisher renders as the deterministic stale public state. A *stored*
 * `STALE_EVIDENCE` revision is created only when what changed is the
 * observation itself: newly observed evidence (a new source revision, hence a
 * new identity and fingerprint) whose essential source time is already older
 * than 60 minutes at its calculation clock.
 *
 * ## Deterministic calculation clock
 *
 * Each work item carries `calculatedAt`, assigned exactly once when the
 * change was scheduled. Retries and concurrent duplicate deliveries reuse it,
 * so the recalculated result is byte-identical and the store's replay
 * semantics converge them onto one immutable revision without conflicts.
 */

export const PACKSCOUT_BUYBACK_EV_RECOMPUTATION_VERSION =
  "packscout-buyback-ev-recomputation-v1" as const;

/**
 * Provenance for revisions synthesized from canonical unavailable evidence:
 * no odds evidence was resolved, so the protected provenance records the
 * conservative published-odds classification and no midpoint usage. The value
 * is protected-internal, never published, and excluded from the fingerprint.
 */
export const PACKSCOUT_BUYBACK_EV_RECOMPUTATION_SYNTHETIC_ODDS_SOURCE =
  "platform_published" as const;

const UNBINDABLE_HASH_DOMAIN =
  "packscout.buyback-ev.recomputation-unbindable.v1";

export type PackScoutBuybackEvChangeEffectV1 =
  | "new_fingerprint"
  | "unchanged_fingerprint";

/**
 * The approved invalidation map. `carrier` names the fingerprint component
 * (or structural exclusion) that makes each mapping hold; the matrix unit
 * test proves every entry by mutating exactly that class.
 */
export const PACKSCOUT_BUYBACK_EV_CHANGE_MATRIX_V1: Readonly<
  Record<
    string,
    Readonly<{ effect: PackScoutBuybackEvChangeEffectV1; carrier: string }>
  >
> = Object.freeze({
  publicPackPrice: {
    effect: "new_fingerprint",
    carrier: "evidence.input.packPrice",
  },
  currencyEvidence: {
    effect: "new_fingerprint",
    carrier: "evidence.input money normalization and parity approvals",
  },
  odds: {
    effect: "new_fingerprint",
    carrier: "evidence.input.outcomes[].probability",
  },
  inventory: {
    effect: "new_fingerprint",
    carrier:
      "evidence.input.oddsEvidence plus current-pool derived probabilities",
  },
  statedValues: {
    effect: "new_fingerprint",
    carrier: "evidence.input.outcomes[].statedValue",
  },
  payoutTerms: {
    effect: "new_fingerprint",
    carrier: "evidence.input buyback payout terms",
  },
  eligibility: {
    effect: "new_fingerprint",
    carrier: "evidence.input.outcomes[].buyback.eligibility",
  },
  drawSemantics: {
    effect: "new_fingerprint",
    carrier: "evidence.input.unitBasis",
  },
  essentialSourceTime: {
    effect: "new_fingerprint",
    carrier: "identity observation observedAt via evidence.input.observation",
  },
  sourceRevision: {
    effect: "new_fingerprint",
    carrier: "identity.sourceRevisionId / sourceManifestSha256",
  },
  restockOrPoolReplacementOrDepletion: {
    effect: "new_fingerprint",
    carrier:
      "new coherent observation set even when product identity is unchanged",
  },
  productRevision: {
    effect: "new_fingerprint",
    carrier: "identity.productRevisionId",
  },
  providerSourceRevision: {
    effect: "new_fingerprint",
    carrier: "identity.providerSourceRevisionId",
  },
  methodVersion: {
    effect: "new_fingerprint",
    carrier: "identity.methodVersion",
  },
  confidencePolicyVersion: {
    effect: "new_fingerprint",
    carrier: "identity.confidencePolicyVersion",
  },
  unavailabilityFacts: {
    effect: "new_fingerprint",
    carrier: "unavailable evidence dataAsOf and internal reasons",
  },
  displayOnlyFields: {
    effect: "unchanged_fingerprint",
    carrier:
      "names, images, descriptions, and marketing fields are structurally excluded from evidence and identity",
  },
  calculationClock: {
    effect: "unchanged_fingerprint",
    carrier:
      "calculatedAt is excluded by the task-005 fingerprint; replays converge",
  },
  workMetadata: {
    effect: "unchanged_fingerprint",
    carrier:
      "request ids, attempts, arrival order, and lineage annotations never enter the fingerprint",
  },
});

export interface PackScoutBuybackEvRecomputationSourceRevisionV1 {
  readonly sourceRevisionId: string;
  readonly sourceManifestSha256?: string | null;
  readonly canonicalRevisionId?: string | null;
}

/** One unit of recomputation work delivered to the boundary. */
export interface PackScoutBuybackEvRecomputationCommandV1 {
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerSourceRevisionId: string;
  /**
   * Expected to be a task-004 `PackScoutBuybackEvEvidenceOutcomeV1`.
   * Accepted as `unknown` for defense in depth; the strict schema is
   * safe-parsed before any other work.
   */
  readonly evidence: unknown;
  /**
   * The work item's calculation clock, assigned exactly once when the change
   * was scheduled. Retries and duplicate deliveries must reuse it so the
   * recalculation replays byte-identically.
   */
  readonly calculatedAt: string;
  /**
   * Normalized source revisions contributing to this work. When omitted, the
   * governing observation source revision is used.
   */
  readonly sourceRevisions?: readonly PackScoutBuybackEvRecomputationSourceRevisionV1[];
}

/** Bounded operational status returned with every resolved revision. */
export interface PackScoutBuybackEvRecomputationStatusV1 {
  readonly methodVersion: typeof PACKSCOUT_BUYBACK_EV_METHOD_VERSION;
  readonly confidencePolicyVersion:
    typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION;
  readonly availability: "AVAILABLE" | "UNAVAILABLE";
  readonly publicReason: PackScoutBuybackEvPublicReasonCodeV1 | null;
  readonly sourceAgeMilliseconds: number | null;
}

export type PackScoutBuybackEvRecomputationResultV1 =
  | Readonly<{
      outcome: "created" | "unchanged";
      revision: PackScoutBuybackEvRevisionIdentityRecordV1;
      projection: PackScoutBuybackEvRevisionPublicationProjectionV1;
      status: PackScoutBuybackEvRecomputationStatusV1;
    }>
  | Readonly<{
      /**
       * Deterministically out of order: the completed current revision was
       * calculated from strictly newer essential source evidence, so this
       * work never becomes current or publishable.
       */
      outcome: "superseded";
      currentRevision: PackScoutBuybackEvRevisionIdentityRecordV1;
      status: PackScoutBuybackEvRecomputationStatusV1;
    }>
  | Readonly<{
      outcome: "rejected";
      reason: "IDENTITY_REUSE_CONFLICT" | "RESULT_CONFLICT";
      occurrenceCount: number;
    }>
  | Readonly<{
      outcome: "unbindable";
      reason: "UNBINDABLE_RESULT";
      occurrenceCount: number;
    }>;

/** The deterministic read task 008 repeats for one canonical snapshot. */
export type PackScoutBuybackEvPublicationEligibilityV1 = Readonly<{
  revision: PackScoutBuybackEvRevisionIdentityRecordV1;
  projection: PackScoutBuybackEvRevisionPublicationProjectionV1;
  readState:
    | Readonly<{
        state: "publishable";
        availability: "AVAILABLE" | "UNAVAILABLE";
      }>
    | Readonly<{
        /**
         * The immutable available revision's evidence expired after its
         * calculation. The revision itself never changes; the publisher must
         * render the deterministic stale public state from `staleSince`.
         */
        state: "expired_since_calculation";
        staleSince: string;
      }>;
  evaluatedAt: string;
}>;

/**
 * The evidence binding: either enough identity to occupy one immutable
 * revision slot, or deterministically unbindable work that may only reach the
 * deduplicated failure ledger.
 */
export type PackScoutBuybackEvRecomputationBindingV1 =
  | Readonly<{
      kind: "bindable";
      platformKey: string;
      productKey: string;
      productRevisionId: string;
      sourceRevisionId: string;
      sourceManifestSha256: string | null;
      observationCoherence: "provider_revision" | "guarded_collection";
      observedAt: string | null;
      evidence: PackScoutBuybackEvGoverningEvidenceV1;
    }>
  | Readonly<{
      kind: "unbindable";
      reason: "MISSING_OBSERVATION" | "MISSING_PRODUCT_IDENTITY";
    }>;

/**
 * Derives the revision binding from one normalized evidence outcome. A
 * complete input always binds. Unavailable evidence binds only when both the
 * product identity and the coherent observation are known; anything else has
 * no revision identity to occupy and is unbindable by construction.
 */
export function derivePackScoutBuybackEvRecomputationBindingV1(
  evidence: PackScoutBuybackEvEvidenceOutcomeV1,
): PackScoutBuybackEvRecomputationBindingV1 {
  if (evidence.status === "complete") {
    const observation = evidence.input.observation;
    return {
      kind: "bindable",
      platformKey: observation.providerKey,
      productKey: evidence.input.product.productKey,
      productRevisionId: evidence.input.product.productRevisionId,
      sourceRevisionId: observation.sourceRevisionId,
      sourceManifestSha256: observation.sourceManifestSha256,
      observationCoherence: observation.coherenceKind,
      observedAt: observation.observedAt,
      evidence: { kind: "complete_input", input: evidence.input },
    };
  }
  if (evidence.observation === null) {
    return { kind: "unbindable", reason: "MISSING_OBSERVATION" };
  }
  if (evidence.product.state !== "known") {
    return { kind: "unbindable", reason: "MISSING_PRODUCT_IDENTITY" };
  }
  return {
    kind: "bindable",
    platformKey: evidence.observation.providerKey,
    productKey: evidence.product.reference.productKey,
    productRevisionId: evidence.product.reference.productRevisionId,
    sourceRevisionId: evidence.observation.sourceRevisionId,
    sourceManifestSha256: evidence.observation.sourceManifestSha256,
    observationCoherence: evidence.observation.coherenceKind,
    observedAt:
      evidence.dataAsOf.state === "known" ? evidence.dataAsOf.observedAt : null,
    evidence: {
      kind: "unavailable_evidence",
      dataAsOf: evidence.dataAsOf,
      internalReasons: evidence.internalReasons,
    },
  };
}

export function packScoutBuybackEvRecomputationIdentityV1(
  binding: Extract<
    PackScoutBuybackEvRecomputationBindingV1,
    { kind: "bindable" }
  >,
  providerSourceRevisionId: string,
): PackScoutBuybackEvCalculationIdentityV1 {
  return {
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    platformKey: binding.platformKey,
    productKey: binding.productKey,
    productRevisionId: binding.productRevisionId,
    sourceRevisionId: binding.sourceRevisionId,
    sourceManifestSha256: binding.sourceManifestSha256,
    observationCoherence: binding.observationCoherence,
    providerSourceRevisionId,
  };
}

/** The effective fingerprint for one bindable unit of work. */
export function computePackScoutBuybackEvRecomputationFingerprintV1(
  binding: Extract<
    PackScoutBuybackEvRecomputationBindingV1,
    { kind: "bindable" }
  >,
  providerSourceRevisionId: string,
): string {
  return computePackScoutBuybackEvEffectiveFingerprintV1({
    identity: packScoutBuybackEvRecomputationIdentityV1(
      binding,
      providerSourceRevisionId,
    ),
    evidence: binding.evidence,
  });
}

/**
 * Deterministic surrogate fingerprint for unbindable evidence so repeated
 * identical deliveries dedupe into one bounded failure-ledger row instead of
 * unbounded volume. Domain-separated from real effective fingerprints.
 */
export function computePackScoutBuybackEvUnbindableFingerprintV1(input: {
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerSourceRevisionId: string;
  readonly evidence: Extract<
    PackScoutBuybackEvEvidenceOutcomeV1,
    { status: "unavailable" }
  >;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        hashDomain: UNBINDABLE_HASH_DOMAIN,
        organizationId: input.organizationId,
        providerId: input.providerId,
        providerSourceRevisionId: input.providerSourceRevisionId,
        product: input.evidence.product,
        observation: input.evidence.observation,
        dataAsOf: input.evidence.dataAsOf,
        internalReasons: [...input.evidence.internalReasons],
      }),
    )
    .digest("hex");
}

function usableDataAsOf(
  dataAsOf: Extract<
    PackScoutBuybackEvEvidenceOutcomeV1,
    { status: "unavailable" }
  >["dataAsOf"],
  calculatedAtMillis: number,
): Readonly<{ state: "known"; observedAt: string }> | Readonly<{
  state: "unknown_source_time";
  observedAt: null;
}> {
  if (dataAsOf.state !== "known") {
    return { state: "unknown_source_time", observedAt: null };
  }
  const observedAtMillis = parsePackScoutBuybackEvTimestampMillisV1(
    dataAsOf.observedAt,
  );
  // An observation later than the calculation clock has no usable source
  // time; mirror the task-002 calculator and fail closed on the clock.
  return observedAtMillis !== null && observedAtMillis <= calculatedAtMillis
    ? { state: "known", observedAt: dataAsOf.observedAt }
    : { state: "unknown_source_time", observedAt: null };
}

/**
 * Synthesizes the deterministic unavailable task-002-shaped calculation for
 * one canonical unavailable evidence outcome, so it can persist through the
 * task-005 boundary exactly like a calculator result. Bindable evidence keeps
 * its provenance; unbindable evidence carries a null provenance plus the
 * `MISSING_PROVENANCE` reason, which the store routes to the deduplicated
 * failure ledger instead of a revision.
 */
export function synthesizePackScoutBuybackEvUnavailableCalculationV1(input: {
  readonly evidence: Extract<
    PackScoutBuybackEvEvidenceOutcomeV1,
    { status: "unavailable" }
  >;
  readonly calculatedAt: string;
  readonly binding: PackScoutBuybackEvRecomputationBindingV1;
}): PackScoutBuybackEvProtectedCalculationResultV1 {
  const calculatedAtMillis = parsePackScoutBuybackEvTimestampMillisV1(
    input.calculatedAt,
  );
  if (calculatedAtMillis === null) {
    throw new RangeError(
      "PackScout EV recomputation requires a canonical calculation clock.",
    );
  }
  const dataAsOf = usableDataAsOf(input.evidence.dataAsOf, calculatedAtMillis);
  const reasons: PackScoutBuybackEvInternalReasonCodeV1[] = [
    ...input.evidence.internalReasons,
  ];
  if (dataAsOf.state === "unknown_source_time") {
    reasons.push("MISSING_SOURCE_TIME");
  }
  const provenance =
    input.binding.kind === "bindable"
      ? {
        providerKey: input.binding.platformKey,
        productKey: input.binding.productKey,
        productRevisionId: input.binding.productRevisionId,
        sourceRevisionId: input.binding.sourceRevisionId,
        sourceManifestSha256: input.binding.sourceManifestSha256,
        observationCoherence: input.binding.observationCoherence,
        oddsSource: PACKSCOUT_BUYBACK_EV_RECOMPUTATION_SYNTHETIC_ODDS_SOURCE,
        usedClosedRangeMidpoint: false,
      }
      : null;
  if (provenance === null) {
    reasons.push("MISSING_PROVENANCE");
  }
  const internalReasons = [
    ...canonicalizePackScoutBuybackEvInternalReasonsV1(reasons),
  ];
  return packScoutBuybackEvProtectedCalculationResultV1Schema.parse({
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    status: "unavailable",
    grossEvMoney: null,
    grossReturnBasisPoints: null,
    evDollars: null,
    evPercentBasisPoints: null,
    calculatedAt: input.calculatedAt,
    dataAsOf,
    provenance,
    protectedEvidence: null,
    confidenceInput: {
      schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
      oddsSource: null,
      usedClosedRangeMidpoint: false,
      oldestEssentialObservedAt: dataAsOf.observedAt,
      calculatedAt: input.calculatedAt,
      availabilityGate: {
        status: "failed",
        internalReasons: [...internalReasons],
      },
    },
    internalReasons,
    publicPrimaryReason:
      packScoutBuybackEvPublicReasonForInternalReasonsV1(internalReasons),
  });
}

/**
 * Aligns an unavailable calculation with the approved freshness boundary
 * before composition: known evidence older than 60 minutes at the calculation
 * clock carries the `STALE_EVIDENCE` reason the composed protected-result
 * contract requires. Available calculations and unknown-source-time states
 * pass through untouched; the alignment is deterministic in the calculation.
 */
export function alignPackScoutBuybackEvCalculationFreshnessV1(
  calculation: PackScoutBuybackEvProtectedCalculationResultV1,
): PackScoutBuybackEvProtectedCalculationResultV1 {
  if (
    calculation.status !== "unavailable" ||
    calculation.dataAsOf.state !== "known" ||
    calculation.internalReasons.includes("STALE_EVIDENCE")
  ) {
    return calculation;
  }
  const sourceAgeMilliseconds =
    Date.parse(calculation.calculatedAt) -
    Date.parse(calculation.dataAsOf.observedAt);
  if (sourceAgeMilliseconds <= PACKSCOUT_BUYBACK_EV_SOURCE_AGE_EXPIRY_MILLISECONDS) {
    return calculation;
  }
  const internalReasons = [
    ...canonicalizePackScoutBuybackEvInternalReasonsV1([
      ...calculation.internalReasons,
      "STALE_EVIDENCE",
    ]),
  ];
  return packScoutBuybackEvProtectedCalculationResultV1Schema.parse({
    ...calculation,
    confidenceInput: {
      ...calculation.confidenceInput,
      availabilityGate: {
        status: "failed",
        internalReasons: [...internalReasons],
      },
    },
    internalReasons,
    publicPrimaryReason:
      packScoutBuybackEvPublicReasonForInternalReasonsV1(internalReasons),
  });
}

/**
 * Whether the task-003 evaluator may run for this calculation. A failed
 * availability gate whose known evidence is still inside the 60-minute window
 * deliberately has no confidence evaluation; the unavailable calculation owns
 * that state and the store composes its freshness directly.
 */
export function packScoutBuybackEvEvaluationIsResolvableV1(
  calculation: PackScoutBuybackEvProtectedCalculationResultV1,
): boolean {
  if (calculation.confidenceInput.availabilityGate.status === "passed") {
    return true;
  }
  const observedAt = calculation.confidenceInput.oldestEssentialObservedAt;
  if (observedAt === null) {
    return true;
  }
  const sourceAgeMilliseconds =
    Date.parse(calculation.calculatedAt) - Date.parse(observedAt);
  return (
    sourceAgeMilliseconds > PACKSCOUT_BUYBACK_EV_SOURCE_AGE_EXPIRY_MILLISECONDS
  );
}
