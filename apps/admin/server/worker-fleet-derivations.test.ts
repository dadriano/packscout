import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateRunStall,
  evaluateScheduleHealth,
  evaluateWorkerFleet,
  isScheduleWedged,
  resolveWorkerFleetSettings,
  type WorkerEffectiveSettings,
} from "@packscout/contracts";
import {
  classifyWorkerPresence,
  isImportRunStalled,
  workerPresenceAgeMs,
} from "@packscout/services";

/**
 * The conditions the admin renders and admin-tools/009 alerts on are one
 * evaluation, so they are exercised here at the exact instants they flip. A
 * threshold that behaved differently by a millisecond on either surface would
 * let the page and the alert disagree about the same fleet.
 */

const now = new Date("2026-08-20T12:00:00.000Z");
const settings: WorkerEffectiveSettings = {
  heartbeatIntervalMs: 15_000,
  presenceStaleAfterMs: 60_000,
  runHeartbeatStaleAfterMs: 300_000,
  scheduleClaimLeaseMs: 120_000,
  importRunLeaseMs: 600_000,
  protectedPayloadRetentionDays: 90,
  presenceRetentionDays: 30,
};

function at(offsetMs: number): Date {
  return new Date(now.getTime() + offsetMs);
}

function presence(lastHeartbeatAt: Date, state: "running" | "stopped" = "running") {
  return {
    state,
    lastHeartbeatAt,
    effectiveSettings: { presenceStaleAfterMs: settings.presenceStaleAfterMs },
  };
}

test("instance staleness flips exactly at the window the instance published", () => {
  const justUnder = presence(at(-settings.presenceStaleAfterMs));
  const justOver = presence(at(-settings.presenceStaleAfterMs - 1));

  assert.equal(classifyWorkerPresence(justUnder, now), "running");
  assert.equal(classifyWorkerPresence(justOver, now), "stale");
  assert.equal(workerPresenceAgeMs(justUnder, now), settings.presenceStaleAfterMs);
  assert.equal(
    workerPresenceAgeMs(justOver, now),
    settings.presenceStaleAfterMs + 1,
  );

  // A cleanly stopped instance is never "stale": it is not presumed dead, it
  // said it was leaving.
  assert.equal(
    classifyWorkerPresence(presence(at(-86_400_000), "stopped"), now),
    "stopped",
  );
  // A heartbeat from the future cannot produce a negative age.
  assert.equal(workerPresenceAgeMs(presence(at(60_000)), now), 0);
});

test("run stall flips exactly at the published run-heartbeat window", () => {
  const window = settings.runHeartbeatStaleAfterMs;
  const running = (heartbeatAt: Date) =>
    ({ state: "running", heartbeatAt, startedAt: at(-window * 4) }) as const;

  assert.equal(isImportRunStalled(running(at(-window)), settings, now), false);
  assert.equal(isImportRunStalled(running(at(-window - 1)), settings, now), true);

  // A run that never beat is judged from its start instead.
  assert.equal(
    isImportRunStalled(
      { state: "running", heartbeatAt: null, startedAt: at(-window) },
      settings,
      now,
    ),
    false,
  );
  assert.equal(
    isImportRunStalled(
      { state: "running", heartbeatAt: null, startedAt: at(-window - 1) },
      settings,
      now,
    ),
    true,
  );
  // Only running work can stall; a finished run is history, not machinery.
  assert.equal(
    isImportRunStalled(
      { state: "failed", heartbeatAt: at(-window * 10), startedAt: at(-window * 10) },
      settings,
      now,
    ),
    false,
  );
});

test("stall measures describe how far past the window a run is", () => {
  const evaluation = evaluateRunStall({
    now: now.toISOString(),
    stalled: true,
    lastSignalAt: at(-settings.runHeartbeatStaleAfterMs - 45_000).toISOString(),
    staleAfterMs: settings.runHeartbeatStaleAfterMs,
  });
  assert.deepEqual(evaluation, {
    stalled: true,
    heartbeatAgeMs: settings.runHeartbeatStaleAfterMs + 45_000,
    staleAfterMs: settings.runHeartbeatStaleAfterMs,
    overdueByMs: 45_000,
  });

  // No published window means no overdue measure, never a fabricated zero.
  assert.deepEqual(
    evaluateRunStall({
      now: now.toISOString(),
      stalled: false,
      lastSignalAt: null,
      staleAfterMs: null,
    }),
    {
      stalled: false,
      heartbeatAgeMs: null,
      staleAfterMs: null,
      overdueByMs: null,
    },
  );
});

test("schedule health flips at the tolerance the fleet published", () => {
  const tolerance = settings.presenceStaleAfterMs;
  const schedule = (overdueByMs: number) => ({
    now: now.toISOString(),
    nextDueAt: at(-overdueByMs).toISOString(),
    claimOwner: null,
    claimExpiresAt: null,
    lastClaimedAt: null,
    overdueAfterMs: tolerance,
  });

  assert.equal(evaluateScheduleHealth(schedule(-1)).state, "scheduled");
  assert.equal(evaluateScheduleHealth(schedule(0)).state, "due");
  assert.equal(evaluateScheduleHealth(schedule(tolerance)).state, "due");
  const overdue = evaluateScheduleHealth(schedule(tolerance + 1));
  assert.equal(overdue.state, "overdue");
  assert.equal(overdue.overdueByMs, tolerance + 1);
  assert.equal(overdue.overdueAfterMs, tolerance);

  // Without published settings a late schedule is reported as due, never judged
  // overdue against a threshold that does not exist.
  assert.equal(
    evaluateScheduleHealth({
      ...schedule(tolerance * 100),
      overdueAfterMs: null,
    }).state,
    "due",
  );
});

