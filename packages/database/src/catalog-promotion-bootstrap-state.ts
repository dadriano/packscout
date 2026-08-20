import { canonicalJson } from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import { loadManifestEligibilitySnapshotInTransaction } from
  "./public-change-settlement-repository.provider-read.ts";
import { loadCatalogPromotionBootstrapProof } from
  "./catalog-promotion-bootstrap-proof-read.ts";
import {
  PromotionV2PersistenceError,
  promotionV2Sha256,
  type PromotionV2ScopeBinding,
} from "./promotion-v2-types.ts";

export type CatalogPromotionBootstrapState =
  | "unverified"
  | "reproof_required"
  | "verified_empty"
  | "verified_cleared"
  | "verified_active";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export async function loadCatalogPromotionBootstrapState(
  database: PackscoutPrismaClient,
  binding: PromotionV2ScopeBinding,
): Promise<CatalogPromotionBootstrapState> {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRaw(Prisma.sql`set transaction read only`);
    const rows = await transaction.$queryRaw<Array<{
      bootstrapState: Exclude<CatalogPromotionBootstrapState, "reproof_required">;
      providerSetBody: string | null;
      providerSetSha256: string | null;
      currentProofRevision: bigint | null;
    }>>(Prisma.sql`
      select bootstrap_state as "bootstrapState",
             bootstrap_provider_set_body as "providerSetBody",
             bootstrap_provider_set_sha256 as "providerSetSha256",
             current_bootstrap_proof_revision as "currentProofRevision"
      from public.manifest_promotion_lanes
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
    `);
    const lane = rows[0];
    if (!lane || lane.bootstrapState === "unverified") return "unverified";
    if (lane.providerSetBody === null || lane.providerSetSha256 === null ||
      lane.currentProofRevision === null ||
      promotionV2Sha256(lane.providerSetBody) !== lane.providerSetSha256) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
    const proof = await loadCatalogPromotionBootstrapProof(
      transaction,
      binding,
    );
    if (proof === null || proof.proofRevision !== lane.currentProofRevision) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNPROVEN");
    }
    const eligibility = await loadManifestEligibilitySnapshotInTransaction(
      transaction, { organizationId: binding.organizationId },
    );
    if (!eligibility || lane.providerSetBody !== canonicalJson(
      eligibility.configuredPlatformKeys,
    )) {
      const recovery = await transaction.$queryRaw<Array<{
        pending: boolean;
      }>>(Prisma.sql`
        select exists (
          select 1
          from public.provider_promotion_operations as operation
          join public.provider_promotion_attempts as attempt
            on attempt.id = operation.attempt_id
           and attempt.organization_id = operation.organization_id
           and attempt.deployment_key = operation.deployment_key
           and attempt.platform_key = operation.platform_key
          where operation.organization_id = ${uuid(binding.organizationId)}
            and operation.deployment_key = ${binding.deploymentKey}
            and operation.send_count > 0
            and attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
          union all
          select 1
          from public.manifest_promotion_operations as operation
          join public.manifest_promotion_attempts as attempt
            on attempt.id = operation.attempt_id
           and attempt.organization_id = operation.organization_id
           and attempt.deployment_key = operation.deployment_key
          where operation.organization_id = ${uuid(binding.organizationId)}
            and operation.deployment_key = ${binding.deploymentKey}
            and operation.send_count > 0
            and attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
          limit 1
        ) as pending
      `);
      return recovery[0]?.pending === true
        ? lane.bootstrapState : "reproof_required";
    }
    return lane.bootstrapState;
  }, {
    ...PACKSCOUT_TRANSACTION_OPTIONS,
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}
