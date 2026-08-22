import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateMachineryConditions,
  evaluateRecomputationBacklog,
  evaluateRetentionCadence,
  evaluateRunStall,
  evaluateScheduleHealth,
  type MachineryCondition,
  type MachineryConditionFacts,
  type NotificationPublishResult,
  type OperationalNotification,
  type WorkerEffectiveSettings,
} from "@packscout/contracts";
import {
  MachineryAlertCycleError,
  MachineryAlertService,
  type MachineryAlertFacts,
  type MachineryAlertFactsSource,
  type MachineryAlertObserver,
  type OpenMachineryAlert,
} from "./machinery-alert-service.ts";
import {
  OperationalEventService,
  type NotificationPublisher,
} from "./operational-events.ts";
import {
  classifyWorkerPresence,
  isImportRunStalled,
  workerPresenceAgeMs,
} from "./worker-presence-service.ts";

/**
 * Alert generation for the machinery conditions, exercised at the exact instant
 * each threshold flips. Just under a threshold must stay silent, just over must
 * raise exactly one alert, a persisting condition must keep publishing the same
 * grouping key rather than a new alert, clearance must close it, and a
 * recurrence must raise again.
 *
 * The fleet-silence scenarios deliberately contain no live worker at all: the
 * condition being detected is that nothing is alive, so nothing alive may be
 * required to detect it.
 */

const organizationId = "9a000000-0000-4000-8000-000000000001";
const providerId = "9a000000-0000-4000-8000-000000000002";
const runId = "9a000000-0000-4000-8000-000000000003";
const now = new Date("2026-08-20T12:00:00.000Z");

