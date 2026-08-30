import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { createLocalConvexEvMigrationClient } = await tsImport("./local-convex-ev-migration-client.mts", import.meta.url);
const { migrateLocalConvexEv, withLocalConvexEvReady } = await tsImport("./local-convex-ev-migration.mts", import.meta.url);

const deploymentName = "local-migration-test";
const adminKey = "fixture-local-admin-key";
const releaseId = "00000000-0000-4000-8000-000000000001";
const pointer = { publicReleaseId: releaseId, releaseFingerprint: "a".repeat(64),
  completedAt: "2026-08-30T00:00:00.000Z", counts: { repacks: 1 } };
const legacyState = { expectedGeneration: 1, expectedActivePublicReleaseId: releaseId,
  expectedPreviousPublicReleaseId: null, activeRelease: pointer, previousRelease: null, initialized: false };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "packscout-ev-client-"));
  const projectDirectory = path.join(directory, "project");
  const homeDirectory = path.join(directory, "home");
  const configFile = path.join(projectDirectory, ".convex", "local", "default", "config.json");
  await mkdir(path.dirname(configFile), { recursive: true });
  const calls = [];
  let instance = options.instance ?? deploymentName;
  let respond = options.respond ?? ((body) => body.path.endsWith(":migrationState") ? legacyState : {});
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text === "" ? null : JSON.parse(text);
    calls.push({ url: request.url, method: request.method, headers: request.headers, body });
    if (options.handle?.(request, response, body)) return;
    if (request.url === "/instance_name") { response.end(instance); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "success", value: respond(body), logLines: ["do-not-log-this"] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const saved = { ports: { cloud: port, site: port }, deploymentName, adminKey, backendVersion: "fixture" };
  await writeFile(configFile, JSON.stringify(saved));
  const configuration = { publicUrl: `http://127.0.0.1:${port}`, childEnvironment: {
    CONVEX_DEPLOYMENT: `local:${deploymentName}`, CONVEX_URL: `http://127.0.0.1:${port}` } };
  const dependencies = { projectDirectory, homeDirectory };
  const close = async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  };
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  return { calls, configuration, dependencies, configFile, saved, projectDirectory, homeDirectory,
    close, setInstance: (value) => { instance = value; }, setRespond: (value) => { respond = value; },
    client: (extra = {}) => createLocalConvexEvMigrationClient(configuration, { ...dependencies, ...extra }) };
}

test("direct HTTP calls pin the instance, wire format, authority and four operation kinds", async (t) => {
  const h = await fixture(t);
  const client = await h.client();
  for (const operation of ["state", "progress", "page", "initialize"]) await client.call(operation, { publicReleaseId: releaseId });
  const posts = h.calls.filter(({ method }) => method === "POST");
  assert.deepEqual(posts.map(({ url }) => url), ["/api/query", "/api/query", "/api/mutation", "/api/mutation"]);
  assert.deepEqual(posts.map(({ body }) => body.path), ["dataReleaseV3EvMigrationState:migrationState",
    "dataReleaseV3EvFactsBackfill:progress", "dataReleaseV3EvFactsBackfill:backfillActiveReleaseEvFacts",
    "dataReleaseV3EvFactsBackfill:initializeActiveRetention"]);
  for (const { body, headers } of posts) {
    assert.equal(headers.authorization, `Convex ${adminKey}`);
    assert.deepEqual(body.args, [{ publicReleaseId: releaseId }]);
    assert.equal(body.format, "convex_encoded_json");
  }
  assert.equal(h.calls.filter(({ url }) => url === "/instance_name").length, 5);
  assert.ok(h.calls.filter(({ method }) => method === "GET").every(({ headers }) => headers.authorization === undefined));
  const count = h.calls.length;
  await assert.rejects(client.call("deleteEverything", {}), /REQUEST_FAILED/u);
  assert.equal(h.calls.length, count);
});

