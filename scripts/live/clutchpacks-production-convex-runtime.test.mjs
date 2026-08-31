import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { openClutchpacksProductionConvexRuntime } = await tsImport("./clutchpacks-production-convex-runtime.mts", import.meta.url);

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
  let completedReads = 0;
  const dependencies = {
    async readUtf8() { return JSON.stringify({ version: options.version ?? "1.43.0" }); },
    async run(file, args, settings) {
      calls.push({ file, args, settings: { ...settings, env: { ...settings.env } } });
      if (args[0] === "--import") {
        // Real existing backend graph validator, in a child with fixture secrets.
        return await promisify(execFile)(file, args, settings);
      }
      const name = args[3];
      await Promise.resolve();
      completedReads++;
      if (options.failRead === name) throw new Error(`${catalogToken}: private child stderr`);
      assert.deepEqual(args.slice(1), ["env", "get", name, "--env-file", "/dev/null", "--deployment", "shiny-newt-310"]);
      return { stdout: values[name] === undefined ? "" : `${values[name]}\n` };
    },
    async fetch(url, settings) {
      calls.push({ url: String(url), settings });
      if (String(url).endsWith("/instance_name")) return new Response(options.instance ?? "shiny-newt-310");
      if (options.fetch) return await options.fetch(url, settings);
      return Response.json({ status: "success", value: { ok: true }, logLines: [catalogToken] });
    },
  };
  return { values, environment, dependencies, calls, completedReads: () => completedReads,
    open: () => openClutchpacksProductionConvexRuntime(environment, dependencies) };
}
const safeFailure = (error) => error.message === "CLUTCHPACKS_PRODUCTION_CONVEX_RUNTIME_INVALID";

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

test("all private reads settle before a sanitized child failure is reported", async () => {
  const h = fixture({ failRead: "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS" });
  await assert.rejects(h.open(), safeFailure);
  assert.equal(h.completedReads(), 7);
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
