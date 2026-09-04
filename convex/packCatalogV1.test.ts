/// <reference types="vite/client" />

import {
  PACK_CATALOG_CURSOR_LIFETIME_MS,
  packCatalogQueryNames,
  packCatalogV1QueryContracts,
  savedCatalogItemsV1Contract,
} from "@packscout/contracts";
import { packCatalogFixtureIds, sealFixturePack } from "@packscout/contracts/test-fixtures/pack-catalog-v1";
import { publicPackSummaryCore } from "@packscout/contracts";
import { convexTest } from "convex-test";
import type { z } from "zod";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  activatePack,
  configurePackCatalogAuthority,
  expectSignedReceipt,
  loadFixture,
  packEntity,
  postOperation,
  publishFixtureProfiles,
  publishPack,
  stagePack,
  startBody,
  type Fixture,
  type SealedPack,
  type StoreTest,
} from "./packCatalogV1.test-support";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const NOW = Date.parse("2026-09-03T18:10:00.000Z");
type PackCatalogQueryName = (typeof packCatalogQueryNames)[number];
const USER_A = { subject: "did:privy:user-a", issuer: "privy.io", tokenIdentifier: "privy.io|did:privy:user-a" };
const QUERIES = {
  getPublicShellStatus: internal.packCatalogV1.getPublicShellStatusAtTime,
  getDashboardBundle: internal.packCatalogV1.getDashboardBundleAtTime,
  listPublicPacks: internal.packCatalogV1.listPublicPacksAtTime,
  getPublicPack: internal.packCatalogV1.getPublicPackAtTime,
  searchPublicCollectibles: internal.packCatalogV1.searchPublicCollectiblesAtTime,
  findPacksByDesiredCollectible: internal.packCatalogV1.findPacksByDesiredCollectibleAtTime,
} as const;

function createTest(): StoreTest {
  return convexTest({ schema, modules, transactionLimits: true });
}

type QueryOutputs = { [N in PackCatalogQueryName]: z.infer<(typeof packCatalogV1QueryContracts)[N]["output"]> };

async function run<N extends PackCatalogQueryName>(
  t: StoreTest,
  name: N,
  request: unknown,
  options: { currentTime?: number; catalogReadToken?: unknown } = {},
): Promise<QueryOutputs[N]> {
  const reference = QUERIES[name] as typeof QUERIES.getPublicShellStatus;
  const raw = await t.query(reference, { currentTime: options.currentTime ?? NOW, request, catalogReadToken: options.catalogReadToken });
  return packCatalogV1QueryContracts[name].output.parse(raw) as QueryOutputs[N];
}

function ok<D>(result: { ok: true; data: D } | { ok: false }): D {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result as { ok: true; data: D }).data;
}

async function seed(t: StoreTest): Promise<Fixture> {
  const fixture = await loadFixture();
  await publishFixtureProfiles(t, fixture);
  await publishPack(t, fixture.packs.packA, { packPublicationSequence: "1", expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null } });
  await publishPack(t, fixture.packs.packB, { packPublicationSequence: "2", expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null } });
  return fixture;
}

async function updatePackA(t: StoreTest, fixture: Fixture) {
  await stagePack(t, fixture.packs.packAUpdate, "3");
  const receipt = await activatePack(t, fixture.packs.packAUpdate, {
    packPublicationSequence: "3",
    expectedHead: { generation: 1, publicationEpoch: 0, activeSnapshotId: fixture.packs.packA.snapshot.identity.publicPackSnapshotId },
  });
  expect(receipt.result.outcome).toBe("applied");
}

const ALL_STATES = { retirements: ["active", "retired"], availabilities: ["available", "sold_out", "unavailable", "unknown"] };

