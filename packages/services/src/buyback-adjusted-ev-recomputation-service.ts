import {
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  packScoutBuybackEvEvidenceOutcomeV1Schema,
  parsePackScoutBuybackEvTimestampMillisV1,
  type PackScoutBuybackEvConfidenceEvaluationV1,
  type PackScoutBuybackEvEvidenceOutcomeV1,
  type PackScoutBuybackEvProtectedCalculationResultV1,
} from "@packscout/contracts";
import { calculatePackScoutBuybackAdjustedEvV1 } from "./buyback-adjusted-ev-calculator.ts";
import { evaluatePackScoutBuybackEvConfidenceV1 } from "./buyback-adjusted-ev-confidence.ts";
import {
  alignPackScoutBuybackEvCalculationFreshnessV1,
  computePackScoutBuybackEvRecomputationFingerprintV1,
  computePackScoutBuybackEvUnbindableFingerprintV1,
  derivePackScoutBuybackEvRecomputationBindingV1,
  packScoutBuybackEvEvaluationIsResolvableV1,
  synthesizePackScoutBuybackEvUnavailableCalculationV1,
  type PackScoutBuybackEvPublicationEligibilityV1,
  type PackScoutBuybackEvRecomputationBindingV1,
  type PackScoutBuybackEvRecomputationCommandV1,
  type PackScoutBuybackEvRecomputationResultV1,
  type PackScoutBuybackEvRecomputationSourceRevisionV1,
  type PackScoutBuybackEvRecomputationStatusV1,
} from "./buyback-adjusted-ev-recomputation-contracts.ts";
import type {
  PackScoutBuybackEvRevisionIdentityRecordV1,
  PackScoutBuybackEvRevisionPublicationProjectionV1,
} from "./buyback-adjusted-ev-revision-contracts.ts";
import type { PackScoutBuybackEvRevisionStore } from "./buyback-adjusted-ev-revision-store.ts";
import type { OperationalObservability } from "./operational-events.ts";

/**
 * Recomputation boundary for buyback-adjusted PackScout EV
 * (task buyback-adjusted-ev/006).
 *
 * Accepts one normalized task-004 evidence outcome per unit of work, resolves
 * the task-002 calculation and the task-003 confidence policy, and writes
 * exclusively through the task-005 immutable revision boundary. It returns
 * the completed revision identity, the bounded outcome state, and a bounded
 * operational status; no money values, provider payloads, credentials, or raw
 * source fields ever reach operational events.
 *
 * Convergence and idempotency rest on two rules:
 *
 * 1. The calculation clock is part of the work item, assigned once at
 *    scheduling. Concurrent duplicates and retries replay byte-identically
 *    and converge on one immutable completed revision via the store's replay
 *    semantics; an identical fingerprint that is already current returns
 *    `unchanged` without recalculating at all.
 * 2. Ordering uses essential source evidence, never wall-clock arrival. Work
 *    whose known essential source time is strictly older than the completed
 *    current revision's — and work with an unprovable (unknown) source time
 *    while ordered evidence is current — resolves as `superseded` and never
 *    becomes current or publishable. Redelivering the newest evidence always
 *    converges to the same current revision.
 *
 * See `buyback-adjusted-ev-recomputation-contracts.ts` for the change matrix
 * and the documented stale-transition resolution this service implements.
 */

const MAX_REPROCESS_BATCH = 100;

export type PackScoutBuybackEvRecomputationErrorCode = "CONTRACT_VIOLATION";

export class PackScoutBuybackEvRecomputationError extends Error {
  constructor(
    readonly code: PackScoutBuybackEvRecomputationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PackScoutBuybackEvRecomputationError";
  }
}

function violation(message: string): PackScoutBuybackEvRecomputationError {
  return new PackScoutBuybackEvRecomputationError(
    "CONTRACT_VIOLATION",
    message,
  );
}

function statusFromProjection(
  projection: PackScoutBuybackEvRevisionPublicationProjectionV1,
): PackScoutBuybackEvRecomputationStatusV1 {
  return projection.status === "available"
    ? {
      methodVersion: projection.methodVersion,
      confidencePolicyVersion: projection.confidencePolicyVersion,
      availability: "AVAILABLE",
      publicReason: null,
      sourceAgeMilliseconds: projection.sourceAgeMilliseconds,
    }
    : {
      methodVersion: projection.methodVersion,
      confidencePolicyVersion: projection.confidencePolicyVersion,
      availability: "UNAVAILABLE",
      publicReason: projection.publicReason,
      sourceAgeMilliseconds: null,
    };
}

