import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { loadActiveCatalogManifestState } from "./catalogManifestState";

/**
 * Read-only provider catalog inspection for the admin.
 *
 * These are the reads behind the admin's Published and Compare surfaces. They
 * are internal functions, reachable only through the deployment-secret-guarded
 * server-to-server routes in `http.ts` — no browser or product client can call
 * them, and none of them writes.
 *
 * The reads are release-scoped on purpose. A provider's published state is
 * whichever release the active manifest currently selects, and three situations
 * must stay distinguishable to callers: there is no active manifest at all, the
 * active manifest does not reference this platform, or it does. Collapsing them
 * into one empty answer would let the comparison surface report "nothing
 * published" when the truth is "nothing published yet, ever" or "the manifest
 * moved on".
 */

/** Entity kinds that carry a standalone public identity. */
export const IDENTIFIED_ENTITY_KINDS = [
  "vendors",
  "categories",
  "repacks",
  "collectibles",
] as const;

export type IdentifiedEntityKind = (typeof IDENTIFIED_ENTITY_KINDS)[number];

const identifiedEntityKindValidator = v.union(
  v.literal("vendors"),
  v.literal("categories"),
  v.literal("repacks"),
  v.literal("collectibles"),
);

/**
 * Paginating one release's entities of a kind, and finding one by public id.
 *
 * The kinds are dispatched explicitly rather than through a table-name lookup:
 * Convex's generated types tie a table to its own index names, so indirection
 * would erase exactly the guarantee that each read uses the right index. The
 * repetition buys a compile-time error if an index is ever renamed.
 */
async function paginateEntities(
  ctx: QueryCtx,
  releaseId: Id<"providerCatalogReleases">,
  entityKind: IdentifiedEntityKind,
  paginationOpts: { numItems: number; cursor: string | null },
): Promise<{
  items: { publicEntityId: string; detail: unknown }[];
  isDone: boolean;
  continueCursor: string;
}> {
  switch (entityKind) {
    case "vendors": {
      const page = await ctx.db
        .query("providerCatalogVendors")
        .withIndex("by_release_id_and_public_vendor_id", (index) =>
          index.eq("releaseId", releaseId),
        )
        .paginate(paginationOpts);
      return {
        items: page.page.map((row) => ({
          publicEntityId: row.publicVendorId,
          detail: row.detail,
        })),
        isDone: page.isDone,
        continueCursor: page.continueCursor,
      };
    }
    case "categories": {
      const page = await ctx.db
        .query("providerCatalogCategories")
        .withIndex("by_release_id_and_public_category_id", (index) =>
          index.eq("releaseId", releaseId),
        )
        .paginate(paginationOpts);
      return {
        items: page.page.map((row) => ({
          publicEntityId: row.publicCategoryId,
          detail: row.detail,
        })),
        isDone: page.isDone,
        continueCursor: page.continueCursor,
      };
    }
    case "repacks": {
      const page = await ctx.db
        .query("providerCatalogRepacks")
        .withIndex("by_release_id_and_public_repack_id", (index) =>
          index.eq("releaseId", releaseId),
        )
        .paginate(paginationOpts);
      return {
        items: page.page.map((row) => ({
          publicEntityId: row.publicRepackId,
          detail: row.detail,
        })),
        isDone: page.isDone,
        continueCursor: page.continueCursor,
      };
    }
    case "collectibles": {
      const page = await ctx.db
        .query("providerCatalogCollectibles")
        .withIndex("by_release_id_and_public_collectible_id", (index) =>
          index.eq("releaseId", releaseId),
        )
        .paginate(paginationOpts);
      return {
        items: page.page.map((row) => ({
          publicEntityId: row.publicCollectibleId,
          detail: row.detail,
        })),
        isDone: page.isDone,
        continueCursor: page.continueCursor,
      };
    }
  }
}

