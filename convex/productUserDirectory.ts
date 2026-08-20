import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import {
  compareProductUserRecency,
  formatProductUserSearchCursor,
  isProductUserSearchCursor,
  normalizeProductUserSearchTerm,
  parseProductUserSearchCursor,
  productUserDirectoryRowValidator,
  productUserRecordValidator,
  PRODUCT_USER_MAX_SUBJECT_LENGTH,
  refuseProductUser,
  requireProductUserPageSize,
  toProductUserRecord,
  type ProductUserDirectoryRow,
  type ProductUserSearchTerm,
} from "./productUserRecords";
import { MAX_SAVED_ITEMS_PER_KIND } from "./savedItems";

/**
 * Privileged product-user directory reads for the admin integration.
 *
 * These are internal functions: they are not part of the app's public API and
 * are unreachable from browsers, product clients, and any other authenticated
 * product caller. The only external entry point is the admin-integration HTTP
 * surface in `http.ts`, which authenticates its caller server-side with a
 * deployment secret before running these queries.
 */

/**
 * Per-attribute prefix-scan bound. A search reads at most three scans of this
 * size, so a directory search never scans the whole table.
 */
const SEARCH_SCAN_LIMIT = 100;

const directoryPageValidator = v.object({
  page: v.array(productUserDirectoryRowValidator),
  isDone: v.boolean(),
  /** Opaque cursor for the next page; null when the listing is exhausted. */
  continueCursor: v.union(v.string(), v.null()),
  /** True when search matches were cut off by the per-attribute scan bound. */
  searchTruncated: v.boolean(),
});

/**
 * Saved-item counts for one owner. Counting is bounded by the enforced
 * per-kind saved-item cap, which is also the largest count a product user can
 * legitimately reach.
 */
async function countSavedItems(
  ctx: QueryCtx,
  subject: string,
): Promise<{ savedRepackCount: number; savedCollectibleCount: number }> {
  const [savedRepacks, savedCollectibles] = await Promise.all([
    ctx.db
      .query("savedRepacks")
      .withIndex("by_owner_token_identifier_and_public_repack_id", (index) =>
        index.eq("ownerTokenIdentifier", subject),
      )
      .take(MAX_SAVED_ITEMS_PER_KIND),
    ctx.db
      .query("savedCollectibles")
      .withIndex(
        "by_owner_token_identifier_and_public_collectible_id",
        (index) => index.eq("ownerTokenIdentifier", subject),
      )
      .take(MAX_SAVED_ITEMS_PER_KIND),
  ]);
  return {
    savedRepackCount: savedRepacks.length,
    savedCollectibleCount: savedCollectibles.length,
  };
}

async function toDirectoryRows(
  ctx: QueryCtx,
  documents: readonly Doc<"productUsers">[],
): Promise<ProductUserDirectoryRow[]> {
  return await Promise.all(
    documents.map(async (document) => ({
      ...toProductUserRecord(document),
      ...(await countSavedItems(ctx, document.subject)),
    })),
  );
}

/**
 * Prefix matches across the three searchable identity attributes. Email and
 * wallet address match case-insensitively through their lowercase keys; the
 * subject key is opaque and matches verbatim.
 */
async function findSearchMatches(
  ctx: QueryCtx,
  term: ProductUserSearchTerm,
): Promise<{ matches: Doc<"productUsers">[]; truncated: boolean }> {
  const [byEmail, byWalletAddress, bySubject] = await Promise.all([
    ctx.db
      .query("productUsers")
      .withIndex("by_email", (index) =>
        index.gte("email", term.lowercase).lte("email", term.lowercaseUpperBound),
      )
      .take(SEARCH_SCAN_LIMIT),
    ctx.db
      .query("productUsers")
      .withIndex("by_wallet_address_key", (index) =>
        index
          .gte("walletAddressKey", term.lowercase)
          .lte("walletAddressKey", term.lowercaseUpperBound),
      )
      .take(SEARCH_SCAN_LIMIT),
    ctx.db
      .query("productUsers")
      .withIndex("by_subject", (index) =>
        index
          .gte("subject", term.verbatim)
          .lte("subject", term.verbatimUpperBound),
      )
      .take(SEARCH_SCAN_LIMIT),
  ]);
  const matches = new Map<string, Doc<"productUsers">>();
  for (const document of [...byEmail, ...byWalletAddress, ...bySubject]) {
    matches.set(document._id, document);
  }
  return {
    matches: [...matches.values()].sort(compareProductUserRecency),
    truncated: [byEmail, byWalletAddress, bySubject].some(
      (scan) => scan.length === SEARCH_SCAN_LIMIT,
    ),
  };
}

/**
 * One bounded page of the product-user directory, most recently seen first.
 *
 * Browsing pages through the recency index with Convex cursors. Searching
 * merges bounded prefix scans and pages through them with an opaque offset
 * cursor; both modes return cursors the caller passes back unchanged.
 */
export const listDirectoryPage = internalQuery({
  args: {
    search: v.union(v.string(), v.null()),
    paginationOpts: paginationOptsValidator,
  },
  returns: directoryPageValidator,
  handler: async (ctx, args) => {
    const pageSize = requireProductUserPageSize(args.paginationOpts.numItems);
    const cursor = args.paginationOpts.cursor;
    const term = normalizeProductUserSearchTerm(args.search);

    if (term === null) {
      if (cursor !== null && isProductUserSearchCursor(cursor)) {
        refuseProductUser("PRODUCT_USER_PAGE_CURSOR_INVALID");
      }
      const result = await ctx.db
        .query("productUsers")
        .withIndex("by_last_seen_at")
        .order("desc")
        .paginate(args.paginationOpts);
      return {
        page: await toDirectoryRows(ctx, result.page),
        isDone: result.isDone,
        continueCursor: result.isDone ? null : result.continueCursor,
        searchTruncated: false,
      };
    }

    const offset = parseProductUserSearchCursor(cursor);
    const { matches, truncated } = await findSearchMatches(ctx, term);
    const documents = matches.slice(offset, offset + pageSize);
    const nextOffset = offset + documents.length;
    const isDone = nextOffset >= matches.length;
    return {
      page: await toDirectoryRows(ctx, documents),
      isDone,
      continueCursor: isDone ? null : formatProductUserSearchCursor(nextOffset),
      searchTruncated: truncated,
    };
  },
});

/**
 * One directory record by subject, or null when that identity has never been
 * recorded. The subject is an addressing argument from the trusted admin
 * integration, never an authorization claim: product callers cannot reach this
 * function, and product-side ownership still comes from the verified identity.
 */
export const getDirectoryRecord = internalQuery({
  args: { subject: v.string() },
  returns: v.union(productUserRecordValidator, v.null()),
  handler: async (ctx, args) => {
    const subject = args.subject;
    if (
      subject.length === 0 ||
      subject.length > PRODUCT_USER_MAX_SUBJECT_LENGTH
    ) {
      refuseProductUser("PRODUCT_USER_SUBJECT_INVALID");
    }
    const matches = await ctx.db
      .query("productUsers")
      .withIndex("by_subject", (index) => index.eq("subject", subject))
      .take(2);
    if (matches.length > 1) refuseProductUser("PRODUCT_USER_STATE_CONFLICT");
    const existing = matches[0];
    return existing === undefined ? null : toProductUserRecord(existing);
  },
});
