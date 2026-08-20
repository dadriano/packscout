import assert from "node:assert/strict";
import { request as httpRequest, type Server } from "node:http";
import { test } from "node:test";
import { createOpsPanelApp } from "./app.ts";
import {
  PANEL_REQUEST_HEADER,
  PANEL_REQUEST_HEADER_VALUE,
} from "./core/access.ts";
import { createAuditTrail, type AuditEntry } from "./core/audit-trail.ts";
import { createLogSourceRegistry, type LogSource } from "./core/log-sources.ts";
import { createLogStreamHub } from "./core/log-stream-hub.ts";
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

async function panel() {
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
    directory: "/tmp/packscout-logs",
    registry,
    hub,
    intervalMs: 60_000,
    // The panel's own log directory does not exist under test; a missing file
    // is a state the tail already models, so no stubbing is required.
  });
  const app = createOpsPanelApp({
    audit,
    registry,
    hub,
    reader,
    logDirectory: "/tmp/packscout-logs",
    pollIntervalMs: 1_000,
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
    saved,
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
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

  const response = await fetch(`${harness.origin}/api/database/migrate`, {
    method: "POST",
    headers: { [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE },
  });
  // No database surface exists yet; the point is that the attempt is recorded.
  assert.equal(response.status, 404);
  const [entry] = harness.audit.list();
  assert.equal(entry?.outcome, "failed");
  assert.equal(entry?.route, "/api/database/migrate");
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
