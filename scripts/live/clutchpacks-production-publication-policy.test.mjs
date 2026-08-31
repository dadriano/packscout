import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const {
  CLUTCHPACKS_PRODUCTION_SCOPE: scope, CLUTCHPACKS_PRODUCTION_TARGET: target,
  parseClutchpacksProductionPublicationIntent: parse,
  productionPublicationSha256: digest, productionPublicationIdempotencyKey: operationKey,
  assertClutchpacksProductionIntentReplay: replay,
  assertClutchpacksProductionBindings: bindings,
  assertClutchpacksProductionPredecessor: predecessor,
  buildClutchpacksProductionPublicationReceipt: receipt,
  withClutchpacksProductionPublicationLease: withLease,
} = await tsImport("./clutchpacks-production-publication-policy.mts", import.meta.url);

// Acceptance map: pure boundaries, replay/ABA protection, honest quality receipts,
// and fenced cleanup are automated below. Live DB/Convex readbacks are owner-run.
const id = suffix => `11111111-1111-5111-8111-${suffix.padStart(12, "0")}`;
const hash = character => character.repeat(64);
function fixture() {
  const configuration = {
    schemaVersion: "approved_public_catalog_v1", configurationKey: "clutchpacks-production-v1", revision: 1,
    approvedAt: "2026-08-31T17:00:00.000Z", staleAfterSeconds: 900,
    confidencePolicy: { version: "confidence-v1", completeScoreBasisPoints: 9000,
      partialScoreBasisPoints: 6000, unknownScoreBasisPoints: 3000, limitationPenaltyBasisPoints: 500 },
    publicAssetOrigins: ["https://clutchpacks.com"], verifiedUsdStablecoins: [], categories: [],
    platforms: [{ platformKey: "clutchpacks", format: "repack", defaultPublicCategoryIds: [],
      categoryMappings: [], collectibleTypeMappings: [], vendor: {
        publicVendorId: id("9"), vendorKey: "clutchpacks", displayName: "ClutchPacks", logoUrl: null,
        websiteUrl: "https://clutchpacks.com", listingHosts: ["clutchpacks.com"],
        imageOrigins: ["https://clutchpacks.com"], referralParameters: [], publicPromo: null,
      } }], repacks: [], collectibles: [],
  };
  const plan = { publicReleaseId: id("2"), releaseFingerprint: hash("b"), batches: [],
    manifest: { dataAsOf: "2026-08-31T17:00:00.000Z" } };
  const intent = { schemaVersion: "clutchpacks_production_publication_v1", operationId: id("1"),
    scope: { ...scope }, target: { ...target }, readAt: "2026-08-31T18:00:00.000Z",
    source: { runId: "e34e6f0e-a39b-5561-ae6c-c23b3fdf9d0c", checkpointHash: hash("c"),
      stateGeneration: "41", promotionSequence: "125", stabilityFingerprint: hash("d"),
      lastHeadReachedAt: "2026-08-31T17:00:00.000Z", qualityState: "degraded", quarantineCount: 462 },
    approvedConfigurationSha256: digest(configuration),
    candidate: { publicReleaseId: plan.publicReleaseId, releaseFingerprint: plan.releaseFingerprint,
      planSha256: digest(plan) },
    predecessor: { generation: 8, publicReleaseId: id("3"), releaseFingerprint: hash("e") },
  };
  const before = { generation: 8, activeRelease: { publicReleaseId: id("3"), releaseFingerprint: hash("e") },
    previousRelease: null };
  const after = { generation: 9, activeRelease: { publicReleaseId: id("2"), releaseFingerprint: hash("b") },
    previousRelease: before.activeRelease };
  return { intent, configuration, plan, before, after,
    observed: { scope: { ...scope }, source: structuredClone(intent.source), approvedConfiguration: configuration,
      plan, activeState: before } };
}
const refuses = code => error => {
  assert.equal(error.code, code);
  assert.equal(error.message, "ClutchPacks production publication was refused safely.");
  return true;
};
test("reviewed degraded source publishes only its exact target, artifacts, scope and predecessor", () => {
  const f = fixture();
  assert.equal(bindings(f.intent, f.observed), "publish");
  assert.equal(predecessor(f.intent, f.after), "already_active");
  // Replaying tomorrow keeps the original EV calculation clock; wall time is not an approval expiry.
  replay(f.intent, structuredClone(f.intent));
  assert.equal(operationKey(f.intent), operationKey(structuredClone(f.intent)));
});
test("target aliases, local URLs, credentials, foreign tenants and unknown intent properties refuse", () => {
  for (const mutate of [
    x => { x.target.cloudUrl = "http://127.0.0.1:3210"; },
    x => { x.target.siteUrl = "https://shiny-newt-310.convex.site/"; },
    x => { x.target.siteUrl = "https://secret@shiny-newt-310.convex.site"; },
    x => { x.target.cloudUrl += ".attacker.example"; },
    x => { x.scope.organizationId = id("20"); },
    x => { x.scope.providerId = id("21"); },
    x => { x.scope.configId = id("22"); },
    x => { x.scope.configVersion = "5"; },
    x => { x.source.sourceToken = "secret-that-must-not-escape"; },
    x => { x.readAt = "invalid-secret-value"; },
    x => { x.readAt = "2026-08-31T18:00:00Z"; },
    x => { x.readAt = "2026-08-31T16:00:00.000Z"; },
    x => { x.source.qualityState = "healthy"; },
    x => { x.source.quarantineCount = -1; },
  ]) {
    const { intent } = fixture(); mutate(intent);
    assert.throws(() => parse(intent), refuses("PRODUCTION_INTENT_INVALID"));
  }
});
test("every source pin and observed scope are rechecked instead of trusting a previous preflight", () => {
  for (const [key, replacement] of Object.entries({ runId: id("30"), checkpointHash: hash("f"),
    stateGeneration: "42", promotionSequence: "126", stabilityFingerprint: hash("a"),
    lastHeadReachedAt: "2026-08-31T17:01:00.000Z", qualityState: "healthy", quarantineCount: 461 })) {
    const f = fixture(); f.observed.source[key] = replacement;
    assert.throws(() => bindings(f.intent, f.observed), refuses("PRODUCTION_SOURCE_CHANGED"));
  }
  const f = fixture(); f.observed.scope.providerId = id("31");
  assert.throws(() => bindings(f.intent, f.observed), refuses("PRODUCTION_SOURCE_CHANGED"));
});
test("changed approved configuration and plan content cannot retain the approved digest", () => {
  const f = fixture(); f.configuration.staleAfterSeconds += 1;
  assert.throws(() => bindings(f.intent, f.observed), refuses("PRODUCTION_CONFIGURATION_CHANGED"));
  const g = fixture(); g.plan.manifest.dataAsOf = "2026-08-31T17:01:00.000Z";
  assert.throws(() => bindings(g.intent, g.observed), refuses("PRODUCTION_PLAN_CHANGED"));
  const h = fixture(); h.plan.publicReleaseId = id("88"); h.intent.candidate.planSha256 = digest(h.plan);
  assert.throws(() => bindings(h.intent, h.observed), refuses("PRODUCTION_PLAN_CHANGED"));
});
test("unknown or another-provider approved configuration refuses even with a matching artifact hash", () => {
  const f = fixture(); f.configuration.platforms[0].vendor.vendorKey = "courtyard";
  f.intent.approvedConfigurationSha256 = digest(f.configuration);
  assert.throws(() => bindings(f.intent, f.observed), refuses("PRODUCTION_CONFIGURATION_CHANGED"));
  const g = fixture(); g.configuration.secret = "must-not-be-output";
  g.intent.approvedConfigurationSha256 = digest(g.configuration);
  assert.throws(() => bindings(g.intent, g.observed), refuses("PRODUCTION_CONFIGURATION_CHANGED"));
});
test("changing readAt, source, plan or operation ID invalidates an uncertain retry", () => {
  for (const mutate of [x => { x.readAt = "2026-09-01T18:00:00.000Z"; },
    x => { x.source.promotionSequence = "126"; }, x => { x.candidate.planSha256 = hash("a"); },
    x => { x.operationId = id("66"); }]) {
    const { intent } = fixture(); const next = structuredClone(intent); mutate(next);
    assert.throws(() => replay(intent, next), refuses("PRODUCTION_REPLAY_CONFLICT"));
  }
});
test("predecessor protects against changed fingerprints, ABA generations and unrelated activation", () => {
  for (const mutate of [x => { x.generation += 2; },
    x => { x.activeRelease.releaseFingerprint = hash("f"); },
    x => { x.activeRelease.publicReleaseId = id("55"); }]) {
    const f = fixture(); mutate(f.before);
    assert.throws(() => predecessor(f.intent, f.before), refuses("PRODUCTION_PREDECESSOR_CHANGED"));
  }
  const f = fixture(); f.after.previousRelease = null;
  assert.throws(() => predecessor(f.intent, f.after), refuses("PRODUCTION_PREDECESSOR_CHANGED"));
  const g = fixture(); g.after.generation = 11;
  assert.throws(() => predecessor(g.intent, g.after), refuses("PRODUCTION_PREDECESSOR_CHANGED"));
});
test("verified receipt retains degraded source truth and excludes arbitrary evidence fields", () => {
  const f = fixture(); const evidence = { activeState: f.after, verifiedAt: "2026-09-01T00:00:00.000Z",
    publicReadbackSha256: hash("a"), repackCount: 17, secret: "never-output", rawCursor: "never-output" };
  const result = receipt(f.intent, evidence);
  assert.equal(result.source.qualityState, "degraded");
  assert.equal(result.source.quarantineCount, 462);
  assert.equal(result.source.lastHeadReachedAt, f.intent.source.lastHeadReachedAt);
  assert.equal(result.readAt, f.intent.readAt);
  assert.equal(JSON.stringify(result).includes("never-output"), false);
  assert.throws(() => receipt(f.intent, { ...evidence, activeState: f.before }), refuses("PRODUCTION_READBACK_MISMATCH"));
  assert.throws(() => receipt(f.intent, { ...evidence, publicReadbackSha256: "bad" }), refuses("PRODUCTION_READBACK_MISMATCH"));
});

