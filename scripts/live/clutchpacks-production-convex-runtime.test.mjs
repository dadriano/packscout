import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { openClutchpacksProductionConvexRuntime } = await tsImport("./clutchpacks-production-convex-runtime.mts", import.meta.url);
const { canonicalJson, publicCategorySchema, sha256CanonicalJson, productionReceiptHash,
  PRODUCTION_AUTH_HEADER_NAMES, productionPublicationReceiptSigningValue, productionPublicationRequestSigningValue } =
  await tsImport("@packscout/contracts", import.meta.url);
const { DATA_RELEASE_V3_BATCH_HASH_DOMAIN, DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN } =
  await tsImport("@packscout/services", import.meta.url);

const secret = (n) => Buffer.alloc(32, n).toString("base64");
const catalogToken = "private-catalog-runtime-fixture".repeat(2);
function fixture(options = {}) {
  const values = {
    PACKSCOUT_RUNTIME_ENVIRONMENT: "production",
    PACKSCOUT_CATALOG_READ_TOKEN: catalogToken,
    PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS: JSON.stringify({ "v3-v1": secret(1), "provider-v1": secret(2), "manifest-v1": secret(3), "heat-v1": secret(4) }),
    PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS: '["v3-v1"]',
    PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS: '{"provider-v1":"clutchpacks"}',
    PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES: '{"manifest-v1":["publish"]}',
    PACKSCOUT_HEAT_PUBLICATION_KEY_IDS: '["heat-v1"]',
    ...options.values,
  };
  const environment = { NODE_ENV: "production", PACKSCOUT_RUNTIME_ENVIRONMENT: "production",
    HOME: process.env.HOME, PATH: process.env.PATH, PACKSCOUT_DATABASE_URL: "private-database-fixture",
    NODE_OPTIONS: "private-hook-must-not-reach-child", PACKSCOUT_CATALOG_READ_TOKEN: "stale-operator-token" };
  const calls = [];
  let completedReads = 0, graphRuns = 0, instanceReads = 0;
  const readAttempts = new Map();
  const dependencies = {
    async readUtf8() { return JSON.stringify({ version: options.version ?? "1.43.0" }); },
    async run(file, args, settings) {
      calls.push({ file, args, settings: { ...settings, env: { ...settings.env } } });
      if (args[0] === "--import") {
        graphRuns++;
        if (graphRuns <= (options.graphFailures ?? 0)) throw new Error(`${catalogToken}: private graph stderr`);
        // Real existing backend graph validator, in a child with fixture secrets.
        return await promisify(execFile)(file, args, settings);
      }
      const name = args[3];
      const attempt = (readAttempts.get(name) ?? 0) + 1; readAttempts.set(name, attempt);
      await Promise.resolve();
      completedReads++;
      const failures = options.failRead === name ? Number.POSITIVE_INFINITY : (options.readFailures?.[name] ?? 0);
      if (attempt <= failures) throw new Error(`${catalogToken}: private child stderr`);
      assert.deepEqual(args.slice(1), ["env", "get", name, "--env-file", "/dev/null", "--deployment", "shiny-newt-310"]);
      const value = options.readValue?.(name, attempt, values) ?? values[name];
      return { stdout: value === undefined ? "" : `${value}\n` };
    },
    async fetch(url, settings) {
      calls.push({ url: String(url), settings });
      if (String(url).endsWith("/instance_name")) {
        instanceReads++;
        if (instanceReads <= (options.instanceFailures ?? 0)) throw new Error(`${catalogToken}: private instance failure`);
        return options.instanceResponse?.() ?? new Response(options.instance ?? "shiny-newt-310");
      }
      if (options.fetch) return await options.fetch(url, settings);
      return Response.json({ status: "success", value: { ok: true }, logLines: [catalogToken] });
    },
  };
  return { values, environment, dependencies, calls, completedReads: () => completedReads,
    graphRuns: () => graphRuns, instanceReads: () => instanceReads,
    open: () => openClutchpacksProductionConvexRuntime(environment, dependencies) };
}
const safeFailure = (error) => error.message === "CLUTCHPACKS_PRODUCTION_CONVEX_RUNTIME_INVALID";
const unavailableFailure = (error) => error.message === "CLUTCHPACKS_PRODUCTION_CONVEX_RUNTIME_UNAVAILABLE";

