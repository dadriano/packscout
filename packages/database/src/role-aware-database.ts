import {
  type DatabaseReadinessFailureCode,
  type DatabaseReadinessResult,
  type DatabaseTargetDescriptor,
  type DatabaseIdentityQueryClient,
  readDatabaseReadiness,
} from "./database-topology.ts";

export const DISTRIBUTED_TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
});

export interface RoleAwareQueryClient<TTransaction>
  extends DatabaseIdentityQueryClient {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction<T>(
    callback: (transaction: TTransaction) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}

export class DatabaseUnavailableError extends Error {
  readonly code: DatabaseReadinessFailureCode;
  readonly target: DatabaseTargetDescriptor;

  constructor(input: {
    code: DatabaseReadinessFailureCode;
    target: DatabaseTargetDescriptor;
  }) {
    super(`PackScout ${input.target.databaseRole} database is unavailable (${input.code}).`);
    this.name = "DatabaseUnavailableError";
    this.code = input.code;
    this.target = input.target;
  }
}

export interface RoleAwareDatabaseLifecycle<TClient, TTransaction> {
  readonly client: TClient;
  readonly target: DatabaseTargetDescriptor;
  start(): Promise<void>;
  readiness(): Promise<DatabaseReadinessResult>;
  transaction<T>(callback: (transaction: TTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface RoleAwareDatabaseLifecycleOptions<
  TClient extends RoleAwareQueryClient<TTransaction>,
  TTransaction,
> {
  readonly client: TClient;
  readonly target: DatabaseTargetDescriptor;
  readonly transaction?: {
    readonly maxWaitMs?: number;
    readonly timeoutMs?: number;
  };
  readonly now?: () => Date;
}

/**
 * Owns one already-constructed central or provider client. Construction and
 * application startup never mutate schema state; start only connects and
 * verifies the database_identity contract.
 */
export function createRoleAwareDatabaseLifecycle<
  TClient extends RoleAwareQueryClient<TTransaction>,
  TTransaction,
>(
  options: RoleAwareDatabaseLifecycleOptions<TClient, TTransaction>,
): RoleAwareDatabaseLifecycle<TClient, TTransaction> {
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const readiness = async (): Promise<DatabaseReadinessResult> => {
    try {
      await options.client.$connect();
    } catch {
      return {
        state: "unavailable",
        target: options.target,
        failureCode: "DATABASE_UNREACHABLE",
        observedAt: options.now?.() ?? new Date(),
      };
    }
    return readDatabaseReadiness({
      client: options.client,
      target: options.target,
      now: options.now,
    });
  };

  const start = async (): Promise<void> => {
    if (closed) throw new Error("PackScout database lifecycle is closed.");
    startPromise ??= (async () => {
      const result = await readiness();
      if (result.state === "unavailable") {
        throw new DatabaseUnavailableError({
          code: result.failureCode,
          target: result.target,
        });
      }
    })().catch((error: unknown) => {
      startPromise = undefined;
      throw error;
    });
    await startPromise;
  };

  return {
    client: options.client,
    target: options.target,
    start,
    readiness,
    async transaction<T>(
      callback: (transaction: TTransaction) => Promise<T>,
    ): Promise<T> {
      await start();
      return options.client.$transaction(callback, {
        maxWait:
          options.transaction?.maxWaitMs
          ?? DISTRIBUTED_TRANSACTION_OPTIONS.maxWait,
        timeout:
          options.transaction?.timeoutMs
          ?? DISTRIBUTED_TRANSACTION_OPTIONS.timeout,
      });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        try {
          await startPromise;
        } catch {
          // A failed startup still owns a client that must be disconnected.
        }
        await options.client.$disconnect();
      })();
      return closePromise;
    },
  };
}
