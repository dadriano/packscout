import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnonymousProductEvent } from "@/lib/telemetry-contract";
import type {
  ContextValidationResult,
  IngressCapacityResult,
  TelemetryWriteResult,
} from "@/lib/telemetry-request.server";
import { createProductTelemetryPostHandler } from "@/lib/telemetry-routes.server";

const ORIGIN = "https://packscout.example";
const NOW = Date.parse("2026-08-11T20:00:00.000Z");
const PACK_ID = "beab33e4-20cf-5c41-9d31-2e616a34c113";

const VALID_EVENT = {
  schemaVersion: "anonymous-product-event-v1",
  eventId: "5e1b8a78-1577-4abc-8e26-495e2e5fdabc",
  snapshotVersion: "snapshot:v1",
  occurredAt: "2026-08-11T19:59:00.000Z",
  name: "dashboard_view",
  surface: "overview",
  outcome: "rendered",
} as const;

function request(
  body: string = JSON.stringify(VALID_EVENT),
  headers: Record<string, string | null> = {},
) {
  const normalized = new Headers({
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
  });
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) normalized.delete(key);
    else normalized.set(key, value);
  }
  return new Request(`${ORIGIN}/api/telemetry`, {
    method: "POST",
    headers: normalized,
    body,
  });
}

function handler(options: Readonly<{
  context?: ContextValidationResult;
  capacity?: IngressCapacityResult;
  write?: TelemetryWriteResult;
  seen?: AnonymousProductEvent[];
}> = {}) {
  return createProductTelemetryPostHandler({
    publicOrigin: ORIGIN,
    now: () => NOW,
    claimCapacity: async () => options.capacity ?? "allowed",
    validateContext: async (event) => {
      options.seen?.push(event);
      return options.context ?? "valid";
    },
    write: async () => options.write ?? "accepted",
  });
}

async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

test("accepts a strict same-origin product outcome after context validation", async () => {
  const seen: AnonymousProductEvent[] = [];
  const response = await handler({ seen })(request());
  assert.equal(response.status, 202);
  assert.deepEqual(await responseBody(response), {
    ok: true,
    status: "accepted",
  });
  assert.deepEqual(seen, [VALID_EVENT]);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("returns duplicate without exposing or rewriting the stable event id", async () => {
  const response = await handler({ write: "duplicate" })(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await responseBody(response), {
    ok: true,
    status: "duplicate",
  });
});

test("rejects missing or mismatched origin and fetch metadata", async () => {
  const cases: Array<Record<string, string | null>> = [
    { Origin: null },
    { Origin: "https://attacker.example" },
    { "Sec-Fetch-Site": null },
    { "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of cases) {
    const response = await handler()(request(undefined, headers));
    assert.equal(response.status, 403);
    assert.deepEqual(await responseBody(response), {
      ok: false,
      error: "Request origin is not allowed.",
      code: "ORIGIN_REJECTED",
    });
  }
});

test("rejects unsupported media and encoded bodies before parsing", async () => {
  const cases: Array<Record<string, string | null>> = [
    { "Content-Type": "text/plain" },
    { "Content-Type": null },
    { "Content-Encoding": "gzip" },
    { "Content-Encoding": "br" },
  ];
  for (const headers of cases) {
    const response = await handler()(request(undefined, headers));
    assert.equal(response.status, 415);
    assert.equal((await responseBody(response)).code, "UNSUPPORTED_MEDIA");
  }
  const identity = await handler()(
    request(undefined, { "Content-Encoding": "identity" }),
  );
  assert.equal(identity.status, 202);
});

test("rejects declared and actual UTF-8 payloads above 4,096 bytes", async () => {
  const declared = await handler()(
    request(undefined, { "Content-Length": "4097" }),
  );
  assert.equal(declared.status, 413);
  assert.equal((await responseBody(declared)).code, "PAYLOAD_TOO_LARGE");

  const actual = await handler()(request(`{"padding":"${"🂡".repeat(1_100)}"}`));
  assert.equal(actual.status, 413);
  assert.equal((await responseBody(actual)).code, "PAYLOAD_TOO_LARGE");
});

test("rejects malformed JSON, arrays, unknown keys, and invalid event time", async () => {
  const bodies = [
    "not-json",
    "[]",
    JSON.stringify({ ...VALID_EVENT, q: "query-sentinel" }),
    JSON.stringify({ ...VALID_EVENT, occurredAt: "2026-08-11T19:54:59.999Z" }),
    JSON.stringify({ ...VALID_EVENT, occurredAt: "2026-08-11T20:01:00.001Z" }),
    JSON.stringify({ ...VALID_EVENT, publicPackId: PACK_ID }),
  ];
  for (const body of bodies) {
    const response = await handler()(request(body));
    assert.equal(response.status, 400);
    assert.equal((await responseBody(response)).code, "INVALID_EVENT");
  }
});

test("rejects invalid UTF-8 before JSON parsing", async () => {
  const response = await handler()(
    new Request(`${ORIGIN}/api/telemetry`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: new Uint8Array([0xff, 0xfe, 0xfd]),
    }),
  );
  assert.equal(response.status, 400);
  assert.equal((await responseBody(response)).code, "INVALID_EVENT");
});

test("requires published snapshot and subject context without leaking details", async () => {
  const response = await handler({ context: "invalid" })(request());
  assert.equal(response.status, 400);
  assert.deepEqual(await responseBody(response), {
    ok: false,
    error: "Telemetry event context is invalid.",
    code: "INVALID_CONTEXT",
  });

  const subjectEvent = {
    schemaVersion: VALID_EVENT.schemaVersion,
    eventId: VALID_EVENT.eventId,
    snapshotVersion: VALID_EVENT.snapshotVersion,
    occurredAt: VALID_EVENT.occurredAt,
    name: "promo_copied",
    publicPackId: PACK_ID,
    platformKey: "collector_crypt",
    outcome: "clipboard",
  };
  const accepted = await handler()(request(JSON.stringify(subjectEvent)));
  assert.equal(accepted.status, 202);
});

test("maps both ingress capacity and write circuit breakers to one stable limit", async () => {
  for (const options of [
    { capacity: "rate_limited" as const },
    { write: "rate_limited" as const },
  ]) {
    const response = await handler(options)(request());
    assert.equal(response.status, 429);
    assert.equal((await responseBody(response)).code, "RATE_LIMITED");
  }
});

test("fails closed when context, capacity, or event storage is unavailable", async () => {
  for (const options of [
    { context: "unavailable" as const },
    { capacity: "unavailable" as const },
    { write: "unavailable" as const },
  ]) {
    const response = await handler(options)(request());
    assert.equal(response.status, 503);
    assert.equal((await responseBody(response)).code, "EVENT_UNAVAILABLE");
  }
});
