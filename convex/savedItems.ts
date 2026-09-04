import {
  canonicalJson,
  publicCollectibleIdSchema,
  publicRepackIdSchema,
} from "@packscout/contracts";
import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { loadValidatedCatalogManifest } from "./catalogManifestState";
import {
  PRODUCT_USER_READ_CAPABILITY,
  PRODUCT_USER_WRITE_CAPABILITY,
  requireAdmittedProductUser,
} from "./productUserCapabilityGate";
import { productUserTimestamp } from "./productUserRecords";
import {
  normalizeLegacyPackAvailability,
  publicPackAvailabilityValidator,
} from "./publicRepackValidation";

export const MAX_SAVED_ITEMS_PER_KIND = 250;

/**
 * Codes this module raises itself. Authentication and admission refusals —
 * `AUTH_REQUIRED`, `AUTH_IDENTITY_INVALID`, the closed-beta reason codes,
 * and the shared `ACCOUNT_SUSPENDED` outcome for suspended accounts — are
 * raised by the shared capability gate every entry point here passes through
 * before touching any saved-item state.
 */
type SavedItemsErrorCode =
  | "INVALID_PUBLIC_REPACK_ID"
  | "INVALID_PUBLIC_COLLECTIBLE_ID"
  | "SAVED_RESOURCE_UNAVAILABLE"
  | "SAVED_ITEM_LIMIT_REACHED"
  | "SAVED_ITEMS_STATE_CONFLICT";

type SavedItemIds = Readonly<{
  savedRepackIds: string[];
  savedCollectibleIds: string[];
}>;

type SetSavedResult = Readonly<{
  saved: boolean;
  prunedUnavailable: boolean;
}>;

const setSavedResultValidator = v.object({
  saved: v.boolean(),
  prunedUnavailable: v.boolean(),
});

const catalogStatusValidator = v.union(
  v.literal("resolved"),
  v.literal("unavailable"),
);
const collectibleTypeValidator = v.union(
  v.literal("card"),
  v.literal("watch"),
  v.literal("coin"),
  v.literal("sealed_product"),
  v.literal("memorabilia"),
  v.literal("other"),
);
const estimatedEvValidator = v.object({
  evDollarsMinorUnits: v.number(),
  grossReturnBasisPoints: v.number(),
  confidenceBand: v.union(
    v.literal("low"),
    v.literal("medium"),
    v.literal("high"),
  ),
});
const nullableTextValidator = v.union(v.string(), v.null());
const ownerWatchlistRepackValidator = v.object({
  publicRepackId: v.string(),
  savedAt: v.string(),
  catalogStatus: catalogStatusValidator,
  openable: v.boolean(),
  repack: v.union(
    v.null(),
    v.object({
      name: v.string(),
      vendorDisplayName: v.string(),
      availability: publicPackAvailabilityValidator,
      estimatedEv: v.union(v.null(), estimatedEvValidator),
    }),
  ),
});
const ownerWatchlistCollectibleValidator = v.object({
  publicCollectibleId: v.string(),
  savedAt: v.string(),
  catalogStatus: catalogStatusValidator,
  openable: v.boolean(),
  collectible: v.union(
    v.null(),
    v.object({
      name: v.string(),
      collectibleType: collectibleTypeValidator,
      year: v.union(v.number(), v.null()),
      brand: nullableTextValidator,
      setOrSeries: nullableTextValidator,
      cardNumber: nullableTextValidator,
      referenceNumber: nullableTextValidator,
      grade: nullableTextValidator,
      grader: nullableTextValidator,
    }),
  ),
});
const ownerWatchlistValidator = v.object({
  savedRepacks: v.array(ownerWatchlistRepackValidator),
  savedCollectibles: v.array(ownerWatchlistCollectibleValidator),
  savedRepackCount: v.number(),
  savedCollectibleCount: v.number(),
});

type OwnerWatchlist = Infer<typeof ownerWatchlistValidator>;
type ActiveCatalog = Readonly<{
  available: boolean;
  releaseIds: readonly Id<"providerCatalogReleases">[];
}>;

function refuse(code: SavedItemsErrorCode): never {
  const message =
    code === "INVALID_PUBLIC_REPACK_ID" ||
    code === "INVALID_PUBLIC_COLLECTIBLE_ID"
      ? "The saved-item identifier is invalid."
      : code === "SAVED_RESOURCE_UNAVAILABLE"
        ? "The requested resource is not available in the active release."
        : code === "SAVED_ITEM_LIMIT_REACHED"
          ? "The saved-item limit has been reached."
          : "The saved-item state is inconsistent.";
  throw new ConvexError({ code, message });
}

