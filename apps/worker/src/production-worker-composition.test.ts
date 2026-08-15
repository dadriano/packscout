import assert from "node:assert/strict";
import { test } from "node:test";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { ProviderWorkerRuntime } from "./provider-worker-runtime.ts";
import { createProductionWorkerRuntime } from "./production-worker-composition.ts";

test("production composition wires the catalog lane into the provider worker", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const runtime = createProductionWorkerRuntime({
      provider: {
        actorPseudonymKey: new Uint8Array(32).fill(1),
        credentialKey: new Uint8Array(32).fill(2),
        credentialKeyVersion: 1,
        databasePoolMaximum: 5,
        databaseUrl: "postgresql://unused.invalid/packscout",
        environment: "test",
        estimatedEvVerifiedUsdStablecoins: [],
        maximumClaimsPerCycle: 5,
        pollIntervalMilliseconds: 100,
        publicOrganizationId: "54000000-0000-4000-8000-000000000001",
        retentionBatchSize: 10,
        retentionMaximumBatchesPerCycle: 2,
        retentionOrganizationDiscoveryLimit: 10,
        workerId: "production-composition-worker",
      },
      catalog: {
        convexBaseUrl: "https://convex.example",
        deploymentKey: "production-us",
        keyId: "catalog-publisher.v1",
        pollIntervalMilliseconds: 5_000,
        requestTimeoutMilliseconds: 10_000,
        secret: new Uint8Array(32).fill(3),
      },
      heat: {
        convexBaseUrl: "https://convex.example",
        deploymentKey: "production-us",
        keyId: "catalog-publisher.v1",
        requestTimeoutMilliseconds: 10_000,
        retentionBatchSize: 500,
        retentionMaximumBatchesPerCycle: 4,
        secret: new Uint8Array(32).fill(3),
      },
      database: harness.client,
      providerLogger: { write() {} },
      catalogLogger: { write() {} },
      heatLogger: { write() {} },
      observability: { metric() {}, log() {} },
      fetch: async () => new Response(),
    });
    assert.ok(runtime instanceof ProviderWorkerRuntime);
  } finally {
    await harness.close();
  }
});
