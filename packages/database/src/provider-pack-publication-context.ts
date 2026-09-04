import {
  packCatalogSequenceSchema, packCatalogUuidSchema, packPublicationLimits, packPublicationScopeSchema,
  publicationReasonCodeSchema, type PackPublicationScope, type PublicationReasonCode,
} from "@packscout/contracts";
import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderPrismaClient, ProviderTransactionClient } from "./provider-database.ts";

export type PackWorkKind = "build" | "activation";
export interface PackWorkClaim {
  kind: PackWorkKind;
  publicRepackId: string;
  workId: string;
  sequence: string;
  owner: string;
  fence: string;
  expiresAt: string;
}
export class PackPublicationPersistenceError extends Error {
  constructor(readonly code: "PACK_SCOPE_MISMATCH" | "PACK_LEASE_LOST" | "PACK_STATE_CONFLICT" | "PACK_INPUT_INVALID" | "PACK_LIMIT_EXCEEDED" | "PACK_PERSISTENCE_FAILED") {
    super(code); this.name = "PackPublicationPersistenceError";
  }
}
export function packInvariant(condition: unknown, code: PackPublicationPersistenceError["code"] = "PACK_STATE_CONFLICT"): asserts condition {
  if (!condition) throw new PackPublicationPersistenceError(code);
}
export function boundedPackInteger(value: number, maximum: number): number {
  packInvariant(Number.isSafeInteger(value) && value > 0 && value <= maximum, "PACK_INPUT_INVALID");
  return value;
}
export const packWorkTable = (kind: PackWorkKind) => Prisma.raw(kind === "build" ? "pack_build_requests" : "pack_activation_intents");

/** State describes the snapshot, not whether this command activated it.
 * Only a definitive conflict/refusal proves non-activation; expired replay does not. */
