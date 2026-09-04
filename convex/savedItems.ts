import {
  canonicalJson,
  publicCollectibleIdSchema,
  publicRepackDetailV3Schema,
  publicRepackIdSchema,
  type PackScoutDisplayedEvV3,
} from "@packscout/contracts";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { loadValidatedCatalogManifest } from "./catalogManifestState";
import { evFactsFromDetail } from "./dataReleaseV3EvFacts";
import { isDataReleaseV3EvaluationTime } from "./dataReleaseV3Pagination";
import { dataReleaseV3SearchRowMatchesDetail } from "./dataReleaseV3Search";
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
import {
  loadActiveDataReleaseV3,
  loadDesiredChases,
  type ActiveDataReleaseV3,
} from "./publicRepacksV3";

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

async function findActiveRepackForWatchlist(
  ctx: QueryCtx,
  catalog: ActiveDataReleaseV3,
  publicRepackId: string,
): Promise<Doc<"dataReleaseV3Repacks"> | null> {
  const releaseId = catalog.releaseDocument._id;
  const matches = await ctx.db
    .query("dataReleaseV3Repacks")
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
        match.detail.publicRepackId !== publicRepackId))
  ) {
    refuse("SAVED_ITEMS_STATE_CONFLICT");
  }
  if (match === undefined) return null;
  const rawRow = catalog.storedRowByPublicId.get(publicRepackId);
  if (rawRow === undefined) return null;
  const parsed = publicRepackDetailV3Schema.safeParse(match.detail);
  if (
    !parsed.success ||
    !dataReleaseV3SearchRowMatchesDetail(rawRow, parsed.data)
  ) {
    return null;
  }
  if (!catalog.legacyEvSnapshot) {
    const displayedEstimate = catalog.evByPublicId.get(publicRepackId);
    const facts = catalog.factsByPublicId.get(publicRepackId);
    if (
      displayedEstimate === undefined ||
      facts === undefined ||
      canonicalJson(evFactsFromDetail(parsed.data)) !== canonicalJson(facts)
    ) {
      return null;
    }
  }
  return match;
}

async function findActiveCollectibleForWatchlist(
  ctx: QueryCtx,
  catalog: ActiveDataReleaseV3,
  publicCollectibleId: string,
): Promise<Doc<"dataReleaseV3Collectibles"> | null> {
  const releaseId = catalog.releaseDocument._id;
  const matches = await ctx.db
    .query("dataReleaseV3Collectibles")
    .withIndex("by_release_id_and_public_collectible_id", (index) =>
      index
        .eq("releaseId", releaseId)
        .eq("publicCollectibleId", publicCollectibleId),
    )
    .take(2);
  const match = matches[0];
  if (
    matches.length > 1 ||
    (match !== undefined &&
      (match.releaseId !== releaseId ||
        match.publicCollectibleId !== publicCollectibleId ||
        match.detail.publicCollectibleId !== publicCollectibleId))
  ) {
    refuse("SAVED_ITEMS_STATE_CONFLICT");
  }
  if (match === undefined) return null;
  if ((await loadDesiredChases(ctx, catalog, publicCollectibleId)) === null) {
    return null;
  }
  return match;
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

function displayWatchlistEstimatedEv(
  estimate: PackScoutDisplayedEvV3 | undefined,
) {
  if (
    estimate === undefined ||
    estimate.metrics === null ||
    estimate.confidence === null
  ) {
    return null;
  }
  return {
    evDollarsMinorUnits: estimate.metrics.evDollars.minorUnits,
    grossReturnBasisPoints: estimate.metrics.grossReturnBasisPoints,
    confidenceBand: estimate.confidence.band,
  };
}

function displayWatchlistRepack(
  detail: Doc<"dataReleaseV3Repacks">["detail"],
  catalog: ActiveDataReleaseV3,
) {
  return {
    name: detail.name,
    vendorDisplayName: detail.vendorDisplayName,
    availability: normalizeLegacyPackAvailability(detail.availability),
    estimatedEv: displayWatchlistEstimatedEv(
      catalog.legacyEvSnapshot
        ? detail.evEstimates.packScout
        : catalog.evByPublicId.get(detail.publicRepackId),
    ),
  };
}

function displayWatchlistCollectible(
  detail: Doc<"dataReleaseV3Collectibles">["detail"],
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
 * Deterministic Watchlist read at a minted evaluation clock. Public callers
 * use `getOwnerWatchlist`, which supplies Convex's clock the same way the
 * buyer-facing V3 catalog actions do.
 */
export const getOwnerWatchlistAtTime = internalQuery({
  args: { currentTime: v.number() },
  returns: ownerWatchlistValidator,
  handler: async (ctx, args): Promise<OwnerWatchlist> => {
    if (!isDataReleaseV3EvaluationTime(args.currentTime)) {
      refuse("SAVED_RESOURCE_UNAVAILABLE");
    }
    const ownerTokenIdentifier = await requireAdmittedProductUser(
      ctx,
      PRODUCT_USER_WRITE_CAPABILITY,
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

    const catalog = await loadActiveDataReleaseV3(ctx, args.currentTime);
    if (catalog === null) {
      refuse("SAVED_RESOURCE_UNAVAILABLE");
    }

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
          document === null
            ? null
            : displayWatchlistRepack(document.detail, catalog),
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

/**
 * The caller's Watchlist. Convex mints the evaluation clock so retained EV
 * confidence cannot freeze on a cached query. Missing V3 catalog references
 * stay in the payload as unavailable, not-openable rows.
 */
export const getOwnerWatchlist = action({
  args: {},
  returns: ownerWatchlistValidator,
  handler: async (ctx): Promise<OwnerWatchlist> =>
    await ctx.runQuery(internal.savedItems.getOwnerWatchlistAtTime, {
      currentTime: Date.now(),
    }),
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
