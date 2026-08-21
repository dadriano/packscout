import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineryCondition } from "@packscout/contracts";
import {
  PipelineSetupRepository,
  PrismaAdminNotificationPublisher,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import {
  MachineryAlertService,
  type MachineryAlertFacts,
  type MachineryAlertFactsSource,
  type OpenMachineryAlert,
} from "./machinery-alert-service.ts";
import { OperationalEventService } from "./operational-events.ts";

/**
 * The durable half of machinery alerting: each condition, run through the real
 * alert store, must produce exactly one active alert while it persists, must
 * not produce a second alert when it is observed again, must resolve when it
 * clears, and must raise a fresh active alert when it comes back.
 *
 * Every condition is exercised, including the two the pipeline cannot detect
 * from inside a worker.
 */

const organizationId = "9b000000-0000-4000-8000-000000000001";
const providerId = "9b000000-0000-4000-8000-000000000002";
const revisionId = "9b000000-0000-4000-8000-000000000003";
const runId = "9b000000-0000-4000-8000-000000000004";
const occurredAt = new Date("2026-08-20T12:00:00.000Z");

function condition(
  overrides: Partial<MachineryCondition> & Pick<MachineryCondition, "kind">,
): MachineryCondition {
  return {
    dedupeKey: `machinery:${overrides.kind}`,
    recoveryKey: `machinery:${overrides.kind}:health`,
    providerId: null,
    runId: null,
    outcome: "WORKER_FLEET_SILENT",
    threshold: null,
    observedMs: null,
    thresholdMs: null,
    observedCount: null,
    thresholdCount: null,
    ...overrides,
  };
}

/** One condition per kind, shaped exactly as the shared derivation emits it. */
const conditions: readonly MachineryCondition[] = [
  condition({
    kind: "worker_fleet_silent",
    dedupeKey: "worker-fleet:silent",
    recoveryKey: "worker-fleet:health",
    outcome: "WORKER_FLEET_SILENT",
    threshold: "FLEET_PRESENCE_WINDOW",
    observedMs: 61_000,
    thresholdMs: 60_000,
    observedCount: 2,
  }),
  condition({
    kind: "import_run_stalled",
    dedupeKey: `import-run:stalled:${runId}`,
    recoveryKey: `import-run:health:${runId}`,
    providerId,
    runId,
    outcome: "IMPORT_RUN_STALLED",
    threshold: "RUN_HEARTBEAT_WINDOW",
    observedMs: 301_000,
    thresholdMs: 300_000,
  }),
  condition({
    kind: "provider_schedule_overdue",
    dedupeKey: `provider-schedule:overdue:${providerId}`,
    recoveryKey: `provider-schedule:health:${providerId}`,
    providerId,
    outcome: "PROVIDER_SCHEDULE_OVERDUE",
    threshold: "SCHEDULE_OVERDUE_TOLERANCE",
    observedMs: 90_000,
    thresholdMs: 60_000,
  }),
  condition({
    kind: "recomputation_backlogged",
    dedupeKey: "recomputation:backlogged",
    recoveryKey: "recomputation:health",
    outcome: "RECOMPUTATION_BACKLOGGED",
    threshold: "BACKLOG_QUEUE_DEPTH",
    observedCount: 140,
    thresholdCount: 100,
  }),
  condition({
    kind: "retention_overdue",
    dedupeKey: "retention-cadence:overdue",
    recoveryKey: "retention-cadence:health",
    outcome: "RETENTION_OVERDUE",
    threshold: "RETENTION_EXPECTED_INTERVAL",
    observedMs: 120_000,
    thresholdMs: 60_000,
    observedCount: 12,
  }),
];

function openFor(target: MachineryCondition): OpenMachineryAlert {
  return {
    kind: target.kind,
    recoveryKey: target.recoveryKey,
    providerId: target.providerId,
    runId: target.runId,
  };
}

class ScriptedSource implements MachineryAlertFactsSource {
  #cycle = 0;

  constructor(private readonly script: readonly MachineryAlertFacts[]) {}

  listOrganizations(): Promise<readonly string[]> {
    return Promise.resolve([organizationId]);
  }

  readFacts(): Promise<MachineryAlertFacts> {
    const facts = this.script[this.#cycle] ?? { conditions: [], openAlerts: [] };
    this.#cycle += 1;
    return Promise.resolve(facts);
  }
}

test("every machinery condition raises one alert, deduplicates, resolves, and reopens", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: organizationId,
      slug: "machinery-alerts",
      name: "Machinery Alerts",
      createdAt: occurredAt,
    });
    await setup.createProviderSource({
      id: providerId,
      organizationId,
      platformKey: "fanatics",
      displayName: "Fanatics Live",
      createdAt: occurredAt,
    });
    await setup.createConfigRevision({
      id: revisionId,
      organizationId,
      providerId,
      version: 1,
      adapterKey: "fanatics",
      endpointUrl: "https://provider.invalid/feed",
      authMode: "none",
      createdByActorKey: "actor:v1:setup",
      createdAt: occurredAt,
    });
    await setup.createImportRun({
      id: runId,
      organizationId,
      providerId,
      configRevisionId: revisionId,
      trigger: "scheduled",
      state: "running",
      createdAt: occurredAt,
    });

    const publisher = new PrismaAdminNotificationPublisher(harness.database);
    let issued = 0;
    const events = new OperationalEventService(
      publisher,
      {
        id: () =>
          `9b000000-0000-4000-8000-${String(1_000 + ++issued).padStart(12, "0")}`,
      },
      { now: () => new Date(occurredAt.getTime() + issued * 1_000) },
    );

    for (const target of conditions) {
      const open = [openFor(target)];
      const service = new MachineryAlertService(
        new ScriptedSource([
          { conditions: [target], openAlerts: [] },
          { conditions: [target], openAlerts: open },
          { conditions: [], openAlerts: open },
          { conditions: [], openAlerts: [] },
          { conditions: [target], openAlerts: [] },
        ]),
        events,
      );
      const where = { organization_id: organizationId, dedupe_key: target.dedupeKey };

      await service.runCycle();
      const raised = await harness.database.admin_alerts.findFirst({ where });
      assert.equal(raised?.state, "active", `${target.kind} raises an alert`);
      assert.equal(raised?.kind, target.kind);
      assert.equal(raised?.occurrence_count, 1);
      // The alert states the threshold that was crossed alongside the observed
      // value, and never invents a measure that was not taken.
      const evidence = await harness.database.operational_events.findFirst({
        where: { organization_id: organizationId, dedupe_key: target.dedupeKey },
        orderBy: { occurred_at: "desc" },
        select: { evidence_json: true },
      });
      assert.deepEqual(evidence?.evidence_json, {
        outcome: target.outcome,
        ...(target.threshold === null ? {} : { reasonCode: target.threshold }),
        ...(target.observedMs === null ? {} : { durationMs: target.observedMs }),
        ...(target.thresholdMs === null ? {} : { thresholdMs: target.thresholdMs }),
        ...(target.observedCount === null ? {} : { count: target.observedCount }),
        ...(target.thresholdCount === null
          ? {}
          : { thresholdCount: target.thresholdCount }),
      });

      await service.runCycle();
      const persisting = await harness.database.admin_alerts.findMany({ where });
      assert.equal(persisting.length, 1, `${target.kind} keeps one alert`);
      assert.equal(persisting[0]?.state, "active");
      assert.equal(persisting[0]?.occurrence_count, 2);
      assert.equal(persisting[0]?.id, raised?.id);

      await service.runCycle();
      const cleared = await harness.database.admin_alerts.findFirst({
        where: { organization_id: organizationId, id: raised?.id },
      });
      assert.equal(cleared?.state, "resolved", `${target.kind} resolves`);
      assert.equal(cleared?.resolved_by_actor_key, "system:recovery");

      await service.runCycle();
      const quiet = await harness.database.admin_alerts.findFirst({
        where: { organization_id: organizationId, id: raised?.id },
      });
      assert.equal(quiet?.state, "resolved", `${target.kind} stays resolved`);

      await service.runCycle();
      const recurrence = await harness.database.admin_alerts.findMany({ where });
      assert.equal(recurrence.length, 1, `${target.kind} reuses its grouping`);
      assert.equal(recurrence[0]?.state, "active");
      assert.equal(recurrence[0]?.reopened_count, 1);
      assert.equal(recurrence[0]?.kind, target.kind);
    }

    // No standalone alert is ever created by a recovery, so a machinery
    // recovery cannot leave a resolved alert nobody raised.
    const recoveryOnly = await harness.database.admin_alerts.findMany({
      where: { organization_id: organizationId, kind: "machinery_recovered" },
    });
    assert.deepEqual(recoveryOnly, []);
  } finally {
    await harness.close();
  }
});

test("a machinery recovery never resolves the retention failure alert", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await new PipelineSetupRepository(harness.database).createOrganization({
      id: organizationId,
      slug: "machinery-retention",
      name: "Machinery Retention",
      createdAt: occurredAt,
    });
    const publisher = new PrismaAdminNotificationPublisher(harness.database);
    let issued = 0;
    const events = new OperationalEventService(
      publisher,
      {
        id: () =>
          `9b000000-0000-4000-8000-${String(2_000 + ++issued).padStart(12, "0")}`,
      },
      { now: () => new Date(occurredAt.getTime() + issued * 1_000) },
    );
    await events.retentionFailed({
      organizationId,
      failureCode: "RETENTION_BATCH_FAILED",
    });

    const cadence = conditions[4];
    assert.ok(cadence);
    await new MachineryAlertService(
      new ScriptedSource([{ conditions: [], openAlerts: [openFor(cadence)] }]),
      events,
    ).runCycle();

    const failure = await harness.database.admin_alerts.findFirst({
      where: { organization_id: organizationId, kind: "retention_failed" },
    });
    assert.equal(failure?.state, "active");
  } finally {
    await harness.close();
  }
});
