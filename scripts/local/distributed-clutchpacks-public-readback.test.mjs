import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { verifyLocalClutchpacksContentReadback } = await tsImport("./distributed-clutchpacks-public-readback.mts", import.meta.url);

test("content readback detects missing chases and altered source clocks or counts on either public surface", () => {
  const expectedRows = [{ publicRepackId: "pack-one", topChase: { publicCollectibleId: "card-one", observedAt: "2026-08-30T12:00:00.000Z" },
    contentSummary: { knownCollectibleCount: 1, chaseCount: 1 }, collectibleTypes: ["card"] }];
  verifyLocalClutchpacksContentReadback({ expectedRows, manifestRows: expectedRows, v3Rows: expectedRows });
  for (const field of ["manifestRows", "v3Rows"]) for (const mutate of [
    (row) => { row.topChase = null; }, (row) => { row.topChase.observedAt = "2026-08-30T13:00:00.000Z"; },
    (row) => { row.contentSummary.knownCollectibleCount = 0; },
  ]) {
    const actual = structuredClone(expectedRows); mutate(actual[0]);
    assert.throws(() => verifyLocalClutchpacksContentReadback({ expectedRows, manifestRows: expectedRows, v3Rows: expectedRows, [field]: actual }),
      (error) => error.code === "LOCAL_CONVEX_PUBLIC_READBACK_FAILED");
  }
});

const { verifyLocalClutchpacksPublicReadback } = await tsImport(
  "./distributed-clutchpacks-public-readback.mts", import.meta.url,
);
const { presentLastKnownPackScoutEvV3 } = await tsImport(
  "../../packages/contracts/src/data-release-v3.ts", import.meta.url,
);
const { PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION, dataReleaseV3RetainedEvWitnessSchema } = await tsImport("@packscout/contracts", import.meta.url);
const uuid = (label) => /^[0-9a-f-]{36}$/u.test(label) ? label :
  `00000000-0000-5000-8000-${Buffer.from(label).toString("hex").slice(-12).padStart(12, "0")}`;
const RELEASE_ID = uuid("release");
const VENDOR_ID = uuid("vendor");
const FINGERPRINT = "a".repeat(64);
const NOW = Date.parse("2026-08-30T01:00:00.000Z");
const OBSERVED_AT = "2026-08-30T00:10:00.000Z";
const EXPIRES_AT = "2026-08-30T01:10:00.000Z";
const versions = {
  methodVersion: "packscout-buyback-adjusted-ev-v1",
  confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
};
const usd = (minorUnits) => ({ minorUnits, currency: "USD" });

