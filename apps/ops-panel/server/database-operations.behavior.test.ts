import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";
import { createOpsPanelApp } from "./app.ts";
import {
  PANEL_REQUEST_HEADER,
  PANEL_REQUEST_HEADER_VALUE,
} from "./core/access.ts";
import { createAuditTrail } from "./core/audit-trail.ts";
import {
  DATABASE_URL_VARIABLE,
  requireLocalDatabaseTarget,
} from "./core/database-target.ts";
import { createLogSourceRegistry } from "./core/log-sources.ts";
import { createLogStreamHub } from "./core/log-stream-hub.ts";
import {
  createDatabaseOperationRunner,
  type OperationSpawnRequest,
} from "./core/operation-supervisor.ts";
import { createStudioSupervisor } from "./core/studio-supervisor.ts";
import { createDatabaseMonitor } from "./database-monitor.ts";
import { createLogTailReader } from "./log-tail-reader.ts";

/**
 * The operations surface over HTTP: what an operator's browser can and cannot
 * make the panel do.
 *
 * The interesting assertions are the refusals. Every one of them is answered in
 * the panel's stable error shape, recorded in the audit trail, and — crucially —
 * reached without a child process ever being spawned.
 */

const LOCAL = "postgresql://packscout:hunter2@127.0.0.1:5432/packscout_dev";
const REMOTE = "postgresql://packscout:hunter2@db.example.com:5432/packscout_dev";

interface FakeTimer {
  handler: () => void;
  milliseconds: number;
}

