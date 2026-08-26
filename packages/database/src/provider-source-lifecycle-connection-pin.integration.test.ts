import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  providerIdentityNamespaceByLaunchProvider,
} from "@packscout/contracts";
import {
  ACCEPTANCE_CREATED_AT,
  ACCEPTANCE_CURSOR_CODEC_VERSION,
  ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  activateAcceptanceRuntime,
  createAcceptanceProviderSource,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { ProviderSourceAdminLifecycleRepository } from
  "./provider-source-admin-lifecycle-repository.ts";
import { PersistenceError } from "./persistence-error.ts";

const recordIdScopes = [
  "catalog-pack-v1",
  "catalog-card-v1",
  "pull-v1",
  "trade-v1",
] as const;

test("lifecycle diagnostics retain a source-compatible connection pin after an adapter rotation", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "lifecycle-compatible-connection-pin",
  );
  try {
    const source = await createAcceptanceProviderSource(fixture, {
      platformKey: "courtyard",
      displayName: "Courtyard",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey: "dataforrest-courtyard-records-v1",
      intervalSeconds: 60,
      hashCharacter: "b",
    });
    await activateAcceptanceRuntime(
      fixture.database,
      fixture,
      source,
      ACCEPTANCE_CREATED_AT,
    );
    const rotatedRevisionId = randomUUID();
    await fixture.database.$transaction(async (transaction) => {
      await transaction.source_connection_revisions.create({
        data: {
          id: rotatedRevisionId,
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.connectionProfileId,
          revision_number: 2,
          source_type_key: "dataforrest-events-v1",
          source_adapter_version: "dataforrest-events-adapter-v2",
          configuration_ciphertext: new Uint8Array(32).fill(4),
          configuration_nonce: new Uint8Array(12).fill(5),
          configuration_auth_tag: new Uint8Array(16).fill(6),
          encryption_key_version: 1,
          configuration_fingerprint: "d".repeat(64),
          state: "candidate",
          created_by_actor_key: "operator-admin",
          created_at: ACCEPTANCE_CREATED_AT,
        },
      });
      await transaction.source_connection_revisions.update({
        where: { id: fixture.connectionRevisionId },
        data: {
          state: "retired",
          retired_at: ACCEPTANCE_CREATED_AT,
        },
      });
      await transaction.source_connection_revisions.update({
        where: { id: rotatedRevisionId },
        data: {
          state: "active",
          activated_at: ACCEPTANCE_CREATED_AT,
        },
      });
      await transaction.source_connection_profiles.update({
        where: { id: fixture.connectionProfileId },
        data: {
          active_revision_id: rotatedRevisionId,
          updated_at: ACCEPTANCE_CREATED_AT,
        },
      });
    });

    const paused = await new ProviderSourceAdminLifecycleRepository(
      fixture.database,
    ).requestPause({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      actorKey: "operator-admin",
      requestedAt: ACCEPTANCE_CREATED_AT,
    });

    assert.equal(paused.state, "paused");
    const diagnostic = await fixture.database.source_processor_diagnostic_events
      .findFirstOrThrow({
        where: {
          source_instance_id: source.sourceInstanceId,
          phase: "pause_completed",
        },
      });
    assert.equal(diagnostic.connection_revision_id, fixture.connectionRevisionId);
    assert.equal(
      diagnostic.source_adapter_version,
      ACCEPTANCE_SOURCE_ADAPTER_VERSION,
    );
    assert.equal(
      (await fixture.database.source_connection_profiles.findUniqueOrThrow({
        where: { id: fixture.connectionProfileId },
      })).active_revision_id,
      rotatedRevisionId,
    );
  } finally {
    await fixture.close();
  }
});

