import { parsePackScoutBuybackEvTimestampMillisV1 } from "@packscout/contracts";
import type {
  PackScoutBuybackEvRecomputationCommandV1,
  PackScoutBuybackEvRecomputationResultV1,
} from "./buyback-adjusted-ev-recomputation-contracts.ts";
import type { OperationalObservability } from "./operational-events.ts";
import type { ProviderClock } from "./provider-configuration-service.ts";

/**
 * Bounded work-lifecycle processor for buyback-adjusted EV recomputation
 * (task buyback-adjusted-ev/006), following the estimated-EV recomputation
 * pattern: a queue port hands out leased claims, the processor resolves each
 * claim through the recomputation boundary, and every terminal state is
 * durable exactly once.
 *
 * Scheduling, batch size, retry count, and duplicate-event volume are all
 * bounded here. A claim's command carries its own calculation clock, so a
 * retried or duplicated claim replays byte-identically and converges through
 * the store instead of minting history. Queue implementations must lease one
 * claim at most once concurrently and must not lease two claims for the same
 * product at the same time; ordering between claims is still resolved by the
 * recomputation boundary from essential source evidence, never arrival time.
 */

const safeFailureCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const safeWorkerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

export interface BuybackAdjustedEvRecomputationClaim {
  readonly id: string;
  readonly claimToken: string;
  readonly attemptCount: number;
  /** When the work item was scheduled; measures queue lag, never ordering. */
  readonly scheduledAt: string;
  readonly command: PackScoutBuybackEvRecomputationCommandV1;
}

export interface BuybackAdjustedEvRecomputationQueue {
  claimBatch(input: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMilliseconds: number;
  }): Promise<readonly BuybackAdjustedEvRecomputationClaim[]>;
  complete(input: {
    requestId: string;
    claimToken: string;
    completedAt: Date;
    resultStatus: PackScoutBuybackEvRecomputationResultV1["outcome"];
    revisionId: string | null;
    outcomeReasonCode?: string;
  }): Promise<boolean>;
  recordFailure(input: {
    requestId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureCode: string;
    maximumAttempts: number;
  }): Promise<"failed" | "lost" | "retrying">;
}

/** Implemented by `PackScoutBuybackAdjustedEvRecomputationService`. */
export interface BuybackAdjustedEvRecomputationPort {
  recompute(
    command: PackScoutBuybackEvRecomputationCommandV1,
  ): Promise<PackScoutBuybackEvRecomputationResultV1>;
}

export interface BuybackAdjustedEvRecomputationCycleResult {
  readonly claimed: number;
  readonly completed: number;
  readonly created: number;
  readonly unchanged: number;
  readonly superseded: number;
  readonly rejected: number;
  readonly unbindable: number;
  readonly unavailable: number;
  readonly retrying: number;
  readonly failed: number;
  readonly lost: number;
  readonly capReached: boolean;
}

