import { launchProviderKeySchema } from "@packscout/contracts";
import { type PackscoutTransactionClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { type ProviderSourceSupervisorQueueCandidate } from
  "./provider-source-supervisor-work-claim-repository.ts";
import {
  providerSourceBoundedCounter as boundedCounter,
  providerSourceCheckpointValue as checkpointValue,
} from "./provider-source-supervisor-work-values.ts";
import type {
  ProviderSourceSupervisorClaimedWork,
  ProviderSourceSupervisorEpochFence,
} from "./provider-source-supervisor-work-types.ts";

export async function providerSourceScheduleIntervalSeconds(
  transaction: PackscoutTransactionClient,
  revisionId: string,
): Promise<number> {
  const revision = await transaction.provider_source_schedule_revisions.findUnique({
    where: { id: revisionId },
    select: { interval_seconds: true },
  });
  return revision?.interval_seconds ?? 60;
}

export async function loadClaimedProviderSourceSupervisorWork(
  transaction: PackscoutTransactionClient,
  candidate: ProviderSourceSupervisorQueueCandidate,
  input: ProviderSourceSupervisorEpochFence & Readonly<{
    claimOwner: string;
    claimToken: string;
    claimLeaseId: string;
  }>,
  databaseNow: Date,
  expiresAt: Date,
  replayCommitted = false,
): Promise<ProviderSourceSupervisorClaimedWork> {
  const connectionJob = candidate.kind === "connection_test"
    ? await transaction.source_connection_test_jobs.findUnique({
        where: { id: candidate.id },
      })
    : null;
  const sourceJob = candidate.kind === "source_test"
    ? await transaction.provider_source_test_jobs.findUnique({
        where: { id: candidate.id },
      })
    : null;
  const run = candidate.kind === "page_read"
    ? await transaction.import_runs.findUnique({ where: { id: candidate.id } })
    : null;
  const organizationId = connectionJob?.organization_id
    ?? sourceJob?.organization_id
    ?? run?.organization_id;
  const connectionProfileId = connectionJob?.connection_profile_id
    ?? sourceJob?.connection_profile_id
    ?? run?.connection_profile_id;
  const connectionRevisionId = connectionJob?.connection_revision_id
    ?? sourceJob?.connection_revision_id
    ?? run?.connection_revision_id;
  if (!organizationId || !connectionProfileId || !connectionRevisionId) {
    throw new PersistenceError("SOURCE_FENCED", "Claimed work lost its pins.");
  }
  const [profile, connectionRevision] = await Promise.all([
    transaction.source_connection_profiles.findFirst({
      where: {
        id: connectionProfileId,
        organization_id: organizationId,
      },
    }),
    transaction.source_connection_revisions.findFirst({
      where: {
        id: connectionRevisionId,
        organization_id: organizationId,
        connection_profile_id: connectionProfileId,
      },
    }),
  ]);
  if (
    !profile ||
    !connectionRevision ||
    connectionRevision.source_type_key !== profile.source_type_key
  ) {
    throw new PersistenceError("SOURCE_FENCED", "Connection pins changed.");
  }
  const common = {
    id: candidate.id,
    queuedAt: candidate.queuedAt,
    organizationId,
    sourceTypeKey: connectionRevision.source_type_key,
    sourceAdapterVersion: connectionRevision.source_adapter_version,
    connectionProfileId,
    connectionRevisionId,
    connectionHealthGeneration: connectionRevision.health_generation,
    profileRequestLimit: profile.request_limit,
    connectionConfiguration: {
      ciphertext: new Uint8Array(connectionRevision.configuration_ciphertext),
      nonce: new Uint8Array(connectionRevision.configuration_nonce),
      authTag: new Uint8Array(connectionRevision.configuration_auth_tag),
      keyVersion: connectionRevision.encryption_key_version,
    },
    claimOwner: input.claimOwner,
    claimToken: input.claimToken,
    claimLeaseId: input.claimLeaseId,
    claimExpiresAt: expiresAt,
  } as const;
  if (candidate.kind === "connection_test" && connectionJob) {
    const [openEpisodes, latestCandidate] = await Promise.all([
      transaction.source_connection_health_episodes.findMany({
        where: {
          organization_id: organizationId,
          connection_profile_id: connectionProfileId,
          closed_at: null,
        },
        orderBy: [{ opened_at: "asc" }, { id: "asc" }],
        take: 2,
      }),
      transaction.source_connection_revisions.findFirst({
        where: {
          organization_id: organizationId,
          connection_profile_id: connectionProfileId,
          state: "candidate",
          revoked_at: null,
        },
        orderBy: [{ revision_number: "desc" }, { id: "desc" }],
        select: { id: true },
      }),
    ]);
    const recoveryEpisode = connectionJob.blocking_episode_id === null
      ? null
      : openEpisodes.find(
        (episode) => episode.id === connectionJob.blocking_episode_id,
      ) ?? null;
    const normalEligible = connectionJob.blocking_episode_id === null &&
      openEpisodes.length === 0 &&
      profile.state === "active" &&
      connectionRevision.revoked_at === null &&
      connectionRevision.id ===
        (latestCandidate?.id ?? profile.active_revision_id) &&
      (connectionRevision.state === "candidate" ||
        connectionRevision.state === "active");
    const recoveryEligible = recoveryEpisode !== null &&
      connectionJob.recovery_blocked_revision_id ===
        recoveryEpisode.connection_revision_id &&
      (profile.state === "active" || profile.state === "disabled") &&
      connectionRevision.revoked_at === null &&
      (connectionRevision.state === "candidate" ||
        (connectionRevision.id === recoveryEpisode.connection_revision_id &&
          connectionRevision.state === "active"));
    if (
      !replayCommitted && (
        (!normalEligible && !recoveryEligible) ||
        connectionJob.expected_health_generation !==
          connectionRevision.health_generation
      )
    ) {
      throw new PersistenceError(
        "SOURCE_FENCED",
        "Connection-test eligibility changed before execution.",
      );
    }
    return {
      ...common,
      kind: "connection_test",
      connectionHealthGeneration: connectionJob.expected_health_generation,
      recoveryEpisodeId: connectionJob.blocking_episode_id,
    };
  }
  const providerId = sourceJob?.provider_id ?? run?.provider_id;
  const sourceInstanceId = sourceJob?.source_instance_id ?? run?.source_instance_id;
  const sourceRevisionId = sourceJob?.source_revision_id ?? run?.source_revision_id;
  if (!providerId || !sourceInstanceId || !sourceRevisionId) {
    throw new PersistenceError("SOURCE_FENCED", "Source work pins are incomplete.");
  }
  const [provider, source, sourceRevision, schedule, runtime, openEpisode] =
    await Promise.all([
    transaction.provider_sources.findFirst({
      where: { id: providerId, organization_id: organizationId },
    }),
    transaction.provider_source_instances.findFirst({
      where: {
        id: sourceInstanceId,
        organization_id: organizationId,
        provider_id: providerId,
      },
    }),
    transaction.provider_source_revisions.findFirst({
      where: {
        id: sourceRevisionId,
        organization_id: organizationId,
        provider_id: providerId,
        source_instance_id: sourceInstanceId,
        connection_profile_id: connectionProfileId,
      },
    }),
    transaction.provider_source_schedules.findFirst({
      where: { source_instance_id: sourceInstanceId },
    }),
    transaction.provider_source_runtime_states.findFirst({
      where: { source_instance_id: sourceInstanceId },
      select: {
        retry_attempt: true,
        retry_not_before: true,
        activity: true,
      },
    }),
    transaction.source_connection_health_episodes.findFirst({
      where: {
        organization_id: organizationId,
        connection_profile_id: connectionProfileId,
        closed_at: null,
      },
    }),
  ]);
  const providerKey = launchProviderKeySchema.safeParse(provider?.platform_key);
  if (
    !provider ||
    !source ||
    !sourceRevision ||
    !providerKey.success ||
    (!replayCommitted && source.active_revision_id !== sourceRevisionId) ||
    (!replayCommitted && source.connection_profile_id !== connectionProfileId) ||
    sourceRevision.source_type_key !== connectionRevision.source_type_key ||
    sourceRevision.source_adapter_version !==
      connectionRevision.source_adapter_version
  ) {
    throw new PersistenceError("SOURCE_FENCED", "Source revision pins changed.");
  }
  const sourceCommon = {
    ...common,
    providerId,
    provider: providerKey.data,
    sourceInstanceId,
    sourceRevisionId,
    normalizedContractVersion: sourceRevision.normalized_contract_version,
    mapperKey: sourceRevision.mapper_key,
    mapperVersion: sourceRevision.mapper_version,
    identityNamespaceKey: sourceRevision.identity_namespace_key,
    checkpointCodecVersion: sourceRevision.checkpoint_codec_version,
    sourceConfiguration: sourceRevision.configuration_json,
    recordIdScopes: sourceRevision.record_id_scopes_json,
  } as const;
  if (candidate.kind === "source_test" && sourceJob) {
    if (
      !replayCommitted && (
        !["draft", "paused", "active", "disabled"].includes(source.state) ||
        profile.state !== "active" ||
        profile.active_revision_id !== connectionRevisionId ||
        connectionRevision.state !== "active" ||
        connectionRevision.revoked_at !== null ||
        sourceJob.expected_health_generation !==
          connectionRevision.health_generation ||
        openEpisode !== null
      )
    ) {
      throw new PersistenceError(
        "SOURCE_FENCED",
        "Source-test eligibility changed before execution.",
      );
    }
    return {
      ...sourceCommon,
      kind: "source_test",
      connectionHealthGeneration: sourceJob.expected_health_generation,
    };
  }
  if (!run || run.checkpoint_generation === null || run.next_page_number === null) {
    throw new PersistenceError("SOURCE_FENCED", "Page work pins are incomplete.");
  }
  const immutableRunPinsChanged =
    run.source_type_key !== sourceRevision.source_type_key ||
    run.source_adapter_version !== sourceRevision.source_adapter_version ||
    run.normalized_contract_version !==
      sourceRevision.normalized_contract_version ||
    run.mapper_key !== sourceRevision.mapper_key ||
    run.mapper_version !== sourceRevision.mapper_version ||
    run.identity_namespace_key !== sourceRevision.identity_namespace_key;
  const mutableEligibilityChanged = !replayCommitted && (
    provider.state !== "active" ||
    source.state !== "active" ||
    source.pause_requested_at !== null ||
    (profile.state !== "active" &&
      !(profile.state === "disabled" &&
        connectionRevision.state === "retired")) ||
    (connectionRevision.state !== "active" &&
      connectionRevision.state !== "retired") ||
    connectionRevision.revoked_at !== null ||
    openEpisode !== null ||
    runtime?.activity === "action_required" ||
    (runtime?.retry_not_before !== null &&
      runtime?.retry_not_before !== undefined &&
      runtime.retry_not_before > databaseNow)
  );
  if (
    mutableEligibilityChanged ||
    immutableRunPinsChanged
  ) {
    throw new PersistenceError(
      "SOURCE_FENCED",
      "Page-read eligibility changed before execution.",
    );
  }
  return {
    ...sourceCommon,
    kind: "page_read",
    runId: run.id,
    runTrigger: run.trigger,
    runStartedAt: run.started_at ?? candidate.queuedAt,
    committedPages: boundedCounter(run.counters_json, "pages"),
    committedRecords: boundedCounter(run.counters_json, "records"),
    retryAttempt: runtime?.retry_attempt ?? 0,
    pageNumber: run.next_page_number,
    checkpointGeneration: run.checkpoint_generation,
    requestedCheckpointValue: checkpointValue(run.current_checkpoint),
    requestedCheckpointFingerprint: run.current_checkpoint_fingerprint,
    sourceIntervalSeconds: schedule
      ? await providerSourceScheduleIntervalSeconds(
          transaction,
          schedule.active_schedule_revision_id,
        )
      : 60,
  };
}
