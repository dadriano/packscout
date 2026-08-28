/**
 * What signing out does, and what happens after it.
 *
 * Two surfaces end a session: the account menu in the shell header, which is
 * reachable from every product page, and the holding surface, which also
 * offers switching to a different address. Both ran their own copy of the
 * same three-state machine, and only one of them navigated — so signing out
 * of the product left the visitor looking at a fully rendered catalog they
 * were, server-side, no longer admitted to. The decisions live here instead,
 * as plain functions, so both call sites share one tested answer.
 *
 * The rules the surfaces cannot get wrong:
 *
 * - Leaving happens only after the sign-out settles. The context's logout
 *   clears the server-readable identity cookie as part of that call, so the
 *   request the exit makes is the first one the gate reads as signed out.
 *   Leaving first would race the credential it depends on.
 * - The sign-out settles within a bounded wait. See {@link SIGN_OUT_CEILING_MS}
 *   for why an unbounded await is a dead control, and for where the bound has
 *   to sit for the credential to be gone before the exit runs.
 * - Leaving replaces the document; it is never a client-router navigation.
 *   See {@link SignOutExit} for why that distinction is the whole fix.
 * - A sign-out bound for the landing page leaves whether the provider call
 *   succeeded, failed, or never answered. See {@link signOutFollowUp}.
 * - Switching identity never leaves. It signs out and asks for a fresh
 *   sign-in from the same page; sending that visitor to the landing root
 *   would discard the surface and the sign-in dialog mid-switch.
 * - A sign-out that is leaving keeps the control busy. The session is already
 *   gone while the exit is in flight, so re-offering "Sign out" would be a
 *   lie and a second press would do nothing.
 */

export type SignOutPhase = "idle" | "pending" | "leaving" | "failed";

/** Where a settled sign-out goes next. */
export type SignOutDestination = "landing" | "sign_in";

export type SignOutEvent =
  | Readonly<{ type: "requested" }>
  | Readonly<{ type: "succeeded"; next: SignOutDestination }>
  | Readonly<{ type: "failed"; next: SignOutDestination }>;

/**
 * The labels both surfaces show. The holding surface keeps its own copy
 * constant for its wider set of controls; a test pins the two together so
 * the shared sentences cannot drift apart.
 */
export const SIGN_OUT_COPY = Object.freeze({
  signOut: "Sign out",
  signOutBusy: "Signing out…",
  signOutFailed: "Sign out failed. Try again.",
});

/** Whether a press should start a sign-out, or be ignored as a repeat. */
export function signOutRequestAccepted(phase: SignOutPhase): boolean {
  return phase !== "pending" && phase !== "leaving";
}

export function reduceSignOut(
  phase: SignOutPhase,
  event: SignOutEvent,
): SignOutPhase {
  switch (event.type) {
    case "requested":
      return signOutRequestAccepted(phase) ? "pending" : phase;
    case "succeeded":
      return event.next === "landing" ? "leaving" : "idle";
    case "failed":
      // A sign-out bound for the landing page leaves either way — the
      // credential is already gone — so the control stays busy rather than
      // offering a retry for something that is about to unload.
      return event.next === "landing" ? "leaving" : "failed";
  }
}

export type SignOutControl = Readonly<{
  label: string;
  disabled: boolean;
  /** The live-region line, empty while there is nothing to announce. */
  status: string;
}>;

export function presentSignOutControl(phase: SignOutPhase): SignOutControl {
  const busy = phase === "pending" || phase === "leaving";
  return Object.freeze({
    label: busy ? SIGN_OUT_COPY.signOutBusy : SIGN_OUT_COPY.signOut,
    disabled: busy,
    status: phase === "failed" ? SIGN_OUT_COPY.signOutFailed : "",
  });
}

/**
 * How a sign-out leaves: by replacing the document, never by asking the
 * client router to navigate.
 *
 * The distinction is the whole point. A router navigation keeps the document,
 * and with it Next's per-document client cache of every segment this tab has
 * already rendered. That cache is explicitly consulted with staleness checks
 * bypassed on a back/forward traversal, so one Back press after a soft
 * sign-out restores the admitted catalog this session rendered — same markup,
 * same product chrome, no request, and no gate. The only client API that
 * clears it is `router.refresh()`, whose cache-purging side effect is an
 * internal coupling rather than a documented contract; pairing it with the
 * navigation would leave the fix depending on a Next implementation detail
 * that can change without a signal here.
 *
 * Replacing the document closes the hole from the other end and closes more
 * than the hole: the client router, every cached RSC payload, the in-memory
 * saved-item and session state, the identity-cookie refresh timer, and the
 * reactive backend socket all die with the document, and the fresh request
 * re-resolves access server-side for both the page and the shell chrome. Its
 * cost is a full page load. Sign-out is a rare, terminal, security-shaped
 * transition — frequently on a shared or borrowed device, which is the whole
 * reason the control exists — where "nothing from that session survives in
 * this tab" is the actual requirement and a preserved SPA transition buys
 * nothing. `replace`, not `assign`, so the pre-sign-out page is not left as a
 * forward entry.
 */
export type SignOutExit = Readonly<{
  href: "/";
  /** Always true: this exit is a document replacement, not a route change. */
  discardsDocument: true;
}>;

export type SignOutFollowUp = Readonly<{
  /** How to leave, or null when this sign-out stays on the page. */
  exit: SignOutExit | null;
  /** Whether to ask for a fresh sign-in without leaving the page. */
  login: boolean;
}>;

const LANDING_EXIT: SignOutExit = Object.freeze({
  href: "/",
  discardsDocument: true,
});

