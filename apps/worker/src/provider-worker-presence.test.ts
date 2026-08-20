import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IDLE_WORKER_ACTIVITY,
  type WorkerActivity,
  type WorkerEffectiveSettings,
} from "@packscout/contracts";
import {
  WorkerPresenceService,
  type ProviderImportRunSummary,
  type WorkerPresenceStore,
} from "@packscout/services";
import {
  createProviderWorkerPresenceObserver,
  describeWorkerInstance,
  ProviderWorkerPresence,
  resolveWorkerEffectiveSettings,
  type ProviderWorkerHeartbeatTimer,
} from "./provider-worker-presence.ts";
import {
  ProviderWorkerRuntime,
  type ProviderWorkerLogEvent,
  type ProviderWorkerPresencePort,
} from "./provider-worker-runtime.ts";

const now = new Date("2026-08-19T18:00:00.000Z");
const scheduled = {
  organizationId: "7e000000-0000-4000-8000-000000000001",
  providerId: "7e000000-0000-4000-8000-000000000010",
  runId: "7e000000-0000-4000-8000-000000000030",
} as const;

const configuration = Object.freeze({
  heartbeatIntervalMilliseconds: 9_000,
  importRunLeaseMilliseconds: 111_000,
  presenceRetentionDays: 7,
  presenceStaleAfterMilliseconds: 45_000,
  runHeartbeatStaleAfterMilliseconds: 222_000,
  scheduleClaimLeaseMilliseconds: 33_000,
  workerHost: "worker-host-1",
  workerId: "worker:alpha:1",
  workerVersion: "3.2.1",
});

function terminalRun(): ProviderImportRunSummary {
  return {
    id: scheduled.runId,
    organizationId: scheduled.organizationId,
    providerId: scheduled.providerId,
    configRevisionId: "7e000000-0000-4000-8000-000000000020",
    trigger: "scheduled",
    state: "succeeded",
    requestedCursor: null,
    finalCursor: "provider-head",
    startedAt: now,
    finishedAt: now,
    heartbeatAt: now,
    counters: {
      accepted: 1,
      duplicate: 0,
      quarantined: 0,
      pages: 1,
      records: 1,
      requestAttempts: 1,
      transientRetries: 0,
    },
    reachedProviderHead: true,
    failureCode: null,
    failureSummary: null,
  };
}

function retentionRunner() {
  return {
    async runCycle() {
      return {
        cutoffAt: now.toISOString(),
        discoveredOrganizations: 0,
        attemptedOrganizations: 0,
        batchesRun: 0,
        expired: 0,
        failed: 0,
        knownRemaining: 0,
        deferredOrganizations: 0,
        capReached: false,
        prunedRecords: 0,
        prunedFailures: 0,
      };
    },
  };
}

function runtimeFor(
  presence: ProviderWorkerPresencePort,
  events: ProviderWorkerLogEvent[],
): ProviderWorkerRuntime {
  let claimAvailable = true;
  return new ProviderWorkerRuntime({
    scheduler: {
      async runOnce() {
        if (!claimAvailable) return { kind: "idle" };
        claimAvailable = false;
        return {
          kind: "started",
          organizationId: scheduled.organizationId,
          providerId: scheduled.providerId,
          configRevisionId: "7e000000-0000-4000-8000-000000000020",
          runId: scheduled.runId,
          nextDueAt: now,
        };
      },
    },
    imports: {
      async executeImport() {
        return terminalRun();
      },
      async executeNextImport() {
        return { kind: "idle" as const };
      },
    },
    retention: retentionRunner(),
    presence,
    logger: { write: (event) => void events.push(event) },
    workerId: configuration.workerId,
    pollIntervalMilliseconds: 100,
  });
}

function manualTimer() {
  let onTick: (() => void) | null = null;
  const intervals: number[] = [];
  let cancellations = 0;
  const timer: ProviderWorkerHeartbeatTimer = {
    schedule(intervalMilliseconds, tick) {
      intervals.push(intervalMilliseconds);
      onTick = tick;
      return () => {
        cancellations += 1;
        onTick = null;
      };
    },
  };
  return {
    timer,
    intervals,
    get cancellations() {
      return cancellations;
    },
    fire: () => onTick?.(),
  };
}

function recordingStore(overrides: Partial<WorkerPresenceStore> = {}) {
  const heartbeats: WorkerActivity[] = [];
  const calls: string[] = [];
  const store: WorkerPresenceStore = {
    async register() {
      calls.push("register");
      return undefined;
    },
    async heartbeat(input) {
      calls.push("heartbeat");
      heartbeats.push(input.activity);
      return true;
    },
    async markStopped() {
      calls.push("markStopped");
      return true;
    },
    ...overrides,
  };
  return { store, calls, heartbeats };
}

function presenceFor(
  store: WorkerPresenceStore,
  timer: ProviderWorkerHeartbeatTimer,
  events: ProviderWorkerLogEvent[] = [],
): ProviderWorkerPresence {
  const settings = resolveWorkerEffectiveSettings(configuration);
  return new ProviderWorkerPresence({
    service: new WorkerPresenceService({
      store,
      clock: { now: () => new Date(now) },
      descriptor: describeWorkerInstance(configuration, "v22.11.0"),
      effectiveSettings: settings,
      observer: createProviderWorkerPresenceObserver({
        write: (event) => void events.push(event),
      }),
    }),
    heartbeatIntervalMilliseconds: settings.heartbeatIntervalMs,
    timer,
  });
}

