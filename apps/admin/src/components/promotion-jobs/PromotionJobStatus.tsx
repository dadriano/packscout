import { StatusBadge, type StatusTone } from "../StatusBadge";
import { humanize } from "../operations/OperationStatus";

const READY = new Set([
  "accepted",
  "acknowledged",
  "active",
  "caught_up",
  "current",
  "healthy",
  "live",
  "no_change",
  "terminal",
]);
const PENDING = new Set([
  "awaiting_activation",
  "awaiting_publication",
  "change_wake",
  "continuation",
  "continuation_required",
  "deferred",
  "last_known",
  "manual",
  "overdue",
  "pending",
  "pending_activation",
  "persisted",
  "reconciliation_cron",
  "retry_wait",
  "running",
  "sent",
]);
const DANGER = new Set([
  "alerting",
  "blocked",
  "failed",
  "stale",
  "unavailable",
]);

export function promotionStatusTone(value: string): StatusTone {
  if (READY.has(value)) return "ready";
  if (PENDING.has(value)) return "pending";
  if (DANGER.has(value)) return "danger";
  return "neutral";
}

export function PromotionJobStatus({ value }: { value: string }) {
  return (
    <StatusBadge label={humanize(value)} tone={promotionStatusTone(value)} />
  );
}

export function Digest({ value }: { value: string | null }) {
  return value ? <code className="promotion-digest">{value}</code> : <>None</>;
}

export function MonitoringTime({ value }: { value: string | null }) {
  if (!value) return <>Not recorded</>;
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}
