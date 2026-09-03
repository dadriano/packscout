import assert from "node:assert/strict";
import { test } from "node:test";
import { IDLE_WORKER_ACTIVITY } from "@packscout/contracts";
import { PrismaImportRunRepository } from "./import-run-repository.ts";
import { PrismaProviderScheduleRepository } from "./provider-scheduling-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";
import { PrismaWorkerPresenceRepository } from "./worker-presence-repository.ts";

const ids = {
  organization: "7a000000-0000-4000-8000-000000000001",
  provider: "7a000000-0000-4000-8000-000000000010",
  configuration: "7a000000-0000-4000-8000-000000000020",
  run: "7a000000-0000-4000-8000-000000000030",
} as const;

const startedAt = new Date("2026-08-19T12:00:00.000Z");

const settings = {
  heartbeatIntervalMs: 15_000,
  presenceStaleAfterMs: 60_000,
  runHeartbeatStaleAfterMs: 300_000,
  scheduleClaimLeaseMs: 30_000,
  importRunLeaseMs: 120_000,
  protectedPayloadRetentionDays: 90,
  presenceRetentionDays: 14,
} as const;

function descriptor(instanceId: string) {
  return {
    instanceId,
    version: "1.4.2+build9",
    host: "worker-host-1",
    runtimeVersion: "v22.11.0",
  };
}

test("presence records register, heartbeat, publish settings, and stop cleanly", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const presence = new PrismaWorkerPresenceRepository(harness.database);

    const registered = await presence.register({
      descriptor: descriptor("worker:alpha:1"),
      startedAt,
      effectiveSettings: settings,
    });

    assert.equal(registered.instanceId, "worker:alpha:1");
    assert.equal(registered.state, "running");
    assert.equal(registered.version, "1.4.2+build9");
    assert.equal(registered.host, "worker-host-1");
    assert.equal(registered.runtimeVersion, "v22.11.0");
    assert.deepEqual(registered.startedAt, startedAt);
    assert.deepEqual(registered.lastHeartbeatAt, startedAt);
    assert.equal(registered.stoppedAt, null);
    assert.deepEqual(registered.currentActivity, IDLE_WORKER_ACTIVITY);
    assert.deepEqual({ ...registered.effectiveSettings }, { ...settings });

    const workingAt = new Date(startedAt.getTime() + 15_000);
    const importing = {
      kind: "importing" as const,
      organizationId: ids.organization,
      providerId: ids.provider,
      runId: ids.run,
    };
    assert.equal(
      await presence.heartbeat({
        instanceId: "worker:alpha:1",
        observedAt: workingAt,
        activity: importing,
      }),
      true,
    );

    const working = await presence.getInstance("worker:alpha:1");
    assert.deepEqual(working?.lastHeartbeatAt, workingAt);
    assert.deepEqual(working?.currentActivity, importing);
    assert.deepEqual(working?.activityStartedAt, workingAt);

    // A continuing activity keeps its start time so the admin can show how long
    // a run has been worked; only the heartbeat advances.
    const laterAt = new Date(startedAt.getTime() + 30_000);
    await presence.heartbeat({
      instanceId: "worker:alpha:1",
      observedAt: laterAt,
      activity: importing,
    });
    const continued = await presence.getInstance("worker:alpha:1");
    assert.deepEqual(continued?.lastHeartbeatAt, laterAt);
    assert.deepEqual(continued?.activityStartedAt, workingAt);

    const stoppedAt = new Date(startedAt.getTime() + 45_000);
    assert.equal(
      await presence.markStopped({
        instanceId: "worker:alpha:1",
        stoppedAt,
      }),
      true,
    );
    const stopped = await presence.getInstance("worker:alpha:1");
    assert.equal(stopped?.state, "stopped");
    assert.deepEqual(stopped?.stoppedAt, stoppedAt);
    assert.deepEqual(stopped?.currentActivity, IDLE_WORKER_ACTIVITY);
    assert.equal(stopped?.activityStartedAt, null);

    // A stopped instance no longer accepts heartbeats or a second stop.
    assert.equal(
      await presence.heartbeat({
        instanceId: "worker:alpha:1",
        observedAt: new Date(startedAt.getTime() + 60_000),
        activity: IDLE_WORKER_ACTIVITY,
      }),
      false,
    );
    assert.equal(
      await presence.markStopped({
        instanceId: "worker:alpha:1",
        stoppedAt: new Date(startedAt.getTime() + 60_000),
      }),
      false,
    );
  } finally {
    await harness.close();
  }
});

