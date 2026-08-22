import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  sourceAdapterFailureSchema,
  type SourceAdapterFailure,
} from "@packscout/contracts";
import type {
  PackscoutPrismaClient,
  PackscoutTransactionClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { providerSourceTransactionTime } from "./provider-source-database-clock.ts";
import { ProviderSourceDiagnosticRepository } from
  "./provider-source-diagnostic-repository.ts";
import { appendTerminalRequestStartDiagnostic } from
  "./provider-source-request-diagnostic.ts";
import { persistKnownRequestTerminalization } from "./provider-source-request-terminal-proof.ts";
import { isExactProviderSourceRequestBeginReplay } from
  "./provider-source-request-replay.ts";
import {
  PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION,
  PROVIDER_SOURCE_REQUEST_ATTEMPT_RETENTION_DAYS,
  type RequestAttemptTerminalState,
  type SourceRequestOperation,
} from "./provider-source-persistence-types.ts";

const SHA_256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_CLASS_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/u;
const SAFE_CODE_PATTERN = /^(?:[A-Z][A-Z0-9_]{0,127}|[a-z][a-z0-9_-]{0,127})$/u;
const DIRECT_REQUEST_TERMINAL_STATES = new Set<string>(["captured", "failed"]);
type ConnectionBlockingFailureCode = Extract<
  SourceAdapterFailure,
  { disposition: "connection_action_required" }
>["code"];

function requireSafeClass(value: string, label: string): string {
  if (!SAFE_CLASS_PATTERN.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function requireSafeCode(value: string, label: string): string {
  if (!SAFE_CODE_PATTERN.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function requestedCheckpointKey(fingerprint: string | null): string {
  return fingerprint ?? "initial";
}

export class ProviderSourceRequestRepository {
  readonly #diagnostics: ProviderSourceDiagnosticRepository;

  constructor(private readonly database: PackscoutPrismaClient) {
    this.#diagnostics = new ProviderSourceDiagnosticRepository(database);
  }

  async begin(input: Readonly<{
    id?: string;
    organizationId: string;
    requestLeaseId: string;
    claimOwner: string;
    claimToken: string;
    supervisorEpochId: string;
    supervisorOwnerKey: string;
    supervisorLeaseToken: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    expectedHealthGeneration: bigint;
    operation: SourceRequestOperation;
    startedAt: Date;
  }>): Promise<string> {
    const requestAttemptId = input.id ?? randomUUID();
    return this.database.$transaction(async (transaction) => {
      // Serialize the exact logical begin command before eligibility reads.
      // This prevents an outer timeout retry from overlapping an uncommitted
      // first transaction and creating two attempts/calls for one lease.
      await transaction.$queryRaw(Prisma.sql`
        select pg_advisory_xact_lock(
          hashtextextended(${requestAttemptId}, 719_007)
        )::text as locked
      `);
      const epochs = await transaction.$queryRaw<Array<{
        id: string;
        environmentKey: string;
        epochNumber: bigint;
      }>>(Prisma.sql`
        select id,
               environment_key as "environmentKey",
               epoch_number as "epochNumber"
        from public.source_supervisor_epochs
        where id = cast(${input.supervisorEpochId} as uuid)
          and owner_key = ${input.supervisorOwnerKey}
          and lease_token = cast(${input.supervisorLeaseToken} as uuid)
          and state = 'active'
          and lease_expires_at > clock_timestamp()
        for share
      `);
      const epoch = epochs[0];
      if (!epoch) {
        throw new PersistenceError("SUPERVISOR_OWNERSHIP_LOST", "Request epoch is not active.");
      }
      const existing = await transaction.source_request_attempts.findUnique({
        where: { id: requestAttemptId },
      });
      if (existing) {
        if (!isExactProviderSourceRequestBeginReplay(existing, input)) {
          throw new PersistenceError(
            "IDEMPOTENCY_CONFLICT",
            "Request begin command conflicts with its durable attempt.",
          );
        }
      }
      const databaseNow = await providerSourceTransactionTime(transaction);
      const predecessors = await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        select count(*)::bigint as count
        from public.source_request_attempts as attempt
        join public.source_supervisor_epochs as predecessor
          on predecessor.id = attempt.supervisor_epoch_id
        where attempt.state = 'in_flight'
          and predecessor.environment_key = ${epoch.environmentKey}
          and predecessor.epoch_number < ${epoch.epochNumber}
          and (
            (predecessor.state = 'released' and predecessor.released_at <= ${databaseNow})
            or (
              predecessor.state = 'expired'
              and predecessor.takeover_not_before <= ${databaseNow}
            )
          )
      `);
      if ((predecessors[0]?.count ?? 0n) !== 0n) {
        throw new PersistenceError(
          "SUPERVISOR_OWNERSHIP_LOST",
          "Predecessor request attempts must be reconciled before new calls begin.",
        );
      }
      const lockedProfiles = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.source_connection_profiles
        where id = cast(${input.connectionProfileId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);
      if (!lockedProfiles[0]) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Connection profile is outside tenant scope.",
        );
      }
      const revision = await transaction.source_connection_revisions.findFirst({
        where: {
          id: input.connectionRevisionId,
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          health_generation: input.expectedHealthGeneration,
          revoked_at: null,
        },
      });
      if (!revision) {
        throw new PersistenceError("HEALTH_GENERATION_STALE", "Connection revision fence changed.");
      }
      if (
        (input.operation.kind === "source_test" &&
          revision.state !== "active" &&
          !(existing && revision.state === "retired"))
        || (input.operation.kind === "page_read"
          && !["active", "retired"].includes(revision.state))
      ) {
        throw new PersistenceError("SOURCE_FENCED", "Connection revision is not eligible.");
      }
      const profile = await transaction.source_connection_profiles.findFirst({
        where: {
          id: input.connectionProfileId,
          organization_id: input.organizationId,
          source_type_key: revision.source_type_key,
          state: input.operation.kind === "connection_test"
            ? { in: ["draft", "active", "disabled"] }
            : ["page_read", "source_test"].includes(input.operation.kind) &&
                revision.state === "retired"
              ? { in: ["active", "disabled"] }
              : "active",
          ...(input.operation.kind === "source_test" && revision.state !== "retired"
            ? { active_revision_id: input.connectionRevisionId }
            : {}),
        },
        select: { id: true, state: true, active_revision_id: true },
      });
      if (!profile) {
        throw new PersistenceError("SOURCE_FENCED", "Connection profile revision is not eligible.");
      }
      const openEpisode = await transaction.source_connection_health_episodes.findFirst({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          closed_at: null,
        },
        select: { id: true, connection_revision_id: true },
      });
      if ((openEpisode?.id ?? null) !== (input.operation.kind === "connection_test"
        ? input.operation.blockingEpisodeId ?? null
        : null)) {
        throw new PersistenceError("CONNECTION_BLOCKED", "Connection profile requires recovery.");
      }

      if (input.operation.kind === "connection_test") {
        const recoveryTargetIsEligible = openEpisode
          ? revision.state === "candidate" ||
            (revision.id === openEpisode.connection_revision_id &&
              revision.state === "active")
          : revision.state === "candidate" || revision.state === "active" ||
            (existing !== null && revision.state === "retired");
        if (!recoveryTargetIsEligible) {
          throw new PersistenceError(
            "SOURCE_FENCED",
            "Connection-test revision is not an active or candidate recovery target.",
          );
        }
        const job = await transaction.source_connection_test_jobs.findFirst({
          where: {
            id: input.operation.connectionTestJobId,
            organization_id: input.organizationId,
            connection_profile_id: input.connectionProfileId,
            connection_revision_id: input.connectionRevisionId,
            expected_health_generation: input.expectedHealthGeneration,
            blocking_episode_id: input.operation.blockingEpisodeId ?? null,
            supervisor_epoch_id: input.supervisorEpochId,
            claim_owner: input.claimOwner,
            claim_token: input.claimToken,
            claim_expires_at: { gt: databaseNow },
            state: "running",
          },
          select: { id: true, recovery_blocked_revision_id: true },
        });
        if (!job) throw new PersistenceError("SOURCE_FENCED", "Connection-test claim was lost.");
        if (
          openEpisode &&
          job.recovery_blocked_revision_id !== openEpisode.connection_revision_id
        ) {
          throw new PersistenceError(
            "SOURCE_FENCED",
            "Connection-test recovery revision fence changed.",
          );
        }
        if (profile.state === "disabled") {
          const preservedRetiredAttempt = existing !== null &&
            revision.state === "retired" &&
            job.recovery_blocked_revision_id === null &&
            openEpisode === null &&
            profile.active_revision_id === null;
          const blocked = job.recovery_blocked_revision_id
            ? await transaction.source_connection_revisions.findFirst({
                where: {
                  id: job.recovery_blocked_revision_id,
                  organization_id: input.organizationId,
                  connection_profile_id: input.connectionProfileId,
                  state: openEpisode ? { in: ["active", "revoked"] } : "revoked",
                },
                select: { id: true },
              })
            : null;
          if (
            !preservedRetiredAttempt &&
            (!blocked || profile.active_revision_id !== null)
          ) {
            throw new PersistenceError("SOURCE_FENCED", "Disabled profile test lacks a recovery fence.");
          }
        }
      } else {
        const [source, sourceRevision] = await Promise.all([
          transaction.provider_source_instances.findFirst({
          where: {
            id: input.operation.sourceInstanceId,
            organization_id: input.organizationId,
            provider_id: input.operation.providerId,
            active_revision_id: input.operation.sourceRevisionId,
            connection_profile_id: input.connectionProfileId,
            state: input.operation.kind === "page_read"
              ? "active"
              : { in: ["draft", "paused", "active", "disabled"] },
            ...(input.operation.kind === "page_read"
              ? { pause_requested_at: null }
              : {}),
          },
          select: { id: true },
          }),
          transaction.provider_source_revisions.findFirst({
            where: {
              id: input.operation.sourceRevisionId,
              organization_id: input.organizationId,
              provider_id: input.operation.providerId,
              source_instance_id: input.operation.sourceInstanceId,
              connection_profile_id: input.connectionProfileId,
              source_type_key: revision.source_type_key,
              source_adapter_version: revision.source_adapter_version,
            },
          }),
        ]);
        if (!source || !sourceRevision) {
          throw new PersistenceError("SOURCE_FENCED", "Source revision is not eligible.");
        }
        if (input.operation.kind === "source_test") {
          const job = await transaction.provider_source_test_jobs.findFirst({
            where: {
              id: input.operation.sourceTestJobId,
              organization_id: input.organizationId,
              source_instance_id: input.operation.sourceInstanceId,
                source_revision_id: input.operation.sourceRevisionId,
                connection_revision_id: input.connectionRevisionId,
              expected_health_generation: input.expectedHealthGeneration,
              supervisor_epoch_id: input.supervisorEpochId,
              claim_owner: input.claimOwner,
              claim_token: input.claimToken,
              claim_expires_at: { gt: databaseNow },
              state: "running",
            },
            select: { id: true },
          });
          if (!job) throw new PersistenceError("SOURCE_FENCED", "Source-test claim was lost.");
        } else {
          const [run, checkpoint] = await Promise.all([
            transaction.import_runs.findFirst({
              where: {
                id: input.operation.runId,
                organization_id: input.organizationId,
                provider_id: input.operation.providerId,
                source_instance_id: input.operation.sourceInstanceId,
                source_revision_id: input.operation.sourceRevisionId,
                source_type_key: sourceRevision.source_type_key,
                source_adapter_version: sourceRevision.source_adapter_version,
                normalized_contract_version: sourceRevision.normalized_contract_version,
                mapper_key: sourceRevision.mapper_key,
                mapper_version: sourceRevision.mapper_version,
                identity_namespace_key: sourceRevision.identity_namespace_key,
                connection_profile_id: input.connectionProfileId,
                connection_revision_id: input.connectionRevisionId,
                checkpoint_codec_version: sourceRevision.checkpoint_codec_version,
                checkpoint_generation: input.operation.checkpointGeneration,
                current_checkpoint_fingerprint:
                  input.operation.requestedCheckpointFingerprint,
                current_checkpoint_key: requestedCheckpointKey(
                  input.operation.requestedCheckpointFingerprint,
                ),
                next_page_number: input.operation.pageNumber,
                lease_owner: input.claimOwner,
                lease_token: input.claimToken,
                lease_expires_at: { gt: databaseNow },
                state: "running",
              },
              select: { id: true },
            }),
            transaction.provider_source_checkpoints.findFirst({
              where: {
                source_instance_id: input.operation.sourceInstanceId,
                organization_id: input.organizationId,
                source_revision_id: input.operation.sourceRevisionId,
                checkpoint_generation: input.operation.checkpointGeneration,
                checkpoint_fingerprint: input.operation.requestedCheckpointFingerprint,
              },
              select: { source_instance_id: true },
            }),
          ]);
          if (!run || !checkpoint) {
            throw new PersistenceError("SOURCE_FENCED", "Run or checkpoint claim was lost.");
          }
        }
      }

      // An exact replay is still subject to every current eligibility fence
      // above. In particular, an episode, pause, revision rotation, or lost
      // work claim that landed after the original commit must prevent the
      // caller from treating a lost acknowledgement as permission to call.
      if (existing) return existing.id;

      const operation = input.operation;
      const attempt = await transaction.source_request_attempts.create({
        data: {
          id: requestAttemptId,
          organization_id: input.organizationId,
          operation_kind: operation.kind,
          request_lease_id: input.requestLeaseId,
          claim_owner: input.claimOwner,
          claim_token: input.claimToken,
          supervisor_epoch_id: input.supervisorEpochId,
          connection_profile_id: input.connectionProfileId,
          connection_revision_id: input.connectionRevisionId,
          expected_health_generation: input.expectedHealthGeneration,
          provider_id: operation.kind === "connection_test" ? null : operation.providerId,
          source_instance_id: operation.kind === "connection_test" ? null : operation.sourceInstanceId,
          source_revision_id: operation.kind === "connection_test" ? null : operation.sourceRevisionId,
          connection_test_job_id: operation.kind === "connection_test"
            ? operation.connectionTestJobId
            : null,
          source_test_job_id: operation.kind === "source_test" ? operation.sourceTestJobId : null,
          run_id: operation.kind === "page_read" ? operation.runId : null,
          page_number: operation.kind === "page_read" ? operation.pageNumber : null,
          checkpoint_generation: operation.kind === "page_read"
            ? operation.checkpointGeneration
            : null,
          requested_checkpoint_fingerprint: operation.kind === "page_read"
            ? operation.requestedCheckpointFingerprint
            : null,
          requested_checkpoint_key: operation.kind === "page_read"
            ? requestedCheckpointKey(operation.requestedCheckpointFingerprint)
            : null,
          blocking_episode_id: operation.kind === "connection_test"
            ? operation.blockingEpisodeId ?? null
            : null,
          blocking_episode_connection_revision_id: operation.kind === "connection_test"
            ? openEpisode?.connection_revision_id ?? null
            : null,
          started_at: databaseNow,
        },
        select: { id: true },
      });
      return attempt.id;
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async terminalize(input: Readonly<{
    organizationId: string;
    requestAttemptId: string;
    supervisorEpochId: string;
    supervisorOwnerKey: string;
    supervisorLeaseToken: string;
    state: Exclude<RequestAttemptTerminalState, "connection_outcome_uncertain">;
    outcomeClass: string;
    safeCode?: string | null;
    safeOutcomeHash: string;
    responseStatus?: number | null;
    responseBytes?: number | null;
    durationMs?: number | null;
    terminalAt: Date;
    blockingFailure?: Readonly<{
      failureClass: ConnectionBlockingFailureCode;
      safeCode: ConnectionBlockingFailureCode;
    }> | null;
  }>): Promise<{
    blockingEpisodeId: string | null;
    blockingEpisodeOpened: boolean;
    resultingHealthGeneration: bigint;
  }> {
    if (!DIRECT_REQUEST_TERMINAL_STATES.has(input.state)) {
      throw new TypeError(
        "Uncertain request outcomes must be terminalized by predecessor reconciliation.",
      );
    }
    if (!SHA_256_PATTERN.test(input.safeOutcomeHash)) {
      throw new TypeError("Request outcome hash must be a lowercase SHA-256 digest.");
    }
    if (input.blockingFailure && input.state !== "failed") {
      throw new TypeError("A blocking connection outcome must terminalize as failed.");
    }
    requireSafeClass(input.outcomeClass, "Request outcome class");
    if (input.safeCode) requireSafeCode(input.safeCode, "Request safe code");
    if (input.blockingFailure) {
      const parsed = sourceAdapterFailureSchema.safeParse({
        disposition: "connection_action_required",
        code: input.blockingFailure.failureClass,
      });
      if (!parsed.success || input.blockingFailure.safeCode !== parsed.data.code) {
        throw new TypeError(
          "Blocking failure must be an exact connection-action-required adapter code.",
        );
      }
    }
    return this.database.$transaction(async (transaction) => {
      const epochs = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.source_supervisor_epochs
        where id = cast(${input.supervisorEpochId} as uuid)
          and owner_key = ${input.supervisorOwnerKey}
          and lease_token = cast(${input.supervisorLeaseToken} as uuid)
          and state = 'active'
          and lease_expires_at > clock_timestamp()
        for share
      `);
      if (!epochs[0]) {
        throw new PersistenceError("SUPERVISOR_OWNERSHIP_LOST", "Request epoch is no longer active.");
      }
      const rows = await transaction.$queryRaw<Array<{
        id: string;
        state: string;
        operationKind: "connection_test" | "source_test" | "page_read";
        connectionProfileId: string;
        connectionRevisionId: string;
        expectedHealthGeneration: bigint;
        providerId: string | null;
        sourceInstanceId: string | null;
        sourceRevisionId: string | null;
        connectionTestJobId: string | null;
        sourceTestJobId: string | null;
        runId: string | null;
        pageNumber: number | null;
        checkpointGeneration: bigint | null;
        requestedCheckpointFingerprint: string | null;
        blockingEpisodeId: string | null;
        blockingEpisodeConnectionRevisionId: string | null;
        requestLeaseId: string;
        claimOwner: string;
        claimToken: string;
        startedAt: Date;
        outcomeClass: string | null;
        safeCode: string | null;
        safeOutcomeHash: string | null;
        responseStatus: number | null;
        responseBytes: number | null;
        durationMs: number | null;
      }>>(Prisma.sql`
        select id, state::text, operation_kind::text as "operationKind",
               connection_profile_id as "connectionProfileId",
               connection_revision_id as "connectionRevisionId",
               expected_health_generation as "expectedHealthGeneration",
               provider_id as "providerId",
               source_instance_id as "sourceInstanceId",
               source_revision_id as "sourceRevisionId",
               connection_test_job_id as "connectionTestJobId",
               source_test_job_id as "sourceTestJobId",
               run_id as "runId",
               page_number as "pageNumber",
               checkpoint_generation as "checkpointGeneration",
               requested_checkpoint_fingerprint as "requestedCheckpointFingerprint",
               blocking_episode_id as "blockingEpisodeId",
               blocking_episode_connection_revision_id as "blockingEpisodeConnectionRevisionId",
               request_lease_id as "requestLeaseId",
               claim_owner as "claimOwner",
               claim_token as "claimToken",
               started_at as "startedAt",
               outcome_class as "outcomeClass",
               safe_code as "safeCode",
               safe_outcome_hash as "safeOutcomeHash",
               response_status as "responseStatus",
               response_bytes as "responseBytes",
               duration_ms as "durationMs"
        from public.source_request_attempts
        where id = cast(${input.requestAttemptId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and supervisor_epoch_id = cast(${input.supervisorEpochId} as uuid)
        for update
      `);
      const attempt = rows[0];
      if (!attempt) {
        throw new PersistenceError("TENANT_SCOPE_VIOLATION", "Request attempt is outside tenant scope.");
      }
      if (attempt.state !== "in_flight") {
        const compact = await transaction.compact_source_request_attempts
          .findUnique({
            where: { request_attempt_id: attempt.id },
          });
        const durableBlockingCode = attempt.safeCode
          ? sourceAdapterFailureSchema.safeParse({
              disposition: "connection_action_required",
              code: attempt.safeCode,
            })
          : null;
        const durableBlocking = compact !== null &&
          compact.blocking_episode_id !== null &&
          durableBlockingCode?.success === true &&
          (
            compact.outcome_class === "connection_action_required" ||
            compact.outcome_class === durableBlockingCode.data.code
          );
        const exactReplay = compact !== null &&
          durableBlocking === Boolean(input.blockingFailure) &&
          attempt.state === input.state &&
          attempt.outcomeClass === input.outcomeClass &&
          attempt.safeCode === (input.safeCode ?? null) &&
          attempt.safeOutcomeHash === input.safeOutcomeHash &&
          attempt.responseStatus === (input.responseStatus ?? null) &&
          attempt.responseBytes === (input.responseBytes ?? null) &&
          attempt.durationMs === (input.durationMs ?? null) &&
          compact.terminal_state === input.state &&
          compact.outcome_class === input.outcomeClass &&
          compact.safe_outcome_hash === input.safeOutcomeHash &&
          compact.response_bytes === (input.responseBytes ?? null) &&
          compact.duration_ms === (input.durationMs ?? null) &&
          compact.supervisor_epoch_id === input.supervisorEpochId &&
          compact.organization_id === input.organizationId;
        if (!exactReplay) {
          throw new PersistenceError(
            "IDEMPOTENCY_CONFLICT",
            "Request terminalization conflicts with its permanent proof.",
          );
        }
        const episode = compact.blocking_episode_id
          ? await transaction.source_connection_health_episodes.findUnique({
              where: { id: compact.blocking_episode_id },
              select: {
                id: true,
                connection_revision_id: true,
                opened_by_request_attempt_id: true,
                opened_health_generation: true,
              },
            })
          : null;
        return {
          blockingEpisodeId: compact.blocking_episode_id,
          blockingEpisodeOpened:
            durableBlocking &&
            episode?.opened_by_request_attempt_id === attempt.id,
          resultingHealthGeneration:
            durableBlocking && episode?.connection_revision_id === compact.connection_revision_id
              ? episode.opened_health_generation
              : compact.expected_health_generation,
        };
      }
      const databaseNow = await providerSourceTransactionTime(transaction);
      if (!input.blockingFailure) {
        await persistKnownRequestTerminalization(transaction, {
          organizationId: input.organizationId,
          supervisorEpochId: input.supervisorEpochId,
          attempt,
          state: input.state,
          outcomeClass: input.outcomeClass,
          safeCode: input.safeCode ?? null,
          safeOutcomeHash: input.safeOutcomeHash,
          responseStatus: input.responseStatus ?? null,
          responseBytes: input.responseBytes ?? null,
          durationMs: input.durationMs ?? null,
          databaseNow,
          diagnostics: this.#diagnostics,
        });
        return {
          blockingEpisodeId: attempt.blockingEpisodeId,
          blockingEpisodeOpened: false,
          resultingHealthGeneration: attempt.expectedHealthGeneration,
        };
      }
      if (input.blockingFailure) {
        const lockedProfiles = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          select id
          from public.source_connection_profiles
          where id = cast(${attempt.connectionProfileId} as uuid)
            and organization_id = cast(${input.organizationId} as uuid)
          for update
        `);
        if (!lockedProfiles[0]) {
          throw new PersistenceError(
            "TENANT_SCOPE_VIOLATION",
            "Connection profile is outside tenant scope.",
          );
        }
      }
      const connectionRevision = await transaction.source_connection_revisions.findFirst({
        where: {
          id: attempt.connectionRevisionId,
          organization_id: input.organizationId,
          connection_profile_id: attempt.connectionProfileId,
          revoked_at: null,
        },
      });
      if (!connectionRevision) {
        throw new PersistenceError("HEALTH_GENERATION_STALE", "Connection revision fence changed.");
      }
      if (
        (attempt.operationKind === "source_test" &&
          !["active", "retired"].includes(connectionRevision.state))
        || (attempt.operationKind === "page_read"
          && !["active", "retired"].includes(connectionRevision.state))
      ) {
        throw new PersistenceError("SOURCE_FENCED", "Connection revision is not eligible.");
      }
      const terminalOpenEpisode = await transaction.source_connection_health_episodes.findFirst({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: attempt.connectionProfileId,
          closed_at: null,
        },
        select: {
          id: true,
          connection_revision_id: true,
          opened_health_generation: true,
        },
      });
      const generationAdvancedByCurrentEpisode = Boolean(
        !attempt.blockingEpisodeId
        && terminalOpenEpisode?.connection_revision_id === attempt.connectionRevisionId
        && terminalOpenEpisode.opened_health_generation === attempt.expectedHealthGeneration + 1n
        && connectionRevision.health_generation === terminalOpenEpisode.opened_health_generation,
      );
      if (
        connectionRevision.health_generation !== attempt.expectedHealthGeneration
        && !generationAdvancedByCurrentEpisode
      ) {
        throw new PersistenceError("HEALTH_GENERATION_STALE", "Connection health changed.");
      }
      if (
        attempt.blockingEpisodeId
        && terminalOpenEpisode?.id !== attempt.blockingEpisodeId
      ) {
        throw new PersistenceError("CONNECTION_BLOCKED", "Recovery episode is no longer current.");
      }
      const profile = await transaction.source_connection_profiles.findFirst({
        where: {
          id: attempt.connectionProfileId,
          organization_id: input.organizationId,
          source_type_key: connectionRevision.source_type_key,
          state: attempt.operationKind === "connection_test"
            ? { in: ["draft", "active", "disabled"] }
            : ["page_read", "source_test"].includes(attempt.operationKind) &&
                connectionRevision.state === "retired"
              ? { in: ["active", "disabled"] }
              : "active",
          ...(attempt.operationKind === "source_test" && connectionRevision.state !== "retired"
            ? { active_revision_id: attempt.connectionRevisionId }
            : {}),
        },
        select: { id: true, state: true, active_revision_id: true },
      });
      if (!profile) {
        throw new PersistenceError("SOURCE_FENCED", "Connection profile revision is not eligible.");
      }

      let testActorKey: string | null = null;
      if (attempt.operationKind === "connection_test") {
        const claimed = await transaction.source_connection_test_jobs.findFirst({
          where: {
            id: attempt.connectionTestJobId ?? undefined,
            organization_id: input.organizationId,
            connection_profile_id: attempt.connectionProfileId,
            connection_revision_id: attempt.connectionRevisionId,
            blocking_episode_id: attempt.blockingEpisodeId,
            expected_health_generation: attempt.expectedHealthGeneration,
            claim_owner: attempt.claimOwner,
            claim_token: attempt.claimToken,
            claim_expires_at: { gt: databaseNow },
            supervisor_epoch_id: input.supervisorEpochId,
            state: "running",
          },
          select: {
            id: true,
            requested_by_actor_key: true,
            recovery_blocked_revision_id: true,
          },
        });
        if (!claimed) throw new PersistenceError("SOURCE_FENCED", "Connection-test claim was lost.");
        if (profile.state === "disabled") {
          const preservedRetiredAttempt =
            connectionRevision.state === "retired" &&
            claimed.recovery_blocked_revision_id === null &&
            terminalOpenEpisode === null &&
            profile.active_revision_id === null;
          const blocked = claimed.recovery_blocked_revision_id
            ? await transaction.source_connection_revisions.findFirst({
                where: {
                  id: claimed.recovery_blocked_revision_id,
                  organization_id: input.organizationId,
                  connection_profile_id: attempt.connectionProfileId,
                  state: terminalOpenEpisode ? { in: ["active", "revoked"] } : "revoked",
                },
                select: { id: true },
              })
            : null;
          if (
            !preservedRetiredAttempt &&
            (!blocked || profile.active_revision_id !== null)
          ) {
            throw new PersistenceError("SOURCE_FENCED", "Disabled profile test lacks a recovery fence.");
          }
        }
        testActorKey = claimed.requested_by_actor_key;
      } else if (attempt.operationKind === "source_test") {
        const [claimed, source] = await Promise.all([
          transaction.provider_source_test_jobs.findFirst({
            where: {
              id: attempt.sourceTestJobId ?? undefined,
              organization_id: input.organizationId,
              source_instance_id: attempt.sourceInstanceId ?? undefined,
              source_revision_id: attempt.sourceRevisionId ?? undefined,
              connection_profile_id: attempt.connectionProfileId,
              connection_revision_id: attempt.connectionRevisionId,
              expected_health_generation: attempt.expectedHealthGeneration,
              claim_owner: attempt.claimOwner,
              claim_token: attempt.claimToken,
              claim_expires_at: { gt: databaseNow },
              supervisor_epoch_id: input.supervisorEpochId,
              state: "running",
            },
            select: { id: true, requested_by_actor_key: true },
          }),
          transaction.provider_source_instances.findFirst({
            where: {
              id: attempt.sourceInstanceId ?? undefined,
              organization_id: input.organizationId,
              provider_id: attempt.providerId ?? undefined,
              active_revision_id: attempt.sourceRevisionId ?? undefined,
              state: { in: ["draft", "paused", "active", "disabled"] },
            },
            select: { id: true },
          }),
        ]);
        if (!claimed || !source) throw new PersistenceError("SOURCE_FENCED", "Source-test fence changed.");
        testActorKey = claimed.requested_by_actor_key;
      } else {
        if (!attempt.sourceRevisionId || !attempt.sourceInstanceId || !attempt.providerId) {
          throw new PersistenceError("SOURCE_FENCED", "Page-read source pins are incomplete.");
        }
        const sourceRevision = await transaction.provider_source_revisions.findFirst({
          where: {
            id: attempt.sourceRevisionId,
            organization_id: input.organizationId,
            provider_id: attempt.providerId,
            source_instance_id: attempt.sourceInstanceId,
            connection_profile_id: attempt.connectionProfileId,
            source_type_key: connectionRevision.source_type_key,
            source_adapter_version: connectionRevision.source_adapter_version,
          },
        });
        if (!sourceRevision) {
          throw new PersistenceError("SOURCE_FENCED", "Page-read source revision changed.");
        }
        const [run, source, checkpoint] = await Promise.all([
          transaction.import_runs.findFirst({
            where: {
              id: attempt.runId ?? undefined,
              organization_id: input.organizationId,
              source_instance_id: attempt.sourceInstanceId ?? undefined,
              source_revision_id: attempt.sourceRevisionId ?? undefined,
              source_type_key: sourceRevision.source_type_key,
              source_adapter_version: sourceRevision.source_adapter_version,
              normalized_contract_version: sourceRevision.normalized_contract_version,
              mapper_key: sourceRevision.mapper_key,
              mapper_version: sourceRevision.mapper_version,
              identity_namespace_key: sourceRevision.identity_namespace_key,
              connection_profile_id: attempt.connectionProfileId,
              connection_revision_id: attempt.connectionRevisionId,
              checkpoint_codec_version: sourceRevision.checkpoint_codec_version,
              checkpoint_generation: attempt.checkpointGeneration ?? undefined,
              requested_checkpoint_fingerprint: attempt.requestedCheckpointFingerprint,
              requested_checkpoint_key: requestedCheckpointKey(
                attempt.requestedCheckpointFingerprint,
              ),
              lease_owner: attempt.claimOwner,
              lease_token: attempt.claimToken,
              lease_expires_at: { gt: databaseNow },
              state: "running",
            },
            select: { id: true },
          }),
          transaction.provider_source_instances.findFirst({
            where: {
              id: attempt.sourceInstanceId ?? undefined,
              organization_id: input.organizationId,
              provider_id: attempt.providerId ?? undefined,
              active_revision_id: attempt.sourceRevisionId ?? undefined,
              state: "active",
            },
            select: { id: true },
          }),
          transaction.provider_source_checkpoints.findFirst({
            where: {
              source_instance_id: attempt.sourceInstanceId ?? undefined,
              organization_id: input.organizationId,
              source_revision_id: attempt.sourceRevisionId ?? undefined,
              checkpoint_generation: attempt.checkpointGeneration ?? undefined,
              checkpoint_fingerprint: attempt.requestedCheckpointFingerprint,
            },
            select: { source_instance_id: true },
          }),
        ]);
        if (!run || !source || !checkpoint) {
          throw new PersistenceError("SOURCE_FENCED", "Page-read run, source, or checkpoint fence changed.");
        }
      }

      let blockingEpisodeId: string | null = attempt.blockingEpisodeId;
      let resultingHealthGeneration = attempt.expectedHealthGeneration;
      let blockingEpisodeHealthGeneration = attempt.expectedHealthGeneration;
      let createBlockingEpisode = false;
      if (input.blockingFailure) {
        if (terminalOpenEpisode) {
          // The episode is profile-owned. A concurrently admitted request on
          // another retained revision may detect the same shared outage after
          // the active revision already opened it. Coalesce that exact attempt
          // into the winner without advancing its retired revision or fencing
          // the healthy supervisor process.
          blockingEpisodeId = terminalOpenEpisode.id;
          blockingEpisodeHealthGeneration = terminalOpenEpisode.opened_health_generation;
          if (terminalOpenEpisode.connection_revision_id === attempt.connectionRevisionId) {
            resultingHealthGeneration = terminalOpenEpisode.opened_health_generation;
          }
        } else {
          if (attempt.blockingEpisodeId) {
            throw new PersistenceError("CONNECTION_BLOCKED", "Recovery episode already closed.");
          }
          const advanced = await transaction.source_connection_revisions.updateMany({
            where: {
              id: attempt.connectionRevisionId,
              organization_id: input.organizationId,
              connection_profile_id: attempt.connectionProfileId,
              health_generation: attempt.expectedHealthGeneration,
              revoked_at: null,
            },
            data: { health_generation: { increment: 1n } },
          });
          if (advanced.count !== 1) {
            throw new PersistenceError("HEALTH_GENERATION_STALE", "Connection health changed.");
          }
          resultingHealthGeneration = attempt.expectedHealthGeneration + 1n;
          blockingEpisodeHealthGeneration = resultingHealthGeneration;
          createBlockingEpisode = true;
        }
      }

      if (createBlockingEpisode && input.blockingFailure) {
        const episode = await transaction.source_connection_health_episodes.create({
          data: {
            organization_id: input.organizationId,
            connection_profile_id: attempt.connectionProfileId,
            connection_revision_id: attempt.connectionRevisionId,
            opened_health_generation: resultingHealthGeneration,
            failure_class: input.blockingFailure.failureClass,
            safe_code: input.blockingFailure.safeCode,
            opened_by_request_attempt_id: null,
            opened_at: databaseNow,
          },
          select: { id: true },
        });
        blockingEpisodeId = episode.id;
      }

      if (input.blockingFailure && blockingEpisodeId) {
        // The detecting transaction closes every not-yet-started bound work
        // item before its request permit may wake another waiter. Running
        // sibling attempts remain claim-pinned so the process can abort and
        // terminalize them through their own exact detecting-lease CAS.
        await Promise.all([
          this.#blockQueuedProfileWork(transaction, {
            organizationId: input.organizationId,
            connectionProfileId: attempt.connectionProfileId,
            supervisorEpochId: input.supervisorEpochId,
            blockingEpisodeId,
            blockingEpisodeConnectionRevisionId:
              terminalOpenEpisode?.connection_revision_id
                ?? attempt.connectionRevisionId,
            blockingHealthGeneration: blockingEpisodeHealthGeneration,
          }, databaseNow),
          attempt.runId
            ? transaction.import_runs.updateMany({
                where: {
                  id: attempt.runId,
                  organization_id: input.organizationId,
                  state: "running",
                  lease_owner: attempt.claimOwner,
                  lease_token: attempt.claimToken,
                },
                data: {
                  state: "incomplete",
                  failure_code: "CONNECTION_BLOCKED",
                  failure_summary: "Connection recovery is required.",
                  finished_at: databaseNow,
                  lease_owner: null,
                  lease_token: null,
                  claim_lease_id: null,
                  lease_expires_at: null,
                  heartbeat_at: null,
                },
              })
            : Promise.resolve({ count: 0 }),
        ]);
      }

      await transaction.compact_source_request_attempts.create({
        data: {
          request_attempt_id: attempt.id,
          organization_id: input.organizationId,
          operation_kind: attempt.operationKind,
          terminal_state: input.state,
          outcome_class: input.outcomeClass,
          safe_outcome_hash: input.safeOutcomeHash,
          request_lease_id: attempt.requestLeaseId,
          claim_owner: attempt.claimOwner,
          claim_token: attempt.claimToken,
          supervisor_epoch_id: input.supervisorEpochId,
          connection_profile_id: attempt.connectionProfileId,
          connection_revision_id: attempt.connectionRevisionId,
          expected_health_generation: attempt.expectedHealthGeneration,
          provider_id: attempt.providerId,
          source_instance_id: attempt.sourceInstanceId,
          source_revision_id: attempt.sourceRevisionId,
          connection_test_job_id: attempt.connectionTestJobId,
          source_test_job_id: attempt.sourceTestJobId,
          run_id: attempt.runId,
          page_number: attempt.pageNumber,
          checkpoint_generation: attempt.checkpointGeneration,
          requested_checkpoint_fingerprint: attempt.requestedCheckpointFingerprint,
          requested_checkpoint_key: attempt.operationKind === "page_read"
            ? requestedCheckpointKey(attempt.requestedCheckpointFingerprint)
            : null,
          response_bytes: input.responseBytes,
          duration_ms: input.durationMs,
          blocking_episode_id: blockingEpisodeId,
          blocking_episode_connection_revision_id:
            createBlockingEpisode
              ? attempt.connectionRevisionId
              : terminalOpenEpisode?.connection_revision_id
                ?? attempt.blockingEpisodeConnectionRevisionId,
          started_at: attempt.startedAt,
          terminal_at: databaseNow,
          compacted_at: null,
        },
      });
      await appendTerminalRequestStartDiagnostic(
        transaction,
        this.#diagnostics,
        { organizationId: input.organizationId, attempt },
      );
      if (createBlockingEpisode && input.blockingFailure) {
        await transaction.source_connection_health_episodes.update({
          where: { id: blockingEpisodeId! },
          data: { opened_by_request_attempt_id: attempt.id },
        });
        await this.#diagnostics.appendInTransaction(transaction, {
          id: blockingEpisodeId!,
          organizationId: input.organizationId,
          scope: "connection",
          correlationKind: "connection_episode",
          eventKind: "connection_episode",
          severity: "critical",
          phase: "episode_opened",
          safeCode: input.blockingFailure.safeCode,
          occurredAt: databaseNow,
          durationMs: input.durationMs ?? null,
          responseBytes: input.responseBytes ?? null,
          sourceTypeKey: connectionRevision.source_type_key,
          sourceAdapterVersion: connectionRevision.source_adapter_version,
          connectionProfileId: attempt.connectionProfileId,
          connectionRevisionId: attempt.connectionRevisionId,
          blockingEpisodeId: blockingEpisodeId!,
          requestAttemptId: attempt.id,
        });
      }

      if (input.blockingFailure && attempt.operationKind === "connection_test") {
        if (!attempt.connectionTestJobId || !testActorKey) {
          throw new PersistenceError("SOURCE_FENCED", "Blocking connection test lost its claim proof.");
        }
        await transaction.source_connection_test_results.create({
          data: {
            organization_id: input.organizationId,
            job_id: attempt.connectionTestJobId,
            connection_profile_id: attempt.connectionProfileId,
            connection_revision_id: attempt.connectionRevisionId,
            request_attempt_id: attempt.id,
            request_terminal_state: input.state,
            supervisor_epoch_id: input.supervisorEpochId,
            pre_test_health_generation: attempt.expectedHealthGeneration,
            resulting_health_generation: resultingHealthGeneration,
            outcome: "failure",
            safe_code: input.blockingFailure.safeCode,
            response_status: input.responseStatus,
            latency_ms: input.durationMs,
            tested_by_actor_key: testActorKey,
            tested_at: databaseNow,
          },
        });
        await transaction.source_connection_test_jobs.update({
          where: { id: attempt.connectionTestJobId },
          data: { state: "failed", finished_at: databaseNow },
        });
      } else if (input.blockingFailure && attempt.operationKind === "source_test") {
        if (
          !attempt.sourceTestJobId
          || !attempt.providerId
          || !attempt.sourceInstanceId
          || !attempt.sourceRevisionId
          || !testActorKey
        ) {
          throw new PersistenceError("SOURCE_FENCED", "Blocking source test lost its claim proof.");
        }
        await transaction.provider_source_test_results.create({
          data: {
            organization_id: input.organizationId,
            provider_id: attempt.providerId,
            job_id: attempt.sourceTestJobId,
            source_instance_id: attempt.sourceInstanceId,
            source_revision_id: attempt.sourceRevisionId,
            connection_profile_id: attempt.connectionProfileId,
            connection_revision_id: attempt.connectionRevisionId,
            request_attempt_id: attempt.id,
            request_terminal_state: input.state,
            supervisor_epoch_id: input.supervisorEpochId,
            pre_test_health_generation: attempt.expectedHealthGeneration,
            resulting_health_generation: resultingHealthGeneration,
            outcome: "failure",
            safe_code: input.blockingFailure.safeCode,
            tested_by_actor_key: testActorKey,
            tested_at: databaseNow,
          },
        });
        await transaction.provider_source_test_jobs.update({
          where: { id: attempt.sourceTestJobId },
          data: { state: "failed", finished_at: databaseNow },
        });
      }

      await transaction.source_request_attempts.update({
        where: { id: attempt.id },
        data: {
          state: input.state,
          blocking_episode_id: blockingEpisodeId,
          blocking_episode_connection_revision_id:
            terminalOpenEpisode?.connection_revision_id
            ?? (blockingEpisodeId ? attempt.connectionRevisionId : null),
          outcome_class: input.outcomeClass,
          safe_code: input.safeCode,
          safe_outcome_hash: input.safeOutcomeHash,
          response_status: input.responseStatus,
          response_bytes: input.responseBytes,
          duration_ms: input.durationMs,
          terminal_at: databaseNow,
          expires_at: addDays(databaseNow, PROVIDER_SOURCE_REQUEST_ATTEMPT_RETENTION_DAYS),
        },
      });
      return {
        blockingEpisodeId,
        blockingEpisodeOpened: createBlockingEpisode,
        resultingHealthGeneration,
      };
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  /**
   * Reconciles one predecessor attempt after takeover. Callers must drain this
   * method to completion before the replacement supervisor grants any request.
   */
  async reconcilePredecessorAttempt(input: Readonly<{
    organizationId: string;
    requestAttemptId: string;
    currentSupervisorEpochId: string;
    currentSupervisorOwnerKey: string;
    currentSupervisorLeaseToken: string;
    safeOutcomeHash: string;
    reconciledAt: Date;
  }>): Promise<{ blockingEpisodeId: string }> {
    if (!SHA_256_PATTERN.test(input.safeOutcomeHash)) {
      throw new TypeError("Uncertain outcome hash must be a keyed lowercase digest.");
    }
    return this.database.$transaction(async (transaction) => {
      const currentEpochs = await transaction.$queryRaw<Array<{
        id: string;
        environmentKey: string;
        epochNumber: bigint;
      }>>(Prisma.sql`
        select id,
               environment_key as "environmentKey",
               epoch_number as "epochNumber"
        from public.source_supervisor_epochs
        where id = cast(${input.currentSupervisorEpochId} as uuid)
          and owner_key = ${input.currentSupervisorOwnerKey}
          and lease_token = cast(${input.currentSupervisorLeaseToken} as uuid)
          and state = 'active'
          and lease_expires_at > clock_timestamp()
        for share
      `);
      const currentEpoch = currentEpochs[0];
      if (!currentEpoch) {
        throw new PersistenceError("SUPERVISOR_OWNERSHIP_LOST", "Replacement epoch is not active.");
      }
      await transaction.$queryRaw(Prisma.sql`
        select id from public.source_request_attempts
        where id = cast(${input.requestAttemptId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for update
      `);
      const attempt = await transaction.source_request_attempts.findFirst({
        where: {
          id: input.requestAttemptId,
          organization_id: input.organizationId,
          state: "in_flight",
          supervisor_epoch_id: { not: input.currentSupervisorEpochId },
        },
      });
      if (!attempt) {
        throw new PersistenceError("REQUEST_ATTEMPT_TERMINAL", "Predecessor attempt is not reconcilable.");
      }
      const databaseNow = await providerSourceTransactionTime(transaction);
      const predecessorEpochs = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id
        from public.source_supervisor_epochs
        where id = cast(${attempt.supervisor_epoch_id} as uuid)
          and environment_key = ${currentEpoch.environmentKey}
          and epoch_number < ${currentEpoch.epochNumber}
          and released_at <= ${databaseNow}
          and (
            state = 'released'
            or (state = 'expired' and takeover_not_before <= ${databaseNow})
          )
        for key share
      `);
      const predecessorEpoch = predecessorEpochs[0];
      if (!predecessorEpoch) {
        throw new PersistenceError(
          "SUPERVISOR_OWNERSHIP_LOST",
          "Predecessor epoch has not reached a safe takeover boundary.",
        );
      }
      const lockedProfiles = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          select id
          from public.source_connection_profiles
          where id = cast(${attempt.connection_profile_id} as uuid)
            and organization_id = cast(${input.organizationId} as uuid)
          for update
        `,
      );
      if (!lockedProfiles[0]) {
        throw new PersistenceError(
          "TENANT_SCOPE_VIOLATION",
          "Predecessor connection profile is outside tenant scope.",
        );
      }
      let episode = await transaction.source_connection_health_episodes.findFirst({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: attempt.connection_profile_id,
          closed_at: null,
        },
      });
      let createdEpisode = false;
      let episodeRevisionId = episode?.connection_revision_id ?? attempt.connection_revision_id;
      let resultingHealthGeneration = episode?.opened_health_generation ?? 0n;
      if (!episode) {
        const revision = await transaction.source_connection_revisions.findFirst({
          where: {
            id: attempt.connection_revision_id,
            organization_id: input.organizationId,
            connection_profile_id: attempt.connection_profile_id,
          },
          select: { health_generation: true },
        });
        if (!revision) {
          throw new PersistenceError("HEALTH_GENERATION_STALE", "Uncertain connection revision is unavailable.");
        }
        resultingHealthGeneration = revision.health_generation + 1n;
        const advanced = await transaction.source_connection_revisions.updateMany({
          where: {
            id: attempt.connection_revision_id,
            organization_id: input.organizationId,
            connection_profile_id: attempt.connection_profile_id,
            health_generation: revision.health_generation,
          },
          data: { health_generation: resultingHealthGeneration },
        });
        if (advanced.count !== 1) {
          throw new PersistenceError("HEALTH_GENERATION_STALE", "Uncertain health transition lost its fence.");
        }
        episode = await transaction.source_connection_health_episodes.create({
          data: {
            organization_id: input.organizationId,
            connection_profile_id: attempt.connection_profile_id,
            connection_revision_id: attempt.connection_revision_id,
            opened_health_generation: resultingHealthGeneration,
            failure_class: "connection_outcome_uncertain",
            safe_code: "REQUEST_OUTCOME_UNCERTAIN",
            opened_by_request_attempt_id: null,
            opened_at: databaseNow,
          },
        });
        createdEpisode = true;
        episodeRevisionId = attempt.connection_revision_id;
        // The uncertain episode blocks the profile exactly like a detected
        // outage: still-queued bound work must wait out recovery as
        // incomplete/CONNECTION_BLOCKED instead of being claimed and
        // terminally fenced by the replacement supervisor.
        await this.#blockQueuedProfileWork(transaction, {
          organizationId: input.organizationId,
          connectionProfileId: attempt.connection_profile_id,
          supervisorEpochId: input.currentSupervisorEpochId,
          blockingEpisodeId: episode.id,
          blockingEpisodeConnectionRevisionId: episodeRevisionId,
          blockingHealthGeneration: resultingHealthGeneration,
        }, databaseNow);
      }
      await transaction.compact_source_request_attempts.create({
        data: {
          request_attempt_id: attempt.id,
          organization_id: input.organizationId,
          operation_kind: attempt.operation_kind,
          terminal_state: "connection_outcome_uncertain",
          outcome_class: "connection_outcome_uncertain",
          safe_outcome_hash: input.safeOutcomeHash,
          request_lease_id: attempt.request_lease_id,
          claim_owner: attempt.claim_owner,
          claim_token: attempt.claim_token,
          supervisor_epoch_id: attempt.supervisor_epoch_id,
          connection_profile_id: attempt.connection_profile_id,
          connection_revision_id: attempt.connection_revision_id,
          expected_health_generation: attempt.expected_health_generation,
          provider_id: attempt.provider_id,
          source_instance_id: attempt.source_instance_id,
          source_revision_id: attempt.source_revision_id,
          connection_test_job_id: attempt.connection_test_job_id,
          source_test_job_id: attempt.source_test_job_id,
          run_id: attempt.run_id,
          page_number: attempt.page_number,
          checkpoint_generation: attempt.checkpoint_generation,
          requested_checkpoint_fingerprint: attempt.requested_checkpoint_fingerprint,
          requested_checkpoint_key: attempt.operation_kind === "page_read"
            ? requestedCheckpointKey(attempt.requested_checkpoint_fingerprint)
            : null,
          blocking_episode_id: episode.id,
          blocking_episode_connection_revision_id: episodeRevisionId,
          started_at: attempt.started_at,
          terminal_at: databaseNow,
        },
      });
      await appendTerminalRequestStartDiagnostic(
        transaction,
        this.#diagnostics,
        {
          organizationId: input.organizationId,
          attempt: {
            id: attempt.id,
            operationKind: attempt.operation_kind,
            claimToken: attempt.claim_token,
            connectionProfileId: attempt.connection_profile_id,
            connectionRevisionId: attempt.connection_revision_id,
            providerId: attempt.provider_id,
            sourceInstanceId: attempt.source_instance_id,
            sourceRevisionId: attempt.source_revision_id,
            connectionTestJobId: attempt.connection_test_job_id,
            sourceTestJobId: attempt.source_test_job_id,
            runId: attempt.run_id,
            blockingEpisodeId: episode.id,
            startedAt: attempt.started_at,
          },
        },
      );
      if (createdEpisode) {
        await transaction.source_connection_health_episodes.update({
          where: { id: episode.id },
          data: { opened_by_request_attempt_id: attempt.id },
        });
        const revision = await transaction.source_connection_revisions
          .findUniqueOrThrow({
            where: { id: attempt.connection_revision_id },
            select: {
              source_type_key: true,
              source_adapter_version: true,
            },
          });
        await this.#diagnostics.appendInTransaction(transaction, {
          id: episode.id,
          organizationId: input.organizationId,
          scope: "connection",
          correlationKind: "connection_episode",
          eventKind: "connection_episode",
          severity: "critical",
          phase: "episode_opened",
          safeCode: "REQUEST_OUTCOME_UNCERTAIN",
          occurredAt: databaseNow,
          sourceTypeKey: revision.source_type_key,
          sourceAdapterVersion: revision.source_adapter_version,
          connectionProfileId: attempt.connection_profile_id,
          connectionRevisionId: attempt.connection_revision_id,
          blockingEpisodeId: episode.id,
          requestAttemptId: attempt.id,
        });
      }
      await transaction.source_request_attempts.update({
        where: { id: attempt.id },
        data: {
          state: "connection_outcome_uncertain",
          outcome_class: "connection_outcome_uncertain",
          safe_code: "REQUEST_OUTCOME_UNCERTAIN",
          safe_outcome_hash: input.safeOutcomeHash,
          blocking_episode_id: episode.id,
          blocking_episode_connection_revision_id: episodeRevisionId,
          terminal_at: databaseNow,
          expires_at: addDays(
            databaseNow,
            PROVIDER_SOURCE_REQUEST_ATTEMPT_RETENTION_DAYS,
          ),
        },
      });
      if (attempt.connection_test_job_id) {
        await transaction.source_connection_test_jobs.updateMany({
          where: { id: attempt.connection_test_job_id, state: "running" },
          data: { state: "fenced", finished_at: databaseNow },
        });
      }
      if (attempt.source_test_job_id) {
        await transaction.provider_source_test_jobs.updateMany({
          where: { id: attempt.source_test_job_id, state: "running" },
          data: { state: "fenced", finished_at: databaseNow },
        });
      }
      return { blockingEpisodeId: episode.id };
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  /**
   * Closes every not-yet-started work item bound to a newly blocked profile
   * so queued work waits out recovery as incomplete/CONNECTION_BLOCKED rather
   * than being claimed and terminally fenced later. Shared by the detecting
   * terminalization and takeover reconciliation.
   */
  async #blockQueuedProfileWork(
    transaction: PackscoutTransactionClient,
    input: Readonly<{
      organizationId: string;
      connectionProfileId: string;
      supervisorEpochId: string;
      blockingEpisodeId: string;
      blockingEpisodeConnectionRevisionId: string;
      blockingHealthGeneration: bigint;
    }>,
    databaseNow: Date,
  ): Promise<void> {
    await Promise.all([
      transaction.source_connection_test_jobs.updateMany({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          state: "queued",
          blocking_episode_id: null,
        },
        data: { state: "cancelled", finished_at: databaseNow },
      }),
      transaction.provider_source_test_jobs.updateMany({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          state: "queued",
        },
        data: { state: "cancelled", finished_at: databaseNow },
      }),
      transaction.import_runs.updateMany({
        where: {
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          state: "queued",
        },
        data: {
          state: "incomplete",
          failure_code: "CONNECTION_BLOCKED",
          failure_summary: "Connection recovery is required.",
          finished_at: databaseNow,
        },
      }),
      transaction.$executeRaw(Prisma.sql`
        update public.provider_source_runtime_states as runtime
        set supervisor_epoch_id = cast(${input.supervisorEpochId} as uuid),
            phase = 'waiting',
            activity = 'waiting',
            wait_reason = 'connection_blocked',
            action_required_code = null,
            current_run_id = null,
            connection_revision_id = cast(${input.blockingEpisodeConnectionRevisionId} as uuid),
            run_lease_acquired_at = null,
            run_lease_expires_at = null,
            blocking_episode_id = cast(${input.blockingEpisodeId} as uuid),
            blocking_health_generation = ${input.blockingHealthGeneration},
            updated_at = ${databaseNow}
        from public.provider_source_instances as source
        where source.id = runtime.source_instance_id
          and source.organization_id = runtime.organization_id
          and source.connection_profile_id = cast(${input.connectionProfileId} as uuid)
          and source.organization_id = cast(${input.organizationId} as uuid)
          and runtime.connection_profile_id = cast(${input.connectionProfileId} as uuid)
      `),
    ]);
  }
}
