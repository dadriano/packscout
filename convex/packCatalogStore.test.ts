/// <reference types="vite/client" />

import {
  PACK_CATALOG_OPERATION_PATHS,
  PACK_CATALOG_V1,
  PACK_SNAPSHOT_HASH_DOMAIN,
  compareCanonicalStrings,
  hashPackCatalogValue,
  normalizePackCatalogSearchText,
  packCatalogCanonicalJson,
  publicPackLifecycleSchema,
  publicPackSummaryCore,
} from "@packscout/contracts";
import { packCatalogFixtureIds, sealFixturePack } from "@packscout/contracts/test-fixtures/pack-catalog-v1";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AUTHORITIES,
  CATALOG_KEY_ID,
  OTHER_PROVIDER_KEY_ID,
  PROVIDER_ID,
  PROVIDER_KEY_ID,
  activatePack,
  activationIntent,
  configurePackCatalogAuthority,
  expectSignedReceipt,
  loadFixture,
  nextUuid,
  packEntity,
  postOperation,
  publishFixtureProfiles,
  publishPack,
  publishProfile,
  resealCollectibleProfile,
  serviceIdentity,
  stagePack,
  startBody,
  type Fixture,
  type SealedPack,
  type StoreTest,
} from "./packCatalogV1.test-support";
import { signedProviderInit } from "./providerReleaseSecurity.test-support";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTest(): StoreTest {
  return convexTest({ schema, modules, transactionLimits: true });
}

async function operationCount(t: StoreTest): Promise<number> {
  return await t.run(async (ctx) => (await ctx.db.query("packCatalogOperations").take(1_000)).length);
}

/** A 250-content version of pack A: the largest batch the P01 contract allows. */
async function buildScalePack(fixture: Fixture, count: number): Promise<SealedPack> {
  const base = fixture.packs.packA.snapshot.payload;
  const perItem = Math.floor(1_000_000 / count);
  const remainder = 1_000_000 - perItem * count;
  const records = Array.from({ length: count }, (_, index) => ({
    publicCollectibleId: `41000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    collectibleProfileSnapshotId: `ppfs_${(index + 1).toString(16).padStart(64, "0")}`,
    displayName: `Collectible ${index} ${"x".repeat(180)}`.slice(0, 200),
    imageUrl: `https://cdn.packscout.test/collectibles/${index}/${"y".repeat(80)}.jpg`,
    category: base.category,
    quantity: 1,
    probabilityMicros: perItem + (index === 0 ? remainder : 0),
    eligibleForChase: true,
    valuation: { status: "available" as const, amount: { currency: "USD", minorUnits: 1_000 + index }, valuationIdentity: (500_000 + index).toString(16).padStart(64, "0"), observedAt: base.dataAsOf },
  })).sort((left, right) => compareCanonicalStrings(left.publicCollectibleId, right.publicCollectibleId));
  const top = [...records].sort((left, right) => right.valuation.amount.minorUnits - left.valuation.amount.minorUnits || compareCanonicalStrings(left.publicCollectibleId, right.publicCollectibleId))[0]!;
  const topChase = { publicCollectibleId: top.publicCollectibleId, valuationIdentity: top.valuation.valuationIdentity, amount: top.valuation.amount };
  const probabilityInputsSha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, records.map(({ publicCollectibleId, probabilityMicros }) => ({ publicCollectibleId, probabilityMicros })));
  const valuationsSha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, records.map(({ publicCollectibleId, valuation }) => ({ publicCollectibleId, valuation })));
  const evInputsSha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, { price: base.price, probabilityInputsSha256, valuationsSha256, evMethodIdentity: base.evMethodIdentity, evPolicyIdentity: base.evPolicyIdentity });
  const economicsSha256 = await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, { price: base.price, records, probabilityInputsSha256, valuationsSha256, topChase, evInputsSha256, ev: base.ev });
  const core = {
    ...base,
    snapshotKind: "full" as const,
    dataAsOf: "2026-09-03T18:30:00.000Z",
    lifecycle: publicPackLifecycleSchema.parse(base.lifecycle),
    collectibleProfileSnapshotIds: records.map(({ collectibleProfileSnapshotId }) => collectibleProfileSnapshotId).sort(compareCanonicalStrings),
    contents: records,
    contentCount: records.length,
    probabilityInputsSha256,
    valuationDependencyIdentities: records.map(({ valuation }) => valuation.valuationIdentity).sort(compareCanonicalStrings),
    valuationsSha256,
    topChase,
    evInputsSha256,
    economicsSha256,
    lifecycleFreeze: null,
  };
  const payload = { ...core, summaryProjection: publicPackSummaryCore(core), searchProjection: { ...base.searchProjection, normalizedText: normalizePackCatalogSearchText([base.title, ...base.searchProjection.aliases].join(" ")) } };
  const sealed = await sealFixturePack(payload);
  return { snapshot: sealed.snapshot, descriptor: sealed.descriptor, batches: sealed.batches };
}

