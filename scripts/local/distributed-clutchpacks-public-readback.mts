import {
  canonicalJson,
  presentLastKnownPackScoutEvV3,
  publicRepackDetailV3Schema,
  type PackScoutDisplayedEvV3,
  type PublicRepackSummaryV3,
  type PublicRepackViewSummaryV3,
} from "@packscout/contracts";
import type { DataReleaseV3PublishPlan } from "@packscout/services";
import { DistributedClutchpacksPublicationError } from
  "./distributed-clutchpacks-publication-plan.mts";

type ReadResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };
type ReleaseIdentity = { readonly publicReleaseId: string };
type RepackIdentity = { readonly publicRepackId: string };
export type LocalClutchpacksEvReadbackRow = Pick<PublicRepackViewSummaryV3,
  "publicRepackId" | "availability" | "evEstimates">;
type PlannedRow = Pick<PublicRepackSummaryV3,
  "publicRepackId" | "availability" | "evEstimates" | "price">;

function refuse(): never {
  throw new DistributedClutchpacksPublicationError("LOCAL_CONVEX_PUBLIC_READBACK_FAILED");
}

export function localClutchpacksPlannedV3Rows(
  plan: DataReleaseV3PublishPlan,
): readonly PlannedRow[] {
  return plan.batches.filter(({ kind }) => kind === "repacks")
    .flatMap(({ records }) => records.map((record) => publicRepackDetailV3Schema.parse(record)));
}

/** Model display confidence without changing the immutable planned EV. */
function expectedEvAtRead(
  row: PlannedRow,
  currentTime: number,
  prior: LocalClutchpacksEvReadbackRow | undefined,
): PackScoutDisplayedEvV3 {
  const estimate = row.evEstimates.packScout;
  const previous = prior?.evEstimates.packScout;
  if (estimate.status === "unavailable") {
    if (previous?.status !== "last_known") return estimate;
    return presentLastKnownPackScoutEvV3({
      estimate: previous,
      calculationPriceUsdMinor: previous.calculationPriceUsdMinor,
      referenceTimeIso: new Date(currentTime).toISOString(),
      latestUnavailableReason: Date.parse(estimate.calculatedAt) > Date.parse(previous.calculatedAt)
        ? estimate.reason : previous.latestUnavailableReason,
    });
  }
  if (row.price.usdComparison.status !== "available") return refuse();
  return presentLastKnownPackScoutEvV3({
    estimate, calculationPriceUsdMinor: row.price.usdComparison.value.minorUnits,
    referenceTimeIso: new Date(currentTime).toISOString(),
  });
}

function projection(row: LocalClutchpacksEvReadbackRow): LocalClutchpacksEvReadbackRow {
  return {
    publicRepackId: row.publicRepackId,
    availability: row.availability,
    evEstimates: row.evEstimates,
  };
}

function sortedIdentities(rows: readonly RepackIdentity[]): string[] {
  return rows.map(({ publicRepackId }) => publicRepackId).sort();
}

/** Verify the exact public release and its currently actionable EV ranking. */
export function verifyLocalClutchpacksPublicReadback(input: {
  readonly currentTime: number;
  readonly expectedRepackIds: readonly string[];
  readonly expectedV3Rows: readonly PlannedRow[];
  readonly previousV3Rows?: readonly LocalClutchpacksEvReadbackRow[];
  readonly manifestPublicReleaseId: string;
  readonly v3PublicReleaseId: string;
  readonly manifestShell: ReadResult<{ readonly metadata: ReleaseIdentity }>;
  readonly manifestList: ReadResult<{
    readonly metadata: ReleaseIdentity;
    readonly range: { readonly total: number };
    readonly rows: readonly RepackIdentity[];
  }>;
  readonly v3Shell: ReadResult<{ readonly release: ReleaseIdentity }>;
  readonly v3List: ReadResult<{
    readonly release: ReleaseIdentity;
    readonly range: { readonly total: number };
    readonly rows: readonly LocalClutchpacksEvReadbackRow[];
  }>;
  readonly dashboard: ReadResult<{
    readonly release: ReleaseIdentity;
    readonly opportunities: readonly LocalClutchpacksEvReadbackRow[];
  }>;
}): {
  readonly manifestRepackCount: number;
  readonly v3RepackCount: number;
  readonly knownEstimateCount: number;
  readonly agedEstimateCount: number;
  readonly dashboardOpportunityCount: number;
} {
  const { manifestShell, manifestList, v3Shell, v3List, dashboard } = input;
  if (
    !Number.isSafeInteger(input.currentTime) || input.currentTime < 0 ||
    !manifestShell.ok || !manifestList.ok || !v3Shell.ok || !v3List.ok || !dashboard.ok ||
    manifestShell.data.metadata.publicReleaseId !== input.manifestPublicReleaseId ||
    manifestList.data.metadata.publicReleaseId !== input.manifestPublicReleaseId ||
    v3Shell.data.release.publicReleaseId !== input.v3PublicReleaseId ||
    v3List.data.release.publicReleaseId !== input.v3PublicReleaseId ||
    dashboard.data.release.publicReleaseId !== input.v3PublicReleaseId ||
    manifestList.data.range.total !== input.expectedRepackIds.length ||
    v3List.data.range.total !== input.expectedRepackIds.length ||
    new Set(input.expectedRepackIds).size !== input.expectedRepackIds.length
  ) return refuse();
  const expectedIds = canonicalJson([...input.expectedRepackIds].sort());
  if ([manifestList.data.rows, v3List.data.rows, input.expectedV3Rows]
    .some((rows) => canonicalJson(sortedIdentities(rows)) !== expectedIds)) return refuse();

  const previousById = new Map((input.previousV3Rows ?? []).map(row => [row.publicRepackId, row]));
  const expectedRows = input.expectedV3Rows.map((row) => ({
    ...projection(row),
    evEstimates: {
      ...row.evEstimates,
      packScout: expectedEvAtRead(row, input.currentTime, previousById.get(row.publicRepackId)),
    },
  }));
  const expectedById = new Map(expectedRows.map((row) => [row.publicRepackId, row]));
  if (v3List.data.rows.some((row) =>
    canonicalJson(projection(row)) !== canonicalJson(expectedById.get(row.publicRepackId)))) {
    return refuse();
  }
  const eligible = expectedRows.filter((row) => row.availability === "available" &&
    row.evEstimates.packScout.status !== "unavailable");
  const ranked = eligible.sort((left, right) => {
    const leftEv = left.evEstimates.packScout;
    const rightEv = right.evEstimates.packScout;
    if (leftEv.status === "unavailable" || rightEv.status === "unavailable") return refuse();
    return rightEv.metrics.evDollars.minorUnits - leftEv.metrics.evDollars.minorUnits ||
      (left.publicRepackId < right.publicRepackId ? -1 : left.publicRepackId > right.publicRepackId ? 1 : 0);
  }).slice(0, 6);
  if (canonicalJson(dashboard.data.opportunities.map(projection)) !== canonicalJson(ranked)) {
    return refuse();
  }
  const knownEstimateCount = expectedRows.filter((row) =>
    row.evEstimates.packScout.status !== "unavailable").length;
  return {
    manifestRepackCount: manifestList.data.range.total,
    v3RepackCount: v3List.data.range.total,
    knownEstimateCount,
    agedEstimateCount: expectedRows.filter((row) =>
      row.evEstimates.packScout.status === "last_known" &&
      row.evEstimates.packScout.sourceAge.milliseconds > 60 * 60_000).length,
    dashboardOpportunityCount: ranked.length,
  };
}
