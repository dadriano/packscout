import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { hashJson } from "./security.ts";
import { advanceSettledPublicWatermark } from "./public-change-settlement-repository.ts";
import { createPublicDerivationObligations } from "./public-change-settlement-repository.ts";

const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const failureCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const businessOutcomeReasonPattern = /^[a-z][a-z0-9_]{0,127}$/;

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
  readonly origin:
    | Readonly<{
        kind: "legacy_configuration";
        configurationRevisionId: string;
      }>
    | Readonly<{
        kind: "provider_source_revision";
        sourceInstanceId: string;
        sourceRevisionId: string;
      }>;
  readonly claimToken: string;
  readonly attemptCount: number;
  readonly originatingPublicChangeSequence: bigint;
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
    outcomeReasonCode?: string;
    originatingPublicChangeSequence?: bigint;
  }): Promise<boolean>;
  recordFailure(input: {
    requestId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureCode: string;
    maximumAttempts: number;
  }): Promise<"failed" | "lost" | "retrying">;
  retryTechnicalFailure(input: {
    requestId: string;
    retryAt: Date;
  }): Promise<"already_queued" | "not_failed" | "retried">;
}

interface ClaimedRequestRow {
  readonly id: string;
  readonly organization_id: string;
  readonly provider_id: string;
  readonly configuration_revision_id: string | null;
  readonly source_instance_id: string | null;
  readonly source_revision_id: string | null;
  readonly platform_key: string;
  readonly pack_external_id: string;
  readonly ev_input_external_id: string;
  readonly pack_revision_id: string | null;
  readonly ev_input_revision_id: string | null;
  readonly claim_token: string;
  readonly attempt_count: number;
  readonly request_key: string;
  readonly originating_public_change_sequence: bigint;
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

/** Enqueues/coalesces one normalized-source EV request in the caller's page transaction. */
export async function enqueueSourceEstimatedEvRecomputationInTransaction(
  database: PackscoutTransactionClient,
  input: EstimatedEvRecomputationIdentity & Readonly<{
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
    causeSequences: readonly bigint[];
    createdAt: Date;
  }>,
): Promise<{ requestId: string; created: boolean }> {
  if (input.causeSequences.length === 0) {
    throw new TypeError("Estimated EV recomputation requires a public change cause.");
  }
  if (input.packRevisionId === null || input.evInputRevisionId === null) {
    throw new TypeError("Estimated EV recomputation requires complete revision evidence.");
  }
  const requestKey = estimatedEvRecomputationRequestKey(input);
  const originatingPublicChangeSequence = [...input.causeSequences].sort(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  )[0]!;
  const inserted = await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    insert into public.estimated_ev_recomputation_requests (
      request_key, organization_id, provider_id, configuration_revision_id,
      source_instance_id, source_revision_id,
      platform_key, pack_external_id, ev_input_external_id,
      pack_revision_id, ev_input_revision_id,
      originating_public_change_sequence, available_at, created_at, updated_at
    ) values (
      ${requestKey}, ${input.organizationId}::uuid, ${input.providerId}::uuid, null,
      ${input.sourceInstanceId}::uuid, ${input.sourceRevisionId}::uuid,
      ${input.platformKey}, ${input.packExternalId}, ${input.evInputExternalId},
      ${input.packRevisionId}::uuid, ${input.evInputRevisionId}::uuid,
      ${originatingPublicChangeSequence}, ${input.createdAt}, ${input.createdAt},
      ${input.createdAt}
    )
    on conflict (request_key) do nothing
    returning id
  `);
  const existing = inserted[0]
    ? {
        id: inserted[0].id,
        configurationRevisionId: null,
        sourceInstanceId: input.sourceInstanceId,
        sourceRevisionId: input.sourceRevisionId,
      }
    : (
        await database.$queryRaw<Array<{
          id: string;
          configurationRevisionId: string | null;
          sourceInstanceId: string | null;
          sourceRevisionId: string | null;
        }>>(Prisma.sql`
          select id,
                 configuration_revision_id as "configurationRevisionId",
                 source_instance_id as "sourceInstanceId",
                 source_revision_id as "sourceRevisionId"
          from public.estimated_ev_recomputation_requests
          where request_key = ${requestKey}
          for update
        `)
      )[0];
  if (
    !existing ||
    existing.configurationRevisionId !== null ||
    existing.sourceInstanceId !== input.sourceInstanceId ||
    existing.sourceRevisionId !== input.sourceRevisionId
  ) {
    throw new Error(
      "Estimated EV request key is already owned by a different runtime origin.",
    );
  }
  await createPublicDerivationObligations(database, {
    organizationId: input.organizationId,
    causeSequences: input.causeSequences,
    derivationKind: "estimated_ev",
    derivationKey: requestKey,
    createdAt: input.createdAt,
  });
  return { requestId: existing.id, created: inserted.length === 1 };
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

function claimedOrigin(row: ClaimedRequestRow): ClaimedEstimatedEvRecomputation["origin"] {
  if (
    row.configuration_revision_id !== null &&
    row.source_instance_id === null &&
    row.source_revision_id === null
  ) {
    return {
      kind: "legacy_configuration",
      configurationRevisionId: row.configuration_revision_id,
    };
  }
  if (
    row.configuration_revision_id === null &&
    row.source_instance_id !== null &&
    row.source_revision_id !== null
  ) {
    return {
      kind: "provider_source_revision",
      sourceInstanceId: row.source_instance_id,
      sourceRevisionId: row.source_revision_id,
    };
  }
  throw new TypeError("Estimated EV request has an invalid runtime origin.");
}

export async function completeEstimatedEvRecomputation(
  database: PackscoutTransactionClient,
  input: {
    requestId: string;
    claimToken: string;
    completedAt: Date;
    resultStatus: "estimated" | "unavailable";
    calculationRevisionId: string;
    outcomeReasonCode?: string;
    originatingPublicChangeSequence?: bigint;
  },
): Promise<boolean> {
  const reasonCode = input.outcomeReasonCode ?? null;
  if (
    (input.resultStatus === "estimated" && reasonCode !== null) ||
    (input.resultStatus === "unavailable" &&
      (reasonCode === null || !businessOutcomeReasonPattern.test(reasonCode)))
  ) {
    throw new RangeError("Estimated EV outcome reason is invalid.");
  }
  const completed = await database.$queryRaw<Array<{
    organizationId: string;
    requestKey: string;
  }>>(Prisma.sql`
    update public.estimated_ev_recomputation_requests
    set state = 'completed'::public.estimated_ev_recomputation_state,
        result_status = cast(${input.resultStatus} as public.estimated_ev_recomputation_result),
        calculation_revision_id = ${input.calculationRevisionId}::uuid,
        claimed_by = null,
        claim_token = null,
        claim_expires_at = null,
        failure_code = null,
        completed_at = ${input.completedAt},
        updated_at = ${input.completedAt}
    where id = ${input.requestId}::uuid
      and state = 'running'::public.estimated_ev_recomputation_state
      and claim_token = ${input.claimToken}::uuid
      ${input.originatingPublicChangeSequence === undefined
        ? Prisma.empty
        : Prisma.sql`and originating_public_change_sequence = ${input.originatingPublicChangeSequence}`}
    returning organization_id as "organizationId", request_key as "requestKey"
  `);
  const request = completed[0];
  if (!request) {
    const repeated = await database.$queryRaw<Array<{ acknowledged: boolean }>>(
      Prisma.sql`
        select true as acknowledged
        from public.estimated_ev_recomputation_requests as request
        where request.id = ${input.requestId}::uuid
          and request.state = 'completed'::public.estimated_ev_recomputation_state
          and request.result_status = cast(
            ${input.resultStatus} as public.estimated_ev_recomputation_result
          )
          and request.calculation_revision_id = ${input.calculationRevisionId}::uuid
          ${input.originatingPublicChangeSequence === undefined
            ? Prisma.empty
            : Prisma.sql`and request.originating_public_change_sequence = ${input.originatingPublicChangeSequence}`}
          and exists (
            select 1
            from public.public_derivation_obligations as obligation
            where obligation.organization_id = request.organization_id
              and obligation.derivation_kind = 'estimated_ev'::public.public_derivation_kind
              and obligation.derivation_key = request.request_key
          )
          and not exists (
            select 1
            from public.public_derivation_obligations as obligation
            where obligation.organization_id = request.organization_id
              and obligation.derivation_kind = 'estimated_ev'::public.public_derivation_kind
              and obligation.derivation_key = request.request_key
              and (
                obligation.acknowledged_claim_token is distinct from ${input.claimToken}::uuid
                or obligation.state <> cast(
                  ${input.resultStatus === "estimated" ? "succeeded" : "business_unavailable"}
                  as public.public_derivation_state
                )
                or obligation.outcome_reason_code is distinct from ${reasonCode}
              )
          )
        limit 1
      `,
    );
    return repeated[0]?.acknowledged === true;
  }
  const acknowledged = await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    update public.public_derivation_obligations
    set state = cast(
          ${input.resultStatus === "estimated" ? "succeeded" : "business_unavailable"}
          as public.public_derivation_state
        ),
        claimed_by = null,
        claim_token = null,
        claim_expires_at = null,
        outcome_classification = cast(
          ${input.resultStatus === "estimated" ? "success" : "business_unavailable"}
          as public.public_derivation_outcome
        ),
        outcome_reason_code = ${reasonCode},
        acknowledged_claim_token = ${input.claimToken}::uuid,
        outcome_at = ${input.completedAt},
        updated_at = ${input.completedAt}
    where organization_id = ${request.organizationId}::uuid
      and derivation_kind = 'estimated_ev'::public.public_derivation_kind
      and derivation_key = ${request.requestKey}
      and state = 'claimed'::public.public_derivation_state
      and claim_token = ${input.claimToken}::uuid
    returning id
  `);
  const totals = await database.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    select count(*)::bigint as count
    from public.public_derivation_obligations
    where organization_id = ${request.organizationId}::uuid
      and derivation_kind = 'estimated_ev'::public.public_derivation_kind
      and derivation_key = ${request.requestKey}
  `);
  if (acknowledged.length === 0 || BigInt(acknowledged.length) !== totals[0]?.count) {
    throw new Error("Estimated EV obligations did not share the active claim.");
  }
  await advanceSettledPublicWatermark(database, {
    organizationId: request.organizationId,
    settledAt: input.completedAt,
  });
  return true;
}

export class PrismaEstimatedEvRecomputationRepository
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
                    requests.source_instance_id,
                    requests.source_revision_id,
                    requests.platform_key,
                    requests.pack_external_id,
                    requests.ev_input_external_id,
                    requests.pack_revision_id,
                    requests.ev_input_revision_id,
                    requests.request_key,
                    requests.originating_public_change_sequence,
                    requests.claim_token,
                    requests.attempt_count
        )
        select claimed.*
        from claimed
        inner join candidates on candidates.id = claimed.id
        order by candidates.available_at asc, candidates.created_at asc, candidates.id asc
      `);
      if (rows.length > 0) {
        const claims = rows.map((row) => Prisma.sql`(
          ${row.organization_id}::uuid, ${row.request_key},
          ${input.workerId}, ${row.claim_token}::uuid, ${claimExpiresAt}
        )`);
        await transaction.$executeRaw(Prisma.sql`
          update public.public_derivation_obligations as obligation
          set state = 'claimed'::public.public_derivation_state,
              claimed_by = claims.worker_id,
              claim_token = claims.claim_token,
              claim_expires_at = claims.claim_expires_at,
              outcome_classification = null,
              outcome_reason_code = null,
              acknowledged_claim_token = null,
              outcome_at = null,
              updated_at = ${input.now}
          from (values ${Prisma.join(claims)})
            as claims(
              organization_id, derivation_key, worker_id, claim_token,
              claim_expires_at
            )
          where obligation.organization_id = claims.organization_id
            and obligation.derivation_kind = 'estimated_ev'::public.public_derivation_kind
            and obligation.derivation_key = claims.derivation_key
            and obligation.state in (
              'pending'::public.public_derivation_state,
              'claimed'::public.public_derivation_state,
              'technical_failure'::public.public_derivation_state
            )
        `);
      }
      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        providerId: row.provider_id,
        origin: claimedOrigin(row),
        platformKey: row.platform_key,
        packExternalId: row.pack_external_id,
        evInputExternalId: row.ev_input_external_id,
        packRevisionId: row.pack_revision_id,
        evInputRevisionId: row.ev_input_revision_id,
        claimToken: row.claim_token,
        attemptCount: row.attempt_count,
        originatingPublicChangeSequence:
          row.originating_public_change_sequence,
      }));
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async complete(input: {
    requestId: string;
    claimToken: string;
    completedAt: Date;
    resultStatus: "estimated" | "unavailable";
    calculationRevisionId: string;
    outcomeReasonCode?: string;
    originatingPublicChangeSequence?: bigint;
  }): Promise<boolean> {
    return this.database.$transaction(
      (transaction) => completeEstimatedEvRecomputation(transaction, input),
      PACKSCOUT_TRANSACTION_OPTIONS,
    );
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
    return this.database.$transaction(async (transaction) => {
      const [updated] = await transaction.$queryRaw<Array<{
        state: "failed" | "queued";
        organizationId: string;
        requestKey: string;
      }>>(Prisma.sql`
        update public.estimated_ev_recomputation_requests
        set state = case
              when attempt_count >= ${maximumAttempts}
                then 'failed'::public.estimated_ev_recomputation_state
              else 'queued'::public.estimated_ev_recomputation_state
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
        where id = ${input.requestId}::uuid
          and state = 'running'::public.estimated_ev_recomputation_state
          and claim_token = ${input.claimToken}::uuid
        returning state,
                  organization_id as "organizationId",
                  request_key as "requestKey"
      `);
      if (!updated) {
        const repeated = await transaction.$queryRaw<Array<{
          state: "failed" | "queued";
        }>>(Prisma.sql`
          select request.state::text as state
          from public.estimated_ev_recomputation_requests as request
          where request.id = ${input.requestId}::uuid
            and request.state in (
              'queued'::public.estimated_ev_recomputation_state,
              'failed'::public.estimated_ev_recomputation_state
            )
            and exists (
              select 1
              from public.public_derivation_obligations as obligation
              where obligation.organization_id = request.organization_id
                and obligation.derivation_kind = 'estimated_ev'::public.public_derivation_kind
                and obligation.derivation_key = request.request_key
                and obligation.state = 'technical_failure'::public.public_derivation_state
                and obligation.acknowledged_claim_token = ${input.claimToken}::uuid
            )
          limit 1
        `);
        if (!repeated[0]) return "lost";
        return repeated[0].state === "failed" ? "failed" : "retrying";
      }
      const obligations = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        update public.public_derivation_obligations
        set state = 'technical_failure'::public.public_derivation_state,
            claimed_by = null,
            claim_token = null,
            claim_expires_at = null,
            outcome_classification = 'technical_failure'::public.public_derivation_outcome,
            outcome_reason_code = ${failureCode},
            acknowledged_claim_token = ${input.claimToken}::uuid,
            outcome_at = ${input.failedAt},
            updated_at = ${input.failedAt}
        where organization_id = ${updated.organizationId}::uuid
          and derivation_kind = 'estimated_ev'::public.public_derivation_kind
          and derivation_key = ${updated.requestKey}
          and state = 'claimed'::public.public_derivation_state
          and claim_token = ${input.claimToken}::uuid
        returning id
      `);
      const totals = await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        select count(*)::bigint as count
        from public.public_derivation_obligations
        where organization_id = ${updated.organizationId}::uuid
          and derivation_kind = 'estimated_ev'::public.public_derivation_kind
          and derivation_key = ${updated.requestKey}
      `);
      if (obligations.length === 0 || BigInt(obligations.length) !== totals[0]?.count) {
        throw new Error("Estimated EV obligations did not share the active claim.");
      }
      return updated.state === "failed" ? "failed" : "retrying";
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async retryTechnicalFailure(input: {
    requestId: string;
    retryAt: Date;
  }): Promise<"already_queued" | "not_failed" | "retried"> {
    return this.database.$transaction(async (transaction) => {
      const requests = await transaction.$queryRaw<Array<{
        organizationId: string;
        requestKey: string;
        state: "failed" | "queued" | "running" | "completed";
      }>>(Prisma.sql`
        select organization_id as "organizationId",
               request_key as "requestKey",
               state::text as state
        from public.estimated_ev_recomputation_requests
        where id = ${input.requestId}::uuid
        for update
      `);
      const request = requests[0];
      if (!request) return "not_failed";
      if (request.state === "queued") return "already_queued";
      if (request.state !== "failed") return "not_failed";
      await transaction.$executeRaw(Prisma.sql`
        update public.estimated_ev_recomputation_requests
        set state = 'queued'::public.estimated_ev_recomputation_state,
            attempt_count = 0,
            available_at = ${input.retryAt},
            failure_code = null,
            updated_at = ${input.retryAt}
        where id = ${input.requestId}::uuid
      `);
      await transaction.$executeRaw(Prisma.sql`
        update public.public_derivation_obligations
        set state = 'pending'::public.public_derivation_state,
            outcome_classification = null,
            outcome_reason_code = null,
            acknowledged_claim_token = null,
            outcome_at = null,
            updated_at = ${input.retryAt}
        where organization_id = ${request.organizationId}::uuid
          and derivation_kind = 'estimated_ev'::public.public_derivation_kind
          and derivation_key = ${request.requestKey}
          and state = 'technical_failure'::public.public_derivation_state
      `);
      return "retried";
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }
}
