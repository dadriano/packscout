import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { initializeProductionEv, createProductionEvInitializationPort,
  EV_INITIALIZATION_TARGET, EV_INITIALIZATION_URL } = await tsImport("./clutchpacks-production-ev-initialization.mts", import.meta.url);
const { buildPublicRepackListPageV3 } = await tsImport(
  "../../packages/contracts/src/__fixtures__/data-release-v3.fixture.ts", import.meta.url);

// Acceptance: inspect/check make no writes; explicit apply preserves immutable
// catalog pointers; drift, staging, wrong targets and secret-bearing failures
// stop safely; committed backfill pages remain resumable after lost replies.
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pointer = (n) => ({ publicReleaseId: id(n), releaseFingerprint: String(n).repeat(64),
  completedAt: "2026-08-30T00:00:00.000Z", counts: { repacks: 17 } });
function fixture(options = {}) {
  const state = { expectedGeneration: 2, expectedActivePublicReleaseId: id(2),
    expectedPreviousPublicReleaseId: id(1), activeRelease: pointer(2), previousRelease: pointer(1), initialized: false };
  const publication = { generation: 2, activeRelease: state.activeRelease, previousRelease: state.previousRelease,
    terminalOperation: { operationId: "activate-test-v1", kind: "activate", status: "completed", result: "activated",
      publicReleaseId: id(2), receiptDigest: "a".repeat(64),
      receiptDetails: { generation: 2, activeRelease: state.activeRelease, previousRelease: state.previousRelease } },
    catalog: { generation: 1, activeManifest: { publicReleaseId: id(3) } }, catalogCoherent: true, stagingReleasePresent: false };
  const statuses = new Map([1, 2].map((n) => [id(n), { publicReleaseId: id(n), count: 0, nextCursor: null, complete: false }]));
  const calls = [];
  const port = {
    async inspectPublication() { calls.push({ operation: "inspect" }); return structuredClone(publication); },
    async verifyPublicRead(publicReleaseId) {
      calls.push({ operation: "public" }); assert.equal(publicReleaseId, id(2));
      await options.publicRead?.(state, publication);
    },
    async call(operation, args) {
      calls.push({ operation, args: structuredClone(args) });
      if (operation === "state") return structuredClone(state);
      const status = statuses.get(args.publicReleaseId);
      assert.ok(status);
      if (operation === "progress") return { ...status, expectedGeneration: state.expectedGeneration,
        expectedActivePublicReleaseId: state.expectedActivePublicReleaseId, expectedPreviousPublicReleaseId: state.expectedPreviousPublicReleaseId };
      assert.equal(args.expectedGeneration, 2);
      assert.equal(args.expectedActivePublicReleaseId, id(2));
      assert.equal(args.expectedPreviousPublicReleaseId, id(1));
      if (operation === "page") {
        assert.equal(args.afterPublicRepackId, status.nextCursor);
        Object.assign(status, { count: 17, nextCursor: id(17), complete: true });
        await options.afterPage?.(state, publication, args);
      } else {
        assert.equal(operation, "initialize");
        assert.ok([...statuses.values()].every((x) => x.complete));
        state.initialized = !options.noInitialization;
      }
      return structuredClone(status);
    },
  };
  return { state, publication, statuses, calls, port,
    writes: () => calls.filter(({ operation }) => ["page", "initialize"].includes(operation)) };
}
const manifest = async (h) => (await initializeProductionEv(h.port, { mode: "inspect" })).manifest;

test("inspection produces exact public target pins and check-only never backfills", async () => {
  const h = fixture();
  const pins = await manifest(h);
  assert.equal(pins.deployment, "shiny-newt-310");
  assert.equal(pins.expectedActiveReleaseFingerprint, "2".repeat(64));
  assert.equal((await initializeProductionEv(h.port, { mode: "check-only", manifest: pins })).status, "migration_required");
  assert.equal(h.writes().length, 0);
});

test("explicit apply backfills previous then active and preserves catalog proofs", async () => {
  const h = fixture();
  const before = structuredClone(h.publication);
  const pins = await manifest(h);
  assert.equal((await initializeProductionEv(h.port, { mode: "apply", manifest: pins })).status, "ready");
  assert.deepEqual(h.writes().map(({ operation, args }) => [operation, args.publicReleaseId]),
    [["page", id(1)], ["page", id(2)], ["initialize", id(2)]]);
  assert.deepEqual(h.publication, before);
  const writes = h.writes().length;
  assert.equal((await initializeProductionEv(h.port, { mode: "apply", manifest: pins })).status, "ready");
  assert.equal(h.writes().length, writes);
});

