"use client";

import {
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { usePackScoutAuth } from "./AuthContext.client";
import {
  SavedItemsContext,
  type SavedItemsValue,
} from "./SavedItemsContext.client";
import {
  presentSavedItemMutationMessage,
  type SavedItemKind,
  type SavedItemMessage,
} from "./saved-item-presentation";

function itemKey(kind: SavedItemKind, id: string): string {
  return `${kind}:${id}`;
}

export function AuthenticatedSavedItemsProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const auth = usePackScoutAuth();
  const signedIn = auth.status === "signed_in";
  const savedItemIds = useQuery(
    api.savedItems.getSavedItemIds,
    signedIn ? {} : "skip",
  );
  const setSavedRepackBase = useMutation(api.savedItems.setSavedRepack);
  const setSavedCollectibleBase = useMutation(
    api.savedItems.setSavedCollectible,
  );
  const setSavedRepack = useMemo(
    () =>
      setSavedRepackBase.withOptimisticUpdate((localStore, args) => {
        const current = localStore.getQuery(api.savedItems.getSavedItemIds, {});
        if (current === undefined) return;
        const ids = new Set(current.savedRepackIds);
        if (args.saved) ids.add(args.publicRepackId);
        else ids.delete(args.publicRepackId);
        localStore.setQuery(api.savedItems.getSavedItemIds, {}, {
          ...current,
          savedRepackIds: [...ids].sort(),
        });
      }),
    [setSavedRepackBase],
  );
  const setSavedCollectible = useMemo(
    () =>
      setSavedCollectibleBase.withOptimisticUpdate((localStore, args) => {
        const current = localStore.getQuery(api.savedItems.getSavedItemIds, {});
        if (current === undefined) return;
        const ids = new Set(current.savedCollectibleIds);
        if (args.saved) ids.add(args.publicCollectibleId);
        else ids.delete(args.publicCollectibleId);
        localStore.setQuery(api.savedItems.getSavedItemIds, {}, {
          ...current,
          savedCollectibleIds: [...ids].sort(),
        });
      }),
    [setSavedCollectibleBase],
  );
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [messages, setMessages] = useState<
    Readonly<Record<string, SavedItemMessage>>
  >({});

  const serverRepackIds = useMemo(
    () => new Set(savedItemIds?.savedRepackIds ?? []),
    [savedItemIds?.savedRepackIds],
  );
  const serverCollectibleIds = useMemo(
    () => new Set(savedItemIds?.savedCollectibleIds ?? []),
    [savedItemIds?.savedCollectibleIds],
  );

  const isSaved = useCallback(
    (kind: SavedItemKind, id: string) =>
      signedIn && (kind === "repack"
        ? serverRepackIds.has(id)
        : serverCollectibleIds.has(id)),
    [serverCollectibleIds, serverRepackIds, signedIn],
  );

  const toggle = useCallback(
    async (kind: SavedItemKind, id: string) => {
      if (!signedIn || savedItemIds === undefined) return;
      const key = itemKey(kind, id);
      if (pendingKeys.has(key)) return;
      const previous = isSaved(kind, id);
      const requested = !previous;

      setPendingKeys((current) => new Set(current).add(key));
      setMessages((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });

      try {
        const result = kind === "repack"
          ? await setSavedRepack({ publicRepackId: id, saved: requested })
          : await setSavedCollectible({
              publicCollectibleId: id,
              saved: requested,
            });
        setMessages((current) => ({
          ...current,
          [key]: presentSavedItemMutationMessage({
            kind,
            saved: result.saved,
            outcome: "success",
            prunedUnavailable: result.prunedUnavailable,
          }),
        }));
      } catch {
        setMessages((current) => ({
          ...current,
          [key]: presentSavedItemMutationMessage({
            kind,
            saved: previous,
            outcome: "error",
          }),
        }));
      } finally {
        setPendingKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }, [
      isSaved,
      pendingKeys,
      savedItemIds,
      setSavedCollectible,
      setSavedRepack,
      signedIn,
    ],
  );

  const value = useMemo<SavedItemsValue>(
    () => ({
      get(kind, id) {
        const key = itemKey(kind, id);
        return {
          saved: isSaved(kind, id),
          loading: signedIn && savedItemIds === undefined,
          pending: pendingKeys.has(key),
          message: messages[key],
          toggle: () => toggle(kind, id),
        };
      },
    }),
    [isSaved, messages, pendingKeys, savedItemIds, signedIn, toggle],
  );

  return (
    <SavedItemsContext.Provider value={value}>
      {children}
    </SavedItemsContext.Provider>
  );
}
