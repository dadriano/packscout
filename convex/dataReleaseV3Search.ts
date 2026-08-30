import {
  normalizePublicSearchText,
  repackEvSortRowV3FromDetail,
  repackEvSortRowV3Schema,
  type PackScoutDisplayedEvV3,
  type PublicRepackDetailV3,
  type RepackEvSortRowV3,
} from "@packscout/contracts";
import { v } from "convex/values";
import { canonicalJson } from "./dataReleaseCanonicalHash";
import { publicPackAvailabilityValidator } from "./publicRepackValidation";

/**
 * data_release_v3 search rows (task buyback-adjusted-ev/008).
 *
 * A search row is the bounded sortable/filterable projection of exactly one
 * staged `PublicRepackDetailV3`. The EV component is the task-007
 * `RepackEvSortRowV3` — the only sortable EV values a public read may
 * materialize — and every other field is a deterministic derivation of the
 * same detail. Rows are derived server-side inside the same mutation that
 * stages each repack batch, so a staged row can never drift from its detail,
 * and reads re-prove the derivation before trusting a row.
 */

export const DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION =
  "repack_ev_search_v3" as const;

/** Bounded launch capacity for one data_release_v3 release. */
export const MAX_DATA_RELEASE_V3_REPACKS = 1_000;
export const MAX_ROWS_PER_DATA_RELEASE_V3_SHARD = 32;
export const MAX_DATA_RELEASE_V3_SHARDS = Math.ceil(
  MAX_DATA_RELEASE_V3_REPACKS / MAX_ROWS_PER_DATA_RELEASE_V3_SHARD,
);
export const MAX_DATA_RELEASE_V3_CATEGORIES = 512;
export const MAX_DATA_RELEASE_V3_COLLECTIBLES = 20_000;
export const MAX_DATA_RELEASE_V3_CHASES = 50_000;

const nullableNumberValidator = v.union(v.number(), v.null());
const nullRankValidator = v.union(v.literal(0), v.literal(1));

export const dataReleaseV3SearchRowValidator = v.object({
  publicRepackId: v.string(),
  publicVendorId: v.string(),
  vendorKey: v.string(),
  vendorDisplayName: v.string(),
  publicCategoryIds: v.array(v.string()),
  categoryLabels: v.array(v.string()),
  collectibleTypes: v.array(
    v.union(
      v.literal("card"),
      v.literal("watch"),
      v.literal("coin"),
      v.literal("sealed_product"),
      v.literal("memorabilia"),
      v.literal("other"),
    ),
  ),
  contentMode: v.union(
    v.literal("focused"),
    v.literal("mixed"),
    v.literal("unknown"),
  ),
  name: v.string(),
  normalizedName: v.string(),
  normalizedVendor: v.string(),
  normalizedCategories: v.string(),
  // The canonical four-state pack availability, identical to the validator
  // `publicRepackDetailV3Validator` uses for the detail this row projects.
  // data_release_v3 rows are written only by this feature's own staging path,
  // so they carry the current vocabulary exactly and never the retired
  // active/disabled values that `storedPackAvailabilityValidator` tolerates
  // for pre-existing v2 tables.
  availability: publicPackAvailabilityValidator,
  priceMinor: nullableNumberValidator,
  priceNullRank: nullRankValidator,
  buybackRateBasisPoints: nullableNumberValidator,
  buybackRateNullRank: nullRankValidator,
  topChaseValueMinor: nullableNumberValidator,
  topChaseNullRank: nullRankValidator,
  topChaseReason: v.union(
    v.literal("CURRENCY_UNSUPPORTED"),
    v.literal("CHASE_UNAVAILABLE"),
    v.literal("VALUATION_UNAVAILABLE"),
    v.null(),
  ),
  packScoutEvDollarsMinor: nullableNumberValidator,
  packScoutEvDollarsNullRank: nullRankValidator,
  packScoutGrossEvMinor: nullableNumberValidator,
  packScoutGrossEvNullRank: nullRankValidator,
  packScoutEvPercentBasisPoints: nullableNumberValidator,
  packScoutEvPercentNullRank: nullRankValidator,
  packScoutConfidenceBasisPoints: nullableNumberValidator,
  packScoutConfidenceNullRank: nullRankValidator,
  packScoutConfidenceBand: v.union(
    v.literal("low"),
    v.literal("medium"),
    v.literal("high"),
    v.null(),
  ),
  vendorReportedEvUsdMinor: nullableNumberValidator,
  vendorReportedEvUsdNullRank: nullRankValidator,
  packScoutExpiresAtMillis: nullableNumberValidator,
});

export type DataReleaseV3SearchRow = RepackEvSortRowV3 &
  Readonly<{
    publicVendorId: string;
    vendorKey: string;
    vendorDisplayName: string;
    publicCategoryIds: string[];
    categoryLabels: string[];
    collectibleTypes: PublicRepackDetailV3["collectibleTypes"][number][];
    contentMode: PublicRepackDetailV3["contentMode"];
    name: string;
    normalizedName: string;
    normalizedVendor: string;
    normalizedCategories: string;
    priceMinor: number | null;
    priceNullRank: 0 | 1;
    buybackRateBasisPoints: number | null;
    buybackRateNullRank: 0 | 1;
    topChaseValueMinor: number | null;
    topChaseNullRank: 0 | 1;
    topChaseReason:
      | "CURRENCY_UNSUPPORTED"
      | "CHASE_UNAVAILABLE"
      | "VALUATION_UNAVAILABLE"
      | null;
    packScoutExpiresAtMillis: number | null;
  }>;

