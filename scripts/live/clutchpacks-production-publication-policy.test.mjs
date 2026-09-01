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
  const { intent } = fixture(); const calls = []; let owned; let savedAttempt; let clock = 0;
  const epoch = Date.parse("2026-08-31T18:00:00.000Z");
  const port = {
    async acquire(request) { calls.push("acquire"); assert.deepEqual(request, savedAttempt.request);
      owned = { role: "import", owner: request.owner, fence: 489n, rowVersion: 1n,
        heartbeatAt: new Date(epoch + clock), expiresAt: new Date(epoch + clock + request.leaseMilliseconds) };
      return { kind: "acquired", lease: owned }; },
    async renew(request) { calls.push("renew"); assert.equal(request.owner, owned.owner); assert.equal(request.fence, owned.fence);
      const heartbeat = Math.max(epoch + clock, owned.heartbeatAt.getTime() + 1);
      owned = { ...owned, rowVersion: owned.rowVersion + 1n, heartbeatAt: new Date(heartbeat), expiresAt: new Date(heartbeat + request.leaseMilliseconds) };
      return owned; },
    async release(request) { calls.push("release"); assert.equal(request.owner, savedAttempt.request.owner);
      assert.equal(request.fence, 489n); return true; },
  };
  const input = { intent, port, monotonicNow: () => clock,
    prepareLeaseAttempt: async attempt => { calls.push("persist"); savedAttempt = structuredClone(attempt); },
    assertSourceQuiet: async lease => { calls.push(lease ? "quiet-owned" : "quiet"); },
    operation: async (lease, assertLive) => { assert.equal(lease.fence, 489n); calls.push("stage");
      await assertLive(); calls.push("activate"); return "verified"; } };
  return { calls, input, savedAttempt: () => savedAttempt, owned: () => owned,
    advance: milliseconds => { clock += milliseconds; }, setClock: value => { clock = value; } };
}
function fakeTimer(t) {
  let callback;
  t.mock.method(globalThis, "setInterval", (next, milliseconds) => { assert.equal(milliseconds, 30_000); callback = next; return 1; });
  t.mock.method(globalThis, "clearInterval", () => undefined);
  return () => callback();
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test("83 dispatches use acquired proof without repeated quiet reads or renewals", async () => {
  const f = leaseFixture(); f.input.operation = async (_, assertLive, assertNotLost) => {
    for (let i = 0; i < 83; i++) { await assertLive(); assertNotLost(); f.calls.push("dispatch"); }
    return "verified";
  };
  assert.equal(await withLease(f.input), "verified");
  assert.equal(f.calls.filter(call => call === "dispatch").length, 83);
  assert.equal(f.calls.filter(call => call === "quiet").length, 1); assert.equal(f.calls.includes("quiet-owned"), false);
  assert.equal(f.calls.includes("renew"), false); assert.equal(f.calls.at(-1), "release");
});
test("resident not quiet prevents lease acquisition; foreign live lease prevents writes and release", async () => {
  const f = leaseFixture(); f.input.assertSourceQuiet = async () => { throw new Error("private detail"); };
  await assert.rejects(withLease(f.input), refuses("PRODUCTION_SOURCE_NOT_QUIET"));
  assert.deepEqual(f.calls, []);
  const g = leaseFixture(); g.input.port.acquire = async () => ({ kind: "held", fence: 488n, expiresAt: new Date() });
  await assert.rejects(withLease(g.input), refuses("PRODUCTION_IMPORT_LEASE_UNAVAILABLE"));
  assert.deepEqual(g.calls, ["quiet", "persist"]);
});
test("timer renews every30seconds even with ample cached budget and dispatches join it", async t => {
  const tick = fakeTimer(t); const f = leaseFixture(); const entered = deferred(), finish = deferred(); const renew = f.input.port.renew;
  f.input.port.renew = async request => { entered.resolve(); await finish.promise; return renew(request); };
  f.input.operation = async (_, assertLive) => {
    f.advance(30_000); tick(); await entered.promise;
    let dispatched = false; const first = assertLive().then(() => { dispatched = true; }); const second = assertLive();
    await Promise.resolve(); assert.equal(dispatched, false); finish.resolve(); await Promise.all([first, second]);
    assert.equal(f.calls.filter(call => call === "renew").length, 1);
    for (let i = 0; i < 83; i++) await assertLive();
    assert.equal(f.calls.filter(call => call === "renew").length, 1);
  };
  await withLease(f.input);
});
test("inflight timer renewal failure latches despite an unexpired old proof and never reacquires", async t => {
  const tick = fakeTimer(t);
  for (const mode of ["null", "throw", "owner", "role", "fence"]) {
    const f = leaseFixture(); const entered = deferred(), finish = deferred(); let renewals = 0;
    f.input.port.renew = async () => { renewals++; entered.resolve(); await finish.promise;
      if (mode === "null") return null;
      if (mode === "throw") throw new Error("private source authority failure");
      return { ...f.owned(), [mode]: mode === "fence" ? 999n : "foreign" };
    };
    f.input.operation = async (_, assertLive, assertNotLost) => {
      f.advance(30_000); tick(); await entered.promise;
      const first = assert.rejects(assertLive(), refuses("PRODUCTION_IMPORT_LEASE_LOST"));
      const second = assert.rejects(assertLive(), refuses("PRODUCTION_IMPORT_LEASE_LOST"));
      finish.resolve(); await Promise.all([first, second]);
      assert.throws(assertNotLost, refuses("PRODUCTION_IMPORT_LEASE_LOST")); tick();
      await assertLive(); f.calls.push("activate");
    };
    await assert.rejects(withLease(f.input), refuses("PRODUCTION_IMPORT_LEASE_LOST"));
    assert.equal(renewals, 1); assert.equal(f.calls.filter(x => x === "acquire").length, 1);
    assert.equal(f.calls.includes("activate"), false); assert.equal(f.calls.at(-1), "release");
  }
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
test("low remaining proof budget causes one early renewal shared by overlapping dispatch checks", async () => {
  const f = leaseFixture(); const renew = f.input.port.renew; const entered = deferred(), finish = deferred(); let calls = 0;
  f.input.port.renew = async request => { calls++; entered.resolve(); await finish.promise; return renew(request); };
  f.input.operation = async (_, assertLive) => {
    f.advance(860_000);
    const first = assertLive(); await entered.promise; const second = assertLive(); const third = assertLive();
    finish.resolve(); await Promise.all([first, second, third]); assert.equal(calls, 1);
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

test("known acquire response delay consumes request-start validity and still releases exact ownership", async () => {
  const f = leaseFixture(); const acquire = f.input.port.acquire;
  f.input.port.acquire = async request => { const result = await acquire(request); f.advance(885_000); return result; };
  await assert.rejects(withLease(f.input), refuses("PRODUCTION_IMPORT_LEASE_LOST"));
  assert.equal(f.calls.includes("stage"), false); assert.equal(f.calls.at(-1), "release");
});
test("acquire queue delay cannot move proof deadline to response time", async () => {
  const f = leaseFixture(); const acquire = f.input.port.acquire;
  f.input.port.acquire = async request => { f.advance(120_000); return acquire(request); };
  f.input.operation = async (_, assertLive, assertNotLost) => {
    f.advance(764_999); assertNotLost(); f.advance(1);
    assert.throws(assertNotLost, refuses("PRODUCTION_IMPORT_LEASE_LOST")); await assertLive();
  };
  await assert.rejects(withLease(f.input), refuses("PRODUCTION_IMPORT_LEASE_LOST"));
  assert.equal(f.calls.includes("renew"), false); assert.equal(f.calls.at(-1), "release");
});
test("invalid finite-date or duration proof after known acquisition is never accepted or left unreleased", async () => {
  for (const mutate of [lease => { lease.heartbeatAt = new Date(NaN); }, lease => { lease.expiresAt = new Date(Infinity); },
    lease => { lease.heartbeatAt = "2026-08-31T18:00:00.000Z"; },
    lease => { lease.expiresAt = new Date(lease.heartbeatAt.getTime() + 900_001); },
    lease => { lease.expiresAt = new Date(lease.heartbeatAt.getTime() + 15_000); },
    lease => { lease.expiresAt = new Date(lease.heartbeatAt.getTime() - 1); }]) {
    const f = leaseFixture(); const acquire = f.input.port.acquire;
    f.input.port.acquire = async request => { const result = await acquire(request); mutate(result.lease); return result; };
    await assert.rejects(withLease(f.input), refuses("PRODUCTION_IMPORT_LEASE_LOST"));
    assert.equal(f.calls.includes("stage"), false); assert.equal(f.calls.at(-1), "release");
  }
});
test("same or stale renewal timestamps cannot manufacture a new validity window", async t => {
  const tick = fakeTimer(t);
  for (const stale of [false, true]) {
    const f = leaseFixture(); f.input.port.renew = async () => { const old = f.owned(); return { ...old,
      heartbeatAt: new Date(old.heartbeatAt.getTime() - (stale ? 1 : 0)), expiresAt: new Date(old.expiresAt.getTime() - (stale ? 1 : 0)) }; };
    f.input.operation = async (_, assertLive) => { f.advance(30_000); tick(); await assertLive(); f.calls.push("activate"); };
    await assert.rejects(withLease(f.input), refuses("PRODUCTION_IMPORT_LEASE_LOST"));
    assert.equal(f.calls.includes("activate"), false); assert.equal(f.calls.at(-1), "release");
  }
});
test("renew response delay consumes its own request-start window and cannot revive an expired response", async t => {
  const tick = fakeTimer(t); const f = leaseFixture(); const renew = f.input.port.renew;
  f.input.port.renew = async request => { const result = await renew(request); f.advance(885_000); return result; };
  f.input.operation = async (_, assertLive) => { f.advance(30_000); tick(); await assertLive(); f.calls.push("activate"); };
  await assert.rejects(withLease(f.input), refuses("PRODUCTION_IMPORT_LEASE_LOST"));
  assert.equal(f.calls.includes("activate"), false); assert.equal(f.calls.at(-1), "release");
});
test("renewal cannot replace a proof that expired while its response was pending", async t => {
  const tick = fakeTimer(t); const f = leaseFixture(); const renew = f.input.port.renew;
  f.input.port.renew = async request => { const result = await renew(request); f.advance(855_000); return result; };
  f.input.operation = async (_, assertLive, assertNotLost) => {
    f.advance(30_000); tick();
    // Old proof expires at885s; the candidate is still valid until915s. A gap in
    // local proof must nevertheless latch loss, never revive the expired proof.
    await assert.rejects(assertLive(), refuses("PRODUCTION_IMPORT_LEASE_LOST"));
    assert.throws(assertNotLost, refuses("PRODUCTION_IMPORT_LEASE_LOST")); await assertLive(); f.calls.push("activate");
  };
  await assert.rejects(withLease(f.input), refuses("PRODUCTION_IMPORT_LEASE_LOST"));
  assert.equal(f.calls.filter(call => call === "renew").length, 1);
  assert.equal(f.calls.includes("activate"), false); assert.equal(f.calls.at(-1), "release");
});
test("event-loop delay, backwards or nonfinite monotonic clocks latch loss before any renewal/write", async t => {
  const tick = fakeTimer(t);
  for (const next of [885_001, -1, NaN, Infinity]) {
    const f = leaseFixture(); f.input.operation = async (_, assertLive, assertNotLost) => {
      f.setClock(next); assert.throws(assertNotLost, refuses("PRODUCTION_IMPORT_LEASE_LOST"));
      f.setClock(0); tick(); await assertLive(); f.calls.push("activate");
    };
    await assert.rejects(withLease(f.input), refuses("PRODUCTION_IMPORT_LEASE_LOST"));
    assert.equal(f.calls.includes("renew"), false); assert.equal(f.calls.includes("activate"), false); assert.equal(f.calls.at(-1), "release");
  }
});
test("wall-clock rollback and returned Date mutation do not change accepted monotonic proof", async t => {
  const f = leaseFixture(); f.input.operation = async (_, assertLive, assertNotLost) => {
    t.mock.method(Date, "now", () => 0);
    f.owned().heartbeatAt.setTime(0); f.owned().expiresAt.setTime(0);
    f.advance(30_000); await assertLive(); assertNotLost(); return "verified";
  };
  assert.equal(await withLease(f.input), "verified"); assert.equal(f.calls.includes("renew"), false);
});
test("cleanup waits for in-flight renewal before normal exact-fence release", async t => {
  const tick = fakeTimer(t); const f = leaseFixture(); const entered = deferred(), finish = deferred(); const renew = f.input.port.renew;
  f.input.port.renew = async request => { entered.resolve(); await finish.promise; return renew(request); };
  f.input.operation = async () => { f.advance(30_000); tick(); await entered.promise; throw new Error("private stage failure"); };
  const run = withLease(f.input); const rejected = assert.rejects(run, refuses("PRODUCTION_PUBLICATION_FAILED"));
  await entered.promise; await Promise.resolve(); assert.equal(f.calls.includes("release"), false);
  finish.resolve(); await rejected; assert.equal(f.calls.at(-1), "release");
});
