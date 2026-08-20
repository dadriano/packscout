/**
 * Shared vocabulary and derivations for the pipeline's background work that is
 * not a provider import run: the estimated-EV recomputation queue and the
 * protected-payload retention executions.
 *
 * The backlog measures below are the single server-side evaluation of that
 * work. The admin renders them and alerting consumes the same functions, so
 * the browser never recomputes a threshold and the two surfaces cannot drift.
 */

import { z } from "zod";
import type { WorkerEffectiveSettings } from "./worker-presence.ts";

/** Browser-facing queue states. `pending` and `claimed` map to the durable
 * `queued` and `running` states; the durable names stay in the database. */
export const recomputationQueueStates = [
  "pending",
  "claimed",
  "failed",
  "completed",
] as const;

export type RecomputationQueueState =
  (typeof recomputationQueueStates)[number];

export const recomputationRecoveryActions = ["release", "requeue"] as const;

export type RecomputationRecoveryAction =
  (typeof recomputationRecoveryActions)[number];

/**
 * Per-entry recovery outcomes. `already_resolved` is the clean conflict a
 * concurrently completing worker produces: the worker won, nothing was lost,
 * and nothing was processed twice.
 */
export const recomputationRecoveryOutcomes = [
  "released",
  "requeued",
  "already_resolved",
  "claim_active",
  "not_found",
] as const;

export type RecomputationRecoveryOutcome =
  (typeof recomputationRecoveryOutcomes)[number];

/** The largest set of entries one recovery request may act on. */
export const RECOMPUTATION_RECOVERY_SELECTION_LIMIT = 25;

export const recomputationRequestIdSchema = z.uuid();

export const recomputationRecoveryRequestSchema = z
  .object({ action: z.enum(recomputationRecoveryActions) })
  .strict();

export const recomputationRecoveryBulkRequestSchema = z
  .object({
    action: z.enum(recomputationRecoveryActions),
    requestIds: z
      .array(z.uuid())
      .min(1)
      .max(RECOMPUTATION_RECOVERY_SELECTION_LIMIT),
  })
  .strict()
  .refine(
    ({ requestIds }) => new Set(requestIds).size === requestIds.length,
    { message: "background_work.duplicate_id", path: ["requestIds"] },
  );

export type RecomputationRecoveryRequest = z.input<
  typeof recomputationRecoveryRequestSchema
>;
export type RecomputationRecoveryBulkRequest = z.input<
  typeof recomputationRecoveryBulkRequestSchema
>;

export interface RecomputationQueueEntry {
  readonly id: string;
  readonly providerId: string;
  readonly platformKey: string;
  readonly state: RecomputationQueueState;
  /** Opaque, non-identifying handle for the pack the request recalculates. */
  readonly packReference: string;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly availableAt: string;
  readonly completedAt: string | null;
  /** Worker instance identity holding the claim, matching worker presence. */
  readonly claimedBy: string | null;
  readonly claimExpiresAt: string | null;
  readonly claimAgeMs: number | null;
  readonly claimExpired: boolean;
  readonly failureCode: string | null;
  readonly failureSummary: string | null;
}

export interface RecomputationRecoveryResult {
  readonly requestId: string;
  readonly outcome: RecomputationRecoveryOutcome;
  readonly entry: RecomputationQueueEntry | null;
}

export const retentionExecutionStates = [
  "running",
  "succeeded",
  "failed",
] as const;

export type RetentionExecutionState =
  (typeof retentionExecutionStates)[number];

export interface RetentionExecutionSummary {
  readonly id: string;
  readonly state: RetentionExecutionState;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly cutoffAt: string;
  readonly pruned: {
    readonly pages: number;
    readonly sourceRecords: number;
    readonly quarantines: number;
    readonly total: number;
  };
  readonly alreadyExpired: number;
  readonly remaining: number;
  readonly failureCode: string | null;
  readonly failureSummary: string | null;
}

export type RecomputationBacklogState =
  /** No published worker settings, so nothing says what "timely" means yet. */
  | "unknown"
  /** No pending, claimed, or failed work. */
  | "idle"
  /** Work is moving inside the published timeliness window. */
  | "healthy"
  /** Work is waiting past the window, a claim expired, or entries failed. */
  | "backlogged";

export interface RecomputationBacklogFacts {
  readonly now: string;
  readonly pending: number;
  readonly readyPending: number;
  readonly claimed: number;
  readonly expiredClaims: number;
  readonly failed: number;
  readonly oldestPendingAvailableAt: string | null;
  readonly timelyAfterMs: number | null;
}

export interface RecomputationBacklogEvaluation {
  readonly state: RecomputationBacklogState;
  /** Work still owed: everything queued plus everything currently claimed. */
  readonly depth: number;
  readonly pending: number;
  readonly readyPending: number;
  readonly claimed: number;
  readonly expiredClaims: number;
  readonly failed: number;
  readonly oldestPendingAgeMs: number | null;
  readonly timelyAfterMs: number | null;
}

export type RetentionCadenceState =
  /** No published worker settings, so no expected interval exists yet. */
  | "unknown"
  /** Retention has never recorded an execution for this workspace. */
  | "never_observed"
  /** An execution started inside the expected interval. */
  | "current"
  /** Nothing recent, but the last execution left no work behind. */
  | "idle"
  /** Work remained, or an execution never finished, past the interval. */
  | "overdue";

