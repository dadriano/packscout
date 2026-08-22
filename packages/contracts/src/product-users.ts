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

/** One directory record as the admin browser is allowed to see it. */
export interface ProductUserRecord {
  readonly subject: string;
  readonly authMethod: string;
  readonly email: string | null;
  readonly walletAddress: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly standing: ProductUserStanding;
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

export type ProductUserIdentityKind = "email" | "wallet" | "subject";

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
  row: Pick<ProductUserDirectoryRow, "subject" | "email" | "walletAddress">,
): ProductUserIdentity {
  if (row.email !== null && row.email.length > 0) {
    return { kind: "email", label: row.email, secondary: row.walletAddress };
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