function leaseFixture() {
  const { intent } = fixture(); const calls = []; let owned; let savedAttempt;
  const port = {
    async acquire(request) { calls.push("acquire"); assert.deepEqual(request, savedAttempt.request); owned = { role: "import", owner: request.owner, fence: 489n,
      rowVersion: 1n, heartbeatAt: new Date(), expiresAt: new Date(Date.now() + request.leaseMilliseconds) };
      return { kind: "acquired", lease: owned }; },
    async renew(request) { calls.push("renew"); assert.equal(request.owner, owned.owner);
      assert.equal(request.fence, owned.fence); return owned; },
    async release(request) { calls.push("release"); assert.equal(request.owner, owned.owner);
      assert.equal(request.fence, owned.fence); return true; },
  };
  const input = { intent, port, prepareLeaseAttempt: async attempt => { calls.push("persist"); savedAttempt = structuredClone(attempt); }, assertSourceQuiet: async lease => { calls.push(lease ? "quiet-owned" : "quiet"); },
    operation: async (lease, assertLive) => { assert.equal(lease.fence, 489n); calls.push("stage");
      await assertLive(); calls.push("activate"); return "verified"; } };
  return { calls, input, savedAttempt: () => savedAttempt };
}
test("quiet source and exact renewed import fence surround writes; cleanup precedes success", async () => {
  const f = leaseFixture(); assert.equal(await withLease(f.input), "verified");
  assert.deepEqual(f.calls, ["quiet", "persist", "acquire", "quiet-owned", "renew", "stage", "quiet-owned", "renew",
    "activate", "quiet-owned", "renew", "release"]);
});
test("resident not quiet prevents lease acquisition; foreign live lease prevents writes and release", async () => {
  const f = leaseFixture(); f.input.assertSourceQuiet = async () => { throw new Error("private detail"); };
  await assert.rejects(withLease(f.input), refuses("PRODUCTION_SOURCE_NOT_QUIET"));
  assert.deepEqual(f.calls, []);
  const g = leaseFixture(); g.input.port.acquire = async () => ({ kind: "held", fence: 488n, expiresAt: new Date() });
  await assert.rejects(withLease(g.input), refuses("PRODUCTION_IMPORT_LEASE_UNAVAILABLE"));
  assert.deepEqual(g.calls, ["quiet", "persist"]);
});
test("lease loss latches before activation, never reacquires, and releases only the original fence", async () => {
  const f = leaseFixture(); const renew = f.input.port.renew; let n = 0;
  f.input.port.renew = async request => ++n === 1 ? renew(request) : null;
  await assert.rejects(withLease(f.input), refuses("PRODUCTION_IMPORT_LEASE_LOST"));
  assert.equal(f.calls.filter(x => x === "acquire").length, 1);
  assert.equal(f.calls.includes("activate"), false); assert.equal(f.calls.at(-1), "release");
});
test("source resumes during staging: refuse activation while still releasing publication ownership", async () => {
  const f = leaseFixture(); let n = 0;
  f.input.assertSourceQuiet = async () => { if (++n === 3) throw new Error("source resumed"); };
  await assert.rejects(withLease(f.input), refuses("PRODUCTION_SOURCE_NOT_QUIET"));
  assert.equal(f.calls.includes("activate"), false); assert.equal(f.calls.at(-1), "release");
});
test("failed stage and uncertain cleanup cannot emit success or leak transport secrets", async () => {
  const f = leaseFixture(); f.input.operation = async () => { throw new Error("postgres://secret"); };
  await assert.rejects(withLease(f.input), refuses("PRODUCTION_PUBLICATION_FAILED"));
  assert.equal(f.calls.at(-1), "release");
  const g = leaseFixture(); g.input.port.release = async () => { throw new Error("secret"); };
  await assert.rejects(withLease(g.input), refuses("PRODUCTION_IMPORT_LEASE_RELEASE_FAILED"));
});
test("same reviewed operation receives different process lease owners across attempts", async () => {
  const owners = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const f = leaseFixture(); f.input.operation = async lease => { owners.push(lease.owner); };
    await withLease(f.input);
  }
  assert.notEqual(owners[0], owners[1]);
});
test("overlapping phase guards share one renewal and cannot accumulate concurrent lease requests", async () => {
  const f = leaseFixture(); const renew = f.input.port.renew;
  f.input.operation = async (_, assertLive) => {
    let finish; let started;
    const entered = new Promise(resolve => { started = resolve; });
    const delayed = new Promise(resolve => { finish = resolve; });
    let calls = 0;
    f.input.port.renew = async request => { calls++; started(); await delayed; return renew(request); };
    const first = assertLive(); await entered;
    const second = assertLive(); const third = assertLive();
    finish(); await Promise.all([first, second, third]);
    assert.equal(calls, 1);
    f.input.port.renew = renew;
  };
  await withLease(f.input);
});

