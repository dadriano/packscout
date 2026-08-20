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

/**
 * The log record contract, mirrored from the server's `core/log-records.ts`.
 *
 * Identity is `line:<service>:<generation>:<offset>`, derived from bytes rather
 * than assigned, so the initial window, the live stream, and (admin-tools/012)
 * history reads all name the same line the same way. Merging is therefore a
 * matter of set membership, not of guessing at overlaps.
 */
export interface LogLineRecord {
  id: string;
  service: string;
  generation: number;
  offset: number;
  endOffset: number;
  text: string;
  observedAt: string;
  /** True when `observedAt` is a read time rather than an arrival time. */
  backfilled: boolean;
  /** True when the line was published without ever seeing its terminator. */
  partial: boolean;
}

export type LogMarkerKind =
  | "restarted"
  | "disappeared"
  | "appeared"
  | "skipped"
  | "reconnected";

export type LogMarkerReason =
  | "truncated"
  | "replaced"
  | "missing"
  | "discovered"
  | "catch_up"
  | "paused"
  | "browsing"
  | "evicted"
  | "restored";

export interface LogMarkerRecord {
  id: string;
  kind: LogMarkerKind;
  reason: LogMarkerReason;
  service: string;
  generation: number;
  offset: number;
  observedAt: string;
  detail: string;
  skippedLines?: number;
  skippedBytes?: number;
}

/** The row model shared by tailing, history, and filtering. */
export type LogRow =
  | ({ type: "line" } & LogLineRecord)
  | ({ type: "marker" } & LogMarkerRecord);

/** Marker scope for panel-wide events; never a legal service name. */
export const PANEL_MARKER_SCOPE = "*";

export interface LogWindowPayload {
  service: string;
  generation: number;
  present: boolean;
  complete: boolean;
  startOffset: number;
  endOffset: number;
  lines: LogLineRecord[];
}

export interface LogWindowsPayload {
  readAt: string;
  requestedLines: number;
  windows: LogWindowPayload[];
}

export interface LogStreamPayload {
  emittedAt: string;
  lines: LogLineRecord[];
  markers: LogMarkerRecord[];
}

export const LOG_SOURCES_PATH = "/api/logs/sources";
export const LOG_SOURCES_STREAM_PATH = "/api/logs/sources/stream";
export const LOG_SOURCES_EVENT = "sources";
export const LOG_WINDOW_PATH = "/api/logs/window";
export const LOG_STREAM_PATH = "/api/logs/stream";
export const LOG_STREAM_EVENT = "logs";
export const ACTIVITY_PATH = "/api/activity";
