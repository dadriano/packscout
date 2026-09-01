import { z } from "zod";
import {
  publicPackAvailabilities,
  type PublicPackAvailability,
} from "./public-pack-availability-v1.ts";

/**
 * Shared product-user directory vocabulary.
 *
 * Product users sign up through the product backend, not through the admin's
 * own database, so the admin only ever *reads* a projection of that directory.
 * The row shape, the request bounds, and the identity presentation rules live
 * here because the admin server (which owns the server-to-server integration)
 * and the admin browser (which renders the ledger) must agree on them without
 * either one importing the other.
 */

export const productUserStandings = ["active", "suspended"] as const;

export type ProductUserStanding = (typeof productUserStandings)[number];

/**
 * The closed-beta admission dimension, deliberately separate from standing.
 * Standing asks whether a known account was disciplined; access asks whether
 * an account was let in. A waiting account is a person at the door, not a
 * suspended one, and the two must never be collapsed into one badge.
 */
export const productUserAccessStates = [
  "awaiting_review",
  "approved",
  "declined",
] as const;

export type ProductUserAccessState = (typeof productUserAccessStates)[number];

/**
 * Who established the current decision: nobody yet (the default a record holds
 * from first sign-in), the beta allowlist automatically, or an operator by
 * hand. Provenance is display and audit data, never free text.
 */
export const productUserAccessDeciders = [
  "default",
  "allowlist",
  "operator",
] as const;

export type ProductUserAccessDecider = (typeof productUserAccessDeciders)[number];

/**
 * One access decision as the admin browser is allowed to see it: the state,
 * what produced it, and when. The product backend's stored decision also
 * carries the matched allowlist entry or the acting operator's identifier;
 * neither is needed to render provenance, so neither crosses to the browser.
 */
export interface ProductUserAccessDecision {
  readonly state: ProductUserAccessState;
  readonly decidedBy: ProductUserAccessDecider;
  readonly decidedAt: string;
}

/**
 * The composed decision-plus-standing answer the product backend reports with
 * every operator decision, so the admin can tell the whole truth: approving a
 * suspended account is a real approval that still leaves the person locked
 * out, and the toast must say so rather than claiming they are in.
 */
export type ProductUserEffectiveAccess =
  | { readonly admitted: true; readonly reason: "approved" }
  | {
      readonly admitted: false;
      readonly reason: "awaiting_review" | "declined" | "suspended" | "undetermined";
    };

/**
 * The product backend's stable refusal when a suspended account attempts an
 * authenticated write. It lives here because the product backend raises it and
 * the product frontend maps it to a plain notice, and neither may guess at the
 * other's spelling. Nothing about it is operator-facing or internal.
 */
export const PRODUCT_USER_SUSPENDED_ERROR_CODE = "ACCOUNT_SUSPENDED";

/**
 * The directory read is bounded at every edge. The page size matches the
 * product backend's own maximum, so the admin can never ask for a page the
 * backend would refuse.
 */
export const PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE = 20;
export const PRODUCT_USER_MAX_SEARCH_LENGTH = 320;
export const PRODUCT_USER_MAX_SUBJECT_LENGTH = 1_024;
export const PRODUCT_USER_MAX_TEXT_LENGTH = 320;
export const PRODUCT_USER_MAX_WALLET_ADDRESS_LENGTH = 128;
export const PRODUCT_USER_MAX_AUTH_METHOD_LENGTH = 128;
/** Directory cursors are opaque backend values, so the bound is the backend's. */
export const PRODUCT_USER_MAX_CURSOR_LENGTH = 4_096;
/** The product backend caps saved items per kind; counts can never exceed it. */
export const PRODUCT_USER_MAX_SAVED_ITEM_COUNT = 250;
/** Public catalog identifiers are UUID-shaped; the bound is generous, not exact. */
export const PRODUCT_USER_MAX_PUBLIC_ID_LENGTH = 64;
/** Catalog display names, bounded as the public catalog bounds them. */
export const PRODUCT_USER_MAX_DISPLAY_NAME_LENGTH = 240;

