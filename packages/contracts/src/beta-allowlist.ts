import { z } from "zod";

/**
 * Shared beta-allowlist vocabulary for the admin surface.
 *
 * The allowlist itself lives with the product backend (it must be consulted
 * during product sign-in), and the admin reaches it through the same
 * server-to-server operator integration as the product-user directory. The
 * entry shape, request bounds, and stable admin error codes live here because
 * the admin server (which owns the integration) and the admin browser (which
 * renders the ledger) must agree on them without either one importing the
 * other.
 *
 * Entries carry email and wallet addresses of real people, so every request
 * shape here travels in a POST body — identifiers never appear in URLs, query
 * strings, browser history, or logs — and every stable code below describes a
 * failure without echoing an identifier.
 */

/**
 * The listing page size, equal to the product backend's own maximum so the
 * admin can never ask for a page the backend would refuse.
 */
export const BETA_ALLOWLIST_PAGE_SIZE = 20;
export const BETA_ALLOWLIST_MAX_SEARCH_LENGTH = 320;
/** Email bound shared with the product-user directory's text bound. */
export const BETA_ALLOWLIST_MAX_EMAIL_LENGTH = 320;
export const BETA_ALLOWLIST_MAX_WALLET_ADDRESS_LENGTH = 128;
/** The backend refuses longer labels; the bound is restated for forms. */
export const BETA_ALLOWLIST_MAX_LABEL_LENGTH = 120;
/** Entry ids are opaque backend values, never personal data. */
export const BETA_ALLOWLIST_MAX_ENTRY_ID_LENGTH = 128;
/** Listing cursors are opaque backend values, so the bound is the backend's. */
export const BETA_ALLOWLIST_MAX_CURSOR_LENGTH = 4_096;
/** Operator references and display names, bounded as the auth surface bounds them. */
export const BETA_ALLOWLIST_MAX_OPERATOR_ID_LENGTH = 128;
export const BETA_ALLOWLIST_MAX_OPERATOR_NAME_LENGTH = 120;

/** One allowlist entry as the operator integration reports it. */
export interface BetaAllowlistEntry {
  /** Stable opaque id of the entry; safe to hold in memory, never in a URL. */
  readonly entryId: string;
  /** Normalized email address, or null when the entry names only a wallet. */
  readonly email: string | null;
  /** Verbatim-cased wallet address, or null when the entry names only an email. */
  readonly walletAddress: string | null;
  /** Optional short note for the operator's own reference. */
  readonly label: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Admin-side identifier of the operator who created the entry. */
  readonly createdByOperatorId: string;
}

/**
 * A ledger row: the entry plus the creating operator's display name when the
 * admin can still resolve it. Null when the operator record is unresolvable;
 * the ledger then falls back to the bounded operator reference.
 */
export interface BetaAllowlistRow extends BetaAllowlistEntry {
  readonly createdByDisplayName: string | null;
}

export interface BetaAllowlistPage {
  readonly items: readonly BetaAllowlistRow[];
  /** Opaque continuation handle; null when the listing is exhausted. */
  readonly nextCursor: string | null;
  /** True when a search hit the backend's bounded scan and may omit matches. */
  readonly searchTruncated: boolean;
}

/**
 * The outcome of creating or editing an entry: the authoritative entry as
 * stored, and how many waiting accounts the change admitted on the spot. The
 * count is what tells the operator the invited person is no longer stuck.
 */
export interface BetaAllowlistEntryChange {
  readonly entry: BetaAllowlistEntry;
  readonly admittedCount: number;
}

/**
 * The outcome of removing an entry. `removed: false` means the entry was
 * already gone, so repeated operator actions converge instead of failing.
 * Removal never changes any existing access decision.
 */
export interface BetaAllowlistRemoval {
  readonly removed: boolean;
}

/**
 * The listing request. Search terms are identifiers of real people, so this
 * travels in a request body rather than a query string; the shape is
 * otherwise the admin's usual cursor/limit pagination contract.
 */
export const listBetaAllowlistRequestSchema = z
  .object({
    search: z
      .string()
      .trim()
      .min(1, "Enter something to search for.")
      .max(BETA_ALLOWLIST_MAX_SEARCH_LENGTH)
      .optional(),
    cursor: z
      .string()
      .trim()
      .min(1)
      .max(BETA_ALLOWLIST_MAX_CURSOR_LENGTH)
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(BETA_ALLOWLIST_PAGE_SIZE)
      .default(BETA_ALLOWLIST_PAGE_SIZE),
  })
  .strict();

export type ListBetaAllowlistRequest = z.input<
  typeof listBetaAllowlistRequestSchema
