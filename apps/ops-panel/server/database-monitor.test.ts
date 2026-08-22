import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseProbeResult, DatabaseStatusSnapshot } from "./core/database-status.ts";
import { DATABASE_URL_VARIABLE } from "./core/database-target.ts";
import { createStudioSupervisor, type StudioSpawnRequest } from "./core/studio-supervisor.ts";
import { createDatabaseMonitor } from "./database-monitor.ts";

const LOCAL_URL = "postgresql://packscout:hunter2@127.0.0.1:5432/packscout_dev";

const REACHABLE: DatabaseProbeResult = {
  outcome: "reachable",
  sizeBytes: 1_024,
  tables: [],
  migrationHistory: [],
  detail: null,
};

function harness(env: Record<string, string | undefined> = { [DATABASE_URL_VARIABLE]: LOCAL_URL }) {
  const probes: string[] = [];
  const spawned: StudioSpawnRequest[] = [];
  const supervisor = createStudioSupervisor({
    port: 5112,
    permit: () => ({ allowed: true }),
    setTimer: () => "timer",
    clearTimer: () => undefined,
    spawn: (request) => {
      spawned.push(request);
      return { kill: () => undefined };
    },
  });
  const monitor = createDatabaseMonitor({
    env,
    migrationsDirectory: "/workspace/packages/database/prisma/migrations",
    supervisor,
    refreshIntervalMs: 0,
    listMigrations: async () => ["20260812000000_baseline"],
    probe: async ({ connectionString }) => {
      probes.push(connectionString);
      return REACHABLE;
    },
  });
  return { monitor, supervisor, probes, spawned };
}

test("a snapshot combines the resolved target, the probe, and the repository migrations", async () => {
  const { monitor, probes } = harness();
  const snapshot = await monitor.current();
  assert.equal(snapshot.health, "ready");
  assert.equal(snapshot.target.identity?.database, "packscout_dev");
  assert.equal(snapshot.migrations?.health, "behind");
  assert.deepEqual([...(snapshot.migrations?.pending ?? [])], ["20260812000000_baseline"]);
  assert.deepEqual(probes, [LOCAL_URL]);
});

test("an unconfigured environment is never probed", async () => {
  const { monitor, probes } = harness({});
  const snapshot = await monitor.current();
  assert.equal(snapshot.health, "unconfigured");
  assert.equal(snapshot.migrations, null);
  assert.deepEqual(probes, []);
});

test("the cached snapshot is reused until a refresh is asked for", async () => {
  const { monitor, probes } = harness();
  await monitor.current();
  await monitor.current();
  assert.equal(probes.length, 1);
  await monitor.refresh();
  assert.equal(probes.length, 2);
});

test("concurrent refreshes share one database read", async () => {
  const { monitor, probes } = harness();
  await Promise.all([monitor.refresh(), monitor.refresh(), monitor.refresh()]);
  assert.equal(probes.length, 1);
});

test("row-browser state changes republish without re-reading the database", async () => {
  const { monitor, supervisor, probes } = harness();
  const seen: DatabaseStatusSnapshot[] = [];
  const unsubscribe = monitor.subscribe((snapshot) => seen.push(snapshot));
  await monitor.refresh();
  const afterRefresh = probes.length;

  supervisor.start();
  assert.equal(probes.length, afterRefresh, "no extra probe for a supervision change");
  assert.equal(seen.at(-1)?.rowBrowser.phase, "starting");

  supervisor.state();
  unsubscribe();
  monitor.stop();
});

test("subscribers stop receiving updates once they unsubscribe", async () => {
  const { monitor, supervisor } = harness();
  let updates = 0;
  const unsubscribe = monitor.subscribe(() => {
    updates += 1;
  });
  await monitor.refresh();
  const delivered = updates;
  unsubscribe();
  supervisor.start();
  assert.equal(updates, delivered);
  monitor.stop();
});

test("a failure listing repository migrations degrades to none rather than throwing", async () => {
  const errors: unknown[] = [];
  const monitor = createDatabaseMonitor({
    env: { [DATABASE_URL_VARIABLE]: LOCAL_URL },
    migrationsDirectory: "/nowhere",
    supervisor: createStudioSupervisor({
      port: 5112,
      permit: () => ({ allowed: true }),
      spawn: () => ({ kill: () => undefined }),
    }),
    refreshIntervalMs: 0,
    listMigrations: async () => {
      throw new Error("unreadable");
    },
    probe: async () => REACHABLE,
    onError: (error) => errors.push(error),
  });
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.migrations?.repositoryCount, 0);
  assert.equal(errors.length, 1);
});
