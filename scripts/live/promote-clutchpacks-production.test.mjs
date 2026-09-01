import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, stat, rm, symlink, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { runClutchpacksProductionCli: run, parseClutchpacksProductionSourceConfig: parseConfig, serializeClutchpacksProductionSourcePort: serializeSource, clutchpacksProductionSourcePinsFromObservation: sourcePinsFromObservation } =
  await tsImport("./promote-clutchpacks-production.mts", import.meta.url);
const { CLUTCHPACKS_PRODUCTION_SCOPE: scope, productionPublicationSha256: digest, withClutchpacksProductionPublicationLease: withLease } =
  await tsImport("./clutchpacks-production-publication-policy.mts", import.meta.url);
const id = suffix => `11111111-1111-5111-8111-${suffix.padStart(12, "0")}`;
const hash = text => createHash("sha256").update(text).digest("hex");
const now = "2026-08-31T18:00:00.000Z";
const observationForPins = pins => ({ sourceCheckpoint: { runId: pins.runId, checkpointHash: pins.checkpointHash,
  stateGeneration: BigInt(pins.stateGeneration), promotionSequence: BigInt(pins.promotionSequence) },
  sourceObservation: { lastHeadReachedAt: pins.lastHeadReachedAt, qualityState: pins.qualityState, quarantineCount: pins.quarantineCount },
  stabilityFingerprint: pins.stabilityFingerprint });
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "packscout-production-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pinned = async (name, content) => {
    const file = path.join(directory, name); await writeFile(file, content, { mode: 0o600 });
    return { path: file, sha256: hash(content) };
  };
  const baseline = { schemaVersion: "approved_public_catalog_v1", configurationKey: "clutchpacks-baseline-v1", revision: 1,
    approvedAt: now, staleAfterSeconds: 7200, confidencePolicy: { version: "confidence-v1", completeScoreBasisPoints: 9000,
      partialScoreBasisPoints: 6000, unknownScoreBasisPoints: 3000, limitationPenaltyBasisPoints: 500 },
    publicAssetOrigins: ["https://clutchpacks.io"], verifiedUsdStablecoins: [], categories: [], repacks: [], collectibles: [],
    platforms: [{ platformKey: "clutchpacks", format: "repack", defaultPublicCategoryIds: [], categoryMappings: [],
      collectibleTypeMappings: [], vendor: { publicVendorId: id("9"), vendorKey: "clutchpacks", displayName: "ClutchPacks",
        logoUrl: null, websiteUrl: "https://clutchpacks.io/", listingHosts: ["clutchpacks.io"], imageOrigins: [],
        referralParameters: [], publicPromo: null } }],
  };
  const baselinePin = await pinned("baseline.json", JSON.stringify(baseline));
  const environment = "PACKSCOUT_CENTRAL_DATABASE_URL=postgresql://source-secret@central.example/packscout\nPACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64=private-key-material\nPACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION=key-v1\n";
  const config = { schemaVersion: "clutchpacks_production_source_config_v1",
    frozenEnvironment: await pinned("source.env", environment), centralHost: "central.us-west-2.aws.neon.tech",
    providerHost: "provider.us-west-2.aws.neon.tech", scope: { organizationId: scope.organizationId, providerId: scope.providerId,
      providerKey: scope.providerKey, operatorId: id("6"), configVersionId: scope.configId, configVersionNumber: "4" },
    expected: { routeDigest: "a".repeat(64), latestSucceededRunId: id("5"), checkpointHash: "b".repeat(64),
      stateGeneration: "41", runtimeRowVersion: "167" }, baseline: baselinePin, namespaceUuid: id("8"),
    identityProof: await pinned("proof.json", JSON.stringify({ schemaVersion: "proof-fixture", namespaceUuid: id("8"),
      baseline: { rawSha256: baselinePin.sha256 } })), approvedPublicAssetOrigins: ["https://clutchpacks.io"] };
  const configPath = path.join(directory, "source-config.json"); const bundlePath = path.join(directory, "bundle.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const plan = { classification: "publish", publicReleaseId: id("2"), releaseFingerprint: "c".repeat(64),
    manifest: { methodVersion: "packscout-buyback-adjusted-ev-v1", confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
      publicEvPolicyVersion: "packscout-public-ev-nonpositive-v1", dataAsOf: now, contentHash: "2".repeat(64),
      searchAlgorithmVersion: "repack_ev_search_v3", counts: { categories: 0, collectibles: 0, repacks: 17, chases: 0, searchShards: 1 },
      entityChainHashes: { categories: "0".repeat(64), collectibles: "0".repeat(64), repacks: "1".repeat(64), chases: "0".repeat(64) },
      topChaseCount: 0, batchCount: 0, batchChainHash: "3".repeat(64) }, batches: [] };
  const sourcePins = { runId: id("5"), checkpointHash: "b".repeat(64), stateGeneration: "41", promotionSequence: "125",
    stabilityFingerprint: "d".repeat(64), lastHeadReachedAt: "2026-08-31T17:00:00.000Z", qualityState: "degraded", quarantineCount: 465 };
  const source = { snapshot: { facts: {} }, categoryEvidence: { packs: new Map(), collectibles: new Map() }, sourcePins };
  const events = []; let clockCalls = 0; let healthClock = Date.parse(now);
  const deps = {
    async openSource(received, parsed) {
      events.push("open-source"); assert.deepEqual(received, config);
      assert.equal(parsed.PACKSCOUT_CENTRAL_DATABASE_URL, "postgresql://source-secret@central.example/packscout");
      return { async read() { events.push("read-source"); return source; },
        async assertQuiet() { events.push("quiet"); }, leasePort: {}, async close() { events.push("close-source"); } };
    },
    async openConvex(env) { events.push("open-convex"); assert.equal(env.NODE_ENV, "production"); return {
      publication: { async activeState() { events.push("active-state"); return { generation: 8,
        activeRelease: { publicReleaseId: id("3"), releaseFingerprint: "e".repeat(64) }, previousRelease: null }; } },
      publicClient: {}, catalogReadToken: "private-catalog-token", close() { events.push("close-convex"); },
    }; },
    projectSource: raw => ({ ...raw, sourcePins: sourcePinsFromObservation(observationForPins(raw.sourcePins)) }),
    buildConfiguration(input) { events.push("build-configuration"); assert.equal(input.approvedAt, now); return structuredClone(baseline); },
    async buildPlan(input) { events.push("build-plan"); assert.equal(input.readAt, now); return structuredClone(plan); },
    verifyIdentity(input) { events.push("verify-identity"); assert.equal(input.proof.baseline.rawSha256, baselinePin.sha256); },
    async readInventory() { events.push("read-inventory"); return { fixtureInventory: "current production inventory" }; },
    verifyInventory(input) { events.push("verify-inventory"); assert.equal(input.predecessor.generation, 8);
      assert.deepEqual(input.inventory, { fixtureInventory: "current production inventory" }); },
    async publish(input) { events.push("publish"); assert.equal(input.intent.readAt, now); assert.deepEqual(input.plan, plan);
      const attempt = await input.prepareObservation();
      assert.equal(attempt.request.qualityState, sourcePins.qualityState); assert.equal(input.intent.source.quarantineCount, 465);
      const file = `${bundlePath}.observation.${attempt.request.observationSequence}.json`;
      const saved = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(attempt.request, saved.request); assert.equal(attempt.requestSha256, digest(saved.request));
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      const actual = await input.readSource(); assert.deepEqual(actual.source, sourcePins);
      await input.assertSourceQuiet(); await input.verifyPublic({ plan: input.plan, client: input.client, activeState: {} });
      return { status: "verified", operationId: input.intent.operationId, publicReleaseId: input.plan.publicReleaseId,
        readAt: input.intent.readAt, source: input.intent.source, activateReceiptDigest: "f".repeat(64) }; },
    async verifyPublic(input) { events.push("verify-public"); assert.equal(input.catalogReadToken, "private-catalog-token"); return {}; },
    now() { clockCalls++; return now; }, healthNow: () => new Date(healthClock++).toISOString(), operationId: () => id("1"),
  };
  return { config, configPath, bundlePath, directory, sourcePins, plan, deps, events, clockCalls: () => clockCalls };
}
const refused = code => error => { assert.equal(error.code, code); assert.equal(error.message.includes("secret"), false); return true; };
test("prepare creates complete private immutable bundle without publication or leaking frozen environment", async t => {
  const f = await fixture(t); const before = process.env.PACKSCOUT_CENTRAL_DATABASE_URL;
  const result = await run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps);
  assert.equal(result.status, "prepared"); assert.equal(result.quarantineCount, 465);
  const encoded = await readFile(f.bundlePath, "utf8"); const bundle = JSON.parse(encoded);
  assert.equal((await stat(f.bundlePath)).mode & 0o777, 0o600);
  const { bundleSha256, ...body } = bundle; assert.equal(bundleSha256, digest(body));
  assert.equal(bundle.intent.readAt, now); assert.equal(bundle.intent.source.qualityState, "degraded");
  assert.equal(bundle.observation, undefined, "the EV plan must not freeze a stale health request");
  assert.equal(bundle.productionInventorySha256, digest(bundle.productionInventory));
  assert.equal(f.events.filter(event => event === "read-inventory").length, 1);
  assert.ok(f.events.indexOf("read-source") < f.events.indexOf("quiet"), "full read establishes actual reader quiet baseline");
  assert.equal(/source-secret|private-key-material|private-catalog-token/u.test(encoded), false);
  assert.equal(process.env.PACKSCOUT_CENTRAL_DATABASE_URL, before);
  assert.equal(f.events.includes("publish"), false); assert.equal(f.events.includes("verify-public"), false);
  assert.deepEqual(f.events.slice(-2).sort(), ["close-convex", "close-source"]);
});
test("publishing and retrying preserve approved clock/plan and verify again with distinct immutable receipts", async t => {
  const f = await fixture(t); await run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps);
  const original = await readFile(f.bundlePath, "utf8"); f.events.length = 0;
  f.deps.now = () => { throw new Error("publish must not recompute clock"); };
  f.deps.buildPlan = async () => { throw new Error("publish must not recompute plan"); };
  f.deps.buildConfiguration = () => { throw new Error("publish must not reapprove configuration"); };
  const first = await run(["--publish", f.bundlePath], { NODE_ENV: "production" }, f.deps);
  const second = await run(["--publish", f.bundlePath], { NODE_ENV: "production" }, f.deps);
  assert.equal(first.status, "verified"); assert.notEqual(first.receiptPath, second.receiptPath);
  assert.equal(f.events.filter(x => x === "publish").length, 2); assert.equal(f.events.filter(x => x === "verify-public").length, 2);
  assert.equal(await readFile(f.bundlePath, "utf8"), original);
  for (const file of [first.receiptPath, second.receiptPath]) {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(/source-secret|private-key-material|private-catalog-token/u.test(await readFile(file, "utf8")), false);
  }
});
test("production environment and exact command arity are enforced before opening any runtime", async t => {
  const f = await fixture(t);
  await assert.rejects(run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "development" }, f.deps), refused("PRODUCTION_ENVIRONMENT_REQUIRED"));
  await assert.rejects(run(["--publish", f.bundlePath, "extra"], { NODE_ENV: "production" }, f.deps), refused("PRODUCTION_ARGUMENTS_INVALID"));
  assert.deepEqual(f.events, []);
});
test("source configuration rejects unknown secret keys, foreign scope and unpinned or alternate destinations", async t => {
  const f = await fixture(t);
  for (const mutate of [x => { x.secret = "secret"; }, x => { x.scope.providerId = id("88"); },
    x => { x.providerHost = "127.0.0.1"; }, x => { x.frozenEnvironment.path = "relative.env"; },
    x => { delete x.identityProof.sha256; }, x => { x.scope.configVersionNumber = "5"; }]) {
    const value = structuredClone(f.config); mutate(value);
    assert.throws(() => parseConfig(value), refused("PRODUCTION_SOURCE_CONFIG_INVALID"));
  }
});
test("changed frozen environment or baseline proof refuses before source/cloud access", async t => {
  const f = await fixture(t); await writeFile(f.config.frozenEnvironment.path, "new-secret", { mode: 0o600 });
  await assert.rejects(run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps), refused("PRODUCTION_FILE_DIGEST_CHANGED"));
  assert.deepEqual(f.events, []);
  const g = await fixture(t); await writeFile(g.config.identityProof.path, "{}", { mode: 0o600 });
  await assert.rejects(run(["--prepare", g.configPath, g.bundlePath], { NODE_ENV: "production" }, g.deps), refused("PRODUCTION_FILE_DIGEST_CHANGED"));
  assert.deepEqual(g.events, []);
});
test("private source files cannot be symlink substituted", async t => {
  const f = await fixture(t); const replacement = path.join(f.directory, "replacement.env");
  await writeFile(replacement, await readFile(f.config.frozenEnvironment.path), { mode: 0o600 });
  await rm(f.config.frozenEnvironment.path); await symlink(replacement, f.config.frozenEnvironment.path);
  await assert.rejects(run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps), refused("PRODUCTION_CLI_FAILED"));
  assert.deepEqual(f.events, []);
});
test("existing bundle is never overwritten and its bytes remain intact", async t => {
  const f = await fixture(t); await writeFile(f.bundlePath, "operator-owned existing artifact", { mode: 0o600 });
  await assert.rejects(run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps), refused("PRODUCTION_CLI_FAILED"));
  assert.equal(await readFile(f.bundlePath, "utf8"), "operator-owned existing artifact");
});
test("tampered plan or clock is refused without runtime opening even if JSON remains valid", async t => {
  const f = await fixture(t); await run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps);
  const bundle = JSON.parse(await readFile(f.bundlePath, "utf8")); bundle.intent.readAt = "2026-09-01T18:00:00.000Z";
  await writeFile(f.bundlePath, JSON.stringify(bundle)); f.events.length = 0;
  await assert.rejects(run(["--publish", f.bundlePath], { NODE_ENV: "production" }, f.deps), refused("PRODUCTION_BUNDLE_DIGEST_CHANGED"));
  assert.deepEqual(f.events, []);
});
test("publication failure closes both runtimes and never creates a success receipt", async t => {
  const f = await fixture(t); await run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps);
  f.events.length = 0; f.deps.publish = async () => { throw new Error("secret publication transport error"); };
  await assert.rejects(run(["--publish", f.bundlePath], { NODE_ENV: "production" }, f.deps), refused("PRODUCTION_CLI_FAILED"));
  assert.deepEqual(f.events.slice(-2).sort(), ["close-convex", "close-source"]);
});
test("changed live source checkpoint refuses preparing an intent for a different run", async t => {
  const f = await fixture(t); f.sourcePins.checkpointHash = "f".repeat(64);
  await assert.rejects(run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps), refused("PRODUCTION_SOURCE_CHANGED"));
  assert.equal(f.events.includes("build-plan"), false);
  assert.deepEqual(f.events.slice(-2).sort(), ["close-convex", "close-source"]);
});

