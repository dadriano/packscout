import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import {
  PROVIDER_SOURCE_SCHEDULE_BOUNDS,
  type ProviderSourceRevisionPins,
} from "./provider-source-persistence-types.ts";

const SHA_256_PATTERN = /^[0-9a-f]{64}$/;
const REGISTRATION_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/u;
const VERSION_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;

function requireKey(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must not be blank.`);
  return normalized;
}

function requireSha256(value: string, label: string): string {
  if (!SHA_256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireRegistrationKey(value: string, label: string): string {
  if (!REGISTRATION_KEY_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a bounded registration key.`);
  }
  return value;
}

function requireVersionKey(value: string, label: string): string {
  if (!VERSION_KEY_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a bounded version key.`);
  }
  return value;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function asPrismaBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

export interface ProviderSourceActivationCandidateSnapshot {
  readonly organizationId: string;
  readonly provider: Readonly<{
    id: string;
    platformKey: string;
  }>;
  readonly sourceInstance: Readonly<{
    id: string;
    state: string;
    sourceTypeKey: string;
    connectionProfileId: string;
    activeRevisionId: string;
  }>;
  readonly sourceRevision: Readonly<{
    id: string;
    providerId: string;
    connectionProfileId: string;
    sourceTypeKey: string;
    sourceAdapterVersion: string;
    normalizedContractVersion: string;
    mapperKey: string;
    mapperVersion: string;
    identityNamespaceKey: string;
    cursorCodecVersion: string;
    configuration: unknown;
    configurationHash: string;
    recordIdScopes: unknown;
  }>;
  readonly connectionProfile: Readonly<{
    id: string;
    state: string;
    sourceTypeKey: string;
    connectionTypeKey: string;
    requestLimit: number;
    activeRevisionId: string;
  }>;
  readonly connectionRevision: Readonly<{
    id: string;
    state: string;
    sourceTypeKey: string;
    sourceAdapterVersion: string;
    configurationFingerprint: string;
    revokedAt: Date | null;
  }>;
  readonly cursor: Readonly<{
    sourceRevisionId: string;
    sourceAdapterVersion: string;
    cursorCodecVersion: string;
    cursorGeneration: bigint;
    cursorFingerprint: string | null;
    hasCursor: boolean;
    advancedByRunId: string | null;
    advancedByPageId: string | null;
  }>;
}

export interface ActivateProviderSourcePausedExactInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerKey: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly normalizedContractVersion: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly identityNamespaceKey: string;
  readonly cursorCodecVersion: string;
  readonly sourceConfiguration: Readonly<Record<string, unknown>>;
  readonly sourceConfigurationHash: string;
  readonly recordIdScopes: readonly string[];
  readonly connectionProfileId: string;
  readonly connectionTypeKey: string;
  readonly connectionRequestLimit: number;
  readonly connectionRevisionId: string;
  readonly connectionConfigurationFingerprint: string;
  readonly cursorGeneration: bigint;
  readonly actorKey: string;
  readonly activatedAt: Date;
}

export class ProviderSourceLifecycleRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async createConnectionProfileRevision(input: Readonly<{
    organizationId: string;
    sourceTypeKey: string;
    connectionTypeKey: string;
    displayName: string;
    requestLimit: number;
    sourceAdapterVersion: string;
    revisionNumber: number;
    configurationCiphertext: Uint8Array;
    configurationNonce: Uint8Array;
    configurationAuthTag: Uint8Array;
    encryptionKeyVersion: number;
    configurationFingerprint: string;
    actorKey: string;
    createdAt: Date;
  }>): Promise<{ profileId: string; revisionId: string }> {
    const sourceTypeKey = requireRegistrationKey(input.sourceTypeKey, "Source type key");
    const connectionTypeKey = requireRegistrationKey(input.connectionTypeKey, "Connection type key");
    const sourceAdapterVersion = requireRegistrationKey(
      input.sourceAdapterVersion,
      "Source adapter version",
    );
    if (!Number.isInteger(input.requestLimit) || input.requestLimit < 1 || input.requestLimit > 4) {
      throw new TypeError("Connection request limit must be an integer from 1 through 4.");
    }
    if (!Number.isInteger(input.revisionNumber) || input.revisionNumber < 1) {
      throw new TypeError("Connection revision number must be a positive integer.");
    }

    return this.database.$transaction(async (transaction) => {
      const organization = await transaction.organizations.findUnique({
        where: { id: input.organizationId },
        select: { id: true },
      });
      if (!organization) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Connection profile organization does not exist.",
        );
      }

      const profile = await transaction.source_connection_profiles.create({
        data: {
          organization_id: input.organizationId,
          source_type_key: sourceTypeKey,
          connection_type_key: connectionTypeKey,
          display_name: requireKey(input.displayName, "Connection profile name"),
          request_limit: input.requestLimit,
          created_by_actor_key: requireKey(input.actorKey, "Actor key"),
          created_at: input.createdAt,
          updated_at: input.createdAt,
        },
        select: { id: true },
      });
      const revision = await transaction.source_connection_revisions.create({
        data: {
          organization_id: input.organizationId,
          connection_profile_id: profile.id,
          revision_number: input.revisionNumber,
          source_type_key: sourceTypeKey,
          source_adapter_version: sourceAdapterVersion,
          configuration_ciphertext: asPrismaBytes(input.configurationCiphertext),
          configuration_nonce: asPrismaBytes(input.configurationNonce),
          configuration_auth_tag: asPrismaBytes(input.configurationAuthTag),
          encryption_key_version: input.encryptionKeyVersion,
          configuration_fingerprint: requireSha256(
            input.configurationFingerprint,
            "Configuration fingerprint",
          ),
          created_by_actor_key: input.actorKey,
          created_at: input.createdAt,
        },
        select: { id: true },
      });
      return { profileId: profile.id, revisionId: revision.id };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async createSourceInstanceRevision(input: Readonly<{
    organizationId: string;
    providerId: string;
    connectionProfileId: string;
    sourceTypeKey: string;
    sourceAdapterVersion: string;
    normalizedContractVersion: string;
    mapperKey: string;
    mapperVersion: string;
    identityNamespaceKey: string;
    cursorCodecVersion: string;
    revisionNumber: number;
    scheduleRevisionNumber?: number;
    intervalSeconds?: number;
    configuration: Readonly<Record<string, unknown>>;
    configurationHash: string;
    recordIdScopes: readonly string[];
    replacesSourceInstanceId?: string | null;
    replacementPredecessor?: Readonly<{
      mapperKey: string;
      mapperVersion: string;
      normalizedContractVersion: string;
    }> | null;
    actorKey: string;
    createdAt: Date;
  }>): Promise<{ sourceInstanceId: string; sourceRevisionId: string }> {
    const intervalSeconds = input.intervalSeconds
      ?? PROVIDER_SOURCE_SCHEDULE_BOUNDS.defaultIntervalSeconds;
    if (
      !Number.isInteger(intervalSeconds)
      || intervalSeconds < PROVIDER_SOURCE_SCHEDULE_BOUNDS.minimumIntervalSeconds
      || intervalSeconds > PROVIDER_SOURCE_SCHEDULE_BOUNDS.maximumIntervalSeconds
    ) {
      throw new TypeError("Source interval must be an integer from 60 through 86400 seconds.");
    }
    if (
      input.recordIdScopes.length === 0
      || input.recordIdScopes.length > 32
      || new Set(input.recordIdScopes).size !== input.recordIdScopes.length
    ) {
      throw new TypeError("Source record-ID scopes must be nonempty and unique.");
    }
    const sourceTypeKey = requireRegistrationKey(input.sourceTypeKey, "Source type key");
    const sourceAdapterVersion = requireRegistrationKey(
      input.sourceAdapterVersion,
      "Source adapter version",
    );
    const normalizedContractVersion = requireVersionKey(
      input.normalizedContractVersion,
      "Normalized contract version",
    );
    const mapperKey = requireRegistrationKey(input.mapperKey, "Mapper key");
    const mapperVersion = requireRegistrationKey(input.mapperVersion, "Mapper version");
    const identityNamespaceKey = requireRegistrationKey(
      input.identityNamespaceKey,
      "Identity namespace key",
    );
    const cursorCodecVersion = requireRegistrationKey(
      input.cursorCodecVersion,
      "Cursor codec version",
    );
    input.recordIdScopes.forEach((scope) => requireRegistrationKey(scope, "Record-ID scope"));
    const replacementPredecessor = input.replacementPredecessor
      ? {
          mapperKey: requireRegistrationKey(
            input.replacementPredecessor.mapperKey,
            "Replacement predecessor mapper key",
          ),
          mapperVersion: requireRegistrationKey(
            input.replacementPredecessor.mapperVersion,
            "Replacement predecessor mapper version",
          ),
          normalizedContractVersion: requireVersionKey(
            input.replacementPredecessor.normalizedContractVersion,
            "Replacement predecessor normalized contract version",
          ),
        }
      : null;
    if (Boolean(input.replacesSourceInstanceId) !== Boolean(replacementPredecessor)) {
      throw new TypeError(
        "Replacement source and predecessor compatibility pin must be provided together.",
      );
    }
    if (mapperKey === sourceTypeKey) {
      throw new TypeError("Mapper identity must be distinct from source type identity.");
    }
    if (!Number.isInteger(input.revisionNumber) || input.revisionNumber < 1) {
      throw new TypeError("Source revision number must be a positive integer.");
    }

    return this.database.$transaction(async (transaction) => {
      const provider = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id from public.provider_sources
        where id = cast(${input.providerId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for share
      `);
      let replacement: { id: string; activeRevisionId: string } | null = null;
      if (input.replacesSourceInstanceId) {
        const locked = await transaction.$queryRaw<Array<{
          id: string;
          activeRevisionId: string;
        }>>(Prisma.sql`
          select id, active_revision_id as "activeRevisionId"
          from public.provider_source_instances
          where id = cast(${input.replacesSourceInstanceId} as uuid)
            and organization_id = cast(${input.organizationId} as uuid)
            and provider_id = cast(${input.providerId} as uuid)
            and state in ('paused', 'disabled')
          for update
        `);
        replacement = locked[0] ?? null;
        const [activeRun, revision] = replacement
          ? await Promise.all([
              transaction.import_runs.findFirst({
                where: {
                  organization_id: input.organizationId,
                  source_instance_id: replacement.id,
                  state: { in: ["queued", "running"] },
                },
                select: { id: true },
              }),
              transaction.provider_source_revisions.findFirst({
                where: {
                  organization_id: input.organizationId,
                  source_instance_id: replacement.id,
                  id: replacement.activeRevisionId,
                  identity_namespace_key: identityNamespaceKey,
                  mapper_key: replacementPredecessor!.mapperKey,
                  mapper_version: replacementPredecessor!.mapperVersion,
                  normalized_contract_version:
                    replacementPredecessor!.normalizedContractVersion,
                  record_id_scopes_json: { equals: asJson(input.recordIdScopes) },
                },
                select: { id: true },
              }),
            ])
          : [null, null];
        if (!replacement || activeRun || !revision) {
          throw new PersistenceError(
            "SOURCE_FENCED",
            "Replacement source must be idle, paused or disabled, and namespace-compatible.",
          );
        }
      }
      const profile = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select profile.id from public.source_connection_profiles as profile
        where profile.id = cast(${input.connectionProfileId} as uuid)
          and profile.organization_id = cast(${input.organizationId} as uuid)
          and profile.source_type_key = ${sourceTypeKey}
          and profile.state <> 'disabled'
          and (
            profile.state = 'draft'
            or exists (
              select 1
              from public.source_connection_revisions as active_revision
              where active_revision.id = profile.active_revision_id
                and active_revision.organization_id = profile.organization_id
                and active_revision.connection_profile_id = profile.id
                and active_revision.source_type_key = profile.source_type_key
                and active_revision.source_adapter_version = ${sourceAdapterVersion}
                and active_revision.state = 'active'
                and active_revision.revoked_at is null
            )
          )
        for share
      `);
      const compatibleConnectionRevision =
        await transaction.source_connection_revisions.findFirst({
          where: {
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
            source_type_key: sourceTypeKey,
            source_adapter_version: sourceAdapterVersion,
            revoked_at: null,
          },
          select: { id: true },
        });
      if (!provider[0] || !profile[0] || !compatibleConnectionRevision) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Provider or connection profile is outside the organization and source-type scope.",
        );
      }

      const source = await transaction.provider_source_instances.create({
        data: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          source_type_key: sourceTypeKey,
          connection_profile_id: input.connectionProfileId,
          created_by_actor_key: requireKey(input.actorKey, "Actor key"),
          created_at: input.createdAt,
          updated_at: input.createdAt,
        },
        select: { id: true },
      });
      const sourceRevision = await transaction.provider_source_revisions.create({
        data: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          source_instance_id: source.id,
          connection_profile_id: input.connectionProfileId,
          revision_number: input.revisionNumber,
          source_type_key: sourceTypeKey,
          source_adapter_version: sourceAdapterVersion,
          normalized_contract_version: normalizedContractVersion,
          mapper_key: mapperKey,
          mapper_version: mapperVersion,
          identity_namespace_key: identityNamespaceKey,
          cursor_codec_version: cursorCodecVersion,
          configuration_json: asJson(input.configuration),
          configuration_hash: requireSha256(input.configurationHash, "Configuration hash"),
          record_id_scopes_json: asJson(input.recordIdScopes),
          created_by_actor_key: input.actorKey,
          created_at: input.createdAt,
        },
        select: { id: true },
      });
      await transaction.provider_source_instances.update({
        where: { id: source.id },
        data: { active_revision_id: sourceRevision.id },
      });
      const scheduleRevision = await transaction.provider_source_schedule_revisions.create({
        data: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          source_instance_id: source.id,
          revision_number: input.scheduleRevisionNumber ?? 1,
          interval_seconds: intervalSeconds,
          freshness_grace_seconds: PROVIDER_SOURCE_SCHEDULE_BOUNDS.freshnessGraceSeconds,
          created_by_actor_key: input.actorKey,
          effective_at: input.createdAt,
          created_at: input.createdAt,
        },
        select: { id: true },
      });
      await Promise.all([
        transaction.provider_source_schedules.create({
          data: {
            source_instance_id: source.id,
            organization_id: input.organizationId,
            provider_id: input.providerId,
            active_schedule_revision_id: scheduleRevision.id,
            next_due_at: input.createdAt,
            updated_at: input.createdAt,
          },
        }),
        transaction.provider_source_cursors.create({
          data: {
            source_instance_id: source.id,
            organization_id: input.organizationId,
            provider_id: input.providerId,
            source_revision_id: sourceRevision.id,
            source_adapter_version: sourceAdapterVersion,
            cursor_codec_version: cursorCodecVersion,
            cursor_generation: 1n,
            updated_at: input.createdAt,
          },
        }),
        transaction.provider_source_health_states.create({
          data: {
            source_instance_id: source.id,
            organization_id: input.organizationId,
            provider_id: input.providerId,
            updated_at: input.createdAt,
          },
        }),
      ]);
      if (replacement) {
        await transaction.provider_source_instances.update({
          where: { id: replacement.id },
          data: {
            state: "replaced",
            replaced_at: input.createdAt,
            pause_requested_at: null,
            updated_at: input.createdAt,
          },
        });
      }
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.actorKey,
          action: replacement
            ? "provider_source.create_replacement"
            : "provider_source.create",
          subject_type: "provider_source",
          subject_id: source.id,
          outcome: "success",
          metadata_json: {
            sourceRevisionId: sourceRevision.id,
            ...(replacement ? { replacesSourceInstanceId: replacement.id } : {}),
          },
          occurred_at: input.createdAt,
        },
      });
      return { sourceInstanceId: source.id, sourceRevisionId: sourceRevision.id };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async loadSourceActivationCandidate(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
    connectionRevisionId: string;
  }>): Promise<ProviderSourceActivationCandidateSnapshot | null> {
    return this.database.$transaction(async (transaction) => {
      const source = await transaction.provider_source_instances.findFirst({
        where: {
          id: input.sourceInstanceId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          active_revision_id: input.sourceRevisionId,
        },
      });
      if (!source?.active_revision_id) return null;

      const [provider, sourceRevision, connectionProfile, connectionRevision, cursor] =
        await Promise.all([
          transaction.provider_sources.findFirst({
            where: {
              id: input.providerId,
              organization_id: input.organizationId,
            },
            select: { id: true, platform_key: true },
          }),
          transaction.provider_source_revisions.findFirst({
            where: {
              id: input.sourceRevisionId,
              organization_id: input.organizationId,
              provider_id: input.providerId,
              source_instance_id: input.sourceInstanceId,
            },
          }),
          transaction.source_connection_profiles.findFirst({
            where: {
              id: source.connection_profile_id,
              organization_id: input.organizationId,
            },
          }),
          transaction.source_connection_revisions.findFirst({
            where: {
              id: input.connectionRevisionId,
              organization_id: input.organizationId,
              connection_profile_id: source.connection_profile_id,
            },
          }),
          transaction.provider_source_cursors.findFirst({
            where: {
              source_instance_id: input.sourceInstanceId,
              organization_id: input.organizationId,
              provider_id: input.providerId,
            },
          }),
        ]);
      if (
        !provider
        || !sourceRevision
        || !connectionProfile?.active_revision_id
        || !connectionRevision
        || !cursor
      ) return null;

      return {
        organizationId: input.organizationId,
        provider: {
          id: provider.id,
          platformKey: provider.platform_key,
        },
        sourceInstance: {
          id: source.id,
          state: source.state,
          sourceTypeKey: source.source_type_key,
          connectionProfileId: source.connection_profile_id,
          activeRevisionId: source.active_revision_id,
        },
        sourceRevision: {
          id: sourceRevision.id,
          providerId: sourceRevision.provider_id,
          connectionProfileId: sourceRevision.connection_profile_id,
          sourceTypeKey: sourceRevision.source_type_key,
          sourceAdapterVersion: sourceRevision.source_adapter_version,
          normalizedContractVersion: sourceRevision.normalized_contract_version,
          mapperKey: sourceRevision.mapper_key,
          mapperVersion: sourceRevision.mapper_version,
          identityNamespaceKey: sourceRevision.identity_namespace_key,
          cursorCodecVersion: sourceRevision.cursor_codec_version,
          configuration: sourceRevision.configuration_json,
          configurationHash: sourceRevision.configuration_hash,
          recordIdScopes: sourceRevision.record_id_scopes_json,
        },
        connectionProfile: {
          id: connectionProfile.id,
          state: connectionProfile.state,
          sourceTypeKey: connectionProfile.source_type_key,
          connectionTypeKey: connectionProfile.connection_type_key,
          requestLimit: connectionProfile.request_limit,
          activeRevisionId: connectionProfile.active_revision_id,
        },
        connectionRevision: {
          id: connectionRevision.id,
          state: connectionRevision.state,
          sourceTypeKey: connectionRevision.source_type_key,
          sourceAdapterVersion: connectionRevision.source_adapter_version,
          configurationFingerprint: connectionRevision.configuration_fingerprint,
          revokedAt: connectionRevision.revoked_at,
        },
        cursor: {
          sourceRevisionId: cursor.source_revision_id,
          sourceAdapterVersion: cursor.source_adapter_version,
          cursorCodecVersion: cursor.cursor_codec_version,
          cursorGeneration: cursor.cursor_generation,
          cursorFingerprint: cursor.cursor_fingerprint,
          hasCursor: cursor.cursor !== null,
          advancedByRunId: cursor.advanced_by_run_id,
          advancedByPageId: cursor.advanced_by_page_id,
        },
      };
    }, {
      ...PACKSCOUT_TRANSACTION_OPTIONS,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  async activateSourcePausedExact(
    input: ActivateProviderSourcePausedExactInput,
  ): Promise<void> {
    requireRegistrationKey(input.providerKey, "Provider key");
    requireRegistrationKey(input.sourceTypeKey, "Source type key");
    requireRegistrationKey(input.sourceAdapterVersion, "Source adapter version");
    requireVersionKey(input.normalizedContractVersion, "Normalized contract version");
    requireRegistrationKey(input.mapperKey, "Mapper key");
    requireRegistrationKey(input.mapperVersion, "Mapper version");
    requireRegistrationKey(input.identityNamespaceKey, "Identity namespace key");
    requireRegistrationKey(input.cursorCodecVersion, "Cursor codec version");
    requireRegistrationKey(input.connectionTypeKey, "Connection type key");
    requireSha256(input.sourceConfigurationHash, "Source configuration hash");
    requireSha256(
      input.connectionConfigurationFingerprint,
      "Connection configuration fingerprint",
    );
    if (
      !Number.isInteger(input.connectionRequestLimit)
      || input.connectionRequestLimit < 1
      || input.connectionRequestLimit > 4
    ) {
      throw new TypeError("Connection request limit must be an integer from 1 through 4.");
    }
    if (input.cursorGeneration < 1n) {
      throw new TypeError("Cursor generation must be positive.");
    }
    if (
      input.recordIdScopes.length === 0
      || new Set(input.recordIdScopes).size !== input.recordIdScopes.length
    ) {
      throw new TypeError("Source record-ID scopes must be nonempty and unique.");
    }
    input.recordIdScopes.forEach((scope) =>
      requireRegistrationKey(scope, "Record-ID scope"));
    const sourceConfiguration = asJson(input.sourceConfiguration);
    const recordIdScopes = asJson(input.recordIdScopes);

    await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        select id
        from public.provider_source_instances
        where id = cast(${input.sourceInstanceId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and provider_id = cast(${input.providerId} as uuid)
        for update
      `);
      const source = await transaction.provider_source_instances.findFirst({
        where: {
          id: input.sourceInstanceId,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          active_revision_id: input.sourceRevisionId,
          source_type_key: input.sourceTypeKey,
          connection_profile_id: input.connectionProfileId,
          state: { in: ["draft", "disabled"] },
        },
      });
      if (!source) {
        throw new PersistenceError("SOURCE_FENCED", "Draft source revision is no longer current.");
      }

      const lockedProfiles = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.source_connection_profiles
        where id = cast(${input.connectionProfileId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and source_type_key = ${input.sourceTypeKey}
          and connection_type_key = ${input.connectionTypeKey}
          and request_limit = ${input.connectionRequestLimit}
          and state = 'active'
          and active_revision_id = cast(${input.connectionRevisionId} as uuid)
        for share
      `);
      if (!lockedProfiles[0]) {
        throw new PersistenceError(
          "SOURCE_FENCED",
          "Connection profile no longer matches the validated activation pins.",
        );
      }

      const [provider, sourceRevision, connectionRevision, cursor] = await Promise.all([
        transaction.provider_sources.findFirst({
          where: {
            id: input.providerId,
            organization_id: input.organizationId,
            platform_key: input.providerKey,
          },
          select: { id: true },
        }),
        transaction.provider_source_revisions.findFirst({
          where: {
            id: input.sourceRevisionId,
            organization_id: input.organizationId,
            provider_id: input.providerId,
            source_instance_id: input.sourceInstanceId,
            connection_profile_id: input.connectionProfileId,
            source_type_key: input.sourceTypeKey,
            source_adapter_version: input.sourceAdapterVersion,
            normalized_contract_version: input.normalizedContractVersion,
            mapper_key: input.mapperKey,
            mapper_version: input.mapperVersion,
            identity_namespace_key: input.identityNamespaceKey,
            cursor_codec_version: input.cursorCodecVersion,
            configuration_hash: input.sourceConfigurationHash,
            configuration_json: { equals: sourceConfiguration },
            record_id_scopes_json: { equals: recordIdScopes },
          },
          select: { id: true },
        }),
        transaction.source_connection_revisions.findFirst({
          where: {
            id: input.connectionRevisionId,
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
            source_type_key: input.sourceTypeKey,
            source_adapter_version: input.sourceAdapterVersion,
            configuration_fingerprint: input.connectionConfigurationFingerprint,
            state: "active",
            revoked_at: null,
          },
          select: { health_generation: true },
        }),
        transaction.provider_source_cursors.findFirst({
          where: {
            source_instance_id: input.sourceInstanceId,
            organization_id: input.organizationId,
            provider_id: input.providerId,
            source_revision_id: input.sourceRevisionId,
            source_adapter_version: input.sourceAdapterVersion,
            cursor_codec_version: input.cursorCodecVersion,
            cursor_generation: input.cursorGeneration,
          },
          select: { source_instance_id: true },
        }),
      ]);
      if (!provider || !sourceRevision || !connectionRevision || !cursor) {
        throw new PersistenceError(
          "SOURCE_FENCED",
          "Source activation pins changed after compatibility validation.",
        );
      }

      const profile = await transaction.source_connection_profiles.findFirst({
        where: {
          id: input.connectionProfileId,
          organization_id: input.organizationId,
          state: "active",
          active_revision_id: input.connectionRevisionId,
        },
        select: { id: true },
      });
      const [latestSourceTest, latestConnectionTest] = await Promise.all([
        transaction.provider_source_test_jobs.findFirst({
          where: {
            organization_id: input.organizationId,
            provider_id: input.providerId,
            source_instance_id: input.sourceInstanceId,
            source_revision_id: input.sourceRevisionId,
            connection_revision_id: input.connectionRevisionId,
            expected_health_generation: connectionRevision.health_generation,
          },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          select: { id: true, state: true, created_at: true },
        }),
        transaction.source_connection_test_jobs.findFirst({
          where: {
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
            connection_revision_id: input.connectionRevisionId,
            expected_health_generation: connectionRevision.health_generation,
          },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          select: { id: true, state: true },
        }),
      ]);
      const successfulTest = latestSourceTest?.state === "succeeded"
        ? await transaction.provider_source_test_results.findFirst({
            where: {
              job_id: latestSourceTest.id,
              organization_id: input.organizationId,
              provider_id: input.providerId,
              source_instance_id: input.sourceInstanceId,
              source_revision_id: input.sourceRevisionId,
              connection_revision_id: input.connectionRevisionId,
              resulting_health_generation: connectionRevision?.health_generation,
              outcome: "success",
              request_terminal_state: "captured",
            },
            select: { id: true },
          })
        : null;
      const successfulConnectionTest = latestConnectionTest?.state === "succeeded"
        ? await transaction.source_connection_test_results.findFirst({
            where: {
              job_id: latestConnectionTest.id,
              organization_id: input.organizationId,
              connection_profile_id: input.connectionProfileId,
              connection_revision_id: input.connectionRevisionId,
              resulting_health_generation: connectionRevision.health_generation,
              outcome: "success",
              request_terminal_state: "captured",
            },
            select: { id: true },
          })
        : null;
      const disabledTestIsFresh = source.state !== "disabled" || (
        source.disabled_at !== null &&
        latestSourceTest !== null &&
        latestSourceTest.created_at >= source.disabled_at
      );
      if (
        !profile ||
        !successfulConnectionTest ||
        !successfulTest ||
        !disabledTestIsFresh
      ) {
        throw new PersistenceError(
          "CONFIG_REVISION_UNTESTED",
          "Current connection and source tests are required before activation.",
        );
      }
      await transaction.provider_source_instances.update({
        where: { id: input.sourceInstanceId },
        data: {
          state: "paused",
          disabled_at: null,
          activated_at: input.activatedAt,
          paused_at: input.activatedAt,
          updated_at: input.activatedAt,
        },
      });
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.actorKey,
          action: "provider_source.activate_paused",
          subject_type: "provider_source",
          subject_id: input.sourceInstanceId,
          outcome: "success",
          metadata_json: { sourceRevisionId: input.sourceRevisionId },
          occurred_at: input.activatedAt,
        },
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async getCurrentPins(input: Readonly<{
    organizationId: string;
    sourceInstanceId: string;
  }>): Promise<ProviderSourceRevisionPins> {
    const source = await this.database.provider_source_instances.findFirst({
      where: { id: input.sourceInstanceId, organization_id: input.organizationId },
    });
    if (!source?.active_revision_id) {
      throw new PersistenceError("NOT_FOUND", "Source revision was not found in tenant scope.");
    }
    const [revision, profile] = await Promise.all([
      this.database.provider_source_revisions.findFirst({
        where: {
          id: source.active_revision_id,
          organization_id: input.organizationId,
          source_instance_id: source.id,
        },
      }),
      this.database.source_connection_profiles.findFirst({
        where: { id: source.connection_profile_id, organization_id: input.organizationId },
      }),
    ]);
    if (!revision || !profile?.active_revision_id) {
      throw new PersistenceError("SOURCE_FENCED", "Source has no active connection revision.");
    }
    const cursor = await this.database.provider_source_cursors.findFirst({
      where: { source_instance_id: source.id, organization_id: input.organizationId },
    });
    if (!cursor) throw new PersistenceError("NOT_FOUND", "Source cursor was not found.");
    return {
      providerId: source.provider_id,
      sourceInstanceId: source.id,
      sourceRevisionId: revision.id,
      sourceTypeKey: revision.source_type_key,
      sourceAdapterVersion: revision.source_adapter_version,
      normalizedContractVersion: revision.normalized_contract_version,
      mapperKey: revision.mapper_key,
      mapperVersion: revision.mapper_version,
      identityNamespaceKey: revision.identity_namespace_key,
      connectionProfileId: source.connection_profile_id,
      connectionRevisionId: profile.active_revision_id,
      cursorCodecVersion: cursor.cursor_codec_version,
      cursorGeneration: cursor.cursor_generation,
    };
  }
}
