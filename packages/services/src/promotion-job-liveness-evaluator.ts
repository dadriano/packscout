import type { ProviderDatabaseFailureCode } from "@packscout/contracts";
import type {
  PromotionJobSchedule,
  ProviderDatabaseOperationResult,
} from "@packscout/database";
import {
  evaluatePromotionJobScheduleLiveness,
  summarizePromotionJobLivenessCycle,
  type PromotionJobLivenessCycleSummary,
  type PromotionJobScheduleLiveness,
  type PromotionJobScheduleObservation,
} from "./promotion-job-liveness.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_]{0,52}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
// Reserve 15 seconds of the fixed one-minute cadence for persistence and
// condition delivery after provider observation completes.
const DEFAULT_PROVIDER_CYCLE_TIMEOUT_MS = 45_000;

export interface PromotionJobLivenessRosterEntry {
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerKey: string;
}

/**
 * One complete, immutable central-roster observation. Pagination belongs in
 * the source so the evaluator can never mistake a partial page for the roster.
 */
export interface PromotionJobLivenessRosterSnapshot {
  readonly rosterVersion: bigint;
  readonly rosterHighWater: bigint;
  readonly rosterDigest: string;
  readonly capturedAt: Date;
  readonly providers: readonly PromotionJobLivenessRosterEntry[];
}

export interface PromotionJobLivenessRosterSource {
  captureEligibleRoster(): Promise<PromotionJobLivenessRosterSnapshot>;
}

export interface ProviderPromotionScheduleSource {
  readSchedule(
    provider: PromotionJobLivenessRosterEntry,
    input: Readonly<{ deadlineAt: number }>,
  ): Promise<ProviderDatabaseOperationResult<PromotionJobSchedule>>;
}

export interface ManifestPromotionScheduleSource {
  readSchedule(): Promise<Readonly<{
    schedule: PromotionJobSchedule;
    observedAt: Date;
  }>>;
}

export type ProviderPromotionLivenessObservation = Readonly<{
  provider: PromotionJobLivenessRosterEntry;
  observedAt: Date;
  failureCode: ProviderDatabaseFailureCode | null;
  observation: PromotionJobScheduleObservation;
}>;

export interface SuccessfulPromotionJobLivenessCycle {
  readonly evaluatedAt: Date;
  readonly roster: PromotionJobLivenessRosterSnapshot;
  readonly providerObservations: readonly ProviderPromotionLivenessObservation[];
  readonly manifestObservation: Readonly<{
    observedAt: Date;
    judgment: PromotionJobScheduleLiveness;
  }>;
  readonly summary: PromotionJobLivenessCycleSummary;
}

export type PromotionJobLivenessCycleFailureCode =
  | "registry_enumeration_failed"
  | "manifest_schedule_unavailable"
  | "cycle_persistence_failed";

export interface PromotionJobLivenessCycleStore {
  /** Persists the cycle and condition transitions as one central transaction. */
  commitSuccessfulCycle(cycle: SuccessfulPromotionJobLivenessCycle): Promise<void>;
  /** Makes prior successful judgments stale; it must never fabricate a zero roster. */
  recordFailedCycle(input: Readonly<{
    evaluatedAt: Date;
    failureCode: PromotionJobLivenessCycleFailureCode;
    roster: PromotionJobLivenessRosterSnapshot | null;
  }>): Promise<void>;
}

export class PromotionJobLivenessCycleError extends Error {
  constructor(
    readonly code: PromotionJobLivenessCycleFailureCode,
    options?: { readonly cause?: unknown },
  ) {
    super("Promotion job liveness evaluation did not complete.", options);
    this.name = "PromotionJobLivenessCycleError";
  }
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function assertRoster(
  roster: PromotionJobLivenessRosterSnapshot,
): PromotionJobLivenessRosterSnapshot {
  if (
    roster.rosterVersion < 0n
    || roster.rosterHighWater < 0n
    || !SHA256_PATTERN.test(roster.rosterDigest)
    || !validDate(roster.capturedAt)
  ) throw new TypeError("Promotion job roster snapshot is invalid.");
  const providerIds = new Set<string>();
  const providerKeys = new Set<string>();
  for (const provider of roster.providers) {
    if (
      !UUID_PATTERN.test(provider.organizationId)
      || !UUID_PATTERN.test(provider.providerId)
      || !PROVIDER_KEY_PATTERN.test(provider.providerKey)
      || providerIds.has(provider.providerId)
      || providerKeys.has(provider.providerKey)
    ) throw new TypeError("Promotion job roster snapshot is invalid.");
    providerIds.add(provider.providerId);
    providerKeys.add(provider.providerKey);
  }
  return roster;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, worker),
  );
  return results;
}

