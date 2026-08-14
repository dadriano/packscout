import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  env,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import {
  DATA_RELEASE_BATCH_HASH_DOMAIN,
  canonicalJson,
  sha256CanonicalJson,
} from "./dataReleaseCanonicalHash";
import {
  MOCK_DATA_RELEASE_CONTENT_HASH,
  MOCK_DATA_RELEASE_FIXTURE_VERSION,
  MOCK_DATA_RELEASE_MANIFEST_FINGERPRINT,
  MOCK_DATA_RELEASE_ORIGIN_SET_HASH,
  MOCK_DATA_RELEASE_PUBLIC_CONFIG_HASH,
  MOCK_DATA_RELEASE_PUBLIC_ID,
  MOCK_DATA_RELEASE_SEED_IDEMPOTENCY_KEY,
  MOCK_DATA_RELEASE_SEED_OPERATION_ID,
  MOCK_REPACK_SEARCH_SHARD_HASH,
  MOCK_REPACK_SEARCH_INDEX_HASH,
  buildMockDataReleaseV2,
} from "./mockDataReleaseFixture";
import {
  buildMockRepackSearchRows,
  recomputeMockDataReleaseHashes,
} from "./mockDataReleaseSearch";
import type { RepackSearchRow } from "./publicRepackValidation";

const SEED_OPERATION_KIND = "mock_data_release_seed";
const MAX_SEEDED_RECORDS = 256;

type SeedResult = Readonly<{
  status: "created" | "unchanged";
  publicReleaseId: typeof MOCK_DATA_RELEASE_PUBLIC_ID;
  repackCount: 6;
}>;

function refuse(
  code:
    | "MOCK_SEED_DISABLED"
    | "MOCK_SEED_ENVIRONMENT_UNSAFE"
    | "MOCK_FIXTURE_INTEGRITY"
    | "CANONICAL_RELEASE_ACTIVE"
    | "MOCK_RELEASE_CONFLICT"
    | "MOCK_RELEASE_PARTIAL",
): never {
  throw new ConvexError({
    code,
    message: "The mock data release seed was refused without changing data.",
  });
}

