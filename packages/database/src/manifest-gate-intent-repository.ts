import { randomUUID } from "node:crypto";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import type {
  CentralPrismaClient,
  CentralTransactionClient,
} from "./central-database.ts";
import {
  assertManifestGateIntentInput,
  type ManifestGateClaim,
  type ManifestGateExplicitOperation,
  type ManifestGateIntent,
} from "./central-promotion-job-records.ts";
import {
  PromotionJobPersistenceError,
  assertPromotionJobSha256,
  assertPromotionJobUuid,
  validDate,
  type ManifestReconciliationWakeCause,
} from "./promotion-job-persistence-types.ts";
import { PrismaManifestReconciliationJobRepository } from
  "./manifest-reconciliation-job-repository.ts";

interface GateRow {
  providerId: string;
  requestedGeneration: bigint;
  acknowledgedGeneration: bigint;
  latestCause: ManifestReconciliationWakeCause | null;
  latestEvidenceDigest: string | null;
  latestRequestedAt: Date | null;
  providerSourceGeneration: bigint | null;
  providerSourceGateGeneration: bigint | null;
  providerSourceCause: ManifestReconciliationWakeCause | null;
  providerSourceEvidenceDigest: string | null;
  providerSourceRequestedAt: Date | null;
  operationGeneration: bigint | null;
  operationRequestedAt: Date | null;
  requestedOperation: ManifestGateExplicitOperation | null;
  targetProviderReleaseId: string | null;
  targetCatalogVersionId: string | null;
  requestedByOperatorId: string | null;
  authorizationDigest: string | null;
  claimOwner: string | null;
  claimToken: string | null;
  claimedGeneration: bigint | null;
  claimedWorkKind: "provider_source" | "explicit" | null;
  claimedSourceGeneration: bigint | null;
  claimedCause: ManifestReconciliationWakeCause | null;
  claimedEvidenceDigest: string | null;
  claimedRequestedAt: Date | null;
  claimExpiresAt: Date | null;
  attemptCount: number;
  lastAttemptedAt: Date | null;
  retryAt: Date | null;
  lastFailureCode: string | null;
}

interface ClaimRow extends GateRow {
  organizationId: string;
  providerKey: string;
  providerLifecycle: "draft" | "active" | "disabled" | "archived";
  providerRowVersion: bigint;
}

const TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.ReadCommitted,
});
const VERIFY_TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.RepeatableRead,
});

interface ManifestGateTransactionDeadline {
  readonly deadlineAt: number;
}

function transactionOptions<T extends Readonly<{
  maxWait: number;
  timeout: number;
  isolationLevel: CentralPrisma.TransactionIsolationLevel;
}>>(base: T, deadline?: ManifestGateTransactionDeadline) {
  if (deadline === undefined) return base;
  const available = Math.floor(deadline.deadlineAt - Date.now() - 50);
  const maxWait = Math.min(base.maxWait, Math.max(1, Math.floor(available / 5)));
  const timeout = Math.min(base.timeout, available - maxWait);
  if (timeout < 1) {
    throw new PromotionJobPersistenceError("PROMOTION_JOB_DEADLINE_EXCEEDED");
  }
  return { ...base, maxWait, timeout };
}

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const MAX_CLAIM_MILLISECONDS = 15 * 60_000;

const projection = CentralPrisma.sql`
  provider_id::text as "providerId",
  requested_generation as "requestedGeneration",
  acknowledged_generation as "acknowledgedGeneration",
  latest_cause as "latestCause",
  latest_evidence_digest as "latestEvidenceDigest",
  latest_requested_at as "latestRequestedAt",
  provider_source_generation as "providerSourceGeneration",
  provider_source_gate_generation as "providerSourceGateGeneration",
  provider_source_cause as "providerSourceCause",
  provider_source_evidence_digest as "providerSourceEvidenceDigest",
  provider_source_requested_at as "providerSourceRequestedAt",
  operation_generation as "operationGeneration",
  operation_requested_at as "operationRequestedAt",
  requested_operation::text as "requestedOperation",
  target_provider_release_id::text as "targetProviderReleaseId",
  target_catalog_version_id::text as "targetCatalogVersionId",
  requested_by_operator_id::text as "requestedByOperatorId",
  authorization_digest as "authorizationDigest",
  claim_owner as "claimOwner",
  claim_token::text as "claimToken",
  claimed_generation as "claimedGeneration",
  claimed_work_kind as "claimedWorkKind",
  claimed_source_generation as "claimedSourceGeneration",
  claimed_cause as "claimedCause",
  claimed_evidence_digest as "claimedEvidenceDigest",
  claimed_requested_at as "claimedRequestedAt",
  claim_expires_at as "claimExpiresAt",
  attempt_count as "attemptCount",
  last_attempted_at as "lastAttemptedAt",
  retry_at as "retryAt",
  last_failure_code as "lastFailureCode"
`;

