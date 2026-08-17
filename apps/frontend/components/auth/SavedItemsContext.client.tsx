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
  message?: SavedItemMessage;
  toggle: () => Promise<void>;
}>;

export type SavedItemsValue = Readonly<{
  get: (kind: SavedItemKind, id: string) => SavedItemController;
}>;

const unavailableController: SavedItemController = Object.freeze({
  saved: false,
  loading: false,
  pending: false,
  toggle: async () => undefined,
});

export const unavailableSavedItemsValue: SavedItemsValue = Object.freeze({
  get: () => unavailableController,
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
