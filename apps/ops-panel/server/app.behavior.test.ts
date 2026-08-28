import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createOpsPanelApp } from "./app.ts";
import {
  PANEL_REQUEST_HEADER,
  PANEL_REQUEST_HEADER_VALUE,
} from "./core/access.ts";
import { createAuditTrail, type AuditEntry } from "./core/audit-trail.ts";
import {
  DATABASE_URL_VARIABLE,
  requireLocalDatabaseTarget,
} from "./core/database-target.ts";
import { createLogSourceRegistry, type LogSource } from "./core/log-sources.ts";
import { createLogStreamHub } from "./core/log-stream-hub.ts";
import { createDatabaseOperationRunner } from "./core/operation-supervisor.ts";
import {
  createStudioSupervisor,
  type StudioSpawnRequest,
} from "./core/studio-supervisor.ts";
import { createDatabaseMonitor } from "./database-monitor.ts";
import { createLogTailReader } from "./log-tail-reader.ts";

function source(service: string): LogSource {
  return {
    service,
    fileName: `${service}.log`,
    fileId: `1:${service.length}`,
    sizeBytes: 12,
    modifiedAt: "2026-08-19T12:00:00.000Z",
  };
}

/** A request that can forge headers `fetch()` reserves, such as `Host`. */
function rawRequest(
  port: number,
  options: {
    method: string;
    path: string;
    headers: Record<string, string>;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = httpRequest(
      { host: "127.0.0.1", port, method: options.method, path: options.path },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    for (const [name, value] of Object.entries(options.headers)) {
      client.setHeader(name, value);
    }
    client.on("error", reject);
    client.end();
  });
}

const LOCAL_DATABASE_URL = "postgresql://packscout:hunter2@127.0.0.1:5432/packscout_dev";

async function panel(options: { databaseUrl?: string; logDirectory?: string } = {}) {
  const logDirectory = options.logDirectory ?? "/tmp/packscout-logs";
  const saved: AuditEntry[][] = [];
  const audit = await createAuditTrail({
    store: {
      load: async () => [],
      save: async (entries) => {
        saved.push([...entries]);
      },
    },
  });
  const registry = createLogSourceRegistry([source("frontend")]);
  const hub = createLogStreamHub();
  const reader = createLogTailReader({
    directory: logDirectory,
    registry,
    hub,
    intervalMs: 60_000,
    // The panel's own log directory does not exist under test; a missing file
    // is a state the tail already models, so no stubbing is required.
  });
  const env: Record<string, string | undefined> =
    options.databaseUrl === undefined
      ? {}
      : { [DATABASE_URL_VARIABLE]: options.databaseUrl };
  const spawned: StudioSpawnRequest[] = [];
  const supervisor = createStudioSupervisor({
    port: 5112,
    permit: () => {
      const decision = requireLocalDatabaseTarget(env);
      return decision.ok
        ? { allowed: true }
        : { allowed: false, message: decision.message };
    },
    setTimer: () => "timer",
    clearTimer: () => undefined,
    spawn: (request) => {
      spawned.push(request);
      return { kill: () => undefined };
    },
  });
  const monitor = createDatabaseMonitor({
    env,
    migrationsDirectory: "/tmp/packscout-migrations",
    supervisor,
    refreshIntervalMs: 0,
    listMigrations: async () => ["20260812000000_baseline"],
    probe: async () => ({
      outcome: "reachable",
      sizeBytes: 4_096,
      tables: [{ name: "repacks", approximateRows: 12, totalBytes: 8_192 }],
      migrationHistory: [],
      detail: null,
    }),
  });
  const operations = createDatabaseOperationRunner({
    permit: () => requireLocalDatabaseTarget(env),
    markerStore: { load: async () => null, save: async () => undefined },
    spawn: () => ({ kill: () => Promise.resolve() }),
    setTimer: () => "timer",
    clearTimer: () => undefined,
  });
  const app = createOpsPanelApp({
    audit,
    registry,
    hub,
    reader,
    logDirectory,
    pollIntervalMs: 1_000,
    database: { monitor, supervisor, operations, env },
  });
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    audit,
    registry,
    hub,
    reader,
    saved,
    port,
    spawned,
    supervisor,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      monitor.stop();
      supervisor.shutdown();
      operations.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("liveness answers without any panel header", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "packscout-ops-panel",
    scope: "local",
  });
});

