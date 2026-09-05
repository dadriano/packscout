import {
  PROFILE_SNAPSHOT_HASH_DOMAIN, hashPackCatalogValue, packCatalogCanonicalJson, packCatalogUuidSchema,
  type PackCatalogEnvironment, type PublicProfileSnapshotIdentity,
} from "@packscout/contracts";
import { SharedPublicationPersistenceError, sharedInvariant, sharedParse } from "./central-publication-input.ts";
export { SharedPublicationPersistenceError, sharedInvariant, sharedBound, sharedParse, captureSharedInput } from "./central-publication-input.ts";
import { Prisma } from "../prisma/generated/central/index.js";
import type { CentralPrismaClient, CentralTransactionClient } from "./central-database.ts";

export const sharedPublicationLimits = Object.freeze({ providers: 1_000, profiles: 100, claimBatch: 25,
  leaseSeconds: 60, maximumLeaseSeconds: 300, maximumAttempts: 100, maximumOperations: 100, retrySeconds: 86_400 });
export const sharedEqual = (a: unknown, b: unknown) => packCatalogCanonicalJson(a) === packCatalogCanonicalJson(b);
export const profileHash = (value: unknown) => hashPackCatalogValue(PROFILE_SNAPSHOT_HASH_DOMAIN, value);
export function profileKey(identity: PublicProfileSnapshotIdentity) {
  return { profile_kind: identity.profileKind, entity_id: identity.profileKind === "provider" ? identity.providerId : identity.publicCollectibleId };
}
export interface ProfileWorkClaim {
  organizationId: string; profileKind: "provider" | "collectible"; entityId: string;
  intentId: string; owner: string; fence: string; expiresAt: string;
}

/** Server-only capability, constructed from trusted central lifecycle and deployment scope.
 * P06 authenticates transports; no browser adapter or database locator is exposed. */
export class CentralProfilePublicationContext {
  readonly organizationId: string;
  constructor(readonly client: CentralPrismaClient, organizationId: string, readonly environment: PackCatalogEnvironment) {
    this.organizationId = sharedParse(packCatalogUuidSchema, organizationId);
    sharedInvariant(["local", "preproduction", "live"].includes(environment), "SHARED_INPUT_INVALID");
  }
  get where() { return { organization_id: this.organizationId }; }
  async transaction<T>(run: (tx: CentralTransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.$transaction(async tx => {
          const identity = await tx.database_identity.findUnique({ where: { singleton_key: true } });
          sharedInvariant(identity?.database_role === "central", "SHARED_SCOPE_MISMATCH");
          return run(tx);
        }, { isolationLevel: "Serializable", maxWait: 5_000, timeout: 30_000 });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && attempt < 2 &&
          (error.code === "P2034" || (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code))))) continue;
        if (error instanceof SharedPublicationPersistenceError) throw error;
        throw new SharedPublicationPersistenceError("SHARED_PERSISTENCE_FAILED");
      }
    }
  }
  async now(tx: CentralTransactionClient) {
    return (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
  }
  async lockProfile(tx: CentralTransactionClient, claim: ProfileWorkClaim) {
    for (const id of [claim.organizationId, claim.entityId, claim.intentId, claim.owner]) sharedParse(packCatalogUuidSchema, id);
    sharedInvariant(typeof claim.fence === "string" && /^[1-9][0-9]{0,17}$/u.test(claim.fence), "SHARED_INPUT_INVALID");
    sharedInvariant(claim.organizationId === this.organizationId, "SHARED_SCOPE_MISMATCH");
    const rows = await tx.$queryRaw<Array<{ generation: bigint; active_snapshot_id: string | null; lease_expires_at: Date }>>`
      SELECT generation, active_snapshot_id, lease_expires_at FROM profile_publication_heads
      WHERE organization_id = ${this.organizationId}::uuid AND profile_kind = ${claim.profileKind}
        AND entity_id = ${claim.entityId}::uuid AND lease_intent_id = ${claim.intentId}::uuid
        AND lease_owner = ${claim.owner}::uuid AND lease_fence = ${BigInt(claim.fence)}
        AND lease_expires_at > clock_timestamp() FOR UPDATE`;
    sharedInvariant(rows[0], "SHARED_LEASE_LOST");
    const work = await tx.profile_activation_intents.findFirst({ where: { ...this.where, id: claim.intentId,
      profile_kind: claim.profileKind, entity_id: claim.entityId, state: "publishing" } });
    sharedInvariant(work, "SHARED_LEASE_LOST"); return { ...rows[0], work };
  }
  async assertUnexpired(tx: CentralTransactionClient, expiresAt: Date) {
    sharedInvariant(expiresAt.getTime() > (await this.now(tx)).getTime(), "SHARED_LEASE_LOST");
  }
  async releaseProfile(tx: CentralTransactionClient, claim: ProfileWorkClaim) {
    const changed = await tx.$executeRaw`UPDATE profile_publication_heads SET lease_owner = NULL,
      lease_intent_id = NULL, lease_expires_at = NULL WHERE organization_id = ${this.organizationId}::uuid
      AND profile_kind = ${claim.profileKind} AND entity_id = ${claim.entityId}::uuid
      AND lease_intent_id = ${claim.intentId}::uuid AND lease_owner = ${claim.owner}::uuid
      AND lease_fence = ${BigInt(claim.fence)} AND lease_expires_at > clock_timestamp()`;
    sharedInvariant(changed === 1, "SHARED_LEASE_LOST");
  }
}
