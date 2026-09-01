import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { optionsFixture, sourcePostgresFixture, policy, db } from "./clutchpacks-production-source.test-support.mjs";
const { createClutchpacksProductionSourceReader } = await tsImport("./clutchpacks-production-source-reader.mts", import.meta.url);
const { readProductionSourceState, assertProductionSourceLeaseBudget } = await tsImport("./clutchpacks-production-source-state.mts", import.meta.url);
const { readProductionSourceCatalog } = await tsImport("./clutchpacks-production-source-catalog.mts", import.meta.url);
const { releaseKnownProductionSourceLease } = await tsImport("./clutchpacks-production-source-lease.mts", import.meta.url);
const readonly = (client, operation) => policy.drainSourceOperation(callback => client.$transaction(callback,
  { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 30_000 }), async tx => {
  await tx.$executeRaw`SET TRANSACTION READ ONLY`; await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`; return operation(tx);
});

test("production source permits only exact native strict TLS and never opens credentials during construction", async () => {
  const options = optionsFixture();
  assert.equal(new URL(policy.validateProductionSourceOptions(options)).searchParams.get("sslaccept"), "strict");
  const alternate = { ...options, centralDatabaseUrl: options.centralDatabaseUrl.replace("require&sslaccept=strict", "verify-full") };
  assert.equal(new URL(policy.validateProductionSourceOptions(alternate)).searchParams.get("sslmode"), "verify-full");
  let credentialCalls = 0;
  options.credentialResolver = { resolve: async () => { credentialCalls++; throw new Error("No calls allowed"); } };
  const reader = createClutchpacksProductionSourceReader(options);
  await reader.close(); assert.equal(credentialCalls, 0);
  await assert.rejects(reader.read(), /PRODUCTION_SOURCE_CLOSED_OR_BUSY/);
});
for (const [label, mutate] of [
  ["unverified TLS", o => { o.centralDatabaseUrl = o.centralDatabaseUrl.replace("&sslaccept=strict", ""); }],
  ["invalid certificates", o => { o.centralDatabaseUrl = o.centralDatabaseUrl.replace("strict", "accept_invalid_certs"); }],
  ["duplicate TLS", o => { o.centralDatabaseUrl += "&sslmode=disable"; }],
  ["socket override", o => { o.centralDatabaseUrl += "&host=/tmp"; }],
  ["host override", o => { o.centralHost = "other.neon.tech"; }],
  ["loopback provider", o => { o.providerHost = "127.0.0.1"; }],
  ["database mismatch", o => { o.centralDatabaseUrl = o.centralDatabaseUrl.replace("/packscout?", "/other?"); }],
  ["wrong provider", o => { o.scope.providerKey = "courtyard"; }],
  ["invalid operator", o => { o.scope.operatorId = "not-an-id"; }],
  ["empty approved origins", o => { o.approvedPublicAssetOrigins = []; }],
]) test(`source configuration refuses ${label} without connecting`, () => {
  const options = optionsFixture(); mutate(options);
  assert.throws(() => createClutchpacksProductionSourceReader(options), /PRODUCTION_SOURCE_CONFIGURATION_INVALID/);
});

test("final central latency cannot outlive the provider-clock lease admission budget", () => {
  assert.doesNotThrow(() => assertProductionSourceLeaseBudget(150, 149));
  assert.throws(() => assertProductionSourceLeaseBudget(150, 150), /PRODUCTION_SOURCE_IMPORT_LEASE_UNAVAILABLE/);
  assert.doesNotThrow(() => assertProductionSourceLeaseBudget(null, 9_000));
});

test("real PostgreSQL source reads preserve history, cover non-membership cards, and fence exact tenant/head/lease", { timeout: 180_000 }, async context => {
  const fixture = await sourcePostgresFixture();
  const { options, central, provider, leases } = fixture;
  const authority = () => readonly(central, tx => policy.readProductionSourceAuthority(tx, options));
  const capture = async (expectedImportLease, input = options) => {
    const currentAuthority = await authority();
    return readonly(provider, tx => readProductionSourceState(tx, input, currentAuthority, expectedImportLease));
  };
  try {
    const before = { lease: await provider.provider_worker_states.findUnique({ where: { worker_role: "import" } }),
      runtime: await provider.provider_runtime.findUnique({ where: { singleton_key: true } }),
      runs: await provider.provider_runs.findMany(), pages: await provider.provider_run_pages.findMany(), audits: await provider.local_audit_events.findMany() };
    const initialAuthority = await authority(), initial = await capture();
    const catalog = await readonly(provider, tx => readProductionSourceCatalog(tx, options, initialAuthority, initial));
    await context.test("full catalog retains cards and aliases outside every pack membership", () => {
      assert.equal(catalog.facts.contentCatalog.collectibles.length, 0);
      assert.equal(catalog.canonicalCatalog.collectibles.length, 3);
      assert.equal(catalog.canonicalCatalog.aliases.length, 1);
      assert.equal(catalog.canonicalCatalog.aliases[0].collectible_id, fixture.cards[2].id);
      assert.equal(catalog.canonicalCatalog.packs[0].category_id, fixture.category.id);
      assert.equal(catalog.canonicalCatalog.categories[0].category_key, "pokemon");
      assert.equal(catalog.facts.activeCollectibleCount, 3);
      assert.equal(Object.hasOwn(catalog, "checkpoint"), false);
      assert.equal(Object.hasOwn(catalog, "sharedConfigurationEpoch"), false);
    });
    await context.test("dry reads leave leases, runtime, all parent/page/audit history unchanged", async () => {
      assert.deepEqual({ lease: await provider.provider_worker_states.findUnique({ where: { worker_role: "import" } }),
        runtime: await provider.provider_runtime.findUnique({ where: { singleton_key: true } }), runs: await provider.provider_runs.findMany(),
        pages: await provider.provider_run_pages.findMany(), audits: await provider.local_audit_events.findMany() }, before);
      await assert.rejects(readonly(provider, tx => tx.categories.create({ data: { category_key: "read-only-must-refuse", display_name: "Refuse" } })), /read-only transaction/);
      assert.equal(await provider.categories.count(), 1);
    });
    for (const [label, mutate] of [
      ["tenant", o => { o.scope.organizationId = randomUUID(); }], ["operator", o => { o.scope.operatorId = randomUUID(); }],
      ["provider", o => { o.scope.providerId = randomUUID(); }], ["config", o => { o.scope.configVersionId = randomUUID(); }],
      ["route", o => { o.expected.routeDigest = "d".repeat(64); }],
    ]) await context.test(`central refuses changed ${label}`, async () => {
      const changed = { ...options, scope: { ...options.scope }, expected: { ...options.expected } }; mutate(changed);
      await assert.rejects(readonly(central, tx => policy.readProductionSourceAuthority(tx, changed)), /PRODUCTION_SOURCE_/);
    });
    for (const [label, mutate] of [
      ["provider identity", o => { o.scope.providerId = randomUUID(); }], ["generation", o => { o.expected.stateGeneration++; }],
      ["runtime version", o => { o.expected.runtimeRowVersion++; }], ["head run", o => { o.expected.latestSucceededRunId = randomUUID(); }],
      ["full checkpoint pin", o => { o.expected.checkpointHash = "e".repeat(64); }],
    ]) await context.test(`provider refuses changed ${label}`, async () => {
      const changed = { ...options, scope: { ...options.scope }, expected: { ...options.expected } }; mutate(changed);
      await assert.rejects(capture(undefined, changed), /PRODUCTION_SOURCE_/);
    });
    await context.test("normal fenced publication lease excludes a foreign importer and is never inferred by a dry read", async () => {
      const claim = await leases.acquire({ role: "import", owner: "fixture:publication", leaseMilliseconds: 90_000 }); assert.equal(claim.kind, "acquired");
      await assert.rejects(capture(), /PRODUCTION_SOURCE_IMPORT_LEASE_UNAVAILABLE/);
      await assert.rejects(capture({ ...claim.lease, owner: "fixture:foreign" }), /PRODUCTION_SOURCE_IMPORT_LEASE_UNAVAILABLE/);
      await assert.rejects(capture({ ...claim.lease, fence: claim.lease.fence + 1n }), /PRODUCTION_SOURCE_IMPORT_LEASE_UNAVAILABLE/);
      assert.equal((await leases.acquire({ role: "import", owner: "fixture:foreign", leaseMilliseconds: 90_000 })).kind, "held");
      const held = await capture(claim.lease); assert.equal(held.digest, initial.digest);
      await assert.rejects(releaseKnownProductionSourceLease(provider, { ...options.scope, providerId: randomUUID() }, claim.lease), /PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED/);
      await assert.rejects(releaseKnownProductionSourceLease(provider, options.scope, { ...claim.lease, fence: claim.lease.fence + 1n }), /PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED/);
      assert.equal((await provider.provider_worker_states.findUnique({ where: { worker_role: "import" } })).lease_owner, claim.lease.owner);
      assert.equal(await releaseKnownProductionSourceLease(provider, options.scope, claim.lease), true);
      assert.equal((await capture()).digest, initial.digest);
    });
    await context.test("short lease budget fails without publication or lease mutation", async () => {
      const claim = await leases.acquire({ role: "import", owner: "fixture:short", leaseMilliseconds: 10_000 }); assert.equal(claim.kind, "acquired");
      const saved = await provider.provider_worker_states.findUnique({ where: { worker_role: "import" } });
      await assert.rejects(capture(claim.lease), /PRODUCTION_SOURCE_IMPORT_LEASE_UNAVAILABLE/);
      assert.deepEqual(await provider.provider_worker_states.findUnique({ where: { worker_role: "import" } }), saved);
      await leases.release(claim.lease);
    });
  } finally { await fixture.close(); }
});