describe("Atomic store and six-journey catalog contract (authenticated store)", () => {
  beforeEach(configurePackCatalogAuthority);
  afterEach(() => vi.unstubAllEnvs());

  test("profiles publish first, then one pack head activates without moving another pack", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    await publishFixtureProfiles(t, fixture);
    const receiptA = await publishPack(t, fixture.packs.packA, { packPublicationSequence: "1", expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null } });
    expect(receiptA.result).toEqual({ outcome: "applied", state: "published", reasonCode: null });
    expect(receiptA.packHead).toMatchObject({ generation: 1, publicationEpoch: 0, held: false, activeSnapshotId: fixture.packs.packA.snapshot.identity.publicPackSnapshotId, previousSnapshotId: null, latestAcceptedPackPublicationSequence: "1" });
    const statusBefore = await expectSignedReceipt(await postOperation(t, "pack_publication_status",
      { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: fixture.packs.packA.snapshot.identity.publicPackSnapshotId, operation: null }, packEntity(packCatalogFixtureIds.packA)));
    const receiptB = await publishPack(t, fixture.packs.packB, { packPublicationSequence: "2", expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null } });
    expect(receiptB.packHead?.activeSnapshotId).toBe(fixture.packs.packB.snapshot.identity.publicPackSnapshotId);
    const statusAfter = await expectSignedReceipt(await postOperation(t, "pack_publication_status",
      { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: fixture.packs.packA.snapshot.identity.publicPackSnapshotId, operation: null }, packEntity(packCatalogFixtureIds.packA)));
    expect(statusAfter.packHead).toEqual(statusBefore.packHead);
    expect(statusAfter.result.state).toBe("published");
    const storedA = await t.run(async (ctx) => {
      const heads = await ctx.db.query("activePackHeads").withIndex("by_public_repack_id", (index) => index.eq("publicRepackId", packCatalogFixtureIds.packA)).take(2);
      const batches = await ctx.db.query("publicPackSnapshotBatches").withIndex("by_public_pack_snapshot_id_and_batch_index", (index) => index.eq("publicPackSnapshotId", fixture.packs.packA.snapshot.identity.publicPackSnapshotId)).take(5);
      return { heads, batches };
    });
    expect(storedA.heads).toHaveLength(1);
    expect(storedA.heads[0]!.activeSnapshot.contentSha256).toBe(fixture.packs.packA.snapshot.identity.contentSha256);
    expect(storedA.batches.flatMap((batch) => batch.records)).toEqual(fixture.packs.packA.snapshot.payload.contents);
  });

  test("a first activation is refused until the provider and every referenced collectible profile head exist", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    const entity = packEntity(packCatalogFixtureIds.packA);
    const noProvider = await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(fixture.packs.packA, "1"), entity));
    expect(noProvider.result).toEqual({ outcome: "refused", state: "waiting", reasonCode: "PROFILE_HEAD_MISSING" });
    await publishProfile(t, fixture.provider);
    const started = await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(fixture.packs.packA, "1"), entity));
    expect(started.result.outcome).toBe("applied");
    const noCollectibles = await expectSignedReceipt(await postOperation(t, "apply_pack_snapshot_batch",
      { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: fixture.packs.packA.snapshot.identity.publicPackSnapshotId, batch: fixture.packs.packA.batches[0]! }, entity));
    expect(noCollectibles.result).toEqual({ outcome: "refused", state: "waiting", reasonCode: "PROFILE_HEAD_MISSING" });
    for (const collectible of fixture.collectibles) await publishProfile(t, collectible);
    const receipts = await stagePack(t, fixture.packs.packA, "1");
    expect(receipts.map((receipt) => receipt.result.outcome)).toEqual(["already_applied", "applied", "applied"]);
    const activated = await activatePack(t, fixture.packs.packA, { packPublicationSequence: "1", expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null } });
    expect(activated.result.outcome).toBe("applied");
    const head = await t.run(async (ctx) => await ctx.db.query("activePackHeads").take(5));
    expect(head).toHaveLength(1);
  });

  test("missing, reordered, changed, incomplete, or cross-entity batches cannot finalize or become reachable", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    await publishFixtureProfiles(t, fixture);
    const split = await sealFixturePack(fixture.packs.packA.snapshot.payload, 1);
    const pack: SealedPack = { snapshot: split.snapshot, descriptor: split.descriptor, batches: split.batches };
    expect(pack.batches).toHaveLength(2);
    const entity = packEntity(packCatalogFixtureIds.packA);
    const snapshotId = pack.snapshot.identity.publicPackSnapshotId;
    expect((await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(pack, "1"), entity))).result.outcome).toBe("applied");
    const early = await expectSignedReceipt(await postOperation(t, "finalize_pack_snapshot", { snapshot: pack.snapshot.identity }, entity));
    expect(early.result).toEqual({ outcome: "refused", state: "publishing", reasonCode: "INCOMPLETE_CONTENTS" });
    const reordered = await expectSignedReceipt(await postOperation(t, "apply_pack_snapshot_batch", { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: snapshotId, batch: pack.batches[1]! }, entity));
    expect(reordered.result.outcome).toBe("conflict");
    const tampered = structuredClone(pack.batches[0]!);
    tampered.records[0]!.displayName = "Substituted record";
    const changed = await expectSignedReceipt(await postOperation(t, "apply_pack_snapshot_batch", { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: snapshotId, batch: tampered }, entity));
    expect(changed.result).toEqual({ outcome: "refused", state: "publishing", reasonCode: "INVALID_DOMAIN_DATA" });
    const crossEntity = await expectSignedReceipt(await postOperation(t, "apply_pack_snapshot_batch", { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: snapshotId, batch: { ...fixture.packs.packB.batches[0]!, publicPackSnapshotId: snapshotId } }, entity));
    expect(crossEntity.result).toEqual({ outcome: "refused", state: "publishing", reasonCode: "INVALID_DOMAIN_DATA" });
    expect((await expectSignedReceipt(await postOperation(t, "apply_pack_snapshot_batch", { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: snapshotId, batch: pack.batches[0]! }, entity))).result.outcome).toBe("applied");
    const missingLast = await expectSignedReceipt(await postOperation(t, "finalize_pack_snapshot", { snapshot: pack.snapshot.identity }, entity));
    expect(missingLast.result.reasonCode).toBe("INCOMPLETE_CONTENTS");
    const premature = await expectSignedReceipt(await postOperation(t, "activate_pack_snapshot", { intent: activationIntent(pack, { packPublicationSequence: "1", expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null } }) }, entity));
    expect(premature.result).toEqual({ outcome: "refused", state: "publishing", reasonCode: "INCOMPLETE_CONTENTS" });
    expect((await expectSignedReceipt(await postOperation(t, "apply_pack_snapshot_batch", { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: snapshotId, batch: pack.batches[1]! }, entity))).result.outcome).toBe("applied");
    const finalized = await expectSignedReceipt(await postOperation(t, "finalize_pack_snapshot", { snapshot: pack.snapshot.identity }, entity));
    expect(finalized.result).toEqual({ outcome: "applied", state: "ready", reasonCode: null });
    expect(await t.run(async (ctx) => await ctx.db.query("activePackHeads").take(1))).toEqual([]);
  });

  test("exact repeats return the original receipt, changed bytes conflict, and every attempt owns its intent", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    await publishFixtureProfiles(t, fixture);
    const entity = packEntity(packCatalogFixtureIds.packA);
    const operationId = nextUuid();
    const idempotencyKey = `start:${operationId}`;
    const first = await postOperation(t, "start_pack_snapshot", startBody(fixture.packs.packA, "1"), entity, { operationId, idempotencyKey });
    const original = await expectSignedReceipt(first);
    const repeated = await postOperation(t, "start_pack_snapshot", startBody(fixture.packs.packA, "1"), entity, { operationId, idempotencyKey, bodyJson: first.bodyJson, identity: first.envelope.serviceIdentity as never, mutate: () => first.envelope });
    expect(await expectSignedReceipt(repeated)).toEqual(original);
    const changed = await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(fixture.packs.packA, "2"), entity, { operationId, idempotencyKey }));
    expect(changed.result).toEqual({ outcome: "conflict", state: "publishing", reasonCode: "ACTIVATION_CONFLICT" });
    const operations = await operationCount(t);
    const reusedKey = await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(fixture.packs.packA, "1"), entity, { idempotencyKey }));
    expect(reusedKey.result.outcome).toBe("conflict");
    expect(await operationCount(t)).toBe(operations);
    const rest = await stagePack(t, fixture.packs.packA, "1");
    expect(rest[0]!.result.outcome).toBe("already_applied");
    expect(rest[2]!.result.outcome).toBe("applied");
    const again = await expectSignedReceipt(await postOperation(t, "finalize_pack_snapshot", { snapshot: fixture.packs.packA.snapshot.identity }, entity));
    expect(again.result).toEqual({ outcome: "already_applied", state: "ready", reasonCode: null });
    const expiredId = nextUuid();
    await t.run(async (ctx) => {
      const record = (await ctx.db.query("packCatalogOperations").withIndex("by_operation_id", (index) => index.eq("operationId", operationId)).take(1))[0]!;
      const { _id, _creationTime, ...fields } = record;
      void _id;
      void _creationTime;
      const completedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString();
      await ctx.db.insert("packCatalogOperations", { ...fields, operationId: expiredId, idempotencyKey: `start:${expiredId}`, completedAt, expiresAt: new Date(Date.parse(completedAt) + 30 * 24 * 60 * 60 * 1_000).toISOString() });
    });
    const expiredEnvelope = { ...first.envelope, operationId: expiredId, idempotencyKey: `start:${expiredId}` };
    const expiredReplay = await postOperation(t, "start_pack_snapshot", startBody(fixture.packs.packA, "1"), entity, { operationId: expiredId, idempotencyKey: `start:${expiredId}`, bodyJson: packCatalogCanonicalJson(expiredEnvelope), identity: first.envelope.serviceIdentity as never, mutate: () => expiredEnvelope });
    const mismatchedIdentity = await postOperation(t, "start_pack_snapshot", startBody(fixture.packs.packA, "1"), entity, { operationId, idempotencyKey: `start:${expiredId}` });
    expect((await expectSignedReceipt(mismatchedIdentity)).result.outcome).toBe("conflict");
    expect((await expectSignedReceipt(expiredReplay)).result).toEqual({ outcome: "operation_expired", state: "publishing", reasonCode: "OPERATION_EXPIRED" });
  });

  test("competing same-pack activations yield one winner; stale sequences and epochs cannot move a head", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    await publishFixtureProfiles(t, fixture);
    await publishPack(t, fixture.packs.packA, { packPublicationSequence: "1", expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null } });
    const first = fixture.packs.packA.snapshot.identity.publicPackSnapshotId;
    const update = fixture.packs.packAUpdate;
    for (const receipt of await stagePack(t, update, "2")) expect(receipt.result.outcome).toBe("applied");
    const expectedHead = { generation: 1, publicationEpoch: 0, activeSnapshotId: first };
    const winner = await activatePack(t, update, { packPublicationSequence: "2", expectedHead });
    expect(winner.result).toEqual({ outcome: "applied", state: "published", reasonCode: null });
    expect(winner.packHead).toMatchObject({ generation: 2, activeSnapshotId: update.snapshot.identity.publicPackSnapshotId, previousSnapshotId: first });
    const loser = await activatePack(t, update, { packPublicationSequence: "3", expectedHead });
    expect(loser.result).toEqual({ outcome: "conflict", state: "published", reasonCode: "ACTIVATION_CONFLICT" });
    expect(loser.packHead?.generation).toBe(2);
    const stale = await activatePack(t, fixture.packs.packA, { packPublicationSequence: "1", expectedHead: { generation: 2, publicationEpoch: 0, activeSnapshotId: update.snapshot.identity.publicPackSnapshotId } });
    expect(stale.result.outcome).toBe("conflict");
    const unbound = await activatePack(t, update, { packPublicationSequence: "3", expectedHead: { generation: 2, publicationEpoch: 0, activeSnapshotId: update.snapshot.identity.publicPackSnapshotId } });
    expect(unbound.result).toEqual({ outcome: "conflict", state: "published", reasonCode: "ACTIVATION_CONFLICT" });
    const redeclared = await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(update, "3"), packEntity(packCatalogFixtureIds.packA)));
    expect(redeclared.result).toEqual({ outcome: "applied", state: "published", reasonCode: null });
    const alreadyActive = await activatePack(t, update, { packPublicationSequence: "3", expectedHead: { generation: 2, publicationEpoch: 0, activeSnapshotId: update.snapshot.identity.publicPackSnapshotId } });
    expect(alreadyActive.result).toEqual({ outcome: "already_active", state: "published", reasonCode: null });
    expect(alreadyActive.packHead).toMatchObject({ generation: 2, latestAcceptedPackPublicationSequence: "3" });
    expect((await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(fixture.packs.packA, "4"), packEntity(packCatalogFixtureIds.packA)))).result.outcome).toBe("applied");
    const expired = await activatePack(t, fixture.packs.packA, { packPublicationSequence: "4", expectedHead: { generation: 2, publicationEpoch: 0, activeSnapshotId: update.snapshot.identity.publicPackSnapshotId }, expiresAt: "2026-09-03T18:31:00.000Z" });
    expect(expired.result).toEqual({ outcome: "refused", state: "superseded", reasonCode: "OPERATION_EXPIRED" });
    const staleEv = await activatePack(t, fixture.packs.packA, { packPublicationSequence: "4", expectedHead: { generation: 2, publicationEpoch: 0, activeSnapshotId: update.snapshot.identity.publicPackSnapshotId }, createdAt: "2026-09-03T19:00:00.000Z" });
    expect(staleEv.result).toEqual({ outcome: "refused", state: "waiting", reasonCode: "EV_INPUTS_PENDING" });
    const republished = await activatePack(t, fixture.packs.packA, { packPublicationSequence: "4", expectedHead: { generation: 2, publicationEpoch: 0, activeSnapshotId: update.snapshot.identity.publicPackSnapshotId } });
    expect(republished.result).toEqual({ outcome: "applied", state: "published", reasonCode: null });
    expect(republished.packHead).toMatchObject({ generation: 3, activeSnapshotId: first, previousSnapshotId: update.snapshot.identity.publicPackSnapshotId, latestAcceptedPackPublicationSequence: "4" });
  });

  test("hold fences prior epochs, retained activation selects only the previous snapshot, and resume is exact", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    await publishFixtureProfiles(t, fixture);
    await publishPack(t, fixture.packs.packA, { packPublicationSequence: "1", expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null } });
    const first = fixture.packs.packA.snapshot.identity.publicPackSnapshotId;
    const update = fixture.packs.packAUpdate;
    await stagePack(t, update, "2");
    await activatePack(t, update, { packPublicationSequence: "2", expectedHead: { generation: 1, publicationEpoch: 0, activeSnapshotId: first } });
    const entity = packEntity(packCatalogFixtureIds.packA);
    const wrongGeneration = await expectSignedReceipt(await postOperation(t, "hold_pack_head", { publicRepackId: packCatalogFixtureIds.packA, expectedGeneration: 1, expectedPublicationEpoch: 0 }, entity));
    expect(wrongGeneration.result.outcome).toBe("conflict");
    const held = await expectSignedReceipt(await postOperation(t, "hold_pack_head", { publicRepackId: packCatalogFixtureIds.packA, expectedGeneration: 2, expectedPublicationEpoch: 0 }, entity));
    expect(held.result.outcome).toBe("applied");
    expect(held.packHead).toMatchObject({ generation: 2, publicationEpoch: 1, held: true });
    expect((await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(fixture.packs.packA, "3"), entity))).result.outcome).toBe("applied");
    const fenced = await activatePack(t, fixture.packs.packA, { packPublicationSequence: "3", expectedHead: { generation: 2, publicationEpoch: 0, activeSnapshotId: update.snapshot.identity.publicPackSnapshotId } });
    expect(fenced.result).toEqual({ outcome: "refused", state: "waiting", reasonCode: "OPERATOR_HOLD" });
    const wrongTarget = await expectSignedReceipt(await postOperation(t, "activate_retained_pack_snapshot", { publicRepackId: packCatalogFixtureIds.packA, expectedGeneration: 2, expectedPublicationEpoch: 1, targetSnapshotId: update.snapshot.identity.publicPackSnapshotId }, entity));
    expect(wrongTarget.result.outcome).toBe("conflict");
    const rolledBack = await expectSignedReceipt(await postOperation(t, "activate_retained_pack_snapshot", { publicRepackId: packCatalogFixtureIds.packA, expectedGeneration: 2, expectedPublicationEpoch: 1, targetSnapshotId: first }, entity));
    expect(rolledBack.result.outcome).toBe("applied");
    expect(rolledBack.packHead).toMatchObject({ generation: 3, publicationEpoch: 1, held: true, activeSnapshotId: first, previousSnapshotId: update.snapshot.identity.publicPackSnapshotId });
    const wrongResume = await expectSignedReceipt(await postOperation(t, "resume_pack_head", { publicRepackId: packCatalogFixtureIds.packA, expectedGeneration: 2, expectedPublicationEpoch: 1 }, entity));
    expect(wrongResume.result.outcome).toBe("conflict");
    expect(wrongResume.packHead?.held).toBe(true);
    const resumeRequest = await postOperation(t, "resume_pack_head", { publicRepackId: packCatalogFixtureIds.packA, expectedGeneration: 3, expectedPublicationEpoch: 1 }, entity);
    const resumed = await expectSignedReceipt(resumeRequest);
    expect(resumed.result.outcome).toBe("applied");
    expect(resumed.packHead).toMatchObject({ generation: 3, publicationEpoch: 1, held: false });
    const resumedAgain = await expectSignedReceipt(await postOperation(t, "resume_pack_head", resumeRequest.envelope.body, entity, { bodyJson: resumeRequest.bodyJson, identity: resumeRequest.envelope.serviceIdentity as never, mutate: () => resumeRequest.envelope }));
    expect(resumedAgain).toEqual(resumed);
    const resumeReleased = await expectSignedReceipt(await postOperation(t, "resume_pack_head", { publicRepackId: packCatalogFixtureIds.packA, expectedGeneration: 3, expectedPublicationEpoch: 1 }, entity));
    expect(resumeReleased.result.outcome).toBe("conflict");
    expect(resumeReleased.packHead).toMatchObject({ generation: 3, publicationEpoch: 1, held: false });
    expect((await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(update, "4"), entity))).result.outcome).toBe("applied");
    const staleEpoch = await activatePack(t, update, { packPublicationSequence: "4", expectedHead: { generation: 3, publicationEpoch: 0, activeSnapshotId: first } });
    expect(staleEpoch.result.outcome).toBe("conflict");
    const current = await activatePack(t, update, { packPublicationSequence: "4", expectedHead: { generation: 3, publicationEpoch: 1, activeSnapshotId: first } });
    expect(current.result.outcome).toBe("applied");
    expect(current.packHead).toMatchObject({ generation: 4, activeSnapshotId: update.snapshot.identity.publicPackSnapshotId, latestAcceptedPackPublicationSequence: "4" });
    const displaced = await t.run(async (ctx) => (await ctx.db.query("publicPackSnapshots").withIndex("by_public_pack_snapshot_id", (index) => index.eq("publicPackSnapshotId", first)).take(1))[0]);
    expect(displaced?.state).toBe("complete");
    expect(displaced?.displacedBy).toBe("activation");
  });

  test("block keeps staged work unreachable, the active snapshot cannot be blocked, and status stores nothing", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    await publishFixtureProfiles(t, fixture);
    await publishPack(t, fixture.packs.packA, { packPublicationSequence: "1", expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null } });
    const entity = packEntity(packCatalogFixtureIds.packA);
    const update = fixture.packs.packAUpdate;
    const started = await postOperation(t, "start_pack_snapshot", startBody(update, "2"), entity);
    await expectSignedReceipt(started);
    const blocked = await expectSignedReceipt(await postOperation(t, "block_pack_snapshot", { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: update.snapshot.identity.publicPackSnapshotId, reasonCode: "INVALID_DOMAIN_DATA" }, entity));
    expect(blocked.result).toEqual({ outcome: "applied", state: "blocked", reasonCode: null });
    const afterBlock = await expectSignedReceipt(await postOperation(t, "apply_pack_snapshot_batch", { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: update.snapshot.identity.publicPackSnapshotId, batch: update.batches[0]! }, entity));
    expect(afterBlock.result).toEqual({ outcome: "refused", state: "blocked", reasonCode: "INVALID_DOMAIN_DATA" });
    const activeBlock = await expectSignedReceipt(await postOperation(t, "block_pack_snapshot", { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: fixture.packs.packA.snapshot.identity.publicPackSnapshotId, reasonCode: "INVALID_DOMAIN_DATA" }, entity));
    expect(activeBlock.result.outcome).toBe("conflict");
    const operations = await operationCount(t);
    const status = await expectSignedReceipt(await postOperation(t, "pack_publication_status", {
      publicRepackId: packCatalogFixtureIds.packA,
      publicPackSnapshotId: update.snapshot.identity.publicPackSnapshotId,
      operation: { operationId: started.envelope.operationId as string, requestSha256: await hashHex(started.bodyJson) },
    }, entity));
    expect(status.snapshotState).toBe("blocked");
    expect(status.statusOperation).toEqual({ found: true, result: { outcome: "already_applied", state: "publishing", reasonCode: null } });
    expect(status.packHead?.activeSnapshotId).toBe(fixture.packs.packA.snapshot.identity.publicPackSnapshotId);
    expect(await operationCount(t)).toBe(operations);
    const unknown = await expectSignedReceipt(await postOperation(t, "pack_publication_status", { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: null, operation: { operationId: nextUuid(), requestSha256: "f".repeat(64) } }, entity));
    expect(unknown.statusOperation).toEqual({ found: false, result: null });
  });

  test("a later profile activation leaves sealed pack bytes and the pack head untouched", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    await publishFixtureProfiles(t, fixture);
    const published = await publishPack(t, fixture.packs.packA, { packPublicationSequence: "1", expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null } });
    const renamed = await resealCollectibleProfile(fixture.collectibles[0]!, "Alpha Card Renamed");
    const receipts = await publishProfile(t, renamed, 1);
    expect(receipts[3]!.profileHead).toMatchObject({ generation: 2, activeProfileSnapshotId: renamed.descriptor.identity.publicProfileSnapshotId, previousProfileSnapshotId: fixture.collectibles[0]!.profile.identity.publicProfileSnapshotId });
    const status = await expectSignedReceipt(await postOperation(t, "pack_publication_status", { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: fixture.packs.packA.snapshot.identity.publicPackSnapshotId, operation: null }, packEntity(packCatalogFixtureIds.packA)));
    expect(status.packHead).toEqual(published.packHead);
    const stored = await t.run(async (ctx) => (await ctx.db.query("publicPackSnapshots").withIndex("by_public_pack_snapshot_id", (index) => index.eq("publicPackSnapshotId", fixture.packs.packA.snapshot.identity.publicPackSnapshotId)).take(1))[0]!);
    expect(stored.contentSha256).toBe(fixture.packs.packA.snapshot.identity.contentSha256);
    expect(stored.header.summaryProjection).toEqual(fixture.packs.packA.snapshot.payload.summaryProjection);
    const stale = await publishProfile(t, renamed, 1).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(Error);
  });

  test("a first publication names the exact profile snapshots that are active at staging and again at activation", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    await publishFixtureProfiles(t, fixture);
    const renamedA = await resealCollectibleProfile(fixture.collectibles[0]!, "Alpha Card Renamed");
    await publishProfile(t, renamedA, 1);
    const entityA = packEntity(packCatalogFixtureIds.packA);
    expect((await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(fixture.packs.packA, "1"), entityA))).result.outcome).toBe("applied");
    const staleReference = await expectSignedReceipt(await postOperation(t, "apply_pack_snapshot_batch",
      { publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: fixture.packs.packA.snapshot.identity.publicPackSnapshotId, batch: fixture.packs.packA.batches[0]! }, entityA));
    expect(staleReference.result).toEqual({ outcome: "refused", state: "waiting", reasonCode: "PROFILE_HEAD_MISSING" });
    for (const receipt of await stagePack(t, fixture.packs.packB, "1")) expect(receipt.result.outcome).toBe("applied");
    const renamedB = await resealCollectibleProfile(fixture.collectibles[1]!, "Beta Card Renamed");
    await publishProfile(t, renamedB, 1);
    const movedHead = await activatePack(t, fixture.packs.packB, { packPublicationSequence: "1", expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null } });
    expect(movedHead.result).toEqual({ outcome: "refused", state: "waiting", reasonCode: "PROFILE_HEAD_MISSING" });
    expect(await t.run(async (ctx) => (await ctx.db.query("activePackHeads").take(1)).length)).toBe(0);
  });

  test("a maximum P01 batch stages, finalizes, and activates inside one transaction budget", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    await publishFixtureProfiles(t, fixture);
    await publishPack(t, fixture.packs.packA, { packPublicationSequence: "1", expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null } });
    const scale = await buildScalePack(fixture, 250);
    expect(scale.batches).toHaveLength(1);
    expect(scale.batches[0]!.recordCount).toBe(250);
    const receipts = await stagePack(t, scale, "2");
    expect(receipts.map((receipt) => receipt.result.outcome)).toEqual(["applied", "applied", "applied"]);
    const activated = await activatePack(t, scale, { packPublicationSequence: "2", expectedHead: { generation: 1, publicationEpoch: 0, activeSnapshotId: fixture.packs.packA.snapshot.identity.publicPackSnapshotId } });
    expect(activated.result.outcome).toBe("applied");
    const memberships = await t.run(async (ctx) => (await ctx.db.query("publicPackMemberships").withIndex("by_public_pack_snapshot_id", (index) => index.eq("publicPackSnapshotId", scale.snapshot.identity.publicPackSnapshotId)).take(300)).length);
    expect(memberships).toBe(250);
  });
});

