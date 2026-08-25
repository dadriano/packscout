import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  ACCEPTANCE_CREATED_AT,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  activateAcceptanceRuntime,
  createAcceptanceProviderSource,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { ProviderSourceAdminLifecycleRepository } from
  "./provider-source-admin-lifecycle-repository.ts";

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
