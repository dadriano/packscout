import { randomUUID } from "node:crypto";
import {
  PACK_SNAPSHOT_HASH_DOMAIN, assertPublicPackCatalogBytes, hashPackCatalogValue, packCatalogSha256Schema,
  packCatalogTextSchema, packCatalogUuidSchema, publicationReasonCodeSchema, sharedProviderChangeDeliverySchema,
  type ProfilePublicationEnvelope, type PublicationReasonCode, type SharedProviderChangeDelivery,
} from "@packscout/contracts";
import type { CentralTransactionClient } from "./central-database.ts";
import { CentralProfilePublicationContext, captureSharedInput, profileHash, sharedBound, sharedEqual, sharedInvariant, sharedParse, sharedPublicationLimits } from "./central-profile-publication-context.ts";
import { ProfileSnapshotRepository } from "./profile-snapshot-repository.ts";

export interface SharedChangeInput {
  sourceKey: string; sourceIdentity: string; expectedSequence: string; sourceSequence: string;
  sharedDependencies: SharedProviderChangeDelivery["sharedDependencies"]; payloadSha256: string;
  providerAudience: string[]; profiles: ProfilePublicationEnvelope[];
}
export interface SharedDeliveryClaim {
  delivery: SharedProviderChangeDelivery; owner: string; fence: string; expiresAt: string;
}
const int64 = (value: string, allowZero = false) => {
  sharedInvariant(typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/u.test(value) &&
    BigInt(value) <= 9_223_372_036_854_775_807n && (allowZero || BigInt(value) > 0n), "SHARED_INPUT_INVALID");
  return BigInt(value);
};

