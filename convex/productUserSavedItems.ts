import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { loadValidatedCatalogManifest } from "./catalogManifestState";
import {
  productUserTimestamp,
  refuseProductUser,
  requireProductUserSubjectArgument,
} from "./productUserRecords";
import {
  compareSavedItemCandidateOrder,
  MAX_SAVED_ITEMS_PER_KIND,
} from "./savedItems";
import {
  normalizeLegacyPackAvailability,
  publicPackAvailabilityValidator,
} from "./publicRepackValidation";

/**
 * Privileged per-subject saved-item reads for the admin integration.
 *
 * These are internal functions: they are not part of the app's public API and
 * are unreachable from browsers, product clients, and any other authenticated
 * product caller. The only external entry point is the admin-integration HTTP
 * surface in `http.ts`, which authenticates its caller server-side with a
 * deployment secret. They are strictly read-only: nothing here inserts,
 * patches, or deletes a user's saved items.
 *
 * Catalog resolution belongs here because the product backend owns the
 * catalog. Saved rows are durable and outlive catalog republication, so a
 * reference that is absent from the active release is reported as an
 * unresolved row carrying its stable public identifier — never dropped and
 * never an error.
 *
 * Cost is bounded by construction: a collection holds at most
 * `MAX_SAVED_ITEMS_PER_KIND` rows and the active catalog holds at most eight
 * provider releases, so one call reads at most that product of index ranges,
 * and each kind is a separate transaction with its own budget.
 */

const collectibleTypeValidator = v.union(
  v.literal("card"),
  v.literal("watch"),
  v.literal("coin"),
  v.literal("sealed_product"),
  v.literal("memorabilia"),
  v.literal("other"),
);

const resolutionValidator = v.union(
  v.literal("resolved"),
  v.literal("unresolved"),
);

/**
 * PackScout's own estimate for the repack, present only when the active
 * catalog carries one. The vendor's reported figure is deliberately excluded:
 * the admin shows what PackScout states, not what a vendor claims.
 */
const estimatedEvValidator = v.object({
  evDollarsMinorUnits: v.number(),
  grossReturnBasisPoints: v.number(),
  confidenceBand: v.union(
    v.literal("low"),
    v.literal("medium"),
    v.literal("high"),
  ),
});

const savedRepackValidator = v.object({
  publicRepackId: v.string(),
  savedAt: v.string(),
  resolution: resolutionValidator,
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

const savedCollectibleValidator = v.object({
  publicCollectibleId: v.string(),
  savedAt: v.string(),
  resolution: resolutionValidator,
  collectible: v.union(
    v.null(),
    v.object({ name: v.string(), collectibleType: collectibleTypeValidator }),
  ),
});

/**
 * `catalogAvailable` distinguishes "this reference has left the catalog" from
 * "no catalog could be read at all", so the admin never mislabels an entire
 * collection as removed during a republication gap.
 */
const savedRepackCollectionValidator = v.object({
  catalogAvailable: v.boolean(),
  items: v.array(savedRepackValidator),
});

const savedCollectibleCollectionValidator = v.object({
  catalogAvailable: v.boolean(),
  items: v.array(savedCollectibleValidator),
});

type ActiveCatalog = Readonly<{
  available: boolean;
  releaseIds: readonly Id<"providerCatalogReleases">[];
}>;

/**
 * The active release's provider releases, or an empty catalog.
 *
 * A refused catalog state is treated as "no catalog to resolve against" rather
 * than a failed read: this surface exists so an administrator can see what an
 * account holds, and the stable identifiers stay investigable even while the
 * catalog itself is unhealthy.
 */
async function loadActiveCatalog(ctx: QueryCtx): Promise<ActiveCatalog> {
  let releaseIds: readonly Id<"providerCatalogReleases">[];
  try {
    const loaded = await loadValidatedCatalogManifest(ctx);
    releaseIds =
      loaded === null ? [] : loaded.providerReleases.map(({ _id }) => _id);
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    releaseIds = [];
  }
  return { available: releaseIds.length > 0, releaseIds };
}

async function findActiveRepack(
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
      .take(1);
    const match = matches[0];
    if (match !== undefined) return match;
  }
  return null;
}

async function findActiveCollectible(
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
      .take(1);
    const match = matches[0];
    if (match !== undefined) return match;
  }
  return null;
}

