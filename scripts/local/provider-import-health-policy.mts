export type ProviderHeadReconciliationHealth = { state: "absent" } | { state: "invalid" }
  | { state: "recorded"; occurredAt: Date; batchNumber: number; phase: "facts" | "quarantines" | "complete" };

export interface ProviderImportHealthObservation {
  now: Date;
  runtimeState: string;
  runState: string | null;
  reachedHead: boolean;
  lastProgressAt: Date | null;
  nextDueAt: Date | null;
  leaseOwnerPresent: boolean;
  leaseExpiresAt: Date | null;
  leaseMatchesRun: boolean;
  lastHeartbeatAt: Date | null;
  headReconciliation: ProviderHeadReconciliationHealth;
  residentState: string | null;
  configurationMatches: boolean;
  activeRunCount: number;
}

/** Observations never grant recovery authority or reinterpret an operator stop. */
export function providerImportHealth(observation: ProviderImportHealthObservation): string {
  const o = observation;
  const recent = (at: Date | null) => at !== null && at <= o.now && o.now.getTime() - at.getTime() <= 180_000;
  if (o.runtimeState === "paused" || o.runtimeState === "stopped") return o.runtimeState;
  if (o.runtimeState === "error" || o.runState === "failed") return "failed";
  if (!o.configurationMatches) return "configuration_mismatch";
  if (!Number.isSafeInteger(o.activeRunCount) || o.activeRunCount < 0) return "needs_inspection";
  if (o.residentState === "blocked") return "blocked";
  if (o.residentState === "read_unavailable") return "read_unavailable";
  const liveLease = o.leaseOwnerPresent && o.leaseExpiresAt !== null && o.leaseExpiresAt > o.now;
  if (o.runState === "running") {
    if (o.runtimeState !== "running" || o.activeRunCount !== 1) return "inconsistent_runtime";
    if (!liveLease || !o.leaseMatchesRun) return "unowned_run";
    if (o.reachedHead) {
      const receipt = o.headReconciliation;
      if (receipt.state === "invalid") return "reconciliation_receipt_invalid";
      if (!recent(o.lastHeartbeatAt)) return "stalled";
      if (receipt.state === "absent") return recent(o.lastProgressAt) ? "reconciliation_pending" : "stalled";
      if (!recent(receipt.occurredAt)) return "stalled";
      return receipt.phase === "complete" ? "finalizing" : "reconciling";
    }
    return recent(o.lastProgressAt) ? "importing" : "stalled";
  }
  if (o.runState === "queued") {
    if (o.runtimeState !== "idle" || o.activeRunCount !== 1) return "inconsistent_runtime";
    return o.residentState === null ? "unattended_queue" : "queued";
  }
  if (o.reachedHead && o.runState === "succeeded") {
    if (o.runtimeState !== "idle" || o.activeRunCount !== 0) return "inconsistent_runtime";
    if (o.leaseOwnerPresent || o.leaseExpiresAt !== null) return "lease_not_released";
    if (o.residentState === null) return "missing_resident";
    if (o.residentState !== "waiting") return "resident_not_waiting";
    if (o.nextDueAt === null) return "missing_schedule";
    return o.now.getTime() > o.nextDueAt.getTime() + 90_000 ? "overdue" : "caught_up_waiting";
  }
  return "needs_inspection";
}
