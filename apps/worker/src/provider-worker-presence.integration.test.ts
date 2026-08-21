import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaWorkerPresenceRepository } from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { classifyWorkerPresence } from "@packscout/services";
import { createProviderWorkerRuntime } from "./provider-worker-composition.ts";
import { resolveWorkerEffectiveSettings } from "./provider-worker-presence.ts";
import type { ProviderWorkerLogEvent } from "./provider-worker-runtime.ts";

const configuration = Object.freeze({
  actorPseudonymKey: new Uint8Array(32).fill(1),
  credentialKey: new Uint8Array(32).fill(2),
  credentialKeyVersion: 1,
  environment: "test" as const,
  estimatedEvVerifiedUsdStablecoins: [],
  heartbeatIntervalMilliseconds: 9_000,
  importRunLeaseMilliseconds: 111_000,
  maximumClaimsPerCycle: 5,
  pollIntervalMilliseconds: 100,
  presenceRetentionDays: 7,
  presenceStaleAfterMilliseconds: 45_000,
  retentionBatchSize: 10,
  retentionMaximumBatchesPerCycle: 2,
  retentionOrganizationDiscoveryLimit: 10,
  runHeartbeatStaleAfterMilliseconds: 222_000,
  scheduleClaimLeaseMilliseconds: 33_000,
  workerHost: "worker-host-1",
  workerId: "worker:composed:1",
  workerVersion: "3.2.1",
});

function manualTimer() {
  let onTick: (() => void) | null = null;
  return {
    timer: {
      schedule(_intervalMilliseconds: number, tick: () => void) {
        onTick = tick;
        return () => {
          onTick = null;
        };
      },
    },
    fire: () => onTick?.(),
  };
}

test("a composed worker publishes the settings it is actually running with", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const events: ProviderWorkerLogEvent[] = [];
    const presence = new PrismaWorkerPresenceRepository(harness.database);
    const timer = manualTimer();
    // Stop once a full cycle has completed, so start-up, a heartbeat, and a
    // clean shutdown are all exercised deterministically.
    const started = {
      runtime: undefined as ReturnType<typeof createProviderWorkerRuntime> | undefined,
    };
    const runtime = createProviderWorkerRuntime({
      configuration,
      database: harness.client,
      logger: {
        write(event) {
          events.push(event);
          if (event.event === "provider_retention_cycle_finished") {
            timer.fire();
            started.runtime?.stop();
          }
        },
      },
      observability: { metric() {}, log() {} },
      heartbeatTimer: timer.timer,
    });
    started.runtime = runtime;

    await runtime.start();

    const record = await presence.getInstance(runtime.workerId);
    assert.ok(record, "the starting instance registered durable presence");

    // Identity is the same string the instance stamps as lease/claim owner, and
    // it names this process rather than the deployment every replica shares.
    assert.equal(record.instanceId, runtime.workerId);
    assert.match(
      record.instanceId,
      /^worker:composed:1:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    );
    assert.equal(record.version, configuration.workerVersion);
    assert.equal(record.host, configuration.workerHost);
    assert.equal(record.runtimeVersion, process.version);

    // Published settings are exactly the configured operating values.
    assert.deepEqual({ ...record.effectiveSettings }, {
      heartbeatIntervalMs: configuration.heartbeatIntervalMilliseconds,
      presenceStaleAfterMs: configuration.presenceStaleAfterMilliseconds,
      runHeartbeatStaleAfterMs:
        configuration.runHeartbeatStaleAfterMilliseconds,
      scheduleClaimLeaseMs: configuration.scheduleClaimLeaseMilliseconds,
      importRunLeaseMs: configuration.importRunLeaseMilliseconds,
      protectedPayloadRetentionDays: 90,
      presenceRetentionDays: configuration.presenceRetentionDays,
    });
    assert.deepEqual(
      { ...record.effectiveSettings },
      { ...resolveWorkerEffectiveSettings(configuration) },
    );

    // A cleanly stopped instance marks itself stopped rather than ageing out.
    assert.equal(record.state, "stopped");
    assert.ok(record.stoppedAt);
    assert.equal(record.currentActivity.kind, "idle");
    assert.equal(
      classifyWorkerPresence(record, new Date(Date.now() + 86_400_000)),
      "stopped",
    );
    assert.equal(
      events.some(
        ({ event }) => event === "provider_worker_presence_registered",
      ),
      true,
    );
    assert.equal(
      events.some(({ event }) => event === "provider_worker_presence_stopped"),
      true,
    );
  } finally {
    await harness.close();
  }
});

test("the composed retention cycle prunes presence history", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const events: ProviderWorkerLogEvent[] = [];
    const presence = new PrismaWorkerPresenceRepository(harness.database);
    const runtime = createProviderWorkerRuntime({
      configuration,
      database: harness.client,
      logger: { write: (event) => void events.push(event) },
      observability: { metric() {}, log() {} },
      heartbeatTimer: manualTimer().timer,
    });

    const day = 24 * 60 * 60 * 1_000;
    const expired = new Date(Date.now() - 30 * day);
    await presence.register({
      descriptor: {
        instanceId: "worker:retired:9",
        version: "1.0.0",
        host: "worker-host-9",
        runtimeVersion: "v22.11.0",
      },
      startedAt: expired,
      effectiveSettings: resolveWorkerEffectiveSettings(configuration),
    });
    const recent = await presence.register({
      descriptor: {
        instanceId: "worker:recent:8",
        version: "1.0.0",
        host: "worker-host-8",
        runtimeVersion: "v22.11.0",
      },
      startedAt: new Date(Date.now() - day),
      effectiveSettings: resolveWorkerEffectiveSettings(configuration),
    });

    await runtime.runCycle();

    assert.deepEqual(
      (await presence.listInstances()).map(({ instanceId }) => instanceId),
      [recent.instanceId],
      "history older than the published presence window is pruned",
    );
    const retention = events.find(
      ({ event }) => event === "provider_retention_cycle_finished",
    );
    assert.equal(retention?.retentionPruned, 1);
    assert.equal(retention?.retentionPruneFailures, 0);
  } finally {
    await harness.close();
  }
});
