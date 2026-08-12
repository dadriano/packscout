import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PrismaAdminNotificationPublisher,
  PipelineSetupRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import {
  ProviderImportWorkerService,
  type ProviderImportRunSummary,
} from "@packscout/services";
import {
  JsonConsoleProviderWorkerObservability,
  type ProviderWorkerJsonSink,
} from "./provider-worker-observability.ts";
import { createProviderWorkerOperationalRuntime } from "./provider-worker-operational-runtime.ts";

const ids = {
  organization: "78000000-0000-4000-8000-000000000001",
  provider: "78000000-0000-4000-8000-000000000002",
  configuration: "78000000-0000-4000-8000-000000000003",
  run: "78000000-0000-4000-8000-000000000004",
} as const;
const startedAt = new Date("2026-08-06T12:00:00.000Z");
const finishedAt = new Date("2026-08-06T12:00:05.000Z");

test("worker operational composition durably alerts on a terminal failed run", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: ids.organization,
      slug: "worker-operational-runtime",
      name: "Worker Operational Runtime",
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
    await setup.createImportRun({
      id: ids.run,
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.configuration,
      trigger: "scheduled",
      state: "failed",
      createdAt: startedAt,
    });

    const jsonLines: string[] = [];
    const sink: ProviderWorkerJsonSink = {
      write: (_level, serialized) => void jsonLines.push(serialized),
    };
    let eventId = 0;
    const operational = createProviderWorkerOperationalRuntime({
      database: harness.database,
      ids: {
        id: () =>
          `78000000-0000-4000-8001-${String(++eventId).padStart(12, "0")}`,
      },
      clock: { now: () => finishedAt },
      observability: new JsonConsoleProviderWorkerObservability(
        "worker-1",
        sink,
      ),
    });
    const sensitive = "Bearer raw-provider-secret";
    const failedRun: ProviderImportRunSummary = {
      id: ids.run,
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.configuration,
      trigger: "scheduled",
      state: "failed",
      requestedCursor: null,
      finalCursor: null,
      startedAt,
      finishedAt,
      heartbeatAt: finishedAt,
      counters: {
        accepted: 2,
        duplicate: 0,
        quarantined: 1,
        pages: 1,
        records: 3,
        requestAttempts: 2,
        transientRetries: 1,
      },
      reachedProviderHead: false,
      failureCode: "IMPORT_TIMEOUT",
      failureSummary: sensitive,
    };
    const healthInputs: unknown[] = [];
    const service = new ProviderImportWorkerService(
      {
        executeImport: async () => failedRun,
        executeNextImport: async () => ({ kind: "idle" }),
      },
      {
        recordRunOutcome: async (input) => void healthInputs.push(input),
      },
      {
        events: operational.events,
        reporter: operational.reporter,
      },
    );

    const result = await service.executeImport({
      organizationId: ids.organization,
      runId: ids.run,
      workerId: "worker-1",
    });

    assert.equal(result, failedRun);
    assert.equal(healthInputs.length, 1);
    const alerts = new PrismaAdminNotificationPublisher(harness.database);
    const summaries = await alerts.listAlerts({
      organizationId: ids.organization,
      state: "active",
      limit: 10,
    });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.kind, "run_failed");
    assert.equal(summaries[0]?.runId, ids.run);
    const detail = summaries[0]
      ? await alerts.getAlert(ids.organization, summaries[0].id)
      : null;
    assert.equal(detail?.occurrences[0]?.evidence.failureCode, "IMPORT_TIMEOUT");
    assert.equal(jsonLines.length, 12);
    assert.equal(
      JSON.stringify({ summaries, detail, jsonLines }).includes(sensitive),
      false,
    );
    assert.equal(
      jsonLines.some((line) => line.includes('"name":"run_outcome_total"')),
      true,
    );
    assert.equal(
      jsonLines.some((line) => line.includes('"kind":"notification"')),
      true,
    );
  } finally {
    await harness.close();
  }
});