test("opening privately validates existing single V3 authority without publication or environment writes", async () => {
  const h = fixture();
  const before = process.env.PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS;
  const runtime = await h.open();
  try {
    assert.equal(runtime.publicClient.url, "https://shiny-newt-310.convex.cloud");
    assert.equal(runtime.catalogReadToken, catalogToken);
    assert.equal(h.completedReads(), 7);
    assert.equal(h.calls.filter((x) => x.url && !x.url.endsWith("/instance_name")).length, 0);
    assert.equal(process.env.PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS, before);
    for (const call of h.calls.filter((x) => x.file)) {
      assert.equal(call.args.join(" ").includes(secret(1)), false);
      assert.equal(call.args.join(" ").includes(catalogToken), false);
      assert.equal(call.settings.env.PACKSCOUT_DATABASE_URL, undefined);
      assert.equal(call.settings.env.PACKSCOUT_CATALOG_READ_TOKEN, undefined);
      assert.equal(call.settings.env.NODE_OPTIONS, undefined);
    }
    const validation = h.calls.find((x) => x.args?.[0] === "--import");
    assert.equal(validation.settings.env.PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS, h.values.PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS);
  } finally { runtime.close(); }
});

test("development targets, process selectors, version drift and wrong instances refuse before secret reads", async () => {
  for (const patch of [{ NODE_ENV: "development" }, { PACKSCOUT_RUNTIME_ENVIRONMENT: "local" },
    { CONVEX_DEPLOYMENT: "prod:shiny-newt-310" }, { CONVEX_DEPLOY_KEY: "private-key" },
    { CONVEX_OVERRIDE_ACCESS_TOKEN: "private-token" }, { CONVEX_SELF_HOSTED_ADMIN_KEY: "private-key" },
    { CONVEX_URL: "https://kindhearted-ermine-54.convex.cloud" },
    { PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://kindhearted-ermine-54.convex.site" }]) {
    const h = fixture(); Object.assign(h.environment, patch);
    await assert.rejects(h.open(), safeFailure);
    assert.equal(h.completedReads(), 0);
  }
  for (const options of [{ instance: "kindhearted-ermine-54" }, { version: "1.44.0" }]) {
    const h = fixture(options); await assert.rejects(h.open(), safeFailure);
    assert.equal(h.completedReads(), 0);
  }
});

test("remote production marker and catalog credential must be exact", async () => {
  for (const values of [{ PACKSCOUT_RUNTIME_ENVIRONMENT: "preproduction" },
    { PACKSCOUT_RUNTIME_ENVIRONMENT: undefined }, { PACKSCOUT_RUNTIME_ENVIRONMENT: "production " },
    { PACKSCOUT_CATALOG_READ_TOKEN: undefined }, { PACKSCOUT_CATALOG_READ_TOKEN: "short" }]) {
    const h = fixture({ values }); await assert.rejects(h.open(), safeFailure);
    assert.equal(h.calls.some((x) => x.args?.[0] === "--import"), false);
  }
});

test("actual canonical validator rejects missing, malformed, mixed or ambiguous authority graphs", async () => {
  const poisonedMaps = [
    { PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS: undefined },
    { PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS: '["v3-v1", "v3-v2"]' },
    { PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS: '["missing-v1"]' },
    { PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS: '{"v3-v1":"clutchpacks"}' },
    { PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES: '{"v3-v1":["publish"]}' },
    { PACKSCOUT_HEAT_PUBLICATION_KEY_IDS: '["v3-v1"]' },
    { PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS: '{"v3-v1":"bad-base64"}' },
  ];
  for (const values of poisonedMaps) {
    const h = fixture({ values }); await assert.rejects(h.open(), safeFailure);
  }
  for (const patch of [{ "unbound-v1": secret(1) }, { "v3-v2": secret(5) }]) {
    const h = fixture();
    h.values.PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS = JSON.stringify({ ...JSON.parse(h.values.PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS), ...patch });
    if (patch["v3-v2"]) h.values.PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS = '["v3-v1","v3-v2"]';
    await assert.rejects(h.open(), safeFailure);
  }
});

test("optional Heat absence remains valid for the distinct existing V3 surface", async () => {
  const h = fixture({ values: { PACKSCOUT_HEAT_PUBLICATION_KEY_IDS: undefined } });
  const runtime = await h.open(); runtime.close();
});

test("all private reads settle in both snapshots before sanitized unavailability is reported", async () => {
  const h = fixture({ failRead: "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS" });
  await assert.rejects(h.open(), unavailableFailure);
  assert.equal(h.completedReads(), 14);
});

test("opening retries each read-only availability boundary once", async () => {
  const instance = fixture({ instanceFailures: 1 });
  (await instance.open()).close();
  assert.equal(instance.instanceReads(), 3);
  assert.equal(instance.completedReads(), 7);

  const environment = fixture({ readFailures: { PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS: 1 } });
  (await environment.open()).close();
  assert.equal(environment.completedReads(), 14);
  assert.equal(environment.graphRuns(), 1);

  const graph = fixture({ graphFailures: 1 });
  (await graph.open()).close();
  assert.equal(graph.completedReads(), 7);
  assert.equal(graph.graphRuns(), 2);
});

test("opening reports unavailable only after its single bounded retry is exhausted", async () => {
  const instance = fixture({ instanceFailures: 2 });
  await assert.rejects(instance.open(), unavailableFailure);
  assert.equal(instance.instanceReads(), 2);
  assert.equal(instance.completedReads(), 0);

  const graph = fixture({ graphFailures: 2 });
  await assert.rejects(graph.open(), unavailableFailure);
  assert.equal(graph.graphRuns(), 2);
  assert.equal(graph.instanceReads(), 1);
});

test("integrity mismatches are invalid and never retried", async () => {
  for (const options of [{ instance: "kindhearted-ermine-54" },
    { instanceResponse: () => new Response("unavailable", { status: 503 }) }]) {
    const h = fixture(options);
    await assert.rejects(h.open(), safeFailure);
    assert.equal(h.instanceReads(), 1);
    assert.equal(h.completedReads(), 0);
  }

  const changed = fixture({
    readFailures: { PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS: 1 },
    readValue: (name, attempt, values) => name === "PACKSCOUT_RUNTIME_ENVIRONMENT" && attempt === 2
      ? "preproduction"
      : values[name],
  });
  await assert.rejects(changed.open(), safeFailure);
  assert.equal(changed.completedReads(), 14);
  assert.equal(changed.graphRuns(), 0);

  const invalidGraph = fixture({ values: { PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS: '["missing-v1"]' } });
  await assert.rejects(invalidGraph.open(), safeFailure);
  assert.equal(invalidGraph.graphRuns(), 1);
});

test("public client omits admin authority and secret diagnostics, and refuses mutation transport", async () => {
  const h = fixture();
  const runtime = await h.open();
  try {
    assert.deepEqual(await runtime.publicClient.action("publicRepacksV3:getPublicShellStatusV3", { catalogReadToken: catalogToken }), { ok: true });
    const api = h.calls.find((x) => x.url?.endsWith("/api/action"));
    assert.equal(api.settings.headers.Authorization, undefined);
    assert.equal(api.settings.redirect, "error");
    const before = h.calls.length;
    await assert.rejects(runtime.publicClient.mutation("anything:mutate", {}), safeFailure);
    assert.equal(h.calls.length, before);
  } finally { runtime.close(); }
});

test("server error messages never escape through public Convex client exceptions", async () => {
  for (const response of [() => new Response(catalogToken, { status: 500 }),
    () => Response.json({ status: "error", errorMessage: catalogToken }),
    () => new Response("x".repeat(4 * 1_024 * 1_024 + 1))]) {
    const h = fixture({ fetch: async () => response() });
    const runtime = await h.open();
    try { await assert.rejects(runtime.publicClient.query("publicRepacksV3:searchPublicCollectiblesV3", {}), safeFailure); }
    finally { runtime.close(); }
  }
});

test("close is idempotent and blocks further public and signed HTTP requests", async () => {
  const h = fixture();
  const runtime = await h.open();
  runtime.close(); runtime.close();
  const before = h.calls.length;
  await assert.rejects(runtime.publicClient.query("publicRepacksV3:searchPublicCollectiblesV3", {}), safeFailure);
  await assert.rejects(runtime.publication.activeState());
  assert.equal(h.calls.length, before);
});

test("close aborts an already in-flight public request", async () => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const h = fixture({ fetch: async (_url, settings) => {
    entered();
    return await new Promise((_resolve, reject) => {
      settings.signal.addEventListener("abort", () => reject(new Error(catalogToken)), { once: true });
    });
  } });
  const runtime = await h.open();
  const request = runtime.publicClient.query("publicRepacksV3:searchPublicCollectiblesV3", {});
  await started; runtime.close();
  await assert.rejects(request, safeFailure);
});

async function delayedSignedBatchFixture(responseMilliseconds) {
  const publicReleaseId = "90000000-0000-4000-8000-000000000001";
  const categoryId = "90000000-0000-5000-8000-000000000002";
  const records = [publicCategorySchema.parse({ publicCategoryId: categoryId, parentPublicCategoryId: null,
    categoryKey: "cards", name: "Cards", kind: "vertical", depth: 0, pathPublicCategoryIds: [categoryId], displayOrder: 0 })];
  const request = { schemaVersion: "data_release_v3", operationId: `${publicReleaseId}:batch:0`,
    idempotencyKey: `${publicReleaseId}:batch:0`, publicReleaseId, batchIndex: 0, kind: "categories", records,
    batchHash: await sha256CanonicalJson(DATA_RELEASE_V3_BATCH_HASH_DOMAIN, { kind: "categories", records }) };
  const bodyJson = canonicalJson(request);
  const bodyDigest = createHash("sha256").update(bodyJson).digest("hex");
  const body = { schemaVersion: "data_release_v3", operationKind: "applyBatch", operationId: request.operationId,
    idempotencyKey: request.idempotencyKey, publicReleaseId, result: "accepted", serverTime: new Date().toISOString(),
    requestDigest: bodyDigest, details: { batchIndex: 0, kind: "categories", recordCount: 1, acceptedBatchChainHash: "a".repeat(64) } };
  const receipt = { ...body, receiptDigest: await sha256CanonicalJson(DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN, body) };
  const receiptDigest = await productionReceiptHash(receipt);
  const envelope = { ok: true, receipt, responseAuth: { signatureVersion: "v1", keyId: "v3-v1", receiptDigest,
    signature: createHmac("sha256", Buffer.from(secret(1), "base64"))
      .update(productionPublicationReceiptSigningValue(receiptDigest)).digest("hex") } };
  let entered; const arrived = new Promise(resolve => { entered = resolve; });
  let requests = 0;
  const h = fixture({ fetch: async (url, settings) => {
    requests++; entered(settings.signal);
    assert.equal(new URL(url).origin, "https://shiny-newt-310.convex.site");
    assert.equal(settings.redirect, "error"); assert.equal(settings.credentials, "omit");
    assert.equal(settings.body, bodyJson);
    const headers = new Headers(settings.headers);
    assert.equal(headers.get(PRODUCTION_AUTH_HEADER_NAMES.keyId), "v3-v1");
    assert.equal(headers.get(PRODUCTION_AUTH_HEADER_NAMES.signature), createHmac("sha256", Buffer.from(secret(1), "base64"))
      .update(productionPublicationRequestSigningValue({ method: "POST", path: new URL(url).pathname, bodyDigest,
        timestamp: headers.get(PRODUCTION_AUTH_HEADER_NAMES.timestamp), nonce: headers.get(PRODUCTION_AUTH_HEADER_NAMES.nonce) })).digest("hex"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { settings.signal.removeEventListener("abort", abort); resolve(Response.json(envelope)); }, responseMilliseconds);
      const abort = () => { clearTimeout(timer); reject(new Error(catalogToken)); };
      if (settings.signal.aborted) abort(); else settings.signal.addEventListener("abort", abort, { once: true });
    });
  } });
  return { ...h, request, receipt, arrived, requests: () => requests };
}
async function advance(t, milliseconds) {
  t.mock.timers.tick(milliseconds);
  await new Promise(resolve => setImmediate(resolve));
}
const outcomeOf = request => request.then(value => ({ value }), error => ({ error }));

