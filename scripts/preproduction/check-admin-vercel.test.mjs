import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkAdminDeployment, validateDeploymentUrl } from "./check-admin-vercel.mjs";

const DEPLOYMENT = "https://packscout-admin-ab123cd45-pack-scout.vercel.app";
const SECRET = "never-print-this-bypass-secret";
const SHELL = '<!doctype html><html><head><title>Packscout Admin</title><script type="module" src="/assets/index-123.js"></script><link rel="stylesheet" href="/assets/index-456.css"></head><body><div id="root"></div></body></html>';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const html = (body = SHELL, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

function fixture(overrides = {}) {
  const calls = [];
  const routes = {
    "/operations": () => html(),
    "/assets/index-123.js": () => new Response("console.log('admin');", { headers: { "content-type": "application/javascript" } }),
    "/assets/index-456.css": () => new Response("body { color: black; }", { headers: { "content-type": "text/css" } }),
    "/api/health": () => json({ ok: true, service: "packscout-admin" }),
    "/api/auth/session": () => json({ error: "Sign in to continue.", code: "AUTH_REQUIRED" }, 401),
    "/api/provider-source-operations": () => json({ code: "AUTH_REQUIRED" }, 401),
    ...overrides,
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, DEPLOYMENT);
    return routes[new URL(url).pathname](url, options);
  };
  return { calls, run: (options = {}) => checkAdminDeployment({ deploymentUrl: DEPLOYMENT, fetchImpl, attempts: 1, ...options }) };
}

const rejectsCode = (promise, code) => assert.rejects(promise, { message: `ADMIN_VERCEL_${code}` });

test("healthy deployment proves shell, built assets, runtime health and anonymous auth boundaries using only GET", async () => {
  const fake = fixture();
  assert.deepEqual(await fake.run({ protectionBypass: SECRET }), { ok: true, readOnly: true, assetCount: 2, checkedRequests: 6 });
  assert.deepEqual(fake.calls.map(({ url }) => new URL(url).pathname), [
    "/operations", "/assets/index-123.js", "/assets/index-456.css",
    "/api/health", "/api/auth/session", "/api/provider-source-operations",
  ]);
  for (const { options } of fake.calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(options.headers, { "x-vercel-protection-bypass": SECRET });
    assert.equal(options.body, undefined);
  }
  const publicDeployment = fixture();
  await publicDeployment.run();
  assert.deepEqual(publicDeployment.calls[0].options.headers, {});
});

test("exact server startup 500 never passes and has only bounded cold-start retries", async () => {
  const fake = fixture({ "/operations": () => html(`${SECRET} FUNCTION_INVOCATION_FAILED`, 500) });
  await rejectsCode(fake.run({ attempts: 3, retryDelayMs: 1 }), "SERVER_ERROR");
  assert.equal(fake.calls.length, 3);
  let attempt = 0;
  const coldStart = fixture({ "/operations": () => ++attempt === 1 ? html("starting", 503) : html() });
  assert.equal((await coldStart.run({ attempts: 3, retryDelayMs: 1 })).ok, true);
  assert.equal(attempt, 2);
});

test("assets missing, empty, misserved or returned as HTML fail the runtime gate", async (t) => {
  for (const [name, response] of [
    ["missing", () => new Response("Not found", { status: 404 })],
    ["wrong type", () => new Response("console.log('loaded')", { headers: { "content-type": "text/plain" } })],
    ["HTML fallback", () => html()],
    ["HTML with JavaScript type", () => new Response(SHELL, { headers: { "content-type": "application/javascript" } })],
    ["empty", () => new Response(" \n", { headers: { "content-type": "application/javascript" } })],
  ]) {
    await t.test(name, () => rejectsCode(fixture({ "/assets/index-123.js": response }).run(), "ASSET_RESPONSE_INVALID"));
  }
  await rejectsCode(fixture({ "/operations": () => html(SHELL.replace(/<link[^>]*>/u, "")) }).run(), "ASSETS_MISSING");
  await rejectsCode(fixture({ "/operations": () => html(SHELL.replace('src="/assets/index-123.js"', 'data-src="/assets/index-123.js"')) }).run(), "ASSETS_MISSING");
  await rejectsCode(fixture({ "/operations": () => html(SHELL.replace('id="root"', 'data-id="root"')) }).run(), "SHELL_INVALID");
});

test("platform login redirects and HTML API login screens cannot be mistaken for a healthy build", async () => {
  await rejectsCode(fixture({ "/operations": () => new Response(null, { status: 307, headers: { location: `https://external.example/${SECRET}` } }) }).run(), "REDIRECT_REFUSED");
  await rejectsCode(fixture({ "/operations": () => html("<html><title>Log in to Vercel</title></html>") }).run(), "SHELL_INVALID");
  await rejectsCode(fixture({ "/api/auth/session": () => html(SHELL, 401) }).run(), "API_RESPONSE_INVALID");
  const redirected = html();
  Object.defineProperty(redirected, "redirected", { value: true });
  await rejectsCode(fixture({ "/operations": () => redirected }).run(), "REDIRECT_REFUSED");
});