describe("Atomic store and six-journey catalog contract (public reads)", () => {
  beforeEach(configurePackCatalogAuthority);
  afterEach(() => vi.unstubAllEnvs());

  test("all six journeys resolve one pack from the same active snapshot and stay within the V1 contract", async () => {
    const t = createTest();
    const fixture = await seed(t);
    const packA = fixture.packs.packA.snapshot.identity;
    const shell = ok(await run(t, "getPublicShellStatus", {}));
    expect(shell).toMatchObject({ catalogAvailable: true, activeAvailablePackCount: 1, evaluatedAt: new Date(NOW).toISOString() });
    const dashboard = ok(await run(t, "getDashboardBundle", {}));
    expect(dashboard.totalMatchingPacks).toBe(1);
    expect(dashboard.packs.map((pack) => pack.publicPackSnapshotId)).toEqual([packA.publicPackSnapshotId]);
    const list = ok(await run(t, "listPublicPacks", {}));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: packA.publicPackSnapshotId, contentSha256: packA.contentSha256, headGeneration: 1 });
    expect(list.nextCursor).toBeNull();
    const allState = ok(await run(t, "listPublicPacks", { lifecycle: ALL_STATES, sort: "title", direction: "asc" }));
    expect(allState.items.map((item) => item.publicRepackId)).toEqual([packCatalogFixtureIds.packA, packCatalogFixtureIds.packB]);
    expect(allState.items[1]!.lifecycle.availability).toBe("sold_out");
    expect(allState.items[1]!.hasEnabledAction).toBe(false);
    const detail = ok(await run(t, "getPublicPack", { publicRepackId: packCatalogFixtureIds.packA }));
    expect(detail.snapshot).toEqual(packA);
    expect(detail.summary).toEqual(fixture.packs.packA.snapshot.payload.summaryProjection);
    expect(detail.contents).toEqual(fixture.packs.packA.snapshot.payload.contents);
    expect(detail.detail.valuationDependencyIdentities).toEqual(fixture.packs.packA.snapshot.payload.valuationDependencyIdentities);
    expect(detail.detail.economicsSha256).toBe(fixture.packs.packA.snapshot.payload.economicsSha256);
    expect(detail.nextContentsCursor).toBeNull();
    const soldOut = ok(await run(t, "getPublicPack", { publicRepackId: packCatalogFixtureIds.packB }));
    expect(soldOut.contents).toHaveLength(2);
    expect(soldOut.detail.actions.every((action) => !action.enabled && action.disabledReason === "PACK_UNAVAILABLE")).toBe(true);
    const search = ok(await run(t, "searchPublicCollectibles", { query: "beta" }));
    expect(search.items.map((item) => item.displayName)).toEqual(["Beta Card"]);
    expect(search.items[0]!.identity).toEqual(fixture.collectibles[1]!.profile.identity);
    const desired = ok(await run(t, "findPacksByDesiredCollectible", { publicCollectibleId: packCatalogFixtureIds.collectibleB }));
    expect(desired.items.map((item) => item.publicPackSnapshotId)).toEqual([packA.publicPackSnapshotId]);
    const desiredAll = ok(await run(t, "findPacksByDesiredCollectible", { publicCollectibleId: packCatalogFixtureIds.collectibleB, lifecycle: ALL_STATES, sort: "title", direction: "asc" }));
    expect(desiredAll.items.map((item) => item.publicRepackId)).toEqual([packCatalogFixtureIds.packA, packCatalogFixtureIds.packB]);
    expect(JSON.stringify([shell, dashboard, list, detail, search, desired]).toLocaleLowerCase("en-US").includes("heat")).toBe(false);
  });

  test("not-found, invalid, gated, and unavailable outcomes stay bounded", async () => {
    const t = createTest();
    await seed(t);
    expect(await run(t, "getPublicPack", { publicRepackId: "30000000-0000-4000-8000-0000000000ff" })).toMatchObject({ ok: false, code: "PACK_NOT_FOUND", retryable: false });
    expect(await run(t, "findPacksByDesiredCollectible", { publicCollectibleId: "40000000-0000-4000-8000-0000000000ff" })).toMatchObject({ ok: false, code: "COLLECTIBLE_NOT_FOUND" });
    expect(await run(t, "listPublicPacks", { pageSize: 500 })).toMatchObject({ ok: false, code: "INVALID_QUERY" });
    expect(await run(t, "listPublicPacks", { heat: "hot" })).toMatchObject({ ok: false, code: "INVALID_QUERY" });
    expect(await run(t, "getPublicShellStatus", {}, { currentTime: -1 })).toMatchObject({ ok: false, code: "INVALID_QUERY" });
    vi.stubEnv("PACKSCOUT_CLOSED_BETA", "1");
    vi.stubEnv("PACKSCOUT_CATALOG_READ_TOKEN", "packscout-catalog-read-token-for-tests-0001");
    expect(await run(t, "listPublicPacks", {})).toMatchObject({ ok: false, code: "CATALOG_UNAVAILABLE", retryable: true });
    expect(ok(await run(t, "listPublicPacks", {}, { catalogReadToken: "packscout-catalog-read-token-for-tests-0001" })).items).toHaveLength(1);
    vi.stubEnv("PACKSCOUT_CLOSED_BETA", "");
    vi.stubEnv("PACKSCOUT_CATALOG_READ_TOKEN", "");
    vi.stubEnv("PACKSCOUT_PUBLIC_CURSOR_HMAC_KEY", "");
    expect(await run(t, "listPublicPacks", {})).toMatchObject({ ok: false, code: "CATALOG_UNAVAILABLE" });
  });

  test("live keyset pages stay valid across an unrelated activation and refuse tampered, mismatched, or expired cursors", async () => {
    const t = createTest();
    const fixture = await seed(t);
    const request = { lifecycle: ALL_STATES, sort: "title", direction: "asc", pageSize: 1 };
    const first = ok(await run(t, "listPublicPacks", request));
    expect(first.items.map((item) => item.publicRepackId)).toEqual([packCatalogFixtureIds.packA]);
    expect(first.nextCursor).not.toBeNull();
    await updatePackA(t, fixture);
    const second = ok(await run(t, "listPublicPacks", { ...request, cursor: first.nextCursor }));
    expect(second.items.map((item) => item.publicRepackId)).toEqual([packCatalogFixtureIds.packB]);
    expect(second.nextCursor).toBeNull();
    const refreshed = ok(await run(t, "listPublicPacks", { ...request, pageSize: 10 }));
    expect(refreshed.items[0]).toMatchObject({ publicRepackId: packCatalogFixtureIds.packA, publicPackSnapshotId: fixture.packs.packAUpdate.snapshot.identity.publicPackSnapshotId, headGeneration: 2 });
    expect(refreshed.items[0]!.lifecycle.availability).toBe("sold_out");
    expect(ok(await run(t, "listPublicPacks", {})).items).toEqual([]);
    const cursor = first.nextCursor!;
    const flipped = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
    expect(await run(t, "listPublicPacks", { ...request, cursor: flipped })).toMatchObject({ ok: false, code: "CURSOR_EXPIRED", retryable: false });
    expect(await run(t, "listPublicPacks", { ...request, pageSize: 2, cursor })).toMatchObject({ ok: false, code: "CURSOR_EXPIRED" });
    expect(await run(t, "listPublicPacks", { ...request, sort: "price", cursor })).toMatchObject({ ok: false, code: "CURSOR_EXPIRED" });
    expect(await run(t, "listPublicPacks", { ...request, cursor }, { currentTime: NOW + PACK_CATALOG_CURSOR_LIFETIME_MS })).toMatchObject({ ok: false, code: "CURSOR_EXPIRED" });
    expect(await run(t, "listPublicPacks", { ...request, cursor: "bad.cursor" })).toMatchObject({ ok: false, code: "CURSOR_EXPIRED" });
    const byEv = ok(await run(t, "listPublicPacks", { lifecycle: ALL_STATES, sort: "ev", direction: "desc", pageSize: 1 }));
    expect(byEv.items[0]!.publicRepackId).toBe(packCatalogFixtureIds.packA);
    const evRest = ok(await run(t, "listPublicPacks", { lifecycle: ALL_STATES, sort: "ev", direction: "desc", pageSize: 1, cursor: byEv.nextCursor }));
    expect(evRest.items[0]!.publicRepackId).toBe(packCatalogFixtureIds.packB);
  });

  test("pack contents paginate inside one immutable snapshot even after the head advances", async () => {
    const t = createTest();
    const fixture = await seed(t);
    const page1 = ok(await run(t, "getPublicPack", { publicRepackId: packCatalogFixtureIds.packA, contentPageSize: 1 }));
    expect(page1.contents.map((content) => content.publicCollectibleId)).toEqual([packCatalogFixtureIds.collectibleA]);
    expect(page1.contentCount).toBe(2);
    expect(page1.nextContentsCursor).not.toBeNull();
    await updatePackA(t, fixture);
    const page2 = ok(await run(t, "getPublicPack", { publicRepackId: packCatalogFixtureIds.packA, contentPageSize: 1, contentsCursor: page1.nextContentsCursor }));
    expect(page2.snapshot.publicPackSnapshotId).toBe(fixture.packs.packA.snapshot.identity.publicPackSnapshotId);
    expect(page2.contents.map((content) => content.publicCollectibleId)).toEqual([packCatalogFixtureIds.collectibleB]);
    expect(page2.nextContentsCursor).toBeNull();
    const fresh = ok(await run(t, "getPublicPack", { publicRepackId: packCatalogFixtureIds.packA }));
    expect(fresh.snapshot.publicPackSnapshotId).toBe(fixture.packs.packAUpdate.snapshot.identity.publicPackSnapshotId);
    expect(fresh.summary.lifecycle.availability).toBe("sold_out");
    expect(fresh.detail.economicsSha256).toBe(page1.detail.economicsSha256);
    expect(await run(t, "getPublicPack", { publicRepackId: packCatalogFixtureIds.packA, contentPageSize: 2, contentsCursor: page1.nextContentsCursor })).toMatchObject({ ok: false, code: "CURSOR_EXPIRED" });
    const desired = ok(await run(t, "findPacksByDesiredCollectible", { publicCollectibleId: packCatalogFixtureIds.collectibleA, lifecycle: ALL_STATES }));
    expect(desired.items.map((item) => item.publicPackSnapshotId)).toEqual([fixture.packs.packAUpdate.snapshot.identity.publicPackSnapshotId]);
  });

  test("collectible search pages by display name and joins one active profile head", async () => {
    const t = createTest();
    const fixture = await seed(t);
    const first = ok(await run(t, "searchPublicCollectibles", { query: "card", pageSize: 2 }));
    expect(first.items.map((item) => item.displayName)).toEqual(["Alpha Card", "Beta Card"]);
    const second = ok(await run(t, "searchPublicCollectibles", { query: "card", pageSize: 2, cursor: first.nextCursor }));
    expect(second.items.map((item) => item.displayName)).toEqual(["Gamma Card"]);
    expect(second.nextCursor).toBeNull();
    expect(ok(await run(t, "searchPublicCollectibles", { query: "card", categoryIds: [packCatalogFixtureIds.category] })).items).toHaveLength(3);
    expect(ok(await run(t, "searchPublicCollectibles", { query: "card", categoryIds: ["50000000-0000-4000-8000-0000000000ff"] })).items).toEqual([]);
    expect(ok(await run(t, "searchPublicCollectibles", { query: "zzz" })).items).toEqual([]);
    expect(await run(t, "searchPublicCollectibles", { query: "" })).toMatchObject({ ok: false, code: "INVALID_QUERY" });
    void fixture;
  });
});

