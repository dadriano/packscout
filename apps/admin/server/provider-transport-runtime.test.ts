import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderConfigurationSummary } from "@packscout/contracts";
import {
  type InternalProviderRevision,
  type ProviderConfigurationRepository,
  type ProviderHealthRepository,
} from "@packscout/services";
import { createProviderAdminRuntime } from "./provider-runtime.ts";
import { createProviderLiveTransportRegistry } from "./provider-transport-runtime.ts";

function configurationRepository() {
  let provider: ProviderConfigurationSummary | null = null;
  let revision: InternalProviderRevision | null = null;

  const repository = {
    async createProvider(input) {
      const createdAt = input.now.toISOString();
      provider = {
        id: input.providerId,
        platformKey: input.platformKey,
        displayName: input.displayName,
        state: "draft",
        latestRevision: {
          id: input.revisionId,
          version: 1,
          adapterKey: input.adapterKey,
          endpoint: input.endpoint,
          endpointHost: new URL(input.endpoint).hostname,
          authMode: input.authMode,
          hasBearerSecret: input.encryptedCredential !== null,
          scheduleSeconds: input.scheduleSeconds,
          staleAfterSeconds: input.staleAfterSeconds,
          testedAt: null,
          createdAt,
          lastConnectionTest: null,
        },
        activeRevisionId: null,
        nextRunAt: null,
        createdAt,
        updatedAt: createdAt,
      };
      revision = {
        providerId: input.providerId,
        revisionId: input.revisionId,
        organizationId: input.organizationId,
        platformKey: input.platformKey,
        adapterKey: input.adapterKey,
        endpoint: input.endpoint,
        authMode: input.authMode,
        scheduleSeconds: input.scheduleSeconds,
        encryptedCredential: input.encryptedCredential,
      };
      return { kind: "created", provider } as const;
    },
    async replaceRevision() {
      return { kind: "lifecycle_conflict" } as const;
    },
    async getProvider() {
      return provider;
    },
    async getRevisionForConnectionTest(input) {
      if (!provider || !revision || revision.revisionId !== input.expectedRevisionId) {
        return { kind: "not_found" } as const;
      }
      return { kind: "found", revision } as const;
    },
    async recordConnectionTest(input) {
      if (!provider) throw new Error("Provider fixture is unavailable.");
      provider = {
        ...provider,
        latestRevision: {
          ...provider.latestRevision,
          testedAt: input.testedAt.toISOString(),
          lastConnectionTest: input.test,
        },
      };
      return input.test;
    },
    async activateRevision(input) {
      if (
        !provider ||
        provider.latestRevision.lastConnectionTest?.verdict !== "success"
      ) {
        return { kind: "connection_required" } as const;
      }
      provider = {
        ...provider,
        state: "active",
        activeRevisionId: input.expectedRevisionId,
        nextRunAt: input.nextRunAt.toISOString(),
      };
      return { kind: "updated", provider } as const;
    },
    async transitionState() {
      return { kind: "lifecycle_conflict" } as const;
    },
    async listProviders() {
      return provider ? [provider] : [];
    },
  } satisfies ProviderConfigurationRepository & {
    listProviders(
      organizationId: string,
    ): Promise<readonly ProviderConfigurationSummary[]>;
  };
  return repository;
}

