import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionJobSchedule } from "@packscout/database";
import {
  canRecoverPromotionJobScheduleCondition,
  evaluatePromotionJobScheduleLiveness,
  summarizePromotionJobLivenessCycle,
} from "./promotion-job-liveness.ts";

const baseline = new Date("2026-09-01T12:00:00.000Z");

function schedule(
  overrides: Partial<PromotionJobSchedule> = {},
): PromotionJobSchedule {
  return {
    authority: "provider_publication",
    lifecycle: "active",
    scheduleEpoch: 1n,
    cadenceSeconds: 60,
    baselineAt: baseline,
    activatedAt: baseline,
    pausedAt: null,
    lastAdmittedWindowIndex: 0n,
    lastScheduledCheckinAt: null,
    nextExpectedCheckinAt: new Date("2026-09-01T12:01:00.000Z"),
    ...overrides,
  };
}

test("strict due boundaries count one, two, then three missed windows", () => {
  const atTwoMinutes = evaluatePromotionJobScheduleLiveness(
    schedule(),
    new Date("2026-09-01T12:02:00.000Z"),
  );
  assert.deepEqual(
    [atTwoMinutes.latestCountableWindowIndex, atTwoMinutes.missedWindowCount,
      atTwoMinutes.health],
    [1n, 1n, "healthy"],
  );

  const justAfterTwo = evaluatePromotionJobScheduleLiveness(
    schedule(),
    new Date("2026-09-01T12:02:00.001Z"),
  );
  assert.deepEqual(
    [justAfterTwo.latestCountableWindowIndex, justAfterTwo.missedWindowCount,
      justAfterTwo.health],
    [2n, 2n, "overdue"],
  );

  const justAfterThree = evaluatePromotionJobScheduleLiveness(
    schedule(),
    new Date("2026-09-01T12:03:00.001Z"),
  );
  assert.deepEqual(
    [justAfterThree.latestCountableWindowIndex,
      justAfterThree.missedWindowCount, justAfterThree.health],
    [3n, 3n, "alerting"],
  );
});

test("an exact-due check-in stays on time and non-cron work cannot invent it", () => {
  const checkedIn = evaluatePromotionJobScheduleLiveness(schedule({
    lastAdmittedWindowIndex: 2n,
    lastScheduledCheckinAt: new Date("2026-09-01T12:02:00.000Z"),
  }), new Date("2026-09-01T12:02:00.000Z"));
  assert.equal(checkedIn.missedWindowCount, 0n);
  assert.equal(checkedIn.health, "healthy");

  const manualOnly = evaluatePromotionJobScheduleLiveness(schedule({
    lastAdmittedWindowIndex: 0n,
    lastScheduledCheckinAt: null,
  }), new Date("2026-09-01T12:03:00.001Z"));
  assert.equal(manualOnly.health, "alerting");
});

test("pending and paused schedules do not accrue missed windows", () => {
  for (const lifecycle of ["pending_activation", "paused"] as const) {
    const judgment = evaluatePromotionJobScheduleLiveness(schedule({
      lifecycle,
      scheduleEpoch: lifecycle === "pending_activation" ? 0n : 2n,
      baselineAt: lifecycle === "pending_activation" ? null : baseline,
    }), new Date("2026-09-01T18:00:00.000Z"));
    assert.equal(judgment.health, "inactive");
    assert.equal(judgment.missedWindowCount, 0n);
  }
});

test("recovery requires a newer trusted cron check-in or trusted lifecycle change", () => {
  const anchor = {
    scheduleEpoch: 4n,
    lastScheduledCheckinAt: new Date("2026-09-01T12:00:00.000Z"),
  };
  const sameCheckin = evaluatePromotionJobScheduleLiveness(schedule({
    scheduleEpoch: 4n,
    lastAdmittedWindowIndex: 3n,
    lastScheduledCheckinAt: anchor.lastScheduledCheckinAt,
  }), new Date("2026-09-01T12:03:00.001Z"));
  assert.equal(canRecoverPromotionJobScheduleCondition(anchor, {
    evidenceSource: "live",
    judgment: sameCheckin,
  }), false);
  assert.equal(canRecoverPromotionJobScheduleCondition(anchor, {
    evidenceSource: "unavailable",
    judgment: sameCheckin,
  }), false);

  const newerCheckin = evaluatePromotionJobScheduleLiveness(schedule({
    scheduleEpoch: 4n,
    lastAdmittedWindowIndex: 3n,
    lastScheduledCheckinAt: new Date("2026-09-01T12:03:00.000Z"),
  }), new Date("2026-09-01T12:03:00.001Z"));
  assert.equal(canRecoverPromotionJobScheduleCondition(anchor, {
    evidenceSource: "live",
    judgment: newerCheckin,
  }), true);

  const paused = evaluatePromotionJobScheduleLiveness(schedule({
    lifecycle: "paused",
    scheduleEpoch: 4n,
    pausedAt: new Date("2026-09-01T12:04:00.000Z"),
  }), new Date("2026-09-01T12:04:00.000Z"));
  assert.equal(canRecoverPromotionJobScheduleCondition(anchor, {
    evidenceSource: "live",
    judgment: paused,
  }), true);
});

test("dynamic roster summaries preserve one unavailable provider row", () => {
  const healthy = evaluatePromotionJobScheduleLiveness(schedule({
    lastAdmittedWindowIndex: 1n,
    lastScheduledCheckinAt: new Date("2026-09-01T12:01:00.000Z"),
  }), new Date("2026-09-01T12:02:00.000Z"));
  const alerting = evaluatePromotionJobScheduleLiveness(
    schedule(),
    new Date("2026-09-01T12:03:00.001Z"),
  );
  const summary = summarizePromotionJobLivenessCycle({
    providerObservations: [{ evidenceSource: "live", judgment: healthy }, {
      evidenceSource: "unavailable",
      judgment: alerting,
    }],
    manifestObservation: { evidenceSource: "live", judgment: alerting },
  });
  assert.deepEqual(summary, {
    expectedCount: 3,
    reachableCount: 2,
    unavailableCount: 1,
    healthyCount: 1,
    overdueCount: 0,
    alertingCount: 1,
  });
});
