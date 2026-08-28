import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import {
  betaAllowlistApprovedDecision,
  betaAllowlistEntryValidator,
  compareBetaAllowlistRecency,
  findBetaAllowlistEntryByEmail,
  findBetaAllowlistEntryByWalletAddressKey,
  formatBetaAllowlistSearchCursor,
  isBetaAllowlistSearchCursor,
  normalizeBetaAllowlistSearchTerm,
  parseBetaAllowlistSearchCursor,
  refuseBetaAllowlist,
  requireBetaAllowlistEmail,
  requireBetaAllowlistLabel,
  requireBetaAllowlistOperator,
  requireBetaAllowlistPageSize,
  requireBetaAllowlistWalletAddress,
  toBetaAllowlistEntry,
  type BetaAllowlistEntry,
  type BetaAllowlistIdentifiers,
} from "./betaAllowlistRecords";
import {
  productUserAccessDecisionOf,
  productUserTimestamp,
  productUserWalletAddressKey,
} from "./productUserRecords";

/**
 * The privileged beta-allowlist surface for the admin integration.
 *
 * These are internal functions: they are not part of the app's public API and
 * are unreachable from browsers, product clients, and any other authenticated
 * product caller. The only external entry point is the admin-integration HTTP
 * surface in `http.ts`, which authenticates its caller server-side with the
 * same deployment secret as the product-user directory reads before running
 * any of them. Platform operators are not admitted by virtue of managing this
 * list — an operator who wants to use the product adds their own identifier
 * like anyone else, because operator identities and product identities are
 * separate systems.
 *
 * Two semantics are deliberate and load-bearing:
 *
 * - Creating or editing an entry admits matching identities that are already
 *   waiting, so an operator who adds an address never leaves that person
 *   stuck on the waiting screen. The operation reports how many accounts it
 *   admitted, and it never overturns an operator's explicit decline.
 * - Removing an entry stops future automatic admission and nothing else.
 *   Nobody already admitted is thrown out; revoking a specific person's
 *   access is an explicit, audited operator action (closed-beta-access/003),
 *   not a side effect of tidying the list.
 */

/**
 * Per-identifier bound on the retroactive-admission scan. An identifier
 * realistically maps to a handful of directory records at most; the bound
 * keeps one entry write inside one transaction no matter what. Re-running the
 * update converges on full admission in the pathological case.
 */
const ADMISSION_SCAN_LIMIT = 100;

/**
 * Per-attribute prefix-scan bound for identifier search, mirroring the
 * directory's bounded-scan pattern so a search never reads the whole table.
 */
const SEARCH_SCAN_LIMIT = 100;

const betaAllowlistPageValidator = v.object({
  page: v.array(betaAllowlistEntryValidator),
  isDone: v.boolean(),
  /** Opaque cursor for the next page; null when the listing is exhausted. */
  continueCursor: v.union(v.string(), v.null()),
  /** True when search matches were cut off by the per-attribute scan bound. */
  searchTruncated: v.boolean(),
});

/** The identifier target one create or update admits against. */
type BetaAllowlistAdmissionTarget = BetaAllowlistIdentifiers &
  Readonly<{ _id: Id<"betaAllowlistEntries"> }>;

/**
 * Refuses identifiers another entry already claims. Two entries can never
 * cover the same normalized identifier, so a duplicate attempt is a clear
 * rejection — naming which kind of identifier collided — rather than a
 * shadow entry or a silent overwrite. Convex mutations are serializable, so
 * two concurrent creates of the same identifier cannot both pass this check.
 */
async function refuseDuplicateIdentifiers(
  ctx: Pick<MutationCtx, "db">,
  identifiers: BetaAllowlistIdentifiers,
  excludingEntryId: Id<"betaAllowlistEntries"> | null,
): Promise<void> {
  const email = identifiers.email;
  if (email !== null) {
    const existing = await findBetaAllowlistEntryByEmail(ctx, email);
    if (existing !== null && existing._id !== excludingEntryId) {
      refuseBetaAllowlist("BETA_ALLOWLIST_DUPLICATE_EMAIL");
    }
  }
  const walletAddressKey = identifiers.walletAddressKey;
  if (walletAddressKey !== null) {
    const existing = await findBetaAllowlistEntryByWalletAddressKey(
      ctx,
      walletAddressKey,
    );
    if (existing !== null && existing._id !== excludingEntryId) {
      refuseBetaAllowlist("BETA_ALLOWLIST_DUPLICATE_WALLET_ADDRESS");
    }
  }
}

/**
 * Admits every awaiting-review directory record the entry's identifiers
 * match, in the same transaction as the entry write, and reports how many it
 * admitted so the operator gets confirmation.
 *
 * Only awaiting-review records move — including records from before the
 * closed beta existed, which read as awaiting review. An approved account is
 * left exactly as it is (running the admission again admits zero), and a
 * declined account is never overturned: an operator's explicit decline
 * outranks a later list addition, and reversing it is a deliberate operator
 * action in closed-beta-access/003.
 */
