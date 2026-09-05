import {
  PACK_CATALOG_LIST_MAX_ITEMS,
  PACK_CATALOG_V1,
  PackCatalogCursorError,
  compareCanonicalStrings,
  packCatalogV1QueryContracts,
  publicCollectibleProfileSchema,
  readPackCatalogCursor,
  issuePackCatalogCursor,
  type PackCatalogCursorBinding,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, internalQuery, type QueryCtx } from "./_generated/server";
import { isDataReleaseV3EvaluationTime } from "./dataReleaseV3Pagination";
import {
  PACK_CATALOG_HEAD_SCAN_LIMIT,
  PACK_CATALOG_MAX_ACTIVE_HEADS,
  PACK_CATALOG_MEMBERSHIP_SCAN_LIMIT,
  comparePackHeads,
  currentProviderProfile,
  cursorSigningKeyBytes,
  issueListCursor,
  joinProviderProfiles,
  lifecycleMatches,
  packFilterMatches,
  packSortKey,
  packSummaryOf,
  readListCursor,
  scanPackHeads,
  type KeysetPosition,
  type PackHead,
  type PackSort,
  type ProviderProfileCache,
} from "./packCatalogReadModel";
import {
  loadCollectibleProfileHead,
  loadPackHead,
  loadPackSnapshot,
  loadProfileSnapshot,
} from "./packCatalogStoreSupport";
import { catalogReadAuthorized, catalogReadTokenArg } from "./publicCatalogReadAccess";

/**
 * The sole public catalog read surface: `pack_catalog_v1`
 * (pack-version-publication/005, tech-004). Six journeys, each resolving every
 * pack-local field from the one complete snapshot named by that pack's active
 * head, joined to nothing that could mix versions. Public actions mint the
 * evaluation clock; the internal queries take it as an argument so they never
 * read the wall clock. Reads depend only on completed active heads, so paused
 * writers and unavailable providers leave every journey answerable.
 */

type ReadErrorCode = "INVALID_QUERY" | "CURSOR_EXPIRED" | "CATALOG_UNAVAILABLE" | "PACK_NOT_FOUND" | "COLLECTIBLE_NOT_FOUND";
type ReadError = { readonly ok: false; readonly code: ReadErrorCode; readonly error: string; readonly retryable: boolean };
type Result<T> = { readonly ok: true; readonly data: T } | ReadError;

const READ_ERROR_MESSAGES: Record<ReadErrorCode, string> = {
  INVALID_QUERY: "The catalog query is invalid.",
  CURSOR_EXPIRED: "The catalog cursor is invalid or expired.",
  CATALOG_UNAVAILABLE: "The catalog is unavailable.",
  PACK_NOT_FOUND: "The requested pack is not available.",
  COLLECTIBLE_NOT_FOUND: "The requested collectible is not available.",
};

function readError(code: ReadErrorCode): ReadError {
  return { ok: false, code, error: READ_ERROR_MESSAGES[code], retryable: code === "CATALOG_UNAVAILABLE" };
}

const readArgs = { currentTime: v.number(), request: v.optional(v.any()), ...catalogReadTokenArg };

type Prelude<T> =
  | { readonly ok: true; readonly input: T; readonly evaluatedAt: string; readonly signingKey: Uint8Array }
  | { readonly ok: false; readonly error: ReadError };

async function prelude<T>(
  ctx: QueryCtx,
  args: { currentTime: number; request?: unknown; catalogReadToken?: unknown },
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): Promise<Prelude<T>> {
  if (!(await catalogReadAuthorized(ctx, args.catalogReadToken))) return { ok: false, error: readError("CATALOG_UNAVAILABLE") };
  if (!isDataReleaseV3EvaluationTime(args.currentTime)) return { ok: false, error: readError("INVALID_QUERY") };
  const parsed = parse(args.request ?? {});
  if (!parsed.success) return { ok: false, error: readError("INVALID_QUERY") };
  const signingKey = cursorSigningKeyBytes();
  if (signingKey === null) return { ok: false, error: readError("CATALOG_UNAVAILABLE") };
  return { ok: true, input: parsed.data, evaluatedAt: new Date(args.currentTime).toISOString(), signingKey };
}

