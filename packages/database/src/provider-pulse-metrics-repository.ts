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

/** The canonical tables a stored-row count reads, in count-key order. */
const CANONICAL_TABLES = [
  "categories", "packs", "collectibles", "collectible_name_aliases",
  "collectible_instances", "pack_contents", "provider_accounts",
  "pulls", "pull_items", "market_events",
];

/**
 * Canonical tables totalling at or below this many bytes are counted exactly;
 * above it their row estimate is reported instead. Counting every row of a
 * 3,388 MB provider was measured at 40 to 57 seconds against a remote
 * database, so this ceiling keeps a scan well inside its six-second budget.
 * Bytes, not rows, because bytes are what a scan actually reads.
 */
export const EXACT_STORAGE_SCAN_BYTE_CEILING = 128 * 1024 * 1024;

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

type EstimateRow = CountsRow & { readonly scan_bytes: bigint };

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
 * Reads one canonical table's row estimate. The collector's live-tuple count
 * is the fresher of the two sources but is zeroed by a statistics reset, so
 * the planner's own estimate in pg_class — which a reset does not touch — is
 * taken whenever it is larger. A table that genuinely holds no rows reports
 * zero from both.
 */
function rowEstimate(relname: string): ProviderPrisma.Sql {
  return ProviderPrisma.sql`coalesce((
    select greatest(statistics.n_live_tup, catalog.reltuples, 0)::bigint
    from pg_catalog.pg_class catalog
    join pg_catalog.pg_namespace space on space.oid = catalog.relnamespace
    left join pg_catalog.pg_stat_user_tables statistics on statistics.relid = catalog.oid
    where space.nspname = 'public' and catalog.relname = ${relname}
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
   * decision to attempt one is made on the bytes those scans would read, not
   * on an estimated row count: relation size comes from the catalog, is always
   * truthful, and predicts scan cost directly, whereas a row estimate can be
   * zeroed by a statistics reset and would route a large provider into a scan
   * that cannot finish. Whatever happens, an estimate is already in hand, so a
   * scan that still fails downgrades to it rather than withholding everything.
   */
  async readStorageCounts(): Promise<ProviderPulseStorageCounts> {
    const estimated = await this.readEstimatedStorageCounts();
    if (estimated.scanBytes > EXACT_STORAGE_SCAN_BYTE_CEILING) return estimated.counted;
    return this.readExactStorageCounts().catch(() => estimated.counted);
  }

  private async readEstimatedStorageCounts(): Promise<{
    readonly counted: ProviderPulseStorageCounts;
    readonly scanBytes: number;
  }> {
    return this.readOnly(2_000, async (transaction) => {
      // Row estimates and relation sizes are catalog lookups, not scans. The
      // estimates are approximate between collections and are always reported
      // as estimates; the sizes are exact and decide only what is affordable.
      const [row] = await transaction.$queryRaw<EstimateRow[]>(ProviderPrisma.sql`
        select statement_timestamp() as measured_at,
          ${rowEstimate("categories")} as categories,
          ${rowEstimate("packs")} as packs,
          ${rowEstimate("collectibles")} as collectibles,
          ${rowEstimate("collectible_name_aliases")} as aliases,
          ${rowEstimate("collectible_instances")} as instances,
          ${rowEstimate("pack_contents")} as "packContents",
          ${rowEstimate("provider_accounts")} as accounts,
          ${rowEstimate("pulls")} as pulls,
          ${rowEstimate("pull_items")} as "pullItems",
          ${rowEstimate("market_events")} as "marketEvents",
          coalesce((
            select sum(pg_catalog.pg_relation_size(catalog.oid))
            from pg_catalog.pg_class catalog
            join pg_catalog.pg_namespace space on space.oid = catalog.relnamespace
            where space.nspname = 'public' and catalog.relkind = 'r'
              and catalog.relname = any(${CANONICAL_TABLES})
          ), 0)::bigint as scan_bytes
      `);
      if (row === undefined) throw new Error("Provider pulse storage estimates are unavailable.");
      const { scan_bytes, ...counts } = row;
      return { counted: storageCounts(counts, "estimated"), scanBytes: safeCount(scan_bytes) };
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
