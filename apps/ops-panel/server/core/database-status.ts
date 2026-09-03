import type { DatabaseTargetFacts } from "./database-target.ts";
import {
  summarizeMigrationState,
  type MigrationHistoryRow,
  type MigrationStateSummary,
} from "./migration-state.ts";
import type { StudioState } from "./studio-supervisor.ts";

/**
 * The status snapshot the panel serves, assembled from three server-side facts:
 * the resolved target, one probe of the database, and the supervised row
 * browser's state.
 *
 * Its job is to be *honest about which statement failed*. The three unhappy
 * paths are separate values with separate wording, because "the database is
 * down" and "nothing is configured" and "it answered but the panel could not
 * read it" call for three different actions:
 *
 *  - `unconfigured`  — nothing to inspect; the environment names no database;
 *  - `unreachable`   — a target exists, but the connection did not open;
 *  - `unqueryable`   — the connection opened, but the fixed status queries failed.
 *
 * Assembly is pure, so every combination is testable without a database.
 */

export type DatabaseHealth = "ready" | "unconfigured" | "unreachable" | "unqueryable";

export type DatabaseReachability =
  | "not_attempted"
  | "reachable"
  | "unreachable"
  | "unqueryable";

export interface DatabaseTableSummary {
  readonly name: string;
  /** The planner's estimate: cheap, and honest about being approximate. */
  readonly approximateRows: number;
  readonly totalBytes: number;
}

export interface DatabaseProbeResult {
  readonly outcome: Exclude<DatabaseReachability, "not_attempted">;
  readonly sizeBytes: number | null;
  readonly tables: readonly DatabaseTableSummary[];
  /** Null when the history could not be read; empty for a fresh database. */
  readonly migrationHistory: readonly MigrationHistoryRow[] | null;
  /** Redacted already: this module never sees an unsanitized driver message. */
  readonly detail: string | null;
}

export interface RowBrowserStatus {
  readonly phase: StudioState["phase"];
  readonly embedUrl: string | null;
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  readonly message: string | null;
  /** Server-side truth: the client's belief about this is never consulted. */
  readonly canStart: boolean;
  readonly blockedReason: string | null;
  readonly startupTimeoutMs: number;
}

export interface DatabaseStatusSnapshot {
  readonly readAt: string;
  readonly health: DatabaseHealth;
  readonly headline: string;
  readonly detail: string | null;
  readonly target: DatabaseTargetFacts;
  readonly reachability: DatabaseReachability;
  readonly sizeBytes: number | null;
  readonly tables: readonly DatabaseTableSummary[];
  readonly migrations: MigrationStateSummary | null;
  readonly rowBrowser: RowBrowserStatus;
  readonly refreshIntervalMs: number;
}

function headlineFor(
  health: DatabaseHealth,
  reachability: DatabaseReachability,
  target: DatabaseTargetFacts,
): string {
  if (health === "unconfigured") return "No database is configured.";
  if (reachability === "not_attempted") {
    return "Configured, but the panel has not reached it yet.";
  }
  if (health === "unreachable") {
    return "Configured, but the panel could not open a connection to it.";
  }
  if (health === "unqueryable") {
    return "Reachable, but the panel could not read its status.";
  }
  const identity = target.identity;
  return identity === null
    ? "Connected."
    : `Connected to ${identity.database} on ${identity.host}:${identity.port}.`;
}

export interface RowBrowserAvailability {
  readonly state: StudioState;
  readonly startupTimeoutMs: number;
}

function rowBrowserStatus(
  target: DatabaseTargetFacts,
  { state, startupTimeoutMs }: RowBrowserAvailability,
): RowBrowserStatus {
  const local = target.locality === "local";
  const busy = state.phase === "starting" || state.phase === "ready" || state.phase === "stopping";
  return {
    phase: state.phase,
    embedUrl: state.phase === "ready" ? state.embedUrl : null,
    startedAt: state.startedAt,
    readyAt: state.readyAt,
    message: state.message,
    canStart: local && !busy,
    // Only a non-local target *blocks*; a busy one is simply already running.
    blockedReason: local ? null : target.explanation,
    startupTimeoutMs,
  };
}

export interface DatabaseStatusInput {
  readonly readAt: string;
  readonly target: DatabaseTargetFacts;
  /** Null when the target was never probed, which is only true when unconfigured. */
  readonly probe: DatabaseProbeResult | null;
  readonly repositoryMigrations: readonly string[];
  readonly rowBrowser: RowBrowserAvailability;
  readonly refreshIntervalMs: number;
}

/**
 * Assemble one snapshot. A probe result is required for any configured target:
 * omitting it reads as "not attempted", never as healthy.
 */
export function buildDatabaseStatus({
  readAt,
  target,
  probe,
  repositoryMigrations,
  rowBrowser,
  refreshIntervalMs,
}: DatabaseStatusInput): DatabaseStatusSnapshot {
  const configured = target.identity !== null;
  const reachability: DatabaseReachability = probe?.outcome ?? "not_attempted";
  const health: DatabaseHealth = !configured
    ? "unconfigured"
    : reachability === "reachable"
      ? "ready"
      : reachability === "unqueryable"
        ? "unqueryable"
        : "unreachable";

  const migrations =
    probe?.migrationHistory == null
      ? null
      : summarizeMigrationState(repositoryMigrations, probe.migrationHistory);

  return {
    readAt,
    health,
    headline: headlineFor(health, reachability, target),
    detail: health === "unconfigured" ? target.explanation : (probe?.detail ?? null),
    target,
    reachability,
    sizeBytes: probe?.sizeBytes ?? null,
    tables: probe?.tables ?? [],
    migrations,
    rowBrowser: rowBrowserStatus(target, rowBrowser),
    refreshIntervalMs,
  };
}
