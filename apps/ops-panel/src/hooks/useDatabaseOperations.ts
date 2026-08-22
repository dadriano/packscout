import { useCallback, useEffect, useRef, useState } from "react";
import { panelFetch } from "../api/panel-client.ts";
import {
  OPERATIONS_EVENT,
  OPERATIONS_PATH,
  OPERATIONS_STREAM_PATH,
  OPERATION_OUTPUT_EVENT,
  type DatabaseOperationId,
  type DatabaseOperationsPayload,
  type OperationOutputEvent,
  type OperationOutputLine,
} from "../api/panel-types.ts";
import { toPaneLine } from "../database/operation-presentation.ts";
import { subscribeToPanelStream } from "../streams/panel-stream.ts";

/**
 * The operations surface's state: one snapshot fetch, then live state and output
 * through the panel's shared stream budget.
 *
 * The client renders the server's answers, including its refusals. It sends the
 * database name its dialog was rendered against so the server can tell "the
 * operator mistyped" from "the environment moved while the dialog was open", and
 * it never decides for itself whether an operation may run.
 */

export type OperationsPhase = "loading" | "ready" | "error";

export interface DatabaseOperationsState {
  phase: OperationsPhase;
  payload: DatabaseOperationsPayload | null;
  output: OperationOutputLine[];
  live: boolean;
  error: string | null;
  pending: boolean;
  /** Changes each time a run settles, so callers can refresh other surfaces. */
  settledToken: number;
  dismissError: () => void;
  run: (operation: DatabaseOperationId, acknowledgement: string) => void;
}

export function useDatabaseOperations(): DatabaseOperationsState {
  const [payload, setPayload] = useState<DatabaseOperationsPayload | null>(null);
  const [output, setOutput] = useState<OperationOutputLine[]>([]);
  const [phase, setPhase] = useState<OperationsPhase>("loading");
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [settledToken, setSettledToken] = useState(0);
  const runningRunId = useRef<string | null>(null);

  const apply = useCallback((next: DatabaseOperationsPayload) => {
    setPayload(next);
    setPhase("ready");
    setOutput(next.output.map(toPaneLine));
    const previous = runningRunId.current;
    runningRunId.current = next.running?.runId ?? null;
    // A run that was in flight and is no longer is a settled run, whichever
    // way it went: that is the moment other surfaces need re-reading.
    if (previous !== null && next.running === null) {
      setSettledToken((token) => token + 1);
    }
  }, []);

  const fail = useCallback((cause: unknown, fallback: string) => {
    setError(cause instanceof Error ? cause.message : fallback);
  }, []);

  useEffect(() => {
    let cancelled = false;
    panelFetch<DatabaseOperationsPayload>(OPERATIONS_PATH)
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setPhase("error");
        fail(cause, "The panel could not read its database operations.");
      });
    return () => {
      cancelled = true;
    };
  }, [apply, fail]);

  useEffect(() => {
    // State and output share one connection: the per-tab stream budget is small
    // on purpose, and this surface is open beside the status stream.
    const unsubscribe = subscribeToPanelStream<
      DatabaseOperationsPayload | OperationOutputEvent
    >({
      name: "database-operations",
      path: OPERATIONS_STREAM_PATH,
      event: [OPERATIONS_EVENT, OPERATION_OUTPUT_EVENT],
      onMessage: (message, name) => {
        if (name === OPERATION_OUTPUT_EVENT) {
          const appended = (message as OperationOutputEvent).lines.map(toPaneLine);
          setOutput((lines) => [...lines, ...appended]);
          return;
        }
        apply(message as DatabaseOperationsPayload);
      },
      onOpen: () => setLive(true),
      onError: () => setLive(false),
    });
    return () => {
      setLive(false);
      unsubscribe();
    };
  }, [apply]);

  const run = useCallback(
    (operation: DatabaseOperationId, acknowledgement: string) => {
      setPending(true);
      setError(null);
      panelFetch<DatabaseOperationsPayload>(`${OPERATIONS_PATH}/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          acknowledgement,
          // The target this operator was looking at. The server compares it
          // with the target it resolves at execution time and refuses the
          // difference rather than acting on a stale intention.
          expectedDatabase: payload?.target.identity?.database ?? "",
        }),
      })
        .then(apply)
        .catch((cause: unknown) => fail(cause, "The operation was not started."))
        .finally(() => setPending(false));
    },
    [apply, fail, payload],
  );

  return {
    phase,
    payload,
    output,
    live,
    error,
    pending,
    settledToken,
    dismissError: () => setError(null),
    run,
  };
}
