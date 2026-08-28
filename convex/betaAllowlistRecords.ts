import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  normalizeProductUserEmail,
  normalizeProductUserWalletAddress,
  PRODUCT_USER_MAX_TEXT_LENGTH,
  type ProductUserAccessDecision,
} from "./productUserRecords";

/**
 * Shared shape and normalization rules for the closed-beta allowlist.
 *
 * An allowlist entry names an invited identity by email address, wallet
 * address, or both. It is matched two ways: during establishment of a sign-in
 * (an invited identity is admitted on first authenticated contact) and
 * retroactively when an operator adds or edits an entry (identities already
 * waiting are admitted on the spot). Both matchers read the same normalized
 * forms defined here, shared with the product-user directory so an entry and
 * a directory record can never disagree about what "the same address" means:
 * email addresses are trimmed and case-folded, and wallet addresses keep
 * their verbatim casing while matching through a lowercase key.
 *
 * Entries hold email and wallet addresses of real people, so they carry the
 * same handling rules as the directory itself: every refusal is a fixed
 * string, and no identifier is ever echoed into an error, a log, or a URL.
 */

export const BETA_ALLOWLIST_MAX_LABEL_LENGTH = 120;
export const BETA_ALLOWLIST_MAX_OPERATOR_LENGTH = 128;
export const BETA_ALLOWLIST_MAX_PAGE_SIZE = 20;

/**
 * A string that sorts after every realistic continuation of a search prefix,
 * used as the inclusive upper bound of an index prefix range.
 */
const SEARCH_PREFIX_UPPER_BOUND_SUFFIX = "\u{10FFFF}";

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const SEARCH_CURSOR = /^offset:(\d{1,6})$/u;

export type BetaAllowlistErrorCode =
  | "BETA_ALLOWLIST_IDENTIFIER_REQUIRED"
  | "BETA_ALLOWLIST_EMAIL_INVALID"
  | "BETA_ALLOWLIST_WALLET_ADDRESS_INVALID"
  | "BETA_ALLOWLIST_LABEL_INVALID"
  | "BETA_ALLOWLIST_OPERATOR_INVALID"
  | "BETA_ALLOWLIST_ENTRY_INVALID"
  | "BETA_ALLOWLIST_DUPLICATE_EMAIL"
  | "BETA_ALLOWLIST_DUPLICATE_WALLET_ADDRESS"
  | "BETA_ALLOWLIST_SEARCH_INVALID"
  | "BETA_ALLOWLIST_PAGE_SIZE_INVALID"
  | "BETA_ALLOWLIST_PAGE_CURSOR_INVALID";

/**
 * Fixed refusal messages. The duplicate refusals name which kind of
 * identifier is already covered — that is what makes them actionable — but
 * never the identifier itself.
 */
const BETA_ALLOWLIST_MESSAGES: Readonly<Record<BetaAllowlistErrorCode, string>> =
  Object.freeze({
    BETA_ALLOWLIST_IDENTIFIER_REQUIRED:
      "A beta-allowlist entry needs an email address or a wallet address.",
    BETA_ALLOWLIST_EMAIL_INVALID:
      "The beta-allowlist email address is invalid.",
    BETA_ALLOWLIST_WALLET_ADDRESS_INVALID:
      "The beta-allowlist wallet address is invalid.",
    BETA_ALLOWLIST_LABEL_INVALID: "The beta-allowlist label is invalid.",
    BETA_ALLOWLIST_OPERATOR_INVALID:
      "The beta-allowlist operator reference is invalid.",
    BETA_ALLOWLIST_ENTRY_INVALID:
      "The beta-allowlist entry reference is invalid.",
    BETA_ALLOWLIST_DUPLICATE_EMAIL:
      "Another beta-allowlist entry already covers this email address.",
    BETA_ALLOWLIST_DUPLICATE_WALLET_ADDRESS:
      "Another beta-allowlist entry already covers this wallet address.",
    BETA_ALLOWLIST_SEARCH_INVALID:
      "The beta-allowlist search term is invalid.",
    BETA_ALLOWLIST_PAGE_SIZE_INVALID:
      "The requested beta-allowlist page size is out of bounds.",
    BETA_ALLOWLIST_PAGE_CURSOR_INVALID:
      "The beta-allowlist page cursor is invalid.",
  });

export function refuseBetaAllowlist(code: BetaAllowlistErrorCode): never {
  throw new ConvexError({ code, message: BETA_ALLOWLIST_MESSAGES[code] });
}

