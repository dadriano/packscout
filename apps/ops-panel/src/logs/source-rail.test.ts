import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogSource } from "../api/panel-types.ts";
import {
  buildSourceRail,
  createObservationLedger,
  livenessFor,
  MIN_RATE_WINDOW_MS,
  QUIET_WITHIN_MS,
  WRITING_WITHIN_MS,
} from "./source-rail.ts";

const OPENED = Date.parse("2026-08-20T10:00:00.000Z");

function source(service: string, overrides: Partial<LogSource> = {}): LogSource {
  return {
    service,
    fileName: `${service}.log`,
    fileId: `1:${service}`,
    sizeBytes: overrides.sizeBytes ?? 4096,
    modifiedAt: overrides.modifiedAt ?? new Date(OPENED).toISOString(),
  };
}

test("liveness is read from the file, so a quiet service is not called dead", () => {
  const now = OPENED + QUIET_WITHIN_MS + 60_000;
  assert.equal(livenessFor(new Date(now - 1_000).toISOString(), now), "writing");
  assert.equal(
    livenessFor(new Date(now - WRITING_WITHIN_MS - 1_000).toISOString(), now),
    "quiet",
  );
  assert.equal(
    livenessFor(new Date(now - QUIET_WITHIN_MS - 1_000).toISOString(), now),
    "stale",
  );
  assert.equal(livenessFor(null, now), "stale");
  assert.equal(livenessFor("not a date", now), "stale");
});

test("counts come only from lines the panel actually saw", () => {
  const ledger = createObservationLedger(OPENED);
  ledger.record("worker", "info", OPENED + 1_000);
  ledger.record("worker", "error", OPENED + 2_000);
  ledger.record("worker", "error", OPENED + 3_000);
  ledger.record("frontend", "info", OPENED + 4_000);

  const snapshot = ledger.snapshot(OPENED + 5_000);
  assert.equal(snapshot.get("worker")?.lines, 3);
  assert.equal(snapshot.get("worker")?.errors, 2);
  assert.equal(snapshot.get("worker")?.recentErrors, 2);
  assert.equal(snapshot.get("frontend")?.errors, 0);
  assert.equal(snapshot.get("admin"), undefined, "an unobserved service invents nothing");
});

test("the error chip falls back to zero as the window moves past it", () => {
  const ledger = createObservationLedger(OPENED, { recentWindowMs: 60_000 });
  ledger.record("worker", "error", OPENED + 1_000);
  assert.equal(ledger.snapshot(OPENED + 30_000).get("worker")?.recentErrors, 1);
  assert.equal(ledger.snapshot(OPENED + 120_000).get("worker")?.recentErrors, 0);
  assert.equal(
    ledger.snapshot(OPENED + 120_000).get("worker")?.errors,
    1,
    "the total is still true",
  );
});

test("retained error samples are bounded", () => {
  const ledger = createObservationLedger(OPENED, { errorSampleLimit: 3 });
  for (let index = 0; index < 10; index += 1) {
    ledger.record("worker", "error", OPENED + index * 100);
  }
  const observed = ledger.snapshot(OPENED + 1_000).get("worker");
  assert.equal(observed?.errors, 10);
  assert.equal(observed?.recentErrors, 3, "only the retained samples can be counted");
});

test("a rate is withheld until there is enough observation to divide by", () => {
  const ledger = createObservationLedger(OPENED);
  ledger.record("worker", "info", OPENED + 500);

  const tooSoon = buildSourceRail({
    sources: [source("worker")],
    observations: ledger.snapshot(OPENED + 1_000),
    hidden: new Set(),
    focusedService: null,
    openedAtMs: OPENED,
    nowMs: OPENED + 1_000,
  });
  assert.equal(tooSoon[0]?.linesPerMinute, null, "no number is better than a wrong one");

  for (let index = 0; index < 59; index += 1) {
    ledger.record("worker", "info", OPENED + 1_000 + index * 100);
  }
  const now = OPENED + 500 + MIN_RATE_WINDOW_MS * 6;
  const measured = buildSourceRail({
    sources: [source("worker")],
    observations: ledger.snapshot(now),
    hidden: new Set(),
    focusedService: null,
    openedAtMs: OPENED,
    nowMs: now,
  });
  assert.equal(measured[0]?.linesPerMinute, 60, "60 lines over the first minute");
});

test("the rate window opens when the service was first seen, never earlier", () => {
  const ledger = createObservationLedger(OPENED);
  const firstSeen = OPENED + 10 * 60_000;
  ledger.record("late", "info", firstSeen);
  ledger.record("late", "info", firstSeen + 30_000);

  const now = firstSeen + 60_000;
  const rail = buildSourceRail({
    sources: [source("late")],
    observations: ledger.snapshot(now),
    hidden: new Set(),
    focusedService: null,
    openedAtMs: OPENED,
    nowMs: now,
  });
  assert.equal(rail[0]?.linesPerMinute, 2, "two lines in the one minute it was watched");
});

test("the rail lists every discovered service with its file facts", () => {
  const ledger = createObservationLedger(OPENED);
  ledger.record("worker", "error", OPENED + 1_000);
  const now = OPENED + 30_000;
  const rail = buildSourceRail({
    sources: [
      source("worker", { sizeBytes: 2048, modifiedAt: new Date(now - 2_000).toISOString() }),
      source("frontend", {
        sizeBytes: 99,
        modifiedAt: new Date(now - QUIET_WITHIN_MS - 1).toISOString(),
      }),
    ],
    observations: ledger.snapshot(now),
    hidden: new Set(["frontend"]),
    focusedService: null,
    openedAtMs: OPENED,
    nowMs: now,
  });

  assert.deepEqual(
    rail.map((entry) => [entry.service, entry.liveness, entry.sizeBytes, entry.visible]),
    [
      ["frontend", "stale", 99, false],
      ["worker", "writing", 2048, true],
    ],
  );
  assert.equal(rail[1]?.recentErrors, 1);
  assert.equal(rail[0]?.recentErrors, 0);
});

test("focus overrides the visibility checkboxes rather than fighting them", () => {
  const rail = buildSourceRail({
    sources: [source("worker"), source("frontend")],
    observations: new Map(),
    hidden: new Set(["worker"]),
    focusedService: "worker",
    openedAtMs: OPENED,
    nowMs: OPENED,
  });
  const worker = rail.find((entry) => entry.service === "worker");
  const frontend = rail.find((entry) => entry.service === "frontend");
  assert.equal(worker?.visible, true);
  assert.equal(worker?.focused, true);
  assert.equal(frontend?.visible, false);
});

test("a service seen only in the stream still appears, with no file facts", () => {
  const ledger = createObservationLedger(OPENED);
  ledger.record("ghost", "info", OPENED + 1_000);
  const rail = buildSourceRail({
    sources: [],
    observations: ledger.snapshot(OPENED + 2_000),
    hidden: new Set(),
    focusedService: null,
    openedAtMs: OPENED,
    nowMs: OPENED + 2_000,
  });
  assert.equal(rail.length, 1);
  assert.equal(rail[0]?.sizeBytes, null);
  assert.equal(rail[0]?.modifiedAt, null);
  assert.equal(rail[0]?.observedLines, 1);
});

test("a reset forgets the observations rather than carrying them forward", () => {
  const ledger = createObservationLedger(OPENED);
  ledger.record("worker", "error", OPENED + 1_000);
  ledger.reset(OPENED + 5_000);
  assert.equal(ledger.openedAtMs(), OPENED + 5_000);
  assert.equal(ledger.snapshot(OPENED + 6_000).size, 0);
});
