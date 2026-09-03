import { PrismaProviderWorkerLeaseRepository, readDatabaseReadiness, providerDatabaseTarget, runDrainedDatabaseTransaction,
  type AcquireProviderWorkerLeaseResult, type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import { refuseSource } from "./clutchpacks-production-source-policy.mts";
import type { ProductionSourceImportLease } from "./clutchpacks-production-source-state.mts";

/** Caller has freshly revalidated central authority; re-prove provider identity and owner/fence before normal release. */
export async function releaseKnownProductionSourceLease(database: ProviderPrismaClient,
  scope: { providerId: string; providerKey: "clutchpacks" }, lease: ProductionSourceImportLease): Promise<boolean> {
  if (lease.role !== "import" || lease.fence < 1n) refuseSource("PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED");
  await runDrainedDatabaseTransaction(callback => database.$transaction(callback,
    { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 30_000 }), async (tx: ProviderTransactionClient) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`; await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
    const identity = await readDatabaseReadiness({ client: tx, target: providerDatabaseTarget(scope) });
    const row = await tx.provider_worker_states.findUnique({ where: { worker_role: "import" } });
    if (identity.state !== "ready" || row?.lease_owner !== lease.owner || row.lease_fence !== lease.fence) {
      refuseSource("PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED");
    }
  });
  return new PrismaProviderWorkerLeaseRepository(database).release(lease);
}

/** Known acquisition is compensable; an uncertain acquire exception is never converted into a lease or retried. */
export async function acquireCheckedProductionSourceLease(input: {
  readonly request: Parameters<PrismaProviderWorkerLeaseRepository["acquire"]>[0];
  readonly acquire: PrismaProviderWorkerLeaseRepository["acquire"];
  readonly postcheck: (lease: ProductionSourceImportLease) => Promise<void>;
  /** Fresh scoped route/identity/ownership proof followed by normal exact-fence release; never a forced clear. */
  readonly cleanup: (lease: ProductionSourceImportLease) => Promise<boolean>;
}): Promise<AcquireProviderWorkerLeaseResult> {
  const request = Object.freeze({ ...input.request });
  if (request.role !== "import") refuseSource("PRODUCTION_SOURCE_IMPORT_LEASE_INVALID");
  const result = await input.acquire(request);
  if (result.kind === "held") return result;
  if (result.lease.role !== "import" || result.lease.owner !== request.owner || result.lease.fence < 1n) {
    refuseSource("PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED");
  }
  const lease = Object.freeze({ role: result.lease.role, owner: result.lease.owner, fence: result.lease.fence });
  try { await input.postcheck(lease); return result; }
  catch (error) {
    let confirmed = false;
    try { confirmed = await input.cleanup(lease); } catch { /* Preserve uncertainty; no retry or success inference. */ }
    if (!confirmed) refuseSource("PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED");
    throw error;
  }
}