test("a mutation without the custom header is rejected and audited", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/database/migrate`, {
    method: "POST",
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error:
      "Privileged panel requests must send the x-packscout-ops-panel request header.",
    code: "ops_panel_missing_request_header",
  });

  const [entry] = harness.audit.list();
  assert.ok(entry);
  assert.equal(entry.outcome, "rejected");
  assert.equal(entry.reason, "ops_panel_missing_request_header");
  assert.equal(entry.route, "/api/database/migrate");
  assert.equal(entry.method, "POST");
  assert.ok(harness.saved.length >= 1, "the rejection was persisted");
});

test("a mutation from a foreign origin is rejected and audited", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/database/migrate`, {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE,
    },
  });
  assert.equal(response.status, 403);
  const [entry] = harness.audit.list();
  assert.equal(entry?.reason, "ops_panel_non_loopback_origin");
  assert.equal(entry?.outcome, "rejected");
});

test("a rejected request never carries CORS approval back to the page", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/database/migrate`, {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});

test("an admitted privileged request is audited with its outcome", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/database/no-such-action`, {
    method: "POST",
    headers: { [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE },
  });
  // The panel has no route by that name; the point is that the attempt is
  // recorded anyway, so an unrecognised privileged request is not invisible.
  assert.equal(response.status, 404);
  const [entry] = harness.audit.list();
  assert.equal(entry?.outcome, "failed");
  assert.equal(entry?.route, "/api/database/no-such-action");
});

test("a sensitive read through a rebound host name is rejected", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  // fetch() will not let a caller forge Host, so this uses the raw client the
  // way a rebound page's browser would: loopback socket, attacker host name.
  const result = await rawRequest(harness.port, {
    method: "GET",
    path: "/api/logs/sources",
    headers: { Host: "panel.attacker.example" },
  });
  assert.equal(result.status, 403);
  assert.equal(JSON.parse(result.body).code, "ops_panel_non_loopback_host");
});

test("a privileged request through a rebound host name is rejected and audited", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const result = await rawRequest(harness.port, {
    method: "POST",
    path: "/api/database/migrate",
    headers: {
      Host: "panel.attacker.example",
      [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE,
    },
  });
  assert.equal(result.status, 403);
  const [entry] = harness.audit.list();
  assert.equal(entry?.outcome, "rejected");
  assert.equal(entry?.reason, "ops_panel_non_loopback_host");
});

test("the source list is served to a loopback reader", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/logs/sources`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.logDirectory, "/tmp/packscout-logs");
  assert.equal(payload.pollIntervalMs, 1_000);
  assert.deepEqual(payload.sources, [source("frontend")]);
});

test("the source stream sends a retry hint and a named snapshot event", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${harness.origin}/api/logs/sources/stream`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(response.headers.get("x-accel-buffering"), "no");

  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("\n\n") || !received.includes("event: sources")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(received, /^retry: 3000\n\n/);
  assert.match(received, /event: sources\ndata: \{/);
  assert.match(received, /"service":"frontend"/);

  harness.registry.refresh([source("frontend"), source("worker")]);
  while (!received.includes('"worker"')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(received, /"added":\[\{"service":"worker"/);

  await reader.cancel();
});

test("closing a stream releases its registry subscription", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const controller = new AbortController();
  const response = await fetch(`${harness.origin}/api/logs/sources/stream`, {
    signal: controller.signal,
  });
  const reader = response.body?.getReader();
  assert.ok(reader);
  await reader.read();
  assert.equal(harness.registry.listenerCount(), 1);

  controller.abort();
  const deadline = Date.now() + 2_000;
  while (harness.registry.listenerCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(harness.registry.listenerCount(), 0);
});

test("the activity view lists recent privileged attempts newest first", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  await fetch(`${harness.origin}/api/database/migrate`, { method: "POST" });
  await fetch(`${harness.origin}/api/database/seed`, { method: "POST" });

  const response = await fetch(`${harness.origin}/api/activity`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.capacity, 500);
  assert.deepEqual(
    payload.entries.map((entry: AuditEntry) => entry.route),
    ["/api/database/seed", "/api/database/migrate"],
  );
});

test("the live log stream is a sensitive read behind the loopback host guard", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const result = await rawRequest(harness.port, {
    method: "GET",
    path: "/api/logs/stream",
    headers: { Host: "panel.attacker.example" },
  });
  assert.equal(result.status, 403);
  assert.equal(JSON.parse(result.body).code, "ops_panel_non_loopback_host");
});

test("the log stream opens immediately so the client can stop saying connecting", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${harness.origin}/api/logs/stream`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("event: logs")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(received, /^retry: 3000\n\n/);
  assert.match(received, /event: logs\ndata: \{/);
  await reader.cancel();
});

test("a window read reports every discovered service, even an absent one", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/logs/window?lines=50`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.requestedLines, 50);
  assert.deepEqual(
    payload.windows.map((entry: { service: string; present: boolean }) => [
      entry.service,
      entry.present,
    ]),
    [["frontend", false]],
    "a service whose file is missing is reported as absent, not omitted",
  );
});

