import type {
  AdminAlertState,
  OperationalSeverity,
} from "@packscout/contracts";
import { StatusBadge, type StatusTone } from "../StatusBadge";
import { humanize } from "./OperationStatus";

function toneForSeverity(severity: OperationalSeverity): StatusTone {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "pending";
  return "neutral";
}

function toneForState(state: AdminAlertState): StatusTone {
  if (state === "resolved") return "ready";
  if (state === "acknowledged") return "pending";
  return "danger";
}

export function AlertSeverity({ severity }: { severity: OperationalSeverity }) {
  return <StatusBadge label={humanize(severity)} tone={toneForSeverity(severity)} />;
}

export function AlertState({ state }: { state: AdminAlertState }) {
  return <StatusBadge label={humanize(state)} tone={toneForState(state)} />;
}