describe("Atomic store and six-journey catalog contract (lifecycle states and dormant candidates)", () => {
  beforeEach(configurePackCatalogAuthority);
  afterEach(() => vi.unstubAllEnvs());

  async function lifecycleVariant(fixture: Fixture, lifecycle: Fixture["lifecycleCases"][number], dataAsOf: string): Promise<SealedPack> {
    const payload = structuredClone(fixture.packs.packB.snapshot.payload);
    const actionable = lifecycle.availability === "available" && lifecycle.retirement === "active";
    payload.lifecycle = lifecycle;
    payload.dataAsOf = dataAsOf;
    payload.actions = payload.actions.map((action) => ({ ...action, enabled: actionable, disabledReason: actionable ? null : lifecycle.retirement === "retired" ? "PACK_RETIRED" as const : "PACK_UNAVAILABLE" as const }));
    payload.summaryProjection = publicPackSummaryCore(payload);
    const sealed = await sealFixturePack(payload);
    return { snapshot: sealed.snapshot, descriptor: sealed.descriptor, batches: sealed.batches };
  }

  test("every lifecycle state keeps full contents readable with actions disabled, and staged or blocked candidates never leak", async () => {
    const t = createTest();
    const fixture = await seed(t);
    const user = t.withIdentity(USER_A);
    expect(await user.mutation(api.packCatalogSavedItems.setSavedRepack, { publicRepackId: packCatalogFixtureIds.packB, saved: true })).toEqual({ saved: true, prunedUnavailable: false });
    let generation = 1;
    let active = fixture.packs.packB.snapshot.identity.publicPackSnapshotId;
    let sequence = 3;
    const states = fixture.lifecycleCases.filter((state) => !(state.availability === "sold_out" && state.retirement === "active"));
    for (const [index, state] of states.entries()) {
      const variant = await lifecycleVariant(fixture, state, `2026-09-03T19:${String(index).padStart(2, "0")}:00.000Z`);
      await stagePack(t, variant, String(sequence));
      const receipt = await activatePack(t, variant, { packPublicationSequence: String(sequence), expectedHead: { generation, publicationEpoch: 0, activeSnapshotId: active } });
      expect(receipt.result.outcome, JSON.stringify(receipt.result)).toBe("applied");
      generation += 1;
      sequence += 1;
      active = variant.snapshot.identity.publicPackSnapshotId;
      const detail = ok(await run(t, "getPublicPack", { publicRepackId: packCatalogFixtureIds.packB }));
      expect(detail.snapshot.publicPackSnapshotId).toBe(active);
      expect(detail.summary.lifecycle).toEqual(state);
      expect(detail.contents).toHaveLength(2);
      const actionable = state.availability === "available" && state.retirement === "active";
      expect(detail.detail.actions.every((action) => action.enabled === actionable)).toBe(true);
      const defaultList = ok(await run(t, "listPublicPacks", {}));
      expect(defaultList.items.some((item) => item.publicRepackId === packCatalogFixtureIds.packB)).toBe(actionable);
      const everything = ok(await run(t, "listPublicPacks", { lifecycle: ALL_STATES, pageSize: 50 }));
      expect(everything.items.find((item) => item.publicRepackId === packCatalogFixtureIds.packB)?.publicPackSnapshotId).toBe(active);
      expect(await user.mutation(api.packCatalogSavedItems.setSavedRepack, { publicRepackId: packCatalogFixtureIds.packB, saved: true })).toEqual({ saved: true, prunedUnavailable: false });
    }
    const staged = await lifecycleVariant(fixture, fixture.lifecycleCases[0]!, "2026-09-03T20:00:00.000Z");
    await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(staged, String(sequence)), packEntity(packCatalogFixtureIds.packB)));
    const blocked = await lifecycleVariant(fixture, fixture.lifecycleCases[1]!, "2026-09-03T20:01:00.000Z");
    await expectSignedReceipt(await postOperation(t, "start_pack_snapshot", startBody(blocked, String(sequence + 1)), packEntity(packCatalogFixtureIds.packB)));
    await expectSignedReceipt(await postOperation(t, "block_pack_snapshot", { publicRepackId: packCatalogFixtureIds.packB, publicPackSnapshotId: blocked.snapshot.identity.publicPackSnapshotId, reasonCode: "INVALID_DOMAIN_DATA" }, packEntity(packCatalogFixtureIds.packB)));
    const detail = ok(await run(t, "getPublicPack", { publicRepackId: packCatalogFixtureIds.packB }));
    expect(detail.snapshot.publicPackSnapshotId).toBe(active);
    const shell = ok(await run(t, "getPublicShellStatus", {}));
    expect(shell.catalogAvailable).toBe(true);
    const everything = ok(await run(t, "listPublicPacks", { lifecycle: ALL_STATES, pageSize: 50 }));
    expect(everything.items.map((item) => item.publicPackSnapshotId)).not.toContain(staged.snapshot.identity.publicPackSnapshotId);
    expect(everything.items.map((item) => item.publicPackSnapshotId)).not.toContain(blocked.snapshot.identity.publicPackSnapshotId);
    expect(everything.items.find((item) => item.publicRepackId === packCatalogFixtureIds.packA)?.publicPackSnapshotId).toBe(fixture.packs.packA.snapshot.identity.publicPackSnapshotId);
  });
});

