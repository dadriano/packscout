import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";

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
