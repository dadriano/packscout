import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import { runDrainedDatabaseTransaction } from "./drained-database-transaction.ts";
import type {
  ProviderPrismaClient,
  ProviderTransactionClient,
} from "./provider-database.ts";

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 10_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.Serializable,
});
const ownerPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export interface ProviderWorkerLeaseTransactionDeadline {
  readonly deadlineAt: number;
}

function transactionOptions(
  deadline?: ProviderWorkerLeaseTransactionDeadline,
) {
  if (deadline === undefined) return TRANSACTION_OPTIONS;
  const available = Math.floor(deadline.deadlineAt - Date.now() - 50);
  const maxWait = Math.min(
    TRANSACTION_OPTIONS.maxWait,
    Math.max(1, Math.floor(available / 5)),
  );
  const timeout = Math.min(
    TRANSACTION_OPTIONS.timeout,
    available - maxWait,
  );
  if (timeout < 1) {
    throw Object.assign(new Error("Provider worker lease deadline reached."), {
      code: "PROVIDER_WORKER_LEASE_DEADLINE",
    });
  }
  return { ...TRANSACTION_OPTIONS, maxWait, timeout };
}

function transactionExpired(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error.code === "P2024" || error.code === "P2028");
}

async function withWorkerLeaseDeadline<T>(
  deadline: ProviderWorkerLeaseTransactionDeadline | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (deadline !== undefined && transactionExpired(error)) {
      throw Object.assign(new Error("Provider worker lease deadline reached."), {
        code: "PROVIDER_WORKER_LEASE_DEADLINE",
      });
    }
    throw error;
  }
}

export type ProviderWorkerRole = "import" | "promotion";

export interface ProviderWorkerLease {
  readonly role: ProviderWorkerRole;
  readonly owner: string;
  readonly fence: bigint;
  readonly heartbeatAt: Date;
  readonly expiresAt: Date;
  readonly rowVersion: bigint;
}

export type AcquireProviderWorkerLeaseResult =
  | { readonly kind: "acquired" | "renewed" | "unchanged"; readonly lease: ProviderWorkerLease }
  | { readonly kind: "held"; readonly fence: bigint; readonly expiresAt: Date };

interface WorkerLeaseRow {
  readonly worker_role: ProviderWorkerRole;
  readonly lease_owner: string | null;
  readonly lease_fence: bigint;
  readonly heartbeat_at: Date | null;
  readonly lease_expires_at: Date | null;
  readonly row_version: bigint;
  readonly database_now: Date;
}

function requireLeaseDuration(owner: string, leaseMilliseconds: number): void {
  if (!ownerPattern.test(owner)) throw new TypeError("Provider worker owner is invalid.");
  if (
    !Number.isInteger(leaseMilliseconds)
    || leaseMilliseconds < 1_000
    || leaseMilliseconds > 15 * 60_000
  ) {
    throw new TypeError("Provider worker lease duration is invalid.");
  }
}
function leaseFrom(row: WorkerLeaseRow): ProviderWorkerLease {
  if (
    row.lease_owner === null
    || row.heartbeat_at === null
    || row.lease_expires_at === null
  ) throw new Error("Provider worker lease is not owned.");
  return {
    role: row.worker_role,
    owner: row.lease_owner,
    fence: row.lease_fence,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.lease_expires_at,
    rowVersion: row.row_version,
  };
}

export async function lockProviderWorkerLease(
  transaction: ProviderTransactionClient,
  role: ProviderWorkerRole,
): Promise<WorkerLeaseRow> {
  const [row] = await transaction.$queryRaw<WorkerLeaseRow[]>(ProviderPrisma.sql`
    select worker_role, lease_owner, lease_fence, heartbeat_at,
           lease_expires_at, row_version, clock_timestamp() as database_now
    from provider_worker_states
    where worker_role = cast(${role} as "worker_role")
    for update
  `);
  if (!row) throw new Error(`Provider ${role} worker state is missing.`);
  return row;
}

export function providerWorkerLeaseIsLive(
  row: WorkerLeaseRow,
  input: { readonly owner: string; readonly fence: bigint },
): boolean {
  return row.lease_owner === input.owner
    && row.lease_fence === input.fence
    && row.lease_expires_at !== null
    && row.lease_expires_at > row.database_now;
}

export function providerWorkerLeaseDatabaseNow(row: WorkerLeaseRow): Date {
  return row.database_now;
}

export async function setProviderImportLeaseContext(
  transaction: ProviderTransactionClient,
  input: { readonly owner: string; readonly fence: bigint },
): Promise<void> {
  if (!ownerPattern.test(input.owner) || input.fence < 1n) {
    throw new TypeError("Provider import lease context is invalid.");
  }
  await transaction.$queryRaw(ProviderPrisma.sql`
    select set_config('packscout.import_lease_owner', ${input.owner}, true),
           set_config('packscout.import_lease_fence', ${input.fence.toString()}, true)
  `);
}

export interface AcquireProviderWorkerLeaseInput {
  readonly role: ProviderWorkerRole;
  readonly owner: string;
  readonly leaseMilliseconds: number;
}

