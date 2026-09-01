import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type { ProviderTransactionClient } from "./provider-database.ts";

export class ProviderRequestSettingsWriteExpired extends Error {
  constructor() { super("Provider request settings write deadline expired."); }
}

export async function assertProviderRequestSettingsWriteDeadline(transaction: ProviderTransactionClient, deadline: Date | undefined): Promise<void> {
  if (deadline === undefined) return;
  const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>(ProviderPrisma.sql`select clock_timestamp() as now`);
  if (clock === undefined || clock.now >= deadline) throw new ProviderRequestSettingsWriteExpired();
}
