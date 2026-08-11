import {
  decodePublicCursorStack,
  normalizeDashboardQueryInput,
  normalizeListPublicPacksInput,
  normalizePublicSearchText,
  type DashboardQueryInput,
  type ListPublicPacksInput,
  type PublicCatalogFilters,
  type PublicCatalogSort,
} from "@packscout/contracts";
import { v } from "convex/values";

export const MAX_PUBLIC_PACKS = 10_000;
export const MAX_ROWS_PER_QUERY_SHARD = 96;
export const MAX_QUERY_SHARDS = Math.ceil(
  MAX_PUBLIC_PACKS / MAX_ROWS_PER_QUERY_SHARD,
);

const nullableNumberValidator = v.union(v.number(), v.null());
const nullRankValidator = v.union(v.literal(0), v.literal(1));
const availabilityReasonValidator = v.union(
  v.literal("CURRENCY_UNSUPPORTED"),
  v.literal("CHASE_UNAVAILABLE"),
  v.null(),
);

export const catalogQueryRowValidator = v.object({
  publicPackId: v.string(),
  platformKey: v.string(),
  platformDisplayName: v.string(),
  categoryKey: v.string(),
  category: v.string(),
  name: v.string(),
  normalizedName: v.string(),
  normalizedPlatform: v.string(),
  normalizedCategory: v.string(),
  availability: v.union(v.literal("active"), v.literal("sold_out")),
  priceMinor: nullableNumberValidator,
  priceNullRank: nullRankValidator,
  grossEvMinor: nullableNumberValidator,
  grossEvNullRank: nullRankValidator,
  evDollarsMinor: nullableNumberValidator,
  evDollarsNullRank: nullRankValidator,
  evPercentBasisPoints: nullableNumberValidator,
  evPercentNullRank: nullRankValidator,
  buybackBasisPoints: nullableNumberValidator,
  buybackNullRank: nullRankValidator,
  topChaseValueMinor: nullableNumberValidator,
  topChaseNullRank: nullRankValidator,
  topChaseReason: availabilityReasonValidator,
});

export type CatalogQueryRow = {
  readonly publicPackId: string;
  readonly platformKey: string;
  readonly platformDisplayName: string;
  readonly categoryKey: string;
  readonly category: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly normalizedPlatform: string;
  readonly normalizedCategory: string;
  readonly availability: "active" | "sold_out";
  readonly priceMinor: number | null;
  readonly priceNullRank: 0 | 1;
  readonly grossEvMinor: number | null;
  readonly grossEvNullRank: 0 | 1;
  readonly evDollarsMinor: number | null;
  readonly evDollarsNullRank: 0 | 1;
  readonly evPercentBasisPoints: number | null;
  readonly evPercentNullRank: 0 | 1;
  readonly buybackBasisPoints: number | null;
  readonly buybackNullRank: 0 | 1;
  readonly topChaseValueMinor: number | null;
  readonly topChaseNullRank: 0 | 1;
  readonly topChaseReason:
    | "CURRENCY_UNSUPPORTED"
    | "CHASE_UNAVAILABLE"
    | null;
};

type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

export function parseDashboardRequest(
  input: unknown,
): ValidationResult<DashboardQueryInput> {
  try {
    return { ok: true, value: normalizeDashboardQueryInput(input) };
  } catch {
    return { ok: false };
  }
}

export function parseCatalogRequest(
  input: unknown,
): ValidationResult<ListPublicPacksInput> {
  try {
    return { ok: true, value: normalizeListPublicPacksInput(input) };
  } catch {
    return { ok: false };
  }
}

type CursorEnvelope = {
  readonly version: 1;
  readonly snapshotPublicationId: string;
  readonly queryFingerprint: string;
  readonly offset: number;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_PACK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FACET_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/;

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string | null {
  if (!OPAQUE_CURSOR_PATTERN.test(value)) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isCursorEnvelope(value: unknown): value is CursorEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    record.version === 1 &&
    typeof record.snapshotPublicationId === "string" &&
    UUID_PATTERN.test(record.snapshotPublicationId) &&
    typeof record.queryFingerprint === "string" &&
    SHA256_PATTERN.test(record.queryFingerprint) &&
    typeof record.offset === "number" &&
    Number.isSafeInteger(record.offset) &&
    record.offset >= 0
  );
}

export function encodeCatalogCursor(cursor: CursorEnvelope): string {
  return encodeBase64Url(JSON.stringify(cursor));
}