export interface RetentionCadenceFacts {
  readonly now: string;
  readonly expectedIntervalMs: number | null;
  readonly latest: Pick<
    RetentionExecutionSummary,
    "state" | "startedAt" | "finishedAt" | "remaining"
  > | null;
}

export interface RetentionCadenceEvaluation {
  readonly state: RetentionCadenceState;
  readonly expectedIntervalMs: number | null;
  readonly sinceLastStartMs: number | null;
  readonly overdueByMs: number | null;
  readonly lastOutcome: RetentionExecutionState | null;
  readonly knownRemaining: number | null;
}

function elapsedMs(from: string | null, now: string): number | null {
  if (from === null) return null;
  const started = Date.parse(from);
  const observed = Date.parse(now);
  if (!Number.isFinite(started) || !Number.isFinite(observed)) return null;
  return Math.max(0, observed - started);
}

function safeCount(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * The single timeliness threshold both background-work evaluations use, taken
 * from the settings the worker fleet actually published rather than a copy
 * kept here. The most permissive published window wins so a fleet running
 * mixed settings produces the fewest false backlog signals. Returns `null`
 * when no instance has published settings — an absent fleet is a worker
 * problem, not a backlog problem.
 */
export function resolveBackgroundWorkTimelinessMs(
  publishedSettings: readonly WorkerEffectiveSettings[],
): number | null {
  let timeliness: number | null = null;
  for (const settings of publishedSettings) {
    const candidate = settings.presenceStaleAfterMs;
    if (!Number.isInteger(candidate) || candidate <= 0) continue;
    if (timeliness === null || candidate > timeliness) timeliness = candidate;
  }
  return timeliness;
}

/**
 * Queue depth and oldest-pending age, plus the state the admin badges and
 * alerting both key off. Expired claims and failed entries count as backlog
 * because both are work no worker will pick up without an operator.
 */
export function evaluateRecomputationBacklog(
  facts: RecomputationBacklogFacts,
): RecomputationBacklogEvaluation {
  const pending = safeCount(facts.pending);
  const readyPending = Math.min(pending, safeCount(facts.readyPending));
  const claimed = safeCount(facts.claimed);
  const expiredClaims = Math.min(claimed, safeCount(facts.expiredClaims));
  const failed = safeCount(facts.failed);
  const oldestPendingAgeMs = elapsedMs(
    facts.oldestPendingAvailableAt,
    facts.now,
  );
  const timelyAfterMs =
    facts.timelyAfterMs !== null &&
    Number.isInteger(facts.timelyAfterMs) &&
    facts.timelyAfterMs > 0
      ? facts.timelyAfterMs
      : null;
  const evaluation = {
    depth: pending + claimed,
    pending,
    readyPending,
    claimed,
    expiredClaims,
    failed,
    oldestPendingAgeMs,
    timelyAfterMs,
  };
  if (evaluation.depth === 0 && failed === 0) {
    return { state: "idle", ...evaluation };
  }
  if (expiredClaims > 0 || failed > 0) {
    return { state: "backlogged", ...evaluation };
  }
  if (timelyAfterMs === null) return { state: "unknown", ...evaluation };
  const waiting = oldestPendingAgeMs ?? 0;
  return {
    state: waiting > timelyAfterMs ? "backlogged" : "healthy",
    ...evaluation,
  };
}

/**
 * Whether retention has run recently enough. Retention only records an
 * execution when a workspace has expired evidence to clear, so silence alone
 * is not a fault: an interval that lapsed after an execution that left nothing
 * behind reads as `idle`, while a lapse with known remaining work — or an
 * execution that never finished — reads as `overdue`.
 */
export function evaluateRetentionCadence(
  facts: RetentionCadenceFacts,
): RetentionCadenceEvaluation {
  const expectedIntervalMs =
    facts.expectedIntervalMs !== null &&
    Number.isInteger(facts.expectedIntervalMs) &&
    facts.expectedIntervalMs > 0
      ? facts.expectedIntervalMs
      : null;
  const latest = facts.latest;
  const sinceLastStartMs = elapsedMs(latest?.startedAt ?? null, facts.now);
  const knownRemaining = latest ? safeCount(latest.remaining) : null;
  const base = {
    expectedIntervalMs,
    sinceLastStartMs,
    overdueByMs: null,
    lastOutcome: latest?.state ?? null,
    knownRemaining,
  } as const;
  if (expectedIntervalMs === null) return { state: "unknown", ...base };
  if (latest === null || sinceLastStartMs === null) {
    return { state: "never_observed", ...base };
  }
  if (sinceLastStartMs <= expectedIntervalMs) {
    return { state: "current", ...base };
  }
  const overdueByMs = sinceLastStartMs - expectedIntervalMs;
  const unfinished = latest.finishedAt === null || latest.state === "running";
  if (unfinished || (knownRemaining ?? 0) > 0) {
    return { state: "overdue", ...base, overdueByMs };
  }
  return { state: "idle", ...base, overdueByMs };
}
