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

interface GateRow {
  providerId: string;
  requestedGeneration: bigint;
  acknowledgedGeneration: bigint;
  latestCause: ManifestReconciliationWakeCause | null;
  latestEvidenceDigest: string | null;
  latestRequestedAt: Date | null;
  operationGeneration: bigint | null;
  requestedOperation: ManifestGateExplicitOperation | null;
  targetProviderReleaseId: string | null;
  targetCatalogVersionId: string | null;
  requestedByOperatorId: string | null;
  authorizationDigest: string | null;
  claimOwner: string | null;
  claimToken: string | null;
  claimedGeneration: bigint | null;
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
  operation_generation as "operationGeneration",
  requested_operation::text as "requestedOperation",
  target_provider_release_id::text as "targetProviderReleaseId",
  target_catalog_version_id::text as "targetCatalogVersionId",
  requested_by_operator_id::text as "requestedByOperatorId",
  authorization_digest as "authorizationDigest",
  claim_owner as "claimOwner",
  claim_token::text as "claimToken",
  claimed_generation as "claimedGeneration",
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

  coalesce(input: Readonly<{
    providerId: string;
    requestedGeneration: bigint;
    cause: ManifestReconciliationWakeCause;
    evidenceDigest: string;
    requestedAt: Date;
  }>, transaction?: CentralTransactionClient): Promise<ManifestGateIntent> {
    assertManifestGateIntentInput(input);
    const client = transaction ?? this.central;
    return this.#coalesce(client, input);
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
          operation_generation, requested_operation,
          target_provider_release_id, target_catalog_version_id,
          requested_by_operator_id, authorization_digest,
          row_version, created_at, updated_at
        ) values (
          ${input.providerId}::uuid, ${generation}, 0,
          'manifest_eligibility_change', ${input.authorizationDigest},
          ${input.requestedAt}, ${generation},
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
  }>): Promise<ManifestGateClaim | null> {
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
            claimed_generation = coalesce(
              operation_generation, requested_generation
            ),
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
      return {
        ...mapGate(row),
        organizationId: row.organizationId.toLowerCase(),
        providerKey: row.providerKey,
        providerLifecycle: row.providerLifecycle,
        providerRowVersion: row.providerRowVersion,
        observedGeneration: row.claimedGeneration,
        claimToken: row.claimToken,
        claimExpiresAt: row.claimExpiresAt,
      };
    }, TRANSACTION);
  }

  async acknowledgeClaim(input: Readonly<{
    providerId: string;
    claimToken: string;
    observedGeneration: bigint;
    acknowledgedAt: Date;
  }>): Promise<ManifestGateIntent> {
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
    }, TRANSACTION);
  }

  async deferClaim(input: Readonly<{
    providerId: string;
    claimToken: string;
    observedGeneration: bigint;
    failureCode: string;
    observedAt: Date;
    retryAt: Date;
  }>): Promise<ManifestGateIntent> {
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
            claim_expires_at = null,
            retry_at = ${input.retryAt},
            last_failure_code = ${input.failureCode},
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
    }, TRANSACTION);
  }

  async hasPending(): Promise<boolean> {
    const [row] = await this.central.$queryRaw<Array<{ pending: boolean }>>(
      CentralPrisma.sql`
        select exists (
          select 1 from manifest_gate_intents
          where requested_generation > acknowledged_generation
        ) as pending
      `,
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
        input.observedGeneration > current.requestedGeneration
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
    client: CentralPrismaClient | CentralTransactionClient,
    input: Readonly<{
      providerId: string;
      requestedGeneration: bigint;
      cause: ManifestReconciliationWakeCause;
      evidenceDigest: string;
      requestedAt: Date;
    }>,
  ): Promise<ManifestGateIntent> {
    const [row] = await client.$queryRaw<GateRow[]>(CentralPrisma.sql`
      insert into manifest_gate_intents (
        provider_id, requested_generation, acknowledged_generation,
        latest_cause, latest_evidence_digest, latest_requested_at,
        row_version, created_at, updated_at
      ) values (
        ${input.providerId}::uuid, ${input.requestedGeneration}, 0,
        ${input.cause}, ${input.evidenceDigest}, ${input.requestedAt}, 1,
        ${input.requestedAt}, ${input.requestedAt}
      ) on conflict (provider_id) do update set
        requested_generation = greatest(
          manifest_gate_intents.requested_generation,
          excluded.requested_generation
        ),
        latest_cause = case
          when ${newerEvidenceSql} then excluded.latest_cause
          else manifest_gate_intents.latest_cause
        end,
        latest_evidence_digest = case
          when ${newerEvidenceSql} then excluded.latest_evidence_digest
          else manifest_gate_intents.latest_evidence_digest
        end,
        latest_requested_at = case
          when ${newerEvidenceSql} then excluded.latest_requested_at
          else manifest_gate_intents.latest_requested_at
        end,
        row_version = manifest_gate_intents.row_version + 1,
        updated_at = greatest(
          manifest_gate_intents.updated_at + interval '1 microsecond',
          excluded.updated_at
        )
      where ${newerEvidenceSql}
      returning ${projection}
    `);
    if (!row) {
      const [existing] = await client.$queryRaw<GateRow[]>(CentralPrisma.sql`
        select ${projection} from manifest_gate_intents
        where provider_id = ${input.providerId}::uuid
      `);
      if (existing) return mapGate(existing);
      throw new PromotionJobPersistenceError(
        "PROMOTION_JOB_GATE_INTENT_INVALID",
      );
    }
    return mapGate(row);
  }
}

const newerEvidenceSql = CentralPrisma.sql`
  excluded.requested_generation > manifest_gate_intents.requested_generation
  or (
    excluded.requested_generation = manifest_gate_intents.requested_generation
    and excluded.latest_requested_at > manifest_gate_intents.latest_requested_at
  ) or (
    excluded.requested_generation = manifest_gate_intents.requested_generation
    and excluded.latest_requested_at = manifest_gate_intents.latest_requested_at
    and excluded.latest_evidence_digest
      > manifest_gate_intents.latest_evidence_digest
  )
`;

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
