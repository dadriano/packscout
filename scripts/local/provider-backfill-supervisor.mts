import { assertBackfillPins, classifyBackfillCheckpoint, refuseBackfill, safeBackfillFailureCode,
  type BackfillPins, type BackfillSnapshot, type BackfillIntent } from "./provider-backfill-supervisor-policy.mts";
import { backfillRestartApplies, type BackfillRestart } from "./provider-backfill-supervisor-restart.mts";

export interface BackfillView {
  readonly snapshot: BackfillSnapshot;
  readonly intent: BackfillIntent | null;
  readonly pendingRetry: boolean;
  readonly restart?: BackfillRestart | null;
}
export interface BackfillSupervisorPort {
  readonly pins: BackfillPins;
  read(): Promise<BackfillView>;
  persistRetry(view: BackfillView): Promise<void>;
  execute(view: BackfillView): Promise<void | "operator_stop">;
  wait(milliseconds: number): Promise<void>;
  emit(event: Readonly<Record<string, string | number | null>>): void;
}

/** Policy owns no timers, subprocesses, secrets, or database connections. */
export async function superviseProviderBackfill(port: BackfillSupervisorPort,
  signal: AbortSignal): Promise<"head" | "operator_stop"> {
  let lastWaitingIntent: string | null = null;
  while (!signal.aborted) {
    const view = await port.read();
    const { snapshot: s, intent } = view;
    assertBackfillPins(s, port.pins, s.run.configNumber);
    if (s.state === "paused" || s.state === "stopped") return "operator_stop";
    if (view.pendingRetry) {
      if (!intent) refuseBackfill("BACKFILL_PENDING_INTENT_MISSING");
      const delay = Date.parse(intent.notBefore) - s.now.getTime();
      if (lastWaitingIntent !== intent.runId) {
        port.emit({ event: intent.consecutiveNoProgress >= 10 ? "backfill_no_progress_alert" : "backfill_retry_wait",
          providerId: port.pins.providerId, failedRunId: intent.parentRunId, retryRunId: intent.runId,
          failureCode: intent.failureCode, retryNumber: intent.retryNumber,
          consecutiveNoProgress: intent.consecutiveNoProgress, notBefore: intent.notBefore });
        lastWaitingIntent = intent.runId;
      }
      if (delay > 0) { await port.wait(Math.min(delay, 15_000)); continue; }
    } else {
      const kind = classifyBackfillCheckpoint(s);
      if (kind === "head" || kind === "operator_stop") return kind;
      if (kind === "transient_retry" || kind === "page_bound_continuation") {
        await port.persistRetry(view); continue;
      }
      if (backfillRestartApplies(view.restart ?? null, s)) {
        const restart = view.restart!;
        const delay = Date.parse(restart.notBefore) - s.now.getTime();
        if (lastWaitingIntent !== `${restart.runId}/${restart.fence}`) {
          port.emit({ event: restart.consecutiveNoProgress >= 10 ? "backfill_no_progress_alert" : "backfill_closed_child_restart_wait",
            providerId: port.pins.providerId, runId: restart.runId, consecutiveNoProgress: restart.consecutiveNoProgress,
            notBefore: restart.notBefore });
          lastWaitingIntent = `${restart.runId}/${restart.fence}`;
        }
        if (delay > 0) { await port.wait(Math.min(delay, 15_000)); continue; }
      }
    }
    if (signal.aborted) return "operator_stop";
    if (await port.execute(view) === "operator_stop") return "operator_stop";
    if (signal.aborted) return "operator_stop";
    const after = await port.read();
    if (after.snapshot.state === "paused" || after.snapshot.state === "stopped") return "operator_stop";
    port.emit({ event: "backfill_attempt_finished", providerId: port.pins.providerId,
      runId: after.snapshot.run.id, state: after.snapshot.run.state, pages: after.snapshot.run.pageCount,
      accepted: after.snapshot.run.accepted, failureCode: safeBackfillFailureCode(after.snapshot.run.failureCode) });
    // A child that exits before authoritative terminalization is not a source retry.
    if (after.snapshot.run.state === "queued" || after.snapshot.run.state === "running") {
      if (!backfillRestartApplies(after.restart ?? null, after.snapshot)) refuseBackfill("BACKFILL_WORKER_EXIT_WITHOUT_TERMINAL_RESULT");
    }
  }
  return "operator_stop";
}
