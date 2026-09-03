import { Prisma } from "@prisma/client";
import {
  PROVIDER_SOURCE_SUPERVISOR_SNAPSHOT_VERSION,
  launchProviderKeySchema,
  providerSourceLaunchBounds,
  providerSourceSupervisorSnapshotSchema,
  type ProviderSourceSupervisorSnapshot,
} from "@packscout/contracts";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { providerSourceTransactionTime } from
  "./provider-source-database-clock.ts";
import { PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION } from
  "./provider-source-persistence-types.ts";
import type { ProviderSourceSupervisorEpochFence } from
  "./provider-source-supervisor-work-repository.ts";

export interface ProviderSourceSupervisorProcessCapacitySnapshot {
  readonly maximumExecutionSlots: number;
  readonly activeExecutionSlots: number;
  readonly requestPermitLanes: readonly (
    Readonly<{
      organizationId: string;
      connectionProfileId: string;
      approvedRequestCap: number;
      activeRequestPermits: number;
      queuedOperations: number;
    }> & (
      | Readonly<{ scope: "platform"; providerId: string }>
      | Readonly<{ scope: "connection_test"; providerId: null }>
    )
  )[];
}

export interface ProviderSourceCapacityState {
  readonly state: "available" | "blocked" | "probe_failed";
  readonly safeCode: string | null;
}

