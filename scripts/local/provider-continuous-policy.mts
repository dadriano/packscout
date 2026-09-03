import { z } from "zod";
import { assertBackfillPins, backfillDigest, backfillId, backfillPinsSchema, classifyBackfillCheckpoint,
  refuseBackfill, type BackfillPins, type BackfillSnapshot } from "./provider-backfill-supervisor-policy.mts";
import { ContinuousReadUnavailableError } from "./provider-continuous-read.mts";
import { residentFailureCode } from "./provider-resident-errors.mts";
import { backfillHasOwnedExpiredHeadLease } from "./provider-backfill-supervisor.mts";
import { continuousCadenceSchema, defaultContinuousCadence, effectiveContinuousIntervalSeconds,
  validatedContinuousCadence, type ContinuousCadence } from "./provider-continuous-cadence.mts";
import { continuousPostHeadPolicySchema, defaultContinuousPostHeadPolicy, validatedContinuousPostHeadPolicy,
  type ContinuousPostHeadPolicy } from "./provider-continuous-post-head-policy.mts";
export { ContinuousReadUnavailableError } from "./provider-continuous-read.mts";
export { continuousSourceMinimumSeconds } from "./provider-continuous-cadence.mts";

// All integrations admitted by the existing closed DataForrest live registry use
// dataforrestContinuation's 60-second poll_after contract. No source call is needed.
export const continuousObservationMilliseconds = 15_000;
/** Historical recovery evidence only; never an executable cadence-v2 receipt. */
export const historicalContinuousCycleSchema = z.object({ pins: backfillPinsSchema,
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u), parentRunId: z.string().uuid(),
  cycleOperationId: z.string().uuid(), runId: z.string().uuid(), commandId: z.string().uuid(),
  configNumber: z.string().regex(/^[1-9][0-9]*$/u), generation: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  checkpointHash: z.string().regex(/^[a-f0-9]{64}$/u), headFinishedAt: z.string().datetime(),
  notBefore: z.string().datetime(), createdAt: z.string().datetime(),
}).strict();
export const continuousCycleSchema = historicalContinuousCycleSchema.extend({ version: z.literal(2),
  cadence: continuousCadenceSchema, effectiveIntervalSeconds: z.number().int().min(60).max(86_400),
  postHeadPolicy: continuousPostHeadPolicySchema }).strict();
export type ContinuousCycle = z.infer<typeof continuousCycleSchema>;
export const continuousQueueOwner = (cycle: ContinuousCycle) => `local:continuous:${cycle.pins.operationId}:${cycle.cycleOperationId}`;
export interface ContinuousView {
  snapshot: BackfillSnapshot;
  cycle: ContinuousCycle | null;
  cycleQueued: boolean;
  scheduleSeconds: number;
  cadence: ContinuousCadence;
  postHeadPolicy: ContinuousPostHeadPolicy;
  authorityDigest: string;
  ownedLeaseExpiresAt?: Date | null;
}
export function cyclePins(cycle: ContinuousCycle): BackfillPins {
  return { ...cycle.pins, initialRunId: cycle.runId, operationId: cycle.cycleOperationId };
}
export function continuousDueAt(snapshot: BackfillSnapshot, scheduleSeconds: number,
  cadence: ContinuousCadence = defaultContinuousCadence): Date {
  if (!snapshot.run.finishedAt) {
    refuseBackfill("CONTINUOUS_CADENCE_INVALID");
  }
  const result = new Date(snapshot.run.finishedAt.getTime() + effectiveContinuousIntervalSeconds(scheduleSeconds, cadence) * 1000);
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
  const cadence = validatedContinuousCadence(view.cadence);
  const postHeadPolicy = validatedContinuousPostHeadPolicy(view.postHeadPolicy);
  const notBefore = continuousDueAt(s, view.scheduleSeconds, cadence);
  if (notBefore > s.now) refuseBackfill("CONTINUOUS_NOT_DUE");
  const cycleOperationId = backfillId(pins.operationId, `cycle/${s.run.id}`);
  return continuousCycleSchema.parse({ version: 2, pins, cadence, postHeadPolicy,
    effectiveIntervalSeconds: effectiveContinuousIntervalSeconds(view.scheduleSeconds, cadence),
    authorityDigest: view.authorityDigest, parentRunId: s.run.id,
    cycleOperationId, runId: backfillId(cycleOperationId, "run"), commandId: backfillId(cycleOperationId, "command"),
    configNumber: s.run.configNumber.toString(), generation: s.generation.toString(), checkpointHash: s.checkpointHash,
    headFinishedAt: s.run.finishedAt!.toISOString(), notBefore: notBefore.toISOString(), createdAt: s.now.toISOString() });
}
export function assertContinuousCycle(cycle: ContinuousCycle, pins: BackfillPins, authorityDigest: string,
  cadence: ContinuousCadence = defaultContinuousCadence, scheduleSeconds?: number,
  postHeadPolicy: ContinuousPostHeadPolicy = defaultContinuousPostHeadPolicy): void {
  const parsed = continuousCycleSchema.safeParse(cycle), selected = validatedContinuousCadence(cadence);
  const selectedPostHead = validatedContinuousPostHeadPolicy(postHeadPolicy);
  if (!parsed.success || backfillDigest(cycle.cadence) !== backfillDigest(selected) ||
    backfillDigest(cycle.postHeadPolicy) !== backfillDigest(selectedPostHead) ||
    (scheduleSeconds !== undefined && cycle.effectiveIntervalSeconds !== effectiveContinuousIntervalSeconds(scheduleSeconds, selected)) ||
    (selected.kind === "operator_interval" && cycle.effectiveIntervalSeconds !== selected.intervalSeconds) ||
    Date.parse(cycle.notBefore) !== Date.parse(cycle.headFinishedAt) + cycle.effectiveIntervalSeconds * 1000 ||
    Date.parse(cycle.createdAt) < Date.parse(cycle.notBefore) ||
    backfillDigest(cycle.pins) !== backfillDigest(pins) || cycle.authorityDigest !== authorityDigest ||
    cycle.cycleOperationId !== backfillId(pins.operationId, `cycle/${cycle.parentRunId}`) ||
    cycle.runId !== backfillId(cycle.cycleOperationId, "run") || cycle.commandId !== backfillId(cycle.cycleOperationId, "command")) {
    refuseBackfill("CONTINUOUS_CYCLE_DRIFT");
  }
}
export function assertHistoricalContinuousCycle(cycle: z.infer<typeof historicalContinuousCycleSchema>, pins: BackfillPins,
  authorityDigest: string): void {
  if (!historicalContinuousCycleSchema.safeParse(cycle).success || backfillDigest(cycle.pins) !== backfillDigest(pins) ||
    cycle.authorityDigest !== authorityDigest || cycle.cycleOperationId !== backfillId(pins.operationId, `cycle/${cycle.parentRunId}`) ||
    cycle.runId !== backfillId(cycle.cycleOperationId, "run") || cycle.commandId !== backfillId(cycle.cycleOperationId, "command")) {
    refuseBackfill("CONTINUOUS_CYCLE_DRIFT");
  }
}
export type ContinuousDecision = { state: "paused" | "stopped" | "queue" | "execute" | "due" }
  | { state: "waiting"; nextDueAt: string; waitMilliseconds: number };