function assertClaimInput(input: Readonly<{
  owner: string;
  now: Date;
  claimMilliseconds: number;
}>): void {
  if (
    !OWNER_PATTERN.test(input.owner) ||
    !validDate(input.now) ||
    !Number.isSafeInteger(input.claimMilliseconds) ||
    input.claimMilliseconds < 1_000 ||
    input.claimMilliseconds > MAX_CLAIM_MILLISECONDS
  ) throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
}

function explicitPairValid(input: Readonly<{
  operation: ManifestGateExplicitOperation;
  targetProviderReleaseId: string | null;
  targetCatalogVersionId: string | null;
}>): boolean {
  return input.operation === "remove"
    ? input.targetProviderReleaseId === null &&
      input.targetCatalogVersionId === null
    : input.targetProviderReleaseId !== null &&
      input.targetCatalogVersionId !== null;
}

function sameDate(left: Date | null, right: Date | null): boolean {
  return left === null ? right === null
    : right !== null && left.getTime() === right.getTime();
}

/** A claim exposes exactly one ordered work item even when another item was
 * accepted later into the same provider row. */
function effectiveClaimRow(row: ClaimRow): ClaimRow {
  if (row.claimedWorkKind === "explicit") {
    return {
      ...row,
      latestCause: row.claimedCause,
      latestEvidenceDigest: row.claimedEvidenceDigest,
      latestRequestedAt: row.claimedRequestedAt,
    };
  }
  if (row.claimedWorkKind !== "provider_source") return row;
  return {
    ...row,
    latestCause: row.claimedCause,
    latestEvidenceDigest: row.claimedEvidenceDigest,
    latestRequestedAt: row.claimedRequestedAt,
    operationGeneration: null,
    operationRequestedAt: null,
    requestedOperation: null,
    targetProviderReleaseId: null,
    targetCatalogVersionId: null,
    requestedByOperatorId: null,
    authorizationDigest: null,
  };
}

function claimMatchesRow(claim: ManifestGateClaim, row: ClaimRow): boolean {
  const effective = effectiveClaimRow(row);
  return effective.providerId.toLowerCase() === claim.providerId.toLowerCase() &&
    effective.organizationId.toLowerCase() === claim.organizationId.toLowerCase() &&
    effective.providerKey === claim.providerKey &&
    effective.providerLifecycle === claim.providerLifecycle &&
    effective.providerRowVersion === claim.providerRowVersion &&
    effective.requestedGeneration >= claim.requestedGeneration &&
    effective.acknowledgedGeneration === claim.acknowledgedGeneration &&
    effective.latestCause === claim.latestCause &&
    effective.latestEvidenceDigest === claim.latestEvidenceDigest &&
    sameDate(effective.latestRequestedAt, claim.latestRequestedAt) &&
    effective.operationGeneration === claim.operationGeneration &&
    effective.requestedOperation === claim.requestedOperation &&
    effective.targetProviderReleaseId === claim.targetProviderReleaseId &&
    effective.targetCatalogVersionId === claim.targetCatalogVersionId &&
    effective.requestedByOperatorId === claim.requestedByOperatorId &&
    effective.authorizationDigest === claim.authorizationDigest &&
    effective.claimToken?.toLowerCase() === claim.claimToken.toLowerCase() &&
    effective.claimedGeneration === claim.observedGeneration &&
    sameDate(effective.claimExpiresAt, claim.claimExpiresAt) &&
    effective.attemptCount === claim.attemptCount &&
    sameDate(effective.lastAttemptedAt, claim.lastAttemptedAt) &&
    sameDate(effective.retryAt, claim.retryAt) &&
    effective.lastFailureCode === claim.lastFailureCode &&
    claim.pending ===
      (effective.requestedGeneration > effective.acknowledgedGeneration);
}

export interface ManifestGateSourceCoalescingResult {
  readonly intent: ManifestGateIntent;
  readonly advanced: boolean;
  readonly sourceGeneration: bigint;
  readonly sourceGateGeneration: bigint;
  readonly sourceEvidenceDigest: string;
}

function sourceCoalescingResult(
  row: GateRow,
  advanced: boolean,
): ManifestGateSourceCoalescingResult {
  if (
    row.providerSourceGeneration === null ||
    row.providerSourceGateGeneration === null ||
    row.providerSourceEvidenceDigest === null
  ) throw new PromotionJobPersistenceError(
    "PROMOTION_JOB_GATE_INTENT_INVALID",
  );
  return {
    intent: mapGate(row),
    advanced,
    sourceGeneration: row.providerSourceGeneration,
    sourceGateGeneration: row.providerSourceGateGeneration,
    sourceEvidenceDigest: row.providerSourceEvidenceDigest,
  };
}

