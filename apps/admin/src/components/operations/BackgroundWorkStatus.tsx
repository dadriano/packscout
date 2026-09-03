import type {
  RecomputationBacklogState,
  RecomputationQueueEntry,
  RecomputationRecoveryOutcome,
  RetentionCadenceState,
  RetentionExecutionSummary,
} from "@packscout/contracts";
import { StatusBadge, type StatusTone } from "../StatusBadge";
import { humanize } from "./OperationStatus";

/** A stuck claim reads as a distinct state: the worker holding it is gone. */
export function queueEntryLabel(entry: RecomputationQueueEntry): string {
  return entry.state === "claimed" && entry.claimExpired
    ? "Stuck claim"
    : humanize(entry.state);
}

export function QueueEntryStatus({ entry }: { entry: RecomputationQueueEntry }) {
  const tone: StatusTone =
    entry.state === "completed"
      ? "ready"
      : entry.state === "failed" || entry.claimExpired
        ? "danger"
        : entry.state === "claimed"
          ? "pending"
          : "neutral";
  return <StatusBadge label={queueEntryLabel(entry)} tone={tone} />;
}

export function RetentionStatus({
  state,
}: {
  state: RetentionExecutionSummary["state"];
}) {
  const tone: StatusTone =
    state === "succeeded" ? "ready" : state === "failed" ? "danger" : "pending";
  return <StatusBadge label={humanize(state)} tone={tone} />;
}

const backlogLabels: Record<RecomputationBacklogState, string> = {
  unknown: "No worker settings",
  idle: "Idle",
  healthy: "Keeping up",
  backlogged: "Backlogged",
};

export function BacklogStatus({ state }: { state: RecomputationBacklogState }) {
  const tone: StatusTone =
    state === "backlogged"
      ? "danger"
      : state === "healthy"
        ? "ready"
        : state === "idle"
          ? "neutral"
          : "pending";
  return <StatusBadge label={backlogLabels[state]} tone={tone} />;
}

const cadenceLabels: Record<RetentionCadenceState, string> = {
  unknown: "No worker settings",
  never_observed: "Never run",
  current: "On schedule",
  idle: "Nothing to clear",
  overdue: "Overdue",
};

export function CadenceStatus({ state }: { state: RetentionCadenceState }) {
  const tone: StatusTone =
    state === "overdue"
      ? "danger"
      : state === "current"
        ? "ready"
        : state === "idle"
          ? "neutral"
          : "pending";
  return <StatusBadge label={cadenceLabels[state]} tone={tone} />;
}

const outcomeLabels: Record<RecomputationRecoveryOutcome, string> = {
  released: "Claim released",
  requeued: "Re-queued",
  already_resolved: "Already resolved by a worker",
  claim_active: "Claim still active",
  not_found: "No longer present",
};

export function recoveryOutcomeLabel(
  outcome: RecomputationRecoveryOutcome,
): string {
  return outcomeLabels[outcome];
}
