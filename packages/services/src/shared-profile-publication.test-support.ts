import { randomUUID } from "node:crypto";
import {
  PACK_CATALOG_V1, PACK_PUBLICATION_REPLAY_LIFETIME_MS, packCatalogPublicationRequestSchema,
  packCatalogReceiptDigest, profilePublicationEnvelopeSchema, type PackCatalogPublicationRequest,
  type ProfilePublicationEnvelope, type PublicProviderProfile, type PublicCollectibleProfile,
} from "@packscout/contracts";
import { createPackCatalogV1Fixture } from "@packscout/contracts/test-fixtures/pack-catalog-v1";
import { profileHash, type CentralPrismaClient, type ProfileWorkClaim } from "@packscout/database";
import { assemblePublicProfileSnapshot } from "./public-profile-snapshot-assembler.ts";

export const scopeHash = "a".repeat(64);
export async function makeProfileEnvelope(profile: PublicProviderProfile | PublicCollectibleProfile, expectedGeneration = 0): Promise<ProfilePublicationEnvelope> {
  const artifact = await assemblePublicProfileSnapshot(profile);
  const createdAt = new Date().toISOString(), intentId = randomUUID();
  const intent = { intentId, idempotencyKey: `profile:${intentId}`, profile: artifact.profile.identity, expectedGeneration,
    createdAt, expiresAt: new Date(Date.now() + 600_000).toISOString() };
  return profilePublicationEnvelopeSchema.parseAsync({ ...artifact,
    intent: { ...intent, operationDigest: await profileHash(intent) }, authorizationScopeSha256: scopeHash });
}
export async function seedCentralScope(client: CentralPrismaClient, providerIds: string[]) {
  const organizationId = randomUUID();
  await client.organizations.create({ data: { id: organizationId, name: "Publication test", slug: organizationId } });
  await client.providers.createMany({ data: providerIds.map(id => ({ id, organization_id: organizationId,
    display_name: "Profile provider", provider_key: `test_${id.replaceAll("-", "")}`, lifecycle: "draft" as const })) });
  return organizationId;
}
export async function fixtureProfiles(providerId: string) {
  const fixture = await createPackCatalogV1Fixture(new Uint8Array(32).fill(7));
  const provider = structuredClone(fixture.provider.profile);
  provider.identity.providerId = providerId;
  return { fixture, provider: await makeProfileEnvelope(provider), collectible: await makeProfileEnvelope(fixture.collectibles[0]!.profile) };
}
export function profileRequest(claim: ProfileWorkClaim, envelope: ProfilePublicationEnvelope,
  kind: "start_profile_snapshot" | "apply_profile_snapshot_batch" | "finalize_profile_snapshot" | "activate_profile_snapshot" = "activate_profile_snapshot"): PackCatalogPublicationRequest {
  const entity = claim.profileKind === "provider" ? { entityKind: "provider_profile" as const, providerId: claim.entityId }
    : { entityKind: "collectible_profile" as const, publicCollectibleId: claim.entityId };
  const body = kind === "start_profile_snapshot" ? { descriptor: envelope.descriptor }
    : kind === "apply_profile_snapshot_batch" ? { publicProfileSnapshotId: envelope.profile.identity.publicProfileSnapshotId, batch: envelope.batch }
      : kind === "finalize_profile_snapshot" ? { profile: envelope.profile.identity } : { intent: envelope.intent };
  const operationId = randomUUID();
  return packCatalogPublicationRequestSchema.parse({ schemaVersion: PACK_CATALOG_V1, operationKind: kind, operationId,
    idempotencyKey: `op:${operationId}`, requestedAt: new Date().toISOString(), body,
    serviceIdentity: { serviceIdentityId: randomUUID(), environment: "local", organizationId: claim.organizationId,
      scope: claim.profileKind === "provider" ? { scopeKind: "provider", providerId: claim.entityId }
        : { scopeKind: "catalog", catalog: PACK_CATALOG_V1 }, entity, operations: ["activate_head", "finalize_snapshot", "stage_snapshot"],
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), authorizationSha256: scopeHash } });
}
export async function successfulProfileReceipt(request: PackCatalogPublicationRequest, requestSha256: string, envelope: ProfilePublicationEnvelope) {
  const completedAt = new Date().toISOString();
  const receipt = { schemaVersion: PACK_CATALOG_V1, operationKind: request.operationKind, operationId: request.operationId,
    idempotencyKey: request.idempotencyKey, requestSha256, entity: request.serviceIdentity.entity,
    result: { outcome: "applied" as const, state: "published" as const, reasonCode: null },
    snapshotId: envelope.profile.identity.publicProfileSnapshotId, snapshotState: "complete" as const,
    packHead: null, profileHead: { generation: envelope.intent.expectedGeneration + 1,
      activeProfileSnapshotId: envelope.profile.identity.publicProfileSnapshotId, previousProfileSnapshotId: null, activatedAt: completedAt },
    statusOperation: null, completedAt, expiresAt: new Date(Date.parse(completedAt) + PACK_PUBLICATION_REPLAY_LIFETIME_MS).toISOString() };
  return { ...receipt, receiptDigest: await packCatalogReceiptDigest(receipt) };
}
export function faultCentralClient(client: CentralPrismaClient, target: string, before = false): CentralPrismaClient {
  return client.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    if (before && `${model}.${operation}` === target) throw new Error("injected private database and credential failure");
    const result = await query(args);
    if (!before && `${model}.${operation}` === target) throw new Error("injected private database and credential failure");
    return result;
  } } } }) as unknown as CentralPrismaClient;
}
