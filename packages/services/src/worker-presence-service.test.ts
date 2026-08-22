import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IDLE_WORKER_ACTIVITY,
  type WorkerActivity,
  type WorkerEffectiveSettings,
} from "@packscout/contracts";
import {
  classifyWorkerPresence,
  isImportRunStalled,
  workerPresenceAgeMs,
  WorkerPresenceService,
  type WorkerPresenceObserver,
  type WorkerPresenceStore,
} from "./worker-presence-service.ts";

const now = new Date("2026-08-19T12:00:00.000Z");

const settings: WorkerEffectiveSettings = Object.freeze({
  heartbeatIntervalMs: 15_000,
  presenceStaleAfterMs: 60_000,
  runHeartbeatStaleAfterMs: 300_000,
  scheduleClaimLeaseMs: 30_000,
  importRunLeaseMs: 120_000,
  protectedPayloadRetentionDays: 90,
  presenceRetentionDays: 14,
});

const descriptor = Object.freeze({
  instanceId: "worker:alpha:1",
  version: "1.0.0",
  host: "worker-host-1",
  runtimeVersion: "v22.11.0",
});

const importing: WorkerActivity = Object.freeze({
  kind: "importing",
  organizationId: "7b000000-0000-4000-8000-000000000001",
  providerId: "7b000000-0000-4000-8000-000000000010",
  runId: "7b000000-0000-4000-8000-000000000030",
});

class RecordingObserver implements WorkerPresenceObserver {
  readonly reports: string[] = [];
  readonly degradations: {
    kind: string;
    failureCode: string;
    consecutiveFailures: number;
  }[] = [];

  reported(event: Parameters<WorkerPresenceObserver["reported"]>[0]): void {
    this.reports.push(`${event.kind}:${event.activity.kind}`);
  }

  degraded(event: Parameters<WorkerPresenceObserver["degraded"]>[0]): void {
    this.degradations.push({
      kind: event.kind,
      failureCode: event.failureCode,
      consecutiveFailures: event.consecutiveFailures,
    });
  }
}

function stubStore(overrides: Partial<WorkerPresenceStore> = {}) {
  const calls: string[] = [];
  const store: WorkerPresenceStore = {
    async register() {
      calls.push("register");
      return undefined;
    },
    async heartbeat() {
      calls.push("heartbeat");
      return true;
    },
    async markStopped() {
      calls.push("markStopped");
      return true;
    },
    ...overrides,
  };
  return { store, calls };
}

function serviceFor(
  store: WorkerPresenceStore,
  observer?: WorkerPresenceObserver,
) {
  return new WorkerPresenceService({
    store,
    clock: { now: () => new Date(now) },
    descriptor,
    effectiveSettings: settings,
    ...(observer ? { observer } : {}),
  });
}

test("presence reporting publishes identity, settings, and activity", async () => {
  const registrations: unknown[] = [];
  const heartbeats: unknown[] = [];
  const { store } = stubStore({
    async register(input) {
      registrations.push(input);
      return undefined;
    },
    async heartbeat(input) {
      heartbeats.push(input);
      return true;
    },
  });
  const observer = new RecordingObserver();
  const service = serviceFor(store, observer);

  assert.equal(service.instanceId, "worker:alpha:1");
  assert.deepEqual({ ...service.effectiveSettings }, { ...settings });

  assert.equal(await service.register(), true);
  assert.equal(await service.heartbeat(importing), true);
  assert.deepEqual(service.currentActivity, importing);
  assert.equal(await service.stop(), true);

  assert.deepEqual(registrations, [
    { descriptor, startedAt: now, effectiveSettings: settings },
  ]);
  assert.deepEqual(heartbeats, [
    { instanceId: "worker:alpha:1", observedAt: now, activity: importing },
  ]);
  assert.deepEqual(observer.reports, [
    "register:idle",
    "heartbeat:importing",
    "stop:idle",
  ]);
  assert.deepEqual(observer.degradations, []);
});

test("a heartbeat write failure degrades visibly and never throws", async () => {
  let attempts = 0;
  const { store } = stubStore({
    async heartbeat() {
      attempts += 1;
      if (attempts <= 2) throw new Error("postgres unavailable");
      return true;
    },
  });
  const observer = new RecordingObserver();
  const service = serviceFor(store, observer);
  await service.register();

  assert.equal(await service.heartbeat(importing), false);
  assert.equal(await service.heartbeat(importing), false);
  assert.equal(service.consecutiveFailures, 2);
  assert.equal(await service.heartbeat(importing), true);
  assert.equal(service.consecutiveFailures, 0);

  assert.deepEqual(observer.degradations, [
    {
      kind: "heartbeat",
      failureCode: "WORKER_PRESENCE_WRITE_FAILED",
      consecutiveFailures: 1,
    },
    {
      kind: "heartbeat",
      failureCode: "WORKER_PRESENCE_WRITE_FAILED",
      consecutiveFailures: 2,
    },
  ]);
  // Recovery after failures is reported so operators can see the gap close.
  assert.deepEqual(observer.reports, ["register:idle", "heartbeat:importing"]);
});

