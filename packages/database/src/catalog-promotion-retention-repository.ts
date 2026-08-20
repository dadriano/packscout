import {
  CATALOG_RETENTION_SCHEMA_VERSION,
  MAX_CATALOG_RETENTION_ARTIFACT_DOCUMENTS,
  MIN_CATALOG_RETENTION_MANIFEST_DOCUMENTS,
  canonicalJson,
  catalogRetentionManifestReceiptSchema,
  catalogRetentionManifestRequestSchema,
  catalogRetentionPostgresProofSnapshotDigest,
  catalogRetentionPostgresProofSnapshotSchema,
  catalogRetentionProviderReceiptSchema,
  catalogRetentionProviderRequestSchema,
  catalogRetentionPublicationRequestDigest,
  catalogRetentionReceiptDigest,
  catalogRetentionSignedReceiptEnvelopeSchema,
  catalogRetentionTerminalReceiptSha256,
  providerCatalogPlatformKeyV1Schema,
  type CatalogRetentionPostgresProofSnapshot,
  type CatalogRetentionReceipt,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { loadCatalogPromotionRetentionProof } from
  "./catalog-promotion-retention-proof.ts";
import {
  CATALOG_PROMOTION_RETENTION_MAXIMUM_ROWS,
  CATALOG_PROMOTION_RETENTION_MINIMUM_ROWS,
  CatalogPromotionRetentionPersistenceError,
  type CatalogPromotionRetentionAcknowledgement,
  type CatalogPromotionRetentionBarrierClaim,
  type CatalogPromotionRetentionCleanupProgress,
  type CatalogPromotionRetentionOperationRecord,
  type CatalogPromotionRetentionReceiptEvidence,
  type CatalogPromotionRetentionScopeBinding,
} from "./catalog-promotion-retention-types.ts";
import {
  assertPromotionV2Binding,
  finiteDate,
  promotionV2Sha256,
} from "./promotion-v2-types.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

interface BarrierRow {
  barrierGeneration: bigint;
  barrierToken: string | null;
  state: "inactive" | "active";
  retentionGeneration: bigint;
  nextOperationIndex: number;
  manifestPhaseComplete: boolean;
  snapshotBody: string | null;
  snapshotDigest: string | null;
}

interface OperationRow {
  operationIndex: number;
  operationId: string;
  operationKind: "retainManifests" | "retainProviderReleases";
  phase: "manifests" | "provider_releases";
  platformKey: string | null;
  expectedRetentionGeneration: bigint;
  canonicalRequestBody: string;
  requestSha256: string;
  state: "pending" | "sent" | "acknowledged";
  sendCount: number;
  lastSentAt: Date | null;
  acknowledgedAt: Date | null;
  canonicalReceiptBody: string | null;
  receiptSha256: string | null;
  exactResponseBody: string | null;
  responseSha256: string | null;
  terminalState: "complete" | "continuation_required" | null;
  hasMore: boolean | null;
  selectedPlatformKey: string | null;
  selectedPublicProviderReleaseId: string | null;
  selectedProviderReleaseFingerprint: string | null;
  postgresCleanupComplete: boolean;
}

function stateConflict(): never {
  throw new CatalogPromotionRetentionPersistenceError(
    "CATALOG_PROMOTION_RETENTION_STATE_CONFLICT",
  );
}

function inputInvalid(): never {
  throw new CatalogPromotionRetentionPersistenceError(
    "CATALOG_PROMOTION_RETENTION_INPUT_INVALID",
  );
}

function safeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return stateConflict();
  return number;
}

async function parseStoredProof(row: BarrierRow): Promise<Readonly<{
  proof: CatalogRetentionPostgresProofSnapshot;
  body: string;
}>> {
  if (row.snapshotBody === null || row.snapshotDigest === null) {
    return stateConflict();
  }
  try {
    const proof = catalogRetentionPostgresProofSnapshotSchema.parse(
      JSON.parse(row.snapshotBody),
    );
    if (canonicalJson(proof) !== row.snapshotBody ||
      proof.snapshotDigest !== row.snapshotDigest ||
      await catalogRetentionPostgresProofSnapshotDigest(proof) !==
        proof.snapshotDigest) return stateConflict();
    return { proof, body: row.snapshotBody };
  } catch (error) {
    if (error instanceof CatalogPromotionRetentionPersistenceError) throw error;
    return stateConflict();
  }
}

function mapOperation(row: OperationRow): CatalogPromotionRetentionOperationRecord {
  return {
    operationIndex: row.operationIndex,
    operationId: row.operationId,
    operationKind: row.operationKind,
    phase: row.phase,
    platformKey: row.platformKey,
    expectedRetentionGeneration: safeNumber(row.expectedRetentionGeneration),
    canonicalRequestBody: row.canonicalRequestBody,
    requestSha256: row.requestSha256,
    state: row.state,
    sendCount: row.sendCount,
    lastSentAt: row.lastSentAt,
    acknowledgedAt: row.acknowledgedAt,
    canonicalReceiptBody: row.canonicalReceiptBody,
    receiptSha256: row.receiptSha256,
    exactResponseBody: row.exactResponseBody,
    responseSha256: row.responseSha256,
    postgresCleanupComplete: row.postgresCleanupComplete,
  };
}

