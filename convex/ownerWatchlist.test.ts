/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";
import { MAX_SAVED_ITEMS_PER_KIND } from "./savedItems";
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
const MISSING_COLLECTIBLE_ID = "30000000-0000-5000-8000-000000000999";
const CLOCK_BASE = Date.UTC(2026, 7, 19, 12, 0, 0);

const fixture = buildMockDataReleaseV2();
const availableRepack = fixture.repacks.find(
  (repack) =>
    repack.availability === "available" &&
    repack.evEstimates.packScout.status === "available",
)!;
const soldOutRepack = fixture.repacks.find(
  (repack) => repack.availability === "sold_out",
)!;
const firstCollectible = fixture.collectibles[0]!;

function createTest() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(CLOCK_BASE));
  return convexTest({ schema, modules, transactionLimits: true });
}

async function seed(t: WatchlistTest): Promise<void> {
  vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
  vi.stubEnv("PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED", "1");
  await t.mutation(internal.mockDataReleaseSeed.seed, {});
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("owner watchlist read", () => {
  test("refuses unauthenticated and invalid-identity callers without a payload", async () => {
    const t = createTest();
    await seed(t);

    await expectErrorCode(
      t.query(api.savedItems.getOwnerWatchlist, {}),
      "AUTH_REQUIRED",
    );
    await expectErrorCode(
      t
        .withIdentity({
          subject: "",
          issuer: "privy.io",
          tokenIdentifier: "",
        })
        .query(api.savedItems.getOwnerWatchlist, {}),
      "AUTH_IDENTITY_INVALID",
    );
  });

  test("returns empty collections and zero counts when the owner has saved nothing", async () => {
    const t = createTest();
    await seed(t);
    await expect(
      t.withIdentity(USER_A).query(api.savedItems.getOwnerWatchlist, {}),
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

    const packScout = availableRepack.evEstimates.packScout;
    if (packScout.status !== "available") {
      throw new Error("Expected an available PackScout EV fixture.");
    }
    const watchlist = await t
      .withIdentity(USER_A)
      .query(api.savedItems.getOwnerWatchlist, {});

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
          estimatedEv:
            soldOutRepack.evEstimates.packScout.status === "available"
              ? {
                  evDollarsMinorUnits:
                    soldOutRepack.evEstimates.packScout.metrics.evDollars
                      .minorUnits,
                  grossReturnBasisPoints:
                    soldOutRepack.evEstimates.packScout.metrics
                      .grossReturnBasisPoints,
                  confidenceBand:
                    soldOutRepack.evEstimates.packScout.confidence.band,
                }
              : null,
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
          estimatedEv: {
            evDollarsMinorUnits: packScout.metrics.evDollars.minorUnits,
            grossReturnBasisPoints: packScout.metrics.grossReturnBasisPoints,
            confidenceBand: packScout.confidence.band,
          },
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
      .query(api.savedItems.getOwnerWatchlist, {});
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
      .query(api.savedItems.getOwnerWatchlist, {});
    const userB = await t
      .withIdentity(USER_B)
      .query(api.savedItems.getOwnerWatchlist, {});

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
      .query(api.savedItems.getOwnerWatchlist, {});
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
      t.withIdentity(USER_A).query(api.savedItems.getOwnerWatchlist, {}),
      "SAVED_ITEMS_STATE_CONFLICT",
    );
  });
});