type ProviderReadSettlement<T> =
  | { readonly state: "fulfilled"; readonly value: T }
  | { readonly state: "rejected" }
  | { readonly state: "timed_out" };

function settleProviderRead<T>(
  operation: () => Promise<T>,
  deadlineSignal: AbortSignal,
): Promise<ProviderReadSettlement<T>> {
  if (deadlineSignal.aborted) {
    return Promise.resolve({ state: "timed_out" });
  }
  const pending = Promise.resolve().then(operation);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result: ProviderReadSettlement<T>) => {
      if (finished) return;
      finished = true;
      deadlineSignal.removeEventListener("abort", expired);
      resolve(result);
    };
    const expired = () => finish({ state: "timed_out" });
    deadlineSignal.addEventListener("abort", expired, { once: true });
    if (deadlineSignal.aborted) expired();
    void pending.then(
      (value) => finish({ state: "fulfilled", value }),
      () => finish({ state: "rejected" }),
    );
  });
}

function scheduleProviderCycleDeadline(
  expire: () => void,
  timeoutMs: number,
): () => void {
  const timer = setTimeout(expire, timeoutMs);
  return () => clearTimeout(timer);
}

export interface PromotionJobLivenessEvaluatorOptions {
  readonly roster: PromotionJobLivenessRosterSource;
  readonly providers: ProviderPromotionScheduleSource;
  readonly manifest: ManifestPromotionScheduleSource;
  readonly store: PromotionJobLivenessCycleStore;
  readonly providerConcurrency?: number;
  readonly providerCycleTimeoutMs?: number;
  readonly scheduleProviderCycleDeadline?: (
    expire: () => void,
    timeoutMs: number,
  ) => () => void;
  readonly now?: () => Date;
}

/**
 * Reads split schedule authorities and commits one central observation cycle.
 * Provider failures are rows; roster, manifest, or persistence failures make
 * the whole cycle unsuccessful so old judgments cannot appear current.
 */
