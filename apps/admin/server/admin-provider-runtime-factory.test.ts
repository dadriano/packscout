import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderDatabaseDestinationPolicyError,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
} from "@packscout/database";
import {
  dataforrestClutchpacksDistributedSourceAdapterManifest,
} from "@packscout/contracts";
import {
  createClutchpacksSourceIntegrationCapabilities,
} from "@packscout/services";
import {
  createAdminProviderRuntimeFactory,
  readAdminProviderDestinationPolicy,
} from "./admin-provider-runtime-factory.ts";
import { createDistributedProviderSourceOperationsRuntime } from
  "./distributed-provider-source-operations-runtime.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const providerId = "10000000-0000-4000-8000-000000000002";
const revisionId = "10000000-0000-4000-8000-000000000003";
const now = new Date("2026-08-29T18:00:00.000Z");

test("admin provider destination policy allows only local review provider databases in development", () => {
  const policy = readAdminProviderDestinationPolicy({ NODE_ENV: "development" });
  for (const port of [55_432, 55_433, 55_434, 55_435]) {
    assert.doesNotThrow(() => policy.assertAllowed({
      host: "127.0.0.1",
      port,
      sslMode: "disable",
    }));
  }
  for (const target of [
    { host: "localhost", port: 55_432, sslMode: "disable" },
    { host: "127.0.0.1", port: 5_432, sslMode: "disable" },
    { host: "127.0.0.1", port: 55_436, sslMode: "disable" },
    { host: "127.0.0.1", port: 55_432, sslMode: "verify-full" },
  ]) {
    assert.throws(
      () => policy.assertAllowed(target),
      ProviderDatabaseDestinationPolicyError,
    );
  }
});

test("admin provider destination policy requires secure explicit production hosts", () => {
  assert.throws(
    () => readAdminProviderDestinationPolicy({ NODE_ENV: "production" }),
    /PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS/u,
  );
  const policy = readAdminProviderDestinationPolicy({
    NODE_ENV: "production",
    PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: "db.internal.example",
  });
  assert.doesNotThrow(() => policy.assertAllowed({
    host: "db.internal.example",
    port: 5_432,
    sslMode: "verify-full",
  }));
  assert.throws(
    () => policy.assertAllowed({
      host: "db.internal.example",
      port: 5_432,
      sslMode: "disable",
    }),
    ProviderDatabaseDestinationPolicyError,
  );
});

test("distributed source overview accepts one bounded ClutchPacks lane with real local evidence", async () => {
  const diagnosticRunId = "10000000-0000-4000-8000-000000000004";
  const central = {
    provider_activity_events: {
      async findMany(input: { where: { organization_id: string; provider_id: string } }) {
        assert.equal(input.where.organization_id, organizationId);
        assert.equal(input.where.provider_id, providerId);
        return [{ id: diagnosticRunId, event_type: "import_run_started", severity: "info", event_at: now, local_run_id: diagnosticRunId, local_quarantine_id: null }];
      },
    },
    providers: {
      async findMany() {
        return [{
          id: providerId,
          provider_key: "clutchpacks",
          display_name: "ClutchPacks",
          lifecycle: "active",
          active_config_version: {
            id: revisionId,
            adapter_key:
              dataforrestClutchpacksDistributedSourceAdapterManifest
                .adapterVersion,
            schedule_seconds: 300,
            stale_after_seconds: 900,
          },
        }];
      },
    },
  } as unknown as CentralPrismaClient;
  const gateway = {
    async runWithAdminProviderDatabase() {
      return {
        state: "reachable" as const,
        providerId,
        observedAt: now.toISOString(),
        value: {
          overview: {
            runtimeState: "idle" as const,
            runtimeReason: null,
            runtimeGeneration: 1n,
            nextDueAt: now,
            lastAttemptedAt: null,
            lastHeadReachedAt: null,
            lastRunnerHeartbeatAt: null,
            freshnessState: "unknown",
            qualityState: "unknown",
            consecutiveFailures: 0,
            latestFailureCode: null,
            recoveredAt: null,
            activeRun: null,
            latestRun: null,
            openQuarantineCount: 0,
            latestQuarantineReasonCode: null,
            latestRetention: null,
          },
          runs: [],
          details: [],
        },
      };
    },
  } as unknown as Pick<
    BoundedProviderDatabaseGateway,
    "runWithAdminProviderDatabase"
  >;
  const runtime = createDistributedProviderSourceOperationsRuntime({
    central,
    gateway,
    sourceIntegrations: createClutchpacksSourceIntegrationCapabilities(),
    diagnosticCursorKey: new Uint8Array(32).fill(9),
    now: () => now,
  });

  const overview = await runtime.operations.overview(organizationId);
  assert.equal(overview.sources.length, 1);
  assert.equal(overview.sources[0]?.provider, "clutchpacks");
  assert.equal(overview.sources[0]?.source?.sourceRevisionId, revisionId);
  assert.equal(overview.sources[0]?.source?.lifecycle, "active");
  const diagnostics = await runtime.operations.diagnostics({ organizationId, providerId, filter: {}, limit: 25 });
  assert.equal(diagnostics.response.events[0]?.references[0]?.href, `/runs/${diagnosticRunId}?providerId=${providerId}`);
});

test("concrete factory composes current-admin provider dependencies without legacy DB", async () => {
  const central = {} as CentralPrismaClient;
  const runtime = await createAdminProviderRuntimeFactory({
    central,
    environment: {
      NODE_ENV: "development",
      PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64:
        Buffer.alloc(32, 7).toString("base64"),
      PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "1",
    },
    actorPseudonymKey: new Uint8Array(32).fill(8),
    sourceAdministration: null,
    recomputationBacklogLimit: 100,
    catalogDeploymentKey: null,
  });
  assert.ok(runtime.app.canonical);
  assert.ok(runtime.app.importOperations);
  assert.ok(runtime.app.providerSourceOperations);
  assert.equal(runtime.app.providerSources, undefined);
  await runtime.close();
});
