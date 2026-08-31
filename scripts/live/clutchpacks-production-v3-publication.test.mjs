import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { publishClutchpacksProductionV3: publish, clutchpacksProductionObservationOperationId: observationId } =
  await tsImport("./clutchpacks-production-v3-publication.mts", import.meta.url);
const { CLUTCHPACKS_PRODUCTION_SCOPE: scope, CLUTCHPACKS_PRODUCTION_TARGET: target,
  productionPublicationSha256: digest } = await tsImport("./clutchpacks-production-publication-policy.mts", import.meta.url);
const { packScoutPublicEvV3Schema, packScoutDisplayedEvV3Schema, presentLastKnownPackScoutEvV3 } =
  await tsImport("@packscout/contracts", import.meta.url);
const id = suffix => `11111111-1111-5111-8111-${suffix.padStart(12, "0")}`;
const hash = character => character.repeat(64);
const now = "2026-08-31T18:00:00.000Z";
const unavailable = () => ({ status: "unavailable", methodVersion: "packscout-buyback-adjusted-ev-v1",
  confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1", metrics: null, confidence: null,
  calculatedAt: now, dataAsOf: { state: "unknown_source_time", observedAt: null }, reason: "SOURCE_EVIDENCE_UNAVAILABLE" });
function currentEstimate() {
  const value = { status: "current", methodVersion: "packscout-buyback-adjusted-ev-v1",
    confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
    metrics: { grossEvMoney: { minorUnits: 90, currency: "USD" }, grossReturnBasisPoints: 9000,
      evDollars: { minorUnits: -10, currency: "USD" }, evPercentBasisPoints: -1000 },
    confidence: { policyVersion: "packscout-buyback-adjusted-ev-confidence-v1", scoreBasisPoints: 10000,
      band: "high", limitationCodes: [] }, calculatedAt: now, dataAsOf: { state: "known", observedAt: now },
    sourceAge: { milliseconds: 0, state: "fresh_within_15_minutes" }, expiresAt: "2026-08-31T19:00:00.000Z" };
  assert.equal(packScoutPublicEvV3Schema.safeParse(value).success, true);
  return value;
}
function makePositive(value) {
  return { ...value, metrics: { grossEvMoney: { minorUnits: 101, currency: "USD" }, grossReturnBasisPoints: 10100,
    evDollars: { minorUnits: 1, currency: "USD" }, evPercentBasisPoints: 100 } };
}
function fixture() {
  const events = []; const rows = [{ publicRepackId: id("7"), publicVendorId: id("9"), vendorKey: "clutchpacks",
    evEstimates: { packScout: unavailable() } }];
  const configuration = { schemaVersion: "approved_public_catalog_v1", configurationKey: "production-clutchpacks-v1",
    revision: 1, approvedAt: now, staleAfterSeconds: 7200,
    confidencePolicy: { version: "confidence-v1", completeScoreBasisPoints: 9000, partialScoreBasisPoints: 6000,
      unknownScoreBasisPoints: 3000, limitationPenaltyBasisPoints: 500 },
    publicAssetOrigins: [], verifiedUsdStablecoins: [], categories: [], collectibles: [],
    repacks: [{ platformKey: "clutchpacks", packExternalId: "pack", publicRepackId: id("7") }],
    platforms: [{ platformKey: "clutchpacks", format: "repack", defaultPublicCategoryIds: [],
      categoryMappings: [], collectibleTypeMappings: [], vendor: { publicVendorId: id("9"), vendorKey: "clutchpacks",
        displayName: "ClutchPacks", logoUrl: null, websiteUrl: "https://clutchpacks.com", listingHosts: ["clutchpacks.com"],
        imageOrigins: [], referralParameters: [], publicPromo: null } }],
  };
  const counts = { categories: 0, collectibles: 0, repacks: 1, chases: 0, searchShards: 1 };
  const entityChainHashes = { categories: hash("0"), collectibles: hash("0"), repacks: hash("1"), chases: hash("0") };
  const manifest = { methodVersion: "packscout-buyback-adjusted-ev-v1",
    confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1", publicEvPolicyVersion: "packscout-public-ev-nonpositive-v1",
    dataAsOf: now, contentHash: hash("2"), searchAlgorithmVersion: "repack_ev_search_v3", counts,
    entityChainHashes, topChaseCount: 0, batchCount: 1, batchChainHash: hash("3") };
  const plan = { classification: "publish", publicReleaseId: id("2"), releaseFingerprint: hash("b"), manifest,
    batches: [{ batchIndex: 0, kind: "repacks", batchHash: hash("4"), records: rows }] };
  const intent = { schemaVersion: "clutchpacks_production_publication_v1", operationId: id("1"), target, scope, readAt: now,
    source: { runId: id("5"), checkpointHash: hash("c"), stateGeneration: "41", promotionSequence: "125",
      stabilityFingerprint: hash("d"), lastHeadReachedAt: "2026-08-31T17:00:00.000Z", qualityState: "degraded", quarantineCount: 465 },
    approvedConfigurationSha256: digest(configuration), candidate: { publicReleaseId: id("2"), releaseFingerprint: hash("b"),
      planSha256: digest(plan) }, predecessor: { generation: 8, publicReleaseId: id("3"), releaseFingerprint: hash("e") } };
  const before = { generation: 8, activeRelease: { ...manifest, publicReleaseId: id("3"), releaseFingerprint: hash("e"), completedAt: now },
    previousRelease: null };
  let state = structuredClone(before); let owned;
  const makeReceipt = (request, operationKind, result) => {
    const body = { schemaVersion: "data_release_v3", operationKind, operationId: request.operationId,
      idempotencyKey: request.idempotencyKey, publicReleaseId: request.publicReleaseId ?? request.targetPublicReleaseId,
      result, serverTime: now, requestDigest: hash("f"), details: {} };
    return { ...body, receiptDigest: digest({ domain: "packscout.data-release-v3.receipt.v1", value: body }) };
  };
  const client = {
    async activeState() { events.push("read-state"); return structuredClone(state); },
    async retainedEvWitnessReadiness(request) { events.push("readiness"); return { generation: request.expectedGeneration,
      activePublicReleaseId: request.expectedActivePublicReleaseId, activeReleaseFingerprint: request.expectedActiveReleaseFingerprint,
      retention: request.expectedActivePublicReleaseId === null ? null : { operationId: "old-activate", direction: "forward", changesSha256: hash("a") } }; },
    async retainedEvWitness() { events.push("witness"); return {}; },
    async start(request) { events.push("start"); return makeReceipt(request, "start", "started"); },
    async applyBatch(request) { events.push("batch"); return makeReceipt(request, "applyBatch", "applied"); },
    async finalize(request) { events.push("finalize"); return makeReceipt(request, "finalize", "complete"); },
    async status() { return { publicReleaseId: plan.publicReleaseId, releaseFingerprint: plan.releaseFingerprint, lifecycle: "complete",
      acceptedCounts: counts, acceptedBatchCount: manifest.batchCount, acceptedBatchChainHash: manifest.batchChainHash,
      acceptedEntityChainHashes: entityChainHashes, acceptedSearchRowCount: 1, acceptedSearchRowSetHash: hash("8"),
      acceptedTopChaseCount: 0, acceptedVerifiedTopChaseCount: 0, completedAt: now }; },
    async activate(request) { events.push("activate"); assert.equal(request.expectedActivePublicReleaseId, state.activeRelease?.publicReleaseId ?? null);
      state = { generation: state.generation + 1, previousRelease: state.activeRelease,
        activeRelease: { ...manifest, publicReleaseId: plan.publicReleaseId, releaseFingerprint: plan.releaseFingerprint, completedAt: now } };
      return makeReceipt(request, "activate", "activated"); },
    async rollback(request) { events.push("rollback"); assert.equal(request.expectedActivePublicReleaseId, state.activeRelease.publicReleaseId);
      state = { generation: state.generation + 1, activeRelease: state.previousRelease, previousRelease: state.activeRelease };
      return makeReceipt(request, "rollback", "rolled_back"); },
    async refreshProviderObservation(request) { events.push("observation"); assert.equal(request.qualityState, "degraded");
      return makeReceipt(request, "refreshProviderObservation", "refreshed"); },
  };
  const input = { intent, plan, approvedConfiguration: configuration, client,
    async prepareLeaseAttempt() { events.push("prepare-lease"); },
    leasePort: {
      async acquire(request) { events.push("lease"); owned = { role: "import", owner: request.owner, fence: 489n,
        rowVersion: 1n, heartbeatAt: new Date(now), expiresAt: new Date("2026-08-31T18:15:00.000Z") };
        return { kind: "acquired", lease: owned }; },
      async renew() { events.push("renew"); return owned; },
      async release() { events.push("release"); return true; },
    },
    async readSource() { events.push("read-source"); return { scope, source: structuredClone(intent.source) }; },
    async assertSourceQuiet() { events.push("quiet"); },
    observationNow: () => Date.parse(now),
    async prepareObservation() {
      events.push("prepare-observation");
      const observedAt = new Date(input.observationNow()).toISOString();
      const request = { schemaVersion: "data_release_v3", operationId: observationId(intent, observedAt), idempotencyKey: observationId(intent, observedAt),
        publicReleaseId: plan.publicReleaseId, releaseFingerprint: plan.releaseFingerprint, publicVendorId: id("9"), vendorKey: "clutchpacks",
        observationSequence: Date.parse(observedAt), observedAt, freshThrough: "2026-08-31T19:00:00.000Z",
        lastHeadReachedAt: intent.source.lastHeadReachedAt, sourceHeadSequence: "125", settledSequence: "125",
        sourceLifecycle: "active", connectionState: "healthy", qualityState: "degraded", releaseAlignment: "aligned" };
      return { request, requestSha256: digest(request) };
    },
    async verifyPublic({ client: verificationClient }) { events.push("verify-public"); await verificationClient.retainedEvWitness({});
      return { verifiedAt: now, publicReadbackSha256: hash("a"), repackCount: 1, rows: structuredClone(rows) }; },
  };
  return { input, events, rows, before, state: () => state, setState: next => { state = structuredClone(next); },
    completed: () => ({ generation: 9, activeRelease: { ...manifest, publicReleaseId: id("2"), releaseFingerprint: hash("b"), completedAt: now },
      previousRelease: before.activeRelease }) };
}
const rejects = code => error => { assert.equal(error.code, code); assert.equal(error.message.includes("secret"), false); return true; };

