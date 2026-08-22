import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DatabaseHealth,
  DatabaseStatusPayload,
  RowBrowserStatus,
} from "../api/panel-types.ts";
import {
  describeLocality,
  describeTarget,
  formatApproximateRows,
  readHealth,
  readMigrationHealth,
  readRowBrowser,
} from "./status-presentation.ts";

const ROW_BROWSER: RowBrowserStatus = {
  phase: "stopped",
  embedUrl: null,
  startedAt: null,
  readyAt: null,
  message: null,
  canStart: true,
  blockedReason: null,
  startupTimeoutMs: 30_000,
};

function status(overrides: Partial<DatabaseStatusPayload> = {}): DatabaseStatusPayload {
  return {
    readAt: "2026-08-20T00:00:00.000Z",
    health: "ready",
    headline: "Connected to packscout_dev on 127.0.0.1:5432.",
    detail: null,
    target: {
      variableName: "PACKSCOUT_DATABASE_URL",
      configured: true,
      identity: {
        host: "127.0.0.1",
        port: 5432,
        database: "packscout_dev",
        displayUrl: "postgresql://127.0.0.1:5432/packscout_dev",
      },
      locality: "local",
      localityReason: "loopback_host",
      problem: null,
      explanation: "local",
    },
    reachability: "reachable",
    sizeBytes: 1_024,
    tables: [],
    migrations: null,
    rowBrowser: ROW_BROWSER,
    refreshIntervalMs: 5_000,
    ...overrides,
  };
}

test("each unhappy state reads differently in tone, label, and next step", () => {
  const unhappy: DatabaseHealth[] = ["unconfigured", "unreachable", "unqueryable"];
  const readings = unhappy.map(readHealth);
  assert.equal(new Set(readings.map((reading) => reading.tone)).size, 3);
  assert.equal(new Set(readings.map((reading) => reading.label)).size, 3);
  assert.equal(new Set(readings.map((reading) => reading.nextStep)).size, 3);
  for (const reading of readings) assert.ok(reading.nextStep.length > 0);
  assert.equal(readHealth("ready").nextStep, "");
});

test("migration health carries its own tone", () => {
  assert.equal(readMigrationHealth("current").tone, "ready");
  assert.equal(readMigrationHealth("behind").tone, "warning");
  assert.equal(readMigrationHealth("failed").tone, "danger");
  assert.equal(readMigrationHealth("drifted").tone, "warning");
});

test("the row browser reading mirrors the server rather than deciding for itself", () => {
  const blocked = readRowBrowser({
    ...ROW_BROWSER,
    canStart: false,
    blockedReason: "The configured database is not provably on this machine.",
  });
  assert.equal(blocked.canStart, false);
  assert.match(blocked.message ?? "", /not provably on this machine/u);

  const ready = readRowBrowser({
    ...ROW_BROWSER,
    phase: "ready",
    embedUrl: "http://127.0.0.1:5112",
    canStart: false,
  });
  assert.equal(ready.embedUrl, "http://127.0.0.1:5112");
  assert.equal(ready.canStop, true);
  assert.equal(ready.tone, "ready");
});

test("an embed URL is offered only while the child is ready", () => {
  for (const phase of ["starting", "stopping", "failed", "stopped"] as const) {
    const reading = readRowBrowser({
      ...ROW_BROWSER,
      phase,
      embedUrl: "http://127.0.0.1:5112",
    });
    assert.equal(reading.embedUrl, null, phase);
  }
});

test("a failure message survives into the reading", () => {
  const reading = readRowBrowser({
    ...ROW_BROWSER,
    phase: "failed",
    message: "The row browser exited before it was ready (exit code 1).",
  });
  assert.equal(reading.tone, "danger");
  assert.match(reading.message ?? "", /exit code 1/u);
});

test("row counts are presented as estimates", () => {
  assert.equal(formatApproximateRows(4_211), "≈ 4,211");
  assert.equal(formatApproximateRows(0), "≈ 0");
  assert.equal(formatApproximateRows(Number.NaN), "unknown");
});

test("the target line names the database without credentials", () => {
  assert.equal(describeTarget(status()), "packscout_dev at 127.0.0.1:5432");
  assert.match(
    describeTarget(
      status({
        target: { ...status().target, identity: null, configured: false },
      }),
    ),
    /PACKSCOUT_DATABASE_URL is not usable/u,
  );
});

test("locality is rendered from the server's classification", () => {
  assert.deepEqual(describeLocality(status()), { tone: "ready", label: "Local" });
  assert.deepEqual(
    describeLocality(
      status({ target: { ...status().target, locality: "non_local" } }),
    ),
    { tone: "warning", label: "Not local" },
  );
});
