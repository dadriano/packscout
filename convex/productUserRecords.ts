import { PRODUCT_USER_SUSPENDED_ERROR_CODE } from "@packscout/contracts";
import type { UserIdentity } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

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
export const PRODUCT_USER_MAX_OPERATOR_LENGTH = 128;
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
  | typeof PRODUCT_USER_SUSPENDED_ERROR_CODE
  | "PRODUCT_USER_STATE_CONFLICT"
  | "PRODUCT_USER_SEARCH_INVALID"
  | "PRODUCT_USER_PAGE_SIZE_INVALID"
  | "PRODUCT_USER_PAGE_CURSOR_INVALID"
  | "PRODUCT_USER_SUBJECT_INVALID"
  | "PRODUCT_USER_OPERATOR_INVALID"
  | "PRODUCT_USER_WELCOME_REQUEST_INVALID";

/**
 * `ACCOUNT_SUSPENDED` is the stable, distinguishable outcome every
 * authenticated write path raises for a suspended account. The message states
 * the standing and nothing else: no operator, no reason, no internals.
 */
const PRODUCT_USER_MESSAGES: Readonly<Record<ProductUserErrorCode, string>> =
  Object.freeze({
    AUTH_REQUIRED: "Authentication is required for product-user records.",
    AUTH_IDENTITY_INVALID:
      "The authenticated identity is not valid for product-user records.",
    [PRODUCT_USER_SUSPENDED_ERROR_CODE]: "This account is suspended.",
    PRODUCT_USER_STATE_CONFLICT:
      "The product-user directory state is inconsistent.",
    PRODUCT_USER_SEARCH_INVALID:
      "The product-user directory search term is invalid.",
    PRODUCT_USER_PAGE_SIZE_INVALID:
      "The requested product-user page size is out of bounds.",
    PRODUCT_USER_PAGE_CURSOR_INVALID: "The product-user page cursor is invalid.",
    PRODUCT_USER_SUBJECT_INVALID:
      "The requested product-user subject is invalid.",
    PRODUCT_USER_OPERATOR_INVALID:
      "The product-user operator reference is invalid.",
    PRODUCT_USER_WELCOME_REQUEST_INVALID:
      "The product-user welcome request is out of bounds.",
  });

export function refuseProductUser(code: ProductUserErrorCode): never {
  throw new ConvexError({ code, message: PRODUCT_USER_MESSAGES[code] });
}

export const productUserStandingValidator = v.union(
  v.literal("active"),
  v.literal("suspended"),
);

/**
 * The closed-beta admission decision, a dimension deliberately separate from
 * standing because the two answer different questions. Standing asks "was this
 * known account disciplined?", so a missing record reads as `active`.
 * Admission asks "was this account let in?", so a missing record — or a record
 * written before the closed beta existed — reads as `awaiting_review`. Both
 * fail closed for their own question; they must never be collapsed.
 */
export const productUserAccessStateValidator = v.union(
  v.literal("awaiting_review"),
  v.literal("approved"),
  v.literal("declined"),
);

const productUserAccessDecisionFields = {
  state: productUserAccessStateValidator,
  /** When the decision was established, ISO-8601 like the seen timestamps. */
  decidedAt: v.string(),
};

/**
 * A decision plus its provenance: what produced it, when, and a reference to
 * the matched allowlist entry or the acting operator. Provenance is data other
 * tasks display and audit — closed-beta-access/002 writes `allowlist`
 * decisions, closed-beta-access/003 writes `operator` ones — never free text.
 */
export const productUserAccessDecisionValidator = v.union(
  v.object({
    ...productUserAccessDecisionFields,
    decidedBy: v.literal("default"),
  }),
  v.object({
    ...productUserAccessDecisionFields,
    decidedBy: v.literal("allowlist"),
    /** Stable id of the matched beta-allowlist entry. */
    allowlistEntryId: v.string(),
  }),
  v.object({
    ...productUserAccessDecisionFields,
    decidedBy: v.literal("operator"),
    /** The acting operator's admin-side identifier. */
    operatorId: v.string(),
  }),
);

/**
 * The one composed admission answer every consumer reads. `admitted` is true
 * only when access is approved and standing is not suspended; the reason is
 * actionable and pairs with the verdict at the type level, so `undetermined`
 * (or any other non-approved reason) can never be reported as admitted.
 */
