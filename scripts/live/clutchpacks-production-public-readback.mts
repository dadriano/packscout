import { canonicalJson, dataReleaseV3IdentitySchema, publicCollectibleSchema, publicRepackChaseSchema, publicRepackDetailV3Schema,
  type PublicResult, type PublicRepackDetailV3, type PublicRepackViewSummaryV3 } from "@packscout/contracts";
import type { DataReleaseV3ActiveState, DataReleaseV3PublishPlan, SignedConvexDataReleaseV3PublicationClient } from "@packscout/services";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import { parseGetDashboardBundleV3Result, parseGetPublicRepackV3Result, parseGetPublicShellStatusV3Result,
  parseListPublicRepacksV3Result, parseSearchPublicCollectiblesV3Result,
  parseFindRepacksByDesiredCollectibleV3Result } from "../../apps/frontend/lib/public-repacks-v3.ts";
import { localClutchpacksExpectedEv, localClutchpacksRetainedEvWitnessRequest,
  assertLocalClutchpacksWitnessUnchanged } from "../local/distributed-clutchpacks-ev-witness.mts";
import { productionPublicationSha256 } from "./clutchpacks-production-publication-policy.mts";

function refuse(): never { throw new Error("CLUTCHPACKS_PRODUCTION_PUBLIC_READBACK_FAILED"); }
function data<T>(result: PublicResult<T>): T { if (!result.ok) return refuse(); return result.data; }
function equal(actual: unknown, expected: unknown): void { if (canonicalJson(actual) !== canonicalJson(expected)) refuse(); }

export function assertClutchpacksProductionPublicRow(input: {
  readonly planned: PublicRepackDetailV3; readonly actual: PublicRepackViewSummaryV3;
  readonly expectedEv: unknown; readonly detail: boolean;
}): void {
  const actual = input.actual as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(input.planned)) {
    if (key === "evEstimates") continue;
    if (!input.detail && (key === "description" || key === "actions")) continue;
    equal(actual[key], value);
  }
  equal(input.actual.evEstimates.vendorReported, input.planned.evEstimates.vendorReported);
  equal(input.actual.evEstimates.packScout, input.expectedEv);
}