interface SourceLaneRow {
  readonly organizationId: string;
  readonly providerId: string;
  readonly provider: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly normalizedContractVersion: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly identityNamespaceKey: string;
  readonly cursorCodecVersion: string;
  readonly cursorGeneration: bigint;
  readonly lifecycle: "draft" | "paused" | "active" | "disabled" | "replaced";
  readonly phase: string;
  readonly activity: string;
  readonly waitReason: string | null;
  readonly actionRequiredCode: string | null;
  readonly currentRunId: string | null;
  readonly runLeaseAcquiredAt: Date | null;
  readonly retryAttempt: number;
  readonly retryNotBefore: Date | null;
  readonly pagesCommitted: number;
  readonly recordsCommitted: number;
  readonly lastProgressAt: Date | null;
  readonly cursorFingerprint: string | null;
  readonly continuationKind: "continue" | "poll_after" | null;
  readonly continuationMinimumDelaySeconds: number | null;
  readonly nextDueAt: Date | null;
  readonly blockingEpisodeId: string | null;
  readonly blockingHealthGeneration: bigint | null;
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

/** Durable read/write port for Task008. It intentionally reads one explicit
 * runtime snapshot rather than deriving activity from queue table guesses. */
export class ProviderSourceSupervisorSnapshotRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  async publish(input: ProviderSourceSupervisorEpochFence & Readonly<{
    capacity: ProviderSourceSupervisorProcessCapacitySnapshot;
    admission: ProviderSourceCapacityState;
  }>): Promise<void> {
    if (
      !Number.isSafeInteger(input.capacity.maximumExecutionSlots) ||
      input.capacity.maximumExecutionSlots < 1 ||
      input.capacity.maximumExecutionSlots > 64 ||
      !Number.isSafeInteger(input.capacity.activeExecutionSlots) ||
      input.capacity.activeExecutionSlots < 0 ||
      input.capacity.activeExecutionSlots >
        input.capacity.maximumExecutionSlots ||
      (input.admission.state === "available"
        ? input.admission.safeCode !== null
        : input.admission.safeCode === null ||
          !SAFE_CODE.test(input.admission.safeCode))
    ) {
      throw new TypeError("Supervisor capacity snapshot is invalid.");
    }
    await this.database.$transaction(async (transaction) => {
      const databaseNow = await providerSourceTransactionTime(transaction);
      const epoch = await transaction.source_supervisor_epochs.updateMany({
        where: {
          id: input.epochId,
          owner_key: input.ownerKey,
          lease_token: input.leaseToken,
          state: "active",
          lease_expires_at: { gt: databaseNow },
        },
        data: {
          maximum_execution_slots: input.capacity.maximumExecutionSlots,
          active_execution_slots: input.capacity.activeExecutionSlots,
          capacity_state: input.admission.state,
          capacity_safe_code: input.admission.safeCode,
          capacity_checked_at: databaseNow,
          snapshot_updated_at: databaseNow,
        },
      });
      if (epoch.count !== 1) {
        throw new PersistenceError(
          "SUPERVISOR_OWNERSHIP_LOST",
          "Supervisor snapshot epoch was lost.",
        );
      }
      // This table is only the current epoch's materialized capacity view.
      // Replacing it in the same transaction prevents a removed or disabled
      // platform from leaving a stale permit lane in the admin snapshot.
      await transaction.source_supervisor_request_lane_states.deleteMany({
        where: { supervisor_epoch_id: input.epochId },
      });
      for (const lane of input.capacity.requestPermitLanes) {
        if (
          (lane.scope === "platform"
            ? typeof lane.providerId !== "string" || !lane.providerId
            : lane.providerId !== null) ||
          !Number.isSafeInteger(lane.approvedRequestCap) ||
          lane.approvedRequestCap < 1 ||
          lane.approvedRequestCap >
            providerSourceLaunchBounds.stablePlatformRequestCap ||
          !Number.isSafeInteger(lane.activeRequestPermits) ||
          lane.activeRequestPermits < 0 ||
          lane.activeRequestPermits > lane.approvedRequestCap ||
          !Number.isSafeInteger(lane.queuedOperations) ||
          lane.queuedOperations < 0 ||
          lane.queuedOperations > 2_147_483_647
        ) {
          throw new TypeError("Supervisor request-permit lane is invalid.");
        }
        const laneKey = lane.scope === "platform"
          ? lane.providerId
          : "connection_test";
        await transaction.source_supervisor_request_lane_states.upsert({
          where: {
            supervisor_epoch_id_organization_id_connection_profile_id_lane_key: {
              supervisor_epoch_id: input.epochId,
              organization_id: lane.organizationId,
              connection_profile_id: lane.connectionProfileId,
              lane_key: laneKey,
            },
          },
          create: {
            supervisor_epoch_id: input.epochId,
            organization_id: lane.organizationId,
            connection_profile_id: lane.connectionProfileId,
            request_scope: lane.scope,
            provider_id: lane.providerId,
            lane_key: laneKey,
            approved_request_limit: lane.approvedRequestCap,
            active_request_permits: lane.activeRequestPermits,
            waiting_operations: lane.queuedOperations,
            updated_at: databaseNow,
          },
          update: {
            request_scope: lane.scope,
            provider_id: lane.providerId,
            approved_request_limit: lane.approvedRequestCap,
            active_request_permits: lane.activeRequestPermits,
            waiting_operations: lane.queuedOperations,
            updated_at: databaseNow,
          },
        });
      }
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async read(input: Readonly<{
    environmentKey: string;
    organizationId?: string;
  }>): Promise<ProviderSourceSupervisorSnapshot> {
    if (!input.environmentKey.trim()) {
      throw new TypeError("Supervisor environment key must not be blank.");
    }
    return this.database.$transaction(async (transaction) => {
      const databaseTime = await providerSourceTransactionTime(transaction);
      const epoch = await transaction.source_supervisor_epochs.findFirst({
        where: {
          environment_key: input.environmentKey,
          state: { in: ["active", "fenced_draining"] },
        },
        orderBy: { epoch_number: "desc" },
      });
      const live = epoch !== null && epoch.lease_expires_at > databaseTime;
      const requestPermitLanes = epoch
        ? await transaction.source_supervisor_request_lane_states.findMany({
            where: {
              supervisor_epoch_id: epoch.id,
              ...(input.organizationId
                ? { organization_id: input.organizationId }
                : {}),
            },
            orderBy: [
              { organization_id: "asc" },
              { connection_profile_id: "asc" },
              { lane_key: "asc" },
            ],
          })
        : [];
      const lanes = await transaction.$queryRaw<SourceLaneRow[]>(Prisma.sql`
        select runtime.organization_id as "organizationId",
               runtime.provider_id as "providerId",
               provider.platform_key as provider,
               runtime.source_instance_id as "sourceInstanceId",
               runtime.source_revision_id as "sourceRevisionId",
               runtime.connection_profile_id as "connectionProfileId",
               runtime.connection_revision_id as "connectionRevisionId",
               revision.source_type_key as "sourceTypeKey",
               revision.source_adapter_version as "sourceAdapterVersion",
               revision.normalized_contract_version as "normalizedContractVersion",
               revision.mapper_key as "mapperKey",
               revision.mapper_version as "mapperVersion",
               revision.identity_namespace_key as "identityNamespaceKey",
               cursor.cursor_codec_version as "cursorCodecVersion",
               cursor.cursor_generation as "cursorGeneration",
               source.state::text as lifecycle,
               runtime.phase,
               runtime.activity,
               runtime.wait_reason as "waitReason",
               runtime.action_required_code as "actionRequiredCode",
               runtime.current_run_id as "currentRunId",
               runtime.run_lease_acquired_at as "runLeaseAcquiredAt",
               runtime.retry_attempt as "retryAttempt",
               runtime.retry_not_before as "retryNotBefore",
               runtime.pages_committed as "pagesCommitted",
               runtime.records_committed as "recordsCommitted",
               runtime.last_progress_at as "lastProgressAt",
               runtime.cursor_fingerprint as "cursorFingerprint",
               runtime.continuation_kind::text as "continuationKind",
               runtime.continuation_minimum_delay_seconds
                 as "continuationMinimumDelaySeconds",
               runtime.next_due_at as "nextDueAt",
               runtime.blocking_episode_id as "blockingEpisodeId",
               runtime.blocking_health_generation
                 as "blockingHealthGeneration"
        from public.provider_source_runtime_states as runtime
        join public.provider_source_instances as source
          on source.id = runtime.source_instance_id
         and source.organization_id = runtime.organization_id
         and source.provider_id = runtime.provider_id
        join public.provider_source_revisions as revision
          on revision.id = runtime.source_revision_id
         and revision.organization_id = runtime.organization_id
         and revision.provider_id = runtime.provider_id
         and revision.source_instance_id = runtime.source_instance_id
        join public.provider_sources as provider
          on provider.id = runtime.provider_id
         and provider.organization_id = runtime.organization_id
        join public.provider_source_cursors as cursor
          on cursor.source_instance_id = runtime.source_instance_id
         and cursor.organization_id = runtime.organization_id
         and cursor.provider_id = runtime.provider_id
         and cursor.source_revision_id = runtime.source_revision_id
        where (${input.organizationId ?? null}::uuid is null
          or runtime.organization_id = cast(${input.organizationId ?? null} as uuid))
        order by runtime.organization_id, provider.platform_key,
                 runtime.source_instance_id
      `);

      const snapshot = {
        version: PROVIDER_SOURCE_SUPERVISOR_SNAPSHOT_VERSION,
        presence: {
          state: !live
            ? "offline"
            : epoch!.state === "fenced_draining"
              ? "fenced_draining"
              : "active",
          environmentKey: input.environmentKey,
          databaseTime: databaseTime.toISOString(),
          epochId: epoch?.id ?? null,
          epochNumber: epoch?.epoch_number.toString() ?? null,
          ownerKey: epoch?.owner_key ?? null,
          lastRenewedAt: iso(epoch?.last_renewed_at ?? null),
          leaseExpiresAt: iso(epoch?.lease_expires_at ?? null),
          safeTakeoverAt: iso(epoch?.takeover_not_before ?? null),
          safeReasonCode: epoch?.safe_reason_code ?? null,
        },
        capacity: {
          state: epoch?.capacity_state ?? "available",
          safeCode: epoch?.capacity_safe_code ?? null,
          checkedAt: iso(epoch?.capacity_checked_at ?? null),
          executionSlots: {
            used: live ? epoch!.active_execution_slots : 0,
            maximum: epoch?.maximum_execution_slots
              ?? providerSourceLaunchBounds.genericExecutionSlots,
          },
          requestPermitLanes: requestPermitLanes.map((lane) => ({
            scope: lane.request_scope,
            organizationId: lane.organization_id,
            connectionProfileId: lane.connection_profile_id,
            providerId: lane.provider_id,
            used: live ? lane.active_request_permits : 0,
            maximum: lane.approved_request_limit,
            waiting: live ? lane.waiting_operations : 0,
          })),
        },
        sources: lanes.map((lane) => {
          const provider = launchProviderKeySchema.parse(lane.provider);
          return {
            organizationId: lane.organizationId,
            providerId: lane.providerId,
            provider,
            sourceInstanceId: lane.sourceInstanceId,
            sourceRevisionId: lane.sourceRevisionId,
            connectionProfileId: lane.connectionProfileId,
            connectionRevisionId: lane.connectionRevisionId,
            sourceTypeKey: lane.sourceTypeKey,
            sourceAdapterVersion: lane.sourceAdapterVersion,
            normalizedContractVersion: lane.normalizedContractVersion,
            mapperKey: lane.mapperKey,
            mapperVersion: lane.mapperVersion,
            identityNamespaceKey: lane.identityNamespaceKey,
            cursorCodecVersion: lane.cursorCodecVersion,
            cursorGeneration: lane.cursorGeneration.toString(),
            lifecycle: lane.lifecycle,
            phase: lane.phase,
            activity: lane.activity,
            waitReason: lane.waitReason,
            actionRequiredCode: lane.actionRequiredCode,
            currentRunId: lane.currentRunId,
            runLeaseAgeMilliseconds: lane.runLeaseAcquiredAt === null
              ? null
              : Math.max(
                  0,
                  databaseTime.getTime() - lane.runLeaseAcquiredAt.getTime(),
                ),
            retry: {
              attempt: lane.retryAttempt,
              notBefore: iso(lane.retryNotBefore),
            },
            progress: {
              pagesCommitted: lane.pagesCommitted,
              recordsCommitted: lane.recordsCommitted,
              lastProgressAt: iso(lane.lastProgressAt),
            },
            cursorFingerprint: lane.cursorFingerprint,
            continuation: lane.continuationKind === null
              ? null
              : lane.continuationKind === "continue"
                ? { kind: "continue" as const }
                : {
                    kind: "poll_after" as const,
                    minimumDelaySeconds:
                      lane.continuationMinimumDelaySeconds ?? 0,
                  },
            nextDueAt: iso(lane.nextDueAt),
            connectionEpisode: lane.blockingEpisodeId === null
              ? null
              : {
                  episodeId: lane.blockingEpisodeId,
                  healthGeneration:
                    (lane.blockingHealthGeneration ?? 0n).toString(),
                },
          };
        }),
      };
      return providerSourceSupervisorSnapshotSchema.parse(snapshot);
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

}
