"use client";

import { createContext, useContext } from "react";
import type {
  SavedItemKind,
  SavedItemMessage,
} from "./saved-item-presentation";

export type SavedItemController = Readonly<{
  saved: boolean;
  loading: boolean;
  pending: boolean;
  /** True when the signed-in saved-item id read failed. */
  failed: boolean;
  message?: SavedItemMessage;
  toggle: () => Promise<void>;
}>;

export type SavedItemsValue = Readonly<{
  get: (kind: SavedItemKind, id: string) => SavedItemController;
  /**
   * A plain account-level notice, or null when there is nothing to say. It
   * carries the suspended-account explanation, which belongs here because
   * suspension is exactly a statement about what this signed-in account can
   * do; public browsing is unaffected either way.
   */
  accountNotice: string | null;
  /**
   * True only when the signed-in account can currently save. False while
   * signed out, while auth or saved-item ids are still loading, when the
   * saved-item id read failed, when saving is unavailable, and when the
   * session cannot be verified.
   */
  accountSavingAvailable: boolean;
  /**
   * True when the signed-in saved-item id read failed. Distinct from loading:
   * `undefined` data is not enough to tell those apart.
   */
  accountSavingFailed: boolean;
}>;

const unavailableController: SavedItemController = Object.freeze({
  saved: false,
  loading: false,
  pending: false,
  failed: false,
  toggle: async () => undefined,
});

export const unavailableSavedItemsValue: SavedItemsValue = Object.freeze({
  get: () => unavailableController,
  accountNotice: null,
  accountSavingAvailable: false,
  accountSavingFailed: false,
});

export const SavedItemsContext = createContext<SavedItemsValue | null>(null);

function useSavedItem(kind: SavedItemKind, id: string): SavedItemController {
  const value = useContext(SavedItemsContext);
  if (value === null) {
    throw new Error("Saved item controls require an authentication provider");
  }
  return value.get(kind, id);
}

export function useSavedRepack(publicRepackId: string): SavedItemController {
  return useSavedItem("repack", publicRepackId);
}

export function useSavedCollectible(
  publicCollectibleId: string,
): SavedItemController {
  return useSavedItem("collectible", publicCollectibleId);
}

/**
 * The account-level notice, for surfaces that report on the account rather
 * than on one saved item. Unlike the item hooks this never throws: a page
 * rendered without the provider simply has no account to report on, and
 * public browsing must never fail over an account concern.
 */
export function useAccountNotice(): string | null {
  return useContext(SavedItemsContext)?.accountNotice ?? null;
}

export function useAccountSavingAvailable(): boolean {
  return useContext(SavedItemsContext)?.accountSavingAvailable === true;
}

export function useAccountSavingFailed(): boolean {
  return useContext(SavedItemsContext)?.accountSavingFailed === true;
}