async function hashHex(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("pack catalog store security boundary", () => {
  beforeEach(configurePackCatalogAuthority);
  afterEach(() => vi.unstubAllEnvs());

  async function code(response: { status: number; json: Record<string, unknown> }) {
    return `${response.status}:${String(response.json.code)}`;
  }

  test("unauthenticated, unknown, and misconfigured callers are refused before any state is read", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    const entity = packEntity(packCatalogFixtureIds.packA);
    const body = startBody(fixture.packs.packA, "1");
    const path = PACK_CATALOG_OPERATION_PATHS.start_pack_snapshot;
    const envelope = { schemaVersion: PACK_CATALOG_V1, operationKind: "start_pack_snapshot", operationId: nextUuid(), idempotencyKey: "start:anon", serviceIdentity: await serviceIdentity({ entity }), requestedAt: new Date().toISOString(), body };
    const anonymous = await t.fetch(path, { method: "POST", body: packCatalogCanonicalJson(envelope), headers: { "content-type": "application/json" } });
    expect(`${anonymous.status}:${((await anonymous.json()) as { code: string }).code}`).toBe("401:PACK_CATALOG_AUTH_MISSING");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { keyId: "unknown-key-v1", secret: "packscout-unknown-secret-0000000000000001" }))).toBe("401:PACK_CATALOG_AUTH_KEY_UNKNOWN");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { secret: "packscout-wrong-secret-000000000000000001" }))).toBe("401:PACK_CATALOG_AUTH_INVALID");
    const nonce = "packreplaynonce00000001";
    const init = await signedProviderInit(path, envelope, { bodyJson: packCatalogCanonicalJson(envelope), keyId: PROVIDER_KEY_ID, secret: "packscout-pack-provider-alpha-secret-00000001", nonce });
    expect((await t.fetch(path, init)).status).toBe(200);
    const replayed = await t.fetch(path, init);
    expect(`${replayed.status}:${((await replayed.json()) as { code: string }).code}`).toBe("401:PACK_CATALOG_AUTH_REPLAYED");
    vi.stubEnv("PACKSCOUT_PACK_CATALOG_V1_PUBLICATION_KEYS", packCatalogCanonicalJson({ [PROVIDER_KEY_ID]: AUTHORITIES[PROVIDER_KEY_ID] }).replace("local", "live"));
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity))).toBe("403:PACK_CATALOG_AUTH_FORBIDDEN");
    vi.stubEnv("PACKSCOUT_PACK_CATALOG_V1_PUBLICATION_KEYS", packCatalogCanonicalJson({ [CATALOG_KEY_ID]: AUTHORITIES[CATALOG_KEY_ID] }));
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity))).toBe("401:PACK_CATALOG_AUTH_KEY_UNKNOWN");
    vi.stubEnv("PACKSCOUT_PACK_CATALOG_V1_PUBLICATION_KEYS", JSON.stringify(AUTHORITIES, null, 2));
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity))).toBe("401:PACK_CATALOG_AUTH_KEY_UNKNOWN");
  });

  test("wrong scope, wrong environment, wrong organization, expired identity, and forged authority fail closed", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    const entity = packEntity(packCatalogFixtureIds.packA);
    const body = startBody(fixture.packs.packA, "1");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { keyId: CATALOG_KEY_ID, identity: await serviceIdentity({ entity }) }))).toBe("403:PACK_CATALOG_AUTH_FORBIDDEN");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { keyId: CATALOG_KEY_ID }))).toBe("400:PACK_CATALOG_REQUEST_INVALID");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { keyId: OTHER_PROVIDER_KEY_ID }))).toBe("403:PACK_CATALOG_AUTH_FORBIDDEN");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { identity: await serviceIdentity({ entity, environment: "live" }) }))).toBe("403:PACK_CATALOG_AUTH_FORBIDDEN");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { identity: await serviceIdentity({ entity, organizationId: "10000000-0000-4000-8000-000000000002" }) }))).toBe("403:PACK_CATALOG_AUTH_FORBIDDEN");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { identity: await serviceIdentity({ entity, issuedAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() }) }))).toBe("403:PACK_CATALOG_AUTH_FORBIDDEN");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { identity: await serviceIdentity({ entity, operations: ["read_receipt"] }) }))).toBe("403:PACK_CATALOG_AUTH_FORBIDDEN");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { identity: { ...await serviceIdentity({ entity }), authorizationSha256: "a".repeat(64) } }))).toBe("403:PACK_CATALOG_AUTH_FORBIDDEN");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, packEntity(packCatalogFixtureIds.packB)))).toBe("403:PACK_CATALOG_AUTH_FORBIDDEN");
    vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "production");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity))).toBe("403:PACK_CATALOG_AUTH_FORBIDDEN");
    expect(await t.run(async (ctx) => (await ctx.db.query("publicPackSnapshots").take(1)).length)).toBe(0);
  });

  test("malformed, non-canonical, protected, mismatched, and oversized bodies are refused", async () => {
    const t = createTest();
    const fixture = await loadFixture();
    const entity = packEntity(packCatalogFixtureIds.packA);
    const body = startBody(fixture.packs.packA, "1");
    const pretty = await postOperation(t, "start_pack_snapshot", body, entity, { mutate: (envelope) => envelope, bodyJson: undefined });
    expect(pretty.status).toBe(200);
    const identity = await serviceIdentity({ entity });
    const envelope = { schemaVersion: PACK_CATALOG_V1, operationKind: "start_pack_snapshot", operationId: nextUuid(), idempotencyKey: "start:pretty", serviceIdentity: identity, requestedAt: new Date().toISOString(), body };
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { identity, bodyJson: JSON.stringify(envelope, null, 2), mutate: () => envelope }))).toBe("400:PACK_CATALOG_REQUEST_INVALID");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { mutate: (value) => ({ ...value, schemaVersion: "pack_catalog_v0" }) }))).toBe("400:PACK_CATALOG_SCHEMA_UNSUPPORTED");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { mutate: (value) => ({ ...value, body: { ...body, rawProviderPayload: "secret" } }) }))).toBe("400:PACK_CATALOG_PROTECTED_FIELD");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { mutate: (value) => ({ ...value, extra: true }) }))).toBe("400:PACK_CATALOG_REQUEST_INVALID");
    expect(await code(await postOperation(t, "start_pack_snapshot", body, entity, { path: PACK_CATALOG_OPERATION_PATHS.apply_pack_snapshot_batch }))).toBe("400:PACK_CATALOG_REQUEST_INVALID");
    const oversized = await postOperation(t, "start_pack_snapshot", body, entity, { mutate: (value) => ({ ...value, idempotencyKey: "x".repeat(600 * 1_024) }) });
    expect(oversized.status).toBe(413);
  });
});

void PROVIDER_ID;
