import {
  SAVED_CATALOG_ITEM_LIMIT,
  compareCanonicalStrings,
  packCatalogUuidSchema,
  savedCatalogErrorCodes,
} from "@packscout/contracts";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { loadCollectibleProfileHead, loadPackHead } from "./packCatalogStoreSupport";
import {
  PRODUCT_USER_READ_CAPABILITY,
  PRODUCT_USER_WRITE_CAPABILITY,
  requireAdmittedProductUser,
} from "./productUserCapabilityGate";

/**
 * `SavedCatalogItemsV1` (pack-version-publication/005): the P01 saved-item
 * contract resolved against `pack_catalog_v1` heads. Rows live in the same
 * `savedRepacks` / `savedCollectibles` tables as the current catalog, keyed by
 * the Convex-verified owner token and the stable public identity, so saves
 * survive the V1 cutover unchanged. A pack is saveable while it has an active
 * head in any lifecycle state; removal never needs a head; at capacity only
 * the oldest unreachable item of the same kind is pruned.
 */

type SavedError = { readonly code: (typeof savedCatalogErrorCodes)[number]; readonly error: string };
type SetResult = { readonly saved: boolean; readonly prunedUnavailable: boolean };

const SAVED_ERROR_MESSAGES: Record<SavedError["code"], string> = {
  AUTH_REQUIRED: "Sign in to save catalog items.",
  AUTH_IDENTITY_INVALID: "The signed-in identity could not be verified.",
  INVALID_PUBLIC_REPACK_ID: "The pack identifier is invalid.",
  INVALID_PUBLIC_COLLECTIBLE_ID: "The collectible identifier is invalid.",
  SAVED_RESOURCE_UNAVAILABLE: "The requested item is not available in the catalog.",
  SAVED_ITEM_LIMIT_REACHED: "The saved-item limit has been reached.",
  SAVED_ITEMS_STATE_CONFLICT: "The saved-item state is inconsistent.",
};

function savedError(code: SavedError["code"]): SavedError {
  return { code, error: SAVED_ERROR_MESSAGES[code] };
}

/** Owner resolution through the shared admission gate, mapped to the P01 error union. */
async function owner(
  ctx: Pick<QueryCtx, "auth" | "db">,
  capability: typeof PRODUCT_USER_READ_CAPABILITY,
): Promise<{ ok: true; owner: string } | { ok: false; error: SavedError }> {
  try {
    return { ok: true, owner: await requireAdmittedProductUser(ctx, capability) };
  } catch (error) {
    const code = error instanceof ConvexError ? (error.data as { code?: unknown }).code : undefined;
    if (code === "AUTH_REQUIRED" || code === "AUTH_IDENTITY_INVALID") return { ok: false, error: savedError(code) };
    throw error;
  }
}

const setArgsValidator = { saved: v.boolean() };
const setResultValidator = v.union(
  v.object({ saved: v.boolean(), prunedUnavailable: v.boolean() }),
  v.object({ code: v.string(), error: v.string() }),
);

export const getSavedItemIds = query({
  args: {},
  returns: v.union(
    v.object({ savedRepackIds: v.array(v.string()), savedCollectibleIds: v.array(v.string()) }),
    v.object({ code: v.string(), error: v.string() }),
  ),
  handler: async (ctx) => {
    const resolved = await owner(ctx, PRODUCT_USER_READ_CAPABILITY);
    if (!resolved.ok) return resolved.error;
    const [repacks, collectibles] = await Promise.all([
      ctx.db.query("savedRepacks")
        .withIndex("by_owner_token_identifier_and_public_repack_id", (index) => index.eq("ownerTokenIdentifier", resolved.owner))
        .take(SAVED_CATALOG_ITEM_LIMIT + 1),
      ctx.db.query("savedCollectibles")
        .withIndex("by_owner_token_identifier_and_public_collectible_id", (index) => index.eq("ownerTokenIdentifier", resolved.owner))
        .take(SAVED_CATALOG_ITEM_LIMIT + 1),
    ]);
    if (repacks.length > SAVED_CATALOG_ITEM_LIMIT || collectibles.length > SAVED_CATALOG_ITEM_LIMIT) {
      return savedError("SAVED_ITEMS_STATE_CONFLICT");
    }
    return {
      savedRepackIds: [...new Set(repacks.map(({ publicRepackId }) => publicRepackId))].sort(compareCanonicalStrings),
      savedCollectibleIds: [...new Set(collectibles.map(({ publicCollectibleId }) => publicCollectibleId))].sort(compareCanonicalStrings),
    };
  },
});

