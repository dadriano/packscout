import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import type { CentralPrismaClient } from "./central-database.ts";
import {
  providerPromotionInvocationProjectionRecord,
  type ProjectProviderPromotionInvocationInput,
  type ProviderPromotionInvocationProjection,
} from "./central-promotion-job-records.ts";
import {
  PROMOTION_JOB_INVOCATION_LIMIT,
  PROMOTION_JOB_INVOCATION_RETENTION_MS,
  PromotionJobPersistenceError,
  assertPromotionJobSha256,
  assertPromotionJobUuid,
  promotionJobSha256,
  validDate,
} from "./promotion-job-persistence-types.ts";

interface ProjectionRow {
  id: string;
  providerId: string;
  providerInvocationIdDigest: string;
  projectionDigest: string;
  triggerKind: ProviderPromotionInvocationProjection["triggerKind"];
  outcome: ProviderPromotionInvocationProjection["outcome"];
  scheduledCheckinAt: Date | null;
  startedAt: Date;
  finishedAt: Date;
  beforeLanePosition: bigint | null;
  afterLanePosition: bigint | null;
  beforeSettledPosition: bigint | null;
  afterSettledPosition: bigint | null;
  cycleCount: number;
  promotionAttemptCount: number;
  publicationCount: number;
  operationCount: number;
  safeFailureCode: string | null;
  canonicalDetailBody: string;
  canonicalDetailDigest: string;
  projectedAt: Date;
}

const TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.ReadCommitted,
});

const projection = CentralPrisma.sql`
  id::text as "id", provider_id::text as "providerId",
  provider_invocation_id_digest as "providerInvocationIdDigest",
  projection_digest as "projectionDigest", trigger_kind as "triggerKind",
  outcome, scheduled_checkin_at as "scheduledCheckinAt",
  started_at as "startedAt", finished_at as "finishedAt",
  before_lane_position as "beforeLanePosition",
  after_lane_position as "afterLanePosition",
  before_settled_position as "beforeSettledPosition",
  after_settled_position as "afterSettledPosition",
  cycle_count as "cycleCount",
  promotion_attempt_count as "promotionAttemptCount",
  publication_count as "publicationCount",
  operation_count as "operationCount", safe_failure_code as "safeFailureCode",
  canonical_detail_body as "canonicalDetailBody",
  canonical_detail_digest as "canonicalDetailDigest",
  projected_at as "projectedAt"
`;

/** Central monitoring copy; inserts evidence but never admits provider work. */
export class PrismaProviderPromotionInvocationProjectionRepository {
  constructor(private readonly central: CentralPrismaClient) {}

  async project(
    input: ProjectProviderPromotionInvocationInput,
  ): Promise<ProviderPromotionInvocationProjection> {
    const record = providerPromotionInvocationProjectionRecord(input);
    return this.central.$transaction(async (transaction) => {
      await transaction.$executeRaw(CentralPrisma.sql`
        insert into provider_promotion_invocation_projections (
          provider_id, provider_invocation_id_digest, projection_digest,
          trigger_kind, outcome, scheduled_checkin_at, started_at, finished_at,
          before_lane_position, after_lane_position,
          before_settled_position, after_settled_position,
          cycle_count, promotion_attempt_count, publication_count,
          operation_count, safe_failure_code, canonical_detail_body,
          canonical_detail_digest, projected_at, created_at
        ) values (
          ${input.providerId}::uuid, ${record.providerInvocationIdDigest},
          ${record.projectionDigest}, ${input.triggerKind}, ${input.outcome},
          ${input.scheduledCheckinAt}, ${input.startedAt}, ${input.finishedAt},
          ${input.progress.beforeLanePosition}, ${input.progress.afterLanePosition},
          ${input.progress.beforeSettledPosition},
          ${input.progress.afterSettledPosition}, ${input.progress.cycleCount},
          ${input.progress.promotionAttemptCount},
          ${input.progress.publicationCount}, ${input.progress.operationCount},
          ${input.safeFailureCode}, ${record.canonicalDetailBody},
          ${record.canonicalDetailDigest}, ${input.projectedAt},
          ${input.projectedAt}
        ) on conflict (provider_id, provider_invocation_id_digest) do nothing
      `);
      const [row] = await transaction.$queryRaw<ProjectionRow[]>(CentralPrisma.sql`
        select ${projection} from provider_promotion_invocation_projections
        where provider_id = ${input.providerId}::uuid
          and provider_invocation_id_digest =
            ${record.providerInvocationIdDigest}
        for share
      `);
      if (!row || row.projectionDigest !== record.projectionDigest) {
        throw new PromotionJobPersistenceError(
          "PROMOTION_JOB_PROJECTION_CONFLICT",
        );
      }
      return mapProjection(row);
    }, TRANSACTION);
  }

