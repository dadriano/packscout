import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareToBaseline,
  formatDuration,
  GATE_PHASE_GROUPS,
  GATE_PHASES,
  selectPhases,
  summarize,
} from "./gate-phases.mjs";

test("covers every group of the canonical gate", () => {
  assert.deepEqual(GATE_PHASE_GROUPS, [
    "check",
    "lint",
    "typecheck",
    "test",
    "build",
  ]);
});

test("names every test lane so lane-level regressions stay visible", () => {
  const lanes = selectPhases("test").map((phase) => phase.name);
  for (const lane of [
    "test:contracts",
    "test:database",
    "test:services",
    "test:worker",
    "test:convex",
    "test:frontend",
    "test:admin",
    "test:tooling",
  ]) {
    assert.ok(lanes.includes(lane), `${lane} must be measured`);
  }
});

test("reports compilation per workspace, not as one aggregate", () => {
  // Tasks that change a single workspace need to show that workspace improved.
  assert.ok(selectPhases("typecheck").length > 1);
  assert.ok(selectPhases("build").length > 1);
});

test("phase names are unique", () => {
  const names = GATE_PHASES.map((phase) => phase.name);
  assert.equal(new Set(names).size, names.length);
});

test("selecting an unknown group yields nothing", () => {
  assert.deepEqual(selectPhases("nonexistent"), []);
  assert.equal(selectPhases().length, GATE_PHASES.length);
});

test("formats short phases in milliseconds and long ones in seconds", () => {
  assert.equal(formatDuration(240), "240ms");
  assert.equal(formatDuration(9_999), "9999ms");
  assert.equal(formatDuration(10_000), "10.0s");
  assert.equal(formatDuration(62_358), "62.4s");
});

test("summarizes totals and names failing phases without dropping them", () => {
  const summary = summarize([
    { phase: "lint:frontend", group: "lint", durationMs: 100, ok: false },
    { phase: "test:tooling", group: "test", durationMs: 250, ok: true },
  ]);
  assert.equal(summary.totalMs, 350);
  assert.deepEqual(summary.failingPhases, ["lint:frontend"]);
  assert.equal(summary.phases.length, 2);
});

test("compares against a baseline and reports per-phase deltas", () => {
  const baseline = summarize([
    { phase: "build:services", group: "build", durationMs: 5209, ok: true },
    { phase: "build:worker", group: "build", durationMs: 4362, ok: true },
  ]);
  const current = summarize([
    { phase: "build:services", group: "build", durationMs: 120, ok: true },
    { phase: "test:tooling", group: "test", durationMs: 900, ok: true },
  ]);

  const rows = compareToBaseline(baseline, current);
  const byPhase = new Map(rows.map((row) => [row.phase, row]));

  assert.equal(byPhase.get("build:services").deltaMs, 120 - 5209);
  assert.equal(byPhase.get("build:services").status, "compared");
  // A phase that disappears must be reported, not silently counted as a win.
  assert.equal(byPhase.get("build:worker").status, "removed");
  assert.equal(byPhase.get("test:tooling").status, "added");
});

test("comparison tolerates an empty or missing baseline", () => {
  const current = summarize([
    { phase: "lint:admin", group: "lint", durationMs: 10, ok: true },
  ]);
  assert.equal(compareToBaseline(undefined, current).length, 1);
  assert.equal(compareToBaseline({}, current)[0].status, "added");
});