/** Display-only profile details; they never replace the stored sign-in email. */
export interface ProductUserProfile {
  readonly name: string | null;
  readonly email: string | null;
}

/** One directory record as the admin browser is allowed to see it. */
export interface ProductUserRecord {
  readonly subject: string;
  readonly authMethod: string;
  readonly email: string | null;
  /** An optional enrichment: profile details may be absent or unavailable. */
  readonly profile?: ProductUserProfile | null;
  readonly walletAddress: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly standing: ProductUserStanding;
  /** The admission decision and its provenance, alongside — never inside — standing. */
  readonly access: ProductUserAccessDecision;
}

/** A directory record plus the size of what that user owns. */
export interface ProductUserDirectoryRow extends ProductUserRecord {
  readonly savedRepackCount: number;
  readonly savedCollectibleCount: number;
}

export interface ProductUserDirectoryPage {
  readonly items: readonly ProductUserDirectoryRow[];
  /** Opaque continuation handle; null when the listing is exhausted. */
  readonly nextCursor: string | null;
  /** True when a search hit the backend's bounded scan and may omit matches. */
  readonly searchTruncated: boolean;
}

/**
 * The listing request. Search terms and subject keys are personal data, so
 * this travels in a request body rather than a query string; the shape is
 * otherwise the admin's usual cursor/limit pagination contract.
 */
export const listProductUsersRequestSchema = z
  .object({
    search: z
      .string()
      .trim()
      .min(1, "Enter something to search for.")
      .max(PRODUCT_USER_MAX_SEARCH_LENGTH)
      .optional(),
    cursor: z
      .string()
      .trim()
      .min(1)
      .max(PRODUCT_USER_MAX_CURSOR_LENGTH)
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE)
      .default(PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE),
  })
  .strict();

export type ListProductUsersRequest = z.input<
  typeof listProductUsersRequestSchema
>;
export type NormalizedListProductUsersRequest = z.output<
  typeof listProductUsersRequestSchema
>;

/**
 * The detail request. The subject key identifies a person, so like the
 * listing it travels in a request body rather than a query string.
 */
export const productUserDetailRequestSchema = z
  .object({
    subject: z
      .string()
      .trim()
      .min(1, "Choose a user to inspect.")
      .max(PRODUCT_USER_MAX_SUBJECT_LENGTH),
  })
  .strict();

export type ProductUserDetailRequest = z.input<
  typeof productUserDetailRequestSchema
>;

/**
 * The standing request. There is exactly one account control and it is a
 * reversible flip: the caller names the standing it wants, not an operation to
 * perform, so repeating it converges instead of toggling. No shape here can
 * express a deletion.
 */
export const setProductUserStandingRequestSchema = z
  .object({
    subject: z
      .string()
      .trim()
      .min(1, "Choose a user to act on.")
      .max(PRODUCT_USER_MAX_SUBJECT_LENGTH),
    standing: z.enum(productUserStandings),
  })
  .strict();

export type SetProductUserStandingRequest = z.input<
  typeof setProductUserStandingRequestSchema
>;

/**
 * The outcome of a standing change: the authoritative record as it now stands,
 * and whether this particular call is what moved it. A repeat or concurrent
 * action reports `changed: false` with the true standing rather than failing.
 */
export interface ProductUserStandingChange {
  readonly user: ProductUserRecord;
  readonly changed: boolean;
}

/**
 * What the one account control does next, and exactly what the administrator
 * is agreeing to. Both the ledger row and the detail view read this, so the
 * consequence is stated identically wherever the control appears.
 */
export interface ProductUserStandingAction {
  /** The standing this action sets, sent verbatim as the request's target. */
  readonly standing: ProductUserStanding;
  readonly actionLabel: string;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly successMessage: string;
  /** Shown when the record was already in the requested standing. */
  readonly unchangedMessage: string;
  readonly destructive: boolean;
}

