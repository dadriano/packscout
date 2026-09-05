import {
  PACK_CATALOG_OPERATION_PATHS,
  PACK_CATALOG_V1,
  PROFILE_SNAPSHOT_HASH_DOMAIN,
  canonicalJson,
  hashPackCatalogValue,
  normalizePackCatalogSearchText,
  packCatalogCanonicalByteCount,
  packCatalogCanonicalJson,
  packCatalogKeyAuthoritySha256,
  packCatalogPublicationReceiptSchema,
  packCatalogReceiptDigest,
  packSnapshotHeaderFromPayload,
  productionPublicationReceiptSigningValue,
  type PackCatalogKeyAuthority,
  type PackCatalogOperationEntity,
  type PackCatalogPublicationOperationKind,
  type PackCatalogPublicationReceipt,
  type PublicPackSnapshot,
  type PublicPackSnapshotBatch,
  type PublicPackSnapshotDescriptor,
  type PublicProfileSnapshotBatch,
  type PublicProfileSnapshotDescriptor,
} from "@packscout/contracts";
import {
  createPackCatalogV1Fixture,
  packCatalogFixtureIds,
} from "@packscout/contracts/test-fixtures/pack-catalog-v1";
import type { TestConvex } from "convex-test";
import { expect, vi } from "vitest";
import { signedProviderInit } from "./providerReleaseSecurity.test-support";
import type schema from "./schema";

/**
 * Drives the `pack_catalog_v1` store through its real signed HTTP boundary in
 * convex-test: configured keys, one provider-scoped and one catalog-scoped
 * authority, P01 trusted service identities, and canonical request bytes.
 */

export type StoreTest = TestConvex<typeof schema>;

export const ORGANIZATION_ID = packCatalogFixtureIds.organizationId;
export const PROVIDER_ID = packCatalogFixtureIds.providerId;
export const PROVIDER_KEY_ID = "pack-provider-alpha-v1";
export const CATALOG_KEY_ID = "pack-catalog-central-v1";
export const OTHER_PROVIDER_KEY_ID = "pack-provider-beta-v1";
export const OTHER_PROVIDER_ID = "20000000-0000-4000-8000-000000000002";
export const CURSOR_SIGNING_KEY = "packscout-pack-catalog-cursor-test-key-0001";
export const SECRETS: Readonly<Record<string, string>> = Object.freeze({
  [CATALOG_KEY_ID]: "packscout-pack-catalog-central-secret-0000001",
  [PROVIDER_KEY_ID]: "packscout-pack-provider-alpha-secret-00000001",
  [OTHER_PROVIDER_KEY_ID]: "packscout-pack-provider-beta-secret-000000001",
});
export const AUTHORITIES: Readonly<Record<string, PackCatalogKeyAuthority>> = Object.freeze({
  [CATALOG_KEY_ID]: { environment: "local", organizationId: ORGANIZATION_ID, scope: { scopeKind: "catalog", catalog: PACK_CATALOG_V1 } },
  [PROVIDER_KEY_ID]: { environment: "local", organizationId: ORGANIZATION_ID, scope: { scopeKind: "provider", providerId: PROVIDER_ID } },
  [OTHER_PROVIDER_KEY_ID]: { environment: "local", organizationId: ORGANIZATION_ID, scope: { scopeKind: "provider", providerId: OTHER_PROVIDER_ID } },
});
export const FIXTURE_CURSOR_KEY = new Uint8Array(32).fill(17);

export function configurePackCatalogAuthority(): void {
  vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
  vi.stubEnv("PACKSCOUT_PUBLIC_CURSOR_HMAC_KEY", CURSOR_SIGNING_KEY);
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    canonicalJson(Object.fromEntries(Object.entries(SECRETS).map(([keyId, secret]) => [keyId, btoa(secret)]))),
  );
  vi.stubEnv("PACKSCOUT_PACK_CATALOG_V1_PUBLICATION_KEYS", canonicalJson(AUTHORITIES));
}

