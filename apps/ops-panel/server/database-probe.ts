import { Client } from "pg";
import type {
  DatabaseProbeResult,
  DatabaseTableSummary,
} from "./core/database-status.ts";
import type { MigrationHistoryRow } from "./core/migration-state.ts";
import { describeRedactedError } from "./core/secret-redaction.ts";

/**
 * One bounded read of the database, using fixed, parameterless statements.
 *
 * Permanent design invariant: nothing here interpolates a caller value into
 * SQL, and no endpoint can reach this module with a statement of its own. The
 * three queries below are the entire vocabulary of the panel's database reads.
 *
 * The connection string is passed to the driver and never leaves this module;
 * every message that does leave passes through redaction first.
 */

/** Bounded so a wedged database cannot hold a status read open. */
export const PROBE_CONNECT_TIMEOUT_MS = 4_000;
export const PROBE_STATEMENT_TIMEOUT_MS = 5_000;
export const PROBE_TABLE_LIMIT = 12;

const SIZE_QUERY = `
  select current_database() as database,
         pg_database_size(current_database())::text as size_bytes
`;

const TABLE_QUERY = `
  select relation.relname as name,
         coalesce(
           statistics.n_live_tup,
           greatest(relation.reltuples, 0)::bigint
         )::text as approximate_rows,
         pg_total_relation_size(relation.oid)::text as total_bytes
  from pg_class as relation
  join pg_namespace as namespace on namespace.oid = relation.relnamespace
  left join pg_stat_all_tables as statistics on statistics.relid = relation.oid
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p')
  order by pg_total_relation_size(relation.oid) desc, relation.relname asc
  limit ${PROBE_TABLE_LIMIT}
`;

const MIGRATION_QUERY = `
  select migration_name as name,
         started_at,
         finished_at,
         rolled_back_at
  from public."_prisma_migrations"
  order by started_at asc, migration_name asc
`;

/** PostgreSQL's "relation does not exist": a database that never ran a migration. */
const UNDEFINED_TABLE = "42P01";

export interface ProbeQueryResult<Row> {
  rows: Row[];
}

/** The slice of the driver the probe uses, so tests can supply their own. */
export interface ProbeConnection {
  connect(): Promise<void>;
  query<Row>(text: string): Promise<ProbeQueryResult<Row>>;
  end(): Promise<void>;
}

export type ProbeConnectionFactory = (connectionString: string) => ProbeConnection;

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = String((error as { code?: unknown }).code ?? "");
  return /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
}

/**
 * A failure while opening the connection is only *unreachable* when the server
 * never answered. A SQLSTATE means PostgreSQL replied and refused — bad
 * password, missing database — which is reachable but unusable, and saying so
 * points the operator at the right problem.
 */
export function classifyConnectionFailure(
  error: unknown,
): "unreachable" | "unqueryable" {
  return sqlState(error) === undefined ? "unreachable" : "unqueryable";
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

function defaultConnectionFactory(connectionString: string): ProbeConnection {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: PROBE_CONNECT_TIMEOUT_MS,
    statement_timeout: PROBE_STATEMENT_TIMEOUT_MS,
    query_timeout: PROBE_STATEMENT_TIMEOUT_MS,
    application_name: "packscout-ops-panel",
  });
  return {
    connect: async () => {
      await client.connect();
    },
    query: <Row,>(text: string) =>
      client.query(text).then((result) => ({ rows: result.rows as Row[] })),
    end: () => client.end(),
  };
}

async function readMigrationHistory(
  connection: ProbeConnection,
): Promise<MigrationHistoryRow[]> {
  try {
    const result = await connection.query<Record<string, unknown>>(MIGRATION_QUERY);
    return result.rows.map((row) => ({
      name: String(row.name ?? ""),
      startedAt: toIsoOrNull(row.started_at),
      finishedAt: toIsoOrNull(row.finished_at),
      rolledBackAt: toIsoOrNull(row.rolled_back_at),
    }));
  } catch (error) {
    // No history table at all is a fresh database, not an unreadable one: the
    // caller reads that as "behind", never as "unknown".
    if (sqlState(error) === UNDEFINED_TABLE) return [];
    throw error;
  }
}

export interface DatabaseProbeOptions {
  readonly connectionString: string;
  readonly connect?: ProbeConnectionFactory;
}

/**
 * Probe the configured database once. Never throws: every failure becomes a
 * classified, redacted result the status surface can render truthfully.
 */
export async function probeDatabase({
  connectionString,
  connect = defaultConnectionFactory,
}: DatabaseProbeOptions): Promise<DatabaseProbeResult> {
  const secrets = [connectionString];
  let connection: ProbeConnection;
  try {
    connection = connect(connectionString);
  } catch (error) {
    return {
      outcome: "unreachable",
      sizeBytes: null,
      tables: [],
      migrationHistory: null,
      detail: describeRedactedError(error, secrets),
    };
  }

  try {
    await connection.connect();
  } catch (error) {
    await connection.end().catch(() => undefined);
    return {
      outcome: classifyConnectionFailure(error),
      sizeBytes: null,
      tables: [],
      migrationHistory: null,
      detail: describeRedactedError(error, secrets),
    };
  }

  try {
    const size = await connection.query<Record<string, unknown>>(SIZE_QUERY);
    const tables = await connection.query<Record<string, unknown>>(TABLE_QUERY);
    const migrationHistory = await readMigrationHistory(connection);
    return {
      outcome: "reachable",
      sizeBytes: toNumber(size.rows[0]?.size_bytes),
      tables: tables.rows.map(
        (row): DatabaseTableSummary => ({
          name: String(row.name ?? ""),
          approximateRows: toNumber(row.approximate_rows),
          totalBytes: toNumber(row.total_bytes),
        }),
      ),
      migrationHistory,
      detail: null,
    };
  } catch (error) {
    return {
      outcome: "unqueryable",
      sizeBytes: null,
      tables: [],
      migrationHistory: null,
      detail: describeRedactedError(error, secrets),
    };
  } finally {
    await connection.end().catch(() => undefined);
  }
}
