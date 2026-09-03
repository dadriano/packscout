"use client";

import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { usePackScoutAuth } from "@/components/auth/AuthContext.client";
import {
  decideIdentityHandoff,
  IDENTITY_HANDOFF_MAX_ATTEMPTS,
  IDENTITY_HANDOFF_TIMEOUT_MS,
  readBrowserIdentityCookie,
  readLastIdentityCookieWrite,
  subscribeToIdentityCookieWrites,
} from "@/lib/identity-cookie";
import { presentLandingAccessAction } from "./landing-presentation";
import styles from "./Landing.module.css";

/**
 * The landing page's single access action.
 *
 * It consumes the existing authentication context and nothing else. Choosing
 * sign-in sends the same boot intent every other sign-in control sends, which
 * is what keeps the provider unloaded until this moment: the context's
 * `login` is the light boundary's intent dispatch until the provider has been
 * asked for. A signed-in visitor gets a navigation into the product instead
 * of a second sign-in, and every state renders inside the same reserved slot
 * so the provider's arrival causes no layout shift. The note is a polite live
 * region, so the state change is announced without stealing focus.
 */

/** No identity cookie has been written during a server render. */
const noIdentityCookieWrite = () => null;

export function LandingAccessCta() {
  const auth = usePackScoutAuth();
  const router = useRouter();
  const action = presentLandingAccessAction(auth.status);
  // A verified session may be handed off without a click; an unverifiable one
  // may not, because the gate refuses the same token this page was already
  // refused for.
  const automatic = action.kind === "enter" && action.automatic;
  const destination = action.kind === "enter" ? action.href : null;
  // Cookie writes are asynchronous and cause no render of their own, so the
  // hand-off subscribes to them rather than polling for a value it cannot
  // interpret anyway.
  const lastWrite = useSyncExternalStore(
    subscribeToIdentityCookieWrites,
    readLastIdentityCookieWrite,
    noIdentityCookieWrite,
  );
  const mountedAtMs = useRef(0);
  const armedAtMs = useRef(0);
  const attempted = useRef<readonly string[]>([]);
  const surrendered = useRef(false);

  // The page was server-rendered from whatever cookie the browser held before
  // this commit, so that moment is the line between "a credential the gate
  // may already have refused" and "a credential this session has since
  // written".
  useEffect(() => {
    if (mountedAtMs.current === 0) mountedAtMs.current = Date.now();
  }, []);

  // Completing sign-in should land the visitor where they belong without a
  // second click. Only the server knows where that is — the product for an
  // admitted account, the holding surface for one still in review — so this
  // navigates to the root and lets the gate decide.
  //
  // Which credential travels is the whole question. The landing page is also
  // what a visitor sees when the gate *refused* their cookie, and that
  // refused value is still in the jar; navigating on its presence resubmits
  // it and bounces straight back. decideIdentityHandoff answers on the value
  // instead, bounds the wait, and keeps the visible link as the manual
  // fallback rather than trapping anyone in a retry loop. Recording which
  // credential was used — rather than a spent boolean — is what lets a newer
  // one that arrives after a failed attempt try again.
  useEffect(() => {
    if (!automatic || destination === null || surrendered.current) return;
    if (armedAtMs.current === 0) armedAtMs.current = Date.now();
    const decision = decideIdentityHandoff({
      cookieToken: readBrowserIdentityCookie(),
      lastWrite,
      mountedAtMs: mountedAtMs.current,
      armedAtMs: armedAtMs.current,
      nowMs: Date.now(),
      timeoutMs: IDENTITY_HANDOFF_TIMEOUT_MS,
      attemptedTokens: attempted.current,
      maxAttempts: IDENTITY_HANDOFF_MAX_ATTEMPTS,
    });
    if (decision.kind === "give_up") {
      surrendered.current = true;
      return;
    }
    if (decision.kind !== "hand_off") return;
    attempted.current = [...attempted.current, decision.token];
    router.replace(destination);
  }, [automatic, destination, lastWrite, router]);

  return (
    <div className={styles.ctaSlot}>
      {action.kind === "enter" ? (
        <Link className={styles.ctaAction} href={action.href}>
          {action.label}
        </Link>
      ) : (
        <button
          className={styles.ctaAction}
          disabled={action.kind !== "sign_in"}
          onClick={action.kind === "sign_in" ? () => auth.login() : undefined}
          type="button"
        >
          {action.label}
        </button>
      )}
      <p aria-live="polite" className={styles.ctaNote}>
        {action.note ?? null}
      </p>
    </div>
  );
}
