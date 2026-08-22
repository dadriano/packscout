import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDatabaseStatus,
  type DatabaseProbeResult,
  type DatabaseStatusInput,
} from "./database-status.ts";
import { DATABASE_URL_VARIABLE, resolveDatabaseTarget } from "./database-target.ts";
import type { StudioState } from "./studio-supervisor.ts";

const LOCAL_URL = "postgresql://packscout:hunter2@127.0.0.1:5432/packscout_dev";
const REMOTE_URL = "postgresql://packscout:hunter2@db.example.com:5432/packscout";

const STOPPED: StudioState = {
  phase: "stopped",
  embedUrl: null,
  startedAt: null,
  readyAt: null,
  message: null,
};

const READY_PROBE: DatabaseProbeResult = {
  outcome: "reachable",
  sizeBytes: 12_557_335,
  tables: [{ name: "repacks", approximateRows: 4_211, totalBytes: 65_536 }],
  migrationHistory: [
    {
      name: "20260812000000_baseline",
      startedAt: "2026-08-18T00:00:00.000Z",
      finishedAt: "2026-08-18T00:00:01.000Z",
      rolledBackAt: null,
    },
  ],
  detail: null,
};

function status(overrides: Partial<DatabaseStatusInput> = {}) {
  return buildDatabaseStatus({
    readAt: "2026-08-20T00:00:00.000Z",
    target: resolveDatabaseTarget({ [DATABASE_URL_VARIABLE]: LOCAL_URL }),
    probe: READY_PROBE,
    repositoryMigrations: ["20260812000000_baseline"],
    rowBrowser: { state: STOPPED, startupTimeoutMs: 30_000 },
    refreshIntervalMs: 5_000,
    ...overrides,
  });
}

test("a healthy local database reports identity, size, tables, and migrations", () => {
  const snapshot = status();
  assert.equal(snapshot.health, "ready");
  assert.equal(snapshot.reachability, "reachable");
  assert.equal(snapshot.headline, "Connected to packscout_dev on 127.0.0.1:5432.");
  assert.equal(snapshot.sizeBytes, 12_557_335);
  assert.equal(snapshot.tables[0]?.approximateRows, 4_211);
  assert.equal(snapshot.migrations?.health, "current");
  assert.equal(snapshot.detail, null);
});

test("the three unhappy states are distinct values with distinct wording", () => {
  const unconfigured = status({ target: resolveDatabaseTarget({}), probe: null });
  const unreachable = status({
    probe: {
      outcome: "unreachable",
      sizeBytes: null,
      tables: [],
      migrationHistory: null,
      detail: "connect ECONNREFUSED 127.0.0.1:5432",
    },
  });
  const unqueryable = status({
    probe: {
      outcome: "unqueryable",
      sizeBytes: null,
      tables: [],
      migrationHistory: null,
      detail: "permission denied for table pg_stat_user_tables",
    },
  });

  assert.deepEqual(
    [unconfigured.health, unreachable.health, unqueryable.health],
    ["unconfigured", "unreachable", "unqueryable"],
  );
  const headlines = new Set([
    unconfigured.headline,
    unreachable.headline,
    unqueryable.headline,
  ]);
  assert.equal(headlines.size, 3);
  assert.match(unconfigured.detail ?? "", new RegExp(DATABASE_URL_VARIABLE, "u"));
  assert.match(unreachable.detail ?? "", /ECONNREFUSED/u);
  assert.match(unqueryable.detail ?? "", /permission denied/u);
  for (const snapshot of [unconfigured, unreachable, unqueryable]) {
    assert.equal(snapshot.migrations, null);
    assert.equal(snapshot.sizeBytes, null);
  }
});

test("a configured target that was never probed reads as not attempted, not healthy", () => {
  const snapshot = status({ probe: null });
  assert.equal(snapshot.reachability, "not_attempted");
  assert.notEqual(snapshot.health, "ready");
  assert.match(snapshot.headline, /has not reached it yet/u);
});

test("the row browser is startable only for a provably local target", () => {
  assert.equal(status().rowBrowser.canStart, true);
  assert.equal(status().rowBrowser.blockedReason, null);

  const remote = status({
    target: resolveDatabaseTarget({ [DATABASE_URL_VARIABLE]: REMOTE_URL }),
  });
  assert.equal(remote.rowBrowser.canStart, false);
  assert.equal(remote.rowBrowser.blockedReason, remote.target.explanation);

  const unreadable = status({
    target: resolveDatabaseTarget({ [DATABASE_URL_VARIABLE]: "nonsense" }),
  });
  assert.equal(unreadable.rowBrowser.canStart, false);
  assert.ok((unreadable.rowBrowser.blockedReason ?? "").length > 0);
});

test("a running row browser is not startable again and exposes its embed URL only when ready", () => {
  const starting = status({
    rowBrowser: {
      state: { ...STOPPED, phase: "starting", startedAt: "2026-08-20T00:00:00.000Z" },
      startupTimeoutMs: 30_000,
    },
  });
  assert.equal(starting.rowBrowser.canStart, false);
  assert.equal(starting.rowBrowser.embedUrl, null);

  const ready = status({
    rowBrowser: {
      state: { ...STOPPED, phase: "ready", embedUrl: "http://127.0.0.1:5112" },
      startupTimeoutMs: 30_000,
    },
  });
  assert.equal(ready.rowBrowser.embedUrl, "http://127.0.0.1:5112");
  assert.equal(ready.rowBrowser.canStart, false);
});

test("no credential reaches the snapshot, in any state", () => {
  for (const snapshot of [
    status(),
    status({ target: resolveDatabaseTarget({ [DATABASE_URL_VARIABLE]: REMOTE_URL }) }),
    status({ target: resolveDatabaseTarget({}), probe: null }),
  ]) {
    assert.ok(!JSON.stringify(snapshot).includes("hunter2"));
  }
});
