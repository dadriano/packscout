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

/** Backward for older output, forward for reading onwards, around for context. */
export type LogHistoryDirection = "backward" | "forward" | "around";

/**
 * One bounded history page, mirrored from the server's `log-history-reader.ts`.
 *
 * The cursors are the contract that makes paging terminate: `startCursor` is
 * where an older page would end and `endCursor` where a newer one would begin,
 * and both are strictly closer to their boundary than the cursor that produced
 * them whenever any byte was read — even for a line larger than the whole
 * budget, which arrives as bounded `partial` fragments rather than as a stall.
 */
export interface LogHistoryPayload {
  service: string;
  generation: number;
  present: boolean;
  fileSize: number;
  direction: LogHistoryDirection;
  startCursor: number;
  endCursor: number;
  atStart: boolean;
  atEnd: boolean;
  fragmented: boolean;
  bytesRead: number;
  readAt: string;
  lines: LogLineRecord[];
}

/** The refusal a history read earns when the file started a new generation. */
export const LOG_GENERATION_CHANGED_CODE = "ops_panel_log_generation_changed";

/**
 * The database surface's contract, mirrored from the server's
 * `core/database-target.ts`, `core/database-status.ts`, and
 * `core/migration-state.ts`.
 *
 * Two properties are load-bearing for the whole surface. Identity carries a
 * host, a port, and a database name and *never* credentials — there is no field
 * here for one. And `locality` is a server-side fact: the client renders it, but
 * every risky capability is gated on the server's own re-check, so nothing here
 * can grant permission.
 */

export type DatabaseLocality = "local" | "non_local";

export interface DatabaseTargetIdentity {
  host: string;
  port: number;
  database: string;
  displayUrl: string;
}

export interface DatabaseTargetFacts {
  variableName: string;
  configured: boolean;
  identity: DatabaseTargetIdentity | null;
  locality: DatabaseLocality;
  localityReason: "loopback_host" | "routable_host" | "unreadable_configuration";
  problem: string | null;
  explanation: string;
}

export type DatabaseHealth = "ready" | "unconfigured" | "unreachable" | "unqueryable";

export type DatabaseReachability =
  | "not_attempted"
  | "reachable"
  | "unreachable"
  | "unqueryable";

export interface DatabaseTableSummary {
  name: string;
  approximateRows: number;
  totalBytes: number;
}

export type MigrationHealth = "current" | "behind" | "failed" | "drifted";

export type MigrationOutcome =
  | "applied"
  | "failed"
  | "pending"
  | "unknown_to_repository";

export interface MigrationEntry {
  name: string;
  outcome: MigrationOutcome;
  attempts: number;
  inRepository: boolean;
  detail: string | null;
}

export interface MigrationStateSummary {
  health: MigrationHealth;
  repositoryCount: number;
  appliedCount: number;
  pending: string[];
  failed: MigrationEntry[];
  unknownToRepository: string[];
  entries: MigrationEntry[];
  summary: string;
}

export type RowBrowserPhase = "stopped" | "starting" | "ready" | "stopping" | "failed";

export interface RowBrowserStatus {
  phase: RowBrowserPhase;
  /** Present only once the child was verified to be listening on loopback. */
  embedUrl: string | null;
  startedAt: string | null;
  readyAt: string | null;
  message: string | null;
  canStart: boolean;
  blockedReason: string | null;
  startupTimeoutMs: number;
}

export interface DatabaseStatusPayload {
  readAt: string;
  health: DatabaseHealth;
  headline: string;
  detail: string | null;
  target: DatabaseTargetFacts;
  reachability: DatabaseReachability;
  sizeBytes: number | null;
  tables: DatabaseTableSummary[];
  migrations: MigrationStateSummary | null;
  rowBrowser: RowBrowserStatus;
  refreshIntervalMs: number;
}

/**
 * The database-operations contract, mirrored from the server's
 * `core/database-operations.ts`, `core/operation-supervisor.ts`, and
 * `core/operation-status.ts`.
 *
 * Two properties are load-bearing. The operation list travels *with* the
 * payload, so the confirmation tiers and the stated consequences the UI renders
 * are the same declaration the server enforces rather than a copy that can drift.
 * And `available` is the server's own locality answer: when it is false the UI
 * removes the operations region entirely, and the server refuses regardless.
 */

export type DatabaseOperationId = "migrate" | "seed" | "reset";

export type OperationAcknowledgement = "confirm" | "database_name";

export interface DatabaseOperationDefinition {
  id: DatabaseOperationId;
  label: string;
  workspaceScript: string;
  acknowledgement: OperationAcknowledgement;
  summary: string;
  consequence: string;
  destructive: boolean;
}

/** `unknown` means the panel restarted mid-run and will not guess. */
export type OperationOutcome = "succeeded" | "failed" | "timed_out" | "unknown";

export interface OperationOutputLine {
  index: number;
  text: string;
}

export interface OperationRunSnapshot {
  runId: string;
  operation: DatabaseOperationId;
  label: string;
  workspaceScript: string;
  database: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: OperationOutcome | null;
  message: string | null;
  outputLineCount: number;
  outputProduced: number;
  outputTruncated: boolean;
  truncationNotice: string | null;
  interrupted: boolean;
}

export interface DatabaseOperationsPayload {
  readAt: string;
  target: DatabaseTargetFacts;
  available: boolean;
  unavailableReason: string | null;
  operations: DatabaseOperationDefinition[];
  running: OperationRunSnapshot | null;
  last: OperationRunSnapshot | null;
  output: OperationOutputLine[];
  outputLineLimit: number;
  timeoutMs: number;
}

export interface OperationOutputEvent {
  runId: string;
  lines: OperationOutputLine[];
}

export const LOG_SOURCES_PATH = "/api/logs/sources";
export const LOG_SOURCES_STREAM_PATH = "/api/logs/sources/stream";
export const LOG_SOURCES_EVENT = "sources";
export const LOG_WINDOW_PATH = "/api/logs/window";
export const LOG_HISTORY_PATH = "/api/logs/history";
export const LOG_DOWNLOAD_PATH = "/api/logs/download";
export const LOG_STREAM_PATH = "/api/logs/stream";
export const LOG_STREAM_EVENT = "logs";
export const ACTIVITY_PATH = "/api/activity";
export const DATABASE_PATH = "/api/database";
export const DATABASE_STREAM_PATH = "/api/database/stream";
export const DATABASE_EVENT = "database";
export const ROW_BROWSER_PATH = "/api/database/row-browser";
export const OPERATIONS_PATH = "/api/database/operations";
export const OPERATIONS_STREAM_PATH = "/api/database/operations/stream";
export const OPERATIONS_EVENT = "operations";
export const OPERATION_OUTPUT_EVENT = "operation-output";
