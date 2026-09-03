import {
  packScoutPublicEvV3Schema,
  packScoutBuybackEvMetricsAreConsistentV1,
  type PublicRepackDetailV3,
} from "@packscout/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { canonicalJson, sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import { displayDataReleaseV3SearchRow, MAX_DATA_RELEASE_V3_REPACKS,
  type DataReleaseV3SearchRow } from "./dataReleaseV3Search";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";

export type DataReleaseV3EvFacts = Omit<Doc<"dataReleaseV3EvFacts">,
  "_id" | "_creationTime" | "releaseId">;
const EV_FACTS_HASH_DOMAIN = "packscout.data-release-v3.ev-facts.v1";
const MAX_COMPACT_EV_BYTES = 4 * 1_024 * 1_024;
const refuse = () => refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");

export function evFactsFromDetail(detail: PublicRepackDetailV3): DataReleaseV3EvFacts {
  return { vendorKey: detail.vendorKey, publicVendorId: detail.publicVendorId,
    publicRepackId: detail.publicRepackId, availability: detail.availability,
    calculationPriceUsdMinor: detail.price.usdComparison.status === "available"
      ? detail.price.usdComparison.value.minorUnits : null,
    estimate: detail.evEstimates.packScout };
}

export function parseEvFacts(facts: DataReleaseV3EvFacts): DataReleaseV3EvFacts {
  const estimate = packScoutPublicEvV3Schema.parse(facts.estimate);
  if (estimate.status !== "unavailable" && (facts.calculationPriceUsdMinor === null ||
      !Number.isSafeInteger(facts.calculationPriceUsdMinor) || facts.calculationPriceUsdMinor <= 0 ||
      !packScoutBuybackEvMetricsAreConsistentV1({
        grossEvMinorUnits: estimate.metrics.grossEvMoney.minorUnits,
        grossReturnBasisPoints: estimate.metrics.grossReturnBasisPoints,
        evDollarsMinorUnits: estimate.metrics.evDollars.minorUnits,
        evPercentBasisPoints: estimate.metrics.evPercentBasisPoints,
        packPriceMinorUnits: facts.calculationPriceUsdMinor,
      }))) return refuse();
  return { vendorKey: facts.vendorKey, publicVendorId: facts.publicVendorId,
    publicRepackId: facts.publicRepackId, availability: facts.availability,
    calculationPriceUsdMinor: facts.calculationPriceUsdMinor, estimate };
}

export async function loadEvFactSet(ctx: Pick<QueryCtx, "db">, releaseId: Id<"dataReleaseV3Releases">) {
  return ctx.db.query("dataReleaseV3EvFactSets")
    .withIndex("by_release_id", (index) => index.eq("releaseId", releaseId)).unique();
}

/** This is the only release-wide EV read; descriptions/images are never loaded. */
export async function loadReleaseEvFacts(ctx: Pick<QueryCtx, "db">,
  release: Doc<"dataReleaseV3Releases">): Promise<readonly DataReleaseV3EvFacts[]> {
  const set = await loadEvFactSet(ctx, release._id);
  if (set === null || set.status !== "complete" || set.count !== release.expectedCounts.repacks ||
      set.count > MAX_DATA_RELEASE_V3_REPACKS) return refuse();
  const facts = await readBoundedEvFacts(ctx, release._id, set.count);
  if (set.factsSha256 === null || await sha256CanonicalJson(EV_FACTS_HASH_DOMAIN, facts) !== set.factsSha256) return refuse();
  return facts;
}

async function readBoundedEvFacts(ctx: Pick<QueryCtx, "db">, releaseId: Id<"dataReleaseV3Releases">,
  count: number): Promise<readonly DataReleaseV3EvFacts[]> {
  const rows = await ctx.db.query("dataReleaseV3EvFacts")
    .withIndex("by_release_id_and_public_repack_id", (index) => index.eq("releaseId", releaseId))
    .take(count + 1);
  if (rows.length !== count || new TextEncoder().encode(canonicalJson(rows)).byteLength > MAX_COMPACT_EV_BYTES) return refuse();
  if (rows.some((row, index) => index > 0 && rows[index - 1]!.publicRepackId >= row.publicRepackId)) return refuse();
  return rows.map(parseEvFacts);
}

export async function stageReleaseEvFacts(ctx: MutationCtx, release: Doc<"dataReleaseV3Releases">,
  details: readonly PublicRepackDetailV3[]): Promise<void> {
  const set = await loadEvFactSet(ctx, release._id);
  if (release.lifecycle !== "staging" || (set?.count ?? 0) !== release.acceptedCounts.repacks ||
      (set !== null && (set.status !== "building" || set.source !== "staging"))) return refuse();
  for (const detail of details) {
    await ctx.db.insert("dataReleaseV3EvFacts", { releaseId: release._id, ...evFactsFromDetail(detail) });
  }
  const core = { count: (set?.count ?? 0) + details.length,
    cursor: details.at(-1)?.publicRepackId ?? set?.cursor ?? null };
  if (set === null) await ctx.db.insert("dataReleaseV3EvFactSets", {
    releaseId: release._id, source: "staging", status: "building", factsSha256: null, lastRequestCursor: null, ...core,
  });
  else await ctx.db.patch("dataReleaseV3EvFactSets", set._id, core);
}

export async function completeReleaseEvFacts(ctx: MutationCtx, release: Doc<"dataReleaseV3Releases">): Promise<void> {
  const set = await loadEvFactSet(ctx, release._id);
  if (set === null && release.expectedCounts.repacks === 0) {
    await ctx.db.insert("dataReleaseV3EvFactSets", { releaseId: release._id, source: "staging",
      status: "complete", count: 0, cursor: null, lastRequestCursor: null,
      factsSha256: await sha256CanonicalJson(EV_FACTS_HASH_DOMAIN, []) });
    return;
  }
  if (set === null || set.status !== "building" || set.count !== release.expectedCounts.repacks) return refuse();
  await sealEvFactSet(ctx, set);
}

export async function sealEvFactSet(ctx: MutationCtx, set: Doc<"dataReleaseV3EvFactSets">): Promise<void> {
  const facts = await readBoundedEvFacts(ctx, set.releaseId, set.count);
  await ctx.db.patch("dataReleaseV3EvFactSets", set._id, { status: "complete",
    factsSha256: await sha256CanonicalJson(EV_FACTS_HASH_DOMAIN, facts) });
}

export function evFactsMatchSearchRow(facts: DataReleaseV3EvFacts, row: DataReleaseV3SearchRow): boolean {
  if (facts.publicRepackId !== row.publicRepackId || facts.vendorKey !== row.vendorKey ||
      facts.publicVendorId !== row.publicVendorId || facts.availability !== row.availability ||
      facts.calculationPriceUsdMinor !== row.priceMinor) return false;
  const derived = displayDataReleaseV3SearchRow(row, facts.estimate);
  return row.packScoutEvDollarsMinor === derived.packScoutEvDollarsMinor &&
    row.packScoutGrossEvMinor === derived.packScoutGrossEvMinor &&
    row.packScoutEvPercentBasisPoints === derived.packScoutEvPercentBasisPoints &&
    row.packScoutConfidenceBasisPoints === derived.packScoutConfidenceBasisPoints &&
    row.packScoutConfidenceBand === derived.packScoutConfidenceBand &&
    row.packScoutExpiresAtMillis === (facts.estimate.status === "current" ? Date.parse(facts.estimate.expiresAt) : null);
}
