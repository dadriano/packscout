import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient, PackscoutTransactionClient } from
  "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { providerSourceTransactionTime } from
  "./provider-source-database-clock.ts";
import { ProviderSourceDiagnosticRepository } from
  "./provider-source-diagnostic-repository.ts";
import { ProviderSourceImportRunRepository } from
  "./provider-source-import-run-repository.ts";
import { lockProviderSourceSupervisorActiveEpoch } from
  "./provider-source-supervisor-environment-lock.ts";
import { PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION } from
  "./provider-source-persistence-types.ts";
import { ProviderSourceSupervisorRecoveryRepository } from
  "./provider-source-supervisor-recovery-repository.ts";
import { recoverExpiredProviderSourceSupervisorTests } from
  "./provider-source-supervisor-test-recovery-repository.ts";
import type { ProviderSourceSupervisorEpochFence } from
  "./provider-source-supervisor-work-types.ts";

export type ProviderSourceSupervisorRecoverableClaim =
  | Readonly<{ kind: "connection_test"; id: string }>
  | Readonly<{ kind: "source_test"; id: string }>
  | Readonly<{ kind: "page_read"; id: string }>;

/** Lists broadly, then recovers each expired claim in its own bounded tx. */
export class ProviderSourceSupervisorClaimRecoveryRepository {
  readonly #diagnostics: ProviderSourceDiagnosticRepository;
  readonly #pages: ProviderSourceSupervisorRecoveryRepository;

  constructor(private readonly database: PackscoutPrismaClient) {
    const runs = new ProviderSourceImportRunRepository(database);
    this.#diagnostics = new ProviderSourceDiagnosticRepository(database);
    this.#pages = new ProviderSourceSupervisorRecoveryRepository(
      runs,
      this.#diagnostics,
    );
  }

  async list(
    input: ProviderSourceSupervisorEpochFence,
  ): Promise<readonly ProviderSourceSupervisorRecoverableClaim[]> {
    return this.database.$transaction(async (transaction) => {
      const databaseNow = await this.#assertActiveEpoch(transaction, input);
      return transaction.$queryRaw<ProviderSourceSupervisorRecoverableClaim[]>(
        Prisma.sql`
          select candidate.kind, candidate.id
          from (
            select 'connection_test'::text as kind,
                   job.id,
                   job.claim_expires_at as expired_at
            from public.source_connection_test_jobs as job
            where job.state = 'running'::public.source_test_job_state
              and job.claim_expires_at <= ${databaseNow}
              and not exists (
                select 1 from public.source_request_attempts as attempt
                where attempt.connection_test_job_id = job.id
                  and attempt.state = 'in_flight'::public.source_request_attempt_state
              )
            union all
            select 'source_test'::text as kind,
                   job.id,
                   job.claim_expires_at as expired_at
            from public.provider_source_test_jobs as job
            where job.state = 'running'::public.source_test_job_state
              and job.claim_expires_at <= ${databaseNow}
              and not exists (
                select 1 from public.source_request_attempts as attempt
                where attempt.source_test_job_id = job.id
                  and attempt.state = 'in_flight'::public.source_request_attempt_state
              )
            union all
            select 'page_read'::text as kind,
                   run.id,
                   run.lease_expires_at as expired_at
            from public.import_runs as run
            where run.state = 'running'::public.import_run_state
              and run.source_instance_id is not null
              and run.lease_expires_at <= ${databaseNow}
              and not exists (
                select 1 from public.source_request_attempts as attempt
                where attempt.run_id = run.id
                  and attempt.state = 'in_flight'::public.source_request_attempt_state
              )
          ) as candidate
          order by candidate.expired_at, candidate.kind, candidate.id
          limit 100
        `,
      );
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async recoverOne(
    input: ProviderSourceSupervisorEpochFence & Readonly<{
      claim: ProviderSourceSupervisorRecoverableClaim;
    }>,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const databaseNow = await this.#assertActiveEpoch(transaction, input);
      const claim = input.claim;
      if (claim.kind === "page_read") {
        await this.#pages.recoverExpiredPageClaims(
          transaction,
          input,
          databaseNow,
          claim.id,
        );
        return;
      }
      await recoverExpiredProviderSourceSupervisorTests(
        transaction,
        this.#diagnostics,
        input,
        databaseNow,
        claim,
      );
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  /** Compatibility batch for direct recovery tools and focused DB tests. */
  async recoverAll(
    input: ProviderSourceSupervisorEpochFence,
  ): Promise<Readonly<{
    connectionTests: number;
    sourceTests: number;
    runs: number;
  }>> {
    return this.database.$transaction(async (transaction) => {
      const databaseNow = await this.#assertActiveEpoch(transaction, input);
      const tests = await recoverExpiredProviderSourceSupervisorTests(
        transaction,
        this.#diagnostics,
        input,
        databaseNow,
      );
      const runs = await this.#pages.recoverExpiredPageClaims(
        transaction,
        input,
        databaseNow,
      );
      return { ...tests, runs };
    }, PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION);
  }

  async #assertActiveEpoch(
    transaction: PackscoutTransactionClient,
    input: ProviderSourceSupervisorEpochFence,
  ): Promise<Date> {
    const epoch = await lockProviderSourceSupervisorActiveEpoch(
      transaction,
      input,
    );
    if (!epoch) {
      throw new PersistenceError(
        "SUPERVISOR_OWNERSHIP_LOST",
        "Supervisor epoch is not active.",
      );
    }
    return providerSourceTransactionTime(transaction);
  }
}
