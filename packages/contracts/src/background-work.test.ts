import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateRecomputationBacklog,
  evaluateRetentionCadence,
  resolveBackgroundWorkTimelinessMs,
  type RecomputationBacklogFacts,
  type RetentionCadenceFacts,
  type WorkerEffectiveSettings,
} from "./index.ts";

const now = "2026-08-19T12:00:00.000Z";

function settings(
  presenceStaleAfterMs: number,
): WorkerEffectiveSettings {
  return {
    heartbeatIntervalMs: 15_000,
    presenceStaleAfterMs,
    runHeartbeatStaleAfterMs: 300_000,
    scheduleClaimLeaseMs: 30_000,
    importRunLeaseMs: 120_000,
    protectedPayloadRetentionDays: 90,
    presenceRetentionDays: 14,
  };
}

function backlog(
  overrides: Partial<RecomputationBacklogFacts> = {},
): RecomputationBacklogFacts {
  return {
    now,
    pending: 0,
    readyPending: 0,
    claimed: 0,
    expiredClaims: 0,
    failed: 0,
    oldestPendingAvailableAt: null,
    timelyAfterMs: 60_000,
    ...overrides,
  };
}

function cadence(
  overrides: Partial<RetentionCadenceFacts> = {},
): RetentionCadenceFacts {
  return { now, expectedIntervalMs: 60_000, latest: null, ...overrides };
}

test("the timeliness threshold comes from published settings, never a local copy", () => {
  assert.equal(resolveBackgroundWorkTimelinessMs([]), null);
  assert.equal(
    resolveBackgroundWorkTimelinessMs([settings(60_000), settings(180_000)]),
    180_000,
  );
  // A published value outside its bounds cannot widen the window.
  assert.equal(
    resolveBackgroundWorkTimelinessMs([
      { ...settings(60_000), presenceStaleAfterMs: 0 },
    ]),
    null,
  );
});

test("queue depth and oldest-pending age are derived once, server-side", () => {
  const evaluation = evaluateRecomputationBacklog(
    backlog({
      pending: 4,
      readyPending: 3,
      claimed: 2,
      oldestPendingAvailableAt: "2026-08-19T11:59:30.000Z",
    }),
  );
  assert.equal(evaluation.depth, 6);
  assert.equal(evaluation.oldestPendingAgeMs, 30_000);
  assert.equal(evaluation.state, "healthy");

  assert.equal(evaluateRecomputationBacklog(backlog()).state, "idle");
  assert.equal(
    evaluateRecomputationBacklog(
      backlog({
        pending: 1,
        readyPending: 1,
        oldestPendingAvailableAt: "2026-08-19T11:57:00.000Z",
      }),
    ).state,
    "backlogged",
  );
  assert.equal(
    evaluateRecomputationBacklog(backlog({ claimed: 1, expiredClaims: 1 })).state,
    "backlogged",
  );
  assert.equal(evaluateRecomputationBacklog(backlog({ failed: 2 })).state, "backlogged");
  // Without a published window, timeliness is unknown rather than assumed.
  assert.equal(
    evaluateRecomputationBacklog(
      backlog({
        pending: 1,
        readyPending: 1,
        timelyAfterMs: null,
        oldestPendingAvailableAt: "2026-08-01T00:00:00.000Z",
      }),
    ).state,
    "unknown",
  );
});

test("a configured depth ceiling backs the queue up before anything is late", () => {
  const queue = (pending: number, depthLimit: number | null) =>
    evaluateRecomputationBacklog(
      backlog({
        pending,
        readyPending: pending,
        oldestPendingAvailableAt: "2026-08-19T11:59:30.000Z",
        depthLimit,
      }),
    );

  // Every entry is inside the timeliness window; only the ceiling decides.
  assert.equal(queue(2, 2).state, "healthy");
  assert.equal(queue(3, 2).state, "backlogged");
  assert.equal(queue(3, 2).depthLimit, 2);
  // No ceiling configured leaves depth reported but never judged, so the
  // measure stays visible without inventing a threshold.
  assert.equal(queue(500, null).state, "healthy");
  assert.equal(queue(500, null).depth, 500);
  assert.equal(queue(500, null).depthLimit, null);
  // A ceiling outside its bounds is ignored rather than silencing the queue.
  assert.equal(queue(3, 0).depthLimit, null);
});

test("negative or fractional counts cannot distort the backlog measures", () => {
  const evaluation = evaluateRecomputationBacklog(
    backlog({ pending: -5, readyPending: 9, claimed: 1.5, expiredClaims: 9, failed: -1 }),
  );
  assert.deepEqual(
    {
      pending: evaluation.pending,
      readyPending: evaluation.readyPending,
      claimed: evaluation.claimed,
      expiredClaims: evaluation.expiredClaims,
      failed: evaluation.failed,
      depth: evaluation.depth,
    },
    { pending: 0, readyPending: 0, claimed: 0, expiredClaims: 0, failed: 0, depth: 0 },
  );
});

test("retention overdue distinguishes silence with work left from nothing to clear", () => {
  assert.equal(evaluateRetentionCadence(cadence()).state, "never_observed");
  assert.equal(
    evaluateRetentionCadence(cadence({ expectedIntervalMs: null })).state,
    "unknown",
  );

  const finished = {
    state: "succeeded" as const,
    startedAt: "2026-08-19T11:59:30.000Z",
    finishedAt: "2026-08-19T11:59:31.000Z",
    remaining: 0,
  };
  assert.equal(evaluateRetentionCadence(cadence({ latest: finished })).state, "current");

  const lapsed = { ...finished, startedAt: "2026-08-19T11:50:00.000Z", finishedAt: "2026-08-19T11:50:01.000Z" };
  assert.equal(evaluateRetentionCadence(cadence({ latest: lapsed })).state, "idle");

  const overdue = evaluateRetentionCadence(
    cadence({ latest: { ...lapsed, remaining: 12 } }),
  );
  assert.equal(overdue.state, "overdue");
  assert.equal(overdue.sinceLastStartMs, 600_000);
  assert.equal(overdue.overdueByMs, 540_000);
  assert.equal(overdue.knownRemaining, 12);

  // An execution that never finished is overdue even with nothing left behind.
  assert.equal(
    evaluateRetentionCadence(
      cadence({
        latest: { state: "running", startedAt: lapsed.startedAt, finishedAt: null, remaining: 0 },
      }),
    ).state,
    "overdue",
  );
});