function row(publicRepackId, evMinor = -2_000, availability = "available") {
  return {
    publicRepackId: uuid(publicRepackId), vendorKey: "clutchpacks", publicVendorId: VENDOR_ID,
    availability,
    price: {displayMoney:usd(10_000), usdComparison:{status:"available",value:usd(10_000)}},
    evEstimates: {
      vendorReported: { status: "unavailable", sourceMoney: null, usdComparison: null,
        observedAt: null, reason: "NOT_REPORTED" },
      packScout: {
        status: "current", ...versions,
        metrics: { grossEvMoney: usd(10_000 + evMinor), grossReturnBasisPoints: 10_000 + evMinor,
          evDollars: usd(evMinor), evPercentBasisPoints: evMinor },
        confidence: { policyVersion: versions.confidencePolicyVersion, scoreBasisPoints: 10_000,
          band: "high", limitationCodes: [] },
        calculatedAt: "2026-08-30T00:15:00.000Z",
        dataAsOf: { state: "known", observedAt: OBSERVED_AT },
        sourceAge: { milliseconds: 300_000, state: "fresh_within_15_minutes" },
        expiresAt: EXPIRES_AT,
      },
    },
  };
}
function unavailable(publicRepackId) {
  const result = row(publicRepackId);
  result.evEstimates.packScout = {
    status: "unavailable", ...versions, metrics: null, confidence: null,
    calculatedAt: "2026-08-30T00:15:00.000Z",
    dataAsOf: { state: "unknown_source_time", observedAt: null },
    reason: "SOURCE_EVIDENCE_UNAVAILABLE",
  };
  return result;
}
function displayed(row, currentTime = NOW) {
  return {...row, evEstimates:{...row.evEstimates,
    packScout:presentLastKnownPackScoutEvV3({estimate:row.evEstimates.packScout,
      calculationPriceUsdMinor:10_000, referenceTimeIso:new Date(currentTime).toISOString()})}};
}
function readback(expectedRows, opportunities, actualRows = expectedRows, currentTime = NOW) {
  const context = { confidenceEvaluatedAt: new Date(currentTime).toISOString(),
    providerHealthEvaluatedAt: new Date(currentTime).toISOString(),
    publicFreshnessPolicyVersion: PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION };
  const scopes = expectedRows.map(({ vendorKey, publicVendorId, publicRepackId }) => ({ vendorKey, publicVendorId, publicRepackId }));
  const result = {
    witnessRequest: { expectedGeneration: 3, expectedActivePublicReleaseId: RELEASE_ID,
      expectedActiveReleaseFingerprint: FINGERPRINT, scopes },
    witness: { generation: 3, activePublicReleaseId: RELEASE_ID, activeReleaseFingerprint: FINGERPRINT,
      retention: { operationId: "fixture-retention", direction: "forward", changesSha256: "b".repeat(64) },
      entries: expectedRows.map((row, index) => ({ ...scopes[index], activeFacts: {
        availability: row.availability, estimate: row.evEstimates.packScout,
        calculationPriceUsdMinor: row.price.usdComparison.value.minorUnits },
        retained: row.evEstimates.packScout.status === "unavailable" ? null : {
          estimate: row.evEstimates.packScout, calculationPriceUsdMinor: 10_000,
          sourcePublicReleaseId: RELEASE_ID, latestUnavailableAttempt: null } })), witnessSha256: "c".repeat(64) },
    expectedRepackIds: expectedRows.map(({ publicRepackId }) => publicRepackId),
    expectedV3Rows: expectedRows,
    manifestPublicReleaseId: "manifest-release",
    v3PublicReleaseId: RELEASE_ID,
    manifestShell: { ok: true, data: { metadata: { publicReleaseId: "manifest-release" } } },
    manifestList: { ok: true, data: { metadata: { publicReleaseId: "manifest-release" },
      range: { total: expectedRows.length },
      rows: expectedRows.map(({ publicRepackId }) => ({ publicRepackId })) } },
    v3Shell: { ok: true, data: { ...context, release: { publicReleaseId: RELEASE_ID } } },
    v3List: { ok: true, data: { ...context, release: { publicReleaseId: RELEASE_ID },
      range: { total: expectedRows.length }, rows: actualRows.map(row=>displayed(row,currentTime)) } },
    dashboard: { ok: true, data: { ...context, release: { publicReleaseId: RELEASE_ID },
      opportunities: opportunities.map(row=>displayed(row,currentTime)) } },
  };
  if (expectedRows.length > 0) dataReleaseV3RetainedEvWitnessSchema.parse(result.witness);
  return result;
}
function retain(input, original, latest = null) {
  input.witness.entries.find(({ publicRepackId }) => publicRepackId === original.publicRepackId).retained = {
    estimate: original.evEstimates.packScout, calculationPriceUsdMinor: original.price.usdComparison.value.minorUnits,
    sourcePublicReleaseId: uuid("prior"), latestUnavailableAttempt: latest === null ? null : {
      calculatedAt: latest.evEstimates.packScout.calculatedAt, reason: latest.evEstimates.packScout.reason },
  };
  return input;
}
const refused = (error) => error.code === "LOCAL_CONVEX_PUBLIC_READBACK_FAILED";

test("readback proves signed-EV ranking while retaining sold-out and unavailable catalog rows", () => {
  const first = row("pack-a", -100);
  const second = row("pack-b", -900);
  const soldOut = row("pack-c", 0, "sold_out");
  const unavailablePack = row("pack-d", 0, "unavailable");
  const unknownPack = row("pack-e", 0, "unknown");
  const missingEstimate = unavailable("pack-f");
  const expected = [second, soldOut, first, unavailablePack, unknownPack, missingEstimate];
  const input = readback(expected, [first, second], [...expected].reverse());
  assert.deepEqual(verifyLocalClutchpacksPublicReadback(input), {
    manifestRepackCount: 6, v3RepackCount: 6, knownEstimateCount: 5,
    agedEstimateCount: 0, dashboardOpportunityCount: 2,
  });
});

