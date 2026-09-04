/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  buildV3Chase,
  buildV3Collectible,
  buildV3Detail,
  buildV3FixturePlan,
  buildV3SoldOutDetail,
  buildV3UnavailableEv,
  v3ActivateRequest,
  v3BatchRequest,
  v3Body,
  v3FinalizeRequest,
  v3StartRequest,
  V3_COLLECTIBLE_ID,
  V3_FIXTURE_NOW,
  V3_REPACK_ID_A,
  V3_REPACK_ID_B,
} from "./dataReleaseV3Fixture.test-support";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";
import { MAX_DESIRED_CHASES_PER_COLLECTIBLE } from "./publicRepacksV3";
import {
  activateRetentionRelease,
  stageRetentionRelease,
  unavailableRetentionDetail,
} from "./dataReleaseV3Retention.test-support";
import { MAX_DATA_RELEASE_V3_REPACKS } from "./dataReleaseV3Search";
import {
  MAX_SAVED_ITEMS_PER_KIND,
  WATCHLIST_CHASE_VALIDATION_BATCH,
  WATCHLIST_REPACK_PROOF_BATCH,
} from "./savedItems";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type WatchlistTest = TestConvex<typeof schema>;
type TestIdentity = Readonly<{
  subject: string;
  issuer: string;
  tokenIdentifier: string;
}>;

const USER_A: TestIdentity = {
  subject: "did:privy:user-a",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:user-a",
};
const USER_B: TestIdentity = {
  subject: "did:privy:user-b",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:user-b",
};

const MISSING_REPACK_ID = "40000000-0000-5000-8000-000000000999";
const EXTRA_REPACK_ID = "40000000-0000-5000-8000-000000000888";
const MISSING_COLLECTIBLE_ID = "30000000-0000-5000-8000-000000000999";
const V3_PUBLIC_RELEASE_ID = "20000000-0000-4000-8000-000000000001";
const CLOCK_BASE = V3_FIXTURE_NOW;

const availableRepack = buildV3Detail();
const soldOutRepack = buildV3SoldOutDetail({
  publicRepackId: V3_REPACK_ID_B,
  topChase: buildV3Chase(V3_REPACK_ID_B),
});
const firstCollectible = buildV3Collectible();
const legacyFixture = buildMockDataReleaseV2();
const legacyOnlyRepack = legacyFixture.repacks[0]!;

function createTest() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(CLOCK_BASE));
  return convexTest({ schema, modules, transactionLimits: true });
}

async function seedLegacy(t: WatchlistTest): Promise<void> {
  vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
  vi.stubEnv("PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED", "1");
  await t.mutation(internal.mockDataReleaseSeed.seed, {});
}

async function seedV3(t: WatchlistTest): Promise<void> {
  const plan = await buildV3FixturePlan({
    publicReleaseId: V3_PUBLIC_RELEASE_ID,
    details: [availableRepack, soldOutRepack],
    collectibles: [firstCollectible],
  });
  await t.mutation(
    internal.dataReleaseV3Lifecycle.start,
    await v3Body(v3StartRequest(plan)),
  );
  for (const batch of plan.batches) {
    await t.mutation(
      internal.dataReleaseV3Lifecycle.applyBatch,
      await v3Body(v3BatchRequest(plan, batch)),
    );
  }
  await t.mutation(
    internal.dataReleaseV3Lifecycle.finalize,
    await v3Body(v3FinalizeRequest(plan)),
  );
  await t.mutation(
    internal.dataReleaseV3Lifecycle.activate,
    await v3Body(v3ActivateRequest(plan, null)),
  );
}

async function seed(t: WatchlistTest): Promise<void> {
  await seedV3(t);
}

function savedAt(second: number): string {
  return new Date(CLOCK_BASE + second * 1_000).toISOString();
}

