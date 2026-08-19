import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  packScoutBuybackEvConfidenceEvaluationV1Schema,
  packScoutBuybackEvProtectedCalculationResultV1Schema,
  packScoutBuybackEvProtectedResultV1Schema,
  packScoutBuybackEvPublicReasonForInternalReasonsV1,
  type PackScoutBuybackEvConfidenceEvaluationV1,
  type PackScoutBuybackEvProtectedCalculationResultV1,
  type PackScoutBuybackEvProtectedProvenanceV1,
} from "@packscout/contracts";
import {
  computePackScoutBuybackEvCalculationIdentityKeyV1,
  computePackScoutBuybackEvFailureKeyV1,
  computePackScoutBuybackEvResultHashV1,
  sanitizePackScoutBuybackEvRevisionForPublicationV1,
  PACKSCOUT_BUYBACK_EV_REVISION_MAX_SOURCE_REFERENCES,
  type PackScoutBuybackEvCalculationIdentityV1,
  type PackScoutBuybackEvRevisionFreshnessV1,
  type PackScoutBuybackEvRevisionIdentityRecordV1,
  type PackScoutBuybackEvRevisionPublicationProjectionV1,
  type PackScoutBuybackEvRevisionRecordV1,
  type PackScoutBuybackEvRevisionSourceReferenceV1,
  type PackScoutBuybackEvRevisionTraceV1,
} from "./buyback-adjusted-ev-revision-contracts.ts";
import type { OperationalObservability } from "./operational-events.ts";

/**
 * Persistence boundary for task buyback-adjusted-ev/005.
 *
 * Accepts one completed protected calculation result, its task-003 confidence
 * evaluation where one exists, its normalized source revision references, and
 * its effective fingerprint. Returns one immutable revision identity plus the
 * sanitized publication projection. Identical completed fingerprints replay
 * to the existing revision without a duplicate write; reuse of a calculation
 * identity with different inputs or outputs is rejected; unbindable or
 * conflicting work only reaches the deduplicated failure ledger and can never
 * replace a completed revision or advance completed freshness.
 */

const HEX_64_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FRESHNESS_WINDOW_MILLISECONDS = 60 * 60_000;

export type PackScoutBuybackEvRevisionStoreErrorCode =
  | "CONTRACT_VIOLATION"
  | "UNSUPPORTED_METHOD_VERSION";

export class PackScoutBuybackEvRevisionStoreError extends Error {
  constructor(
    readonly code: PackScoutBuybackEvRevisionStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PackScoutBuybackEvRevisionStoreError";
  }
}

export interface PersistBuybackEvRevisionPortInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly platformKey: string;
  readonly productKey: string;
  readonly productRevisionId: string;
  readonly status: "available" | "unavailable";
  readonly calculationKey: string;
  readonly effectiveFingerprint: string;
  readonly resultHash: string;
  readonly sourceRevisionId: string;
  readonly sourceManifestSha256: string | null;
  readonly observationCoherence: "provider_revision" | "guarded_collection";
  readonly oddsSource: "current_remaining_inventory" | "platform_published";
  readonly usedClosedRangeMidpoint: boolean;
  readonly calculatedAt: string;
  readonly dataAsOf: PackScoutBuybackEvRevisionRecordV1["dataAsOf"];
  readonly metrics: PackScoutBuybackEvRevisionRecordV1["metrics"];
  readonly confidence: PackScoutBuybackEvRevisionRecordV1["confidence"];
  readonly freshness: PackScoutBuybackEvRevisionFreshnessV1;
  readonly internalReasons: PackScoutBuybackEvRevisionRecordV1["internalReasons"];
  readonly publicPrimaryReason:
    PackScoutBuybackEvRevisionRecordV1["publicPrimaryReason"];
  readonly sourceReferences: readonly PackScoutBuybackEvRevisionSourceReferenceV1[];
}

