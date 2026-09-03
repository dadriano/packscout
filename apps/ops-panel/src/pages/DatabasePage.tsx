import { useEffect, useState } from "react";
import { DatabaseOperationsCard } from "../components/database/DatabaseOperationsCard.tsx";
import { DatabaseStatusCard } from "../components/database/DatabaseStatusCard.tsx";
import { MigrationStateCard } from "../components/database/MigrationStateCard.tsx";
import { OperationPane } from "../components/database/OperationPane.tsx";
import { RowBrowserCard } from "../components/database/RowBrowserCard.tsx";
import { PanelPageHeader } from "../components/PanelShell.tsx";
import { formatAge } from "../format.ts";
import { useDatabaseOperations } from "../hooks/useDatabaseOperations.ts";
import { useDatabaseStatus } from "../hooks/useDatabaseStatus.ts";

/**
 * The database surface: what the applications point at, whether it is this
 * machine's, whether it answered, what is in it, whether migrations are current,
 * three guarded operations with their live output, and a supervised row browser
 * for looking inside.
 *
 * Every dangerous capability is gated on the server's own locality check,
 * re-evaluated at the moment of the attempt. The panel has no SQL runner and no
 * way to execute a caller-supplied command — a permanent design invariant, not a
 * current limitation.
 */
export function DatabasePage() {
  const { phase, status, live, error, pending, refresh, startRowBrowser, stopRowBrowser } =
    useDatabaseStatus();
  const operations = useDatabaseOperations();
  /**
   * Dismissal is remembered per run rather than as a flag, so a new operation
   * brings the pane back without an effect having to reset anything.
   */
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);

  // A finished operation changes the schema, the row counts, or both, so the
  // status and migration cards are re-read rather than left showing the
  // situation before the run.
  useEffect(() => {
    if (operations.settledToken > 0) refresh();
  }, [operations.settledToken, refresh]);

  const currentRun = operations.payload?.running ?? operations.payload?.last ?? null;
  const paneDismissed =
    currentRun !== null && dismissedRunId === currentRun.runId;

  return (
    <>
      <PanelPageHeader
        eyebrow="Database"
        title="Database"
        description="The local PostgreSQL database the pipeline uses: identity, locality, reachability, size, migration state, three guarded operations, and a supervised row browser."
      />

      <div className="panel-toolbar">
        <button type="button" className="panel-button" onClick={refresh}>
          Refresh
        </button>
        <span className="panel-status" data-tone={live ? "live" : "neutral"}>
          {live ? "Live" : "Not streaming"}
        </span>
        <span className="panel-status">
          {status ? `Read ${formatAge(status.readAt)}` : "—"}
        </span>
      </div>

      {error ? (
        <p className="panel-notice" role="alert">
          {error}
        </p>
      ) : null}

      {operations.error ? (
        <p className="panel-notice" data-tone="warning" role="alert">
          {operations.error}{" "}
          <button
            type="button"
            className="panel-button"
            onClick={operations.dismissError}
          >
            Dismiss
          </button>
        </p>
      ) : null}

      {phase === "loading" ? <p>Reading the database status…</p> : null}

      {status ? (
        <div className="panel-card-stack">
          <DatabaseStatusCard status={status} />
          <MigrationStateCard status={status} />
          {operations.payload ? (
            <DatabaseOperationsCard
              payload={operations.payload}
              pending={operations.pending}
              onRun={(definition, acknowledgement) =>
                operations.run(definition.id, acknowledgement)
              }
            />
          ) : null}
          {paneDismissed ? null : (
            <OperationPane
              run={currentRun}
              output={operations.output}
              onClose={() => setDismissedRunId(currentRun?.runId ?? null)}
            />
          )}
          <RowBrowserCard
            status={status}
            pending={pending}
            onStart={startRowBrowser}
            onStop={stopRowBrowser}
          />
        </div>
      ) : null}
    </>
  );
}
