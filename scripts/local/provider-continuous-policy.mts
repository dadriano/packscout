import { z } from "zod";
import { assertBackfillPins, backfillDigest, backfillId, backfillPinsSchema, classifyBackfillCheckpoint,
  refuseBackfill, type BackfillPins, type BackfillSnapshot } from "./provider-backfill-supervisor-policy.mts";
import { ContinuousReadUnavailableError } from "./provider-continuous-read.mts";
import { residentFailureCode } from "./provider-resident-errors.mts";
import { backfillHasOwnedExpiredHeadLease } from "./provider-backfill-supervisor.mts";
export { ContinuousReadUnavailableError } from "./provider-continuous-read.mts";

// All integrations admitted by the existing closed DataForrest live registry use
// dataforrestContinuation's 60-second poll_after contract. No source call is needed.
export const continuousSourceMinimumSeconds = 60;
export const continuousObservationMilliseconds = 15_000;
export const continuousCycleSchema = z.object({ pins: backfillPinsSchema,
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u), parentRunId: z.string().uuid(),
  cycleOperationId: z.string().uuid(), runId: z.string().uuid(), commandId: z.string().uuid(),
  configNumber: z.string().regex(/^[1-9][0-9]*$/u), generation: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  checkpointHash: z.string().regex(/^[a-f0-9]{64}$/u), headFinishedAt: z.string().datetime(),
  notBefore: z.string().datetime(), createdAt: z.string().datetime(),
}).strict();
export type ContinuousCycle = z.infer<typeof continuousCycleSchema>;
export const continuousQueueOwner = (cycle: ContinuousCycle) => `local:continuous:${cycle.pins.operationId}:${cycle.cycleOperationId}`;
export interface ContinuousView {
  snapshot: BackfillSnapshot;
  cycle: ContinuousCycle | null;
  cycleQueued: boolean;
  scheduleSeconds: number;
  authorityDigest: string;
  ownedLeaseExpiresAt?: Date | null;
}
export function cyclePins(cycle: ContinuousCycle): BackfillPins {
  return { ...cycle.pins, initialRunId: cycle.runId, operationId: cycle.cycleOperationId };
}
export function continuousDueAt(snapshot: BackfillSnapshot, scheduleSeconds: number): Date {
  if (!Number.isSafeInteger(scheduleSeconds) || scheduleSeconds < 1 || !snapshot.run.finishedAt) {
    refuseBackfill("CONTINUOUS_CADENCE_INVALID");
  }
  const result = new Date(snapshot.run.finishedAt.getTime() + Math.max(scheduleSeconds, continuousSourceMinimumSeconds) * 1000);
  if (!Number.isFinite(result.getTime())) refuseBackfill("CONTINUOUS_CADENCE_INVALID");
  return result;
}
export function assertContinuousHead(snapshot: BackfillSnapshot, pins: BackfillPins, configNumber: bigint): void {
  assertBackfillPins(snapshot, pins, configNumber);
  if (snapshot.state !== "idle" || snapshot.checkpointHash === null || snapshot.lease.expiresAt !== null || !snapshot.run.finishedAt ||
    classifyBackfillCheckpoint(snapshot) !== "head") refuseBackfill("CONTINUOUS_HEAD_REQUIRED");
}
export function makeContinuousCycle(view: ContinuousView, pins: BackfillPins): ContinuousCycle {
  const s = view.snapshot;
  assertContinuousHead(s, pins, s.run.configNumber);
  const notBefore = continuousDueAt(s, view.scheduleSeconds);
  if (notBefore > s.now) refuseBackfill("CONTINUOUS_NOT_DUE");
  const cycleOperationId = backfillId(pins.operationId, `cycle/${s.run.id}`);
  return continuousCycleSchema.parse({ pins, authorityDigest: view.authorityDigest, parentRunId: s.run.id,
    cycleOperationId, runId: backfillId(cycleOperationId, "run"), commandId: backfillId(cycleOperationId, "command"),
    configNumber: s.run.configNumber.toString(), generation: s.generation.toString(), checkpointHash: s.checkpointHash,
    headFinishedAt: s.run.finishedAt!.toISOString(), notBefore: notBefore.toISOString(), createdAt: s.now.toISOString() });
}
export function assertContinuousCycle(cycle: ContinuousCycle, pins: BackfillPins, authorityDigest: string): void {
  if (backfillDigest(cycle.pins) !== backfillDigest(pins) || cycle.authorityDigest !== authorityDigest ||
    cycle.cycleOperationId !== backfillId(pins.operationId, `cycle/${cycle.parentRunId}`) ||
    cycle.runId !== backfillId(cycle.cycleOperationId, "run") || cycle.commandId !== backfillId(cycle.cycleOperationId, "command")) {
    refuseBackfill("CONTINUOUS_CYCLE_DRIFT");
  }
}
export type ContinuousDecision = { state: "paused" | "stopped" | "queue" | "execute" | "due" }
  | { state: "waiting"; nextDueAt: string; waitMilliseconds: number };