/** Central manifest intent only; this repository never addresses provider DBs. */
export class PrismaManifestGateIntentRepository {
  constructor(private readonly central: CentralPrismaClient) {}

  async load(providerId: string): Promise<ManifestGateIntent | null> {
    assertPromotionJobUuid(providerId);
    const [row] = await this.central.$queryRaw<GateRow[]>(CentralPrisma.sql`
      select ${projection} from manifest_gate_intents
      where provider_id = ${providerId}::uuid
    `);
    return row ? mapGate(row) : null;
  }

  async coalesce(input: Readonly<{
    providerId: string;
    requestedGeneration: bigint;
    cause: ManifestReconciliationWakeCause;
    evidenceDigest: string;
    requestedAt: Date;
  }>, transaction?: CentralTransactionClient): Promise<ManifestGateIntent> {
    return (await this.coalesceProviderSource({
      providerId: input.providerId,
      sourceGeneration: input.requestedGeneration,
      cause: input.cause,
      evidenceDigest: input.evidenceDigest,
      requestedAt: input.requestedAt,
    }, transaction)).intent;
  }

  async coalesceProviderSource(input: Readonly<{
    providerId: string;
    sourceGeneration: bigint;
    cause: ManifestReconciliationWakeCause;
    evidenceDigest: string;
    requestedAt: Date;
  }>, transaction?: CentralTransactionClient): Promise<
    ManifestGateSourceCoalescingResult
  > {
    assertManifestGateIntentInput({
      ...input,
      requestedGeneration: input.sourceGeneration,
    });
    if (transaction !== undefined) return this.#coalesce(transaction, input);
    return this.central.$transaction(
      (centralTransaction) => this.#coalesce(centralTransaction, input),
      TRANSACTION,
    );
  }

  /** Records an operator-authorized one-provider gate without collapsing it
   * into a later provider-completion generation. Exact replay is idempotent. */
  async authorizeExplicit(input: Readonly<{
    providerId: string;
    operation: ManifestGateExplicitOperation;
    targetProviderReleaseId: string | null;
    targetCatalogVersionId: string | null;
    requestedByOperatorId: string;
    authorizationDigest: string;
    requestedAt: Date;
  }>): Promise<ManifestGateIntent> {
    assertPromotionJobUuid(input.providerId);
    assertPromotionJobUuid(input.requestedByOperatorId);
    assertPromotionJobSha256(input.authorizationDigest);
    if (
      !validDate(input.requestedAt) ||
      !["advance", "add", "remove", "rollback"].includes(input.operation) ||
      !explicitPairValid(input)
    ) throw new PromotionJobPersistenceError(
      "PROMOTION_JOB_GATE_INTENT_INVALID",
    );
    if (input.targetProviderReleaseId !== null) {
      assertPromotionJobUuid(input.targetProviderReleaseId);
    }
    if (input.targetCatalogVersionId !== null) {
      assertPromotionJobUuid(input.targetCatalogVersionId);
    }
    return this.central.$transaction(async (transaction) => {
      const [provider, catalog] = await Promise.all([
        transaction.providers.findUnique({
          where: { id: input.providerId },
          select: { id: true, organization_id: true },
        }),
        input.targetCatalogVersionId === null
          ? Promise.resolve(null)
          : transaction.catalog_versions.findUnique({
              where: { id: input.targetCatalogVersionId },
              select: { lifecycle: true },
            }),
      ]);
      if (
        provider === null ||
        (input.targetCatalogVersionId !== null && catalog?.lifecycle !== "complete")
      ) throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
      const membership = await transaction.operator_memberships.findUnique({
        where: {
          organization_id_operator_id: {
            organization_id: provider.organization_id,
            operator_id: input.requestedByOperatorId,
          },
        },
        select: {
          role: true,
          operator: { select: { state: true } },
        },
      });
      if (
        membership?.role !== "admin" || membership.operator.state !== "active"
      ) throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
      const [current] = await transaction.$queryRaw<GateRow[]>(CentralPrisma.sql`
        select ${projection} from manifest_gate_intents
        where provider_id = ${input.providerId}::uuid
        for update
      `);
      if (
        current !== undefined && current.operationGeneration !== null &&
        current.operationGeneration > current.acknowledgedGeneration
      ) {
        if (
          current.requestedOperation === input.operation &&
          current.targetProviderReleaseId === input.targetProviderReleaseId &&
          current.targetCatalogVersionId === input.targetCatalogVersionId &&
          current.requestedByOperatorId === input.requestedByOperatorId &&
          current.authorizationDigest === input.authorizationDigest
        ) return mapGate(current);
        throw new PromotionJobPersistenceError(
          "PROMOTION_JOB_GATE_INTENT_INVALID",
        );
      }
      const generation = (current?.requestedGeneration ?? 0n) + 1n;
      const [row] = await transaction.$queryRaw<GateRow[]>(CentralPrisma.sql`
        insert into manifest_gate_intents (
          provider_id, requested_generation, acknowledged_generation,
          latest_cause, latest_evidence_digest, latest_requested_at,
          operation_generation, operation_requested_at, requested_operation,
          target_provider_release_id, target_catalog_version_id,
          requested_by_operator_id, authorization_digest,
          row_version, created_at, updated_at
        ) values (
          ${input.providerId}::uuid, ${generation}, 0,
          'manifest_eligibility_change', ${input.authorizationDigest},
          ${input.requestedAt}, ${generation}, ${input.requestedAt},
          ${input.operation}::manifest_operation,
          ${input.targetProviderReleaseId}::uuid,
          ${input.targetCatalogVersionId}::uuid,
          ${input.requestedByOperatorId}::uuid,
          ${input.authorizationDigest}, 1, ${input.requestedAt},
          ${input.requestedAt}
        ) on conflict (provider_id) do update set
          requested_generation = ${generation},
          latest_cause = 'manifest_eligibility_change',
          latest_evidence_digest = ${input.authorizationDigest},
          latest_requested_at = ${input.requestedAt},
          operation_generation = ${generation},
          operation_requested_at = ${input.requestedAt},
          requested_operation = ${input.operation}::manifest_operation,
          target_provider_release_id = ${input.targetProviderReleaseId}::uuid,
          target_catalog_version_id = ${input.targetCatalogVersionId}::uuid,
          requested_by_operator_id = ${input.requestedByOperatorId}::uuid,
          authorization_digest = ${input.authorizationDigest},
          retry_at = null,
          last_failure_code = null,
          row_version = manifest_gate_intents.row_version + 1,
          updated_at = greatest(
            manifest_gate_intents.updated_at + interval '1 microsecond',
            ${input.requestedAt}
          )
        returning ${projection}
      `);
      if (!row) throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
      await new PrismaManifestReconciliationJobRepository(
        this.central,
      ).requestNextWake({
        cause: "manifest_eligibility_change",
        requestedAt: input.requestedAt,
      }, transaction);
      return mapGate(row);
    }, TRANSACTION);
  }

