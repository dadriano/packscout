import { canonicalJson } from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import { loadManifestEligibilitySnapshotInTransaction } from
  "./public-change-settlement-repository.provider-read.ts";
import {
  PromotionV2PersistenceError,
  promotionV2Sha256,
  type PromotionV2ScopeBinding,
} from "./promotion-v2-types.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export async function lockPromotionConfigurationScope(
  transaction: PackscoutTransactionClient,
  binding: PromotionV2ScopeBinding,
): Promise<void> {
  const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    select id::text
    from public.organizations
    where id = ${uuid(binding.organizationId)}
    for update
  `);
  if (locked.length !== 1) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
}

export async function promotionAttemptBootstrapProofIsCurrent(
  transaction: PackscoutTransactionClient,
  binding: PromotionV2ScopeBinding,
  attempt: Readonly<{
    bootstrapProofRevision: bigint;
    bootstrapProviderSetSha256: string;
  }>,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{
    proofRevision: bigint | null;
    providerSetBody: string | null;
    providerSetSha256: string | null;
  }>>(Prisma.sql`
    select current_bootstrap_proof_revision as "proofRevision",
           bootstrap_provider_set_body as "providerSetBody",
           bootstrap_provider_set_sha256 as "providerSetSha256"
    from public.manifest_promotion_lanes
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
  `);
  const lane = rows[0];
  if (!lane || lane.proofRevision === null || lane.providerSetBody === null ||
    lane.providerSetSha256 === null ||
    promotionV2Sha256(lane.providerSetBody) !== lane.providerSetSha256 ||
    attempt.bootstrapProofRevision !== lane.proofRevision ||
    attempt.bootstrapProviderSetSha256 !== lane.providerSetSha256) return false;
  const eligibility = await loadManifestEligibilitySnapshotInTransaction(
    transaction, { organizationId: binding.organizationId },
  );
  return eligibility !== null && lane.providerSetBody === canonicalJson(
    eligibility.configuredPlatformKeys,
  );
}

export async function assertPromotionAttemptBootstrapProof(
  transaction: PackscoutTransactionClient,
  binding: PromotionV2ScopeBinding,
  input: Readonly<{
    attemptId: string;
    bootstrapProofRevision: bigint;
    bootstrapProviderSetSha256: string;
    lane: "provider" | "manifest";
    allowSentRecovery: boolean;
  }>,
): Promise<void> {
  if (await promotionAttemptBootstrapProofIsCurrent(
    transaction, binding, input,
  )) return;
  if (input.allowSentRecovery) {
    const dispatched = input.lane === "provider"
      ? await transaction.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
          select exists (
            select 1 from public.provider_promotion_operations
            where attempt_id = ${uuid(input.attemptId)} and send_count > 0
          ) as present
        `)
      : await transaction.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
          select exists (
            select 1 from public.manifest_promotion_operations
            where attempt_id = ${uuid(input.attemptId)} and send_count > 0
          ) as present
        `);
    if (dispatched[0]?.present === true) return;
  }
  throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNVERIFIED");
}