/** Parses the same six public APIs consumed by the frontend, bounded to this release. */
export async function verifyClutchpacksProductionPublicReadback(input: {
  readonly plan: DataReleaseV3PublishPlan; readonly client: SignedConvexDataReleaseV3PublicationClient;
  readonly publicClient: Pick<ConvexHttpClient, "action" | "query">; readonly activeState: DataReleaseV3ActiveState;
  readonly catalogReadToken: string;
}) {
  const { plan } = input;
  const rows = plan.batches.filter(batch => batch.kind === "repacks")
    .flatMap(batch => batch.records.map(row => publicRepackDetailV3Schema.parse(row)));
  const cards = plan.batches.filter(batch => batch.kind === "collectibles")
    .flatMap(batch => batch.records.map(row => publicCollectibleSchema.parse(row)));
  const chases = plan.batches.filter(batch => batch.kind === "chases")
    .flatMap(batch => batch.records.map(row => publicRepackChaseSchema.parse(row)));
  if (rows.length < 1 || rows.length > 50 || cards.length === 0) return refuse();
  const auth = { catalogReadToken: input.catalogReadToken };
  const witnessRequest = localClutchpacksRetainedEvWitnessRequest({ publicReleaseId: plan.publicReleaseId,
    releaseFingerprint: plan.releaseFingerprint, rows, state: input.activeState });
  const witness = await input.client.retainedEvWitness(witnessRequest);
  const expectedEv = localClutchpacksExpectedEv({ rows, request: witnessRequest, witness });
  const expectedRelease = dataReleaseV3IdentitySchema.parse({ schemaVersion: "data_release_v3",
    publicReleaseId: plan.publicReleaseId, methodVersion: plan.manifest.methodVersion,
    confidencePolicyVersion: plan.manifest.confidencePolicyVersion,
    publicEvPolicyVersion: plan.manifest.publicEvPolicyVersion, dataAsOf: plan.manifest.dataAsOf,
    completedAt: input.activeState.activeRelease?.completedAt });
  const verifyRows = (actualRows: readonly PublicRepackViewSummaryV3[], detail: boolean, clock: string) => {
    for (const actual of actualRows) {
      const planned = rows.find(row => row.publicRepackId === actual.publicRepackId);
      if (planned === undefined) return refuse();
      assertClutchpacksProductionPublicRow({ planned, actual, detail, expectedEv: expectedEv(planned, clock) });
    }
  };
  const [shell, list, dashboard] = await Promise.all([
    input.publicClient.action(api.publicRepacksV3.getPublicShellStatusV3, auth).then(parseGetPublicShellStatusV3Result).then(data),
    input.publicClient.action(api.publicRepacksV3.listPublicRepacksV3, { pageSize: 50, filters: { availability: "all" }, ...auth })
      .then(parseListPublicRepacksV3Result).then(data),
    input.publicClient.action(api.publicRepacksV3.getDashboardBundleV3, { filters: { availability: "all" }, ...auth })
      .then(parseGetDashboardBundleV3Result).then(data),
  ]);
  for (const response of [shell, list, dashboard]) equal(response.release, expectedRelease);
  equal(list.range.total, rows.length);
  equal(list.nextCursor, null);
  equal(list.rows.map(row => row.publicRepackId).sort(), rows.map(row => row.publicRepackId).sort());
  verifyRows(list.rows, false, list.confidenceEvaluatedAt);
  verifyRows(list.details, true, list.confidenceEvaluatedAt);
  if (list.selectedRepack !== null) verifyRows([list.selectedRepack], true, list.confidenceEvaluatedAt);
  const details = [];
  for (const planned of rows) {
    const actual = data(parseGetPublicRepackV3Result(await input.publicClient.action(api.publicRepacksV3.getPublicRepackV3,
      { publicReleaseId: plan.publicReleaseId, publicRepackId: planned.publicRepackId, ...auth })));
    // The direct detail contract has no envelope clock. A presented estimate
    // carries its own validated clock; unavailable facts do not age.
    const detailClock = actual.evEstimates.packScout.status === "last_known"
      ? actual.evEstimates.packScout.confidenceEvaluatedAt : list.confidenceEvaluatedAt;
    assertClutchpacksProductionPublicRow({ planned, actual, detail: true,
      expectedEv: expectedEv(planned, detailClock) });
    details.push(actual);
  }
  const ranked = rows.map(row => ({ row, ev: expectedEv(row, dashboard.confidenceEvaluatedAt) }))
    .filter(({ row, ev }) => row.availability === "available" && ev.status !== "unavailable" &&
      (ev.status !== "last_known" || ev.historicalSoldOutAt === null))
    .sort((left, right) => {
      if (left.ev.status === "unavailable" || right.ev.status === "unavailable") return refuse();
      return right.ev.metrics.evDollars.minorUnits - left.ev.metrics.evDollars.minorUnits ||
        left.row.publicRepackId.localeCompare(right.row.publicRepackId);
    }).slice(0, 6);
  equal(dashboard.opportunities.map(row => row.publicRepackId), ranked.map(({ row }) => row.publicRepackId));
  verifyRows(dashboard.opportunities, false, dashboard.confidenceEvaluatedAt);
  verifyRows(dashboard.details, true, dashboard.confidenceEvaluatedAt);
  if (dashboard.selectedRepack !== null) verifyRows([dashboard.selectedRepack], true, dashboard.confidenceEvaluatedAt);
  const probes = [...new Set([cards[0]!.publicCollectibleId, cards[Math.floor(cards.length / 2)]!.publicCollectibleId,
    cards.at(-1)!.publicCollectibleId, ...rows.flatMap(row => row.topChase === null ? [] : [row.topChase.publicCollectibleId])])];
  const desiredReads = [];
  for (const id of probes) {
    const desired = data(parseFindRepacksByDesiredCollectibleV3Result(await input.publicClient.action(
      api.publicRepacksV3.findRepacksByDesiredCollectibleV3,
      { publicCollectibleId: id, filters: { availability: "all" }, limit: 50, ...auth })));
    equal(desired.release, expectedRelease);
    const card = cards.find(row => row.publicCollectibleId === id);
    if (card === undefined) return refuse();
    equal(desired.desiredCollectible, { publicCollectibleId: card.publicCollectibleId, name: card.name,
      collectibleType: card.collectibleType, publicCategoryIds: card.publicCategoryIds,
      primaryImage: card.primaryImage, valuation: card.valuation });
    const expected = chases.filter(row => row.publicCollectibleId === id);
    equal(desired.total, expected.length);
    equal(desired.matches.map(row => row.chase).sort((a, b) => a.publicRepackId.localeCompare(b.publicRepackId)),
      [...expected].sort((a, b) => a.publicRepackId.localeCompare(b.publicRepackId)));
    verifyRows(desired.matches.map(row => row.repack), false, desired.confidenceEvaluatedAt);
    desiredReads.push(desired);
  }
  const search = data(parseSearchPublicCollectiblesV3Result(await input.publicClient.query(
    api.publicRepacksV3.searchPublicCollectiblesV3, { search: cards[0]!.normalizedName.slice(0, 100), limit: 20, ...auth })));
  equal(search.release, expectedRelease);
  if (search.matches.length === 0) return refuse();
  for (const card of search.matches) equal(card, cards.find(row => row.publicCollectibleId === card.publicCollectibleId));
  const end = data(parseGetPublicShellStatusV3Result(await input.publicClient.action(api.publicRepacksV3.getPublicShellStatusV3, auth)));
  equal(end.release, expectedRelease);
  assertLocalClutchpacksWitnessUnchanged(witness, await input.client.retainedEvWitness(witnessRequest));
  return { verifiedAt: new Date().toISOString(), repackCount: rows.length, rows: list.rows,
    publicReadbackSha256: productionPublicationSha256({ shell, list, dashboard, details, desiredReads, search, end, witness }) };
}