test("admin tests and activates a live decoder-backed V2 provider", async () => {
  const transportAdapters = createProviderLiveTransportRegistry({
    resolveHost: async () => ["8.8.8.8"],
    httpClient: async (_input, init) => {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer sanitized-secret",
      );
      return new Response(
        JSON.stringify({
          records: [
            {
              stream: "catalog",
              platform: "courtyard",
              record_id: "sanitized-pack",
              entity: "pack",
              first_seen_at: "2026-08-19T12:00:00Z",
              occurred_at: "2026-08-19T12:00:00Z",
              collected_at: "2026-08-19T12:00:01Z",
              available: true,
              data: {},
            },
          ],
          next_cursor: "sanitized-cursor",
          poll_after_seconds: 0,
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const runtime = createProviderAdminRuntime({
    repository: configurationRepository(),
    healthRepository: {
      async loadHealthEvidence() {
        return null;
      },
    } satisfies ProviderHealthRepository,
    credentialKey: new Uint8Array(32).fill(1),
    actorPseudonymKey: new Uint8Array(32).fill(2),
    environment: "test",
    transportAdapters,
  });
  const actor = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    operatorId: "00000000-0000-4000-8000-000000000002",
    role: "admin" as const,
  };

  const provider = await runtime.configuration.createProvider(actor, {
    platformKey: "courtyard",
    displayName: "Courtyard",
    adapterKey: "http-cursor-v2",
    endpoint: "https://provider.example/feed",
    auth: { mode: "bearer", bearerSecret: "sanitized-secret" },
    scheduleSeconds: 300,
    staleAfterSeconds: 900,
  });
  assert.equal(provider.latestRevision.adapterKey, "http-cursor-v2");

  const connection = await runtime.configuration.testConnection(
    actor,
    provider.id,
    provider.latestRevision.id,
  );
  assert.equal(connection.verdict, "success");
  assert.deepEqual(connection.recordCounts, {
    catalog: 1,
    pulls: 0,
    trades: 0,
  });
  const activated = await runtime.configuration.activateRevision(
    actor,
    provider.id,
    provider.latestRevision.id,
  );
  assert.equal(activated.state, "active");
  assert.equal(activated.activeRevisionId, provider.latestRevision.id);

  assert.deepEqual(transportAdapters.keys(), ["http-cursor-v2"]);
  assert.throws(
    () => transportAdapters.resolve("http-cursor-v2", "gamestop"),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "unsupported_adapter_platform",
  );
});

test("admin live connection tests retain the explicit ten MiB response bound", async () => {
  const records = Array.from({ length: 500 }, (_, index) => ({
    stream: "catalog",
    platform: "phygitals",
    record_id: `sanitized-card-${index}`,
    entity: "card",
    first_seen_at: "2026-08-19T12:00:00Z",
    occurred_at: "2026-08-19T12:00:00Z",
    collected_at: "2026-08-19T12:00:01Z",
    available: null,
    data: { sanitizedPadding: "x".repeat(6_000) },
  }));
  const body = JSON.stringify({
    records,
    next_cursor: "sanitized-phygitals-cursor",
    poll_after_seconds: 0,
  });
  assert.ok(body.length > 2 * 1024 * 1024);
  assert.ok(body.length < 10 * 1024 * 1024);

  const runtime = createProviderAdminRuntime({
    repository: configurationRepository(),
    healthRepository: {
      async loadHealthEvidence() {
        return null;
      },
    } satisfies ProviderHealthRepository,
    credentialKey: new Uint8Array(32).fill(1),
    actorPseudonymKey: new Uint8Array(32).fill(2),
    environment: "test",
    transportAdapters: createProviderLiveTransportRegistry({
      resolveHost: async () => ["8.8.8.8"],
      httpClient: async () =>
        new Response(body, {
          headers: { "content-type": "application/json" },
        }),
    }),
  });
  const actor = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    operatorId: "00000000-0000-4000-8000-000000000002",
    role: "admin" as const,
  };
  const provider = await runtime.configuration.createProvider(actor, {
    platformKey: "phygitals",
    displayName: "Phygitals",
    adapterKey: "http-cursor-v2",
    endpoint: "https://provider.example/feed",
    auth: { mode: "bearer", bearerSecret: "sanitized-secret" },
    scheduleSeconds: 300,
    staleAfterSeconds: 900,
  });

  const result = await runtime.configuration.testConnection(
    actor,
    provider.id,
    provider.latestRevision.id,
  );
  assert.equal(result.verdict, "success");
  assert.deepEqual(result.recordCounts, {
    catalog: 500,
    pulls: 0,
    trades: 0,
  });
});
