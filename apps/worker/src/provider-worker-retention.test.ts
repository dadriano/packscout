import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DrizzleProtectedPayloadRetentionRepository,
  IngestionPersistenceRepository,
  PipelineSetupRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { JsonConsoleProviderWorkerObservability } from "./provider-worker-observability.ts";
import { createProviderWorkerOperationalRuntime } from "./provider-worker-operational-runtime.ts";
import { createProviderWorkerRetentionCoordinator } from "./provider-worker-retention.ts";

const ids = {
  organization: "79000000-0000-4000-8000-000000000001",
  provider: "79000000-0000-4000-8000-000000000002",
  configuration: "79000000-0000-4000-8000-000000000003",
  run: "79000000-0000-4000-8000-000000000004",
} as const;
const committedAt = new Date("2026-01-01T12:00:00.000Z");
const retentionAt = new Date("2026-04-02T12:00:00.000Z");

test("worker retention composition expires a bounded durable batch", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: ids.organization,
      slug: "worker-retention",
      name: "Worker Retention",
      createdAt: committedAt,
    });
    await setup.createProviderSource({
      id: ids.provider,
      organizationId: ids.organization,
      platformKey: "fixture-provider",
      displayName: "Fixture Provider",
      createdAt: committedAt,
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
      createdAt: committedAt,
    });
    await setup.createImportRun({
      id: ids.run,
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.configuration,
      trigger: "scheduled",
      state: "succeeded",
      createdAt: committedAt,
    });
    const sensitive = "Bearer raw-provider-secret";
    const ingestion = new IngestionPersistenceRepository(harness.database, {
      retentionDays: 90,
      actorPseudonymKey: "worker-retention-test-key",
    });
    await ingestion.commitPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.configuration,
      runId: ids.run,
      pageNumber: 1,
      requestedCursor: null,
      nextCursor: null,
      hasMore: false,
      payload: { protected: sensitive },
      records: [],
      committedAt,
    });

    const clock = { now: () => new Date(retentionAt) };
    let generatedId = 0;
    const idSource = {
      id: () =>
        `79000000-0000-4000-8001-${String(++generatedId).padStart(12, "0")}`,
    };
    const jsonLines: string[] = [];
    const observability = new JsonConsoleProviderWorkerObservability(
      "worker-1",
      { write: (_level, serialized) => void jsonLines.push(serialized) },
    );
    const operational = createProviderWorkerOperationalRuntime({
      database: harness.database,
      ids: idSource,
      clock,
      observability,
    });
    const retention = createProviderWorkerRetentionCoordinator({
      database: harness.database,
      ids: idSource,
      clock,
      events: operational.events,
      observability,
      config: {
        batchSize: 1,
        maxBatchesPerCycle: 1,
        organizationDiscoveryLimit: 1,
      },
    });

    const result = await retention.runCycle();

    assert.equal(result.discoveredOrganizations, 1);
    assert.equal(result.batchesRun, 1);
    assert.equal(result.expired, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.capReached, false);
    assert.equal(jsonLines.length, 7);
    assert.equal(jsonLines.join("\n").includes(sensitive), false);
    assert.equal(
      jsonLines.some((line) =>
        line.includes('"name":"retention_expired_total"'),
      ),
      true,
    );

    const discovery = new DrizzleProtectedPayloadRetentionRepository(
      harness.database,
      clock,
    );
    assert.deepEqual(
      await discovery.discoverEligibleOrganizations({
        cutoffAt: retentionAt,
        limit: 1,
      }),
      [],
    );
  } finally {
    await harness.close();
  }
});
