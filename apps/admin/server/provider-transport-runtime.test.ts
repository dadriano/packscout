import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderConfigurationSummary } from "@packscout/contracts";
import {
  ProviderConfigurationServiceError,
  ProviderTransportAdapterRegistry,
  type InternalProviderRevision,
  type ProviderConfigurationRepository,
  type ProviderHealthRepository,
} from "@packscout/services";
import { createProviderAdminRuntime } from "./provider-runtime.ts";

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
    async activateRevision() {
      return { kind: "connection_required" } as const;
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

test("admin keeps V2 provider drafts configurable while the missing decoder fails closed", async () => {
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
    auth: { mode: "none" },
    scheduleSeconds: 300,
    staleAfterSeconds: 900,
  });
  assert.equal(provider.latestRevision.adapterKey, "http-cursor-v2");

  const connection = await runtime.configuration.testConnection(
    actor,
    provider.id,
    provider.latestRevision.id,
  );
  assert.equal(connection.verdict, "unreachable");
  assert.equal(connection.sanitizedCode, "invalid_configuration");
  await assert.rejects(
    runtime.configuration.activateRevision(
      actor,
      provider.id,
      provider.latestRevision.id,
    ),
    (error: unknown) =>
      error instanceof ProviderConfigurationServiceError &&
      error.code === "PROVIDER_CONNECTION_FAILED",
  );

  const liveTransports = new ProviderTransportAdapterRegistry();
  assert.equal(liveTransports.keys().length, 0);
  assert.throws(
    () => liveTransports.resolve("http-cursor-v2", "courtyard"),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "unknown_adapter_key",
  );
});
