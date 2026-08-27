"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { usePackScoutAuth } from "@/components/auth/AuthContext.client";
import { browserHasIdentityCookie } from "@/lib/identity-cookie";
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
/** How long to wait for the identity cookie before falling back to the link. */
const IDENTITY_HANDOFF_TIMEOUT_MS = 6_000;
const IDENTITY_HANDOFF_POLL_MS = 120;

export function LandingAccessCta() {
  const auth = usePackScoutAuth();
  const router = useRouter();
  const action = presentLandingAccessAction(auth.status);
  const entered = useRef(false);

  // Completing sign-in should land the visitor where they belong without a
  // second click. Only the server knows where that is — the product for an
  // admitted account, the holding surface for one still in review — so this
  // navigates to the root and lets the gate decide.
  //
  // It waits for the identity cookie first. The provider establishes the
  // session in the browser before that cookie exists, and navigating in the
  // gap renders as a signed-out visitor: the landing page again. If the
  // cookie never arrives, the effect gives up and leaves the visible link as
  // a working manual fallback rather than trapping anyone in a retry loop.
  useEffect(() => {
    if (action.kind !== "enter" || entered.current) return;
    let timer = 0;
    let waited = 0;
    const attempt = () => {
      if (entered.current) return;
      if (browserHasIdentityCookie()) {
        entered.current = true;
        router.replace(action.href);
        return;
      }
      waited += IDENTITY_HANDOFF_POLL_MS;
      if (waited >= IDENTITY_HANDOFF_TIMEOUT_MS) return;
      timer = window.setTimeout(attempt, IDENTITY_HANDOFF_POLL_MS);
    };
    attempt();
    return () => window.clearTimeout(timer);
  }, [action, router]);

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