test("a window read refuses a service name outside the log convention", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(
    `${harness.origin}/api/logs/window?service=${encodeURIComponent("../etc/passwd")}`,
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "ops_panel_unknown_service");
});

test("a window request is clamped rather than trusted", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/logs/window?lines=999999`);
  assert.equal((await response.json()).requestedLines, 5_000);
});

test("closing a log stream releases every tail it was holding", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const controller = new AbortController();
  const response = await fetch(`${harness.origin}/api/logs/stream`, {
    signal: controller.signal,
  });
  const reader = response.body?.getReader();
  assert.ok(reader);
  await reader.read();
  assert.equal(harness.hub.viewerCount(), 1);

  controller.abort();
  const deadline = Date.now() + 2_000;
  while (harness.hub.viewerCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(harness.hub.viewerCount(), 0, "the tail fleet went passive again");
});

test("the database status read is served to a loopback reader without credentials", async (t) => {
  const harness = await panel({ databaseUrl: LOCAL_DATABASE_URL });
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/database`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes("hunter2"), "no credential reaches the response");

  const payload = JSON.parse(body);
  assert.equal(payload.health, "ready");
  assert.equal(payload.target.locality, "local");
  assert.deepEqual(payload.target.identity, {
    host: "127.0.0.1",
    port: 5432,
    database: "packscout_dev",
    displayUrl: "postgresql://127.0.0.1:5432/packscout_dev",
  });
  assert.equal(payload.migrations.health, "behind");
  assert.equal(payload.rowBrowser.canStart, true);
});

test("the database status read is refused through a rebound host name", async (t) => {
  const harness = await panel({ databaseUrl: LOCAL_DATABASE_URL });
  t.after(() => harness.close());

  const result = await rawRequest(harness.port, {
    method: "GET",
    path: "/api/database",
    headers: { Host: "panel.attacker.example" },
  });
  assert.equal(result.status, 403);
  assert.equal(JSON.parse(result.body).code, "ops_panel_non_loopback_host");
});

test("the database status stream pushes a snapshot and follows the row browser live", async (t) => {
  const harness = await panel({ databaseUrl: LOCAL_DATABASE_URL });
  t.after(() => harness.close());

  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${harness.origin}/api/database/stream`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("event: database")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(received, /^retry: 3000\n\n/);
  assert.ok(!received.includes("hunter2"));

  harness.supervisor.start();
  while (!received.includes('"phase":"starting"')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(received, /"phase":"starting"/);
  await reader.cancel();
});

test("starting the row browser is privileged, audited, and starts one child", async (t) => {
  const harness = await panel({ databaseUrl: LOCAL_DATABASE_URL });
  t.after(() => harness.close());

  const unheaded = await fetch(`${harness.origin}/api/database/row-browser`, {
    method: "POST",
  });
  assert.equal(unheaded.status, 403);
  assert.equal(harness.spawned.length, 0);

  const response = await fetch(`${harness.origin}/api/database/row-browser`, {
    method: "POST",
    headers: { [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE },
  });
  assert.equal(response.status, 202);
  assert.equal(harness.spawned.length, 1);
  assert.equal(harness.spawned[0]?.hostname, "127.0.0.1");
  assert.equal((await response.json()).rowBrowser.phase, "starting");

  const outcomes = harness.audit.list().map((entry) => entry.outcome);
  assert.deepEqual(outcomes, ["succeeded", "rejected"]);
});

test("stopping the row browser is privileged and audited", async (t) => {
  const harness = await panel({ databaseUrl: LOCAL_DATABASE_URL });
  t.after(() => harness.close());

  await fetch(`${harness.origin}/api/database/row-browser`, {
    method: "POST",
    headers: { [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE },
  });
  const response = await fetch(`${harness.origin}/api/database/row-browser`, {
    method: "DELETE",
    headers: { [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE },
  });
  assert.equal(response.status, 200);

  const [latest] = harness.audit.list();
  assert.equal(latest?.method, "DELETE");
  assert.equal(latest?.route, "/api/database/row-browser");
  assert.equal(latest?.outcome, "succeeded");
});

test("a non-local database refuses the row browser server-side and explains why", async (t) => {
  const harness = await panel({
    databaseUrl: "postgresql://packscout:hunter2@db.example.com:5432/packscout",
  });
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/database/row-browser`, {
    method: "POST",
    headers: { [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE },
  });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.code, "ops_panel_database_not_local");
  assert.match(payload.error, /not provably on this machine/);
  assert.equal(harness.spawned.length, 0);

  const [entry] = harness.audit.list();
  assert.equal(entry?.outcome, "rejected");
  assert.match(entry?.detail ?? "", /not provably local/);

  const status = await (await fetch(`${harness.origin}/api/database`)).json();
  assert.equal(status.rowBrowser.canStart, false);
  assert.equal(status.rowBrowser.blockedReason, payload.error);
});