export class PromotionJobLivenessEvaluator {
  readonly #providerConcurrency: number;
  readonly #providerCycleTimeoutMs: number;
  readonly #scheduleProviderCycleDeadline: (
    expire: () => void,
    timeoutMs: number,
  ) => () => void;
  readonly #now: () => Date;

  constructor(private readonly options: PromotionJobLivenessEvaluatorOptions) {
    const concurrency = options.providerConcurrency ?? 8;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new TypeError("Promotion job provider concurrency is invalid.");
    }
    this.#providerConcurrency = concurrency;
    this.#providerCycleTimeoutMs = options.providerCycleTimeoutMs
      ?? DEFAULT_PROVIDER_CYCLE_TIMEOUT_MS;
    if (
      !Number.isInteger(this.#providerCycleTimeoutMs)
      || this.#providerCycleTimeoutMs < 100
      || this.#providerCycleTimeoutMs > 50_000
    ) {
      throw new TypeError("Promotion job provider cycle timeout is invalid.");
    }
    this.#scheduleProviderCycleDeadline = options.scheduleProviderCycleDeadline
      ?? scheduleProviderCycleDeadline;
    this.#now = options.now ?? (() => new Date());
  }

  async runCycle(): Promise<SuccessfulPromotionJobLivenessCycle> {
    const evaluatedAt = this.#now();
    if (!validDate(evaluatedAt)) {
      throw new TypeError("Promotion job evaluator time is invalid.");
    }
    const providerDeadlineAt = Date.now() + this.#providerCycleTimeoutMs;
    const providerDeadline = new AbortController();
    const cancelProviderDeadline = this.#scheduleProviderCycleDeadline(
      () => providerDeadline.abort(),
      this.#providerCycleTimeoutMs,
    );
    try {
      return await this.runCycleBeforeDeadline(
        evaluatedAt,
        providerDeadlineAt,
        providerDeadline.signal,
      );
    } finally {
      cancelProviderDeadline();
    }
  }

  private async runCycleBeforeDeadline(
    evaluatedAt: Date,
    providerDeadlineAt: number,
    providerDeadlineSignal: AbortSignal,
  ): Promise<SuccessfulPromotionJobLivenessCycle> {
    let roster: PromotionJobLivenessRosterSnapshot;
    try {
      roster = assertRoster(await this.options.roster.captureEligibleRoster());
    } catch (cause) {
      await this.recordFailure(evaluatedAt, "registry_enumeration_failed", null);
      throw new PromotionJobLivenessCycleError(
        "registry_enumeration_failed",
        { cause },
      );
    }

    let manifestObservation: SuccessfulPromotionJobLivenessCycle["manifestObservation"];
    try {
      const observed = await this.options.manifest.readSchedule();
      if (
        !validDate(observed.observedAt)
        || observed.schedule.authority !== "manifest_reconciliation"
      ) throw new TypeError("Manifest schedule evidence is invalid.");
      manifestObservation = {
        observedAt: new Date(observed.observedAt),
        judgment: evaluatePromotionJobScheduleLiveness(
          observed.schedule,
          evaluatedAt,
        ),
      };
    } catch (cause) {
      await this.recordFailure(
        evaluatedAt,
        "manifest_schedule_unavailable",
        roster,
      );
      throw new PromotionJobLivenessCycleError(
        "manifest_schedule_unavailable",
        { cause },
      );
    }

    const providerObservations = await mapWithConcurrency(
      roster.providers,
      this.#providerConcurrency,
      (provider) => this.observeProvider(
        provider,
        evaluatedAt,
        providerDeadlineAt,
        providerDeadlineSignal,
      ),
    );
    const summary = summarizePromotionJobLivenessCycle({
      providerObservations: providerObservations.map(({ observation }) =>
        observation),
      manifestObservation: {
        evidenceSource: "live",
        judgment: manifestObservation.judgment,
      },
    });
    const cycle: SuccessfulPromotionJobLivenessCycle = {
      evaluatedAt: new Date(evaluatedAt),
      roster,
      providerObservations,
      manifestObservation,
      summary,
    };
    try {
      await this.options.store.commitSuccessfulCycle(cycle);
    } catch (cause) {
      await this.recordFailure(
        evaluatedAt,
        "cycle_persistence_failed",
        roster,
      );
      throw new PromotionJobLivenessCycleError(
        "cycle_persistence_failed",
        { cause },
      );
    }
    return cycle;
  }

  private async observeProvider(
    provider: PromotionJobLivenessRosterEntry,
    evaluatedAt: Date,
    providerDeadlineAt: number,
    providerDeadlineSignal: AbortSignal,
  ): Promise<ProviderPromotionLivenessObservation> {
    const settlement = await settleProviderRead(
      () => this.options.providers.readSchedule(provider, {
        deadlineAt: providerDeadlineAt,
      }),
      providerDeadlineSignal,
    );
    if (settlement.state !== "fulfilled") {
      return this.unavailableProvider(
        provider,
        evaluatedAt,
        "database_unreachable",
      );
    }
    const result = settlement.value;
    if (result.state === "unreachable") {
      const observedAt = new Date(result.observedAt);
      return this.unavailableProvider(
        provider,
        validDate(observedAt) ? observedAt : evaluatedAt,
        result.failureCode,
      );
    }
    try {
      const observedAt = new Date(result.observedAt);
      if (
        result.providerId !== provider.providerId
        || result.value.authority !== "provider_publication"
        || !validDate(observedAt)
      ) throw new TypeError("Provider schedule evidence is invalid.");
      return {
        provider,
        observedAt,
        failureCode: null,
        observation: {
          evidenceSource: "live",
          judgment: evaluatePromotionJobScheduleLiveness(
            result.value,
            evaluatedAt,
          ),
        },
      };
    } catch {
      return this.unavailableProvider(
        provider,
        evaluatedAt,
        "database_schema_mismatch",
      );
    }
  }

  private unavailableProvider(
    provider: PromotionJobLivenessRosterEntry,
    observedAt: Date,
    failureCode: ProviderDatabaseFailureCode,
  ): ProviderPromotionLivenessObservation {
    return {
      provider,
      observedAt: new Date(observedAt),
      failureCode,
      observation: { evidenceSource: "unavailable", judgment: null },
    };
  }

  private async recordFailure(
    evaluatedAt: Date,
    failureCode: PromotionJobLivenessCycleFailureCode,
    roster: PromotionJobLivenessRosterSnapshot | null,
  ): Promise<void> {
    try {
      await this.options.store.recordFailedCycle({
        evaluatedAt: new Date(evaluatedAt),
        failureCode,
        roster,
      });
    } catch {
      // The thrown cycle error remains the authoritative signal to the
      // scheduler/watchdog when even the stale marker cannot be persisted.
    }
  }
}