export const productUserEffectiveAccessValidator = v.union(
  v.object({
    admitted: v.literal(true),
    reason: v.literal("approved"),
  }),
  v.object({
    admitted: v.literal(false),
    reason: v.union(
      v.literal("awaiting_review"),
      v.literal("declined"),
      v.literal("suspended"),
      v.literal("undetermined"),
    ),
  }),
);

/**
 * The durable once-ever welcome marker (messaging/007).
 *
 * Absence means "not yet due": the identity has not had its first admitted
 * session since this machinery began observing, so there is nothing to send
 * yet. Every present state is permanent forward progress:
 *
 * - `due`: the first admitted session happened; a welcome should be sent.
 * - `claimed`: a dispatcher pass claimed this identity. The claim expires at
 *   `claimExpiresAt`, so a dispatcher that crashes between claiming and
 *   durably enqueueing surrenders the identity back to discovery instead of
 *   stranding it claimed-but-never-sent.
 * - `sent`: the welcome was durably enqueued with the delivery layer. Never
 *   revisited — this is what makes "once, ever" survive restarts, retries,
 *   duplicate discovery, and re-admission after revocation.
 * - `not_applicable`: recorded as a normal skip, never retried. Either the
 *   identity had no verified email address at its first admitted session, or
 *   it was grandfathered: already admitted before this machinery existed, so
 *   welcoming it now would be retroactive.
 *
 * The marker is written only by the establishment path (arming) and the
 * dispatcher operations in `productUserWelcome.ts` (claim and settle).
 * Access decisions — operator approve/decline/revoke, allowlist admission —
 * never touch it, which is exactly why an admitted-revoked-readmitted
 * identity is never welcomed twice: its marker survives every decision flip.
 */
export const productUserWelcomeMarkerValidator = v.union(
  v.object({
    state: v.literal("due"),
    /** When the first admitted session armed the marker; ISO-8601. */
    dueAt: v.string(),
  }),
  v.object({
    state: v.literal("claimed"),
    dueAt: v.string(),
    claimedAt: v.string(),
    /** After this instant the claim lapses and discovery may reclaim. */
    claimExpiresAt: v.string(),
  }),
  v.object({
    state: v.literal("sent"),
    dueAt: v.string(),
    /** When the dispatcher confirmed the durable enqueue, not delivery. */
    sentAt: v.string(),
  }),
  v.object({
    state: v.literal("not_applicable"),
    reason: v.union(
      v.literal("no_verified_email"),
      v.literal("grandfathered"),
    ),
    recordedAt: v.string(),
  }),
);

export type ProductUserWelcomeMarker = Infer<
  typeof productUserWelcomeMarkerValidator
>;

function timestampIsStrictlyAfter(left: string, right: string): boolean {
  const leftMilliseconds = productUserTimestampMilliseconds(left);
  const rightMilliseconds = productUserTimestampMilliseconds(right);
  if (leftMilliseconds === null || rightMilliseconds === null) return false;
  return leftMilliseconds > rightMilliseconds;
}

/**
 * The welcome arming rule, evaluated inside the establishment write path and
 * nowhere else (messaging/007). Stated precisely:
 *
 * A record with no welcome marker gains one only at an establishment contact
 * whose composed decision-plus-standing answer is admitted (approved and not
 * suspended, independent of the `PACKSCOUT_CLOSED_BETA` switch, matching how
 * the allowlist and operator decisions are switch-independent), and only in
 * one of these ways:
 *
 * 1. The identity became admitted during THIS establishment — a new record
 *    inserted with an allowlist approval, or an existing awaiting identity
 *    the allowlist approved on this very contact. This session is its first
 *    admitted session: arm.
 * 2. The identity arrived already approved and the approval's `decidedAt` is
 *    strictly after the record's previous `lastSeenAt` — the decision landed
 *    between contacts (operator approval, retroactive allowlist admission),
 *    so no session has happened while admitted. This session is its first
 *    admitted session: arm.
 * 3. The identity arrived already approved with `decidedAt` at or before the
 *    previous `lastSeenAt` — it has already had a contact while approved, so
 *    its first admitted session predates this machinery's observation.
 *    Welcoming it now would be retroactive: the marker is set to
 *    `not_applicable` with reason `grandfathered`, decided once and never
 *    revisited.
 *
 * "Arm" resolves against the verified email known at this establishment:
 * `due` when an address exists, `not_applicable`/`no_verified_email` when
 * none does — recorded as a normal skip and never retried, even if a later
 * sign-in exposes an address.
 *
 * Deliberate consequences, chosen to fail toward silence rather than toward
 * a duplicate or retroactive welcome:
 *
 * - An identity approved before this shipped that never returned after its
 *   approval (`decidedAt` after its last pre-rollout contact) is armed on
 *   its next contact: it is newly reaching its first admitted session.
 * - An identity whose only contacts after approval happened while suspended
 *   reads as grandfathered once reinstated, because contact recency is the
 *   only durable trace of past sessions and standing history is not stored.
 *   It is never welcomed; it is also never welcomed twice or retroactively.
 * - A decision flip never arms, un-arms, or rewrites a marker; only the sent
 *   and not_applicable states are terminal, and both are permanent.
 *
 * Returns the marker to write, or undefined when nothing must change. The
 * caller must include a returned marker in its patch even when no other
 * field changed.
 */
