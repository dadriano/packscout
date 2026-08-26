import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
  providerIdentityNamespaceByLaunchProvider,
} from "@packscout/contracts";
import {
  ACCEPTANCE_CREATED_AT,
  ACCEPTANCE_CURSOR_CODEC_VERSION,
  ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { PersistenceError } from "./persistence-error.ts";

const recordIdScopes = [
  "catalog-pack-v1",
  "catalog-card-v1",
  "pull-v1",
  "trade-v1",
] as const;

test("draft profiles can stage a current-adapter source but active legacy profiles reject its replacement", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "source-active-connection-adapter",
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