  /** Fairly claims one provider generation. Oldest never-attempted/attempted
   * provider wins; a deferred or unavailable provider therefore cannot pin
   * the front of the queue. */
  async claimNext(input: Readonly<{
    owner: string;
    now: Date;
    claimMilliseconds: number;
  }>, deadline?: ManifestGateTransactionDeadline): Promise<ManifestGateClaim | null> {
    assertClaimInput(input);
    const token = randomUUID();
    return this.central.$transaction(async (transaction) => {
      const [candidate] = await transaction.$queryRaw<Array<{
        providerId: string;
      }>>(CentralPrisma.sql`
        select gate.provider_id::text as "providerId"
        from manifest_gate_intents gate
        where gate.requested_generation > gate.acknowledged_generation
          and (gate.claim_token is null or gate.claim_expires_at <= ${input.now})
          and (gate.retry_at is null or gate.retry_at <= ${input.now})
        order by gate.last_attempted_at asc nulls first,
                 gate.updated_at asc,
                 gate.provider_id asc
        for update of gate skip locked
        limit 1
      `);
      if (!candidate) return null;
      const expiresAt = new Date(
        input.now.getTime() + input.claimMilliseconds,
      );
      await transaction.$executeRaw(CentralPrisma.sql`
        update manifest_gate_intents
        set claim_owner = ${input.owner},
            claim_token = ${token}::uuid,
            claimed_generation = case
              when operation_generation > acknowledged_generation
                and provider_source_gate_generation > acknowledged_generation
                then least(
                  operation_generation, provider_source_gate_generation
                )
              when operation_generation > acknowledged_generation
                then operation_generation
              else provider_source_gate_generation
            end,
            claimed_work_kind = case
              when operation_generation > acknowledged_generation
                and (
                  provider_source_gate_generation is null
                  or provider_source_gate_generation <= acknowledged_generation
                  or operation_generation <= provider_source_gate_generation
                ) then 'explicit'
              else 'provider_source'
            end,
            claimed_source_generation = case
              when operation_generation > acknowledged_generation
                and (
                  provider_source_gate_generation is null
                  or provider_source_gate_generation <= acknowledged_generation
                  or operation_generation <= provider_source_gate_generation
                ) then null
              else provider_source_generation
            end,
            claimed_cause = case
              when operation_generation > acknowledged_generation
                and (
                  provider_source_gate_generation is null
                  or provider_source_gate_generation <= acknowledged_generation
                  or operation_generation <= provider_source_gate_generation
                ) then 'manifest_eligibility_change'
              else provider_source_cause
            end,
            claimed_evidence_digest = case
              when operation_generation > acknowledged_generation
                and (
                  provider_source_gate_generation is null
                  or provider_source_gate_generation <= acknowledged_generation
                  or operation_generation <= provider_source_gate_generation
                ) then authorization_digest
              else provider_source_evidence_digest
            end,
            claimed_requested_at = case
              when operation_generation > acknowledged_generation
                and (
                  provider_source_gate_generation is null
                  or provider_source_gate_generation <= acknowledged_generation
                  or operation_generation <= provider_source_gate_generation
                ) then operation_requested_at
              else provider_source_requested_at
            end,
            claim_expires_at = ${expiresAt},
            attempt_count = attempt_count + 1,
            last_attempted_at = ${input.now},
            retry_at = null,
            row_version = row_version + 1,
            updated_at = greatest(
              updated_at + interval '1 microsecond', ${input.now}
            )
        where provider_id = ${candidate.providerId}::uuid
      `);
      const [row] = await transaction.$queryRaw<ClaimRow[]>(CentralPrisma.sql`
        select ${projection},
               provider.organization_id::text as "organizationId",
               provider.provider_key as "providerKey",
               provider.lifecycle::text as "providerLifecycle",
               provider.row_version as "providerRowVersion"
        from manifest_gate_intents gate
        join providers provider on provider.id = gate.provider_id
        where gate.provider_id = ${candidate.providerId}::uuid
      `);
      if (
        !row || row.claimToken !== token ||
        row.claimedGeneration === null || row.claimExpiresAt === null
      ) throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
      const effective = effectiveClaimRow(row);
      return {
        ...mapGate(effective),
        organizationId: effective.organizationId.toLowerCase(),
        providerKey: effective.providerKey,
        providerLifecycle: effective.providerLifecycle,
        providerRowVersion: effective.providerRowVersion,
        observedGeneration: row.claimedGeneration,
        claimToken: row.claimToken,
        claimExpiresAt: row.claimExpiresAt,
      };
    }, transactionOptions(TRANSACTION, deadline));
  }

