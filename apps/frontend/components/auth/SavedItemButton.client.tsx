"use client";

import { useId } from "react";
import { usePackScoutAuth } from "./AuthContext.client";
import {
  type SavedItemController,
  useSavedCollectible,
  useSavedRepack,
} from "./SavedItemsContext.client";
import {
  presentSaveControl,
  type SavedItemKind,
} from "./saved-item-presentation";
import styles from "./SavedItemButton.module.css";

function BookmarkIcon({ filled }: Readonly<{ filled: boolean }>) {
  return (
    <svg
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      height="14"
      viewBox="0 0 16 18"
      width="13"
    >
      <path
        d="M2.25 2.6c0-.75.6-1.35 1.35-1.35h8.8c.75 0 1.35.6 1.35 1.35v13.75L8 12.55l-5.75 3.8V2.6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function SavedItemButton({
  controller,
  kind,
}: Readonly<{
  controller: SavedItemController;
  kind: SavedItemKind;
}>) {
  const auth = usePackScoutAuth();
  const statusId = useId();
  const presentation = presentSaveControl({
    authStatus: auth.status,
    kind,
    saved: controller.saved,
    loading: controller.loading,
    pending: controller.pending,
    failed: controller.failed,
    message: controller.message,
  });

  function activate() {
    if (presentation.action === "login") {
      auth.login();
    } else if (presentation.action === "toggle") {
      void controller.toggle();
    }
  }

  return (
    <div className={styles.root} data-kind={kind}>
      <button
        aria-describedby={presentation.statusCopy ? statusId : undefined}
        aria-pressed={presentation.pressed}
        className={styles.button}
        disabled={presentation.disabled}
        onClick={activate}
        type="button"
      >
        <BookmarkIcon filled={presentation.pressed} />
        <span>{presentation.label}</span>
      </button>
      <p
        aria-live="polite"
        className={presentation.statusCopy ? styles.status : "sr-only"}
        data-tone={presentation.tone}
        id={statusId}
        role="status"
      >
        {presentation.statusCopy}
      </p>
    </div>
  );
}

export function SavedRepackButton({
  publicRepackId,
}: Readonly<{ publicRepackId: string }>) {
  const controller = useSavedRepack(publicRepackId);
  return <SavedItemButton controller={controller} kind="repack" />;
}

export function SavedCollectibleButton({
  publicCollectibleId,
}: Readonly<{ publicCollectibleId: string }>) {
  const controller = useSavedCollectible(publicCollectibleId);
  return <SavedItemButton controller={controller} kind="collectible" />;
}