test("lease acquisition uses the exact durably saved owner, request digest and intent identity", async () => {
  const f = leaseFixture(); await withLease(f.input); const attempt = f.savedAttempt();
  assert.match(attempt.attemptId, /^[a-f0-9-]{36}$/u);
  assert.equal(attempt.request.owner, `production-publication:${f.input.intent.operationId}:${attempt.attemptId}`);
  assert.equal(attempt.request.role, "import"); assert.equal(attempt.request.leaseMilliseconds, 900_000);
  assert.equal(attempt.intentSha256, digest(f.input.intent)); assert.equal(attempt.requestSha256, digest(attempt.request));
  assert.ok(f.calls.indexOf("persist") < f.calls.indexOf("acquire"));
});
test("failed lease-attempt persistence prevents every acquisition and publication write", async () => {
  const f = leaseFixture(); f.input.prepareLeaseAttempt = async () => { throw new Error("secret disk path"); };
  await assert.rejects(withLease(f.input), refuses("PRODUCTION_IMPORT_LEASE_ATTEMPT_PERSIST_FAILED"));
  assert.deepEqual(f.calls, ["quiet"]);
});
test("unknown acquire or unconfirmed cleanup keeps exact evidence and never retries, releases unknown ownership or publishes", async () => {
  for (const code of ["PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED", "PRODUCTION_IMPORT_LEASE_ACQUIRE_UNKNOWN"]) {
    const f = leaseFixture(); let acquisitions = 0;
    f.input.port.acquire = async request => { acquisitions++; assert.deepEqual(request, f.savedAttempt().request);
      throw Object.assign(new Error("private database error"), { code: code === "PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED" ? code : "TIMEOUT" }); };
    await assert.rejects(withLease(f.input), refuses(code));
    assert.equal(acquisitions, 1); assert.ok(f.savedAttempt().request.owner);
    assert.deepEqual(f.calls, ["quiet", "persist"]);
  }
});