export function continuousDecision(view: ContinuousView, pins: BackfillPins): ContinuousDecision {
  const s = view.snapshot;
  effectiveContinuousIntervalSeconds(view.scheduleSeconds, view.cadence);
  validatedContinuousPostHeadPolicy(view.postHeadPolicy);
  if (view.cycle) assertContinuousCycle(view.cycle, pins, view.authorityDigest, view.cadence, view.scheduleSeconds, view.postHeadPolicy);
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
  const next = continuousDueAt(s, view.scheduleSeconds, view.cadence);
  return next <= s.now ? { state: "due" } : { state: "waiting", nextDueAt: next.toISOString(),
    waitMilliseconds: Math.min(continuousObservationMilliseconds, next.getTime() - s.now.getTime()) };
}

export interface ContinuousPort {
  pins: BackfillPins;
  read(): Promise<ContinuousView>;
  persist(view: ContinuousView): Promise<void>;
  queue(cycle: ContinuousCycle): Promise<void>;
  execute(cycle: ContinuousCycle): Promise<"head" | "operator_stop">;
  postHead?(view: ContinuousView): Promise<void>;
  /** Read-only deployment checks immediately before admitting source work. */
  beforeSource?(): Promise<void>;
  wait(milliseconds: number): Promise<void>;
  emit(event: { state: string; runId?: string; nextDueAt?: string; code?: string }): void;
}
/** Only the nested backfill supervisor retries failures. Unknown/permanent errors
 * latch this resident observer blocked until an explicit operator restart. */
export async function superviseContinuousProvider(port: ContinuousPort, signal: AbortSignal): Promise<"stopped"> {
  let blocked: string | null = null;
  let completedPostHead: string | null = null;
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
      const postHeadPolicy = validatedContinuousPostHeadPolicy(view.postHeadPolicy);
      if ((port.postHead !== undefined && typeof port.postHead !== "function") ||
        (postHeadPolicy.kind === "callback") !== (typeof port.postHead === "function")) {
        refuseBackfill("CONTINUOUS_POST_HEAD_POLICY_DRIFT");
      }
      const decision = continuousDecision(view, port.pins);
      if (port.postHead && view.snapshot.state === "idle" && view.snapshot.run.state === "succeeded" &&
        view.snapshot.run.reachedHead && view.snapshot.lease.owner === null && view.snapshot.lease.expiresAt === null &&
        view.snapshot.activeRunIds.length === 0 && view.snapshot.actionableCommands.length === 0) {
        assertContinuousHead(view.snapshot, port.pins, view.snapshot.run.configNumber);
        const head = `${view.snapshot.run.id}/${view.snapshot.checkpointHash}`;
        if (completedPostHead !== head) {
          if (signal.aborted) break;
          port.emit({ state: "post_head", runId: view.snapshot.run.id });
          await port.postHead(view);
          completedPostHead = head;
          // The callback can outlive its observation; all decisions need a fresh read.
          continue;
        }
      }
      port.emit({ state: decision.state, runId: view.snapshot.run.id,
        ...(decision.state === "waiting" ? { nextDueAt: decision.nextDueAt } : {}) });
      if (signal.aborted || decision.state === "stopped") break;
      if (decision.state === "due" || decision.state === "queue" || decision.state === "execute") {
        await port.beforeSource?.();
        if (signal.aborted) break;
      }
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
