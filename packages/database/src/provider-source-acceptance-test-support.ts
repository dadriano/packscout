import { providerSourceLaunchBounds } from "@packscout/contracts";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
} from "@packscout/contracts";
import type { PackscoutPrismaClient } from "./database.ts";
import { ProviderSourceLifecycleRepository } from "./provider-source-lifecycle-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import {
  createMigratedTestDatabase,
  type MigratedTestDatabase,
} from "./test-support.ts";

export const ACCEPTANCE_SOURCE_TYPE_KEY = "dataforrest-events-v1";
export const ACCEPTANCE_SOURCE_ADAPTER_VERSION =
  "dataforrest-events-adapter-v1";
export const ACCEPTANCE_NORMALIZED_CONTRACT_VERSION =
  PROVIDER_OBSERVATION_CONTRACT_VERSION;
export const ACCEPTANCE_OBSERVATION_HASH_VERSION =
  PROVIDER_OBSERVATION_HASH_VERSION;
export const ACCEPTANCE_CHECKPOINT_CODEC_VERSION = "dataforrest-cursor-v1";
export const ACCEPTANCE_CREATED_AT = new Date("2026-08-20T12:00:00.000Z");

export interface ProviderSourceAcceptanceFixture extends MigratedTestDatabase {
  readonly setup: PipelineSetupRepository;
  readonly lifecycle: ProviderSourceLifecycleRepository;
  readonly organizationId: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
}

export interface AcceptanceSource {
  readonly platformKey: string;
  readonly providerId: string;
  readonly configRevisionId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly mapperKey: string;
  readonly identityNamespaceKey: string;
}

export async function createProviderSourceAcceptanceFixture(
  testKey: string,
): Promise<ProviderSourceAcceptanceFixture> {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  const organizationId = await setup.createOrganization({
    slug: `provider-source-${testKey}`,
    name: `Provider source ${testKey}`,
    createdAt: ACCEPTANCE_CREATED_AT,
  });
  const lifecycle = new ProviderSourceLifecycleRepository(harness.database);
  const connection = await lifecycle.createConnectionProfileRevision({
    organizationId,
    sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
    connectionTypeKey: "dataforrest-events-connection-v1",
    displayName: `DataForrest ${testKey}`,
    requestLimit: providerSourceLaunchBounds.stableProfileRequestCap,
    sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
    revisionNumber: 1,
    configurationCiphertext: new Uint8Array(32).fill(1),
    configurationNonce: new Uint8Array(12).fill(2),
    configurationAuthTag: new Uint8Array(16).fill(3),
    encryptionKeyVersion: 1,
    configurationFingerprint: "a".repeat(64),
    actorKey: "operator-admin",
    createdAt: ACCEPTANCE_CREATED_AT,
  });
  return {
    ...harness,
    setup,
    lifecycle,
    organizationId,
    connectionProfileId: connection.profileId,
    connectionRevisionId: connection.revisionId,
  };
}

export interface AcceptanceSourceDefinition {
  readonly platformKey: string;
  readonly displayName: string;
  readonly mapperKey: string;
  readonly identityNamespaceKey: string;
  readonly intervalSeconds: number;
  readonly hashCharacter: string;
  readonly createdAt?: Date;
}

export async function createAcceptanceSourceInstance(
  fixture: ProviderSourceAcceptanceFixture,
  input: Readonly<{
    providerId: string;
    definition: AcceptanceSourceDefinition;
  }>,
): Promise<{ sourceInstanceId: string; sourceRevisionId: string }> {
  return fixture.lifecycle.createSourceInstanceRevision({
    organizationId: fixture.organizationId,
    providerId: input.providerId,
    connectionProfileId: fixture.connectionProfileId,
    sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
    sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
    normalizedContractVersion: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
    mapperKey: input.definition.mapperKey,
    mapperVersion: "1",
    identityNamespaceKey: input.definition.identityNamespaceKey,
    checkpointCodecVersion: ACCEPTANCE_CHECKPOINT_CODEC_VERSION,
    revisionNumber: 1,
    intervalSeconds: input.definition.intervalSeconds,
    configuration: { provider: input.definition.platformKey },
    configurationHash: input.definition.hashCharacter.repeat(64),
    recordIdScopes: [
      "catalog-pack-v1",
      "catalog-card-v1",
      "pull-v1",
      "trade-v1",
    ],
    actorKey: "operator-admin",
    createdAt: input.definition.createdAt ?? ACCEPTANCE_CREATED_AT,
  });
}

