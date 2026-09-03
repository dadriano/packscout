import { Pool } from "pg";
import {
  ProviderReviewProvisionError,
  type ReviewProviderDescriptor,
} from "./provider-review-database-plan.mts";

export interface FreshProviderSeedSnapshot {
  readonly providerId: string;
  readonly providerKey: string;
  readonly databaseRole: string;
  readonly schemaVersion: string;
  readonly operatingState: string;
  readonly stateGeneration: string;
  readonly cachedConfigCount: number;
  readonly cursorCount: number;
  readonly nextDueCount: number;
  readonly runtimeFailureCount: number;
  readonly leasedWorkerCount: number;
  readonly workerRoles: readonly string[];
  readonly promotionSequence: string;
  readonly canonicalCount: string;
  readonly commandCount: string;
  readonly runCount: string;
  readonly runPageCount: string;
  readonly quarantineCount: string;
}

function refuse(code: string): never {
  throw new ProviderReviewProvisionError(code);
}

export function assertFreshProviderSeedSnapshot(input: {
  readonly snapshot: Readonly<FreshProviderSeedSnapshot>;
  readonly descriptor: Readonly<ReviewProviderDescriptor>;
  readonly providerId: string;
}): void {
  const value = input.snapshot;
  if (
    value.providerId !== input.providerId ||
    value.providerKey !== input.descriptor.providerKey ||
    value.databaseRole !== "provider" ||
    value.schemaVersion !== input.descriptor.schemaVersion ||
    value.operatingState !== "idle" || value.stateGeneration !== "0" ||
    value.cachedConfigCount !== 0 || value.cursorCount !== 0 ||
    value.nextDueCount !== 0 || value.runtimeFailureCount !== 0 ||
    value.leasedWorkerCount !== 0 ||
    value.workerRoles.join(",") !== "import,promotion" ||
    value.promotionSequence !== "0" || value.canonicalCount !== "0" ||
    value.commandCount !== "0" || value.runCount !== "0" ||
    value.runPageCount !== "0" || value.quarantineCount !== "0"
  ) {
    refuse("PROVIDER_FRESH_SEED_PROOF_FAILED");
  }
}

export async function verifyFreshProviderReviewDatabase(input: {
  readonly databaseUrl: string;
  readonly descriptor: Readonly<ReviewProviderDescriptor>;
  readonly providerId: string;
}): Promise<void> {
  const pool = new Pool({ connectionString: input.databaseUrl, max: 1 });
  try {
    const result = await pool.query<{
      provider_id: string;
      provider_key: string;
      database_role: string;
      schema_version: string;
      operating_state: string;
      state_generation: string;
      cached_config_count: number;
      cursor_count: number;
      next_due_count: number;
      runtime_failure_count: number;
      leased_worker_count: number;
      worker_roles: string[];
      promotion_sequence: string;
      canonical_count: string;
      command_count: string;
      run_count: string;
      run_page_count: string;
      quarantine_count: string;
    }>(`
      select identity.provider_id::text, identity.provider_key,
             identity.database_role, identity.schema_version,
             runtime.operating_state::text,
             runtime.state_generation::text,
             (case when runtime.cached_config_version_id is null
                        and runtime.cached_config_version_number is null
                        and runtime.cached_configuration is null
                        and runtime.last_control_sync_at is null
                        and runtime.schedule_seconds is null
                   then 0 else 1 end) as cached_config_count,
             (case when runtime.source_cursor is null
                        and runtime.source_cursor_hash is null
                   then 0 else 1 end) as cursor_count,
             (case when runtime.next_due_at is null then 0 else 1 end)
               as next_due_count,
             runtime.consecutive_failures as runtime_failure_count,
             (select count(*)::int from provider_worker_states worker
               where worker.lease_owner is not null
                  or worker.heartbeat_at is not null
                  or worker.lease_expires_at is not null) as leased_worker_count,
             (select array_agg(worker_role::text order by worker_role::text)
               from provider_worker_states) as worker_roles,
             (select last_sequence::text from promotion_ledger
               where singleton_key = true) as promotion_sequence,
             (
               (select count(*) from categories) +
               (select count(*) from packs) +
               (select count(*) from collectibles) +
               (select count(*) from collectible_name_aliases) +
               (select count(*) from collectible_instances) +
               (select count(*) from pack_contents) +
               (select count(*) from pack_content_snapshots) +
               (select count(*) from provider_accounts) +
               (select count(*) from pulls) +
               (select count(*) from pull_items) +
               (select count(*) from market_events) +
               (select count(*) from promotion_changes)
             )::text as canonical_count,
             (select count(*)::text from control_commands) as command_count,
             (select count(*)::text from provider_runs) as run_count,
             (select count(*)::text from provider_run_pages) as run_page_count,
             (select count(*)::text from quarantine_records) as quarantine_count
      from database_identity identity
      join provider_runtime runtime on runtime.singleton_key = true
      where identity.singleton_key = true
    `);
    const row = result.rows[0];
    if (result.rows.length !== 1 || row === undefined) {
      refuse("PROVIDER_FRESH_SEED_PROOF_FAILED");
    }
    assertFreshProviderSeedSnapshot({
      descriptor: input.descriptor,
      providerId: input.providerId,
      snapshot: {
        providerId: row.provider_id,
        providerKey: row.provider_key,
        databaseRole: row.database_role,
        schemaVersion: row.schema_version,
        operatingState: row.operating_state,
        stateGeneration: row.state_generation,
        cachedConfigCount: row.cached_config_count,
        cursorCount: row.cursor_count,
        nextDueCount: row.next_due_count,
        runtimeFailureCount: row.runtime_failure_count,
        leasedWorkerCount: row.leased_worker_count,
        workerRoles: row.worker_roles,
        promotionSequence: row.promotion_sequence,
        canonicalCount: row.canonical_count,
        commandCount: row.command_count,
        runCount: row.run_count,
        runPageCount: row.run_page_count,
        quarantineCount: row.quarantine_count,
      },
    });
  } catch (error) {
    if (error instanceof ProviderReviewProvisionError) throw error;
    refuse("PROVIDER_FRESH_SEED_PROOF_FAILED");
  } finally {
    await pool.end().catch(() => undefined);
  }
}
