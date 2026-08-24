/**
 * Every word the holding surface says (closed-beta-access/008), keyed by the
 * reason the server-side gate resolved (closed-beta-access/007).
 *
 * The four reasons are four different situations, and conflating them
 * produces wrong and sometimes insulting messages — so each gets its own
 * plain-language words: waiting is a normal, expected state with no invented
 * delivery promises; declined is brief and respectful, exposes no reasoning,
 * and never dangles a sign-in that would loop back here; suspended is its own
 * notice, never presented as review; and a backend that could not answer is a
 * temporary problem clearly separated from any decision about the person. The
 * approved notice exists for one moment only: the live decision flipping to
 * admitted while the page is open, just before the surface moves the visitor
 * into the product.
 *
 * No status codes, reason identifiers, or backend vocabulary reach the
 * visitor. Nothing here reads catalog data or authentication state; the
 * copy renders from the reason alone, and the identity and control strings
 * render from the client session the surface already holds.
 */

export type AccessHoldingReason =
  | "awaiting_review"
  | "declined"
  | "suspended"
  | "undetermined";

export type AccessHoldingCopy = Readonly<{
  /** The document title for this state. */
  title: string;
  /** The kicker line above the heading. */
  kicker: string;
  /** The page's one heading. */
  heading: string;
  /** What is going on, in the visitor's terms. */
  body: string;
  /** What happens next, or what this state means for them — never a promise. */
  detail: string;
  /** A retry action, only for the temporary-problem state. */
  retry: Readonly<{ href: "/"; label: string }> | null;
}>;

export const ACCESS_HOLDING_COPY: Readonly<
  Record<AccessHoldingReason, AccessHoldingCopy>
> = Object.freeze({
  awaiting_review: Object.freeze({
    title: "Access request in review",
    kicker: "Closed beta",
    heading: "Your access request is in review",
    body:
      "You are signed in, and your request to join the PackScout beta is " +
      "with the team. There is nothing more you need to do.",
    detail:
      "The moment your request is approved, this page brings you straight " +
      "in. You can keep it open, or come back later and sign in with the " +
      "same address.",
    retry: null,
  }),
  declined: Object.freeze({
    title: "Access not available",
    kicker: "Closed beta",
    heading: "Access is not available for this account",
    body:
      "Your request to join the PackScout beta was not approved, so this " +
      "account cannot use PackScout.",
    detail:
      "Signing in again with this address will not change the answer. If a " +
      "different email or wallet address of yours was invited, you can sign " +
      "out and use that one instead.",
    retry: null,
  }),
  suspended: Object.freeze({
    title: "Account suspended",
    kicker: "Account notice",
    heading: "This account is suspended",
    body:
      "Your account has been suspended, so PackScout is not available to " +
      "it right now. This is a decision about this account, separate from " +
      "the beta.",
    detail:
      "Signing in with a different address does not lift a suspension of " +
      "this account. You can sign out below.",
    retry: null,
  }),
  undetermined: Object.freeze({
    title: "Access check unavailable",
    kicker: "One moment",
    heading: "We can't confirm your access right now",
    body:
      "PackScout could not reach the service that checks beta access. This " +
      "is a temporary problem on our side — not a decision about you or " +
      "your request.",
    detail: "Nothing about your request has changed. Try again in a moment.",
    retry: Object.freeze({ href: "/", label: "Try again" }),
  }),
});

/**
 * The one moment the surface says yes: the live decision flipped to admitted
 * while the page was open, and the product is about to load. Distinct words
 * so the transition reads as what it is, not as another waiting screen.
 */
export const ACCESS_APPROVED_NOTICE = Object.freeze({
  title: "Access approved",
  kicker: "Closed beta",
  heading: "You're in",
  body: "Your access was approved. Taking you into PackScout…",
});

/**
 * The identity block: which verified address this decision is about. Only
 * what the sign-in provider itself verified is ever shown — nothing inferred,
 * and nothing about anyone else — so the person can tell at a glance whether
 * they used the address they expected.
 */
export const ACCESS_IDENTITY_COPY = Object.freeze({
  legend: "Signed in as",
  emailLabel: "Email",
  walletLabel: "Wallet address",
  /** A verified session that exposed no displayable address. */
  noneExposed:
    "Your sign-in did not share an email or wallet address we can show here.",
  /** The browser is still establishing the session the server saw. */
  checking: "Checking which address you are signed in with…",
  /** The session has ended on this device. */
  signedOut: "You are signed out on this device.",
  /** The established session could not be verified. */
  sessionError:
    "Your sign-in session could not be verified on this device. Signing " +
    "out usually clears this up.",
  /** Authentication is not configured, so no address can be shown. */
  unavailable:
    "Sign-in is not available right now, so the address you used cannot be " +
    "shown.",
});

/** Labels for the session controls the surface offers. */
export const ACCESS_CONTROL_COPY = Object.freeze({
  signOut: "Sign out",
  signOutBusy: "Signing out…",
  switchIdentity: "Sign out & use a different address",
  signIn: "Sign in",
  signOutFailed: "Sign out failed. Try again.",
});

/**
 * What to do if the state looks wrong. PackScout has no support inbox or
 * ticket form, and inventing one here would be dishonest — the honest paths
 * are the two that exist: check that the address above is the one that was
 * actually invited, and ask the person who did the inviting. The sentence
 * about an inviter is conditional on one existing, so it stays true for
 * people who simply signed in to request access.
 */
export const ACCESS_WRONG_STATE_GUIDANCE =
  "Think something is off? Check the address above first — access is tied " +
  "to the exact email or wallet address it was granted for, and signing in " +
  "with a different one starts a separate request. If someone invited you " +
  "to the beta, they are the right person to ask about it.";
