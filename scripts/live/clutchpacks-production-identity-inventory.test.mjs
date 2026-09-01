import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { captureClutchpacksProductionIdentityInventory, readClutchpacksProductionIdentityInventory,
  clutchpacksIdentityPageQuery, CLUTCHPACKS_IDENTITY_STATE_QUERY } = await tsImport("./clutchpacks-production-identity-inventory.mts", import.meta.url);
const { productionPublicationSha256 } = await tsImport("./clutchpacks-production-publication-policy.mts", import.meta.url);
const { PACKSCOUT_BUYBACK_EV_METHOD_VERSION, PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3 } = await tsImport("../../packages/contracts/src/index.ts", import.meta.url);
const id = (n) => `00000000-0000-5000-8000-${String(n).padStart(12, "0")}`;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const safeFailure = (error) => error.message === "CLUTCHPACKS_PRODUCTION_IDENTITY_INVENTORY_INVALID";

function fixture(options = {}) {
  const acceptedCounts = { categories: 1, collectibles: options.collectibles ?? 3,
    repacks: options.repacks ?? 2, chases: 0, searchShards: 1 };
  const pointer = { publicReleaseId: id(90_000), releaseFingerprint: "a".repeat(64),
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION, confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3, dataAsOf: "2026-08-31T00:00:00.000Z",
    completedAt: "2026-08-31T00:01:00.000Z", counts: { ...acceptedCounts } };
  const active = { key: "singleton", generation: 2, activeReleaseId: "active-internal-id", activeRelease: pointer };
  const release = { ...pointer, lifecycle: "complete", acceptedCounts, expectedCounts: { ...acceptedCounts },
    acceptedBatchCount: 1, expectedBatchCount: 1, acceptedBatchChainHash: "b".repeat(64), expectedBatchChainHash: "b".repeat(64),
    acceptedSearchRowCount: acceptedCounts.repacks, acceptedEntityChainHashes: {}, expectedEntityChainHashes: {} };
  const category = { publicCategoryId: id(80_000), parentPublicCategoryId: null, categoryKey: "sports", name: "Sports",
    kind: "vertical", depth: 0, pathPublicCategoryIds: [id(80_000)], displayOrder: 0 };
  const rows = {
    activeDataReleaseV3State: [active],
    dataReleaseV3Collectibles: Array.from({ length: acceptedCounts.collectibles }, (_, n) => ({ releaseId: "active-internal-id",
      publicCollectibleId: id(n + 1), detail: { name: "PRIVATE_RAW_PAYLOAD_MUST_NOT_LEAVE", aliases: [] } })),
    dataReleaseV3Repacks: Array.from({ length: acceptedCounts.repacks }, (_, n) => ({ releaseId: "active-internal-id",
      publicRepackId: id(n + 50_000), detail: { publicRepackId: id(n + 50_000), publicVendorId: id(70_000), vendorKey: "clutchpacks",
        description: options.largePacks ? "x".repeat(1_000_000) : "PRIVATE_RAW_PAYLOAD_MUST_NOT_LEAVE",
        actions: { repackLink: { listingUrl: `https://clutchpacks.io/checkout/${id(n + 100_000)}` } } } })),
    dataReleaseV3Categories: [{ releaseId: "active-internal-id", publicCategoryId: category.publicCategoryId, detail: category }],
  };
  const calls = [];
  const ctx = { db: {
    async get(table, rowId) { assert.equal(table, "dataReleaseV3Releases"); assert.equal(rowId, "active-internal-id"); return release; },
    query(table) {
      assert.ok(Object.hasOwn(rows, table), `unexpected table ${table}`);
      let predicates = [];
      const result = () => rows[table].filter((row) => predicates.every(([kind, key, value]) => kind === "eq" ? row[key] === value : row[key] > value))
        .sort((a, b) => String(a.publicCollectibleId ?? a.publicRepackId ?? a.publicCategoryId ?? a.key)
          .localeCompare(String(b.publicCollectibleId ?? b.publicRepackId ?? b.publicCategoryId ?? b.key)));
      const query = {
        withIndex(index, callback) {
          const p = { eq(key, value) { predicates.push(["eq", key, value]); return p; },
            gt(key, value) { predicates.push(["gt", key, value]); return p; } };
          callback(p); calls.push({ table, index, predicates: [...predicates] }); return query;
        },
        async unique() { const selected = result(); assert.equal(selected.length, 1); return selected[0]; },
        async take(limit) { calls.push({ table, limit }); return result().slice(0, limit); },
        async *[Symbol.asyncIterator]() { for (const row of result()) yield row; },
      };
      return query;
    },
  } };
  const pages = [];
  let stateReads = 0;
  const evaluate = async (source) => await new AsyncFunction("ctx", source)(ctx);
  const port = {
    async readState() { stateReads++; await options.beforeState?.({ active, release, stateReads }); return await evaluate(CLUTCHPACKS_IDENTITY_STATE_QUERY); },
    async readPage(kind, cursor, pins) {
      pages.push({ kind, cursor, pins });
      await options.beforePage?.({ active, release, rows, pages, kind });
      return await evaluate(clutchpacksIdentityPageQuery(kind, cursor, pins));
    },
  };
  return { active, release, rows, calls, pages, port, evaluate, stateReads: () => stateReads };
}

