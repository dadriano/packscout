import { randomUUID } from "node:crypto";
import {
  PACK_SNAPSHOT_HASH_DOMAIN, hashPackCatalogValue, packActivationIntentSchema, packBuildRequestSchema,
  packCatalogCanonicalJson, packPublicationEnvelopeSchema, providerPackBuildInputsSchema,
  packCatalogUuidSchema, preservesPackLifecycleBaseline,
  type PackActivationIntent, type PublicPackSnapshot, type PublicPackSnapshotDescriptor, type PublicPackSnapshotBatch,
} from "@packscout/contracts";
import { Prisma } from "../prisma/generated/provider/index.js";
import { ProviderPackPublicationContext, packInvariant, type PackWorkClaim } from "./provider-pack-publication-context.ts";

export interface BuiltPublicPackSnapshot {
  snapshot: PublicPackSnapshot;
  descriptor: PublicPackSnapshotDescriptor;
  batches: PublicPackSnapshotBatch[];
}

export class ProviderPackSnapshotRepository {
  constructor(readonly context: ProviderPackPublicationContext) {}

  async sealAndEnqueueActivation(claim: PackWorkClaim, built: BuiltPublicPackSnapshot): Promise<{
    artifact: "created" | "reused"; intent: PackActivationIntent;
  }> {
    return this.context.transaction(async tx => {
      const head = await this.context.lockLease(tx, claim, "build");
      const row = await tx.pack_build_requests.findUniqueOrThrow({ where: { id: claim.workId } });
      const request = packBuildRequestSchema.parse(row.request_json);
      const inputs = providerPackBuildInputsSchema.parse(row.inputs_json);
      packInvariant(!head.held && head.latest_sequence === row.pack_publication_sequence &&
        head.publication_epoch === BigInt(request.expectedPublicationEpoch));
      const payload = built.snapshot.payload;
      const equal = (a: unknown, b: unknown) => packCatalogCanonicalJson(a) === packCatalogCanonicalJson(b);
      for (const key of ["providerId", "publicRepackId", "snapshotKind", "dataAsOf", "title", "imageUrl", "category", "price",
        "lifecycle", "contents", "actions", "providerProfileSnapshotId", "evMethodIdentity", "evPolicyIdentity", "ev"] as const) {
        packInvariant(equal(payload[key], inputs[key]), "PACK_INPUT_INVALID");
      }
      packInvariant(equal(payload.searchProjection.aliases, inputs.aliases) &&
        payload.probabilityInputsSha256 === request.probabilityInputsSha256 && payload.valuationsSha256 === request.valuationInputsSha256 &&
        payload.evInputsSha256 === request.evInputsSha256 &&
        request.contentsSha256 === await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, payload.contents), "PACK_INPUT_INVALID");
      if (inputs.snapshotKind === "lifecycle_only") {
        packInvariant(inputs.lifecycleBaseline?.identity.publicPackSnapshotId === head.active_snapshot_id, "PACK_INPUT_INVALID");
        packInvariant(payload.lifecycleFreeze?.previousSnapshotId === head.active_snapshot_id &&
          payload.lifecycleFreeze?.provenanceIdentity === inputs.lifecycleProvenanceIdentity, "PACK_INPUT_INVALID");
        const baseline = await tx.pack_snapshot_artifacts.findUniqueOrThrow({ where: { public_pack_snapshot_id: head.active_snapshot_id! } });
        const previous = baseline.snapshot_json as unknown as PublicPackSnapshot;
        packInvariant(preservesPackLifecycleBaseline(inputs, previous) && payload.economicsSha256 === previous.payload.economicsSha256, "PACK_INPUT_INVALID");
      }
      const createdAt = await this.context.now(tx);
      const expectedHead = { generation: Number(head.generation), publicationEpoch: Number(head.publication_epoch), activeSnapshotId: head.active_snapshot_id };
      const intent = packActivationIntentSchema.parse({ intentId: randomUUID(), idempotencyKey: `activate:${request.requestId}`,
        snapshot: built.snapshot.identity, packPublicationSequence: request.packPublicationSequence, evidence: request.evidence,
        expectedHead, operationDigest: await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, { requestId: request.requestId,
          snapshot: built.snapshot.identity, expectedHead }), createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + 86_400_000).toISOString() });
      await packPublicationEnvelopeSchema.parseAsync({ ...built, intent,
        payloadSha256: await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, payload),
        authorizationScopeSha256: await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, this.context.scope) });
      const identity = built.snapshot.identity;
      const existing = await tx.pack_snapshot_artifacts.findUnique({ where: { public_pack_snapshot_id: identity.publicPackSnapshotId } });
      if (existing) {
        packInvariant(existing.organization_id === this.context.scope.organizationId && existing.provider_id === this.context.scope.providerId &&
          existing.public_repack_id === claim.publicRepackId && equal(existing.snapshot_json, built.snapshot) && equal(existing.descriptor_json, built.descriptor));
      } else {
        await tx.pack_snapshot_artifacts.create({ data: { ...this.context.where, public_repack_id: claim.publicRepackId,
          public_pack_snapshot_id: identity.publicPackSnapshotId, content_sha256: identity.contentSha256,
          snapshot_json: built.snapshot as unknown as Prisma.InputJsonValue, descriptor_json: built.descriptor as unknown as Prisma.InputJsonValue } });
        await tx.pack_snapshot_batches.createMany({ data: built.batches.map(batch => ({
          public_pack_snapshot_id: identity.publicPackSnapshotId, batch_index: batch.batchIndex, batch_json: batch as unknown as Prisma.InputJsonValue })) });
      }
      await tx.pack_activation_intents.create({ data: { ...this.context.where, id: intent.intentId, public_repack_id: claim.publicRepackId,
        build_request_id: claim.workId, public_pack_snapshot_id: identity.publicPackSnapshotId,
        pack_publication_sequence: row.pack_publication_sequence, intent_json: intent, state: "ready" } });
      await tx.pack_build_requests.update({ where: { id: claim.workId }, data: { state: "published", reason_code: null } });
      await this.context.release(tx, claim);
      return { artifact: existing ? "reused" : "created", intent };
    });
  }
  async findActivationForRequest(requestId: string): Promise<PackActivationIntent | null> {
    packCatalogUuidSchema.parse(requestId);
    return this.context.transaction(async tx => {
      const row = await tx.pack_activation_intents.findFirst({ where: { ...this.context.where, build_request_id: requestId } });
      return row ? packActivationIntentSchema.parse(row.intent_json) : null;
    });
  }
}
