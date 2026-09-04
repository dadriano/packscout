import assert from "node:assert/strict";
import { test } from "node:test";
import { productionPublicationPathSchema } from "./data-release-v2-publication-auth.ts";
import {
  packSearchText,
  publicPackSnapshotHeaderSchema,
  publicPackSnapshotPayloadSchema,
} from "./pack-catalog-domain.ts";
import { createPackCatalogV1Fixture } from "./pack-catalog-fixtures.ts";
import { PACK_CATALOG_V1, packCatalogSequenceSchema } from "./pack-catalog-v1.ts";
import {
  PACK_CATALOG_OPERATION_AUTHORITY,
  PACK_CATALOG_OPERATION_PATHS,
  PRODUCTION_PACK_CATALOG_V1_PATHS,
  classifyPackCatalogError,
  packCatalogErrorCodes,
  packCatalogKeyAuthoritySha256,
  packCatalogPublicationOperationKinds,
  packCatalogPublicationReceiptSchema,
  packCatalogPublicationRequestSchema,
  packCatalogReceiptDigest,
  packCatalogRequestEntity,
  packSnapshotHeaderFromPayload,
} from "./pack-catalog-publication-protocol.ts";

const SIGNING_KEY = new Uint8Array(32).fill(17);
const PROVIDER_ID = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";