let sequence = 0;
export function nextUuid(): string {
  sequence += 1;
  return `90000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}
export function nextNonce(): string {
  sequence += 1;
  return `packnonce${String(sequence).padStart(14, "0")}`;
}

export async function loadFixture() {
  return await createPackCatalogV1Fixture(FIXTURE_CURSOR_KEY);
}
export type Fixture = Awaited<ReturnType<typeof loadFixture>>;

const ALL_OPERATIONS = ["activate_head", "finalize_snapshot", "read_receipt", "recover_pack", "stage_snapshot"] as const;

export async function serviceIdentity(input: {
  readonly keyId?: string;
  readonly entity: PackCatalogOperationEntity;
  readonly operations?: readonly (typeof ALL_OPERATIONS)[number][];
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly environment?: "local" | "preproduction" | "live";
  readonly organizationId?: string;
  readonly authority?: PackCatalogKeyAuthority;
}) {
  const keyId = input.keyId ?? PROVIDER_KEY_ID;
  const authority = input.authority ?? AUTHORITIES[keyId] ?? AUTHORITIES[PROVIDER_KEY_ID]!;
  const issuedAt = input.issuedAt ?? new Date(Date.now() - 60_000).toISOString();
  return {
    serviceIdentityId: nextUuid(),
    environment: input.environment ?? authority.environment,
    organizationId: input.organizationId ?? authority.organizationId,
    scope: authority.scope,
    entity: input.entity,
    operations: [...(input.operations ?? ALL_OPERATIONS)],
    issuedAt,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString(),
    authorizationSha256: await packCatalogKeyAuthoritySha256(keyId, authority),
  };
}

export interface PostOptions {
  readonly keyId?: string;
  readonly secret?: string;
  readonly identity?: Awaited<ReturnType<typeof serviceIdentity>>;
  readonly operationId?: string;
  readonly idempotencyKey?: string;
  readonly bodyJson?: string;
  readonly path?: string;
  readonly mutate?: (envelope: Record<string, unknown>) => Record<string, unknown>;
}

export function packEntity(publicRepackId: string): PackCatalogOperationEntity {
  return { entityKind: "pack", publicRepackId };
}

export async function postOperation(
  t: StoreTest,
  kind: PackCatalogPublicationOperationKind,
  body: unknown,
  entity: PackCatalogOperationEntity,
  options: PostOptions = {},
): Promise<{ status: number; json: Record<string, unknown>; receipt: PackCatalogPublicationReceipt | null; envelope: Record<string, unknown>; bodyJson: string }> {
  const keyId = options.keyId ?? (entity.entityKind === "collectible_profile" ? CATALOG_KEY_ID : PROVIDER_KEY_ID);
  const identity = options.identity ?? await serviceIdentity({ keyId, entity });
  let envelope: Record<string, unknown> = {
    schemaVersion: PACK_CATALOG_V1,
    operationKind: kind,
    operationId: options.operationId ?? nextUuid(),
    idempotencyKey: options.idempotencyKey ?? `${kind}:${nextUuid()}`,
    serviceIdentity: identity,
    requestedAt: new Date().toISOString(),
    body,
  };
  if (options.mutate) envelope = options.mutate(envelope);
  const bodyJson = options.bodyJson ?? packCatalogCanonicalJson(envelope);
  const path = options.path ?? PACK_CATALOG_OPERATION_PATHS[kind];
  const response = await t.fetch(path, await signedProviderInit(path, envelope, {
    bodyJson,
    keyId,
    secret: options.secret ?? SECRETS[keyId],
    nonce: nextNonce(),
  }));
  const json = (await response.json()) as Record<string, unknown>;
  let receipt: PackCatalogPublicationReceipt | null = null;
  if (response.status === 200) {
    const parsed = packCatalogPublicationReceiptSchema.safeParse(json.receipt);
    expect(parsed.success, JSON.stringify(json).slice(0, 400)).toBe(true);
    receipt = parsed.success ? parsed.data : null;
  }
  return { status: response.status, json, receipt, envelope, bodyJson };
}

export async function expectSignedReceipt(
  result: Awaited<ReturnType<typeof postOperation>>,
  keyId = PROVIDER_KEY_ID,
): Promise<PackCatalogPublicationReceipt> {
  expect(result.status, JSON.stringify(result.json).slice(0, 400)).toBe(200);
  const auth = result.json.responseAuth as { keyId: string; receiptDigest: string; signature: string };
  expect(auth.keyId).toBe(keyId);
  const receipt = result.receipt!;
  expect(auth.receiptDigest).toBe(await packCatalogReceiptDigest(receipt));
  expect(receipt.receiptDigest).toBe(auth.receiptDigest);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRETS[keyId]!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(productionPublicationReceiptSigningValue(auth.receiptDigest))))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  expect(auth.signature).toBe(signature);
  return receipt;
}

export type SealedPack = { snapshot: PublicPackSnapshot; descriptor: PublicPackSnapshotDescriptor; batches: PublicPackSnapshotBatch[] };
export type SealedProfile = { descriptor: PublicProfileSnapshotDescriptor; batch: PublicProfileSnapshotBatch; profile: PublicProfileSnapshotBatch["profile"] };

export function packEvidence(pack: SealedPack, packPublicationSequence: string) {
  return {
    providerId: pack.snapshot.identity.providerId,
    publicRepackId: pack.snapshot.identity.publicRepackId,
    packPublicationSequence,
    providerChangeIdentity: `provider-change:${packPublicationSequence}`,
    sourceRevisionIdentity: `source-revision:${packPublicationSequence}`,
    sharedDependencies: [],
  };
}

export function startBody(pack: SealedPack, packPublicationSequence: string) {
  return {
    descriptor: pack.descriptor,
    header: packSnapshotHeaderFromPayload(pack.snapshot.payload).header,
    packPublicationSequence,
    evidence: packEvidence(pack, packPublicationSequence),
  };
}

export function activationIntent(pack: SealedPack, input: {
  readonly packPublicationSequence: string;
  readonly expectedHead: { generation: number; publicationEpoch: number; activeSnapshotId: string | null };
  readonly expiresAt?: string;
  readonly createdAt?: string;
}) {
  // Inside the fixture's sealed EV validity window (dataAsOf 18:00Z, validUntil 19:00Z).
  const createdAt = input.createdAt ?? "2026-09-03T18:30:00.000Z";
  return {
    intentId: nextUuid(),
    idempotencyKey: `activate:${nextUuid()}`,
    snapshot: pack.snapshot.identity,
    packPublicationSequence: input.packPublicationSequence,
    evidence: packEvidence(pack, input.packPublicationSequence),
    expectedHead: input.expectedHead,
    operationDigest: "c".repeat(64),
    createdAt,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

/** Stages and finalizes one complete pack; returns every receipt in order. */
export async function stagePack(t: StoreTest, pack: SealedPack, packPublicationSequence: string, keyId = PROVIDER_KEY_ID) {
  const entity = packEntity(pack.snapshot.identity.publicRepackId);
  const receipts: PackCatalogPublicationReceipt[] = [];
  receipts.push(await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(pack, packPublicationSequence), entity, { keyId }), keyId));
  for (const batch of pack.batches) {
    receipts.push(await expectSignedReceipt(await postOperation(t, "apply_pack_snapshot_batch",
      { publicRepackId: pack.snapshot.identity.publicRepackId, publicPackSnapshotId: pack.snapshot.identity.publicPackSnapshotId, batch }, entity, { keyId }), keyId));
  }
  receipts.push(await expectSignedReceipt(await postOperation(t, "finalize_pack_snapshot", { snapshot: pack.snapshot.identity }, entity, { keyId }), keyId));
  return receipts;
}

export async function activatePack(t: StoreTest, pack: SealedPack, input: Parameters<typeof activationIntent>[1], keyId = PROVIDER_KEY_ID) {
  return await expectSignedReceipt(await postOperation(t, "activate_pack_snapshot",
    { intent: activationIntent(pack, input) }, packEntity(pack.snapshot.identity.publicRepackId), { keyId }), keyId);
}

export async function publishPack(t: StoreTest, pack: SealedPack, input: Parameters<typeof activationIntent>[1], keyId = PROVIDER_KEY_ID) {
  const receipts = await stagePack(t, pack, input.packPublicationSequence, keyId);
  for (const receipt of receipts) expect(receipt.result.outcome, JSON.stringify(receipt.result)).toBe("applied");
  return await activatePack(t, pack, input, keyId);
}

export function profileEntity(profile: SealedProfile): PackCatalogOperationEntity {
  const identity = profile.descriptor.identity;
  return identity.profileKind === "provider"
    ? { entityKind: "provider_profile", providerId: identity.providerId }
    : { entityKind: "collectible_profile", publicCollectibleId: identity.publicCollectibleId };
}

export async function publishProfile(t: StoreTest, profile: SealedProfile, expectedGeneration = 0) {
  const entity = profileEntity(profile);
  const keyId = entity.entityKind === "provider_profile" ? PROVIDER_KEY_ID : CATALOG_KEY_ID;
  const identity = profile.descriptor.identity;
  const receipts: PackCatalogPublicationReceipt[] = [];
  receipts.push(await expectSignedReceipt(await postOperation(t, "start_profile_snapshot", { descriptor: profile.descriptor }, entity, { keyId }), keyId));
  receipts.push(await expectSignedReceipt(await postOperation(t, "apply_profile_snapshot_batch", { publicProfileSnapshotId: identity.publicProfileSnapshotId, batch: profile.batch }, entity, { keyId }), keyId));
  receipts.push(await expectSignedReceipt(await postOperation(t, "finalize_profile_snapshot", { profile: identity }, entity, { keyId }), keyId));
  const createdAt = new Date().toISOString();
  receipts.push(await expectSignedReceipt(await postOperation(t, "activate_profile_snapshot", {
    intent: {
      intentId: nextUuid(), idempotencyKey: `profile:${nextUuid()}`, profile: identity, expectedGeneration,
      operationDigest: "d".repeat(64), createdAt, expiresAt: new Date(Date.parse(createdAt) + 10 * 60_000).toISOString(),
    },
  }, entity, { keyId }), keyId));
  for (const receipt of receipts) expect(receipt.result.outcome, JSON.stringify(receipt.result)).toBe("applied");
  return receipts;
}

/** Publishes the fixture's provider and collectible profiles, the prerequisite for any first pack activation. */
export async function publishFixtureProfiles(t: StoreTest, fixture: Fixture) {
  await publishProfile(t, fixture.provider);
  for (const collectible of fixture.collectibles) await publishProfile(t, collectible);
}

/** Seals a new version of one collectible profile fixture with a different display name. */
export async function resealCollectibleProfile(source: SealedProfile, displayName: string): Promise<SealedProfile> {
  const profile = source.profile;
  if (!("valuationDisplay" in profile)) throw new Error("collectible profile required");
  const { identity, ...fields } = profile;
  const aliases = [displayName.toLocaleLowerCase("en-US")];
  const body = {
    profileKind: "collectible" as const,
    publicCollectibleId: identity.publicCollectibleId,
    sourceIdentity: `${identity.sourceIdentity}:renamed`,
    dataAsOf: "2026-09-03T18:30:00.000Z",
    ...fields,
    displayName,
    aliases,
    searchText: normalizePackCatalogSearchText([displayName, ...aliases].join(" ")),
  };
  const contentSha256 = await hashPackCatalogValue(PROFILE_SNAPSHOT_HASH_DOMAIN, body);
  const nextIdentity = { profileKind: "collectible" as const, publicCollectibleId: body.publicCollectibleId, sourceIdentity: body.sourceIdentity, dataAsOf: body.dataAsOf, publicProfileSnapshotId: `ppfs_${contentSha256}`, contentSha256 };
  const nextProfile = { identity: nextIdentity, displayName, imageUrl: fields.imageUrl, category: fields.category, aliases, searchText: body.searchText, valuationDisplay: fields.valuationDisplay };
  const batchBody = { kind: "profile_batch", profile: nextProfile };
  const batchSha256 = await hashPackCatalogValue(PROFILE_SNAPSHOT_HASH_DOMAIN, batchBody);
  const byteCount = packCatalogCanonicalByteCount(batchBody);
  const batch = { publicProfileSnapshotId: nextIdentity.publicProfileSnapshotId, batchIndex: 0 as const, recordCount: 1 as const, byteCount, batchSha256, profile: nextProfile };
  return {
    profile: nextProfile,
    batch,
    descriptor: { identity: nextIdentity, batch: { publicProfileSnapshotId: nextIdentity.publicProfileSnapshotId, batchIndex: 0, recordCount: 1, byteCount, batchSha256 }, completionState: "complete" },
  } as SealedProfile;
}

/** Seals a new version of the provider profile fixture with a different display name. */
export async function resealProviderProfile(source: SealedProfile, displayName: string): Promise<SealedProfile> {
  const profile = source.profile;
  if (!("brandAssets" in profile)) throw new Error("provider profile required");
  const { identity, ...fields } = profile;
  const body = {
    profileKind: "provider" as const,
    providerId: identity.providerId,
    sourceIdentity: `${identity.sourceIdentity}:renamed`,
    dataAsOf: "2026-09-03T18:30:00.000Z",
    ...fields,
    displayName,
  };
  const contentSha256 = await hashPackCatalogValue(PROFILE_SNAPSHOT_HASH_DOMAIN, body);
  const nextIdentity = { profileKind: "provider" as const, providerId: body.providerId, sourceIdentity: body.sourceIdentity, dataAsOf: body.dataAsOf, publicProfileSnapshotId: `ppfs_${contentSha256}`, contentSha256 };
  const nextProfile = { identity: nextIdentity, displayName, brandAssets: fields.brandAssets, promotions: fields.promotions };
  const batchBody = { kind: "profile_batch", profile: nextProfile };
  const batchSha256 = await hashPackCatalogValue(PROFILE_SNAPSHOT_HASH_DOMAIN, batchBody);
  const byteCount = packCatalogCanonicalByteCount(batchBody);
  const batch = { publicProfileSnapshotId: nextIdentity.publicProfileSnapshotId, batchIndex: 0 as const, recordCount: 1 as const, byteCount, batchSha256, profile: nextProfile };
  return {
    profile: nextProfile,
    batch,
    descriptor: { identity: nextIdentity, batch: { publicProfileSnapshotId: nextIdentity.publicProfileSnapshotId, batchIndex: 0, recordCount: 1, byteCount, batchSha256 }, completionState: "complete" },
  } as SealedProfile;
}