export function dataReleaseV3SearchRowFromDetail(
  detail: PublicRepackDetailV3,
): DataReleaseV3SearchRow {
  const evSortRow = repackEvSortRowV3Schema.parse(
    repackEvSortRowV3FromDetail(detail),
  );
  const valuation = detail.topChase?.collectible.valuation ?? null;
  const topChaseValueMinor =
    valuation?.usdComparison.status === "available"
      ? valuation.usdComparison.value.minorUnits
      : null;
  const topChaseReason: DataReleaseV3SearchRow["topChaseReason"] =
    detail.topChase === null
      ? "CHASE_UNAVAILABLE"
      : valuation === null ||
          (valuation.usdComparison.status === "unavailable" &&
            valuation.usdComparison.reason === "VALUATION_UNAVAILABLE")
        ? "VALUATION_UNAVAILABLE"
        : valuation.usdComparison.status === "unavailable"
          ? "CURRENCY_UNSUPPORTED"
          : null;
  const packScout = detail.evEstimates.packScout;
  const priceMinor =
    detail.price.usdComparison.status === "available"
      ? detail.price.usdComparison.value.minorUnits
      : null;
  const buybackRateBasisPoints =
    detail.buyback.kind === "uniform_rate"
      ? detail.buyback.rateBasisPoints
      : null;
  return {
    ...evSortRow,
    publicVendorId: detail.publicVendorId,
    vendorKey: detail.vendorKey,
    vendorDisplayName: detail.vendorDisplayName,
    publicCategoryIds: detail.categories.map(
      ({ publicCategoryId }) => publicCategoryId,
    ),
    categoryLabels: detail.categories.map(({ label }) => label),
    collectibleTypes: [...detail.collectibleTypes],
    contentMode: detail.contentMode,
    name: detail.name,
    normalizedName: normalizePublicSearchText(detail.name),
    normalizedVendor: normalizePublicSearchText(detail.vendorDisplayName),
    normalizedCategories: normalizePublicSearchText(
      detail.categories.map(({ label }) => label).join(" "),
    ),
    priceMinor,
    priceNullRank: priceMinor === null ? 1 : 0,
    buybackRateBasisPoints,
    buybackRateNullRank: buybackRateBasisPoints === null ? 1 : 0,
    topChaseValueMinor,
    topChaseNullRank: topChaseValueMinor === null ? 1 : 0,
    topChaseReason,
    packScoutExpiresAtMillis:
      packScout.status === "current" ? Date.parse(packScout.expiresAt) : null,
  };
}

/** Extracts the exact task-007 EV sort row carried inside one search row. */
export function evSortRowFromDataReleaseV3SearchRow(
  row: DataReleaseV3SearchRow,
): RepackEvSortRowV3 {
  return {
    publicRepackId: row.publicRepackId,
    availability: row.availability,
    packScoutEvDollarsMinor: row.packScoutEvDollarsMinor,
    packScoutEvDollarsNullRank: row.packScoutEvDollarsNullRank,
    packScoutGrossEvMinor: row.packScoutGrossEvMinor,
    packScoutGrossEvNullRank: row.packScoutGrossEvNullRank,
    packScoutEvPercentBasisPoints: row.packScoutEvPercentBasisPoints,
    packScoutEvPercentNullRank: row.packScoutEvPercentNullRank,
    packScoutConfidenceBasisPoints: row.packScoutConfidenceBasisPoints,
    packScoutConfidenceNullRank: row.packScoutConfidenceNullRank,
    packScoutConfidenceBand: row.packScoutConfidenceBand,
    vendorReportedEvUsdMinor: row.vendorReportedEvUsdMinor,
    vendorReportedEvUsdNullRank: row.vendorReportedEvUsdNullRank,
  };
}

/**
 * A stored search row is honest only when it byte-matches the deterministic
 * derivation of its staged detail. Any divergence fails closed.
 */
export function dataReleaseV3SearchRowMatchesDetail(
  row: DataReleaseV3SearchRow,
  detail: PublicRepackDetailV3,
): boolean {
  return (
    canonicalJson(row) === canonicalJson(dataReleaseV3SearchRowFromDetail(detail))
  );
}

export function isValidDataReleaseV3SearchRow(
  row: DataReleaseV3SearchRow,
): boolean {
  return repackEvSortRowV3Schema.safeParse(
    evSortRowFromDataReleaseV3SearchRow(row),
  ).success;
}

/** Derived read projection only; never persisted into the immutable search shards. */
export function displayDataReleaseV3SearchRow(
  row: DataReleaseV3SearchRow,
  estimate: PackScoutDisplayedEvV3,
): DataReleaseV3SearchRow {
  // Restocking alone cannot make an estimate frozen at sellout actionable.
  const ranked = row.availability === "available" &&
    (estimate.status === "current" ||
      (estimate.status === "last_known" && estimate.historicalSoldOutAt === null))
    ? estimate : null;
  return {
    ...row,
    packScoutEvDollarsMinor: ranked?.metrics.evDollars.minorUnits ?? null,
    packScoutEvDollarsNullRank: ranked === null ? 1 : 0,
    packScoutGrossEvMinor: ranked?.metrics.grossEvMoney.minorUnits ?? null,
    packScoutGrossEvNullRank: ranked === null ? 1 : 0,
    packScoutEvPercentBasisPoints: ranked?.metrics.evPercentBasisPoints ?? null,
    packScoutEvPercentNullRank: ranked === null ? 1 : 0,
    packScoutConfidenceBasisPoints: ranked?.confidence.scoreBasisPoints ?? null,
    packScoutConfidenceNullRank: ranked === null ? 1 : 0,
    packScoutConfidenceBand: ranked?.confidence.band ?? null,
    packScoutExpiresAtMillis: null,
  };
}
