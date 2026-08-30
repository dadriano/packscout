import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { verifyLocalClutchpacksPublicReadback } = await tsImport(
  "./distributed-clutchpacks-public-readback.mts", import.meta.url,
);
const { presentLastKnownPackScoutEvV3 } = await tsImport(
  "../../packages/contracts/src/data-release-v3.ts", import.meta.url,
);
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
    publicRepackId,
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
  return {
    currentTime,
    expectedRepackIds: expectedRows.map(({ publicRepackId }) => publicRepackId),
    expectedV3Rows: expectedRows,
    manifestPublicReleaseId: "manifest-release",
    v3PublicReleaseId: "v3-release",
    manifestShell: { ok: true, data: { metadata: { publicReleaseId: "manifest-release" } } },
    manifestList: { ok: true, data: { metadata: { publicReleaseId: "manifest-release" },
      range: { total: expectedRows.length },
      rows: expectedRows.map(({ publicRepackId }) => ({ publicRepackId })) } },
    v3Shell: { ok: true, data: { release: { publicReleaseId: "v3-release" } } },
    v3List: { ok: true, data: { release: { publicReleaseId: "v3-release" },
      range: { total: expectedRows.length }, rows: actualRows.map(row=>displayed(row,currentTime)) } },
    dashboard: { ok: true, data: { release: { publicReleaseId: "v3-release" },
      opportunities: opportunities.map(row=>displayed(row,currentTime)) } },
  };
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
  const prior = displayed(row("pack-a"));
  const latest = unavailable("pack-a");
  latest.evEstimates.packScout.calculatedAt = new Date(currentTime).toISOString();
  const retained = {...latest, evEstimates:{...latest.evEstimates,
    packScout:presentLastKnownPackScoutEvV3({
      estimate:prior.evEstimates.packScout, calculationPriceUsdMinor:10_000,
      referenceTimeIso:new Date(currentTime).toISOString(),
      latestUnavailableReason:"SOURCE_EVIDENCE_UNAVAILABLE",
    })}};
  const input = {...readback([latest], [retained], [retained], currentTime), previousV3Rows:[prior]};
  assert.equal(verifyLocalClutchpacksPublicReadback(input).knownEstimateCount,1);
  assert.equal(input.v3List.data.rows[0].evEstimates.packScout.confidence.scoreBasisPoints,0);
  assert.throws(()=>verifyLocalClutchpacksPublicReadback({
    ...readback([latest], [], [latest], currentTime), previousV3Rows:[prior],
  }),refused);
});

test("nonempty eligible catalog with empty, reverse-ranked, or unavailable opportunities fails", () => {
  const best = row("pack-a", -100);
  const worse = row("pack-b", -5_000);
  for (const opportunities of [[], [worse, best], [unavailable("pack-a")]]) {
    assert.throws(() => verifyLocalClutchpacksPublicReadback(readback([best, worse], opportunities)), refused);
  }
});

test("empty catalog is valid only when both catalogs and dashboard are empty", () => {
  assert.deepEqual(verifyLocalClutchpacksPublicReadback(readback([], [])), {
    manifestRepackCount: 0, v3RepackCount: 0, knownEstimateCount: 0,
    agedEstimateCount: 0, dashboardOpportunityCount: 0,
  });
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