export function unreconciledPackOperations(intentId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM pack_publication_operations pack_op
    LEFT JOIN pack_publication_receipts pack_receipt ON pack_receipt.operation_id = pack_op.id WHERE pack_op.intent_id = ${intentId}
    AND (pack_receipt.operation_id IS NULL OR pack_receipt.receipt_json->>'requestSha256' IS DISTINCT FROM pack_op.request_sha256
      OR COALESCE(pack_op.request_json->>'kind', '') NOT IN ('start_snapshot','stage_batch','finalize_snapshot','activate_head')
      OR (pack_op.request_json->>'kind' = 'activate_head' AND NOT (
        COALESCE(pack_receipt.receipt_json #>> '{result,outcome}', '') IN ('conflict','refused')
        AND pack_receipt.receipt_json #>> '{result,reasonCode}' IS NOT NULL))))`;
}

/** One trusted, provisioned organization/provider binding. Never accepts a connection target. */
export class ProviderPackPublicationContext {
  readonly scope: PackPublicationScope;
  constructor(readonly client: ProviderPrismaClient, scope: PackPublicationScope) {
    this.scope = Object.freeze(packPublicationScopeSchema.parse(scope));
  }
  get where() { return { organization_id: this.scope.organizationId, provider_id: this.scope.providerId }; }
  async initialize(): Promise<void> {
    await this.transaction(async tx => {
      const identity = await tx.database_identity.findUnique({ where: { singleton_key: true } });
      packInvariant(identity?.provider_id === this.scope.providerId, "PACK_SCOPE_MISMATCH");
      await tx.pack_publication_scopes.upsert({ where: { provider_id: this.scope.providerId },
        create: this.where, update: {} });
      await this.assertScope(tx);
    }, false);
  }
  async assertScope(tx: ProviderTransactionClient): Promise<void> {
    const identity = await tx.database_identity.findUnique({ where: { singleton_key: true } });
    const scope = await tx.pack_publication_scopes.findUnique({ where: { provider_id: this.scope.providerId } });
    packInvariant(identity?.provider_id === this.scope.providerId && scope?.organization_id === this.scope.organizationId, "PACK_SCOPE_MISMATCH");
  }
  async transaction<T>(run: (tx: ProviderTransactionClient) => Promise<T>, checkScope = true): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.client.$transaction(async tx => {
          if (checkScope) await this.assertScope(tx);
          return run(tx);
        }, { isolationLevel: "RepeatableRead", timeout: 30_000, maxWait: 5_000 });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && attempt < 2 &&
          (error.code === "P2034" || (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code))))) continue;
        if (error instanceof PackPublicationPersistenceError) throw error;
        throw new PackPublicationPersistenceError("PACK_PERSISTENCE_FAILED");
      }
    }
  }
  async now(tx: ProviderTransactionClient): Promise<Date> {
    const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return row!.now;
  }
  async operationsNeedReconciliation(tx: ProviderTransactionClient, intentId: string): Promise<boolean> {
    const [row] = await tx.$queryRaw<Array<{ required: boolean }>>(Prisma.sql`
      SELECT ${unreconciledPackOperations(Prisma.sql`${intentId}::uuid`)} AS required`);
    return row!.required;
  }
  async lockLease(tx: ProviderTransactionClient, claim: PackWorkClaim, kind: PackWorkKind) {
    packInvariant(["build", "activation"].includes(kind) && claim.kind === kind, "PACK_LEASE_LOST");
    for (const id of [claim.publicRepackId, claim.workId, claim.owner]) packCatalogUuidSchema.parse(id);
    packCatalogSequenceSchema.parse(claim.fence); packCatalogSequenceSchema.parse(claim.sequence);
    const rows = await tx.$queryRaw<Array<{ latest_sequence: bigint; accepted_sequence: bigint; publication_epoch: bigint; generation: bigint; held: boolean; active_snapshot_id: string | null }>>`
      SELECT latest_sequence, accepted_sequence, publication_epoch, generation, held, active_snapshot_id FROM pack_publication_heads
      WHERE organization_id = ${this.scope.organizationId}::uuid AND provider_id = ${this.scope.providerId}::uuid
        AND public_repack_id = ${claim.publicRepackId}::uuid AND lease_work_id = ${claim.workId}::uuid
        AND lease_owner = ${claim.owner}::uuid AND lease_fence = ${BigInt(claim.fence)} AND lease_kind = ${kind}
        AND lease_expires_at > clock_timestamp() FOR UPDATE`;
    packInvariant(rows[0], "PACK_LEASE_LOST");
    const work = await tx.$queryRaw<Array<{ pack_publication_sequence: bigint; state: string }>>(Prisma.sql`
      SELECT pack_publication_sequence, state FROM ${packWorkTable(kind)} WHERE id = ${claim.workId}::uuid`);
    packInvariant(work[0]?.state === "publishing" && work[0]?.pack_publication_sequence === BigInt(claim.sequence), "PACK_LEASE_LOST");
    return rows[0];
  }
  async release(tx: ProviderTransactionClient, claim: PackWorkClaim): Promise<void> {
    const changed = await tx.$executeRaw`UPDATE pack_publication_heads
      SET lease_owner = NULL, lease_work_id = NULL, lease_kind = NULL, lease_expires_at = NULL
      WHERE organization_id = ${this.scope.organizationId}::uuid AND provider_id = ${this.scope.providerId}::uuid
        AND public_repack_id = ${claim.publicRepackId}::uuid AND lease_work_id = ${claim.workId}::uuid
        AND lease_owner = ${claim.owner}::uuid AND lease_fence = ${BigInt(claim.fence)} AND lease_kind = ${claim.kind}
        AND lease_expires_at > clock_timestamp()`;
    packInvariant(changed === 1, "PACK_LEASE_LOST");
  }
  async claim(kind: PackWorkKind, ownerInput: string, limit = 1, leaseSeconds: number = packPublicationLimits.leaseSeconds): Promise<PackWorkClaim[]> {
    packInvariant(["build", "activation"].includes(kind), "PACK_INPUT_INVALID");
    const owner = packCatalogUuidSchema.parse(ownerInput);
    boundedPackInteger(limit, packPublicationLimits.claimBatch);
    boundedPackInteger(leaseSeconds, packPublicationLimits.maximumLeaseSeconds);
    return this.transaction(async tx => {
      const reconciliation = Prisma.sql`SELECT r.id FROM pack_activation_intents r
        WHERE r.public_repack_id = h.public_repack_id
          AND (r.intent_json #>> '{expectedHead,publicationEpoch}')::bigint = h.publication_epoch
          AND r.state IN ('ready','publishing','retry_scheduled','waiting','blocked')
          AND ((r.pack_publication_sequence = h.accepted_sequence AND r.public_pack_snapshot_id = h.active_snapshot_id)
            OR ${unreconciledPackOperations(Prisma.sql`r.id`)})`;
      const latest = Prisma.sql`w.pack_publication_sequence = h.latest_sequence
        AND w.state IN ('ready','retry_scheduled','publishing') AND NOT EXISTS (${reconciliation})`;
      const eligible = kind === "activation" ? Prisma.sql`((${latest}) OR w.id IN (${reconciliation}))` : latest;
      const rows = await tx.$queryRaw<Array<{ public_repack_id: string; id: string; pack_publication_sequence: bigint; attempts: number }>>(Prisma.sql`
        SELECT h.public_repack_id, w.id, w.pack_publication_sequence, w.attempts
        FROM pack_publication_heads h JOIN ${packWorkTable(kind)} w
          ON w.public_repack_id = h.public_repack_id
        WHERE h.organization_id = ${this.scope.organizationId}::uuid AND h.provider_id = ${this.scope.providerId}::uuid
          AND NOT h.held AND (h.lease_expires_at IS NULL OR h.lease_expires_at <= clock_timestamp())
          AND (${eligible}) AND w.state IN ('ready','retry_scheduled','publishing','waiting') AND w.available_at <= clock_timestamp()
        ORDER BY w.available_at, w.pack_publication_sequence LIMIT ${limit} FOR UPDATE OF h SKIP LOCKED`);
      const result: PackWorkClaim[] = [];
      for (const row of rows) {
        if (row.attempts >= packPublicationLimits.maximumAttempts) {
          await tx.$executeRaw(Prisma.sql`UPDATE ${packWorkTable(kind)} SET state = 'blocked', reason_code = 'OPERATION_EXPIRED' WHERE id = ${row.id}::uuid`);
          await tx.pack_publication_heads.update({ where: { public_repack_id: row.public_repack_id }, data: {
            lease_owner: null, lease_work_id: null, lease_kind: null, lease_expires_at: null, lease_fence: { increment: 1 } } });
          continue;
        }
        // Persisted operations survive a crash even before an ambiguity marker.
        // Only explicit receipt/head reconciliation may retire those episodes.
        for (const staleKind of ["build", "activation"] as const) {
          const safe = staleKind === "activation"
            ? Prisma.sql`AND NOT ${unreconciledPackOperations(Prisma.sql`stale.id`)}` : Prisma.empty;
          await tx.$executeRaw(Prisma.sql`UPDATE ${packWorkTable(staleKind)} stale SET state = 'superseded'
            WHERE stale.public_repack_id = ${row.public_repack_id}::uuid AND stale.state = 'publishing'
              AND stale.pack_publication_sequence < ${row.pack_publication_sequence} ${safe}`);
        }
        const expiresAt = new Date((await this.now(tx)).getTime() + leaseSeconds * 1000);
        const head = await tx.pack_publication_heads.update({ where: { public_repack_id: row.public_repack_id },
          data: { lease_owner: owner, lease_work_id: row.id, lease_kind: kind, lease_fence: { increment: 1 }, lease_expires_at: expiresAt } });
        await tx.$executeRaw(Prisma.sql`UPDATE ${packWorkTable(kind)} SET state = 'publishing', attempts = attempts + 1
          WHERE id = ${row.id}::uuid`);
        result.push({ kind, publicRepackId: row.public_repack_id, workId: row.id, sequence: row.pack_publication_sequence.toString(),
          owner, fence: head.lease_fence.toString(), expiresAt: expiresAt.toISOString() });
      }
      return result;
    });
  }
  async renew(claim: PackWorkClaim, leaseSeconds: number = packPublicationLimits.leaseSeconds): Promise<void> {
    boundedPackInteger(leaseSeconds, packPublicationLimits.maximumLeaseSeconds);
    await this.transaction(async tx => {
      await this.lockLease(tx, claim, claim.kind);
      await tx.pack_publication_heads.update({ where: { public_repack_id: claim.publicRepackId },
        data: { lease_expires_at: new Date((await this.now(tx)).getTime() + leaseSeconds * 1000) } });
    });
  }
  async defer(claim: PackWorkClaim, state: "waiting" | "blocked" | "retry_scheduled" | "superseded", reason: PublicationReasonCode, retrySeconds = 1): Promise<void> {
    packInvariant(["waiting", "blocked", "retry_scheduled", "superseded"].includes(state), "PACK_INPUT_INVALID");
    publicationReasonCodeSchema.parse(reason);
    boundedPackInteger(retrySeconds, packPublicationLimits.maximumRetrySeconds);
    await this.transaction(async tx => {
      const head = await this.lockLease(tx, claim, claim.kind);
      const reconciling = claim.kind === "activation" &&
        (head.accepted_sequence === BigInt(claim.sequence) || await this.operationsNeedReconciliation(tx, claim.workId));
      packInvariant(!reconciling || state !== "superseded");
      const nextState = head.latest_sequence > BigInt(claim.sequence) && !reconciling ? "superseded" : state;
      await tx.$executeRaw(Prisma.sql`UPDATE ${packWorkTable(claim.kind)} SET state = ${nextState}, reason_code = ${reason},
        available_at = clock_timestamp() + ${retrySeconds} * interval '1 second' WHERE id = ${claim.workId}::uuid`);
      await this.release(tx, claim);
    });
  }
}
