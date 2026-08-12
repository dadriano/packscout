/// <reference types="vite/client" />

import {
  getDashboardBundleResultSchema,
  getPublicPackResultSchema,
  getPublicShellStatusResultSchema,
  listPublicPacksResultSchema,
} from "@packscout/contracts";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { canonicalJson, sha256CanonicalJson } from "./catalogCanonicalHash";
import {
  MOCK_CATALOG_MANIFEST_FINGERPRINT,
  MOCK_CATALOG_ORIGIN_SET_HASH,
  MOCK_CATALOG_PUBLIC_CONFIG_HASH,
  MOCK_CATALOG_CONTENT_HASH,
  MOCK_CATALOG_PUBLICATION_ID,
  MOCK_CATALOG_QUERY_SHARD_HASH,
  MOCK_COLLECTOR_CONFIG_HASH,
  MOCK_COURTYARD_CONFIG_HASH,
  buildMockCatalogQueryRows,
  buildMockCatalogSnapshotV1,
  recomputeMockCatalogHashes,
} from "./mockCatalogFixture";

const modules = import.meta.glob("./**/*.ts");
type CatalogTest = TestConvex<typeof schema>;

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function enableSeed(environment = "local") {
  vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", environment);
  vi.stubEnv("PACKSCOUT_MOCK_CATALOG_SEED_ENABLED", "1");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

async function databaseCounts(t: CatalogTest) {
  return await t.run(async (ctx) => ({
    states: (await ctx.db.query("catalogState").take(3)).length,
    snapshots: (await ctx.db.query("catalogSnapshots").take(3)).length,
    packs: (await ctx.db.query("publicPacks").take(10)).length,
    shards: (await ctx.db.query("catalogQueryShards").take(3)).length,
    operations: (await ctx.db.query("publicationOperations").take(3)).length,
  }));
}

async function insertActiveSnapshot(
  t: CatalogTest,
  dataSource: "canonical" | "mock",
  publicationId: string,
) {
  const fixture = buildMockCatalogSnapshotV1();
  await t.run(async (ctx) => {
    const snapshotId = await ctx.db.insert("catalogSnapshots", {
      publicationId,
      lifecycle: "complete",
      metadata: {
        ...fixture.metadata,
        dataSource,
        publicationId,
      },
      platformConfigs: fixture.platformConfigs,
      facets: fixture.facets,
      shardCount: 1,
    });
    await ctx.db.insert("catalogState", {
      key: "singleton",
      activeSnapshotId: snapshotId,
      previousSnapshotId: null,
      latestObservationSequence: 1,
      dataAsOf: fixture.metadata.dataAsOf,
      lastSuccessfulObservationAt: fixture.metadata.lastSuccessfulObservationAt,
      staleAt: fixture.metadata.staleAt,
      freshness: fixture.metadata.freshness,
      delayedSourceCount: 0,
      updatedAt: fixture.metadata.completedAt,
    });
  });
}

describe("mock catalog fixture", () => {
  test("is deterministic, contract-valid, and contains exactly nine packs", () => {
    const first = buildMockCatalogSnapshotV1();
    const second = buildMockCatalogSnapshotV1();
    expect(first).toEqual(second);
    expect(first.metadata).toMatchObject({
      dataSource: "mock",
      publicationId: MOCK_CATALOG_PUBLICATION_ID,
      contentHash: MOCK_CATALOG_CONTENT_HASH,
      packCount: 9,
    });
    expect(first.packs).toHaveLength(9);
    expect(first.packs.map((pack) => pack.name)).toContain(
      "Mythic Pokemon Gacha",
    );
  });

  test("canonical JSON is key-order stable and the hash is domain separated", async () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
    expect(canonicalJson({ a: { x: 3, y: 2 }, z: 1 })).toBe(
      canonicalJson({ z: 1, a: { y: 2, x: 3 } }),
    );
    await expect(
      sha256CanonicalJson("packscout.mock.test.v1", { value: 1 }),
    ).resolves.not.toBe(
      await sha256CanonicalJson("packscout.mock.test.v2", { value: 1 }),
    );
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(
      /non-finite/u,
    );
  });

  test("every persisted fixture hash recomputes from its governed value", async () => {
    const fixture = buildMockCatalogSnapshotV1();
    const rows = buildMockCatalogQueryRows(fixture);
    const hashes = await recomputeMockCatalogHashes(fixture, rows);

    expect(hashes.platformConfigHashes).toEqual([
      MOCK_COLLECTOR_CONFIG_HASH,
      MOCK_COURTYARD_CONFIG_HASH,
    ]);
    expect(fixture.platformConfigs.map(({ contentHash }) => contentHash)).toEqual(
      hashes.platformConfigHashes,
    );
    expect(hashes.publicConfigHash).toBe(MOCK_CATALOG_PUBLIC_CONFIG_HASH);
    expect(fixture.metadata.publicConfigHash).toBe(hashes.publicConfigHash);
    expect(hashes.originSetHash).toBe(MOCK_CATALOG_ORIGIN_SET_HASH);
    expect(fixture.metadata.originSetHash).toBe(hashes.originSetHash);
    expect(hashes.manifestFingerprint).toBe(
      MOCK_CATALOG_MANIFEST_FINGERPRINT,
    );
    expect(fixture.metadata.manifestFingerprint).toBe(
      hashes.manifestFingerprint,
    );
    expect(hashes.contentHash).toBe(MOCK_CATALOG_CONTENT_HASH);
    expect(fixture.metadata.contentHash).toBe(hashes.contentHash);
    expect(hashes.queryShardHash).toBe(MOCK_CATALOG_QUERY_SHARD_HASH);
  });
});

