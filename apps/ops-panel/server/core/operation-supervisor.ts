import type {
  DatabaseOperationDefinition,
  DatabaseOperationId,
} from "./database-operations.ts";
import { findDatabaseOperation } from "./database-operations.ts";
import type { LocalTargetDecision } from "./database-target.ts";
import {
  decideOperationStart,
  unknownOperationRefusal,
  type OperationRefusal,
  type RunningOperationDescriptor,
} from "./operation-guards.ts";
import {
  createOperationOutputCollector,
  DEFAULT_OPERATION_LINE_LIMIT,
  type OperationOutputLine,
} from "./operation-output.ts";

/**
 * Supervision for the panel's three database operations.
 *
 * Four guarantees live here, and none of them can be granted by a client:
 *
 *  1. **One at a time.** A single lock serialises the registered operations
 *     against each other, and it is held until the previous run's *process
 *     tree* is gone rather than until its record settles: a script that is
 *     still in its termination grace period is still talking to the database,
 *     so a second migrate or reset started against it would race work nobody
 *     can see. It gates nothing else — log tailing, status reads and the row
 *     browser are unaffected — so the panel stays usable while a migration
 *     runs.
 *  2. **Guards evaluate at execution time.** The locality permit and the typed
 *     acknowledgement are checked here, against a target re-resolved at the
 *     moment of the attempt, not against whatever was true when the request was
 *     made or when the dialog was opened.
 *  3. **Runs are bounded twice.** Output is capped and an overall timeout kills
 *     a wedged child; both are reported in the run's own record rather than
 *     appearing as silence.
 *  4. **An interrupted run is not lost.** A durable marker is written — and
 *     *awaited* — before the child starts, and cleared only after that write
 *     has landed, so a panel that is killed mid-operation reports that
 *     operation's outcome as *unknown* on its next start instead of forgetting
 *     it happened. Every marker write goes through one queue, so a run that
 *     exits faster than the store writes cannot clear a marker that has not
 *     been saved yet and leave a stale one behind it.
 *
 * Framework-free: spawning, persistence, timers and the clock are injected, so
 * every one of those guarantees is provable without a database or a child
 * process.
 */

/** Long enough for a cold reset of a local database, short enough to notice. */
export const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;

export interface OperationSpawnRequest {
  /** A workspace script name taken from the registry. Never caller-supplied. */
  readonly script: string;
  readonly onOutput: (chunk: string) => void;
  readonly onExit: (result: { code: number | null; signal: string | null }) => void;
  readonly onError: (error: Error) => void;
}

export interface OperationChildHandle {
  /**
   * Terminate the child *and everything it started*. The promise settles only
   * once that tree is observed gone or the force-kill has been issued, so a
   * caller can hold a lock across it rather than hoping.
   */
  kill(): Promise<void>;
}

export type OperationSpawn = (request: OperationSpawnRequest) => OperationChildHandle;

export type OperationOutcome = "succeeded" | "failed" | "timed_out" | "unknown";

export interface OperationRunSnapshot {
  readonly runId: string;
  readonly operation: DatabaseOperationId;
  readonly label: string;
  readonly workspaceScript: string;
  /** The database proven current when the run was admitted. */
  readonly database: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** Null while the run is in flight. */
  readonly outcome: OperationOutcome | null;
  readonly message: string | null;
  readonly outputLineCount: number;
  readonly outputProduced: number;
  readonly outputTruncated: boolean;
  readonly truncationNotice: string | null;
  /** True when the panel restarted mid-run and cannot say what happened. */
  readonly interrupted: boolean;
}

export interface OperationMarker {
  readonly runId: string;
  readonly operation: DatabaseOperationId;
  readonly label: string;
  readonly workspaceScript: string;
  readonly database: string;
  readonly startedAt: string;
}

export interface OperationMarkerStore {
  load(): Promise<unknown>;
  /** `null` clears the marker: the run settled and is no longer in doubt. */
  save(marker: OperationMarker | null): Promise<void>;
}

export type OperationEvent =
  | { readonly type: "state" }
  | {
      readonly type: "output";
      readonly runId: string;
      readonly lines: readonly OperationOutputLine[];
    };