// Given a valid signed publication response, transport latency may exceed the
// shared client's default. The production override remains bounded and cancellable.
test("production publication accepts a signed 13.239-second batch response without retrying", async t => {
  const h = await delayedSignedBatchFixture(13_239), runtime = await h.open();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let outcome;
  try {
    let settled = false;
    outcome = outcomeOf(runtime.publication.applyBatch(h.request)).then(value => { settled = true; return value; });
    const signal = await h.arrived;
    await advance(t, 10_001);
    assert.equal(signal.aborted, false); assert.equal(settled, false);
    await advance(t, 3_238);
    assert.deepEqual((await outcome).value, h.receipt);
    assert.equal(signal.aborted, false); assert.equal(h.requests(), 1);
  } finally { runtime.close(); await outcome; t.mock.timers.reset(); }
});

test("production publication aborts at 30 seconds and leaves the uncertain request unretried", async t => {
  const h = await delayedSignedBatchFixture(30_001), runtime = await h.open();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let outcome;
  try {
    let settled = false;
    outcome = outcomeOf(runtime.publication.applyBatch(h.request)).then(value => { settled = true; return value; });
    const signal = await h.arrived;
    await advance(t, 29_999);
    assert.equal(signal.aborted, false); assert.equal(settled, false);
    await advance(t, 1);
    const result = await outcome;
    assert.equal(result.error?.code, "PUBLICATION_TIMEOUT"); assert.equal(result.value, undefined);
    assert.equal(result.error.message.includes(catalogToken), false); assert.equal(signal.aborted, true);
    await advance(t, 60_000); assert.equal(h.requests(), 1);
  } finally { runtime.close(); await outcome; t.mock.timers.reset(); }
});

for (const cancel of ["caller", "close"]) {
  test(`${cancel} cancellation still aborts a signed publication before its 30-second timeout`, async t => {
    const h = await delayedSignedBatchFixture(13_239), runtime = await h.open(), controller = new AbortController();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let outcome;
    try {
      outcome = outcomeOf(runtime.publication.applyBatch(h.request, controller.signal));
      const signal = await h.arrived;
      await advance(t, 5_000);
      if (cancel === "caller") controller.abort(); else runtime.close();
      const result = await outcome;
      assert.equal(signal.aborted, true); assert.equal(result.value, undefined);
      assert.equal(result.error?.code, cancel === "caller" ? "PUBLICATION_CANCELLED" : "PUBLICATION_NETWORK_ERROR");
      assert.equal(result.error.message.includes(catalogToken), false);
      await advance(t, 60_000); assert.equal(h.requests(), 1);
    } finally { runtime.close(); await outcome; t.mock.timers.reset(); }
  });
}