export async function createAcceptanceProviderSource(
  fixture: ProviderSourceAcceptanceFixture,
  definition: AcceptanceSourceDefinition,
): Promise<AcceptanceSource> {
  const providerId = await fixture.setup.createProviderSource({
    organizationId: fixture.organizationId,
    platformKey: definition.platformKey,
    displayName: definition.displayName,
    createdAt: definition.createdAt ?? ACCEPTANCE_CREATED_AT,
  });
  const configRevisionId = await fixture.setup.createConfigRevision({
    organizationId: fixture.organizationId,
    providerId,
    version: 1,
    adapterKey: "http-cursor-v1",
    endpointUrl: `https://${definition.platformKey}.example.test/feed`,
    authMode: "none",
    createdByActorKey: "operator-admin",
    createdAt: definition.createdAt ?? ACCEPTANCE_CREATED_AT,
  });
  const source = await createAcceptanceSourceInstance(fixture, {
    providerId,
    definition,
  });
  return {
    platformKey: definition.platformKey,
    providerId,
    configRevisionId,
    ...source,
    mapperKey: definition.mapperKey,
    identityNamespaceKey: definition.identityNamespaceKey,
  };
}

function copyBytes(value: Uint8Array | null): Uint8Array<ArrayBuffer> | null {
  if (value === null) return null;
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

export async function createPinnedSourceRun(
  database: PackscoutPrismaClient,
  fixture: ProviderSourceAcceptanceFixture,
  source: AcceptanceSource,
  input: Readonly<{
    state: "running" | "succeeded";
    trigger?: "scheduled" | "continuation";
    createdAt: Date;
    requestedCheckpoint: Uint8Array | null;
    requestedCheckpointFingerprint: string | null;
    leaseOwner?: string;
    leaseToken?: string;
    claimLeaseId?: string;
    leaseExpiresAt?: Date;
  }>,
) {
  return database.import_runs.create({
    data: {
      organization_id: fixture.organizationId,
      provider_id: source.providerId,
      config_revision_id: null,
      trigger: input.trigger ?? "scheduled",
      state: input.state,
      started_at: input.createdAt,
      finished_at: input.state === "succeeded" ? input.createdAt : null,
      created_at: input.createdAt,
      lease_owner: input.leaseOwner,
      lease_token: input.leaseToken,
      claim_lease_id: input.claimLeaseId,
      lease_expires_at: input.leaseExpiresAt,
      source_instance_id: source.sourceInstanceId,
      source_revision_id: source.sourceRevisionId,
      source_type_key: ACCEPTANCE_SOURCE_TYPE_KEY,
      source_adapter_version: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      normalized_contract_version: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
      mapper_key: source.mapperKey,
      mapper_version: "1",
      identity_namespace_key: source.identityNamespaceKey,
      connection_profile_id: fixture.connectionProfileId,
      connection_revision_id: fixture.connectionRevisionId,
      checkpoint_codec_version: ACCEPTANCE_CHECKPOINT_CODEC_VERSION,
      checkpoint_generation: 1n,
      requested_checkpoint: copyBytes(input.requestedCheckpoint),
      requested_checkpoint_fingerprint: input.requestedCheckpointFingerprint,
      requested_checkpoint_key:
        input.requestedCheckpointFingerprint ?? "initial",
      current_checkpoint: copyBytes(input.requestedCheckpoint),
      current_checkpoint_fingerprint: input.requestedCheckpointFingerprint,
      current_checkpoint_key:
        input.requestedCheckpointFingerprint ?? "initial",
      next_page_number: 1,
    },
  });
}

export async function activateAcceptanceRuntime(
  database: PackscoutPrismaClient,
  fixture: ProviderSourceAcceptanceFixture,
  source: AcceptanceSource,
  activatedAt: Date,
): Promise<void> {
  await database.$transaction(async (transaction) => {
    await transaction.provider_sources.update({
      where: { id: source.providerId },
      data: { state: "active", updated_at: activatedAt },
    });
    await transaction.source_connection_revisions.update({
      where: { id: fixture.connectionRevisionId },
      data: { state: "active", activated_at: activatedAt },
    });
    await transaction.source_connection_profiles.update({
      where: { id: fixture.connectionProfileId },
      data: {
        state: "active",
        active_revision_id: fixture.connectionRevisionId,
        updated_at: activatedAt,
      },
    });
    await transaction.provider_source_instances.update({
      where: { id: source.sourceInstanceId },
      data: {
        state: "active",
        activated_at: activatedAt,
        updated_at: activatedAt,
      },
    });
  });
}