export interface OperationStartRequest {
  readonly operation: unknown;
  readonly acknowledgement?: unknown;
  readonly expectedDatabase?: unknown;
}

export type OperationStartResult =
  | { readonly ok: true; readonly run: OperationRunSnapshot }
  | OperationRefusal;

export interface DatabaseOperationRunnerOptions {
  readonly spawn: OperationSpawn;
  /** Re-evaluated on every attempt: the execution-time locality gate. */
  readonly permit: () => LocalTargetDecision;
  readonly markerStore: OperationMarkerStore;
  readonly timeoutMs?: number;
  readonly lineLimit?: number;
  /** Applied to every output line and message. Redaction lives here. */
  readonly sanitize?: (text: string) => string;
  readonly onSettled?: (run: OperationRunSnapshot) => void;
  readonly onPersistenceError?: (error: unknown) => void;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly setTimer?: (handler: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface DatabaseOperationRunner {
  readonly timeoutMs: number;
  readonly lineLimit: number;
  /** Adopt an interrupted run, if the previous process left one behind. */
  restore(): Promise<void>;
  running(): OperationRunSnapshot | null;
  last(): OperationRunSnapshot | null;
  /** Retained output of the running run, or of the most recent one. */
  output(): readonly OperationOutputLine[];
  /**
   * Admit an operation and run it. The lock is taken before the first `await`,
   * so two concurrent calls cannot both be admitted; the promise resolves once
   * the in-flight marker is durable and the child has been spawned.
   */
  start(request: OperationStartRequest): Promise<OperationStartResult>;
  subscribe(listener: (event: OperationEvent) => void): () => void;
  shutdown(): void;
}

export function parseOperationMarker(value: unknown): OperationMarker | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const definition = findDatabaseOperation(record.operation);
  if (definition === null) return null;
  const runId = typeof record.runId === "string" ? record.runId : "";
  const startedAt = typeof record.startedAt === "string" ? record.startedAt : "";
  if (runId.length === 0 || !Number.isFinite(Date.parse(startedAt))) return null;
  return {
    runId,
    operation: definition.id,
    label: definition.label,
    workspaceScript: definition.workspaceScript,
    database: typeof record.database === "string" ? record.database : "unknown",
    startedAt,
  };
}

function describeExit(code: number | null, signal: string | null): string {
  if (signal !== null) return `signal ${signal}`;
  return code === null ? "an unknown status" : `exit code ${code}`;
}

let counter = 0;

function defaultId(): string {
  counter = (counter + 1) % 1_000_000;
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${counter.toString(36)}`;
}

interface ActiveRun {
  snapshot: OperationRunSnapshot;
  definition: DatabaseOperationDefinition;
  collector: ReturnType<typeof createOperationOutputCollector>;
  child?: OperationChildHandle;
  timer?: unknown;
  settled: boolean;
}

export function createDatabaseOperationRunner({
  spawn,
  permit,
  markerStore,
  timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  lineLimit = DEFAULT_OPERATION_LINE_LIMIT,
  sanitize = (value) => value,
  onSettled,
  onPersistenceError,
  now = () => new Date(),
  createId = defaultId,
  setTimer = (handler, milliseconds) => setTimeout(handler, milliseconds),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: DatabaseOperationRunnerOptions): DatabaseOperationRunner {
  const listeners = new Set<(event: OperationEvent) => void>();
  let active: ActiveRun | null = null;
  /** A settled run whose process tree is still being terminated. */
  let stopping: OperationRunSnapshot | null = null;
  let last: OperationRunSnapshot | null = null;
  let lastOutput: readonly OperationOutputLine[] = [];
  let markerWrites: Promise<void> = Promise.resolve();

  function emit(event: OperationEvent): void {
    for (const listener of listeners) listener(event);
  }

  /**
   * One queue for every marker write. Ordering is the whole point: a run that
   * exits while its in-flight marker is still being written must clear that
   * marker *after* it lands, not before, or the panel reports an operation as
   * interrupted that actually finished.
   */
  function persist(marker: OperationMarker | null): Promise<void> {
    const write = markerWrites
      .then(() => markerStore.save(marker))
      .catch((error: unknown) => onPersistenceError?.(error));
    markerWrites = write.then(() => undefined);
    return markerWrites;
  }

  /** What a start attempt is blocked by: a live run, or one still dying. */
  function blockingRun(): RunningOperationDescriptor | null {
    if (active !== null) {
      return {
        operation: active.snapshot.operation,
        label: active.snapshot.label,
        startedAt: active.snapshot.startedAt,
      };
    }
    if (stopping !== null) {
      return {
        operation: stopping.operation,
        label: stopping.label,
        startedAt: stopping.startedAt,
        stopping: true,
      };
    }
    return null;
  }

  /**
   * Terminate a child's whole process tree.
   *
   * `hold` is the difference between a run that ended and a run that was
   * *stopped*. A child that reported its own exit is gone, and the group signal
   * that follows is only there to reap anything it left behind — nothing needs
   * to wait for it. A child the panel killed is a different matter: it is
   * inside a termination grace period, still connected to the database, and
   * still able to write. The lock stays held across that, because a second
   * migrate or reset started against it would race work nobody can see.
   */
  function terminate(
    child: OperationChildHandle,
    snapshot: OperationRunSnapshot,
    { hold }: { hold: boolean },
  ): void {
    if (hold) stopping = snapshot;
    void Promise.resolve(child.kill())
      // A handle that cannot report its own termination must not strand the
      // lock: the escalation has been issued either way.
      .catch(() => undefined)
      .finally(() => {
        if (!hold || stopping?.runId !== snapshot.runId) return;
        stopping = null;
        emit({ type: "state" });
      });
  }

  function publishLines(run: ActiveRun, lines: OperationOutputLine[]): void {
    if (lines.length === 0) return;
    run.snapshot = {
      ...run.snapshot,
      outputLineCount: run.collector.lines().length,
      outputProduced: run.collector.produced(),
      outputTruncated: run.collector.truncated(),
      truncationNotice: run.collector.describeTruncation(),
    };
    emit({ type: "output", runId: run.snapshot.runId, lines });
  }

  function settle(
    run: ActiveRun,
    outcome: OperationOutcome,
    message: string,
    /** True when the panel stopped the child rather than the child exiting. */
    forced = false,
  ): void {
    if (run.settled) return;
    run.settled = true;
    if (run.timer !== undefined) clearTimer(run.timer);
    run.timer = undefined;
    const child = run.child;
    run.child = undefined;
    publishLines(run, [...run.collector.flush()]);

    const snapshot: OperationRunSnapshot = {
      ...run.snapshot,
      finishedAt: now().toISOString(),
      outcome,
      message: sanitize(message),
      outputLineCount: run.collector.lines().length,
      outputProduced: run.collector.produced(),
      outputTruncated: run.collector.truncated(),
      truncationNotice: run.collector.describeTruncation(),
    };
    last = snapshot;
    lastOutput = run.collector.lines();
    if (active === run) active = null;
    // The run is no longer in doubt, so the marker that would have reported it
    // as unknown after a restart is cleared — queued behind the write that put
    // it there, never racing it.
    void persist(null);
    if (child !== undefined) terminate(child, snapshot, { hold: forced });
    emit({ type: "state" });
    onSettled?.(snapshot);
  }

  function handleExit(
    run: ActiveRun,
    code: number | null,
    signal: string | null,
  ): void {
    if (code === 0) {
      settle(run, "succeeded", `${run.definition.label} finished successfully.`);
      return;
    }
    settle(
      run,
      "failed",
      `${run.definition.label} did not finish: the workspace script ${run.definition.workspaceScript} ended with ${describeExit(code, signal)}.`,
    );
  }

  return {
    timeoutMs,
    lineLimit,

    async restore() {
      let stored: unknown;
      try {
        stored = await markerStore.load();
      } catch (error) {
        onPersistenceError?.(error);
        return;
      }
      const marker = parseOperationMarker(stored);
      if (marker === null) return;
      const snapshot: OperationRunSnapshot = {
        ...marker,
        finishedAt: now().toISOString(),
        outcome: "unknown",
        message: `The panel restarted while ${marker.label.toLowerCase()} was running against "${marker.database}", so its outcome is unknown. Check the database's state before running anything else.`,
        outputLineCount: 0,
        outputProduced: 0,
        outputTruncated: false,
        truncationNotice: null,
        interrupted: true,
      };
      last = snapshot;
      lastOutput = [];
      void persist(null);
      emit({ type: "state" });
      onSettled?.(snapshot);
    },

    running: () => active?.snapshot ?? null,
    last: () => last,
    output: () => (active ? active.collector.lines() : lastOutput),

    async start(request) {
      const definition = findDatabaseOperation(request.operation);
      if (definition === null) return unknownOperationRefusal();

      const decision = decideOperationStart({
        definition,
        // Execution time, not request time: resolved here, at the attempt.
        locality: permit(),
        running: blockingRun(),
        acknowledgement: request.acknowledgement,
        expectedDatabase: request.expectedDatabase,
      });
      if (!decision.ok) return decision;

      const run: ActiveRun = {
        definition,
        collector: createOperationOutputCollector({ lineLimit, sanitize }),
        settled: false,
        snapshot: {
          runId: createId(),
          operation: definition.id,
          label: definition.label,
          workspaceScript: definition.workspaceScript,
          database: decision.database,
          startedAt: now().toISOString(),
          finishedAt: null,
          outcome: null,
          message: null,
          outputLineCount: 0,
          outputProduced: 0,
          outputTruncated: false,
          truncationNotice: null,
          interrupted: false,
        },
      };
      // The lock is taken before anything is awaited, so two requests arriving
      // together cannot both find the panel idle.
      active = run;
      lastOutput = [];
      emit({ type: "state" });

      run.timer = setTimer(() => {
        run.collector.note(
          `The panel stopped waiting after ${Math.round(timeoutMs / 1_000)}s and terminated the workspace script.`,
        );
        settle(
          run,
          "timed_out",
          `${definition.label} was stopped after ${Math.round(timeoutMs / 1_000)}s without finishing. The database may be in a partially changed state.`,
          true,
        );
      }, timeoutMs);

      // Durable *before* the child exists, and awaited rather than hoped for: a
      // crash between here and the first line of output must still be reported
      // as unknown rather than lost.
      await persist({
        runId: run.snapshot.runId,
        operation: definition.id,
        label: definition.label,
        workspaceScript: definition.workspaceScript,
        database: decision.database,
        startedAt: run.snapshot.startedAt,
      });

      // The run can already have been settled — by the timeout, or by a
      // shutdown — while the marker was being written. Spawning now would
      // start a child nothing is watching.
      if (run.settled) return { ok: true, run: last as OperationRunSnapshot };

      try {
        const child = spawn({
          script: definition.workspaceScript,
          onOutput: (chunk) => publishLines(run, run.collector.append(chunk)),
          onExit: ({ code, signal }) => handleExit(run, code, signal),
          onError: (error) =>
            settle(run, "failed", `${definition.label} could not start: ${error.message}`),
        });
        // A child that already exited during `spawn` has settled the run;
        // adopting its handle now would leak it, so its group is reaped here.
        if (!run.settled) run.child = child;
        else terminate(child, last as OperationRunSnapshot, { hold: false });
      } catch (error) {
        settle(
          run,
          "failed",
          `${definition.label} could not start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return { ok: true, run: active?.snapshot ?? (last as OperationRunSnapshot) };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Terminate any child without settling the run: whatever the script had
     * already done to the database is genuinely unknown, and the marker left on
     * disk is what says so when the panel comes back.
     */
    shutdown() {
      if (active) {
        if (active.timer !== undefined) clearTimer(active.timer);
        active.timer = undefined;
        const child = active.child;
        active.child = undefined;
        // The first signal goes out synchronously, so it still reaches the
        // process group when this runs from an `exit` handler that will never
        // resume a continuation. The run is deliberately left unsettled, so
        // `active` already holds the lock for as long as this process lives.
        if (child !== undefined) {
          terminate(child, active.snapshot, { hold: false });
        }
      }
      listeners.clear();
    },
  };
}
