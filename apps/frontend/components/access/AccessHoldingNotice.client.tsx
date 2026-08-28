"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../../../../convex/_generated/api";
import { usePackScoutAuth } from "@/components/auth/AuthContext.client";
import {
  browserSignOutEffects,
  presentSignOutControl,
  reduceSignOut,
  runSignOutFollowUp,
  type SignOutDestination,
  type SignOutEvent,
  type SignOutPhase,
  signOutFollowUp,
  signOutRequestAccepted,
} from "@/components/auth/sign-out-handoff";
import { useTolerantQuery } from "@/components/auth/tolerant-query.client";
import {
  ACCESS_APPROVED_NOTICE,
  ACCESS_CONTROL_COPY,
  ACCESS_HOLDING_COPY,
  ACCESS_IDENTITY_COPY,
  ACCESS_WRONG_STATE_GUIDANCE,
  type AccessHoldingReason,
} from "@/lib/access-holding-content";
import {
  type AccessIdentitySlot,
  type AccessLiveDecision,
  initialAccessSessionObservation,
  observeAccessSessionStatus,
  presentAccessControls,
  presentAccessIdentity,
  presentAccessNotice,
} from "./access-holding-presentation";
import styles from "./AccessHolding.module.css";

/**
 * The holding surface (closed-beta-access/008): the one page a signed-in but
 * unadmitted visitor gets, rendered from the reason the server-side gate
 * resolved (closed-beta-access/007) and kept current by the authenticated
 * self-read streaming over the client subscription — the surface's only
 * authenticated call. An operator approving this visitor while the page is
 * open moves them into the product with no re-login; a decline, suspension,
 * or newly unresolvable state swaps the notice in place, document title
 * included. No catalog read happens here and no capability is granted; the
 * page renders whole while the catalog read model is closed.
 *
 * The surface also shows which verified identity the decision is about and
 * carries the two session controls: sign out (back to the landing page) and
 * switch identity (sign out, then sign in as someone else, without leaving
 * the page). On mount it asks the authentication boundary to establish the
 * session the server already verified — a boot request, never a login
 * prompt — so the live reaction works even when the browser lost its
 * returning-session hint.
 */
