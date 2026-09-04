import { classifyBackfillCheckpoint, refuseBackfill,
  type BackfillPins } from "./provider-backfill-supervisor-policy.mts";
import { backfillHasOwnedExpiredHeadLease, type BackfillView } from "./provider-backfill-supervisor.mts";
import { ContinuousReadUnavailableError } from "./provider-continuous-read.mts";
export { ContinuousReadUnavailableError } from "./provider-continuous-read.mts";
export { ProviderBackfillSupervisorError };
import { continuousObservationMilliseconds, isProviderUnavailableRefusal, ProviderBackfillSupervisorError,
  providerUnavailableRetryLimit,
  providerUnavailableWaitMilliseconds } from "./provider-continuous-policy.mts";
import { residentContinuousPins, type ResidentBootstrapView, type ResidentHandoff } from "./provider-resident-handoff.mts";
import type { ContinuousHealth } from "./provider-continuous-residency.mts";
import { residentFailureCode } from "./provider-resident-errors.mts";

export interface ResidentBootstrapPort {
  read(): Promise<ResidentBootstrapView>;
  persist(view: BackfillView): Promise<ResidentHandoff>;
  execute(): Promise<"head" | "operator_stop">;
  wait(milliseconds: number): Promise<void>;
  emit(event: ContinuousHealth): void;
}
/** A backfill reaches head once, then its immutable handoff anchors all future
 * cycles. Errors from writes/execution latch; only typed read outages and the
 * bounded provider-database refusal retry. */
export async function superviseResidentBootstrap(port: ResidentBootstrapPort, signal: AbortSignal): Promise<BackfillPins | null> {
  let blocked: string | null = null;
  let unavailable = 0;
  while (!signal.aborted) {
    let reading = true;
    try {
      const view = await port.read();
      reading = false;
      if (signal.aborted || view.backfill?.snapshot.state === "stopped") break;
      if (blocked !== null) {
        port.emit({ state: "blocked", code: blocked });
        await port.wait(continuousObservationMilliseconds); continue;
      }
      if (view.handoff) return residentContinuousPins(view.handoff);
      if ("awaitingInitialRun" in view && view.awaitingInitialRun) {
        port.emit({ state: "waiting_initial_run" });
        await port.wait(continuousObservationMilliseconds); continue;
      }
      const backfill = view.backfill;
      if (!backfill) refuseBackfill("CONTINUOUS_BOOTSTRAP_VIEW_INVALID");
      if (backfill.snapshot.state === "paused") {
        port.emit({ state: "paused", runId: backfill.snapshot.run.id });
        await port.wait(continuousObservationMilliseconds); continue;
      }
      if (backfill.ownedLeaseExpiresAt && backfill.ownedLeaseExpiresAt > backfill.snapshot.now) {
        port.emit({ state: "waiting_owned_child", runId: backfill.snapshot.run.id,
          nextDueAt: backfill.ownedLeaseExpiresAt.toISOString() });
        await port.wait(Math.min(continuousObservationMilliseconds,
          backfill.ownedLeaseExpiresAt.getTime() - backfill.snapshot.now.getTime())); continue;
      }
      const disposition = backfillHasOwnedExpiredHeadLease(backfill) ? "execute" : classifyBackfillCheckpoint(backfill.snapshot);
      if (disposition === "head") {
        port.emit({ state: "handoff", runId: backfill.snapshot.run.id });
        await port.persist(backfill);
        continue;
      }
      port.emit({ state: "backfilling", runId: backfill.snapshot.run.id });
      if (await port.execute() === "operator_stop") {
        if (signal.aborted) break;
        // A directly signalled child is a deliberate stop, never a retry.
        const after = await port.read();
        if (after.backfill?.snapshot.state !== "paused") break;
      }
      unavailable = 0;
    } catch (error) {
      if (reading && error instanceof ContinuousReadUnavailableError) {
        port.emit({ state: blocked === null ? "read_unavailable" : "blocked", code: blocked ?? error.code });
      } else if (blocked === null && isProviderUnavailableRefusal(error) && ++unavailable <= providerUnavailableRetryLimit) {
        port.emit({ state: "provider_unavailable", code: error.code, retry: unavailable });
        await port.wait(providerUnavailableWaitMilliseconds(unavailable)); continue;
      } else {
        blocked ??= residentFailureCode(error);
        port.emit({ state: "blocked", code: blocked });
      }
      await port.wait(continuousObservationMilliseconds);
    }
  }
  port.emit({ state: "stopped" });
  return null;
}