test("real publisher stages, reconciles, activates, refreshes degraded observation and verifies before releasing", async () => {
  const f = fixture(); const result = await publish(f.input);
  assert.equal(result.status, "verified"); assert.equal(result.source.qualityState, "degraded");
  assert.equal(result.source.quarantineCount, 465); assert.equal(result.publicationOutcome, "activated");
  assert.match(result.activateReceiptDigest, /^[a-f0-9]{64}$/u);
  assert.equal(f.events.filter(x => x === "read-source").length, 4);
  assert.deepEqual(f.events.filter(x => ["readiness", "start", "batch", "finalize", "activate", "observation", "verify-public", "witness", "release"].includes(x)),
    ["readiness", "start", "batch", "finalize", "activate", "observation", "verify-public", "witness", "release"]);
});
test("already activated replay performs readiness, observation and full public/witness verification without lifecycle writes", async () => {
  const f = fixture(); f.setState(f.completed()); const result = await publish(f.input);
  assert.equal(result.publicationOutcome, "unchanged");
  assert.equal(result.activateReceiptDigest, null);
  assert.equal(f.events.some(x => ["start", "batch", "finalize", "activate"].includes(x)), false);
  assert.equal(f.events.includes("verify-public"), true); assert.equal(f.events.includes("witness"), true);
});
test("missing witness readiness prevents every cloud write and still releases source ownership", async () => {
  const f = fixture(); f.input.client.retainedEvWitnessReadiness = async () => ({ generation: 8 });
  await assert.rejects(publish(f.input), rejects("PRODUCTION_BACKEND_NOT_READY"));
  assert.equal(f.events.includes("start"), false); assert.equal(f.events.at(-1), "release");
});
test("changed source binding prevents execution authority and wrong observation quality is never sent", async () => {
  const f = fixture(); f.input.readSource = async () => ({ scope, source: { ...f.input.intent.source, checkpointHash: hash("a") } });
  await assert.rejects(publish(f.input), rejects("PRODUCTION_SOURCE_CHANGED"));
  assert.equal(f.events.includes("lease"), false);
  const g = fixture(); const prepare = g.input.prepareObservation;
  g.input.prepareObservation = async () => { const attempt = await prepare(); attempt.request.qualityState = "healthy";
    attempt.requestSha256 = digest(attempt.request); return attempt; };
  await assert.rejects(publish(g.input), rejects("PRODUCTION_PUBLICATION_FAILED"));
  assert.equal(g.events.includes("activate"), false); assert.equal(g.events.includes("observation"), false);
});
test("predecessor generation changes after finalize: activation is refused even with the same active ID", async () => {
  const f = fixture(); const finalize = f.input.client.finalize;
  f.input.client.finalize = async request => { const result = await finalize(request);
    f.setState({ ...f.before, generation: 10 }); return result; };
  await assert.rejects(publish(f.input), rejects("PRODUCTION_PUBLICATION_FAILED"));
  assert.equal(f.events.includes("activate"), false); assert.equal(f.events.includes("rollback"), false);
});
test("source lease loss during staging prevents the next cloud write and never steals a new fence", async () => {
  const f = fixture(); const start = f.input.client.start;
  f.input.client.start = async request => { const result = await start(request); f.input.leasePort.renew = async () => null; return result; };
  await assert.rejects(publish(f.input), rejects("PRODUCTION_PUBLICATION_FAILED"));
  assert.equal(f.events.includes("batch"), false); assert.equal(f.events.includes("activate"), false);
  assert.equal(f.events.filter(x => x === "lease").length, 1); assert.equal(f.events.at(-1), "release");
});
test("failed public verification rolls back only the exact retained predecessor and reports failure", async () => {
  const f = fixture(); f.input.verifyPublic = async () => { throw new Error("secret transport"); };
  await assert.rejects(publish(f.input), rejects("PRODUCTION_VERIFICATION_FAILED_ROLLED_BACK"));
  assert.equal(f.events.filter(x => x === "rollback").length, 1);
  assert.equal(f.state().activeRelease.publicReleaseId, f.before.activeRelease.publicReleaseId);
  assert.equal(f.state().generation, 10); assert.equal(f.events.at(-1), "release");
});
test("failed verification on an exact completed replay still rolls back the pinned candidate", async () => {
  const f = fixture(); f.setState(f.completed()); f.input.verifyPublic = async () => { throw new Error("bad public detail"); };
  await assert.rejects(publish(f.input), rejects("PRODUCTION_VERIFICATION_FAILED_ROLLED_BACK"));
  assert.equal(f.events.includes("activate"), false); assert.equal(f.events.includes("rollback"), true);
});
test("verification failure cannot roll back a foreign, unknown or ABA-moved pointer", async () => {
  for (const mode of ["foreign", "unavailable", "aba"]) {
    const f = fixture(); f.input.verifyPublic = async () => {
      if (mode === "foreign") f.setState({ ...f.completed(), generation: 10,
        activeRelease: { ...f.completed().activeRelease, publicReleaseId: id("88") } });
      if (mode === "unavailable") f.input.client.activeState = async () => { throw new Error("secret"); };
      if (mode === "aba") f.setState({ ...f.completed(), generation: 11 });
      throw new Error("verification failed");
    };
    await assert.rejects(publish(f.input), rejects("PRODUCTION_VERIFICATION_RECOVERY_REQUIRED"));
    assert.equal(f.events.includes("rollback"), false);
  }
});
test("genesis verification failure has no invented rollback target", async () => {
  const f = fixture(); f.input.intent.predecessor = { generation: 0, publicReleaseId: null, releaseFingerprint: null };
  f.setState({ generation: 0, activeRelease: null, previousRelease: null });
  f.input.verifyPublic = async () => { throw new Error("public verification failed"); };
  await assert.rejects(publish(f.input), rejects("PRODUCTION_VERIFICATION_RECOVERY_REQUIRED"));
  assert.equal(f.events.includes("rollback"), false);
});
test("positive candidate EV fails before acquiring a lease, including a rehashed plan", async () => {
  const f = fixture(); f.rows[0].evEstimates.packScout = makePositive(currentEstimate());
  f.input.intent.candidate.planSha256 = digest(f.input.plan);
  await assert.rejects(publish(f.input), rejects("PRODUCTION_PUBLIC_EV_INVALID")); assert.deepEqual(f.events, []);
});
test("positive last-known public EV and incomplete public identity sets trigger guarded rollback", async () => {
  for (const mode of ["positive", "missing", "foreign"]) {
    const f = fixture(); const verify = f.input.verifyPublic;
    f.input.verifyPublic = async argument => {
      const result = await verify(argument);
      if (mode === "positive") {
        const valid = presentLastKnownPackScoutEvV3({ estimate: currentEstimate(), calculationPriceUsdMinor: 100,
          referenceTimeIso: now, latestUnavailableReason: null });
        assert.equal(packScoutDisplayedEvV3Schema.safeParse(valid).success, true);
        result.rows[0].evEstimates.packScout = makePositive(valid);
      }
      if (mode === "missing") result.rows = [];
      if (mode === "foreign") result.rows[0].publicVendorId = id("99");
      return result;
    };
    await assert.rejects(publish(f.input), rejects("PRODUCTION_VERIFICATION_FAILED_ROLLED_BACK"));
    assert.equal(f.events.includes("rollback"), true);
  }
});

