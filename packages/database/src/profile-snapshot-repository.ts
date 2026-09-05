import { assertPublicPackCatalogBytes, profilePublicationEnvelopeSchema, type ProfilePublicationEnvelope } from "@packscout/contracts";
import type { CentralTransactionClient } from "./central-database.ts";
import { CentralProfilePublicationContext, captureSharedInput, profileKey, sharedEqual, sharedInvariant } from "./central-profile-publication-context.ts";
import { assertProfilePublicData } from "./profile-public-data.ts";

/** Artifact bytes are immutable; publishing identical bytes is a distinct intent episode. */
export class ProfileSnapshotRepository {
  constructor(readonly context: CentralProfilePublicationContext, readonly kind: "provider" | "collectible") {}
  sealAndEnqueueActivation(input: ProfilePublicationEnvelope) {
    const captured = captureSharedInput(input, 1_500_000);
    return this.context.transaction(tx => this.sealInTransaction(tx, captured));
  }
  async sealInTransaction(tx: CentralTransactionClient, input: ProfilePublicationEnvelope) {
    input = captureSharedInput(input, 1_500_000);
    assertProfilePublicData(input);
    const parsed = await profilePublicationEnvelopeSchema.safeParseAsync(input);
    sharedInvariant(parsed.success, "SHARED_INPUT_INVALID");
    const envelope = parsed.data;
    assertProfilePublicData(envelope.profile);
    try { assertPublicPackCatalogBytes(envelope); } catch { sharedInvariant(false, "SHARED_INPUT_INVALID"); }
    const key = { ...this.context.where, ...profileKey(envelope.profile.identity) };
    sharedInvariant(key.profile_kind === this.kind, "SHARED_SCOPE_MISMATCH");
    if (this.kind === "provider") sharedInvariant(await tx.providers.findFirst({ where: {
      ...this.context.where, id: key.entity_id }, select: { id: true } }), "SHARED_SCOPE_MISMATCH");
    const artifactKey = { ...key, snapshot_id: envelope.profile.identity.publicProfileSnapshotId };
    const intentKey = { ...key, id: envelope.intent.intentId };
    const existingIntent = await tx.profile_activation_intents.findUnique({ where: {
      organization_id_profile_kind_entity_id_id: intentKey } });
    if (existingIntent) {
      sharedInvariant(sharedEqual(existingIntent.intent_json, envelope.intent) &&
        existingIntent.authorization_sha256 === envelope.authorizationScopeSha256 && existingIntent.payload_sha256 === envelope.payloadSha256);
    } else {
      const now = await this.context.now(tx);
      sharedInvariant(Date.parse(envelope.intent.createdAt) <= now.getTime() + 30_000 &&
        Date.parse(envelope.intent.expiresAt) > now.getTime(), "SHARED_INPUT_INVALID");
    }
    const artifact = await tx.profile_snapshot_artifacts.findUnique({ where: {
      organization_id_profile_kind_entity_id_snapshot_id: artifactKey } });
    await tx.profile_publication_heads.upsert({ where: { organization_id_profile_kind_entity_id: key }, create: key, update: {} });
    if (artifact) {
      const batch = await tx.profile_snapshot_batches.findUniqueOrThrow({ where: {
        organization_id_profile_kind_entity_id_snapshot_id_batch_index: { ...artifactKey, batch_index: 0 } } });
      sharedInvariant(sharedEqual(artifact.descriptor_json, envelope.descriptor) && sharedEqual(batch.batch_json, envelope.batch));
    } else {
      await tx.profile_snapshot_artifacts.create({ data: { ...artifactKey,
        content_sha256: envelope.profile.identity.contentSha256, descriptor_json: envelope.descriptor } });
      await tx.profile_snapshot_batches.create({ data: { ...artifactKey, batch_index: 0, batch_json: envelope.batch } });
    }
    if (!existingIntent) await tx.profile_activation_intents.create({ data: { ...intentKey,
      snapshot_id: artifactKey.snapshot_id, idempotency_key: envelope.intent.idempotencyKey, intent_json: envelope.intent,
      authorization_sha256: envelope.authorizationScopeSha256, payload_sha256: envelope.payloadSha256 } });
    return { artifact: artifact ? "reused" as const : "created" as const, intentId: envelope.intent.intentId,
      snapshotId: artifactKey.snapshot_id };
  }
}
export class ProviderProfileSnapshotRepository extends ProfileSnapshotRepository {
  constructor(context: CentralProfilePublicationContext) { super(context, "provider"); }
}
export class CollectibleProfileSnapshotRepository extends ProfileSnapshotRepository {
  constructor(context: CentralProfilePublicationContext) { super(context, "collectible"); }
}

export async function loadProfileEnvelope(tx: CentralTransactionClient, key: {
  organization_id: string; profile_kind: string; entity_id: string; id: string;
}): Promise<ProfilePublicationEnvelope> {
  const work = await tx.profile_activation_intents.findUniqueOrThrow({ where: { organization_id_profile_kind_entity_id_id: key } });
  const artifactKey = { organization_id: key.organization_id, profile_kind: key.profile_kind, entity_id: key.entity_id, snapshot_id: work.snapshot_id };
  const artifact = await tx.profile_snapshot_artifacts.findUniqueOrThrow({ where: { organization_id_profile_kind_entity_id_snapshot_id: artifactKey } });
  const batch = await tx.profile_snapshot_batches.findUniqueOrThrow({ where: {
    organization_id_profile_kind_entity_id_snapshot_id_batch_index: { ...artifactKey, batch_index: 0 } } });
  const batchJson = batch.batch_json as unknown as ProfilePublicationEnvelope["batch"];
  return profilePublicationEnvelopeSchema.parseAsync({ intent: work.intent_json, descriptor: artifact.descriptor_json,
    batch: batchJson, profile: batchJson.profile, payloadSha256: work.payload_sha256, authorizationScopeSha256: work.authorization_sha256 });
}