interface CurrentPublication {
  readonly revision: PackScoutBuybackEvRevisionIdentityRecordV1;
  readonly projection: PackScoutBuybackEvRevisionPublicationProjectionV1;
}

export class PackScoutBuybackAdjustedEvRecomputationService {
  constructor(
    private readonly store: PackScoutBuybackEvRevisionStore,
    private readonly operational?: OperationalObservability,
  ) {}

  /**
   * Resolves one unit of recomputation work into exactly one bounded
   * outcome: `created`, `unchanged`, `superseded`, `rejected`, or
   * `unbindable`. Completed history is never mutated on any path.
   */
  async recompute(
    command: PackScoutBuybackEvRecomputationCommandV1,
  ): Promise<PackScoutBuybackEvRecomputationResultV1> {
    if (
      parsePackScoutBuybackEvTimestampMillisV1(command.calculatedAt) === null
    ) {
      throw violation(
        "calculatedAt must be a canonical UTC millisecond timestamp assigned once per work item.",
      );
    }
    const parsedEvidence = packScoutBuybackEvEvidenceOutcomeV1Schema.safeParse(
      command.evidence,
    );
    if (!parsedEvidence.success) {
      throw violation(
        "evidence must be a valid task-004 buyback EV evidence outcome.",
      );
    }
    const evidence = parsedEvidence.data;
    const binding = derivePackScoutBuybackEvRecomputationBindingV1(evidence);
    if (binding.kind === "unbindable") {
      if (evidence.status !== "unavailable") {
        // Unreachable: a complete input always carries a full binding.
        throw violation("Complete evidence always binds to a revision.");
      }
      return this.resolveUnbindable(command, evidence, binding);
    }

    const effectiveFingerprint =
      computePackScoutBuybackEvRecomputationFingerprintV1(
        binding,
        command.configurationRevisionId,
      );
    const current = await this.store.getCurrentPublication({
      organizationId: command.organizationId,
      platformKey: binding.platformKey,
      productKey: binding.productKey,
    });
    if (current !== null) {
      if (current.revision.effectiveFingerprint === effectiveFingerprint) {
        // Same governing evidence under any calculation clock: freshness and
        // availability recomputation replays to the immutable revision.
        this.log("BUYBACK_EV_RECOMPUTATION_UNCHANGED", "info", command);
        return {
          outcome: "unchanged",
          revision: current.revision,
          projection: current.projection,
          status: statusFromProjection(current.projection),
        };
      }
      if (this.isSuperseded(binding, current)) {
        this.log("BUYBACK_EV_RECOMPUTATION_SUPERSEDED", "info", command);
        return {
          outcome: "superseded",
          currentRevision: current.revision,
          status: statusFromProjection(current.projection),
        };
      }
    }

    const calculation = alignPackScoutBuybackEvCalculationFreshnessV1(
      evidence.status === "complete"
        ? calculatePackScoutBuybackAdjustedEvV1({
          input: evidence.input,
          calculatedAt: command.calculatedAt,
        })
        : synthesizePackScoutBuybackEvUnavailableCalculationV1({
          evidence,
          calculatedAt: command.calculatedAt,
          binding,
        }),
    );
    const persisted = await this.store.persistCompletedCalculation({
      organizationId: command.organizationId,
      providerId: command.providerId,
      configurationRevisionId: command.configurationRevisionId,
      calculation,
      confidenceEvaluation: this.resolveEvaluation(calculation),
      effectiveFingerprint,
      sourceRevisions: this.sourceRevisionsFor(command, binding),
    });
    if (persisted.outcome === "superseded") {
      // The persistence boundary re-proved ordering inside its transaction:
      // a concurrent recomputation completed strictly newer essential source
      // evidence between this service's read-check and the write. The store
      // refusal maps to the same bounded `superseded` outcome as the
      // read-time check, so older evidence never becomes current.
      this.log("BUYBACK_EV_RECOMPUTATION_SUPERSEDED", "info", command);
      return {
        outcome: "superseded",
        currentRevision: persisted.revision,
        status: statusFromProjection(persisted.projection),
      };
    }
    if (persisted.outcome === "rejected") {
      return {
        outcome: "rejected",
        reason: persisted.reason,
        occurrenceCount: persisted.occurrenceCount,
      };
    }
    if (persisted.outcome === "failed") {
      return {
        outcome: "unbindable",
        reason: "UNBINDABLE_RESULT",
        occurrenceCount: persisted.occurrenceCount,
      };
    }
    const status = statusFromProjection(persisted.projection);
    this.reportCompleted(command, status, persisted.outcome);
    return {
      outcome: persisted.outcome,
      revision: persisted.revision,
      projection: persisted.projection,
      status,
    };
  }

