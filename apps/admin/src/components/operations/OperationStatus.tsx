import type { QuarantineLifecycleState } from "@packscout/contracts";
import type { ImportRunState } from "../../api/import-operations";
import { StatusBadge, type StatusTone } from "../StatusBadge";

export function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

export function dateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

export function duration(start: string | null, finish: string | null): string {
  if (!start) return "Not started";
  if (!finish) return "In progress";
  const seconds = Math.max(0, Math.round((Date.parse(finish) - Date.parse(start)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function age(milliseconds: number | null): string {
  if (milliseconds === null) return "Not recorded";
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${hours}h ${minutes % 60}m`
    : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function interval(seconds: number): string {
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function runTone(state: ImportRunState): StatusTone {
  if (state === "succeeded") return "ready";
  if (state === "failed") return "danger";
  if (state === "incomplete" || state === "running") return "pending";
  return "neutral";
}

export function RunStatus({ state }: { state: ImportRunState }) {
  return <StatusBadge label={humanize(state)} tone={runTone(state)} />;
}

export function QuarantineStatus({ state }: { state: QuarantineLifecycleState }) {
  const tone: StatusTone = state === "resolved" ? "ready" : state === "expired" ? "danger" : state === "retrying" ? "pending" : "neutral";
  return <StatusBadge label={humanize(state)} tone={tone} />;
}

export function HealthStatus({ value }: { value: "fresh" | "stale" | "healthy" | "warning" | "degraded" }) {
  const tone: StatusTone = value === "fresh" || value === "healthy" ? "ready" : value === "stale" || value === "degraded" ? "danger" : "pending";
  return <StatusBadge label={humanize(value)} tone={tone} />;
}