test("source creation rejects an inactive matching revision when the active adapter differs", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "source-active-connection-adapter-v3",
  );
  try {
    const candidateRevisionId = randomUUID();
    await fixture.database.$transaction(async (transaction) => {
      await transaction.source_connection_revisions.update({
        where: { id: fixture.connectionRevisionId },
        data: {
          state: "active",
          activated_at: ACCEPTANCE_CREATED_AT,
        },
      });
      await transaction.source_connection_profiles.update({
        where: { id: fixture.connectionProfileId },
        data: {
          state: "active",
          active_revision_id: fixture.connectionRevisionId,
          updated_at: ACCEPTANCE_CREATED_AT,
        },
      });
      await transaction.source_connection_revisions.create({
        data: {
          id: candidateRevisionId,
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.connectionProfileId,
          revision_number: 2,
          source_type_key: ACCEPTANCE_SOURCE_TYPE_KEY,
          source_adapter_version: DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
          configuration_ciphertext: new Uint8Array(32).fill(4),
          configuration_nonce: new Uint8Array(12).fill(5),
          configuration_auth_tag: new Uint8Array(16).fill(6),
          encryption_key_version: 1,
          configuration_fingerprint: "c".repeat(64),
          state: "candidate",
          created_by_actor_key: "operator-admin",
          created_at: ACCEPTANCE_CREATED_AT,
        },
      });
    });
    const providerId = await fixture.setup.createProviderSource({
      organizationId: fixture.organizationId,
      platformKey: "collector_crypt",
      displayName: "Collector Crypt",
      createdAt: ACCEPTANCE_CREATED_AT,
    });

    await assert.rejects(
      fixture.lifecycle.createSourceInstanceRevision({
        organizationId: fixture.organizationId,
        providerId,
        connectionProfileId: fixture.connectionProfileId,
        sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
        sourceAdapterVersion: DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
        normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
        mapperKey: "collector-crypt-provider-observation",
        mapperVersion: "2",
        identityNamespaceKey:
          providerIdentityNamespaceByLaunchProvider.collector_crypt,
        cursorCodecVersion: ACCEPTANCE_CURSOR_CODEC_VERSION,
        revisionNumber: 1,
        intervalSeconds: 60,
        configuration: { provider: "collector_crypt" },
        configurationHash: "d".repeat(64),
        recordIdScopes,
        actorKey: "operator-admin",
        createdAt: ACCEPTANCE_CREATED_AT,
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "TENANT_SCOPE_VIOLATION",
    );
    assert.equal(
      await fixture.database.provider_source_instances.count({
        where: {
          organization_id: fixture.organizationId,
          provider_id: providerId,
        },
      }),
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("draft profiles can stage a current-adapter source but active legacy profiles reject its replacement", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "source-active-connection-adapter-v2",
  );
  try {
    await fixture.database.source_connection_revisions.create({
      data: {
        id: randomUUID(),
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.connectionProfileId,
        revision_number: 2,
        source_type_key: ACCEPTANCE_SOURCE_TYPE_KEY,
        source_adapter_version: DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
        configuration_ciphertext: new Uint8Array(32).fill(4),
        configuration_nonce: new Uint8Array(12).fill(5),
        configuration_auth_tag: new Uint8Array(16).fill(6),
        encryption_key_version: 1,
        configuration_fingerprint: "c".repeat(64),
        state: "candidate",
        created_by_actor_key: "operator-admin",
        created_at: ACCEPTANCE_CREATED_AT,
      },
    });
    const providerId = await fixture.setup.createProviderSource({
      organizationId: fixture.organizationId,
      platformKey: "collector_crypt",
      displayName: "Collector Crypt",
      createdAt: ACCEPTANCE_CREATED_AT,
    });
    const source = await fixture.lifecycle.createSourceInstanceRevision({
      organizationId: fixture.organizationId,
      providerId,
      connectionProfileId: fixture.connectionProfileId,
      sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
      sourceAdapterVersion: DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
      normalizedContractVersion: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
      mapperKey: "collector-crypt-provider-observation",
      mapperVersion: "1",
      identityNamespaceKey:
        providerIdentityNamespaceByLaunchProvider.collector_crypt,
      cursorCodecVersion: ACCEPTANCE_CURSOR_CODEC_VERSION,
      revisionNumber: 1,
      intervalSeconds: 60,
      configuration: { provider: "collector_crypt" },
      configurationHash: "d".repeat(64),
      recordIdScopes,
      actorKey: "operator-admin",
      createdAt: ACCEPTANCE_CREATED_AT,
    });
    await fixture.database.$transaction([
      fixture.database.provider_source_instances.update({
        where: { id: source.sourceInstanceId },
        data: {
          state: "paused",
          activated_at: ACCEPTANCE_CREATED_AT,
          paused_at: ACCEPTANCE_CREATED_AT,
        },
      }),
      fixture.database.source_connection_revisions.update({
        where: { id: fixture.connectionRevisionId },
        data: {
          state: "active",
          activated_at: ACCEPTANCE_CREATED_AT,
        },
      }),
      fixture.database.source_connection_profiles.update({
        where: { id: fixture.connectionProfileId },
        data: {
          state: "active",
          active_revision_id: fixture.connectionRevisionId,
          updated_at: ACCEPTANCE_CREATED_AT,
        },
      }),
    ]);

    await assert.rejects(
      fixture.lifecycle.createSourceInstanceRevision({
        organizationId: fixture.organizationId,
        providerId,
        connectionProfileId: fixture.connectionProfileId,
        sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
        sourceAdapterVersion: DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
        normalizedContractVersion: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
        mapperKey: "collector-crypt-provider-observation",
        mapperVersion: "1",
        identityNamespaceKey:
          providerIdentityNamespaceByLaunchProvider.collector_crypt,
        cursorCodecVersion: ACCEPTANCE_CURSOR_CODEC_VERSION,
        revisionNumber: 1,
        intervalSeconds: 60,
        configuration: { provider: "collector_crypt", replacement: true },
        configurationHash: "e".repeat(64),
        recordIdScopes,
        replacesSourceInstanceId: source.sourceInstanceId,
        replacementPredecessor: {
          mapperKey: "collector-crypt-provider-observation",
          mapperVersion: "1",
          normalizedContractVersion: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
        },
        actorKey: "operator-admin",
        createdAt: new Date(ACCEPTANCE_CREATED_AT.getTime() + 1_000),
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "TENANT_SCOPE_VIOLATION",
    );
    assert.deepEqual(
      await fixture.database.provider_source_instances.findUniqueOrThrow({
        where: { id: source.sourceInstanceId },
        select: { state: true, replaced_at: true },
      }),
      { state: "paused", replaced_at: null },
    );
    assert.equal(
      await fixture.database.provider_source_instances.count({
        where: {
          organization_id: fixture.organizationId,
          provider_id: providerId,
        },
      }),
      1,
    );
  } finally {
    await fixture.close();
  }
});
