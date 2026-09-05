import { PRODUCT_USER_SUSPENDED_ERROR_CODE } from "@packscout/contracts";
import { SUSPENDED_ACCOUNT_NOTICE } from "./account-standing";
import type { PackScoutAuthStatus } from "./AuthContext.client";

export type SavedItemKind = "repack" | "collectible";

export type SavedItemMessage = Readonly<{
  copy: string;
  tone: "success" | "error";
}>;

export type SaveControlPresentation = Readonly<{
  action: "login" | "toggle" | "none";
  disabled: boolean;
  label: string;
  pressed: boolean;
  statusCopy: string;
  tone: "neutral" | "success" | "error";
}>;

const noun = (kind: SavedItemKind) =>
  kind === "repack" ? "repack" : "desired collectible";

const savedErrorCopy: Readonly<Record<string, string>> = {
  AUTH_REQUIRED: "Sign in again to update your saved items.",
  AUTH_IDENTITY_INVALID: "Your session could not be verified. Sign out and try again.",
  INVALID_PUBLIC_REPACK_ID: "This repack cannot be saved. Refresh the catalog and try again.",
  INVALID_PUBLIC_COLLECTIBLE_ID: "This collectible cannot be saved. Refresh the catalog and try again.",
  SAVED_RESOURCE_UNAVAILABLE: "This item is no longer in the catalog. You can still remove an existing save.",
  SAVED_ITEM_LIMIT_REACHED: "You have reached the limit of 250 saves for this collection. Remove an item and try again.",
  SAVED_ITEMS_STATE_CONFLICT: "Your saved items changed. Refresh the page before trying again.",
};

export function presentSavedItemMutationMessage(input: Readonly<{
  kind: SavedItemKind;
  saved: boolean;
  outcome: "success" | "error";
  prunedUnavailable?: boolean;
  /** The refusal code a rejected write carried, when it carried one. */
  errorCode?: string | null;
}>): SavedItemMessage {
  const label = input.kind === "repack" ? "Repack" : "Desired collectible";
  if (input.outcome === "error") {
    // A suspended account is a standing explanation, not a transient fault:
    // telling this person to try again would be untrue and unhelpful.
    return {
      copy: input.errorCode === PRODUCT_USER_SUSPENDED_ERROR_CODE
        ? SUSPENDED_ACCOUNT_NOTICE
        : input.errorCode && Object.hasOwn(savedErrorCopy, input.errorCode)
          ? savedErrorCopy[input.errorCode]
          : `We couldn't update this ${label.toLowerCase()}. Try again.`,
      tone: "error",
    };
  }
  const capacityCopy = input.prunedUnavailable
    ? " An older unavailable save was removed to make room."
    : "";
  return {
    copy: input.saved
      ? `${label} saved to your account.${capacityCopy}`
      : `${label} removed from your saved items.`,
    tone: "success",
  };
}

export function presentSaveControl(input: Readonly<{
  authStatus: PackScoutAuthStatus;
  kind: SavedItemKind;
  saved: boolean;
  loading: boolean;
  pending: boolean;
  pendingSaved?: boolean;
  failed?: boolean;
  message?: Readonly<{
    copy: string;
    tone: "success" | "error";
  }>;
}>): SaveControlPresentation {
  if (input.authStatus === "unavailable") {
    return {
      action: "none",
      disabled: true,
      label: "Save unavailable",
      pressed: false,
      statusCopy: "Account saving is not configured for this environment.",
      tone: "neutral",
    };
  }

  if (input.authStatus === "loading") {
    return {
      action: "none",
      disabled: true,
      label: "Checking account…",
      pressed: input.saved,
      statusCopy: "Checking your saved items.",
      tone: "neutral",
    };
  }

  if (input.authStatus === "error") {
    return {
      action: "none",
      disabled: true,
      label: "Save unavailable",
      pressed: false,
      statusCopy: "Your session could not be verified. Sign out and try again.",
      tone: "error",
    };
  }

  if (input.authStatus === "signed_out") {
    return {
      action: "login",
      disabled: false,
      label: "Sign in to save",
      pressed: false,
      statusCopy: "",
      tone: "neutral",
    };
  }

  if (input.loading) {
    return {
      action: "none",
      disabled: true,
      label: "Checking saved items…",
      pressed: false,
      statusCopy: "Checking your saved items.",
      tone: "neutral",
    };
  }

  if (input.failed) {
    return {
      action: "none",
      disabled: true,
      label: "Save unavailable",
      pressed: false,
      statusCopy: "Your saved items could not be loaded right now.",
      tone: "error",
    };
  }

  if (input.pending) {
    const saving = input.pendingSaved ?? !input.saved;
    return {
      action: "none",
      disabled: true,
      label: saving ? "Saving…" : "Removing…",
      pressed: input.saved,
      statusCopy: saving
        ? `Saving this ${noun(input.kind)}.`
        : `Removing this ${noun(input.kind)}.`,
      tone: "neutral",
    };
  }

  return {
    action: "toggle",
    disabled: false,
    label: input.saved
      ? input.kind === "repack"
        ? "Saved repack"
        : "Saved chase"
      : input.kind === "repack"
        ? "Save repack"
        : "Save chase",
    pressed: input.saved,
    statusCopy: input.message?.copy ?? "",
    tone: input.message?.tone ?? "neutral",
  };
}