const SUSPEND_ACTION: ProductUserStandingAction = Object.freeze({
  standing: "suspended",
  actionLabel: "Suspend",
  title: "Suspend this account?",
  description:
    "While suspended, this person cannot save or unsave anything in PackScout, and signing in shows them a plain notice that their account is suspended. Everything they have already saved is kept, and they can still browse the public catalogue. You can reinstate them at any time.",
  confirmLabel: "Suspend account",
  successMessage: "Account suspended. Everything they saved is kept.",
  unchangedMessage: "That account was already suspended.",
  destructive: true,
});

const REINSTATE_ACTION: ProductUserStandingAction = Object.freeze({
  standing: "active",
  actionLabel: "Reinstate",
  title: "Reinstate this account?",
  description:
    "Reinstating restores this person's signed-in capabilities on their very next request, with everything they had saved still in place. Nothing was removed while they were suspended.",
  confirmLabel: "Reinstate account",
  successMessage:
    "Account reinstated, with everything they saved still in place.",
  unchangedMessage: "That account was already active.",
  destructive: false,
});

/**
 * The action available for a record in the given standing. There is no third
 * option: an account is either suspendable or reinstatable, and never
 * deletable.
 */
export function describeProductUserStandingAction(
  current: ProductUserStanding,
): ProductUserStandingAction {
  return current === "active" ? SUSPEND_ACTION : REINSTATE_ACTION;
}

/**
 * What to tell the administrator once the backend has spoken. The message is
 * derived from the standing the backend reports, not from the one the browser
 * asked for, so a concurrent action by someone else is reported honestly.
 */
export function describeProductUserStandingOutcome(
  change: ProductUserStandingChange,
): string {
  const performed =
    change.user.standing === "suspended" ? SUSPEND_ACTION : REINSTATE_ACTION;
  return change.changed ? performed.successMessage : performed.unchangedMessage;
}

export const productUserDirectoryErrorCodes = [
  "INVALID_PRODUCT_USER_REQUEST",
  "INVALID_PRODUCT_USER_CURSOR",
  "PRODUCT_USER_NOT_FOUND",
  "PRODUCT_USER_DIRECTORY_UNCONFIGURED",
  "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
] as const;

export type ProductUserDirectoryErrorCode =
  (typeof productUserDirectoryErrorCodes)[number];

/**
 * What one saved item is, as far as the active catalog can say.
 *
 * Saved rows are durable and outlive catalog republication, so an item whose
 * reference the active catalog no longer carries is `unresolved` rather than
 * missing: it keeps its stable public identifier so it stays investigable.
 */
export type ProductUserSavedItemResolution = "resolved" | "unresolved";

export const productUserRepackAvailabilities = publicPackAvailabilities;

export type ProductUserRepackAvailability = PublicPackAvailability;

export const productUserCollectibleTypes = [
  "card",
  "watch",
  "coin",
  "sealed_product",
  "memorabilia",
  "other",
] as const;

export type ProductUserCollectibleType =
  (typeof productUserCollectibleTypes)[number];

/** PackScout's own estimate for a repack, as the admin displays it. */
export interface ProductUserEstimatedEv {
  /** Signed USD minor units: estimated gross value less the repack price. */
  readonly evDollarsMinorUnits: number;
  /** Estimated gross value as basis points of the price. */
  readonly grossReturnBasisPoints: number;
  readonly confidenceBand: "low" | "medium" | "high";
}

interface SavedItemBase {
  readonly savedAt: string;
}

export type ProductUserSavedRepack = SavedItemBase &
  (
    | {
        readonly resolution: "resolved";
        readonly publicRepackId: string;
        readonly name: string;
        readonly vendorDisplayName: string;
        readonly availability: ProductUserRepackAvailability;
        readonly estimatedEv: ProductUserEstimatedEv | null;
      }
    | { readonly resolution: "unresolved"; readonly publicRepackId: string }
  );

export type ProductUserSavedCollectible = SavedItemBase &
  (
    | {
        readonly resolution: "resolved";
        readonly publicCollectibleId: string;
        readonly name: string;
        readonly collectibleType: ProductUserCollectibleType;
      }
    | {
        readonly resolution: "unresolved";
        readonly publicCollectibleId: string;
      }
  );

/**
 * One product user and everything they own in the product today. Both
 * collections are ordered newest save first and bounded by the product
 * backend's per-kind save cap.
 */
