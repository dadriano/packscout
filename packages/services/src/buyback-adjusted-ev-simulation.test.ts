import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  publicRepackViewDetailV3Schema,
  unavailableRepackHeat,
  type PublicRepackDetailV3,
} from "@packscout/contracts";
import { calculatePackScoutBuybackAdjustedEvV1 } from "./buyback-adjusted-ev-calculator.ts";
import { evaluatePackScoutBuybackEvConfidenceV1 } from "./buyback-adjusted-ev-confidence.ts";
import { InMemoryDataReleaseV3Port } from "./buyback-adjusted-ev-release.test-support.ts";
import type {
  DataReleaseV3ActivateRequest,
  DataReleaseV3ApplyBatchRequest,
  DataReleaseV3FinalizeRequest,
  DataReleaseV3PublicationPort,
  DataReleaseV3RollbackRequest,
  DataReleaseV3StartRequest,
} from "./buyback-adjusted-ev-release-types.ts";
import {
  PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION,
  isPackScoutBuybackEvSimulatedPublicIdV1,
  type PackScoutBuybackEvSimulationControlsV1,
} from "./buyback-adjusted-ev-simulation-contracts.ts";
import {
  openPackScoutBuybackEvSimulationSessionV1,
  type PackScoutBuybackEvSimulationFrameResultV1,
  type PackScoutBuybackEvSimulationSessionV1,
} from "./buyback-adjusted-ev-simulation-runner.ts";
import {
  PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_KEYS_V1,
  buildPackScoutBuybackEvSimulationFrameV1,
} from "./buyback-adjusted-ev-simulation-scenarios.ts";
import type { OperationalObservability } from "./operational-events.ts";

const LOCAL_ORIGIN = "http://127.0.0.1:3211";

const CONTROLS: PackScoutBuybackEvSimulationControlsV1 = {
  seed: "sim-test",
  scenarioVersion: PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION,
  startAt: "2026-08-19T12:00:00.000Z",
  frameStepMilliseconds: 30 * 60_000,
};

/** Records every publication request so tests can string-scan stored bytes. */
class RecordingPort implements DataReleaseV3PublicationPort {
  readonly recorded: unknown[] = [];
  constructor(readonly inner = new InMemoryDataReleaseV3Port()) {}
  activeState() {
    return this.inner.activeState();
  }
  status(publicReleaseId: string) {
    return this.inner.status(publicReleaseId);
  }
  start(request: DataReleaseV3StartRequest) {
    this.recorded.push(request);
    return this.inner.start(request);
  }
  applyBatch(request: DataReleaseV3ApplyBatchRequest) {
    this.recorded.push(request);
    return this.inner.applyBatch(request);
  }
  finalize(request: DataReleaseV3FinalizeRequest) {
    this.recorded.push(request);
    return this.inner.finalize(request);
  }
  activate(request: DataReleaseV3ActivateRequest) {
    this.recorded.push(request);
    return this.inner.activate(request);
  }
  rollback(request: DataReleaseV3RollbackRequest) {
    this.recorded.push(request);
    return this.inner.rollback(request);
  }
}

interface RecordedOperational extends OperationalObservability {
  readonly entries: unknown[];
}

function recordedOperational(): RecordedOperational {
  const entries: unknown[] = [];
  return {
    entries,
    log: (event) => {
      entries.push(event);
    },
    metric: (metric) => {
      entries.push(metric);
    },
  };
}

async function openSession(
  overrides: Partial<PackScoutBuybackEvSimulationControlsV1> = {},
  port: DataReleaseV3PublicationPort = new RecordingPort(),
  operational?: OperationalObservability,
): Promise<PackScoutBuybackEvSimulationSessionV1> {
  return await openPackScoutBuybackEvSimulationSessionV1({
    port,
    controls: { ...CONTROLS, ...overrides },
    publicationOrigin: LOCAL_ORIGIN,
    ...(operational === undefined ? {} : { operational }),
  });
}

async function runFrames(
  session: PackScoutBuybackEvSimulationSessionV1,
  frameCount: number,
): Promise<PackScoutBuybackEvSimulationFrameResultV1[]> {
  const results: PackScoutBuybackEvSimulationFrameResultV1[] = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    results.push(await session.simulator.runFrame(frameIndex));
  }
  return results;
}

function detailFor(
  result: PackScoutBuybackEvSimulationFrameResultV1,
  scenarioKey: string,
): PublicRepackDetailV3 {
  const scenario = result.scenarioResults.find(
    (candidate) => candidate.scenarioKey === scenarioKey,
  );
  assert.ok(scenario, `missing scenario result ${scenarioKey}`);
  const detail = result.publicDetails.find(
    (candidate) => candidate.publicRepackId === scenario.publicRepackId,
  );
  assert.ok(detail, `missing public detail for ${scenarioKey}`);
  return detail;
}