export function welcomeMarkerAtEstablishment(input: {
  /** The stored marker; any present marker is final for this rule. */
  existingMarker: ProductUserWelcomeMarker | undefined;
  /** The decision as it stands after this establishment's own resolution. */
  decision: ProductUserAccessDecision;
  standing: ProductUserStanding;
  /** True when this establishment itself moved the identity to approved. */
  admittedByThisEstablishment: boolean;
  /** The record's lastSeenAt before this contact; null for a new record. */
  previousLastSeenAt: string | null;
  /** The verified email known at this establishment, post-merge. */
  email: string | null;
  observedAt: string;
}): ProductUserWelcomeMarker | undefined {
  if (input.existingMarker !== undefined) return undefined;
  if (input.decision.state !== "approved" || input.standing === "suspended") {
    return undefined;
  }
  const firstAdmittedSession =
    input.admittedByThisEstablishment ||
    input.previousLastSeenAt === null ||
    timestampIsStrictlyAfter(
      input.decision.decidedAt,
      input.previousLastSeenAt,
    );
  if (!firstAdmittedSession) {
    return {
      state: "not_applicable",
      reason: "grandfathered",
      recordedAt: input.observedAt,
    };
  }
  if (input.email === null) {
    return {
      state: "not_applicable",
      reason: "no_verified_email",
      recordedAt: input.observedAt,
    };
  }
  return { state: "due", dueAt: input.observedAt };
}

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
  /**
   * Optional because records written before the closed beta existed lack it;
   * absence reads as awaiting review with default provenance, and the next
   * authenticated contact materializes exactly that decision.
   */
  access: v.optional(productUserAccessDecisionValidator),
  /**
   * The once-ever welcome marker (messaging/007). Optional because absence
   * is the meaningful default: not yet due. Deliberately absent from
   * `productUserRecordValidator` — it is dispatcher bookkeeping, not a
   * directory fact any existing consumer displays.
   */
  welcome: v.optional(productUserWelcomeMarkerValidator),
});

export const productUserRecordValidator = productUserDocumentValidator
  .omit("walletAddressKey")
  .omit("access")
  .omit("welcome")
  .extend({
    /**
     * The authoritative admission decision, always present on a returned
     * record: the stored decision when the record carries one, otherwise the
     * default derived exactly as reads derive it for records that predate
     * the closed beta (closed-beta-access/003 exposes it to operators).
     */
    access: productUserAccessDecisionValidator,
  });

export const productUserDirectoryRowValidator =
  productUserRecordValidator.extend({
    savedRepackCount: v.number(),
    savedCollectibleCount: v.number(),
  });

export type ProductUserStanding = Infer<typeof productUserStandingValidator>;
export type ProductUserAccessState = Infer<
  typeof productUserAccessStateValidator
>;
export type ProductUserAccessDecision = Infer<
  typeof productUserAccessDecisionValidator
>;
export type ProductUserEffectiveAccess = Infer<
  typeof productUserEffectiveAccessValidator
>;
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

/**
 * Bounds a subject supplied by the trusted admin integration. The value is an
 * addressing argument, never an authorization claim: product callers cannot
 * reach the functions that accept it, and product-side ownership still comes
 * from the Convex-verified identity.
 */
export function requireProductUserSubjectArgument(subject: string): string {
  if (
    subject.length === 0 ||
    subject.length > PRODUCT_USER_MAX_SUBJECT_LENGTH
  ) {
    refuseProductUser("PRODUCT_USER_SUBJECT_INVALID");
  }
  return subject;
}

