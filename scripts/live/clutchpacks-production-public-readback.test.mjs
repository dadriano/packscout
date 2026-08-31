import assert from "node:assert/strict";
import test from "node:test";
import { register } from "tsx/esm/api";
import { getFunctionName } from "convex/server";

register();
const { verifyClutchpacksProductionPublicReadback: verify, assertClutchpacksProductionPublicRow: assertRow } =
  await import("./clutchpacks-production-public-readback.mts");
const { publicCollectibleSchema, publicRepackViewSummaryV3FromDetail: summary,
  dataReleaseV3RetainedEvWitnessSchema, buildPublicCollectibleSearchText } = await import("@packscout/contracts");
const { buildDataReleaseV3Identity, buildPublicRepackDetailV3, buildPublicRepackViewDetailV3,
  buildPublicShellStatusV3, buildPackScoutPublicEvCurrentV3 } =
  await import("../../packages/contracts/src/__fixtures__/data-release-v3.fixture.ts");
const publicParsers = await import("../../apps/frontend/lib/public-repacks-v3.ts");

// Acceptance map: exact static rows/actions, server-clock EV, signed witness
// binding, all public response projections, and unassociated collectible reads.
const CLOCK = "2026-08-19T18:45:00.000Z";
const FINGERPRINT = "a".repeat(64);
const filters = { vendors: [], categories: [], collectibleTypes: [], availability: "all",
  price: { mode: "full", minMinor: 1000, maxMinor: 1200000 } };
const facets = { vendors: [], categories: [], collectibleTypes: [] };
const display = card => Object.fromEntries(["publicCollectibleId", "name", "collectibleType",
  "publicCategoryIds", "primaryImage", "valuation"].map(key => [key, card[key]]));
const refused = error => /PUBLIC_READBACK_FAILED/.test(error.code ?? error.message);

