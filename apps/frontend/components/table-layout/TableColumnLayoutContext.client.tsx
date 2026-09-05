"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  TableColumnLayoutEntry,
  TableColumnLayoutTableKey,
} from "@packscout/contracts";
import {
  isDefaultTableColumnLayout,
  moveTableColumn,
  reconcileTableColumnLayout,
  setTableColumnVisibility,
  summarizeTableColumnLayout,
  type TableColumnDefinition,
  type TableColumnLayout,
  type TableColumnLayoutSummary,
} from "@/lib/table-column-layout";
import { sessionTableColumnLayoutStore } from "@/lib/table-column-layout.client";

export type TableColumnLayoutPersistence = "session" | "account";

export type TableColumnLayoutSaveState = "idle" | "saving" | "error";

export type TableColumnLayoutStore = Readonly<{
  /** Where a change made right now is kept. */
  persistence: TableColumnLayoutPersistence;
  /** True while the account layout has not arrived yet. */
  loading: boolean;
  saveState: TableColumnLayoutSaveState;
  read: (
    tableKey: TableColumnLayoutTableKey,
  ) => readonly TableColumnLayoutEntry[] | null;
  write: (
    tableKey: TableColumnLayoutTableKey,
    entries: readonly TableColumnLayoutEntry[],
  ) => void;
  clear: (tableKey: TableColumnLayoutTableKey) => void;
}>;

/**
 * The store a table sees when no provider is mounted above it — isolated
 * surface tests and any host that renders the table outside the app tree.
 * It yields the default layout and remembers nothing; the wiring source test
 * guarantees every real provider tree mounts a live store.
 */
export const unavailableTableColumnLayoutStore: TableColumnLayoutStore =
  Object.freeze({
    persistence: "session",
    loading: false,
    saveState: "idle",
    read: () => null,
    write: () => undefined,
    clear: () => undefined,
  });

export const TableColumnLayoutContext = createContext<TableColumnLayoutStore>(
  unavailableTableColumnLayoutStore,
);

export type SessionTableColumnLayouts = Readonly<{
  read: TableColumnLayoutStore["read"];
  write: TableColumnLayoutStore["write"];
  clear: TableColumnLayoutStore["clear"];
}>;

/** Per-tab layouts. The server snapshot is empty, so SSR renders defaults. */
export function useSessionTableColumnLayouts(): SessionTableColumnLayouts {
  const snapshot = useSyncExternalStore(
    sessionTableColumnLayoutStore.subscribe,
    sessionTableColumnLayoutStore.getSnapshot,
    sessionTableColumnLayoutStore.getServerSnapshot,
  );
  const read = useCallback<TableColumnLayoutStore["read"]>(
    (tableKey) => snapshot[tableKey] ?? null,
    [snapshot],
  );
  return useMemo(
    () => ({
      read,
      write: sessionTableColumnLayoutStore.write,
      clear: sessionTableColumnLayoutStore.clear,
    }),
    [read],
  );
}

export function SessionTableColumnLayoutProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = useSessionTableColumnLayouts();
  const value = useMemo<TableColumnLayoutStore>(
    () => ({
      persistence: "session",
      loading: false,
      saveState: "idle",
      read: session.read,
      write: session.write,
      clear: session.clear,
    }),
    [session],
  );
  return (
    <TableColumnLayoutContext.Provider value={value}>
      {children}
    </TableColumnLayoutContext.Provider>
  );
}

export type TableColumnLayoutColumn<K extends string> = TableColumnDefinition<K> &
  Readonly<{ visible: boolean }>;

export type TableColumnLayoutController<K extends string> = Readonly<{
  layout: TableColumnLayout<K>;
  columns: readonly TableColumnLayoutColumn<K>[];
  summary: TableColumnLayoutSummary;
  persistence: TableColumnLayoutPersistence;
  loading: boolean;
  saveState: TableColumnLayoutSaveState;
  setVisible: (key: K, visible: boolean) => void;
  move: (key: K, toIndex: number) => void;
  reset: () => void;
}>;

export function useTableColumnLayout<K extends string>(
  tableKey: TableColumnLayoutTableKey,
  definitions: readonly TableColumnDefinition<K>[],
): TableColumnLayoutController<K> {
  const store = useContext(TableColumnLayoutContext);
  const stored = store.read(tableKey);
  const layout = useMemo(
    () => reconcileTableColumnLayout(stored, definitions),
    [definitions, stored],
  );
  const columns = useMemo(
    () =>
      layout.flatMap((entry) => {
        const definition = definitions.find(({ key }) => key === entry.key);
        return definition ? [{ ...definition, visible: entry.visible }] : [];
      }),
    [definitions, layout],
  );
  const summary = useMemo(
    () => summarizeTableColumnLayout(layout, definitions),
    [definitions, layout],
  );
  const { clear, write } = store;
  const commit = useCallback(
    (next: TableColumnLayout<K>) => {
      if (next === layout) return;
      if (isDefaultTableColumnLayout(next, definitions)) clear(tableKey);
      else write(tableKey, next);
    },
    [clear, definitions, layout, tableKey, write],
  );

  return useMemo(
    () => ({
      layout,
      columns,
      summary,
      persistence: store.persistence,
      loading: store.loading,
      saveState: store.saveState,
      setVisible: (key, visible) =>
        commit(setTableColumnVisibility(layout, definitions, key, visible)),
      move: (key, toIndex) => commit(moveTableColumn(layout, key, toIndex)),
      reset: () => {
        if (summary.customized) clear(tableKey);
      },
    }),
    [
      clear,
      columns,
      commit,
      definitions,
      layout,
      store.loading,
      store.persistence,
      store.saveState,
      summary,
      tableKey,
    ],
  );
}
