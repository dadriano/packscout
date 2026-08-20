import { z } from "zod";

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

/** One directory row as the admin browser is allowed to see it. */
export interface ProductUserDirectoryRow {
  readonly subject: string;
  readonly authMethod: string;
  readonly email: string | null;
  readonly walletAddress: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly standing: ProductUserStanding;
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
    cursor: z.string().trim().min(1).max(PRODUCT_USER_MAX_CURSOR_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE)
      .default(PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE),
  })
  .strict();

export type ListProductUsersRequest = z.input<typeof listProductUsersRequestSchema>;
export type NormalizedListProductUsersRequest = z.output<
  typeof listProductUsersRequestSchema
>;

export const productUserDirectoryErrorCodes = [
  "INVALID_PRODUCT_USER_REQUEST",
  "INVALID_PRODUCT_USER_CURSOR",
  "PRODUCT_USER_DIRECTORY_UNCONFIGURED",
  "PRODUCT_USER_DIRECTORY_UNAVAILABLE",
] as const;

export type ProductUserDirectoryErrorCode =
  (typeof productUserDirectoryErrorCodes)[number];

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
