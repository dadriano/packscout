"use client";

import type { ReactNode } from "react";
import { SessionTableColumnLayoutProvider } from "@/components/table-layout/TableColumnLayoutContext.client";
import {
  PackScoutAuthContext,
  unavailableAuthValue,
} from "./AuthContext.client";
import {
  SavedItemsContext,
  unavailableSavedItemsValue,
} from "./SavedItemsContext.client";

export function UnavailablePackScoutAuthProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <PackScoutAuthContext.Provider value={unavailableAuthValue}>
      <SavedItemsContext.Provider value={unavailableSavedItemsValue}>
        <SessionTableColumnLayoutProvider>
          {children}
        </SessionTableColumnLayoutProvider>
      </SavedItemsContext.Provider>
    </PackScoutAuthContext.Provider>
  );
}
