"use client";

import Link from "next/link";
import { usePackScoutAuth } from "@/components/auth/AuthContext.client";
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
export function LandingAccessCta() {
  const auth = usePackScoutAuth();
  const action = presentLandingAccessAction(auth.status);

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
        {action.note}
      </p>
    </div>
  );
}