function numericSort(sort: PackSort): boolean {
  return sort !== "title";
}

async function pagedHeads(ctx: QueryCtx, input: {
  readonly operation: "listPublicPacks" | "findPacksByDesiredCollectible";
  readonly filters: PackCatalogCursorBinding["filters"];
  readonly sort: PackSort;
  readonly direction: "asc" | "desc";
  readonly pageSize: number;
  readonly cursor: string | null;
  readonly evaluatedAt: string;
  readonly signingKey: Uint8Array;
  readonly matches: (head: PackHead) => boolean;
  readonly candidates?: PackHead[];
}): Promise<Result<{ items: ReturnType<typeof packSummaryOf>[]; nextCursor: string | null; providerProfiles: Awaited<ReturnType<typeof joinProviderProfiles>>["providerProfiles"] }>> {
  const binding: PackCatalogCursorBinding = {
    operation: input.operation, filters: input.filters, sort: input.sort,
    direction: input.direction, pageSize: input.pageSize, publicPackSnapshotId: null,
  };
  let position: Awaited<ReturnType<typeof readListCursor>> | null = null;
  if (input.cursor !== null) {
    try {
      position = await readListCursor({ cursor: input.cursor, binding, numeric: numericSort(input.sort), now: input.evaluatedAt, signingKey: input.signingKey });
    } catch (error) {
      if (error instanceof PackCatalogCursorError) return readError("CURSOR_EXPIRED");
      throw error;
    }
  }
  let items: PackHead[];
  let hasMore: boolean;
  let resume: KeysetPosition | null = null;
  if (input.candidates !== undefined) {
    const compare = comparePackHeads(input.sort, input.direction);
    const sorted = input.candidates.filter(input.matches).sort(compare);
    const after = position;
    const remaining = after === null ? sorted : sorted.filter((head) => {
      const probe = { ...head, publicRepackId: after.publicRepackId } as PackHead;
      probe[input.sort === "title" ? "sortTitle" : input.sort === "price" ? "sortPrice" : input.sort === "ev" ? "sortEv" : "sortTopChase"] = after.sortKey as never;
      return compare(head, probe) > 0;
    });
    items = remaining.slice(0, input.pageSize);
    hasMore = remaining.length > input.pageSize;
    const last = items[items.length - 1];
    resume = last === undefined ? null : { sortKey: packSortKey(last, input.sort), publicRepackId: last.publicRepackId };
  } else {
    const scan = await scanPackHeads(ctx, { sort: input.sort, direction: input.direction, position, pageSize: input.pageSize, matches: input.matches });
    items = scan.items;
    hasMore = scan.hasMore;
    resume = scan.resume;
  }
  const nextCursor = hasMore && resume !== null
    ? await issueListCursor({ binding, last: resume, issuedAt: input.evaluatedAt, signingKey: input.signingKey })
    : null;
  // A pack whose provider profile is unavailable fails alone; the page and its cursor stand.
  const joined = await joinProviderProfiles(ctx, items);
  return { ok: true, data: { items: joined.heads.map(packSummaryOf), nextCursor, providerProfiles: joined.providerProfiles } };
}

export const getPublicShellStatusAtTime = internalQuery({
  args: readArgs,
  handler: async (ctx, args): Promise<Result<unknown>> => {
    const ready = await prelude(ctx, args, (value) => packCatalogV1QueryContracts.getPublicShellStatus.input.safeParse(value));
    if (!ready.ok) return ready.error;
    let activeAvailablePackCount = 0;
    let reachable = false;
    let scanned = 0;
    for await (const head of ctx.db.query("activePackHeads").withIndex("by_sort_title_and_public_repack_id")) {
      reachable = true;
      scanned += 1;
      // The count is exact or the read fails closed; a capped number is never reported as exact.
      if (scanned > PACK_CATALOG_MAX_ACTIVE_HEADS) return readError("CATALOG_UNAVAILABLE");
      if (head.availability === "available" && head.retirement === "active") activeAvailablePackCount += 1;
    }
    return { ok: true, data: { schemaVersion: PACK_CATALOG_V1, evaluatedAt: ready.evaluatedAt, catalogAvailable: reachable, activeAvailablePackCount } };
  },
});

