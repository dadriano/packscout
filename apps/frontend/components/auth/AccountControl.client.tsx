"use client";

import { useEffect, useRef, useState } from "react";
import { usePackScoutAuth } from "./AuthContext.client";
import { useAccountNotice } from "./SavedItemsContext.client";
import {
  browserSignOutEffects,
  presentSignOutControl,
  reduceSignOut,
  runSignOutFollowUp,
  type SignOutEvent,
  type SignOutPhase,
  signOutFollowUp,
  signOutRequestAccepted,
} from "./sign-out-handoff";
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

/**
 * The shell's account menu, which renders on every surface — product pages,
 * the landing page, and the holding surface alike — so signing in and signing
 * out stay reachable from all of them.
 *
 * Signing out here ends the session *and* leaves the product, by replacing
 * the document rather than navigating the client router. Access is decided
 * server-side per request, so a sign-out that only flipped local state left
 * this person reading a fully rendered catalog they were no longer admitted
 * to; a sign-out that only asked the router to navigate left that same
 * catalog one Back press away, restored from the router's per-document cache
 * with no request and no gate. The reasoning for the document replacement is
 * on `SignOutExit` in ./sign-out-handoff.
 *
 * The hand-off is in the handler, never in an effect watching the session
 * status: such an effect would also fire during the holding surface's
 * switch-identity flow and yank that visitor away mid-switch.
 */
export function AccountControl() {
  const auth = usePackScoutAuth();
  /**
   * An account-level notice, today only the suspended-account explanation. It
   * lives in the account menu because that is where this person looks when
   * something about their account, rather than one item, has changed. Public
   * browsing is unaffected, so nothing here interrupts the page.
   */
  const accountNotice = useAccountNotice();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const [logoutState, setLogoutState] = useState<SignOutPhase>("idle");
  const signOutControl = presentSignOutControl(logoutState);

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
    if (!signOutRequestAccepted(logoutState)) return;
    setLogoutState((phase) => reduceSignOut(phase, { type: "requested" }));
    let settled: SignOutEvent;
    try {
      // Bounded, and not by this component: the ceiling is applied around the
      // provider call inside the context's logout, because both credential
      // clears run downstream of it. A bound here would leave for the landing
      // page while a hung call still held them. See SIGN_OUT_CEILING_MS in
      // ./sign-out-handoff.
      await auth.logout();
      settled = { type: "succeeded", next: "landing" };
    } catch {
      // A sign-out whose provider call failed — or never answered — still
      // leaves. Logout clears the server-readable credential in a `finally`,
      // so this person is already signed out as far as the gate is concerned;
      // keeping them on a rendered admitted page would be the very thing this
      // hand-off exists to prevent.
      settled = { type: "failed", next: "landing" };
    }
    setLogoutState((phase) => reduceSignOut(phase, settled));
    // The awaited logout already cleared the server-readable credential, so
    // the request this exit makes is the first one the gate reads as signed
    // out and the root answers it with the public landing page. Running the
    // follow-up outside the try keeps an exit failure from being reported as
    // a failed sign-out.
    runSignOutFollowUp(signOutFollowUp(settled), browserSignOutEffects(auth.login));
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
          aria-label={
            auth.status === "error"
              ? "Session issue"
              : accountNotice
                ? "Account suspended"
                : "Account menu"
          }
          className={styles.trigger}
          ref={summaryRef}
        >
          <AccountIcon />
          <span>
            {auth.status === "error"
              ? "Session issue"
              : accountNotice
                ? "Account suspended"
                : "Account"}
          </span>
          <span aria-hidden="true" className={styles.chevron}>⌄</span>
        </summary>
        <div className={styles.panel}>
          <p className={styles.eyebrow}>
            {auth.status === "error"
              ? "Session unavailable"
              : accountNotice
                ? "Account suspended"
                : "Signed in"}
          </p>
          <p className={styles.description}>
            {auth.status === "error"
              ? "Your session could not be verified. Sign out, then try again."
              : (accountNotice ??
                "Saved repacks and chase collectibles sync to this account.")}
          </p>
          <button
            className={styles.signOut}
            disabled={signOutControl.disabled}
            onClick={() => void signOut()}
            type="button"
          >
            {signOutControl.label}
          </button>
          <p aria-live="polite" className={styles.status} role="status">
            {signOutControl.status}
          </p>
        </div>
      </details>
    </div>
  );
}