function fixture({ unavailable = false, mutate = () => {}, mutateWitness = () => {} } = {}) {
  const release = buildDataReleaseV3Identity();
  const raw = buildPublicRepackDetailV3({ vendorKey: "clutchpacks" });
  if (unavailable) raw.evEstimates.packScout = { status: "unavailable",
    methodVersion: release.methodVersion, confidencePolicyVersion: release.confidencePolicyVersion,
    calculatedAt: raw.sourceUpdatedAt, dataAsOf: { state: "known", observedAt: raw.sourceUpdatedAt },
    metrics: null, confidence: null, reason: "SOURCE_EVIDENCE_UNAVAILABLE" };
  const view = buildPublicRepackViewDetailV3(raw, { confidenceEvaluatedAt: CLOCK });
  const cardFields = { ...raw.topChase.collectible, normalizedName: "charizard ex 199", aliases: [], normalizedAliases: [],
    year: null, brand: null, setOrSeries: null, cardNumber: null, referenceNumber: null, subject: null,
    grade: null, grader: null, dataAsOf: raw.sourceUpdatedAt };
  const card = publicCollectibleSchema.parse({ ...cardFields, searchText: buildPublicCollectibleSearchText(cardFields) });
  const unassociated = publicCollectibleSchema.parse({ ...card, publicCollectibleId: "00000000-0000-5000-8000-000000000299" });
  const cards = [card, unassociated];
  const plan = { publicReleaseId: release.publicReleaseId, releaseFingerprint: FINGERPRINT,
    manifest: { ...release, counts: { categories: 1, collectibles: 2, repacks: 1, chases: 1, searchShards: 1 } },
    batches: [{ kind: "repacks", records: [raw] }, { kind: "collectibles", records: cards },
      { kind: "chases", records: [raw.topChase] }] };
  const scope = { vendorKey: raw.vendorKey, publicVendorId: raw.publicVendorId, publicRepackId: raw.publicRepackId };
  const witness = dataReleaseV3RetainedEvWitnessSchema.parse({ generation: 3,
    activePublicReleaseId: release.publicReleaseId, activeReleaseFingerprint: FINGERPRINT,
    retention: { operationId: "fixture-retention", direction: "forward", changesSha256: "b".repeat(64) },
    entries: [{ ...scope, activeFacts: { availability: raw.availability, estimate: raw.evEstimates.packScout,
      calculationPriceUsdMinor: raw.price.usdComparison.value.minorUnits }, retained: unavailable ? null : {
      estimate: raw.evEstimates.packScout, calculationPriceUsdMinor: raw.price.usdComparison.value.minorUnits,
      sourcePublicReleaseId: release.publicReleaseId, latestUnavailableAttempt: null } }], witnessSha256: "c".repeat(64) });
  const shell = { ...buildPublicShellStatusV3(), confidenceEvaluatedAt: CLOCK, providerHealthEvaluatedAt: CLOCK };
  const list = { ...shell, rows: [summary(view)], details: [view], selectedRepack: view,
    selectedRepackEligible: true, desiredCollectible: null, desiredChaseMatches: [], facets,
    activeQuery: { search: "", filters, sort: "packscout_ev_dollars", direction: "desc", pageSize: 50,
      desiredPublicCollectibleId: null }, queryFingerprint: "d".repeat(64), nextCursor: null,
    hasPrevious: false, range: { start: 1, end: 1, total: 1 }, paginationReset: null };
  const dashboard = { ...shell, opportunities: unavailable ? [] : [summary(view)], details: unavailable ? [] : [view],
    selectedRepack: unavailable ? null : view, kpis: { totalRepacks: 1,
      medianPackScoutEvPercent: { status: "unavailable", basisPoints: null, reason: "ESTIMATE_UNAVAILABLE" }, highestChaseValueUsdMinor: 85000,
      highConfidenceRepacks: 0 }, vendorSummaries: [], categorySummaries: [], facets, activeFilters: filters };
  const calls = [];
  const answer = (reference, args) => {
    const name = getFunctionName(reference).split(":")[1];
    assert.equal(args.catalogReadToken, "fixture-catalog-read-token");
    calls.push({ name, id: args.publicCollectibleId ?? null });
    let payload;
    if (name === "getPublicShellStatusV3") payload = shell;
    else if (name === "listPublicRepacksV3") payload = list;
    else if (name === "getDashboardBundleV3") payload = dashboard;
    else if (name === "getPublicRepackV3") {
      assert.equal(args.publicReleaseId, release.publicReleaseId);
      assert.equal(args.publicRepackId, raw.publicRepackId);
      payload = view;
    } else if (name === "findRepacksByDesiredCollectibleV3") {
      const selected = cards.find(value => value.publicCollectibleId === args.publicCollectibleId);
      assert.ok(selected);
      const matches = selected === card ? [{ repack: summary(view), chase: raw.topChase }] : [];
      const { providerHealthSummary: _unused, ...context } = shell;
      payload = { ...context, desiredCollectible: display(selected), matches, total: matches.length };
    } else if (name === "searchPublicCollectiblesV3") payload = { release, matches: [card] };
    else throw new Error("UNEXPECTED_PUBLIC_READ");
    const result = { ok: true, data: structuredClone(payload) };
    const parse = publicParsers[`parse${name[0].toUpperCase()}${name.slice(1)}Result`];
    assert.equal(parse(result).ok, true, `valid ${name} fixture before mutation`);
    mutate(name, result, args, { raw, view, cards });
    return Promise.resolve(result);
  };
  let witnessCalls = 0;
  return { raw, view, calls, cards, input: { plan, catalogReadToken: "fixture-catalog-read-token",
    activeState: { generation: 3, activeRelease: { ...release, releaseFingerprint: FINGERPRINT }, previousRelease: null },
    client: { async retainedEvWitness(request) {
      assert.equal(request.expectedGeneration, 3);
      assert.equal(request.expectedActiveReleaseFingerprint, FINGERPRINT);
      const result = structuredClone(witness); mutateWitness(result, ++witnessCalls); return result;
    } }, publicClient: { action: answer, query: answer } } };
}

test("direct detail uses its nested presentation clock and unassociated approved cards may match zero packs", async () => {
  const f = fixture();
  assert.equal(f.view.confidenceEvaluatedAt, undefined);
  assert.equal(f.view.evEstimates.packScout.confidenceEvaluatedAt, CLOCK);
  const result = await verify(f.input);
  assert.equal(result.repackCount, 1);
  assert.match(result.publicReadbackSha256, /^[a-f0-9]{64}$/);
  assert.equal(f.calls.filter(call => call.name === "findRepacksByDesiredCollectibleV3").length, 2);
  assert.deepEqual(new Set(f.calls.map(call => call.name)), new Set(["getPublicShellStatusV3", "listPublicRepacksV3",
    "getDashboardBundleV3", "getPublicRepackV3", "findRepacksByDesiredCollectibleV3", "searchPublicCollectiblesV3"]));
});