async function admitMatchingAwaitingReviewAccounts(
  ctx: MutationCtx,
  target: BetaAllowlistAdmissionTarget,
  admittedAt: string,
): Promise<number> {
  const candidates = new Map<Id<"productUsers">, Doc<"productUsers">>();
  const email = target.email;
  if (email !== null) {
    const byEmail = await ctx.db
      .query("productUsers")
      .withIndex("by_email", (index) => index.eq("email", email))
      .take(ADMISSION_SCAN_LIMIT);
    for (const document of byEmail) candidates.set(document._id, document);
  }
  const walletAddressKey = target.walletAddressKey;
  if (walletAddressKey !== null) {
    const byWalletAddress = await ctx.db
      .query("productUsers")
      .withIndex("by_wallet_address_key", (index) =>
        index.eq("walletAddressKey", walletAddressKey),
      )
      .take(ADMISSION_SCAN_LIMIT);
    for (const document of byWalletAddress) {
      candidates.set(document._id, document);
    }
  }

  let admitted = 0;
  for (const document of candidates.values()) {
    if (productUserAccessDecisionOf(document).state !== "awaiting_review") {
      continue;
    }
    await ctx.db.patch("productUsers", document._id, {
      access: betaAllowlistApprovedDecision(target._id, admittedAt),
    });
    admitted += 1;
  }
  return admitted;
}

/**
 * Resolves an integration-supplied entry reference. A string that is not a
 * well-formed entry id is a caller defect and refuses; a well-formed id whose
 * entry no longer exists is a normal outcome the caller restates.
 */
function requireBetaAllowlistEntryId(
  ctx: Pick<MutationCtx, "db">,
  entryId: string,
): Id<"betaAllowlistEntries"> {
  const normalized = ctx.db.normalizeId("betaAllowlistEntries", entryId);
  if (normalized === null) refuseBetaAllowlist("BETA_ALLOWLIST_ENTRY_INVALID");
  return normalized;
}

/**
 * Creates an allowlist entry and immediately admits matching identities that
 * are already waiting.
 *
 * Identifiers are normalized on the way in — email trimmed and case-folded,
 * wallet address kept verbatim and matched through its lowercase key — and at
 * least one identifier must be present. The entry may name an identity that
 * has never signed in; that person is admitted on first contact by the
 * establishment-path match with no operator involvement.
 */
export const createEntry = internalMutation({
  args: {
    email: v.union(v.string(), v.null()),
    walletAddress: v.union(v.string(), v.null()),
    label: v.union(v.string(), v.null()),
    operatorId: v.string(),
  },
  returns: v.object({
    entry: betaAllowlistEntryValidator,
    admittedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const email = requireBetaAllowlistEmail(args.email);
    const walletAddress = requireBetaAllowlistWalletAddress(args.walletAddress);
    if (email === null && walletAddress === null) {
      refuseBetaAllowlist("BETA_ALLOWLIST_IDENTIFIER_REQUIRED");
    }
    const label = requireBetaAllowlistLabel(args.label);
    const createdByOperatorId = requireBetaAllowlistOperator(args.operatorId);
    const walletAddressKey = productUserWalletAddressKey(walletAddress);
    await refuseDuplicateIdentifiers(ctx, { email, walletAddressKey }, null);

    const now = productUserTimestamp(Date.now());
    const entryId = await ctx.db.insert("betaAllowlistEntries", {
      email,
      walletAddress,
      walletAddressKey,
      label,
      createdAt: now,
      updatedAt: now,
      createdByOperatorId,
    });
    const admittedCount = await admitMatchingAwaitingReviewAccounts(
      ctx,
      { _id: entryId, email, walletAddressKey },
      now,
    );
    const entry: BetaAllowlistEntry = {
      entryId,
      email,
      walletAddress,
      label,
      createdAt: now,
      updatedAt: now,
      createdByOperatorId,
    };
    return { entry, admittedCount };
  },
});

/**
 * Edits an entry in place and admits identities the edited identifiers now
 * match. An omitted field keeps its stored value; an explicit null clears it;
 * at least one identifier must remain. Editing an identifier away stops
 * future automatic admission for it — matching always consults the current
 * entries — and leaves already-approved accounts untouched, because
 * admission never runs in reverse.
 *
 * A call that changes nothing still re-runs the admission scan, so repeating
 * an update is a safe way to converge after the (pathological) case of a
 * bounded scan cutting off matches. An entry that no longer exists returns a
 * null entry rather than refusing, so repeated operator actions converge.
 */
export const updateEntry = internalMutation({
  args: {
    entryId: v.string(),
    email: v.optional(v.union(v.string(), v.null())),
    walletAddress: v.optional(v.union(v.string(), v.null())),
    label: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    entry: v.union(betaAllowlistEntryValidator, v.null()),
    admittedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const entryId = requireBetaAllowlistEntryId(ctx, args.entryId);
    const existing = await ctx.db.get("betaAllowlistEntries", entryId);
    if (existing === null) return { entry: null, admittedCount: 0 };

    const email =
      args.email === undefined
        ? existing.email
        : requireBetaAllowlistEmail(args.email);
    const walletAddress =
      args.walletAddress === undefined
        ? existing.walletAddress
        : requireBetaAllowlistWalletAddress(args.walletAddress);
    if (email === null && walletAddress === null) {
      refuseBetaAllowlist("BETA_ALLOWLIST_IDENTIFIER_REQUIRED");
    }
    const label =
      args.label === undefined
        ? existing.label
        : requireBetaAllowlistLabel(args.label);
    const walletAddressKey = productUserWalletAddressKey(walletAddress);
    await refuseDuplicateIdentifiers(ctx, { email, walletAddressKey }, entryId);

    const changed =
      email !== existing.email ||
      walletAddress !== existing.walletAddress ||
      label !== existing.label;
    const now = productUserTimestamp(Date.now());
    const updatedAt = changed ? now : existing.updatedAt;
    if (changed) {
      await ctx.db.patch("betaAllowlistEntries", entryId, {
        email,
        walletAddress,
        walletAddressKey,
        label,
        updatedAt,
      });
    }
    const admittedCount = await admitMatchingAwaitingReviewAccounts(
      ctx,
      { _id: entryId, email, walletAddressKey },
      now,
    );
    const entry: BetaAllowlistEntry = {
      entryId,
      email,
      walletAddress,
      label,
      createdAt: existing.createdAt,
      updatedAt,
      createdByOperatorId: existing.createdByOperatorId,
    };
    return { entry, admittedCount };
  },
});

/**
 * Removes an entry, which stops future automatic admission for its
 * identifiers and changes nothing else: no existing access decision moves,
 * and accounts the entry admitted stay admitted with their provenance
 * intact. Removing an already-removed entry converges on `removed: false`
 * rather than failing, so repeated operator actions are safe.
 */
export const removeEntry = internalMutation({
  args: { entryId: v.string() },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    const entryId = requireBetaAllowlistEntryId(ctx, args.entryId);
    const existing = await ctx.db.get("betaAllowlistEntries", entryId);
    if (existing === null) return { removed: false };
    await ctx.db.delete("betaAllowlistEntries", entryId);
    return { removed: true };
  },
});

