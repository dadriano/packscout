import type {
  RecalculatePackScoutEstimatedEvCommand,
  RecalculatePackScoutEstimatedEvResult,
} from "./estimated-ev-projection-contracts.ts";
import type { ProviderClock } from "./provider-configuration-service.ts";

const safeFailureCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const safeWorkerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

export interface EstimatedEvRecomputationClaim {
  readonly id: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly evInputExternalId: string;
  readonly packRevisionId: string | null;
  readonly evInputRevisionId: string | null;
  readonly claimToken: string;
  readonly attemptCount: number;
  readonly originatingPublicChangeSequence: bigint;
}

export interface EstimatedEvRecomputationQueue {
  claimBatch(input: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMilliseconds: number;
  }): Promise<readonly EstimatedEvRecomputationClaim[]>;
  complete(input: {
    requestId: string;
    claimToken: string;
    completedAt: Date;
    resultStatus: "estimated" | "unavailable";
    calculationRevisionId: string;
    outcomeReasonCode?: string;
    originatingPublicChangeSequence?: bigint;
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

export interface EstimatedEvCalculationPort {
  recalculate(
    command: RecalculatePackScoutEstimatedEvCommand,
  ): Promise<RecalculatePackScoutEstimatedEvResult>;
}

export interface EstimatedEvRecomputationCycleResult {
  readonly claimed: number;
  readonly completed: number;
  readonly estimated: number;
  readonly unavailable: number;
  readonly retrying: number;
  readonly failed: number;
  readonly lost: number;
  readonly capReached: boolean;
}

export interface EstimatedEvRecomputationProcessorOptions {
  readonly workerId: string;
  readonly maximumRequestsPerCycle?: number;
  readonly leaseMilliseconds?: number;
  readonly retryDelayMilliseconds?: number;
  readonly maximumAttempts?: number;
  readonly verifiedUsdStablecoins?: readonly string[];
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
  return "ESTIMATED_EV_RECOMPUTATION_FAILED";
}

export class EstimatedEvRecomputationProcessor {
  readonly #leaseMilliseconds: number;
  readonly #maximumAttempts: number;
  readonly #maximumRequestsPerCycle: number;
  readonly #retryDelayMilliseconds: number;
  readonly #verifiedUsdStablecoins: readonly string[];

  constructor(
    private readonly queue: EstimatedEvRecomputationQueue,
    private readonly calculations: EstimatedEvCalculationPort,
    private readonly clock: ProviderClock,
    private readonly options: EstimatedEvRecomputationProcessorOptions,
  ) {
    if (!safeWorkerIdPattern.test(options.workerId)) {
      throw new RangeError("Estimated EV worker ID is invalid.");
    }
    this.#maximumRequestsPerCycle = boundedInteger(
      options.maximumRequestsPerCycle,
      25,
      1,
      100,
      "Estimated EV cycle limit",
    );
    this.#leaseMilliseconds = boundedInteger(
      options.leaseMilliseconds,
      30_000,
      1_000,
      15 * 60_000,
      "Estimated EV lease",
    );
    this.#retryDelayMilliseconds = boundedInteger(
      options.retryDelayMilliseconds,
      1_000,
      0,
      15 * 60_000,
      "Estimated EV retry delay",
    );
    this.#maximumAttempts = boundedInteger(
      options.maximumAttempts,
      5,
      1,
      20,
      "Estimated EV maximum attempts",
    );
    this.#verifiedUsdStablecoins = [
      ...new Set(options.verifiedUsdStablecoins ?? []),
    ].sort();
  }

  async runCycle(): Promise<EstimatedEvRecomputationCycleResult> {
    const claims = await this.queue.claimBatch({
      workerId: this.options.workerId,
      now: this.clock.now(),
      limit: this.#maximumRequestsPerCycle,
      leaseMilliseconds: this.#leaseMilliseconds,
    });
    const counts = {
      completed: 0,
      estimated: 0,
      unavailable: 0,
      retrying: 0,
      failed: 0,
      lost: 0,
    };
    for (const claim of claims) {
      try {
        const result = await this.calculations.recalculate({
          organizationId: claim.organizationId,
          providerId: claim.providerId,
          configurationRevisionId: claim.configurationRevisionId,
          platformKey: claim.platformKey,
          packExternalId: claim.packExternalId,
          evInputExternalId: claim.evInputExternalId,
          calculatedAt: this.clock.now().toISOString(),
          currencyPolicy: {
            verifiedUsdStablecoins: this.#verifiedUsdStablecoins,
          },
        });
        const completed = await this.queue.complete({
          requestId: claim.id,
          claimToken: claim.claimToken,
          completedAt: this.clock.now(),
          resultStatus: result.explanation.status,
          calculationRevisionId: result.calculationRevisionId,
          ...(result.explanation.status === "unavailable"
            ? { outcomeReasonCode: result.explanation.reasonCodes[0] }
            : {}),
          originatingPublicChangeSequence:
            claim.originatingPublicChangeSequence,
        });
        if (!completed) {
          counts.lost += 1;
          continue;
        }
        counts.completed += 1;
        counts[result.explanation.status] += 1;
      } catch (error) {
        const failedAt = this.clock.now();
        const outcome = await this.queue.recordFailure({
          requestId: claim.id,
          claimToken: claim.claimToken,
          failedAt,
          retryAt: new Date(
            failedAt.getTime() + this.#retryDelayMilliseconds,
          ),
          failureCode: failureCode(error),
          maximumAttempts: this.#maximumAttempts,
        });
        counts[outcome] += 1;
      }
    }
    return {
      claimed: claims.length,
      ...counts,
      capReached: claims.length === this.#maximumRequestsPerCycle,
    };
  }
}