test("an unconfigured database refuses the row browser and reports the honest state", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const status = await (await fetch(`${harness.origin}/api/database`)).json();
  assert.equal(status.health, "unconfigured");
  assert.equal(status.target.locality, "non_local");
  assert.equal(status.migrations, null);

  const response = await fetch(`${harness.origin}/api/database/row-browser`, {
    method: "POST",
    headers: { [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE },
  });
  assert.equal(response.status, 409);
  assert.equal(harness.spawned.length, 0);
});

async function logDirectoryWith(
  service: string,
  content: string,
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "packscout-panel-logs-"));
  await writeFile(path.join(directory, `${service}.log`), content, "utf8");
  return directory;
}

test("a history page is bounded and names lines exactly as the tail does", async (t) => {
  const directory = await logDirectoryWith("frontend", "a\nbb\nccc\ndddd\n");
  const harness = await panel({ logDirectory: directory });
  t.after(async () => {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  });

  // One tail tick gives the service its generation, exactly as the running
  // panel does; history then names the same bytes the tail would.
  await harness.reader.tick();

  const response = await fetch(
    `${harness.origin}/api/logs/history?service=frontend&direction=backward&lines=2`,
  );
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.deepEqual(
    page.lines.map((line: { id: string; text: string }) => [line.id, line.text]),
    [
      ["line:frontend:1:5", "ccc"],
      ["line:frontend:1:9", "dddd"],
    ],
  );
  assert.equal(page.startCursor, 5, "the next older page ends where this one began");
  assert.equal(page.atStart, false);
});

test("a history page for a generation the file no longer has is refused", async (t) => {
  const directory = await logDirectoryWith("frontend", "one\ntwo\n");
  const harness = await panel({ logDirectory: directory });
  t.after(async () => {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  });

  await harness.reader.tick();

  const response = await fetch(
    `${harness.origin}/api/logs/history?service=frontend&cursor=9&generation=77`,
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "ops_panel_log_generation_changed");
  assert.equal(body.requestedGeneration, 77);
  assert.equal(body.generation, 1, "the answer says which generation is current");
});

test("a raw log download without the custom header is rejected and audited", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/logs/download?service=frontend`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "ops_panel_missing_request_header");

  const [entry] = harness.audit.list();
  assert.ok(entry, "handing over a whole log file is a privileged attempt");
  assert.equal(entry.outcome, "rejected");
  assert.equal(entry.route, "/api/logs/download");
});

test("a raw log download streams the file as an attachment and is audited", async (t) => {
  const directory = await logDirectoryWith("frontend", "first\nsecond\n");
  const harness = await panel({ logDirectory: directory });
  t.after(async () => {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  });

  const response = await fetch(
    `${harness.origin}/api/logs/download?service=frontend`,
    { headers: { [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE } },
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="frontend.log"',
  );
  assert.equal(response.headers.get("content-length"), "13");
  assert.equal(await response.text(), "first\nsecond\n");

  const [entry] = harness.audit.list();
  assert.ok(entry);
  assert.equal(entry.outcome, "succeeded");
  assert.match(entry.detail ?? "", /streamed 13 bytes of frontend\.log/u);
});

test("a raw log download refuses a name that is not a service", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(
    `${harness.origin}/api/logs/download?service=${encodeURIComponent("../../etc/passwd")}`,
    { headers: { [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE } },
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "ops_panel_unknown_service");
});

test("unknown api routes answer with the panel error shape", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/nope`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "Unknown operations panel route.",
    code: "ops_panel_not_found",
  });
});
