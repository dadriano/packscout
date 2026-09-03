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
  /** "exact" only when every entity was counted; see estimatedEntities. */
  readonly precision: ProviderPulseCountPrecision;
  /** The entities whose value is an estimate. Empty exactly when precision is "exact". */
  readonly estimatedEntities: readonly ProviderPulseCountKey[];
  readonly counts: ProviderPulseCounts;
}

export interface ProviderPulseRecordTotals {
  readonly measuredAt: string;
  readonly processed: number;
  readonly accepted: number;
}

/** Each stored-row count key and the canonical table it counts. */
const CANONICAL_ENTITY_TABLES = Object.freeze({
  categories: "categories",
  packs: "packs",
  collectibles: "collectibles",
  aliases: "collectible_name_aliases",
  instances: "collectible_instances",
  packContents: "pack_contents",
  accounts: "provider_accounts",
  pulls: "pulls",
  pullItems: "pull_items",
  marketEvents: "market_events",
} as const);

export type ProviderPulseCountKey = keyof typeof CANONICAL_ENTITY_TABLES;

const CANONICAL_ENTITY_KEYS = Object.keys(CANONICAL_ENTITY_TABLES) as ProviderPulseCountKey[];
const CANONICAL_TABLES = Object.values(CANONICAL_ENTITY_TABLES) as string[];

/**
 * The most bytes one exact-count statement may scan. Table sizes differ by
 * orders of magnitude inside a single provider — on the measured database
 * seven canonical tables held nothing at all, market_events held 49 MB, and
 * pulls held 2,220 MB — so the smallest tables are counted exactly and only
 * the ones that would blow the budget are estimated. Counting was measured at
 * roughly 56 MB per second against a remote database, which puts this ceiling
 * near two seconds of scanning, well inside the statement's six-second budget.
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

type EstimateRow = CountsRow
  & { readonly readable_tables: bigint }
  & { readonly [Key in Exclude<keyof ProviderPulseCounts, "total"> as `bytes_${Key}`]: bigint };

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

function own(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const field = Object.getOwnPropertyDescriptor(value, name);
  return field && "value" in field ? field.value : undefined;
}

/**
 * True only for a statement the database cancelled against its own budget,
 * identified by SQLSTATE 57014. Every other failure — a missing relation, a
 * revoked privilege, a broken connection — is a different fact about the
 * provider and must not be mistaken for a scan that merely ran long. No error
 * text, SQL or metadata is read beyond this code.
 */
