import type {
  ScheduleHealthState,
  WorkerActivityView,
  WorkerFleetEvaluation,
  WorkerFleetState,
  WorkerLivenessStatus,
} from "@packscout/contracts";
import { StatusBadge, type StatusTone } from "../StatusBadge";
import { age, humanize } from "../operations/OperationStatus";

const fleetLabels: Record<WorkerFleetState, string> = {
  never_reported: "Never reported",
  silent: "No live worker",
  degraded: "Degraded",
  healthy: "Healthy",
};

export function FleetStatus({ state }: { state: WorkerFleetState }) {
  const tone: StatusTone =
    state === "healthy"
      ? "ready"
      : state === "silent"
        ? "danger"
        : state === "degraded"
          ? "pending"
          : "neutral";
  return <StatusBadge label={fleetLabels[state]} tone={tone} />;
}

const livenessLabels: Record<WorkerLivenessStatus, string> = {
  running: "Running",
  stale: "Stale",
  stopped: "Stopped",
};

export function LivenessStatus({ status }: { status: WorkerLivenessStatus }) {
  const tone: StatusTone =
    status === "running" ? "ready" : status === "stale" ? "danger" : "neutral";
  return <StatusBadge label={livenessLabels[status]} tone={tone} />;
}

const scheduleLabels: Record<ScheduleHealthState, string> = {
  scheduled: "Scheduled",
  due: "Due now",
  overdue: "Overdue",
  claim_expired: "Claim expired",
};

export function ScheduleStatus({ state }: { state: ScheduleHealthState }) {
  const tone: StatusTone =
    state === "scheduled"
      ? "ready"
      : state === "due"
        ? "pending"
        : "danger";
  return <StatusBadge label={scheduleLabels[state]} tone={tone} />;
}

/**
 * A healthy idle fleet reads differently from an absent one, so idleness is
 * stated outright rather than shown as an empty activity.
 */
export function activityLabel(activity: WorkerActivityView): string {
  if (activity.kind === "idle") return "Idle — waiting for work";
  if (activity.scope === "other_workspace") {
    return `${humanize(activity.kind)} in another workspace`;
  }
  return activity.providerName
    ? `${humanize(activity.kind)} · ${activity.providerName}`
    : humanize(activity.kind);
}

/**
 * The page's most important sentence. Fleet silence is stated with its measured
 * duration, and the never-reported case says exactly that instead of inventing
 * a duration no record supports.
 */
export function fleetHeadline(fleet: WorkerFleetEvaluation): string {
  if (fleet.state === "never_reported") {
    return "No worker has ever reported inside the retained presence window. Either no worker has started since this deployment, or every presence record has aged past its retention window.";
  }
  if (fleet.state === "silent") {
    return fleet.silentForMs === null
      ? "No worker is live, and no heartbeat time could be measured from the retained records."
      : `No worker has heartbeated for ${age(fleet.silentForMs)}. Scheduled imports, estimated-EV recomputation, and retention are not running.`;
  }
  if (fleet.state === "degraded") {
    const problems = [
      fleet.stale > 0 ? `${fleet.stale} stale instance${fleet.stale === 1 ? "" : "s"}` : null,
      fleet.stalledRuns > 0
        ? `${fleet.stalledRuns} stalled run${fleet.stalledRuns === 1 ? "" : "s"}`
        : null,
      fleet.wedgedSchedules > 0
        ? `${fleet.wedgedSchedules} schedule${fleet.wedgedSchedules === 1 ? "" : "s"} needing attention`
        : null,
    ].filter((value): value is string => value !== null);
    return `${fleet.live} worker${fleet.live === 1 ? " is" : "s are"} live, with ${problems.join(", ")}.`;
  }
  return `${fleet.live} worker${fleet.live === 1 ? " is" : "s are"} live and heartbeating, with no stalled run and no schedule past its window.`;
}