/** Normal lease admission within a caller-owned transaction, including any required claim audit. */
export async function acquireProviderWorkerLease(transaction: ProviderTransactionClient,
  input: AcquireProviderWorkerLeaseInput): Promise<AcquireProviderWorkerLeaseResult> {
  requireLeaseDuration(input.owner, input.leaseMilliseconds);
  let row = await lockProviderWorkerLease(transaction, input.role);
  const active = row.lease_owner !== null
    && row.lease_expires_at !== null
    && row.lease_expires_at > row.database_now;
  if (active && row.lease_owner !== input.owner) {
    return {
      kind: "held" as const,
      fence: row.lease_fence,
      expiresAt: row.lease_expires_at as Date,
    };
  }
  const takeover = !active || row.lease_owner === null;
  const heartbeatAt = row.database_now;
  const expiresAt = new Date(
    heartbeatAt.getTime() + input.leaseMilliseconds,
  );
  const updated = await transaction.provider_worker_states.updateMany({
    where: { worker_role: input.role, row_version: row.row_version },
    data: {
      lease_owner: input.owner,
      lease_fence: takeover ? row.lease_fence + 1n : row.lease_fence,
      heartbeat_at: heartbeatAt,
      lease_expires_at: expiresAt,
      row_version: { increment: 1n },
      updated_at: heartbeatAt,
    },
  });
  if (updated.count !== 1) throw new Error("Provider worker lease changed concurrently.");
  row = await lockProviderWorkerLease(transaction, input.role);
  return {
    kind: takeover ? "acquired" as const : "renewed" as const,
    lease: leaseFrom(row),
  };
}

export class PrismaProviderWorkerLeaseRepository {
  constructor(private readonly database: ProviderPrismaClient) {}

  async acquire(
    input: AcquireProviderWorkerLeaseInput,
    deadline?: ProviderWorkerLeaseTransactionDeadline,
  ): Promise<
    AcquireProviderWorkerLeaseResult
  > {
    requireLeaseDuration(input.owner, input.leaseMilliseconds);
    return withWorkerLeaseDeadline(deadline, () =>
      runDrainedDatabaseTransaction<
        AcquireProviderWorkerLeaseResult,
        ProviderTransactionClient
      >(
        callback => this.database.$transaction(
          callback,
          transactionOptions(deadline),
        ),
        transaction => acquireProviderWorkerLease(transaction, input),
      )
    );
  }

  async renew(input: {
    readonly role: ProviderWorkerRole;
    readonly owner: string;
    readonly fence: bigint;
    readonly leaseMilliseconds: number;
  }, deadline?: ProviderWorkerLeaseTransactionDeadline): Promise<
    ProviderWorkerLease | null
  > {
    requireLeaseDuration(input.owner, input.leaseMilliseconds);
    return withWorkerLeaseDeadline(deadline, () =>
      runDrainedDatabaseTransaction(callback => this.database.$transaction(callback, transactionOptions(deadline)), async (transaction: ProviderTransactionClient) => {
      let row = await lockProviderWorkerLease(transaction, input.role);
      if (!providerWorkerLeaseIsLive(row, {
        owner: input.owner,
        fence: input.fence,
      })) return null;
      const heartbeatAt = row.database_now;
      const expiresAt = new Date(
        heartbeatAt.getTime() + input.leaseMilliseconds,
      );
      const updated = await transaction.provider_worker_states.updateMany({
        where: {
          worker_role: input.role,
          lease_owner: input.owner,
          lease_fence: input.fence,
          row_version: row.row_version,
        },
        data: {
          heartbeat_at: heartbeatAt,
          lease_expires_at: expiresAt,
          row_version: { increment: 1n },
          updated_at: heartbeatAt,
        },
      });
      if (updated.count !== 1) return null;
      row = await lockProviderWorkerLease(transaction, input.role);
      return leaseFrom(row);
      })
    );
  }

  async release(input: {
    readonly role: ProviderWorkerRole;
    readonly owner: string;
    readonly fence: bigint;
  }, deadline?: ProviderWorkerLeaseTransactionDeadline): Promise<boolean> {
    if (!ownerPattern.test(input.owner)) throw new TypeError("Provider worker owner is invalid.");
    return withWorkerLeaseDeadline(deadline, () =>
      runDrainedDatabaseTransaction(callback => this.database.$transaction(callback, transactionOptions(deadline)), async (transaction: ProviderTransactionClient) => {
      const row = await lockProviderWorkerLease(transaction, input.role);
      if (row.lease_owner === null) return true;
      if (row.lease_owner !== input.owner || row.lease_fence !== input.fence) return false;
      const updated = await transaction.provider_worker_states.updateMany({
        where: {
          worker_role: input.role,
          lease_owner: input.owner,
          lease_fence: input.fence,
          row_version: row.row_version,
        },
        data: {
          lease_owner: null,
          heartbeat_at: null,
          lease_expires_at: null,
          row_version: { increment: 1n },
          updated_at: row.database_now,
        },
      });
      return updated.count === 1;
      })
    );
  }
}
