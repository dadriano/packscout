import {
  canonicalJson,
  publicEvPresentationResponseContextV1Schema,
  publicProviderHealthResponseContextV1Schema,
  publicRepackDetailV3Schema,
  type DataReleaseV3RetainedEvWitness,
  type DataReleaseV3RetainedEvWitnessRequest,
  type PublicRepackSummaryV3,
  type PublicRepackViewSummaryV3,
} from "@packscout/contracts";
import type { DataReleaseV3PublishPlan } from "@packscout/services";
import { DistributedClutchpacksPublicationError } from
  "./distributed-clutchpacks-publication-plan.mts";
import { localClutchpacksExpectedEv, type LocalClutchpacksPlannedEvRow } from
  "./distributed-clutchpacks-ev-witness.mts";

type ReadResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };
type ReleaseIdentity = { readonly publicReleaseId: string };
type RepackIdentity = { readonly publicRepackId: string };
export type LocalClutchpacksEvReadbackRow = Pick<PublicRepackViewSummaryV3,
  "publicRepackId" | "availability" | "evEstimates">;
type PlannedRow = LocalClutchpacksPlannedEvRow;
type Clock = { readonly confidenceEvaluatedAt: string; readonly publicFreshnessPolicyVersion: string;
  readonly providerHealthEvaluatedAt: string };
type ContentRow = Pick<PublicRepackSummaryV3,
  "publicRepackId" | "topChase" | "contentSummary" | "collectibleTypes">;

function refuse(): never {
  throw new DistributedClutchpacksPublicationError("LOCAL_CONVEX_PUBLIC_READBACK_FAILED");
}

export function localClutchpacksPlannedV3Rows(
  plan: DataReleaseV3PublishPlan,
): readonly (PlannedRow & ContentRow)[] {
  return plan.batches.filter(({ kind }) => kind === "repacks")
    .flatMap(({ records }) => records.map((record) => publicRepackDetailV3Schema.parse(record)));
}

/** Both public list projections must expose the exact staged current contents. */
export function verifyLocalClutchpacksContentReadback(input: {
  readonly expectedRows: readonly ContentRow[];
  readonly manifestRows: readonly ContentRow[];
  readonly v3Rows: readonly ContentRow[];
}): void {
  const normalize = (rows: readonly ContentRow[]) => rows.map((row) => ({
    publicRepackId: row.publicRepackId, topChase: row.topChase,
    contentSummary: row.contentSummary, collectibleTypes: row.collectibleTypes,
  })).sort((left, right) => left.publicRepackId < right.publicRepackId ? -1 : left.publicRepackId > right.publicRepackId ? 1 : 0);
  const expected = canonicalJson(normalize(input.expectedRows));
  if (canonicalJson(normalize(input.manifestRows)) !== expected || canonicalJson(normalize(input.v3Rows)) !== expected) return refuse();
}

function trustedClock(data: Clock): string {
  const confidence = publicEvPresentationResponseContextV1Schema.safeParse({
    confidenceEvaluatedAt: data.confidenceEvaluatedAt,
    publicFreshnessPolicyVersion: data.publicFreshnessPolicyVersion,
  });
  const health = publicProviderHealthResponseContextV1Schema.safeParse({ providerHealthEvaluatedAt: data.providerHealthEvaluatedAt });
  if (!confidence.success || !health.success ||
      Date.parse(data.providerHealthEvaluatedAt) < Date.parse(data.confidenceEvaluatedAt)) return refuse();
  return confidence.data.confidenceEvaluatedAt;
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
  readonly expectedRepackIds: readonly string[];
  readonly expectedV3Rows: readonly PlannedRow[];
  readonly witnessRequest: DataReleaseV3RetainedEvWitnessRequest;
  readonly witness: DataReleaseV3RetainedEvWitness;
  readonly manifestPublicReleaseId: string;
  readonly v3PublicReleaseId: string;
  readonly manifestShell: ReadResult<{ readonly metadata: ReleaseIdentity }>;
  readonly manifestList: ReadResult<{
    readonly metadata: ReleaseIdentity;
    readonly range: { readonly total: number };
    readonly rows: readonly RepackIdentity[];
  }>;
  readonly v3Shell: ReadResult<Clock & { readonly release: ReleaseIdentity }>;
  readonly v3List: ReadResult<Clock & {
    readonly release: ReleaseIdentity;
    readonly range: { readonly total: number };
    readonly rows: readonly LocalClutchpacksEvReadbackRow[];
  }>;
  readonly dashboard: ReadResult<Clock & {
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

  trustedClock(v3Shell.data);
  const listClock = trustedClock(v3List.data);
  const dashboardClock = trustedClock(dashboard.data);
  if (input.witnessRequest.expectedActivePublicReleaseId !== input.v3PublicReleaseId) return refuse();
  const expectedEv = localClutchpacksExpectedEv({ rows: input.expectedV3Rows,
    request: input.witnessRequest, witness: input.witness });
  const atClock = (clock: string) => input.expectedV3Rows.map((row) => ({
    ...projection(row),
    evEstimates: {
      ...row.evEstimates,
      packScout: expectedEv(row, clock),
    },
  }));
  const expectedRows = atClock(listClock);
  const expectedById = new Map(expectedRows.map((row) => [row.publicRepackId, row]));
  if (v3List.data.rows.some((row) =>
    canonicalJson(projection(row)) !== canonicalJson(expectedById.get(row.publicRepackId)))) {
    return refuse();
  }
  const eligible = atClock(dashboardClock).filter((row) => {
    const estimate = row.evEstimates.packScout;
    return row.availability === "available" &&
      (estimate.status === "current" ||
        (estimate.status === "last_known" && estimate.historicalSoldOutAt === null));
  });
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