export const getDashboardBundleAtTime = internalQuery({
  args: readArgs,
  handler: async (ctx, args): Promise<Result<unknown>> => {
    const ready = await prelude(ctx, args, (value) => packCatalogV1QueryContracts.getDashboardBundle.input.safeParse(value));
    if (!ready.ok) return ready.error;
    const packs: PackHead[] = [];
    const cache: ProviderProfileCache = new Map();
    let totalMatchingPacks = 0;
    let scanned = 0;
    for await (const head of ctx.db.query("activePackHeads").withIndex("by_sort_ev_and_public_repack_id").order("desc")) {
      scanned += 1;
      if (scanned > PACK_CATALOG_MAX_ACTIVE_HEADS) return readError("CATALOG_UNAVAILABLE");
      if (!lifecycleMatches(head, ready.input.lifecycle)) continue;
      if (await currentProviderProfile(ctx, cache, head.providerId) === null) continue;
      totalMatchingPacks += 1;
      if (packs.length < PACK_CATALOG_LIST_MAX_ITEMS) packs.push(head);
    }
    const joined = await joinProviderProfiles(ctx, packs);
    return { ok: true, data: { evaluatedAt: ready.evaluatedAt, packs: joined.heads.map(packSummaryOf), totalMatchingPacks, providerProfiles: joined.providerProfiles } };
  },
});

export const listPublicPacksAtTime = internalQuery({
  args: readArgs,
  handler: async (ctx, args): Promise<Result<unknown>> => {
    const ready = await prelude(ctx, args, (value) => packCatalogV1QueryContracts.listPublicPacks.input.safeParse(value));
    if (!ready.ok) return ready.error;
    const input = ready.input;
    const page = await pagedHeads(ctx, {
      operation: "listPublicPacks",
      filters: { query: input.query, providerIds: input.providerIds, categoryIds: input.categoryIds, retirements: input.lifecycle.retirements, availabilities: input.lifecycle.availabilities },
      sort: input.sort, direction: input.direction, pageSize: input.pageSize, cursor: input.cursor,
      evaluatedAt: ready.evaluatedAt, signingKey: ready.signingKey,
      matches: (head) => packFilterMatches(head, input),
    });
    return page.ok ? { ok: true, data: { evaluatedAt: ready.evaluatedAt, ...page.data } } : page;
  },
});

