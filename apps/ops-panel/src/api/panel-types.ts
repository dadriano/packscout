/**
 * Response shapes the panel UI consumes. Declared here rather than imported
 * from the server so browser code never reaches across the client/server
 * boundary, matching the repository's app conventions.
 */

export interface LogSource {
  service: string;
  fileName: string;
  fileId: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface LogSourcesPayload {
  logDirectory: string;
  pollIntervalMs: number;
  revision: number;
  sources: LogSource[];
  added: LogSource[];
  removed: LogSource[];
  changed: LogSource[];
}

export type ActivityOutcome = "succeeded" | "failed" | "rejected";

export interface ActivityEntry {
  id: string;
  recordedAt: string;
  action: string;
  method: string;
  route: string;
  outcome: ActivityOutcome;
  reason?: string;
  detail?: string;
}

export interface ActivityPayload {
  limit: number;
  total: number;
  capacity: number;
  entries: ActivityEntry[];
}

export const LOG_SOURCES_PATH = "/api/logs/sources";
export const LOG_SOURCES_STREAM_PATH = "/api/logs/sources/stream";
export const LOG_SOURCES_EVENT = "sources";
export const ACTIVITY_PATH = "/api/activity";
