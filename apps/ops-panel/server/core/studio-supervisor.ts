import { isLoopbackHostname } from "./loopback.ts";

/**
 * Supervision for the ORM's row browser, which the panel runs as a child
 * process rather than reimplementing.
 *
 * The child is a *second HTTP listener*, so it could quietly undo the panel's
 * structural security model. Four rules prevent that:
 *
 *  1. it is bound to a loopback address the panel chooses, never a routable one;
 *  2. the address it announces on startup must itself be loopback, or the panel
 *     kills it and refuses to embed — an announcement that is missing or
 *     unreadable fails closed the same way;
 *  3. the embedded URL is built from the panel's own loopback host and port, so
 *     a hostile announcement cannot redirect the frame;
 *  4. starting is gated by an injected server-side permit (the database-locality
 *     gate), re-evaluated on every start, so no client state can authorize it.
 *
 * Startup is bounded, exits are reflected as state rather than silence, and
 * `shutdown()` always terminates the child. Child output is read only to detect
 * readiness and is never stored or forwarded: the ORM prints its datasource URL
 * on some failures, and that URL carries credentials.
 */

export type StudioPhase = "stopped" | "starting" | "ready" | "stopping" | "failed";

export interface StudioState {
  readonly phase: StudioPhase;
  /** Set only while `ready`, and only after the loopback check passed. */
  readonly embedUrl: string | null;
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  /** Why it failed, or why a start was refused. Never contains credentials. */
  readonly message: string | null;
}

export interface StudioSpawnRequest {
  readonly port: number;
  readonly hostname: string;
  readonly onOutput: (chunk: string) => void;
  readonly onExit: (result: { code: number | null; signal: string | null }) => void;
  readonly onError: (error: Error) => void;
}

export interface StudioChildHandle {
  kill(): void;
}

export type StudioSpawn = (request: StudioSpawnRequest) => StudioChildHandle;

export type StudioPermit = () => { allowed: true } | { allowed: false; message: string };

