import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { providerSourceTransactionTime } from "./provider-source-database-clock.ts";
import { ProviderSourceImportRunRepository } from "./provider-source-import-run-repository.ts";

interface EncryptedConfiguration {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyVersion: number;
}

function bytes(value: Uint8Array | null): Uint8Array<ArrayBuffer> | null {
  if (value === null) return null;
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

function recoveryRunId(
  fenceId: string,
  sourceInstanceId: string,
  connectionRevisionId: string,
): string {
  const value = createHash("sha256")
    .update("packscout.source-connection-recovery-run.v1")
    .update("\0")
    .update(fenceId)
    .update("\0")
    .update(sourceInstanceId)
    .update("\0")
    .update(connectionRevisionId)
    .digest()
    .subarray(0, 16);
  value[6] = (value[6]! & 0x0f) | 0x50;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class SourceConnectionRecoveryRepository {
  readonly #runs: ProviderSourceImportRunRepository;

  constructor(private readonly database: PackscoutPrismaClient) {
    this.#runs = new ProviderSourceImportRunRepository(database);
  }

  /**
   * A successful same-revision recovery test closes the episode and resumes
   * every eligible bound lane in the caller-owned result transaction.
   */
  async resumeSameRevisionRecoveryInTransaction(
    transaction: PackscoutTransactionClient,
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      connectionRevisionId: string;
      blockingEpisodeId: string;
      actorKey: string;
      supervisorEpochId: string;
      resumedAt: Date;
    }>,
  ): Promise<readonly string[]> {
    const episode = await transaction.source_connection_health_episodes.findFirst({
      where: {
        id: input.blockingEpisodeId,
        organization_id: input.organizationId,
        connection_profile_id: input.connectionProfileId,
        connection_revision_id: input.connectionRevisionId,
      },
      select: { opened_at: true },
    });
    if (!episode) {
      throw new PersistenceError(
        "CONNECTION_BLOCKED",
        "Same-revision recovery episode changed before lanes resumed.",
      );
    }
    return this.#queueRecoveryRuns(transaction, {
      organizationId: input.organizationId,
      connectionProfileId: input.connectionProfileId,
      connectionRevisionId: input.connectionRevisionId,
      fenceId: input.blockingEpisodeId,
      actorKey: input.actorKey,
      activatedAt: input.resumedAt,
      supervisorEpochId: input.supervisorEpochId,
      preserveBlockedRunPins: true,
      preserveBlockedRunFinishedAfter: episode.opened_at,
    });
  }

  async addRecoveryConnectionRevision(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    blockedRevisionId: string;
    latestRevisionId: string;
    blockingEpisodeId: string | null;
    revisionId: string;
    revisionNumber: number;
    sourceTypeKey: string;
    sourceAdapterVersion: string;
    encryptedConfiguration: EncryptedConfiguration;
    configurationFingerprint: string;
    actorKey: string;
    createdAt: Date;
  }>): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const profile = await this.#lockProfile(transaction, input);
      const latest = await transaction.source_connection_revisions.findFirst({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
        },
        orderBy: [{ revision_number: "desc" }, { id: "desc" }],
      });
      const blocked = await transaction.source_connection_revisions.findFirst({
        where: {
          id: input.blockedRevisionId,
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          source_type_key: input.sourceTypeKey,
          source_adapter_version: input.sourceAdapterVersion,
        },
      });
      await this.#requireRecoveryFence(transaction, {
        ...input,
        profile,
        testedRevisionId: null,
      });
      if (
        !latest || !blocked || latest.id !== input.latestRevisionId ||
        latest.revision_number + 1 !== input.revisionNumber
      ) this.#fenced("Recovery predecessor is no longer the latest revision.");
      await transaction.source_connection_revisions.create({
        data: {
          id: input.revisionId,
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          revision_number: input.revisionNumber,
          source_type_key: input.sourceTypeKey,
          source_adapter_version: input.sourceAdapterVersion,
          configuration_ciphertext: bytes(input.encryptedConfiguration.ciphertext)!,
          configuration_nonce: bytes(input.encryptedConfiguration.nonce)!,
          configuration_auth_tag: bytes(input.encryptedConfiguration.authTag)!,
          encryption_key_version: input.encryptedConfiguration.keyVersion,
          configuration_fingerprint: input.configurationFingerprint,
          created_by_actor_key: input.actorKey,
          created_at: input.createdAt,
        },
      });
      await this.#audit(transaction, {
        ...input,
        revisionId: input.revisionId,
        action: "source_connection.create_recovery_revision",
        occurredAt: input.createdAt,
        metadata: {
          blockedRevisionId: input.blockedRevisionId,
          blockingEpisodeId: input.blockingEpisodeId,
        },
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async requestConnectionRecoveryTest(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    expectedHealthGeneration: bigint;
    blockedRevisionId: string;
    blockingEpisodeId: string | null;
    requestedByActorKey: string;
    requestedAt: Date;
  }>): Promise<{ readonly jobId: string }> {
    return this.database.$transaction(async (transaction) => {
      const profile = await this.#lockProfile(transaction, input);
      const tested = await transaction.source_connection_revisions.findFirst({
        where: {
          id: input.connectionRevisionId,
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          health_generation: input.expectedHealthGeneration,
          revoked_at: null,
          state: { in: ["candidate", "active"] },
        },
      });
      if (!tested) this.#fenced("Recovery candidate changed before testing.");
      await this.#requireRecoveryFence(transaction, {
        ...input,
        profile,
        testedRevisionId: tested.id,
      });
      const latest = await transaction.source_connection_revisions.findFirst({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
        },
        orderBy: [{ revision_number: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      if (tested.id !== input.blockedRevisionId && latest?.id !== tested.id) {
        this.#fenced("Recovery candidate is not the latest revision.");
      }
      const existing = await transaction.source_connection_test_jobs.findFirst({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          connection_revision_id: input.connectionRevisionId,
          blocking_episode_id: input.blockingEpisodeId,
          recovery_blocked_revision_id: input.blockedRevisionId,
          expected_health_generation: input.expectedHealthGeneration,
          state: { in: ["queued", "running"] },
        },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      const jobId = existing?.id ?? randomUUID();
      if (!existing) {
        await transaction.source_connection_test_jobs.create({
          data: {
            id: jobId,
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
            connection_revision_id: input.connectionRevisionId,
            blocking_episode_id: input.blockingEpisodeId,
            recovery_blocked_revision_id: input.blockedRevisionId,
            expected_health_generation: input.expectedHealthGeneration,
            requested_by_actor_key: input.requestedByActorKey,
            created_at: input.requestedAt,
          },
        });
      }
      await this.#audit(transaction, {
        ...input,
        actorKey: input.requestedByActorKey,
        revisionId: input.connectionRevisionId,
        action: existing
          ? "source_connection.request_recovery_test_coalesced"
          : "source_connection.request_recovery_test",
        occurredAt: input.requestedAt,
        metadata: {
          jobId,
          blockedRevisionId: input.blockedRevisionId,
          blockingEpisodeId: input.blockingEpisodeId,
        },
      });
      return { jobId };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async activateTestedConnectionRecovery(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    expectedHealthGeneration: bigint;
    blockedRevisionId: string;
    blockingEpisodeId: string | null;
    actorKey: string;
    activatedAt: Date;
  }>): Promise<Readonly<{ runIds: readonly string[] }>> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        select provider.id
        from public.provider_sources provider
        join public.provider_source_instances source
          on source.provider_id = provider.id
         and source.organization_id = provider.organization_id
        where source.organization_id = cast(${input.organizationId} as uuid)
          and source.connection_profile_id = cast(${input.connectionProfileId} as uuid)
          and source.state = 'active'::public.provider_source_instance_state
          and source.pause_requested_at is null
          and provider.state = 'active'::public.provider_state
        order by provider.id, source.id
        for update of provider, source
      `);
      const profile = await this.#lockProfile(transaction, input);
      const [tested, blocked, latest] = await Promise.all([
        transaction.source_connection_revisions.findFirst({
          where: {
            id: input.connectionRevisionId,
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
            health_generation: input.expectedHealthGeneration,
            revoked_at: null,
            state: { in: ["candidate", "active"] },
          },
        }),
        transaction.source_connection_revisions.findFirst({
          where: {
            id: input.blockedRevisionId,
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
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
      ]);
      if (!tested || !blocked || latest?.id !== tested.id) {
        this.#fenced("Recovery activation revision pins changed.");
      }
      const latestJob = await transaction.source_connection_test_jobs.findFirst({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          connection_revision_id: tested.id,
        },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
      });
      if (
        !latestJob || latestJob.state !== "succeeded" ||
        latestJob.blocking_episode_id !== input.blockingEpisodeId ||
        latestJob.recovery_blocked_revision_id !== input.blockedRevisionId ||
        latestJob.expected_health_generation !== input.expectedHealthGeneration
      ) this.#untested();
      const result = await transaction.source_connection_test_results.findFirst({
        where: {
          job_id: latestJob.id,
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          connection_revision_id: tested.id,
          resulting_health_generation: input.expectedHealthGeneration,
          outcome: "success",
          request_terminal_state: "captured",
        },
      });
      if (!result) this.#untested();

      const episode = input.blockingEpisodeId
        ? await transaction.source_connection_health_episodes.findFirst({
            where: {
              id: input.blockingEpisodeId,
              organization_id: input.organizationId,
              connection_profile_id: input.connectionProfileId,
              connection_revision_id: input.blockedRevisionId,
            },
          })
        : null;
      if (input.blockingEpisodeId && !episode) {
        throw new PersistenceError("CONNECTION_BLOCKED", "Recovery episode changed.");
      }
      if (episode?.closed_at === null) {
        if (tested.id === blocked.id) this.#fenced("Same-revision recovery result did not close its episode.");
        const advanced = await transaction.source_connection_revisions.updateMany({
          where: {
            id: blocked.id,
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
            health_generation: episode.opened_health_generation,
          },
          data: { health_generation: { increment: 1n } },
        });
        if (advanced.count !== 1) {
          throw new PersistenceError("HEALTH_GENERATION_STALE", "Blocked revision health changed.");
        }
        await transaction.source_connection_health_episodes.update({
          where: { id: episode.id },
          data: {
            closed_health_generation: episode.opened_health_generation + 1n,
            closed_by_test_result_id: result.id,
            closed_at: input.activatedAt,
          },
        });
      } else if (episode && episode.closed_by_test_result_id !== result.id) {
        this.#fenced("Recovery result does not own the closed episode.");
      }
      if (!episode) {
        const recoveryAlreadyActive = profile.state === "active" &&
          profile.activeRevisionId === tested.id;
        if (
          (!recoveryAlreadyActive &&
            (profile.state !== "disabled" || profile.activeRevisionId !== null)) ||
          blocked.state !== "revoked"
        ) this.#fenced("Revocation recovery fence changed.");
      }

      const databaseNow = await providerSourceTransactionTime(transaction);
      if (blocked.id !== tested.id) {
        await Promise.all([
          transaction.source_connection_test_jobs.updateMany({
            where: {
              organization_id: input.organizationId,
              connection_profile_id: input.connectionProfileId,
              connection_revision_id: blocked.id,
              state: { in: ["queued", "running"] },
            },
            data: { state: "fenced", finished_at: databaseNow },
          }),
          transaction.provider_source_test_jobs.updateMany({
            where: {
              organization_id: input.organizationId,
              connection_profile_id: input.connectionProfileId,
              connection_revision_id: blocked.id,
              state: { in: ["queued", "running"] },
            },
            data: { state: "fenced", finished_at: databaseNow },
          }),
          transaction.import_runs.updateMany({
            where: {
              organization_id: input.organizationId,
              connection_profile_id: input.connectionProfileId,
              connection_revision_id: blocked.id,
              state: { in: ["queued", "running"] },
            },
            data: {
              state: "failed",
              failure_code: "CONNECTION_RECOVERY_FENCED",
              failure_summary: "Pinned connection revision was fenced by recovery.",
              finished_at: databaseNow,
              lease_owner: null,
              lease_token: null,
              lease_expires_at: null,
            },
          }),
        ]);
        if (blocked.state === "active") {
          await transaction.source_connection_revisions.update({
            where: { id: blocked.id },
            data: { state: "retired", retired_at: input.activatedAt },
          });
        }
      }
      const alreadyActive = tested.state === "active" &&
        profile.state === "active" && profile.activeRevisionId === tested.id;
      if (!alreadyActive) {
        if (
          profile.activeRevisionId &&
          profile.activeRevisionId !== tested.id &&
          profile.activeRevisionId !== blocked.id
        ) {
          await transaction.source_connection_revisions.updateMany({
            where: {
              id: profile.activeRevisionId,
              organization_id: input.organizationId,
              connection_profile_id: input.connectionProfileId,
              state: "active",
            },
            data: { state: "retired", retired_at: input.activatedAt },
          });
        }
        await transaction.source_connection_revisions.update({
          where: { id: tested.id },
          data: { state: "active", activated_at: input.activatedAt, retired_at: null },
        });
        await transaction.source_connection_profiles.update({
          where: { id: input.connectionProfileId },
          data: {
            state: "active",
            active_revision_id: tested.id,
            updated_at: input.activatedAt,
          },
        });
      }

      const runIds = await this.#queueRecoveryRuns(transaction, {
        ...input,
        fenceId: input.blockingEpisodeId ?? input.blockedRevisionId,
        connectionRevisionId: tested.id,
      });
      await this.#audit(transaction, {
        ...input,
        revisionId: tested.id,
        action: alreadyActive
          ? "source_connection.activate_recovery_coalesced"
          : "source_connection.activate_recovery",
        occurredAt: input.activatedAt,
        metadata: {
          blockedRevisionId: blocked.id,
          blockingEpisodeId: input.blockingEpisodeId,
          recoveryRunIds: runIds,
        },
      });
      return Object.freeze({ runIds: Object.freeze(runIds) });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async #queueRecoveryRuns(
    transaction: Prisma.TransactionClient,
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      connectionRevisionId: string;
      fenceId: string;
      actorKey: string;
      activatedAt: Date;
      supervisorEpochId?: string;
      preserveBlockedRunPins?: boolean;
      preserveBlockedRunFinishedAfter?: Date;
    }>,
  ): Promise<string[]> {
    const sources = await transaction.provider_source_instances.findMany({
      where: {
        organization_id: input.organizationId,
        connection_profile_id: input.connectionProfileId,
        state: "active",
        active_revision_id: { not: null },
        pause_requested_at: null,
      },
      orderBy: [{ provider_id: "asc" }, { id: "asc" }],
    });
    const runIds: string[] = [];
    for (const source of sources) {
      if (!source.active_revision_id) continue;
      const checkpoint = await transaction.provider_source_checkpoints.findFirst({
        where: {
          organization_id: input.organizationId,
          provider_id: source.provider_id,
          source_instance_id: source.id,
          source_revision_id: source.active_revision_id,
        },
      });
      if (!checkpoint) {
        this.#fenced("Recovery source checkpoint is unavailable.");
      }
      const preservedRun = input.preserveBlockedRunPins
        ? await transaction.import_runs.findFirst({
            where: {
              organization_id: input.organizationId,
              provider_id: source.provider_id,
              source_instance_id: source.id,
              source_revision_id: source.active_revision_id,
              connection_profile_id: input.connectionProfileId,
              state: "incomplete",
              failure_code: "CONNECTION_BLOCKED",
              connection_revision_id: { not: input.connectionRevisionId },
              finished_at: input.preserveBlockedRunFinishedAfter
                ? { gte: input.preserveBlockedRunFinishedAfter }
                : { not: null },
            },
            orderBy: [{ finished_at: "desc" }, { created_at: "desc" }, { id: "desc" }],
          })
        : null;
      if (preservedRun?.connection_revision_id) {
        const preservedConnection = await transaction.source_connection_revisions
          .findFirst({
            where: {
              id: preservedRun.connection_revision_id,
              organization_id: input.organizationId,
              connection_profile_id: input.connectionProfileId,
              state: { in: ["active", "retired"] },
              revoked_at: null,
            },
            select: { id: true },
          });
        if (preservedConnection) {
          const runId = recoveryRunId(
            input.fenceId,
            source.id,
            preservedConnection.id,
          );
          const prior = await transaction.import_runs.findUnique({
            where: { id: runId },
          });
          const recoveryRun = prior ?? await transaction.import_runs.create({
            data: {
              id: runId,
              organization_id: input.organizationId,
              provider_id: source.provider_id,
              config_revision_id: null,
              trigger: "recovery",
              state: "queued",
              requested_by_actor_key: input.actorKey,
              source_instance_id: source.id,
              source_revision_id: source.active_revision_id,
              source_type_key: preservedRun.source_type_key,
              source_adapter_version: preservedRun.source_adapter_version,
              normalized_contract_version:
                preservedRun.normalized_contract_version,
              mapper_key: preservedRun.mapper_key,
              mapper_version: preservedRun.mapper_version,
              identity_namespace_key: preservedRun.identity_namespace_key,
              connection_profile_id: input.connectionProfileId,
              connection_revision_id: preservedConnection.id,
              checkpoint_codec_version: checkpoint.checkpoint_codec_version,
              checkpoint_generation: checkpoint.checkpoint_generation,
              requested_checkpoint: bytes(checkpoint.checkpoint_bytes),
              requested_checkpoint_fingerprint:
                checkpoint.checkpoint_fingerprint,
              requested_checkpoint_key:
                checkpoint.checkpoint_fingerprint ?? "initial",
              current_checkpoint: bytes(checkpoint.checkpoint_bytes),
              current_checkpoint_fingerprint:
                checkpoint.checkpoint_fingerprint,
              current_checkpoint_key:
                checkpoint.checkpoint_fingerprint ?? "initial",
              next_page_number: 1,
              counters_json: {
                pages: 0,
                records: 0,
                catalog: 0,
                pulls: 0,
                trades: 0,
                inserted: 0,
                revised: 0,
                duplicate: 0,
                quarantined: 0,
                warnings: 0,
                unresolvedRelationships: 0,
                canonicalRevisions: 0,
                evRequests: 0,
              },
              created_at: input.activatedAt,
            },
          });
          this.#requireExactRecoveryRun(recoveryRun, {
            ...input,
            connectionRevisionId: preservedConnection.id,
            providerId: source.provider_id,
            sourceInstanceId: source.id,
            sourceRevisionId: source.active_revision_id,
            runId,
            checkpoint,
          });
          runIds.push(runId);
          await this.#setRecoveredLaneQueued(transaction, {
            ...input,
            connectionRevisionId: preservedConnection.id,
            sourceInstanceId: source.id,
            sourceRevisionId: source.active_revision_id,
            runId,
          });
          continue;
        }
      }
      const runId = recoveryRunId(
        input.fenceId,
        source.id,
        input.connectionRevisionId,
      );
      const prior = await transaction.import_runs.findUnique({ where: { id: runId } });
      if (prior) {
        this.#requireExactRecoveryRun(prior, {
          ...input,
          providerId: source.provider_id,
          sourceInstanceId: source.id,
          sourceRevisionId: source.active_revision_id,
          runId,
          checkpoint,
        });
        runIds.push(prior.id);
        await this.#setRecoveredLaneQueued(transaction, {
          ...input,
          sourceInstanceId: source.id,
          sourceRevisionId: source.active_revision_id,
          runId: prior.id,
        });
        continue;
      }
      const requested = await this.#runs.requestRunInTransaction(transaction, {
        organizationId: input.organizationId,
        providerId: source.provider_id,
        runId,
        trigger: "recovery",
        requestedByActorKey: input.actorKey,
        requestedAt: input.activatedAt,
        expectedSourceRevisionId: source.active_revision_id,
      });
      if (requested.kind !== "created") {
        this.#fenced(
          requested.kind === "active"
            ? "Existing source work must reach a terminal boundary before recovery activation."
            : "Recovery source stopped being eligible before run creation.",
        );
      }
      if (
        requested.run.id !== runId ||
        requested.run.trigger !== "recovery" ||
        requested.run.sourceInstanceId !== source.id ||
        requested.run.sourceRevisionId !== source.active_revision_id
      ) this.#fenced("Recovery run coalesced to different source pins.");
      const created = await transaction.import_runs.findUniqueOrThrow({
        where: { id: runId },
      });
      this.#requireExactRecoveryRun(created, {
        ...input,
        providerId: source.provider_id,
        sourceInstanceId: source.id,
        sourceRevisionId: source.active_revision_id,
        runId,
        checkpoint,
      });
      runIds.push(requested.run.id);
      await this.#setRecoveredLaneQueued(transaction, {
        ...input,
        sourceInstanceId: source.id,
        sourceRevisionId: source.active_revision_id,
        runId: requested.run.id,
      });
    }
    return runIds;
  }

  async #setRecoveredLaneQueued(
    transaction: Prisma.TransactionClient,
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      connectionRevisionId: string;
      sourceInstanceId: string;
      sourceRevisionId: string;
      runId: string;
      activatedAt: Date;
      supervisorEpochId?: string;
    }>,
  ): Promise<void> {
    await transaction.provider_source_runtime_states.updateMany({
      where: {
        source_instance_id: input.sourceInstanceId,
        organization_id: input.organizationId,
        source_revision_id: input.sourceRevisionId,
        connection_profile_id: input.connectionProfileId,
      },
      data: {
        source_revision_id: input.sourceRevisionId,
        connection_revision_id: input.connectionRevisionId,
        supervisor_epoch_id: input.supervisorEpochId ?? null,
        phase: "queued",
        activity: "queued",
        wait_reason: null,
        action_required_code: null,
        current_run_id: input.runId,
        run_lease_acquired_at: null,
        run_lease_expires_at: null,
        retry_attempt: 0,
        retry_not_before: null,
        blocking_episode_id: null,
        blocking_health_generation: null,
        queued_at: input.activatedAt,
        updated_at: input.activatedAt,
      },
    });
  }

  #requireExactRecoveryRun(
    run: Readonly<{
      id: string;
      organization_id: string;
      provider_id: string;
      source_instance_id: string | null;
      source_revision_id: string | null;
      trigger: "scheduled" | "manual" | "continuation" | "recovery";
      connection_profile_id: string | null;
      connection_revision_id: string | null;
      checkpoint_codec_version: string | null;
      checkpoint_generation: bigint | null;
      requested_checkpoint: Uint8Array | null;
      requested_checkpoint_fingerprint: string | null;
      requested_checkpoint_key: string | null;
    }>,
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      connectionRevisionId: string;
      providerId: string;
      sourceInstanceId: string;
      sourceRevisionId: string;
      runId: string;
      checkpoint: Readonly<{
        checkpoint_codec_version: string;
        checkpoint_generation: bigint;
        checkpoint_bytes: Uint8Array | null;
        checkpoint_fingerprint: string | null;
      }>;
    }>,
  ): void {
    const expectedCheckpoint = input.checkpoint.checkpoint_bytes;
    const checkpointBytesMatch = run.requested_checkpoint === null
      ? expectedCheckpoint === null
      : expectedCheckpoint !== null &&
        run.requested_checkpoint.byteLength === expectedCheckpoint.byteLength &&
        run.requested_checkpoint.every(
          (value, index) => value === expectedCheckpoint[index],
        );
    if (
      run.id !== input.runId ||
      run.organization_id !== input.organizationId ||
      run.provider_id !== input.providerId ||
      run.source_instance_id !== input.sourceInstanceId ||
      run.source_revision_id !== input.sourceRevisionId ||
      run.trigger !== "recovery" ||
      run.connection_profile_id !== input.connectionProfileId ||
      run.connection_revision_id !== input.connectionRevisionId ||
      run.checkpoint_generation === null ||
      run.requested_checkpoint_key !==
        (run.requested_checkpoint_fingerprint ?? "initial") ||
      run.checkpoint_codec_version !==
        input.checkpoint.checkpoint_codec_version ||
        run.checkpoint_generation !== input.checkpoint.checkpoint_generation ||
        run.requested_checkpoint_fingerprint !==
          input.checkpoint.checkpoint_fingerprint ||
      !checkpointBytesMatch
    ) this.#fenced("Recovery run pins do not match the tested revision and checkpoint.");
  }

  async #lockProfile(
    transaction: Prisma.TransactionClient,
    input: Readonly<{ organizationId: string; connectionProfileId: string }>,
  ) {
    const rows = await transaction.$queryRaw<Array<{
      id: string;
      state: "draft" | "active" | "disabled";
      activeRevisionId: string | null;
    }>>(Prisma.sql`
      select id, state, active_revision_id as "activeRevisionId"
      from public.source_connection_profiles
      where id = cast(${input.connectionProfileId} as uuid)
        and organization_id = cast(${input.organizationId} as uuid)
      for update
    `);
    if (!rows[0]) {
      throw new PersistenceError("TENANT_SCOPE_VIOLATION", "Connection profile is outside tenant scope.");
    }
    return rows[0];
  }

  async #requireRecoveryFence(
    transaction: Prisma.TransactionClient,
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      blockedRevisionId: string;
      blockingEpisodeId: string | null;
      profile: Readonly<{
        state: "draft" | "active" | "disabled";
        activeRevisionId: string | null;
      }>;
      testedRevisionId: string | null;
    }>,
  ): Promise<void> {
    if (input.blockingEpisodeId) {
      const episode = await transaction.source_connection_health_episodes.findFirst({
        where: {
          id: input.blockingEpisodeId,
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          connection_revision_id: input.blockedRevisionId,
          closed_at: null,
        },
      });
      if (!episode || !["active", "disabled"].includes(input.profile.state)) {
        throw new PersistenceError("CONNECTION_BLOCKED", "Recovery episode changed.");
      }
      return;
    }
    const blocked = await transaction.source_connection_revisions.findFirst({
      where: {
        id: input.blockedRevisionId,
        organization_id: input.organizationId,
        connection_profile_id: input.connectionProfileId,
        state: "revoked",
        revoked_at: { not: null },
      },
      select: { id: true },
    });
    if (
      !blocked || input.profile.state !== "disabled" ||
      input.profile.activeRevisionId !== null ||
      input.testedRevisionId === input.blockedRevisionId
    ) this.#fenced("Revocation recovery fence changed.");
  }

  async #audit(
    transaction: Prisma.TransactionClient,
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      actorKey: string;
      revisionId: string;
      action: string;
      occurredAt: Date;
      metadata: Prisma.InputJsonObject;
    }>,
  ): Promise<void> {
    await transaction.audit_events.create({
      data: {
        organization_id: input.organizationId,
        actor_key: input.actorKey,
        action: input.action,
        subject_type: "source_connection_profile",
        subject_id: input.connectionProfileId,
        outcome: "success",
        metadata_json: {
          connectionRevisionId: input.revisionId,
          ...input.metadata,
        },
        occurred_at: input.occurredAt,
      },
    });
  }

  #untested(): never {
    throw new PersistenceError("CONFIG_REVISION_UNTESTED", "Current recovery test is required.");
  }

  #fenced(message: string): never {
    throw new PersistenceError("SOURCE_FENCED", message);
  }
}