async function findEntity(
  ctx: QueryCtx,
  releaseId: Id<"providerCatalogReleases">,
  entityKind: IdentifiedEntityKind,
  publicEntityId: string,
): Promise<unknown | null> {
  switch (entityKind) {
    case "vendors":
      return (
        await ctx.db
          .query("providerCatalogVendors")
          .withIndex("by_release_id_and_public_vendor_id", (index) =>
            index.eq("releaseId", releaseId).eq("publicVendorId", publicEntityId),
          )
          .unique()
      )?.detail ?? null;
    case "categories":
      return (
        await ctx.db
          .query("providerCatalogCategories")
          .withIndex("by_release_id_and_public_category_id", (index) =>
            index
              .eq("releaseId", releaseId)
              .eq("publicCategoryId", publicEntityId),
          )
          .unique()
      )?.detail ?? null;
    case "repacks":
      return (
        await ctx.db
          .query("providerCatalogRepacks")
          .withIndex("by_release_id_and_public_repack_id", (index) =>
            index.eq("releaseId", releaseId).eq("publicRepackId", publicEntityId),
          )
          .unique()
      )?.detail ?? null;
    case "collectibles":
      return (
        await ctx.db
          .query("providerCatalogCollectibles")
          .withIndex("by_release_id_and_public_collectible_id", (index) =>
            index
              .eq("releaseId", releaseId)
              .eq("publicCollectibleId", publicEntityId),
          )
          .unique()
      )?.detail ?? null;
  }
}

/** Server-enforced ceiling; a caller asking for more gets this. */
export const MAX_PAGE_ITEMS = 200;
/** Identity-only pages carry no document bodies, so they page wider. */
export const MAX_ID_PAGE_ITEMS = 1_000;

export function boundedPageSize(requested: number, ceiling: number): number {
  if (!Number.isFinite(requested) || requested < 1) return ceiling;
  return Math.min(Math.floor(requested), ceiling);
}

async function releaseByPublicId(
  ctx: QueryCtx,
  publicProviderReleaseId: string,
): Promise<Doc<"providerCatalogReleases"> | null> {
  return await ctx.db
    .query("providerCatalogReleases")
    .withIndex("by_public_provider_release_id", (index) =>
      index.eq("publicProviderReleaseId", publicProviderReleaseId),
    )
    .unique();
}

/**
 * Resolve the release only when the active manifest still selects it.
 *
 * This check deliberately lives in the same Convex query as the requested
 * document read. Convex queries observe one transactional snapshot, so a
 * manifest promotion cannot happen between validating the selector and
 * reading entities from the selected release.
 */
async function expectedActiveRelease(
  ctx: QueryCtx,
  platformKey: string,
  expectedPublicProviderReleaseId: string,
): Promise<Doc<"providerCatalogReleases"> | null> {
  const { state, document } = await loadActiveCatalogManifestState(ctx);
  const activeManifest = state.activeManifest;
  const activeManifestId = document?.activeManifestId ?? null;
  if (
    activeManifest === null ||
    document === null ||
    activeManifestId === null
  ) {
    return null;
  }

  const reference = await ctx.db
    .query("catalogManifestProviderReferences")
    .withIndex("by_manifest_id_and_platform_key", (index) =>
      index
        .eq("manifestId", activeManifestId)
        .eq("platformKey", platformKey),
    )
    .unique();
  if (
    reference === null ||
    reference.manifestPublicReleaseId !== activeManifest.publicReleaseId ||
    reference.manifestFingerprint !== activeManifest.manifestFingerprint ||
    reference.platformKey !== platformKey ||
    reference.publicProviderReleaseId !== expectedPublicProviderReleaseId
  ) {
    return null;
  }

  const release = await ctx.db.get(reference.releaseId);
  if (
    release === null ||
    release.platformKey !== platformKey ||
    release.publicProviderReleaseId !== expectedPublicProviderReleaseId ||
    release.providerReleaseFingerprint !==
      reference.providerReleaseFingerprint
  ) {
    return null;
  }
  return release;
}

function releaseFacts(release: Doc<"providerCatalogReleases">) {
  return {
    publicProviderReleaseId: release.publicProviderReleaseId,
    platformKey: release.platformKey,
    lifecycle: release.lifecycle,
    dataAsOf: release.dataAsOf,
    providerReleaseFingerprint: release.providerReleaseFingerprint,
    contentHash: release.contentHash,
    entityHashes: release.entityHashes,
    counts: release.counts,
    batchCount: release.batchCount,
    batchChainHash: release.batchChainHash,
    createdAt: release.createdAt,
    completedAt: release.completedAt,
    completionOperationId: release.completionOperationId,
  };
}

/**
 * What the product currently serves for one platform.
 *
 * Reports its own lifecycle rather than assuming `complete`: a release that
 * failed or was retired while still referenced is a fact an operator needs, and
 * silently presenting it as the served release would hide exactly the situation
 * the comparison surface exists to catch.
 */
