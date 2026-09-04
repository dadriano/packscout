import {
  canonicalJson,
  publicCollectibleIdSchema,
  publicCollectibleSchema,
  publicRepackDetailV3Schema,
  publicRepackIdSchema,
  type PackScoutDisplayedEvV3,
  type PublicRepackDetailV3,
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
import {
  dataReleaseV3SearchRowFromDetail,
  dataReleaseV3SearchRowMatchesDetail,
} from "./dataReleaseV3Search";
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
  MAX_DESIRED_CHASES_PER_COLLECTIBLE,
  type ActiveDataReleaseV3,
} from "./publicRepacksV3";

export const MAX_SAVED_ITEMS_PER_KIND = 250;
const WATCHLIST_QUERY_DOCUMENT_BUDGET = 4_096;
/** Stay under Convex's per-query document-read budget when proving chase rows. */
export const WATCHLIST_CHASE_VALIDATION_BATCH = Math.floor(
  WATCHLIST_QUERY_DOCUMENT_BUDGET / (MAX_DESIRED_CHASES_PER_COLLECTIBLE + 1),
);
/**
 * Full pack details are large. Prove a handful of chased documents per query
 * without reloading the catalog.
 */
export const WATCHLIST_REPACK_PROOF_BATCH = 8;

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
const displayedEvValidator = v.object({
  evDollarsMinorUnits: v.number(),
  grossReturnBasisPoints: v.number(),
  confidenceBand: v.union(
    v.literal("low"),
    v.literal("medium"),
    v.literal("high"),
  ),
});
const nullableTextValidator = v.union(v.string(), v.null());
const nullableImageValidator = v.union(
  v.object({
    url: v.string(),
    alt: v.string(),
  }),
  v.null(),
);
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
      displayedEv: v.union(v.null(), displayedEvValidator),
      primaryImage: nullableImageValidator,
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
      primaryImage: nullableImageValidator,
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
const watchlistRepackProofValidator = v.object({
  publicRepackId: v.string(),
  searchRowCanonical: v.string(),
  omitDerivedSearchPenalty: v.boolean(),
  factsCanonical: v.union(v.string(), v.null()),
  hasDisplayedEv: v.boolean(),
});
const ownerWatchlistSnapshotValidator = v.object({
  watchlist: ownerWatchlistValidator,
  releaseId: v.id("dataReleaseV3Releases"),
  legacyEvSnapshot: v.boolean(),
  displayedPackProofs: v.array(watchlistRepackProofValidator),
  failedDisplayedPublicRepackIds: v.array(v.string()),
});
type OwnerWatchlistSnapshot = Infer<typeof ownerWatchlistSnapshotValidator>;
type WatchlistRepackProof = Infer<typeof watchlistRepackProofValidator>;

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
  if (!publicCollectibleSchema.safeParse(match.detail).success) {
    return null;
  }
  return match;
}

function catalogPackProofs(catalog: ActiveDataReleaseV3): {
  displayedPackProofs: WatchlistRepackProof[];
  failedDisplayedPublicRepackIds: string[];
} {
  const displayedPackProofs = [];
  const failedDisplayedPublicRepackIds = [];
  for (const publicRepackId of catalog.rowByPublicId.keys()) {
    const rawRow = catalog.storedRowByPublicId.get(publicRepackId);
    if (rawRow === undefined) {
      failedDisplayedPublicRepackIds.push(publicRepackId);
      continue;
    }
    const facts = catalog.factsByPublicId.get(publicRepackId);
    displayedPackProofs.push({
      publicRepackId,
      searchRowCanonical: canonicalJson(rawRow),
      omitDerivedSearchPenalty:
        rawRow.packScoutStaticConfidencePenaltyBasisPoints === undefined,
      factsCanonical: facts === undefined ? null : canonicalJson(facts),
      hasDisplayedEv: catalog.evByPublicId.get(publicRepackId) !== undefined,
    });
  }
  return { displayedPackProofs, failedDisplayedPublicRepackIds };
}

function derivedSearchRowCanonical(
  detail: PublicRepackDetailV3,
  omitDerivedSearchPenalty: boolean,
): string {
  const derived = dataReleaseV3SearchRowFromDetail(detail);
  if (!omitDerivedSearchPenalty) return canonicalJson(derived);
  const {
    packScoutStaticConfidencePenaltyBasisPoints: _penalty,
    ...retainedShape
  } = derived;
  return canonicalJson(retainedShape);
}

