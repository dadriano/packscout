import { z } from "zod";
import {
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  normalizePublicSearchText,
  publicCategoryIdSchema,
  publicCollectibleTypeSchema,
  publicRepackIdSchema,
  publicVendorIdSchema,
  publicVendorKeySchema,
} from "./data-release-v2-values.ts";
import type { PublicRepackDetail } from "./data-release-v2-entities.ts";

export const MAX_ROWS_PER_REPACK_SEARCH_SHARD = 32;
export const MAX_REPACK_SEARCH_SHARDS = Math.ceil(
  MAX_PUBLIC_REPACKS_PER_RELEASE / MAX_ROWS_PER_REPACK_SEARCH_SHARD,
);

const nullRankSchema = z.union([z.literal(0), z.literal(1)]);
const nullableIntegerWithRank = (options: { minimum?: number; maximum?: number } = {}) =>
  z.object({
    value: z.number().int().safe()
      .min(options.minimum ?? Number.MIN_SAFE_INTEGER)
      .max(options.maximum ?? Number.MAX_SAFE_INTEGER)
      .nullable(),
    rank: nullRankSchema,
  }).refine(({ value, rank }) => (value === null) === (rank === 1));

export const repackSearchRowSchema = z.object({
  publicRepackId: publicRepackIdSchema,
  publicVendorId: publicVendorIdSchema,
  vendorKey: publicVendorKeySchema,
  vendorDisplayName: z.string().trim().min(1).max(100),
  publicCategoryIds: z.array(publicCategoryIdSchema).max(32),
  categoryLabels: z.array(z.string().trim().min(1).max(100)).max(32),
  collectibleTypes: z.array(publicCollectibleTypeSchema).max(8),
  contentMode: z.enum(["focused", "mixed", "unknown"]),
  name: z.string().trim().min(1).max(200),
  normalizedName: z.string(),
  normalizedVendor: z.string(),
  normalizedCategories: z.string(),
  availability: z.enum(["active", "sold_out"]),
  priceMinor: z.number().int().safe().nonnegative().nullable(),
  priceNullRank: nullRankSchema,
  vendorReportedGrossEvMinor: z.number().int().safe().nonnegative().nullable(),
  vendorReportedGrossEvNullRank: nullRankSchema,
  vendorReportedEvDollarsMinor: z.number().int().safe().nullable(),
  vendorReportedEvDollarsNullRank: nullRankSchema,
  vendorReportedEvPercentBasisPoints: z.number().int().safe().nullable(),
  vendorReportedEvPercentNullRank: nullRankSchema,
  packScoutGrossEvMinor: z.number().int().safe().nonnegative().nullable(),
  packScoutGrossEvNullRank: nullRankSchema,
  packScoutEvDollarsMinor: z.number().int().safe().nullable(),
  packScoutEvDollarsNullRank: nullRankSchema,
  packScoutEvPercentBasisPoints: z.number().int().safe().nullable(),
  packScoutEvPercentNullRank: nullRankSchema,
  packScoutConfidenceBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  packScoutConfidenceNullRank: nullRankSchema,
  packScoutConfidenceBand: z.enum(["low", "medium", "high"]).nullable(),
  buybackBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  buybackNullRank: nullRankSchema,
  topChaseValueMinor: z.number().int().safe().nonnegative().nullable(),
  topChaseNullRank: nullRankSchema,
  topChaseReason: z.enum([
    "CURRENCY_UNSUPPORTED",
    "CHASE_UNAVAILABLE",
    "VALUATION_UNAVAILABLE",
  ]).nullable(),
}).strict().superRefine((row, context) => {
  const canonical = (values: readonly string[]) =>
    values.every((value, index) => index === 0 || values[index - 1]! < value);
  if (!canonical(row.publicCategoryIds) || !canonical(row.collectibleTypes)) {
    context.addIssue({ code: "custom", message: "search_row.not_canonical" });
  }
  if (row.publicCategoryIds.length !== row.categoryLabels.length) {
    context.addIssue({ code: "custom", path: ["categoryLabels"], message: "search_row.category_count_mismatch" });
  }
  const textMatches = row.normalizedName === normalizePublicSearchText(row.name) &&
    row.normalizedVendor === normalizePublicSearchText(row.vendorDisplayName) &&
    row.normalizedCategories === normalizePublicSearchText(row.categoryLabels.join(" "));
  if (!textMatches) context.addIssue({ code: "custom", message: "search_row.normalization_mismatch" });
  const pairs = [
    nullableIntegerWithRank({ minimum: 0 }).safeParse({ value: row.priceMinor, rank: row.priceNullRank }),
    nullableIntegerWithRank({ minimum: 0 }).safeParse({ value: row.vendorReportedGrossEvMinor, rank: row.vendorReportedGrossEvNullRank }),
    nullableIntegerWithRank().safeParse({ value: row.vendorReportedEvDollarsMinor, rank: row.vendorReportedEvDollarsNullRank }),
    nullableIntegerWithRank().safeParse({ value: row.vendorReportedEvPercentBasisPoints, rank: row.vendorReportedEvPercentNullRank }),
    nullableIntegerWithRank({ minimum: 0 }).safeParse({ value: row.packScoutGrossEvMinor, rank: row.packScoutGrossEvNullRank }),
    nullableIntegerWithRank().safeParse({ value: row.packScoutEvDollarsMinor, rank: row.packScoutEvDollarsNullRank }),
    nullableIntegerWithRank().safeParse({ value: row.packScoutEvPercentBasisPoints, rank: row.packScoutEvPercentNullRank }),
    nullableIntegerWithRank({ minimum: 0, maximum: 10_000 }).safeParse({ value: row.packScoutConfidenceBasisPoints, rank: row.packScoutConfidenceNullRank }),
    nullableIntegerWithRank({ minimum: 0, maximum: 10_000 }).safeParse({ value: row.buybackBasisPoints, rank: row.buybackNullRank }),
    nullableIntegerWithRank({ minimum: 0 }).safeParse({ value: row.topChaseValueMinor, rank: row.topChaseNullRank }),
  ];
  if (pairs.some((pair) => !pair.success)) context.addIssue({ code: "custom", message: "search_row.null_rank_mismatch" });
  const score = row.packScoutConfidenceBasisPoints;
  const expectedBand = score === null ? null : score < 5_000 ? "low" : score < 8_000 ? "medium" : "high";
  if (row.packScoutConfidenceBand !== expectedBand) context.addIssue({ code: "custom", message: "search_row.confidence_mismatch" });
  if ((row.topChaseValueMinor === null) === (row.topChaseReason === null)) {
    context.addIssue({ code: "custom", message: "search_row.top_chase_reason_mismatch" });
  }
});