test("staging longer than five minutes saves a fresh observation before CAS while the EV clock stays frozen", async () => {
  const f = fixture(); const originalPlan = structuredClone(f.input.plan); const finalize = f.input.client.finalize;
  f.input.client.finalize = async request => { const receipt = await finalize(request);
    f.input.observationNow = () => Date.parse(now) + 600_000; return receipt; };
  const refresh = f.input.client.refreshProviderObservation;
  f.input.client.refreshProviderObservation = async request => { assert.equal(request.observedAt, "2026-08-31T18:10:00.000Z");
    assert.equal(request.observationSequence, Date.parse(request.observedAt)); return refresh(request); };
  const result = await publish(f.input);
  assert.equal(result.status, "verified"); assert.equal(f.input.intent.readAt, now); assert.deepEqual(f.input.plan, originalPlan);
  assert.ok(f.events.indexOf("prepare-observation") > f.events.indexOf("finalize"));
  assert.ok(f.events.indexOf("prepare-observation") < f.events.indexOf("activate"));
});
test("expired source horizon, forged attempt digest, or disk failure cannot activate staged data", async () => {
  for (const mode of ["stale-head", "stale-observation", "bad-digest", "extra-field", "disk-failure"]) {
    const f = fixture(); const prepare = f.input.prepareObservation;
    f.input.prepareObservation = async () => {
      if (mode === "disk-failure") throw new Error("private disk path");
      if (mode === "stale-head") f.input.observationNow = () => Date.parse("2026-08-31T19:00:00.000Z");
      const attempt = await prepare();
      if (mode === "stale-observation") f.input.observationNow = () => Date.parse(now) + 600_000;
      if (mode === "extra-field") { attempt.request.secret = "private callback data"; attempt.requestSha256 = digest(attempt.request); }
      if (mode === "bad-digest") attempt.requestSha256 = hash("0"); return attempt;
    };
    await assert.rejects(publish(f.input), rejects("PRODUCTION_PUBLICATION_FAILED"));
    assert.equal(f.events.includes("finalize"), true); assert.equal(f.events.includes("activate"), false);
    assert.equal(f.events.includes("rollback"), false); assert.equal(f.events.includes("observation"), false);
  }
});
test("refresh uses exact saved request and completed replay saves fresh health without recomputing the plan", async () => {
  const f = fixture(); const prepare = f.input.prepareObservation; const saved = []; const sent = [];
  f.input.prepareObservation = async () => { const attempt = await prepare(); saved.push(structuredClone(attempt)); return attempt; };
  const refresh = f.input.client.refreshProviderObservation;
  f.input.client.refreshProviderObservation = async request => { sent.push(structuredClone(request)); return refresh(request); };
  const original = digest(f.input.plan); await publish(f.input);
  f.input.observationNow = () => Date.parse(now) + 600_000; f.events.length = 0;
  const result = await publish(f.input);
  assert.equal(result.publicationOutcome, "unchanged"); assert.equal(digest(f.input.plan), original); assert.equal(f.input.intent.readAt, now);
  assert.deepEqual(sent, saved.map(attempt => attempt.request));
  assert.notEqual(saved[0].request.operationId, saved[1].request.operationId);
  assert.equal(f.events.some(event => ["start", "batch", "finalize", "activate"].includes(event)), false);
  assert.equal(f.events.includes("verify-public"), true);
});