test("effective settings come from configuration and the retention invariant", () => {
  const settings: WorkerEffectiveSettings =
    resolveWorkerEffectiveSettings(configuration);

  assert.deepEqual(
    { ...settings },
    {
      heartbeatIntervalMs: 9_000,
      presenceStaleAfterMs: 45_000,
      runHeartbeatStaleAfterMs: 222_000,
      scheduleClaimLeaseMs: 33_000,
      importRunLeaseMs: 111_000,
      // Protected evidence retention is a policy invariant, so the published
      // window is the one the ingestion repository enforces.
      protectedPayloadRetentionDays: 90,
      presenceRetentionDays: 7,
    },
  );
  assert.deepEqual(describeWorkerInstance(configuration, "v22.11.0"), {
    instanceId: "worker:alpha:1",
    version: "3.2.1",
    host: "worker-host-1",
    runtimeVersion: "v22.11.0",
  });
});

test("the runtime publishes the provider and run it is working", async () => {
  const activities: WorkerActivity[] = [];
  const events: ProviderWorkerLogEvent[] = [];
  const runtime = runtimeFor(
    {
      start: async () => undefined,
      activity: (activity) => void activities.push(activity),
      stop: async () => undefined,
    },
    events,
  );

  const result = await runtime.runCycle();

  assert.equal(result.executions, 1);
  assert.equal(activities[0]?.kind, "scheduling");
  assert.deepEqual(
    activities.find(({ kind }) => kind === "importing"),
    {
      kind: "importing",
      organizationId: scheduled.organizationId,
      providerId: scheduled.providerId,
      runId: scheduled.runId,
    },
  );
  assert.equal(
    activities.some(({ kind }) => kind === "retention"),
    true,
  );
  assert.deepEqual(activities.at(-1), IDLE_WORKER_ACTIVITY);
});

test("a heartbeat write failure does not interrupt import work", async () => {
  const events: ProviderWorkerLogEvent[] = [];
  const timer = manualTimer();
  const presence = presenceFor(
    {
      async register() {
        return undefined;
      },
      async heartbeat() {
        throw new Error("postgresql://worker:secret@db.test/packscout");
      },
      async markStopped() {
        return true;
      },
    },
    timer.timer,
    events,
  );
  const runtime = runtimeFor(presence, events);

  await presence.start();
  const result = await runtime.runCycle();
  timer.fire();
  await presence.stop();

  // The import still ran to completion despite every heartbeat failing.
  assert.deepEqual(result, {
    claims: 1,
    executions: 1,
    contentions: 0,
    failures: 0,
    reason: "idle",
  });
  assert.equal(
    events.some(({ event }) => event === "provider_import_finished"),
    true,
  );

  const degraded = events.filter(
    ({ event }) => event === "provider_worker_presence_degraded",
  );
  assert.ok(degraded.length > 0, "degradation is visible in structured logs");
  assert.equal(degraded[0]?.level, "error");
  assert.equal(degraded[0]?.failureCode, "WORKER_PRESENCE_WRITE_FAILED");
  assert.equal(degraded[0]?.workerId, "worker:alpha:1");
  assert.equal(degraded.at(-1)?.presenceFailures, degraded.length);
  // Failures are reported as stable codes, never as raw connection details.
  for (const event of events) {
    assert.doesNotMatch(JSON.stringify(event), /secret|db\.test/);
  }
});

test("presence beats on the published cadence and stops cleanly", async () => {
  const timer = manualTimer();
  const { store, calls, heartbeats } = recordingStore();
  const presence = presenceFor(store, timer.timer);

  await presence.start();
  assert.deepEqual(timer.intervals, [9_000]);
  assert.deepEqual(calls, ["register"]);

  timer.fire();
  timer.fire();
  presence.activity({
    kind: "importing",
    organizationId: scheduled.organizationId,
    providerId: scheduled.providerId,
    runId: scheduled.runId,
  });

  await presence.stop();

  assert.equal(timer.cancellations, 1);
  assert.deepEqual(calls, [
    "register",
    "heartbeat",
    "heartbeat",
    "heartbeat",
    "markStopped",
  ]);
  assert.equal(heartbeats.at(-1)?.runId, scheduled.runId);

  // A stopped reporter no longer beats, and stopping twice is harmless.
  timer.fire();
  await presence.stop();
  assert.equal(calls.filter((call) => call === "markStopped").length, 1);
});

test("presence cadence outside its bounds is rejected at construction", () => {
  const build = (heartbeatIntervalMilliseconds: number) =>
    new ProviderWorkerPresence({
      service: new WorkerPresenceService({
        store: recordingStore().store,
        clock: { now: () => new Date(now) },
        descriptor: describeWorkerInstance(configuration, "v22.11.0"),
        effectiveSettings: resolveWorkerEffectiveSettings(configuration),
      }),
      heartbeatIntervalMilliseconds,
    });

  assert.throws(() => build(999), /cadence is outside its bounds/);
  assert.throws(() => build(300_001), /cadence is outside its bounds/);
  assert.throws(() => build(1_500.5), /cadence is outside its bounds/);
});
