import type {
  DatabaseHealth,
  DatabaseStatusPayload,
  MigrationHealth,
  RowBrowserStatus,
} from "../api/panel-types.ts";

/**
 * Wording and tone for the database surface, kept out of the components so the
 * claims the panel makes are testable on their own.
 *
 * The three unhappy states are deliberately three *different* readings — a
 * separate tone, a separate label, and a separate next step for each — because
 * "nothing is configured", "it is down", and "it answered but could not be
 * read" call for three different actions from the operator.
 */

export type PanelTone = "ready" | "warning" | "danger" | "neutral";

export interface HealthReading {
  readonly tone: PanelTone;
  readonly label: string;
  /** What the operator should do next. Empty when nothing is wrong. */
  readonly nextStep: string;
}

const HEALTH_READINGS: Record<DatabaseHealth, HealthReading> = {
  ready: { tone: "ready", label: "Connected", nextStep: "" },
  unconfigured: {
    tone: "neutral",
    label: "Not configured",
    nextStep:
      "Set the database URL in the workspace environment and refresh; until then there is nothing to inspect.",
  },
  unreachable: {
    tone: "danger",
    label: "Unreachable",
    nextStep:
      "The target is configured but did not answer. Check that PostgreSQL is running and listening where the URL points.",
  },
  unqueryable: {
    tone: "warning",
    label: "Unreadable",
    nextStep:
      "The server answered but the panel could not read its status. Check the credentials, the database name, and the role's permissions.",
  },
};

export function readHealth(health: DatabaseHealth): HealthReading {
  return HEALTH_READINGS[health];
}

const MIGRATION_READINGS: Record<MigrationHealth, { tone: PanelTone; label: string }> = {
  current: { tone: "ready", label: "Current" },
  behind: { tone: "warning", label: "Behind" },
  failed: { tone: "danger", label: "Failed" },
  drifted: { tone: "warning", label: "Drifted" },
};

export function readMigrationHealth(health: MigrationHealth): {
  tone: PanelTone;
  label: string;
} {
  return MIGRATION_READINGS[health];
}

export interface RowBrowserReading {
  readonly tone: PanelTone;
  readonly label: string;
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly busy: boolean;
  readonly embedUrl: string | null;
  /** The refusal, the failure, or the reason the embed is not shown. */
  readonly message: string | null;
}

const ROW_BROWSER_LABELS: Record<RowBrowserStatus["phase"], string> = {
  stopped: "Stopped",
  starting: "Starting",
  ready: "Running",
  stopping: "Stopping",
  failed: "Stopped after a problem",
};

/**
 * The client mirrors the server's decision; it never makes one. `canStart` comes
 * straight from the server, so a client that believes it may start the row
 * browser still gets refused at the route.
 */
export function readRowBrowser(status: RowBrowserStatus): RowBrowserReading {
  const busy = status.phase === "starting" || status.phase === "stopping";
  return {
    tone:
      status.phase === "ready"
        ? "ready"
        : status.phase === "failed"
          ? "danger"
          : busy
            ? "warning"
            : "neutral",
    label: ROW_BROWSER_LABELS[status.phase],
    canStart: status.canStart,
    canStop: status.phase === "ready" || status.phase === "starting",
    busy,
    embedUrl: status.phase === "ready" ? status.embedUrl : null,
    message: status.message ?? status.blockedReason,
  };
}

/** Row counts are planner estimates; the wording says so rather than implying a count. */
export function formatApproximateRows(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "unknown";
  return `≈ ${Math.round(value).toLocaleString("en-US")}`;
}

/** One line naming the target, safe to render anywhere: it has no credentials. */
export function describeTarget(status: DatabaseStatusPayload): string {
  const identity = status.target.identity;
  if (identity === null) return `${status.target.variableName} is not usable.`;
  return `${identity.database} at ${identity.host}:${identity.port}`;
}

export function describeLocality(status: DatabaseStatusPayload): {
  tone: PanelTone;
  label: string;
} {
  return status.target.locality === "local"
    ? { tone: "ready", label: "Local" }
    : { tone: "warning", label: "Not local" };
}