/**
 * Bounds the acting operator's admin-side reference on a decision operation.
 * Like the allowlist's creating-operator field, it is a bounded opaque string
 * rather than a foreign key because operator identities live in the admin's
 * own store. It is provenance supplied by the trusted integration, never an
 * authorization claim.
 */
export function requireProductUserOperatorArgument(operatorId: string): string {
  const trimmed = operatorId.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > PRODUCT_USER_MAX_OPERATOR_LENGTH ||
    CONTROL_CHARACTERS.test(trimmed)
  ) {
    refuseProductUser("PRODUCT_USER_OPERATOR_INVALID");
  }
  return trimmed;
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
    access: productUserAccessDecisionOf(document),
  };
}

/**
 * The one directory record for a subject, or null when that identity has never
 * been recorded. Two records for one subject is an impossible state, so it
 * refuses rather than picking a winner.
 */
export async function findProductUserBySubject(
  ctx: Pick<QueryCtx, "db">,
  subject: string,
): Promise<Doc<"productUsers"> | null> {
  const matches = await ctx.db
    .query("productUsers")
    .withIndex("by_subject", (index) => index.eq("subject", subject))
    .take(2);
  if (matches.length > 1) refuseProductUser("PRODUCT_USER_STATE_CONFLICT");
  return matches[0] ?? null;
}

/**
 * The authoritative standing for a subject, read from the database.
 *
 * An identity with no directory record reads as `active`. That is the intended
 * meaning of fail-closed here: the check trusts the stored record over the
 * session, not the other way round. A missing record is an unrecorded sign-up
 * — a user who predates the directory, or a best-effort record write that has
 * not landed — and never a suspension.
 */
export async function readProductUserStanding(
  ctx: Pick<QueryCtx, "db">,
  subject: string,
): Promise<ProductUserStanding> {
  const existing = await findProductUserBySubject(ctx, subject);
  return existing?.standing ?? "active";
}

/**
 * The standing gate for authenticated write paths. It is deliberately a
 * database read inside the caller's own transaction, so standing is evaluated
 * at request time: a session established before a suspension gains nothing,
 * and a reinstatement takes effect on the very next request.
 *
 * This is the default for every future authenticated capability, not a
 * saved-item special case.
 */
export async function requireActiveProductUserStanding(
  ctx: Pick<QueryCtx, "db">,
  subject: string,
): Promise<void> {
  if ((await readProductUserStanding(ctx, subject)) === "suspended") {
    refuseProductUser(PRODUCT_USER_SUSPENDED_ERROR_CODE);
  }
}

/**
 * The decision a record holds before any explicit one is written: awaiting
 * review, decided by default when the record was first established. New
 * records store it at insert; legacy records read as it until their next
 * authenticated contact materializes it.
 */
export function defaultProductUserAccessDecision(
  decidedAt: string,
): ProductUserAccessDecision {
  return { state: "awaiting_review", decidedBy: "default", decidedAt };
}

/**
 * The stored admission decision, or the default one derived for records
 * written before the closed beta existed. The derived decision is dated at
 * `firstSeenAt` — the identity has been awaiting review since it first showed
 * up — so a later materialization stores exactly what reads already reported.
 */
export function productUserAccessDecisionOf(
  document: Pick<ProductUserDocument, "access" | "firstSeenAt">,
): ProductUserAccessDecision {
  return (
    document.access ?? defaultProductUserAccessDecision(document.firstSeenAt)
  );
}

/**
 * Composes admission and standing into the one answer consumers act on, for
 * a deployment where the closed beta is on (the off position short-circuits
 * to admitted before composition and never reaches this rule).
 *
 * - No record: awaiting review — absence means "not yet let in", never entry.
 * - Access not approved: that state is the reason; an unadmitted identity's
 *   suspension is not the operative fact until it would otherwise be in.
 * - Approved but suspended: suspended, so discipline still bites.
 * - Approved and active: admitted.
 */
export function composeProductUserEffectiveAccess(
  document: Pick<
    ProductUserDocument,
    "access" | "firstSeenAt" | "standing"
  > | null,
): ProductUserEffectiveAccess {
  if (document === null) {
    return { admitted: false, reason: "awaiting_review" };
  }
  const state = productUserAccessDecisionOf(document).state;
  if (state !== "approved") {
    return { admitted: false, reason: state };
  }
  if (document.standing === "suspended") {
    return { admitted: false, reason: "suspended" };
  }
  return { admitted: true, reason: "approved" };
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