export const activeRelease = internalQuery({
  args: { platformKey: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const { state } = await loadActiveCatalogManifestState(ctx);
    const activeManifest = state.activeManifest;
    if (activeManifest === null) {
      return { status: "no_active_manifest" as const };
    }

    const reference = await ctx.db
      .query("catalogManifestProviderReferences")
      .withIndex("by_manifest_public_release_id_and_platform_key", (index) =>
        index
          .eq("manifestPublicReleaseId", activeManifest.publicReleaseId)
          .eq("platformKey", args.platformKey),
      )
      .unique();

    if (reference === null) {
      return {
        status: "platform_not_referenced" as const,
        manifestPublicReleaseId: activeManifest.publicReleaseId,
      };
    }

    const release = await ctx.db.get(reference.releaseId);
    if (release === null) {
      // The manifest names a release the store no longer holds. That is a real
      // inconsistency, reported as itself rather than as an absent platform.
      return {
        status: "release_missing" as const,
        manifestPublicReleaseId: activeManifest.publicReleaseId,
        publicProviderReleaseId: reference.publicProviderReleaseId,
      };
    }

    return {
      status: "active" as const,
      manifestPublicReleaseId: activeManifest.publicReleaseId,
      referenceFingerprint: reference.providerReleaseFingerprint,
      release: releaseFacts(release),
    };
  },
});

/** One page of published documents for a release and entity kind. */
export const listEntities = internalQuery({
  args: {
    platformKey: v.string(),
    expectedPublicProviderReleaseId: v.string(),
    entityKind: identifiedEntityKindValidator,
    paginationOpts: paginationOptsValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const release = await expectedActiveRelease(
      ctx,
      args.platformKey,
      args.expectedPublicProviderReleaseId,
    );
    if (release === null) return { status: "release_unknown" as const };

    const page = await paginateEntities(ctx, release._id, args.entityKind, {
      ...args.paginationOpts,
      numItems: boundedPageSize(args.paginationOpts.numItems, MAX_PAGE_ITEMS),
    });

    return {
      status: "ok" as const,
      items: page.items,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * One page of public ids, without document bodies.
 *
 * This exists so a reconciliation walk can cover a release holding millions of
 * entities in a bounded number of requests. Pulling documents to compare
 * identities would move orders of magnitude more data for no additional answer.
 */
export const listEntityIds = internalQuery({
  args: {
    publicProviderReleaseId: v.string(),
    entityKind: identifiedEntityKindValidator,
    paginationOpts: paginationOptsValidator,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const release = await releaseByPublicId(ctx, args.publicProviderReleaseId);
    if (release === null) return { status: "release_unknown" as const };

    const page = await paginateEntities(ctx, release._id, args.entityKind, {
      ...args.paginationOpts,
      numItems: boundedPageSize(
        args.paginationOpts.numItems,
        MAX_ID_PAGE_ITEMS,
      ),
    });

    return {
      status: "ok" as const,
      publicEntityIds: page.items.map((item) => item.publicEntityId),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** One published document, or a representable absence. */
export const readDocument = internalQuery({
  args: {
    platformKey: v.string(),
    expectedPublicProviderReleaseId: v.string(),
    entityKind: identifiedEntityKindValidator,
    publicEntityId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const release = await expectedActiveRelease(
      ctx,
      args.platformKey,
      args.expectedPublicProviderReleaseId,
    );
    if (release === null) return { status: "release_unknown" as const };

    const detail = await findEntity(
      ctx,
      release._id,
      args.entityKind,
      args.publicEntityId,
    );

    if (detail === null) return { status: "not_present" as const };
    return {
      status: "ok" as const,
      publicEntityId: args.publicEntityId,
      detail,
    };
  },
});

/**
 * Chase reconciliation for one repack, read from what the publication itself
 * recorded. Chases are edges rather than entities — they carry no standalone
 * public id — so they are compared through their parent repack's expected and
 * accepted counts instead of through an identity walk.
 */
export const readRepackChaseReconciliation = internalQuery({
  args: {
    platformKey: v.string(),
    expectedPublicProviderReleaseId: v.string(),
    publicRepackId: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const release = await expectedActiveRelease(
      ctx,
      args.platformKey,
      args.expectedPublicProviderReleaseId,
    );
    if (release === null) return { status: "release_unknown" as const };

    const row = await ctx.db
      .query("providerCatalogRepackReconciliation")
      .withIndex("by_release_id_and_public_repack_id", (index) =>
        index
          .eq("releaseId", release._id as Id<"providerCatalogReleases">)
          .eq("publicRepackId", args.publicRepackId),
      )
      .unique();

    if (row === null) return { status: "not_present" as const };
    return {
      status: "ok" as const,
      publicRepackId: row.publicRepackId,
      expectedChaseCount: row.expectedChaseCount,
      acceptedChaseCount: row.acceptedChaseCount,
      complete: row.complete,
    };
  },
});
