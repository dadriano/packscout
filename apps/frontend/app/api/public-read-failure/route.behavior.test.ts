import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicReadFailureBeacon } from "@/lib/telemetry-contract";
import type {
  ContextValidationResult,
  IngressCapacityResult,
  TelemetryWriteResult,
} from "@/lib/telemetry-request.server";
import { createPublicReadFailurePostHandler } from "@/lib/telemetry-routes.server";

const ORIGIN = "https://packscout.example";
const NOW = Date.parse("2026-08-11T20:00:00.000Z");
const VALID_BEACON = {
  schemaVersion: "public-read-failure-v1",
  eventId: "5e1b8a78-1577-4abc-8e26-495e2e5fdabc",
  queryName: "listPublicPacks",
  routeSurface: "all_packs",
  errorCode: "TRANSPORT_UNAVAILABLE",
  snapshotVersion: "snapshot:v1",
  retainedPreviousResult: true,
  occurredAt: "2026-08-11T19:59:00.000Z",
} as const;

function request(body: unknown = VALID_BEACON) {
  return new Request(`${ORIGIN}/api/public-read-failure`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function handler(options: Readonly<{
  context?: ContextValidationResult;
  capacity?: IngressCapacityResult;
  write?: TelemetryWriteResult;
  seen?: PublicReadFailureBeacon[];
}> = {}) {
  return createPublicReadFailurePostHandler({
    publicOrigin: ORIGIN,
    now: () => NOW,
    claimCapacity: async () => options.capacity ?? "allowed",
    validateContext: async (beacon) => {
      options.seen?.push(beacon);
      return options.context ?? "valid";
    },
    write: async () => options.write ?? "accepted",
  });
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

test("accepts one strict reactive-read failure without catalog query data", async () => {
  const seen: PublicReadFailureBeacon[] = [];
  const response = await handler({ seen })(request());
  assert.equal(response.status, 202);
  assert.deepEqual(await body(response), { ok: true, status: "accepted" });
  assert.deepEqual(seen, [VALID_BEACON]);
  assert.doesNotMatch(JSON.stringify(seen), /cursor|fingerprint|publicPackId|platformKey/);
});

test("rejects raw query, cursor, subject, and arbitrary metadata fields", async () => {
  for (const forbidden of [
    { q: "query-sentinel" },
    { cursor: "cursor-sentinel" },
    { cursorStack: "stack-sentinel" },
    { fingerprint: "fingerprint-sentinel" },
    { publicPackId: "beab33e4-20cf-5c41-9d31-2e616a34c113" },
    { platformKey: "collector_crypt" },
    { userAgent: "browser" },
  ]) {
    const response = await handler()(request({ ...VALID_BEACON, ...forbidden }));
    assert.equal(response.status, 400);
    assert.equal((await body(response)).code, "INVALID_EVENT");
  }
});

test("rejects query/error combinations that cannot occur", async () => {
  const invalid = [
    { queryName: "getPublicShellStatus", errorCode: "CURSOR_EXPIRED" },
    { queryName: "getDashboardBundle", errorCode: "PACK_NOT_FOUND" },
    { queryName: "getPublicPack", errorCode: "CURSOR_EXPIRED" },
  ] as const;
  for (const fields of invalid) {
    const response = await handler()(request({ ...VALID_BEACON, ...fields }));
    assert.equal(response.status, 400);
    assert.equal((await body(response)).code, "INVALID_EVENT");
  }
});

test("requires active or safe-previous snapshot context", async () => {
  const invalid = await handler({ context: "invalid" })(request());
  assert.equal(invalid.status, 400);
  assert.equal((await body(invalid)).code, "INVALID_CONTEXT");

  const unavailable = await handler({ context: "unavailable" })(request());
  assert.equal(unavailable.status, 503);
  assert.equal((await body(unavailable)).code, "EVENT_UNAVAILABLE");
});

test("shares the circuit-breaker and duplicate response vocabulary", async () => {
  const limitedByCapacity = await handler({ capacity: "rate_limited" })(request());
  assert.equal(limitedByCapacity.status, 429);
  assert.equal((await body(limitedByCapacity)).code, "RATE_LIMITED");

  const limitedByWrite = await handler({ write: "rate_limited" })(request());
  assert.equal(limitedByWrite.status, 429);
  assert.equal((await body(limitedByWrite)).code, "RATE_LIMITED");

  const duplicate = await handler({ write: "duplicate" })(request());
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await body(duplicate), { ok: true, status: "duplicate" });
});