function createSaver(t: WatchlistTest) {
  let second = 0;
  function advanceClock(): void {
    second += 1;
    vi.setSystemTime(new Date(CLOCK_BASE + second * 1_000));
  }
  return {
    async repacks(
      ownerTokenIdentifier: string,
      publicRepackIds: readonly string[],
    ): Promise<void> {
      for (const publicRepackId of publicRepackIds) {
        advanceClock();
        await t.run(async (ctx) => {
          await ctx.db.insert("savedRepacks", {
            ownerTokenIdentifier,
            publicRepackId,
          });
        });
      }
    },
    async collectibles(
      ownerTokenIdentifier: string,
      publicCollectibleIds: readonly string[],
    ): Promise<void> {
      for (const publicCollectibleId of publicCollectibleIds) {
        advanceClock();
        await t.run(async (ctx) => {
          await ctx.db.insert("savedCollectibles", {
            ownerTokenIdentifier,
            publicCollectibleId,
          });
        });
      }
    },
  };
}

async function expectErrorCode(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toMatchObject({ data: { code } });
  }
}

function boundedPublicId(index: number): string {
  return `41000000-0000-5000-8000-${String(index).padStart(12, "0")}`;
}

function watchlistEstimatedEv(
  packScout: typeof availableRepack.evEstimates.packScout,
) {
  if (packScout.metrics === null || packScout.confidence === null) {
    throw new Error("Expected a presentable PackScout estimate.");
  }
  return {
    evDollarsMinorUnits: packScout.metrics.evDollars.minorUnits,
    grossReturnBasisPoints: packScout.metrics.grossReturnBasisPoints,
    confidenceBand: packScout.confidence.band,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("owner watchlist read", () => {
  test("proves only chased packs in small document pages", () => {
    expect(WATCHLIST_CHASE_VALIDATION_BATCH).toBeGreaterThan(1);
    expect(WATCHLIST_REPACK_PROOF_BATCH).toBeGreaterThan(0);
    expect(WATCHLIST_REPACK_PROOF_BATCH).toBeLessThan(
      MAX_DATA_RELEASE_V3_REPACKS,
    );
  });

  test("refuses unauthenticated and invalid-identity callers without a payload", async () => {
    const t = createTest();
    await seed(t);

    await expectErrorCode(
      t.action(api.savedItems.getOwnerWatchlist, {}),
      "AUTH_REQUIRED",
    );
    await expectErrorCode(
      t
        .withIdentity({
          subject: "",
          issuer: "privy.io",
          tokenIdentifier: "",
        })
        .action(api.savedItems.getOwnerWatchlist, {}),
      "AUTH_IDENTITY_INVALID",
    );
  });

  test("returns empty collections and zero counts when the owner has saved nothing", async () => {
    const t = createTest();
    await seed(t);
    await expect(
      t.withIdentity(USER_A).action(api.savedItems.getOwnerWatchlist, {}),
    ).resolves.toEqual({
      savedRepacks: [],
      savedCollectibles: [],
      savedRepackCount: 0,
      savedCollectibleCount: 0,
    });
  });

  test("returns both collections newest first with counts that match rows", async () => {
    const t = createTest();
    await seed(t);
    const saver = createSaver(t);
    await saver.repacks(USER_A.tokenIdentifier, [
      availableRepack.publicRepackId,
      soldOutRepack.publicRepackId,
    ]);
    await saver.collectibles(USER_A.tokenIdentifier, [
      firstCollectible.publicCollectibleId,
    ]);

    const watchlist = await t
      .withIdentity(USER_A)
      .action(api.savedItems.getOwnerWatchlist, {});

    expect(watchlist.savedRepackCount).toBe(watchlist.savedRepacks.length);
    expect(watchlist.savedCollectibleCount).toBe(
      watchlist.savedCollectibles.length,
    );
    expect(watchlist.savedRepacks).toEqual([
      {
        publicRepackId: soldOutRepack.publicRepackId,
        savedAt: savedAt(2),
        catalogStatus: "resolved",
        openable: true,
        repack: {
          name: soldOutRepack.name,
          vendorDisplayName: soldOutRepack.vendorDisplayName,
          availability: "sold_out",
          estimatedEv: watchlistEstimatedEv(soldOutRepack.evEstimates.packScout),
        },
      },
      {
        publicRepackId: availableRepack.publicRepackId,
        savedAt: savedAt(1),
        catalogStatus: "resolved",
        openable: true,
        repack: {
          name: availableRepack.name,
          vendorDisplayName: availableRepack.vendorDisplayName,
          availability: "available",
          estimatedEv: watchlistEstimatedEv(
            availableRepack.evEstimates.packScout,
          ),
        },
      },
    ]);
    expect(watchlist.savedCollectibles).toEqual([
      {
        publicCollectibleId: firstCollectible.publicCollectibleId,
        savedAt: savedAt(3),
        catalogStatus: "resolved",
        openable: true,
        collectible: {
          name: firstCollectible.name,
          collectibleType: firstCollectible.collectibleType,
          year: firstCollectible.year,
          brand: firstCollectible.brand,
          setOrSeries: firstCollectible.setOrSeries,
          cardNumber: firstCollectible.cardNumber,
          referenceNumber: firstCollectible.referenceNumber,
          grade: firstCollectible.grade,
          grader: firstCollectible.grader,
        },
      },
    ]);
  });

  test("keeps unavailable catalog rows, marks them not openable, and counts them", async () => {
    const t = createTest();
    await seed(t);
    const saver = createSaver(t);
    await saver.repacks(USER_A.tokenIdentifier, [
      availableRepack.publicRepackId,
      MISSING_REPACK_ID,
    ]);
    await saver.collectibles(USER_A.tokenIdentifier, [MISSING_COLLECTIBLE_ID]);

    const watchlist = await t
      .withIdentity(USER_A)
      .action(api.savedItems.getOwnerWatchlist, {});
    expect(watchlist.savedRepackCount).toBe(2);
    expect(watchlist.savedCollectibleCount).toBe(1);
    expect(watchlist.savedRepacks[0]).toEqual({
      publicRepackId: MISSING_REPACK_ID,
      savedAt: savedAt(2),
      catalogStatus: "unavailable",
      openable: false,
      repack: null,
    });
    expect(watchlist.savedCollectibles[0]).toEqual({
      publicCollectibleId: MISSING_COLLECTIBLE_ID,
      savedAt: savedAt(3),
      catalogStatus: "unavailable",
      openable: false,
      collectible: null,
    });
  });

  test("does not return another owner's saved rows", async () => {
    const t = createTest();
    await seed(t);
    const saver = createSaver(t);
    await saver.repacks(USER_A.tokenIdentifier, [
      availableRepack.publicRepackId,
    ]);
    await saver.collectibles(USER_B.tokenIdentifier, [
      firstCollectible.publicCollectibleId,
    ]);

    const userA = await t
      .withIdentity(USER_A)
      .action(api.savedItems.getOwnerWatchlist, {});
    const userB = await t
      .withIdentity(USER_B)
      .action(api.savedItems.getOwnerWatchlist, {});

    expect(userA.savedRepacks.map(({ publicRepackId }) => publicRepackId)).toEqual(
      [availableRepack.publicRepackId],
    );
    expect(userA.savedCollectibles).toEqual([]);
    expect(userB.savedRepacks).toEqual([]);
    expect(
      userB.savedCollectibles.map(({ publicCollectibleId }) => publicCollectibleId),
    ).toEqual([firstCollectible.publicCollectibleId]);
  });

  test("returns a cap-sized collection whole and refuses anything beyond the cap", async () => {
    const t = createTest();
    await seed(t);
    const publicRepackIds = Array.from(
      { length: MAX_SAVED_ITEMS_PER_KIND },
      (_, index) => boundedPublicId(index + 1),
    );
    await t.run(async (ctx) => {
      for (const publicRepackId of publicRepackIds) {
        await ctx.db.insert("savedRepacks", {
          ownerTokenIdentifier: USER_A.tokenIdentifier,
          publicRepackId,
        });
      }
    });

    const watchlist = await t
      .withIdentity(USER_A)
      .action(api.savedItems.getOwnerWatchlist, {});
    expect(watchlist.savedRepackCount).toBe(MAX_SAVED_ITEMS_PER_KIND);
    expect(watchlist.savedRepacks).toHaveLength(MAX_SAVED_ITEMS_PER_KIND);
    expect(
      watchlist.savedRepacks.map(({ publicRepackId }) => publicRepackId),
    ).toEqual([...publicRepackIds].reverse());
    expect(
      watchlist.savedRepacks.every(
        ({ catalogStatus, openable }) =>
          catalogStatus === "unavailable" && openable === false,
      ),
    ).toBe(true);

    await t.run(async (ctx) => {
      await ctx.db.insert("savedRepacks", {
        ownerTokenIdentifier: USER_A.tokenIdentifier,
        publicRepackId: boundedPublicId(MAX_SAVED_ITEMS_PER_KIND + 1),
      });
    });
    await expectErrorCode(
      t.withIdentity(USER_A).action(api.savedItems.getOwnerWatchlist, {}),
      "SAVED_ITEMS_STATE_CONFLICT",
    );
  });

  test("refuses a suspended account the same way saving does while the beta is off", async () => {
    const t = createTest();
    await seed(t);
    const session = t.withIdentity(USER_A);
    await session.mutation(api.productUsers.recordSignIn, {});
    await t.mutation(internal.productUserDirectory.setDirectoryStanding, {
      subject: USER_A.tokenIdentifier,
      standing: "suspended",
    });

    await expectErrorCode(
      session.action(api.savedItems.getOwnerWatchlist, {}),
      "ACCOUNT_SUSPENDED",
    );
    await expectErrorCode(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: availableRepack.publicRepackId,
        saved: true,
      }),
      "ACCOUNT_SUSPENDED",
    );
    await expect(
      session.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({ savedRepackIds: [], savedCollectibleIds: [] });
  });

  test("refuses when the legacy catalog is present but V3 is not activated", async () => {
    const t = createTest();
    await seedLegacy(t);
    await expectErrorCode(
      t.withIdentity(USER_A).action(api.savedItems.getOwnerWatchlist, {}),
      "SAVED_RESOURCE_UNAVAILABLE",
    );
  });

  test("resolves against V3, not the legacy provider catalog, when the pointers diverge", async () => {
    const t = createTest();
    await seedLegacy(t);
    await seedV3(t);
    const saver = createSaver(t);
    await saver.repacks(USER_A.tokenIdentifier, [
      legacyOnlyRepack.publicRepackId,
      V3_REPACK_ID_A,
    ]);

    const watchlist = await t
      .withIdentity(USER_A)
      .action(api.savedItems.getOwnerWatchlist, {});
    expect(watchlist.savedRepacks).toEqual([
      {
        publicRepackId: V3_REPACK_ID_A,
        savedAt: savedAt(2),
        catalogStatus: "resolved",
        openable: true,
        repack: {
          name: availableRepack.name,
          vendorDisplayName: availableRepack.vendorDisplayName,
          availability: "available",
          estimatedEv: watchlistEstimatedEv(
            availableRepack.evEstimates.packScout,
          ),
        },
      },
      {
        publicRepackId: legacyOnlyRepack.publicRepackId,
        savedAt: savedAt(1),
        catalogStatus: "unavailable",
        openable: false,
        repack: null,
      },
    ]);
  });

  test("refuses a saved public id that is duplicated in the active V3 release", async () => {
    const t = createTest();
    await seed(t);
    const saver = createSaver(t);
    await t.run(async (ctx) => {
      const source = (await ctx.db.query("dataReleaseV3Repacks").collect()).find(
        (document) => document.publicRepackId === V3_REPACK_ID_A,
      );
      if (source === undefined) {
        throw new Error("Expected the seeded V3 repack.");
      }
      await ctx.db.insert("dataReleaseV3Repacks", {
        releaseId: source.releaseId,
        publicRepackId: source.publicRepackId,
        detail: source.detail,
      });
    });
    await saver.repacks(USER_A.tokenIdentifier, [V3_REPACK_ID_A]);
    await expectErrorCode(
      t.withIdentity(USER_A).action(api.savedItems.getOwnerWatchlist, {}),
      "SAVED_ITEMS_STATE_CONFLICT",
    );
  });

  test("refuses a saved collectible that is duplicated in the active V3 release", async () => {
    const t = createTest();
    await seed(t);
    const saver = createSaver(t);
    await t.run(async (ctx) => {
      const source = (
        await ctx.db.query("dataReleaseV3Collectibles").collect()
      ).find((document) => document.publicCollectibleId === V3_COLLECTIBLE_ID);
      if (source === undefined) {
        throw new Error("Expected the seeded V3 collectible.");
      }
      await ctx.db.insert("dataReleaseV3Collectibles", {
        releaseId: source.releaseId,
        publicCollectibleId: source.publicCollectibleId,
        collectibleType: source.collectibleType,
        normalizedName: source.normalizedName,
        searchText: source.searchText,
        detail: source.detail,
      });
    });
    await saver.collectibles(USER_A.tokenIdentifier, [V3_COLLECTIBLE_ID]);
    await expectErrorCode(
      t.withIdentity(USER_A).action(api.savedItems.getOwnerWatchlist, {}),
      "SAVED_ITEMS_STATE_CONFLICT",
    );
  });

  test("marks a collectible with duplicate chase repack entries as unavailable", async () => {
    const t = createTest();
    await seed(t);
    const saver = createSaver(t);
    await t.run(async (ctx) => {
      const source = (await ctx.db.query("dataReleaseV3Chases").collect()).find(
        (document) => document.publicCollectibleId === V3_COLLECTIBLE_ID,
      );
      if (source === undefined) {
        throw new Error("Expected the seeded V3 chase.");
      }
      await ctx.db.insert("dataReleaseV3Chases", {
        releaseId: source.releaseId,
        publicRepackId: source.publicRepackId,
        publicCollectibleId: source.publicCollectibleId,
        detail: source.detail,
      });
    });
    await saver.collectibles(USER_A.tokenIdentifier, [V3_COLLECTIBLE_ID]);
    const watchlist = await t
      .withIdentity(USER_A)
      .action(api.savedItems.getOwnerWatchlist, {});
    expect(watchlist.savedCollectibles).toEqual([
      {
        publicCollectibleId: V3_COLLECTIBLE_ID,
        savedAt: savedAt(1),
        catalogStatus: "unavailable",
        openable: false,
        collectible: null,
      },
    ]);
  });

  test("marks a collectible whose detail violates the public contract as unavailable", async () => {
    const t = createTest();
    await seed(t);
    const saver = createSaver(t);
    await t.run(async (ctx) => {
      const source = (
        await ctx.db.query("dataReleaseV3Collectibles").collect()
      ).find((document) => document.publicCollectibleId === V3_COLLECTIBLE_ID);
      if (source === undefined) {
        throw new Error("Expected the seeded V3 collectible.");
      }
      await ctx.db.patch(source._id, {
        detail: { ...source.detail, name: "", year: 99 },
      });
    });
    await saver.collectibles(USER_A.tokenIdentifier, [V3_COLLECTIBLE_ID]);
    const watchlist = await t
      .withIdentity(USER_A)
      .action(api.savedItems.getOwnerWatchlist, {});
    expect(watchlist.savedCollectibles).toEqual([
      {
        publicCollectibleId: V3_COLLECTIBLE_ID,
        savedAt: savedAt(1),
        catalogStatus: "unavailable",
        openable: false,
        collectible: null,
      },
    ]);
  });

  test("marks a collectible whose chase detail disagrees with outer ids as unavailable", async () => {
    const t = createTest();
    await seed(t);
    const saver = createSaver(t);
    await t.run(async (ctx) => {
      const source = (await ctx.db.query("dataReleaseV3Chases").collect()).find(
        (document) => document.publicCollectibleId === V3_COLLECTIBLE_ID,
      );
      if (source === undefined) {
        throw new Error("Expected the seeded V3 chase.");
      }
      await ctx.db.patch(source._id, {
        detail: { ...source.detail, publicRepackId: EXTRA_REPACK_ID },
      });
    });
    await saver.collectibles(USER_A.tokenIdentifier, [V3_COLLECTIBLE_ID]);
    const watchlist = await t
      .withIdentity(USER_A)
      .action(api.savedItems.getOwnerWatchlist, {});
    expect(watchlist.savedCollectibles).toEqual([
      {
        publicCollectibleId: V3_COLLECTIBLE_ID,
        savedAt: savedAt(1),
        catalogStatus: "unavailable",
        openable: false,
        collectible: null,
      },
    ]);
  });

  test("marks a collectible whose chased catalog pack diverges from facts as unavailable", async () => {
    const t = createTest();
    await seed(t);
    const saver = createSaver(t);
    await saver.collectibles(USER_A.tokenIdentifier, [V3_COLLECTIBLE_ID]);
    await t.run(async (ctx) => {
      const source = (await ctx.db.query("dataReleaseV3Repacks").collect()).find(
        (document) => document.publicRepackId === V3_REPACK_ID_A,
      );
      if (source === undefined) {
        throw new Error("Expected the seeded V3 repack.");
      }
      await ctx.db.patch(source._id, {
        detail: {
          ...source.detail,
          evEstimates: {
            ...source.detail.evEstimates,
            packScout: buildV3UnavailableEv(),
          },
        },
      });
    });
    const watchlist = await t
      .withIdentity(USER_A)
      .action(api.savedItems.getOwnerWatchlist, {});
    expect(watchlist.savedCollectibles).toEqual([
      {
        publicCollectibleId: V3_COLLECTIBLE_ID,
        savedAt: savedAt(1),
        catalogStatus: "unavailable",
        openable: false,
        collectible: null,
      },
    ]);
  });

  test("marks a collectible with too many chase rows as unavailable", async () => {
    const t = createTest();
    await seed(t);
    const saver = createSaver(t);
    await t.run(async (ctx) => {
      const source = (await ctx.db.query("dataReleaseV3Chases").collect()).find(
        (document) => document.publicCollectibleId === V3_COLLECTIBLE_ID,
      );
      if (source === undefined) {
        throw new Error("Expected the seeded V3 chase.");
      }
      for (let index = 0; index < MAX_DESIRED_CHASES_PER_COLLECTIBLE; index += 1) {
        const publicRepackId = boundedPublicId(index + 1);
        await ctx.db.insert("dataReleaseV3Chases", {
          releaseId: source.releaseId,
          publicRepackId,
          publicCollectibleId: V3_COLLECTIBLE_ID,
          detail: buildV3Chase(publicRepackId),
        });
      }
    });
    await saver.collectibles(USER_A.tokenIdentifier, [V3_COLLECTIBLE_ID]);
    const watchlist = await t
      .withIdentity(USER_A)
      .action(api.savedItems.getOwnerWatchlist, {});
    expect(watchlist.savedCollectibles).toEqual([
      {
        publicCollectibleId: V3_COLLECTIBLE_ID,
        savedAt: savedAt(1),
        catalogStatus: "unavailable",
        openable: false,
        collectible: null,
      },
    ]);
  });

  test("refuses when the active V3 release fails the public catalog validation", async () => {
    const t = createTest();
    await seed(t);
    await t.run(async (ctx) => {
      const release = (await ctx.db.query("dataReleaseV3Releases").collect())[0];
      if (release === undefined) {
        throw new Error("Expected the seeded V3 release.");
      }
      await ctx.db.patch(release._id, {
        acceptedBatchCount: release.acceptedBatchCount + 1,
      });
    });
    await expectErrorCode(
      t.withIdentity(USER_A).action(api.savedItems.getOwnerWatchlist, {}),
      "SAVED_RESOURCE_UNAVAILABLE",
    );
  });

  test("marks a unique V3 document absent from the catalog projection as unavailable", async () => {
    const t = createTest();
    await seed(t);
    const saver = createSaver(t);
    await t.run(async (ctx) => {
      const source = (await ctx.db.query("dataReleaseV3Repacks").collect()).find(
        (document) => document.publicRepackId === V3_REPACK_ID_A,
      );
      if (source === undefined) {
        throw new Error("Expected the seeded V3 repack.");
      }
      await ctx.db.insert("dataReleaseV3Repacks", {
        releaseId: source.releaseId,
        publicRepackId: EXTRA_REPACK_ID,
        detail: { ...source.detail, publicRepackId: EXTRA_REPACK_ID },
      });
    });
    await saver.repacks(USER_A.tokenIdentifier, [EXTRA_REPACK_ID]);
    const watchlist = await t
      .withIdentity(USER_A)
      .action(api.savedItems.getOwnerWatchlist, {});
    expect(watchlist.savedRepacks).toEqual([
      {
        publicRepackId: EXTRA_REPACK_ID,
        savedAt: savedAt(1),
        catalogStatus: "unavailable",
        openable: false,
        repack: null,
      },
    ]);
  });

  test("marks a V3 document whose detail diverges from catalog facts as unavailable", async () => {
    const t = createTest();
    await seed(t);
    const saver = createSaver(t);
    await saver.repacks(USER_A.tokenIdentifier, [availableRepack.publicRepackId]);
    await t.run(async (ctx) => {
      const source = (await ctx.db.query("dataReleaseV3Repacks").collect()).find(
        (document) => document.publicRepackId === availableRepack.publicRepackId,
      );
      if (source === undefined) {
        throw new Error("Expected the seeded V3 repack.");
      }
      await ctx.db.patch(source._id, {
        detail: {
          ...source.detail,
          evEstimates: {
            ...source.detail.evEstimates,
            packScout: buildV3UnavailableEv(),
          },
        },
      });
    });
    const watchlist = await t
      .withIdentity(USER_A)
      .action(api.savedItems.getOwnerWatchlist, {});
    expect(watchlist.savedRepacks).toEqual([
      {
        publicRepackId: availableRepack.publicRepackId,
        savedAt: savedAt(1),
        catalogStatus: "unavailable",
        openable: false,
        repack: null,
      },
    ]);
  });

  test("returns retained last-known EV when the active release reports unavailable", async () => {
    const t = createTest();
    const original = buildV3Detail();
    await activateRetentionRelease(
      t,
      await stageRetentionRelease(t, 1, [original]),
      null,
    );
    await activateRetentionRelease(
      t,
      await stageRetentionRelease(t, 2, [unavailableRetentionDetail()]),
      1,
    );
    const saver = createSaver(t);
    await saver.repacks(USER_A.tokenIdentifier, [original.publicRepackId]);
    const later = V3_FIXTURE_NOW + 24 * 60 * 60_000;
    const watchlist = (
      await t
        .withIdentity(USER_A)
        .query(internal.savedItems.getOwnerWatchlistAtTime, {
          currentTime: later,
        })
    ).watchlist;
    const expectedEv = watchlistEstimatedEv(original.evEstimates.packScout);
    expect(watchlist.savedRepacks).toEqual([
      {
        publicRepackId: original.publicRepackId,
        savedAt: savedAt(1),
        catalogStatus: "resolved",
        openable: true,
        repack: {
          name: original.name,
          vendorDisplayName: original.vendorDisplayName,
          availability: "available",
          estimatedEv: { ...expectedEv, confidenceBand: "low" },
        },
      },
    ]);
  });

  test("refuses an invalid evaluation clock on the deterministic Watchlist read", async () => {
    const t = createTest();
    await seed(t);
    await expectErrorCode(
      t.withIdentity(USER_A).query(internal.savedItems.getOwnerWatchlistAtTime, {
        currentTime: -1,
      }),
      "SAVED_RESOURCE_UNAVAILABLE",
    );
  });
});