/**
 * Newest save first. This is the exact reverse of the prune order the saving
 * mutations use, so the row a further save would prune first is the last
 * unresolved row an administrator sees.
 */
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

function displayRepack(detail: Doc<"providerCatalogRepacks">["detail"]) {
  const packScout = detail.evEstimates.packScout;
  return {
    name: detail.name,
    vendorDisplayName: detail.vendorDisplayName,
    // Stored details may predate the availability rename; the returns
    // validator stays on the strict four-state union.
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

function requireBoundedCollection(count: number): void {
  if (count > MAX_SAVED_ITEMS_PER_KIND) {
    refuseProductUser("PRODUCT_USER_STATE_CONFLICT");
  }
}

/**
 * One owner's saved repacks, newest save first, each resolved against the
 * active catalog. Every saved row appears, whether or not the catalog still
 * carries its reference.
 */
export const listSavedRepacksForSubject = internalQuery({
  args: { subject: v.string() },
  returns: savedRepackCollectionValidator,
  handler: async (ctx, args) => {
    const subject = requireProductUserSubjectArgument(args.subject);
    const saved = await ctx.db
      .query("savedRepacks")
      .withIndex("by_owner_token_identifier_and_public_repack_id", (index) =>
        index.eq("ownerTokenIdentifier", subject),
      )
      .take(MAX_SAVED_ITEMS_PER_KIND + 1);
    requireBoundedCollection(saved.length);

    const catalog = await loadActiveCatalog(ctx);
    const items = [];
    for (const row of newestSavedFirst(
      saved,
      ({ publicRepackId }) => publicRepackId,
      ({ _creationTime }) => _creationTime,
    )) {
      const document = await findActiveRepack(ctx, catalog, row.publicRepackId);
      items.push({
        publicRepackId: row.publicRepackId,
        savedAt: productUserTimestamp(row._creationTime),
        resolution:
          document === null ? ("unresolved" as const) : ("resolved" as const),
        repack: document === null ? null : displayRepack(document.detail),
      });
    }
    return { catalogAvailable: catalog.available, items };
  },
});

/**
 * One owner's saved collectibles, newest save first, on the same terms as the
 * repack collection.
 */
export const listSavedCollectiblesForSubject = internalQuery({
  args: { subject: v.string() },
  returns: savedCollectibleCollectionValidator,
  handler: async (ctx, args) => {
    const subject = requireProductUserSubjectArgument(args.subject);
    const saved = await ctx.db
      .query("savedCollectibles")
      .withIndex(
        "by_owner_token_identifier_and_public_collectible_id",
        (index) => index.eq("ownerTokenIdentifier", subject),
      )
      .take(MAX_SAVED_ITEMS_PER_KIND + 1);
    requireBoundedCollection(saved.length);

    const catalog = await loadActiveCatalog(ctx);
    const items = [];
    for (const row of newestSavedFirst(
      saved,
      ({ publicCollectibleId }) => publicCollectibleId,
      ({ _creationTime }) => _creationTime,
    )) {
      const document = await findActiveCollectible(
        ctx,
        catalog,
        row.publicCollectibleId,
      );
      items.push({
        publicCollectibleId: row.publicCollectibleId,
        savedAt: productUserTimestamp(row._creationTime),
        resolution:
          document === null ? ("unresolved" as const) : ("resolved" as const),
        collectible:
          document === null
            ? null
            : {
                name: document.detail.name,
                collectibleType: document.detail.collectibleType,
              },
      });
    }
    return { catalogAvailable: catalog.available, items };
  },
});