test("the $100 outcome EV / 85% uniform buyback / $100 price example flows through the full production path", async () => {
  const session = await openSession();
  const [frame0] = await runFrames(session, 1);
  const detail = detailFor(frame0!, "courtyard-uniform-price-shift");
  const packScout = detail.evEstimates.packScout;
  assert.equal(packScout.status, "current");
  assert.ok(packScout.status === "current");
  assert.deepEqual(packScout.metrics, {
    grossEvMoney: { minorUnits: 8_500, currency: "USD" },
    grossReturnBasisPoints: 8_500,
    evDollars: { minorUnits: -1_500, currency: "USD" },
    evPercentBasisPoints: -1_500,
  });
  assert.equal(detail.price.usdComparison.status, "available");
  session.close();
});

test("identical controls replay byte-equivalent frames, revisions, and release identities", async () => {
  const evidenceA = buildPackScoutBuybackEvSimulationFrameV1(CONTROLS, 1);
  const evidenceB = buildPackScoutBuybackEvSimulationFrameV1(CONTROLS, 1);
  assert.equal(canonicalJson(evidenceA), canonicalJson(evidenceB));

  const sessionA = await openSession();
  const sessionB = await openSession();
  const resultsA = await runFrames(sessionA, 3);
  const resultsB = await runFrames(sessionB, 3);
  assert.equal(canonicalJson(resultsA), canonicalJson(resultsB));
  assert.equal(
    canonicalJson(sessionA.simulator.inspectCanonicalRevisionRows()),
    canonicalJson(sessionB.simulator.inspectCanonicalRevisionRows()),
  );
  for (const [index, result] of resultsA.entries()) {
    assert.equal(result.releaseFingerprint, resultsB[index]!.releaseFingerprint);
    assert.equal(result.publicReleaseId, resultsB[index]!.publicReleaseId);
    assert.equal(result.frameContentDigest, resultsB[index]!.frameContentDigest);
  }
});

test("re-running the previous frame is a convergent replay without new writes", async () => {
  const port = new RecordingPort();
  const session = await openSession({}, port);
  const first = await session.simulator.runFrame(0);
  const replay = await session.simulator.runFrame(0);
  assert.equal(first.publishOutcome, "activated");
  assert.equal(replay.publishOutcome, "unchanged");
  assert.equal(replay.frameContentDigest, first.frameContentDigest);
  assert.equal(replay.publicReleaseId, first.publicReleaseId);
});

test("seed, clock, and frame control changes each produce the expected new result", async () => {
  const baseline = await runFrames(await openSession(), 2);
  const reseeded = await runFrames(await openSession({ seed: "sim-other" }), 1);
  const shifted = await runFrames(
    await openSession({ startAt: "2026-08-19T13:00:00.000Z" }),
    1,
  );

  assert.notEqual(
    baseline[0]!.releaseFingerprint,
    reseeded[0]!.releaseFingerprint,
  );
  assert.notEqual(
    baseline[0]!.releaseFingerprint,
    shifted[0]!.releaseFingerprint,
  );
  assert.equal(shifted[0]!.readAt, "2026-08-19T13:00:00.000Z");

  // Price-driven transition: the $100 listing reprices to $80, its raw result
  // turns positive, and the public policy makes the estimate unavailable.
  const frame0 = baseline[0]!;
  const frame1 = baseline[1]!;
  const priced0 = detailFor(frame0, "courtyard-uniform-price-shift");
  const priced1 = detailFor(frame1, "courtyard-uniform-price-shift");
  assert.ok(priced0.evEstimates.packScout.status === "current");
  assert.ok(priced1.evEstimates.packScout.status === "unavailable");
  assert.equal(priced0.evEstimates.packScout.metrics.evDollars.minorUnits, -1_500);
  assert.equal(priced1.evEstimates.packScout.reason, "CALCULATION_UNAVAILABLE");

  const transitioned = ["courtyard-uniform-price-shift", "clutchpacks-pool-pulls", "trove-per-draw-final-payout"]
    .filter((scenarioKey) =>
      JSON.stringify(detailFor(frame0, scenarioKey).evEstimates) !==
        JSON.stringify(detailFor(frame1, scenarioKey).evEstimates),
    );
  assert.ok(
    transitioned.length >= 2,
    "at least two repacks must visibly transition between successive frames",
  );

  // The frozen sold-out history never changes between frames.
  assert.equal(
    JSON.stringify(detailFor(frame0, "trove-sold-out-historical").evEstimates),
    JSON.stringify(detailFor(frame1, "trove-sold-out-historical").evEstimates),
  );
});

