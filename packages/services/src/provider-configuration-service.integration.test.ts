import assert from "node:assert/strict";
import { test } from "node:test";
import type { CreateProviderRequest } from "@packscout/contracts";
import {
  PrismaProviderConfigurationRepository,
  PipelineSetupRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import type {
  ProviderConnectionTestResult,
  ProviderTransportAdapter,
  ProviderTransportConnectionInput,
  ProviderTransportPageInput,
} from "./provider-adapter.ts";
import { ProviderTransportAdapterRegistry } from "./provider-adapter-registry.ts";
import {
  ProviderConfigurationService,
  ProviderConfigurationServiceError,
  type ProviderActor,
} from "./provider-configuration-service.ts";
import { AesGcmProviderCredentialCipher } from "./provider-credential-cipher.ts";
import { HttpCursorAdapter } from "./http-cursor-adapter.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const otherOrganizationId = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-08-06T12:00:00.000Z");
const admin: ProviderActor = {
  organizationId,
  operatorId: "00000000-0000-4000-8000-000000000003",
  role: "admin",
};
const dataOperator: ProviderActor = {
  ...admin,
  operatorId: "00000000-0000-4000-8000-000000000004",
  role: "data_operator",
};

function validPage(platform: string) {
  return {
    catalog: [
      {
        platform,
        external_id: `${platform}:pack:1`,
        updated_at: "2026-08-06T11:00:00.000Z",
        collected_at: "2026-08-06T11:01:00.000Z",
        data: { name: "Fixture Pack" },
      },
    ],
    pulls: [],
    sales: [],
    next_cursor: "fixture-complete",
    has_more: false,
  };
}

class TrackingTransportAdapter implements ProviderTransportAdapter {
  readonly key = "http-cursor-v1";
  readonly connectionInputs: ProviderTransportConnectionInput[] = [];
  failConnection = false;
  readonly #inner: HttpCursorAdapter;

  constructor() {
    this.#inner = new HttpCursorAdapter({
      resolveHost: async () => ["93.184.216.34"],
      httpClient: async (input) => {
        const platform = new URL(String(input)).searchParams.get("platform")!;
        return new Response(JSON.stringify(validPage(platform)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      now: (() => {
        let value = 100;
        return () => value++;
      })(),
    });
  }

  supportsPlatform(platform: string): boolean {
    return platform.length > 0;
  }

  testConnection(
    input: ProviderTransportConnectionInput,
  ): Promise<ProviderConnectionTestResult> {
    this.connectionInputs.push(input);
    if (this.failConnection) {
      return Promise.resolve({
        ok: false,
        latencyMs: 2,
        failure: { code: "invalid_response", retryable: false },
      });
    }
    return this.#inner.testConnection(input);
  }

  fetchPage(input: ProviderTransportPageInput) {
    return this.#inner.fetchPage(input);
  }
}

class AuthenticationFailureAdapter implements ProviderTransportAdapter {
  readonly key = "auth-failure-v1";

  supportsPlatform(): boolean {
    return true;
  }

  async testConnection(): Promise<ProviderConnectionTestResult> {
    return {
      ok: false,
      latencyMs: 12,
      failure: { code: "http_error", retryable: false, httpStatus: 401 },
    };
  }

  async fetchPage(): Promise<never> {
    throw new Error("Not used by connection tests.");
  }
}

function createIdSource() {
  let value = 100;
  return {
    id() {
      value += 1;
      return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
    },
  };
}

function createRequest(
  overrides: Partial<CreateProviderRequest> = {},
): CreateProviderRequest {
  return {
    platformKey: "beezie",
    displayName: "Beezie",
    adapterKey: "http-cursor-v1",
    endpoint: "https://Provider.Example./feed",
    scheduleSeconds: 300,
    staleAfterSeconds: 900,
    auth: {
      mode: "bearer" as const,
      bearerSecret: "fixture-initial-secret",
    },
    ...overrides,
  };
}

async function captureServiceError(
  operation: Promise<unknown>,
): Promise<ProviderConfigurationServiceError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof ProviderConfigurationServiceError);
    return error;
  }
  assert.fail("Expected provider configuration operation to fail.");
}