test("never-calculated EV has no invented clock and no dashboard opportunity", async () => {
  assert.equal((await verify(fixture({ unavailable: true }).input)).repackCount, 1);
});

test("row proof allows dynamic heat/health and summary shape but rejects changed catalog facts", () => {
  const { raw, view } = fixture();
  const actual = summary(view);
  assert.doesNotThrow(() => assertRow({ planned: raw, actual, expectedEv: view.evEstimates.packScout, detail: false }));
  for (const change of [row => { row.name += " changed"; }, row => { row.categories[0].label = "Wrong category"; },
    row => { row.topChase.observedAt = "2026-08-19T18:01:00.000Z"; },
    row => { row.sourceUpdatedAt = "2026-08-19T18:01:00.000Z"; }, row => { row.actionAvailability.repackLink = false; }]) {
    const changed = structuredClone(actual); change(changed);
    assert.throws(() => assertRow({ planned: raw, actual: changed, expectedEv: view.evEstimates.packScout, detail: false }), refused);
  }
});

test("dashboard must match signed EV facts even when internally valid rows retain the same IDs", async () => {
  const f = fixture({ mutate(name, result, _args, { raw }) {
    if (name !== "getDashboardBundleV3") return;
    const changed = buildPublicRepackViewDetailV3({ ...raw, evEstimates: { ...raw.evEstimates,
      packScout: buildPackScoutPublicEvCurrentV3(9500) } }, { confidenceEvaluatedAt: CLOCK });
    Object.assign(result.data, { opportunities: [summary(changed)], details: [changed], selectedRepack: changed });
  } });
  await assert.rejects(verify(f.input), refused);
});

test("list and dashboard detail actions are bound to the plan independently of the direct detail endpoint", async () => {
  for (const surface of ["listPublicRepacksV3", "getDashboardBundleV3"]) {
    const f = fixture({ mutate(name, result) {
      if (name !== surface) return;
      result.data.details[0].actions.repackLink.listingUrl = "https://vendor.example/repacks/wrong";
      result.data.selectedRepack = result.data.details[0];
    } });
    await assert.rejects(verify(f.input), refused);
  }
});

test("desired reads bind both the zero-match collectible and matching repack facts", async () => {
  for (const kind of ["unassociated", "repack"]) {
    const f = fixture({ mutate(name, result) {
      if (name !== "findRepacksByDesiredCollectibleV3") return;
      if (kind === "unassociated" && result.data.total === 0) result.data.desiredCollectible.name += " wrong";
      if (kind === "repack" && result.data.total > 0) result.data.matches[0].repack.name += " wrong";
    } });
    await assert.rejects(verify(f.input), refused);
  }
});

test("release metadata cannot change while retaining the public release ID", async () => {
  const f = fixture({ mutate(name, result) {
    if (name === "searchPublicCollectiblesV3") result.data.release.dataAsOf = "2026-08-19T17:59:00.000Z";
  } });
  await assert.rejects(verify(f.input), refused);
});

test("missing list rows, changed chase evidence, parser failures, and changed end witness refuse", async () => {
  const cases = [
    { mutate(name, result) { if (name === "listPublicRepacksV3") result.data.range.total = 2; } },
    { mutate(name, result) { if (name === "findRepacksByDesiredCollectibleV3" && result.data.total > 0)
      result.data.matches[0].chase.evidenceKinds = ["historical_pull_inference"]; } },
    { mutate(name, result) { if (name === "getPublicShellStatusV3") result.data.providerHealthEvaluatedAt = "invalid"; } },
    { mutateWitness(witness, count) { if (count === 2) witness.witnessSha256 = "e".repeat(64); } },
    { mutateWitness(witness) { witness.entries[0].activeFacts.availability = "sold_out"; } },
  ];
  for (const options of cases) await assert.rejects(verify(fixture(options).input), refused);
});
