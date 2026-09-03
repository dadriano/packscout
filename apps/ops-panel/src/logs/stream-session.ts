/**
 * The connection lifecycle, as a decision rather than a tangle of refs.
 *
 * `EventSource` reconnects on its own, which is convenient for the transport
 * and dangerous for the view: the socket comes back, but whatever was written
 * while it was down was never delivered to anybody. Appending the next live
 * batch onto the existing buffer would splice two moments together with nothing
 * between them, and the reader would have no way to tell.
 *
 * So a re-open is treated as a break in continuity, not a resumption: the
 * buffer is thrown away, the initial windows are read again, and the seam is
 * marked. This module owns that judgement so it can be proved without a browser
 * or a React renderer; the hook only carries the decision out.
 */

export type LogStreamPhase = "connecting" | "live" | "reconnecting";

export type LogStreamAction =
  /** Nothing to do; the transition changed only what the chip says. */
  | "none"
  /** First connection: read the initial windows and merge them in. */
  | "load-initial-window"
  /** Re-connection: the buffer is stale, so reset and read the windows again. */
  | "reset-and-refetch";

export interface LogStreamTransition {
  phase: LogStreamPhase;
  action: LogStreamAction;
  /** True when the reader must be told the stream was interrupted. */
  markSeam: boolean;
}

export interface LogStreamSession {
  phase(): LogStreamPhase;
  /** The stream opened. */
  opened(): LogStreamTransition;
  /** The stream errored or dropped. */
  failed(): LogStreamTransition;
}

export function createLogStreamSession(): LogStreamSession {
  let phase: LogStreamPhase = "connecting";
  let connectedBefore = false;

  return {
    phase: () => phase,

    opened() {
      // A duplicate open on an already-live stream is not a break in
      // continuity, and must not be allowed to discard a good buffer.
      if (phase === "live") {
        return { phase, action: "none", markSeam: false };
      }
      const reconnected = connectedBefore;
      connectedBefore = true;
      phase = "live";
      return {
        phase,
        action: reconnected ? "reset-and-refetch" : "load-initial-window",
        markSeam: reconnected,
      };
    },

    failed() {
      // Before the first successful connection this is still the initial
      // attempt; calling it a reconnection would overstate what happened.
      phase = connectedBefore ? "reconnecting" : "connecting";
      return { phase, action: "none", markSeam: false };
    },
  };
}