function validatePublicRepackId(publicRepackId: string): void {
  if (!publicRepackIdSchema.safeParse(publicRepackId).success) {
    refuse("INVALID_PUBLIC_REPACK_ID");
  }
}

function validatePublicCollectibleId(publicCollectibleId: string): void {
  if (!publicCollectibleIdSchema.safeParse(publicCollectibleId).success) {
    refuse("INVALID_PUBLIC_COLLECTIBLE_ID");
  }
}

async function activeProviderReleaseIds(
  ctx: MutationCtx,
): Promise<readonly Id<"providerCatalogReleases">[]> {
  const loaded = await loadValidatedCatalogManifest(ctx);
  if (loaded === null || loaded.providerReleases.length === 0) {
    refuse("SAVED_RESOURCE_UNAVAILABLE");
  }
  return loaded.providerReleases.map(({ _id }) => _id);
}

async function activeRepackExists(
  ctx: MutationCtx,
  releaseIds: readonly Id<"providerCatalogReleases">[],
  publicRepackId: string,
): Promise<boolean> {
  let found = false;
  for (const releaseId of releaseIds) {
    const matches = await ctx.db
      .query("providerCatalogRepacks")
      .withIndex("by_release_id_and_public_repack_id", (index) =>
        index.eq("releaseId", releaseId).eq("publicRepackId", publicRepackId),
      )
      .take(2);
    const match = matches[0];
    if (
      matches.length > 1 ||
      (match !== undefined &&
        (match.releaseId !== releaseId ||
          match.publicRepackId !== publicRepackId ||
          match.detail.publicRepackId !== publicRepackId)) ||
      (found && match !== undefined)
    ) {
      refuse("SAVED_ITEMS_STATE_CONFLICT");
    }
    found ||= match !== undefined;
  }
  return found;
}