  /**
   * Revalidates an untrusted serialized claim against current central truth
   * before proof composition. Token, generation, expiry, provider roster row,
   * lifecycle, and exact evidence must all still be the claimed values.
   */
  async verifyActiveClaim(
    claim: ManifestGateClaim,
    now: Date,
    deadline?: ManifestGateTransactionDeadline,
  ): Promise<ManifestGateClaim> {
    assertPromotionJobUuid(claim.providerId);
    assertPromotionJobUuid(claim.organizationId);
    assertPromotionJobUuid(claim.claimToken);
    if (
      !validDate(now) || !validDate(claim.claimExpiresAt) ||
      claim.claimExpiresAt.getTime() <= now.getTime() ||
      claim.observedGeneration < 1n ||
      claim.requestedGeneration < claim.observedGeneration ||
      claim.observedGeneration <= claim.acknowledgedGeneration ||
      claim.latestEvidenceDigest === null ||
      !OWNER_PATTERN.test(claim.providerKey)
    ) throw new PromotionJobPersistenceError(
      "PROMOTION_JOB_GATE_INTENT_INVALID",
    );
    assertPromotionJobSha256(claim.latestEvidenceDigest);
    if (claim.authorizationDigest !== null) {
      assertPromotionJobSha256(claim.authorizationDigest);
    }
    return this.central.$transaction(async (transaction) => {
      const [row] = await transaction.$queryRaw<ClaimRow[]>(CentralPrisma.sql`
        select ${projection},
               provider.organization_id::text as "organizationId",
               provider.provider_key as "providerKey",
               provider.lifecycle::text as "providerLifecycle",
               provider.row_version as "providerRowVersion"
        from manifest_gate_intents gate
        join providers provider on provider.id = gate.provider_id
        where gate.provider_id = ${claim.providerId}::uuid
      `);
      if (
        !row || !claimMatchesRow(claim, row) ||
        row.claimExpiresAt === null || row.claimExpiresAt <= now ||
        row.claimToken === null || row.claimedGeneration === null
      ) throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
      const effective = effectiveClaimRow(row);
      if (effective.requestedOperation === null) {
        const [evidence] = await transaction.$queryRaw<Array<{
          valid: boolean;
        }>>(CentralPrisma.sql`
          select exists (
            select 1
            from provider_activity_events event
            join provider_completion_publish_plans proof
              on proof.provider_id = event.provider_id
             and proof.event_id = event.id
             and proof.evidence_digest = event.event_digest
            where event.provider_id = ${row.providerId}::uuid
              and event.event_type = 'provider_release_completed'
              and event.event_digest = ${effective.latestEvidenceDigest}
          ) as valid
        `);
        if (evidence?.valid !== true) {
          throw new PromotionJobPersistenceError(
            "PROMOTION_JOB_GATE_INTENT_INVALID",
          );
        }
      } else {
        if (
          effective.operationGeneration !== row.claimedGeneration ||
          effective.requestedByOperatorId === null ||
          effective.authorizationDigest === null ||
          effective.authorizationDigest !== effective.latestEvidenceDigest ||
          !explicitPairValid({
            operation: effective.requestedOperation,
            targetProviderReleaseId: effective.targetProviderReleaseId,
            targetCatalogVersionId: effective.targetCatalogVersionId,
          })
        ) throw new PromotionJobPersistenceError(
          "PROMOTION_JOB_GATE_INTENT_INVALID",
        );
        const membership = await transaction.operator_memberships.findUnique({
          where: {
            organization_id_operator_id: {
              organization_id: row.organizationId,
              operator_id: effective.requestedByOperatorId,
            },
          },
          select: { role: true, operator: { select: { state: true } } },
        });
        if (
          membership?.role !== "admin" ||
          membership.operator.state !== "active"
        ) throw new PromotionJobPersistenceError(
          "PROMOTION_JOB_GATE_INTENT_INVALID",
        );
      }
      return {
        ...mapGate(effective),
        organizationId: effective.organizationId.toLowerCase(),
        providerKey: effective.providerKey,
        providerLifecycle: effective.providerLifecycle,
        providerRowVersion: effective.providerRowVersion,
        observedGeneration: row.claimedGeneration,
        claimToken: row.claimToken,
        claimExpiresAt: row.claimExpiresAt,
      };
    }, transactionOptions(VERIFY_TRANSACTION, deadline));
  }