/** Implemented by `BuybackEvRevisionRepository` in `@packscout/database`. */
export interface PackScoutBuybackEvRevisionPersistencePortV1 {
  persistCompletedRevision(
    input: PersistBuybackEvRevisionPortInput,
  ): Promise<
    | Readonly<{ outcome: "created"; row: PackScoutBuybackEvRevisionRecordV1 }>
    | Readonly<{ outcome: "unchanged"; row: PackScoutBuybackEvRevisionRecordV1 }>
    | Readonly<{ outcome: "identity_conflict" }>
    | Readonly<{ outcome: "result_conflict" }>
  >;
  recordPersistenceFailure(input: {
    readonly organizationId: string;
    readonly failureKey: string;
    readonly reasonCode:
      | "CONTRACT_VIOLATION"
      | "IDENTITY_REUSE_CONFLICT"
      | "RESULT_CONFLICT"
      | "UNBINDABLE_RESULT";
    readonly providerId: string | null;
    readonly platformKey: string | null;
    readonly productKey: string | null;
    readonly seenAt: string;
  }): Promise<Readonly<{ occurrenceCount: number; created: boolean }>>;
  getCurrentCompletedRevision(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly productKey: string;
    readonly methodVersion: string;
  }): Promise<PackScoutBuybackEvRevisionRecordV1 | null>;
  getRevisionTrace(input: {
    readonly organizationId: string;
    readonly revisionId: string;
  }): Promise<PackScoutBuybackEvRevisionTraceV1 | null>;
}

export interface PersistPackScoutBuybackEvRevisionCommandV1 {
  readonly organizationId: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  /** Expected to be a `PackScoutBuybackEvProtectedCalculationResultV1`. */
  readonly calculation: unknown;
  /**
   * Expected to be the task-003 `PackScoutBuybackEvConfidenceEvaluationV1`
   * for the same calculation, or null when the failed availability gate with
   * current evidence owns the unavailable state and no evaluation exists.
   */
  readonly confidenceEvaluation: unknown | null;
  readonly effectiveFingerprint: string;
  readonly sourceRevisions: readonly Readonly<{
    sourceRevisionId: string;
    sourceManifestSha256?: string | null;
    canonicalRevisionId?: string | null;
  }>[];
}

export type PersistPackScoutBuybackEvRevisionResultV1 =
  | Readonly<{
      outcome: "created" | "unchanged";
      revision: PackScoutBuybackEvRevisionIdentityRecordV1;
      projection: PackScoutBuybackEvRevisionPublicationProjectionV1;
    }>
  | Readonly<{
      outcome: "rejected";
      reason: "IDENTITY_REUSE_CONFLICT" | "RESULT_CONFLICT";
      occurrenceCount: number;
    }>
  | Readonly<{
      outcome: "failed";
      reason: "UNBINDABLE_RESULT";
      occurrenceCount: number;
    }>;

type ParsedCalculation = PackScoutBuybackEvProtectedCalculationResultV1;
type ParsedEvaluation = PackScoutBuybackEvConfidenceEvaluationV1;

/** The composed completed outcome the immutable revision will persist. */
interface ComposedCompletedRevision {
  readonly status: "available" | "unavailable";
  readonly metrics: PackScoutBuybackEvRevisionRecordV1["metrics"];
  readonly confidence: PackScoutBuybackEvRevisionRecordV1["confidence"];
  readonly freshness: PackScoutBuybackEvRevisionFreshnessV1;
  readonly dataAsOf: PackScoutBuybackEvRevisionRecordV1["dataAsOf"];
  readonly internalReasons: PackScoutBuybackEvRevisionRecordV1["internalReasons"];
  readonly publicPrimaryReason:
    PackScoutBuybackEvRevisionRecordV1["publicPrimaryReason"];
}

function violation(message: string): PackScoutBuybackEvRevisionStoreError {
  return new PackScoutBuybackEvRevisionStoreError("CONTRACT_VIOLATION", message);
}

function requireCanonicalUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw violation(`${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

function derivedFreshness(
  calculation: ParsedCalculation,
): PackScoutBuybackEvRevisionFreshnessV1 {
  if (calculation.dataAsOf.state !== "known") {
    return {
      state: "unknown_source_time",
      sourceAgeMilliseconds: null,
      expiresAt: null,
    };
  }
  const observedAtMilliseconds = Date.parse(calculation.dataAsOf.observedAt);
  const sourceAgeMilliseconds =
    Date.parse(calculation.calculatedAt) - observedAtMilliseconds;
  return {
    state:
      sourceAgeMilliseconds > FRESHNESS_WINDOW_MILLISECONDS
        ? "expired"
        : "current",
    sourceAgeMilliseconds,
    expiresAt: new Date(
      observedAtMilliseconds + FRESHNESS_WINDOW_MILLISECONDS,
    ).toISOString(),
  };
}

function evaluationFreshness(
  evaluation: ParsedEvaluation,
): PackScoutBuybackEvRevisionFreshnessV1 {
  return evaluation.freshness.state === "unknown_source_time"
    ? {
      state: "unknown_source_time",
      sourceAgeMilliseconds: null,
      expiresAt: null,
    }
    : {
      state: evaluation.freshness.state,
      sourceAgeMilliseconds: evaluation.freshness.sourceAgeMilliseconds,
      expiresAt: evaluation.freshness.expiresAt,
    };
}

/**
 * Composes the task-002 calculation with its task-003 confidence evaluation
 * into the completed outcome this revision persists, then re-validates the
 * full task-001 protected result contract so metric arithmetic, freshness
 * times, reason pairing, and confidence-evidence relationships are all proven
 * before anything is written.
 *
 * The calculator never scores freshness, so an available calculation whose
 * evaluation expired composes into an unavailable `STALE_EVIDENCE` revision;
 * a null evaluation is valid only for the failed-availability-gate state
 * whose known evidence is still current, which the confidence boundary
 * deliberately cannot express.
 */
function composeCompletedRevision(
  calculation: ParsedCalculation,
  evaluation: ParsedEvaluation | null,
): ComposedCompletedRevision {
  if (evaluation !== null) {
    if (evaluation.calculatedAt !== calculation.calculatedAt) {
      throw violation(
        "The confidence evaluation clock must match the calculation clock.",
      );
    }
    if (
      evaluation.dataAsOf.state !== calculation.dataAsOf.state ||
      evaluation.dataAsOf.observedAt !== calculation.dataAsOf.observedAt
    ) {
      throw violation(
        "The confidence evaluation data-as-of must match the calculation.",
      );
    }
  }
  let composed: ComposedCompletedRevision;
  if (calculation.status === "available") {
    if (evaluation === null) {
      throw violation(
        "An available calculation requires its confidence evaluation.",
      );
    }
    if (evaluation.status === "available") {
      composed = {
        status: "available",
        metrics: {
          packPriceMinorUnits:
            calculation.protectedEvidence.packPriceMoney.minorUnits,
          underlyingOutcomeEvMinorUnits:
            calculation.protectedEvidence.underlyingOutcomeEvMoney.minorUnits,
          drawMultiplier: calculation.protectedEvidence.drawMultiplier,
          grossEvMinorUnits: calculation.grossEvMoney.minorUnits,
          grossReturnBasisPoints: calculation.grossReturnBasisPoints,
          evDollarsMinorUnits: calculation.evDollars.minorUnits,
          evPercentBasisPoints: calculation.evPercentBasisPoints,
        },
        confidence: {
          scoreBasisPoints: evaluation.confidence.scoreBasisPoints,
          band: evaluation.confidence.band,
          limitationCodes: evaluation.confidence.limitationCodes,
        },
        freshness: evaluationFreshness(evaluation),
        dataAsOf: calculation.dataAsOf,
        internalReasons: [],
        publicPrimaryReason: null,
      };
    } else {
      if (evaluation.freshness.state !== "expired") {
        throw violation(
          "An available calculation only composes with an available or expired confidence evaluation.",
        );
      }
      composed = {
        status: "unavailable",
        metrics: null,
        confidence: null,
        freshness: evaluationFreshness(evaluation),
        dataAsOf: calculation.dataAsOf,
        internalReasons: ["STALE_EVIDENCE"],
        publicPrimaryReason: packScoutBuybackEvPublicReasonForInternalReasonsV1(
          ["STALE_EVIDENCE"],
        ),
      };
    }
  } else {
    if (evaluation !== null && evaluation.status !== "unavailable") {
      throw violation(
        "An unavailable calculation cannot carry an available confidence evaluation.",
      );
    }
    const freshness =
      evaluation === null
        ? derivedFreshness(calculation)
        : evaluationFreshness(evaluation);
    if (evaluation === null && freshness.state !== "current") {
      throw violation(
        "A missing confidence evaluation is only valid for current evidence owned by a failed availability gate.",
      );
    }
    composed = {
      status: "unavailable",
      metrics: null,
      confidence: null,
      freshness,
      dataAsOf: calculation.dataAsOf,
      internalReasons: calculation.internalReasons,
      publicPrimaryReason: calculation.publicPrimaryReason,
    };
  }
  const contractFreshness =
    evaluation !== null
      ? evaluation.freshness
      : composed.freshness.state === "current"
        ? {
          state: "current" as const,
          sourceAgeMilliseconds: composed.freshness.sourceAgeMilliseconds,
          expiresAt: composed.freshness.expiresAt,
        }
        : null;
  if (contractFreshness === null) {
    throw violation(
      "A missing confidence evaluation is only valid for current evidence owned by a failed availability gate.",
    );
  }
  const validated = packScoutBuybackEvProtectedResultV1Schema.safeParse(
    composed.status === "available" && calculation.status === "available"
      ? {
        schemaVersion: calculation.schemaVersion,
        methodVersion: calculation.methodVersion,
        confidencePolicyVersion: calculation.confidencePolicyVersion,
        visibility: calculation.visibility,
        status: "available",
        grossEvMoney: calculation.grossEvMoney,
        grossReturnBasisPoints: calculation.grossReturnBasisPoints,
        evDollars: calculation.evDollars,
        evPercentBasisPoints: calculation.evPercentBasisPoints,
        confidence:
          evaluation?.status === "available" ? evaluation.confidence : null,
        calculatedAt: calculation.calculatedAt,
        dataAsOf: calculation.dataAsOf,
        freshness: contractFreshness,
        provenance: calculation.provenance,
        protectedEvidence: calculation.protectedEvidence,
      }
      : {
        schemaVersion: calculation.schemaVersion,
        methodVersion: calculation.methodVersion,
        confidencePolicyVersion: calculation.confidencePolicyVersion,
        visibility: calculation.visibility,
        status: "unavailable",
        grossEvMoney: null,
        grossReturnBasisPoints: null,
        evDollars: null,
        evPercentBasisPoints: null,
        confidence: null,
        calculatedAt: calculation.calculatedAt,
        dataAsOf: calculation.dataAsOf,
        freshness: contractFreshness,
        provenance: calculation.provenance,
        protectedEvidence: null,
        internalReasons: composed.internalReasons,
        publicPrimaryReason: composed.publicPrimaryReason,
      },
  );
  if (!validated.success) {
    throw violation(
      "The calculation and confidence evaluation do not compose into a valid protected result.",
    );
  }
  return composed;
}

function normalizeSourceReferences(
  command: PersistPackScoutBuybackEvRevisionCommandV1,
  provenance: PackScoutBuybackEvProtectedProvenanceV1,
): readonly PackScoutBuybackEvRevisionSourceReferenceV1[] {
  if (
    command.sourceRevisions.length < 1 ||
    command.sourceRevisions.length >
      PACKSCOUT_BUYBACK_EV_REVISION_MAX_SOURCE_REFERENCES
  ) {
    throw violation(
      `sourceRevisions must contain between 1 and ${PACKSCOUT_BUYBACK_EV_REVISION_MAX_SOURCE_REFERENCES} references.`,
    );
  }
  const seen = new Set<string>();
  const references = command.sourceRevisions.map((reference, index) => {
    if (seen.has(reference.sourceRevisionId)) {
      throw violation("sourceRevisions must not repeat a source revision.");
    }
    seen.add(reference.sourceRevisionId);
    return {
      referenceIndex: index,
      sourceRevisionId: reference.sourceRevisionId,
      sourceManifestSha256: reference.sourceManifestSha256 ?? null,
      canonicalRevisionId: reference.canonicalRevisionId ?? null,
    };
  });
  if (!seen.has(provenance.sourceRevisionId)) {
    throw violation(
      "sourceRevisions must include the governing observation source revision.",
    );
  }
  return references;
}

export class PackScoutBuybackEvRevisionStore {
  constructor(
    private readonly persistence: PackScoutBuybackEvRevisionPersistencePortV1,
    private readonly operational?: OperationalObservability,
  ) {}

  async persistCompletedCalculation(
    command: PersistPackScoutBuybackEvRevisionCommandV1,
  ): Promise<PersistPackScoutBuybackEvRevisionResultV1> {
    const organizationId = requireCanonicalUuid(
      command.organizationId,
      "organizationId",
    );
    const providerId = requireCanonicalUuid(command.providerId, "providerId");
    const configurationRevisionId = requireCanonicalUuid(
      command.configurationRevisionId,
      "configurationRevisionId",
    );
    if (!HEX_64_PATTERN.test(command.effectiveFingerprint)) {
      throw violation(
        "effectiveFingerprint must be a lowercase sha-256 hex digest.",
      );
    }
    const parsedCalculation =
      packScoutBuybackEvProtectedCalculationResultV1Schema.safeParse(
        command.calculation,
      );
    if (!parsedCalculation.success) {
      throw violation(
        "calculation must be a valid protected calculation result.",
      );
    }
    const calculation = parsedCalculation.data;
    let evaluation: ParsedEvaluation | null = null;
    if (command.confidenceEvaluation !== null) {
      const parsedEvaluation =
        packScoutBuybackEvConfidenceEvaluationV1Schema.safeParse(
          command.confidenceEvaluation,
        );
      if (!parsedEvaluation.success) {
        throw violation(
          "confidenceEvaluation must be a valid confidence evaluation.",
        );
      }
      evaluation = parsedEvaluation.data;
    }
    if (calculation.provenance === null) {
      return this.recordFailure({
        outcome: "failed",
        reason: "UNBINDABLE_RESULT",
        organizationId,
        providerId,
        platformKey: null,
        productKey: null,
        effectiveFingerprint: command.effectiveFingerprint,
        calculatedAt: calculation.calculatedAt,
      });
    }
    const provenance: PackScoutBuybackEvProtectedProvenanceV1 =
      calculation.provenance;
    const composed = composeCompletedRevision(calculation, evaluation);
    const identity: PackScoutBuybackEvCalculationIdentityV1 = {
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      platformKey: provenance.providerKey,
      productKey: provenance.productKey,
      productRevisionId: provenance.productRevisionId,
      sourceRevisionId: provenance.sourceRevisionId,
      sourceManifestSha256: provenance.sourceManifestSha256,
      observationCoherence: provenance.observationCoherence,
      configurationRevisionId,
    };
    const persisted = await this.persistence.persistCompletedRevision({
      organizationId,
      providerId,
      configurationRevisionId,
      platformKey: identity.platformKey,
      productKey: identity.productKey,
      productRevisionId: identity.productRevisionId,
      status: composed.status,
      calculationKey:
        computePackScoutBuybackEvCalculationIdentityKeyV1(identity),
      effectiveFingerprint: command.effectiveFingerprint,
      resultHash: computePackScoutBuybackEvResultHashV1({
        calculation,
        confidenceEvaluation: evaluation,
      }),
      sourceRevisionId: identity.sourceRevisionId,
      sourceManifestSha256: identity.sourceManifestSha256,
      observationCoherence: identity.observationCoherence,
      oddsSource: provenance.oddsSource,
      usedClosedRangeMidpoint: provenance.usedClosedRangeMidpoint,
      calculatedAt: calculation.calculatedAt,
      dataAsOf: composed.dataAsOf,
      metrics: composed.metrics,
      confidence: composed.confidence,
      freshness: composed.freshness,
      internalReasons: composed.internalReasons,
      publicPrimaryReason: composed.publicPrimaryReason,
      sourceReferences: normalizeSourceReferences(command, provenance),
    });
    if (persisted.outcome === "identity_conflict") {
      return this.recordFailure({
        outcome: "rejected",
        reason: "IDENTITY_REUSE_CONFLICT",
        organizationId,
        providerId,
        platformKey: identity.platformKey,
        productKey: identity.productKey,
        effectiveFingerprint: command.effectiveFingerprint,
        calculatedAt: calculation.calculatedAt,
      });
    }
    if (persisted.outcome === "result_conflict") {
      return this.recordFailure({
        outcome: "rejected",
        reason: "RESULT_CONFLICT",
        organizationId,
        providerId,
        platformKey: identity.platformKey,
        productKey: identity.productKey,
        effectiveFingerprint: command.effectiveFingerprint,
        calculatedAt: calculation.calculatedAt,
      });
    }
    const projection = sanitizePackScoutBuybackEvRevisionForPublicationV1(
      persisted.row,
    );
    this.report({
      organizationId,
      providerId,
      code:
        persisted.outcome === "unchanged"
          ? "BUYBACK_EV_REVISION_UNCHANGED"
          : persisted.row.status === "available"
            ? "BUYBACK_EV_REVISION_CREATED"
            : "BUYBACK_EV_REVISION_UNAVAILABLE",
      level: "info",
      occurredAt: calculation.calculatedAt,
      availability:
        persisted.outcome === "created"
          ? persisted.row.status === "available"
            ? "AVAILABLE"
            : "UNAVAILABLE"
          : null,
    });
    return {
      outcome: persisted.outcome,
      revision: {
        revisionId: persisted.row.revisionId,
        revisionNumber: persisted.row.revisionNumber,
        status: persisted.row.status,
        methodVersion: persisted.row.methodVersion,
        confidencePolicyVersion: persisted.row.confidencePolicyVersion,
        calculationKey: persisted.row.calculationKey,
        effectiveFingerprint: persisted.row.effectiveFingerprint,
        resultHash: persisted.row.resultHash,
        calculatedAt: persisted.row.calculatedAt,
      },
      projection,
    };
  }

  /**
   * Selects the current completed revision for the requested method version
   * and returns only its sanitized publication projection. Historical
   * pre-buyback results live outside this store and are never selected.
   */
  async getCurrentPublication(query: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly productKey: string;
    readonly methodVersion?: string;
  }): Promise<
    | Readonly<{
        revision: PackScoutBuybackEvRevisionIdentityRecordV1;
        projection: PackScoutBuybackEvRevisionPublicationProjectionV1;
      }>
    | null
  > {
    const methodVersion = query.methodVersion
      ?? PACKSCOUT_BUYBACK_EV_METHOD_VERSION;
    if (methodVersion !== PACKSCOUT_BUYBACK_EV_METHOD_VERSION) {
      throw new PackScoutBuybackEvRevisionStoreError(
        "UNSUPPORTED_METHOD_VERSION",
        "This store only serves packscout-buyback-adjusted-ev-v1 revisions.",
      );
    }
    const row = await this.persistence.getCurrentCompletedRevision({
      organizationId: requireCanonicalUuid(
        query.organizationId,
        "organizationId",
      ),
      platformKey: query.platformKey,
      productKey: query.productKey,
      methodVersion,
    });
    if (row === null) return null;
    if (row.lifecycle !== "completed" || row.methodVersion !== methodVersion) {
      throw violation("The persistence port returned a non-completed revision.");
    }
    return {
      revision: {
        revisionId: row.revisionId,
        revisionNumber: row.revisionNumber,
        status: row.status,
        methodVersion: row.methodVersion,
        confidencePolicyVersion: row.confidencePolicyVersion,
        calculationKey: row.calculationKey,
        effectiveFingerprint: row.effectiveFingerprint,
        resultHash: row.resultHash,
        calculatedAt: row.calculatedAt,
      },
      projection: sanitizePackScoutBuybackEvRevisionForPublicationV1(row),
    };
  }

  /** Protected trace for publication and launch verification (tasks 012/013). */
  async getRevisionTrace(query: {
    readonly organizationId: string;
    readonly revisionId: string;
  }): Promise<PackScoutBuybackEvRevisionTraceV1 | null> {
    return this.persistence.getRevisionTrace({
      organizationId: requireCanonicalUuid(
        query.organizationId,
        "organizationId",
      ),
      revisionId: requireCanonicalUuid(query.revisionId, "revisionId"),
    });
  }

  private async recordFailure(input: {
    readonly outcome: "rejected" | "failed";
    readonly reason:
      | "IDENTITY_REUSE_CONFLICT"
      | "RESULT_CONFLICT"
      | "UNBINDABLE_RESULT";
    readonly organizationId: string;
    readonly providerId: string;
    readonly platformKey: string | null;
    readonly productKey: string | null;
    readonly effectiveFingerprint: string;
    readonly calculatedAt: string;
  }): Promise<PersistPackScoutBuybackEvRevisionResultV1> {
    const { occurrenceCount } = await this.persistence.recordPersistenceFailure({
      organizationId: input.organizationId,
      failureKey: computePackScoutBuybackEvFailureKeyV1({
        effectiveFingerprint: input.effectiveFingerprint,
        reasonCode: input.reason,
      }),
      reasonCode: input.reason,
      providerId: input.providerId,
      platformKey: input.platformKey,
      productKey: input.productKey,
      seenAt: input.calculatedAt,
    });
    this.report({
      organizationId: input.organizationId,
      providerId: input.providerId,
      code: `BUYBACK_EV_REVISION_FAILED_${input.reason}`,
      level: "warning",
      occurredAt: input.calculatedAt,
      availability: null,
    });
    return input.outcome === "failed"
      ? { outcome: "failed", reason: "UNBINDABLE_RESULT", occurrenceCount }
      : {
        outcome: "rejected",
        reason:
          input.reason === "RESULT_CONFLICT"
            ? "RESULT_CONFLICT"
            : "IDENTITY_REUSE_CONFLICT",
        occurrenceCount,
      };
  }

  /**
   * Bounded operational reporting: outcome labels only, never money values,
   * evidence, or raw payloads. Telemetry failures never affect persistence.
   */
  private report(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly code: string;
    readonly level: "info" | "warning";
    readonly occurredAt: string;
    readonly availability: "AVAILABLE" | "UNAVAILABLE" | null;
  }): void {
    if (!this.operational) return;
    try {
      this.operational.log({
        event: "pipeline_measurement",
        level: input.level,
        organizationId: input.organizationId,
        providerId: input.providerId,
        code: input.code,
        occurredAt: input.occurredAt,
      });
      if (input.availability !== null) {
        this.operational.metric({
          name: "calculation_availability_total",
          value: 1,
          organizationId: input.organizationId,
          providerId: input.providerId,
          outcomeCode: input.availability,
        });
      }
    } catch {
      // A committed revision must not depend on operational telemetry.
    }
  }
}