describe("SavedCatalogItemsV1 against pack_catalog_v1 heads", () => {
  beforeEach(configurePackCatalogAuthority);
  afterEach(() => vi.unstubAllEnvs());

  test("saves resolve current heads, stay idempotent, survive updates, and remove without a head", async () => {
    const t = createTest();
    const fixture = await seed(t);
    const anonymous = savedCatalogItemsV1Contract.setSavedRepack.output.parse(await t.mutation(api.packCatalogSavedItems.setSavedRepack, { publicRepackId: packCatalogFixtureIds.packA, saved: true }));
    expect(anonymous).toMatchObject({ code: "AUTH_REQUIRED" });
    const user = t.withIdentity(USER_A);
    expect(await user.mutation(api.packCatalogSavedItems.setSavedRepack, { publicRepackId: "not-a-uuid", saved: true })).toMatchObject({ code: "INVALID_PUBLIC_REPACK_ID" });
    expect(await user.mutation(api.packCatalogSavedItems.setSavedRepack, { publicRepackId: "30000000-0000-4000-8000-0000000000ff", saved: true })).toMatchObject({ code: "SAVED_RESOURCE_UNAVAILABLE" });
    expect(await user.mutation(api.packCatalogSavedItems.setSavedRepack, { publicRepackId: packCatalogFixtureIds.packB, saved: true })).toEqual({ saved: true, prunedUnavailable: false });
    expect(await user.mutation(api.packCatalogSavedItems.setSavedRepack, { publicRepackId: packCatalogFixtureIds.packB, saved: true })).toEqual({ saved: true, prunedUnavailable: false });
    expect(await user.mutation(api.packCatalogSavedItems.setSavedCollectible, { publicCollectibleId: packCatalogFixtureIds.collectibleA, saved: true })).toEqual({ saved: true, prunedUnavailable: false });
    expect(await user.mutation(api.packCatalogSavedItems.setSavedCollectible, { publicCollectibleId: "40000000-0000-4000-8000-0000000000ff", saved: true })).toMatchObject({ code: "SAVED_RESOURCE_UNAVAILABLE" });
    const ids = savedCatalogItemsV1Contract.getSavedItemIds.output.parse(await user.query(api.packCatalogSavedItems.getSavedItemIds, {}));
    expect(ids).toEqual({ savedRepackIds: [packCatalogFixtureIds.packB], savedCollectibleIds: [packCatalogFixtureIds.collectibleA] });
    await updatePackA(t, fixture);
    expect(await user.mutation(api.packCatalogSavedItems.setSavedRepack, { publicRepackId: packCatalogFixtureIds.packA, saved: true })).toEqual({ saved: true, prunedUnavailable: false });
    expect(await user.query(api.packCatalogSavedItems.getSavedItemIds, {})).toMatchObject({ savedRepackIds: [packCatalogFixtureIds.packA, packCatalogFixtureIds.packB] });
    expect(await user.mutation(api.packCatalogSavedItems.setSavedRepack, { publicRepackId: packCatalogFixtureIds.packA, saved: false })).toEqual({ saved: false, prunedUnavailable: false });
    expect(await user.mutation(api.packCatalogSavedItems.setSavedRepack, { publicRepackId: "30000000-0000-4000-8000-0000000000ff", saved: false })).toEqual({ saved: false, prunedUnavailable: false });
    expect(await t.withIdentity({ ...USER_A, subject: "did:privy:user-b", tokenIdentifier: "privy.io|did:privy:user-b" }).query(api.packCatalogSavedItems.getSavedItemIds, {})).toEqual({ savedRepackIds: [], savedCollectibleIds: [] });
    const rows = await t.run(async (ctx) => (await ctx.db.query("savedRepacks").take(10)).map((row) => Object.keys(row).sort()));
    expect(rows).toEqual([["_creationTime", "_id", "ownerTokenIdentifier", "publicRepackId"]]);
  });

  test("at capacity only the oldest unreachable item of the same kind is pruned, otherwise the limit is refused without mutation", async () => {
    const t = createTest();
    await seed(t);
    const owner = USER_A.tokenIdentifier!;
    const unreachable = (index: number) => `80000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    await t.run(async (ctx) => {
      for (let index = 0; index < 249; index += 1) await ctx.db.insert("savedRepacks", { ownerTokenIdentifier: owner, publicRepackId: unreachable(index) });
      await ctx.db.insert("savedRepacks", { ownerTokenIdentifier: owner, publicRepackId: packCatalogFixtureIds.packA });
    });
    const user = t.withIdentity(USER_A);
    expect(await user.mutation(api.packCatalogSavedItems.setSavedRepack, { publicRepackId: packCatalogFixtureIds.packB, saved: true })).toEqual({ saved: true, prunedUnavailable: true });
    const remaining = await t.run(async (ctx) => (await ctx.db.query("savedRepacks").take(300)).map((row) => row.publicRepackId));
    expect(remaining).toHaveLength(250);
    expect(remaining).not.toContain(unreachable(0));
    expect(remaining).toContain(packCatalogFixtureIds.packB);
    await t.run(async (ctx) => {
      for (let index = 0; index < 250; index += 1) {
        const publicCollectibleId = `81000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
        await ctx.db.insert("activeCollectibleProfileHeads", {
          publicCollectibleId, generation: 1, activeProfileSnapshotId: `ppfs_${index.toString(16).padStart(64, "0")}`,
          previousProfileSnapshotId: null, contentSha256: index.toString(16).padStart(64, "0"), activatedAt: new Date(NOW).toISOString(),
          searchText: `synthetic ${index}`, sortDisplayName: `synthetic ${index}`, publicCategoryId: packCatalogFixtureIds.category,
        });
        await ctx.db.insert("savedCollectibles", { ownerTokenIdentifier: owner, publicCollectibleId });
      }
    });
    expect(await user.mutation(api.packCatalogSavedItems.setSavedCollectible, { publicCollectibleId: packCatalogFixtureIds.collectibleA, saved: true })).toMatchObject({ code: "SAVED_ITEM_LIMIT_REACHED" });
    expect(await t.run(async (ctx) => (await ctx.db.query("savedCollectibles").take(300)).length)).toBe(250);
    expect(await user.mutation(api.packCatalogSavedItems.setSavedCollectible, { publicCollectibleId: "81000000-0000-4000-8000-000000000000", saved: false })).toEqual({ saved: false, prunedUnavailable: false });
    expect(await user.mutation(api.packCatalogSavedItems.setSavedCollectible, { publicCollectibleId: packCatalogFixtureIds.collectibleA, saved: true })).toEqual({ saved: true, prunedUnavailable: false });
  });
});