test("concurrent instances stay individually distinguishable", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const presence = new PrismaWorkerPresenceRepository(harness.database);
    await presence.register({
      descriptor: descriptor("worker:alpha:1"),
      startedAt,
      effectiveSettings: settings,
    });
    await presence.register({
      descriptor: {
        ...descriptor("worker:beta:2"),
        host: "worker-host-2",
        version: "1.5.0",
      },
      startedAt: new Date(startedAt.getTime() + 1_000),
      effectiveSettings: { ...settings, heartbeatIntervalMs: 20_000 },
    });

    await presence.heartbeat({
      instanceId: "worker:beta:2",
      observedAt: new Date(startedAt.getTime() + 5_000),
      activity: {
        kind: "retention",
        organizationId: null,
        providerId: null,
        runId: null,
      },
    });

    const instances = await presence.listInstances();
    assert.deepEqual(
      instances.map(({ instanceId }) => instanceId),
      ["worker:beta:2", "worker:alpha:1"],
    );
    const [beta, alpha] = instances;
    assert.equal(beta?.host, "worker-host-2");
    assert.equal(beta?.version, "1.5.0");
    assert.equal(beta?.effectiveSettings.heartbeatIntervalMs, 20_000);
    assert.equal(beta?.currentActivity.kind, "retention");
    assert.equal(alpha?.host, "worker-host-1");
    assert.equal(alpha?.effectiveSettings.heartbeatIntervalMs, 15_000);
    assert.equal(alpha?.currentActivity.kind, "idle");

    // One instance stopping leaves the other untouched.
    await presence.markStopped({
      instanceId: "worker:alpha:1",
      stoppedAt: new Date(startedAt.getTime() + 10_000),
    });
    assert.equal(
      (await presence.getInstance("worker:beta:2"))?.state,
      "running",
    );
  } finally {
    await harness.close();
  }
});

test("presence identity matches the lease and claim owner the instance stamps", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const instanceId = "worker:alpha:1";
    const presence = new PrismaWorkerPresenceRepository(harness.database);
    const setup = new PipelineSetupRepository(harness.database);
    const schedules = new PrismaProviderScheduleRepository(harness.database);
    const runs = new PrismaImportRunRepository(harness.database);

    const registered = await presence.register({
      descriptor: descriptor(instanceId),
      startedAt,
      effectiveSettings: settings,
    });

    await setup.createOrganization({
      id: ids.organization,
      slug: "presence-identity",
      name: "Presence Identity",
      createdAt: startedAt,
    });
    await setup.createProviderSource({
      id: ids.provider,
      organizationId: ids.organization,
      platformKey: "fixture-provider",
      displayName: "Fixture Provider",
      createdAt: startedAt,
    });
    await setup.createConfigRevision({
      id: ids.configuration,
      organizationId: ids.organization,
      providerId: ids.provider,
      version: 1,
      adapterKey: "fixture-mapper-v1",
      endpointUrl: "https://provider.example/feed",
      authMode: "none",
      createdByActorKey: "actor:test",
      createdAt: startedAt,
    });
    await setup.recordSuccessfulConnectionTest({
      organizationId: ids.organization,
      providerId: ids.provider,
      revisionId: ids.configuration,
      actorKey: "actor:test",
      testedAt: startedAt,
      latencyMs: 12,
    });
    await setup.activateConfiguration({
      organizationId: ids.organization,
      providerId: ids.provider,
      revisionId: ids.configuration,
      actorKey: "actor:test",
      activatedAt: startedAt,
      nextRunAt: startedAt,
    });
    await setup.createImportRun({
      id: ids.run,
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.configuration,
      trigger: "scheduled",
      state: "queued",
      createdAt: startedAt,
    });

    const claimedAt = new Date(startedAt.getTime() + 1_000);
    const claim = await schedules.claimDueProvider({
      workerId: instanceId,
      now: claimedAt,
      leaseExpiresAt: new Date(
        claimedAt.getTime() + settings.scheduleClaimLeaseMs,
      ),
    });
    assert.equal(claim?.providerId, ids.provider);

    const claimedRun = await runs.claimNextRun({
      workerId: instanceId,
      claimedAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + settings.importRunLeaseMs),
    });
    assert.equal(claimedRun.kind, "claimed");

    await presence.heartbeat({
      instanceId,
      observedAt: claimedAt,
      activity: {
        kind: "importing",
        organizationId: ids.organization,
        providerId: ids.provider,
        runId: ids.run,
      },
    });

    const schedule = await harness.database.provider_schedules.findFirst({
      where: { provider_id: ids.provider },
      select: { claim_owner: true, claim_expires_at: true },
    });
    const run = await harness.database.import_runs.findFirst({
      where: { id: ids.run },
      select: { lease_owner: true, lease_expires_at: true, heartbeat_at: true },
    });
    const instance = await presence.getInstance(instanceId);

    // One identity ties the presence record, the schedule claim, and the run
    // lease together, so a stalled run traces back to a named instance.
    assert.equal(schedule?.claim_owner, registered.instanceId);
    assert.equal(run?.lease_owner, registered.instanceId);
    assert.equal(instance?.instanceId, schedule?.claim_owner);
    assert.equal(instance?.currentActivity.runId, ids.run);

    // The durable lease windows are the published ones.
    assert.equal(
      schedule!.claim_expires_at!.getTime() - claimedAt.getTime(),
      instance!.effectiveSettings.scheduleClaimLeaseMs,
    );
    assert.equal(
      run!.lease_expires_at!.getTime() - run!.heartbeat_at!.getTime(),
      instance!.effectiveSettings.importRunLeaseMs,
    );
  } finally {
    await harness.close();
  }
});