test("provider lifecycle is versioned, masked, tenant-scoped, and non-importing", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: organizationId,
      slug: "packscout",
      name: "PackScout",
    });
    await setup.createOrganization({
      id: otherOrganizationId,
      slug: "other",
      name: "Other",
    });
    const adapter = new TrackingTransportAdapter();
    const repository = new PrismaProviderConfigurationRepository(
      harness.database,
    );
    const credentialCipher = new AesGcmProviderCredentialCipher({
      primaryVersion: 1,
      keys: new Map([[1, new Uint8Array(32).fill(11)]]),
    });
    const ids = createIdSource();
    const service = new ProviderConfigurationService({
      repository,
      adapters: new ProviderTransportAdapterRegistry([
        adapter,
        new AuthenticationFailureAdapter(),
      ]),
      credentialCipher,
      actorKeyer: {
        keyFor: ({ operatorId }) => `actor-key:${operatorId.slice(-4)}`,
      },
      clock: { now: () => now },
      ids,
      environment: "production",
      connectionTimeoutMs: 5_000,
      maximumConnectionResponseBytes: 64_000,
    });

    const provider = await service.createProvider(admin, createRequest());
    const providerId = provider.id;
    const firstRevisionId = provider.latestRevision.id;
    assert.equal(provider.state, "draft");
    assert.equal(provider.latestRevision.version, 1);
    assert.equal(provider.latestRevision.endpointHost, "provider.example");
    assert.equal(provider.latestRevision.hasBearerSecret, true);
    assert.doesNotMatch(JSON.stringify(provider), /fixture-initial-secret/);

    assert.deepEqual(await service.getProvider(dataOperator, providerId), provider);
    const crossTenant = await captureServiceError(
      service.getProvider(
        { ...admin, organizationId: otherOrganizationId },
        providerId,
      ),
    );
    assert.equal(crossTenant.code, "PROVIDER_NOT_FOUND");
    const forbidden = await captureServiceError(
      service.testConnection(dataOperator, providerId, firstRevisionId),
    );
    assert.equal(forbidden.code, "FORBIDDEN");

    const unknownAdapter = await captureServiceError(
      service.createProvider(
        admin,
        createRequest({ platformKey: "unknown", adapterKey: "missing-v1" }),
      ),
    );
    assert.equal(unknownAdapter.code, "UNKNOWN_ADAPTER");
    const invalidEndpoint = await captureServiceError(
      service.createProvider(
        admin,
        createRequest({
          platformKey: "unsafe",
          endpoint: "https://provider.example.attacker.test:8443/feed",
        }),
      ),
    );
    assert.equal(invalidEndpoint.code, "INVALID_PROVIDER_CONFIGURATION");
    const duplicate = await captureServiceError(
      service.createProvider(admin, createRequest({ displayName: "Duplicate" })),
    );
    assert.equal(duplicate.code, "PROVIDER_PLATFORM_CONFLICT");

    const beforeTestActivation = await captureServiceError(
      service.activateRevision(admin, providerId, firstRevisionId),
    );
    assert.equal(beforeTestActivation.code, "PROVIDER_CONNECTION_FAILED");
    const testResult = await service.testConnection(
      admin,
      providerId,
      firstRevisionId,
    );
    assert.deepEqual(testResult, {
      verdict: "success",
      checkedAt: now.toISOString(),
      latencyMs: 1,
      responseStatus: 200,
      recordCounts: { catalog: 1, pulls: 0, sales: 0 },
      hasMore: false,
      nextCursorPresent: true,
      sanitizedCode: null,
    });
    assert.equal(adapter.connectionInputs.length, 1);
    assert.deepEqual(adapter.connectionInputs[0]?.allowedHosts, [
      "provider.example",
    ]);
    assert.equal(adapter.connectionInputs[0]?.endpoint, "https://provider.example/feed");
    assert.deepEqual(adapter.connectionInputs[0]?.auth, {
      mode: "bearer",
      token: "fixture-initial-secret",
    });

    assert.deepEqual(
      await Promise.all([
        harness.database.import_pages.count(),
        harness.database.source_records.count(),
        harness.database.canonical_revisions.count(),
        harness.database.import_runs.count(),
      ]),
      [0, 0, 0, 0],
    );
    assert.equal(await harness.database.provider_cursor_checkpoints.count(), 0);

    const concurrentActivations = await Promise.all([
      service.activateRevision(admin, providerId, firstRevisionId),
      service.activateRevision(admin, providerId, firstRevisionId),
    ]);
    assert.ok(
      concurrentActivations.every(
        (result) => result.activeRevisionId === firstRevisionId,
      ),
    );
    assert.equal(
      await harness.database.provider_cursor_checkpoints.count({
        where: { provider_id: providerId, organization_id: organizationId },
      }),
      1,
    );
    const active = concurrentActivations[0]!;
    assert.equal(active.state, "active");
    assert.equal(active.activeRevisionId, firstRevisionId);
    assert.equal(active.nextRunAt, new Date(now.getTime() + 300_000).toISOString());
    adapter.failConnection = true;
    const failedRetest = await service.testConnection(
      admin,
      providerId,
      firstRevisionId,
    );
    assert.equal(failedRetest.verdict, "contract_failure");
    assert.equal(
      (await service.getProvider(admin, providerId)).latestRevision.testedAt,
      null,
    );
    const failedRetestActivation = await captureServiceError(
      service.activateRevision(admin, providerId, firstRevisionId),
    );
    assert.equal(failedRetestActivation.code, "PROVIDER_CONNECTION_FAILED");
    adapter.failConnection = false;
    await service.testConnection(admin, providerId, firstRevisionId);
    const runId = "00000000-0000-4000-8000-000000000900";
    await setup.createImportRun({
      id: runId,
      organizationId,
      providerId,
      configRevisionId: firstRevisionId,
      trigger: "manual",
      requestedByActorKey: "operator:admin",
      state: "succeeded",
      createdAt: now,
    });
    await harness.database.import_runs.update({
      where: { id: runId },
      data: { state: "running", started_at: now },
    });

    const replacements = await Promise.allSettled([
      service.replaceRevision(admin, providerId, {
        expectedRevisionId: firstRevisionId,
        adapterKey: "http-cursor-v1",
        endpoint: "https://provider.example/feed?v=2",
        scheduleSeconds: 300,
        staleAfterSeconds: 900,
        auth: { mode: "bearer", bearerSecret: "fixture-rotated-a" },
      }),
      service.replaceRevision(admin, providerId, {
        expectedRevisionId: firstRevisionId,
        adapterKey: "http-cursor-v1",
        endpoint: "https://provider.example/feed?v=2",
        scheduleSeconds: 300,
        staleAfterSeconds: 900,
        auth: { mode: "bearer", bearerSecret: "fixture-rotated-b" },
      }),
    ]);
    const successfulReplacement = replacements.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.replaceRevision>>> =>
        result.status === "fulfilled",
    );
    const rejectedReplacement = replacements.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.ok(successfulReplacement);
    assert.ok(rejectedReplacement);
    assert.ok(rejectedReplacement.reason instanceof ProviderConfigurationServiceError);
    assert.equal(rejectedReplacement.reason.code, "CONFIG_REVISION_CONFLICT");
    const replacement = successfulReplacement.value;
    const secondRevisionId = replacement.latestRevision.id;
    assert.equal(replacement.latestRevision.version, 2);
    assert.equal(replacement.activeRevisionId, firstRevisionId);

    const stale = await captureServiceError(
      service.activateRevision(admin, providerId, firstRevisionId),
    );
    assert.equal(stale.code, "CONFIG_REVISION_CONFLICT");
    assert.equal(stale.current?.latestRevision.id, secondRevisionId);
    await service.testConnection(admin, providerId, secondRevisionId);
    const replacementActive = await service.activateRevision(
      admin,
      providerId,
      secondRevisionId,
    );
    assert.equal(replacementActive.activeRevisionId, secondRevisionId);

    const disabled = await service.disableProvider(
      admin,
      providerId,
      secondRevisionId,
    );
    assert.equal(disabled.state, "disabled");
    assert.equal(disabled.nextRunAt, null);
    const runningRecord = await harness.database.import_runs.findUnique({
      where: { id: runId },
      select: { state: true, config_revision_id: true },
    });
    const running = runningRecord
      ? { state: runningRecord.state, revisionId: runningRecord.config_revision_id }
      : null;
    assert.deepEqual(running, {
      state: "running",
      revisionId: firstRevisionId,
    });
    const archived = await service.archiveProvider(
      admin,
      providerId,
      secondRevisionId,
    );
    assert.equal(archived.state, "archived");
    assert.equal(archived.nextRunAt, null);
    const archivedEdit = await captureServiceError(
      service.replaceRevision(admin, providerId, {
        expectedRevisionId: secondRevisionId,
        adapterKey: "http-cursor-v1",
        endpoint: "https://provider.example/feed?v=3",
        scheduleSeconds: 300,
        staleAfterSeconds: 900,
        auth: { mode: "bearer", reuseExistingSecret: true },
      }),
    );
    assert.equal(archivedEdit.code, "PROVIDER_LIFECYCLE_CONFLICT");

    const priorRuntimeRevision = await repository.getImmutableRevisionForRuntime({
      organizationId,
      providerId,
      revisionId: firstRevisionId,
    });
    assert.ok(priorRuntimeRevision?.encryptedCredential);
    assert.equal(
      credentialCipher.decrypt(priorRuntimeRevision.encryptedCredential, {
        organizationId,
        providerId,
        revisionId: firstRevisionId,
      }),
      "fixture-initial-secret",
    );
    const retiredPriorSecret =
      await harness.database.provider_secret_versions.findUnique({
        where: { revision_id: firstRevisionId },
        select: { retired_at: true },
      });
    assert.ok(retiredPriorSecret?.retired_at);

    const [revisionCount, secretCount, testCount] = await Promise.all([
      harness.database.provider_config_revisions.count({
        where: { provider_id: providerId },
      }),
      harness.database.provider_secret_versions.count({
        where: { provider_id: providerId },
      }),
      harness.database.provider_connection_tests.count({
        where: { provider_id: providerId },
      }),
    ]);
    assert.deepEqual(
      { revisions: revisionCount, secrets: secretCount, tests: testCount },
      { revisions: 2, secrets: 2, tests: 4 },
    );
    const lifecycleImpacts = await harness.database
      .public_change_catalog_impacts.findMany({
        where: {
          organization_id: organizationId,
          lifecycle_platform_key: "beezie",
        },
        orderBy: { cause_sequence: "asc" },
        select: {
          lifecycle_state: true,
          provider_platform_keys: true,
        },
      });
    assert.deepEqual(
      lifecycleImpacts.map(({ lifecycle_state }) => lifecycle_state),
      ["active", "active", "disabled", "archived"],
    );
    assert.deepEqual(
      lifecycleImpacts.map(({ provider_platform_keys }) =>
        provider_platform_keys),
      [["beezie"], ["beezie"], [], []],
    );
    const auditRecords = await harness.database.audit_events.findMany({
      where: { subject_id: providerId },
      select: { actor_key: true, metadata_json: true },
    });
    const audits = auditRecords.map((audit) => ({
      actorKey: audit.actor_key,
      metadata: audit.metadata_json,
    }));
    const serializedEvidence = JSON.stringify({ archived, audits });
    assert.doesNotMatch(
      serializedEvidence,
      /fixture-initial-secret|fixture-rotated-a|fixture-rotated-b/,
    );
    assert.ok(audits.every(({ actorKey }) => actorKey.startsWith("actor-key:")));
  } finally {
    await harness.close();
  }
});

