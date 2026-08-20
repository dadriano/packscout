import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerEffectiveSettings } from "@packscout/contracts";
import { PrismaWorkerPresenceRepository } from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { ProtectedPayloadRetentionCoordinator } from "./protected-payload-retention-coordinator.ts";
import {
  classifyWorkerPresence,
  WorkerPresenceService,
} from "./worker-presence-service.ts";

const settings: WorkerEffectiveSettings = Object.freeze({
  heartbeatIntervalMs: 15_000,
  presenceStaleAfterMs: 60_000,
  runHeartbeatStaleAfterMs: 300_000,
  scheduleClaimLeaseMs: 30_000,
  importRunLeaseMs: 120_000,
  protectedPayloadRetentionDays: 90,
  presenceRetentionDays: 14,
});

const day = 24 * 60 * 60 * 1_000;

class MutableClock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

function descriptor(instanceId: string, host: string) {
  return {
    instanceId,
    version: "2.1.0",
    host,
    runtimeVersion: process.version,
  };
}

test("an instance registers, advances, and stops against durable presence", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const store = new PrismaWorkerPresenceRepository(harness.database);
    const clock = new MutableClock(new Date("2026-08-19T12:00:00.000Z"));
    const service = new WorkerPresenceService({
      store,
      clock,
      descriptor: descriptor("worker:alpha:1", "worker-host-1"),
      effectiveSettings: settings,
    });

    assert.equal(await service.register(), true);
    const registered = await store.getInstance("worker:alpha:1");
    assert.equal(registered?.state, "running");
    assert.deepEqual(
      { ...registered?.effectiveSettings },
      { ...settings },
      "the instance publishes the settings it is running with",
    );
    assert.equal(classifyWorkerPresence(registered!, clock.now()), "running");

    clock.advance(15_000);
    assert.equal(
      await service.heartbeat({
        kind: "scheduling",
        organizationId: null,
        providerId: null,
        runId: null,
      }),
      true,
    );
    const beating = await store.getInstance("worker:alpha:1");
    assert.equal(
      beating!.lastHeartbeatAt.getTime() - registered!.lastHeartbeatAt.getTime(),
      15_000,
    );
    assert.equal(beating?.currentActivity.kind, "scheduling");
    assert.equal(classifyWorkerPresence(beating!, clock.now()), "running");

    clock.advance(5_000);
    assert.equal(await service.stop(), true);
    const stopped = await store.getInstance("worker:alpha:1");
    assert.equal(stopped?.state, "stopped");
    assert.equal(classifyWorkerPresence(stopped!, clock.now()), "stopped");
  } finally {
    await harness.close();
  }
});

test("a killed instance stops heartbeating and reads as stale by age", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const store = new PrismaWorkerPresenceRepository(harness.database);
    const clock = new MutableClock(new Date("2026-08-19T12:00:00.000Z"));
    const survivor = new WorkerPresenceService({
      store,
      clock,
      descriptor: descriptor("worker:alpha:1", "worker-host-1"),
      effectiveSettings: settings,
    });
    const killed = new WorkerPresenceService({
      store,
      clock,
      descriptor: descriptor("worker:beta:2", "worker-host-2"),
      effectiveSettings: settings,
    });

    await survivor.register();
    await killed.register();
    await killed.heartbeat({
      kind: "importing",
      organizationId: "7c000000-0000-4000-8000-000000000001",
      providerId: "7c000000-0000-4000-8000-000000000010",
      runId: "7c000000-0000-4000-8000-000000000030",
    });

    // The killed instance never reports again; only the survivor keeps beating.
    clock.advance(settings.presenceStaleAfterMs + 1);
    await survivor.heartbeat();

    const instances = await store.listInstances();
    const byId = new Map(
      instances.map((instance) => [instance.instanceId, instance]),
    );
    const alpha = byId.get("worker:alpha:1")!;
    const beta = byId.get("worker:beta:2")!;

    assert.equal(classifyWorkerPresence(alpha, clock.now()), "running");
    assert.equal(classifyWorkerPresence(beta, clock.now()), "stale");
    // The presumed-dead instance still reads as `running` state: staleness is
    // derived by consumers from heartbeat age, not written by the dead process.
    assert.equal(beta.state, "running");
    assert.equal(beta.currentActivity.kind, "importing");
    assert.notEqual(alpha.host, beta.host);
  } finally {
    await harness.close();
  }
});

test("the retention cycle prunes presence history as a new pruned kind", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const store = new PrismaWorkerPresenceRepository(harness.database);
    const now = new Date("2026-08-19T12:00:00.000Z");
    for (const [index, age] of [30, 20, 2, 0].entries()) {
      const clock = new MutableClock(new Date(now.getTime() - age * day));
      const service = new WorkerPresenceService({
        store,
        clock,
        descriptor: descriptor(`worker:history:${index}`, "worker-host-1"),
        effectiveSettings: settings,
      });
      await service.register();
    }
    assert.equal((await store.listInstances()).length, 4);

    const coordinator = new ProtectedPayloadRetentionCoordinator(
      { discoverEligibleOrganizations: async () => [] },
      {
        run: async () => {
          throw new Error("no protected payload work in this fixture");
        },
      },
      { id: () => "7d000000-0000-4000-8000-000000000001" },
      { now: () => new Date(now) },
      {
        batchSize: 25,
        maxBatchesPerCycle: 5,
        organizationDiscoveryLimit: 10,
        pruners: [
          {
            kind: "worker_presence",
            retentionMs: settings.presenceRetentionDays * day,
            prune: (input) => store.prune(input),
          },
        ],
      },
    );

    const cycle = await coordinator.runCycle();

    assert.equal(cycle.prunedRecords, 2);
    assert.equal(cycle.prunedFailures, 0);
    assert.deepEqual(
      (await store.listInstances()).map(({ instanceId }) => instanceId),
      ["worker:history:3", "worker:history:2"],
    );

    // A second cycle is stable once history is inside the window.
    const settled = await coordinator.runCycle();
    assert.equal(settled.prunedRecords, 0);
    assert.equal((await store.listInstances()).length, 2);
  } finally {
    await harness.close();
  }
});

test("presence writes that fail leave the instance reporting and recovering", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const store = new PrismaWorkerPresenceRepository(harness.database);
    const clock = new MutableClock(new Date("2026-08-19T12:00:00.000Z"));
    const degradations: string[] = [];
    const service = new WorkerPresenceService({
      store: {
        register: (input) => store.register(input),
        heartbeat: async (input) => {
          if (degradations.length === 0) throw new Error("connection reset");
          return store.heartbeat(input);
        },
        markStopped: (input) => store.markStopped(input),
      },
      clock,
      descriptor: descriptor("worker:alpha:1", "worker-host-1"),
      effectiveSettings: settings,
      observer: {
        reported: () => undefined,
        degraded: (event) => void degradations.push(event.failureCode),
      },
    });

    await service.register();
    clock.advance(15_000);
    assert.equal(await service.heartbeat(), false);
    assert.deepEqual(degradations, ["WORKER_PRESENCE_WRITE_FAILED"]);

    // The instance keeps reporting; the durable record catches up on the retry.
    clock.advance(15_000);
    assert.equal(await service.heartbeat(), true);
    const recovered = await store.getInstance("worker:alpha:1");
    assert.deepEqual(recovered?.lastHeartbeatAt, clock.now());
    assert.equal(classifyWorkerPresence(recovered!, clock.now()), "running");
  } finally {
    await harness.close();
  }
});