/** Full organization provider audience is captured centrally; pack membership stays provider-local. */
export class SharedPackFanoutRepository {
  constructor(readonly context: CentralProfilePublicationContext) {}
  async recordChangeAndAdvance(raw: SharedChangeInput) {
    const input = captureSharedInput(raw);
    sharedInvariant(Object.keys(input).sort().join() === ["sourceKey", "sourceIdentity", "expectedSequence", "sourceSequence",
      "sharedDependencies", "payloadSha256", "providerAudience", "profiles"].sort().join(), "SHARED_INPUT_INVALID");
    return this.context.transaction(async tx => {
      const sourceKey = packCatalogTextSchema(200).parse(input.sourceKey), sourceIdentity = packCatalogTextSchema(200).parse(input.sourceIdentity);
      const prior = int64(input.expectedSequence, true), next = int64(input.sourceSequence);
      sharedInvariant(next > prior, "SHARED_INPUT_INVALID");
      sharedBound(Math.max(1, input.providerAudience.length), sharedPublicationLimits.providers);
      sharedBound(Math.max(1, input.profiles.length), sharedPublicationLimits.profiles);
      const audience = input.providerAudience.map(id => packCatalogUuidSchema.parse(id)).sort();
      sharedInvariant(new Set(audience).size === audience.length, "SHARED_INPUT_INVALID");
      sharedInvariant(new Set(input.profiles.map(p => p.intent.intentId)).size === input.profiles.length, "SHARED_INPUT_INVALID");
      const probe = sharedProviderChangeDeliverySchema.parse({ organizationId: this.context.organizationId,
        providerId: randomUUID(), centralChangeIdentity: sourceIdentity, providerChangeSequence: "1",
        sharedDependencies: input.sharedDependencies, payloadSha256: input.payloadSha256,
        leaseIdentity: randomUUID(), acknowledgmentIdentity: null });
      try { assertPublicPackCatalogBytes(input); } catch { sharedInvariant(false, "SHARED_INPUT_INVALID"); }
      const requestDigest = await profileHash({ ...input, providerAudience: audience, sourceKey, sourceIdentity });
      // Serialize allocation and checkpoints across source streams in this organization.
      const org = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM organizations WHERE id = ${this.context.organizationId}::uuid FOR UPDATE`;
      sharedInvariant(org[0], "SHARED_SCOPE_MISMATCH");
      const existing = await tx.shared_catalog_changes.findUnique({ where: {
        organization_id_source_identity: { ...this.context.where, source_identity: sourceIdentity } } });
      if (existing) { sharedInvariant(existing.request_sha256 === requestDigest); return this.receipt(existing); }
      sharedInvariant(await tx.profile_activation_intents.count({ where: { ...this.context.where,
        id: { in: input.profiles.map(p => p.intent.intentId) } } }) === 0);
      const providers = await tx.providers.findMany({ where: this.context.where, orderBy: { id: "asc" },
        select: { id: true }, take: sharedPublicationLimits.providers + 1 });
      sharedInvariant(providers.length <= sharedPublicationLimits.providers, "SHARED_LIMIT_EXCEEDED");
      sharedInvariant(sharedEqual(providers.map(p => p.id), audience), "SHARED_SCOPE_MISMATCH");
      const checkpointKey = { ...this.context.where, source_key: sourceKey };
      const checkpoint = await tx.shared_change_checkpoints.upsert({ where: { organization_id_source_key: checkpointKey },
        create: checkpointKey, update: {} });
      sharedInvariant(checkpoint.through_sequence === prior);
      const changeId = randomUUID(), audienceDigest = await profileHash(audience);
      const profileIntents = input.profiles.map(p => p.intent.intentId).sort();
      const receiptDigest = await profileHash({ changeId, sourceKey, sourceSequence: next.toString(), requestDigest, audienceDigest, profileIntents });
      await tx.shared_catalog_changes.create({ data: { ...this.context.where, id: changeId, source_key: sourceKey,
        source_sequence: next, source_identity: sourceIdentity, request_sha256: requestDigest, payload_sha256: probe.payloadSha256,
        dependencies_json: probe.sharedDependencies, audience_json: audience, audience_sha256: audienceDigest,
        profile_intent_ids: profileIntents, receipt_sha256: receiptDigest } });
      for (const [index, providerId] of audience.entries()) {
        const id = randomUUID();
        const [sequence] = await tx.$queryRaw<Array<{ value: bigint }>>`SELECT nextval('shared_change_deliveries_provider_change_sequence_seq') AS value`;
        const delivery = { ...probe, providerId, leaseIdentity: id, providerChangeSequence: sequence!.value.toString() };
        await tx.shared_change_deliveries.create({ data: { ...this.context.where, provider_id: providerId,
          id, change_id: changeId, provider_change_sequence: sequence!.value, shard_index: index, delivery_json: delivery } });
      }
      for (const profile of input.profiles) await new ProfileSnapshotRepository(this.context, profile.profile.identity.profileKind).sealInTransaction(tx, profile);
      await tx.shared_change_checkpoints.update({ where: { organization_id_source_key: checkpointKey }, data: {
        through_sequence: next, change_id: changeId, receipt_sha256: receiptDigest } });
      return { changeId, sourceSequence: next.toString(), audienceSha256: audienceDigest, receiptSha256: receiptDigest, profileIntentIds: profileIntents };
    });
  }
  private receipt(row: { id: string; source_sequence: bigint; audience_sha256: string; receipt_sha256: string; profile_intent_ids: unknown }) {
    return { changeId: row.id, sourceSequence: row.source_sequence.toString(), audienceSha256: row.audience_sha256,
      receiptSha256: row.receipt_sha256, profileIntentIds: row.profile_intent_ids as string[] };
  }
  forProvider(providerId: string) { return new SharedProviderChangeDeliveryRepository(this.context, providerId); }
}

/** A trusted provider binding is fixed at construction, never selected by claim or acknowledgment input. */
export class SharedProviderChangeDeliveryRepository {
  readonly providerId: string;
  constructor(readonly context: CentralProfilePublicationContext, providerId: string) { this.providerId = sharedParse(packCatalogUuidSchema, providerId); }
  async claimDelivery(owner: string, leaseSeconds: number = sharedPublicationLimits.leaseSeconds): Promise<SharedDeliveryClaim | null> {
    const providerId = this.providerId;
    sharedParse(packCatalogUuidSchema, owner);
    sharedBound(leaseSeconds, sharedPublicationLimits.maximumLeaseSeconds);
    return this.context.transaction(async tx => {
      // A blocked or delayed earlier shard must not let newer dependencies overtake it.
      const rows = await tx.$queryRaw<Array<{ id: string; state: string; attempts: number }>>`
        SELECT id, state, attempts FROM shared_change_deliveries WHERE organization_id = ${this.context.organizationId}::uuid
          AND provider_id = ${providerId}::uuid AND state <> 'published'
          AND available_at <= clock_timestamp() AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
          AND provider_change_sequence = (SELECT min(provider_change_sequence) FROM shared_change_deliveries
            WHERE organization_id = ${this.context.organizationId}::uuid AND provider_id = ${providerId}::uuid AND state <> 'published')
        LIMIT 1 FOR UPDATE SKIP LOCKED`;
      const row = rows[0]; if (!row || row.state === "blocked") return null;
      const key = { ...this.context.where, provider_id: providerId, id: row.id };
      if (row.attempts >= sharedPublicationLimits.maximumAttempts) {
        await tx.shared_change_deliveries.update({ where: { organization_id_provider_id_id: key }, data: {
          state: "blocked", reason_code: "OPERATION_EXPIRED", lease_owner: null, lease_expires_at: null, lease_fence: { increment: 1 } } }); return null;
      }
      const expiresAt = new Date((await this.context.now(tx)).getTime() + leaseSeconds * 1000);
      const claimed = await tx.shared_change_deliveries.update({ where: { organization_id_provider_id_id: key }, data: {
        state: "publishing", attempts: { increment: 1 }, lease_owner: owner, lease_fence: { increment: 1 }, lease_expires_at: expiresAt } });
      return { delivery: sharedProviderChangeDeliverySchema.parse(claimed.delivery_json), owner,
        fence: claimed.lease_fence.toString(), expiresAt: expiresAt.toISOString() };
    });
  }
  private async lock(tx: CentralTransactionClient, claim: SharedDeliveryClaim) {
    const delivery = sharedProviderChangeDeliverySchema.parse(claim.delivery);
    sharedInvariant(delivery.organizationId === this.context.organizationId && delivery.providerId === this.providerId, "SHARED_SCOPE_MISMATCH");
    const rows = await tx.$queryRaw<Array<{ delivery_json: unknown; lease_expires_at: Date }>>`SELECT delivery_json, lease_expires_at FROM shared_change_deliveries
      WHERE organization_id = ${this.context.organizationId}::uuid AND provider_id = ${delivery.providerId}::uuid
        AND id = ${delivery.leaseIdentity}::uuid AND lease_owner = ${claim.owner}::uuid AND lease_fence = ${int64(claim.fence)}
        AND lease_expires_at > clock_timestamp() AND state = 'publishing' FOR UPDATE`;
    sharedInvariant(rows[0] && sharedEqual(rows[0].delivery_json, delivery), "SHARED_LEASE_LOST");
    return { key: { ...this.context.where, provider_id: delivery.providerId, id: delivery.leaseIdentity }, expiresAt: rows[0].lease_expires_at };
  }
  renewDelivery(claim: SharedDeliveryClaim, leaseSeconds: number = sharedPublicationLimits.leaseSeconds) {
    sharedBound(leaseSeconds, sharedPublicationLimits.maximumLeaseSeconds);
    return this.context.transaction(async tx => {
      const { key, expiresAt } = await this.lock(tx, claim);
      await tx.shared_change_deliveries.update({ where: { organization_id_provider_id_id: key }, data: {
        lease_expires_at: new Date((await this.context.now(tx)).getTime() + leaseSeconds * 1000) } });
      await this.context.assertUnexpired(tx, expiresAt);
    });
  }
  acknowledgeDelivery(claim: SharedDeliveryClaim, result: { boundaryIdentity: string; complete: boolean; acknowledgmentDigest: string | null }) {
    return this.context.transaction(async tx => {
      sharedInvariant(claim.delivery.organizationId === this.context.organizationId && claim.delivery.providerId === this.providerId, "SHARED_SCOPE_MISMATCH");
      const boundaryHash = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, { kind: "shared_boundary", identity: claim.delivery.centralChangeIdentity });
      sharedInvariant(result.complete && result.boundaryIdentity === `shared:${boundaryHash}` &&
        packCatalogSha256Schema.safeParse(result.acknowledgmentDigest).success, "SHARED_INPUT_INVALID");
      const previous = await tx.shared_change_deliveries.findUnique({ where: { organization_id_provider_id_id: {
        ...this.context.where, provider_id: this.providerId, id: claim.delivery.leaseIdentity } } });
      if (previous?.state === "published") {
        sharedInvariant(previous.lease_owner === claim.owner && previous.lease_fence === int64(claim.fence), "SHARED_LEASE_LOST");
        sharedInvariant(previous.acknowledgment_sha256 === result.acknowledgmentDigest && sharedEqual(previous.delivery_json, claim.delivery)); return;
      }
      const { key, expiresAt } = await this.lock(tx, claim);
      await tx.shared_change_deliveries.update({ where: { organization_id_provider_id_id: key }, data: {
        state: "published", reason_code: null, acknowledgment_sha256: result.acknowledgmentDigest,
        lease_expires_at: null, completed_at: await this.context.now(tx) } });
      await this.context.assertUnexpired(tx, expiresAt);
    });
  }
  recordDeliveryFailure(claim: SharedDeliveryClaim, reason: PublicationReasonCode, retrySeconds = 1) {
    sharedParse(publicationReasonCodeSchema, reason); sharedBound(retrySeconds, sharedPublicationLimits.retrySeconds);
    return this.context.transaction(async tx => {
      const { key, expiresAt } = await this.lock(tx, claim);
      await tx.shared_change_deliveries.update({ where: { organization_id_provider_id_id: key }, data: {
        state: "retry_scheduled", reason_code: reason, lease_owner: null, lease_expires_at: null,
        available_at: new Date((await this.context.now(tx)).getTime() + retrySeconds * 1000) } });
      await this.context.assertUnexpired(tx, expiresAt);
    });
  }
}