test("expired source refuses before opening runtimes and saving a fresh observation never extends the source horizon", async t => {
  const f = await fixture(t); await run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps);
  f.deps.healthNow = () => "2026-08-31T19:00:00.000Z"; f.events.length = 0;
  await assert.rejects(run(["--publish", f.bundlePath], { NODE_ENV: "production" }, f.deps), refused("PRODUCTION_SOURCE_HEAD_STALE"));
  assert.equal(f.events.includes("open-source"), false); assert.equal(f.events.includes("publish"), false);
  f.deps.healthNow = () => "2026-08-31T18:30:00.000Z";
  await run(["--publish", f.bundlePath], { NODE_ENV: "production" }, f.deps);
  const attempt = JSON.parse(await readFile(`${f.bundlePath}.observation.${Date.parse("2026-08-31T18:30:00.000Z")}.json`, "utf8"));
  assert.equal(attempt.request.freshThrough, "2026-08-31T19:00:00.000Z");
  assert.equal(attempt.request.observedAt, "2026-08-31T18:30:00.000Z");
});
test("uncertain observation attempt is preserved and the same clock cannot silently overwrite or retry it", async t => {
  const f = await fixture(t); await run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps);
  f.deps.healthNow = () => now;
  f.deps.publish = async input => { await input.prepareObservation(); throw new Error("unknown signed API outcome"); };
  await assert.rejects(run(["--publish", f.bundlePath], { NODE_ENV: "production" }, f.deps), refused("PRODUCTION_CLI_FAILED"));
  const file = `${f.bundlePath}.observation.${Date.parse(now)}.json`; const original = await readFile(file, "utf8");
  await assert.rejects(run(["--publish", f.bundlePath], { NODE_ENV: "production" }, f.deps), refused("PRODUCTION_CLI_FAILED"));
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal((await readdir(f.directory)).some(name => name.includes(".receipt.")), false);
});
test("known source codes survive sanitization while arbitrary codes and private messages are suppressed", async t => {
  for (const [error, code] of [
    [Object.assign(new Error("source-secret transport"), { code: "PRODUCTION_SOURCE_ROUTE_CHANGED" }), "PRODUCTION_SOURCE_ROUTE_CHANGED"],
    [Object.assign(new Error("source-secret transport"), { code: "EXFILTRATE_source-secret" }), "PRODUCTION_CLI_FAILED"],
    [new Error("CLUTCHPACKS_PRODUCTION_CONVEX_RUNTIME_UNAVAILABLE"), "CLUTCHPACKS_PRODUCTION_CONVEX_RUNTIME_UNAVAILABLE"],
    [new Error("CLUTCHPACKS_PRODUCTION_IDENTITY_CONTINUITY_FAILED"), "CLUTCHPACKS_PRODUCTION_IDENTITY_CONTINUITY_FAILED"],
  ]) {
    const f = await fixture(t); f.deps.openSource = async () => { throw error; };
    await assert.rejects(run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps), refused(code));
  }
});
test("source queue serializes snapshot, quiet and every lease operation, survives failures and drains before closing", async () => {
  const events = []; let releaseRead; let concurrent = 0;
  const operation = (name, wait = false, fail = false) => async () => {
    assert.equal(concurrent++, 0); events.push(name);
    try { if (wait) await new Promise(resolve => { releaseRead = resolve; });
      if (fail) throw new Error("quiet failed"); return name; }
    finally { concurrent--; }
  };
  const source = serializeSource({ read: operation("read", true), assertQuiet: operation("quiet", false, true),
    leasePort: { acquire: operation("acquire"), renew: operation("renew"), release: operation("release") }, close: operation("close") });
  const reading = source.read(); const quiet = source.assertQuiet();
  const acquiring = source.leasePort.acquire({}); const renewing = source.leasePort.renew({}); const releasing = source.leasePort.release({});
  const closing = source.close(); await Promise.resolve(); assert.deepEqual(events, ["read"]);
  releaseRead(); assert.equal(await reading, "read"); await assert.rejects(quiet, /quiet failed/u);
  assert.equal(await acquiring, "acquire"); assert.equal(await renewing, "renew"); assert.equal(await releasing, "release");
  await closing; assert.deepEqual(events, ["read", "quiet", "acquire", "renew", "release", "close"]);
  await assert.rejects(source.read(), refused("PRODUCTION_SOURCE_CLOSED_OR_BUSY"));
});

