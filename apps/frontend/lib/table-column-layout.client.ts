import {
  TABLE_COLUMN_LAYOUT_TABLE_KEYS,
  type TableColumnLayoutEntry,
  type TableColumnLayoutTableKey,
} from "@packscout/contracts";
import {
  browserSessionTableColumnLayoutStorage,
  clearStoredTableColumnLayout,
  readStoredTableColumnLayout,
  writeStoredTableColumnLayout,
  type TableColumnLayoutStorage,
} from "./table-column-layout";

export type SessionTableColumnLayoutSnapshot = Readonly<
  Partial<Record<TableColumnLayoutTableKey, readonly TableColumnLayoutEntry[]>>
>;

export type SessionTableColumnLayoutStore = Readonly<{
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => SessionTableColumnLayoutSnapshot;
  getServerSnapshot: () => SessionTableColumnLayoutSnapshot;
  write: (
    tableKey: TableColumnLayoutTableKey,
    entries: readonly TableColumnLayoutEntry[],
  ) => void;
  clear: (tableKey: TableColumnLayoutTableKey) => void;
}>;

const EMPTY_SNAPSHOT: SessionTableColumnLayoutSnapshot = Object.freeze({});

/**
 * A `useSyncExternalStore`-shaped view over per-tab session storage. The
 * snapshot is cached so React sees a stable reference until a write happens.
 */
export function createSessionTableColumnLayoutStore(
  resolveStorage: () => TableColumnLayoutStorage | null,
): SessionTableColumnLayoutStore {
  const listeners = new Set<() => void>();
  let snapshot: SessionTableColumnLayoutSnapshot | null = null;

  function load(): SessionTableColumnLayoutSnapshot {
    const storage = resolveStorage();
    const loaded: Partial<
      Record<TableColumnLayoutTableKey, readonly TableColumnLayoutEntry[]>
    > = {};
    for (const tableKey of TABLE_COLUMN_LAYOUT_TABLE_KEYS) {
      const entries = readStoredTableColumnLayout(storage, tableKey);
      if (entries !== null) loaded[tableKey] = entries;
    }
    return Object.freeze(loaded);
  }

  function getSnapshot(): SessionTableColumnLayoutSnapshot {
    snapshot ??= load();
    return snapshot;
  }

  function emit(): void {
    for (const listener of listeners) listener();
  }

  return Object.freeze({
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot,
    getServerSnapshot: () => EMPTY_SNAPSHOT,
    write(tableKey, entries) {
      writeStoredTableColumnLayout(resolveStorage(), tableKey, entries);
      snapshot = Object.freeze({ ...getSnapshot(), [tableKey]: entries });
      emit();
    },
    clear(tableKey) {
      clearStoredTableColumnLayout(resolveStorage(), tableKey);
      const next = { ...getSnapshot() };
      delete next[tableKey];
      snapshot = Object.freeze(next);
      emit();
    },
  });
}

export const sessionTableColumnLayoutStore = createSessionTableColumnLayoutStore(
  browserSessionTableColumnLayoutStorage,
);