async function panel(options: { databaseUrl?: string; lineLimit?: number } = {}) {
  const audit = await createAuditTrail({
    store: { load: async () => [], save: async () => undefined },
  });
  const registry = createLogSourceRegistry([
    {
      service: "frontend",
      fileName: "frontend.log",
      fileId: "1:8",
      sizeBytes: 12,
      modifiedAt: "2026-08-20T09:00:00.000Z",
    },
  ]);
  const hub = createLogStreamHub();
  const reader = createLogTailReader({
    directory: "/tmp/packscout-logs",
    registry,
    hub,
    intervalMs: 60_000,
  });
  const env: Record<string, string | undefined> = {
    [DATABASE_URL_VARIABLE]: options.databaseUrl ?? LOCAL,
  };
  const supervisor = createStudioSupervisor({
    port: 5112,
    permit: () => ({ allowed: false, message: "not under test" }),
    setTimer: () => "timer",
    clearTimer: () => undefined,
    spawn: () => ({ kill: () => undefined }),
  });
  const monitor = createDatabaseMonitor({
    env,
    migrationsDirectory: "/tmp/packscout-migrations",
    supervisor,
    refreshIntervalMs: 0,
    listMigrations: async () => [],
    probe: async () => ({
      outcome: "reachable",
      sizeBytes: 4_096,
      tables: [],
      migrationHistory: [],
      detail: null,
    }),
  });

  const spawned: OperationSpawnRequest[] = [];
  const kills: number[] = [];
  const timers: FakeTimer[] = [];
  const operations = createDatabaseOperationRunner({
    permit: () => requireLocalDatabaseTarget(env),
    markerStore: { load: async () => null, save: async () => undefined },
    lineLimit: options.lineLimit ?? 2_000,
    spawn: (request) => {
      spawned.push(request);
      return { kill: () => kills.push(1) };
    },
    setTimer: (handler, milliseconds) => {
      const timer = { handler, milliseconds };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => undefined,
  });

  const app = createOpsPanelApp({
    audit,
    registry,
    hub,
    reader,
    logDirectory: "/tmp/packscout-logs",
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
    env,
    spawned,
    timers,
    operations,
    origin: `http://127.0.0.1:${port}`,
    post(operation: string, body: Record<string, unknown> = {}) {
      return fetch(`http://127.0.0.1:${port}/api/database/operations/${operation}`, {
        method: "POST",
        headers: {
          [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    },
    async close() {
      monitor.stop();
      supervisor.shutdown();
      operations.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("the surface publishes exactly three operations and their bounds", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(`${harness.origin}/api/database/operations`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.available, true);
  assert.deepEqual(
    payload.operations.map((operation: { id: string }) => operation.id),
    ["migrate", "seed", "reset"],
  );
  assert.equal(payload.running, null);
  assert.equal(payload.last, null);
  assert.ok(payload.outputLineLimit > 0);
  assert.ok(payload.timeoutMs > 0);
  // The payload names the target but never carries a credential.
  assert.equal(payload.target.identity.database, "packscout_dev");
  assert.ok(!JSON.stringify(payload).includes("hunter2"));
});

test("a non-local target makes the region unavailable and refuses every operation", async (t) => {
  const harness = await panel({ databaseUrl: REMOTE });
  t.after(() => harness.close());

  const snapshot = await (
    await fetch(`${harness.origin}/api/database/operations`)
  ).json();
  assert.equal(snapshot.available, false);
  assert.match(snapshot.unavailableReason, /not provably on this machine/u);

  for (const operation of ["migrate", "seed", "reset"]) {
    const response = await harness.post(operation, {
      acknowledgement: "packscout_dev",
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "ops_panel_database_not_local");
  }
  assert.equal(harness.spawned.length, 0, "nothing ran against a remote database");

  const rejected = harness.audit.list().filter((entry) => entry.outcome === "rejected");
  assert.equal(rejected.length, 3);
  assert.deepEqual(
    rejected.map((entry) => entry.route),
    [
      "/api/database/operations/reset",
      "/api/database/operations/seed",
      "/api/database/operations/migrate",
    ],
  );
});

test("no endpoint accepts anything but a registered operation name", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  for (const impostor of [
    "drop",
    "psql",
    "db%3Areset%3Alocal",
    "MIGRATE",
    "vacuum-full",
  ]) {
    const response = await harness.post(impostor);
    assert.equal(response.status, 400, `${impostor} was not refused`);
    const payload = await response.json();
    assert.equal(payload.code, "ops_panel_operation_unknown");
    assert.match(payload.error, /migrate, seed, reset/u);
  }
  assert.equal(harness.spawned.length, 0);
  assert.equal(
    harness.audit.list().filter((entry) => entry.outcome === "rejected").length,
    5,
    "every refused attempt is audited",
  );
});

test("a mistyped acknowledgement refuses the reset and is audited", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await harness.post("reset", { acknowledgement: "packscout-dev" });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.code, "ops_panel_operation_acknowledgement_mismatch");
  assert.equal(harness.spawned.length, 0);

  const [entry] = harness.audit.list();
  assert.equal(entry?.outcome, "rejected");
  assert.match(entry?.detail ?? "", /does not name the database/u);
});

test("a target that drifted since the dialog opened refuses with an explanation", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  // The dialog was rendered against packscout_dev; the environment has moved.
  harness.env[DATABASE_URL_VARIABLE] =
    "postgresql://packscout:hunter2@127.0.0.1:5432/packscout_other";

  const response = await harness.post("reset", {
    acknowledgement: "packscout_dev",
    expectedDatabase: "packscout_dev",
  });
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.code, "ops_panel_operation_target_drifted");
  assert.match(payload.error, /packscout_other/u);
  assert.equal(harness.spawned.length, 0);
});

test("a second operation is refused as busy while the first is still running", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const started = await harness.post("migrate");
  assert.equal(started.status, 202);
  const startedPayload = await started.json();
  assert.equal(startedPayload.running.operation, "migrate");
  assert.equal(harness.spawned[0]?.script, "db:prisma:migrate:deploy");

  const busy = await harness.post("seed");
  assert.equal(busy.status, 409);
  const payload = await busy.json();
  assert.equal(payload.code, "ops_panel_operation_busy");
  assert.match(payload.error, /Apply migrations is already running/u);
  assert.equal(harness.spawned.length, 1);
});

test("the lock does not gate log streaming or status reads", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  assert.equal((await harness.post("migrate")).status, 202);

  assert.equal((await fetch(`${harness.origin}/api/logs/sources`)).status, 200);
  assert.equal((await fetch(`${harness.origin}/api/database`)).status, 200);
  assert.equal(
    (await fetch(`${harness.origin}/api/database/operations`)).status,
    200,
  );
});

test("a started operation is audited with what it started and against what", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  await harness.post("seed");
  const [entry] = harness.audit.list();
  assert.equal(entry?.outcome, "succeeded");
  assert.equal(entry?.route, "/api/database/operations/seed");
  assert.match(entry?.detail ?? "", /run the seed against "packscout_dev"/u);
});

test("the stream carries a snapshot, live output and the settled outcome", async (t) => {
  const harness = await panel({ lineLimit: 3 });
  t.after(() => harness.close());

  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${harness.origin}/api/database/operations/stream`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let received = "";
  async function readUntil(pattern: RegExp): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!pattern.test(received) && Date.now() < deadline) {
      const chunk = await reader!.read();
      if (chunk.done) return;
      received += decoder.decode(chunk.value, { stream: true });
    }
  }

  await readUntil(/event: operations/u);
  assert.match(received, /^retry: 3000\n\n/u);

  assert.equal((await harness.post("migrate")).status, 202);
  harness.spawned[0]?.onOutput("applying 001\napplying 002\napplying 003\nextra\n");
  await readUntil(/event: operation-output/u);
  assert.match(received, /applying 001/u);

  harness.spawned[0]?.onExit({ code: 0, signal: null });
  await readUntil(/"outcome":"succeeded"/u);
  assert.match(received, /"outputTruncated":true/u);
  assert.match(received, /after 3 lines/u);

  await reader.cancel();
});

test("a timed-out run reports the limit it hit rather than going quiet", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  assert.equal((await harness.post("migrate")).status, 202);
  harness.timers[0]?.handler();

  const payload = await (
    await fetch(`${harness.origin}/api/database/operations`)
  ).json();
  assert.equal(payload.running, null);
  assert.equal(payload.last.outcome, "timed_out");
  assert.match(payload.last.message, /stopped after \d+s/u);
});

test("a panel that restarted mid-run reports that run's outcome as unknown", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  // Stand in for the previous process: a marker it never got to clear.
  const restarted = createDatabaseOperationRunner({
    permit: () => requireLocalDatabaseTarget(harness.env),
    markerStore: {
      load: async () => ({
        runId: "run-before-the-restart",
        operation: "reset",
        database: "packscout_dev",
        startedAt: "2026-08-20T08:59:00.000Z",
      }),
      save: async () => undefined,
    },
    spawn: () => ({ kill: () => undefined }),
  });
  await restarted.restore();

  const last = restarted.last();
  assert.equal(last?.outcome, "unknown");
  assert.equal(last?.interrupted, true);
  assert.match(last?.message ?? "", /restarted while/u);
});

test("a body that is not a small JSON object is refused in the panel's error shape", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(
    `${harness.origin}/api/database/operations/reset`,
    {
      method: "POST",
      headers: {
        [PANEL_REQUEST_HEADER]: PANEL_REQUEST_HEADER_VALUE,
        "content-type": "application/json",
      },
      body: "{not json",
    },
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "ops_panel_operation_request_invalid");
  assert.equal(harness.spawned.length, 0);
});

test("running an operation without the panel's custom header is refused and audited", async (t) => {
  const harness = await panel();
  t.after(() => harness.close());

  const response = await fetch(
    `${harness.origin}/api/database/operations/reset`,
    { method: "POST" },
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "ops_panel_missing_request_header");
  assert.equal(harness.spawned.length, 0);
  assert.equal(harness.audit.list()[0]?.outcome, "rejected");
});
