import assert from "node:assert/strict";
import test from "node:test";
import type {
  PromotionJobPublicReleaseMonitoring,
  PromotionJobScheduleMonitoring,
  PromotionJobWakeMonitoring,
} from "@packscout/contracts";
import {
  judgeProviderPromotionMonitoring,
  type ProviderPromotionMonitoringLocalFacts,
} from "./promotion-job-monitoring-judgment.ts";

const schedule: PromotionJobScheduleMonitoring = {
  lifecycle: "active",
  health: "healthy",
  scheduleEpoch: "1",
  missedWindowCount: "0",
  lastScheduledCheckinAt: "2026-09-01T12:00:00.000Z",
  nextExpectedCheckinAt: "2026-09-01T12:01:00.000Z",
};
const wake: PromotionJobWakeMonitoring = {
  pending: false,
  requestedGeneration: "1",
  acknowledgedGeneration: "1",
  latestCause: "canonical_settlement",
  latestRequestedAt: "2026-09-01T12:00:00.000Z",
  deliveryState: "delivered",
  lastDeliveryAttemptAt: "2026-09-01T12:00:00.000Z",
  failureCode: null,
};

function release(position: string, token: string): PromotionJobPublicReleaseMonitoring {
  return {
    publicReleaseId: `release-${token}`,
    fingerprint: token.repeat(64),
    position,
  };
}

function local(
  overrides: Partial<ProviderPromotionMonitoringLocalFacts> = {},
): ProviderPromotionMonitoringLocalFacts {
  return {
    observedAt: "2026-09-01T12:00:01.000Z",
    schedule,
    wake,
    settledPosition: "2",
    completedRelease: release("2", "a"),
    latestInvocation: null,
    executionState: "ready",
    projectionLagMs: 1_000,
    ...overrides,
  };
}

function judge(overrides: Partial<Parameters<
  typeof judgeProviderPromotionMonitoring
>[0]> = {}) {
  return judgeProviderPromotionMonitoring({
    roster: {
      providerKey: "alpha",
      displayName: "Alpha",
      lifecycle: "active",
    },
    live: local(),
    lastKnown: null,
    central: {
      activeRelease: release("2", "a"),
      pendingGate: null,
    },
    routeFailureCode: null,
    evaluatorCurrent: true,
    ...overrides,
  });
}

test("completed release newer than the active selection awaits only activation", () => {
  const alpha = judge({
    central: { activeRelease: release("1", "b"), pendingGate: null },
  });
  const beta = judge({
    roster: {
      providerKey: "beta",
      displayName: "Beta",
      lifecycle: "active",
    },
  });
  assert.equal(alpha.state, "awaiting_activation");
  assert.equal(beta.state, "current");
});

test("settled work newer than the completed release awaits publication", () => {
  const result = judge({
    live: local({
      settledPosition: "3",
      completedRelease: release("2", "a"),
    }),
  });
  assert.equal(result.state, "awaiting_publication");
});

test("provider outage retains only matching last-known evidence and marks it stale", () => {
  const result = judge({
    live: null,
    lastKnown: local(),
    routeFailureCode: "DATABASE_UNREACHABLE",
  });
  assert.equal(result.evidenceSource, "last_known");
  assert.equal(result.state, "last_known");
  assert.equal(result.stale, true);
  assert.equal(result.routeFailureCode, "DATABASE_UNREACHABLE");
  assert.equal(result.completedRelease?.position, "2");
});

test("one unavailable provider has no effect on a healthy provider judgment", () => {
  const unavailable = judge({
    live: null,
    lastKnown: null,
    routeFailureCode: "DATABASE_UNREACHABLE",
  });
  const healthy = judge();
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.schedule, null);
  assert.equal(healthy.state, "current");
});

test("disabled retained-active and archived last-known remain visibly distinct", () => {
  const disabled = judge({
    roster: {
      providerKey: "alpha",
      displayName: "Alpha",
      lifecycle: "disabled",
    },
  });
  const archived = judge({
    roster: {
      providerKey: "alpha",
      displayName: "Alpha",
      lifecycle: "archived",
    },
    live: null,
    lastKnown: local(),
    routeFailureCode: null,
  });
  assert.equal(disabled.state, "inactive");
  assert.notEqual(disabled.activeRelease, null);
  assert.equal(archived.state, "last_known");
  assert.equal(archived.evidenceSource, "last_known");
});

test("a stale evaluator does not erase current publication facts", () => {
  const result = judge({ evaluatorCurrent: false });
  assert.equal(result.state, "current");
  assert.equal(result.stale, true);
  assert.equal(result.completedRelease?.position, "2");
});

test("invalid position evidence fails before the browser receives a judgment", () => {
  assert.throws(() => judge({
    live: local({ settledPosition: "02" }),
  }), { code: "PROMOTION_JOB_MONITORING_EVIDENCE_INVALID" });
});