test("health contract and both anonymous endpoint rejections must match exactly", async () => {
  for (const route of ["/api/auth/session", "/api/provider-source-operations"]) {
    await rejectsCode(fixture({ [route]: () => json({ code: "AUTH_REQUIRED" }) }).run(), "API_RESPONSE_INVALID");
    await rejectsCode(fixture({ [route]: () => json({ code: "FORBIDDEN" }, 401) }).run(), "API_CONTRACT_INVALID");
  }
  await rejectsCode(fixture({ "/api/health": () => json({ ok: true, service: "another-app" }) }).run(), "API_CONTRACT_INVALID");
  await rejectsCode(fixture({ "/api/health": () => json({ ok: false, service: "packscout-admin" }) }).run(), "API_CONTRACT_INVALID");
  await rejectsCode(fixture({ "/api/health": () => new Response("not-json", { headers: { "content-type": "application/json" } }) }).run(), "API_JSON_INVALID");
});

test("invalid origins never receive requests or the protection bypass", async () => {
  assert.equal(validateDeploymentUrl(`${DEPLOYMENT}/`), DEPLOYMENT);
  for (const deploymentUrl of [
    undefined, "", "https://packscout-admin.vercel.app", "https://packscout-admin-git-main-pack-scout.vercel.app",
    "https://external.example", DEPLOYMENT.replace("https:", "http:"), `${DEPLOYMENT}:443`,
    `${DEPLOYMENT}/operations`, `${DEPLOYMENT}?secret=${SECRET}`, `${DEPLOYMENT}#fragment`,
    DEPLOYMENT.replace("https://", `https://${SECRET}@`), `${DEPLOYMENT}.external.example`, `${DEPLOYMENT}\\external`,
  ]) {
    let calls = 0;
    await rejectsCode(checkAdminDeployment({ deploymentUrl, protectionBypass: SECRET, fetchImpl: async () => { calls += 1; } }), "TARGET_INVALID");
    assert.equal(calls, 0);
  }
});

test("external, redirected, traversal and query-bearing assets cannot receive the bypass", async () => {
  for (const reference of [
    "https://external.example/assets/app.js", "//external.example/assets/app.js",
    "/assets/../private.js", "/assets/nested/app.js", "/assets/app.js?query=1",
    "/assets/%2e%2e/app.js", "data:text/javascript,alert(1)",
  ]) {
    const fake = fixture({ "/operations": () => html(SHELL.replace("/assets/index-123.js", reference)) });
    await rejectsCode(fake.run({ protectionBypass: SECRET }), "ASSET_URL_INVALID");
    assert.equal(fake.calls.length, 1);
  }
  const fake = fixture({ "/assets/index-123.js": () => new Response(null, { status: 302, headers: { location: "https://external.example" } }) });
  await rejectsCode(fake.run({ protectionBypass: SECRET }), "REDIRECT_REFUSED");
  assert.equal(fake.calls.length, 2);
});

test("response limits include stalled fetches, stalled body reads and streamed bytes", async () => {
  for (const request of [
    () => new Promise(() => {}),
    () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/html" } }),
  ]) {
    const fake = fixture({ "/operations": request });
    const started = Date.now();
    await rejectsCode(fake.run({ totalTimeoutMs: 20, requestTimeoutMs: 10 }), "DEADLINE_EXCEEDED");
    assert.ok(Date.now() - started < 1_000);
    assert.equal(fake.calls[0].options.signal.aborted, true);
  }
  await rejectsCode(fixture().run({ maxBodyBytes: 20 }), "BODY_TOO_LARGE");
  await rejectsCode(fixture({ "/operations": () => new Response(SHELL, { headers: { "content-length": "99999999" } }) }).run(), "BODY_TOO_LARGE");
  const hugeAsset = fixture({ "/assets/index-123.js": () => new Response("x".repeat(1000), { headers: { "content-type": "application/javascript" } }) });
  await rejectsCode(hugeAsset.run({ maxBodyBytes: 500 }), "BODY_TOO_LARGE");
  const retried = fixture({ "/operations": () => html("still starting", 503) });
  await rejectsCode(retried.run({ attempts: 3, totalTimeoutMs: 5, retryDelayMs: 10 }), "DEADLINE_EXCEEDED");
  assert.equal(retried.calls.length, 1);
  for (const options of [{ requestTimeoutMs: 0 }, { totalTimeoutMs: 120_001 }, { maxBodyBytes: Infinity }, { attempts: 4 }, { retryDelayMs: -1 }]) {
    const invalid = fixture();
    await rejectsCode(invalid.run(options), "LIMIT_INVALID");
    assert.equal(invalid.calls.length, 0);
  }
});

test("network exceptions and CLI failure output never leak credentials, URLs or response bodies", async () => {
  const fake = fixture({ "/operations": () => { throw new Error(`request failed at ${DEPLOYMENT}?bypass=${SECRET}`); } });
  await rejectsCode(fake.run({ protectionBypass: SECRET }), "REQUEST_FAILED");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check-admin-vercel.mjs", import.meta.url))], {
    encoding: "utf8", env: { ...process.env, PACKSCOUT_ADMIN_DEPLOYMENT_URL: `https://external.example/${SECRET}`, VERCEL_AUTOMATION_BYPASS_SECRET: SECRET },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "ADMIN_VERCEL_TARGET_INVALID\n");
});