export function continuousDecision(view: ContinuousView, pins: BackfillPins): ContinuousDecision {
  const s = view.snapshot;
  assertBackfillPins(s, pins, s.run.configNumber);
  if (s.state === "stopped") return { state: "stopped" };
  if (s.state === "paused") return { state: "paused" };
  if (view.ownedLeaseExpiresAt && view.ownedLeaseExpiresAt > s.now) return { state: "waiting",
    nextDueAt: view.ownedLeaseExpiresAt.toISOString(),
    waitMilliseconds: Math.min(continuousObservationMilliseconds, view.ownedLeaseExpiresAt.getTime() - s.now.getTime()) };
  if (view.cycle && s.lease.owner === continuousQueueOwner(view.cycle)) {
    if (s.lease.expiresAt !== null && s.lease.expiresAt > s.now) return { state: "waiting",
      nextDueAt: s.lease.expiresAt.toISOString(), waitMilliseconds: Math.min(continuousObservationMilliseconds, s.lease.expiresAt.getTime() - s.now.getTime()) };
    return { state: "queue" };
  }
  if (view.cycle && !view.cycleQueued) return { state: "queue" };
  if (view.cycleQueued && backfillHasOwnedExpiredHeadLease(view)) return { state: "execute" };
  if (view.cycleQueued && classifyBackfillCheckpoint(s) !== "head") return { state: "execute" };
  assertContinuousHead(s, pins, s.run.configNumber);
  const next = continuousDueAt(s, view.scheduleSeconds);
  return next <= s.now ? { state: "due" } : { state: "waiting", nextDueAt: next.toISOString(),
    waitMilliseconds: Math.min(continuousObservationMilliseconds, next.getTime() - s.now.getTime()) };
}

export interface ContinuousPort {
  pins: BackfillPins;
  read(): Promise<ContinuousView>;
  persist(view: ContinuousView): Promise<void>;
  queue(cycle: ContinuousCycle): Promise<void>;
  execute(cycle: ContinuousCycle): Promise<"head" | "operator_stop">;
  wait(milliseconds: number): Promise<void>;
  emit(event: { state: string; runId?: string; nextDueAt?: string; code?: string }): void;
}
/** Only the nested backfill supervisor retries failures. Unknown/permanent errors
 * latch this resident observer blocked until an explicit operator restart. */
export async function superviseContinuousProvider(port: ContinuousPort, signal: AbortSignal): Promise<"stopped"> {
  let blocked: string | null = null;
  while (!signal.aborted) {
    let reading = true;
    try {
      const view = await port.read();
      reading = false;
      if (view.snapshot.state === "stopped") break;
      if (blocked !== null) {
        port.emit({ state: "blocked", code: blocked, runId: view.snapshot.run.id });
        await port.wait(continuousObservationMilliseconds); continue;
      }
      const decision = continuousDecision(view, port.pins);
      port.emit({ state: decision.state, runId: view.snapshot.run.id,
        ...(decision.state === "waiting" ? { nextDueAt: decision.nextDueAt } : {}) });
      if (signal.aborted || decision.state === "stopped") break;
      if (decision.state === "paused" || decision.state === "waiting") {
        await port.wait(decision.state === "waiting" ? decision.waitMilliseconds : continuousObservationMilliseconds);
      } else if (decision.state === "due") await port.persist(view);
      else if (decision.state === "queue") await port.queue(view.cycle!);
      else if (await port.execute(view.cycle!) === "operator_stop") {
        // A directly signalled child must not be automatically restarted.
        const after = await port.read();
        if (after.snapshot.state !== "paused") break;
      }
    } catch (error) {
      if (reading && error instanceof ContinuousReadUnavailableError) {
        port.emit({ state: blocked === null ? "read_unavailable" : "blocked", code: blocked ?? error.code });
        await port.wait(continuousObservationMilliseconds); continue;
      }
      blocked ??= residentFailureCode(error);
      port.emit({ state: "blocked", code: blocked });
      await port.wait(continuousObservationMilliseconds);
    }
  }
  port.emit({ state: "stopped" });
  return "stopped";
}
