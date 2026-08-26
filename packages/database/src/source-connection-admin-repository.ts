import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutQueryClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { providerSourceTransactionTime } from "./provider-source-database-clock.ts";
import { SourceConnectionRecoveryRepository } from "./source-connection-recovery-repository.ts";

interface EncryptedConfiguration {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyVersion: number;
}

function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

function safeAuditMetadata(revisionId: string): Prisma.InputJsonObject {
  return { connectionRevisionId: revisionId };
}

async function hasIncompatibleRunnableSourceAdapterPins(
  database: PackscoutQueryClient,
  input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    sourceAdapterVersion: string;
  }>,
): Promise<boolean> {
  const rows = await database.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`
    select exists (
      select 1
      from public.provider_source_instances source
      join public.provider_source_revisions revision
        on revision.id = source.active_revision_id
       and revision.organization_id = source.organization_id
       and revision.provider_id = source.provider_id
       and revision.source_instance_id = source.id
       and revision.connection_profile_id = source.connection_profile_id
      where source.organization_id = cast(${input.organizationId} as uuid)
        and source.connection_profile_id = cast(${input.connectionProfileId} as uuid)
        and source.state in ('active', 'paused')
        and revision.source_adapter_version <> ${input.sourceAdapterVersion}
    ) as blocked
  `);
  return rows[0]?.blocked ?? false;
}

export class SourceConnectionAdminRepository {
  readonly #recovery: SourceConnectionRecoveryRepository;

  constructor(private readonly database: PackscoutPrismaClient) {
    this.#recovery = new SourceConnectionRecoveryRepository(database);
  }

  addRecoveryConnectionRevision(
    input: Parameters<
      SourceConnectionRecoveryRepository["addRecoveryConnectionRevision"]
    >[0],
  ) {
    return this.#recovery.addRecoveryConnectionRevision(input);
  }

  requestConnectionRecoveryTest(
    input: Parameters<
      SourceConnectionRecoveryRepository["requestConnectionRecoveryTest"]
    >[0],
  ) {
    return this.#recovery.requestConnectionRecoveryTest(input);
  }

  activateTestedConnectionRecovery(
    input: Parameters<
      SourceConnectionRecoveryRepository["activateTestedConnectionRecovery"]
    >[0],
  ) {
    return this.#recovery.activateTestedConnectionRecovery(input);
  }

  async createConnectionProfile(
    input: Readonly<{
      organizationId: string;
      profileId: string;
      revisionId: string;
      sourceTypeKey: string;
      connectionTypeKey: string;
      displayName: string;
      requestLimit: number;
      sourceAdapterVersion: string;
      encryptedConfiguration: EncryptedConfiguration;
      configurationFingerprint: string;
      actorKey: string;
      createdAt: Date;
    }>,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const organization = await transaction.organizations.findUnique({
        where: { id: input.organizationId },
        select: { id: true },
      });
      if (!organization) this.#tenantViolation();
      await transaction.source_connection_profiles.create({
        data: {
          id: input.profileId,
          organization_id: input.organizationId,
          source_type_key: input.sourceTypeKey,
          connection_type_key: input.connectionTypeKey,
          display_name: input.displayName,
          request_limit: input.requestLimit,
          created_by_actor_key: input.actorKey,
          created_at: input.createdAt,
          updated_at: input.createdAt,
        },
      });
      await transaction.source_connection_revisions.create({
        data: {
          id: input.revisionId,
          organization_id: input.organizationId,
          connection_profile_id: input.profileId,
          revision_number: 1,
          source_type_key: input.sourceTypeKey,
          source_adapter_version: input.sourceAdapterVersion,
          configuration_ciphertext: bytes(
            input.encryptedConfiguration.ciphertext,
          ),
          configuration_nonce: bytes(input.encryptedConfiguration.nonce),
          configuration_auth_tag: bytes(input.encryptedConfiguration.authTag),
          encryption_key_version: input.encryptedConfiguration.keyVersion,
          configuration_fingerprint: input.configurationFingerprint,
          created_by_actor_key: input.actorKey,
          created_at: input.createdAt,
        },
      });
      await this.#audit(transaction, {
        organizationId: input.organizationId,
        actorKey: input.actorKey,
        action: "source_connection.create_profile",
        subjectId: input.profileId,
        revisionId: input.revisionId,
        occurredAt: input.createdAt,
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async loadConnectionRevision(
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      connectionRevisionId?: string;
    }>,
  ) {
    const revision = await this.database.source_connection_revisions.findFirst({
      where: {
        organization_id: input.organizationId,
        connection_profile_id: input.connectionProfileId,
        ...(input.connectionRevisionId
          ? { id: input.connectionRevisionId }
          : {}),
      },
      orderBy: [{ revision_number: "desc" }, { id: "desc" }],
    });
    if (!revision) return null;
    return {
      organizationId: revision.organization_id,
      connectionProfileId: revision.connection_profile_id,
      connectionRevisionId: revision.id,
      sourceTypeKey: revision.source_type_key,
      sourceAdapterVersion: revision.source_adapter_version,
      revisionNumber: revision.revision_number,
      state: revision.state,
      healthGeneration: revision.health_generation,
      configurationFingerprint: revision.configuration_fingerprint,
      encryptedConfiguration: {
        ciphertext: new Uint8Array(revision.configuration_ciphertext),
        nonce: new Uint8Array(revision.configuration_nonce),
        authTag: new Uint8Array(revision.configuration_auth_tag),
        keyVersion: revision.encryption_key_version,
      },
    };
  }