const operationProjection = Prisma.sql`
  operation_index as "operationIndex", operation_id as "operationId",
  operation_kind as "operationKind", phase, platform_key as "platformKey",
  expected_retention_generation as "expectedRetentionGeneration",
  canonical_request_body as "canonicalRequestBody",
  request_sha256 as "requestSha256", state, send_count as "sendCount",
  last_sent_at as "lastSentAt", acknowledged_at as "acknowledgedAt",
  canonical_receipt_body as "canonicalReceiptBody",
  receipt_sha256 as "receiptSha256",
  exact_response_body as "exactResponseBody",
  response_sha256 as "responseSha256", terminal_state as "terminalState",
  has_more as "hasMore", selected_platform_key as "selectedPlatformKey",
  selected_public_provider_release_id::text
    as "selectedPublicProviderReleaseId",
  selected_provider_release_fingerprint
    as "selectedProviderReleaseFingerprint",
  postgres_cleanup_complete as "postgresCleanupComplete"
`;

/** Durable two-phase PostgreSQL/Convex catalog-retention barrier. */
export class PrismaCatalogPromotionRetentionRepository {
  readonly #organizationId: string;
  readonly #deploymentKey: string;

  constructor(
    private readonly database: PackscoutPrismaClient,
    binding: CatalogPromotionRetentionScopeBinding,
  ) {
    assertPromotionV2Binding(binding);
    this.#organizationId = binding.organizationId.toLowerCase();
    this.#deploymentKey = binding.deploymentKey;
  }

