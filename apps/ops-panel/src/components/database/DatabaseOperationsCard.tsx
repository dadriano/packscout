import { useEffect, useRef, useState } from "react";
import type {
  DatabaseOperationDefinition,
  DatabaseOperationsPayload,
} from "../../api/panel-types.ts";
import {
  describeOutputBound,
  readAcknowledgement,
  readOperationsAvailability,
} from "../../database/operation-presentation.ts";

/**
 * The three registered database operations, offered with confirmation
 * proportionate to their danger.
 *
 * When the target is not provably this machine's, the whole region is *replaced*
 * by the server's explanation rather than showing disabled buttons: there is no
 * action the operator could take here to enable them, so offering them greyed
 * out would only invite a hunt for a switch that does not exist.
 *
 * The confirmation this component collects is a courtesy, not a control. Every
 * guard — locality, the lock, drift, and the typed acknowledgement — is applied
 * again on the server at the moment the operation starts.
 */
export function DatabaseOperationsCard({
  payload,
  pending,
  onRun,
}: {
  payload: DatabaseOperationsPayload;
  pending: boolean;
  onRun: (definition: DatabaseOperationDefinition, acknowledgement: string) => void;
}) {
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    definition: DatabaseOperationDefinition;
    /** The target the dialog was opened against. */
    database: string;
  } | null>(null);
  const [typed, setTyped] = useState("");
  const acknowledgementInput = useRef<HTMLInputElement>(null);
  const availability = readOperationsAvailability(payload);
  const database = payload.target.identity?.database ?? "";

  // A dialog belongs to the target it was opened against. If the target stops
  // being local, or becomes a different database, the dialog is simply no longer
  // the choice the operator was making — so it is derived away rather than
  // dismissed after the fact.
  const confirming =
    availability.available && pendingConfirmation?.database === database
      ? pendingConfirmation.definition
      : null;

  useEffect(() => {
    if (confirming?.acknowledgement === "database_name") {
      acknowledgementInput.current?.focus();
    }
  }, [confirming]);

  if (!availability.available) {
    return (
      <section className="panel-card" aria-labelledby="database-operations-heading">
        <div className="panel-card-header">
          <h2 id="database-operations-heading">Operations</h2>
          <span className="panel-status" data-tone="warning">
            Unavailable
          </span>
        </div>
        <p className="panel-card-headline">
          Database operations are disabled — this database is not local.
        </p>
        <p className="panel-card-detail">
          {availability.reason ??
            "The panel could not prove the configured database is on this machine."}
        </p>
      </section>
    );
  }

  const acknowledgement = confirming
    ? readAcknowledgement(confirming, database, typed)
    : null;
  const blocked = pending || availability.busyWith !== null;

  function open(definition: DatabaseOperationDefinition): void {
    setTyped("");
    setPendingConfirmation({ definition, database });
  }

  function submit(): void {
    if (!confirming || !acknowledgement?.satisfied) return;
    onRun(confirming, typed.trim());
    setPendingConfirmation(null);
    setTyped("");
  }

  return (
    <section className="panel-card" aria-labelledby="database-operations-heading">
      <div className="panel-card-header">
        <h2 id="database-operations-heading">Operations</h2>
        <span
          className="panel-status"
          data-tone={availability.busyWith ? "warning" : "ready"}
        >
          {availability.busyWith ? `${availability.busyWith} running` : "Ready"}
        </span>
      </div>

      <p className="panel-card-headline">
        Three workflows run against <span className="panel-mono">{database}</span>,
        each one a workspace script rather than a command the panel invents. The
        panel runs one at a time.
      </p>

      <div className="panel-toolbar">
        {payload.operations.map((definition) => (
          <button
            key={definition.id}
            type="button"
            className="panel-button"
            data-destructive={definition.destructive ? "yes" : undefined}
            disabled={blocked}
            onClick={() => open(definition)}
          >
            {definition.label}
          </button>
        ))}
      </div>

      {availability.busyWith ? (
        <p className="panel-card-detail" role="status">
          {availability.busyWith} is running. The panel serializes these three
          operations against each other; log tailing and status reads are
          unaffected.
        </p>
      ) : null}

      <p className="panel-card-note">{describeOutputBound(payload)}</p>

      {confirming && acknowledgement ? (
        <div
          className="panel-confirm"
          role="dialog"
          aria-labelledby="database-operation-confirm-heading"
          data-destructive={confirming.destructive ? "yes" : undefined}
        >
          <h3 id="database-operation-confirm-heading">{confirming.label}</h3>
          <p className="panel-card-detail">{confirming.summary}</p>
          <p className="panel-confirm-consequence">{confirming.consequence}</p>
          <p className="panel-card-note">
            Target: <span className="panel-mono">{payload.target.identity?.displayUrl}</span>
            . It runs <span className="panel-mono">npm run {confirming.workspaceScript}</span>.
          </p>

          {acknowledgement.required ? (
            <label className="panel-confirm-field">
              <span>{acknowledgement.prompt}</span>
              <input
                ref={acknowledgementInput}
                type="text"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={typed.length > 0 && !acknowledgement.satisfied}
                aria-describedby="database-operation-confirm-hint"
                onChange={(event) => setTyped(event.target.value)}
              />
              <span id="database-operation-confirm-hint" className="panel-card-note">
                {acknowledgement.hint}
              </span>
            </label>
          ) : null}

          <div className="panel-toolbar">
            <button
              type="button"
              className="panel-button"
              disabled={!acknowledgement.satisfied || blocked}
              onClick={submit}
            >
              Run {confirming.label.toLowerCase()}
            </button>
            <button
              type="button"
              className="panel-button"
              onClick={() => setPendingConfirmation(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
