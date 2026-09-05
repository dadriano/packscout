"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation } from "convex/react";
import {
  TABLE_COLUMN_LAYOUT_TABLE_KEYS,
  type TableColumnLayoutEntry,
} from "@packscout/contracts";
import { api } from "../../../../convex/_generated/api";
import { usePackScoutAuth } from "@/components/auth/AuthContext.client";
import { useTolerantQuery } from "@/components/auth/tolerant-query.client";
import {
  TableColumnLayoutContext,
  useSessionTableColumnLayouts,
  type TableColumnLayoutSaveState,
  type TableColumnLayoutStore,
} from "./TableColumnLayoutContext.client";

function plainColumns(
  entries: readonly TableColumnLayoutEntry[],
): Array<{ key: string; visible: boolean }> {
  return entries.map(({ key, visible }) => ({ key, visible }));
}

/**
 * Signed-in viewers keep layouts on their account; everyone else keeps them for
 * the tab. A tab layout is adopted into the account the first time its owner
 * signs in without one, which is what "sign in to keep it" promises.
 *
 * The account read goes through the tolerant hook: the capability gate refuses
 * it for a held closed-beta account as a matter of course, and a layout is
 * display state, so a refusal simply leaves that viewer on the tab-scoped
 * layout instead of taking the page down.
 */
export function AccountTableColumnLayoutProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const auth = usePackScoutAuth();
  const signedIn = auth.status === "signed_in";
  const session = useSessionTableColumnLayouts();
  const layoutsQuery = useTolerantQuery(
    api.tableColumnLayouts.getTableColumnLayouts,
    signedIn ? {} : "skip",
  );
  const layouts = layoutsQuery.data;
  const accountAvailable = signedIn && layoutsQuery.error === undefined;
  const setLayoutBase = useMutation(api.tableColumnLayouts.setTableColumnLayout);
  const clearLayoutBase = useMutation(
    api.tableColumnLayouts.clearTableColumnLayout,
  );
  const setLayout = useMemo(
    () =>
      setLayoutBase.withOptimisticUpdate((localStore, args) => {
        const current = localStore.getQuery(
          api.tableColumnLayouts.getTableColumnLayouts,
          {},
        );
        if (current === undefined) return;
        localStore.setQuery(api.tableColumnLayouts.getTableColumnLayouts, {}, [
          ...current.filter(({ tableKey }) => tableKey !== args.tableKey),
          { tableKey: args.tableKey, columns: args.columns },
        ]);
      }),
    [setLayoutBase],
  );
  const clearLayout = useMemo(
    () =>
      clearLayoutBase.withOptimisticUpdate((localStore, args) => {
        const current = localStore.getQuery(
          api.tableColumnLayouts.getTableColumnLayouts,
          {},
        );
        if (current === undefined) return;
        localStore.setQuery(
          api.tableColumnLayouts.getTableColumnLayouts,
          {},
          current.filter(({ tableKey }) => tableKey !== args.tableKey),
        );
      }),
    [clearLayoutBase],
  );
  const [saveState, setSaveState] = useState<TableColumnLayoutSaveState>("idle");
  const pendingWrites = useRef(0);
  const adoptedTableKeys = useRef(new Set<string>());

  const persist = useCallback((operation: Promise<unknown>) => {
    pendingWrites.current += 1;
    setSaveState("saving");
    operation.then(
      () => {
        pendingWrites.current -= 1;
        if (pendingWrites.current === 0) setSaveState("idle");
      },
      () => {
        pendingWrites.current -= 1;
        setSaveState("error");
      },
    );
  }, []);

  useEffect(() => {
    if (!accountAvailable || layouts === undefined) return;
    for (const tableKey of TABLE_COLUMN_LAYOUT_TABLE_KEYS) {
      if (adoptedTableKeys.current.has(tableKey)) continue;
      if (layouts.some((layout) => layout.tableKey === tableKey)) continue;
      const entries = session.read(tableKey);
      if (entries === null) continue;
      adoptedTableKeys.current.add(tableKey);
      // Adoption is silent: the optimistic update shows the layout at once and
      // only a failure needs to surface, from the async callback.
      setLayout({ tableKey, columns: plainColumns(entries) }).then(
        () => session.clear(tableKey),
        () => setSaveState("error"),
      );
    }
  }, [accountAvailable, layouts, session, setLayout]);

  const value = useMemo<TableColumnLayoutStore>(
    () => ({
      persistence: accountAvailable ? "account" : "session",
      loading: accountAvailable && layouts === undefined,
      saveState: accountAvailable ? saveState : "idle",
      read: (tableKey) =>
        accountAvailable
          ? layouts?.find((layout) => layout.tableKey === tableKey)?.columns ??
            null
          : session.read(tableKey),
      write: (tableKey, entries) => {
        if (accountAvailable) {
          persist(setLayout({ tableKey, columns: plainColumns(entries) }));
        } else {
          session.write(tableKey, entries);
        }
      },
      clear: (tableKey) => {
        if (accountAvailable) persist(clearLayout({ tableKey }));
        else session.clear(tableKey);
      },
    }),
    [
      accountAvailable,
      clearLayout,
      layouts,
      persist,
      saveState,
      session,
      setLayout,
    ],
  );

  return (
    <TableColumnLayoutContext.Provider value={value}>
      {children}
    </TableColumnLayoutContext.Provider>
  );
}
