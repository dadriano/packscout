import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpaqueCursorEnvelope } from "@packscout/contracts";
import {
  OpaqueCursorGuard,
  OpaqueCursorGuardError,
} from "./opaque-cursor-guard.ts";

const base: OpaqueCursorEnvelope = {
  sourceInstanceId: "source-1",
  sourceRevisionId: "source-revision-1",
  sourceTypeKey: "fixture-source-v1",
  adapterVersion: "fixture-adapter-v1",
  cursorCodecKey: "fixture-cursor-v1",
  cursorGeneration: 1,
  value: null,
};
const guard = new OpaqueCursorGuard(Buffer.alloc(32, 7));

function expectCode(code: OpaqueCursorGuardError["code"], invoke: () => unknown) {
  assert.throws(
    invoke,
    (error) => error instanceof OpaqueCursorGuardError && error.code === code,
  );
}

test("continue requires a new non-null opaque cursor", () => {
  expectCode("continue_cursor_missing", () =>
    guard.guard({
      requested: base,
      next: base,
      continuation: { kind: "continue" },
      committedFingerprints: new Set(),
    }));
  expectCode("continue_cursor_unchanged", () =>
    guard.guard({
      requested: { ...base, value: "A" },
      next: { ...base, value: "A" },
      continuation: { kind: "continue" },
      committedFingerprints: new Set(),
    }));
});

test("committed fingerprints reject A-to-B-to-A cycles after restart", () => {
  const a = { ...base, value: "A" };
  const b = { ...base, value: "B" };
  const committedAfterFirstRun = new Set([guard.fingerprint(a)]);
  const bTransition = guard.guard({
    requested: a,
    next: b,
    continuation: { kind: "continue" },
    committedFingerprints: committedAfterFirstRun,
  });
  committedAfterFirstRun.add(bTransition.nextFingerprint);
  expectCode("cursor_cycle_detected", () =>
    guard.guard({
      requested: b,
      next: a,
      continuation: { kind: "continue" },
      committedFingerprints: committedAfterFirstRun,
    }));
});

test("poll_after may preserve null or non-null cursors", () => {
  assert.equal(
    guard.guard({
      requested: base,
      next: base,
      continuation: { kind: "poll_after", minimumDelaySeconds: 60 },
      committedFingerprints: new Set([guard.fingerprint(base)]),
    }).shouldContinueImmediately,
    false,
  );
  const nonNull = { ...base, value: "opaque" };
  assert.doesNotThrow(() =>
    guard.guard({
      requested: nonNull,
      next: nonNull,
      continuation: { kind: "poll_after", minimumDelaySeconds: 0 },
      committedFingerprints: new Set([guard.fingerprint(nonNull)]),
    }));
});

test("null and the opaque string null have distinct fingerprints", () => {
  assert.notEqual(
    guard.fingerprint(base),
    guard.fingerprint({ ...base, value: "null" }),
  );
});

test("binding changes and weak fingerprint keys fail closed", () => {
  expectCode("cursor_binding_mismatch", () =>
    guard.guard({
      requested: base,
      next: { ...base, sourceRevisionId: "other", value: "B" },
      continuation: { kind: "continue" },
      committedFingerprints: new Set(),
    }));
  expectCode(
    "cursor_fingerprint_key_invalid",
    () => new OpaqueCursorGuard(Buffer.alloc(31)),
  );
});