test("public readback uses the pinned endpoint and catalog token without admin authority", async (t) => {
  const h = await fixture(t, { respond: () => ({ ok: true, data: { release: { publicReleaseId: releaseId } } }) });
  const token = "fixture-catalog-read-token-".repeat(2);
  h.configuration.childEnvironment.PACKSCOUT_CATALOG_READ_TOKEN = token;
  await (await h.client()).verifyPublicRead(releaseId);
  const request = h.calls.at(-1);
  assert.equal(request.url, "/api/query");
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.body.path, "publicRepacksV3:listPublicRepacksV3");
  assert.equal(request.body.args[0].catalogReadToken, token);
  assert.equal(request.body.args[0].pageSize, 1);
  h.setRespond(() => ({ ok: true, data: { release: { publicReleaseId: "wrong" } } }));
  await assert.rejects((await h.client()).verifyPublicRead(releaseId), /READBACK_FAILED/u);
});

test("poisoned dotenv files cannot alter deployment selection or become credentials", async (t) => {
  const h = await fixture(t);
  await writeFile(path.join(h.projectDirectory, ".env"), "CONVEX_DEPLOY_KEY=poisoned-cloud-key\n");
  await writeFile(path.join(h.projectDirectory, ".env.local"), "CONVEX_DEPLOYMENT_TOKEN=poisoned-cloud-token\n");
  const reads = [];
  const client = await h.client({ readUtf8: async (file) => { reads.push(file); return readFile(file, "utf8"); } });
  await client.call("state", {});
  assert.deepEqual(reads, [h.configFile]);
  assert.equal(h.calls.at(-1).headers.authorization, `Convex ${adminKey}`);
});

test("unsafe environment selections fail before reading configuration or making requests", async (t) => {
  const h = await fixture(t);
  for (const patch of [{ CONVEX_DEPLOYMENT: "prod:production" }, { CONVEX_DEPLOYMENT: "local:../other" },
    { CONVEX_DEPLOY_KEY: "secret" }, { CONVEX_DEPLOYMENT_TOKEN: "secret" },
    { CONVEX_SELF_HOSTED_URL: h.configuration.publicUrl }, { CONVEX_SELF_HOSTED_ADMIN_KEY: "secret" },
    { CONVEX_URL: "https://remote.convex.cloud" }, { NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:1" }]) {
    await assert.rejects(createLocalConvexEvMigrationClient({ ...h.configuration,
      childEnvironment: { ...h.configuration.childEnvironment, ...patch } }, {
      ...h.dependencies, readUtf8: async () => assert.fail("must not read") }), /LOCAL_TARGET_INVALID/u);
  }
  assert.equal(h.calls.length, 0);
});

test("saved port or project deployment mismatch refuses before the first instance request", async (t) => {
  const h = await fixture(t);
  for (const saved of [{ ...h.saved, ports: { cloud: 1 } }, { ...h.saved, deploymentName: "other" },
    { ...h.saved, deploymentName: undefined }, { ...h.saved, adminKey: "key\nInjected: header" }]) {
    await writeFile(h.configFile, JSON.stringify(saved));
    await assert.rejects(h.client(), /LOCAL_TARGET_INVALID/u);
  }
  assert.equal(h.calls.length, 0);
});

test("mismatched or malformed project configuration never falls back to a home deployment", async (t) => {
  const h = await fixture(t);
  for (const content of [JSON.stringify({ ...h.saved, deploymentName: "other" }), "not JSON"]) {
    const reads = [];
    await assert.rejects(h.client({ readUtf8: async (file) => { reads.push(file); return content; } }), /LOCAL_TARGET_INVALID/u);
    assert.deepEqual(reads, [h.configFile]);
  }
  assert.equal(h.calls.length, 0);
});

test("only a missing project config permits the exact local or anonymous home config", async (t) => {
  const h = await fixture(t);
  await rm(h.configFile);
  for (const kind of ["local", "anonymous"]) {
    const name = kind === "local" ? deploymentName : "anonymous-migration-test";
    h.configuration.childEnvironment.CONVEX_DEPLOYMENT = `${kind}:${name}`;
    h.setInstance(name);
    const homeConfig = path.join(h.homeDirectory, ".convex", kind === "local"
      ? "convex-backend-state" : "anonymous-convex-backend-state", name, "config.json");
    await mkdir(path.dirname(homeConfig), { recursive: true });
    await writeFile(homeConfig, JSON.stringify({ ...h.saved, deploymentName: undefined }));
    const reads = [];
    await h.client({ readUtf8: async (file) => { reads.push(file); return readFile(file, "utf8"); } });
    assert.deepEqual(reads, [h.configFile, homeConfig]);
  }
});

test("localhost configuration is pinned to the same numeric loopback port", async (t) => {
  const h = await fixture(t);
  h.configuration.publicUrl = h.configuration.publicUrl.replace("127.0.0.1", "localhost");
  h.configuration.childEnvironment.CONVEX_URL = h.configuration.publicUrl;
  await (await h.client()).call("state", {});
  assert.ok(h.calls.every(({ headers }) => headers.host.startsWith("127.0.0.1:")));
});

test("wrong or stopped instances never receive migration credentials or mutations", async (t) => {
  const h = await fixture(t, { instance: "different-deployment" });
  await assert.rejects(h.client(), /LOCAL_TARGET_INVALID/u);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].headers.authorization, undefined);
  await h.close();
  await assert.rejects(h.client(), /LOCAL_TARGET_INVALID/u);
  assert.equal(h.calls.length, 1);
});

