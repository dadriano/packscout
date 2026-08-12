import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  env,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import {
  MOCK_CATALOG_MANIFEST_FINGERPRINT,
  MOCK_CATALOG_ORIGIN_SET_HASH,
  MOCK_CATALOG_PUBLIC_CONFIG_HASH,
  MOCK_CATALOG_CONTENT_HASH,
  MOCK_CATALOG_FIXTURE_VERSION,
  MOCK_CATALOG_PUBLICATION_ID,
  MOCK_CATALOG_QUERY_SHARD_HASH,
  MOCK_CATALOG_SEED_IDEMPOTENCY_KEY,
  MOCK_CATALOG_SEED_OPERATION_ID,
  MOCK_COLLECTOR_CONFIG_HASH,
  MOCK_COURTYARD_CONFIG_HASH,
  buildMockCatalogQueryRows,
  buildMockCatalogSnapshotV1,
  recomputeMockCatalogHashes,
} from "./mockCatalogFixture";
import { canonicalJson } from "./catalogCanonicalHash";
import type { CatalogQueryRow } from "./publicCatalogValidation";

const SEED_OPERATION_KIND = "mock_catalog_seed";

type SeedResult = Readonly<{
  status: "created" | "unchanged";
  publicationId: typeof MOCK_CATALOG_PUBLICATION_ID;
  packCount: 9;
}>;

function refuse(
  code:
    | "MOCK_SEED_DISABLED"
    | "MOCK_SEED_ENVIRONMENT_UNSAFE"
    | "MOCK_FIXTURE_INTEGRITY"
    | "CANONICAL_SNAPSHOT_ACTIVE"
    | "MOCK_SNAPSHOT_CONFLICT"
    | "MOCK_SNAPSHOT_PARTIAL",
): never {
  throw new ConvexError({
    code,
    message: "The mock catalog seed was refused without changing data.",
  });
}

