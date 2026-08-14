import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicRepackHeat } from "@packscout/contracts";
import {
  expireCurrentRepackHeat,
  millisecondsUntilRepackHeatExpiry,
  resolveRepackHeatAtTime,
} from "./repack-heat-deadline.client";

const currentHeat = {
  status: "current",
  signal: {
    calculatedAt: "2026-08-13T12:05:00Z",
    expiresAt: "2026-08-13T12:20:00Z",
  },
} as unknown as PublicRepackHeat;

test("keeps current heat before its exact public deadline", () => {
  assert.equal(
    resolveRepackHeatAtTime(currentHeat, Date.parse("2026-08-13T12:19:59.999Z")),
    currentHeat,
  );
  assert.equal(
    millisecondsUntilRepackHeatExpiry(
      "2026-08-13T12:20:00Z",
      Date.parse("2026-08-13T12:19:59.999Z"),
    ),
    1,
  );
});

test("expires current heat at the deadline without retaining a stale signal", () => {
  const expired = resolveRepackHeatAtTime(
    currentHeat,
    Date.parse("2026-08-13T12:20:00Z"),
  );

  assert.deepEqual(expired, {
    status: "expired",
    signal: null,
    lastCalculatedAt: "2026-08-13T12:05:00Z",
    expiredAt: "2026-08-13T12:20:00Z",
  });
});

test("does not rewrite already expired or unavailable heat", () => {
  const expired: PublicRepackHeat = {
    status: "expired",
    signal: null,
    lastCalculatedAt: "2026-08-13T12:05:00Z",
    expiredAt: "2026-08-13T12:20:00Z",
  };
  const unavailable: PublicRepackHeat = {
    status: "unavailable",
    signal: null,
    reason: "NOT_PUBLISHED",
  };

  assert.equal(expireCurrentRepackHeat(expired), expired);
  assert.equal(
    resolveRepackHeatAtTime(unavailable, Number.POSITIVE_INFINITY),
    unavailable,
  );
});

test("does not manufacture expiry from a malformed deadline", () => {
  assert.equal(
    millisecondsUntilRepackHeatExpiry("not-a-timestamp", Date.now()),
    null,
  );
  const malformed = {
    ...currentHeat,
    signal: { ...currentHeat.signal, expiresAt: "not-a-timestamp" },
  } as unknown as PublicRepackHeat;
  assert.equal(resolveRepackHeatAtTime(malformed, Number.POSITIVE_INFINITY), malformed);
});
