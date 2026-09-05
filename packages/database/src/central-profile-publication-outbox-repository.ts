import { createHash } from "node:crypto";
import {
  PACK_CATALOG_OPERATION_AUTHORITY, PACK_PUBLICATION_REPLAY_LIFETIME_MS, MAX_PACK_CATALOG_HTTP_BODY_BYTES,
  assertPublicPackCatalogBytes, packCatalogCanonicalByteCount, packCatalogCanonicalJson,
  packCatalogPublicationRequestSchema, packCatalogPublicationReceiptSchema, packCatalogRequestEntity,
  packCatalogReceiptDigest, packCatalogUuidSchema, publicationReasonCodeSchema, trustedPackCatalogServiceIdentityAllows,
  type PackCatalogPublicationRequest, type PublicationReasonCode,
} from "@packscout/contracts";
import type { CentralTransactionClient } from "./central-database.ts";
import { CentralProfilePublicationContext, captureSharedInput, sharedBound, sharedEqual, sharedInvariant, sharedParse, sharedPublicationLimits, type ProfileWorkClaim } from "./central-profile-publication-context.ts";
import { loadProfileEnvelope } from "./profile-snapshot-repository.ts";

const workKey = (claim: ProfileWorkClaim) => ({ organization_id: claim.organizationId,
  profile_kind: claim.profileKind, entity_id: claim.entityId, id: claim.intentId });
const operationScope = (claim: ProfileWorkClaim) => ({ organization_id: claim.organizationId,
  profile_kind: claim.profileKind, entity_id: claim.entityId, intent_id: claim.intentId });