function assertSeedEnvironment(): void {
  if (env.PACKSCOUT_MOCK_CATALOG_SEED_ENABLED !== "1") {
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
  fixture: ReturnType<typeof buildMockCatalogSnapshotV1>,
  rows: readonly CatalogQueryRow[],
): Promise<void> {
  const hashes = await recomputeMockCatalogHashes(fixture, rows);
  const platformHashes = [
    MOCK_COLLECTOR_CONFIG_HASH,
    MOCK_COURTYARD_CONFIG_HASH,
  ];
  if (
    !sameValue(hashes.platformConfigHashes, platformHashes) ||
    !sameValue(
      fixture.platformConfigs.map(({ contentHash }) => contentHash),
      platformHashes,
    ) ||
    hashes.publicConfigHash !== MOCK_CATALOG_PUBLIC_CONFIG_HASH ||
    fixture.metadata.publicConfigHash !== MOCK_CATALOG_PUBLIC_CONFIG_HASH ||
    hashes.originSetHash !== MOCK_CATALOG_ORIGIN_SET_HASH ||
    fixture.metadata.originSetHash !== MOCK_CATALOG_ORIGIN_SET_HASH ||
    hashes.manifestFingerprint !== MOCK_CATALOG_MANIFEST_FINGERPRINT ||
    fixture.metadata.manifestFingerprint !==
      MOCK_CATALOG_MANIFEST_FINGERPRINT ||
    hashes.contentHash !== MOCK_CATALOG_CONTENT_HASH ||
    fixture.metadata.contentHash !== MOCK_CATALOG_CONTENT_HASH ||
    hashes.queryShardHash !== MOCK_CATALOG_QUERY_SHARD_HASH
  ) {
    refuse("MOCK_FIXTURE_INTEGRITY");
  }
}

async function existingSeedIsComplete(
  ctx: MutationCtx,
  input: {
    readonly state: Doc<"catalogState">;
    readonly snapshot: Doc<"catalogSnapshots">;
    readonly operation: Doc<"publicationOperations">;
    readonly expectedRows: readonly CatalogQueryRow[];
  },
): Promise<boolean> {
  const fixture = buildMockCatalogSnapshotV1();
  const {
    createdAt,
    completedAt,
    dataAsOf,
    lastSuccessfulObservationAt,
    staleAt,
    ...storedStableMetadata
  } = input.snapshot.metadata;
  const {
    createdAt: _fixtureCreatedAt,
    completedAt: _fixtureCompletedAt,
    dataAsOf: _fixtureDataAsOf,
    lastSuccessfulObservationAt: _fixtureLastSuccessfulObservationAt,
    staleAt: _fixtureStaleAt,
    ...fixtureStableMetadata
  } = fixture.metadata;
  const storedObservationTime = Date.parse(lastSuccessfulObservationAt);
  const stateObservationTime = Date.parse(
    input.state.lastSuccessfulObservationAt,
  );
  if (
    input.state.activeSnapshotId !== input.snapshot._id ||
    input.state.previousSnapshotId !== null ||
    input.state.latestObservationSequence !== 1 ||
    input.state.freshness !== "fresh" ||
    input.state.delayedSourceCount !== 0 ||
    input.state.dataAsOf !== input.state.lastSuccessfulObservationAt ||
    input.state.updatedAt !== input.state.lastSuccessfulObservationAt ||
    !Number.isFinite(stateObservationTime) ||
    Date.parse(input.state.staleAt) - stateObservationTime !==
      15 * 60 * 1_000 ||
    input.snapshot.lifecycle !== "complete" ||
    input.snapshot.publicationId !== MOCK_CATALOG_PUBLICATION_ID ||
    !sameValue(storedStableMetadata, fixtureStableMetadata) ||
    createdAt !== completedAt ||
    dataAsOf !== completedAt ||
    lastSuccessfulObservationAt !== completedAt ||
    !Number.isFinite(storedObservationTime) ||
    Date.parse(staleAt) - storedObservationTime !== 15 * 60 * 1_000 ||
    input.snapshot.shardCount !== 1 ||
    !sameValue(input.snapshot.platformConfigs, fixture.platformConfigs) ||
    !sameValue(input.snapshot.facets, fixture.facets) ||
    input.operation.operationId !== MOCK_CATALOG_SEED_OPERATION_ID ||
    input.operation.kind !== SEED_OPERATION_KIND ||
    input.operation.idempotencyKey !== MOCK_CATALOG_SEED_IDEMPOTENCY_KEY ||
    input.operation.bodyHash !== MOCK_CATALOG_CONTENT_HASH ||
    input.operation.publicationId !== MOCK_CATALOG_PUBLICATION_ID ||
    input.operation.observationSequence !== 1 ||
    input.operation.status !== "completed" ||
    input.operation.result !== "created" ||
    input.operation.convexSnapshotVersion !== MOCK_CATALOG_FIXTURE_VERSION ||
    input.operation.confirmationReceiptHash !== null ||
    input.operation.acceptedAt !== completedAt ||
    input.operation.completedAt !== completedAt
  ) {
    return false;
  }

  const packs = await ctx.db
    .query("publicPacks")
    .withIndex("by_snapshot_id_and_public_pack_id", (index) =>
      index.eq("snapshotId", input.snapshot._id),
    )
    .take(10);
  const shards = await ctx.db
    .query("catalogQueryShards")
    .withIndex("by_snapshot_id_and_shard_number", (index) =>
      index.eq("snapshotId", input.snapshot._id),
    )
    .take(2);
  return (
    packs.length === 9 &&
    packs.every(
      (document, index) =>
        document.publicPackId === fixture.packs[index]?.publicPackId &&
        sameValue(document.detail, fixture.packs[index]),
    ) &&
    shards.length === 1 &&
    shards[0]!.shardNumber === 0 &&
    shards[0]!.rowCount === 9 &&
    shards[0]!.byteCount ===
      new TextEncoder().encode(canonicalJson(input.expectedRows)).byteLength &&
    shards[0]!.contentHash === MOCK_CATALOG_QUERY_SHARD_HASH &&
    sameValue(shards[0]!.rows, input.expectedRows)
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
    publicationId: v.literal(MOCK_CATALOG_PUBLICATION_ID),
    packCount: v.literal(9),
  }),
  handler: async (ctx): Promise<SeedResult> => {
    assertSeedEnvironment();
    const fixture = buildMockCatalogSnapshotV1();
    const rows = buildMockCatalogQueryRows(fixture);
    await assertFixtureIntegrity(fixture, rows);

    const states = await ctx.db
      .query("catalogState")
      .withIndex("by_key", (index) => index.eq("key", "singleton"))
      .take(2);
    if (states.length > 1) refuse("MOCK_SNAPSHOT_PARTIAL");
    const state = states[0] ?? null;
    if (state?.activeSnapshotId !== null && state !== null) {
      const activeSnapshot = await ctx.db.get(
        "catalogSnapshots",
        state.activeSnapshotId,
      );
      if (activeSnapshot === null) refuse("MOCK_SNAPSHOT_PARTIAL");
      if (activeSnapshot.metadata.dataSource === "canonical") {
        refuse("CANONICAL_SNAPSHOT_ACTIVE");
      }
      if (activeSnapshot.publicationId !== MOCK_CATALOG_PUBLICATION_ID) {
        refuse("MOCK_SNAPSHOT_CONFLICT");
      }
    }

    const snapshots = await ctx.db
      .query("catalogSnapshots")
      .withIndex("by_publication_id", (index) =>
        index.eq("publicationId", MOCK_CATALOG_PUBLICATION_ID),
      )
      .take(2);
    const operations = await ctx.db
      .query("publicationOperations")
      .withIndex("by_kind_and_idempotency_key", (index) =>
        index
          .eq("kind", SEED_OPERATION_KIND)
          .eq("idempotencyKey", MOCK_CATALOG_SEED_IDEMPOTENCY_KEY),
      )
      .take(2);
    if (snapshots.length > 1 || operations.length > 1) {
      refuse("MOCK_SNAPSHOT_CONFLICT");
    }

    const existingSnapshot = snapshots[0] ?? null;
    const existingOperation = operations[0] ?? null;
    if (
      existingSnapshot !== null &&
      existingSnapshot.metadata.contentHash !== MOCK_CATALOG_CONTENT_HASH
    ) {
      refuse("MOCK_SNAPSHOT_CONFLICT");
    }
    if (
      existingOperation !== null &&
      existingOperation.bodyHash !== MOCK_CATALOG_CONTENT_HASH
    ) {
      refuse("MOCK_SNAPSHOT_CONFLICT");
    }
    if (state !== null || existingSnapshot !== null || existingOperation !== null) {
      if (
        state !== null &&
        existingSnapshot !== null &&
        existingOperation !== null &&
        (await existingSeedIsComplete(ctx, {
          state,
          snapshot: existingSnapshot,
          operation: existingOperation,
          expectedRows: rows,
        }))
      ) {
        const observationTimeline = timeline(Date.now());
        await ctx.db.patch("catalogState", state._id, {
          dataAsOf: observationTimeline.now,
          lastSuccessfulObservationAt: observationTimeline.now,
          staleAt: observationTimeline.staleAt,
          updatedAt: observationTimeline.now,
        });
        return {
          status: "unchanged",
          publicationId: MOCK_CATALOG_PUBLICATION_ID,
          packCount: 9,
        };
      }
      refuse("MOCK_SNAPSHOT_PARTIAL");
    }

    const seedTimeline = timeline(Date.now());
    const metadata = {
      ...fixture.metadata,
      createdAt: seedTimeline.now,
      completedAt: seedTimeline.now,
      dataAsOf: seedTimeline.now,
      lastSuccessfulObservationAt: seedTimeline.now,
      staleAt: seedTimeline.staleAt,
    };
    const snapshotId: Id<"catalogSnapshots"> = await ctx.db.insert(
      "catalogSnapshots",
      {
        publicationId: MOCK_CATALOG_PUBLICATION_ID,
        lifecycle: "complete",
        metadata,
        platformConfigs: fixture.platformConfigs,
        facets: fixture.facets,
        shardCount: 1,
      },
    );
    for (const pack of fixture.packs) {
      await ctx.db.insert("publicPacks", {
        snapshotId,
        publicPackId: pack.publicPackId,
        detail: pack,
      });
    }
    await ctx.db.insert("catalogQueryShards", {
      snapshotId,
      shardNumber: 0,
      rowCount: rows.length,
      byteCount: new TextEncoder().encode(canonicalJson(rows)).byteLength,
      contentHash: MOCK_CATALOG_QUERY_SHARD_HASH,
      rows,
    });
    await ctx.db.insert("catalogState", {
      key: "singleton",
      activeSnapshotId: snapshotId,
      previousSnapshotId: null,
      latestObservationSequence: 1,
      dataAsOf: seedTimeline.now,
      lastSuccessfulObservationAt: seedTimeline.now,
      staleAt: seedTimeline.staleAt,
      freshness: "fresh",
      delayedSourceCount: 0,
      updatedAt: seedTimeline.now,
    });
    await ctx.db.insert("publicationOperations", {
      operationId: MOCK_CATALOG_SEED_OPERATION_ID,
      kind: SEED_OPERATION_KIND,
      idempotencyKey: MOCK_CATALOG_SEED_IDEMPOTENCY_KEY,
      bodyHash: MOCK_CATALOG_CONTENT_HASH,
      publicationId: MOCK_CATALOG_PUBLICATION_ID,
      observationSequence: 1,
      status: "completed",
      result: "created",
      convexSnapshotVersion: MOCK_CATALOG_FIXTURE_VERSION,
      confirmationReceiptHash: null,
      acceptedAt: seedTimeline.now,
      completedAt: seedTimeline.now,
    });
    return {
      status: "created",
      publicationId: MOCK_CATALOG_PUBLICATION_ID,
      packCount: 9,
    };
  },
});
