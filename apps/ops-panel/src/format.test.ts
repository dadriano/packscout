import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAge, formatByteSize, formatTimestamp } from "./format.ts";

test("byte sizes read at a glance", () => {
  assert.equal(formatByteSize(0), "0 B");
  assert.equal(formatByteSize(512), "512 B");
  assert.equal(formatByteSize(2048), "2.0 KB");
  assert.equal(formatByteSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatByteSize(-1), "unknown");
  assert.equal(formatByteSize(Number.NaN), "unknown");
});

test("ages degrade from seconds to days", () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");
  assert.equal(formatAge("2026-08-19T11:59:48.000Z", now), "12s ago");
  assert.equal(formatAge("2026-08-19T11:57:00.000Z", now), "3m ago");
  assert.equal(formatAge("2026-08-19T09:00:00.000Z", now), "3h ago");
  assert.equal(formatAge("2026-08-17T12:00:00.000Z", now), "2d ago");
  assert.equal(formatAge("nonsense", now), "unknown");
});

test("unparseable timestamps never render as Invalid Date", () => {
  assert.equal(formatTimestamp("nonsense"), "unknown");
  assert.notEqual(formatTimestamp("2026-08-19T12:00:00.000Z"), "unknown");
});