  async loadByDigest(input: Readonly<{
    providerId: string;
    providerInvocationIdDigest: string;
  }>): Promise<ProviderPromotionInvocationProjection | null> {
    assertPromotionJobUuid(input.providerId);
    assertPromotionJobSha256(input.providerInvocationIdDigest);
    const [row] = await this.central.$queryRaw<ProjectionRow[]>(CentralPrisma.sql`
      select ${projection} from provider_promotion_invocation_projections
      where provider_id = ${input.providerId}::uuid
        and provider_invocation_id_digest =
          ${input.providerInvocationIdDigest}
    `);
    return row ? mapProjection(row) : null;
  }

  async prune(input: Readonly<{
    providerId: string;
    now: Date;
    maximumRows?: number;
  }>): Promise<Readonly<{ deleted: number; moreEligible: boolean }>> {
    assertPromotionJobUuid(input.providerId);
    const maximumRows = input.maximumRows ?? 1_000;
    if (!validDate(input.now) || !Number.isSafeInteger(maximumRows)
      || maximumRows < 1 || maximumRows > 10_000) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
    const cutoff = new Date(
      input.now.getTime() - PROMOTION_JOB_INVOCATION_RETENTION_MS,
    );
    const rows = await this.central.$queryRaw<Array<{ id: string }>>(
      CentralPrisma.sql`
        with ranked as (
          select id, row_number() over (
            order by finished_at desc, id desc
          ) as retained_rank
          from provider_promotion_invocation_projections
          where provider_id = ${input.providerId}::uuid
        ), eligible as (
          select item.id
          from provider_promotion_invocation_projections item
          join ranked on ranked.id = item.id
          where item.provider_id = ${input.providerId}::uuid
            and (item.finished_at <= ${cutoff}
              or ranked.retained_rank > ${PROMOTION_JOB_INVOCATION_LIMIT})
          order by item.finished_at, item.id
          limit ${maximumRows}
        )
        delete from provider_promotion_invocation_projections item
        using eligible where item.id = eligible.id
        returning item.id::text as "id"
      `,
    );
    return { deleted: rows.length, moreEligible: rows.length === maximumRows };
  }
}

function mapProjection(row: ProjectionRow): ProviderPromotionInvocationProjection {
  if (promotionJobSha256(row.canonicalDetailBody)
    !== row.canonicalDetailDigest) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_PROJECTION_CONFLICT");
  }
  return {
    id: row.id,
    providerId: row.providerId.toLowerCase(),
    providerInvocationIdDigest: row.providerInvocationIdDigest,
    projectionDigest: row.projectionDigest,
    triggerKind: row.triggerKind,
    outcome: row.outcome,
    scheduledCheckinAt: row.scheduledCheckinAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    progress: {
      beforeLanePosition: row.beforeLanePosition,
      afterLanePosition: row.afterLanePosition,
      beforeSettledPosition: row.beforeSettledPosition,
      afterSettledPosition: row.afterSettledPosition,
      cycleCount: row.cycleCount,
      promotionAttemptCount: row.promotionAttemptCount,
      publicationCount: row.publicationCount,
      operationCount: row.operationCount,
    },
    safeFailureCode: row.safeFailureCode,
    canonicalDetailBody: row.canonicalDetailBody,
    canonicalDetailDigest: row.canonicalDetailDigest,
    projectedAt: row.projectedAt,
  };
}
