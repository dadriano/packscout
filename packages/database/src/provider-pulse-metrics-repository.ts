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

export type ProviderPulseCountPrecision = "exact" | "estimated";

export interface ProviderPulseStorageCounts {
  readonly measuredAt: string;
  readonly precision: ProviderPulseCountPrecision;
  readonly counts: ProviderPulseCounts;
}

export interface ProviderPulseRecordTotals {
  readonly measuredAt: string;
  readonly processed: number;
  readonly accepted: number;
}

/**
 * Stored rows at or below this ceiling are counted exactly; above it the
 * collector's estimate is reported instead. An exact count of the canonical
 * tables was measured at roughly seven microseconds per row against a remote
 * provider database, so this ceiling keeps that scan inside its budget.
 */
export const EXACT_STORAGE_COUNT_CEILING = 250_000;

export interface ProviderPulseLease {
  readonly state: "active" | "expired" | "unowned";
  readonly heartbeatAt: string | null;
  readonly expiresAt: string | null;
}

export interface ProviderPulseLeases {
  readonly measuredAt: string;
  readonly importLease: ProviderPulseLease;
  readonly promotionLease: ProviderPulseLease;
}

export interface ProviderPulseHistory {
  readonly measuredAt: string;
  readonly lastCommittedPageAt: string | null;
  readonly quarantine: {
    readonly open: number;
    readonly resolved: number;
    readonly expired: number;
    readonly retained: number;
  };
}

type CountsRow = {
  readonly measured_at: Date;
} & { readonly [Key in Exclude<keyof ProviderPulseCounts, "total">]: bigint };

interface RecordTotalsRow {
  readonly measured_at: Date;
  readonly processed: bigint;
  readonly accepted: bigint;
}

interface LeasesRow {
  readonly measured_at: Date;
  readonly import_state: ProviderPulseLease["state"];
  readonly import_heartbeat_at: Date | null;
  readonly import_expires_at: Date | null;
  readonly promotion_state: ProviderPulseLease["state"];
  readonly promotion_heartbeat_at: Date | null;
  readonly promotion_expires_at: Date | null;
}

interface HistoryRow {
  readonly measured_at: Date;
  readonly last_committed_page_at: Date | null;
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

/**
 * Reads one canonical table's live-tuple estimate from the statistics view.
 * A table the collector has not yet reported estimates zero, which keeps the
 * caller on the exact path rather than reporting an absent table as measured.
 */
function liveTupleEstimate(relname: string): ProviderPrisma.Sql {
  return ProviderPrisma.sql`coalesce((
    select greatest(statistics.n_live_tup, 0)::bigint
    from pg_catalog.pg_stat_user_tables statistics
    where statistics.schemaname = 'public' and statistics.relname = ${relname}
  ), 0)::bigint`;
}

function storageCounts(
  row: CountsRow,
  precision: ProviderPulseCountPrecision,
): ProviderPulseStorageCounts {
  const { measured_at, ...counts } = row;
  return {
    measuredAt: measured_at.toISOString(),
    precision,
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
  };
}

/** Provider-local measurements; central authorization selects the database. */
export class PrismaProviderPulseMetricsRepository {
  constructor(private readonly database: ProviderPrismaClient) {}

  /**
   * Retained-run totals are read alone so that the cost of counting stored
   * rows cannot withhold them. This aggregate reads one small run table and
   * stays affordable however large the canonical tables grow.
   */
  async readRecordTotals(): Promise<ProviderPulseRecordTotals> {
    return this.readOnly(2_000, async (transaction) => {
      const [row] = await transaction.$queryRaw<RecordTotalsRow[]>(ProviderPrisma.sql`
        select statement_timestamp() as measured_at,
          coalesce(sum(catalog_record_count::bigint
                 + pull_record_count::bigint
                 + market_event_record_count::bigint), 0)::bigint as processed,
          coalesce(sum(accepted_count::bigint), 0)::bigint as accepted
        from public.provider_runs
      `);
      if (row === undefined) throw new Error("Provider pulse record totals are unavailable.");
      return {
        measuredAt: row.measured_at.toISOString(),
        processed: safeCount(row.processed),
        accepted: safeCount(row.accepted),
      };
    });
  }

  /**
   * Exact counts scan every canonical row, so their cost grows without bound
   * and a large provider cannot be counted inside any request budget. The
   * collector's live-tuple statistics answer in constant time, so they decide
   * which measurement is affordable before one is attempted: at or below the
   * ceiling the exact scan runs and reports "exact"; above it the estimate is
   * reported as "estimated" rather than withheld. A provider whose statistics
   * are absent or not yet collected estimates zero and so takes the exact
   * path, which is cheap at that size and keeps a new database truthful.
   */
  async readStorageCounts(): Promise<ProviderPulseStorageCounts> {
    const estimated = await this.readEstimatedStorageCounts();
    if (estimated.counts.total > EXACT_STORAGE_COUNT_CEILING) return estimated;
    return this.readExactStorageCounts();
  }