function assertSeedEnvironment(): void {
  const configuredEnv = env as typeof env & {
    readonly PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED?: "1";
  };
  if (configuredEnv.PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED !== "1") {
    refuse("MOCK_SEED_DISABLED");
  }
  if (
    env.PACKSCOUT_RUNTIME_ENVIRONMENT !== "local" &&
    env.PACKSCOUT_RUNTIME_ENVIRONMENT !== "development" &&
    env.PACKSCOUT_RUNTIME_ENVIRONMENT !== "preproduction"
  ) {
    refuse("MOCK_SEED_ENVIRONMENT_UNSAFE");
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function assertFixtureIntegrity(
  fixture: ReturnType<typeof buildMockDataReleaseV2>,
  rows: readonly RepackSearchRow[],
): Promise<void> {
  const hashes = await recomputeMockDataReleaseHashes(fixture, rows);
  if (
    hashes.publicConfigHash !== MOCK_DATA_RELEASE_PUBLIC_CONFIG_HASH ||
    fixture.metadata.publicConfigHash !== MOCK_DATA_RELEASE_PUBLIC_CONFIG_HASH ||
    hashes.originSetHash !== MOCK_DATA_RELEASE_ORIGIN_SET_HASH ||
    fixture.metadata.originSetHash !== MOCK_DATA_RELEASE_ORIGIN_SET_HASH ||
    hashes.manifestFingerprint !== MOCK_DATA_RELEASE_MANIFEST_FINGERPRINT ||
    fixture.metadata.manifestFingerprint !==
      MOCK_DATA_RELEASE_MANIFEST_FINGERPRINT ||
    hashes.contentHash !== MOCK_DATA_RELEASE_CONTENT_HASH ||
    fixture.metadata.contentHash !== MOCK_DATA_RELEASE_CONTENT_HASH ||
    hashes.searchShardHash !== MOCK_REPACK_SEARCH_SHARD_HASH ||
    hashes.searchIndexHash !== MOCK_REPACK_SEARCH_INDEX_HASH ||
    fixture.metadata.repackSearchIndexHash !== MOCK_REPACK_SEARCH_INDEX_HASH
  ) {
    refuse("MOCK_FIXTURE_INTEGRITY");
  }
}

async function existingSeedIsComplete(
  ctx: MutationCtx,
  input: {
    state: Doc<"dataReleaseState">;
    release: Doc<"dataReleases">;
    operation: Doc<"dataReleaseOperations">;
    expectedRows: readonly RepackSearchRow[];
  },
): Promise<boolean> {
  const fixture = buildMockDataReleaseV2();
  if (
    input.state.activeReleaseId !== input.release._id ||
    input.state.previousReleaseId !== null ||
    input.state.latestObservationSequence !== 1 ||
    input.state.freshness !== "fresh" ||
    input.state.delayedVendorCount !== 0 ||
    input.release.lifecycle !== "complete" ||
    input.release.publicReleaseId !== MOCK_DATA_RELEASE_PUBLIC_ID ||
    input.release.searchShardCount !== 1 ||
    input.operation.operationId !== MOCK_DATA_RELEASE_SEED_OPERATION_ID ||
    input.operation.kind !== SEED_OPERATION_KIND ||
    input.operation.idempotencyKey !== MOCK_DATA_RELEASE_SEED_IDEMPOTENCY_KEY ||
    input.operation.bodyHash !== MOCK_DATA_RELEASE_CONTENT_HASH ||
    input.operation.publicReleaseId !== MOCK_DATA_RELEASE_PUBLIC_ID ||
    input.operation.observationSequence !== 1 ||
    input.operation.status !== "completed" ||
    input.operation.result !== "created" ||
    input.operation.convexReleaseVersion !== MOCK_DATA_RELEASE_FIXTURE_VERSION ||
    input.operation.confirmationReceiptHash !== null ||
    input.operation.completedAt === null
  ) {
    return false;
  }

  const [
    storedVendors,
    storedCategories,
    storedRepacks,
    storedCollectibles,
    storedChases,
    shards,
    batches,
  ] = await Promise.all([
    ctx.db
      .query("vendors")
      .withIndex("by_release_id_and_public_vendor_id", (index) =>
        index.eq("releaseId", input.release._id),
      )
      .take(MAX_SEEDED_RECORDS),
    ctx.db
      .query("categories")
      .withIndex("by_release_id_and_public_category_id", (index) =>
        index.eq("releaseId", input.release._id),
      )
      .take(MAX_SEEDED_RECORDS),
    ctx.db
      .query("repacks")
      .withIndex("by_release_id_and_public_repack_id", (index) =>
        index.eq("releaseId", input.release._id),
      )
      .take(MAX_SEEDED_RECORDS),
    ctx.db
      .query("collectibles")
      .withIndex("by_release_id_and_public_collectible_id", (index) =>
        index.eq("releaseId", input.release._id),
      )
      .take(MAX_SEEDED_RECORDS),
    ctx.db
      .query("repackChases")
      .withIndex("by_release_id_and_repack_id", (index) =>
        index.eq("releaseId", input.release._id),
      )
      .take(MAX_SEEDED_RECORDS),
    ctx.db
      .query("repackSearchShards")
      .withIndex("by_release_id_and_shard_number", (index) =>
        index.eq("releaseId", input.release._id),
      )
      .take(MAX_SEEDED_RECORDS),
    ctx.db
      .query("dataReleaseBatches")
      .withIndex("by_release_id_and_batch_index", (index) =>
        index.eq("releaseId", input.release._id),
      )
      .take(MAX_SEEDED_RECORDS),
  ]);
  return (
    storedVendors.length === fixture.vendors.length &&
    storedVendors.every((document, index) =>
      sameValue(document.detail, fixture.vendors[index]),
    ) &&
    storedCategories.length === fixture.categories.length &&
    storedCategories.every((document, index) =>
      sameValue(document.detail, fixture.categories[index]),
    ) &&
    storedRepacks.length === fixture.repacks.length &&
    storedRepacks.every((document, index) =>
      sameValue(document.detail, fixture.repacks[index]),
    ) &&
    storedCollectibles.length === fixture.collectibles.length &&
    storedCollectibles.every((document, index) =>
      sameValue(document.detail, fixture.collectibles[index]),
    ) &&
    storedChases.length === fixture.repackChases.length &&
    (() => {
      const expectedByIdentity = new Map(
        fixture.repackChases.map((chase) => [
          `${chase.publicRepackId}:${chase.publicCollectibleId}`,
          chase,
        ]),
      );
      return storedChases.every((document) => {
        const expected = expectedByIdentity.get(
          `${document.detail.publicRepackId}:${document.detail.publicCollectibleId}`,
        );
        return expected !== undefined && sameValue(document.detail, expected);
      });
    })() &&
    shards.length === 1 &&
    shards[0]!.shardNumber === 0 &&
    shards[0]!.contentHash === MOCK_REPACK_SEARCH_SHARD_HASH &&
    sameValue(shards[0]!.rows, input.expectedRows) &&
    batches.length === 6 &&
    (await Promise.all(
      ([
        ["vendors", fixture.vendors],
        ["categories", fixture.categories],
        ["repacks", fixture.repacks],
        ["collectibles", fixture.collectibles],
        ["repack_chases", fixture.repackChases],
        ["search_shards", input.expectedRows],
      ] as const).map(async ([kind, records], batchIndex) => {
        const body = canonicalJson(records);
        const batch = batches[batchIndex];
        return batch !== undefined &&
          batch.batchIndex === batchIndex &&
          batch.kind === kind &&
          batch.idempotencyKey ===
            `${MOCK_DATA_RELEASE_SEED_IDEMPOTENCY_KEY}:${kind}` &&
          batch.bodyHash ===
            await sha256CanonicalJson(DATA_RELEASE_BATCH_HASH_DOMAIN, {
              kind,
              records,
            }) &&
          batch.recordCount === records.length &&
          batch.byteCount === new TextEncoder().encode(body).byteLength;
      }),
    )).every(Boolean)
  );
}

function timeline(nowMilliseconds: number) {
  const now = new Date(nowMilliseconds).toISOString();
  return {
    now,
    staleAt: new Date(nowMilliseconds + 15 * 60 * 1_000).toISOString(),
  };
}

export const seed = internalMutation({
  args: {},
  returns: v.object({
    status: v.union(v.literal("created"), v.literal("unchanged")),
    publicReleaseId: v.literal(MOCK_DATA_RELEASE_PUBLIC_ID),
    repackCount: v.literal(6),
  }),
  handler: async (ctx): Promise<SeedResult> => {
    assertSeedEnvironment();
    const fixture = buildMockDataReleaseV2();
    const searchRows = buildMockRepackSearchRows(fixture);
    await assertFixtureIntegrity(fixture, searchRows);

    const states = await ctx.db
      .query("dataReleaseState")
      .withIndex("by_key", (index) => index.eq("key", "singleton"))
      .take(2);
    if (states.length > 1) refuse("MOCK_RELEASE_PARTIAL");
    const state = states[0] ?? null;
    if (state?.activeReleaseId !== null && state !== null) {
      const activeRelease = await ctx.db.get("dataReleases", state.activeReleaseId);
      if (activeRelease === null) refuse("MOCK_RELEASE_PARTIAL");
      if (activeRelease.metadata.dataSource === "canonical") {
        refuse("CANONICAL_RELEASE_ACTIVE");
      }
      if (activeRelease.publicReleaseId !== MOCK_DATA_RELEASE_PUBLIC_ID) {
        refuse("MOCK_RELEASE_CONFLICT");
      }
    }

    const releases = await ctx.db
      .query("dataReleases")
      .withIndex("by_public_release_id", (index) =>
        index.eq("publicReleaseId", MOCK_DATA_RELEASE_PUBLIC_ID),
      )
      .take(2);
    const operations = await ctx.db
      .query("dataReleaseOperations")
      .withIndex("by_kind_and_idempotency_key", (index) =>
        index
          .eq("kind", SEED_OPERATION_KIND)
          .eq("idempotencyKey", MOCK_DATA_RELEASE_SEED_IDEMPOTENCY_KEY),
      )
      .take(2);
    if (releases.length > 1 || operations.length > 1) {
      refuse("MOCK_RELEASE_PARTIAL");
    }
    if (releases.length === 1 || operations.length === 1 || state !== null) {
      if (
        releases.length !== 1 ||
        operations.length !== 1 ||
        state === null ||
        !(await existingSeedIsComplete(ctx, {
          state,
          release: releases[0]!,
          operation: operations[0]!,
          expectedRows: searchRows,
        }))
      ) {
        refuse("MOCK_RELEASE_PARTIAL");
      }
      const replayTimeline = timeline(Date.now());
      await ctx.db.patch("dataReleaseState", state._id, {
        dataAsOf: replayTimeline.now,
        lastSuccessfulObservationAt: replayTimeline.now,
        staleAt: replayTimeline.staleAt,
        freshness: "fresh",
        delayedVendorCount: 0,
        updatedAt: replayTimeline.now,
      });
      return {
        status: "unchanged",
        publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID,
        repackCount: 6,
      };
    }

    const { now, staleAt } = timeline(Date.now());
    const metadata = {
      ...fixture.metadata,
      dataAsOf: now,
      lastSuccessfulObservationAt: now,
      staleAt,
    };
    const releaseId = await ctx.db.insert("dataReleases", {
      publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID,
      lifecycle: "staging",
      metadata,
      searchShardCount: 1,
    });

    const vendorIdByPublicId = new Map<string, Id<"vendors">>();
    for (const detail of fixture.vendors) {
      const vendorId = await ctx.db.insert("vendors", {
        releaseId,
        publicVendorId: detail.publicVendorId,
        vendorKey: detail.vendorKey,
        detail,
      });
      vendorIdByPublicId.set(detail.publicVendorId, vendorId);
    }

    const categoryIdByPublicId = new Map<string, Id<"categories">>();
    for (const detail of fixture.categories) {
      const parentCategoryId =
        detail.parentPublicCategoryId === null
          ? null
          : categoryIdByPublicId.get(detail.parentPublicCategoryId);
      if (detail.parentPublicCategoryId !== null && parentCategoryId === undefined) {
        refuse("MOCK_FIXTURE_INTEGRITY");
      }
      const categoryId = await ctx.db.insert("categories", {
        releaseId,
        publicCategoryId: detail.publicCategoryId,
        categoryKey: detail.categoryKey,
        parentCategoryId: parentCategoryId ?? null,
        detail,
      });
      categoryIdByPublicId.set(detail.publicCategoryId, categoryId);
    }

    const collectibleIdByPublicId = new Map<string, Id<"collectibles">>();
    for (const detail of fixture.collectibles) {
      const collectibleId = await ctx.db.insert("collectibles", {
        releaseId,
        publicCollectibleId: detail.publicCollectibleId,
        collectibleType: detail.collectibleType,
        normalizedName: detail.normalizedName,
        searchText: detail.searchText,
        detail,
      });
      collectibleIdByPublicId.set(detail.publicCollectibleId, collectibleId);
    }

    const repackIdByPublicId = new Map<string, Id<"repacks">>();
    for (const detail of fixture.repacks) {
      const vendorId = vendorIdByPublicId.get(detail.publicVendorId);
      if (vendorId === undefined) refuse("MOCK_FIXTURE_INTEGRITY");
      const repackId = await ctx.db.insert("repacks", {
        releaseId,
        publicRepackId: detail.publicRepackId,
        vendorId,
        detail,
      });
      repackIdByPublicId.set(detail.publicRepackId, repackId);
    }

    for (const detail of fixture.repackChases) {
      const repackId = repackIdByPublicId.get(detail.publicRepackId);
      const collectibleId = collectibleIdByPublicId.get(
        detail.publicCollectibleId,
      );
      if (repackId === undefined || collectibleId === undefined) {
        refuse("MOCK_FIXTURE_INTEGRITY");
      }
      await ctx.db.insert("repackChases", {
        releaseId,
        repackId,
        collectibleId,
        detail,
      });
    }

    const encodedRows = new TextEncoder().encode(canonicalJson(searchRows));
    await ctx.db.insert("repackSearchShards", {
      releaseId,
      shardNumber: 0,
      rowCount: searchRows.length,
      byteCount: encodedRows.byteLength,
      contentHash: MOCK_REPACK_SEARCH_SHARD_HASH,
      rows: searchRows,
    });

    const batchInputs = [
      ["vendors", fixture.vendors],
      ["categories", fixture.categories],
      ["repacks", fixture.repacks],
      ["collectibles", fixture.collectibles],
      ["repack_chases", fixture.repackChases],
      ["search_shards", searchRows],
    ] as const;
    for (const [batchIndex, [kind, records]] of batchInputs.entries()) {
      const body = canonicalJson(records);
      const bodyHash = await sha256CanonicalJson(
        DATA_RELEASE_BATCH_HASH_DOMAIN,
        { kind, records },
      );
      await ctx.db.insert("dataReleaseBatches", {
        releaseId,
        batchIndex,
        kind,
        idempotencyKey: `${MOCK_DATA_RELEASE_SEED_IDEMPOTENCY_KEY}:${kind}`,
        bodyHash,
        recordCount: records.length,
        byteCount: new TextEncoder().encode(body).byteLength,
        acceptedAt: now,
      });
    }

    await ctx.db.patch("dataReleases", releaseId, { lifecycle: "complete" });
    await ctx.db.insert("dataReleaseOperations", {
      operationId: MOCK_DATA_RELEASE_SEED_OPERATION_ID,
      kind: SEED_OPERATION_KIND,
      idempotencyKey: MOCK_DATA_RELEASE_SEED_IDEMPOTENCY_KEY,
      bodyHash: MOCK_DATA_RELEASE_CONTENT_HASH,
      publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID,
      observationSequence: 1,
      status: "completed",
      result: "created",
      convexReleaseVersion: MOCK_DATA_RELEASE_FIXTURE_VERSION,
      confirmationReceiptHash: null,
      acceptedAt: now,
      completedAt: now,
    });
    await ctx.db.insert("dataReleaseState", {
      key: "singleton",
      activeReleaseId: releaseId,
      previousReleaseId: null,
      latestObservationSequence: 1,
      dataAsOf: now,
      lastSuccessfulObservationAt: now,
      staleAt,
      freshness: "fresh",
      delayedVendorCount: 0,
      updatedAt: now,
    });

    return {
      status: "created",
      publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID,
      repackCount: 6,
    };
  },
});
