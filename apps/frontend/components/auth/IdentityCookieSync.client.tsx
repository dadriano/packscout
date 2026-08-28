"use client";

import { useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";
import {
  buildIdentityCookieValue,
  clearIdentityCookieValue,
  IDENTITY_COOKIE_REFRESH_INTERVAL_MS,
  identityCookieAssignmentStores,
  identityTokenShapeValid,
  identityWriteSupersededByClear,
  readLastIdentityCookieWrite,
  recordIdentityCookieWrite,
} from "@/lib/identity-cookie";

function cookieSecurityForLocation(): boolean {
  return window.location.protocol === "https:";
}

/**
 * Clears the identity cookie in the current document. Exported so sign-out
 * can drop the server-readable credential the moment the provider session
 * ends, without waiting for the sync effect's next pass.
 */
export function clearBrowserIdentityCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = clearIdentityCookieValue(cookieSecurityForLocation());
  // Logged so an in-flight refresh cannot write the credential back, and so
  // the sign-in hand-off can tell a cleared cookie from a live one.
  recordIdentityCookieWrite({ kind: "cleared", token: null, atMs: Date.now() });
}

/**
 * Keeps the server-readable identity cookie in step with the provider
 * session (closed-beta-access/007).
 *
 * Server rendering decides admission per request, so it needs the
 * provider-issued token where server code can read it. This component owns
 * that hand-off: while a session is established it writes the current token
 * into the cookie — on session changes, on an interval well inside the token
 * lifetime, and when a backgrounded tab comes back — and when the session
 * ends it clears the cookie. The cookie is transport only; the server
 * verifies its value against the product backend on every request and trusts
 * nothing about it.
 *
 * It lives inside the initialized provider tree, so a signed-out visitor who
 * never asks for authentication never loads it and never gets a cookie —
 * the intent-based provider boot stays intact.
 */
export function IdentityAccessCookieSync() {
  const { authenticated, getAccessToken, ready, user } = usePrivy();
  const userId = user?.id;

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) {
      clearBrowserIdentityCookie();
      return;
    }

    let disposed = false;
    const sync = async () => {
      // A sign-out that lands while this fetch is outstanding must win. The
      // effect's own cleanup only closes after React commits the signed-out
      // render, so `disposed` alone would let a resolving refresh restore a
      // live credential the visitor just ended.
      const seenSeq = readLastIdentityCookieWrite()?.seq ?? 0;
      try {
        const token = await getAccessToken();
        if (disposed) return;
        if (
          identityWriteSupersededByClear({
            seenSeq,
            latest: readLastIdentityCookieWrite(),
          })
        ) {
          return;
        }
        const secure = cookieSecurityForLocation();
        const assignment = token !== null && identityTokenShapeValid(token)
          ? buildIdentityCookieValue({ token, nowMs: Date.now(), secure })
          : clearIdentityCookieValue(secure);
        document.cookie = assignment;
        // An expired or malformed token becomes a clearing write, so the log
        // records what the cookie jar actually holds rather than what was
        // offered to it.
        const stored = identityCookieAssignmentStores(assignment, secure);
        recordIdentityCookieWrite({
          kind: stored ? "written" : "cleared",
          token: stored ? token : null,
          atMs: Date.now(),
        });
      } catch {
        // Keep whatever cookie exists; the server re-verifies every request,
        // and an expired value only ever reads as signed out.
      }
    };

    void sync();
    const interval = window.setInterval(
      () => void sync(),
      IDENTITY_COOKIE_REFRESH_INTERVAL_MS,
    );
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", syncWhenVisible);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", syncWhenVisible);
    };
  }, [authenticated, getAccessToken, ready, userId]);

  return null;
}