test("private lease evidence exists before an uncertain acquisition and preserves cleanup warnings", async t => {
  for (const code of ["PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED", "PRODUCTION_IMPORT_LEASE_ACQUIRE_UNKNOWN"]) {
    const f = await fixture(t); await run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps);
    let acquired = 0; let saved;
    f.deps.publish = async input => withLease({ intent: input.intent, prepareLeaseAttempt: input.prepareLeaseAttempt,
      assertSourceQuiet: async () => undefined, operation: async () => { throw new Error("must not publish"); }, port: {
        async acquire(request) {
          acquired++; const names = (await readdir(f.directory)).filter(name => name.startsWith("bundle.json.lease."));
          assert.equal(names.length, 1); const file = path.join(f.directory, names[0]);
          saved = JSON.parse(await readFile(file, "utf8")); assert.equal((await stat(file)).mode & 0o777, 0o600);
          assert.deepEqual(saved.request, request); assert.equal(saved.requestSha256, digest(request));
          assert.equal(saved.intentSha256, digest(input.intent));
          assert.equal(saved.bundleSha256, JSON.parse(await readFile(f.bundlePath, "utf8")).bundleSha256);
          throw Object.assign(new Error("source-secret uncertain write"), { code: code === "PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED" ? code : "TIMEOUT" });
        }, async renew() { throw new Error("must not renew"); }, async release() { throw new Error("must not clear unknown owner"); },
      } });
    await assert.rejects(run(["--publish", f.bundlePath], { NODE_ENV: "production" }, f.deps), refused(code));
    assert.equal(acquired, 1); assert.equal(saved.schemaVersion, "clutchpacks_production_lease_attempt_v1");
    assert.equal((await readdir(f.directory)).some(name => name.includes(".receipt.")), false);
    assert.equal(/source-secret|private-key-material|private-catalog-token/u.test(JSON.stringify(saved)), false);
  }
});