export interface ProductUserDetail {
  readonly user: ProductUserRecord;
  /**
   * False when no active catalog release could be read. Items are then
   * unresolved because nothing could be resolved, not because their
   * references were removed.
   */
  readonly catalogAvailable: boolean;
  readonly savedRepacks: readonly ProductUserSavedRepack[];
  readonly savedCollectibles: readonly ProductUserSavedCollectible[];
}

function usdFromMinorUnits(minorUnits: number): string {
  const whole = Math.trunc(Math.abs(minorUnits) / 100);
  const cents = Math.abs(minorUnits) % 100;
  return `${minorUnits < 0 ? "-" : "+"}$${whole.toLocaleString("en-US")}.${String(
    cents,
  ).padStart(2, "0")}`;
}

/**
 * A one-line estimated-value summary for a saved repack: what PackScout
 * estimates the pack returns against its price, and how confident that
 * estimate is. Percentages are rounded for display only; the underlying
 * basis points are what the product computed.
 */
export function describeProductUserEstimatedEv(
  estimate: ProductUserEstimatedEv,
): string {
  return `${usdFromMinorUnits(estimate.evDollarsMinorUnits)} EV · ${Math.round(
    estimate.grossReturnBasisPoints / 100,
  )}% of price · ${estimate.confidenceBand} confidence`;
}

/** Exact source-neutral public availability, phrased for an administrator. */
export function describeProductUserRepackAvailability(
  availability: ProductUserRepackAvailability,
): string {
  switch (availability) {
    case "available":
      return "Available now";
    case "unavailable":
      return "Unavailable";
    case "unknown":
      return "Availability unknown";
    case "sold_out":
      return "Sold out";
  }
}

export type ProductUserIdentityKind = "name" | "email" | "wallet" | "subject";

export interface ProductUserIdentity {
  readonly kind: ProductUserIdentityKind;
  readonly label: string;
  readonly secondary: string | null;
}

const SUBJECT_LABEL_MAX_LENGTH = 44;
const SUBJECT_LABEL_HEAD_LENGTH = 28;
const SUBJECT_LABEL_TAIL_LENGTH = 12;

/**
 * A bounded, single-line display form of the stable subject key.
 *
 * The key is an issuer-qualified token identifier — `issuer|subject` — that is
 * routinely longer than a table cell. The issuer is already shown as the
 * sign-in source, so the label keeps the part that distinguishes this person
 * and elides the middle of that part when it is still too long. The full value
 * stays on the row: this is presentation, not identity.
 */
export function boundedProductUserSubjectLabel(subject: string): string {
  if (subject.length === 0) return "Unrecorded identity";
  const separator = subject.lastIndexOf("|");
  const distinctive =
    separator === -1 || separator === subject.length - 1
      ? subject
      : subject.slice(separator + 1);
  if (distinctive.length <= SUBJECT_LABEL_MAX_LENGTH) return distinctive;
  return `${distinctive.slice(0, SUBJECT_LABEL_HEAD_LENGTH)}…${distinctive.slice(
    -SUBJECT_LABEL_TAIL_LENGTH,
  )}`;
}

/**
 * How one row identifies itself. Optional attributes are genuinely optional:
 * the hosted auth provider often issues a token carrying neither an email nor
 * a wallet address, and such a user is still a real sign-up that must render
 * as an identifiable, selectable row.
 */
export function describeProductUserIdentity(
  row: Pick<
    ProductUserDirectoryRow,
    "subject" | "email" | "walletAddress" | "profile"
  >,
): ProductUserIdentity {
  const email = row.profile?.email || row.email;
  if (row.profile?.name) {
    return { kind: "name", label: row.profile.name, secondary: email };
  }
  if (email !== null && email.length > 0) {
    return { kind: "email", label: email, secondary: row.walletAddress };
  }
  if (row.walletAddress !== null && row.walletAddress.length > 0) {
    return { kind: "wallet", label: row.walletAddress, secondary: null };
  }
  return {
    kind: "subject",
    label: boundedProductUserSubjectLabel(row.subject),
    secondary: null,
  };
}

