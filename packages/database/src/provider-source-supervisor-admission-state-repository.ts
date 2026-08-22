import type { PackscoutTransactionClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { upsertProviderSourceRuntimeLane } from
  "./provider-source-supervisor-lane-state-repository.ts";
import type {
  ProviderSourceSupervisorClaimedWork,
  ProviderSourceSupervisorEpochFence,
} from "./provider-source-supervisor-work-repository.ts";

export type ProviderSourceAdmissionWaitReason =
  | "profile_capacity"
  | "execution_capacity";

export interface ProviderSourceAdmissionStateInput
  extends ProviderSourceSupervisorEpochFence {
  readonly work: ProviderSourceSupervisorClaimedWork;
  readonly state:
    | Readonly<{
        kind: "waiting";
        reason: ProviderSourceAdmissionWaitReason;
      }>
    | Readonly<{ kind: "granted" }>;
}

async function assertLiveClaim(
  transaction: PackscoutTransactionClient,
  input: ProviderSourceAdmissionStateInput,
  databaseNow: Date,
): Promise<void> {
  const { work } = input;
  if (work.kind === "connection_test") {
    const job = await transaction.source_connection_test_jobs.findFirst({
      where: {
        id: work.id,
        organization_id: work.organizationId,
        connection_profile_id: work.connectionProfileId,
        connection_revision_id: work.connectionRevisionId,
        state: "running",
        claim_owner: work.claimOwner,
        claim_token: work.claimToken,
        supervisor_epoch_id: input.epochId,
        claim_expires_at: { gt: databaseNow },
      },
      select: { id: true },
    });
    if (job) return;
  } else if (work.kind === "source_test") {
    const job = await transaction.provider_source_test_jobs.findFirst({
      where: {
        id: work.id,
        organization_id: work.organizationId,
        provider_id: work.providerId,
        source_instance_id: work.sourceInstanceId,
        source_revision_id: work.sourceRevisionId,
        connection_profile_id: work.connectionProfileId,
        connection_revision_id: work.connectionRevisionId,
        state: "running",
        claim_owner: work.claimOwner,
        claim_token: work.claimToken,
        supervisor_epoch_id: input.epochId,
        claim_expires_at: { gt: databaseNow },
      },
      select: { id: true },
    });
    if (job) return;
  } else {
    const run = await transaction.import_runs.findFirst({
      where: {
        id: work.runId,
        organization_id: work.organizationId,
        provider_id: work.providerId,
        source_instance_id: work.sourceInstanceId,
        source_revision_id: work.sourceRevisionId,
        connection_profile_id: work.connectionProfileId,
        connection_revision_id: work.connectionRevisionId,
        state: "running",
        lease_owner: work.claimOwner,
        lease_token: work.claimToken,
        claim_lease_id: work.claimLeaseId,
        lease_expires_at: { gt: databaseNow },
      },
      select: { id: true },
    });
    if (run) return;
  }
  throw new PersistenceError(
    "SOURCE_FENCED",
    "Supervisor work claim was lost before capacity admission.",
  );
}

/**
 * Persist one claimed source lane's paired-capacity wait/grant boundary.
 * Connection tests have no source lane, but their claim is still fenced here.
 */
export async function markProviderSourceSupervisorAdmissionState(
  transaction: PackscoutTransactionClient,
  input: ProviderSourceAdmissionStateInput,
  databaseNow: Date,
): Promise<void> {
  await assertLiveClaim(transaction, input, databaseNow);
  if (input.work.kind === "connection_test") return;
  const waiting = input.state.kind === "waiting";
  await upsertProviderSourceRuntimeLane(
    transaction,
    input.work,
    input.epochId,
    {
      phase: waiting ? "waiting" : "claimed",
      activity: waiting ? "waiting" : "running",
      waitReason: waiting ? input.state.reason : null,
      actionRequiredCode: null,
      currentRunId: input.work.kind === "page_read"
        ? input.work.runId
        : null,
      retryAttempt: input.work.kind === "page_read"
        ? input.work.retryAttempt
        : 0,
      retryNotBefore: null,
      updatedAt: databaseNow,
    },
  );
}
