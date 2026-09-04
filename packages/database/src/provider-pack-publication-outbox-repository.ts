import {
  PACK_SNAPSHOT_HASH_DOMAIN, activePackHeadSchema, hashPackCatalogValue, packActivationIntentSchema,
  packCatalogCanonicalJson, packCatalogOperationReceiptSchema, packCatalogUuidSchema, packPublicationLimits,
  providerPackPublicationOperationSchema, type ActivePackHead, type PackActivationIntent,
  type ProviderPackPublicationOperation,
} from "@packscout/contracts";
import { ProviderPackPublicationContext, packInvariant, type PackWorkClaim } from "./provider-pack-publication-context.ts";

const equal = (a: unknown, b: unknown) => packCatalogCanonicalJson(a) === packCatalogCanonicalJson(b);
const hash = (value: unknown) => hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, value);

/** Persistence only: P06 supplies authenticated public-store responses, never transport secrets. */
export class ProviderPackPublicationOutboxRepository {
  constructor(readonly context: ProviderPackPublicationContext) {}
  claim(owner: string, limit = 1) { return this.context.claim("activation", owner, limit); }
  renew(claim: PackWorkClaim) { return this.context.renew(claim); }
  async load(claim: PackWorkClaim): Promise<PackActivationIntent> {
    return this.context.transaction(async tx => {
      await this.context.lockLease(tx, claim, "activation");
      const row = await tx.pack_activation_intents.findUniqueOrThrow({ where: { id: claim.workId } });
      return packActivationIntentSchema.parse(row.intent_json);
    });
  }
  async recordOperation(claim: PackWorkClaim, input: ProviderPackPublicationOperation): Promise<string> {
    return this.context.transaction(async tx => {
      const head = await this.context.lockLease(tx, claim, "activation");
      const operation = providerPackPublicationOperationSchema.parse(input);
      packInvariant(operation.organizationId === this.context.scope.organizationId &&
        operation.intent.snapshot.providerId === this.context.scope.providerId &&
        operation.intent.snapshot.publicRepackId === claim.publicRepackId && operation.intent.intentId === claim.workId, "PACK_SCOPE_MISMATCH");
      const intent = await tx.pack_activation_intents.findUniqueOrThrow({ where: { id: claim.workId } });
      packInvariant(equal(intent.intent_json, operation.intent), "PACK_INPUT_INVALID");
      const digest = await hash(operation);
      const existing = await tx.pack_publication_operations.findUnique({ where: {
        intent_id_idempotency_key: { intent_id: claim.workId, idempotency_key: operation.idempotencyKey } } });
      // An expired operation remains readable for receipt reconciliation; it cannot be re-created.
      if (existing) { packInvariant(existing.request_sha256 === digest && equal(existing.request_json, operation)); return digest; }
      packInvariant(!head.held && head.latest_sequence === BigInt(claim.sequence) &&
        head.publication_epoch === BigInt(operation.intent.expectedHead.publicationEpoch) &&
        Date.parse(operation.intent.expiresAt) > (await this.context.now(tx)).getTime());
      const artifact = await tx.pack_snapshot_artifacts.findUniqueOrThrow({ where: { public_pack_snapshot_id: intent.public_pack_snapshot_id } });
      let expectedPayload: unknown = operation.kind === "activate_head" ? operation.intent : artifact.descriptor_json;
      if (operation.kind === "stage_batch") {
        const batch = await tx.pack_snapshot_batches.findUniqueOrThrow({ where: { public_pack_snapshot_id_batch_index: {
          public_pack_snapshot_id: intent.public_pack_snapshot_id, batch_index: operation.batchIndex! } } });
        expectedPayload = batch.batch_json;
      }
      packInvariant(operation.payloadSha256 === await hash(expectedPayload), "PACK_INPUT_INVALID");
      packInvariant(await tx.pack_publication_operations.count({ where: { intent_id: claim.workId } }) < packPublicationLimits.maximumOperations, "PACK_LIMIT_EXCEEDED");
      await tx.pack_publication_operations.create({ data: { ...this.context.where, public_repack_id: claim.publicRepackId,
        intent_id: claim.workId, id: operation.operationId, idempotency_key: operation.idempotencyKey,
        request_sha256: digest, request_json: operation } });
      return digest;
    });
  }
  async recordReceipt(claim: PackWorkClaim, input: unknown): Promise<void> {
    await this.context.transaction(async tx => {
      await this.context.lockLease(tx, claim, "activation");
      const receipt = packCatalogOperationReceiptSchema.parse(input);
      const operation = await tx.pack_publication_operations.findFirst({ where: { ...this.context.where,
        public_repack_id: claim.publicRepackId, intent_id: claim.workId, id: receipt.operationId } });
      packInvariant(operation && operation.request_sha256 === receipt.requestSha256, "PACK_INPUT_INVALID");
      const completedAt = Date.parse(receipt.completedAt);
      packInvariant(completedAt >= operation.created_at.getTime() && completedAt <= (await this.context.now(tx)).getTime(), "PACK_INPUT_INVALID");
      const digest = await hash(receipt);
      const previous = await tx.pack_publication_receipts.findUnique({ where: { operation_id: receipt.operationId } });
      if (previous) { packInvariant(previous.receipt_sha256 === digest && equal(previous.receipt_json, receipt)); return; }
      await tx.pack_publication_receipts.create({ data: { ...this.context.where, public_repack_id: claim.publicRepackId,
        intent_id: claim.workId, operation_id: receipt.operationId, receipt_sha256: digest, receipt_json: receipt } });
    });
  }
  async readOperation(claim: PackWorkClaim, operationId: string) {
    packCatalogUuidSchema.parse(operationId);
    return this.context.transaction(async tx => {
      await this.context.lockLease(tx, claim, "activation");
      const row = await tx.pack_publication_operations.findFirst({ where: { ...this.context.where,
        public_repack_id: claim.publicRepackId, intent_id: claim.workId, id: operationId }, include: { receipt: true } });
      return row ? { operation: providerPackPublicationOperationSchema.parse(row.request_json), requestSha256: row.request_sha256,
        receipt: row.receipt ? packCatalogOperationReceiptSchema.parse(row.receipt.receipt_json) : null } : null;
    });
  }
  async complete(claim: PackWorkClaim, operationId: string, observedHead: ActivePackHead): Promise<void> {
    packCatalogUuidSchema.parse(operationId);
    await this.context.transaction(async tx => {
      const mirror = await this.context.lockLease(tx, claim, "activation");
      const head = await activePackHeadSchema.parseAsync(observedHead);
      const row = await tx.pack_publication_operations.findFirst({ where: { ...this.context.where,
        public_repack_id: claim.publicRepackId, intent_id: claim.workId, id: operationId }, include: { receipt: true } });
      packInvariant(row?.receipt);
      const operation = providerPackPublicationOperationSchema.parse(row.request_json);
      const receipt = packCatalogOperationReceiptSchema.parse(row.receipt.receipt_json);
      packInvariant(operation.kind === "activate_head" && receipt.requestSha256 === row.request_sha256 &&
        ["applied", "already_applied", "already_active"].includes(receipt.result.outcome) &&
        receipt.result.state === "published" && receipt.result.reasonCode === null);
      packInvariant(head.providerId === this.context.scope.providerId && head.publicRepackId === claim.publicRepackId &&
        equal(head.activeSnapshot, operation.intent.snapshot) && head.latestAcceptedPackPublicationSequence === claim.sequence &&
        head.generation >= operation.intent.expectedHead.generation + 1 &&
        head.publicationEpoch === operation.intent.expectedHead.publicationEpoch &&
        BigInt(head.generation) >= mirror.generation && BigInt(head.publicationEpoch) >= mirror.publication_epoch, "PACK_INPUT_INVALID");
      await tx.pack_activation_intents.update({ where: { id: claim.workId }, data: { state: "published", reason_code: null } });
      await tx.pack_publication_heads.update({ where: { public_repack_id: claim.publicRepackId }, data: {
        generation: head.generation, publication_epoch: head.publicationEpoch, held: head.held,
        active_snapshot_id: head.activeSnapshot.publicPackSnapshotId } });
      await this.context.release(tx, claim);
    });
  }
  /** Mirror an authenticated authoritative read; retire incompatible work before fencing owners. */
  async observeHead(input: ActivePackHead): Promise<void> {
    const head = await activePackHeadSchema.parseAsync(input);
    packInvariant(head.providerId === this.context.scope.providerId, "PACK_SCOPE_MISMATCH");
    await this.context.transaction(async tx => {
      await tx.$queryRaw`SELECT public_repack_id FROM pack_publication_heads WHERE public_repack_id = ${head.publicRepackId}::uuid FOR UPDATE`;
      const previous = await tx.pack_publication_heads.findUniqueOrThrow({ where: { public_repack_id: head.publicRepackId } });
      packInvariant(BigInt(head.generation) >= previous.generation && BigInt(head.publicationEpoch) >= previous.publication_epoch);
      if (BigInt(head.generation) === previous.generation && BigInt(head.publicationEpoch) === previous.publication_epoch) {
        packInvariant(previous.active_snapshot_id === head.activeSnapshot.publicPackSnapshotId && previous.held === head.held);
        return;
      }
      // Every pending intent was sealed against the previous mirrored head. Keep
      // its immutable evidence, but never reacquire that obsolete CAS episode.
      await tx.pack_activation_intents.updateMany({ where: { ...this.context.where, public_repack_id: head.publicRepackId,
        state: { in: ["waiting", "ready", "publishing", "retry_scheduled"] } },
        data: { state: "superseded", reason_code: "ACTIVATION_CONFLICT" } });
      // A full build can survive a generation-only change; epoch-bound and
      // lifecycle-baseline-bound captures cannot. Prepared resume work survives.
      await tx.$executeRaw`UPDATE pack_build_requests SET state = 'superseded', reason_code = 'ACTIVATION_CONFLICT'
        WHERE organization_id = ${this.context.scope.organizationId}::uuid AND provider_id = ${this.context.scope.providerId}::uuid
          AND public_repack_id = ${head.publicRepackId}::uuid AND state IN ('waiting','ready','publishing','retry_scheduled')
          AND (expected_publication_epoch <> ${BigInt(head.publicationEpoch)}
            OR (inputs_json->>'snapshotKind' = 'lifecycle_only'
              AND inputs_json #>> '{lifecycleBaseline,identity,publicPackSnapshotId}' IS DISTINCT FROM ${head.activeSnapshot.publicPackSnapshotId}))`;
      await tx.pack_publication_heads.update({ where: { public_repack_id: head.publicRepackId }, data: {
        generation: head.generation, publication_epoch: head.publicationEpoch, held: head.held,
        active_snapshot_id: head.activeSnapshot.publicPackSnapshotId, lease_owner: null, lease_kind: null,
        lease_work_id: null, lease_expires_at: null, lease_fence: { increment: 1 } } });
    });
  }
}
