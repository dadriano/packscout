"use client";

import { useEffect, useRef, useState } from "react";
import { usePackScoutAuth } from "./AuthContext.client";
import styles from "./AccountControl.module.css";

function AccountIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="15" viewBox="0 0 16 16" width="15">
      <circle cx="8" cy="5.25" r="2.5" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M3.1 14c.35-2.45 2.15-3.85 4.9-3.85s4.55 1.4 4.9 3.85"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.35"
      />
    </svg>
  );
}

export function AccountControl() {
  const auth = usePackScoutAuth();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const [logoutState, setLogoutState] = useState<
    "idle" | "pending" | "failed"
  >("idle");

  useEffect(() => {
    function closeOnOutsidePress(event: PointerEvent) {
      const details = detailsRef.current;
      if (
        details?.open &&
        event.target instanceof Node &&
        !details.contains(event.target)
      ) {
        details.open = false;
      }
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, []);

  async function signOut() {
    if (logoutState === "pending") return;
    setLogoutState("pending");
    try {
      await auth.logout();
      setLogoutState("idle");
    } catch {
      setLogoutState("failed");
    }
  }

  if (auth.status === "unavailable") {
    return (
      <div className={styles.root}>
        <button
          aria-label="Sign in unavailable"
          className={styles.trigger}
          disabled
          type="button"
        >
          <AccountIcon />
          <span>Sign in unavailable</span>
        </button>
      </div>
    );
  }

  if (auth.status === "loading") {
    return (
      <div className={styles.root}>
        <button aria-label="Checking account" className={styles.trigger} disabled type="button">
          <AccountIcon />
          <span>Checking…</span>
        </button>
      </div>
    );
  }

  if (auth.status === "signed_out") {
    return (
      <div className={styles.root}>
        <button
          aria-label="Sign in"
          className={styles.trigger}
          onClick={() => auth.login()}
          type="button"
        >
          <AccountIcon />
          <span>Sign in</span>
        </button>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <details
        className={styles.details}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !detailsRef.current?.open) return;
          event.preventDefault();
          detailsRef.current.open = false;
          summaryRef.current?.focus();
        }}
        ref={detailsRef}
      >
        <summary
          aria-label={auth.status === "error" ? "Session issue" : "Account menu"}
          className={styles.trigger}
          ref={summaryRef}
        >
          <AccountIcon />
          <span>{auth.status === "error" ? "Session issue" : "Account"}</span>
          <span aria-hidden="true" className={styles.chevron}>⌄</span>
        </summary>
        <div className={styles.panel}>
          <p className={styles.eyebrow}>
            {auth.status === "error" ? "Session unavailable" : "Signed in"}
          </p>
          <p className={styles.description}>
            {auth.status === "error"
              ? "Your session could not be verified. Sign out, then try again."
              : "Saved repacks and chase collectibles sync to this account."}
          </p>
          <button
            className={styles.signOut}
            disabled={logoutState === "pending"}
            onClick={() => void signOut()}
            type="button"
          >
            {logoutState === "pending" ? "Signing out…" : "Sign out"}
          </button>
          <p aria-live="polite" className={styles.status} role="status">
            {logoutState === "failed" ? "Sign out failed. Try again." : ""}
          </p>
        </div>
      </details>
    </div>
  );
}