  private async readEstimatedStorageCounts(): Promise<ProviderPulseStorageCounts> {
    return this.readOnly(2_000, async (transaction) => {
      // Live-tuple statistics are maintained incrementally by the collector,
      // so these are catalog lookups rather than scans. They are approximate
      // between collections and are reported as estimates, never as counts.
      const [row] = await transaction.$queryRaw<CountsRow[]>(ProviderPrisma.sql`
        select statement_timestamp() as measured_at,
          ${liveTupleEstimate("categories")} as categories,
          ${liveTupleEstimate("packs")} as packs,
          ${liveTupleEstimate("collectibles")} as collectibles,
          ${liveTupleEstimate("collectible_name_aliases")} as aliases,
          ${liveTupleEstimate("collectible_instances")} as instances,
          ${liveTupleEstimate("pack_contents")} as "packContents",
          ${liveTupleEstimate("provider_accounts")} as accounts,
          ${liveTupleEstimate("pulls")} as pulls,
          ${liveTupleEstimate("pull_items")} as "pullItems",
          ${liveTupleEstimate("market_events")} as "marketEvents"
      `);
      if (row === undefined) throw new Error("Provider pulse storage estimates are unavailable.");
      return storageCounts(row, "estimated");
    });
  }

  private async readExactStorageCounts(): Promise<ProviderPulseStorageCounts> {
    return this.readOnly(6_000, async (transaction) => {
      // A single statement gives all counts one MVCC snapshot. These are
      // physical canonical rows, including retired rows and relationships,
      // with no promotion history or overlapping EV projections counted.
      const [row] = await transaction.$queryRaw<CountsRow[]>(ProviderPrisma.sql`
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
          (select count(*) from public.market_events) as "marketEvents"
      `);
      if (row === undefined) throw new Error("Provider pulse storage counts are unavailable.");
      return storageCounts(row, "exact");
    });
  }

  async readLeases(): Promise<ProviderPulseLeases> {
    return this.readOnly(2_000, async (transaction) => {
      // Lease expiry is compared with the same database clock used for this
      // measurement. An active lease does not establish OS process liveness.
      const [row] = await transaction.$queryRaw<LeasesRow[]>(ProviderPrisma.sql`
        select statement_timestamp() as measured_at,
          case when importer.lease_owner is null then 'unowned'
            when importer.lease_expires_at > statement_timestamp() then 'active'
            else 'expired' end as import_state,
          importer.heartbeat_at as import_heartbeat_at,
          importer.lease_expires_at as import_expires_at,
          case when promoter.lease_owner is null then 'unowned'
            when promoter.lease_expires_at > statement_timestamp() then 'active'
            else 'expired' end as promotion_state,
          promoter.heartbeat_at as promotion_heartbeat_at,
          promoter.lease_expires_at as promotion_expires_at
        from (values (1)) as measurement(singleton)
        left join public.provider_worker_states importer on importer.worker_role = 'import'
        left join public.provider_worker_states promoter on promoter.worker_role = 'promotion'
      `);
      if (row === undefined) throw new Error("Provider pulse leases are unavailable.");
      return {
        measuredAt: row.measured_at.toISOString(),
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
      };
    });
  }

  async readHistory(): Promise<ProviderPulseHistory> {
    return this.readOnly(2_000, async (transaction) => {
      // Retained history grows with ingestion. Keep its exact aggregates
      // separate from the worker point reads so callers can cache this scan.
      const [row] = await transaction.$queryRaw<HistoryRow[]>(ProviderPrisma.sql`
        select statement_timestamp() as measured_at,
          (select max(committed_at) from public.provider_run_pages) as last_committed_page_at,
          quarantine.open, quarantine.resolved, quarantine.expired, quarantine.retained
        from (
          select count(*) filter (where state = 'open') as open,
                 count(*) filter (where state = 'resolved') as resolved,
                 count(*) filter (where state = 'expired') as expired,
                 count(*) as retained
          from public.quarantine_records
        ) quarantine
      `);
      if (row === undefined) throw new Error("Provider pulse history is unavailable.");
      return {
        measuredAt: row.measured_at.toISOString(),
        lastCommittedPageAt: row.last_committed_page_at?.toISOString() ?? null,
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