const STAY_PUT: SignOutFollowUp = Object.freeze({
  exit: null,
  login: false,
});
const LEAVE_FOR_LANDING: SignOutFollowUp = Object.freeze({
  exit: LANDING_EXIT,
  login: false,
});
const ASK_FOR_A_FRESH_SIGN_IN: SignOutFollowUp = Object.freeze({
  exit: null,
  login: true,
});

/**
 * What to do once the sign-out has settled.
 *
 * A sign-out bound for the landing page leaves, and the provider call's
 * outcome does not enter into it. That resolves a contradiction the surfaces
 * used to live with. Sign-out clears the server-readable identity cookie and
 * the returning-session hint in `finally` blocks, and the wait for the
 * provider is bounded (see {@link SIGN_OUT_CEILING_MS}), so by the time this
 * runs the person is signed out as far as the gate is concerned no matter
 * what the provider did. Staying put left a server-side-signed-out person
 * reading a fully rendered admitted page, which is the same harm a soft exit
 * leaves one Back press away. Not clearing the credential on failure would
 * make a retry message honest but would re-admit someone who asked to leave,
 * so the direction to fix in is the navigation, not the credential.
 *
 * A failed *identity switch* is the one case that stays put: its whole
 * contract is not to leave, the visitor is on the holding surface rather than
 * inside the product, and that surface renders no admitted data — so the
 * failure is reported exactly where it is actionable, next to a control the
 * person can press again.
 */
export function signOutFollowUp(event: SignOutEvent): SignOutFollowUp {
  if (event.type === "requested") return STAY_PUT;
  if (event.next === "landing") return LEAVE_FOR_LANDING;
  return event.type === "succeeded" ? ASK_FOR_A_FRESH_SIGN_IN : STAY_PUT;
}

/** The one place the document replacement is spelled. */
export function replaceDocumentWith(href: string): void {
  window.location.replace(href);
}

export type SignOutEffects = Readonly<{
  replaceDocument: (href: string) => void;
  login: () => void;
}>;

export function browserSignOutEffects(login: () => void): SignOutEffects {
  return {
    replaceDocument: replaceDocumentWith,
    login,
  };
}

/**
 * Performs a settled sign-out's follow-up. Both surfaces call this instead of
 * reaching for a router, so there is exactly one implementation of how a
 * sign-out leaves and neither can quietly reintroduce a soft navigation.
 */
export function runSignOutFollowUp(
  followUp: SignOutFollowUp,
  effects: SignOutEffects,
): void {
  if (followUp.exit !== null) {
    effects.replaceDocument(followUp.exit.href);
    return;
  }
  if (followUp.login) effects.login();
}

/**
 * How long a sign-out waits for the session provider before giving up on it.
 *
 * The provider's sign-out is a single request to its session endpoint, and it
 * is not written to give up on its own. A promise that never settles pins the
 * control at "Signing out…", disabled, for the life of the document: no exit,
 * no announcement, no retry, and no second press accepted. That is a dead
 * control, and on a shared device it is a dead control on a page the person
 * has already decided to leave.
 *
 * Eight seconds is comfortably past a slow-network round trip, so a sign-out
 * that is merely slow is never cut short and mislabelled — which matters for
 * the identity switch, the one destination that reports failure to the
 * person. Past that, waiting buys nothing: the credential clears are already
 * queued behind this bound and the landing exit is the same either way.
 *
 * *Where* the bound sits is load-bearing. The identity cookie and the
 * returning-session hint are cleared in `finally` blocks downstream of the
 * provider call, so a bound placed at the surface — around `auth.logout()` —
 * would leave for the landing page while the hung call still held both
 * credentials, and the gate would hand the product straight back. The bound
 * is therefore applied around the provider call itself, in
 * `logoutAndClearReturningSessionHint`, where reaching the ceiling settles
 * that call and both `finally` blocks run before the surface is told anything.
 */
export const SIGN_OUT_CEILING_MS = 8_000;

/** What a sign-out that ran out its ceiling rejects with. */
export const SIGN_OUT_NOT_CONFIRMED_MESSAGE =
  "The sign-out did not settle within its ceiling.";

/**
 * A delay, taken as a parameter so the ceiling is testable without real time.
 * Returns the cancel, because a sign-out that settles first must leave no
 * timer and no pending rejection behind it.
 */
export type SignOutCeilingTimer = (
  onDue: () => void,
  ms: number,
) => () => void;

export const realSignOutCeilingTimer: SignOutCeilingTimer = (onDue, ms) => {
  const handle = setTimeout(onDue, ms);
  return () => clearTimeout(handle);
};

/**
 * Runs a sign-out and refuses to wait for it forever.
 *
 * Resolves when the work resolves, rejects with the work's own reason when it
 * rejects, and rejects with {@link SIGN_OUT_NOT_CONFIRMED_MESSAGE} once the
 * ceiling passes. Either rejection reaches the surface as the same thing — a
 * sign-out that could not be confirmed — which is honest: an unanswered call
 * and a refused one are equally unknown from here.
 *
 * The abandoned work is left running rather than cancelled, because there is
 * nothing to cancel: the provider owns that request. Nothing downstream waits
 * on it, and the exit discards the document it would resolve into.
 */
export async function settleWithinSignOutCeiling(
  work: () => Promise<void>,
  ceilingMs: number,
  schedule: SignOutCeilingTimer,
): Promise<void> {
  let cancel: () => void = () => undefined;
  const ceiling = new Promise<never>((_resolve, reject) => {
    cancel = schedule(
      () => reject(new Error(SIGN_OUT_NOT_CONFIRMED_MESSAGE)),
      ceilingMs,
    );
  });
  try {
    await Promise.race([work(), ceiling]);
  } finally {
    // Cancelling matters as much as scheduling: an uncancelled ceiling would
    // reject after the race had already settled, with nobody left to catch it.
    cancel();
  }
}
