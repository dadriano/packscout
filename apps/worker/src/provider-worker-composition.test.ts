import assert from "node:assert/strict";
import { test } from "node:test";
import { PipelineSetupRepository } from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import {
  ProviderTransportAdapterRegistry,
  type ProviderTransportAdapter,
  type ProviderTransportPageInput,
} from "@packscout/services";
import { createProviderWorkerRuntime } from "./provider-worker-composition.ts";
import type { ProviderWorkerLogEvent } from "./provider-worker-runtime.ts";

class ContinuingPageTransport implements ProviderTransportAdapter {
  readonly key = "http-cursor-v2";
  readonly requestedCursors: Array<string | null> = [];

  supportsPlatform(platform: string): boolean {
    return platform === "courtyard";
  }

  async testConnection() {
    return {
      ok: true as const,
      latencyMs: 1,
      responseStatus: 200,
      recordCounts: { catalog: 0, pulls: 0, trades: 0 },
      hasMore: true,
      nextCursorPresent: true,
    };
  }

  async fetchPage(input: ProviderTransportPageInput) {
    this.requestedCursors.push(input.cursor);
    const nextCursor = `bounded-page-${this.requestedCursors.length}`;
    const rawRecord = {
      stream: "catalog",
      platform: "courtyard",
      record_id: nextCursor,
    };
    const invalidRecord = {
      status: "invalid" as const,
      recordIndex: 0,
      rawRecord,
      issues: [
        {
          code: "invalid_type" as const,
          path: "records[0].collected_at",
        },
      ],
    };
    return {
      rawPage: { records: [rawRecord] },
      page: {
        requestedCursor: input.cursor,
        nextCursor,
        hasMore: true,
        records: [],
      },
      recordOutcomes: [invalidRecord],
      invalidRecords: [invalidRecord],
    };
  }
}

test("worker composition runs an idle cycle against one Prisma client", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const events: ProviderWorkerLogEvent[] = [];
    const runtime = createProviderWorkerRuntime({
      configuration: {
        actorPseudonymKey: new Uint8Array(32).fill(1),
        credentialKey: new Uint8Array(32).fill(2),
        credentialKeyVersion: 1,
        environment: "test",
        estimatedEvVerifiedUsdStablecoins: [],
        importMaximumPages: 50_000,
        importMaximumRunDurationMilliseconds: 4 * 60 * 60_000,
        importMinimumFreeBytes: 0,
        importPageBudgetPerClaim: 50_000,
        maximumClaimsPerCycle: 5,
        pollIntervalMilliseconds: 100,
        retentionBatchSize: 10,
        retentionMaximumBatchesPerCycle: 2,
        retentionOrganizationDiscoveryLimit: 10,
        workerId: "prisma-composition-worker",
      },
      database: harness.client,
      logger: { write: (event) => void events.push(event) },
      observability: { metric() {}, log() {} },
    });

    const result = await runtime.runCycle();

    assert.deepEqual(result, {
      claims: 0,
      executions: 0,
      contentions: 0,
      failures: 0,
      reason: "idle",
    });
    assert.deepEqual(
      events.map(({ event }) => event),
      [
        "provider_estimated_ev_cycle_finished",
        "provider_retention_cycle_finished",
      ],
    );
  } finally {
    await harness.close();
  }
});

