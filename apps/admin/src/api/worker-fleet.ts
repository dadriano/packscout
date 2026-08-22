import type {
  ScheduleHealthView,
  StalledRunView,
  WorkerFleetEvaluation,
  WorkerFleetSettingsResolution,
  WorkerInstanceView,
} from "@packscout/contracts";
import { requestJson } from "./client";

export interface WorkerInstancesResult {
  instances: WorkerInstanceView[];
  hasMore: boolean;
  fleet: WorkerFleetEvaluation;
  settings: WorkerFleetSettingsResolution;
}

export interface StalledRunsResult {
  items: StalledRunView[];
  nextCursor: string | null;
  staleAfterMs: number | null;
}

export interface ScheduleHealthResult {
  items: ScheduleHealthView[];
  nextCursor: string | null;
  overdueAfterMs: number | null;
}

export interface WorkerSettingsResult {
  settings: WorkerFleetSettingsResolution;
  observedAt: string;
}

interface PageQuery {
  cursor?: string;
  limit?: number;
}

function queryString<T extends object>(values: T): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

export function listWorkerInstances(
  query: { limit?: number } = {},
): Promise<WorkerInstancesResult> {
  return requestJson(`/worker-fleet/instances${queryString(query)}`);
}

export function listStalledRuns(
  query: PageQuery = {},
): Promise<StalledRunsResult> {
  return requestJson(`/worker-fleet/stalled-runs${queryString(query)}`);
}

export function listScheduleHealth(
  query: PageQuery = {},
): Promise<ScheduleHealthResult> {
  return requestJson(`/worker-fleet/schedules${queryString(query)}`);
}

export function getWorkerSettings(): Promise<WorkerSettingsResult> {
  return requestJson("/worker-fleet/settings");
}