test("exclusive lease-evidence collision refuses before acquire and preserves the existing artifact", async t => {
  const f = await fixture(t); await run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps);
  let acquisitions = 0; let collision;
  f.deps.publish = async input => withLease({ intent: input.intent,
    prepareLeaseAttempt: async attempt => {
      collision = `${f.bundlePath}.lease.${attempt.attemptId}.json`;
      await writeFile(collision, "operator-owned evidence", { mode: 0o600 });
      await input.prepareLeaseAttempt(attempt);
    }, assertSourceQuiet: async () => undefined, operation: async () => { throw new Error("must not publish"); },
    port: { async acquire() { acquisitions++; throw new Error("must not acquire"); },
      async renew() { throw new Error("must not renew"); }, async release() { throw new Error("must not release"); } },
  });
  await assert.rejects(run(["--publish", f.bundlePath], { NODE_ENV: "production" }, f.deps), refused("PRODUCTION_IMPORT_LEASE_ATTEMPT_PERSIST_FAILED"));
  assert.equal(acquisitions, 0); assert.equal(await readFile(collision, "utf8"), "operator-owned evidence");
});

test("unknown and unhealthy source quality with465 quarantines survives actual pin mapping, intent, observation and output", async t => {
  for (const qualityState of ["unknown", "unhealthy"]) {
    const f = await fixture(t); f.sourcePins.qualityState = qualityState;
    const prepared = await run(["--prepare", f.configPath, f.bundlePath], { NODE_ENV: "production" }, f.deps);
    assert.equal(prepared.qualityState, qualityState); assert.equal(prepared.quarantineCount, 465);
    const bundle = JSON.parse(await readFile(f.bundlePath, "utf8")); assert.equal(bundle.intent.source.qualityState, qualityState);
    const verified = await run(["--publish", f.bundlePath], { NODE_ENV: "production" }, f.deps);
    assert.equal(verified.qualityState, qualityState); assert.equal(verified.quarantineCount, 465);
    const names = (await readdir(f.directory)).filter(name => name.includes(".observation.")); assert.equal(names.length, 1);
    const attempt = JSON.parse(await readFile(path.join(f.directory, names[0]), "utf8"));
    assert.equal(attempt.request.qualityState, qualityState);
    assert.equal(JSON.parse(await readFile(verified.receiptPath, "utf8")).source.qualityState, qualityState);
  }
});
test("source pin mapping rejects malformed quality and healthy quarantines without reinterpreting them", async t => {
  const f = await fixture(t);
  for (const qualityState of ["healthy", "invalid", null, 1]) {
    assert.throws(() => sourcePinsFromObservation(observationForPins({ ...f.sourcePins, qualityState })), refused("PRODUCTION_SOURCE_CHECKPOINT_INVALID"));
  }
  const healthy = sourcePinsFromObservation(observationForPins({ ...f.sourcePins, qualityState: "healthy", quarantineCount: 0 }));
  assert.equal(healthy.qualityState, "healthy"); assert.equal(healthy.quarantineCount, 0);
});
