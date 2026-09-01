import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import type {
  CentralPrismaClient,
  CentralTransactionClient,
} from "./central-database.ts";
import {
  assertManifestGateIntentInput,
  type ManifestGateIntent,
} from "./central-promotion-job-records.ts";
import {
  PromotionJobPersistenceError,
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
}

const TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.ReadCommitted,
});

const projection = CentralPrisma.sql`
  provider_id::text as "providerId",
  requested_generation as "requestedGeneration",
  acknowledged_generation as "acknowledgedGeneration",
  latest_cause as "latestCause",
  latest_evidence_digest as "latestEvidenceDigest",
  latest_requested_at as "latestRequestedAt"
`;

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
      if (!current || input.observedGeneration > current.requestedGeneration) {
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
    ...row,
    providerId: row.providerId.toLowerCase(),
    pending: row.requestedGeneration > row.acknowledgedGeneration,
  };
}
