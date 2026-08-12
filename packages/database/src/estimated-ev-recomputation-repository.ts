import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import { hashJson } from "./security.ts";

const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const failureCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;

export interface EstimatedEvRecomputationIdentity {
  readonly organizationId: string;
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly evInputExternalId: string;
  readonly packRevisionId: string | null;
  readonly evInputRevisionId: string | null;
}

export interface ClaimedEstimatedEvRecomputation
  extends EstimatedEvRecomputationIdentity {
  readonly id: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly claimToken: string;
  readonly attemptCount: number;
}

export interface EstimatedEvRecomputationQueuePort {
  claimBatch(input: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMilliseconds: number;
  }): Promise<readonly ClaimedEstimatedEvRecomputation[]>;
  complete(input: {
    requestId: string;
    claimToken: string;
    completedAt: Date;
    resultStatus: "estimated" | "unavailable";
    calculationRevisionId: string;
  }): Promise<boolean>;
  recordFailure(input: {
    requestId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureCode: string;
    maximumAttempts: number;
  }): Promise<"failed" | "lost" | "retrying">;
}

interface ClaimedRequestRow {
  readonly id: string;
  readonly organization_id: string;
  readonly provider_id: string;
  readonly configuration_revision_id: string;
  readonly platform_key: string;
  readonly pack_external_id: string;
  readonly ev_input_external_id: string;
  readonly pack_revision_id: string | null;
  readonly ev_input_revision_id: string | null;
  readonly claim_token: string;
  readonly attempt_count: number;
}

export function estimatedEvRecomputationRequestKey(
  input: EstimatedEvRecomputationIdentity,
): string {
  return hashJson({
    version: "estimated-ev-recomputation-v1",
    organizationId: input.organizationId,
    platformKey: input.platformKey,
    packExternalId: input.packExternalId,
    evInputExternalId: input.evInputExternalId,
    packRevisionId: input.packRevisionId,
    evInputRevisionId: input.evInputRevisionId,
  });
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is outside its safe bounds.`);
  }
  return value;
}

export class DrizzleEstimatedEvRecomputationRepository
  implements EstimatedEvRecomputationQueuePort
{
  constructor(private readonly database: PackscoutPrismaClient) {}

  async claimBatch(input: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMilliseconds: number;
  }): Promise<readonly ClaimedEstimatedEvRecomputation[]> {
    if (!workerIdPattern.test(input.workerId)) {
      throw new RangeError("Estimated EV worker ID is invalid.");
    }
    const limit = boundedInteger(input.limit, 1, 100, "Estimated EV claim limit");
    const leaseMilliseconds = boundedInteger(
      input.leaseMilliseconds,
      1_000,
      15 * 60_000,
      "Estimated EV claim lease",
    );
    const claimExpiresAt = new Date(input.now.getTime() + leaseMilliseconds);
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<ClaimedRequestRow[]>(Prisma.sql`
        with candidates as (
          select id, available_at, created_at
          from estimated_ev_recomputation_requests
          where (
              state = 'queued'::estimated_ev_recomputation_state
              and available_at <= ${input.now}
            ) or (
              state = 'running'::estimated_ev_recomputation_state
              and claim_expires_at <= ${input.now}
            )
          order by available_at asc, created_at asc, id asc
          for update skip locked
          limit ${limit}
        ), claimed as (
          update estimated_ev_recomputation_requests as requests
          set state = 'running'::estimated_ev_recomputation_state,
              claimed_by = ${input.workerId},
              claim_token = gen_random_uuid(),
              claim_expires_at = ${claimExpiresAt},
              attempt_count = requests.attempt_count + 1,
              failure_code = null,
              updated_at = ${input.now}
          from candidates
          where requests.id = candidates.id
          returning requests.id,
                    requests.organization_id,
                    requests.provider_id,
                    requests.configuration_revision_id,
                    requests.platform_key,
                    requests.pack_external_id,
                    requests.ev_input_external_id,
                    requests.pack_revision_id,
                    requests.ev_input_revision_id,
                    requests.claim_token,
                    requests.attempt_count
        )
        select claimed.*
        from claimed
        inner join candidates on candidates.id = claimed.id
        order by candidates.available_at asc, candidates.created_at asc, candidates.id asc
      `);
      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        providerId: row.provider_id,
        configurationRevisionId: row.configuration_revision_id,
        platformKey: row.platform_key,
        packExternalId: row.pack_external_id,
        evInputExternalId: row.ev_input_external_id,
        packRevisionId: row.pack_revision_id,
        evInputRevisionId: row.ev_input_revision_id,
        claimToken: row.claim_token,
        attemptCount: row.attempt_count,
      }));
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async complete(input: {
    requestId: string;
    claimToken: string;
    completedAt: Date;
    resultStatus: "estimated" | "unavailable";
    calculationRevisionId: string;
  }): Promise<boolean> {
    const completed = await this.database.estimated_ev_recomputation_requests.updateMany({
      where: {
        id: input.requestId,
        state: "running",
        claim_token: input.claimToken,
      },
      data: {
        state: "completed",
        result_status: input.resultStatus,
        calculation_revision_id: input.calculationRevisionId,
        claimed_by: null,
        claim_token: null,
        claim_expires_at: null,
        failure_code: null,
        completed_at: input.completedAt,
        updated_at: input.completedAt,
      },
    });
    return completed.count === 1;
  }

  async recordFailure(input: {
    requestId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureCode: string;
    maximumAttempts: number;
  }): Promise<"failed" | "lost" | "retrying"> {
    const maximumAttempts = boundedInteger(
      input.maximumAttempts,
      1,
      20,
      "Estimated EV maximum attempts",
    );
    const failureCode = failureCodePattern.test(input.failureCode)
      ? input.failureCode
      : "ESTIMATED_EV_RECOMPUTATION_FAILED";
    const [updated] = await this.database.$queryRaw<
      { state: "failed" | "queued" }[]
    >(Prisma.sql`
      update estimated_ev_recomputation_requests
      set state = case
            when attempt_count >= ${maximumAttempts}
              then 'failed'::estimated_ev_recomputation_state
            else 'queued'::estimated_ev_recomputation_state
          end,
          available_at = case
            when attempt_count >= ${maximumAttempts} then ${input.failedAt}
            else ${input.retryAt}
          end,
          claimed_by = null,
          claim_token = null,
          claim_expires_at = null,
          failure_code = ${failureCode},
          updated_at = ${input.failedAt}
      where id = cast(${input.requestId} as uuid)
        and state = 'running'::estimated_ev_recomputation_state
        and claim_token = cast(${input.claimToken} as uuid)
      returning state
    `);
    if (!updated) return "lost";
    return updated.state === "failed" ? "failed" : "retrying";
  }
}