export const getPublicPackAtTime = internalQuery({
  args: readArgs,
  handler: async (ctx, args): Promise<Result<unknown>> => {
    const ready = await prelude(ctx, args, (value) => packCatalogV1QueryContracts.getPublicPack.input.safeParse(value));
    if (!ready.ok) return ready.error;
    const input = ready.input;
    const head = await loadPackHead(ctx, input.publicRepackId);
    if (head === null) return readError("PACK_NOT_FOUND");
    let snapshotId = head.activeSnapshot.publicPackSnapshotId;
    let offset = 0;
    const bindingFor = (publicPackSnapshotId: string): PackCatalogCursorBinding => ({
      operation: "getPublicPack", filters: { publicRepackId: input.publicRepackId }, sort: "contents",
      direction: "asc", pageSize: input.contentPageSize, publicPackSnapshotId,
    });
    if (input.contentsCursor !== null) {
      try {
        const probe = await readPackCatalogCursor({ cursor: input.contentsCursor, binding: bindingFor(snapshotId), now: ready.evaluatedAt, signingKey: ready.signingKey })
          .catch(async () => {
            const [body] = input.contentsCursor!.split(".");
            const claimed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body!.replace(/-/gu, "+").replace(/_/gu, "/")), (c) => c.charCodeAt(0)))) as { publicPackSnapshotId?: unknown };
            if (typeof claimed.publicPackSnapshotId !== "string") throw new PackCatalogCursorError();
            return await readPackCatalogCursor({ cursor: input.contentsCursor!, binding: bindingFor(claimed.publicPackSnapshotId), now: ready.evaluatedAt, signingKey: ready.signingKey });
          });
        snapshotId = probe.publicPackSnapshotId!;
        offset = Number(probe.lastSortKey);
        if (!Number.isSafeInteger(offset) || offset < 1) throw new PackCatalogCursorError();
      } catch {
        // Everything inside is cursor decoding: a signature, shape, or base64 defect is one bounded outcome.
        return readError("CURSOR_EXPIRED");
      }
    }
    const root = await loadPackSnapshot(ctx, snapshotId);
    if (root === null || root.state !== "complete" || root.publicRepackId !== input.publicRepackId) {
      return readError(snapshotId === head.activeSnapshot.publicPackSnapshotId ? "CATALOG_UNAVAILABLE" : "CURSOR_EXPIRED");
    }
    const manifest = root.descriptor.batches;
    const contents: Doc<"publicPackSnapshotBatches">["records"] = [];
    let cursorOffset = 0;
    for (const entry of manifest) {
      const batchEnd = cursorOffset + entry.recordCount;
      if (batchEnd <= offset) { cursorOffset = batchEnd; continue; }
      const batch = await ctx.db.query("publicPackSnapshotBatches")
        .withIndex("by_public_pack_snapshot_id_and_batch_index", (index) => index.eq("publicPackSnapshotId", snapshotId).eq("batchIndex", entry.batchIndex))
        .take(1);
      if (batch[0] === undefined || batch[0].batchSha256 !== entry.batchSha256) return readError("CATALOG_UNAVAILABLE");
      const records = batch[0].records.slice(Math.max(0, offset - cursorOffset));
      contents.push(...records.slice(0, input.contentPageSize - contents.length));
      cursorOffset = batchEnd;
      if (contents.length >= input.contentPageSize) break;
    }
    const nextOffset = offset + contents.length;
    const dependencies = await ctx.db.query("publicPackSnapshotBatchDependencies")
      .withIndex("by_public_pack_snapshot_id_and_batch_index", (index) => index.eq("publicPackSnapshotId", snapshotId))
      .take(manifest.length + 1);
    if (dependencies.length !== manifest.length) return readError("CATALOG_UNAVAILABLE");
    const valuationDependencyIdentities = [...new Set(dependencies.flatMap((row) => row.valuationDependencyIdentities))].sort(compareCanonicalStrings);
    const header = root.header;
    const providerProfile = await currentProviderProfile(ctx, new Map(), root.providerId);
    if (providerProfile === null) return readError("CATALOG_UNAVAILABLE");
    const nextContentsCursor = nextOffset < header.contentCount
      ? await issuePackCatalogCursor({ binding: bindingFor(snapshotId), lastSortKey: String(nextOffset), lastStableId: input.publicRepackId, issuedAt: ready.evaluatedAt, signingKey: ready.signingKey })
      : null;
    return {
      ok: true,
      data: {
        evaluatedAt: ready.evaluatedAt,
        snapshot: {
          providerId: root.providerId, publicRepackId: root.publicRepackId, publicPackSnapshotId: root.publicPackSnapshotId,
          contentSha256: root.contentSha256, summarySha256: root.summarySha256, dataAsOf: root.dataAsOf,
          evMethodIdentity: root.evMethodIdentity, evPolicyIdentity: root.evPolicyIdentity,
        },
        summary: header.summaryProjection,
        detail: {
          providerProfileSnapshotId: header.providerProfileSnapshotId,
          dataAsOf: header.dataAsOf,
          actions: header.actions,
          probabilityInputsSha256: header.probabilityInputsSha256,
          valuationDependencyIdentities,
          valuationsSha256: header.valuationsSha256,
          evMethodIdentity: header.evMethodIdentity,
          evPolicyIdentity: header.evPolicyIdentity,
          evInputsSha256: header.evInputsSha256,
          economicsSha256: header.economicsSha256,
          searchProjection: header.searchProjection,
        },
        providerProfile,
        contents,
        contentCount: header.contentCount,
        nextContentsCursor,
      },
    };
  },
});