test("readback requires only top six, resolving equal signed EV by public identity", () => {
  const expected = ["h", "g", "f", "e", "d", "c", "b", "a"].map((id) => row(id, -100));
  const ranked = [...expected].reverse().slice(0, 6);
  assert.equal(verifyLocalClutchpacksPublicReadback(readback(expected, ranked)).dashboardOpportunityCount, 6);
  assert.throws(() => verifyLocalClutchpacksPublicReadback(readback(expected, ranked.reverse())), refused);
  assert.throws(() => verifyLocalClutchpacksPublicReadback(readback(expected, [...expected].reverse())), refused);
});

test("age never erases known values or empties opportunities", () => {
  const original = row("pack-a");
  const snapshot = structuredClone(original);
  const currentTime = Date.parse(EXPIRES_AT) + 24 * 60 * 60_000;
  const input = readback([original], [original], [original], currentTime);
  assert.deepEqual(verifyLocalClutchpacksPublicReadback(input), {
    manifestRepackCount: 1, v3RepackCount: 1, knownEstimateCount: 1,
    agedEstimateCount: 1, dashboardOpportunityCount: 1,
  });
  assert.deepEqual(original, snapshot, "readback cannot mutate the immutable plan");
  assert.equal(input.dashboard.data.opportunities[0].evEstimates.packScout.confidence.scoreBasisPoints,0);
  assert.throws(() => verifyLocalClutchpacksPublicReadback(readback([original], [], [original], currentTime)), refused);
});

test("the exact one-hour threshold retains values and never-calculated states stay unavailable", () => {
  const current = row("pack-current");
  const absent = unavailable("pack-absent");
  assert.equal(verifyLocalClutchpacksPublicReadback(
    readback([current, absent], [current], [current, absent], Date.parse(EXPIRES_AT)),
  ).knownEstimateCount, 1);
  assert.equal(verifyLocalClutchpacksPublicReadback(readback([absent], [])).dashboardOpportunityCount, 0);
});

test("sold-out historical EV remains visible as history but never ranks", () => {
  const history = row("pack-history", -100, "sold_out");
  history.evEstimates.packScout = {
    ...history.evEstimates.packScout, status: "sold_out_historical",
    soldOutAt: "2026-08-30T00:20:00.000Z", expiresAt: null,
  };
  assert.equal(verifyLocalClutchpacksPublicReadback({
    ...readback([history], [], [history], Date.parse(EXPIRES_AT) + 1),
  }).agedEstimateCount, 1);
  assert.throws(() => verifyLocalClutchpacksPublicReadback(readback([history], [history])), refused);
});

test("restocked packs retain sold-out EV without ranking until a newer valid calculation", () => {
  const history = row("pack-history", -100, "sold_out");
  history.evEstimates.packScout = {
    ...history.evEstimates.packScout, status: "sold_out_historical",
    soldOutAt: "2026-08-30T00:20:00.000Z", expiresAt: null,
  };
  const prior = displayed(history);
  const restocked = unavailable("pack-history");
  restocked.evEstimates.packScout.calculatedAt = "2026-08-30T00:30:00.000Z";
  const retained = { ...restocked, evEstimates: { ...restocked.evEstimates,
    packScout: presentLastKnownPackScoutEvV3({
      estimate: prior.evEstimates.packScout, calculationPriceUsdMinor: 10_000,
      referenceTimeIso: new Date(NOW).toISOString(),
      latestUnavailableReason: "SOURCE_EVIDENCE_UNAVAILABLE",
    }) } };
  const eligible = row("pack-eligible", -900);
  const input = retain(readback([restocked, eligible], [eligible], [retained, eligible]), history, restocked);
  assert.deepEqual(verifyLocalClutchpacksPublicReadback(input), {
    manifestRepackCount: 2, v3RepackCount: 2, knownEstimateCount: 2,
    agedEstimateCount: 0, dashboardOpportunityCount: 1,
  });
  const displayedEv = input.v3List.data.rows[0].evEstimates.packScout;
  assert.deepEqual(displayedEv.metrics, history.evEstimates.packScout.metrics);
  assert.equal(displayedEv.calculatedAt, history.evEstimates.packScout.calculatedAt);
  assert.equal(displayedEv.historicalSoldOutAt, history.evEstimates.packScout.soldOutAt);
  assert.throws(() => verifyLocalClutchpacksPublicReadback(retain(
    readback([restocked, eligible], [retained, eligible], [retained, eligible]), history, restocked)), refused);

  const recalculated = row("pack-history", -500);
  Object.assign(recalculated.evEstimates.packScout, {
    calculatedAt: "2026-08-30T00:45:00.000Z",
    dataAsOf: { state: "known", observedAt: "2026-08-30T00:40:00.000Z" },
    expiresAt: "2026-08-30T01:40:00.000Z",
  });
  const restored = readback([recalculated, eligible], [recalculated, eligible]);
  assert.equal(verifyLocalClutchpacksPublicReadback(restored).dashboardOpportunityCount, 2);
  assert.equal(restored.v3List.data.rows[0].evEstimates.packScout.historicalSoldOutAt, null);
});