/** Durable journal of exact P05 requests. P06 supplies verified service credentials and signed receipts. */
export class CentralProfilePublicationOutboxRepository {
  constructor(readonly context: CentralProfilePublicationContext) {}
  claim(owner: string, limit = 1, leaseSeconds: number = sharedPublicationLimits.leaseSeconds): Promise<ProfileWorkClaim[]> {
    sharedParse(packCatalogUuidSchema, owner); sharedBound(limit, sharedPublicationLimits.claimBatch);
    sharedBound(leaseSeconds, sharedPublicationLimits.maximumLeaseSeconds);
    return this.context.transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ profile_kind: "provider" | "collectible"; entity_id: string; id: string; attempts: number }>>`
        SELECT h.profile_kind, h.entity_id, w.id, w.attempts FROM profile_publication_heads h
        JOIN profile_activation_intents w ON w.organization_id = h.organization_id AND w.profile_kind = h.profile_kind AND w.entity_id = h.entity_id
        WHERE h.organization_id = ${this.context.organizationId}::uuid
          AND (h.lease_expires_at IS NULL OR h.lease_expires_at <= clock_timestamp())
          AND w.state IN ('ready','publishing','retry_scheduled') AND w.available_at <= clock_timestamp()
          AND w.sequence = (SELECT min(p.sequence) FROM profile_activation_intents p WHERE p.organization_id = h.organization_id
            AND p.profile_kind = h.profile_kind AND p.entity_id = h.entity_id AND p.state NOT IN ('published','superseded','rolled_back'))
        ORDER BY w.available_at, w.sequence LIMIT ${limit} FOR UPDATE OF h SKIP LOCKED`;
      const result: ProfileWorkClaim[] = [];
      for (const row of rows) {
        const key = { ...this.context.where, profile_kind: row.profile_kind, entity_id: row.entity_id };
        if (row.attempts >= sharedPublicationLimits.maximumAttempts) {
          await tx.profile_activation_intents.update({ where: { organization_id_profile_kind_entity_id_id: { ...key, id: row.id } },
            data: { state: "blocked", reason_code: "OPERATION_EXPIRED" } });
          await tx.profile_publication_heads.update({ where: { organization_id_profile_kind_entity_id: key }, data: {
            lease_owner: null, lease_intent_id: null, lease_expires_at: null, lease_fence: { increment: 1 } } }); continue;
        }
        const expiresAt = new Date((await this.context.now(tx)).getTime() + leaseSeconds * 1000);
        const head = await tx.profile_publication_heads.update({ where: { organization_id_profile_kind_entity_id: key }, data: {
          lease_owner: owner, lease_intent_id: row.id, lease_fence: { increment: 1 }, lease_expires_at: expiresAt } });
        await tx.profile_activation_intents.update({ where: { organization_id_profile_kind_entity_id_id: { ...key, id: row.id } },
          data: { state: "publishing", attempts: { increment: 1 } } });
        result.push({ organizationId: this.context.organizationId, profileKind: row.profile_kind, entityId: row.entity_id,
          intentId: row.id, owner, fence: head.lease_fence.toString(), expiresAt: expiresAt.toISOString() });
      }
      return result;
    });
  }
  load(claim: ProfileWorkClaim) {
    return this.context.transaction(async tx => { await this.context.lockProfile(tx, claim); return loadProfileEnvelope(tx, workKey(claim)); });
  }
  renew(claim: ProfileWorkClaim, leaseSeconds: number = sharedPublicationLimits.leaseSeconds) {
    sharedBound(leaseSeconds, sharedPublicationLimits.maximumLeaseSeconds);
    return this.context.transaction(async tx => {
      const previous = await this.context.lockProfile(tx, claim);
      await tx.profile_publication_heads.update({ where: { organization_id_profile_kind_entity_id: {
        ...this.context.where, profile_kind: claim.profileKind, entity_id: claim.entityId } }, data: {
        lease_expires_at: new Date((await this.context.now(tx)).getTime() + leaseSeconds * 1000) } });
      await this.context.assertUnexpired(tx, previous.lease_expires_at);
    });
  }
  async recordOperation(claim: ProfileWorkClaim, raw: PackCatalogPublicationRequest): Promise<string> {
    raw = captureSharedInput(raw, MAX_PACK_CATALOG_HTTP_BODY_BYTES);
    return this.context.transaction(async tx => {
      const head = await this.context.lockProfile(tx, claim);
      const parsed = packCatalogPublicationRequestSchema.safeParse(raw);
      sharedInvariant(parsed.success, "SHARED_INPUT_INVALID"); const request = parsed.data;
      const envelope = await loadProfileEnvelope(tx, workKey(claim));
      const entity = claim.profileKind === "provider" ? { entityKind: "provider_profile" as const, providerId: claim.entityId }
        : { entityKind: "collectible_profile" as const, publicCollectibleId: claim.entityId };
      sharedInvariant(sharedEqual(packCatalogRequestEntity(request), entity) &&
        request.serviceIdentity.organizationId === this.context.organizationId, "SHARED_SCOPE_MISMATCH");
      let expected: unknown;
      switch (request.operationKind) {
        case "start_profile_snapshot": expected = { descriptor: envelope.descriptor }; break;
        case "apply_profile_snapshot_batch": expected = { publicProfileSnapshotId: envelope.profile.identity.publicProfileSnapshotId, batch: envelope.batch }; break;
        case "finalize_profile_snapshot": expected = { profile: envelope.profile.identity }; break;
        case "activate_profile_snapshot": expected = { intent: envelope.intent }; break;
        case "profile_publication_status": {
          const lookup = request.body.operation;
          sharedInvariant(lookup, "SHARED_INPUT_INVALID");
          const original = await tx.profile_publication_operations.findFirst({ where: {
            ...operationScope(claim), id: lookup.operationId, request_sha256: lookup.requestSha256 } });
          sharedInvariant(original && packCatalogPublicationRequestSchema.parse(original.request_json).operationKind !== "profile_publication_status", "SHARED_INPUT_INVALID");
          const profile = claim.profileKind === "provider" ? { profileKind: "provider", providerId: claim.entityId }
            : { profileKind: "collectible", publicCollectibleId: claim.entityId };
          expected = { profile, publicProfileSnapshotId: envelope.profile.identity.publicProfileSnapshotId, operation: lookup }; break;
        }
        default: sharedInvariant(false, "SHARED_INPUT_INVALID");
      }
      sharedInvariant(sharedEqual(request.body, expected), "SHARED_INPUT_INVALID");
      try { assertPublicPackCatalogBytes(request.body); } catch { sharedInvariant(false, "SHARED_INPUT_INVALID"); }
      sharedInvariant(packCatalogCanonicalByteCount(request) <= MAX_PACK_CATALOG_HTTP_BODY_BYTES, "SHARED_LIMIT_EXCEEDED");
      const requestSha256 = createHash("sha256").update(packCatalogCanonicalJson(request)).digest("hex");
      const existing = await tx.profile_publication_operations.findFirst({ where: { ...this.context.where,
        OR: [{ id: request.operationId }, { idempotency_key: request.idempotencyKey }] } });
      if (existing) {
        sharedInvariant(existing.intent_id === claim.intentId && existing.entity_id === claim.entityId &&
          existing.profile_kind === claim.profileKind && existing.request_sha256 === requestSha256 && sharedEqual(existing.request_json, request));
        return requestSha256; // Existing expired authority remains evidence for reconciliation, never new authorization.
      }
      const now = await this.context.now(tx);
      sharedInvariant(trustedPackCatalogServiceIdentityAllows({ identity: request.serviceIdentity, environment: this.context.environment,
        organizationId: this.context.organizationId, providerId: claim.profileKind === "provider" ? claim.entityId : undefined,
        entity, operation: PACK_CATALOG_OPERATION_AUTHORITY[request.operationKind], now: now.toISOString() }) &&
        request.serviceIdentity.authorizationSha256 === envelope.authorizationScopeSha256, "SHARED_SCOPE_MISMATCH");
      sharedInvariant(Math.abs(Date.parse(request.requestedAt) - now.getTime()) <= 30_000 &&
        (request.operationKind === "profile_publication_status" || (Date.parse(envelope.intent.expiresAt) > now.getTime() &&
          BigInt(envelope.intent.expectedGeneration) === head.generation)), "SHARED_INPUT_INVALID");
      sharedInvariant(await tx.profile_publication_operations.count({ where: operationScope(claim) }) < sharedPublicationLimits.maximumOperations,
        "SHARED_LIMIT_EXCEEDED");
      await tx.profile_publication_operations.create({ data: { ...operationScope(claim), id: request.operationId,
        idempotency_key: request.idempotencyKey, request_sha256: requestSha256, request_json: request } });
      await this.context.lockProfile(tx, claim);
      return requestSha256;
    });
  }
  recordReceipt(claim: ProfileWorkClaim, raw: unknown) {
    raw = captureSharedInput(raw, 16_384);
    return this.context.transaction(async tx => {
      await this.context.lockProfile(tx, claim);
      const parsed = packCatalogPublicationReceiptSchema.safeParse(raw);
      sharedInvariant(parsed.success, "SHARED_INPUT_INVALID"); const receipt = parsed.data;
      const row = await tx.profile_publication_operations.findFirst({ where: { ...operationScope(claim), id: receipt.operationId } });
      sharedInvariant(row, "SHARED_INPUT_INVALID"); const request = packCatalogPublicationRequestSchema.parse(row.request_json);
      sharedInvariant(receipt.requestSha256 === row.request_sha256 && receipt.operationKind === request.operationKind &&
        receipt.idempotencyKey === request.idempotencyKey && sharedEqual(receipt.entity, packCatalogRequestEntity(request)) &&
        receipt.receiptDigest === await packCatalogReceiptDigest(receipt), "SHARED_INPUT_INVALID");
      const work = await tx.profile_activation_intents.findUniqueOrThrow({ where: { organization_id_profile_kind_entity_id_id: workKey(claim) } });
      const now = await this.context.now(tx);
      sharedInvariant(receipt.snapshotId === work.snapshot_id && receipt.packHead === null &&
        (request.operationKind === "profile_publication_status" ? receipt.statusOperation !== null : receipt.statusOperation === null) &&
        Date.parse(receipt.completedAt) >= row.created_at.getTime() - 30_000 && Date.parse(receipt.completedAt) <= now.getTime() + 30_000 &&
        Date.parse(receipt.expiresAt) - Date.parse(receipt.completedAt) === PACK_PUBLICATION_REPLAY_LIFETIME_MS, "SHARED_INPUT_INVALID");
      const key = { ...operationScope(claim), operation_id: receipt.operationId };
      const existing = await tx.profile_publication_receipts.findUnique({ where: { organization_id_profile_kind_entity_id_intent_id_operation_id: key } });
      if (existing) { sharedInvariant(sharedEqual(existing.receipt_json, receipt)); return; }
      await tx.profile_publication_receipts.create({ data: { ...key, receipt_json: receipt, receipt_sha256: receipt.receiptDigest } });
      await this.context.lockProfile(tx, claim);
    });
  }
  listOperations(claim: ProfileWorkClaim) {
    return this.context.transaction(async tx => {
      await this.context.lockProfile(tx, claim);
      return tx.profile_publication_operations.findMany({ where: operationScope(claim), orderBy: { created_at: "asc" },
        take: sharedPublicationLimits.maximumOperations, select: { id: true, request_sha256: true } });
    });
  }
  readOperation(claim: ProfileWorkClaim, id: string) {
    sharedParse(packCatalogUuidSchema, id);
    return this.context.transaction(async tx => {
      await this.context.lockProfile(tx, claim);
      const row = await tx.profile_publication_operations.findFirst({ where: { ...operationScope(claim), id } });
      if (!row) return null;
      const receipt = await tx.profile_publication_receipts.findFirst({ where: { ...operationScope(claim), operation_id: id } });
      return { request: packCatalogPublicationRequestSchema.parse(row.request_json), requestSha256: row.request_sha256,
        receipt: receipt ? packCatalogPublicationReceiptSchema.parse(receipt.receipt_json) : null };
    });
  }
  /** Neither missing receipts nor expired replay prove that a previously sent activation failed. */
  private async unresolved(tx: CentralTransactionClient, claim: ProfileWorkClaim) {
    const [row] = await tx.$queryRaw<Array<{ required: boolean }>>`SELECT EXISTS (
      SELECT 1 FROM profile_publication_operations o LEFT JOIN profile_publication_receipts r ON
        r.organization_id = o.organization_id AND r.profile_kind = o.profile_kind AND r.entity_id = o.entity_id
        AND r.intent_id = o.intent_id AND r.operation_id = o.id
      WHERE o.organization_id = ${this.context.organizationId}::uuid AND o.profile_kind = ${claim.profileKind}
        AND o.entity_id = ${claim.entityId}::uuid AND o.intent_id = ${claim.intentId}::uuid
        AND o.request_json->>'operationKind' <> 'profile_publication_status'
        AND NOT EXISTS (SELECT 1 FROM profile_publication_operations lookup JOIN profile_publication_receipts proof ON
          proof.organization_id = lookup.organization_id AND proof.profile_kind = lookup.profile_kind AND proof.entity_id = lookup.entity_id
          AND proof.intent_id = lookup.intent_id AND proof.operation_id = lookup.id
          WHERE lookup.organization_id = o.organization_id AND lookup.profile_kind = o.profile_kind AND lookup.entity_id = o.entity_id
            AND lookup.intent_id = o.intent_id AND lookup.request_json->>'operationKind' = 'profile_publication_status'
            AND lookup.request_json #>> '{body,operation,operationId}' = o.id::text
            AND lookup.request_json #>> '{body,operation,requestSha256}' = o.request_sha256
            AND proof.receipt_json #>> '{statusOperation,found}' = 'true'
            AND ((o.request_json->>'operationKind' = 'activate_profile_snapshot'
              AND proof.receipt_json #>> '{statusOperation,result,outcome}' IN ('conflict','refused')
              AND proof.receipt_json #>> '{statusOperation,result,reasonCode}' IS NOT NULL)
              OR (o.request_json->>'operationKind' <> 'activate_profile_snapshot'
                AND proof.receipt_json #>> '{statusOperation,result,outcome}' IN ('applied','already_applied','already_active','conflict','refused'))))
        AND (r.operation_id IS NULL OR (o.request_json->>'operationKind' = 'activate_profile_snapshot'
          AND NOT (COALESCE(r.receipt_json #>> '{result,outcome}', '') IN ('conflict','refused')
            AND r.receipt_json #>> '{result,reasonCode}' IS NOT NULL)))) AS required`;
    return row!.required;
  }
  private defer(claim: ProfileWorkClaim, state: "retry_scheduled" | "blocked" | "superseded", reason: PublicationReasonCode, retrySeconds: number) {
    sharedParse(publicationReasonCodeSchema, reason); sharedBound(retrySeconds, sharedPublicationLimits.retrySeconds);
    return this.context.transaction(async tx => {
      await this.context.lockProfile(tx, claim);
      if (state === "superseded") sharedInvariant(!await this.unresolved(tx, claim));
      await tx.profile_activation_intents.update({ where: { organization_id_profile_kind_entity_id_id: workKey(claim) }, data: {
        state, reason_code: reason, available_at: new Date((await this.context.now(tx)).getTime() + retrySeconds * 1000),
        ...(state === "superseded" ? { completed_at: await this.context.now(tx) } : {}) } });
      await this.context.releaseProfile(tx, claim);
    });
  }
  scheduleRetry(claim: ProfileWorkClaim, reason: PublicationReasonCode, retrySeconds = 1) { return this.defer(claim, "retry_scheduled", reason, retrySeconds); }
  block(claim: ProfileWorkClaim, reason: PublicationReasonCode) { return this.defer(claim, "blocked", reason, 1); }
  supersede(claim: ProfileWorkClaim) { return this.defer(claim, "superseded", "ACTIVATION_CONFLICT", 1); }
  complete(claim: ProfileWorkClaim, operationId: string) {
    sharedParse(packCatalogUuidSchema, operationId);
    return this.context.transaction(async tx => {
      const mirror = await this.context.lockProfile(tx, claim);
      const operation = await tx.profile_publication_operations.findFirst({ where: { ...operationScope(claim), id: operationId } });
      const recorded = await tx.profile_publication_receipts.findFirst({ where: { ...operationScope(claim), operation_id: operationId } });
      sharedInvariant(operation && recorded);
      let request = packCatalogPublicationRequestSchema.parse(operation.request_json);
      const receipt = packCatalogPublicationReceiptSchema.parse(recorded.receipt_json);
      let result = receipt.result;
      if (request.operationKind === "profile_publication_status") {
        sharedInvariant(request.body.operation && receipt.statusOperation?.found && receipt.statusOperation.result);
        const original = await tx.profile_publication_operations.findFirst({ where: { ...operationScope(claim),
          id: request.body.operation.operationId, request_sha256: request.body.operation.requestSha256 } });
        sharedInvariant(original); request = packCatalogPublicationRequestSchema.parse(original.request_json); result = receipt.statusOperation.result;
      }
      sharedInvariant(request.operationKind === "activate_profile_snapshot" && result.state === "published" &&
        ["applied", "already_applied", "already_active"].includes(result.outcome) && result.reasonCode === null && receipt.profileHead);
      const head = receipt.profileHead;
      sharedInvariant(head.activeProfileSnapshotId === mirror.work.snapshot_id &&
        head.generation === request.body.intent.expectedGeneration + (result.outcome === "already_active" ? 0 : 1) &&
        BigInt(head.generation) >= mirror.generation && receipt.snapshotState === "complete");
      await tx.profile_activation_intents.update({ where: { organization_id_profile_kind_entity_id_id: workKey(claim) },
        data: { state: "published", reason_code: null, completed_at: await this.context.now(tx) } });
      await tx.profile_publication_heads.update({ where: { organization_id_profile_kind_entity_id: {
        ...this.context.where, profile_kind: claim.profileKind, entity_id: claim.entityId } }, data: {
        generation: head.generation, active_snapshot_id: head.activeProfileSnapshotId } });
      await this.context.releaseProfile(tx, claim);
    });
  }
}
