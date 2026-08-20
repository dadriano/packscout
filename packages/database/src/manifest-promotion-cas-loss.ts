import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import { parseManifestCasErrorBody } from
  "./manifest-promotion-repository-validation.ts";
import {
  PromotionV2PersistenceError,
  finiteDate,
  promotionV2Sha256,
  type PromotionV2ScopeBinding,
} from "./promotion-v2-types.ts";
import { assertPromotionAttemptBootstrapProof } from
  "./promotion-v2-bootstrap-proof-guard.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export async function deferManifestPromotionCasLoss(
  database: PackscoutPrismaClient,
  binding: PromotionV2ScopeBinding,
  input: Readonly<{
    attemptId: string;
    claimToken: string;
    canonicalErrorBody: string;
    observedAt: Date;
    retryAt: Date;
  }>,
): Promise<boolean> {
  if (!finiteDate(input.observedAt) || !finiteDate(input.retryAt) ||
    input.retryAt <= input.observedAt) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
  }
  const failureCode = parseManifestCasErrorBody(input.canonicalErrorBody);
  return database.$transaction(async (transaction) => {
    const rows = await transaction.$queryRaw<Array<{
      state: string;
      claimToken: string | null;
      claimExpiresAt: Date | null;
      casErrorBody: string | null;
      bootstrapProofRevision: bigint;
      bootstrapProviderSetSha256: string;
    }>>(Prisma.sql`
      select state, claim_token::text as "claimToken",
             claim_expires_at as "claimExpiresAt",
             cas_error_body as "casErrorBody",
             bootstrap_proof_revision as "bootstrapProofRevision",
             bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256"
      from public.manifest_promotion_attempts
      where id = ${uuid(input.attemptId)}
        and organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
      for update
    `);
    const attempt = rows[0];
    if (!attempt || attempt.claimToken !== input.claimToken ||
      attempt.claimExpiresAt === null ||
      attempt.claimExpiresAt <= input.observedAt ||
      !["assembling", "ready", "in_progress"].includes(attempt.state)) {
      return false;
    }
    if (attempt.casErrorBody !== null &&
      attempt.casErrorBody !== input.canonicalErrorBody) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_CONFLICT");
    }
    await assertPromotionAttemptBootstrapProof(transaction, binding, {
      attemptId: input.attemptId,
      bootstrapProofRevision: attempt.bootstrapProofRevision,
      bootstrapProviderSetSha256: attempt.bootstrapProviderSetSha256,
      lane: "manifest",
      allowSentRecovery: true,
    });
    const sent = await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      select count(*)::bigint as count
      from public.manifest_promotion_operations
      where attempt_id = ${uuid(input.attemptId)} and state = 'sent'
    `);
    if (sent[0]?.count !== 1n) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
    }
    await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_attempts
      set state = 'retry_wait', retry_count = retry_count + 1,
          retry_at = ${input.retryAt}, failure_class = 'reconciliation',
          failure_code = ${failureCode},
          cas_error_body = ${input.canonicalErrorBody},
          cas_error_sha256 = ${promotionV2Sha256(input.canonicalErrorBody)},
          claim_owner = null, claim_token = null, claim_expires_at = null,
          last_heartbeat_at = null, updated_at = ${input.observedAt}
      where id = ${uuid(input.attemptId)}
    `);
    await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_lanes
      set next_retry_at = ${input.retryAt}, updated_at = ${input.observedAt}
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
    `);
    return true;
  }, PACKSCOUT_TRANSACTION_OPTIONS);
}