test("an instance replacement after client creation blocks the next authenticated call", async (t) => {
  const h = await fixture(t);
  const client = await h.client();
  h.setInstance("different-deployment");
  await assert.rejects(client.call("page", {}), /REQUEST_FAILED/u);
  assert.ok(h.calls.every(({ method, headers }) => method === "GET" && headers.authorization === undefined));
});

test("check-only on an unmigrated target performs queries only and blocks publication", async (t) => {
  const h = await fixture(t);
  const client = await h.client();
  assert.equal((await migrateLocalConvexEv(client, { checkOnly: true })).status, "migration_required");
  let published = false;
  await assert.rejects(withLocalConvexEvReady(client, async () => { published = true; }), /MIGRATION_REQUIRED/u);
  assert.equal(published, false);
  assert.ok(h.calls.every(({ url }) => url === "/instance_name" || url === "/api/query"));
  assert.equal(h.calls.filter(({ method }) => method === "POST").length, 2);
});

test("instance and authenticated API redirects are refused without following them", async (t) => {
  for (const redirectPath of ["/instance_name", "/api/mutation"]) {
    const h = await fixture(t, { handle(request, response) {
      if (request.url !== redirectPath) return false;
      response.writeHead(302, { Location: "/credential-sink" }); response.end(); return true;
    } });
    if (redirectPath === "/instance_name") await assert.rejects(h.client(), /LOCAL_TARGET_INVALID/u);
    else await assert.rejects((await h.client()).call("initialize", {}), /REQUEST_FAILED/u);
    assert.ok(h.calls.every(({ url }) => url !== "/credential-sink"));
  }
});

test("request timeouts and oversized responses fail with redacted errors", async (t) => {
  const hanging = await fixture(t, { handle(_request, _response) { return true; } });
  await assert.rejects(hanging.client({ timeoutMilliseconds: 30 }), /LOCAL_TARGET_INVALID/u);
  const oversized = await fixture(t, { respond: () => "x".repeat(4 * 1_024 * 1_024) });
  await assert.rejects((await oversized.client()).call("state", {}), /REQUEST_FAILED/u);
});

test("server diagnostics and credential values never escape through errors or logging", async (t) => {
  const logs = ["log", "warn", "error"].map((name) => t.mock.method(console, name, () => {}));
  const secret = "protected-response-and-credential";
  const h = await fixture(t, { handle(request, response) {
    if (request.url === "/instance_name") return false;
    response.writeHead(560, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "error", errorMessage: secret, logLines: [secret] })); return true;
  } });
  const client = await h.client();
  await assert.rejects(client.call("state", {}), (error) => {
    assert.equal(error.message, "LOCAL_CONVEX_EV_MIGRATION_REQUEST_FAILED");
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  await assert.rejects(h.client({ readUtf8: async () => { throw new Error(secret); } }), (error) => {
    assert.equal(error.message, "LOCAL_CONVEX_EV_MIGRATION_LOCAL_TARGET_INVALID"); return true;
  });
  assert.ok(logs.every((log) => log.mock.callCount() === 0));
});