export function decodeCatalogCursor(value: string): CursorEnvelope | null {
  const decoded = decodeBase64Url(value);
  if (decoded === null) return null;
  try {
    const parsed: unknown = JSON.parse(decoded);
    return isCursorEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function decodeCursorStack(value: string | null): readonly string[] | null {
  if (value === null) return [];
  return decodePublicCursorStack(value);
}

function canonicalFingerprintInput(
  snapshotPublicationId: string,
  input: ListPublicPacksInput,
): string {
  return JSON.stringify({
    snapshotPublicationId,
    search: input.search,
    platforms: input.filters.platforms,
    categories: input.filters.categories,
    price: input.filters.price,
    sort: input.sort,
    direction: input.direction,
    pageSize: input.pageSize,
  });
}

export async function createQueryFingerprint(
  snapshotPublicationId: string,
  input: ListPublicPacksInput,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      canonicalFingerprintInput(snapshotPublicationId, input),
    ),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function validateCursorSet(input: {
  readonly cursor: string | null;
  readonly cursorStack: string | null;
  readonly expectedFingerprint: string;
  readonly expectedPublicationId: string;
  readonly pageSize: number;
}): ValidationResult<{
  readonly cursor: CursorEnvelope | null;
  readonly stack: readonly CursorEnvelope[];
}> {
  const cursor = input.cursor === null ? null : decodeCatalogCursor(input.cursor);
  if (input.cursor !== null && cursor === null) return { ok: false };
  const encodedStack = decodeCursorStack(input.cursorStack);
  if (encodedStack === null) return { ok: false };
  const stack = encodedStack.map(decodeCatalogCursor);
  if (stack.some((entry) => entry === null)) return { ok: false };
  const envelopes = stack as CursorEnvelope[];
  const validEnvelope = (entry: CursorEnvelope) =>
    entry.snapshotPublicationId === input.expectedPublicationId &&
    entry.queryFingerprint === input.expectedFingerprint &&
    entry.offset % input.pageSize === 0;
  if (
    (cursor !== null && !validEnvelope(cursor)) ||
    !envelopes.every(validEnvelope)
  ) {
    return { ok: false };
  }
  if (
    cursor !== null &&
    envelopes.some((entry) => entry.offset >= cursor.offset)
  ) {
    return { ok: false };
  }
  return { ok: true, value: { cursor, stack: envelopes } };
}

export function rowMatchesSearch(
  row: CatalogQueryRow,
  normalizedSearch: string,
): boolean {
  if (normalizedSearch === "") return true;
  const queryTokens = normalizedSearch.split(" ");
  const candidateTokens = [
    ...row.normalizedName.split(" "),
    ...row.normalizedPlatform.split(" "),
    ...row.normalizedCategory.split(" "),
  ];
  return queryTokens.every((queryToken) =>
    candidateTokens.some((candidate) => candidate.startsWith(queryToken)),
  );
}

function validNullableInteger(
  value: number | null,
  nullRank: 0 | 1,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): boolean {
  if (value === null) return nullRank === 1;
  return (
    nullRank === 0 &&
    Number.isSafeInteger(value) &&
    value >= (options.minimum ?? Number.MIN_SAFE_INTEGER) &&
    value <= (options.maximum ?? Number.MAX_SAFE_INTEGER)
  );
}

export function isValidCatalogQueryRow(row: CatalogQueryRow): boolean {
  return (
    PUBLIC_PACK_ID_PATTERN.test(row.publicPackId) &&
    row.platformKey.length <= 64 &&
    FACET_KEY_PATTERN.test(row.platformKey) &&
    FACET_KEY_PATTERN.test(row.categoryKey) &&
    row.platformDisplayName.length >= 1 &&
    row.platformDisplayName.length <= 100 &&
    row.platformDisplayName.trim() === row.platformDisplayName &&
    row.category.length >= 1 &&
    row.category.length <= 100 &&
    row.category.trim() === row.category &&
    row.name.length >= 1 &&
    row.name.length <= 200 &&
    row.name.trim() === row.name &&
    row.normalizedName === normalizePublicSearchText(row.name) &&
    row.normalizedPlatform ===
      normalizePublicSearchText(row.platformDisplayName) &&
    row.normalizedCategory === normalizePublicSearchText(row.category) &&
    validNullableInteger(row.priceMinor, row.priceNullRank, { minimum: 0 }) &&
    validNullableInteger(row.grossEvMinor, row.grossEvNullRank, {
      minimum: 0,
    }) &&
    validNullableInteger(row.evDollarsMinor, row.evDollarsNullRank) &&
    validNullableInteger(
      row.evPercentBasisPoints,
      row.evPercentNullRank,
    ) &&
    validNullableInteger(row.buybackBasisPoints, row.buybackNullRank, {
      minimum: 0,
      maximum: 10_000,
    }) &&
    validNullableInteger(row.topChaseValueMinor, row.topChaseNullRank, {
      minimum: 0,
    }) &&
    (row.topChaseValueMinor === null
      ? row.topChaseReason !== null
      : row.topChaseReason === null)
  );
}

function relevance(row: CatalogQueryRow, normalizedSearch: string) {
  const queryTokens = normalizedSearch.split(" ");
  const nameTokens = row.normalizedName.split(" ");
  const matchingNameTokens = queryTokens.filter((queryToken) =>
    nameTokens.some((candidate) => candidate.startsWith(queryToken)),
  ).length;
  const tier =
    row.normalizedName === normalizedSearch
      ? 0
      : row.normalizedName.startsWith(`${normalizedSearch} `)
        ? 1
        : matchingNameTokens === queryTokens.length
          ? 2
          : 3;
  return { tier, matchingNameTokens };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullableMetric(
  leftValue: number | null,
  leftNullRank: 0 | 1,
  rightValue: number | null,
  rightNullRank: 0 | 1,
  direction: "asc" | "desc",
): number {
  if (leftNullRank !== rightNullRank) return leftNullRank - rightNullRank;
  if (leftValue === null || rightValue === null) return 0;
  const comparison = leftValue - rightValue;
  return direction === "asc" ? comparison : -comparison;
}

const metricFields: Readonly<
  Record<
    Exclude<PublicCatalogSort, "pack">,
    readonly [
      keyof CatalogQueryRow & string,
      keyof CatalogQueryRow & string,
    ]
  >
> = {
  pack_price: ["priceMinor", "priceNullRank"],
  ev_dollars: ["evDollarsMinor", "evDollarsNullRank"],
  ev_percent: ["evPercentBasisPoints", "evPercentNullRank"],
  buyback_percent: ["buybackBasisPoints", "buybackNullRank"],
  gross_ev: ["grossEvMinor", "grossEvNullRank"],
  top_chase_value: ["topChaseValueMinor", "topChaseNullRank"],
};

export function compareCatalogRows(
  left: CatalogQueryRow,
  right: CatalogQueryRow,
  input: Pick<ListPublicPacksInput, "search" | "sort" | "direction">,
): number {
  if (input.search !== "") {
    const leftRelevance = relevance(left, input.search);
    const rightRelevance = relevance(right, input.search);
    return (
      leftRelevance.tier - rightRelevance.tier ||
      rightRelevance.matchingNameTokens - leftRelevance.matchingNameTokens ||
      compareText(left.normalizedName, right.normalizedName) ||
      compareText(left.publicPackId, right.publicPackId)
    );
  }
  if (input.sort === "pack") {
    const nameComparison = compareText(left.normalizedName, right.normalizedName);
    return (
      (input.direction === "asc" ? nameComparison : -nameComparison) ||
      compareText(left.publicPackId, right.publicPackId)
    );
  }
  const [valueField, rankField] = metricFields[input.sort];
  return (
    compareNullableMetric(
      left[valueField] as number | null,
      left[rankField] as 0 | 1,
      right[valueField] as number | null,
      right[rankField] as 0 | 1,
      input.direction,
    ) || compareText(left.publicPackId, right.publicPackId)
  );
}

export function rowMatchesFilters(
  row: CatalogQueryRow,
  filters: PublicCatalogFilters,
  options: {
    readonly ignorePlatforms?: boolean;
    readonly ignoreCategories?: boolean;
  } = {},
): boolean {
  if (
    !options.ignorePlatforms &&
    filters.platforms.length > 0 &&
    !filters.platforms.includes(row.platformKey)
  ) {
    return false;
  }
  if (
    !options.ignoreCategories &&
    filters.categories.length > 0 &&
    !filters.categories.includes(row.categoryKey)
  ) {
    return false;
  }
  if (filters.price.mode === "narrowed") {
    return (
      row.priceMinor !== null &&
      row.priceMinor >= filters.price.minMinor &&
      row.priceMinor <= filters.price.maxMinor
    );
  }
  return true;
}

export function queryRowFromPack(input: {
  readonly publicPackId: string;
  readonly platformKey: string;
  readonly platformDisplayName: string;
  readonly category: string;
  readonly name: string;
  readonly availability: "active" | "sold_out";
  readonly priceMinor: number | null;
  readonly grossEvMinor: number | null;
  readonly evDollarsMinor: number | null;
  readonly evPercentBasisPoints: number | null;
  readonly buybackBasisPoints: number | null;
  readonly topChaseValueMinor: number | null;
  readonly topChaseReason: CatalogQueryRow["topChaseReason"];
}): CatalogQueryRow {
  return {
    ...input,
    categoryKey: normalizePublicSearchText(input.category).replace(/ /g, "_"),
    normalizedName: normalizePublicSearchText(input.name),
    normalizedPlatform: normalizePublicSearchText(input.platformDisplayName),
    normalizedCategory: normalizePublicSearchText(input.category),
    priceNullRank: input.priceMinor === null ? 1 : 0,
    grossEvNullRank: input.grossEvMinor === null ? 1 : 0,
    evDollarsNullRank: input.evDollarsMinor === null ? 1 : 0,
    evPercentNullRank: input.evPercentBasisPoints === null ? 1 : 0,
    buybackNullRank: input.buybackBasisPoints === null ? 1 : 0,
    topChaseNullRank: input.topChaseValueMinor === null ? 1 : 0,
  };
}