export interface BuybackAdjustedEvRecomputationProcessorOptions {
  readonly workerId: string;
  readonly maximumRequestsPerCycle?: number;
  readonly leaseMilliseconds?: number;
  readonly retryDelayMilliseconds?: number;
  readonly maximumAttempts?: number;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${label} is outside its safe bounds.`);
  }
  return resolved;
}

function failureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    safeFailureCodePattern.test(error.code)
  ) {
    return error.code;
  }
  return "BUYBACK_EV_RECOMPUTATION_FAILED";
}

function outcomeReasonCode(
  result: PackScoutBuybackEvRecomputationResultV1,
): string | undefined {
  if (result.outcome === "rejected" || result.outcome === "unbindable") {
    return result.reason;
  }
  if (
    (result.outcome === "created" || result.outcome === "unchanged") &&
    result.status.publicReason !== null
  ) {
    return result.status.publicReason;
  }
  return undefined;
}

export class BuybackAdjustedEvRecomputationProcessor {
  readonly #leaseMilliseconds: number;
  readonly #maximumAttempts: number;
  readonly #maximumRequestsPerCycle: number;
  readonly #retryDelayMilliseconds: number;

  constructor(
    private readonly queue: BuybackAdjustedEvRecomputationQueue,
    private readonly recomputations: BuybackAdjustedEvRecomputationPort,
    private readonly clock: ProviderClock,
    private readonly options: BuybackAdjustedEvRecomputationProcessorOptions,
    private readonly operational?: OperationalObservability,
  ) {
    if (!safeWorkerIdPattern.test(options.workerId)) {
      throw new RangeError("Buyback EV recomputation worker ID is invalid.");
    }
    this.#maximumRequestsPerCycle = boundedInteger(
      options.maximumRequestsPerCycle,
      25,
      1,
      100,
      "Buyback EV recomputation cycle limit",
    );
    this.#leaseMilliseconds = boundedInteger(
      options.leaseMilliseconds,
      30_000,
      1_000,
      15 * 60_000,
      "Buyback EV recomputation lease",
    );
    this.#retryDelayMilliseconds = boundedInteger(
      options.retryDelayMilliseconds,
      1_000,
      0,
      15 * 60_000,
      "Buyback EV recomputation retry delay",
    );
    this.#maximumAttempts = boundedInteger(
      options.maximumAttempts,
      5,
      1,
      20,
      "Buyback EV recomputation maximum attempts",
    );
  }

  async runCycle(): Promise<BuybackAdjustedEvRecomputationCycleResult> {
    const claims = await this.queue.claimBatch({
      workerId: this.options.workerId,
      now: this.clock.now(),
      limit: this.#maximumRequestsPerCycle,
      leaseMilliseconds: this.#leaseMilliseconds,
    });
    const counts = {
      completed: 0,
      created: 0,
      unchanged: 0,
      superseded: 0,
      rejected: 0,
      unbindable: 0,
      unavailable: 0,
      retrying: 0,
      failed: 0,
      lost: 0,
    };
    for (const claim of claims) {
      this.reportQueueLag(claim);
      try {
        const result = await this.recomputations.recompute(claim.command);
        const revisionId =
          result.outcome === "created" || result.outcome === "unchanged"
            ? result.revision.revisionId
            : result.outcome === "superseded"
              ? result.currentRevision.revisionId
              : null;
        const reason = outcomeReasonCode(result);
        const completed = await this.queue.complete({
          requestId: claim.id,
          claimToken: claim.claimToken,
          completedAt: this.clock.now(),
          resultStatus: result.outcome,
          revisionId,
          ...(reason === undefined ? {} : { outcomeReasonCode: reason }),
        });
        if (!completed) {
          counts.lost += 1;
          continue;
        }
        counts.completed += 1;
        counts[result.outcome] += 1;
        if (
          (result.outcome === "created" || result.outcome === "unchanged") &&
          result.status.availability === "UNAVAILABLE"
        ) {
          counts.unavailable += 1;
        }
      } catch (error) {
        const failedAt = this.clock.now();
        const outcome = await this.queue.recordFailure({
          requestId: claim.id,
          claimToken: claim.claimToken,
          failedAt,
          retryAt: new Date(failedAt.getTime() + this.#retryDelayMilliseconds),
          failureCode: failureCode(error),
          maximumAttempts: this.#maximumAttempts,
        });
        counts[outcome] += 1;
        this.reportRetryOutcome(claim, outcome);
      }
    }
    return {
      claimed: claims.length,
      ...counts,
      capReached: claims.length === this.#maximumRequestsPerCycle,
    };
  }

  /** Queue lag as a bounded non-negative seconds metric; never money. */
  private reportQueueLag(claim: BuybackAdjustedEvRecomputationClaim): void {
    if (!this.operational) return;
    const scheduledAtMillis = parsePackScoutBuybackEvTimestampMillisV1(
      claim.scheduledAt,
    );
    if (scheduledAtMillis === null) return;
    const lagSeconds = Math.max(
      0,
      Math.floor((this.clock.now().getTime() - scheduledAtMillis) / 1_000),
    );
    try {
      this.operational.metric({
        name: "cursor_lag_proxy",
        value: lagSeconds,
        organizationId: claim.command.organizationId,
        providerId: claim.command.providerId,
        outcomeCode: "BUYBACK_EV_RECOMPUTATION_QUEUE",
      });
    } catch {
      // Claim processing must not depend on operational telemetry.
    }
  }

  private reportRetryOutcome(
    claim: BuybackAdjustedEvRecomputationClaim,
    outcome: "failed" | "lost" | "retrying",
  ): void {
    if (!this.operational) return;
    try {
      this.operational.metric({
        name: "retry_outcome_total",
        value: 1,
        organizationId: claim.command.organizationId,
        providerId: claim.command.providerId,
        outcomeCode: `BUYBACK_EV_RECOMPUTATION_${outcome.toUpperCase()}`,
      });
    } catch {
      // Claim processing must not depend on operational telemetry.
    }
  }
}
