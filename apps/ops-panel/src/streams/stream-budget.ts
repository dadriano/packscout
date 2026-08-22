/**
 * A per-tab budget for concurrent server-sent-event streams.
 *
 * Browsers cap simultaneous HTTP/1.1 connections per origin (commonly six), and
 * every open stream holds one for its whole lifetime. Without a budget, a panel
 * with several live surfaces open — admin-tools/011 through admin-tools/015 all
 * add one — would exhaust the cap and stall ordinary fetches.
 *
 * Framework-free and callback-based so a React effect can cancel a pending
 * request during cleanup without unresolved promises.
 */

/** Leaves headroom for ordinary fetches inside the browser's per-origin cap. */
export const DEFAULT_STREAM_BUDGET = 3;

export interface StreamLease {
  readonly name: string;
  release(): void;
  isActive(): boolean;
}

export interface StreamBudget {
  readonly limit: number;
  activeCount(): number;
  queuedCount(): number;
  /**
   * Ask for a stream slot. `onGranted` runs immediately when capacity exists,
   * otherwise when a slot frees in request order. The returned function cancels
   * a queued request or releases a granted one.
   */
  request(name: string, onGranted: (lease: StreamLease) => void): () => void;
}

export function createStreamBudget(limit = DEFAULT_STREAM_BUDGET): StreamBudget {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("A stream budget limit must be a positive integer.");
  }

  let active = 0;
  const queue: Array<{
    name: string;
    onGranted: (lease: StreamLease) => void;
    cancelled: boolean;
  }> = [];

  function grant(name: string, onGranted: (lease: StreamLease) => void): StreamLease {
    active += 1;
    let released = false;
    const lease: StreamLease = {
      name,
      release() {
        if (released) return;
        released = true;
        active -= 1;
        drain();
      },
      isActive: () => !released,
    };
    onGranted(lease);
    return lease;
  }

  function drain(): void {
    while (active < limit && queue.length > 0) {
      const next = queue.shift();
      if (!next || next.cancelled) continue;
      grant(next.name, next.onGranted);
    }
  }

  return {
    limit,
    activeCount: () => active,
    queuedCount: () => queue.filter((entry) => !entry.cancelled).length,
    request(name, onGranted) {
      if (active < limit) {
        const lease = grant(name, onGranted);
        return () => lease.release();
      }
      const waiting = { name, onGranted, cancelled: false };
      queue.push(waiting);
      return () => {
        waiting.cancelled = true;
      };
    },
  };
}

/** One budget per tab: every surface in the panel shares it. */
export const panelStreamBudget = createStreamBudget();
