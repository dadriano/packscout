import { Client } from "pg";

const MAX_LOCK_NAME_BYTES = 256;
const ACQUIRE_LOCK_SQL = `
  select pg_try_advisory_lock(
    hashtextextended($1::text, 0)
  ) as acquired
`;
const RELEASE_LOCK_SQL = `
  select pg_advisory_unlock(
    hashtextextended($1::text, 0)
  ) as released
`;

interface GuardQueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

/**
 * The deliberately small surface the guard needs from one PostgreSQL session.
 * The production dependency creates a fresh `pg.Client`; the injectable form
 * keeps connection-affinity and failure behavior directly testable.
 */
export interface PostgresAdvisoryOperationGuardClient {
  connect(): Promise<void>;
  query(
    statement: string,
    values: readonly string[],
  ): Promise<GuardQueryResult>;
  end(): Promise<void>;
}

export interface PostgresAdvisoryOperationGuardDependencies {
  readonly createClient: (input: {
    readonly connectionString: string;
  }) => PostgresAdvisoryOperationGuardClient;
}

export interface PostgresAdvisoryOperationGuardInput {
  /**
   * Must connect directly to a session-affine PostgreSQL endpoint. Transaction
   * poolers cannot safely hold a session advisory lock across this operation.
   */
  readonly unpooledConnectionString: string;
  /** A stable, caller-owned namespace for this operation. */
  readonly lockName: string;
}

export type PostgresAdvisoryOperationGuardResult<T> =
  | { readonly status: "executed"; readonly value: T }
  | { readonly status: "busy" };

const productionDependencies: PostgresAdvisoryOperationGuardDependencies = {
  createClient({ connectionString }) {
    const client = new Client({ connectionString });
    return {
      async connect() {
        await client.connect();
      },
      async query(statement, values) {
        const result = await client.query<Record<string, unknown>>(
          statement,
          [...values],
        );
        return { rows: result.rows };
      },
      async end() {
        await client.end();
      },
    };
  },
};

function validateInput(input: PostgresAdvisoryOperationGuardInput): void {
  if (input.unpooledConnectionString.trim().length === 0) {
    throw new Error("An unpooled PostgreSQL connection string is required.");
  }
  const lockNameBytes = Buffer.byteLength(input.lockName, "utf8");
  if (
    input.lockName.trim().length === 0
    || lockNameBytes > MAX_LOCK_NAME_BYTES
  ) {
    throw new Error("PostgreSQL advisory operation lock name is invalid.");
  }
}

function acquisitionFailure(): Error {
  return new Error("PostgreSQL advisory operation lock could not be acquired.");
}

function releaseFailure(): Error {
  return new Error("PostgreSQL advisory operation lock could not be released.");
}

function readBoolean(
  result: GuardQueryResult,
  property: "acquired" | "released",
  failure: () => Error,
): boolean {
  const value = result.rows[0]?.[property];
  if (result.rows.length !== 1 || typeof value !== "boolean") throw failure();
  return value;
}

/**
 * Attempts one operation while holding a session-level PostgreSQL advisory
 * lock. Every lock query and the final disconnect use the same dedicated
 * `pg.Client`; the guarded operation is intentionally not given that client.
 */
export async function runWithPostgresAdvisoryOperationGuard<T>(
  input: PostgresAdvisoryOperationGuardInput,
  operation: () => T | Promise<T>,
  dependencies: PostgresAdvisoryOperationGuardDependencies =
    productionDependencies,
): Promise<PostgresAdvisoryOperationGuardResult<T>> {
  validateInput(input);
  // Capture both values before client creation or operation code can run. In
  // particular, acquire and release must hash the exact same lock name even if
  // a caller passed a mutable object behind the readonly input type.
  const unpooledConnectionString = input.unpooledConnectionString;
  const lockName = input.lockName;

  let client: PostgresAdvisoryOperationGuardClient;
  try {
    client = dependencies.createClient({
      connectionString: unpooledConnectionString,
    });
  } catch {
    throw new Error("PostgreSQL advisory operation client could not be created.");
  }

  let lockAcquired = false;
  let outcome: PostgresAdvisoryOperationGuardResult<T> | undefined;
  let primaryFailure: { readonly error: unknown } | undefined;
  let cleanupFailure: Error | undefined;

  try {
    try {
      await client.connect();
    } catch {
      throw new Error("PostgreSQL advisory operation client could not connect.");
    }

    let acquisition: GuardQueryResult;
    try {
      acquisition = await client.query(ACQUIRE_LOCK_SQL, [lockName]);
    } catch {
      throw acquisitionFailure();
    }
    lockAcquired = readBoolean(acquisition, "acquired", acquisitionFailure);
    if (!lockAcquired) {
      outcome = { status: "busy" };
    } else {
      outcome = { status: "executed", value: await operation() };
    }
  } catch (error) {
    primaryFailure = { error };
  } finally {
    if (lockAcquired) {
      try {
        const release = await client.query(RELEASE_LOCK_SQL, [lockName]);
        if (!readBoolean(release, "released", releaseFailure)) {
          cleanupFailure = releaseFailure();
        }
      } catch {
        cleanupFailure = releaseFailure();
      }
    }
    try {
      await client.end();
    } catch {
      cleanupFailure ??= new Error(
        "PostgreSQL advisory operation client could not close.",
      );
    }
  }

  if (primaryFailure) throw primaryFailure.error;
  if (cleanupFailure) throw cleanupFailure;
  if (!outcome) {
    throw new Error("PostgreSQL advisory operation guard did not complete.");
  }
  return outcome;
}
