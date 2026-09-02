import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { ProviderWorkerRuntime } from "./provider-worker-runtime.ts";
import { createProductionWorkerRuntime } from "./production-worker-composition.ts";

test("production composition wires the provider, Heat, and retention lanes", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const input: Parameters<typeof createProductionWorkerRuntime>[0] = {
      provider: {
        actorPseudonymKey: new Uint8Array(32).fill(1),
        credentialKey: new Uint8Array(32).fill(2),
        credentialKeyVersion: 1,
        databasePoolMaximum: 5,
        databaseUrl: "postgresql://unused.invalid/packscout",
        environment: "test",
        estimatedEvVerifiedUsdStablecoins: [],
        heartbeatIntervalMilliseconds: 15_000,
        importRunLeaseMilliseconds: 120_000,
        maximumClaimsPerCycle: 5,
        messageOutboxBackoffBaseMilliseconds: 1_000,
        messageOutboxBackoffCapMilliseconds: 60_000,
        messageOutboxBatchSize: 10,
        messageOutboxLeaseMilliseconds: 30_000,
        messageOutboxMaximumAttempts: 4,
        messageOutboxPerRecipientLimit: 3,
        messageOutboxPollMilliseconds: 1_000,
        messageOutboxRetentionDays: 30,
        pollIntervalMilliseconds: 100,
        publicOrganizationId: "54000000-0000-4000-8000-000000000001",
        presenceRetentionDays: 14,
        // Presence staleness has to leave room for a missed heartbeat.
        presenceStaleAfterMilliseconds: 60_000,
        retentionBatchSize: 10,
        retentionMaximumBatchesPerCycle: 2,
        retentionOrganizationDiscoveryLimit: 10,
        sourceSupervisor: {
          actorPseudonymKey: new Uint8Array(32).fill(1),
          databaseUrl: "postgresql://unused.invalid/packscout",
          environment: "test",
          sourceConnectionConfigurationKey: new Uint8Array(32).fill(8),
          sourceConnectionConfigurationKeyVersion: 1,
          sourceDatabaseVolumePath: "/tmp",
          workerId: "production-composition-worker",
        },
        runHeartbeatStaleAfterMilliseconds: 300_000,
        scheduleClaimLeaseMilliseconds: 30_000,
        welcomeDispatchBatchSize: 10,
        welcomeDispatchLeaseMilliseconds: 300_000,
        welcomeDispatchPollMilliseconds: 60_000,
        workerHost: "composition-host",
        workerId: "production-composition-worker",
        workerVersion: "0.0.0-test",
      },
      heat: {
        convexBaseUrl: "https://convex.example",
        deploymentKey: "production-us",
        keyId: "catalog-publisher.v1",
        requestTimeoutMilliseconds: 10_000,
        retentionBatchSize: 500,
        retentionMaximumBatchesPerCycle: 4,
        secret: new Uint8Array(32).fill(6),
      },
      retention: {
        convexBaseUrl: "https://convex.example",
        deploymentKey: "production-us",
        keyId: "catalog.retention.v1",
        secret: new Uint8Array(32).fill(7),
        requestTimeoutMilliseconds: 10_000,
        intervalMilliseconds: 3_600_000,
        continuationIntervalMilliseconds: 1_000,
        maximumDocuments: 90,
        maximumPostgresRowsPerStep: 100,
        maximumStepsPerCycle: 25,
      },
      database: harness.client,
      providerLogger: { write() {} },
      heatLogger: { write() {} },
      retentionLogger: { write() {} },
      observability: { metric() {}, log() {} },
      fetch: async () => new Response(),
    };
    const runtime = createProductionWorkerRuntime(input);
    assert.ok(runtime instanceof ProviderWorkerRuntime);
    // Without the supervisor settings the lane is skipped, not fatal.
    assert.ok(
      createProductionWorkerRuntime({
        ...input,
        provider: { ...input.provider, sourceSupervisor: undefined },
      }) instanceof ProviderWorkerRuntime,
    );
    assert.throws(
      () => createProductionWorkerRuntime({
        ...input,
        retention: { ...input.retention, secret: input.heat.secret },
      }),
      /configuration is invalid/u,
    );
  } finally {
    await harness.close();
  }
});

test("default production has no legacy composite publication authority", async () => {
  for (const file of [
    "./production-worker-composition.ts",
    "./index.ts",
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /PromotionV2/u);
    assert.doesNotMatch(source, /promotion-v2-worker/u);
    assert.doesNotMatch(source, /createPromotionV2WorkerRuntime/u);
    assert.doesNotMatch(source, /createCatalogPromotionWorkerRuntime/u);
    assert.doesNotMatch(source, /SignedConvexCatalogPublicationClient/u);
    assert.doesNotMatch(source, /PrismaCatalogPromotionRepository/u);
    assert.doesNotMatch(source, /CatalogReleaseAssembler/u);
  }
});
