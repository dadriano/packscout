import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionJobHistoryQuery } from "@packscout/contracts";
import {
  InvalidPromotionJobMonitoringCursorError,
  PromotionJobMonitoringCursorCodec,
} from "./promotion-job-monitoring-cursor.ts";

const key = new Uint8Array(32).fill(7);
const organizationId = "10000000-0000-4000-8000-000000000001";
const query: PromotionJobHistoryQuery = {
  filter: "provider:alpha",
  trigger: "reconciliation_cron",
  outcome: "no_change",
  limit: 25,
};

function scope(overrides: Partial<{
  organizationId: string;
  deployment: string;
  rosterDigest: string;
  query: PromotionJobHistoryQuery;
}> = {}) {
  return {
    organizationId,
    deployment: "production",
    rosterDigest: "a".repeat(64),
    query,
    ...overrides,
  };
}

test("promotion history cursor round trips its exact safe position", () => {
  const codec = new PromotionJobMonitoringCursorCodec(key);
  const cursor = codec.encode(scope(), {
    startedAt: new Date("2026-09-01T12:00:00.000Z"),
    monitoringId: "pj_6HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g",
  });
  assert.deepEqual(codec.decode(cursor, scope()), {
    startedAt: new Date("2026-09-01T12:00:00.000Z"),
    monitoringId: "pj_6HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g",
  });

  const decodedBody = Buffer.from(cursor.split(".")[0]!, "base64url")
    .toString("utf8");
  assert.equal(decodedBody.includes(organizationId), false);
  assert.equal(decodedBody.includes("production"), false);
});

test("cursor is bound to tenant, deployment, roster, filters, and page size", () => {
  const codec = new PromotionJobMonitoringCursorCodec(key);
  const cursor = codec.encode(scope(), {
    startedAt: new Date("2026-09-01T12:00:00.000Z"),
    monitoringId: "pj_6HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g",
  });
  const mismatches = [
    scope({ organizationId: "10000000-0000-4000-8000-000000000002" }),
    scope({ deployment: "preproduction" }),
    scope({ rosterDigest: "b".repeat(64) }),
    scope({ query: { ...query, filter: "manifest" } }),
    scope({ query: { ...query, trigger: "manual" } }),
    scope({ query: { ...query, outcome: "failed" } }),
    scope({ query: { ...query, limit: 50 } }),
  ];
  for (const mismatch of mismatches) {
    assert.throws(() => codec.decode(cursor, mismatch),
      InvalidPromotionJobMonitoringCursorError);
  }
});

test("cursor tampering fails closed with one stable error", () => {
  const codec = new PromotionJobMonitoringCursorCodec(key);
  const cursor = codec.encode(scope(), {
    startedAt: new Date("2026-09-01T12:00:00.000Z"),
    monitoringId: "pj_6HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g",
  });
  const tampered = `${cursor.slice(0, -2)}aa`;
  assert.throws(() => codec.decode(tampered, scope()), {
    code: "INVALID_PROMOTION_JOB_CURSOR",
  });
  assert.throws(() => codec.decode("not-a-cursor", scope()), {
    code: "INVALID_PROMOTION_JOB_CURSOR",
  });
});