test("Atomic store and six-journey catalog contract: publication protocol", async (context) => {
  const fixture = await createPackCatalogV1Fixture(SIGNING_KEY);
  const pack = fixture.packs.packA;
  const authority = { environment: "local" as const, organizationId: ORGANIZATION_ID, scope: { scopeKind: "provider" as const, providerId: PROVIDER_ID } };
  const identity = {
    serviceIdentityId: "90000000-0000-4000-8000-000000000001",
    environment: "local",
    organizationId: ORGANIZATION_ID,
    scope: authority.scope,
    entity: { entityKind: "pack", publicRepackId: pack.snapshot.identity.publicRepackId },
    operations: ["activate_head", "finalize_snapshot", "read_receipt", "recover_pack", "stage_snapshot"],
    issuedAt: "2026-09-03T18:00:00.000Z",
    expiresAt: "2026-09-03T18:20:00.000Z",
    authorizationSha256: await packCatalogKeyAuthoritySha256("pack-provider-alpha-v1", authority),
  };
  const envelope = (operationKind: string, body: unknown) => ({
    schemaVersion: PACK_CATALOG_V1, operationKind, operationId: "90000000-0000-4000-8000-000000000002",
    idempotencyKey: `${operationKind}:1`, serviceIdentity: identity, requestedAt: "2026-09-03T18:01:00.000Z", body,
  });

  await context.test("every operation has one path, one authority, and one admitted signed route", () => {
    const paths = Object.values(PRODUCTION_PACK_CATALOG_V1_PATHS);
    assert.equal(new Set(paths).size, 15);
    assert.deepEqual(Object.keys(PACK_CATALOG_OPERATION_PATHS).sort(), [...packCatalogPublicationOperationKinds].sort());
    assert.deepEqual(Object.keys(PACK_CATALOG_OPERATION_AUTHORITY).sort(), [...packCatalogPublicationOperationKinds].sort());
    for (const path of paths) {
      assert.ok(path.startsWith("/internal/pack-catalog-v1/"));
      assert.equal(productionPublicationPathSchema.safeParse(path).success, true);
    }
    assert.equal(productionPublicationPathSchema.safeParse("/internal/pack-catalog-v1/pack/delete").success, false);
  });

  await context.test("the wire header carries a complete pack without its contents-derived vectors", async () => {
    const { header, contents, collectibleProfileSnapshotIds, valuationDependencyIdentities } = packSnapshotHeaderFromPayload(pack.snapshot.payload);
    assert.equal("contents" in header, false);
    assert.equal(contents.length, pack.snapshot.payload.contentCount);
    assert.equal(collectibleProfileSnapshotIds.length, contents.length);
    assert.equal(valuationDependencyIdentities.length, pack.descriptor.valuationDependencyCount);
    assert.equal(publicPackSnapshotHeaderSchema.safeParse({ ...header, summaryProjection: { ...header.summaryProjection, title: "Renamed" } }).success, false);
    assert.equal(publicPackSnapshotHeaderSchema.safeParse({ ...header, searchProjection: { ...header.searchProjection, normalizedText: "alpha pack alpha card beta card fixture" } }).success, false);
    assert.equal(header.searchProjection.normalizedText, packSearchText(header.title, header.searchProjection.aliases));
    const withNames = structuredClone(pack.snapshot.payload);
    withNames.searchProjection.normalizedText = "alpha pack alpha card beta card featured fixture";
    assert.equal(publicPackSnapshotPayloadSchema.safeParse(withNames).success, false);
    const longNames = structuredClone(pack.snapshot.payload);
    for (const record of longNames.contents) record.displayName = `${record.displayName} ${"x".repeat(150)}`;
    assert.equal(publicPackSnapshotPayloadSchema.safeParse(longNames).success, true);
  });

  await context.test("requests parse as one discriminated envelope and name the exact entity they touch", () => {
    const start = packCatalogPublicationRequestSchema.parse(envelope("start_pack_snapshot", {
      descriptor: pack.descriptor,
      header: packSnapshotHeaderFromPayload(pack.snapshot.payload).header,
      packPublicationSequence: packCatalogSequenceSchema.parse("1"),
      evidence: { providerId: PROVIDER_ID, publicRepackId: pack.snapshot.identity.publicRepackId, packPublicationSequence: "1", providerChangeIdentity: "provider-change:1", sourceRevisionIdentity: "source-revision:1", sharedDependencies: [] },
    }));
    assert.deepEqual(packCatalogRequestEntity(start), { entityKind: "pack", publicRepackId: pack.snapshot.identity.publicRepackId });
    assert.equal(packCatalogPublicationRequestSchema.safeParse({ ...envelope("start_pack_snapshot", start.body), extra: 1 }).success, false);
    assert.equal(packCatalogPublicationRequestSchema.safeParse(envelope("start_pack_snapshot", { ...start.body, packPublicationSequence: "2" })).success, false);
    assert.equal(packCatalogPublicationRequestSchema.safeParse(envelope("hold_pack_head", { publicRepackId: pack.snapshot.identity.publicRepackId, expectedGeneration: 0, expectedPublicationEpoch: 0 })).success, false);
    const profile = packCatalogPublicationRequestSchema.parse(envelope("finalize_profile_snapshot", { profile: fixture.collectibles[0]!.profile.identity }));
    assert.deepEqual(packCatalogRequestEntity(profile), { entityKind: "collectible_profile", publicCollectibleId: fixture.collectibles[0]!.profile.identity.profileKind === "collectible" ? fixture.collectibles[0]!.profile.identity.publicCollectibleId : "" });
    assert.equal(packCatalogPublicationRequestSchema.safeParse(envelope("finalize_profile_snapshot", { profile: { ...fixture.collectibles[0]!.profile.identity, contentSha256: "0".repeat(64) } })).success, false);
  });

  await context.test("receipts bind one operation and carry a digest over their own bytes", async () => {
    const receipt = {
      schemaVersion: PACK_CATALOG_V1, operationKind: "activate_pack_snapshot", operationId: "90000000-0000-4000-8000-000000000002",
      idempotencyKey: "activate:1", requestSha256: "a".repeat(64), result: { outcome: "applied", state: "published", reasonCode: null },
      entity: { entityKind: "pack", publicRepackId: pack.snapshot.identity.publicRepackId },
      snapshotId: pack.snapshot.identity.publicPackSnapshotId, snapshotState: "complete",
      packHead: { generation: 1, publicationEpoch: 0, held: false, activeSnapshotId: pack.snapshot.identity.publicPackSnapshotId, previousSnapshotId: null, latestAcceptedPackPublicationSequence: "1", activatedAt: "2026-09-03T18:02:00.000Z" },
      profileHead: null, statusOperation: null, completedAt: "2026-09-03T18:02:00.000Z", expiresAt: "2026-10-03T18:02:00.000Z",
    };
    const receiptDigest = await packCatalogReceiptDigest(receipt);
    const parsed = packCatalogPublicationReceiptSchema.parse({ ...receipt, receiptDigest });
    assert.equal(await packCatalogReceiptDigest(parsed), receiptDigest);
    assert.notEqual(await packCatalogReceiptDigest({ ...receipt, requestSha256: "b".repeat(64) }), receiptDigest);
    assert.equal(packCatalogPublicationReceiptSchema.safeParse({ ...receipt, receiptDigest, replayed: true }).success, false);
    assert.equal(packCatalogPublicationReceiptSchema.safeParse({ ...receipt, receiptDigest, result: { outcome: "applied", state: "held", reasonCode: null } }).success, false);
  });

  await context.test("key authorities hash with their key identity and error codes classify fail-closed", async () => {
    const digest = await packCatalogKeyAuthoritySha256("pack-provider-alpha-v1", authority);
    assert.notEqual(await packCatalogKeyAuthoritySha256("pack-provider-beta-v1", authority), digest);
    assert.notEqual(await packCatalogKeyAuthoritySha256("pack-provider-alpha-v1", { ...authority, environment: "live" }), digest);
    assert.equal(packCatalogErrorCodes.length, 13);
    assert.equal(classifyPackCatalogError("PACK_CATALOG_AUTH_STALE"), "bounded_retry");
    assert.equal(classifyPackCatalogError("PACK_CATALOG_INTERNAL_ERROR"), "bounded_retry");
    assert.equal(classifyPackCatalogError("PACK_CATALOG_AUTH_FORBIDDEN"), "authentication");
    assert.equal(classifyPackCatalogError("PACK_CATALOG_REQUEST_INVALID"), "terminal");
    assert.equal(classifyPackCatalogError("PACK_CATALOG_STATE_CONFLICT"), "terminal");
  });
});
