import {
  PackCatalogCursorError,
  compareCanonicalStrings,
  issuePackCatalogCursor,
  publicProviderProfileSchema,
  readPackCatalogCursor,
  type PackCatalogCursorBinding,
  type PublicProviderProfile,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { configuredDataReleaseV3CursorSigningKey } from "./dataReleaseV3Pagination";
import { loadProfileSnapshot, loadProviderProfileHead } from "./packCatalogStoreSupport";

/**
 * Head-driven read model for `pack_catalog_v1` (pack-version-publication/005,
 * tech-004). Every list resolves current `activePackHeads` through one index
 * per sort path and advances from the last `(sortKey, publicRepackId)` tuple.
 * Filtering happens after the index range, so each request reads a bounded
 * number of heads; a page may come back short with a live cursor rather than
 * ever scanning without limit.
 */

/** Heads examined per list request before a live cursor continues the scan. */
export const PACK_CATALOG_HEAD_SCAN_LIMIT = 2_000;
/**
 * The catalog-wide ceiling for exact counts (shell status, dashboard totals).
 * Mirrors the V2 release maximum; crossing it is an invariant failure that
 * fails closed rather than reporting a capped number as exact.
 */
export const PACK_CATALOG_MAX_ACTIVE_HEADS = 8_000;
/** Distinct packs examined per desired-collectible lookup before failing closed. */
export const PACK_CATALOG_MEMBERSHIP_SCAN_LIMIT = 2_000;

export type PackSort = "title" | "price" | "ev" | "top_chase";
export type Direction = "asc" | "desc";
export type PackHead = Doc<"activePackHeads">;

const SORT_INDEX = {
  title: "by_sort_title_and_public_repack_id",
  price: "by_sort_price_and_public_repack_id",
  ev: "by_sort_ev_and_public_repack_id",
  top_chase: "by_sort_top_chase_and_public_repack_id",
} as const;
const SORT_FIELD = {
  title: "sortTitle",
  price: "sortPrice",
  ev: "sortEv",
  top_chase: "sortTopChase",
} as const;

/** Per-query cache of each provider's current active profile (null when unavailable). */
export type ProviderProfileCache = Map<string, PublicProviderProfile | null>;

/**
 * The current active provider profile for provider-wide display fields. A
 * missing head, an incomplete snapshot, or a profile that fails the P01 schema
 * reads as unavailable, so only the dependent pack results fail.
 */
export async function currentProviderProfile(
  ctx: QueryCtx,
  cache: ProviderProfileCache,
  providerId: string,
): Promise<PublicProviderProfile | null> {
  const cached = cache.get(providerId);
  if (cached !== undefined) return cached;
  const head = await loadProviderProfileHead(ctx, providerId);
  const root = head === null ? null : await loadProfileSnapshot(ctx, head.activeProfileSnapshotId);
  const parsed = root !== null && root.state === "complete" ? publicProviderProfileSchema.safeParse(root.profile) : null;
  const profile = parsed?.success === true && parsed.data.identity.providerId === providerId ? parsed.data : null;
  cache.set(providerId, profile);
  return profile;
}

/** Keeps only heads whose provider profile is available; returns the sorted joined profiles. */
export async function joinProviderProfiles(
  ctx: QueryCtx,
  heads: readonly PackHead[],
): Promise<{ readonly heads: PackHead[]; readonly providerProfiles: PublicProviderProfile[] }> {
  const cache: ProviderProfileCache = new Map();
  const kept: PackHead[] = [];
  for (const head of heads) {
    if (await currentProviderProfile(ctx, cache, head.providerId) !== null) kept.push(head);
  }
  const providerProfiles = [...new Set(kept.map(({ providerId }) => providerId))]
    .sort(compareCanonicalStrings)
    .map((providerId) => cache.get(providerId)!)
    .filter((profile): profile is PublicProviderProfile => profile !== null);
  return { heads: kept, providerProfiles };
}

export function cursorSigningKeyBytes(): Uint8Array | null {
  const key = configuredDataReleaseV3CursorSigningKey();
  return key === null ? null : new TextEncoder().encode(key);
}

export function packSortKey(head: PackHead, sort: PackSort): string | number {
  return head[SORT_FIELD[sort]];
}

export function comparePackHeads(sort: PackSort, direction: Direction) {
  const sign = direction === "asc" ? 1 : -1;
  return (left: PackHead, right: PackHead): number => {
    const leftKey = packSortKey(left, sort);
    const rightKey = packSortKey(right, sort);
    const byKey = typeof leftKey === "number" && typeof rightKey === "number"
      ? leftKey - rightKey
      : compareCanonicalStrings(String(leftKey), String(rightKey));
    return sign * (byKey || compareCanonicalStrings(left.publicRepackId, right.publicRepackId));
  };
}

export function packSummaryOf(head: PackHead) {
  return {
    ...head.indexableSummary,
    publicPackSnapshotId: head.activeSnapshot.publicPackSnapshotId,
    contentSha256: head.activeSnapshot.contentSha256,
    headGeneration: head.generation,
  };
}

export function lifecycleMatches(
  head: PackHead,
  lifecycle: { readonly retirements: readonly string[]; readonly availabilities: readonly string[] },
): boolean {
  return lifecycle.retirements.includes(head.retirement) &&
    lifecycle.availabilities.includes(head.availability);
}

export function packFilterMatches(
  head: PackHead,
  input: {
    readonly lifecycle: { readonly retirements: readonly string[]; readonly availabilities: readonly string[] };
    readonly query?: string;
    readonly providerIds?: readonly string[];
    readonly categoryIds?: readonly string[];
  },
): boolean {
  return lifecycleMatches(head, input.lifecycle) &&
    (input.query === undefined || input.query === "" || head.normalizedText.includes(input.query)) &&
    (input.providerIds === undefined || input.providerIds.length === 0 || input.providerIds.includes(head.providerId)) &&
    (input.categoryIds === undefined || input.categoryIds.length === 0 ||
      head.categoryIds.some((categoryId) => input.categoryIds!.includes(categoryId)));
}

export interface KeysetPosition {
  readonly sortKey: string | number;
  readonly publicRepackId: string;
}

/**
 * Reads heads in `(sortKey, publicRepackId)` order after `position`, keeping
 * those that pass `matches`, until the page is full or the scan budget ends.
 * `hasMore` is true only when a further matching head was observed.
 */
export async function scanPackHeads(ctx: QueryCtx, input: {
  readonly sort: PackSort;
  readonly direction: Direction;
  readonly position: KeysetPosition | null;
  readonly pageSize: number;
  readonly matches: (head: PackHead) => boolean;
  readonly scanLimit?: number;
}): Promise<{ readonly items: PackHead[]; readonly hasMore: boolean; readonly scanned: number; readonly resume: KeysetPosition | null }> {
  const field = SORT_FIELD[input.sort];
  const indexName = SORT_INDEX[input.sort];
  const items: PackHead[] = [];
  let scanned = 0;
  let hasMore = false;
  const budget = input.scanLimit ?? PACK_CATALOG_HEAD_SCAN_LIMIT;
  const positionOf = (head: PackHead): KeysetPosition => ({ sortKey: packSortKey(head, input.sort), publicRepackId: head.publicRepackId });
  const segments: Array<AsyncIterable<PackHead>> = [];
  const after = input.position;
  const forward = input.direction === "asc";
  if (after !== null) {
    segments.push(ctx.db.query("activePackHeads")
      .withIndex(indexName, (index) => {
        const tie = (index as unknown as { eq: (f: string, v: unknown) => { gt: (f: string, v: unknown) => unknown; lt: (f: string, v: unknown) => unknown } })
          .eq(field, after.sortKey);
        return (forward ? tie.gt("publicRepackId", after.publicRepackId) : tie.lt("publicRepackId", after.publicRepackId)) as never;
      })
      .order(input.direction));
    segments.push(ctx.db.query("activePackHeads")
      .withIndex(indexName, (index) => {
        const range = index as unknown as { gt: (f: string, v: unknown) => unknown; lt: (f: string, v: unknown) => unknown };
        return (forward ? range.gt(field, after.sortKey) : range.lt(field, after.sortKey)) as never;
      })
      .order(input.direction));
  } else {
    segments.push(ctx.db.query("activePackHeads").withIndex(indexName).order(input.direction));
  }
  for (const segment of segments) {
    for await (const head of segment) {
      scanned += 1;
      if (input.matches(head)) {
        if (items.length === input.pageSize) {
          hasMore = true;
          return { items, hasMore, scanned, resume: positionOf(items[items.length - 1]!) };
        }
        items.push(head);
      }
      // The budget truncated the scan: continue after the last head examined,
      // matched or not, so a sparse filter never hides later matches.
      if (scanned >= budget) return { items, hasMore: true, scanned, resume: positionOf(head) };
    }
  }
  return { items, hasMore, scanned, resume: null };
}

export async function issueListCursor(input: {
  readonly binding: PackCatalogCursorBinding;
  readonly last: KeysetPosition;
  readonly issuedAt: string;
  readonly signingKey: Uint8Array;
}): Promise<string> {
  return await issuePackCatalogCursor({
    binding: input.binding,
    lastSortKey: String(input.last.sortKey),
    lastStableId: input.last.publicRepackId,
    issuedAt: input.issuedAt,
    signingKey: input.signingKey,
  });
}

/** Decodes a live list cursor into a keyset position; any defect is `CURSOR_EXPIRED`. */
export async function readListCursor(input: {
  readonly cursor: string;
  readonly binding: PackCatalogCursorBinding;
  readonly numeric: boolean;
  readonly now: string;
  readonly signingKey: Uint8Array;
}): Promise<KeysetPosition> {
  const payload = await readPackCatalogCursor({
    cursor: input.cursor,
    binding: input.binding,
    now: input.now,
    signingKey: input.signingKey,
  });
  if (!input.numeric) return { sortKey: payload.lastSortKey, publicRepackId: payload.lastStableId };
  const value = Number(payload.lastSortKey);
  if (!Number.isSafeInteger(value) || String(value) !== payload.lastSortKey) throw new PackCatalogCursorError();
  return { sortKey: value, publicRepackId: payload.lastStableId };
}