async function activeCollectibleExists(
  ctx: MutationCtx,
  releaseIds: readonly Id<"providerCatalogReleases">[],
  publicCollectibleId: string,
): Promise<boolean> {
  let canonicalDetail: string | null = null;
  for (const releaseId of releaseIds) {
    const matches = await ctx.db
      .query("providerCatalogCollectibles")
      .withIndex("by_release_id_and_public_collectible_id", (index) =>
        index
          .eq("releaseId", releaseId)
          .eq("publicCollectibleId", publicCollectibleId),
      )
      .take(2);
    const match = matches[0];
    const detail = match === undefined
      ? null
      : canonicalJson(match.detail);
    if (
      matches.length > 1 ||
      (match !== undefined &&
        (match.releaseId !== releaseId ||
          match.publicCollectibleId !== publicCollectibleId ||
          match.detail.publicCollectibleId !== publicCollectibleId ||
          (canonicalDetail !== null && canonicalDetail !== detail)))
    ) {
      refuse("SAVED_ITEMS_STATE_CONFLICT");
    }
    if (detail !== null) canonicalDetail = detail;
  }
  return canonicalDetail !== null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSavedItemCandidateOrder(
  leftCreationTime: number,
  leftPublicId: string,
  rightCreationTime: number,
  rightPublicId: string,
): number {
  return (
    leftCreationTime - rightCreationTime ||
    compareText(leftPublicId, rightPublicId)
  );
}

async function firstUnavailableSavedRepack(
  ctx: MutationCtx,
  releaseIds: readonly Id<"providerCatalogReleases">[],
  savedItems: readonly Doc<"savedRepacks">[],
): Promise<Doc<"savedRepacks"> | null> {
  const candidates = [...savedItems].sort((left, right) =>
    compareSavedItemCandidateOrder(
      left._creationTime,
      left.publicRepackId,
      right._creationTime,
      right.publicRepackId,
    ),
  );
  for (const candidate of candidates) {
    if (!(await activeRepackExists(ctx, releaseIds, candidate.publicRepackId))) {
      return candidate;
    }
  }
  return null;
}

async function firstUnavailableSavedCollectible(
  ctx: MutationCtx,
  releaseIds: readonly Id<"providerCatalogReleases">[],
  savedItems: readonly Doc<"savedCollectibles">[],
): Promise<Doc<"savedCollectibles"> | null> {
  const candidates = [...savedItems].sort((left, right) =>
    compareSavedItemCandidateOrder(
      left._creationTime,
      left.publicCollectibleId,
      right._creationTime,
      right.publicCollectibleId,
    ),
  );
  for (const candidate of candidates) {
    if (
      !(await activeCollectibleExists(
        ctx,
        releaseIds,
        candidate.publicCollectibleId,
      ))
    ) {
      return candidate;
    }
  }
  return null;
}

async function loadActiveCatalogForWatchlist(
  ctx: QueryCtx,
): Promise<ActiveCatalog> {
  let releaseIds: readonly Id<"providerCatalogReleases">[];
  try {
    const loaded = await loadValidatedCatalogManifest(ctx);
    releaseIds =
      loaded === null ? [] : loaded.providerReleases.map(({ _id }) => _id);
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    refuse("SAVED_RESOURCE_UNAVAILABLE");
  }
  return { available: releaseIds.length > 0, releaseIds };
}

async function findActiveRepackForWatchlist(
  ctx: QueryCtx,
  catalog: ActiveCatalog,
  publicRepackId: string,
): Promise<Doc<"providerCatalogRepacks"> | null> {
  for (const releaseId of catalog.releaseIds) {
    const matches = await ctx.db
      .query("providerCatalogRepacks")
      .withIndex("by_release_id_and_public_repack_id", (index) =>
        index.eq("releaseId", releaseId).eq("publicRepackId", publicRepackId),
      )
      .take(2);
    if (matches.length > 1) refuse("SAVED_ITEMS_STATE_CONFLICT");
    const match = matches[0];
    if (match !== undefined) return match;
  }
  return null;
}

async function findActiveCollectibleForWatchlist(
  ctx: QueryCtx,
  catalog: ActiveCatalog,
  publicCollectibleId: string,
): Promise<Doc<"providerCatalogCollectibles"> | null> {
  for (const releaseId of catalog.releaseIds) {
    const matches = await ctx.db
      .query("providerCatalogCollectibles")
      .withIndex("by_release_id_and_public_collectible_id", (index) =>
        index
          .eq("releaseId", releaseId)
          .eq("publicCollectibleId", publicCollectibleId),
      )
      .take(2);
    if (matches.length > 1) refuse("SAVED_ITEMS_STATE_CONFLICT");
    const match = matches[0];
    if (match !== undefined) return match;
  }
  return null;
}

function newestSavedFirst<TRow>(
  rows: readonly TRow[],
  publicId: (row: TRow) => string,
  creationTime: (row: TRow) => number,
): TRow[] {
  return [...rows].sort(
    (left, right) =>
      -compareSavedItemCandidateOrder(
        creationTime(left),
        publicId(left),
        creationTime(right),
        publicId(right),
      ),
  );
}

function displayWatchlistRepack(
  detail: Doc<"providerCatalogRepacks">["detail"],
) {
  const packScout = detail.evEstimates.packScout;
  return {
    name: detail.name,
    vendorDisplayName: detail.vendorDisplayName,
    availability: normalizeLegacyPackAvailability(detail.availability),
    estimatedEv:
      packScout.status === "available"
        ? {
            evDollarsMinorUnits: packScout.metrics.evDollars.minorUnits,
            grossReturnBasisPoints: packScout.metrics.grossReturnBasisPoints,
            confidenceBand: packScout.confidence.band,
          }
        : null,
  };
}

function displayWatchlistCollectible(
  detail: Doc<"providerCatalogCollectibles">["detail"],
) {
  return {
    name: detail.name,
    collectibleType: detail.collectibleType,
    year: detail.year,
    brand: detail.brand,
    setOrSeries: detail.setOrSeries,
    cardNumber: detail.cardNumber,
    referenceNumber: detail.referenceNumber,
    grade: detail.grade,
    grader: detail.grader,
  };
}

/**
 * The caller's own saved item IDs. Reading is an authenticated product
 * capability: while the closed beta is on, an unadmitted account is refused
 * here too, with its stored rows untouched — a later admission returns
 * exactly this data. While the beta is off, the read refuses nothing, as it
 * always has: suspension stops what an account can do, never hides what it
 * owns.
 */
export const getSavedItemIds = query({
  args: {},
  returns: v.object({
    savedRepackIds: v.array(v.string()),
    savedCollectibleIds: v.array(v.string()),
  }),
  handler: async (ctx): Promise<SavedItemIds> => {
    const ownerTokenIdentifier = await requireAdmittedProductUser(
      ctx,
      PRODUCT_USER_READ_CAPABILITY,
    );
    const [savedRepacks, savedCollectibles] = await Promise.all([
      ctx.db
        .query("savedRepacks")
        .withIndex("by_owner_token_identifier_and_public_repack_id", (index) =>
          index.eq("ownerTokenIdentifier", ownerTokenIdentifier),
        )
        .take(MAX_SAVED_ITEMS_PER_KIND + 1),
      ctx.db
        .query("savedCollectibles")
        .withIndex(
          "by_owner_token_identifier_and_public_collectible_id",
          (index) => index.eq("ownerTokenIdentifier", ownerTokenIdentifier),
        )
        .take(MAX_SAVED_ITEMS_PER_KIND + 1),
    ]);
    if (
      savedRepacks.length > MAX_SAVED_ITEMS_PER_KIND ||
      savedCollectibles.length > MAX_SAVED_ITEMS_PER_KIND
    ) {
      refuse("SAVED_ITEMS_STATE_CONFLICT");
    }
    return {
      savedRepackIds: savedRepacks
        .map(({ publicRepackId }) => publicRepackId)
        .sort(),
      savedCollectibleIds: savedCollectibles
        .map(({ publicCollectibleId }) => publicCollectibleId)
        .sort(),
    };
  },
});

/**
 * The caller's Watchlist: both saved collections resolved against the current
 * catalog, newest first, with per-tab counts. This is the same owner-only
 * read capability as `getSavedItemIds`; it adds display fields so later UI
 * can render lists without a second store. Missing catalog references stay
 * in the payload as unavailable, not-openable rows.
 */
export const getOwnerWatchlist = query({
  args: {},
  returns: ownerWatchlistValidator,
  handler: async (ctx): Promise<OwnerWatchlist> => {
    const ownerTokenIdentifier = await requireAdmittedProductUser(
      ctx,
      PRODUCT_USER_READ_CAPABILITY,
    );
    const [savedRepacks, savedCollectibles] = await Promise.all([
      ctx.db
        .query("savedRepacks")
        .withIndex("by_owner_token_identifier_and_public_repack_id", (index) =>
          index.eq("ownerTokenIdentifier", ownerTokenIdentifier),
        )
        .take(MAX_SAVED_ITEMS_PER_KIND + 1),
      ctx.db
        .query("savedCollectibles")
        .withIndex(
          "by_owner_token_identifier_and_public_collectible_id",
          (index) => index.eq("ownerTokenIdentifier", ownerTokenIdentifier),
        )
        .take(MAX_SAVED_ITEMS_PER_KIND + 1),
    ]);
    if (
      savedRepacks.length > MAX_SAVED_ITEMS_PER_KIND ||
      savedCollectibles.length > MAX_SAVED_ITEMS_PER_KIND
    ) {
      refuse("SAVED_ITEMS_STATE_CONFLICT");
    }

    const catalog = await loadActiveCatalogForWatchlist(ctx);
    if (!catalog.available) refuse("SAVED_RESOURCE_UNAVAILABLE");

    const resolvedRepacks = [];
    for (const row of newestSavedFirst(
      savedRepacks,
      ({ publicRepackId }) => publicRepackId,
      ({ _creationTime }) => _creationTime,
    )) {
      const document = await findActiveRepackForWatchlist(
        ctx,
        catalog,
        row.publicRepackId,
      );
      resolvedRepacks.push({
        publicRepackId: row.publicRepackId,
        savedAt: productUserTimestamp(row._creationTime),
        catalogStatus:
          document === null ? ("unavailable" as const) : ("resolved" as const),
        openable: document !== null,
        repack:
          document === null ? null : displayWatchlistRepack(document.detail),
      });
    }

    const resolvedCollectibles = [];
    for (const row of newestSavedFirst(
      savedCollectibles,
      ({ publicCollectibleId }) => publicCollectibleId,
      ({ _creationTime }) => _creationTime,
    )) {
      const document = await findActiveCollectibleForWatchlist(
        ctx,
        catalog,
        row.publicCollectibleId,
      );
      resolvedCollectibles.push({
        publicCollectibleId: row.publicCollectibleId,
        savedAt: productUserTimestamp(row._creationTime),
        catalogStatus:
          document === null ? ("unavailable" as const) : ("resolved" as const),
        openable: document !== null,
        collectible:
          document === null
            ? null
            : displayWatchlistCollectible(document.detail),
      });
    }

    return {
      savedRepacks: resolvedRepacks,
      savedCollectibles: resolvedCollectibles,
      savedRepackCount: resolvedRepacks.length,
      savedCollectibleCount: resolvedCollectibles.length,
    };
  },
});

export const setSavedRepack = mutation({
  args: { publicRepackId: v.string(), saved: v.boolean() },
  returns: setSavedResultValidator,
  handler: async (ctx, args): Promise<SetSavedResult> => {
    const ownerTokenIdentifier = await requireAdmittedProductUser(
      ctx,
      PRODUCT_USER_WRITE_CAPABILITY,
    );
    validatePublicRepackId(args.publicRepackId);
    const matches = await ctx.db
      .query("savedRepacks")
      .withIndex("by_owner_token_identifier_and_public_repack_id", (index) =>
        index
          .eq("ownerTokenIdentifier", ownerTokenIdentifier)
          .eq("publicRepackId", args.publicRepackId),
      )
      .take(2);
    if (matches.length > 1) refuse("SAVED_ITEMS_STATE_CONFLICT");

    if (!args.saved) {
      if (matches[0] !== undefined) {
        await ctx.db.delete("savedRepacks", matches[0]._id);
      }
      return { saved: false, prunedUnavailable: false };
    }

    const releaseIds = await activeProviderReleaseIds(ctx);
    if (!(await activeRepackExists(ctx, releaseIds, args.publicRepackId))) {
      refuse("SAVED_RESOURCE_UNAVAILABLE");
    }
    if (matches[0] !== undefined) {
      return { saved: true, prunedUnavailable: false };
    }
    const savedItems = await ctx.db
      .query("savedRepacks")
      .withIndex("by_owner_token_identifier_and_public_repack_id", (index) =>
        index.eq("ownerTokenIdentifier", ownerTokenIdentifier),
      )
      .take(MAX_SAVED_ITEMS_PER_KIND + 1);
    if (savedItems.length > MAX_SAVED_ITEMS_PER_KIND) {
      refuse("SAVED_ITEMS_STATE_CONFLICT");
    }
    let prunedUnavailable = false;
    if (savedItems.length === MAX_SAVED_ITEMS_PER_KIND) {
      const stale = await firstUnavailableSavedRepack(
        ctx,
        releaseIds,
        savedItems,
      );
      if (stale === null) refuse("SAVED_ITEM_LIMIT_REACHED");
      await ctx.db.delete("savedRepacks", stale._id);
      prunedUnavailable = true;
    }
    await ctx.db.insert("savedRepacks", {
      ownerTokenIdentifier,
      publicRepackId: args.publicRepackId,
    });
    return { saved: true, prunedUnavailable };
  },
});

export const setSavedCollectible = mutation({
  args: { publicCollectibleId: v.string(), saved: v.boolean() },
  returns: setSavedResultValidator,
  handler: async (ctx, args): Promise<SetSavedResult> => {
    const ownerTokenIdentifier = await requireAdmittedProductUser(
      ctx,
      PRODUCT_USER_WRITE_CAPABILITY,
    );
    validatePublicCollectibleId(args.publicCollectibleId);
    const matches = await ctx.db
      .query("savedCollectibles")
      .withIndex(
        "by_owner_token_identifier_and_public_collectible_id",
        (index) =>
          index
            .eq("ownerTokenIdentifier", ownerTokenIdentifier)
            .eq("publicCollectibleId", args.publicCollectibleId),
      )
      .take(2);
    if (matches.length > 1) refuse("SAVED_ITEMS_STATE_CONFLICT");

    if (!args.saved) {
      if (matches[0] !== undefined) {
        await ctx.db.delete("savedCollectibles", matches[0]._id);
      }
      return { saved: false, prunedUnavailable: false };
    }

    const releaseIds = await activeProviderReleaseIds(ctx);
    if (
      !(await activeCollectibleExists(ctx, releaseIds, args.publicCollectibleId))
    ) {
      refuse("SAVED_RESOURCE_UNAVAILABLE");
    }
    if (matches[0] !== undefined) {
      return { saved: true, prunedUnavailable: false };
    }
    const savedItems = await ctx.db
      .query("savedCollectibles")
      .withIndex(
        "by_owner_token_identifier_and_public_collectible_id",
        (index) => index.eq("ownerTokenIdentifier", ownerTokenIdentifier),
      )
      .take(MAX_SAVED_ITEMS_PER_KIND + 1);
    if (savedItems.length > MAX_SAVED_ITEMS_PER_KIND) {
      refuse("SAVED_ITEMS_STATE_CONFLICT");
    }
    let prunedUnavailable = false;
    if (savedItems.length === MAX_SAVED_ITEMS_PER_KIND) {
      const stale = await firstUnavailableSavedCollectible(
        ctx,
        releaseIds,
        savedItems,
      );
      if (stale === null) refuse("SAVED_ITEM_LIMIT_REACHED");
      await ctx.db.delete("savedCollectibles", stale._id);
      prunedUnavailable = true;
    }
    await ctx.db.insert("savedCollectibles", {
      ownerTokenIdentifier,
      publicCollectibleId: args.publicCollectibleId,
    });
    return { saved: true, prunedUnavailable };
  },
});
