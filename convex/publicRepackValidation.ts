import {
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  repackSearchRowFromDetail,
  repackSearchRowSchema,
  decodePublicCursorStack,
  normalizeDashboardQueryInput,
  normalizeListPublicRepacksInput,
  normalizePublicSearchText,
  type DashboardQueryInput,
  type ListPublicRepacksInput,
  type PublicRepackFilters,
  type PublicRepackDetail,
  type PublicRepackSort,
  type RepackSearchRow,
} from "@packscout/contracts";
import { v } from "convex/values";
import { canonicalJson } from "./dataReleaseCanonicalHash";

export const MAX_PUBLIC_REPACKS = MAX_PUBLIC_REPACKS_PER_RELEASE;
export {
  MAX_REPACK_SEARCH_SHARDS,
  MAX_ROWS_PER_REPACK_SEARCH_SHARD,
  type RepackSearchRow,
} from "@packscout/contracts";

const nullableNumberValidator = v.union(v.number(), v.null());
const nullRankValidator = v.union(v.literal(0), v.literal(1));
const confidenceBandValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.null(),
);
const collectibleTypeValidator = v.union(
  v.literal("card"),
  v.literal("watch"),
  v.literal("coin"),
  v.literal("sealed_product"),
  v.literal("memorabilia"),
  v.literal("other"),
);

export const repackSearchRowValidator = v.object({
  publicRepackId: v.string(),
  publicVendorId: v.string(),
  vendorKey: v.string(),
  vendorDisplayName: v.string(),
  publicCategoryIds: v.array(v.string()),
  categoryLabels: v.array(v.string()),
  collectibleTypes: v.array(collectibleTypeValidator),
  contentMode: v.union(
    v.literal("focused"),
    v.literal("mixed"),
    v.literal("unknown"),
  ),
  name: v.string(),
  normalizedName: v.string(),
  normalizedVendor: v.string(),
  normalizedCategories: v.string(),
  availability: v.union(v.literal("active"), v.literal("sold_out")),
  priceMinor: nullableNumberValidator,
  priceNullRank: nullRankValidator,
  vendorReportedGrossEvMinor: nullableNumberValidator,
  vendorReportedGrossEvNullRank: nullRankValidator,
  vendorReportedEvDollarsMinor: nullableNumberValidator,
  vendorReportedEvDollarsNullRank: nullRankValidator,
  vendorReportedEvPercentBasisPoints: nullableNumberValidator,
  vendorReportedEvPercentNullRank: nullRankValidator,
  packScoutGrossEvMinor: nullableNumberValidator,
  packScoutGrossEvNullRank: nullRankValidator,
  packScoutEvDollarsMinor: nullableNumberValidator,
  packScoutEvDollarsNullRank: nullRankValidator,
  packScoutEvPercentBasisPoints: nullableNumberValidator,
  packScoutEvPercentNullRank: nullRankValidator,
  packScoutConfidenceBasisPoints: nullableNumberValidator,
  packScoutConfidenceNullRank: nullRankValidator,
  packScoutConfidenceBand: confidenceBandValidator,
  buybackBasisPoints: nullableNumberValidator,
  buybackNullRank: nullRankValidator,
  topChaseValueMinor: nullableNumberValidator,
  topChaseNullRank: nullRankValidator,
  topChaseReason: v.union(
    v.literal("CURRENCY_UNSUPPORTED"),
    v.literal("CHASE_UNAVAILABLE"),
    v.literal("VALUATION_UNAVAILABLE"),
    v.null(),
  ),
});

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

export function parseRepackListRequest(
  input: unknown,
): ValidationResult<ListPublicRepacksInput> {
  try {
    return { ok: true, value: normalizeListPublicRepacksInput(input) };
  } catch {
    return { ok: false };
  }
}

type CursorEnvelope = {
  readonly version: 2;
  readonly publicReleaseId: string;
  readonly queryFingerprint: string;
  readonly offset: number;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    record.version === 2 &&
    typeof record.publicReleaseId === "string" &&
    UUID_PATTERN.test(record.publicReleaseId) &&
    typeof record.queryFingerprint === "string" &&
    SHA256_PATTERN.test(record.queryFingerprint) &&
    typeof record.offset === "number" &&
    Number.isSafeInteger(record.offset) &&
    record.offset >= 0
  );
}

export function encodeRepackCursor(cursor: CursorEnvelope): string {
  return encodeBase64Url(JSON.stringify(cursor));
}

export function decodeRepackCursor(value: string): CursorEnvelope | null {
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
  publicReleaseId: string,
  input: ListPublicRepacksInput,
): string {
  return JSON.stringify({
    publicReleaseId,
    search: input.search,
    filters: input.filters,
    sort: input.sort,
    direction: input.direction,
    pageSize: input.pageSize,
    desiredPublicCollectibleId: input.desiredPublicCollectibleId,
  });
}