function isStatementCancellation(error: unknown): boolean {
  if (!(error instanceof ProviderPrisma.PrismaClientKnownRequestError)) return false;
  if (own(error, "code") !== "P2010") return false;
  return own(own(error, "meta"), "code") === "57014";
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

/** The size of one canonical table's heap — what an exact count would scan. */
function relationBytes(relname: string): ProviderPrisma.Sql {
  return ProviderPrisma.sql`coalesce((
    select pg_catalog.pg_relation_size(catalog.oid)
    from pg_catalog.pg_class catalog
    join pg_catalog.pg_namespace space on space.oid = catalog.relnamespace
    where space.nspname = 'public' and catalog.relkind = 'r'
      and pg_catalog.has_table_privilege(catalog.oid, 'SELECT')
      and catalog.relname = ${relname}
  ), 0)::bigint`;
}

/**
 * Builds a measurement from one row, naming which entities were counted. The
 * total is summed from the named entity columns rather than every column of
 * the row, so a column added to either statement cannot inflate it.
 */
function storageCounts(
  row: CountsRow,
  measuredAt: Date,
  counted: readonly ProviderPulseCountKey[],
): ProviderPulseStorageCounts {
  const counts = Object.fromEntries(CANONICAL_ENTITY_KEYS.map(
    (key) => [key, safeCount(row[key])],
  )) as Record<ProviderPulseCountKey, number>;
  const estimatedEntities = CANONICAL_ENTITY_KEYS.filter((key) => !counted.includes(key));
  return {
    measuredAt: measuredAt.toISOString(),
    precision: estimatedEntities.length === 0 ? "exact" : "estimated",
    estimatedEntities,
    counts: {
      total: safeCount(Object.values(counts).reduce((sum, count) => sum + BigInt(count), 0n)),
      ...counts,
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
    // Smallest first, taking entities while the statement stays inside its
    // scan ceiling. One oversized table therefore costs only its own count,
    // never the counts of the tables beside it.
    const affordable: ProviderPulseCountKey[] = [];
    let planned = 0;
    for (const key of [...CANONICAL_ENTITY_KEYS].sort(
      (left, right) => estimated.scanBytes[left] - estimated.scanBytes[right],
    )) {
      if (planned + estimated.scanBytes[key] > EXACT_STORAGE_SCAN_BYTE_CEILING) break;
      planned += estimated.scanBytes[key];
      affordable.push(key);
    }
    if (affordable.length === 0) return estimated.counted;
    return this.readExactStorageCounts(affordable, estimated.counted)
      .catch((error: unknown) => {
        // Only a scan the database cancelled against its budget downgrades to
        // the estimate. Anything else is a fact about the provider that the
        // estimate cannot stand in for, so it is reported as a failure.
        if (!isStatementCancellation(error)) throw error;
        return estimated.counted;
      });
  }

  private async readEstimatedStorageCounts(): Promise<{
    readonly counted: ProviderPulseStorageCounts;
    readonly scanBytes: Readonly<Record<ProviderPulseCountKey, number>>;
  }> {
    return this.readOnly(2_000, async (transaction) => {
      // Row estimates and relation sizes are catalog lookups, not scans. The
      // estimates are approximate between collections and are always reported
      // as estimates; the sizes are exact and decide only what is affordable.
      const [row] = await transaction.$queryRaw<EstimateRow[]>(ProviderPrisma.sql`
        select statement_timestamp() as measured_at,
          ${ProviderPrisma.join(CANONICAL_ENTITY_KEYS.map((key) => ProviderPrisma.sql`
            ${rowEstimate(CANONICAL_ENTITY_TABLES[key])} as ${ProviderPrisma.raw(`"${key}"`)},
            ${relationBytes(CANONICAL_ENTITY_TABLES[key])} as ${ProviderPrisma.raw(`"bytes_${key}"`)}`), ",")},
          (
            select count(*)
            from pg_catalog.pg_class catalog
            join pg_catalog.pg_namespace space on space.oid = catalog.relnamespace
            where space.nspname = 'public' and catalog.relkind = 'r'
              and pg_catalog.has_table_privilege(catalog.oid, 'SELECT')
              and catalog.relname = any(${CANONICAL_TABLES})
          )::bigint as readable_tables
      `);
      if (row === undefined) throw new Error("Provider pulse storage estimates are unavailable.");
      // A canonical table that is absent or unreadable estimates zero rows and
      // contributes no bytes, which would read as a measured empty table. The
      // schema is checked so that is reported as a failure instead.
      if (safeCount(row.readable_tables) !== CANONICAL_TABLES.length) {
        throw new Error("Provider pulse storage counts are unavailable: canonical tables are missing or unreadable.");
      }
      const scanBytes = Object.fromEntries(CANONICAL_ENTITY_KEYS.map(
        (key) => [key, safeCount(row[`bytes_${key}`])],
      )) as Record<ProviderPulseCountKey, number>;
      return {
        counted: storageCounts(row, row.measured_at, []),
        scanBytes,
      };
    });
  }

  /**
   * Counts only the entities the caller judged affordable, in one statement,
   * and takes the remaining values from the estimate already in hand.
   */
  private async readExactStorageCounts(
    affordable: readonly ProviderPulseCountKey[],
    estimated: ProviderPulseStorageCounts,
  ): Promise<ProviderPulseStorageCounts> {
    return this.readOnly(6_000, async (transaction) => {
      // A single statement gives these counts one MVCC snapshot. They are
      // physical canonical rows, including retired rows and relationships,
      // with no promotion history or overlapping EV projections counted.
      const [row] = await transaction.$queryRaw<Partial<CountsRow>[]>(ProviderPrisma.sql`
        select statement_timestamp() as measured_at,
          ${ProviderPrisma.join(affordable.map((key) => ProviderPrisma.sql`
            (select count(*) from ${ProviderPrisma.raw(`public.${CANONICAL_ENTITY_TABLES[key]}`)})
              as ${ProviderPrisma.raw(`"${key}"`)}`), ",")}
      `);
      if (row === undefined) throw new Error("Provider pulse storage counts are unavailable.");
      const measuredAt = row.measured_at;
      if (!(measuredAt instanceof Date)) {
        throw new Error("Provider pulse storage counts are unavailable: no measurement time.");
      }
      const merged = { ...row } as Record<string, unknown>;
      for (const key of CANONICAL_ENTITY_KEYS) {
        if (!affordable.includes(key)) merged[key] = BigInt(estimated.counts[key]);
      }
      return storageCounts(
        merged as CountsRow,
        measuredAt,
        affordable,
      );
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
