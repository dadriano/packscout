"use client";

import {
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import {
  isSuspendedAccountRefusal,
  presentAccountStandingNotice,
  readRefusalCode,
} from "./account-standing";
import { usePackScoutAuth } from "./AuthContext.client";
import {
  SavedItemsContext,
  type SavedItemsValue,
} from "./SavedItemsContext.client";
import { useTolerantQuery } from "./tolerant-query.client";
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
  /**
   * Tolerant on purpose: while the closed beta holds this account, the
   * saved-items read is refused by the capability gate
   * (closed-beta-access/004), and a held visitor's whole session — including
   * the holding surface itself (closed-beta-access/008) — lives under this
   * provider. A refusal reads as "no saved items available", never as a
   * crash, and the live subscription starts answering by itself the moment
   * the account is admitted.
   */
  const savedItemIds = useTolerantQuery(
    api.savedItems.getSavedItemIds,
    signedIn ? {} : "skip",
  ).data;
  /**
   * The account's own standing, read once the session is established and kept
   * live afterwards. This is presentation only — the backend re-reads the
   * authoritative record on every write regardless of what is held here.
   */
  const accountStanding = useTolerantQuery(
    api.productUsers.getMyStanding,
    signedIn ? {} : "skip",
  ).data;
  /**
   * Set when a write comes back refused as suspended, which covers the moment
   * between a suspension landing and the standing read answering. A later
   * completed write clears it, and the presenter retires it outright once the
   * live standing reports the account active again, so a reinstatement is not
   * left waiting on the person to attempt another save.
   */
  const [refusedAsSuspended, setRefusedAsSuspended] = useState(false);
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
        // A completed write proves the account is not suspended right now.
        setRefusedAsSuspended(false);
        setMessages((current) => ({
          ...current,
          [key]: presentSavedItemMutationMessage({
            kind,
            saved: result.saved,
            outcome: "success",
            prunedUnavailable: result.prunedUnavailable,
          }),
        }));
      } catch (error) {
        if (isSuspendedAccountRefusal(error)) setRefusedAsSuspended(true);
        setMessages((current) => ({
          ...current,
          [key]: presentSavedItemMutationMessage({
            kind,
            saved: previous,
            outcome: "error",
            // Only the stable code crosses over; no backend text is shown.
            errorCode: readRefusalCode(error),
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

  const accountNotice = useMemo(
    () =>
      presentAccountStandingNotice({
        signedIn,
        standing: accountStanding?.standing ?? "unknown",
        refusedAsSuspended,
      }),
    [accountStanding?.standing, refusedAsSuspended, signedIn],
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
      accountNotice,
      accountSavingAvailable:
        signedIn && savedItemIds !== undefined && accountNotice === null,
    }),
    [
      accountNotice,
      isSaved,
      messages,
      pendingKeys,
      savedItemIds,
      signedIn,
      toggle,
    ],
  );

  return (
    <SavedItemsContext.Provider value={value}>
      {children}
    </SavedItemsContext.Provider>
  );
}