export const betaAllowlistEntryDocumentValidator = v.object({
  /** Normalized (trimmed, case-folded) email address, or null. */
  email: v.union(v.string(), v.null()),
  /** Verbatim-cased wallet address (checksums are meaningful), or null. */
  walletAddress: v.union(v.string(), v.null()),
  /** Lowercased wallet address; match and search key only, never a response. */
  walletAddressKey: v.union(v.string(), v.null()),
  /** Optional short note for the operator's own reference. */
  label: v.union(v.string(), v.null()),
  createdAt: v.string(),
  updatedAt: v.string(),
  /** Admin-side identifier of the operator who created the entry. */
  createdByOperatorId: v.string(),
});

/**
 * The entry as the operator integration sees it: the stable id plus every
 * stored field except the lowercase wallet key, which is storage detail.
 */
export const betaAllowlistEntryValidator = betaAllowlistEntryDocumentValidator
  .omit("walletAddressKey")
  .extend({ entryId: v.string() });

export type BetaAllowlistEntryDocument = Infer<
  typeof betaAllowlistEntryDocumentValidator
>;
export type BetaAllowlistEntry = Infer<typeof betaAllowlistEntryValidator>;

/** The pair of normalized identifiers both matchers consume. */
export type BetaAllowlistIdentifiers = Readonly<{
  email: string | null;
  walletAddressKey: string | null;
}>;

export function toBetaAllowlistEntry(
  document: Doc<"betaAllowlistEntries">,
): BetaAllowlistEntry {
  return {
    entryId: document._id,
    email: document.email,
    walletAddress: document.walletAddress,
    label: document.label,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    createdByOperatorId: document.createdByOperatorId,
  };
}

/**
 * Normalizes an operator-supplied email identifier. Absence is fine — an
 * entry may carry only a wallet address — but a present value that does not
 * normalize is a refusal, never a silently dropped identifier: an operator
 * who typoed an address must not end up with an entry that admits nobody.
 */
export function requireBetaAllowlistEmail(value: string | null): string | null {
  if (value === null) return null;
  const normalized = normalizeProductUserEmail(value);
  if (normalized === null) refuseBetaAllowlist("BETA_ALLOWLIST_EMAIL_INVALID");
  return normalized;
}

/** As `requireBetaAllowlistEmail`, for the wallet-address identifier. */
export function requireBetaAllowlistWalletAddress(
  value: string | null,
): string | null {
  if (value === null) return null;
  const normalized = normalizeProductUserWalletAddress(value);
  if (normalized === null) {
    refuseBetaAllowlist("BETA_ALLOWLIST_WALLET_ADDRESS_INVALID");
  }
  return normalized;
}

/** A blank label reads as "no label"; a malformed one is a refusal. */
export function requireBetaAllowlistLabel(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (
    trimmed.length > BETA_ALLOWLIST_MAX_LABEL_LENGTH ||
    CONTROL_CHARACTERS.test(trimmed)
  ) {
    refuseBetaAllowlist("BETA_ALLOWLIST_LABEL_INVALID");
  }
  return trimmed;
}

/**
 * Bounds the creating operator's admin-side reference. Like the operator in
 * decision provenance, it is a bounded string rather than a foreign key
 * because operator identities live in the admin's own store.
 */
export function requireBetaAllowlistOperator(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > BETA_ALLOWLIST_MAX_OPERATOR_LENGTH ||
    CONTROL_CHARACTERS.test(trimmed)
  ) {
    refuseBetaAllowlist("BETA_ALLOWLIST_OPERATOR_INVALID");
  }
  return trimmed;
}

export async function findBetaAllowlistEntryByEmail(
  ctx: Pick<QueryCtx, "db">,
  email: string,
): Promise<Doc<"betaAllowlistEntries"> | null> {
  const matches = await ctx.db
    .query("betaAllowlistEntries")
    .withIndex("by_email", (index) => index.eq("email", email))
    .take(1);
  return matches[0] ?? null;
}

export async function findBetaAllowlistEntryByWalletAddressKey(
  ctx: Pick<QueryCtx, "db">,
  walletAddressKey: string,
): Promise<Doc<"betaAllowlistEntries"> | null> {
  const matches = await ctx.db
    .query("betaAllowlistEntries")
    .withIndex("by_wallet_address_key", (index) =>
      index.eq("walletAddressKey", walletAddressKey),
    )
    .take(1);
  return matches[0] ?? null;
}

