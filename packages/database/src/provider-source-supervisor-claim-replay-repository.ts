import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import type {
  ProviderSourceSupervisorClaimIdentity,
  ProviderSourceSupervisorQueueCandidate,
} from "./provider-source-supervisor-work-claim-repository.ts";

export interface ProviderSourceSupervisorClaimReplay {
  readonly candidate: ProviderSourceSupervisorQueueCandidate;
  readonly expiresAt: Date;
}

/** Finds the one exact claim committed by an ambiguously acknowledged command. */
export async function findProviderSourceSupervisorClaimReplay(
  transaction: PackscoutTransactionClient,
  input: ProviderSourceSupervisorClaimIdentity,
): Promise<ProviderSourceSupervisorClaimReplay | null> {
  const rows = await transaction.$queryRaw<Array<{
    kind: ProviderSourceSupervisorQueueCandidate["kind"];
    id: string;
    queuedAt: Date;
    expiresAt: Date;
  }>>(Prisma.sql`
    select replay.kind, replay.id, replay."queuedAt", replay."expiresAt"
    from (
      select 'connection_test'::text as kind,
             job.id,
             job.queued_at as "queuedAt",
             job.claim_expires_at as "expiresAt"
      from public.source_connection_test_jobs as job
      where job.state = 'running'::public.source_test_job_state
        and job.supervisor_epoch_id = cast(${input.epochId} as uuid)
        and job.claim_owner = ${input.claimOwner}
        and job.claim_token = cast(${input.claimToken} as uuid)
      union all
      select 'source_test'::text as kind,
             job.id,
             job.queued_at as "queuedAt",
             job.claim_expires_at as "expiresAt"
      from public.provider_source_test_jobs as job
      where job.state = 'running'::public.source_test_job_state
        and job.supervisor_epoch_id = cast(${input.epochId} as uuid)
        and job.claim_owner = ${input.claimOwner}
        and job.claim_token = cast(${input.claimToken} as uuid)
      union all
      select 'page_read'::text as kind,
             run.id,
             coalesce(runtime.queued_at, run.created_at) as "queuedAt",
             run.lease_expires_at as "expiresAt"
      from public.import_runs as run
      left join public.provider_source_runtime_states as runtime
        on runtime.source_instance_id = run.source_instance_id
       and runtime.organization_id = run.organization_id
      where run.state = 'running'::public.import_run_state
        and run.lease_owner = ${input.claimOwner}
        and run.lease_token = cast(${input.claimToken} as uuid)
        and run.claim_lease_id = cast(${input.claimLeaseId} as uuid)
    ) as replay
    where replay."expiresAt" > clock_timestamp()
    order by replay.kind, replay.id
    limit 2
  `);
  if (rows.length > 1) {
    throw new TypeError("Supervisor claim command matched multiple work items.");
  }
  const row = rows[0];
  return row
    ? {
        candidate: {
          kind: row.kind,
          id: row.id,
          queuedAt: row.queuedAt,
        },
        expiresAt: row.expiresAt,
      }
    : null;
}
