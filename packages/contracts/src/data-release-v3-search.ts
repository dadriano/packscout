import { z } from "zod";
import { publicRepackIdSchema } from "./data-release-v2-values.ts";
import { publicRepackAvailabilitySchema } from "./data-release-v2-entities.ts";
import {
  packAvailabilityIsPurchasableV3,
  type PublicRepackDetailV3,
} from "./data-release-v3-entities.ts";

const safeIntegerSchema = z.number().int().safe();
const nullRankSchema = z.union([z.literal(0), z.literal(1)]);

/**
 * The only sortable EV values a public read may materialize: bounded
 * integers plus null ranks. Default opportunity ranking uses signed
 * PackScout EV dollars. Two independent gates must both open for a row to
 * carry sortable values: the pack availability must be purchasable
 * (`available` only, per {@link packAvailabilityIsPurchasableV3}) and the
 * PackScout estimate status must be `current`. A row that fails either gate
 * materializes nulls, so neither a sold-out-historical or unavailable
 * estimate nor an `unavailable`, `unknown`, or `sold_out` pack can rank.
 */
export const repackEvSortRowV3Schema = z
  .object({
    publicRepackId: publicRepackIdSchema,
    availability: publicRepackAvailabilitySchema,
    packScoutEvDollarsMinor: safeIntegerSchema.nullable(),
    packScoutEvDollarsNullRank: nullRankSchema,
    packScoutGrossEvMinor: safeIntegerSchema.min(0).nullable(),
    packScoutGrossEvNullRank: nullRankSchema,
    packScoutEvPercentBasisPoints: safeIntegerSchema.nullable(),
    packScoutEvPercentNullRank: nullRankSchema,
    packScoutConfidenceBasisPoints: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .nullable(),
    packScoutConfidenceNullRank: nullRankSchema,
    packScoutConfidenceBand: z.enum(["low", "medium", "high"]).nullable(),
    vendorReportedEvUsdMinor: safeIntegerSchema.min(0).nullable(),
    vendorReportedEvUsdNullRank: nullRankSchema,
  })
  .strict()
  .superRefine((row, context) => {
    const pairs: readonly (readonly [unknown, 0 | 1, string])[] = [
      [row.packScoutEvDollarsMinor, row.packScoutEvDollarsNullRank, "packScoutEvDollarsNullRank"],
      [row.packScoutGrossEvMinor, row.packScoutGrossEvNullRank, "packScoutGrossEvNullRank"],
      [row.packScoutEvPercentBasisPoints, row.packScoutEvPercentNullRank, "packScoutEvPercentNullRank"],
      [row.packScoutConfidenceBasisPoints, row.packScoutConfidenceNullRank, "packScoutConfidenceNullRank"],
      [row.vendorReportedEvUsdMinor, row.vendorReportedEvUsdNullRank, "vendorReportedEvUsdNullRank"],
    ];
    for (const [value, rank, path] of pairs) {
      if ((value === null) !== (rank === 1)) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: "data_release_v3.null_rank_mismatch",
        });
      }
    }
    const packScoutValues = [
      row.packScoutEvDollarsMinor,
      row.packScoutGrossEvMinor,
      row.packScoutEvPercentBasisPoints,
      row.packScoutConfidenceBasisPoints,
      row.packScoutConfidenceBand,
    ];
    const nullCount = packScoutValues.filter((value) => value === null).length;
    if (nullCount !== 0 && nullCount !== packScoutValues.length) {
      context.addIssue({
        code: "custom",
        path: ["packScoutEvDollarsMinor"],
        message: "data_release_v3.partial_packscout_sort_values",
      });
    }
    const score = row.packScoutConfidenceBasisPoints;
    const expectedBand =
      score === null ? null : score < 5_000 ? "low" : score < 8_000 ? "medium" : "high";
    if (row.packScoutConfidenceBand !== expectedBand) {
      context.addIssue({
        code: "custom",
        path: ["packScoutConfidenceBand"],
        message: "data_release_v3.confidence_band_mismatch",
      });
    }
    // Every pack that is not purchasable must carry fully null sort values,
    // not just `sold_out`: an `unavailable` or `unknown` pack may still hold
    // a current PackScout estimate, and materializing it here would let it
    // sort beside buyable packs.
    if (
      !packAvailabilityIsPurchasableV3(row.availability) &&
      (nullCount !== packScoutValues.length || row.vendorReportedEvUsdMinor !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["availability"],
        message: "data_release_v3.non_purchasable_rankable",
      });
    }
  });

export type RepackEvSortRowV3 = z.infer<typeof repackEvSortRowV3Schema>;

export function repackEvSortRowV3FromDetail(
  detail: PublicRepackDetailV3,
): RepackEvSortRowV3 {
  const packScout = detail.evEstimates.packScout;
  const vendorReported = detail.evEstimates.vendorReported;
  const rankable = packAvailabilityIsPurchasableV3(detail.availability);
  const current = rankable && packScout.status === "current" ? packScout : null;
  const vendorUsd =
    rankable &&
      vendorReported.status === "available" &&
      vendorReported.usdComparison.status === "available"
      ? vendorReported.usdComparison.value.minorUnits
      : null;
  return repackEvSortRowV3Schema.parse({
    publicRepackId: detail.publicRepackId,
    availability: detail.availability,
    packScoutEvDollarsMinor: current === null ? null : current.metrics.evDollars.minorUnits,
    packScoutEvDollarsNullRank: current === null ? 1 : 0,
    packScoutGrossEvMinor: current === null ? null : current.metrics.grossEvMoney.minorUnits,
    packScoutGrossEvNullRank: current === null ? 1 : 0,
    packScoutEvPercentBasisPoints:
      current === null ? null : current.metrics.evPercentBasisPoints,
    packScoutEvPercentNullRank: current === null ? 1 : 0,
    packScoutConfidenceBasisPoints:
      current === null ? null : current.confidence.scoreBasisPoints,
    packScoutConfidenceNullRank: current === null ? 1 : 0,
    packScoutConfidenceBand: current === null ? null : current.confidence.band,
    vendorReportedEvUsdMinor: vendorUsd,
    vendorReportedEvUsdNullRank: vendorUsd === null ? 1 : 0,
  });
}

/** A sort row is honest only when it byte-matches its source detail. */
export function repackEvSortRowV3MatchesDetail(
  row: RepackEvSortRowV3,
  detail: PublicRepackDetailV3,
): boolean {
  return JSON.stringify(row) === JSON.stringify(repackEvSortRowV3FromDetail(detail));
}