/**
 * The evaluation the establishment path (closed-beta-access/001) consumes:
 * given an identity's verified identifiers, the matching entry or nothing.
 *
 * Only identifiers that arrived through the Convex-verified identity (or were
 * stored from one on an earlier contact) ever reach this function — there is
 * no code path from a client-supplied attribute to a match. Email is
 * consulted first so an identity matching two different entries resolves
 * deterministically. Uniqueness of normalized identifiers is enforced at
 * write time; reads take the first index match so a broken invariant could
 * never make sign-in itself throw.
 */
export async function findBetaAllowlistMatch(
  ctx: Pick<QueryCtx, "db">,
  identifiers: BetaAllowlistIdentifiers,
): Promise<Doc<"betaAllowlistEntries"> | null> {
  const email = identifiers.email;
  if (email !== null) {
    const byEmail = await findBetaAllowlistEntryByEmail(ctx, email);
    if (byEmail !== null) return byEmail;
  }
  const walletAddressKey = identifiers.walletAddressKey;
  if (walletAddressKey !== null) {
    return await findBetaAllowlistEntryByWalletAddressKey(
      ctx,
      walletAddressKey,
    );
  }
  return null;
}

/**
 * The decision an allowlist match produces: approved, with provenance naming
 * the matched entry. Written by both matchers so establishment-time and
 * retroactive admissions are indistinguishable to auditors and displays.
 */
export function betaAllowlistApprovedDecision(
  entryId: Id<"betaAllowlistEntries">,
  decidedAt: string,
): ProductUserAccessDecision {
  return {
    state: "approved",
    decidedBy: "allowlist",
    decidedAt,
    allowlistEntryId: entryId,
  };
}

export type BetaAllowlistSearchTerm = Readonly<{
  /** Lowercase prefix; email and wallet identifiers both match through it. */
  lowercase: string;
  lowercaseUpperBound: string;
}>;

export function normalizeBetaAllowlistSearchTerm(
  search: string | null,
): BetaAllowlistSearchTerm | null {
  if (search === null) return null;
  const trimmed = search.trim();
  if (trimmed.length === 0) return null;
  if (
    trimmed.length > PRODUCT_USER_MAX_TEXT_LENGTH ||
    CONTROL_CHARACTERS.test(trimmed)
  ) {
    refuseBetaAllowlist("BETA_ALLOWLIST_SEARCH_INVALID");
  }
  const lowercase = trimmed.toLowerCase();
  return {
    lowercase,
    lowercaseUpperBound: `${lowercase}${SEARCH_PREFIX_UPPER_BOUND_SUFFIX}`,
  };
}

export function requireBetaAllowlistPageSize(numItems: number): number {
  if (
    !Number.isInteger(numItems) ||
    numItems < 1 ||
    numItems > BETA_ALLOWLIST_MAX_PAGE_SIZE
  ) {
    refuseBetaAllowlist("BETA_ALLOWLIST_PAGE_SIZE_INVALID");
  }
  return numItems;
}

export function isBetaAllowlistSearchCursor(cursor: string): boolean {
  return SEARCH_CURSOR.test(cursor);
}

export function formatBetaAllowlistSearchCursor(offset: number): string {
  return `offset:${offset}`;
}

export function parseBetaAllowlistSearchCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const match = SEARCH_CURSOR.exec(cursor);
  if (match === null) refuseBetaAllowlist("BETA_ALLOWLIST_PAGE_CURSOR_INVALID");
  return Number(match[1]);
}

export type BetaAllowlistRecencyKey = Readonly<{
  updatedAt: string;
  _creationTime: number;
  _id: string;
}>;

/**
 * Mirrors the `by_updated_at` index read in descending order: most recently
 * updated first, then newest document, then document ID, so merged search
 * results and paginated browse results agree on ordering. An entry that was
 * never edited sits by its creation time, because `updatedAt` starts equal
 * to `createdAt`.
 */
export function compareBetaAllowlistRecency(
  left: BetaAllowlistRecencyKey,
  right: BetaAllowlistRecencyKey,
): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt < right.updatedAt ? 1 : -1;
  }
  if (left._creationTime !== right._creationTime) {
    return left._creationTime < right._creationTime ? 1 : -1;
  }
  if (left._id === right._id) return 0;
  return left._id < right._id ? 1 : -1;
}