export function AccessHoldingNotice({
  reason,
}: Readonly<{ reason: AccessHoldingReason }>) {
  const auth = usePackScoutAuth();
  const router = useRouter();
  const [observation, setObservation] = useState(
    initialAccessSessionObservation,
  );
  const [liveDecision, setLiveDecision] = useState<AccessLiveDecision | null>(
    null,
  );
  const [logoutState, setLogoutState] = useState<SignOutPhase>("idle");

  // The server rendered this page only after verifying a session, so ask the
  // boundary to establish it client-side. No login intent: an existing
  // session comes up silently, a missing one opens nothing.
  const requestSessionBoot = auth.requestSessionBoot;
  useEffect(() => {
    requestSessionBoot();
  }, [requestSessionBoot]);

  // Status changes advance the session observation during render (the
  // documented adjust-state-on-change pattern), so what this render presents
  // is already consistent with the status it presents it for.
  const status = auth.status;
  const [observedStatus, setObservedStatus] = useState<
    typeof auth.status | null
  >(null);
  if (observedStatus !== status) {
    setObservedStatus(status);
    setObservation(observeAccessSessionStatus(observation, status));
    // A live answer belongs to the session that produced it. Sign-out and
    // identity switches pass through a non-signed-in status, which drops it
    // before the next session could inherit a stale decision.
    if (status !== "signed_in") setLiveDecision(null);
  }

  const notice = presentAccessNotice({ serverReason: reason, liveDecision });
  const identitySlot = presentAccessIdentity({
    status,
    identity: auth.identity,
    observation,
  });
  const controls = presentAccessControls({ status, observation });

  // Decision changes re-title the document exactly as a fresh server render
  // would (per-state titles live in generateMetadata for the first paint).
  useEffect(() => {
    document.title = notice.documentTitle;
  }, [notice.documentTitle]);

  // Approval while the page is open: into the product, once, no re-login.
  // The root re-resolves access server-side and renders the product.
  const entered = useRef(false);
  useEffect(() => {
    if (notice.kind !== "enter" || entered.current) return;
    entered.current = true;
    router.replace(notice.destination);
  }, [notice, router]);

  async function signOutThen(next: SignOutDestination) {
    if (!signOutRequestAccepted(logoutState)) return;
    setLogoutState((phase) => reduceSignOut(phase, { type: "requested" }));
    let settled: SignOutEvent;
    try {
      // Bounded, and not by this component: the ceiling is applied around the
      // provider call inside the context's logout, because both credential
      // clears run downstream of it. See SIGN_OUT_CEILING_MS in
      // components/auth/sign-out-handoff.
      await auth.logout();
      settled = { type: "succeeded", next };
    } catch {
      // Leaving still leaves: the credential is cleared whether the provider
      // succeeded, failed, or never answered, so a failed sign-out that
      // stayed here would strand a server-side signed-out person on a page
      // rendered for a session that is gone. A failed identity *switch* is
      // the case that stays, because staying is its whole contract and this
      // surface renders no admitted data — signOutFollowUp draws that line.
      settled = { type: "failed", next };
    }
    setLogoutState((phase) => reduceSignOut(phase, settled));
    // The follow-up runs outside the try, so an exit or dialog failure is
    // never reported as a sign-out that did not happen. Leaving replaces the
    // document rather than navigating the client router — the router keeps a
    // per-document cache of every segment this tab rendered and serves it
    // back on a Back press without re-running the gate. See `SignOutExit` in
    // components/auth/sign-out-handoff.
    runSignOutFollowUp(signOutFollowUp(settled), browserSignOutEffects(auth.login));
  }

  if (notice.kind === "enter") {
    return (
      <section aria-labelledby="access-holding-heading" className={styles.surface}>
        <div className={styles.inner}>
          <p className={styles.kicker}>{ACCESS_APPROVED_NOTICE.kicker}</p>
          <h1
            className={styles.heading}
            data-route-heading
            id="access-holding-heading"
            tabIndex={-1}
          >
            {ACCESS_APPROVED_NOTICE.heading}
          </h1>
          <p className={styles.body}>{ACCESS_APPROVED_NOTICE.body}</p>
          <p aria-live="polite" className="sr-only" role="status">
            {notice.announcement}
          </p>
        </div>
      </section>
    );
  }

  const copy = ACCESS_HOLDING_COPY[notice.state];
  // "Signing out…" and the disabled state hold across the hand-off too: the
  // session is already gone while the navigation is in flight.
  const busy = presentSignOutControl(logoutState).disabled;

  return (
    <section aria-labelledby="access-holding-heading" className={styles.surface}>
      <div className={styles.inner}>
        {status === "signed_in" ? (
          <AccessDecisionSubscription onDecision={setLiveDecision} />
        ) : null}
        <p className={styles.kicker}>{copy.kicker}</p>
        <h1
          className={styles.heading}
          data-route-heading
          id="access-holding-heading"
          tabIndex={-1}
        >
          {copy.heading}
        </h1>
        <p className={styles.body}>{copy.body}</p>
        <p className={styles.body}>{copy.detail}</p>
        {copy.retry ? (
          <a className="route-action" href={copy.retry.href}>
            {copy.retry.label}
          </a>
        ) : null}
        <div className={styles.identity}>
          <p className={styles.identityLegend}>{ACCESS_IDENTITY_COPY.legend}</p>
          <AccessIdentityDisplay slot={identitySlot} />
        </div>
        <div className={styles.actions}>
          {controls.kind === "sign_in" ? (
            <button
              className={styles.action}
              onClick={() => auth.login()}
              type="button"
            >
              {ACCESS_CONTROL_COPY.signIn}
            </button>
          ) : (
            <>
              <button
                className={styles.action}
                disabled={!controls.signOutEnabled || busy}
                onClick={() => void signOutThen("landing")}
                type="button"
              >
                {busy
                  ? ACCESS_CONTROL_COPY.signOutBusy
                  : ACCESS_CONTROL_COPY.signOut}
              </button>
              <button
                className={styles.action}
                disabled={!controls.switchEnabled || busy}
                onClick={() => void signOutThen("sign_in")}
                type="button"
              >
                {ACCESS_CONTROL_COPY.switchIdentity}
              </button>
            </>
          )}
        </div>
        <p aria-live="polite" className={styles.actionStatus} role="status">
          {logoutState === "failed" ? ACCESS_CONTROL_COPY.signOutFailed : ""}
        </p>
        <p className={styles.guidance}>{ACCESS_WRONG_STATE_GUIDANCE}</p>
        <p aria-live="polite" className="sr-only" role="status">
          {notice.announcement ?? ""}
        </p>
      </div>
    </section>
  );
}

function AccessIdentityDisplay({
  slot,
}: Readonly<{ slot: AccessIdentitySlot }>) {
  if (slot.kind !== "identity") {
    const line = slot.kind === "checking"
      ? ACCESS_IDENTITY_COPY.checking
      : slot.kind === "signed_out"
        ? ACCESS_IDENTITY_COPY.signedOut
        : slot.kind === "session_error"
          ? ACCESS_IDENTITY_COPY.sessionError
          : ACCESS_IDENTITY_COPY.unavailable;
    return <p className={styles.identityNote}>{line}</p>;
  }
  if (slot.email === null && slot.walletAddress === null) {
    return (
      <p className={styles.identityNote}>{ACCESS_IDENTITY_COPY.noneExposed}</p>
    );
  }
  return (
    <dl className={styles.identityRows}>
      {slot.email !== null ? (
        <div className={styles.identityRow}>
          <dt className={styles.identityTerm}>
            {ACCESS_IDENTITY_COPY.emailLabel}
          </dt>
          <dd className={styles.identityValue}>{slot.email}</dd>
        </div>
      ) : null}
      {slot.walletAddress !== null ? (
        <div className={styles.identityRow}>
          <dt className={styles.identityTerm}>
            {ACCESS_IDENTITY_COPY.walletLabel}
          </dt>
          <dd className={styles.identityValue}>{slot.walletAddress}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * The surface's one authenticated call: the visitor's own effective access
 * (closed-beta-access/001), subscribed reactively so a decision change
 * arrives without any polling or reload. Mounted only while the session is
 * established — the tree outside the initialized provider has no reactive
 * client — and tolerant of failure: an unanswered or refused read simply
 * leaves the server-resolved notice standing.
 */
function AccessDecisionSubscription({
  onDecision,
}: Readonly<{ onDecision: (decision: AccessLiveDecision) => void }>) {
  const live = useTolerantQuery(api.productUserAccess.getMyAccess, {}).data;
  useEffect(() => {
    if (live !== undefined) onDecision(live);
  }, [live, onDecision]);
  return null;
}
