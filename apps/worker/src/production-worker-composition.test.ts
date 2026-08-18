import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { ProviderWorkerRuntime } from "./provider-worker-runtime.ts";
import { createProductionWorkerRuntime } from "./production-worker-composition.ts";

test("production composition wires provider and manifest lanes without legacy catalog", async () => {
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
        maximumClaimsPerCycle: 5,
        pollIntervalMilliseconds: 100,
        publicOrganizationId: "54000000-0000-4000-8000-000000000001",
        retentionBatchSize: 10,
        retentionMaximumBatchesPerCycle: 2,
        retentionOrganizationDiscoveryLimit: 10,
        workerId: "production-composition-worker",
      },
      promotion: {
        convexBaseUrl: "https://convex.example",
        deploymentKey: "production-us",
        providerCredentials: [{
          platformKey: "alpha",
          keyId: "provider.alpha.v1",
          secret: new Uint8Array(32).fill(3),
        }],
        manifestPublishCredential: {
          keyId: "manifest.publish.v1",
          secret: new Uint8Array(32).fill(4),
        },
        manifestClearCredential: {
          keyId: "manifest.clear.v1",
          secret: new Uint8Array(32).fill(5),
        },
        pollIntervalMilliseconds: 5_000,
        requestTimeoutMilliseconds: 10_000,
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
      promotionLogger: { write() {} },
      heatLogger: { write() {} },
      retentionLogger: { write() {} },
      observability: { metric() {}, log() {} },
      fetch: async () => new Response(),
    };
    const runtime = createProductionWorkerRuntime(input);
    assert.ok(runtime instanceof ProviderWorkerRuntime);
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

test("production composition has no legacy global catalog publication path", async () => {
  const source = await readFile(
    new URL("./production-worker-composition.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /createPromotionV2WorkerRuntime/);
  assert.doesNotMatch(source, /createCatalogPromotionWorkerRuntime/);
  assert.doesNotMatch(source, /SignedConvexCatalogPublicationClient/);
  assert.doesNotMatch(source, /PrismaCatalogPromotionRepository/);
  assert.doesNotMatch(source, /CatalogReleaseAssembler/);
});
