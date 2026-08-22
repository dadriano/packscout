/**
 * Every word the holding surface says, keyed by the reason the gate hands it
 * (closed-beta-access/007).
 *
 * This is the placeholder copy for the surface closed-beta-access/008 owns:
 * 008 replaces the words and adds the identity display, the live reaction to
 * decision changes, and the contact path, but the route, the reason
 * vocabulary, and this content shape are the hand-off. Each reason gets
 * distinct, plain-language copy — waiting is not declined, declined is not
 * suspended, and a backend that could not answer is a temporary problem
 * clearly separated from any decision about the person. No status codes or
 * backend vocabulary reach the visitor.
 *
 * Nothing here reads catalog data or authentication state; the surface
 * renders from the reason alone.
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
  /** Where the sign-out affordance lives and what it is for. */
  accountNote: string;
  /** A retry action, only for the temporary-problem state. */
  retry: Readonly<{ href: "/"; label: string }> | null;
}>;

const ACCOUNT_NOTE =
  "You can sign out from the account menu in the top-right corner — for " +
  "example to try a different email or wallet address.";

export const ACCESS_HOLDING_COPY: Readonly<
  Record<AccessHoldingReason, AccessHoldingCopy>
> = Object.freeze({
  awaiting_review: Object.freeze({
    title: "Access request in review",
    kicker: "Closed beta",
    heading: "Your access request is in review",
    body:
      "You are signed in, and your request to join the PackScout beta is " +
      "with the team. You will be able to use PackScout as soon as it is " +
      "approved.",
    accountNote: ACCOUNT_NOTE,
    retry: null,
  }),
  declined: Object.freeze({
    title: "Access not available",
    kicker: "Closed beta",
    heading: "Access is not available for this account",
    body:
      "Your request to join the PackScout beta was not approved, so this " +
      "account cannot use PackScout right now.",
    accountNote: ACCOUNT_NOTE,
    retry: null,
  }),
  suspended: Object.freeze({
    title: "Account suspended",
    kicker: "Account notice",
    heading: "This account is suspended",
    body:
      "Your account has been suspended, so PackScout is not available to " +
      "it. This is different from the beta review process.",
    accountNote: ACCOUNT_NOTE,
    retry: null,
  }),
  undetermined: Object.freeze({
    title: "Access check unavailable",
    kicker: "One moment",
    heading: "We can't confirm your access right now",
    body:
      "PackScout could not reach the service that checks beta access. This " +
      "is a temporary problem on our side, not a decision about your " +
      "request.",
    accountNote: ACCOUNT_NOTE,
    retry: Object.freeze({ href: "/", label: "Try again" }),
  }),
});