async function proveWatchlistRepackDocument(
  ctx: QueryCtx,
  releaseId: Id<"dataReleaseV3Releases">,
  proof: WatchlistRepackProof,
  legacyEvSnapshot: boolean,
): Promise<boolean> {
  const matches = await ctx.db
    .query("dataReleaseV3Repacks")
    .withIndex("by_release_id_and_public_repack_id", (index) =>
      index
        .eq("releaseId", releaseId)
        .eq("publicRepackId", proof.publicRepackId),
    )
    .take(2);
  const match = matches[0];
  if (
    matches.length > 1 ||
    (match !== undefined &&
      (match.releaseId !== releaseId ||
        match.publicRepackId !== proof.publicRepackId ||
        match.detail.publicRepackId !== proof.publicRepackId))
  ) {
    refuse("SAVED_ITEMS_STATE_CONFLICT");
  }
  if (match === undefined) return false;
  const parsed = publicRepackDetailV3Schema.safeParse(match.detail);
  if (!parsed.success) return false;
  if (
    derivedSearchRowCanonical(parsed.data, proof.omitDerivedSearchPenalty) !==
    proof.searchRowCanonical
  ) {
    return false;
  }
  if (!legacyEvSnapshot) {
    if (!proof.hasDisplayedEv || proof.factsCanonical === null) return false;
    if (canonicalJson(evFactsFromDetail(parsed.data)) !== proof.factsCanonical) {
      return false;
    }
  }
  return true;
}

function chasedCatalogRepacksCanOpen(
  publicRepackIds: readonly string[],
  failedPublicRepackIds: ReadonlySet<string>,
): boolean {
  return !publicRepackIds.some((id) => failedPublicRepackIds.has(id));
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

function displayWatchlistDisplayedEv(
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
    displayedEv: displayWatchlistDisplayedEv(
      catalog.legacyEvSnapshot
        ? detail.evEstimates.packScout
        : catalog.evByPublicId.get(detail.publicRepackId),
    ),
    primaryImage: detail.primaryImage ?? null,
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
    primaryImage: detail.primaryImage ?? null,
  };
}

function unavailableCollectibleRow(
  row: OwnerWatchlist["savedCollectibles"][number],
): OwnerWatchlist["savedCollectibles"][number] {
  return {
    publicCollectibleId: row.publicCollectibleId,
    savedAt: row.savedAt,
    catalogStatus: "unavailable",
    openable: false,
    collectible: null,
  };
}

function demoteCollectiblesThatCannotOpen(
  watchlist: OwnerWatchlist,
  failedPublicCollectibleIds: ReadonlySet<string>,
): OwnerWatchlist {
  if (failedPublicCollectibleIds.size === 0) return watchlist;
  return {
    ...watchlist,
    savedCollectibles: watchlist.savedCollectibles.map((row) =>
      failedPublicCollectibleIds.has(row.publicCollectibleId)
        ? unavailableCollectibleRow(row)
        : row,
    ),
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
  returns: ownerWatchlistSnapshotValidator,
  handler: async (ctx, args): Promise<OwnerWatchlistSnapshot> => {
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
      watchlist: {
        savedRepacks: resolvedRepacks,
        savedCollectibles: resolvedCollectibles,
        savedRepackCount: resolvedRepacks.length,
        savedCollectibleCount: resolvedCollectibles.length,
      },
      releaseId: catalog.releaseDocument._id,
      legacyEvSnapshot: catalog.legacyEvSnapshot,
      ...catalogPackProofs(catalog),
    };
  },
});

/**
 * Open-equivalent proof for a small page of chased pack documents. Catalog
 * fingerprints come from the snapshot; this query does not reload the catalog.
 */
export const proveOwnerWatchlistRepacks = internalQuery({
  args: {
    releaseId: v.id("dataReleaseV3Releases"),
    legacyEvSnapshot: v.boolean(),
    packs: v.array(watchlistRepackProofValidator),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args): Promise<string[]> => {
    await requireAdmittedProductUser(ctx, PRODUCT_USER_WRITE_CAPABILITY);
    if (args.packs.length > WATCHLIST_REPACK_PROOF_BATCH) {
      refuse("SAVED_RESOURCE_UNAVAILABLE");
    }
    const failedPublicRepackIds = [];
    for (const proof of args.packs) {
      if (
        !(await proveWatchlistRepackDocument(
          ctx,
          args.releaseId,
          proof,
          args.legacyEvSnapshot,
        ))
      ) {
        failedPublicRepackIds.push(proof.publicRepackId);
      }
    }
    return failedPublicRepackIds;
  },
});

