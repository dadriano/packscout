import {
  createLogTailer,
  type LogTailer,
  type TailEmission,
} from "./log-tail.ts";
import {
  createLogMarkerRecord,
  type LogLineRecord,
  type LogMarkerRecord,
} from "./log-records.ts";

/**
 * One place every service's tail is kept, and one place every viewer listens.
 *
 * Delivery is a single stream carrying all services, because the alternative —
 * a connection per service — spends the browser's per-origin connection budget
 * on a decision (which services to show) that is a *view* concern. Toggling a
 * service therefore filters locally and never disturbs the connection.
 *
 * Viewer attachment is reference counted here rather than per tailer, so the
 * fleet moves between passive and active as a unit: the first viewer wakes
 * every tail, the last one to leave puts them all back to identity-only
 * tracking.
 */

export interface LogStreamBatch {
  lines: LogLineRecord[];
  markers: LogMarkerRecord[];
}

export type LogStreamListener = (batch: LogStreamBatch) => void;

export interface LogStreamHub {
  /** Get or create the tailer for a service. */
  tailer(service: string): LogTailer;
  peek(service: string): LogTailer | undefined;
  services(): string[];
  viewerCount(): number;
  /** Attach a viewer; the returned function detaches it exactly once. */
  subscribe(listener: LogStreamListener): () => void;
  /** Fan a batch out; empty batches are dropped rather than framed. */
  publish(batch: TailEmission): void;
  nextSequence(): number;
  /** Build a hub-scoped marker (used for panel-wide notices). */
  marker(input: {
    kind: LogMarkerRecord["kind"];
    reason: LogMarkerRecord["reason"];
    service: string;
    generation?: number;
    offset?: number;
    detail: string;
    observedAt?: string;
  }): LogMarkerRecord;
}

export interface LogStreamHubOptions {
  createTailer?: (service: string, nextSequence: () => number) => LogTailer;
}

export function createLogStreamHub({
  createTailer = (service, nextSequence) =>
    createLogTailer({ service, nextSequence }),
}: LogStreamHubOptions = {}): LogStreamHub {
  const tailers = new Map<string, LogTailer>();
  const listeners = new Set<LogStreamListener>();
  const detachers = new Map<LogStreamListener, Array<() => void>>();
  let sequence = 0;

  function nextSequence(): number {
    sequence += 1;
    return sequence;
  }

  const hub: LogStreamHub = {
    nextSequence,

    tailer(service) {
      const existing = tailers.get(service);
      if (existing) return existing;
      const created = createTailer(service, nextSequence);
      tailers.set(service, created);
      // A service discovered while viewers are watching joins them
      // immediately, so its first bytes are not silently dropped.
      for (const releases of detachers.values()) releases.push(created.attach());
      return created;
    },

    peek: (service) => tailers.get(service),
    services: () => [...tailers.keys()].sort(),
    viewerCount: () => listeners.size,

    subscribe(listener) {
      listeners.add(listener);
      const releases = [...tailers.values()].map((tailer) => tailer.attach());
      detachers.set(listener, releases);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        listeners.delete(listener);
        for (const release of detachers.get(listener) ?? []) release();
        detachers.delete(listener);
      };
    },

    publish(batch) {
      if (batch.lines.length === 0 && batch.markers.length === 0) return;
      const payload: LogStreamBatch = {
        lines: batch.lines,
        markers: batch.markers,
      };
      for (const listener of [...listeners]) listener(payload);
    },

    marker(input) {
      return createLogMarkerRecord({
        kind: input.kind,
        reason: input.reason,
        service: input.service,
        generation: input.generation ?? 0,
        offset: input.offset ?? 0,
        observedAt: input.observedAt ?? new Date().toISOString(),
        detail: input.detail,
        sequence: nextSequence(),
      });
    },
  };

  return hub;
}
