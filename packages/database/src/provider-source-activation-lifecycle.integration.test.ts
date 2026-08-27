import assert from "node:assert/strict";
import { test } from "node:test";
import { providerSourceLaunchBounds } from "@packscout/contracts";
import { PersistenceError } from "./persistence-error.ts";
import {
  ProviderSourceLifecycleRepository,
  type ActivateProviderSourcePausedExactInput,
} from "./provider-source-lifecycle-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const createdAt = new Date("2026-08-21T12:00:00.000Z");
const sourceTypeKey = "dataforrest-events-v1";
const sourceAdapterVersion = "dataforrest-events-adapter-v1";
const normalizedContractVersion = "packscout.provider-observation.v1";
const cursorCodecVersion = "dataforrest-cursor-v1";
const connectionTypeKey = "dataforrest-events-connection-v1";
const sourceConfigurationHash = "b".repeat(64);
const connectionConfigurationFingerprint = "a".repeat(64);
const recordIdScopes = [
  "catalog-pack-v1",
  "catalog-card-v1",
  "pull-v1",
  "trade-v1",
] as const;

test("source activation candidate is coherent and exact persistence pins fail closed", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    const organizationId = await setup.createOrganization({
      slug: "source-activation-seam",
      name: "Source activation seam",
      createdAt,
    });
    const providerId = await setup.createProviderSource({
      organizationId,
      platformKey: "courtyard",
      displayName: "Courtyard",
      createdAt,
    });
    const lifecycle = new ProviderSourceLifecycleRepository(harness.database);
    const connection = await lifecycle.createConnectionProfileRevision({
      organizationId,
      sourceTypeKey,
      connectionTypeKey,
      displayName: "DataForrest shared",
      requestLimit: providerSourceLaunchBounds.stablePlatformRequestCap,
      sourceAdapterVersion,
      revisionNumber: 1,
      configurationCiphertext: new Uint8Array(32).fill(1),
      configurationNonce: new Uint8Array(12).fill(2),
      configurationAuthTag: new Uint8Array(16).fill(3),
      encryptionKeyVersion: 1,
      configurationFingerprint: connectionConfigurationFingerprint,
      actorKey: "operator-admin",
      createdAt,
    });
    const sourceConfiguration = { platform: "courtyard" } as const;
    const source = await lifecycle.createSourceInstanceRevision({
      organizationId,
      providerId,
      connectionProfileId: connection.profileId,
      sourceTypeKey,
      sourceAdapterVersion,
      normalizedContractVersion,
      mapperKey: "courtyard-provider-observation",
      mapperVersion: "1",
      identityNamespaceKey: "dataforrest-courtyard-records-v1",
      cursorCodecVersion,
      revisionNumber: 1,
      configuration: sourceConfiguration,
      configurationHash: sourceConfigurationHash,
      recordIdScopes,
      actorKey: "operator-admin",
      createdAt,
    });
    await harness.database.$transaction([
      harness.database.source_connection_revisions.update({
        where: { id: connection.revisionId },
        data: { state: "active", activated_at: createdAt },
      }),
      harness.database.source_connection_profiles.update({
        where: { id: connection.profileId },
        data: {
          state: "active",
          active_revision_id: connection.revisionId,
          updated_at: createdAt,
        },
      }),
    ]);

    const candidate = await lifecycle.loadSourceActivationCandidate({
      organizationId,
      providerId,
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      connectionRevisionId: connection.revisionId,
    });
    assert.ok(candidate);
    assert.equal(candidate.provider.platformKey, "courtyard");
    assert.equal(candidate.sourceInstance.state, "draft");
    assert.equal(candidate.connectionProfile.activeRevisionId, connection.revisionId);
    assert.equal(candidate.connectionRevision.configurationFingerprint,
      connectionConfigurationFingerprint);
    assert.deepEqual(candidate.sourceRevision.configuration, sourceConfiguration);
    assert.deepEqual(candidate.sourceRevision.recordIdScopes, recordIdScopes);
    assert.deepEqual(candidate.cursor, {
      sourceRevisionId: source.sourceRevisionId,
      sourceAdapterVersion,
      cursorCodecVersion,
      cursorGeneration: 1n,
      cursorFingerprint: null,
      hasCursor: false,
      advancedByRunId: null,
      advancedByPageId: null,
    });

    const exactInput: ActivateProviderSourcePausedExactInput = {
      organizationId,
      providerId,
      providerKey: "courtyard",
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      sourceTypeKey,
      sourceAdapterVersion,
      normalizedContractVersion,
      mapperKey: "courtyard-provider-observation",
      mapperVersion: "1",
      identityNamespaceKey: "dataforrest-courtyard-records-v1",
      cursorCodecVersion,
      sourceConfiguration,
      sourceConfigurationHash,
      recordIdScopes,
      connectionProfileId: connection.profileId,
      connectionTypeKey,
      connectionRequestLimit: providerSourceLaunchBounds.stablePlatformRequestCap,
      connectionRevisionId: connection.revisionId,
      connectionConfigurationFingerprint,
      cursorGeneration: 1n,
      actorKey: "operator-admin",
      activatedAt: createdAt,
    };
    await assert.rejects(
      lifecycle.activateSourcePausedExact({
        ...exactInput,
        sourceConfigurationHash: "c".repeat(64),
      }),
      (error: unknown) => error instanceof PersistenceError
        && error.code === "SOURCE_FENCED",
    );
    await assert.rejects(
      lifecycle.activateSourcePausedExact(exactInput),
      (error: unknown) => error instanceof PersistenceError
        && error.code === "CONFIG_REVISION_UNTESTED",
    );
    assert.equal((await harness.database.provider_source_instances.findUniqueOrThrow({
      where: { id: source.sourceInstanceId },
    })).state, "draft");
  } finally {
    await harness.close();
  }
});

test("the exact activation method is the only lifecycle activation authority", () => {
  const prototype = ProviderSourceLifecycleRepository.prototype as unknown as
    Record<string, unknown>;
  assert.equal(prototype.activateConnectionRevision, undefined);
  assert.equal(prototype.activateSourcePaused, undefined);
  assert.equal(typeof prototype.activateSourcePausedExact, "function");
});