/**
 * The three operator decisions about admission. Approve admits, decline
 * refuses, revoke returns the identity to awaiting review. All three are
 * reversible flips on the record; none can express a deletion.
 */
export const productUserAccessActions = ["approve", "decline", "revoke"] as const;

export type ProductUserAccessAction = (typeof productUserAccessActions)[number];

/**
 * The review-queue listing request. The queue is the directory filtered by
 * access state, so it shares the directory's bounded cursor/limit pagination
 * contract; state defaults to the queue that matters, awaiting review.
 */
export const listProductUserAccessQueueRequestSchema = z
  .object({
    accessState: z.enum(productUserAccessStates).default("awaiting_review"),
    cursor: z.string().trim().min(1).max(PRODUCT_USER_MAX_CURSOR_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE)
      .default(PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE),
  })
  .strict();

export type ListProductUserAccessQueueRequest = z.input<
  typeof listProductUserAccessQueueRequestSchema
>;

/**
 * One page of the review queue: full directory rows, oldest request first so
 * nobody is buried by newer arrivals. `queueTruncated` means the backend's
 * bounded queue scan cut off the newest arrivals — the front of the queue,
 * which is what operators work, is always complete.
 */
export interface ProductUserAccessQueuePage {
  readonly items: readonly ProductUserDirectoryRow[];
  /** Opaque continuation handle; null when the listing is exhausted. */
  readonly nextCursor: string | null;
  readonly queueTruncated: boolean;
}

/**
 * How many identities are awaiting review, bounded. `truncated` means the
 * backend's counting bound was hit and the real number is at least `count`,
 * which displays as "500+" rather than a false exact figure.
 */
export interface ProductUserAccessQueueCount {
  readonly count: number;
  readonly truncated: boolean;
}

/** The bounded count as operators read it: exact, or "at least this many". */
export function formatProductUserAwaitingCount(
  count: ProductUserAccessQueueCount,
): string {
  return count.truncated ? `${count.count}+` : `${count.count}`;
}

/**
 * A decision request names only the person. The action is the endpoint, and
 * the acting operator is always the authenticated session — no request shape
 * can act as someone else.
 */
export const decideProductUserAccessRequestSchema = z
  .object({
    subject: z
      .string()
      .trim()
      .min(1, "Choose a user to act on.")
      .max(PRODUCT_USER_MAX_SUBJECT_LENGTH),
  })
  .strict();

export type DecideProductUserAccessRequest = z.input<
  typeof decideProductUserAccessRequestSchema
>;

/**
 * The outcome of a decision: which action ran, whether this call is what
 * moved the record, the decision the product backend now holds, and the
 * composed effective access. A repeat or concurrent action reports
 * `changed: false` with the authoritative decision rather than failing.
 */
export interface ProductUserAccessDecisionChange {
  readonly action: ProductUserAccessAction;
  readonly changed: boolean;
  /** The resulting decision — what the record authoritatively holds now. */
  readonly access: ProductUserAccessDecision;
  readonly effectiveAccess: ProductUserEffectiveAccess;
}

/** The badge label for an access state, spelled the same everywhere. */
export function describeProductUserAccessState(
  state: ProductUserAccessState,
): string {
  switch (state) {
    case "awaiting_review":
      return "Awaiting review";
    case "approved":
      return "Approved";
    case "declined":
      return "Declined";
  }
}

/**
 * How the current decision came to be, for the ledger's provenance line. The
 * caller appends the decision date; this names the mechanism, so an operator
 * can tell an allowlist admission from a hand approval at a glance.
 */
export function describeProductUserAccessProvenance(
  decision: ProductUserAccessDecision,
): string {
  if (decision.decidedBy === "default") return "Awaiting a first decision";
  if (decision.decidedBy === "allowlist") {
    return decision.state === "approved"
      ? "Admitted automatically by the allowlist"
      : `${describeProductUserAccessState(decision.state)} by the allowlist`;
  }
  return decision.state === "awaiting_review"
    ? "Returned to review by an operator"
    : `${describeProductUserAccessState(decision.state)} by an operator`;
}