  /**
   * The exact completed revision eligible for the next repeatable publication
   * read, selected deterministically: the store's completed-current revision
   * for the approved method version, evaluated against the caller's read
   * clock. An available revision whose immutable evidence window has expired
   * is reported as `expired_since_calculation` so the publisher renders the
   * deterministic stale public state without any revision being mutated.
   * Repeating the read with the same `readAt` returns the same answer.
   */
  async getPublicationEligibleRevision(query: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly productKey: string;
    readonly readAt: string;
  }): Promise<PackScoutBuybackEvPublicationEligibilityV1 | null> {
    const readAtMillis = parsePackScoutBuybackEvTimestampMillisV1(query.readAt);
    if (readAtMillis === null) {
      throw violation(
        "readAt must be a canonical UTC millisecond timestamp.",
      );
    }
    const current = await this.store.getCurrentPublication({
      organizationId: query.organizationId,
      platformKey: query.platformKey,
      productKey: query.productKey,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    });
    if (current === null) {
      return null;
    }
    if (current.projection.status === "unavailable") {
      return {
        revision: current.revision,
        projection: current.projection,
        readState: { state: "publishable", availability: "UNAVAILABLE" },
        evaluatedAt: query.readAt,
      };
    }
    const expiresAtMillis = Date.parse(current.projection.expiresAt);
    return {
      revision: current.revision,
      projection: current.projection,
      readState:
        readAtMillis > expiresAtMillis
          ? {
            state: "expired_since_calculation",
            staleSince: current.projection.expiresAt,
          }
          : { state: "publishable", availability: "AVAILABLE" },
      evaluatedAt: query.readAt,
    };
  }

  /**
   * Recovery path: reprocesses a bounded batch of source-revision work items
   * through the identical recomputation flow. Completed history is immutable
   * on every path, so replayed evidence resolves as `unchanged` or
   * `superseded` and never rewrites, duplicates, or reorders revisions.
   */
  async reprocess(
    commands: readonly PackScoutBuybackEvRecomputationCommandV1[],
  ): Promise<{
    readonly outcomes: readonly PackScoutBuybackEvRecomputationResultV1[];
    readonly tally: Readonly<
      Record<PackScoutBuybackEvRecomputationResultV1["outcome"], number>
    >;
  }> {
    if (commands.length > MAX_REPROCESS_BATCH) {
      throw violation(
        `reprocess batches are bounded to ${MAX_REPROCESS_BATCH} work items.`,
      );
    }
    const outcomes: PackScoutBuybackEvRecomputationResultV1[] = [];
    const tally = {
      created: 0,
      unchanged: 0,
      superseded: 0,
      rejected: 0,
      unbindable: 0,
    };
    for (const command of commands) {
      const outcome = await this.recompute(command);
      outcomes.push(outcome);
      tally[outcome.outcome] += 1;
    }
    return { outcomes, tally };
  }

  /**
   * Source ordering, never arrival ordering: strictly older known essential
   * source time is superseded by the completed current revision, and evidence
   * whose source time is unknown cannot displace ordered current evidence.
   * Equal source times fall through to the store's identity rules, which
   * dedupe replays and reject conflicting identity reuse.
   */
  private isSuperseded(
    binding: Extract<
      PackScoutBuybackEvRecomputationBindingV1,
      { kind: "bindable" }
    >,
    current: CurrentPublication,
  ): boolean {
    const currentObservedAt = current.projection.dataAsOf.observedAt;
    if (currentObservedAt === null) {
      return false;
    }
    if (binding.observedAt === null) {
      return true;
    }
    return Date.parse(binding.observedAt) < Date.parse(currentObservedAt);
  }

  private resolveEvaluation(
    calculation: PackScoutBuybackEvProtectedCalculationResultV1,
  ): PackScoutBuybackEvConfidenceEvaluationV1 | null {
    return packScoutBuybackEvEvaluationIsResolvableV1(calculation)
      ? evaluatePackScoutBuybackEvConfidenceV1(calculation.confidenceInput)
      : null;
  }

  private sourceRevisionsFor(
    command: PackScoutBuybackEvRecomputationCommandV1,
    binding: Extract<
      PackScoutBuybackEvRecomputationBindingV1,
      { kind: "bindable" }
    >,
  ): readonly PackScoutBuybackEvRecomputationSourceRevisionV1[] {
    return command.sourceRevisions !== undefined &&
        command.sourceRevisions.length > 0
      ? command.sourceRevisions
      : [
        {
          sourceRevisionId: binding.sourceRevisionId,
          sourceManifestSha256: binding.sourceManifestSha256,
        },
      ];
  }

  /**
   * Evidence that cannot occupy any revision identity (no coherent
   * observation or no product identity) only ever reaches the deduplicated
   * failure ledger, keyed by a deterministic surrogate fingerprint so
   * repeated deliveries accumulate one bounded occurrence count.
   */
  private async resolveUnbindable(
    command: PackScoutBuybackEvRecomputationCommandV1,
    evidence: Extract<
      PackScoutBuybackEvEvidenceOutcomeV1,
      { status: "unavailable" }
    >,
    binding: Extract<
      PackScoutBuybackEvRecomputationBindingV1,
      { kind: "unbindable" }
    >,
  ): Promise<PackScoutBuybackEvRecomputationResultV1> {
    const persisted = await this.store.persistCompletedCalculation({
      organizationId: command.organizationId,
      providerId: command.providerId,
      configurationRevisionId: command.configurationRevisionId,
      calculation: synthesizePackScoutBuybackEvUnavailableCalculationV1({
        evidence,
        calculatedAt: command.calculatedAt,
        binding,
      }),
      confidenceEvaluation: null,
      effectiveFingerprint: computePackScoutBuybackEvUnbindableFingerprintV1({
        organizationId: command.organizationId,
        providerId: command.providerId,
        configurationRevisionId: command.configurationRevisionId,
        evidence,
      }),
      sourceRevisions: command.sourceRevisions ?? [],
    });
    if (persisted.outcome !== "failed") {
      throw violation(
        "Unbindable evidence must never occupy a completed revision.",
      );
    }
    return {
      outcome: "unbindable",
      reason: "UNBINDABLE_RESULT",
      occurrenceCount: persisted.occurrenceCount,
    };
  }

  private reportCompleted(
    command: PackScoutBuybackEvRecomputationCommandV1,
    status: PackScoutBuybackEvRecomputationStatusV1,
    outcome: "created" | "unchanged",
  ): void {
    if (outcome === "unchanged") {
      this.log("BUYBACK_EV_RECOMPUTATION_UNCHANGED", "info", command);
      return;
    }
    if (status.publicReason !== null) {
      this.log(
        `BUYBACK_EV_RECOMPUTATION_UNAVAILABLE_${status.publicReason}`,
        "warning",
        command,
      );
    }
    this.metric({
      name: "record_count",
      value: 1,
      organizationId: command.organizationId,
      providerId: command.providerId,
      outcomeCode: "PACKSCOUT_BUYBACK_ADJUSTED_EV_V1",
    });
    if (status.sourceAgeMilliseconds !== null) {
      this.metric({
        name: "freshness_age_seconds",
        value: Math.floor(status.sourceAgeMilliseconds / 1_000),
        organizationId: command.organizationId,
        providerId: command.providerId,
        outcomeCode: "BUYBACK_ADJUSTED_EV",
      });
    }
  }

  /**
   * Bounded operational reporting: outcome labels, counts, and ages only —
   * never money values, evidence, provider payloads, or raw source fields.
   * Telemetry failures never affect a resolved outcome.
   */
  private log(
    code: string,
    level: "info" | "warning",
    command: PackScoutBuybackEvRecomputationCommandV1,
  ): void {
    if (!this.operational) return;
    try {
      this.operational.log({
        event: "pipeline_measurement",
        level,
        organizationId: command.organizationId,
        providerId: command.providerId,
        code,
        occurredAt: command.calculatedAt,
      });
    } catch {
      // A resolved recomputation must not depend on operational telemetry.
    }
  }

  private metric(
    metric: Parameters<OperationalObservability["metric"]>[0],
  ): void {
    if (!this.operational) return;
    try {
      this.operational.metric(metric);
    } catch {
      // A resolved recomputation must not depend on operational telemetry.
    }
  }
}
