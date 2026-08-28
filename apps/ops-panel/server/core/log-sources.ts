import { serviceNameFromLogFileName } from "./service-logs.ts";

/**
 * Log-source discovery: the snapshot contract admin-tools/011 (tailing) and
 * admin-tools/012 (history) consume. Framework-free so appear/disappear/rename
 * behavior is provable without a filesystem or a browser.
 */

export interface LogFileIdentity {
  /** Device id of the containing filesystem. */
  deviceId: number;
  /** Inode number; together with deviceId this identifies the file itself. */
  inode: number;
  sizeBytes: number;
  modifiedAtMs: number;
}

export interface LogSource {
  service: string;
  fileName: string;
  /** Stable identity of the file behind the name; changes on rotation. */
  fileId: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface LogSourceDiff {
  added: LogSource[];
  removed: LogSource[];
  changed: LogSource[];
}

export interface LogSourceChange extends LogSourceDiff {
  sources: LogSource[];
  revision: number;
}

export type LogSourceListener = (change: LogSourceChange) => void;

export interface LogSourceRegistry {
  snapshot(): LogSource[];
  revision(): number;
  /** Apply a fresh listing. Returns the change, or null when nothing moved. */
  refresh(listing: readonly LogSource[]): LogSourceChange | null;
  subscribe(listener: LogSourceListener): () => void;
  listenerCount(): number;
}

export function formatFileId(identity: LogFileIdentity): string {
  return `${identity.deviceId}:${identity.inode}`;
}

/**
 * Build a source from a directory entry. Returns null when the file name is not
 * part of the convention, so unsafe names never reach a consumer.
 */
export function toLogSource(
  fileName: string,
  identity: LogFileIdentity,
): LogSource | null {
  const service = serviceNameFromLogFileName(fileName);
  if (service === null) return null;
  if (!Number.isFinite(identity.sizeBytes) || identity.sizeBytes < 0) return null;
  if (!Number.isFinite(identity.modifiedAtMs)) return null;
  return {
    service,
    fileName,
    fileId: formatFileId(identity),
    sizeBytes: identity.sizeBytes,
    modifiedAt: new Date(identity.modifiedAtMs).toISOString(),
  };
}

export function sortLogSources(sources: readonly LogSource[]): LogSource[] {
  return [...sources].sort((left, right) =>
    left.service.localeCompare(right.service, "en-US"),
  );
}

function sameSource(left: LogSource, right: LogSource): boolean {
  return (
    left.fileId === right.fileId &&
    left.sizeBytes === right.sizeBytes &&
    left.modifiedAt === right.modifiedAt &&
    left.fileName === right.fileName
  );
}

export function diffLogSources(
  previous: readonly LogSource[],
  next: readonly LogSource[],
): LogSourceDiff {
  const previousByService = new Map(
    previous.map((source) => [source.service, source]),
  );
  const nextByService = new Map(next.map((source) => [source.service, source]));

  const added: LogSource[] = [];
  const changed: LogSource[] = [];
  for (const source of next) {
    const existing = previousByService.get(source.service);
    if (!existing) {
      added.push(source);
    } else if (!sameSource(existing, source)) {
      changed.push(source);
    }
  }

  const removed = previous.filter(
    (source) => !nextByService.has(source.service),
  );

  return {
    added: sortLogSources(added),
    removed: sortLogSources(removed),
    changed: sortLogSources(changed),
  };
}

export function isEmptyDiff(diff: LogSourceDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0
  );
}

/**
 * Holds the current source list and fans changes out to subscribers. It owns no
 * timers and no filesystem access; the poller adapter supplies listings.
 */
export function createLogSourceRegistry(
  initial: readonly LogSource[] = [],
): LogSourceRegistry {
  let sources = sortLogSources(initial);
  let currentRevision = 0;
  const listeners = new Set<LogSourceListener>();

  return {
    snapshot: () => [...sources],
    revision: () => currentRevision,
    refresh(listing) {
      const next = sortLogSources(listing);
      const diff = diffLogSources(sources, next);
      if (isEmptyDiff(diff)) return null;
      sources = next;
      currentRevision += 1;
      const change: LogSourceChange = {
        ...diff,
        sources: [...sources],
        revision: currentRevision,
      };
      for (const listener of [...listeners]) listener(change);
      return change;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listenerCount: () => listeners.size,
  };
}