const published: WorkerEffectiveSettings = {
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

/** One presence record as the fleet repository would return it. */
function instance(lastHeartbeatAt: Date) {
  return {
    state: "running" as const,
    lastHeartbeatAt,
    effectiveSettings: published,
  };
}

function fleetOf(records: readonly ReturnType<typeof instance>[]) {
  return {
    instances: records.map((record) => ({
      status: classifyWorkerPresence(record, now),
      heartbeatAgeMs: workerPresenceAgeMs(record, now),
    })),
  };
}

const healthyBacklog = evaluateRecomputationBacklog({
  now: now.toISOString(),
  pending: 0,
  readyPending: 0,
  claimed: 0,
  expiredClaims: 0,
  failed: 0,
  oldestPendingAvailableAt: null,
  timelyAfterMs: published.presenceStaleAfterMs,
  depthLimit: 10,
});

const currentRetention = evaluateRetentionCadence({
  now: now.toISOString(),
  expectedIntervalMs: published.presenceStaleAfterMs,
  latest: {
    state: "succeeded",
    startedAt: at(-1_000).toISOString(),
    finishedAt: at(-900).toISOString(),
    remaining: 4,
  },
});

/**
 * Facts with one live worker and nothing else wrong. Each test overrides only
 * the measure it is moving across a threshold, so every other condition stays
 * demonstrably silent.
 */
function facts(
  overrides: Partial<MachineryConditionFacts> = {},
): MachineryConditionFacts {
  const records = [instance(at(-1_000))];
  return {
    fleet: {
      state: "healthy",
      observed: records.length,
      live: 1,
      stale: 0,
      stopped: 0,
      silentForMs: null,
      stalledRuns: 0,
      wedgedSchedules: 0,
      ...(overrides.fleet ?? {}),
    },
    fleetStaleAfterMs: published.presenceStaleAfterMs,
    stalledRuns: [],
    schedules: [],
    backlog: healthyBacklog,
    retention: currentRetention,
    retentionFailureActive: false,
    ...overrides,
  };
}

function fleetFacts(records: readonly ReturnType<typeof instance>[]) {
  const evaluated = fleetOf(records);
  const live = evaluated.instances.filter(
    (entry) => entry.status === "running",
  ).length;
  const ages = evaluated.instances.map((entry) => entry.heartbeatAgeMs);
  return facts({
    fleet: {
      state:
        records.length === 0 ? "never_reported" : live > 0 ? "healthy" : "silent",
      observed: records.length,
      live,
      stale: evaluated.instances.length - live,
      stopped: 0,
      silentForMs:
        records.length === 0 || live > 0 ? null : Math.min(...ages),
      stalledRuns: 0,
      wedgedSchedules: 0,
    },
    fleetStaleAfterMs: records.length === 0 ? null : published.presenceStaleAfterMs,
  });
}

function kinds(conditions: readonly MachineryCondition[]): readonly string[] {
  return conditions.map((condition) => condition.kind);
}

test("a fleet inside its published window raises nothing, and one millisecond past it raises exactly one alert", () => {
  const justUnder = fleetFacts([instance(at(-published.presenceStaleAfterMs))]);
  assert.deepEqual(kinds(evaluateMachineryConditions(justUnder)), []);

  const justOver = fleetFacts([
    instance(at(-published.presenceStaleAfterMs - 1)),
  ]);
  const raised = evaluateMachineryConditions(justOver);
  assert.deepEqual(kinds(raised), ["worker_fleet_silent"]);
  const [condition] = raised;
  assert.ok(condition);
  assert.equal(condition.outcome, "WORKER_FLEET_SILENT");
  assert.equal(condition.threshold, "FLEET_PRESENCE_WINDOW");
  assert.equal(condition.observedMs, published.presenceStaleAfterMs + 1);
  assert.equal(condition.thresholdMs, published.presenceStaleAfterMs);
});

test("fleet silence still raises with no presence record at all, reporting the duration as unknown", () => {
  const raised = evaluateMachineryConditions(fleetFacts([]));
  assert.deepEqual(kinds(raised), ["worker_fleet_silent"]);
  const [condition] = raised;
  assert.ok(condition);
  assert.equal(condition.outcome, "WORKER_FLEET_NEVER_REPORTED");
  // No record exists to measure from, so no duration is reported — and none is
  // invented from the retention window either.
  assert.equal(condition.observedMs, null);
  assert.equal(condition.thresholdMs, null);
  assert.equal(condition.threshold, null);
  assert.equal(condition.observedCount, 0);
});

test("a running import run raises only once its own heartbeat passes the published window", () => {
  const stallAt = (offsetMs: number) => {
    const heartbeatAt = at(offsetMs);
    const stalled = isImportRunStalled(
      { state: "running", heartbeatAt, startedAt: at(-600_000) },
      { runHeartbeatStaleAfterMs: published.runHeartbeatStaleAfterMs },
      now,
    );
    return {
      runId,
      providerId,
      stall: evaluateRunStall({
        now: now.toISOString(),
        stalled,
        lastSignalAt: heartbeatAt.toISOString(),
        staleAfterMs: published.runHeartbeatStaleAfterMs,
      }),
    };
  };

  const justUnder = stallAt(-published.runHeartbeatStaleAfterMs);
  assert.deepEqual(
    kinds(evaluateMachineryConditions(facts({ stalledRuns: [justUnder] }))),
    [],
  );

  const justOver = stallAt(-published.runHeartbeatStaleAfterMs - 1);
  const raised = evaluateMachineryConditions(facts({ stalledRuns: [justOver] }));
  assert.deepEqual(kinds(raised), ["import_run_stalled"]);
  const [condition] = raised;
  assert.ok(condition);
  assert.equal(condition.runId, runId);
  assert.equal(condition.providerId, providerId);
  assert.equal(condition.thresholdMs, published.runHeartbeatStaleAfterMs);
  assert.equal(condition.observedMs, published.runHeartbeatStaleAfterMs + 1);
});

test("a schedule raises only past its overdue tolerance, and an expired claim outranks being late", () => {
  const scheduleAt = (dueOffsetMs: number, claimExpiresAt: string | null) => ({
    providerId,
    health: evaluateScheduleHealth({
      now: now.toISOString(),
      nextDueAt: at(dueOffsetMs).toISOString(),
      claimOwner: claimExpiresAt === null ? null : "worker-1",
      claimExpiresAt,
      lastClaimedAt: null,
      overdueAfterMs: published.presenceStaleAfterMs,
    }),
  });

  const justUnder = scheduleAt(-published.presenceStaleAfterMs, null);
  assert.deepEqual(
    kinds(evaluateMachineryConditions(facts({ schedules: [justUnder] }))),
    [],
  );

  const justOver = scheduleAt(-published.presenceStaleAfterMs - 1, null);
  const overdue = evaluateMachineryConditions(facts({ schedules: [justOver] }));
  assert.deepEqual(kinds(overdue), ["provider_schedule_overdue"]);
  assert.equal(overdue[0]?.outcome, "PROVIDER_SCHEDULE_OVERDUE");
  assert.equal(overdue[0]?.thresholdMs, published.presenceStaleAfterMs);

  const wedged = evaluateMachineryConditions(
    facts({ schedules: [scheduleAt(-1_000, at(-1).toISOString())] }),
  );
  assert.equal(wedged[0]?.outcome, "PROVIDER_SCHEDULE_CLAIM_EXPIRED");
  assert.equal(wedged[0]?.threshold, "SCHEDULE_CLAIM_EXPIRY");
});

test("the recomputation queue raises at its configured depth and at its timeliness window", () => {
  const queue = (pending: number, oldestOffsetMs: number) =>
    evaluateRecomputationBacklog({
      now: now.toISOString(),
      pending,
      readyPending: pending,
      claimed: 0,
      expiredClaims: 0,
      failed: 0,
      oldestPendingAvailableAt:
        pending === 0 ? null : at(oldestOffsetMs).toISOString(),
      timelyAfterMs: published.presenceStaleAfterMs,
      depthLimit: 2,
    });

  assert.deepEqual(
    kinds(evaluateMachineryConditions(facts({ backlog: queue(2, -1_000) }))),
    [],
  );
  const byDepth = evaluateMachineryConditions(
    facts({ backlog: queue(3, -1_000) }),
  );
  assert.deepEqual(kinds(byDepth), ["recomputation_backlogged"]);
  assert.equal(byDepth[0]?.threshold, "BACKLOG_QUEUE_DEPTH");
  assert.equal(byDepth[0]?.observedCount, 3);
  assert.equal(byDepth[0]?.thresholdCount, 2);

  assert.deepEqual(
    kinds(
      evaluateMachineryConditions(
        facts({ backlog: queue(1, -published.presenceStaleAfterMs) }),
      ),
    ),
    [],
  );
  const byAge = evaluateMachineryConditions(
    facts({ backlog: queue(1, -published.presenceStaleAfterMs - 1) }),
  );
  assert.deepEqual(kinds(byAge), ["recomputation_backlogged"]);
  assert.equal(byAge[0]?.threshold, "BACKLOG_OLDEST_PENDING_AGE");
  assert.equal(byAge[0]?.observedMs, published.presenceStaleAfterMs + 1);
});

test("retention raises past its expected interval, and never while a retention failure alert is open", () => {
  const cadence = (startedOffsetMs: number) =>
    evaluateRetentionCadence({
      now: now.toISOString(),
      expectedIntervalMs: published.presenceStaleAfterMs,
      latest: {
        state: "succeeded",
        startedAt: at(startedOffsetMs).toISOString(),
        finishedAt: at(startedOffsetMs + 100).toISOString(),
        remaining: 7,
      },
    });

  assert.deepEqual(
    kinds(
      evaluateMachineryConditions(
        facts({ retention: cadence(-published.presenceStaleAfterMs) }),
      ),
    ),
    [],
  );
  const overdue = evaluateMachineryConditions(
    facts({ retention: cadence(-published.presenceStaleAfterMs - 1) }),
  );
  assert.deepEqual(kinds(overdue), ["retention_overdue"]);
  assert.equal(overdue[0]?.thresholdMs, published.presenceStaleAfterMs);
  assert.equal(overdue[0]?.observedCount, 7);

  // The retention service already raised a failure alert for this situation.
  // Reporting it a second time as "stopped running" would be the same outage
  // under two names.
  assert.deepEqual(
    kinds(
      evaluateMachineryConditions(
        facts({
          retention: cadence(-published.presenceStaleAfterMs - 1),
          retentionFailureActive: true,
        }),
      ),
    ),
    [],
  );
});

class RecordingPublisher implements NotificationPublisher {
  readonly events: OperationalNotification[] = [];

  publish(event: OperationalNotification): Promise<NotificationPublishResult> {
    this.events.push(event);
    return Promise.resolve({
      status: "accepted",
      alertId: null,
      failureCode: null,
    });
  }
}

class ScriptedFactsSource implements MachineryAlertFactsSource {
  cycle = 0;

  constructor(private readonly script: readonly MachineryAlertFacts[]) {}

  listOrganizations(): Promise<readonly string[]> {
    return Promise.resolve([organizationId]);
  }

  readFacts(): Promise<MachineryAlertFacts> {
    const facts = this.script[this.cycle] ?? { conditions: [], openAlerts: [] };
    this.cycle += 1;
    return Promise.resolve(facts);
  }
}

function serviceFor(script: readonly MachineryAlertFacts[]) {
  const publisher = new RecordingPublisher();
  let issued = 0;
  const events = new OperationalEventService(
    publisher,
    {
      id: () =>
        `9a000000-0000-4000-8000-${String(++issued).padStart(12, "0")}`,
    },
    { now: () => new Date(now.getTime() + issued * 1_000) },
  );
  return {
    publisher,
    service: new MachineryAlertService(new ScriptedFactsSource(script), events),
  };
}

test("a condition already open is not published again, clearance closes it, and a recurrence publishes", async () => {
  const silent = fleetFacts([instance(at(-published.presenceStaleAfterMs - 1))]);
  const [condition] = evaluateMachineryConditions(silent);
  assert.ok(condition);
  const open: OpenMachineryAlert = {
    kind: condition.kind,
    recoveryKey: condition.recoveryKey,
    providerId: null,
    runId: null,
  };
  const { publisher, service } = serviceFor([
    // Raised.
    { conditions: [condition], openAlerts: [] },
    // Still holding, and already open: republishing would add another durable
    // event for a situation the operator can already see.
    { conditions: [condition], openAlerts: [open] },
    // Still holding after many more cycles: still nothing published.
    { conditions: [condition], openAlerts: [open] },
    // Cleared: the fleet is back, and an alert is open to close.
    { conditions: [], openAlerts: [open] },
    // Quiet: nothing to raise and nothing left open, so nothing is published.
    { conditions: [], openAlerts: [] },
    // Recurrence: the condition returns with no alert open, so it publishes.
    { conditions: [condition], openAlerts: [] },
  ]);

  const results = [];
  for (let cycle = 0; cycle < 6; cycle += 1) {
    results.push(await service.runCycle());
  }

  assert.deepEqual(
    results.map((result) => [result.raised, result.cleared]),
    [
      [1, 0],
      [0, 0],
      [0, 0],
      [0, 1],
      [0, 0],
      [1, 0],
    ],
  );
  assert.deepEqual(
    publisher.events.map((event) => event.kind),
    ["worker_fleet_silent", "machinery_recovered", "worker_fleet_silent"],
  );
  // One episode of a condition means one grouping key, not one key per cycle.
  const dedupeKeys = new Set(
    publisher.events
      .filter((event) => event.kind === "worker_fleet_silent")
      .map((event) => event.dedupeKey),
  );
  assert.equal(dedupeKeys.size, 1);
  // The recovery event carries the condition's recovery key, which is what the
  // durable alert lifecycle resolves by.
  assert.equal(publisher.events[1]?.recoveryKey, condition.recoveryKey);
  assert.equal(publisher.events[0]?.recoveryKey, condition.recoveryKey);
});

function eventsFor(publisher: RecordingPublisher): OperationalEventService {
  let issued = 0;
  return new OperationalEventService(
    publisher,
    {
      id: () =>
        `9a000000-0000-4000-8000-${String(++issued).padStart(12, "0")}`,
    },
    { now: () => new Date(now.getTime() + issued * 1_000) },
  );
}

test("a workspace that cannot be read never silences alerting for the rest, and is reported", async () => {
  const publisher = new RecordingPublisher();
  const events = eventsFor(publisher);
  const readable = "9a000000-0000-4000-8000-000000000009";
  const [condition] = evaluateMachineryConditions(fleetFacts([]));
  assert.ok(condition);
  const source: MachineryAlertFactsSource = {
    listOrganizations: () => Promise.resolve([organizationId, readable]),
    readFacts: (id) =>
      id === organizationId
        ? Promise.reject(new Error("unavailable"))
        : Promise.resolve({ conditions: [condition], openAlerts: [] }),
  };
  const failed: string[] = [];
  const observer: MachineryAlertObserver = {
    cycleCompleted() {},
    organizationFailed: (event) => void failed.push(event.organizationId),
  };

  const result = await new MachineryAlertService(
    source,
    events,
    observer,
  ).runCycle();

  assert.equal(result.failedOrganizations, 1);
  assert.equal(result.raised, 1);
  assert.equal(publisher.events.length, 1);
  assert.equal(publisher.events[0]?.organizationId, readable);
  // A degraded tenant is never only a counter the caller discards.
  assert.deepEqual(failed, [organizationId]);
});

test("a cycle that could not enumerate its workspaces fails rather than reporting a quiet cycle", async () => {
  const publisher = new RecordingPublisher();
  const completed: unknown[] = [];
  const source: MachineryAlertFactsSource = {
    listOrganizations: () => Promise.reject(new Error("unavailable")),
    readFacts: () => Promise.reject(new Error("unreachable")),
  };

  await assert.rejects(
    new MachineryAlertService(source, eventsFor(publisher), {
      cycleCompleted: (result) => void completed.push(result),
    }).runCycle(),
    (error: unknown) => {
      assert.ok(error instanceof MachineryAlertCycleError);
      assert.equal(error.code, "MACHINERY_ALERT_CYCLE_UNREADABLE");
      return true;
    },
  );
  // Nothing was evaluated, so no cycle is reported as having completed.
  assert.deepEqual(completed, []);
});

test("a facts repository broken for every workspace fails the cycle", async () => {
  const publisher = new RecordingPublisher();
  const failed: string[] = [];
  const readable = "9a000000-0000-4000-8000-000000000009";
  const source: MachineryAlertFactsSource = {
    listOrganizations: () => Promise.resolve([organizationId, readable]),
    readFacts: () => Promise.reject(new Error("unavailable")),
  };

  await assert.rejects(
    new MachineryAlertService(source, eventsFor(publisher), {
      cycleCompleted() {},
      organizationFailed: (event) => void failed.push(event.organizationId),
    }).runCycle(),
    MachineryAlertCycleError,
  );
  assert.deepEqual(failed, [organizationId, readable]);
});