test("same IDs with missing or changed published EV fail readback", () => {
  const planned = row("pack-a", -100);
  for (const actual of [unavailable("pack-a"), row("pack-a", -200)]) {
    assert.throws(() => verifyLocalClutchpacksPublicReadback(readback([planned], [planned], [actual])), refused);
  }
  const input = readback([planned], [planned]);
  input.dashboard.data.opportunities[0].evEstimates.packScout.confidence.scoreBasisPoints -= 1;
  assert.throws(() => verifyLocalClutchpacksPublicReadback(input), refused);
});

test("a later unavailable publication must retain the pinned predecessor's last valid values", () => {
  const currentTime = NOW + 24 * 60 * 60_000;
  const original = row("pack-a");
  const prior = displayed(original);
  const latest = unavailable("pack-a");
  latest.evEstimates.packScout.calculatedAt = new Date(currentTime).toISOString();
  const retained = {...latest, evEstimates:{...latest.evEstimates,
    packScout:presentLastKnownPackScoutEvV3({
      estimate:prior.evEstimates.packScout, calculationPriceUsdMinor:10_000,
      referenceTimeIso:new Date(currentTime).toISOString(),
      latestUnavailableReason:"SOURCE_EVIDENCE_UNAVAILABLE",
    })}};
  const input = retain(readback([latest], [retained], [retained], currentTime), original, latest);
  assert.equal(verifyLocalClutchpacksPublicReadback(input).knownEstimateCount,1);
  assert.equal(input.v3List.data.rows[0].evEstimates.packScout.confidence.scoreBasisPoints,0);
  assert.throws(()=>verifyLocalClutchpacksPublicReadback(retain(
    readback([latest], [], [latest], currentTime), original, latest)),refused);
});

test("nonempty eligible catalog with empty, reverse-ranked, or unavailable opportunities fails", () => {
  const best = row("pack-a", -100);
  const worse = row("pack-b", -5_000);
  for (const opportunities of [[], [worse, best], [unavailable("pack-a")]]) {
    assert.throws(() => verifyLocalClutchpacksPublicReadback(readback([best, worse], opportunities)), refused);
  }
});

test("an empty catalog cannot replace the bounded nonempty authenticated witness", () => {
  assert.throws(() => verifyLocalClutchpacksPublicReadback(readback([], [])), refused);
  assert.throws(() => verifyLocalClutchpacksPublicReadback(readback([], [row("unexpected-pack")])), refused);
});

test("pointer races, truncated availability-filtered results, duplicate IDs, and failed reads refuse", () => {
  const expected = [row("pack-a"), row("pack-b", -200, "sold_out")];
  const cases = [];
  for (const field of ["manifestShell", "manifestList", "v3Shell", "v3List", "dashboard"]) {
    const failed = readback(expected, [expected[0]]);
    failed[field] = { ok: false };
    cases.push(failed);
    const changed = readback(expected, [expected[0]]);
    const identity = field.startsWith("manifest") ? "metadata" : "release";
    changed[field].data[identity].publicReleaseId = "concurrent-release";
    cases.push(changed);
  }
  const truncated = readback(expected, [expected[0]]);
  truncated.manifestList.data.rows.pop();
  cases.push(truncated);
  const duplicate = readback(expected, [expected[0]]);
  duplicate.v3List.data.rows[1] = duplicate.v3List.data.rows[0];
  cases.push(duplicate);
  for (const input of cases) assert.throws(() => verifyLocalClutchpacksPublicReadback(input), refused);
});