  async acknowledgeClaim(input: Readonly<{
    providerId: string;
    claimToken: string;
    observedGeneration: bigint;
    acknowledgedAt: Date;
  }>, deadline?: ManifestGateTransactionDeadline): Promise<ManifestGateIntent> {
    assertPromotionJobUuid(input.providerId);
    assertPromotionJobUuid(input.claimToken);
    if (input.observedGeneration < 1n || !validDate(input.acknowledgedAt)) {
      throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
    }
    return this.central.$transaction(async (transaction) => {
      const [current] = await transaction.$queryRaw<GateRow[]>(CentralPrisma.sql`
        select ${projection} from manifest_gate_intents
        where provider_id = ${input.providerId}::uuid
        for update
      `);
      if (
        !current || current.claimToken !== input.claimToken ||
        current.claimedGeneration !== input.observedGeneration ||
        input.observedGeneration > current.requestedGeneration
      ) throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
      const clearsExplicit = current.operationGeneration ===
        input.observedGeneration;
      const [row] = await transaction.$queryRaw<GateRow[]>(CentralPrisma.sql`
        update manifest_gate_intents
        set acknowledged_generation = greatest(
              acknowledged_generation, ${input.observedGeneration}
            ),
            operation_generation = case when ${clearsExplicit}
              then null else operation_generation end,
            operation_requested_at = case when ${clearsExplicit}
              then null else operation_requested_at end,
            requested_operation = case when ${clearsExplicit}
              then null else requested_operation end,
            target_provider_release_id = case when ${clearsExplicit}
              then null else target_provider_release_id end,
            target_catalog_version_id = case when ${clearsExplicit}
              then null else target_catalog_version_id end,
            requested_by_operator_id = case when ${clearsExplicit}
              then null else requested_by_operator_id end,
            authorization_digest = case when ${clearsExplicit}
              then null else authorization_digest end,
            claim_owner = null,
            claim_token = null,
            claimed_generation = null,
            claimed_work_kind = null,
            claimed_source_generation = null,
            claimed_cause = null,
            claimed_evidence_digest = null,
            claimed_requested_at = null,
            claim_expires_at = null,
            retry_at = null,
            last_failure_code = null,
            row_version = row_version + 1,
            updated_at = greatest(
              updated_at + interval '1 microsecond', ${input.acknowledgedAt}
            )
        where provider_id = ${input.providerId}::uuid
          and claim_token = ${input.claimToken}::uuid
        returning ${projection}
      `);
      if (!row) throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
      return mapGate(row);
    }, transactionOptions(TRANSACTION, deadline));
  }