type Kind = "repack" | "collectible";
type SavedRow = Doc<"savedRepacks"> | Doc<"savedCollectibles">;

async function setSaved(ctx: MutationCtx, kind: Kind, rawId: string, saved: boolean): Promise<SetResult | SavedError> {
  const resolved = await owner(ctx, PRODUCT_USER_WRITE_CAPABILITY);
  if (!resolved.ok) return resolved.error;
  const parsedId = packCatalogUuidSchema.safeParse(rawId);
  if (!parsedId.success) return savedError(kind === "repack" ? "INVALID_PUBLIC_REPACK_ID" : "INVALID_PUBLIC_COLLECTIBLE_ID");
  const id = parsedId.data;
  const table = kind === "repack" ? "savedRepacks" : "savedCollectibles";
  const ownerRows = async (): Promise<SavedRow[]> => kind === "repack"
    ? await ctx.db.query("savedRepacks").withIndex("by_owner_token_identifier_and_public_repack_id", (index) => index.eq("ownerTokenIdentifier", resolved.owner)).take(SAVED_CATALOG_ITEM_LIMIT + 1)
    : await ctx.db.query("savedCollectibles").withIndex("by_owner_token_identifier_and_public_collectible_id", (index) => index.eq("ownerTokenIdentifier", resolved.owner)).take(SAVED_CATALOG_ITEM_LIMIT + 1);
  const idOf = (row: SavedRow) => "publicRepackId" in row ? row.publicRepackId : row.publicCollectibleId;
  const reachable = async (stableId: string) => kind === "repack"
    ? await loadPackHead(ctx, stableId) !== null
    : await loadCollectibleProfileHead(ctx, stableId) !== null;
  const rows = await ownerRows();
  if (rows.length > SAVED_CATALOG_ITEM_LIMIT) return savedError("SAVED_ITEMS_STATE_CONFLICT");
  const matches = rows.filter((row) => idOf(row) === id);
  if (matches.length > 1) return savedError("SAVED_ITEMS_STATE_CONFLICT");
  if (!saved) {
    if (matches[0] !== undefined) await ctx.db.delete(table, matches[0]._id as never);
    return { saved: false, prunedUnavailable: false };
  }
  if (!(await reachable(id))) return savedError("SAVED_RESOURCE_UNAVAILABLE");
  if (matches[0] !== undefined) return { saved: true, prunedUnavailable: false };
  let prunedUnavailable = false;
  if (rows.length === SAVED_CATALOG_ITEM_LIMIT) {
    const oldestFirst = [...rows].sort((left, right) => left._creationTime - right._creationTime);
    let stale: SavedRow | null = null;
    for (const row of oldestFirst) {
      if (!(await reachable(idOf(row)))) { stale = row; break; }
    }
    if (stale === null) return savedError("SAVED_ITEM_LIMIT_REACHED");
    await ctx.db.delete(table, stale._id as never);
    prunedUnavailable = true;
  }
  if (kind === "repack") await ctx.db.insert("savedRepacks", { ownerTokenIdentifier: resolved.owner, publicRepackId: id });
  else await ctx.db.insert("savedCollectibles", { ownerTokenIdentifier: resolved.owner, publicCollectibleId: id });
  return { saved: true, prunedUnavailable };
}

export const setSavedRepack = mutation({
  args: { publicRepackId: v.string(), ...setArgsValidator },
  returns: setResultValidator,
  handler: (ctx, args) => setSaved(ctx, "repack", args.publicRepackId, args.saved),
});

export const setSavedCollectible = mutation({
  args: { publicCollectibleId: v.string(), ...setArgsValidator },
  returns: setResultValidator,
  handler: (ctx, args) => setSaved(ctx, "collectible", args.publicCollectibleId, args.saved),
});