test("presence history is pruned to a bounded window without touching fresh rows", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const presence = new PrismaWorkerPresenceRepository(harness.database);
    const day = 24 * 60 * 60 * 1_000;
    const now = new Date("2026-09-19T12:00:00.000Z");
    const ages = [40, 30, 20, 1];
    for (const [index, age] of ages.entries()) {
      const at = new Date(now.getTime() - age * day);
      await presence.register({
        descriptor: descriptor(`worker:history:${index}`),
        startedAt: at,
        effectiveSettings: settings,
      });
      await presence.markStopped({
        instanceId: `worker:history:${index}`,
        stoppedAt: at,
      });
    }
    // A crashed instance simply stops heartbeating and ages out the same way.
    await presence.register({
      descriptor: descriptor("worker:history:crashed"),
      startedAt: new Date(now.getTime() - 35 * day),
      effectiveSettings: settings,
    });

    const cutoffAt = new Date(now.getTime() - 14 * day);
    assert.equal(await presence.prune({ cutoffAt, limit: 2 }), 2);
    assert.deepEqual(
      (await presence.listInstances()).map(({ instanceId }) => instanceId),
      ["worker:history:3", "worker:history:2", "worker:history:1"],
    );

    assert.equal(await presence.prune({ cutoffAt, limit: 10 }), 2);
    assert.deepEqual(
      (await presence.listInstances()).map(({ instanceId }) => instanceId),
      ["worker:history:3"],
    );
    assert.equal(await presence.prune({ cutoffAt, limit: 10 }), 0);
  } finally {
    await harness.close();
  }
});

test("invalid presence reports are rejected before reaching PostgreSQL", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const presence = new PrismaWorkerPresenceRepository(harness.database);
    const register = (overrides: Record<string, unknown>) =>
      presence.register({
        descriptor: descriptor("worker:alpha:1"),
        startedAt,
        effectiveSettings: settings,
        ...overrides,
      });

    await assert.rejects(
      register({ descriptor: descriptor("worker alpha") }),
      /descriptor is invalid/,
    );
    await assert.rejects(
      register({ descriptor: { ...descriptor("worker:alpha:1"), host: "" } }),
      /descriptor is invalid/,
    );
    await assert.rejects(
      register({ effectiveSettings: { ...settings, heartbeatIntervalMs: 999 } }),
      /outside their bounds/,
    );
    await assert.rejects(
      register({
        effectiveSettings: { ...settings, presenceStaleAfterMs: 15_000 },
      }),
      /outside their bounds/,
    );

    await presence.register({
      descriptor: descriptor("worker:alpha:1"),
      startedAt,
      effectiveSettings: settings,
    });
    await assert.rejects(
      presence.heartbeat({
        instanceId: "worker:alpha:1",
        observedAt: startedAt,
        activity: {
          kind: "importing",
          organizationId: ids.organization,
          providerId: null,
          runId: null,
        },
      }),
      /activity is invalid/,
    );
    await assert.rejects(
      presence.heartbeat({
        instanceId: "worker:alpha:1",
        observedAt: startedAt,
        activity: {
          kind: "idle",
          organizationId: ids.organization,
          providerId: null,
          runId: null,
        },
      }),
      /activity is invalid/,
    );
    await assert.rejects(
      presence.prune({ cutoffAt: startedAt, limit: 0 }),
      /prune request is invalid/,
    );
  } finally {
    await harness.close();
  }
});