  async deferClaim(input: Readonly<{
    providerId: string;
    claimToken: string;
    observedGeneration: bigint;
    failureCode: string;
    observedAt: Date;
    retryAt: Date;
  }>, deadline?: ManifestGateTransactionDeadline): Promise<ManifestGateIntent> {
    assertPromotionJobUuid(input.providerId);
    assertPromotionJobUuid(input.claimToken);
    if (
      input.observedGeneration < 1n ||
      !FAILURE_CODE_PATTERN.test(input.failureCode) ||
      !validDate(input.observedAt) || !validDate(input.retryAt) ||
      input.retryAt.getTime() < input.observedAt.getTime()
    ) throw new PromotionJobPersistenceError(
      "PROMOTION_JOB_GATE_INTENT_INVALID",
    );
    return this.central.$transaction(async (transaction) => {
      const [current] = await transaction.$queryRaw<GateRow[]>(CentralPrisma.sql`
        select ${projection} from manifest_gate_intents
        where provider_id = ${input.providerId}::uuid
        for update
      `);
      if (
        !current || current.claimToken !== input.claimToken ||
        current.claimedGeneration !== input.observedGeneration
      ) throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
      const [row] = await transaction.$queryRaw<GateRow[]>(CentralPrisma.sql`
        update manifest_gate_intents
        set claim_owner = null,
            claim_token = null,
            claimed_generation = null,
            claimed_work_kind = null,
            claimed_source_generation = null,
            claimed_cause = null,
            claimed_evidence_digest = null,
            claimed_requested_at = null,
            claim_expires_at = null,
            retry_at = case
              when requested_generation > ${input.observedGeneration}
                then null else ${input.retryAt} end,
            last_failure_code = case
              when requested_generation > ${input.observedGeneration}
                then null else ${input.failureCode} end,
            row_version = row_version + 1,
            updated_at = greatest(
              updated_at + interval '1 microsecond', ${input.observedAt}
            )
        where provider_id = ${input.providerId}::uuid
          and claim_token = ${input.claimToken}::uuid
        returning ${projection}
      `);
      if (!row) throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
      return mapGate(row);
    }, transactionOptions(TRANSACTION, deadline));
  }

  async hasPending(deadline?: ManifestGateTransactionDeadline): Promise<boolean> {
    const [row] = await this.central.$transaction(
      (transaction) => transaction.$queryRaw<Array<{ pending: boolean }>>(
        CentralPrisma.sql`
          select exists (
            select 1 from manifest_gate_intents
            where requested_generation > acknowledged_generation
          ) as pending
        `,
      ),
      transactionOptions(TRANSACTION, deadline),
    );
    return row?.pending === true;
  }

  acknowledge(input: Readonly<{
    providerId: string;
    observedGeneration: bigint;
    acknowledgedAt: Date;
  }>): Promise<ManifestGateIntent> {
    assertPromotionJobUuid(input.providerId);
    if (input.observedGeneration < 1n || !validDate(input.acknowledgedAt)) {
      throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
    }
    return this.central.$transaction(async (transaction) => {
      const [current] = await transaction.$queryRaw<GateRow[]>(CentralPrisma.sql`
        select ${projection} from manifest_gate_intents
        where provider_id = ${input.providerId}::uuid
        for update
      `);
      if (
        !current || current.claimToken !== null ||
        input.observedGeneration > current.requestedGeneration ||
        (current.operationGeneration !== null &&
          current.operationGeneration > current.acknowledgedGeneration &&
          current.operationGeneration < input.observedGeneration)
      ) {
        throw new PromotionJobPersistenceError(
          "PROMOTION_JOB_GATE_INTENT_INVALID",
        );
      }
      if (input.observedGeneration <= current.acknowledgedGeneration) {
        return mapGate(current);
      }
      const [row] = await transaction.$queryRaw<GateRow[]>(CentralPrisma.sql`
        update manifest_gate_intents
        set acknowledged_generation = ${input.observedGeneration},
            operation_generation = case
              when operation_generation = ${input.observedGeneration}
                then null else operation_generation end,
            operation_requested_at = case
              when operation_generation = ${input.observedGeneration}
                then null else operation_requested_at end,
            requested_operation = case
              when operation_generation = ${input.observedGeneration}
                then null else requested_operation end,
            target_provider_release_id = case
              when operation_generation = ${input.observedGeneration}
                then null else target_provider_release_id end,
            target_catalog_version_id = case
              when operation_generation = ${input.observedGeneration}
                then null else target_catalog_version_id end,
            requested_by_operator_id = case
              when operation_generation = ${input.observedGeneration}
                then null else requested_by_operator_id end,
            authorization_digest = case
              when operation_generation = ${input.observedGeneration}
                then null else authorization_digest end,
            row_version = row_version + 1,
            updated_at = greatest(
              updated_at + interval '1 microsecond', ${input.acknowledgedAt}
            )
        where provider_id = ${input.providerId}::uuid
          and requested_generation >= ${input.observedGeneration}
        returning ${projection}
      `);
      if (!row) {
        throw new PromotionJobPersistenceError(
          "PROMOTION_JOB_GATE_INTENT_INVALID",
        );
      }
      return mapGate(row);
    }, TRANSACTION);
  }

