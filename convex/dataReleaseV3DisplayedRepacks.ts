import {
  presentLastKnownPackScoutEvV3,
  type PackScoutDisplayedEvV3,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { loadReleaseEvFacts, evFactsMatchSearchRow, type DataReleaseV3EvFacts } from "./dataReleaseV3EvFacts";
import { loadRetainedEvForScopes, retainedEvForFacts } from "./dataReleaseV3RetainedEv";
import { displayDataReleaseV3SearchRow, type DataReleaseV3SearchRow } from "./dataReleaseV3Search";

/** One compact, consistent projection supplies every EV sort, KPI, and detail. */
export async function loadDataReleaseV3DisplayedRepacks(
  ctx: Pick<QueryCtx, "db">,
  release: Doc<"dataReleaseV3Releases">,
  storedRows: readonly DataReleaseV3SearchRow[],
  currentTime: number,
): Promise<{
  readonly rows: readonly DataReleaseV3SearchRow[];
  readonly evByPublicId: ReadonlyMap<string, PackScoutDisplayedEvV3>;
  readonly factsByPublicId: ReadonlyMap<string, DataReleaseV3EvFacts>;
} | null> {
  const facts = await loadReleaseEvFacts(ctx, release);
  if (facts.length !== storedRows.length || facts.some((fact, index) =>
    storedRows[index] === undefined || !evFactsMatchSearchRow(fact, storedRows[index]!))) return null;
  const referenceTimeIso = new Date(currentTime).toISOString();
  const retained = await loadRetainedEvForScopes(ctx, facts);
  const projected = facts.map((fact, index) => {
    const history = retainedEvForFacts(fact, retained[index]?.value ?? null, release.publicReleaseId);
    const estimate = history.value === null ? fact.estimate : presentLastKnownPackScoutEvV3({
      estimate: history.value.estimate,
      calculationPriceUsdMinor: history.value.calculationPriceUsdMinor,
      referenceTimeIso,
      latestUnavailableReason: history.latestUnavailableReason ?? null,
    });
    return { row: displayDataReleaseV3SearchRow(storedRows[index]!, estimate), estimate };
  });
  return {
    rows: projected.map(({ row }) => row),
    evByPublicId: new Map(projected.map(({ row, estimate }) => [row.publicRepackId, estimate])),
    factsByPublicId: new Map(facts.map((fact) => [fact.publicRepackId, fact])),
  };
}