  hasIncompatibleRunnableSourceAdapterPins(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    sourceAdapterVersion: string;
  }>): Promise<boolean> {
    return hasIncompatibleRunnableSourceAdapterPins(this.database, input);
  }

  async addConnectionRevision(
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      expectedRevisionId: string;
      revisionId: string;
      revisionNumber: number;
      sourceTypeKey: string;
      sourceAdapterVersion: string;
      encryptedConfiguration: EncryptedConfiguration;
      configurationFingerprint: string;
      actorKey: string;
      createdAt: Date;
    }>,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const profile = await transaction.$queryRaw<
        Array<{
          id: string;
          sourceTypeKey: string;
        }>
      >(Prisma.sql`
        select id, source_type_key as "sourceTypeKey"
        from public.source_connection_profiles
        where id = cast(${input.connectionProfileId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and state <> 'disabled'
          and not exists (
            select 1 from public.source_connection_health_episodes episode
            where episode.connection_profile_id = source_connection_profiles.id
              and episode.organization_id = source_connection_profiles.organization_id
              and episode.closed_at is null
          )
        for update
      `);
      if (!profile[0] || profile[0].sourceTypeKey !== input.sourceTypeKey) {
        this.#tenantViolation();
      }
      const latest = await transaction.source_connection_revisions.findFirst({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
        },
        orderBy: [{ revision_number: "desc" }, { id: "desc" }],
        select: {
          id: true,
          revision_number: true,
          source_adapter_version: true,
        },
      });
      if (
        latest?.id !== input.expectedRevisionId ||
        latest.revision_number + 1 !== input.revisionNumber ||
        latest.source_adapter_version !== input.sourceAdapterVersion
      )
        this.#fenced("Connection revision changed before rotation.");
      await transaction.source_connection_revisions.create({
        data: {
          id: input.revisionId,
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          revision_number: input.revisionNumber,
          source_type_key: input.sourceTypeKey,
          source_adapter_version: input.sourceAdapterVersion,
          configuration_ciphertext: bytes(
            input.encryptedConfiguration.ciphertext,
          ),
          configuration_nonce: bytes(input.encryptedConfiguration.nonce),
          configuration_auth_tag: bytes(input.encryptedConfiguration.authTag),
          encryption_key_version: input.encryptedConfiguration.keyVersion,
          configuration_fingerprint: input.configurationFingerprint,
          created_by_actor_key: input.actorKey,
          created_at: input.createdAt,
        },
      });
      await this.#audit(transaction, {
        organizationId: input.organizationId,
        actorKey: input.actorKey,
        action: "source_connection.rotate_credential",
        subjectId: input.connectionProfileId,
        revisionId: input.revisionId,
        occurredAt: input.createdAt,
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async addConnectionAdapterRevision(
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      expectedRevisionId: string;
      expectedSourceAdapterVersion: string;
      revisionId: string;
      revisionNumber: number;
      sourceTypeKey: string;
      sourceAdapterVersion: string;
      encryptedConfiguration: EncryptedConfiguration;
      configurationFingerprint: string;
      actorKey: string;
      createdAt: Date;
    }>,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const profile = await transaction.$queryRaw<
        Array<{
          id: string;
          sourceTypeKey: string;
        }>
      >(Prisma.sql`
        select id, source_type_key as "sourceTypeKey"
        from public.source_connection_profiles
        where id = cast(${input.connectionProfileId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and state <> 'disabled'
          and not exists (
            select 1 from public.source_connection_health_episodes episode
            where episode.connection_profile_id = source_connection_profiles.id
              and episode.organization_id = source_connection_profiles.organization_id
              and episode.closed_at is null
          )
        for update
      `);
      if (!profile[0] || profile[0].sourceTypeKey !== input.sourceTypeKey) {
        this.#tenantViolation();
      }
      const latest = await transaction.source_connection_revisions.findFirst({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
        },
        orderBy: [{ revision_number: "desc" }, { id: "desc" }],
        select: {
          id: true,
          revision_number: true,
          source_adapter_version: true,
          state: true,
          revoked_at: true,
        },
      });
      if (
        latest?.id !== input.expectedRevisionId ||
        latest.revision_number + 1 !== input.revisionNumber ||
        latest.source_adapter_version !== input.expectedSourceAdapterVersion ||
        !["candidate", "active"].includes(latest.state) ||
        latest.revoked_at !== null ||
        input.sourceAdapterVersion === input.expectedSourceAdapterVersion
      )
        this.#fenced("Connection revision changed before adapter upgrade.");
      if (await hasIncompatibleRunnableSourceAdapterPins(transaction, {
        organizationId: input.organizationId,
        connectionProfileId: input.connectionProfileId,
        sourceAdapterVersion: input.sourceAdapterVersion,
      })) {
        this.#fenced("Runnable sources are pinned to another adapter version.");
      }
      await transaction.source_connection_revisions.create({
        data: {
          id: input.revisionId,
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          revision_number: input.revisionNumber,
          source_type_key: input.sourceTypeKey,
          source_adapter_version: input.sourceAdapterVersion,
          configuration_ciphertext: bytes(
            input.encryptedConfiguration.ciphertext,
          ),
          configuration_nonce: bytes(input.encryptedConfiguration.nonce),
          configuration_auth_tag: bytes(input.encryptedConfiguration.authTag),
          encryption_key_version: input.encryptedConfiguration.keyVersion,
          configuration_fingerprint: input.configurationFingerprint,
          created_by_actor_key: input.actorKey,
          created_at: input.createdAt,
        },
      });
      await this.#audit(transaction, {
        organizationId: input.organizationId,
        actorKey: input.actorKey,
        action: "source_connection.upgrade_adapter",
        subjectId: input.connectionProfileId,
        revisionId: input.revisionId,
        occurredAt: input.createdAt,
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async requestConnectionTest(
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      connectionRevisionId: string;
      expectedHealthGeneration: bigint;
      requestedByActorKey: string;
      requestedAt: Date;
    }>,
  ): Promise<{ readonly jobId: string }> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<
        Array<{ id: string }>
      >(Prisma.sql`
        select revision.id
        from public.source_connection_profiles profile
        join public.source_connection_revisions revision
          on revision.connection_profile_id = profile.id
         and revision.organization_id = profile.organization_id
        where profile.id = cast(${input.connectionProfileId} as uuid)
          and profile.organization_id = cast(${input.organizationId} as uuid)
          and profile.state <> 'disabled'
          and not exists (
            select 1 from public.source_connection_health_episodes episode
            where episode.connection_profile_id = profile.id
              and episode.organization_id = profile.organization_id
              and episode.closed_at is null
          )
          and revision.id = cast(${input.connectionRevisionId} as uuid)
          and revision.health_generation = ${input.expectedHealthGeneration}
          and revision.state in ('candidate', 'active')
          and revision.revoked_at is null
        for update of profile, revision
      `);
      if (!locked[0]) this.#fenced("Connection revision is not testable.");
      const existing = await transaction.source_connection_test_jobs.findFirst({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          connection_revision_id: input.connectionRevisionId,
          expected_health_generation: input.expectedHealthGeneration,
          state: { in: ["queued", "running"] },
        },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (existing) {
        await this.#audit(transaction, {
          organizationId: input.organizationId,
          actorKey: input.requestedByActorKey,
          action: "source_connection.request_test_coalesced",
          subjectId: input.connectionProfileId,
          revisionId: input.connectionRevisionId,
          occurredAt: input.requestedAt,
        });
        return { jobId: existing.id };
      }
      const jobId = randomUUID();
      await transaction.source_connection_test_jobs.create({
        data: {
          id: jobId,
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          connection_revision_id: input.connectionRevisionId,
          expected_health_generation: input.expectedHealthGeneration,
          requested_by_actor_key: input.requestedByActorKey,
          created_at: input.requestedAt,
        },
      });
      await this.#audit(transaction, {
        organizationId: input.organizationId,
        actorKey: input.requestedByActorKey,
        action: "source_connection.request_test",
        subjectId: input.connectionProfileId,
        revisionId: input.connectionRevisionId,
        occurredAt: input.requestedAt,
      });
      return { jobId };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async activateTestedConnectionRevision(
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      connectionRevisionId: string;
      expectedHealthGeneration: bigint;
      preservePinnedWork: true;
      actorKey: string;
      activatedAt: Date;
    }>,
  ): Promise<void> {
    if (input.preservePinnedWork !== true) {
      throw new TypeError("Normal rotation must preserve pinned work.");
    }
    await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        select id from public.source_connection_profiles
        where id = cast(${input.connectionProfileId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);
      const [
        revision,
        latestRevision,
        latestTestJob,
        blockingEpisode,
        profile,
      ] = await Promise.all([
        transaction.source_connection_revisions.findFirst({
          where: {
            id: input.connectionRevisionId,
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
            health_generation: input.expectedHealthGeneration,
            state: { in: ["candidate", "active"] },
            revoked_at: null,
          },
        }),
        transaction.source_connection_revisions.findFirst({
          where: {
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
          },
          orderBy: [{ revision_number: "desc" }, { id: "desc" }],
          select: { id: true },
        }),
        transaction.source_connection_test_jobs.findFirst({
          where: {
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
            connection_revision_id: input.connectionRevisionId,
          },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          select: { id: true, state: true },
        }),
        transaction.source_connection_health_episodes.findFirst({
          where: {
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
            closed_at: null,
          },
          select: { id: true },
        }),
        transaction.source_connection_profiles.findFirst({
          where: {
            id: input.connectionProfileId,
            organization_id: input.organizationId,
            state: { not: "disabled" },
          },
          select: { active_revision_id: true },
        }),
      ]);
      if (!revision || !profile) this.#tenantViolation();
      if (latestRevision?.id !== revision.id) {
        this.#fenced("Only the latest connection revision can activate.");
      }
      if (await hasIncompatibleRunnableSourceAdapterPins(transaction, {
        organizationId: input.organizationId,
        connectionProfileId: input.connectionProfileId,
        sourceAdapterVersion: revision.source_adapter_version,
      })) {
        this.#fenced("Runnable sources are pinned to another adapter version.");
      }
      const successfulTest =
        latestTestJob?.state === "succeeded"
          ? await transaction.source_connection_test_results.findFirst({
              where: {
                job_id: latestTestJob.id,
                organization_id: input.organizationId,
                connection_profile_id: input.connectionProfileId,
                connection_revision_id: input.connectionRevisionId,
                resulting_health_generation: input.expectedHealthGeneration,
                outcome: "success",
                request_terminal_state: "captured",
              },
              select: { id: true },
            })
          : null;
      if (!successfulTest) {
        throw new PersistenceError(
          "CONFIG_REVISION_UNTESTED",
          "Current successful connection test is required.",
        );
      }
      if (blockingEpisode) {
        throw new PersistenceError(
          "CONNECTION_BLOCKED",
          "Blocking recovery must use the fenced recovery activation path.",
        );
      }
      const previousRevisionId = profile.active_revision_id;
      await this.#recovery.restoreUnclaimedLanesAfterRecoveryInTransaction(
        transaction,
        {
          organizationId: input.organizationId,
          connectionProfileId: input.connectionProfileId,
          connectionRevisionId: previousRevisionId,
          blockingEpisodeId: null,
          supervisorEpochId: null,
          resumedAt: input.activatedAt,
        },
      );
      if (previousRevisionId && previousRevisionId !== revision.id) {
        await transaction.source_connection_revisions.updateMany({
          where: {
            id: previousRevisionId,
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
            state: "active",
          },
          data: { state: "retired", retired_at: input.activatedAt },
        });
      }
      await transaction.source_connection_revisions.update({
        where: { id: revision.id },
        data: {
          state: "active",
          activated_at: input.activatedAt,
          retired_at: null,
        },
      });
      await transaction.source_connection_profiles.update({
        where: { id: input.connectionProfileId },
        data: {
          state: "active",
          active_revision_id: revision.id,
          updated_at: input.activatedAt,
        },
      });
      await this.#audit(transaction, {
        organizationId: input.organizationId,
        actorKey: input.actorKey,
        action: "source_connection.activate_normal_revision",
        subjectId: input.connectionProfileId,
        revisionId: revision.id,
        occurredAt: input.activatedAt,
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async revokeConnectionRevision(
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      connectionRevisionId: string;
      expectedHealthGeneration: bigint;
      actorKey: string;
      revokedAt: Date;
    }>,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        select id from public.source_connection_profiles
        where id = cast(${input.connectionProfileId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);
      const revision = await transaction.source_connection_revisions.findFirst({
        where: {
          id: input.connectionRevisionId,
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          health_generation: input.expectedHealthGeneration,
          revoked_at: null,
        },
      });
      if (!revision)
        this.#fenced("Connection revision changed before revocation.");
      const databaseNow = await providerSourceTransactionTime(transaction);
      await transaction.source_connection_revisions.update({
        where: { id: revision.id },
        data: {
          state: "revoked",
          health_generation: { increment: 1n },
          revoked_at: input.revokedAt,
          revoked_by_actor_key: input.actorKey,
        },
      });
      await Promise.all([
        transaction.source_connection_test_jobs.updateMany({
          where: {
            organization_id: input.organizationId,
            connection_revision_id: revision.id,
            state: { in: ["queued", "running"] },
          },
          data: { state: "fenced", finished_at: databaseNow },
        }),
        transaction.provider_source_test_jobs.updateMany({
          where: {
            organization_id: input.organizationId,
            connection_revision_id: revision.id,
            state: { in: ["queued", "running"] },
          },
          data: { state: "fenced", finished_at: databaseNow },
        }),
        transaction.import_runs.updateMany({
          where: {
            organization_id: input.organizationId,
            connection_revision_id: revision.id,
            state: { in: ["queued", "running"] },
          },
          data: {
            state: "failed",
            failure_code: "CONNECTION_REVISION_REVOKED",
            failure_summary: "Pinned connection revision was revoked.",
            finished_at: databaseNow,
            lease_owner: null,
            lease_token: null,
            lease_expires_at: null,
          },
        }),
      ]);
      await transaction.source_connection_profiles.updateMany({
        where: {
          id: input.connectionProfileId,
          organization_id: input.organizationId,
          active_revision_id: revision.id,
        },
        data: {
          state: "disabled",
          active_revision_id: null,
          updated_at: input.revokedAt,
        },
      });
      await this.#audit(transaction, {
        organizationId: input.organizationId,
        actorKey: input.actorKey,
        action: "source_connection.revoke_revision",
        subjectId: input.connectionProfileId,
        revisionId: revision.id,
        occurredAt: input.revokedAt,
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async #audit(
    transaction: Prisma.TransactionClient,
    input: Readonly<{
      organizationId: string;
      actorKey: string;
      action: string;
      subjectId: string;
      revisionId: string;
      occurredAt: Date;
    }>,
  ): Promise<void> {
    await transaction.audit_events.create({
      data: {
        organization_id: input.organizationId,
        actor_key: input.actorKey,
        action: input.action,
        subject_type: "source_connection_profile",
        subject_id: input.subjectId,
        outcome: "success",
        metadata_json: safeAuditMetadata(input.revisionId),
        occurred_at: input.occurredAt,
      },
    });
  }

  #tenantViolation(): never {
    throw new PersistenceError(
      "TENANT_SCOPE_VIOLATION",
      "Connection profile is outside tenant scope.",
    );
  }

  #fenced(message: string): never {
    throw new PersistenceError("SOURCE_FENCED", message);
  }
}
