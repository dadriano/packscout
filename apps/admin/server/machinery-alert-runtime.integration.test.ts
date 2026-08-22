import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IDLE_WORKER_ACTIVITY,
  type WorkerEffectiveSettings,
} from "@packscout/contracts";
import {
  PipelineSetupRepository,
  PrismaAdminNotificationPublisher,
  PrismaWorkerPresenceRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import {
  MachineryAlertService,
  OperationalEventService,
} from "@packscout/services";
import { createAdminMachineryAlertFactsSource } from "./machinery-alert-runtime.ts";

/**
 * The admin server's machinery alert cycle, composed exactly as the running
 * service composes it, against real durable evidence.
 *
 * The composition contains no worker: the whole point of hosting this cycle in
 * the admin is that the loudest condition — nothing is alive — must still be
 * detected when the fleet that would normally do the detecting is gone.
 */

const organizationId = "9c000000-0000-4000-8000-000000000001";
const observedAt = new Date("2026-08-20T12:00:00.000Z");

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
  return new Date(observedAt.getTime() + offsetMs);
}

test("fleet silence is raised, measured, and resolved with no worker process in the composition", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await new PipelineSetupRepository(harness.database).createOrganization({
      id: organizationId,
      slug: "machinery-alert-runtime",
      name: "Machinery Alert Runtime",
      createdAt: observedAt,
    });
    const presence = new PrismaWorkerPresenceRepository(harness.database);
    let issued = 0;
    let now = observedAt;
    const events = new OperationalEventService(
      new PrismaAdminNotificationPublisher(harness.database),
      {
        id: () =>
          `9c000000-0000-4000-8000-${String(1_000 + ++issued).padStart(12, "0")}`,
      },
      { now: () => new Date(observedAt.getTime() + issued * 1_000) },
    );
    const service = new MachineryAlertService(
      createAdminMachineryAlertFactsSource({
        database: harness.database,
        backlogDepthLimit: 100,
        clock: { now: () => now },
      }),
      events,
    );

    // No presence record exists at all. The condition still has to raise, and
    // the alert must not claim a silence duration it cannot measure.
    const firstCycle = await service.runCycle();
    assert.equal(firstCycle.organizations, 1);
    assert.equal(firstCycle.raised, 1);
    const alert = await harness.database.admin_alerts.findFirst({
      where: { organization_id: organizationId },
    });
    assert.equal(alert?.kind, "worker_fleet_silent");
    assert.equal(alert?.state, "active");
    assert.equal(alert?.severity, "critical");
    const neverReported = await harness.database.operational_events.findFirst({
      where: { organization_id: organizationId },
      orderBy: { occurred_at: "desc" },
      select: { evidence_json: true },
    });
    assert.deepEqual(neverReported?.evidence_json, {
      outcome: "WORKER_FLEET_NEVER_REPORTED",
      count: 0,
    });

    // A worker that reported and then died: the same condition, now with a
    // duration measured from the last heartbeat anybody published.
    await presence.register({
      descriptor: {
        instanceId: "worker-departed",
        version: "1.0.0",
        host: "worker-host",
        runtimeVersion: "v22.0.0",
      },
      startedAt: at(-600_000),
      effectiveSettings: settings,
    });
    await presence.heartbeat({
      instanceId: "worker-departed",
      observedAt: at(-settings.presenceStaleAfterMs - 1),
      activity: IDLE_WORKER_ACTIVITY,
    });
    // The condition still holds and its alert is still open, so this cycle
    // publishes nothing: the operator can already see it, and a durable row per
    // cycle would be half a million permanent rows a year for one unresolved
    // condition. The alert itself is untouched.
    const secondCycle = await service.runCycle();
    assert.equal(secondCycle.raised, 0);
    assert.equal(secondCycle.cleared, 0);
    const persisting = await harness.database.admin_alerts.findMany({
      where: { organization_id: organizationId, kind: "worker_fleet_silent" },
    });
    assert.equal(persisting.length, 1, "a persisting condition keeps one alert");
    assert.equal(persisting[0]?.id, alert?.id);
    assert.equal(persisting[0]?.state, "active");
    assert.equal(persisting[0]?.occurrence_count, 1);
    const stillOne = await harness.database.operational_events.findMany({
      where: { organization_id: organizationId, kind: "worker_fleet_silent" },
      select: { evidence_json: true },
    });
    assert.equal(
      stillOne.length,
      1,
      "an episode already reported appends no second durable event",
    );

    // A live worker again: the open alert resolves through the existing
    // lifecycle rather than being deleted or left behind.
    await presence.heartbeat({
      instanceId: "worker-departed",
      observedAt: at(-1_000),
      activity: IDLE_WORKER_ACTIVITY,
    });
    now = at(0);
    const thirdCycle = await service.runCycle();
    assert.equal(thirdCycle.raised, 0);
    assert.equal(thirdCycle.cleared, 1);
    const resolved = await harness.database.admin_alerts.findFirst({
      where: { organization_id: organizationId, id: alert?.id },
    });
    assert.equal(resolved?.state, "resolved");
    assert.equal(resolved?.resolved_by_actor_key, "system:recovery");

    // Nothing holds and nothing is open, so a quiet cycle publishes nothing.
    const quietCycle = await service.runCycle();
    assert.deepEqual(
      [quietCycle.raised, quietCycle.cleared, quietCycle.failedPublications],
      [0, 0, 0],
    );

    // The fleet goes silent a second time. Publishing once per episode is not
    // publishing once ever: a recurrence after recovery is a new episode and
    // must raise again, this time with the duration it can now measure.
    now = at(settings.presenceStaleAfterMs);
    const recurrence = await service.runCycle();
    assert.equal(recurrence.raised, 1);
    const reopened = await harness.database.admin_alerts.findFirst({
      where: {
        organization_id: organizationId,
        kind: "worker_fleet_silent",
        state: "active",
      },
    });
    assert.ok(reopened, "a recurrence is visible as an open alert again");
    const republished = await harness.database.operational_events.findMany({
      where: { organization_id: organizationId, kind: "worker_fleet_silent" },
      orderBy: { occurred_at: "desc" },
      select: { evidence_json: true },
    });
    assert.equal(republished.length, 2, "the new episode is its own event");
    assert.deepEqual(republished[0]?.evidence_json, {
      outcome: "WORKER_FLEET_SILENT",
      reasonCode: "FLEET_PRESENCE_WINDOW",
      durationMs: settings.presenceStaleAfterMs + 1_000,
      thresholdMs: settings.presenceStaleAfterMs,
      count: 1,
    });
  } finally {
    await harness.close();
  }
});
