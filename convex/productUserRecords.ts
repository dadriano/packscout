import type { UserIdentity } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";

/**
 * Shared shape and normalization rules for the durable product-user directory.
 *
 * A directory record is keyed on `subject`, which stores the Convex-verified
 * `ctx.auth.getUserIdentity().tokenIdentifier`. That is exactly the owner key
 * already stamped on `savedRepacks.ownerTokenIdentifier` and
 * `savedCollectibles.ownerTokenIdentifier`, so directory rows and saved items
 * join on a server-derived identity and never on a client-supplied one.
 */

export const PRODUCT_USER_MAX_SUBJECT_LENGTH = 1_024;
export const PRODUCT_USER_MAX_TEXT_LENGTH = 320;
export const PRODUCT_USER_MAX_WALLET_ADDRESS_LENGTH = 128;
export const PRODUCT_USER_MAX_AUTH_METHOD_LENGTH = 128;
export const PRODUCT_USER_UNKNOWN_AUTH_METHOD = "unknown";
export const PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE = 20;

/**
 * The verified custom claim that carries a wallet address when the hosted auth
 * provider exposes one. Absence is normal: the provider's access token often
 * carries only the subject and issuer.
 */
export const PRODUCT_USER_WALLET_ADDRESS_CLAIM = "wallet_address";

/**
 * A string that sorts after every realistic continuation of a search prefix,
 * used as the inclusive upper bound of an index prefix range.
 */
const SEARCH_PREFIX_UPPER_BOUND_SUFFIX = "\u{10FFFF}";

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const WHITESPACE = /\s/u;
const SEARCH_CURSOR = /^offset:(\d{1,6})$/u;

export type ProductUserErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_IDENTITY_INVALID"
  | "PRODUCT_USER_STATE_CONFLICT"
  | "PRODUCT_USER_SEARCH_INVALID"
  | "PRODUCT_USER_PAGE_SIZE_INVALID"
  | "PRODUCT_USER_PAGE_CURSOR_INVALID"
  | "PRODUCT_USER_SUBJECT_INVALID";

export function refuseProductUser(code: ProductUserErrorCode): never {
  const message =
    code === "AUTH_REQUIRED"
      ? "Authentication is required for product-user records."
      : code === "AUTH_IDENTITY_INVALID"
        ? "The authenticated identity is not valid for product-user records."
        : code === "PRODUCT_USER_STATE_CONFLICT"
          ? "The product-user directory state is inconsistent."
          : code === "PRODUCT_USER_SEARCH_INVALID"
            ? "The product-user directory search term is invalid."
            : code === "PRODUCT_USER_PAGE_SIZE_INVALID"
              ? "The requested product-user page size is out of bounds."
              : code === "PRODUCT_USER_PAGE_CURSOR_INVALID"
                ? "The product-user page cursor is invalid."
                : "The requested product-user subject is invalid.";
  throw new ConvexError({ code, message });
}

export const productUserStandingValidator = v.union(
  v.literal("active"),
  v.literal("suspended"),
);

export const productUserDocumentValidator = v.object({
  subject: v.string(),
  authMethod: v.string(),
  email: v.union(v.string(), v.null()),
  walletAddress: v.union(v.string(), v.null()),
  /** Lowercased wallet address; search key only, never part of a response. */
  walletAddressKey: v.union(v.string(), v.null()),
  firstSeenAt: v.string(),
  lastSeenAt: v.string(),
  standing: productUserStandingValidator,
});

export const productUserRecordValidator =
  productUserDocumentValidator.omit("walletAddressKey");

export const productUserDirectoryRowValidator =
  productUserRecordValidator.extend({
    savedRepackCount: v.number(),
    savedCollectibleCount: v.number(),
  });

export type ProductUserStanding = Infer<typeof productUserStandingValidator>;
export type ProductUserDocument = Infer<typeof productUserDocumentValidator>;
export type ProductUserRecord = Infer<typeof productUserRecordValidator>;
export type ProductUserDirectoryRow = Infer<
  typeof productUserDirectoryRowValidator
>;

export type ProductUserIdentityAttributes = Readonly<{
  subject: string;
  authMethod: string;
  email: string | null;
  walletAddress: string | null;
  walletAddressKey: string | null;
}>;

function boundedText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximumLength) return null;
  return CONTROL_CHARACTERS.test(trimmed) ? null : trimmed;
}

export function normalizeProductUserEmail(value: unknown): string | null {
  const text = boundedText(value, PRODUCT_USER_MAX_TEXT_LENGTH);
  if (text === null || WHITESPACE.test(text) || !text.includes("@")) {
    return null;
  }
  // Directory search treats email as case-insensitive, so the stored value is
  // the normalized lowercase form rather than the provider's original casing.
  return text.toLowerCase();
}

export function normalizeProductUserWalletAddress(
  value: unknown,
): string | null {
  const text = boundedText(value, PRODUCT_USER_MAX_WALLET_ADDRESS_LENGTH);
  // Wallet address casing is meaningful (EVM checksums, case-sensitive base58
  // encodings), so the verbatim value is stored and a separate lowercase key
  // carries case-insensitive search.
  return text === null || WHITESPACE.test(text) ? null : text;
}

