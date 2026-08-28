import { Prisma } from "@prisma/client";
import type { PackscoutQueryClient } from "./database.ts";

/**
 * Reads PostgreSQL's wall clock for security-sensitive lease and fencing
 * decisions. Caller clocks are suitable for observations, but must never
 * decide ownership or accelerate takeover.
 */
export async function providerSourceTransactionTime(
  transaction: PackscoutQueryClient,
): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    select clock_timestamp() as "now"
  `);
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("PostgreSQL did not return a valid transaction timestamp.");
  }
  return now;
}
