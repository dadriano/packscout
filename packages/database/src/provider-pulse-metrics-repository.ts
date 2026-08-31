import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type {
  ProviderPrismaClient,
  ProviderTransactionClient,
} from "./provider-database.ts";

export interface ProviderPulseCounts {
  readonly total: number;
  readonly categories: number;
  readonly packs: number;
  readonly collectibles: number;
  readonly aliases: number;
  readonly instances: number;
  readonly packContents: number;
  readonly accounts: number;
  readonly pulls: number;
  readonly pullItems: number;
  readonly marketEvents: number;
}

export interface ProviderPulseTotals {
  readonly measuredAt: string;
  readonly counts: ProviderPulseCounts;
  readonly processed: number;
  readonly accepted: number;
}

export interface ProviderPulseLease {
  readonly state: "active" | "expired" | "unowned";
  readonly heartbeatAt: string | null;
  readonly expiresAt: string | null;
}

export interface ProviderPulseActivity {
  readonly measuredAt: string;
  readonly lastCommittedPageAt: string | null;
  readonly importLease: ProviderPulseLease;
  readonly promotionLease: ProviderPulseLease;
  readonly quarantine: {
    readonly open: number;
    readonly resolved: number;
    readonly expired: number;
    readonly retained: number;
  };
}

type TotalsRow = {
  readonly measured_at: Date;
  readonly processed: bigint;
  readonly accepted: bigint;
} & { readonly [Key in Exclude<keyof ProviderPulseCounts, "total">]: bigint };

interface ActivityRow {
  readonly measured_at: Date;
  readonly last_committed_page_at: Date | null;
  readonly import_state: ProviderPulseLease["state"];
  readonly import_heartbeat_at: Date | null;
  readonly import_expires_at: Date | null;
  readonly promotion_state: ProviderPulseLease["state"];
  readonly promotion_heartbeat_at: Date | null;
  readonly promotion_expires_at: Date | null;
  readonly open: bigint;
  readonly resolved: bigint;
  readonly expired: bigint;
  readonly retained: bigint;
}

function safeCount(value: bigint): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("Provider pulse count exceeds the supported integer range.");
  }
  return count;
}

/** Provider-local measurements; central authorization selects the database. */
export class PrismaProviderPulseMetricsRepository {
  constructor(private readonly database: ProviderPrismaClient) {}

  async readTotals(): Promise<ProviderPulseTotals> {
    return this.readOnly(6_000, async (transaction) => {
      // A single statement gives all counts one MVCC snapshot. These are
      // physical canonical rows, including retired rows and relationships,
      // with no promotion history or overlapping EV projections counted.
      const [row] = await transaction.$queryRaw<TotalsRow[]>(ProviderPrisma.sql`
        select statement_timestamp() as measured_at,
          (select count(*) from public.categories) as categories,
          (select count(*) from public.packs) as packs,
          (select count(*) from public.collectibles) as collectibles,
          (select count(*) from public.collectible_name_aliases) as aliases,
          (select count(*) from public.collectible_instances) as instances,
          (select count(*) from public.pack_contents) as "packContents",
          (select count(*) from public.provider_accounts) as accounts,
          (select count(*) from public.pulls) as pulls,
          (select count(*) from public.pull_items) as "pullItems",
          (select count(*) from public.market_events) as "marketEvents",
          retained_runs.processed, retained_runs.accepted
        from (
          select coalesce(sum(catalog_record_count::bigint
                 + pull_record_count::bigint
                 + market_event_record_count::bigint), 0)::bigint as processed,
                 coalesce(sum(accepted_count::bigint), 0)::bigint as accepted
          from public.provider_runs
        ) retained_runs
      `);
      if (row === undefined) throw new Error("Provider pulse totals are unavailable.");
      const { measured_at, processed, accepted, ...counts } = row;
      return {
        measuredAt: measured_at.toISOString(),
        counts: {
          total: safeCount(Object.values(counts).reduce((sum, count) => sum + count, 0n)),
          categories: safeCount(counts.categories),
          packs: safeCount(counts.packs),
          collectibles: safeCount(counts.collectibles),
          aliases: safeCount(counts.aliases),
          instances: safeCount(counts.instances),
          packContents: safeCount(counts.packContents),
          accounts: safeCount(counts.accounts),
          pulls: safeCount(counts.pulls),
          pullItems: safeCount(counts.pullItems),
          marketEvents: safeCount(counts.marketEvents),
        },
        processed: safeCount(processed),
        accepted: safeCount(accepted),
      };
    });
  }

  async readActivity(): Promise<ProviderPulseActivity> {
    return this.readOnly(2_000, async (transaction) => {
      // Lease expiry is compared with the same database clock used for this
      // measurement. An active lease does not establish OS process liveness.
      const [row] = await transaction.$queryRaw<ActivityRow[]>(ProviderPrisma.sql`
        select statement_timestamp() as measured_at,
          (select max(committed_at) from public.provider_run_pages) as last_committed_page_at,
          case when importer.lease_owner is null then 'unowned'
            when importer.lease_expires_at > statement_timestamp() then 'active'
            else 'expired' end as import_state,
          importer.heartbeat_at as import_heartbeat_at,
          importer.lease_expires_at as import_expires_at,
          case when promoter.lease_owner is null then 'unowned'
            when promoter.lease_expires_at > statement_timestamp() then 'active'
            else 'expired' end as promotion_state,
          promoter.heartbeat_at as promotion_heartbeat_at,
          promoter.lease_expires_at as promotion_expires_at,
          quarantine.open, quarantine.resolved, quarantine.expired, quarantine.retained
        from (
          select count(*) filter (where state = 'open') as open,
                 count(*) filter (where state = 'resolved') as resolved,
                 count(*) filter (where state = 'expired') as expired,
                 count(*) as retained
          from public.quarantine_records
        ) quarantine
        left join public.provider_worker_states importer on importer.worker_role = 'import'
        left join public.provider_worker_states promoter on promoter.worker_role = 'promotion'
      `);
      if (row === undefined) throw new Error("Provider pulse activity is unavailable.");
      return {
        measuredAt: row.measured_at.toISOString(),
        lastCommittedPageAt: row.last_committed_page_at?.toISOString() ?? null,
        importLease: {
          state: row.import_state,
          heartbeatAt: row.import_heartbeat_at?.toISOString() ?? null,
          expiresAt: row.import_expires_at?.toISOString() ?? null,
        },
        promotionLease: {
          state: row.promotion_state,
          heartbeatAt: row.promotion_heartbeat_at?.toISOString() ?? null,
          expiresAt: row.promotion_expires_at?.toISOString() ?? null,
        },
        quarantine: {
          open: safeCount(row.open),
          resolved: safeCount(row.resolved),
          expired: safeCount(row.expired),
          retained: safeCount(row.retained),
        },
      };
    });
  }

  private async readOnly<T>(
    statementTimeout: number,
    read: (transaction: ProviderTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(ProviderPrisma.sql`set transaction read only`);
      await transaction.$queryRaw(ProviderPrisma.sql`
        select set_config('statement_timeout', ${String(statementTimeout)}, true)
      `);
      return read(transaction);
    }, {
      maxWait: 1_000,
      timeout: statementTimeout + 1_000,
      isolationLevel: ProviderPrisma.TransactionIsolationLevel.ReadCommitted,
    });
  }
}
