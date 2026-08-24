import type {
  PackScoutAuthStatus,
} from "@/components/auth/AuthContext.client";
import type { VerifiedSignInIdentity } from "@/components/auth/verified-identity";
import {
  ACCESS_APPROVED_NOTICE,
  ACCESS_HOLDING_COPY,
  type AccessHoldingReason,
} from "@/lib/access-holding-content";

/**
 * The holding surface's decision logic (closed-beta-access/008), kept pure so
 * every state the person can reach is provable without a browser.
 *
 * Two inputs decide what the page says. The server-resolved reason is the
 * authoritative starting point — the gate (closed-beta-access/007) computed
 * it before this markup existed. The live decision is the authenticated
 * self-read streaming over the client subscription, and whenever it has
 * answered, it is newer than the markup and wins: an approval moves the
 * visitor into the product with no re-login, and a decline, suspension, or
 * newly unresolvable state swaps the notice in place. No stale rendering
 * survives a decision change.
 *
 * The session presentation solves a subtler problem: the server verified a
 * session, but the browser establishes its own view of it asynchronously, and
 * the client-side "signed out" reading is ambiguous — it is what the light
 * boundary reports before the provider boots, and also what a genuinely
 * ended session reports after it. The observation reducer separates the two,
 * so "still checking" is never presented as "you are signed out" and vice
 * versa.
 */

/** The self-read's answer, structurally (closed-beta-access/001). */
export type AccessLiveDecision = Readonly<{
  admitted: boolean;
  reason:
    | "approved"
    | "awaiting_review"
    | "declined"
    | "suspended"
    | "undetermined";
}>;

export type AccessNoticePresentation =
  | Readonly<{
      kind: "notice";
      state: AccessHoldingReason;
      documentTitle: string;
      /** Spoken when the live decision changed the notice; otherwise null. */
      announcement: string | null;
    }>
  | Readonly<{
      kind: "enter";
      destination: "/";
      documentTitle: string;
      announcement: string;
    }>;

/** The layout appends this to route titles; live updates must match it. */
const DOCUMENT_TITLE_SUFFIX = " · PackScout";

export function accessDocumentTitle(
  state: AccessHoldingReason | "approved",
): string {
  const title = state === "approved"
    ? ACCESS_APPROVED_NOTICE.title
    : ACCESS_HOLDING_COPY[state].title;
  return `${title}${DOCUMENT_TITLE_SUFFIX}`;
}

function heldReasonFromLive(
  live: AccessLiveDecision,
): AccessHoldingReason | null {
  return live.reason === "awaiting_review" ||
      live.reason === "declined" ||
      live.reason === "suspended" ||
      live.reason === "undetermined"
    ? live.reason
    : null;
}

/**
 * What the surface presents right now. The live decision wins whenever it
 * has answered — admitted means enter the product; anything else swaps the
 * notice — and the server-resolved reason carries until then. A defensively
 * impossible live shape (a non-admitted "approved") changes nothing.
 */
export function presentAccessNotice(input: Readonly<{
  serverReason: AccessHoldingReason;
  liveDecision: AccessLiveDecision | null;
}>): AccessNoticePresentation {
  const { serverReason, liveDecision } = input;
  if (liveDecision?.admitted === true) {
    return {
      kind: "enter",
      destination: "/",
      documentTitle: accessDocumentTitle("approved"),
      announcement: ACCESS_APPROVED_NOTICE.body,
    };
  }
  const liveReason = liveDecision === null
    ? null
    : heldReasonFromLive(liveDecision);
  const state = liveReason ?? serverReason;
  return {
    kind: "notice",
    state,
    documentTitle: accessDocumentTitle(state),
    announcement: state === serverReason
      ? null
      : ACCESS_HOLDING_COPY[state].heading,
  };
}

/**
 * What the surface has learned about the browser's own session so far. The
 * flags only ever turn on: once the provider has booted (any "loading") or a
 * session has stood ("signed_in", or "error" — an established session that
 * could not be verified), a later "signed out" is a settled fact rather than
 * a boot still in progress.
 */
export type AccessSessionObservation = Readonly<{
  sawProviderBoot: boolean;
  sawEstablishedSession: boolean;
}>;

export const initialAccessSessionObservation: AccessSessionObservation =
  Object.freeze({ sawProviderBoot: false, sawEstablishedSession: false });

export function observeAccessSessionStatus(
  observation: AccessSessionObservation,
  status: PackScoutAuthStatus,
): AccessSessionObservation {
  if (status === "loading" && !observation.sawProviderBoot) {
    return { ...observation, sawProviderBoot: true };
  }
  if (
    (status === "signed_in" || status === "error") &&
    !(observation.sawProviderBoot && observation.sawEstablishedSession)
  ) {
    return { sawProviderBoot: true, sawEstablishedSession: true };
  }
  return observation;
}

function signedOutIsSettled(observation: AccessSessionObservation): boolean {
  return observation.sawProviderBoot || observation.sawEstablishedSession;
}

/** What the identity block shows. */
export type AccessIdentitySlot =
  | Readonly<{
      kind: "identity";
      email: string | null;
      walletAddress: string | null;
    }>
  | Readonly<{ kind: "checking" }>
  | Readonly<{ kind: "signed_out" }>
  | Readonly<{ kind: "session_error" }>
  | Readonly<{ kind: "unavailable" }>;

/**
 * The identity block presents only what the provider verified for the
 * standing session — an established session shows its attributes (or says
 * plainly that none were exposed), a booting one says it is checking, and a
 * settled sign-out says so instead of pretending to check forever.
 */
export function presentAccessIdentity(input: Readonly<{
  status: PackScoutAuthStatus;
  identity: VerifiedSignInIdentity | null;
  observation: AccessSessionObservation;
}>): AccessIdentitySlot {
  switch (input.status) {
    case "unavailable":
      return { kind: "unavailable" };
    case "error":
      return { kind: "session_error" };
    case "signed_in":
      return {
        kind: "identity",
        email: input.identity?.email ?? null,
        walletAddress: input.identity?.walletAddress ?? null,
      };
    case "loading":
      // A session refreshing its backend verification still has its verified
      // attributes; keep showing them instead of flickering back to a check.
      return input.identity === null
        ? { kind: "checking" }
        : {
            kind: "identity",
            email: input.identity.email,
            walletAddress: input.identity.walletAddress,
          };
    case "signed_out":
      return signedOutIsSettled(input.observation)
        ? { kind: "signed_out" }
        : { kind: "checking" };
  }
}

/** Which session controls the surface offers, and whether they are live. */
export type AccessSessionControls =
  | Readonly<{
      kind: "session";
      signOutEnabled: boolean;
      switchEnabled: boolean;
    }>
  | Readonly<{ kind: "sign_in" }>;

/**
 * Sign-out and switch-identity are the surface's controls while a session
 * stands; a settled sign-out replaces them with one sign-in action, which is
 * how switching identities completes. No held state ever offers sign-in
 * while its session stands — a declined visitor is never handed a sign-in
 * that would loop them straight back here.
 */
export function presentAccessControls(input: Readonly<{
  status: PackScoutAuthStatus;
  observation: AccessSessionObservation;
}>): AccessSessionControls {
  if (input.status === "signed_out" && signedOutIsSettled(input.observation)) {
    return { kind: "sign_in" };
  }
  return {
    kind: "session",
    signOutEnabled: input.status === "signed_in" || input.status === "error",
    switchEnabled: input.status === "signed_in",
  };
}
