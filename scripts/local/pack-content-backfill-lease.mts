import { z } from "zod";
import { lockProviderWorkerLease, PrismaProviderWorkerLeaseRepository,
  type ProviderPrismaClient, type ProviderWorkerLease } from "@packscout/database";
import { packContentBackfillDigest, packContentBackfillManifestSchema,
  type PackContentBackfillManifest } from "./pack-content-backfill-contract.mts";
import { readPackContentBackfillProgress } from "./pack-content-backfill-progress.mts";

export const PACK_CONTENT_BACKFILL_LEASE_ACTION = "local.pack_content_backfill.lease_claim";
const claimSchema = z.object({ manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  owner: z.string().min(1).max(256), expectedFence: z.string().regex(/^[1-9][0-9]*$/u) }).strict();
function refuse(): never { throw new Error("PACK_CONTENT_BACKFILL_LEASE_REFUSED"); }

/** An interrupted local operation may reclaim only its own proven expired fence. */
export async function acquirePackContentBackfillLease(input: {
  database: ProviderPrismaClient; manifest: PackContentBackfillManifest;
  revalidateAuthority(): Promise<void>;
}, leases: Pick<PrismaProviderWorkerLeaseRepository, "acquire" | "release"> = new PrismaProviderWorkerLeaseRepository(input.database)): Promise<ProviderWorkerLease> {
  const manifest = packContentBackfillManifestSchema.parse(input.manifest);
  const manifestDigest = packContentBackfillDigest(manifest);
  const owner = `local:chase-backfill:${manifest.operationId}`;
  await input.revalidateAuthority();
  const expectedFence = await input.database.$transaction(async tx => {
    const current = await lockProviderWorkerLease(tx, "import");
    await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
    await readPackContentBackfillProgress(tx, manifest);
    const rows = await tx.local_audit_events.findMany({ where: {
      correlation_id: manifest.operationId, action: PACK_CONTENT_BACKFILL_LEASE_ACTION,
    }, orderBy: { sequence: "asc" }, take: 101 });
    if (rows.length > 100) refuse();
    const claims = rows.map(row => {
      const claim = claimSchema.parse(row.details);
      if (row.outcome !== "success" || row.actor_operator_id !== manifest.operatorId ||
          row.target_type !== "provider" || row.target_id !== manifest.providerId ||
          claim.manifestDigest !== manifestDigest || claim.owner !== owner) refuse();
      return claim;
    });
    const nextFence = current.lease_fence + 1n;
    if (claims.some(claim => BigInt(claim.expectedFence) > nextFence) ||
        new Set(claims.map(claim => claim.expectedFence)).size !== claims.length) refuse();
    if (current.lease_owner !== null && (current.lease_owner !== owner ||
        current.lease_expires_at === null || current.lease_expires_at > current.database_now ||
        !claims.some(claim => BigInt(claim.expectedFence) === current.lease_fence))) refuse();
    if (!claims.some(claim => BigInt(claim.expectedFence) === nextFence)) {
      if (rows.length === 100) refuse();
      await tx.local_audit_events.create({ data: {
        correlation_id: manifest.operationId, actor_operator_id: manifest.operatorId,
        action: PACK_CONTENT_BACKFILL_LEASE_ACTION, target_type: "provider", target_id: manifest.providerId,
        outcome: "success", details: { manifestDigest, owner, expectedFence: nextFence.toString() },
        occurred_at: current.database_now,
      } });
    }
    return nextFence;
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 30000 });
  await input.revalidateAuthority();
  const acquired = await leases.acquire({ role: "import", owner, leaseMilliseconds: 600000 });
  if (acquired.kind === "held") return refuse();
  if (acquired.kind !== "acquired" || acquired.lease.owner !== owner || acquired.lease.fence !== expectedFence) {
    await leases.release(acquired.lease);
    return refuse();
  }
  return acquired.lease;
}