test("worker composition fails a live V2 import closed when no response decoder is registered", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const now = new Date();
    const organizationId = "77000000-0000-4000-8000-000000000001";
    const providerId = "77000000-0000-4000-8000-000000000002";
    const revisionId = "77000000-0000-4000-8000-000000000003";
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: organizationId,
      slug: "decoder-unavailable",
      name: "Decoder Unavailable",
      createdAt: now,
    });
    await setup.createProviderSource({
      id: providerId,
      organizationId,
      platformKey: "courtyard",
      displayName: "Courtyard",
      createdAt: now,
    });
    await setup.createConfigRevision({
      id: revisionId,
      organizationId,
      providerId,
      version: 1,
      adapterKey: "http-cursor-v2",
      endpointUrl: "https://provider.example/feed",
      authMode: "none",
      createdByActorKey: "actor:test",
      createdAt: now,
    });
    await setup.recordSuccessfulConnectionTest({
      organizationId,
      providerId,
      revisionId,
      actorKey: "actor:test",
      testedAt: now,
      latencyMs: 1,
    });
    await setup.activateConfiguration({
      organizationId,
      providerId,
      revisionId,
      actorKey: "actor:test",
      activatedAt: now,
      nextRunAt: new Date(now.getTime() - 60_000),
    });

    const events: ProviderWorkerLogEvent[] = [];
    const runtime = createProviderWorkerRuntime({
      configuration: {
        actorPseudonymKey: new Uint8Array(32).fill(1),
        credentialKey: new Uint8Array(32).fill(2),
        credentialKeyVersion: 1,
        environment: "test",
        estimatedEvVerifiedUsdStablecoins: [],
        importMaximumPages: 50_000,
        importMaximumRunDurationMilliseconds: 4 * 60 * 60_000,
        importMinimumFreeBytes: 0,
        importPageBudgetPerClaim: 50_000,
        maximumClaimsPerCycle: 5,
        pollIntervalMilliseconds: 100,
        retentionBatchSize: 10,
        retentionMaximumBatchesPerCycle: 2,
        retentionOrganizationDiscoveryLimit: 10,
        workerId: "decoder-unavailable-worker",
      },
      database: harness.client,
      logger: { write: (event) => void events.push(event) },
      observability: { metric() {}, log() {} },
    });

    const result = await runtime.runCycle();
    assert.equal(result.executions, 1);
    assert.equal(result.failures, 0);
    const runs = await harness.database.import_runs.findMany({
      where: { organization_id: organizationId, provider_id: providerId },
      select: { state: true, failure_code: true },
    });
    assert.deepEqual(runs, [
      {
        state: "failed",
        failure_code: "IMPORT_CONFIGURATION_UNAVAILABLE",
      },
    ]);
    assert.ok(
      events.some(
        (event) =>
          event.event === "provider_import_finished" &&
          event.failureCode === "IMPORT_CONFIGURATION_UNAVAILABLE",
      ),
    );
  } finally {
    await harness.close();
  }
});

test("worker composition stops a continuing import at the configured page bound", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const now = new Date();
    const organizationId = "78000000-0000-4000-8000-000000000001";
    const providerId = "78000000-0000-4000-8000-000000000002";
    const revisionId = "78000000-0000-4000-8000-000000000003";
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: organizationId,
      slug: "bounded-import",
      name: "Bounded Import",
      createdAt: now,
    });
    await setup.createProviderSource({
      id: providerId,
      organizationId,
      platformKey: "courtyard",
      displayName: "Courtyard",
      createdAt: now,
    });
    await setup.createConfigRevision({
      id: revisionId,
      organizationId,
      providerId,
      version: 1,
      adapterKey: "http-cursor-v2",
      endpointUrl: "https://provider.example/feed",
      authMode: "none",
      createdByActorKey: "actor:test",
      createdAt: now,
    });
    await setup.recordSuccessfulConnectionTest({
      organizationId,
      providerId,
      revisionId,
      actorKey: "actor:test",
      testedAt: now,
      latencyMs: 1,
    });
    await setup.activateConfiguration({
      organizationId,
      providerId,
      revisionId,
      actorKey: "actor:test",
      activatedAt: now,
      nextRunAt: new Date(now.getTime() - 60_000),
    });

    const transport = new ContinuingPageTransport();
    const runtime = createProviderWorkerRuntime({
      configuration: {
        actorPseudonymKey: new Uint8Array(32).fill(1),
        credentialKey: new Uint8Array(32).fill(2),
        credentialKeyVersion: 1,
        environment: "test",
        estimatedEvVerifiedUsdStablecoins: [],
        importMaximumPages: 1,
        importMaximumRunDurationMilliseconds: 4 * 60 * 60_000,
        importMinimumFreeBytes: 0,
        importPageBudgetPerClaim: 1,
        maximumClaimsPerCycle: 5,
        pollIntervalMilliseconds: 100,
        retentionBatchSize: 10,
        retentionMaximumBatchesPerCycle: 2,
        retentionOrganizationDiscoveryLimit: 10,
        workerId: "bounded-import-worker",
      },
      database: harness.client,
      logger: { write() {} },
      observability: { metric() {}, log() {} },
      transportAdapters: new ProviderTransportAdapterRegistry([transport]),
    });

    const result = await runtime.runCycle();

    assert.equal(result.executions, 1);
    assert.deepEqual(transport.requestedCursors, [null]);
    assert.equal(
      await harness.database.import_pages.count({
        where: { organization_id: organizationId, provider_id: providerId },
      }),
      1,
    );
    const run = await harness.database.import_runs.findFirstOrThrow({
      where: { organization_id: organizationId, provider_id: providerId },
      select: {
        state: true,
        failure_code: true,
        final_cursor: true,
        counters_json: true,
      },
    });
    assert.equal(run.state, "failed");
    assert.equal(run.failure_code, "IMPORT_RUN_LIMIT_REACHED");
    assert.equal(run.final_cursor, "bounded-page-1");
    assert.deepEqual(run.counters_json, {
      pages: 1,
      records: 1,
      accepted: 0,
      duplicate: 0,
      quarantined: 1,
      requestAttempts: 1,
      transientRetries: 0,
    });
  } finally {
    await harness.close();
  }
});
