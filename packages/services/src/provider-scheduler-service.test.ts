import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderSchedulerService,
  type ProviderScheduleClaim,
  type ProviderScheduleOutcome,
  type ProviderScheduleRepository,
} from "./provider-scheduler-service.ts";

class MutableClock {
  constructor(public current: Date) {}
  now(): Date {
    return this.current;
  }
}

type ScheduleState = Omit<ProviderScheduleClaim, "dueAt"> & {
  dueAt: Date;
  claimOwner: string | null;
  claimExpiresAt: Date | null;
  enabled: boolean;
  lastOutcome: ProviderScheduleOutcome | null;
  lastRunId: string | null;
};

function schedule(
  dueAt: Date,
  scheduleSeconds = 300,
): ScheduleState {
  return {
    organizationId: "organization-1",
    providerId: "provider-1",
    configRevisionId: "revision-1",
    scheduleSeconds,
    staleAfterSeconds: 900,
    dueAt,
    claimOwner: null,
    claimExpiresAt: null,
    enabled: true,
    lastOutcome: null,
    lastRunId: null,
  };
}

function repository(state: ScheduleState): ProviderScheduleRepository {
  return {
    async claimDueProvider(input) {
      if (
        !state.enabled ||
        state.dueAt > input.now ||
        (state.claimExpiresAt !== null && state.claimExpiresAt > input.now)
      ) {
        return null;
      }
      state.claimOwner = input.workerId;
      state.claimExpiresAt = input.leaseExpiresAt;
      return { ...state };
    },
    async completeClaim(input) {
      if (
        state.claimOwner !== input.workerId ||
        state.configRevisionId !== input.configRevisionId
      ) {
        return false;
      }
      state.claimOwner = null;
      state.claimExpiresAt = null;
      state.lastOutcome = input.outcome;
      state.lastRunId = input.runId;
      if (input.nextDueAt) state.dueAt = input.nextDueAt;
      else state.enabled = false;
      return true;
    },
    async releaseClaim(input) {
      if (state.claimOwner !== input.workerId) return;
      state.claimOwner = null;
      state.claimExpiresAt = null;
      state.dueAt = input.retryAt;
    },
  };
}

test("five-minute cadence starts once under multi-worker contention", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const state = schedule(now);
  let requests = 0;
  const dependencies = {
    schedules: repository(state),
    clock: new MutableClock(now),
    imports: {
      async requestImport() {
        requests += 1;
        return { run: { id: "run-1" }, coalesced: false };
      },
    },
  };
  const workerA = new ProviderSchedulerService(dependencies);
  const workerB = new ProviderSchedulerService(dependencies);

  const results = await Promise.all([
    workerA.runOnce("worker-a"),
    workerB.runOnce("worker-b"),
  ]);

  assert.equal(requests, 1);
  assert.deepEqual(
    results.map((result) => result.kind).sort(),
    ["idle", "started"],
  );
  assert.equal(state.dueAt.toISOString(), "2026-08-06T12:05:00.000Z");
  assert.equal((await workerA.runOnce("worker-a")).kind, "idle");
});

test("custom cadence and downtime coalesce into one current trigger", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const state = schedule(new Date("2026-08-06T09:00:00.000Z"), 600);
  const scheduler = new ProviderSchedulerService({
    schedules: repository(state),
    clock: new MutableClock(now),
    imports: {
      async requestImport() {
        return { run: { id: "active-run" }, coalesced: true };
      },
    },
  });

  const result = await scheduler.runOnce("restarted-worker");

  assert.equal(result.kind, "coalesced");
  assert.equal(result.nextDueAt?.toISOString(), "2026-08-06T12:10:00.000Z");
  assert.equal(state.lastRunId, "active-run");
});

test("an expired worker lease is reclaimable after restart", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const state = schedule(now);
  state.claimOwner = "crashed-worker";
  state.claimExpiresAt = new Date("2026-08-06T11:59:59.000Z");
  const scheduler = new ProviderSchedulerService({
    schedules: repository(state),
    clock: new MutableClock(now),
    imports: {
      async requestImport() {
        return { run: { id: "recovered-run" }, coalesced: false };
      },
    },
  });

  assert.equal((await scheduler.runOnce("replacement-worker")).kind, "started");
  assert.equal(state.lastRunId, "recovered-run");
});

test("disabled or archived races stop future scheduling", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const state = schedule(now);
  const scheduler = new ProviderSchedulerService({
    schedules: repository(state),
    clock: new MutableClock(now),
    imports: {
      async requestImport() {
        throw Object.assign(new Error("not enabled"), {
          code: "PROVIDER_NOT_IMPORTABLE",
        });
      },
    },
  });

  const result = await scheduler.runOnce("worker-a");

  assert.equal(result.kind, "not_enabled");
  assert.equal(result.nextDueAt, null);
  assert.equal(state.enabled, false);
  assert.equal((await scheduler.runOnce("worker-a")).kind, "idle");
});

test("enqueue failures release ownership for a bounded retry", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const state = schedule(now);
  const scheduler = new ProviderSchedulerService({
    schedules: repository(state),
    clock: new MutableClock(now),
    imports: {
      async requestImport(): Promise<never> {
        throw new Error("database unavailable");
      },
    },
  });

  await assert.rejects(() => scheduler.runOnce("worker-a"), /database unavailable/);
  assert.equal(state.claimOwner, null);
  assert.equal(state.dueAt.toISOString(), "2026-08-06T12:00:30.000Z");
});