test("wrong manifest targets, fingerprints, generations and extra properties fail before writes", async () => {
  for (const patch of [{ deployment: "kindhearted-ermine-54" }, { convexUrl: "http://127.0.0.1:3210" },
    { expectedGeneration: 3 }, { expectedActiveReleaseFingerprint: "0".repeat(64) },
    { expectedPreviousPublicReleaseId: null }, { immutableCatalogProofSha256: "0".repeat(64) },
    { unexpectedCredential: "must-not-be-accepted" }]) {
    const h = fixture();
    const pins = await manifest(h);
    await assert.rejects(initializeProductionEv(h.port, { mode: "apply", manifest: { ...pins, ...patch } }));
    assert.equal(h.writes().length, 0);
  }
});

test("staged releases, incoherent manifests and ambiguous rollback ancestry refuse preflight", async () => {
  for (const mutate of [(x) => { x.stagingReleasePresent = true; },
    (x) => { x.catalogCoherent = false; }, (x) => { x.terminalOperation.kind = "rollback"; },
    (x) => { x.terminalOperation.receiptDetails.generation = 3; }]) {
    const h = fixture();
    mutate(h.publication);
    await assert.rejects(manifest(h), /PUBLICATION_CONFLICT/u);
    assert.equal(h.writes().length, 0);
  }
});

test("catalog drift after a page prevents subsequent mutation and never adopts new pins", async () => {
  const h = fixture({ afterPage(_state, publication) { publication.catalog.generation++; } });
  const pins = await manifest(h);
  await assert.rejects(initializeProductionEv(h.port, { mode: "apply", manifest: pins }), /MANIFEST_CHANGED/u);
  assert.equal(h.writes().length, 1);
  assert.equal(h.state.initialized, false);
});

test("a committed page with lost acknowledgement resumes from progress with unchanged pins", async () => {
  let loseReply = true;
  const h = fixture({ afterPage() { if (loseReply) { loseReply = false; throw new Error("lost reply"); } } });
  const pins = await manifest(h);
  await assert.rejects(initializeProductionEv(h.port, { mode: "apply", manifest: pins }), /lost reply/u);
  assert.equal(h.statuses.get(id(1)).complete, true);
  assert.equal((await initializeProductionEv(h.port, { mode: "apply", manifest: pins })).status, "ready");
  assert.equal(h.writes().filter(({ operation, args }) => operation === "page" && args.publicReleaseId === id(1)).length, 1);
});

test("sealed facts do not count as ready without initialization", async () => {
  const h = fixture({ noInitialization: true });
  await assert.rejects(initializeProductionEv(h.port, { mode: "apply", manifest: await manifest(h) }), /MIGRATION_REQUIRED/u);
});

function transportFixture(options = {}) {
  const calls = [];
  const environment = { NODE_ENV: "production", PACKSCOUT_CATALOG_READ_TOKEN: "private-catalog-fixture-token".repeat(2) };
  const dependencies = {
    async readUtf8() { return JSON.stringify({ version: options.version ?? "1.43.0" }); },
    async run(file, args, settings) {
      calls.push({ file, args, settings });
      if (options.failRun) throw new Error(environment.PACKSCOUT_CATALOG_READ_TOKEN);
      return { stdout: "{}" };
    },
    async fetch(url, settings) {
      calls.push({ url, settings });
      return new Response(options.instance ?? EV_INITIALIZATION_TARGET);
    },
  };
  return { calls, environment, dependencies };
}

test("production transport pins installed CLI, named target and empty env file without secret argv", async () => {
  const h = transportFixture();
  const port = await createProductionEvInitializationPort(h.environment, h.dependencies);
  await port.call("state", {});
  const cli = h.calls.find((x) => x.file);
  assert.deepEqual(cli.args.slice(1), ["run", "--env-file", "/dev/null", "--deployment", "shiny-newt-310",
    "--codegen", "disable", "dataReleaseV3EvMigrationState:migrationState", "{}"]);
  assert.equal(cli.settings.env.PACKSCOUT_CATALOG_READ_TOKEN, undefined);
  assert.equal(JSON.stringify(cli).includes(h.environment.PACKSCOUT_CATALOG_READ_TOKEN), false);
  assert.equal(h.calls[0].url, `${EV_INITIALIZATION_URL}/instance_name`);
  assert.equal(h.calls[0].settings.redirect, "error");
  assert.equal(cli.settings.timeout, 45_000);
  assert.equal(cli.settings.maxBuffer, 262_144);
});