test("activation cannot mutate the durably prepared request before it is sent", async () => {
  const f = fixture(); const prepare = f.input.prepareObservation; let callbackRequest;
  f.input.prepareObservation = async () => { const attempt = await prepare(); callbackRequest = attempt.request; return attempt; };
  const activate = f.input.client.activate;
  f.input.client.activate = async request => { callbackRequest.qualityState = "healthy"; return activate(request); };
  const refresh = f.input.client.refreshProviderObservation;
  f.input.client.refreshProviderObservation = async request => { assert.equal(request.qualityState, "degraded"); return refresh(request); };
  assert.equal((await publish(f.input)).status, "verified");
});

test("background source or lease loss during a deferred active-state read prevents the next batch", async t => {
  for (const mode of ["quiet", "renewal"]) {
    const f = fixture(); let tick; let unblock; let entered;
    const blocked = new Promise(resolve => { entered = resolve; });
    const delayed = new Promise(resolve => { unblock = resolve; });
    t.mock.method(globalThis, "setInterval", callback => { tick = callback; return 1; });
    t.mock.method(globalThis, "clearInterval", () => undefined);
    const activeState = f.input.client.activeState; const quiet = f.input.assertSourceQuiet;
    let loseQuiet = false;
    f.input.assertSourceQuiet = async lease => { if (loseQuiet) { f.events.push("background-source-lost"); throw new Error("source resumed"); }
      return quiet(lease); };
    let paused = false;
    f.input.client.activeState = async () => {
      if (f.events.includes("start") && !paused) { paused = true; entered(); await delayed; }
      return activeState();
    };
    const publication = publish(f.input);
    const rejected = assert.rejects(publication, rejects("PRODUCTION_PUBLICATION_FAILED"));
    await blocked;
    if (mode === "quiet") loseQuiet = true;
    else f.input.leasePort.renew = async () => { f.events.push("background-lease-lost"); return null; };
    tick();
    // Drain the background promise chain while the state read remains paused.
    await new Promise(resolve => setImmediate(resolve));
    unblock(); await rejected;
    assert.equal(f.events.includes("batch"), false, `${mode}: no cloud batch after background loss`);
    assert.equal(f.events.includes("activate"), false); assert.equal(f.events.at(-1), "release");
    t.mock.restoreAll();
  }
});

test("unconfirmed lease cleanup remains an explicit recovery outcome before any cloud mutation", async () => {
  const f = fixture(); let acquisitions = 0; let attempt;
  f.input.prepareLeaseAttempt = async saved => { attempt = structuredClone(saved); };
  f.input.leasePort.acquire = async request => { acquisitions++; assert.deepEqual(request, attempt.request);
    throw Object.assign(new Error("private route"), { code: "PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED" }); };
  await assert.rejects(publish(f.input), rejects("PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED"));
  assert.equal(acquisitions, 1);
  assert.equal(f.events.some(event => ["start", "batch", "finalize", "activate", "observation", "release"].includes(event)), false);
});