export type RepackSearchRow = z.infer<typeof repackSearchRowSchema>;

const estimateValues = (
  estimate: PublicRepackDetail["evEstimates"]["vendorReported"] | PublicRepackDetail["evEstimates"]["packScout"],
) => estimate.status === "available"
  ? {
      gross: estimate.metrics.grossEv.minorUnits,
      dollars: estimate.metrics.evDollars.minorUnits,
      percent: estimate.metrics.evPercentBasisPoints,
    }
  : { gross: null, dollars: null, percent: null };

export function repackSearchRowFromDetail(detail: PublicRepackDetail): RepackSearchRow {
  const vendorEv = estimateValues(detail.evEstimates.vendorReported);
  const packScoutEv = estimateValues(detail.evEstimates.packScout);
  const valuation = detail.topChase?.collectible.valuation ?? null;
  const topChaseValueMinor = valuation?.usdComparison.status === "available"
    ? valuation.usdComparison.value.minorUnits
    : null;
  const topChaseReason: RepackSearchRow["topChaseReason"] = detail.topChase === null
    ? "CHASE_UNAVAILABLE"
    : valuation === null || valuation.usdComparison.status === "unavailable" && valuation.usdComparison.reason === "VALUATION_UNAVAILABLE"
      ? "VALUATION_UNAVAILABLE"
      : valuation.usdComparison.status === "unavailable" ? "CURRENCY_UNSUPPORTED" : null;
  return repackSearchRowSchema.parse({
    publicRepackId: detail.publicRepackId,
    publicVendorId: detail.publicVendorId,
    vendorKey: detail.vendorKey,
    vendorDisplayName: detail.vendorDisplayName,
    publicCategoryIds: detail.categories.map(({ publicCategoryId }) => publicCategoryId),
    categoryLabels: detail.categories.map(({ label }) => label),
    collectibleTypes: detail.collectibleTypes,
    contentMode: detail.contentMode,
    name: detail.name,
    normalizedName: normalizePublicSearchText(detail.name),
    normalizedVendor: normalizePublicSearchText(detail.vendorDisplayName),
    normalizedCategories: normalizePublicSearchText(detail.categories.map(({ label }) => label).join(" ")),
    availability: detail.availability,
    priceMinor: detail.price.usdComparison.status === "available" ? detail.price.usdComparison.value.minorUnits : null,
    priceNullRank: detail.price.usdComparison.status === "available" ? 0 : 1,
    vendorReportedGrossEvMinor: vendorEv.gross,
    vendorReportedGrossEvNullRank: vendorEv.gross === null ? 1 : 0,
    vendorReportedEvDollarsMinor: vendorEv.dollars,
    vendorReportedEvDollarsNullRank: vendorEv.dollars === null ? 1 : 0,
    vendorReportedEvPercentBasisPoints: vendorEv.percent,
    vendorReportedEvPercentNullRank: vendorEv.percent === null ? 1 : 0,
    packScoutGrossEvMinor: packScoutEv.gross,
    packScoutGrossEvNullRank: packScoutEv.gross === null ? 1 : 0,
    packScoutEvDollarsMinor: packScoutEv.dollars,
    packScoutEvDollarsNullRank: packScoutEv.dollars === null ? 1 : 0,
    packScoutEvPercentBasisPoints: packScoutEv.percent,
    packScoutEvPercentNullRank: packScoutEv.percent === null ? 1 : 0,
    packScoutConfidenceBasisPoints: detail.evEstimates.packScout.status === "available" ? detail.evEstimates.packScout.confidence.scoreBasisPoints : null,
    packScoutConfidenceNullRank: detail.evEstimates.packScout.status === "available" ? 0 : 1,
    packScoutConfidenceBand: detail.evEstimates.packScout.status === "available" ? detail.evEstimates.packScout.confidence.band : null,
    buybackBasisPoints: detail.buyback.status === "available" ? detail.buyback.value.basisPoints : null,
    buybackNullRank: detail.buyback.status === "available" ? 0 : 1,
    topChaseValueMinor,
    topChaseNullRank: topChaseValueMinor === null ? 1 : 0,
    topChaseReason,
  });
}
