import assert from "node:assert/strict";
import test from "node:test";
import {
  promotionJobHistoryQuerySchema,
  promotionJobMonitoringOverviewSchema,
  promotionJobMonitoringFilterSchema,
  promotionJobMonitoringIdSchema,
  promotionJobPublicReleaseMonitoringSchema,
  providerPromotionJobMonitoringSchema,
} from "./promotion-job-monitoring.ts";

test("promotion monitoring filters accept only manifest or prefixed provider keys", () => {
  for (const valid of ["manifest", "provider:alpha", "provider:beta_cards"]) {
    assert.equal(promotionJobMonitoringFilterSchema.safeParse(valid).success, true);
  }
  for (const invalid of [
    "all",
    "alpha",
    "provider",
    "provider:",
    "provider:Alpha",
    "provider:packscout_canonical_alpha",
    "10000000-0000-4000-8000-000000000001",
  ]) {
    assert.equal(
      promotionJobMonitoringFilterSchema.safeParse(invalid).success,
      false,
      invalid,
    );
  }
});

test("history query is bounded and never broadens an invalid filter", () => {
  assert.deepEqual(promotionJobHistoryQuerySchema.parse({}), { limit: 25 });
  assert.deepEqual(promotionJobHistoryQuerySchema.parse({
    filter: "provider:alpha",
    trigger: "reconciliation_cron",
    outcome: "no_change",
    limit: "100",
  }), {
    filter: "provider:alpha",
    trigger: "reconciliation_cron",
    outcome: "no_change",
    limit: 100,
  });
  for (const invalid of [
    { filter: "all" },
    { filter: "alpha" },
    { trigger: "scheduled" },
    { outcome: "success" },
    { limit: 101 },
    { unknown: "value" },
  ]) assert.equal(promotionJobHistoryQuerySchema.safeParse(invalid).success, false);
});

test("detail identity is opaque and cannot be a UUID or local run ID", () => {
  assert.equal(
    promotionJobMonitoringIdSchema.safeParse(
      "pj_6HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g",
    ).success,
    true,
  );
  for (const invalid of [
    "10000000-0000-4000-8000-000000000001",
    "run_6HY8d6A1RXq4A1l68cnXPgEVxk0Z_r6g",
    "pj_short",
  ]) {
    assert.equal(promotionJobMonitoringIdSchema.safeParse(invalid).success, false);
  }
});

test("historical active positions may be unknown but completed positions may not", () => {
  const release = {
    publicReleaseId: "release-alpha",
    fingerprint: "a".repeat(64),
    position: null,
  };
  assert.equal(
    promotionJobPublicReleaseMonitoringSchema.safeParse(release).success,
    true,
  );
  assert.equal(providerPromotionJobMonitoringSchema.safeParse({
    providerKey: "alpha",
    displayName: "Alpha",
    lifecycle: "active",
    evidenceSource: "last_known",
    observedAt: "2026-09-01T12:00:00.000Z",
    stale: true,
    routeFailureCode: null,
    state: "last_known",
    schedule: null,
    wake: null,
    settledPosition: "2",
    completedRelease: release,
    activeRelease: release,
    pendingGate: null,
    latestInvocation: null,
    projectionLagMs: null,
  }).success, false);
});

test("overview schema strips undeclared protected authority at every boundary", () => {
  const result = promotionJobMonitoringOverviewSchema.parse({
    observedAt: "2026-09-01T12:00:00.000Z",
    organizationId: "never-return",
    roster: {
      observedAt: "2026-09-01T12:00:00.000Z",
      version: "1",
      highWater: "2",
      digest: "a".repeat(64),
      providerCount: 0,
      eligibleProviderCount: 0,
      databaseUrl: "never-return",
    },
    evaluator: {
      state: "current",
      observedAt: "2026-09-01T12:00:00.000Z",
      evaluatedThrough: "2026-09-01T12:00:00.000Z",
      rosterVersion: "1",
      rosterHighWater: "2",
      rosterDigest: "a".repeat(64),
      expectedCount: 1,
      reachableCount: 1,
      unavailableCount: 0,
      manifestEvaluated: true,
      failureCode: null,
      credential: "never-return",
    },
    manifest: {
      evidenceSource: "live",
      observedAt: "2026-09-01T12:00:00.000Z",
      stale: false,
      schedule: null,
      wake: null,
      activeManifest: null,
      previousManifest: null,
      gateQueueDepth: 0,
      oldestGateAgeMs: null,
      serializedOperation: null,
      lastActivationAt: null,
      lastReconciliationAt: null,
      latestInvocation: null,
      receiptBody: "never-return",
    },
    providers: [],
  });
  const serialized = JSON.stringify(result);
  for (const token of ["organizationId", "databaseUrl", "credential", "receiptBody"]) {
    assert.equal(serialized.includes(token), false, token);
  }
});