test("remote overrides, nonproduction runtime, missing credential and changed CLI fail before calls", async () => {
  for (const patch of [{ NODE_ENV: "development" }, { PACKSCOUT_CATALOG_READ_TOKEN: "" },
    { CONVEX_DEPLOYMENT: "prod:shiny-newt-310" }, { CONVEX_DEPLOY_KEY: "private-key" },
    { CONVEX_SELF_HOSTED_URL: EV_INITIALIZATION_URL }, { CONVEX_OVERRIDE_ACCESS_TOKEN: "private-token" },
    { CONVEX_URL: "https://kindhearted-ermine-54.convex.cloud" }]) {
    const h = transportFixture();
    await assert.rejects(createProductionEvInitializationPort({ ...h.environment, ...patch }, h.dependencies));
    assert.equal(h.calls.length, 0);
  }
  const h = transportFixture({ version: "1.42.0" });
  await assert.rejects(createProductionEvInitializationPort(h.environment, h.dependencies), /CLI_VERSION_INVALID/u);
  assert.equal(h.calls.length, 0);
});

test("instance mismatch prevents CLI invocation and transport errors do not disclose credentials", async () => {
  for (const options of [{ instance: "kindhearted-ermine-54" }, { failRun: true }]) {
    const h = transportFixture(options);
    const port = await createProductionEvInitializationPort(h.environment, h.dependencies);
    await assert.rejects(port.call("state", {}), (error) =>
      error.message === "PRODUCTION_EV_INITIALIZATION_REQUEST_FAILED" &&
      !error.message.includes(h.environment.PACKSCOUT_CATALOG_READ_TOKEN));
    if (options.instance) assert.equal(h.calls.filter((x) => x.file).length, 0);
  }
});

function publicPage() {
  const page = buildPublicRepackListPageV3();
  const pack = (value, n) => {
    const publicRepackId = id(n + 10).replace("-4000-", "-5000-");
    return { ...value, publicRepackId, vendorKey: "clutchpacks",
      topChase: { ...value.topChase, publicRepackId } };
  };
  return { ...page, release: { ...page.release, publicReleaseId: id(2) },
    rows: Array.from({ length: 17 }, (_, n) => pack(page.rows[0], n)),
    details: Array.from({ length: 17 }, (_, n) => pack(page.details[0], n)),
    selectedRepack: null, selectedRepackEligible: false,
    facets: { vendors: [], categories: [], collectibleTypes: [] },
    activeQuery: { search: "", filters: { vendors: [], categories: [], collectibleTypes: [],
      price: { mode: "full", minMinor: 1_000, maxMinor: 1_200_000 }, availability: "all" },
      sort: "packscout_ev_dollars", direction: "desc", pageSize: 50, desiredPublicCollectibleId: null },
    queryFingerprint: "a".repeat(64), nextCursor: null, hasPrevious: false,
    range: { start: 1, end: 17, total: 17 }, paginationReset: null,
  };
}

test("public readback validates all17 contract pairs and carries catalog credentials only in HTTP body", async () => {
  const h = transportFixture();
  let body;
  h.dependencies.fetch = async (url, settings) => {
    if (url.endsWith("/instance_name")) return new Response(EV_INITIALIZATION_TARGET);
    body = JSON.parse(settings.body);
    return Response.json({ status: "success", value: { ok: true, data: publicPage() } });
  };
  await (await createProductionEvInitializationPort(h.environment, h.dependencies)).verifyPublicRead(id(2));
  assert.equal(body.path, "publicRepacksV3:listPublicRepacksV3");
  assert.equal(body.args.catalogReadToken, h.environment.PACKSCOUT_CATALOG_READ_TOKEN);
  assert.equal(h.calls.filter((x) => x.file).length, 0);
});

test("wrong release, incomplete catalog, unsafe envelopes and inconsistent raw/display details refuse readback", async () => {
  for (const mutate of [(p) => { p.release.publicReleaseId = id(9); },
    (p) => { p.range.total = 18; }, (p) => { p.rows[0].publicRepackId = id(90); },
    (p) => { p.details[0].name = "tampered-detail"; },
    (p) => { p.publicFreshnessPolicyVersion = "obsolete-policy"; }]) {
    const h = transportFixture();
    h.dependencies.fetch = async (url) => {
      if (url.endsWith("/instance_name")) return new Response(EV_INITIALIZATION_TARGET);
      const page = publicPage(); mutate(page);
      return Response.json({ status: "success", value: { ok: true, data: page } });
    };
    await assert.rejects((await createProductionEvInitializationPort(h.environment, h.dependencies)).verifyPublicRead(id(2)),
      /PUBLIC_READ_FAILED/u);
  }
});