test("captures all6442 public collectible IDs in13 pages with only public identity references", async () => {
  const h = fixture({ collectibles: 6_442, repacks: 17 });
  const inventory = await captureClutchpacksProductionIdentityInventory(h.port);
  assert.equal(inventory.publicCollectibleIds.length, 6_442);
  assert.equal(h.pages.filter((p) => p.kind === "collectibles").length, 13);
  assert.equal(h.stateReads(), 2);
  assert.equal(inventory.publicRepackIds.length, 17);
  assert.equal(inventory.repacks[0].listingUrl, `https://clutchpacks.io/checkout/${id(100_000)}`);
  assert.deepEqual(inventory.categories, [h.rows.dataReleaseV3Categories[0].detail]);
  assert.equal(JSON.stringify(inventory).includes("PRIVATE_RAW_PAYLOAD"), false);
  const { digest, ...body } = inventory;
  assert.equal(digest, productionPublicationSha256(body));
  assert.deepEqual(Object.keys(inventory).sort(), ["schemaVersion", "activeState", "publicRepackIds", "publicCollectibleIds", "categories", "repacks", "digest"].sort());
});

test("each invocation captures a newly active predecessor and its newly introduced identities", async () => {
  const h = fixture();
  const first = await captureClutchpacksProductionIdentityInventory(h.port);
  h.active.generation++;
  h.active.activeRelease.publicReleaseId = h.release.publicReleaseId = id(90_001);
  h.active.activeRelease.releaseFingerprint = h.release.releaseFingerprint = "c".repeat(64);
  h.rows.dataReleaseV3Collectibles.push({ releaseId: "active-internal-id", publicCollectibleId: id(4), detail: {} });
  for (const counts of [h.active.activeRelease.counts, h.release.acceptedCounts, h.release.expectedCounts]) counts.collectibles++;
  const second = await captureClutchpacksProductionIdentityInventory(h.port);
  assert.equal(second.activeState.generation, 3);
  assert.equal(second.publicCollectibleIds.includes(id(4)), true);
  assert.notEqual(second.digest, first.digest);
});

test("page transactions and final read reject generation, identity or fingerprint changes", async () => {
  for (const field of ["generation", "publicReleaseId", "releaseFingerprint"]) {
    const h = fixture({ beforePage({ active, kind }) {
      if (kind !== "repacks") return;
      if (field === "generation") active.generation++;
      else active.activeRelease[field] = field === "publicReleaseId" ? id(99_999) : "f".repeat(64);
    } });
    await assert.rejects(captureClutchpacksProductionIdentityInventory(h.port), /INVENTORY_PREDECESSOR_CHANGED/u);
  }
  const h = fixture({ beforeState({ active, stateReads }) { if (stateReads === 2) active.generation++; } });
  await assert.rejects(captureClutchpacksProductionIdentityInventory(h.port), safeFailure);
});

test("missing, duplicate, excess, malformed and unbound category identities cannot pass count validation", async () => {
  for (const mutate of [
    (h) => { h.rows.dataReleaseV3Collectibles.pop(); },
    (h) => { h.rows.dataReleaseV3Collectibles[1].publicCollectibleId = id(1); },
    (h) => { h.rows.dataReleaseV3Collectibles.push({ releaseId: "active-internal-id", publicCollectibleId: id(4) }); },
    (h) => { h.rows.dataReleaseV3Collectibles[0].publicCollectibleId = "not-an-id"; },
    (h) => { h.rows.dataReleaseV3Repacks[0].detail.publicRepackId = id(42); },
    (h) => { h.rows.dataReleaseV3Repacks[0].detail.vendorKey = "another_provider"; },
    (h) => { h.rows.dataReleaseV3Categories[0].detail.pathPublicCategoryIds = [id(90), id(80_000)];
      h.rows.dataReleaseV3Categories[0].detail.depth = 1; h.rows.dataReleaseV3Categories[0].detail.parentPublicCategoryId = id(90); },
  ]) {
    const h = fixture(); mutate(h);
    await assert.rejects(captureClutchpacksProductionIdentityInventory(h.port));
  }
});