export function productUserWalletAddressKey(
  walletAddress: string | null,
): string | null {
  return walletAddress === null ? null : walletAddress.toLowerCase();
}

/**
 * The sign-in source descriptor. PackScout trusts a hosted third-party token,
 * whose verified issuer is the only sign-in source the product backend can
 * state as fact; a record is still written when it is missing.
 */
export function normalizeProductUserAuthMethod(value: unknown): string {
  const text = boundedText(value, PRODUCT_USER_MAX_AUTH_METHOD_LENGTH);
  return text === null || WHITESPACE.test(text)
    ? PRODUCT_USER_UNKNOWN_AUTH_METHOD
    : text.toLowerCase();
}

export function requireProductUserSubject(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PRODUCT_USER_MAX_SUBJECT_LENGTH
  ) {
    refuseProductUser("AUTH_IDENTITY_INVALID");
  }
  return value;
}

/**
 * Derives every stored attribute from the Convex-verified identity. No caller
 * argument contributes to identity, ownership, or standing.
 */
export function deriveProductUserAttributes(
  identity: UserIdentity,
): ProductUserIdentityAttributes {
  const subject = requireProductUserSubject(identity.tokenIdentifier);
  const walletAddress = normalizeProductUserWalletAddress(
    identity[PRODUCT_USER_WALLET_ADDRESS_CLAIM],
  );
  return {
    subject,
    authMethod: normalizeProductUserAuthMethod(identity.issuer),
    email: normalizeProductUserEmail(identity.email),
    walletAddress,
    walletAddressKey: productUserWalletAddressKey(walletAddress),
  };
}

export function toProductUserRecord(
  document: ProductUserDocument,
): ProductUserRecord {
  return {
    subject: document.subject,
    authMethod: document.authMethod,
    email: document.email,
    walletAddress: document.walletAddress,
    firstSeenAt: document.firstSeenAt,
    lastSeenAt: document.lastSeenAt,
    standing: document.standing,
  };
}

export function productUserTimestamp(epochMilliseconds: number): string {
  if (
    !Number.isFinite(epochMilliseconds) ||
    Math.abs(epochMilliseconds) > 8.64e15
  ) {
    refuseProductUser("PRODUCT_USER_STATE_CONFLICT");
  }
  return new Date(epochMilliseconds).toISOString();
}

export function productUserTimestampMilliseconds(
  timestamp: string,
): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

export type ProductUserSearchTerm = Readonly<{
  /** Verbatim prefix, used for the case-sensitive subject key. */
  verbatim: string;
  /** Lowercase prefix, used for email and wallet-address search keys. */
  lowercase: string;
  verbatimUpperBound: string;
  lowercaseUpperBound: string;
}>;

export function normalizeProductUserSearchTerm(
  search: string | null,
): ProductUserSearchTerm | null {
  if (search === null) return null;
  const trimmed = search.trim();
  if (trimmed.length === 0) return null;
  if (
    trimmed.length > PRODUCT_USER_MAX_TEXT_LENGTH ||
    CONTROL_CHARACTERS.test(trimmed)
  ) {
    refuseProductUser("PRODUCT_USER_SEARCH_INVALID");
  }
  const lowercase = trimmed.toLowerCase();
  return {
    verbatim: trimmed,
    lowercase,
    verbatimUpperBound: `${trimmed}${SEARCH_PREFIX_UPPER_BOUND_SUFFIX}`,
    lowercaseUpperBound: `${lowercase}${SEARCH_PREFIX_UPPER_BOUND_SUFFIX}`,
  };
}

export function requireProductUserPageSize(numItems: number): number {
  if (
    !Number.isInteger(numItems) ||
    numItems < 1 ||
    numItems > PRODUCT_USER_DIRECTORY_MAX_PAGE_SIZE
  ) {
    refuseProductUser("PRODUCT_USER_PAGE_SIZE_INVALID");
  }
  return numItems;
}

export function isProductUserSearchCursor(cursor: string): boolean {
  return SEARCH_CURSOR.test(cursor);
}

export function formatProductUserSearchCursor(offset: number): string {
  return `offset:${offset}`;
}

export function parseProductUserSearchCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const match = SEARCH_CURSOR.exec(cursor);
  if (match === null) refuseProductUser("PRODUCT_USER_PAGE_CURSOR_INVALID");
  return Number(match[1]);
}

export type ProductUserRecencyKey = Readonly<{
  lastSeenAt: string;
  _creationTime: number;
  _id: string;
}>;

/**
 * Mirrors the `by_last_seen_at` index read in descending order: most recently
 * seen first, then newest document, then document ID, so merged search results
 * and paginated browse results agree on ordering.
 */
export function compareProductUserRecency(
  left: ProductUserRecencyKey,
  right: ProductUserRecencyKey,
): number {
  if (left.lastSeenAt !== right.lastSeenAt) {
    return left.lastSeenAt < right.lastSeenAt ? 1 : -1;
  }
  if (left._creationTime !== right._creationTime) {
    return left._creationTime < right._creationTime ? 1 : -1;
  }
  if (left._id === right._id) return 0;
  return left._id < right._id ? 1 : -1;
}