export const searchPublicCollectiblesAtTime = internalQuery({
  args: readArgs,
  handler: async (ctx, args): Promise<Result<unknown>> => {
    const ready = await prelude(ctx, args, (value) => packCatalogV1QueryContracts.searchPublicCollectibles.input.safeParse(value));
    if (!ready.ok) return ready.error;
    const input = ready.input;
    const binding: PackCatalogCursorBinding = {
      operation: "searchPublicCollectibles",
      filters: { query: input.query, categoryIds: input.categoryIds, retirements: input.lifecycle.retirements, availabilities: input.lifecycle.availabilities },
      sort: "display_name", direction: "asc", pageSize: input.pageSize, publicPackSnapshotId: null,
    };
    let position: { sortKey: string; publicCollectibleId: string } | null = null;
    if (input.cursor !== null) {
      try {
        const payload = await readPackCatalogCursor({ cursor: input.cursor, binding, now: ready.evaluatedAt, signingKey: ready.signingKey });
        position = { sortKey: payload.lastSortKey, publicCollectibleId: payload.lastStableId };
      } catch (error) {
        if (error instanceof PackCatalogCursorError) return readError("CURSOR_EXPIRED");
        throw error;
      }
    }
    const matches = (head: Doc<"activeCollectibleProfileHeads">) =>
      head.searchText.includes(input.query) &&
      (input.categoryIds.length === 0 || input.categoryIds.includes(head.publicCategoryId));
    const segments = position === null
      ? [ctx.db.query("activeCollectibleProfileHeads").withIndex("by_sort_display_name_and_public_collectible_id")]
      : [
        ctx.db.query("activeCollectibleProfileHeads").withIndex("by_sort_display_name_and_public_collectible_id", (index) =>
          index.eq("sortDisplayName", position!.sortKey).gt("publicCollectibleId", position!.publicCollectibleId)),
        ctx.db.query("activeCollectibleProfileHeads").withIndex("by_sort_display_name_and_public_collectible_id", (index) =>
          index.gt("sortDisplayName", position!.sortKey)),
      ];
    const heads: Doc<"activeCollectibleProfileHeads">[] = [];
    let hasMore = false;
    let scanned = 0;
    let resume: Doc<"activeCollectibleProfileHeads"> | null = null;
    outer: for (const segment of segments) {
      for await (const head of segment) {
        scanned += 1;
        if (matches(head)) {
          if (heads.length === input.pageSize) { hasMore = true; resume = heads[heads.length - 1]!; break outer; }
          heads.push(head);
        }
        // Budget truncation continues after the last head examined, matched or not.
        if (scanned >= PACK_CATALOG_HEAD_SCAN_LIMIT) { hasMore = true; resume = head; break outer; }
      }
    }
    const items = [];
    for (const head of heads) {
      const root = await loadProfileSnapshot(ctx, head.activeProfileSnapshotId);
      const profile = root?.profile ?? null;
      const parsed = publicCollectibleProfileSchema.safeParse(profile);
      if (root === null || root.state !== "complete" || !parsed.success || parsed.data.identity.publicCollectibleId !== head.publicCollectibleId) {
        return readError("CATALOG_UNAVAILABLE");
      }
      items.push(parsed.data);
    }
    const nextCursor = hasMore && resume !== null
      ? await issuePackCatalogCursor({ binding, lastSortKey: resume.sortDisplayName, lastStableId: resume.publicCollectibleId, issuedAt: ready.evaluatedAt, signingKey: ready.signingKey })
      : null;
    return { ok: true, data: { evaluatedAt: ready.evaluatedAt, items, nextCursor } };
  },
});