/**
 * One bounded page of the allowlist, most recently updated first.
 *
 * Browsing pages through the recency index with Convex cursors. Searching
 * matches identifier prefixes case-insensitively — email directly, wallet
 * address through its lowercase key — by merging bounded prefix scans and
 * paging them with an opaque offset cursor; both modes return cursors the
 * caller passes back unchanged.
 */
export const listEntriesPage = internalQuery({
  args: {
    search: v.union(v.string(), v.null()),
    paginationOpts: paginationOptsValidator,
  },
  returns: betaAllowlistPageValidator,
  handler: async (ctx, args) => {
    const pageSize = requireBetaAllowlistPageSize(args.paginationOpts.numItems);
    const cursor = args.paginationOpts.cursor;
    const term = normalizeBetaAllowlistSearchTerm(args.search);

    if (term === null) {
      if (cursor !== null && isBetaAllowlistSearchCursor(cursor)) {
        refuseBetaAllowlist("BETA_ALLOWLIST_PAGE_CURSOR_INVALID");
      }
      const result = await ctx.db
        .query("betaAllowlistEntries")
        .withIndex("by_updated_at")
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        page: result.page.map(toBetaAllowlistEntry),
        isDone: result.isDone,
        continueCursor: result.isDone ? null : result.continueCursor,
        searchTruncated: false,
      };
    }

    const offset = parseBetaAllowlistSearchCursor(cursor);
    const [byEmail, byWalletAddress] = await Promise.all([
      ctx.db
        .query("betaAllowlistEntries")
        .withIndex("by_email", (index) =>
          index
            .gte("email", term.lowercase)
            .lte("email", term.lowercaseUpperBound),
        )
        .take(SEARCH_SCAN_LIMIT),
      ctx.db
        .query("betaAllowlistEntries")
        .withIndex("by_wallet_address_key", (index) =>
          index
            .gte("walletAddressKey", term.lowercase)
            .lte("walletAddressKey", term.lowercaseUpperBound),
        )
        .take(SEARCH_SCAN_LIMIT),
    ]);
    const matches = new Map<string, Doc<"betaAllowlistEntries">>();
    for (const document of [...byEmail, ...byWalletAddress]) {
      matches.set(document._id, document);
    }
    const ordered = [...matches.values()].sort(compareBetaAllowlistRecency);
    const documents = ordered.slice(offset, offset + pageSize);
    const nextOffset = offset + documents.length;
    const isDone = nextOffset >= ordered.length;
    return {
      page: documents.map(toBetaAllowlistEntry),
      isDone,
      continueCursor: isDone
        ? null
        : formatBetaAllowlistSearchCursor(nextOffset),
      searchTruncated: [byEmail, byWalletAddress].some(
        (scan) => scan.length === SEARCH_SCAN_LIMIT,
      ),
    };
  },
});
