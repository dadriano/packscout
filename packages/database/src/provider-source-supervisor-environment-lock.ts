import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";

export interface ProviderSourceSupervisorActiveEpochFence {
  readonly epochId: string;
  readonly ownerKey: string;
  readonly leaseToken: string;
}

export interface ProviderSourceSupervisorActiveEpoch {
  readonly id: string;
  readonly environmentKey: string;
  readonly epochNumber: bigint;
}

async function environmentKeyForEpoch(
  transaction: PackscoutTransactionClient,
  epochId: string,
): Promise<string | null> {
  const rows = await transaction.$queryRaw<Array<{ environmentKey: string }>>(
    Prisma.sql`
      select environment_key as "environmentKey"
      from public.source_supervisor_epochs
      where id = cast(${epochId} as uuid)
    `,
  );
  return rows[0]?.environmentKey ?? null;
}

export async function lockProviderSourceSupervisorEnvironmentExclusive(
  transaction: PackscoutTransactionClient,
  environmentKey: string,
): Promise<void> {
  await transaction.$executeRaw(Prisma.sql`
    select pg_advisory_xact_lock(hashtextextended(${environmentKey}, 0))
  `);
}

export async function lockProviderSourceSupervisorEpochEnvironmentExclusive(
  transaction: PackscoutTransactionClient,
  epochId: string,
): Promise<boolean> {
  const environmentKey = await environmentKeyForEpoch(transaction, epochId);
  if (environmentKey === null) return false;
  await lockProviderSourceSupervisorEnvironmentExclusive(
    transaction,
    environmentKey,
  );
  return true;
}

export async function lockProviderSourceSupervisorEpochEnvironmentShared(
  transaction: PackscoutTransactionClient,
  epochId: string,
): Promise<boolean> {
  const environmentKey = await environmentKeyForEpoch(transaction, epochId);
  if (environmentKey === null) return false;
  await transaction.$executeRaw(Prisma.sql`
    select pg_advisory_xact_lock_shared(
      hashtextextended(${environmentKey}, 0)
    )
  `);
  return true;
}

/**
 * Holds the environment's shared transition barrier, then revalidates the
 * exact active epoch without locking its row. Heartbeat and snapshot writers
 * may therefore update the epoch while bounded work transactions are waiting
 * on provider/source rows. Acquire, fence, and release still take the matching
 * exclusive advisory lock, so no epoch transition can pass this guard.
 */
export async function lockProviderSourceSupervisorActiveEpoch(
  transaction: PackscoutTransactionClient,
  input: ProviderSourceSupervisorActiveEpochFence,
): Promise<ProviderSourceSupervisorActiveEpoch | null> {
  const environmentLocked =
    await lockProviderSourceSupervisorEpochEnvironmentShared(
      transaction,
      input.epochId,
    );
  if (!environmentLocked) return null;
  const rows = await transaction.$queryRaw<
    ProviderSourceSupervisorActiveEpoch[]
  >(Prisma.sql`
    select id,
           environment_key as "environmentKey",
           epoch_number as "epochNumber"
    from public.source_supervisor_epochs
    where id = cast(${input.epochId} as uuid)
      and owner_key = ${input.ownerKey}
      and lease_token = cast(${input.leaseToken} as uuid)
      and state = 'active'::public.supervisor_epoch_state
      and lease_expires_at > clock_timestamp()
  `);
  return rows[0] ?? null;
}