export interface StudioSupervisorOptions {
  spawn: StudioSpawn;
  port: number;
  /** Must be loopback: the panel refuses to run the child anywhere else. */
  hostname?: string;
  permit: StudioPermit;
  startupTimeoutMs?: number;
  now?: () => Date;
  setTimer?: (handler: () => void, milliseconds: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface StudioStartResult {
  readonly started: boolean;
  readonly state: StudioState;
  readonly message: string | null;
}

export interface StudioSupervisor {
  state(): StudioState;
  readonly startupTimeoutMs: number;
  start(): StudioStartResult;
  stop(): StudioState;
  shutdown(): void;
  subscribe(listener: (state: StudioState) => void): () => void;
}

/** Long enough for a cold ORM start, short enough that a hang is reported. */
export const STUDIO_STARTUP_TIMEOUT_MS = 30_000;

const READY_URL_PATTERN = /https?:\/\/[^\s"'<>]+/u;

const STOPPED: StudioState = {
  phase: "stopped",
  embedUrl: null,
  startedAt: null,
  readyAt: null,
  message: null,
};

/**
 * Pull the address the child announced out of its startup output. Returns null
 * until a line both mentions the row browser being up and carries a URL, so
 * partial reads never register as readiness.
 */
export function readAnnouncedStudioUrl(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    if (!/\bup on\b/iu.test(line)) continue;
    const match = READY_URL_PATTERN.exec(line);
    if (match) return match[0].replace(/[.,)]+$/u, "");
  }
  return null;
}

/** Fail-closed: an unparseable or non-loopback announcement is not embeddable. */
export function isLoopbackAnnouncement(announced: string | null): boolean {
  if (announced === null) return false;
  try {
    return isLoopbackHostname(new URL(announced).hostname);
  } catch {
    return false;
  }
}

function describeExit(code: number | null, signal: string | null): string {
  if (signal !== null) return `signal ${signal}`;
  return code === null ? "an unknown status" : `exit code ${code}`;
}

export function createStudioSupervisor({
  spawn,
  port,
  hostname = "127.0.0.1",
  permit,
  startupTimeoutMs = STUDIO_STARTUP_TIMEOUT_MS,
  now = () => new Date(),
  setTimer = (handler, milliseconds) => setTimeout(handler, milliseconds),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: StudioSupervisorOptions): StudioSupervisor {
  if (!isLoopbackHostname(hostname)) {
    throw new Error(
      "The operations panel only runs the row browser on a loopback address; it never binds a routable interface.",
    );
  }

  let state: StudioState = STOPPED;
  let child: StudioChildHandle | undefined;
  let timeout: unknown;
  let output = "";
  const listeners = new Set<(state: StudioState) => void>();

  function publish(next: Partial<StudioState> & { phase: StudioPhase }): void {
    state = { ...STOPPED, ...next };
    for (const listener of listeners) listener(state);
  }

  /**
   * Read the phase through a call so a callback that already moved the state on
   * — a child that reported readiness or died during `spawn` — is observed, not
   * assumed away.
   */
  function phaseNow(): StudioPhase {
    return state.phase;
  }

  function clearStartupTimer(): void {
    if (timeout === undefined) return;
    clearTimer(timeout);
    timeout = undefined;
  }

  function terminate(): void {
    clearStartupTimer();
    output = "";
    const running = child;
    child = undefined;
    running?.kill();
  }

  function fail(message: string): void {
    const startedAt = state.startedAt;
    terminate();
    publish({ phase: "failed", startedAt, message });
  }

  function handleOutput(chunk: string): void {
    if (state.phase !== "starting") return;
    // Bounded: readiness is announced in the first lines, and unbounded child
    // output must never accumulate in the panel's memory.
    output = `${output}${chunk}`.slice(-8_192);
    const announced = readAnnouncedStudioUrl(output);
    if (announced === null) return;
    if (!isLoopbackAnnouncement(announced)) {
      fail(
        "The row browser reported an address the panel cannot prove is loopback, so it was stopped instead of embedded.",
      );
      return;
    }
    clearStartupTimer();
    output = "";
    publish({
      phase: "ready",
      startedAt: state.startedAt,
      readyAt: now().toISOString(),
      embedUrl: `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`,
    });
  }

  function handleExit(code: number | null, signal: string | null): void {
    if (state.phase === "stopped" || state.phase === "failed") return;
    if (state.phase === "stopping") {
      terminate();
      publish({ phase: "stopped" });
      return;
    }
    const context =
      state.phase === "ready"
        ? "The row browser exited"
        : "The row browser exited before it was ready";
    fail(`${context} (${describeExit(code, signal)}).`);
  }

  return {
    startupTimeoutMs,
    state: () => state,

    start() {
      if (state.phase === "starting" || state.phase === "ready") {
        return { started: false, state, message: "The row browser is already running." };
      }
      const decision = permit();
      if (!decision.allowed) {
        publish({ phase: "failed", message: decision.message });
        return { started: false, state, message: decision.message };
      }

      output = "";
      publish({ phase: "starting", startedAt: now().toISOString() });
      timeout = setTimer(() => {
        fail(
          `The row browser did not report readiness within ${Math.round(startupTimeoutMs / 1_000)}s, so it was stopped.`,
        );
      }, startupTimeoutMs);

      try {
        const handle = spawn({
          port,
          hostname,
          onOutput: handleOutput,
          onExit: ({ code, signal }) => handleExit(code, signal),
          onError: (error) =>
            fail(`The row browser could not start: ${error.message}`),
        });
        // A child that already reported readiness or death during `spawn` has
        // moved the state on; adopting its handle now would leak it.
        const settled = phaseNow();
        if (settled === "starting" || settled === "ready") child = handle;
        else handle.kill();
      } catch (error) {
        fail(
          `The row browser could not start: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { started: false, state, message: state.message };
      }
      return { started: true, state, message: null };
    },

    stop() {
      if (state.phase === "stopped" || state.phase === "failed") {
        publish({ phase: "stopped" });
        return state;
      }
      const running = child;
      clearStartupTimer();
      publish({ phase: "stopping", startedAt: state.startedAt });
      running?.kill();
      return state;
    },

    shutdown() {
      terminate();
      state = STOPPED;
      listeners.clear();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