test("failed connection tests stay sanitized and cannot enable a revision", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: organizationId,
      slug: "packscout",
      name: "PackScout",
    });
    const service = new ProviderConfigurationService({
      repository: new PrismaProviderConfigurationRepository(harness.database),
      adapters: new ProviderTransportAdapterRegistry([
        new AuthenticationFailureAdapter(),
      ]),
      credentialCipher: new AesGcmProviderCredentialCipher({
        primaryVersion: 1,
        keys: new Map([[1, new Uint8Array(32).fill(17)]]),
      }),
      actorKeyer: { keyFor: () => "actor-key:admin" },
      clock: { now: () => now },
      ids: createIdSource(),
      environment: "production",
    });
    const provider = await service.createProvider(
      admin,
      createRequest({
        platformKey: "failure-platform",
        adapterKey: "auth-failure-v1",
        auth: { mode: "bearer", bearerSecret: "must-never-leak" },
      }),
    );
    const result = await service.testConnection(
      admin,
      provider.id,
      provider.latestRevision.id,
    );
    assert.deepEqual(result, {
      verdict: "authentication_failure",
      checkedAt: now.toISOString(),
      latencyMs: 12,
      responseStatus: 401,
      recordCounts: null,
      hasMore: null,
      nextCursorPresent: null,
      sanitizedCode: "http_error",
    });
    const activation = await captureServiceError(
      service.activateRevision(admin, provider.id, provider.latestRevision.id),
    );
    assert.equal(activation.code, "PROVIDER_CONNECTION_FAILED");
    assert.doesNotMatch(
      JSON.stringify({ result, activation: activation.message }),
      /must-never-leak/,
    );
    const [rawCount, cursorCount] = await Promise.all([
      harness.database.import_pages.count(),
      harness.database.provider_cursor_checkpoints.count(),
    ]);
    assert.deepEqual(
      { raw: rawCount, cursors: cursorCount },
      { raw: 0, cursors: 0 },
    );
  } finally {
    await harness.close();
  }
});
