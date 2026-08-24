import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { providerSourceRunBounds } from "@packscout/contracts";
import type { PackscoutTransactionClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import type { ProviderSourceImportRunRepository } from
  "./provider-source-import-run-repository.ts";
import type { ProviderSourceSupervisorQueueCandidate } from
  "./provider-source-supervisor-work-claim-repository.ts";

function pageCount(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return 0;
  const candidate = (value as Record<string, unknown>).pages;
  return Number.isSafeInteger(candidate) && Number(candidate) >= 0
    ? Number(candidate)
    : 0;
}

/** Rolls an elapsed/page-bounded queued run before it can make another call. */
export async function rolloverExpiredQueuedProviderSourceRun(
  transaction: PackscoutTransactionClient,
  runs: ProviderSourceImportRunRepository,
  candidate: ProviderSourceSupervisorQueueCandidate,
  databaseNow: Date,
): Promise<boolean> {
  if (candidate.kind !== "page_read") return false;
  const rows = await transaction.$queryRaw<Array<{
    id: string;
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
    startedAt: Date | null;
    nextPageNumber: number;
    counters: unknown;
  }>>(Prisma.sql`
    select id,
           organization_id as "organizationId",
           provider_id as "providerId",
           source_instance_id as "sourceInstanceId",
           source_revision_id as "sourceRevisionId",
           started_at as "startedAt",
           next_page_number as "nextPageNumber",
           counters_json as counters
    from public.import_runs
    where id = cast(${candidate.id} as uuid)
      and state = 'queued'::public.import_run_state
      and source_instance_id is not null
    for update
  `);
  const run = rows[0];
  if (!run) return false;
  const lastPage = run.nextPageNumber > 0
    ? await transaction.import_pages.findFirst({
        where: {
          run_id: run.id,
          organization_id: run.organizationId,
          provider_id: run.providerId,
          source_instance_id: run.sourceInstanceId,
          source_revision_id: run.sourceRevisionId,
          page_number: run.nextPageNumber - 1,
        },
        select: { continuation_kind: true },
      })
    : null;
  // A never-started manual run has consumed none of its 15-minute execution
  // budget. A committed poll_after page is already at head and must be closed
  // by recovery/finalization rather than converted into a continuation run.
  if (lastPage?.continuation_kind !== "continue") return false;
  if (
    pageCount(run.counters) < providerSourceRunBounds.maximumCommittedPages &&
    (run.startedAt === null ||
      databaseNow.getTime() - run.startedAt.getTime() <
        providerSourceRunBounds.maximumElapsedMilliseconds)
  ) return false;

  await transaction.import_runs.update({
    where: { id: run.id },
    data: {
      state: "incomplete",
      finished_at: databaseNow,
      failure_code: null,
      failure_summary: null,
      lease_owner: null,
      lease_token: null,
      claim_lease_id: null,
      lease_expires_at: null,
      heartbeat_at: null,
    },
  });
  const continuation = await runs.requestRunInTransaction(transaction, {
    organizationId: run.organizationId,
    providerId: run.providerId,
    runId: randomUUID(),
    trigger: "continuation",
    requestedByActorKey: null,
    requestedAt: databaseNow,
    expectedSourceRevisionId: run.sourceRevisionId,
  });
  if (continuation.kind !== "created") {
    throw new PersistenceError(
      "SOURCE_FENCED",
      "Expired queued run did not create its exact continuation.",
    );
  }
  await transaction.provider_source_runtime_states.updateMany({
    where: {
      source_instance_id: run.sourceInstanceId,
      organization_id: run.organizationId,
      source_revision_id: run.sourceRevisionId,
    },
    data: {
      phase: "queued",
      activity: "queued",
      wait_reason: null,
      action_required_code: null,
      current_run_id: continuation.run.id,
      run_lease_acquired_at: null,
      run_lease_expires_at: null,
      retry_attempt: 0,
      retry_not_before: null,
      queued_at: databaseNow,
      updated_at: databaseNow,
    },
  });
  return true;
}