  async listPending(input: Readonly<{
    afterProviderId?: string;
    limit: number;
  }>): Promise<readonly ManifestGateIntent[]> {
    if (input.afterProviderId !== undefined) {
      assertPromotionJobUuid(input.afterProviderId);
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new PromotionJobPersistenceError("PROMOTION_JOB_INPUT_INVALID");
    }
    const rows = await this.central.$queryRaw<GateRow[]>(CentralPrisma.sql`
      select ${projection} from manifest_gate_intents
      where requested_generation > acknowledged_generation
        and (${input.afterProviderId ?? null}::uuid is null
          or provider_id > ${input.afterProviderId ?? null}::uuid)
      order by provider_id
      limit ${input.limit}
    `);
    return rows.map(mapGate);
  }

  async #coalesce(
    client: CentralTransactionClient,
    input: Readonly<{
      providerId: string;
      sourceGeneration: bigint;
      cause: ManifestReconciliationWakeCause;
      evidenceDigest: string;
      requestedAt: Date;
    }>,
  ): Promise<ManifestGateSourceCoalescingResult> {
    const [provider] = await client.$queryRaw<Array<{ id: string }>>(
      CentralPrisma.sql`
        select id::text as id from providers
        where id = ${input.providerId}::uuid
        for update
      `,
    );
    if (!provider) {
      throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
    }
    const [current] = await client.$queryRaw<GateRow[]>(CentralPrisma.sql`
      select ${projection} from manifest_gate_intents
      where provider_id = ${input.providerId}::uuid
      for update
    `);
    if (current?.providerSourceGeneration !== null &&
        current?.providerSourceGeneration !== undefined) {
      if (input.sourceGeneration < current.providerSourceGeneration) {
        return sourceCoalescingResult(current, false);
      }
      if (input.sourceGeneration === current.providerSourceGeneration) {
        if (
          current.providerSourceCause !== input.cause ||
          current.providerSourceEvidenceDigest !== input.evidenceDigest ||
          !sameDate(current.providerSourceRequestedAt, input.requestedAt)
        ) throw new PromotionJobPersistenceError(
          "PROMOTION_JOB_GATE_INTENT_INVALID",
        );
        return sourceCoalescingResult(current, false);
      }
    }
    const gateGeneration = (current?.requestedGeneration ?? 0n) + 1n;
    const [row] = await client.$queryRaw<GateRow[]>(CentralPrisma.sql`
      insert into manifest_gate_intents (
        provider_id, requested_generation, acknowledged_generation,
        latest_cause, latest_evidence_digest, latest_requested_at,
        provider_source_generation, provider_source_gate_generation,
        provider_source_cause, provider_source_evidence_digest,
        provider_source_requested_at,
        row_version, created_at, updated_at
      ) values (
        ${input.providerId}::uuid, ${gateGeneration}, 0,
        ${input.cause}, ${input.evidenceDigest}, ${input.requestedAt},
        ${input.sourceGeneration}, ${gateGeneration}, ${input.cause},
        ${input.evidenceDigest}, ${input.requestedAt}, 1,
        ${input.requestedAt}, ${input.requestedAt}
      ) on conflict (provider_id) do update set
        requested_generation = ${gateGeneration},
        latest_cause = ${input.cause},
        latest_evidence_digest = ${input.evidenceDigest},
        latest_requested_at = ${input.requestedAt},
        provider_source_generation = ${input.sourceGeneration},
        provider_source_gate_generation = ${gateGeneration},
        provider_source_cause = ${input.cause},
        provider_source_evidence_digest = ${input.evidenceDigest},
        provider_source_requested_at = ${input.requestedAt},
        retry_at = null,
        last_failure_code = null,
        row_version = manifest_gate_intents.row_version + 1,
        updated_at = greatest(
          manifest_gate_intents.updated_at + interval '1 microsecond',
          ${input.requestedAt}
        )
      returning ${projection}
    `);
    if (!row) throw new PromotionJobPersistenceError(
      "PROMOTION_JOB_GATE_INTENT_INVALID",
    );
    return sourceCoalescingResult(row, true);
  }
}

function mapGate(row: GateRow): ManifestGateIntent {
  return {
    providerId: row.providerId.toLowerCase(),
    requestedGeneration: row.requestedGeneration,
    acknowledgedGeneration: row.acknowledgedGeneration,
    latestCause: row.latestCause,
    latestEvidenceDigest: row.latestEvidenceDigest,
    latestRequestedAt: row.latestRequestedAt,
    operationGeneration: row.operationGeneration,
    requestedOperation: row.requestedOperation,
    targetProviderReleaseId: row.targetProviderReleaseId?.toLowerCase() ?? null,
    targetCatalogVersionId: row.targetCatalogVersionId?.toLowerCase() ?? null,
    requestedByOperatorId: row.requestedByOperatorId?.toLowerCase() ?? null,
    authorizationDigest: row.authorizationDigest,
    attemptCount: row.attemptCount,
    lastAttemptedAt: row.lastAttemptedAt,
    retryAt: row.retryAt,
    lastFailureCode: row.lastFailureCode,
    pending: row.requestedGeneration > row.acknowledgedGeneration,
  };
}