>;
export type NormalizedListBetaAllowlistRequest = z.output<
  typeof listBetaAllowlistRequestSchema
>;

/**
 * Field shapes for create and update. The product backend owns normalization
 * (email case-folding, wallet-address casing) and duplicate detection, so
 * these bound and trim but deliberately do not second-guess what counts as a
 * valid address — one authority, not two.
 */
const allowlistEmailField = z
  .string()
  .trim()
  .min(1, "Enter an email address.")
  .max(
    BETA_ALLOWLIST_MAX_EMAIL_LENGTH,
    `Email must be ${BETA_ALLOWLIST_MAX_EMAIL_LENGTH} characters or fewer.`,
  );
const allowlistWalletAddressField = z
  .string()
  .trim()
  .min(1, "Enter a wallet address.")
  .max(
    BETA_ALLOWLIST_MAX_WALLET_ADDRESS_LENGTH,
    `Wallet address must be ${BETA_ALLOWLIST_MAX_WALLET_ADDRESS_LENGTH} characters or fewer.`,
  );
const allowlistLabelField = z
  .string()
  .trim()
  .min(1)
  .max(
    BETA_ALLOWLIST_MAX_LABEL_LENGTH,
    `Label must be ${BETA_ALLOWLIST_MAX_LABEL_LENGTH} characters or fewer.`,
  );
const allowlistEntryIdField = z
  .string()
  .trim()
  .min(1, "Choose an allowlist entry.")
  .max(BETA_ALLOWLIST_MAX_ENTRY_ID_LENGTH);

/**
 * The create request. At least one identifier is required; the acting
 * operator is taken from the server session, so no shape here can name one.
 */
export const createBetaAllowlistEntryRequestSchema = z
  .object({
    email: allowlistEmailField.optional(),
    walletAddress: allowlistWalletAddressField.optional(),
    label: allowlistLabelField.optional(),
  })
  .strict()
  .refine(
    (value) => value.email !== undefined || value.walletAddress !== undefined,
    { message: "Enter an email address, a wallet address, or both." },
  );

export type CreateBetaAllowlistEntryRequest = z.input<
  typeof createBetaAllowlistEntryRequestSchema
>;
export type NormalizedCreateBetaAllowlistEntryRequest = z.output<
  typeof createBetaAllowlistEntryRequestSchema
>;

/**
 * The update request. An omitted field keeps its stored value and an explicit
 * null clears it, so the edit form states the entry it wants in full without
 * re-sending what it does not touch.
 */
export const updateBetaAllowlistEntryRequestSchema = z
  .object({
    entryId: allowlistEntryIdField,
    email: allowlistEmailField.nullable().optional(),
    walletAddress: allowlistWalletAddressField.nullable().optional(),
    label: allowlistLabelField.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.email !== undefined ||
      value.walletAddress !== undefined ||
      value.label !== undefined,
    { message: "Provide at least one allowlist change." },
  );

export type UpdateBetaAllowlistEntryRequest = z.input<
  typeof updateBetaAllowlistEntryRequestSchema
>;
export type NormalizedUpdateBetaAllowlistEntryRequest = z.output<
  typeof updateBetaAllowlistEntryRequestSchema
>;

export const removeBetaAllowlistEntryRequestSchema = z
  .object({ entryId: allowlistEntryIdField })
  .strict();

export type RemoveBetaAllowlistEntryRequest = z.input<
  typeof removeBetaAllowlistEntryRequestSchema
>;

/**
 * The admin's stable beta-allowlist failure codes. Every failure the browser
 * can see resolves to one of these; no upstream status text or body is ever
 * restated, and no code or message carries an identifier.
 */
export const betaAllowlistAdminErrorCodes = [
  "BETA_ALLOWLIST_UNAVAILABLE",
  "BETA_ALLOWLIST_UNCONFIGURED",
  "BETA_ALLOWLIST_ENTRY_NOT_FOUND",
  "INVALID_BETA_ALLOWLIST_REQUEST",
  "INVALID_BETA_ALLOWLIST_CURSOR",
  "BETA_ALLOWLIST_EMAIL_INVALID",
  "BETA_ALLOWLIST_WALLET_ADDRESS_INVALID",
  "BETA_ALLOWLIST_LABEL_INVALID",
  "BETA_ALLOWLIST_IDENTIFIER_REQUIRED",
  "BETA_ALLOWLIST_DUPLICATE_EMAIL",
  "BETA_ALLOWLIST_DUPLICATE_WALLET_ADDRESS",
] as const;

export type BetaAllowlistAdminErrorCode =
  (typeof betaAllowlistAdminErrorCodes)[number];
