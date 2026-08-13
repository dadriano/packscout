import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAnonymousProductEvent,
  parsePublicReadFailureBeacon,
  TELEMETRY_RETENTION_POLICY,
} from "./telemetry-contract";

const NOW = Date.parse("2026-08-11T20:00:00.000Z");
const BASE = {
    schemaVersion: "anonymous-product-event-v2",
  eventId: "5e1b8a78-1577-4abc-8e26-495e2e5fdabc",
  publicReleaseId: "20000000-0000-4000-8000-000000000002",
  occurredAt: "2026-08-11T19:59:00.000Z",
} as const;
const REPACK_ID = "beab33e4-20cf-5c41-9d31-2e616a34c113";

test("accepts only the five strict anonymous product event shapes", () => {
  const events = [
    { ...BASE, name: "dashboard_view", surface: "overview", outcome: "rendered" },
    {
      ...BASE,
      name: "repack_search",
      surface: "all_repacks",
      outcome: "results",
      queryLengthBucket: "1-20",
      resultCountBucket: "1-25",
    },
    {
      ...BASE,
      name: "filters_applied",
      surface: "overview",
      outcome: "no_matches",
      activeFilterCount: 2,
      resultCountBucket: "0",
    },
    {
      ...BASE,
      name: "promo_copied",
      publicRepackId: REPACK_ID,
      vendorKey: "collector_crypt",
      outcome: "clipboard",
    },
    {
      ...BASE,
      name: "repack_link_opened",
      publicRepackId: REPACK_ID,
      vendorKey: "collector_crypt",
      outcome: "opened",
    },
  ];
  for (const event of events) {
    assert.equal(parseAnonymousProductEvent(event, NOW).ok, true);
  }
});

test("rejects browser identity, raw catalog state, and subject fields on aggregate events", () => {
  const event = {
    ...BASE,
    name: "repack_search",
    surface: "all_repacks",
    outcome: "results",
    queryLengthBucket: "1-20",
    resultCountBucket: "1-25",
  } as const;
  for (const forbidden of [
    { q: "secret-query" },
    { cursor: "secret-cursor" },
    { fingerprint: "secret-fingerprint" },
    { publicRepackId: REPACK_ID },
    { publicCollectibleId: REPACK_ID },
    { userAgent: "browser" },
    { tenantId: "tenant" },
  ]) {
    assert.equal(
      parseAnonymousProductEvent({ ...event, ...forbidden }, NOW).ok,
      false,
    );
  }
});

test("enforces the five-minute past and one-minute future UTC window", () => {
  const event = {
    ...BASE,
    name: "dashboard_view",
    surface: "overview",
    outcome: "rendered",
  } as const;
  assert.equal(
    parseAnonymousProductEvent(
      { ...event, occurredAt: "2026-08-11T19:55:00.000Z" },
      NOW,
    ).ok,
    true,
  );
  assert.equal(
    parseAnonymousProductEvent(
      { ...event, occurredAt: "2026-08-11T19:54:59.999Z" },
      NOW,
    ).ok,
    false,
  );
  assert.equal(
    parseAnonymousProductEvent(
      { ...event, occurredAt: "2026-08-11T20:01:00.000Z" },
      NOW,
    ).ok,
    true,
  );
  assert.equal(
    parseAnonymousProductEvent(
      { ...event, occurredAt: "2026-08-11T20:01:00+00:00" },
      NOW,
    ).ok,
    false,
  );
  assert.equal(
    parseAnonymousProductEvent(
      { ...event, occurredAt: "2026-02-31T12:00:00Z" },
      Date.parse("2026-03-03T12:00:00Z"),
    ).ok,
    false,
  );
});

test("enforces public-read query/error combinations and excludes raw query context", () => {
  const beacon = {
    schemaVersion: "public-read-failure-v1",
    eventId: BASE.eventId,
    queryName: "listPublicRepacks",
    routeSurface: "all_repacks",
    errorCode: "CURSOR_EXPIRED",
    publicReleaseId: "20000000-0000-4000-8000-000000000002",
    retainedPreviousResult: true,
    occurredAt: BASE.occurredAt,
  } as const;
  assert.equal(parsePublicReadFailureBeacon(beacon, NOW).ok, true);
  assert.equal(
    parsePublicReadFailureBeacon(
      { ...beacon, queryName: "getPublicShellStatus" },
      NOW,
    ).ok,
    false,
  );
  assert.equal(
    parsePublicReadFailureBeacon({ ...beacon, q: "sentinel" }, NOW).ok,
    false,
  );
  assert.equal(
    parsePublicReadFailureBeacon(
      { ...beacon, publicReleaseId: null, retainedPreviousResult: true },
      NOW,
    ).ok,
    false,
  );
});

test("publishes the bounded downstream retention contract without claiming storage", () => {
  assert.deepEqual(TELEMETRY_RETENTION_POLICY, {
    receiptHours: 24,
    rawEventDays: 30,
    aggregateMonths: 13,
    aggregationBatchSize: 500,
    maximumAttempts: 10,
    globalWritesPerMinute: 5_000,
  });
});