test("list and dashboard use their own trusted confidence clocks without compounding decay", () => {
  const planned = row("clock");
  const input = readback([planned], [planned]);
  const later = NOW + 15 * 60_000;
  input.dashboard.data.confidenceEvaluatedAt = new Date(later).toISOString();
  input.dashboard.data.providerHealthEvaluatedAt = new Date(later).toISOString();
  input.dashboard.data.opportunities = [displayed(planned, later)];
  assert.equal(verifyLocalClutchpacksPublicReadback(input).dashboardOpportunityCount, 1);
  input.dashboard.data.opportunities = input.v3List.data.rows;
  assert.throws(() => verifyLocalClutchpacksPublicReadback(input), refused);
});

test("older and equal-time candidates cannot replace retained original metrics or calculation price", () => {
  const original = row("pack-original", -100);
  Object.assign(original.evEstimates.packScout, { calculatedAt: "2026-08-30T00:30:00.000Z",
    dataAsOf: { state: "known", observedAt: "2026-08-30T00:30:00.000Z" },
    sourceAge: { milliseconds: 0, state: "fresh_within_15_minutes" }, expiresAt: "2026-08-30T01:30:00.000Z" });
  for (const sameTime of [false, true]) {
    const candidate = row("pack-original", -900);
    if (sameTime) Object.assign(candidate.evEstimates.packScout, {
      calculatedAt: original.evEstimates.packScout.calculatedAt, dataAsOf: original.evEstimates.packScout.dataAsOf,
      sourceAge: original.evEstimates.packScout.sourceAge, expiresAt: original.evEstimates.packScout.expiresAt });
    const before = structuredClone(candidate);
    const input = retain(readback([candidate], [original], [original]), original);
    assert.equal(verifyLocalClutchpacksPublicReadback(input).knownEstimateCount, 1);
    assert.deepEqual(candidate, before);
  }
  const latest = unavailable("pack-original");
  latest.price = { displayMoney: usd(20_000), usdComparison: { status: "available", value: usd(20_000) } };
  latest.evEstimates.packScout.calculatedAt = "2026-08-30T00:40:00.000Z";
  const retained = { ...latest, evEstimates: { ...latest.evEstimates, packScout: presentLastKnownPackScoutEvV3({
    estimate: original.evEstimates.packScout, calculationPriceUsdMinor: 10_000,
    referenceTimeIso: new Date(NOW).toISOString(), latestUnavailableReason: "SOURCE_EVIDENCE_UNAVAILABLE" }) } };
  const input = retain(readback([latest], [retained], [retained]), original, latest);
  assert.equal(verifyLocalClutchpacksPublicReadback(input).knownEstimateCount, 1);
  assert.equal(input.v3List.data.rows[0].evEstimates.packScout.calculationPriceUsdMinor, 10_000);
});

test("unbound witnesses, mismatched active facts, and missing trusted clock policy cannot certify EV", () => {
  for (const mutate of [
    (input) => { input.witness.generation++; },
    (input) => { input.witness.activeReleaseFingerprint = "f".repeat(64); },
    (input) => { input.witness.entries[0].vendorKey = "courtyard"; },
    (input) => { input.witness.entries[0].activeFacts.availability = "sold_out"; },
    (input) => { input.witness.entries[0].retained.calculationPriceUsdMinor++; },
    (input) => { input.witness.entries[0].retained = null; },
    (input) => { delete input.v3List.data.confidenceEvaluatedAt; },
    (input) => { input.dashboard.data.publicFreshnessPolicyVersion = "obsolete"; },
    (input) => { input.v3Shell.data.providerHealthEvaluatedAt = "2020-01-01T00:00:00.000Z"; },
  ]) {
    const planned = row("pack-a"); const input = readback([planned], [planned]); mutate(input);
    assert.throws(() => verifyLocalClutchpacksPublicReadback(input), refused);
  }
});
