import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRepackSearchEvent,
  createDashboardViewEvent,
  createFiltersAppliedEvent,
  createPublicReadFailureBeacon,
  queryLengthBucket,
  queueProductTelemetry,
  queuePublicReadFailure,
  resultCountBucket,
} from "./telemetry.client";

test("creates bounded product outcomes without raw search or browser identity", () => {
  const event = createRepackSearchEvent({
    publicReleaseId: "20000000-0000-4000-8000-000000000002",
    queryLength: 34,
    resultCount: 0,
    outcome: "no_matches",
  });
  assert.ok(event);
  assert.deepEqual(
    {
      schemaVersion: event.schemaVersion,
      publicReleaseId: event.publicReleaseId,
      name: event.name,
      surface: event.surface,
      outcome: event.outcome,
      queryLengthBucket: event.queryLengthBucket,
      resultCountBucket: event.resultCountBucket,
    },
    {
      schemaVersion: "anonymous-product-event-v2",
      publicReleaseId: "20000000-0000-4000-8000-000000000002",
      name: "repack_search",
      surface: "all_repacks",
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
      publicReleaseId: "20000000-0000-4000-8000-000000000002",
      surface: "overview",
      outcome: "results",
      activeFilterCount: 5,
      resultCount: 10,
    }),
    null,
  );
  assert.ok(
    createDashboardViewEvent({
      publicReleaseId: "20000000-0000-4000-8000-000000000002",
      surface: "overview",
    }),
  );
});

test("uses sendBeacon first and sends only the strict JSON blob", async () => {
  const calls: Array<{ url: string; body: Blob }> = [];
  const event = createDashboardViewEvent({
    publicReleaseId: "20000000-0000-4000-8000-000000000002",
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
    queryName: "listPublicRepacks",
    routeSurface: "all_repacks",
    errorCode: "TRANSPORT_UNAVAILABLE",
    publicReleaseId: "20000000-0000-4000-8000-000000000002",
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
    publicReleaseId: "20000000-0000-4000-8000-000000000002",
    surface: "all_repacks",
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