describe("internal mock catalog seed", () => {
  test("refuses a disabled or production seed before any writes", async () => {
    const disabled = createTest();
    vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
    await expect(
      disabled.mutation(internal.mockCatalogSeed.seed, {}),
    ).rejects.toThrow(/MOCK_SEED_DISABLED/u);
    expect(await databaseCounts(disabled)).toEqual({
      states: 0,
      snapshots: 0,
      packs: 0,
      shards: 0,
      operations: 0,
    });

    const production = createTest();
    enableSeed("production");
    await expect(
      production.mutation(internal.mockCatalogSeed.seed, {}),
    ).rejects.toThrow(/MOCK_SEED_ENVIRONMENT_UNSAFE/u);
    expect(await databaseCounts(production)).toEqual({
      states: 0,
      snapshots: 0,
      packs: 0,
      shards: 0,
      operations: 0,
    });
  });

  test("creates once, records the operation, and replays unchanged", async () => {
    enableSeed();
    const t = createTest();
    const startedAt = Date.now();
    const created = await t.mutation(internal.mockCatalogSeed.seed, {});
    const completedAt = Date.now();
    expect(created).toEqual({
      status: "created",
      publicationId: MOCK_CATALOG_PUBLICATION_ID,
      packCount: 9,
    });
    expect(await databaseCounts(t)).toEqual({
      states: 1,
      snapshots: 1,
      packs: 9,
      shards: 1,
      operations: 1,
    });

    const stored = await t.run(async (ctx) => {
      const state = await ctx.db.query("catalogState").take(1);
      const snapshot = await ctx.db.query("catalogSnapshots").take(1);
      const packs = await ctx.db.query("publicPacks").take(10);
      const shards = await ctx.db.query("catalogQueryShards").take(1);
      const operation = await ctx.db.query("publicationOperations").take(1);
      return {
        state: state[0]!,
        snapshot: snapshot[0]!,
        packIds: packs.map(({ _id }) => _id).sort(),
        shardIds: shards.map(({ _id }) => _id).sort(),
        operation: operation[0]!,
      };
    });
    const observationTime = Date.parse(
      stored.snapshot.metadata.lastSuccessfulObservationAt,
    );
    expect(observationTime).toBeGreaterThanOrEqual(startedAt);
    expect(observationTime).toBeLessThanOrEqual(completedAt);
    expect(Date.parse(stored.snapshot.metadata.staleAt) - observationTime).toBe(
      15 * 60 * 1_000,
    );
    expect(stored.operation).toMatchObject({
      kind: "mock_catalog_seed",
      bodyHash: MOCK_CATALOG_CONTENT_HASH,
      status: "completed",
      result: "created",
    });

    const oldObservation = "2026-01-01T00:00:00.000Z";
    await t.run(async (ctx) => {
      await ctx.db.patch("catalogState", stored.state._id, {
        dataAsOf: oldObservation,
        lastSuccessfulObservationAt: oldObservation,
        staleAt: "2026-01-01T00:15:00.000Z",
        updatedAt: oldObservation,
      });
    });
    const unchanged = await t.mutation(internal.mockCatalogSeed.seed, {});
    expect(unchanged.status).toBe("unchanged");
    expect(await databaseCounts(t)).toEqual({
      states: 1,
      snapshots: 1,
      packs: 9,
      shards: 1,
      operations: 1,
    });
    const replayed = await t.run(async (ctx) => {
      const state = await ctx.db.query("catalogState").take(1);
      const snapshot = await ctx.db.query("catalogSnapshots").take(1);
      const packs = await ctx.db.query("publicPacks").take(10);
      const shards = await ctx.db.query("catalogQueryShards").take(1);
      const operation = await ctx.db.query("publicationOperations").take(1);
      return {
        state: state[0]!,
        snapshot: snapshot[0]!,
        packIds: packs.map(({ _id }) => _id).sort(),
        shardIds: shards.map(({ _id }) => _id).sort(),
        operation: operation[0]!,
      };
    });
    expect(replayed.state._id).toBe(stored.state._id);
    expect(replayed.state.activeSnapshotId).toBe(stored.state.activeSnapshotId);
    expect(replayed.state.previousSnapshotId).toBe(
      stored.state.previousSnapshotId,
    );
    expect(replayed.state.latestObservationSequence).toBe(
      stored.state.latestObservationSequence,
    );
    expect(Date.parse(replayed.state.lastSuccessfulObservationAt)).toBeGreaterThan(
      Date.parse(oldObservation),
    );
    expect(
      Date.parse(replayed.state.staleAt) -
        Date.parse(replayed.state.lastSuccessfulObservationAt),
    ).toBe(15 * 60 * 1_000);
    expect(replayed.snapshot).toEqual(stored.snapshot);
    expect(replayed.packIds).toEqual(stored.packIds);
    expect(replayed.shardIds).toEqual(stored.shardIds);
    expect(replayed.operation).toEqual(stored.operation);
  });

  test("serves exact public queries from the seeded data with bounded details", async () => {
    enableSeed();
    const t = createTest();
    await t.mutation(internal.mockCatalogSeed.seed, {});

    const shell = getPublicShellStatusResultSchema.parse(
      await t.query(api.publicCatalog.getPublicShellStatus, {}),
    );
    expect(shell.ok).toBe(true);
    if (shell.ok) expect(shell.data.metadata.dataSource).toBe("mock");

    const dashboard = getDashboardBundleResultSchema.parse(
      await t.query(api.publicCatalog.getDashboardBundle, {}),
    );
    expect(dashboard.ok).toBe(true);
    if (dashboard.ok) {
      expect(dashboard.data.kpis).toMatchObject({
        totalPacks: 8,
        positiveEvPacks: 7,
      });
      expect(dashboard.data.opportunities).toHaveLength(6);
      expect(dashboard.data.details.map((pack) => pack.publicPackId)).toEqual(
        dashboard.data.opportunities.map((pack) => pack.publicPackId),
      );
    }

    const list = listPublicPacksResultSchema.parse(
      await t.query(api.publicCatalog.listPublicPacks, { pageSize: 50 }),
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.range.total).toBe(9);
    expect(list.data.rows).toHaveLength(9);
    expect(list.data.details.map((pack) => pack.publicPackId)).toEqual(
      list.data.rows.map((pack) => pack.publicPackId),
    );

    const last = list.data.details.at(-1)!;
    const detail = getPublicPackResultSchema.parse(
      await t.query(api.publicCatalog.getPublicPack, {
        publicPackId: last.publicPackId,
        snapshotPublicationId: MOCK_CATALOG_PUBLICATION_ID,
      }),
    );
    expect(detail).toEqual({ ok: true, data: last });
  });

  test("refuses canonical active, conflicting, and partial catalog state", async () => {
    enableSeed();
    const canonical = createTest();
    await insertActiveSnapshot(
      canonical,
      "canonical",
      "80000000-0000-4000-8000-000000000001",
    );
    await expect(
      canonical.mutation(internal.mockCatalogSeed.seed, {}),
    ).rejects.toThrow(/CANONICAL_SNAPSHOT_ACTIVE/u);

    const conflict = createTest();
    const fixture = buildMockCatalogSnapshotV1();
    await conflict.run(async (ctx) => {
      await ctx.db.insert("catalogSnapshots", {
        publicationId: MOCK_CATALOG_PUBLICATION_ID,
        lifecycle: "complete",
        metadata: { ...fixture.metadata, contentHash: "f".repeat(64) },
        platformConfigs: fixture.platformConfigs,
        facets: fixture.facets,
        shardCount: 1,
      });
    });
    await expect(
      conflict.mutation(internal.mockCatalogSeed.seed, {}),
    ).rejects.toThrow(/MOCK_SNAPSHOT_CONFLICT/u);

    const partial = createTest();
    await partial.run(async (ctx) => {
      await ctx.db.insert("catalogSnapshots", {
        publicationId: MOCK_CATALOG_PUBLICATION_ID,
        lifecycle: "complete",
        metadata: fixture.metadata,
        platformConfigs: fixture.platformConfigs,
        facets: fixture.facets,
        shardCount: 1,
      });
    });
    await expect(
      partial.mutation(internal.mockCatalogSeed.seed, {}),
    ).rejects.toThrow(/MOCK_SNAPSHOT_PARTIAL/u);

    const tampered = createTest();
    await tampered.mutation(internal.mockCatalogSeed.seed, {});
    await tampered.run(async (ctx) => {
      const snapshots = await ctx.db.query("catalogSnapshots").take(1);
      const snapshot = snapshots[0]!;
      await ctx.db.patch("catalogSnapshots", snapshot._id, {
        metadata: {
          ...snapshot.metadata,
          publicConfigHash: "f".repeat(64),
        },
      });
    });
    await expect(
      tampered.mutation(internal.mockCatalogSeed.seed, {}),
    ).rejects.toThrow(/MOCK_SNAPSHOT_PARTIAL/u);
  });

  test("fails public reads closed when mock data is active in production", async () => {
    enableSeed();
    const t = createTest();
    await t.mutation(internal.mockCatalogSeed.seed, {});
    vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "production");
    const result = getPublicShellStatusResultSchema.parse(
      await t.query(api.publicCatalog.getPublicShellStatus, {}),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "SNAPSHOT_UNAVAILABLE",
    });
  });
});