export const findPacksByDesiredCollectibleAtTime = internalQuery({
  args: readArgs,
  handler: async (ctx, args): Promise<Result<unknown>> => {
    const ready = await prelude(ctx, args, (value) => packCatalogV1QueryContracts.findPacksByDesiredCollectible.input.safeParse(value));
    if (!ready.ok) return ready.error;
    const input = ready.input;
    if (await loadCollectibleProfileHead(ctx, input.publicCollectibleId) === null) return readError("COLLECTIBLE_NOT_FOUND");
    // Skip-scan the membership index one distinct pack at a time, so the cost
    // follows the number of packs containing the collectible, not the number
    // of retained snapshot versions; each pack counts only if its active
    // snapshot still contains the collectible.
    const candidates: PackHead[] = [];
    let lastPackId = "";
    let distinctPacks = 0;
    for (;;) {
      const next = await ctx.db.query("publicPackMemberships")
        .withIndex("by_collectible_and_repack_and_snapshot", (index) =>
          index.eq("publicCollectibleId", input.publicCollectibleId).gt("publicRepackId", lastPackId))
        .take(1);
      const membership = next[0];
      if (membership === undefined) break;
      distinctPacks += 1;
      if (distinctPacks > PACK_CATALOG_MEMBERSHIP_SCAN_LIMIT) return readError("CATALOG_UNAVAILABLE");
      lastPackId = membership.publicRepackId;
      const head = await loadPackHead(ctx, membership.publicRepackId);
      if (head === null) continue;
      const active = await ctx.db.query("publicPackMemberships")
        .withIndex("by_collectible_and_repack_and_snapshot", (index) =>
          index.eq("publicCollectibleId", input.publicCollectibleId).eq("publicRepackId", head.publicRepackId)
            .eq("publicPackSnapshotId", head.activeSnapshot.publicPackSnapshotId))
        .take(1);
      if (active.length === 1) candidates.push(head);
    }
    const page = await pagedHeads(ctx, {
      operation: "findPacksByDesiredCollectible",
      filters: { publicCollectibleId: input.publicCollectibleId, retirements: input.lifecycle.retirements, availabilities: input.lifecycle.availabilities },
      sort: input.sort, direction: input.direction, pageSize: input.pageSize, cursor: input.cursor,
      evaluatedAt: ready.evaluatedAt, signingKey: ready.signingKey,
      matches: (head) => lifecycleMatches(head, input.lifecycle),
      candidates,
    });
    return page.ok ? { ok: true, data: { evaluatedAt: ready.evaluatedAt, publicCollectibleId: input.publicCollectibleId, ...page.data } } : page;
  },
});

const publicArgs = { request: v.optional(v.any()), ...catalogReadTokenArg };

export const getPublicShellStatus = action({
  args: publicArgs,
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> =>
    await ctx.runQuery(internal.packCatalogV1.getPublicShellStatusAtTime, { ...args, currentTime: Date.now() }),
});
export const getDashboardBundle = action({
  args: publicArgs,
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> =>
    await ctx.runQuery(internal.packCatalogV1.getDashboardBundleAtTime, { ...args, currentTime: Date.now() }),
});
export const listPublicPacks = action({
  args: publicArgs,
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> =>
    await ctx.runQuery(internal.packCatalogV1.listPublicPacksAtTime, { ...args, currentTime: Date.now() }),
});
export const getPublicPack = action({
  args: publicArgs,
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> =>
    await ctx.runQuery(internal.packCatalogV1.getPublicPackAtTime, { ...args, currentTime: Date.now() }),
});
export const searchPublicCollectibles = action({
  args: publicArgs,
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> =>
    await ctx.runQuery(internal.packCatalogV1.searchPublicCollectiblesAtTime, { ...args, currentTime: Date.now() }),
});
export const findPacksByDesiredCollectible = action({
  args: publicArgs,
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> =>
    await ctx.runQuery(internal.packCatalogV1.findPacksByDesiredCollectibleAtTime, { ...args, currentTime: Date.now() }),
});