  async acquireBarrier(): Promise<CatalogPromotionRetentionBarrierClaim> {
    return this.database.$transaction(async (transaction) => {
      await this.#lockOrganization(transaction);
      await transaction.$executeRaw(Prisma.sql`
        insert into public.catalog_promotion_retention_barriers (
          organization_id, deployment_key
        ) values (${uuid(this.#organizationId)}, ${this.#deploymentKey})
        on conflict do nothing
      `);
      let barrier = await this.#lockBarrier(transaction);
      if (barrier.state === "active") {
        if (barrier.barrierToken === null) return stateConflict();
        const stored = await parseStoredProof(barrier);
        return {
          barrierGeneration: barrier.barrierGeneration,
          barrierToken: barrier.barrierToken,
          retentionGeneration: safeNumber(barrier.retentionGeneration),
          postgresProof: stored.proof,
          canonicalPostgresProofBody: stored.body,
          resumed: true,
        };
      }
      await this.#assertNoUnresolvedPromotionWork(transaction);
      const generated = await transaction.$queryRaw<Array<{
        barrierToken: string;
        evaluatedAt: Date;
      }>>(Prisma.sql`
        select gen_random_uuid()::text as "barrierToken",
               clock_timestamp() as "evaluatedAt"
      `);
      const identity = generated[0]!;
      const nextGeneration = barrier.barrierGeneration + 1n;
      const snapshotId = `retention:snapshot:${identity.barrierToken}`;
      const postgresProof = await loadCatalogPromotionRetentionProof(
        transaction,
        { organizationId: this.#organizationId, deploymentKey: this.#deploymentKey },
        {
          snapshotId,
          snapshotSequence: nextGeneration,
          evaluatedAt: identity.evaluatedAt,
        },
      );
      const canonicalPostgresProofBody = canonicalJson(postgresProof);
      await transaction.$executeRaw(Prisma.sql`
        update public.catalog_promotion_retention_barriers
        set barrier_generation = ${nextGeneration},
            barrier_token = ${uuid(identity.barrierToken)}, state = 'active',
            next_operation_index = 0, manifest_phase_complete = false,
            snapshot_body = ${canonicalPostgresProofBody},
            snapshot_digest = ${postgresProof.snapshotDigest},
            activated_at = ${identity.evaluatedAt}, completed_at = null,
            updated_at = ${identity.evaluatedAt}
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
      `);
      barrier = await this.#lockBarrier(transaction);
      return {
        barrierGeneration: nextGeneration,
        barrierToken: identity.barrierToken,
        retentionGeneration: safeNumber(barrier.retentionGeneration),
        postgresProof,
        canonicalPostgresProofBody,
        resumed: false,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async loadBarrier(): Promise<CatalogPromotionRetentionBarrierClaim | null> {
    const rows = await this.database.$queryRaw<BarrierRow[]>(Prisma.sql`
      select barrier_generation as "barrierGeneration",
             barrier_token::text as "barrierToken", state,
             retention_generation as "retentionGeneration",
             next_operation_index as "nextOperationIndex",
             manifest_phase_complete as "manifestPhaseComplete",
             snapshot_body as "snapshotBody", snapshot_digest as "snapshotDigest"
      from public.catalog_promotion_retention_barriers
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
    `);
    const barrier = rows[0];
    if (!barrier || barrier.state === "inactive") return null;
    if (barrier.barrierToken === null) return stateConflict();
    const stored = await parseStoredProof(barrier);
    return {
      barrierGeneration: barrier.barrierGeneration,
      barrierToken: barrier.barrierToken,
      retentionGeneration: safeNumber(barrier.retentionGeneration),
      postgresProof: stored.proof,
      canonicalPostgresProofBody: stored.body,
      resumed: true,
    };
  }

  async prepareOperation(input: Readonly<{
    barrierToken: string;
    phase: "manifests" | "provider_releases";
    platformKey?: string;
    maximumDocuments: number;
  }>): Promise<CatalogPromotionRetentionOperationRecord | null> {
    if (!Number.isSafeInteger(input.maximumDocuments) ||
      input.maximumDocuments < 1 ||
      input.maximumDocuments > MAX_CATALOG_RETENTION_ARTIFACT_DOCUMENTS ||
      (input.phase === "manifests" &&
        input.maximumDocuments < MIN_CATALOG_RETENTION_MANIFEST_DOCUMENTS) ||
      (input.phase === "manifests" && input.platformKey !== undefined) ||
      (input.phase === "provider_releases" &&
        !providerCatalogPlatformKeyV1Schema.safeParse(input.platformKey).success)) {
      return inputInvalid();
    }
    return this.database.$transaction(async (transaction) => {
      const barrier = await this.#requireBarrier(transaction, input.barrierToken);
      const pending = await this.#loadFirstPendingOperation(transaction);
      if (pending) {
        if (pending.phase === input.phase &&
          pending.platformKey === (input.platformKey ?? null)) {
          return mapOperation(pending);
        }
        throw new CatalogPromotionRetentionPersistenceError(
          "CATALOG_PROMOTION_RETENTION_OPERATION_ORDER",
        );
      }
      const cleanup = await transaction.$queryRaw<Array<{ pending: boolean }>>(
        Prisma.sql`
          select exists (
            select 1 from public.catalog_promotion_retention_operations
            where organization_id = ${uuid(this.#organizationId)}
              and deployment_key = ${this.#deploymentKey}
              and barrier_generation = ${barrier.barrierGeneration}
              and state = 'acknowledged'
              and postgres_cleanup_complete = false
          ) as pending
        `,
      );
      if (cleanup[0]?.pending) {
        throw new CatalogPromotionRetentionPersistenceError(
          "CATALOG_PROMOTION_RETENTION_OPERATION_ORDER",
        );
      }
      const stored = await parseStoredProof(barrier);
      if (input.phase === "provider_releases" &&
        !barrier.manifestPhaseComplete) {
        throw new CatalogPromotionRetentionPersistenceError(
          "CATALOG_PROMOTION_RETENTION_OPERATION_ORDER",
        );
      }
      if (input.phase === "manifests" && barrier.manifestPhaseComplete) return null;
      if (input.phase === "provider_releases") {
        const platformKey = input.platformKey!;
        if (!stored.proof.completedHeads.some((head) =>
          head.platformKey === platformKey)) return inputInvalid();
        const completed = await transaction.$queryRaw<Array<{ complete: boolean }>>(
          Prisma.sql`
            select exists (
              select 1 from public.catalog_promotion_retention_operations
              where organization_id = ${uuid(this.#organizationId)}
                and deployment_key = ${this.#deploymentKey}
                and barrier_generation = ${barrier.barrierGeneration}
                and phase = 'provider_releases'
                and platform_key = ${platformKey}
                and state = 'acknowledged' and terminal_state = 'complete'
            ) as complete
          `,
        );
        if (completed[0]?.complete) return null;
      }
      const operationIndex = barrier.nextOperationIndex;
      const operationId = [
        "retention", String(barrier.barrierGeneration), String(operationIndex),
      ].join(":");
      const base = {
        schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
        operationId,
        idempotencyKey: operationId,
        expectedRetentionGeneration: safeNumber(barrier.retentionGeneration),
        maximumDocuments: input.maximumDocuments,
        postgresProof: stored.proof,
      };
      const request = input.phase === "manifests"
        ? catalogRetentionManifestRequestSchema.parse({
            ...base, phase: "manifests",
          })
        : catalogRetentionProviderRequestSchema.parse({
            ...base, phase: "provider_releases", platformKey: input.platformKey,
          });
      const body = canonicalJson(request);
      const kind = input.phase === "manifests"
        ? "retainManifests" : "retainProviderReleases";
      const inserted = await transaction.$queryRaw<OperationRow[]>(Prisma.sql`
        insert into public.catalog_promotion_retention_operations (
          organization_id, deployment_key, barrier_generation,
          operation_index, operation_id, idempotency_key, operation_kind,
          phase, platform_key, expected_retention_generation,
          canonical_request_body, request_sha256
        ) values (
          ${uuid(this.#organizationId)}, ${this.#deploymentKey},
          ${barrier.barrierGeneration}, ${operationIndex}, ${operationId},
          ${operationId}, ${kind}, ${input.phase}, ${input.platformKey ?? null},
          ${barrier.retentionGeneration}, ${body}, ${promotionV2Sha256(body)}
        ) returning ${operationProjection}
      `);
      await transaction.$executeRaw(Prisma.sql`
        update public.catalog_promotion_retention_barriers
        set next_operation_index = next_operation_index + 1,
            updated_at = clock_timestamp()
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and barrier_token = ${uuid(input.barrierToken)}
      `);
      return mapOperation(inserted[0]!);
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async loadPendingOperation(input: Readonly<{
    barrierToken: string;
  }>): Promise<CatalogPromotionRetentionOperationRecord | null> {
    return this.database.$transaction(async (transaction) => {
      await this.#requireBarrier(transaction, input.barrierToken);
      const operation = await this.#loadFirstPendingOperation(transaction);
      return operation ? mapOperation(operation) : null;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  /** Returns the exact acknowledged operation whose selected graph still needs cleanup. */
  async loadOperationRequiringCleanup(input: Readonly<{
    barrierToken: string;
  }>): Promise<CatalogPromotionRetentionOperationRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const barrier = await this.#requireBarrier(transaction, input.barrierToken);
      const rows = await transaction.$queryRaw<OperationRow[]>(Prisma.sql`
        select ${operationProjection}
        from public.catalog_promotion_retention_operations
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and barrier_generation = ${barrier.barrierGeneration}
          and state = 'acknowledged'
          and postgres_cleanup_complete = false
        order by operation_index
        limit 1 for update
      `);
      return rows[0] ? mapOperation(rows[0]) : null;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async markOperationSent(input: Readonly<{
    barrierToken: string;
    operationId: string;
    sentAt: Date;
  }>): Promise<boolean> {
    if (!finiteDate(input.sentAt)) return inputInvalid();
    return this.database.$transaction(async (transaction) => {
      await this.#requireBarrier(transaction, input.barrierToken);
      const operation = await this.#lockOperation(transaction, input.operationId);
      if (operation.state === "acknowledged") return false;
      const first = await this.#loadFirstPendingOperation(transaction);
      if (first?.operationId !== operation.operationId) {
        throw new CatalogPromotionRetentionPersistenceError(
          "CATALOG_PROMOTION_RETENTION_OPERATION_ORDER",
        );
      }
      const updated = await transaction.$executeRaw(Prisma.sql`
        update public.catalog_promotion_retention_operations
        set state = 'sent', send_count = send_count + 1,
            last_sent_at = ${input.sentAt}, updated_at = ${input.sentAt}
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and operation_id = ${input.operationId}
          and state in ('pending', 'sent')
      `);
      return updated === 1;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async acknowledgeOperation(input: Readonly<{
    barrierToken: string;
    operationId: string;
    acknowledgedAt: Date;
    evidence: CatalogPromotionRetentionReceiptEvidence;
  }>): Promise<CatalogPromotionRetentionAcknowledgement> {
    if (!finiteDate(input.acknowledgedAt)) return inputInvalid();
    return this.database.$transaction(async (transaction) => {
      const barrier = await this.#requireBarrier(transaction, input.barrierToken);
      const operation = await this.#lockOperation(transaction, input.operationId);
      const validated = await this.#validateEvidence(operation, input.evidence);
      if (operation.state === "acknowledged") {
        if (operation.canonicalReceiptBody !== input.evidence.canonicalReceiptBody ||
          operation.exactResponseBody !== input.evidence.exactResponseBody) {
          throw new CatalogPromotionRetentionPersistenceError(
            "CATALOG_PROMOTION_RETENTION_OPERATION_CONFLICT",
          );
        }
        return {
          receipt: validated.receipt,
          receiptSha256: validated.receiptSha256,
          postgresCleanupPending: !operation.postgresCleanupComplete,
        };
      }
      if (operation.state !== "sent" ||
        barrier.retentionGeneration !== operation.expectedRetentionGeneration) {
        throw new CatalogPromotionRetentionPersistenceError(
          "CATALOG_PROMOTION_RETENTION_OPERATION_ORDER",
        );
      }
      const selected = validated.receipt.operationKind ===
          "retainProviderReleases" &&
          validated.receipt.details.deletedProviderReleaseCount === 1
        ? validated.receipt.details.selectedProviderRelease : null;
      if (selected && this.#releaseIsProtected(validated.receipt, selected)) {
        throw new CatalogPromotionRetentionPersistenceError(
          "CATALOG_PROMOTION_RETENTION_UNSAFE",
        );
      }
      const cleanupComplete = selected === null;
      await transaction.$executeRaw(Prisma.sql`
        update public.catalog_promotion_retention_operations
        set state = 'acknowledged', acknowledged_at = ${input.acknowledgedAt},
            canonical_receipt_body = ${input.evidence.canonicalReceiptBody},
            receipt_sha256 = ${validated.receiptSha256},
            exact_response_body = ${input.evidence.exactResponseBody},
            response_sha256 = ${promotionV2Sha256(input.evidence.exactResponseBody)},
            terminal_state = ${validated.receipt.terminalState},
            has_more = ${validated.receipt.details.hasMore},
            selected_platform_key = ${selected?.platformKey ?? null},
            selected_public_provider_release_id = ${selected
              ? uuid(selected.publicProviderReleaseId) : null},
            selected_provider_release_fingerprint =
              ${selected?.providerReleaseFingerprint ?? null},
            postgres_cleanup_complete = ${cleanupComplete},
            updated_at = ${input.acknowledgedAt}
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and operation_id = ${input.operationId} and state = 'sent'
      `);
      await transaction.$executeRaw(Prisma.sql`
        update public.catalog_promotion_retention_barriers
        set retention_generation = ${BigInt(validated.receipt.retentionGeneration)},
            manifest_phase_complete = manifest_phase_complete or
              ${validated.receipt.phase === "manifests" &&
                validated.receipt.terminalState === "complete"},
            updated_at = ${input.acknowledgedAt}
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and barrier_token = ${uuid(input.barrierToken)}
          and retention_generation = ${barrier.retentionGeneration}
      `);
      return {
        receipt: validated.receipt,
        receiptSha256: validated.receiptSha256,
        postgresCleanupPending: !cleanupComplete,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async deleteProviderArtifactChunk(input: Readonly<{
    barrierToken: string;
    operationId: string;
    maximumRows: number;
  }>): Promise<CatalogPromotionRetentionCleanupProgress> {
    if (!Number.isSafeInteger(input.maximumRows) ||
      input.maximumRows < CATALOG_PROMOTION_RETENTION_MINIMUM_ROWS ||
      input.maximumRows > CATALOG_PROMOTION_RETENTION_MAXIMUM_ROWS) {
      return inputInvalid();
    }
    return this.database.$transaction(async (transaction) => {
      await this.#requireBarrier(transaction, input.barrierToken);
      const operation = await this.#lockOperation(transaction, input.operationId);
      if (operation.state !== "acknowledged" ||
        operation.postgresCleanupComplete ||
        operation.selectedPlatformKey === null ||
        operation.selectedPublicProviderReleaseId === null ||
        operation.selectedProviderReleaseFingerprint === null) {
        if (operation.state === "acknowledged" &&
          operation.postgresCleanupComplete) {
          return { deletedRowCount: 0, complete: true };
        }
        throw new CatalogPromotionRetentionPersistenceError(
          "CATALOG_PROMOTION_RETENTION_OPERATION_ORDER",
        );
      }
      const target = {
        platformKey: operation.selectedPlatformKey,
        publicProviderReleaseId: operation.selectedPublicProviderReleaseId,
        providerReleaseFingerprint:
          operation.selectedProviderReleaseFingerprint,
      };
      if (await this.#artifactGraphAbsent(transaction, target)) {
        await transaction.$executeRaw(Prisma.sql`
          update public.catalog_promotion_retention_operations
          set postgres_cleanup_complete = true, updated_at = clock_timestamp()
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
            and operation_id = ${input.operationId}
        `);
        return { deletedRowCount: 0, complete: true };
      }
      await this.#assertArtifactDeletable(transaction, target);
      await transaction.$executeRaw(Prisma.sql`
        select set_config(
          'packscout.catalog_retention_delete_token', ${input.barrierToken}, true
        )
      `);
      await transaction.$executeRaw(Prisma.sql`
        select set_config(
          'packscout.catalog_retention_delete_identity',
          ${canonicalJson(target)}, true
        )
      `);
      let remaining = input.maximumRows;
      let deletedRowCount = 0;
      const obsoleteProofRows = await transaction.$queryRaw<Array<{
        proofRevision: bigint;
      }>>(Prisma.sql`
        select proof.proof_revision as "proofRevision"
        from public.catalog_promotion_bootstrap_provider_proofs as proof
        join public.manifest_promotion_lanes as lane
          on lane.organization_id = proof.organization_id
         and lane.deployment_key = proof.deployment_key
        where proof.organization_id = ${uuid(this.#organizationId)}
          and proof.deployment_key = ${this.#deploymentKey}
          and proof.platform_key = ${target.platformKey}
          and proof.public_provider_release_id =
            ${uuid(target.publicProviderReleaseId)}
          and proof.provider_release_fingerprint =
            ${target.providerReleaseFingerprint}
          and proof.proof_revision <> lane.current_bootstrap_proof_revision
          and not exists (
            select 1 from public.provider_promotion_attempts as attempt
            where attempt.organization_id = proof.organization_id
              and attempt.deployment_key = proof.deployment_key
              and attempt.bootstrap_proof_revision = proof.proof_revision
              and attempt.state in (
                'assembling', 'ready', 'in_progress', 'retry_wait'
              )
          )
          and not exists (
            select 1 from public.manifest_promotion_attempts as attempt
            where attempt.organization_id = proof.organization_id
              and attempt.deployment_key = proof.deployment_key
              and attempt.bootstrap_proof_revision = proof.proof_revision
              and attempt.state in (
                'assembling', 'ready', 'in_progress', 'retry_wait'
              )
          )
        order by proof.proof_revision
        limit ${remaining}
      `);
      for (const proof of obsoleteProofRows) {
        await transaction.$executeRaw(Prisma.sql`
          select set_config(
            'packscout.catalog_retention_delete_proof_revision',
            ${String(proof.proofRevision)}, true
          )
        `);
        const deleted = await transaction.$executeRaw(Prisma.sql`
          delete from public.catalog_promotion_bootstrap_provider_proofs
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
            and proof_revision = ${proof.proofRevision}
            and platform_key = ${target.platformKey}
            and public_provider_release_id =
              ${uuid(target.publicProviderReleaseId)}
            and provider_release_fingerprint =
              ${target.providerReleaseFingerprint}
        `);
        deletedRowCount += deleted;
        remaining -= deleted;
      }
      if (remaining > 0) {
        const deleted = await transaction.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`
            delete from public.provider_promotion_operations
            where id in (
              select operation.id
              from public.provider_promotion_operations as operation
              join public.provider_promotion_attempts as attempt
                on attempt.id = operation.attempt_id
              where attempt.organization_id = ${uuid(this.#organizationId)}
                and attempt.deployment_key = ${this.#deploymentKey}
                and attempt.platform_key = ${target.platformKey}
                and attempt.public_provider_release_id =
                  ${uuid(target.publicProviderReleaseId)}
                and attempt.provider_release_fingerprint =
                  ${target.providerReleaseFingerprint}
                and attempt.state in (
                  'published', 'reused', 'superseded', 'cas_lost', 'failed'
                )
              order by attempt.evaluation_sequence, operation.operation_index,
                       operation.id
              limit ${remaining}
            ) returning id::text
          `,
        );
        deletedRowCount += deleted.length;
        remaining -= deleted.length;
      }
      if (remaining > 0) {
        const artifact = await transaction.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`
            delete from public.provider_release_artifacts
            where organization_id = ${uuid(this.#organizationId)}
              and deployment_key = ${this.#deploymentKey}
              and platform_key = ${target.platformKey}
              and public_provider_release_id =
                ${uuid(target.publicProviderReleaseId)}
              and provider_release_fingerprint =
                ${target.providerReleaseFingerprint}
            returning public_provider_release_id::text as id
          `,
        );
        deletedRowCount += artifact.length;
        remaining -= artifact.length;
      }
      while (remaining >= 2) {
        const candidates = await transaction.$queryRaw<Array<{
          attemptId: string;
          evaluationSequence: bigint;
        }>>(Prisma.sql`
          select attempt.id::text as "attemptId",
                 attempt.evaluation_sequence as "evaluationSequence"
          from public.provider_promotion_attempts as attempt
          where attempt.organization_id = ${uuid(this.#organizationId)}
            and attempt.deployment_key = ${this.#deploymentKey}
            and attempt.platform_key = ${target.platformKey}
            and attempt.public_provider_release_id =
              ${uuid(target.publicProviderReleaseId)}
            and attempt.provider_release_fingerprint =
              ${target.providerReleaseFingerprint}
            and attempt.state in (
              'published', 'reused', 'superseded', 'cas_lost', 'failed'
            )
            and not exists (
              select 1 from public.provider_promotion_operations as operation
              where operation.attempt_id = attempt.id
            )
          order by attempt.evaluation_sequence, attempt.id
          limit 1
        `);
        const candidate = candidates[0];
        if (!candidate) break;
        await transaction.$executeRaw(Prisma.sql`
          select set_config(
            'packscout.catalog_retention_delete_evaluation_sequence',
            ${String(candidate.evaluationSequence)}, true
          )
        `);
        const attemptCount = await transaction.$executeRaw(Prisma.sql`
          delete from public.provider_promotion_attempts
          where id = ${uuid(candidate.attemptId)}
            and organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
            and platform_key = ${target.platformKey}
            and public_provider_release_id =
              ${uuid(target.publicProviderReleaseId)}
            and provider_release_fingerprint =
              ${target.providerReleaseFingerprint}
        `);
        const evaluationCount = await transaction.$executeRaw(Prisma.sql`
          delete from public.provider_promotion_evaluations
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
            and platform_key = ${target.platformKey}
            and evaluation_sequence = ${candidate.evaluationSequence}
        `);
        if (attemptCount !== 1 || evaluationCount !== 1) return stateConflict();
        deletedRowCount += 2;
        remaining -= 2;
      }
      if (remaining > 0) {
        const parents = await transaction.$queryRaw<Array<{
          proofRevision: bigint;
        }>>(Prisma.sql`
          select proof.proof_revision as "proofRevision"
          from public.catalog_promotion_bootstrap_proofs as proof
          join public.manifest_promotion_lanes as lane
            on lane.organization_id = proof.organization_id
           and lane.deployment_key = proof.deployment_key
          where proof.organization_id = ${uuid(this.#organizationId)}
            and proof.deployment_key = ${this.#deploymentKey}
            and proof.proof_revision <> lane.current_bootstrap_proof_revision
            and not exists (
              select 1 from public.catalog_promotion_bootstrap_provider_proofs
              where organization_id = proof.organization_id
                and deployment_key = proof.deployment_key
                and proof_revision = proof.proof_revision
            )
            and not exists (
              select 1 from public.provider_promotion_attempts
              where organization_id = proof.organization_id
                and deployment_key = proof.deployment_key
                and bootstrap_proof_revision = proof.proof_revision
            )
            and not exists (
              select 1 from public.manifest_promotion_attempts
              where organization_id = proof.organization_id
                and deployment_key = proof.deployment_key
                and bootstrap_proof_revision = proof.proof_revision
            )
          order by proof.proof_revision
          limit 1
        `);
        const parent = parents[0];
        if (parent) {
          await transaction.$executeRaw(Prisma.sql`
            select set_config(
              'packscout.catalog_retention_delete_proof_revision',
              ${String(parent.proofRevision)}, true
            )
          `);
          const deleted = await transaction.$executeRaw(Prisma.sql`
            delete from public.catalog_promotion_bootstrap_proofs
            where organization_id = ${uuid(this.#organizationId)}
              and deployment_key = ${this.#deploymentKey}
              and proof_revision = ${parent.proofRevision}
          `);
          deletedRowCount += deleted;
        }
      }
      if (deletedRowCount > input.maximumRows) return stateConflict();
      const complete = await this.#artifactGraphAbsent(transaction, target);
      if (complete) {
        await transaction.$executeRaw(Prisma.sql`
          update public.catalog_promotion_retention_operations
          set postgres_cleanup_complete = true, updated_at = clock_timestamp()
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
            and operation_id = ${input.operationId}
        `);
      } else if (deletedRowCount === 0) {
        throw new CatalogPromotionRetentionPersistenceError(
          "CATALOG_PROMOTION_RETENTION_STATE_CONFLICT",
        );
      }
      return { deletedRowCount, complete };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async releaseBarrier(input: Readonly<{
    barrierToken: string;
  }>): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      await this.#lockOrganization(transaction);
      const barrier = await this.#requireBarrier(transaction, input.barrierToken);
      const stored = await parseStoredProof(barrier);
      const incomplete = await transaction.$queryRaw<Array<{ present: boolean }>>(
        Prisma.sql`
          select exists (
            select 1 from public.catalog_promotion_retention_operations
            where organization_id = ${uuid(this.#organizationId)}
              and deployment_key = ${this.#deploymentKey}
              and barrier_generation = ${barrier.barrierGeneration}
              and (state <> 'acknowledged' or postgres_cleanup_complete = false)
          ) as present
        `,
      );
      if (incomplete[0]?.present || !barrier.manifestPhaseComplete) {
        throw new CatalogPromotionRetentionPersistenceError(
          "CATALOG_PROMOTION_RETENTION_OPERATION_ORDER",
        );
      }
      for (const head of stored.proof.completedHeads) {
        const rows = await transaction.$queryRaw<Array<{ complete: boolean }>>(
          Prisma.sql`
            select exists (
              select 1 from public.catalog_promotion_retention_operations
              where organization_id = ${uuid(this.#organizationId)}
                and deployment_key = ${this.#deploymentKey}
                and barrier_generation = ${barrier.barrierGeneration}
                and phase = 'provider_releases'
                and platform_key = ${head.platformKey}
                and state = 'acknowledged' and terminal_state = 'complete'
                and postgres_cleanup_complete = true
            ) as complete
          `,
        );
        if (!rows[0]?.complete) {
          throw new CatalogPromotionRetentionPersistenceError(
            "CATALOG_PROMOTION_RETENTION_OPERATION_ORDER",
          );
        }
      }
      const updated = await transaction.$executeRaw(Prisma.sql`
        update public.catalog_promotion_retention_barriers
        set state = 'inactive', barrier_token = null,
            snapshot_body = null, snapshot_digest = null,
            manifest_phase_complete = false, completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and barrier_token = ${uuid(input.barrierToken)} and state = 'active'
      `);
      return updated === 1;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async #lockOrganization(transaction: PackscoutTransactionClient) {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      select id::text from public.organizations
      where id = ${uuid(this.#organizationId)} for update
    `);
    if (rows.length !== 1) return stateConflict();
  }

  async #assertNoUnresolvedPromotionWork(
    transaction: PackscoutTransactionClient,
  ): Promise<void> {
    const rows = await transaction.$queryRaw<Array<{ blocked: boolean }>>(
      Prisma.sql`
        select exists (
          select 1
          from public.provider_promotion_attempts as attempt
          where attempt.organization_id = ${uuid(this.#organizationId)}
            and attempt.deployment_key = ${this.#deploymentKey}
            and attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
            and attempt.claim_expires_at > clock_timestamp()
        ) or exists (
          select 1
          from public.manifest_promotion_attempts as attempt
          where attempt.organization_id = ${uuid(this.#organizationId)}
            and attempt.deployment_key = ${this.#deploymentKey}
            and attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
            and attempt.claim_expires_at > clock_timestamp()
        ) or exists (
          select 1
          from public.provider_promotion_operations as operation
          join public.provider_promotion_attempts as attempt
            on attempt.id = operation.attempt_id
           and attempt.organization_id = operation.organization_id
           and attempt.deployment_key = operation.deployment_key
           and attempt.platform_key = operation.platform_key
          where operation.organization_id = ${uuid(this.#organizationId)}
            and operation.deployment_key = ${this.#deploymentKey}
            and operation.state <> 'acknowledged'
            and attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
        ) or exists (
          select 1
          from public.manifest_promotion_operations as operation
          join public.manifest_promotion_attempts as attempt
            on attempt.id = operation.attempt_id
           and attempt.organization_id = operation.organization_id
           and attempt.deployment_key = operation.deployment_key
          where operation.organization_id = ${uuid(this.#organizationId)}
            and operation.deployment_key = ${this.#deploymentKey}
            and operation.state <> 'acknowledged'
            and attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
        ) as blocked
      `,
    );
    if (rows[0]?.blocked !== false) stateConflict();
  }

  async #lockBarrier(transaction: PackscoutTransactionClient) {
    const rows = await transaction.$queryRaw<BarrierRow[]>(Prisma.sql`
      select barrier_generation as "barrierGeneration",
             barrier_token::text as "barrierToken", state,
             retention_generation as "retentionGeneration",
             next_operation_index as "nextOperationIndex",
             manifest_phase_complete as "manifestPhaseComplete",
             snapshot_body as "snapshotBody", snapshot_digest as "snapshotDigest"
      from public.catalog_promotion_retention_barriers
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey} for update
    `);
    return rows[0] ?? stateConflict();
  }

  async #requireBarrier(
    transaction: PackscoutTransactionClient,
    token: string,
  ) {
    const barrier = await this.#lockBarrier(transaction);
    if (barrier.state !== "active") {
      throw new CatalogPromotionRetentionPersistenceError(
        "CATALOG_PROMOTION_RETENTION_BARRIER_INACTIVE",
      );
    }
    if (barrier.barrierToken !== token) {
      throw new CatalogPromotionRetentionPersistenceError(
        "CATALOG_PROMOTION_RETENTION_TOKEN_INVALID",
      );
    }
    await parseStoredProof(barrier);
    return barrier;
  }

  async #loadFirstPendingOperation(transaction: PackscoutTransactionClient) {
    const rows = await transaction.$queryRaw<OperationRow[]>(Prisma.sql`
      select ${operationProjection}
      from public.catalog_promotion_retention_operations
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and state <> 'acknowledged'
      order by barrier_generation, operation_index limit 1 for update
    `);
    return rows[0] ?? null;
  }

  async #lockOperation(
    transaction: PackscoutTransactionClient,
    operationId: string,
  ) {
    const rows = await transaction.$queryRaw<OperationRow[]>(Prisma.sql`
      select ${operationProjection}
      from public.catalog_promotion_retention_operations
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and operation_id = ${operationId} for update
    `);
    if (rows.length !== 1) {
      throw new CatalogPromotionRetentionPersistenceError(
        "CATALOG_PROMOTION_RETENTION_OPERATION_CONFLICT",
      );
    }
    return rows[0]!;
  }

  async #validateEvidence(
    operation: OperationRow,
    evidence: CatalogPromotionRetentionReceiptEvidence,
  ): Promise<Readonly<{ receipt: CatalogRetentionReceipt; receiptSha256: string }>> {
    try {
      const request = operation.operationKind === "retainManifests"
        ? catalogRetentionManifestRequestSchema.parse(
            JSON.parse(operation.canonicalRequestBody),
          )
        : catalogRetentionProviderRequestSchema.parse(
            JSON.parse(operation.canonicalRequestBody),
          );
      if (canonicalJson(request) !== operation.canonicalRequestBody ||
        promotionV2Sha256(operation.canonicalRequestBody) !==
          operation.requestSha256) throw new Error("request");
      const schema = operation.operationKind === "retainManifests"
        ? catalogRetentionManifestReceiptSchema
        : catalogRetentionProviderReceiptSchema;
      const receipt = schema.parse(JSON.parse(evidence.canonicalReceiptBody));
      const envelope = catalogRetentionSignedReceiptEnvelopeSchema.parse(
        JSON.parse(evidence.exactResponseBody),
      );
      const requestDigest = await catalogRetentionPublicationRequestDigest(request);
      if (canonicalJson(receipt) !== evidence.canonicalReceiptBody ||
        canonicalJson(envelope.receipt) !== evidence.canonicalReceiptBody ||
        receipt.operationKind !== operation.operationKind ||
        receipt.operationId !== operation.operationId ||
        receipt.idempotencyKey !== request.idempotencyKey ||
        receipt.phase !== request.phase ||
        receipt.platformKey !== (request.phase === "manifests"
          ? null : request.platformKey) ||
        receipt.requestDigest !== requestDigest ||
        receipt.expectedRetentionGeneration !==
          request.expectedRetentionGeneration ||
        receipt.details.maximumDocuments !== request.maximumDocuments ||
        receipt.details.protectionSet.postgresProofSnapshotId !==
          request.postgresProof.snapshotId ||
        receipt.details.protectionSet.postgresProofSnapshotSequence !==
          request.postgresProof.snapshotSequence ||
        receipt.details.protectionSet.postgresProofSnapshotDigest !==
          request.postgresProof.snapshotDigest ||
        receipt.receiptDigest !== await catalogRetentionReceiptDigest(receipt)) {
        throw new Error("binding");
      }
      return {
        receipt,
        receiptSha256: await catalogRetentionTerminalReceiptSha256(receipt),
      };
    } catch {
      throw new CatalogPromotionRetentionPersistenceError(
        "CATALOG_PROMOTION_RETENTION_RECEIPT_INVALID",
      );
    }
  }

  #releaseIsProtected(
    receipt: CatalogRetentionReceipt,
    selected: Readonly<{
      platformKey: string;
      publicProviderReleaseId: string;
      providerReleaseFingerprint: string;
    }>,
  ) {
    const group = receipt.details.protectionSet.providerReleasesByPlatform
      .find(({ platformKey }) => platformKey === selected.platformKey);
    return group?.releases.some((release) =>
      release.publicProviderReleaseId === selected.publicProviderReleaseId &&
      release.providerReleaseFingerprint ===
        selected.providerReleaseFingerprint) ?? false;
  }

  async #assertArtifactDeletable(
    transaction: PackscoutTransactionClient,
    target: Readonly<{
      platformKey: string;
      publicProviderReleaseId: string;
      providerReleaseFingerprint: string;
    }>,
  ) {
    const rows = await transaction.$queryRaw<Array<{
      artifactCount: bigint;
      activeReferenceCount: bigint;
    }>>(Prisma.sql`
      select
        (select count(*) from public.provider_release_artifacts
         where organization_id = ${uuid(this.#organizationId)}
           and deployment_key = ${this.#deploymentKey}
           and platform_key = ${target.platformKey}
           and public_provider_release_id = ${uuid(target.publicProviderReleaseId)}
           and provider_release_fingerprint =
             ${target.providerReleaseFingerprint}) as "artifactCount",
        (
          (select count(*) from public.provider_promotion_lanes
           where organization_id = ${uuid(this.#organizationId)}
             and deployment_key = ${this.#deploymentKey}
             and platform_key = ${target.platformKey}
             and completed_public_provider_release_id =
               ${uuid(target.publicProviderReleaseId)})
          +
          (select count(*) from public.manifest_active_provider_selections
           where organization_id = ${uuid(this.#organizationId)}
             and deployment_key = ${this.#deploymentKey}
             and platform_key = ${target.platformKey}
             and provider_public_release_id =
               ${uuid(target.publicProviderReleaseId)})
          +
          (select count(*)
           from public.catalog_promotion_bootstrap_provider_proofs as proof
           join public.manifest_promotion_lanes as lane
             on lane.organization_id = proof.organization_id
            and lane.deployment_key = proof.deployment_key
            and lane.current_bootstrap_proof_revision = proof.proof_revision
           where proof.organization_id = ${uuid(this.#organizationId)}
             and proof.deployment_key = ${this.#deploymentKey}
           and proof.platform_key = ${target.platformKey}
           and proof.public_provider_release_id =
               ${uuid(target.publicProviderReleaseId)}
             and proof.provider_release_fingerprint =
               ${target.providerReleaseFingerprint})
          +
          (select count(*) from public.provider_promotion_attempts
           where organization_id = ${uuid(this.#organizationId)}
             and deployment_key = ${this.#deploymentKey}
             and platform_key = ${target.platformKey}
             and public_provider_release_id =
               ${uuid(target.publicProviderReleaseId)}
             and state in ('assembling', 'ready', 'in_progress', 'retry_wait'))
        ) as "activeReferenceCount"
    `);
    const row = rows[0];
    if (!row || row.artifactCount < 0n || row.artifactCount > 1n) {
      return stateConflict();
    }
    if (row.activeReferenceCount !== 0n) {
      throw new CatalogPromotionRetentionPersistenceError(
        "CATALOG_PROMOTION_RETENTION_UNSAFE",
      );
    }
  }

  async #artifactGraphAbsent(
    transaction: PackscoutTransactionClient,
    target: Readonly<{
      platformKey: string;
      publicProviderReleaseId: string;
      providerReleaseFingerprint: string;
    }>,
  ) {
    const rows = await transaction.$queryRaw<Array<{ absent: boolean }>>(
      Prisma.sql`
        select not exists (
          select 1 from public.provider_release_artifacts
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
            and platform_key = ${target.platformKey}
            and public_provider_release_id =
              ${uuid(target.publicProviderReleaseId)}
            and provider_release_fingerprint =
              ${target.providerReleaseFingerprint}
        ) and not exists (
          select 1 from public.provider_promotion_attempts
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
            and platform_key = ${target.platformKey}
            and public_provider_release_id =
              ${uuid(target.publicProviderReleaseId)}
            and provider_release_fingerprint =
              ${target.providerReleaseFingerprint}
        ) and not exists (
          select 1 from public.catalog_promotion_bootstrap_provider_proofs
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
            and platform_key = ${target.platformKey}
            and public_provider_release_id =
              ${uuid(target.publicProviderReleaseId)}
            and provider_release_fingerprint =
              ${target.providerReleaseFingerprint}
        ) as absent
      `,
    );
    return rows[0]?.absent === true;
  }
}