/**
 * What one decision control does next, and exactly what the administrator is
 * agreeing to. The ledger row and the detail view both read this, so a
 * consequence is stated identically wherever the control appears.
 */
export interface ProductUserAccessActionDescription {
  readonly action: ProductUserAccessAction;
  readonly actionLabel: string;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly destructive: boolean;
}

const APPROVE_ACCESS_ACTION: ProductUserAccessActionDescription = Object.freeze({
  action: "approve",
  actionLabel: "Approve",
  title: "Approve access for this person?",
  description:
    "Approving admits this person to the PackScout closed beta immediately. If they are signed in on the waiting screen, they are let straight into the product. You can revoke or decline their access at any time, and nothing about their account is ever deleted.",
  confirmLabel: "Approve access",
  destructive: false,
});

const DECLINE_ACCESS_ACTION: ProductUserAccessActionDescription = Object.freeze({
  action: "decline",
  actionLabel: "Decline",
  title: "Decline access for this person?",
  description:
    "Declining refuses this person's beta access. When they sign in they see the declined notice instead of the product. Their sign-up record and everything they saved are kept, and adding them to the allowlist later will not overturn this decision — only an operator can reverse it.",
  confirmLabel: "Decline access",
  destructive: true,
});

const REVOKE_ACCESS_ACTION: ProductUserAccessActionDescription = Object.freeze({
  action: "revoke",
  actionLabel: "Revoke",
  title: "Revoke this person's access?",
  description:
    "Revoking returns this person to awaiting review and closes the product to them on their very next request. Nothing they saved is deleted. If their email or wallet address is still on the allowlist, their next sign-in will admit them again automatically — decline them instead if they must stay out.",
  confirmLabel: "Revoke access",
  destructive: true,
});

const REOPEN_ACCESS_ACTION: ProductUserAccessActionDescription = Object.freeze({
  action: "revoke",
  actionLabel: "Return to review",
  title: "Return this person to review?",
  description:
    "This clears the decline and returns this person to awaiting review. They stay out of the product until someone approves them — but if their email or wallet address is on the allowlist, their next sign-in will admit them automatically.",
  confirmLabel: "Return to review",
  destructive: false,
});

/**
 * The decision controls that make sense for a record in the given state.
 * Waiting people get the two verdicts; admitted people can be revoked (and
 * declined from review afterwards); declined people can be approved outright
 * or handed back to the queue. Every state stays reversible and no state
 * offers a deletion.
 */
export function describeProductUserAccessActions(
  current: ProductUserAccessState,
): readonly ProductUserAccessActionDescription[] {
  switch (current) {
    case "awaiting_review":
      return [APPROVE_ACCESS_ACTION, DECLINE_ACCESS_ACTION];
    case "approved":
      return [REVOKE_ACCESS_ACTION];
    case "declined":
      return [APPROVE_ACCESS_ACTION, REOPEN_ACCESS_ACTION];
  }
}

/**
 * What to tell the administrator once the product backend has spoken. The
 * message is derived from the decision the backend reports, not the one the
 * browser asked for: a repeat states the authoritative decision plainly, and
 * an approval that leaves the person suspended says so instead of claiming
 * they are in.
 */
export function describeProductUserAccessOutcome(
  change: ProductUserAccessDecisionChange,
): string {
  const { state } = change.access;
  if (!change.changed) {
    switch (state) {
      case "approved":
        return "That person's access was already approved.";
      case "declined":
        return "That person's access was already declined.";
      case "awaiting_review":
        return "That person was already awaiting review.";
    }
  }
  switch (state) {
    case "approved":
      return change.effectiveAccess.admitted
        ? "Access approved. They are in the beta now."
        : change.effectiveAccess.reason === "suspended"
          ? "Access approved — but this account is suspended, so they stay locked out until reinstated."
          : "Access approved.";
    case "declined":
      return "Access declined. Their sign-up record and saved items are kept.";
    case "awaiting_review":
      return "Access revoked. They are back in the review queue and out of the product on their next request.";
  }
}
