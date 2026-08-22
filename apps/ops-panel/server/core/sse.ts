/**
 * Server-sent-event conventions for the whole panel. admin-tools/011 through
 * admin-tools/015 stream through this module rather than hand-rolling framing,
 * so every stream carries the same guarantees:
 *
 *  - named events, so a client subscribes to what it needs;
 *  - a retry hint, so a disconnected client reconnects on the panel's schedule;
 *  - periodic heartbeats, so idle streams survive intermediaries and the client
 *    can tell "quiet" from "dead";
 *  - proxy buffering disabled, so a tail is not held back;
 *  - teardown that releases per-connection resources exactly once.
 *
 * Framework-free: the transport supplies `write`/`close` and a timer.
 */

export const SSE_RETRY_MS = 3_000;
export const SSE_HEARTBEAT_MS = 15_000;

export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Disable proxy buffering (nginx and compatible intermediaries).
  "x-accel-buffering": "no",
});

export function formatRetryHint(milliseconds: number): string {
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new Error("A server-sent retry hint must be a non-negative integer.");
  }
  return `retry: ${milliseconds}\n\n`;
}

export function formatHeartbeat(): string {
  return ": heartbeat\n\n";
}

/** Frame one named event. Multi-line payloads are split across `data:` lines. */
export function formatServerSentEvent({
  event,
  data,
  id,
}: {
  event: string;
  data: string;
  id?: string;
}): string {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(event)) {
    throw new Error(`A server-sent event name is invalid: ${JSON.stringify(event)}`);
  }
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  for (const line of data.split(/\r\n|\r|\n/u)) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

export interface ServerSentStreamOptions {
  write: (chunk: string) => void;
  close: () => void;
  retryMs?: number;
  heartbeatMs?: number;
  setTimer?: (handler: () => void, milliseconds: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Released on teardown: subscriptions, pollers, watchers. */
  onTeardown?: () => void;
}

export interface ServerSentStream {
  open(): void;
  send(event: string, payload: unknown, id?: string): boolean;
  heartbeat(): boolean;
  teardown(): void;
  isOpen(): boolean;
}

export function createServerSentStream({
  write,
  close,
  retryMs = SSE_RETRY_MS,
  heartbeatMs = SSE_HEARTBEAT_MS,
  setTimer = (handler, milliseconds) => setInterval(handler, milliseconds),
  clearTimer = (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  onTeardown,
}: ServerSentStreamOptions): ServerSentStream {
  let open = false;
  let torndown = false;
  let heartbeatHandle: unknown;

  function safeWrite(chunk: string): boolean {
    if (!open || torndown) return false;
    write(chunk);
    return true;
  }

  const stream: ServerSentStream = {
    open() {
      if (open || torndown) return;
      open = true;
      write(formatRetryHint(retryMs));
      heartbeatHandle = setTimer(() => {
        stream.heartbeat();
      }, heartbeatMs);
    },
    send(event, payload, id) {
      return safeWrite(
        formatServerSentEvent({ event, data: JSON.stringify(payload) ?? "null", id }),
      );
    },
    heartbeat() {
      return safeWrite(formatHeartbeat());
    },
    teardown() {
      if (torndown) return;
      torndown = true;
      open = false;
      if (heartbeatHandle !== undefined) {
        clearTimer(heartbeatHandle);
        heartbeatHandle = undefined;
      }
      onTeardown?.();
      close();
    },
    isOpen: () => open && !torndown,
  };

  return stream;
}