test("invalid release counts and incomplete immutable publication proofs fail before entity reads", async () => {
  for (const mutate of [
    (h) => { h.release.acceptedCounts.collectibles++; },
    (h) => { h.active.activeRelease.counts.collectibles = h.release.acceptedCounts.collectibles = h.release.expectedCounts.collectibles = 20_001; },
    (h) => { h.release.acceptedBatchChainHash = "0".repeat(64); },
    (h) => { h.release.lifecycle = "staging"; },
  ]) {
    const h = fixture(); mutate(h);
    await assert.rejects(captureClutchpacksProductionIdentityInventory(h.port));
    assert.equal(h.pages.length, 0);
  }
});

test("large public pack documents split under the read byte bound without losing identity references", async () => {
  const h = fixture({ repacks: 6, largePacks: true });
  const inventory = await captureClutchpacksProductionIdentityInventory(h.port);
  assert.equal(inventory.repacks.length, 6);
  assert.equal(h.pages.filter((p) => p.kind === "repacks").length, 2);
  assert.equal(JSON.stringify(inventory).length < 10_000, true);
});

test("nonadvancing or crossed page receipts fail instead of retrying indefinitely", async () => {
  for (const patch of [{ items: [], lastId: null, hasMore: true },
    { lastId: id(10) }, { pins: { generation: 3, publicReleaseId: id(90_000), releaseFingerprint: "a".repeat(64) } }]) {
    const h = fixture();
    const read = h.port.readPage;
    h.port.readPage = async (...args) => ({ ...await read(...args), ...patch });
    await assert.rejects(captureClutchpacksProductionIdentityInventory(h.port), safeFailure);
    assert.equal(h.pages.length, 1);
  }
});

function transport(options = {}) {
  const h = fixture();
  const calls = [];
  const environment = { NODE_ENV: "production", HOME: process.env.HOME, PATH: process.env.PATH,
    PACKSCOUT_DATABASE_URL: "PRIVATE-DATABASE", PACKSCOUT_CATALOG_READ_TOKEN: "PRIVATE-TOKEN", NODE_OPTIONS: "PRIVATE-HOOK" };
  const dependencies = {
    async readUtf8() { return JSON.stringify({ version: options.version ?? "1.43.0" }); },
    async fetch(url, settings) { calls.push({ url, settings }); return new Response(options.instance ?? "shiny-newt-310"); },
    async run(file, args, settings) {
      calls.push({ file, args, settings });
      if (options.fail) throw new Error("PRIVATE-STDERR-TOKEN");
      assert.deepEqual(args.slice(1, -1), ["run", "--env-file", "/dev/null", "--deployment", "shiny-newt-310", "--codegen", "disable", "--inline-query"]);
      return { stdout: JSON.stringify(await h.evaluate(args.at(-1))) };
    },
  };
  return { calls, environment, dependencies };
}

test("named CLI transport exposes only inline read queries and filters all process secrets", async () => {
  const h = transport();
  assert.equal((await readClutchpacksProductionIdentityInventory(h.environment, h.dependencies)).publicCollectibleIds.length, 3);
  for (const call of h.calls.filter((entry) => entry.file)) {
    assert.equal(JSON.stringify(call).includes("PRIVATE"), false);
    assert.equal(call.settings.timeout, 45_000);
    assert.equal(call.settings.maxBuffer, 1_024 * 1_024);
  }
});

test("wrong selection, instance, CLI version and raw CLI errors refuse with sanitized diagnostics", async () => {
  for (const patch of [{ NODE_ENV: "development" }, { CONVEX_DEPLOYMENT: "prod:shiny-newt-310" },
    { CONVEX_DEPLOY_KEY: "PRIVATE" }, { CONVEX_URL: "http://127.0.0.1:3210" }]) {
    const h = transport();
    await assert.rejects(readClutchpacksProductionIdentityInventory({ ...h.environment, ...patch }, h.dependencies), safeFailure);
    assert.equal(h.calls.length, 0);
  }
  for (const options of [{ instance: "kindhearted-ermine-54" }, { instance: "x".repeat(257) }, { version: "1.44.0" }, { fail: true }]) {
    const h = transport(options);
    await assert.rejects(readClutchpacksProductionIdentityInventory(h.environment, h.dependencies), safeFailure);
    if (!options.fail) assert.equal(h.calls.filter((entry) => entry.file).length, 0);
  }
});