test("every approved public state appears and passes the production contracts", async () => {
  const session = await openSession();
  const results = await runFrames(session, 4);
  const states = new Map<string, string[]>();
  for (const result of results) {
    for (const scenario of result.scenarioResults) {
      const seen = states.get(scenario.scenarioKey) ?? [];
      seen.push(
        scenario.publicState +
          (scenario.publicReason === null ? "" : `:${scenario.publicReason}`),
      );
      states.set(scenario.scenarioKey, seen);
    }
    for (const detail of result.publicDetails) {
      assert.ok(isPackScoutBuybackEvSimulatedPublicIdV1(detail.publicRepackId));
      assert.ok(detail.vendorKey.startsWith("simulated-"));
      assert.ok(detail.name.startsWith("[Simulated]"));
      // Heat stays explicitly unavailable on v3 views (documented divergence).
      const view = publicRepackViewDetailV3Schema.safeParse({
        ...detail,
        heat: unavailableRepackHeat(),
      });
      assert.ok(view.success);
      assert.ok(!JSON.stringify(detail).includes('"heat"'));
    }
  }
  for (const scenarioKey of PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_KEYS_V1) {
    assert.ok(states.has(scenarioKey), `missing scenario ${scenarioKey}`);
  }

  const frame0 = results[0]!;
  const frame2 = results[2]!;
  const frame3 = results[3]!;

  // Positive raw results fail closed; neutral, negative, and valid zero-payout
  // states remain available.
  const positiveRaw = detailFor(results[1]!, "courtyard-uniform-price-shift");
  assert.ok(positiveRaw.evEstimates.packScout.status === "unavailable");
  assert.equal(
    positiveRaw.evEstimates.packScout.reason,
    "CALCULATION_UNAVAILABLE",
  );
  const neutral = detailFor(frame2, "gamestop-fixed-offers");
  assert.ok(neutral.evEstimates.packScout.status === "current");
  assert.equal(neutral.evEstimates.packScout.metrics.evDollars.minorUnits, 0);
  const negative = detailFor(frame0, "beezie-usdc-parity");
  assert.ok(negative.evEstimates.packScout.status === "current");
  assert.ok(negative.evEstimates.packScout.metrics.evDollars.minorUnits < 0);
  const zeroPayout = detailFor(frame0, "courtyard-zero-payout");
  assert.ok(zeroPayout.evEstimates.packScout.status === "current");
  assert.equal(
    zeroPayout.evEstimates.packScout.metrics.grossEvMoney.minorUnits,
    0,
  );

  // Delayed evidence in both penalty bands with the approved limitations.
  const delayed20 = detailFor(frame0, "courtyard-delayed-20m");
  assert.ok(delayed20.evEstimates.packScout.status === "current");
  assert.deepEqual(delayed20.evEstimates.packScout.confidence.limitationCodes, [
    "platform_published_odds",
    "source_age_over_15_through_30_minutes",
  ]);
  const delayed45 = detailFor(frame0, "courtyard-delayed-45m");
  assert.ok(delayed45.evEstimates.packScout.status === "current");
  assert.deepEqual(delayed45.evEstimates.packScout.confidence.limitationCodes, [
    "platform_published_odds",
    "source_age_over_30_through_60_minutes",
  ]);

  // Midpoint and current-pool evidence: midpoint limitation, no odds penalty.
  const pool = detailFor(frame0, "clutchpacks-pool-pulls");
  assert.ok(pool.evEstimates.packScout.status === "current");
  assert.deepEqual(pool.evEstimates.packScout.confidence.limitationCodes, [
    "closed_range_midpoint",
  ]);

  // Unavailable states carry their stable public reasons.
  assert.deepEqual(states.get("courtyard-no-buyback"), [
    "unavailable:BUYBACK_UNAVAILABLE",
    "unavailable:BUYBACK_UNAVAILABLE",
    "unavailable:BUYBACK_UNAVAILABLE",
    "unavailable:BUYBACK_UNAVAILABLE",
  ]);
  assert.equal(
    states.get("clutchpacks-odds-conflict")![0],
    "unavailable:ODDS_UNAVAILABLE",
  );
  assert.equal(
    states.get("courtyard-incomplete-values")![0],
    "unavailable:VALUE_UNAVAILABLE",
  );

  // The fixed observation expires purely by advancing the calculation clock.
  assert.deepEqual(states.get("courtyard-source-age-expiry"), [
    "current",
    "current",
    "unavailable:SOURCE_DATA_STALE",
    "unavailable:SOURCE_DATA_STALE",
  ]);

  // Sold-out history stays frozen with its original confidence.
  assert.deepEqual(states.get("trove-sold-out-historical"), [
    "sold_out_historical",
    "sold_out_historical",
    "sold_out_historical",
    "sold_out_historical",
  ]);

  // Per-pack and per-draw unit bases both traverse the path.
  const frame = buildPackScoutBuybackEvSimulationFrameV1(CONTROLS, 0);
  const unitBases = new Set(
    frame.scenarios.flatMap((scenario) =>
      scenario.evidence.status === "complete"
        ? [scenario.evidence.input.unitBasis.kind]
        : [],
    ),
  );
  assert.deepEqual([...unitBases].sort(), ["per_draw", "per_pack"]);

  // Stablecoin parity normalized the USDC machine into USD cents.
  const parity = frame.scenarios.find(
    (scenario) => scenario.scenarioKey === "beezie-usdc-parity",
  )!;
  assert.ok(parity.evidence.status === "complete");
  assert.equal(
    parity.evidence.input.packPrice.sourceAmount.currency,
    "USDC",
  );
  assert.equal(parity.evidence.input.packPrice.canonicalUsdCents.numerator, 2_000);

  // Restock arrives as a new coherent observation at frame 3.
  const restocked = detailFor(frame3, "clutchpacks-pool-pulls");
  assert.ok(restocked.evEstimates.packScout.status === "current");
  assert.notEqual(
    restocked.evEstimates.packScout.metrics.grossEvMoney.minorUnits,
    (pool.evEstimates.packScout as { metrics: { grossEvMoney: { minorUnits: number } } })
      .metrics.grossEvMoney.minorUnits,
  );
  session.close();
});