test("a claim held past its expiry outranks being past due", () => {
  const wedged = evaluateScheduleHealth({
    now: now.toISOString(),
    nextDueAt: at(-3_600_000).toISOString(),
    claimOwner: "worker:departed:1",
    claimExpiresAt: now.toISOString(),
    lastClaimedAt: at(-3_500_000).toISOString(),
    overdueAfterMs: settings.presenceStaleAfterMs,
  });
  assert.equal(wedged.state, "claim_expired");
  assert.equal(wedged.claimExpired, true);
  assert.equal(wedged.claimHeldForMs, 3_500_000);
  assert.equal(isScheduleWedged(wedged), true);

  // One millisecond before expiry the claim is still a worker's to finish.
  const active = evaluateScheduleHealth({
    now: now.toISOString(),
    nextDueAt: at(-3_600_000).toISOString(),
    claimOwner: "worker:alive:1",
    claimExpiresAt: at(1).toISOString(),
    lastClaimedAt: at(-1_000).toISOString(),
    overdueAfterMs: settings.presenceStaleAfterMs,
  });
  assert.equal(active.state, "overdue");
  assert.equal(active.claimExpired, false);
  assert.equal(isScheduleWedged(active), true);

  // An expiry timestamp with no owner is stale bookkeeping, not a held claim.
  assert.equal(
    evaluateScheduleHealth({
      now: now.toISOString(),
      nextDueAt: at(60_000).toISOString(),
      claimOwner: null,
      claimExpiresAt: at(-60_000).toISOString(),
      lastClaimedAt: null,
      overdueAfterMs: settings.presenceStaleAfterMs,
    }).state,
    "scheduled",
  );
});

test("fleet silence is reported with a measured duration, never an invented one", () => {
  const emptyFleet = evaluateWorkerFleet({
    now: now.toISOString(),
    instances: [],
    stalledRuns: 0,
    wedgedSchedules: 0,
  });
  assert.equal(emptyFleet.state, "never_reported");
  assert.equal(emptyFleet.silentForMs, null);
  assert.equal(emptyFleet.observed, 0);

  // Silence is measured from the most recent heartbeat anyone published.
  const silent = evaluateWorkerFleet({
    now: now.toISOString(),
    instances: [
      { status: "stale", heartbeatAgeMs: 900_000 },
      { status: "stale", heartbeatAgeMs: 420_000 },
      { status: "stopped", heartbeatAgeMs: 3_600_000 },
    ],
    stalledRuns: 2,
    wedgedSchedules: 1,
  });
  assert.equal(silent.state, "silent");
  assert.equal(silent.silentForMs, 420_000);
  assert.equal(silent.live, 0);
  assert.equal(silent.stale, 2);
  assert.equal(silent.stopped, 1);
  assert.equal(silent.stalledRuns, 2);
  assert.equal(silent.wedgedSchedules, 1);

  // A fleet with a stopped instance and no records at all are different facts.
  assert.notEqual(emptyFleet.state, silent.state);
});

test("a live fleet is healthy only when nothing is stale, stalled, or wedged", () => {
  const facts = {
    now: now.toISOString(),
    instances: [{ status: "running" as const, heartbeatAgeMs: 5_000 }],
    stalledRuns: 0,
    wedgedSchedules: 0,
  };
  const healthy = evaluateWorkerFleet(facts);
  assert.equal(healthy.state, "healthy");
  assert.equal(healthy.silentForMs, null);

  assert.equal(
    evaluateWorkerFleet({ ...facts, stalledRuns: 1 }).state,
    "degraded",
  );
  assert.equal(
    evaluateWorkerFleet({ ...facts, wedgedSchedules: 1 }).state,
    "degraded",
  );
  assert.equal(
    evaluateWorkerFleet({
      ...facts,
      instances: [...facts.instances, { status: "stale", heartbeatAgeMs: 999_000 }],
    }).state,
    "degraded",
  );
  // An idle-but-live fleet is healthy: idleness is not absence.
  assert.equal(evaluateWorkerFleet(facts).live, 1);
});

test("published settings resolve to the most permissive value across the fleet", () => {
  assert.deepEqual(resolveWorkerFleetSettings([]), {
    settings: null,
    source: "none",
    publishers: 0,
  });

  const uniform = resolveWorkerFleetSettings([settings, { ...settings }]);
  assert.equal(uniform.source, "uniform");
  assert.equal(uniform.publishers, 2);
  assert.deepEqual(uniform.settings, settings);

  const mixed = resolveWorkerFleetSettings([
    settings,
    { ...settings, presenceStaleAfterMs: 90_000, presenceRetentionDays: 7 },
  ]);
  assert.equal(mixed.source, "mixed");
  assert.equal(mixed.publishers, 2);
  assert.equal(mixed.settings?.presenceStaleAfterMs, 90_000);
  assert.equal(mixed.settings?.presenceRetentionDays, 30);

  // A malformed publication is ignored rather than governing the fleet.
  const malformed = resolveWorkerFleetSettings([
    { ...settings, presenceStaleAfterMs: 0 },
    settings,
  ]);
  assert.equal(malformed.publishers, 1);
  assert.deepEqual(malformed.settings, settings);
});
