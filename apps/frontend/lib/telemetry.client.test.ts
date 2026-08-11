import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCatalogSearchEvent,
  createDashboardViewEvent,
  createFiltersAppliedEvent,
  createPublicReadFailureBeacon,
  queryLengthBucket,
  queueProductTelemetry,
  queuePublicReadFailure,
  resultCountBucket,
} from "./telemetry.client";

test("creates bounded product outcomes without raw search or browser identity", () => {
  const event = createCatalogSearchEvent({
    snapshotVersion: "snapshot:v1",
    queryLength: 34,
    resultCount: 0,
    outcome: "no_matches",
  });
  assert.ok(event);
  assert.deepEqual(
    {
      schemaVersion: event.schemaVersion,
      snapshotVersion: event.snapshotVersion,
      name: event.name,
      surface: event.surface,
      outcome: event.outcome,
      queryLengthBucket: event.queryLengthBucket,
      resultCountBucket: event.resultCountBucket,
    },
    {
      schemaVersion: "anonymous-product-event-v1",
      snapshotVersion: "snapshot:v1",
      name: "catalog_search",
      surface: "all_packs",
      outcome: "no_matches",
      queryLengthBucket: "21-60",
      resultCountBucket: "0",
    },
  );
  assert.doesNotMatch(
    JSON.stringify(event),
    /raw query|cursor|fingerprint|cookie|wallet|user agent/i,
  );
  assert.match(event.eventId, /^[0-9a-f-]{36}$/i);
  assert.match(event.occurredAt, /Z$/);
});

test("fails closed instead of constructing unbounded bucket events", () => {
  assert.equal(queryLengthBucket(0), null);
  assert.equal(queryLengthBucket(121), null);
  assert.equal(resultCountBucket(-1), null);
  assert.equal(
    createFiltersAppliedEvent({
      snapshotVersion: "snapshot:v1",
      surface: "overview",
      outcome: "results",
      activeFilterCount: 4,
      resultCount: 10,
    }),
    null,
  );
  assert.ok(
    createDashboardViewEvent({
      snapshotVersion: "snapshot:v1",
      surface: "overview",
    }),
  );
});

test("uses sendBeacon first and sends only the strict JSON blob", async () => {
  const calls: Array<{ url: string; body: Blob }> = [];
  const event = createDashboardViewEvent({
    snapshotVersion: "snapshot:v1",
    surface: "overview",
  });
  queueProductTelemetry(event, {
    sendBeacon(url, body) {
      calls.push({ url, body });
      return true;
    },
    fetch: async () => {
      throw new Error("fetch should not run after beacon acceptance");
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/telemetry");
  assert.equal(calls[0]?.body.type, "application/json");
  assert.deepEqual(JSON.parse(await calls[0]!.body.text()), event);
});

test("falls back to nonblocking credential-free keepalive fetch", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const event = createPublicReadFailureBeacon({
    queryName: "listPublicPacks",
    routeSurface: "all_packs",
    errorCode: "TRANSPORT_UNAVAILABLE",
    snapshotVersion: "snapshot:v1",
    retainedPreviousResult: true,
  });

  queuePublicReadFailure(event, {
    sendBeacon: () => false,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });
  await Promise.resolve();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "/api/public-read-failure");
  assert.equal(calls[0]?.init?.keepalive, true);
  assert.equal(calls[0]?.init?.credentials, "omit");
  assert.equal(calls[0]?.init?.cache, "no-store");
  assert.equal(calls[0]?.init?.referrerPolicy, "no-referrer");
});

test("swallows transport failures without changing the caller outcome", () => {
  const event = createDashboardViewEvent({
    snapshotVersion: "snapshot:v1",
    surface: "all_packs",
  });
  assert.doesNotThrow(() =>
    queueProductTelemetry(event, {
      sendBeacon() {
        throw new Error("blocked");
      },
      fetch() {
        throw new Error("offline");
      },
    }),
  );
});