const watchlistCollectibleChasesValidator = v.object({
  publicCollectibleId: v.string(),
  publicRepackIds: v.union(v.null(), v.array(v.string())),
});

/**
 * Bounded chase-row proof for a small batch of saved collectibles. Does not
 * load the catalog or pack details.
 */
export const validateOwnerWatchlistCollectibleChases = internalQuery({
  args: {
    releaseId: v.id("dataReleaseV3Releases"),
    publicCollectibleIds: v.array(v.string()),
  },
  returns: v.array(watchlistCollectibleChasesValidator),
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ publicCollectibleId: string; publicRepackIds: string[] | null }>> => {
    await requireAdmittedProductUser(ctx, PRODUCT_USER_WRITE_CAPABILITY);
    if (args.publicCollectibleIds.length > WATCHLIST_CHASE_VALIDATION_BATCH) {
      refuse("SAVED_RESOURCE_UNAVAILABLE");
    }
    const release = { releaseDocument: { _id: args.releaseId } };
    const rows = [];
    for (const publicCollectibleId of args.publicCollectibleIds) {
      const chases = await loadDesiredChases(
        ctx,
        release,
        publicCollectibleId,
      );
      rows.push({
        publicCollectibleId,
        publicRepackIds: chases === null ? null : [...chases.keys()],
      });
    }
    return rows;
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
  handler: async (ctx): Promise<OwnerWatchlist> => {
    const currentTime = Date.now();
    const snapshot: OwnerWatchlistSnapshot = await ctx.runQuery(
      internal.savedItems.getOwnerWatchlistAtTime,
      { currentTime },
    );
    const resolvedIds = snapshot.watchlist.savedCollectibles
      .filter((row) => row.catalogStatus === "resolved")
      .map((row) => row.publicCollectibleId);
    const chaseRows: Array<{
      publicCollectibleId: string;
      publicRepackIds: string[] | null;
    }> = [];
    for (
      let offset = 0;
      offset < resolvedIds.length;
      offset += WATCHLIST_CHASE_VALIDATION_BATCH
    ) {
      const publicCollectibleIds = resolvedIds.slice(
        offset,
        offset + WATCHLIST_CHASE_VALIDATION_BATCH,
      );
      const batch: typeof chaseRows = await ctx.runQuery(
        internal.savedItems.validateOwnerWatchlistCollectibleChases,
        { releaseId: snapshot.releaseId, publicCollectibleIds },
      );
      chaseRows.push(...batch);
    }
    const proofByPublicId = new Map(
      snapshot.displayedPackProofs.map((proof) => [
        proof.publicRepackId,
        proof,
      ]),
    );
    const chasedDisplayedProofs = [];
    const seen = new Set<string>();
    for (const row of chaseRows) {
      if (row.publicRepackIds === null) continue;
      for (const publicRepackId of row.publicRepackIds) {
        const proof = proofByPublicId.get(publicRepackId);
        if (proof === undefined || seen.has(publicRepackId)) continue;
        seen.add(publicRepackId);
        chasedDisplayedProofs.push(proof);
      }
    }
    const failedPacks = new Set(snapshot.failedDisplayedPublicRepackIds);
    for (
      let offset = 0;
      offset < chasedDisplayedProofs.length;
      offset += WATCHLIST_REPACK_PROOF_BATCH
    ) {
      const packs = chasedDisplayedProofs.slice(
        offset,
        offset + WATCHLIST_REPACK_PROOF_BATCH,
      );
      const batchFailed: string[] = await ctx.runQuery(
        internal.savedItems.proveOwnerWatchlistRepacks,
        {
          releaseId: snapshot.releaseId,
          legacyEvSnapshot: snapshot.legacyEvSnapshot,
          packs,
        },
      );
      for (const publicRepackId of batchFailed) {
        failedPacks.add(publicRepackId);
      }
    }
    const failed = new Set<string>();
    for (const row of chaseRows) {
      if (
        row.publicRepackIds === null ||
        !chasedCatalogRepacksCanOpen(row.publicRepackIds, failedPacks)
      ) {
        failed.add(row.publicCollectibleId);
      }
    }
    return demoteCollectiblesThatCannotOpen(snapshot.watchlist, failed);
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