export async function createQueryFingerprint(
  publicReleaseId: string,
  input: ListPublicRepacksInput,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalFingerprintInput(publicReleaseId, input)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function validateCursorSet(input: {
  readonly cursor: string | null;
  readonly cursorStack: string | null;
  readonly expectedFingerprint: string;
  readonly expectedReleaseId: string;
  readonly pageSize: number;
}): ValidationResult<{
  readonly cursor: CursorEnvelope | null;
  readonly stack: readonly CursorEnvelope[];
}> {
  const cursor = input.cursor === null ? null : decodeRepackCursor(input.cursor);
  if (input.cursor !== null && cursor === null) return { ok: false };
  const encodedStack = decodeCursorStack(input.cursorStack);
  if (encodedStack === null) return { ok: false };
  const stack = encodedStack.map(decodeRepackCursor);
  if (stack.some((entry) => entry === null)) return { ok: false };
  const envelopes = stack as CursorEnvelope[];
  const validEnvelope = (entry: CursorEnvelope) =>
    entry.publicReleaseId === input.expectedReleaseId &&
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
  row: RepackSearchRow,
  normalizedSearch: string,
): boolean {
  if (normalizedSearch === "") return true;
  const queryTokens = normalizedSearch.split(" ");
  const candidateTokens = [
    ...row.normalizedName.split(" "),
    ...row.normalizedVendor.split(" "),
    ...row.normalizedCategories.split(" "),
  ];
  return queryTokens.every((queryToken) =>
    candidateTokens.some((candidate) => candidate.startsWith(queryToken)),
  );
}

export function isValidRepackSearchRow(row: RepackSearchRow): boolean {
  return repackSearchRowSchema.safeParse(row).success;
}

function relevance(row: RepackSearchRow, normalizedSearch: string) {
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
    Exclude<PublicRepackSort, "repack">,
    readonly [keyof RepackSearchRow & string, keyof RepackSearchRow & string]
  >
> = {
  repack_price: ["priceMinor", "priceNullRank"],
  packscout_ev_dollars: [
    "packScoutEvDollarsMinor",
    "packScoutEvDollarsNullRank",
  ],
  packscout_ev_percent: [
    "packScoutEvPercentBasisPoints",
    "packScoutEvPercentNullRank",
  ],
  vendor_reported_ev_percent: [
    "vendorReportedEvPercentBasisPoints",
    "vendorReportedEvPercentNullRank",
  ],
  packscout_confidence: [
    "packScoutConfidenceBasisPoints",
    "packScoutConfidenceNullRank",
  ],
  buyback_percent: ["buybackBasisPoints", "buybackNullRank"],
  packscout_gross_ev: ["packScoutGrossEvMinor", "packScoutGrossEvNullRank"],
  top_chase_value: ["topChaseValueMinor", "topChaseNullRank"],
};

export function compareRepackRows(
  left: RepackSearchRow,
  right: RepackSearchRow,
  input: Pick<ListPublicRepacksInput, "search" | "sort" | "direction">,
): number {
  if (input.search !== "") {
    const leftRelevance = relevance(left, input.search);
    const rightRelevance = relevance(right, input.search);
    return (
      leftRelevance.tier - rightRelevance.tier ||
      rightRelevance.matchingNameTokens - leftRelevance.matchingNameTokens ||
      compareText(left.normalizedName, right.normalizedName) ||
      compareText(left.publicRepackId, right.publicRepackId)
    );
  }
  if (input.sort === "repack") {
    const nameComparison = compareText(left.normalizedName, right.normalizedName);
    return (
      (input.direction === "asc" ? nameComparison : -nameComparison) ||
      compareText(left.publicRepackId, right.publicRepackId)
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
    ) || compareText(left.publicRepackId, right.publicRepackId)
  );
}

export function rowMatchesFilters(
  row: RepackSearchRow,
  filters: PublicRepackFilters,
  options: {
    readonly ignoreVendors?: boolean;
    readonly ignoreCategories?: boolean;
  } = {},
): boolean {
  if (
    !options.ignoreVendors &&
    filters.vendors.length > 0 &&
    !filters.vendors.includes(row.vendorKey)
  ) {
    return false;
  }
  if (
    !options.ignoreCategories &&
    filters.categories.length > 0 &&
    !filters.categories.some((publicCategoryId) =>
      row.publicCategoryIds.includes(publicCategoryId),
    )
  ) {
    return false;
  }
  if (
    filters.collectibleTypes.length > 0 &&
    !filters.collectibleTypes.some((type) => row.collectibleTypes.includes(type))
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

export const searchRowFromRepackDetail = repackSearchRowFromDetail;

export function repackSearchRowMatchesDetail(
  row: RepackSearchRow,
  detail: PublicRepackDetail,
): boolean {
  return canonicalJson(row) === canonicalJson(searchRowFromRepackDetail(detail));
}
