"use client";

import { type ReactNode, useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useConvex, useMutation } from "convex/react";
import { savedCatalogItemIdsSchema } from "@packscout/contracts";
import { api } from "../../../../convex/_generated/api";
import { presentAccountStandingNotice } from "./account-standing";
import { usePackScoutAuth } from "./AuthContext.client";
import { SavedItemsContext, type SavedItemsValue } from "./SavedItemsContext.client";
import { useTolerantQuery } from "./tolerant-query.client";
import type { SavedItemKind } from "./saved-item-presentation";
import { createSavedItemMutations, savedItemKey } from "./saved-item-mutations.client";

export function AuthenticatedSavedItemsProvider({ children }: Readonly<{ children: ReactNode }>) {
  const auth = usePackScoutAuth();
  const signedIn = auth.status === "signed_in";
  const convex = useConvex();
  // Capability refusals are ordinary session state, including on the beta holding surface.
  const savedItemIdsQuery = useTolerantQuery(
    api.savedItems.getSavedItemIds,
    signedIn ? {} : "skip",
  );
  const rawIds = savedItemIdsQuery.data;
  const savedItemIds = useMemo(() => {
    const parsed = savedCatalogItemIdsSchema.safeParse(rawIds);
    return parsed.success ? parsed.data : undefined;
  }, [rawIds]);
  const savedItemIdsFailed = savedItemIdsQuery.error !== undefined || (rawIds !== undefined && savedItemIds === undefined);
  const accountStanding = useTolerantQuery(
    api.productUsers.getMyStanding,
    signedIn ? {} : "skip",
  ).data;
  const setSavedRepack = useMutation(api.savedItems.setSavedRepack);
  const setSavedCollectible = useMutation(api.savedItems.setSavedCollectible);
  const mutations = useMemo(() => createSavedItemMutations({
    setSavedRepack,
    setSavedCollectible,
    getSavedItemIds: () => convex.query(api.savedItems.getSavedItemIds, {}),
  }), [convex, setSavedCollectible, setSavedRepack]);
  const mutationState = useSyncExternalStore(mutations.subscribe, mutations.getSnapshot, mutations.getServerSnapshot);

  // Cached IDs can enable controls on the first commit, before passive effects.
  useLayoutEffect(() => {
    if (signedIn) mutations.activate();
    return () => mutations.dispose();
  }, [mutations, signedIn]);

  const serverRepackIds = useMemo(() => new Set(savedItemIds?.savedRepackIds ?? []), [savedItemIds?.savedRepackIds]);
  const serverCollectibleIds = useMemo(() => new Set(savedItemIds?.savedCollectibleIds ?? []), [savedItemIds?.savedCollectibleIds]);
  const isSaved = useCallback((kind: SavedItemKind, id: string) => signedIn && (kind === "repack" ? serverRepackIds : serverCollectibleIds).has(id), [serverCollectibleIds, serverRepackIds, signedIn]);
  const accountNotice = presentAccountStandingNotice({
    signedIn,
    standing: accountStanding?.standing ?? "unknown",
    refusedAsSuspended: mutationState.refusedAsSuspended,
  });

  const value = useMemo<SavedItemsValue>(() => ({
    get(kind, id) {
      const key = savedItemKey(kind, id);
      return {
        saved: isSaved(kind, id),
        loading: signedIn && savedItemIds === undefined && !savedItemIdsFailed,
        pending: signedIn && Object.hasOwn(mutationState.pending, key),
        pendingSaved: signedIn ? mutationState.pending[key] : undefined,
        failed: signedIn && savedItemIdsFailed,
        message: signedIn ? mutationState.messages[key] : undefined,
        toggle: async () => {
          if (signedIn && savedItemIds !== undefined) {
            await mutations.run(kind, id, !isSaved(kind, id));
          }
        },
      };
    },
    accountNotice,
    accountSavingAvailable: signedIn && savedItemIds !== undefined && accountNotice === null,
    accountSavingFailed: signedIn && savedItemIdsFailed,
  }), [accountNotice, isSaved, mutationState, mutations, savedItemIds, savedItemIdsFailed, signedIn]);

  return <SavedItemsContext.Provider value={value}>{children}</SavedItemsContext.Provider>;
}