test("published values equal an independent recomputation through the real calculator and confidence policy", async () => {
  const session = await openSession();
  const results = await runFrames(session, 3);
  let verified = 0;
  for (const result of results) {
    const frame = buildPackScoutBuybackEvSimulationFrameV1(
      CONTROLS,
      result.frameIndex,
    );
    for (const scenario of frame.scenarios) {
      const detail = detailFor(result, scenario.scenarioKey);
      const packScout = detail.evEstimates.packScout;
      if (packScout.status === "unavailable") continue;
      assert.ok(scenario.evidence.status === "complete");
      const calculation = calculatePackScoutBuybackAdjustedEvV1({
        input: scenario.evidence.input,
        calculatedAt: packScout.calculatedAt,
      });
      assert.ok(calculation.status === "available");
      assert.deepEqual(packScout.metrics, {
        grossEvMoney: calculation.grossEvMoney,
        grossReturnBasisPoints: calculation.grossReturnBasisPoints,
        evDollars: calculation.evDollars,
        evPercentBasisPoints: calculation.evPercentBasisPoints,
      });
      const evaluation = evaluatePackScoutBuybackEvConfidenceV1(
        calculation.confidenceInput,
      );
      assert.ok(evaluation.status === "available");
      assert.deepEqual(packScout.confidence, {
        policyVersion: evaluation.confidence.policyVersion,
        scoreBasisPoints: evaluation.confidence.scoreBasisPoints,
        band: evaluation.confidence.band,
        limitationCodes: [...evaluation.confidence.limitationCodes],
      });
      verified += 1;
    }
  }
  assert.ok(verified >= 20, "expected many independently verified estimates");
  session.close();
});

test("raw synthetic observations never serialize into releases, revisions, results, or telemetry", async () => {
  const port = new RecordingPort();
  const operational = recordedOperational();
  const session = await openSession({}, port, operational);
  const results = await runFrames(session, 2);
  const rawOnlyKeys = [
    "oddsBuckets",
    "hitTiers",
    "livePool",
    "pullLedger",
    "remainingByBucket",
    "swapFeePercents",
    "buybackRatio",
    "salePriceUsd",
    "packPriceText",
    "oddsTiers",
    "tradeCredit",
    "estimatedValueUsd",
    "buybackPercentText",
    "sourceRevision",
  ];
  const surfaces = {
    publication: JSON.stringify(port.recorded),
    results: JSON.stringify(results),
    revisions: JSON.stringify(session.simulator.inspectCanonicalRevisionRows()),
    telemetry: JSON.stringify(operational.entries),
  };
  assert.ok(operational.entries.length > 0);
  for (const [surface, bytes] of Object.entries(surfaces)) {
    for (const key of rawOnlyKeys) {
      assert.ok(
        !bytes.includes(`"${key}"`),
        `raw source key ${key} leaked into ${surface}`,
      );
    }
  }
  session.close();
});
