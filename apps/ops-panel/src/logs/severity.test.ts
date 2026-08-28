import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifySeverity,
  maxSeverity,
  stripLinePrefixes,
  type LogSeverity,
} from "./severity.ts";

function expectSeverity(cases: readonly (readonly [string, LogSeverity])[]): void {
  for (const [text, expected] of cases) {
    assert.equal(classifySeverity(text), expected, `for ${JSON.stringify(text)}`);
  }
}

test("a line that names its own level is taken at its word", () => {
  expectSeverity([
    ["ERROR: could not reach the provider", "error"],
    ["error connecting to postgres", "error"],
    ["warn: retrying in 5s", "warn"],
    ["WARNING deprecated flag --legacy", "warn"],
    ["info  ready in 812 ms", "info"],
    ["debug cache miss for pack:42", "debug"],
    ["trace enter importRun()", "debug"],
    ["fatal: the worker fleet is gone", "error"],
  ]);
});

test("timestamps, service tags, and glyphs are peeled off before classifying", () => {
  expectSeverity([
    ["2026-08-20T10:00:00.123Z [worker] ERROR quarantine full", "error"],
    ["10:00:00.123 | worker | warn | schedule overdue", "warn"],
    ["[frontend] [DEBUG] hydrating", "debug"],
    ["  ->  info   listening on 3000", "info"],
    ["2026-08-20 10:00:00 error: import failed", "error"],
  ]);
});

test("a level in a tag or a level= field counts as a prefix", () => {
  expectSeverity([
    ["[warn] slow query took 4s", "warn"],
    ["(ERROR) provider handshake rejected", "error"],
    ['ts=2026-08-20 level="error" msg="boom"', "error"],
    ["level=debug component=poller", "debug"],
  ]);
});

test("shapes that mean trouble are recognised wherever they sit", () => {
  expectSeverity([
    ["Uncaught TypeError: cannot read property id of undefined", "error"],
    ["npm ERR! code ELIFECYCLE", "error"],
    ["Traceback (most recent call last):", "error"],
    ["panic: runtime error: index out of range", "error"],
    ["TypeError: x is not a function", "error"],
    ["something happened, DeprecationWarning: Buffer() is obsolete", "warn"],
  ]);
});

test("a glyph stands in for a level word", () => {
  expectSeverity([
    ["✖ build failed in 3.2s", "error"],
    ["⚠ two providers are stale", "warn"],
    ["✔ 12 packs projected", "info"],
  ]);
});

test("a line that declares nothing is left unknown rather than guessed at", () => {
  expectSeverity([
    ["  at Object.<anonymous> (/app/worker.ts:14:9)", "unknown"],
    ["GET /api/packs 200 12ms", "unknown"],
    ["", "unknown"],
    ["   ", "unknown"],
    ["errorState = false", "unknown"],
    ['"error": null', "unknown"],
  ]);
});

test("the declaring form wins over a mention later in the line", () => {
  assert.equal(classifySeverity("warn: could not parse the error field"), "warn");
  assert.equal(classifySeverity("[debug] retrying after warning"), "debug");
});

test("prefix stripping stops at a level tag rather than eating it", () => {
  assert.equal(stripLinePrefixes("2026-08-20T10:00:00Z [worker] [ERROR] boom"), "[ERROR] boom");
  assert.equal(stripLinePrefixes("plain text"), "plain text");
});

test("the louder severity wins when a group is folded", () => {
  assert.equal(maxSeverity("info", "error"), "error");
  assert.equal(maxSeverity("warn", "debug"), "warn");
  assert.equal(maxSeverity("unknown", "debug"), "debug");
  assert.equal(maxSeverity("error", "error"), "error");
});