test("a vanished presence record is re-registered on the next beat", async () => {
  // The record survives exactly one heartbeat, then disappears as if pruned.
  let recordExists = false;
  const calls: string[] = [];
  const observer = new RecordingObserver();
  const { store } = stubStore({
    async register() {
      calls.push("register");
      recordExists = true;
      return undefined;
    },
    async heartbeat() {
      calls.push("heartbeat");
      const existed = recordExists;
      recordExists = false;
      return existed;
    },
  });
  const service = serviceFor(store, observer);

  await service.register();
  assert.equal(await service.heartbeat(IDLE_WORKER_ACTIVITY), true);
  // The row is gone (pruned or never written); the next beat re-registers.
  assert.equal(await service.heartbeat(IDLE_WORKER_ACTIVITY), false);
  assert.equal(await service.heartbeat(IDLE_WORKER_ACTIVITY), true);

  assert.deepEqual(calls, [
    "register",
    "heartbeat",
    "heartbeat",
    "register",
    "heartbeat",
  ]);
  assert.deepEqual(observer.degradations, [
    {
      kind: "heartbeat",
      failureCode: "WORKER_PRESENCE_RECORD_MISSING",
      consecutiveFailures: 1,
    },
  ]);
});

test("registration failure leaves the instance reporting rather than silent", async () => {
  let failRegistration = true;
  const { store } = stubStore({
    async register() {
      if (failRegistration) throw new Error("postgres unavailable");
      return undefined;
    },
  });
  const observer = new RecordingObserver();
  const service = serviceFor(store, observer);

  assert.equal(await service.register(), false);
  assert.equal(await service.heartbeat(importing), false);
  failRegistration = false;
  assert.equal(await service.heartbeat(importing), true);

  assert.deepEqual(
    observer.degradations.map(({ kind, failureCode }) => `${kind}:${failureCode}`),
    [
      "register:WORKER_PRESENCE_WRITE_FAILED",
      "register:WORKER_PRESENCE_WRITE_FAILED",
    ],
  );
});

test("a throwing observer cannot break presence reporting", async () => {
  const { store } = stubStore({
    async heartbeat() {
      throw new Error("postgres unavailable");
    },
  });
  const service = serviceFor(store, {
    reported() {
      throw new Error("observer exploded");
    },
    degraded() {
      throw new Error("observer exploded");
    },
  });

  assert.equal(await service.register(), true);
  assert.equal(await service.heartbeat(importing), false);
  assert.equal(await service.stop(), true);
});

test("consumers derive fleet status from the thresholds instances published", () => {
  const record = {
    state: "running" as const,
    lastHeartbeatAt: new Date(now.getTime() - 30_000),
    effectiveSettings: { presenceStaleAfterMs: 60_000 },
  };

  assert.equal(workerPresenceAgeMs(record, now), 30_000);
  assert.equal(classifyWorkerPresence(record, now), "running");
  assert.equal(
    classifyWorkerPresence(
      { ...record, lastHeartbeatAt: new Date(now.getTime() - 60_001) },
      now,
    ),
    "stale",
  );
  // A tighter published threshold makes the same record presumed dead.
  assert.equal(
    classifyWorkerPresence(
      { ...record, effectiveSettings: { presenceStaleAfterMs: 20_000 } },
      now,
    ),
    "stale",
  );
  assert.equal(
    classifyWorkerPresence({ ...record, state: "stopped" }, now),
    "stopped",
  );
  // A clock that ran backwards must not report a negative age.
  assert.equal(
    workerPresenceAgeMs(
      { lastHeartbeatAt: new Date(now.getTime() + 5_000) },
      now,
    ),
    0,
  );
});

test("stalled runs are derived from run heartbeats against the published threshold", () => {
  const thresholds = { runHeartbeatStaleAfterMs: 300_000 };
  const running = {
    state: "running" as const,
    heartbeatAt: new Date(now.getTime() - 300_001),
    startedAt: new Date(now.getTime() - 600_000),
  };

  assert.equal(isImportRunStalled(running, thresholds, now), true);
  assert.equal(
    isImportRunStalled(
      { ...running, heartbeatAt: new Date(now.getTime() - 299_000) },
      thresholds,
      now,
    ),
    false,
  );
  // A claimed run that never heartbeat falls back to when it started.
  assert.equal(
    isImportRunStalled({ ...running, heartbeatAt: null }, thresholds, now),
    true,
  );
  assert.equal(
    isImportRunStalled(
      { state: "running", heartbeatAt: null, startedAt: null },
      thresholds,
      now,
    ),
    false,
  );
  // Terminal and queued runs are never stalled.
  for (const state of ["queued", "succeeded", "incomplete", "failed"] as const) {
    assert.equal(isImportRunStalled({ ...running, state }, thresholds, now), false);
  }
});
