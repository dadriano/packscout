/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";
import {
  listSavedCollectiblesForSubject,
  listSavedRepacksForSubject,
} from "./productUserSavedItems";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type SavedItemsTest = TestConvex<typeof schema>;

const ALICE = "privy.io|did:privy:alice";
const BOB = "privy.io|did:privy:bob";
const ADMIN_TOKEN = "packscout-admin-directory-token-000000000001";
const SAVED_ITEMS_PATH = "/admin/product-users/saved-items";
const MAX_SAVED_ITEMS_PER_KIND = 250;

/** References the catalog has never carried; they can only read as unresolved. */
const MISSING_REPACK_ID = "40000000-0000-5000-8000-000000000999";
const MISSING_COLLECTIBLE_ID = "30000000-0000-5000-8000-000000000999";

const fixture = buildMockDataReleaseV2();
const availableRepack = fixture.repacks.find(
  (repack) =>
    repack.availability === "available" &&
    repack.evEstimates.packScout.status === "available",
)!;
const soldOutRepack = fixture.repacks.find(
  (repack) => repack.availability === "sold_out",
)!;
const unavailableRepack = fixture.repacks.find(
  (repack) => repack.availability === "unavailable",
)!;
const unknownRepack = fixture.repacks.find(
  (repack) => repack.availability === "unknown",
)!;
const withoutEvRepack = fixture.repacks.find(
  (repack) => repack.evEstimates.packScout.status === "unavailable",
)!;
const firstCollectible = fixture.collectibles[0]!;

const CLOCK_BASE = Date.UTC(2026, 7, 19, 12, 0, 0);

function savedAt(second: number): string {
  return new Date(CLOCK_BASE + second * 1_000).toISOString();
}

/**
 * Freezes the clock before any document exists, so every later save lands on a
 * known instant and the collection ordering under test is the save ordering.
 */
function createTest() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(CLOCK_BASE));
  return convexTest({ schema, modules, transactionLimits: true });
}

async function seedCatalog(t: SavedItemsTest): Promise<void> {
  vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
  vi.stubEnv("PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED", "1");
  await t.mutation(internal.mockDataReleaseSeed.seed, {});
}

/** Saves references a second apart, in call order, across both kinds. */
function createSaver(t: SavedItemsTest) {
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

function listRepacks(t: SavedItemsTest, subject: string) {
  return t.query(internal.productUserSavedItems.listSavedRepacksForSubject, {
    subject,
  });
}

function listCollectibles(t: SavedItemsTest, subject: string) {
  return t.query(
    internal.productUserSavedItems.listSavedCollectiblesForSubject,
    { subject },
  );
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

/** Identifiers outside every fixture range, so they can only read as unresolved. */
function boundedPublicId(index: number): string {
  return `41000000-0000-5000-8000-${String(index).padStart(12, "0")}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("privileged per-subject saved-item reads", () => {
  test("resolves saved repacks against the active catalog, newest save first", async () => {
    const t = createTest();
    await seedCatalog(t);
    const saver = createSaver(t);
    await saver.repacks(ALICE, [
      availableRepack.publicRepackId,
      withoutEvRepack.publicRepackId,
      MISSING_REPACK_ID,
      soldOutRepack.publicRepackId,
    ]);
    // Another owner's saves never appear in this owner's collection.
    await saver.repacks(BOB, [availableRepack.publicRepackId]);

    const collection = await listRepacks(t, ALICE);
    expect(collection.catalogAvailable).toBe(true);
    expect(
      collection.items.map(({ publicRepackId }) => publicRepackId),
    ).toEqual([
      soldOutRepack.publicRepackId,
      MISSING_REPACK_ID,
      withoutEvRepack.publicRepackId,
      availableRepack.publicRepackId,
    ]);

    const packScout = availableRepack.evEstimates.packScout;
    if (packScout.status !== "available") {
      throw new Error("Expected a fixture repack with a PackScout estimate.");
    }
    expect(collection.items.at(-1)).toEqual({
      publicRepackId: availableRepack.publicRepackId,
      savedAt: savedAt(1),
      resolution: "resolved",
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
    });
    expect(collection.items[0]).toMatchObject({
      savedAt: savedAt(4),
      resolution: "resolved",
      repack: { name: soldOutRepack.name, availability: "sold_out" },
    });
    // A repack the catalog carries without a PackScout estimate still resolves.
    expect(collection.items[2]).toMatchObject({
      resolution: "resolved",
      repack: { name: withoutEvRepack.name, estimatedEv: null },
    });
  });

  test("preserves all four public availability states", async () => {
    const t = createTest();
    await seedCatalog(t);
    await createSaver(t).repacks(ALICE, [
      availableRepack.publicRepackId,
      unavailableRepack.publicRepackId,
      unknownRepack.publicRepackId,
      soldOutRepack.publicRepackId,
    ]);

    const collection = await listRepacks(t, ALICE);
    expect(
      collection.items.map((item) => item.repack?.availability ?? null),
    ).toEqual(["sold_out", "unknown", "unavailable", "available"]);
  });

  test("keeps a reference the active catalog no longer carries, labelled and identified", async () => {
    const t = createTest();
    await seedCatalog(t);
    const saver = createSaver(t);
    await saver.repacks(ALICE, [MISSING_REPACK_ID]);
    await saver.collectibles(ALICE, [MISSING_COLLECTIBLE_ID]);

    const repacks = await listRepacks(t, ALICE);
    expect(repacks.catalogAvailable).toBe(true);
    expect(repacks.items).toEqual([
      {
        publicRepackId: MISSING_REPACK_ID,
        savedAt: savedAt(1),
        resolution: "unresolved",
        repack: null,
      },
    ]);

    const collectibles = await listCollectibles(t, ALICE);
    expect(collectibles.items).toEqual([
      {
        publicCollectibleId: MISSING_COLLECTIBLE_ID,
        savedAt: savedAt(2),
        resolution: "unresolved",
        collectible: null,
      },
    ]);
  });

  test("resolves saved collectibles to recognizable catalog information", async () => {
    const t = createTest();
    await seedCatalog(t);
    const saver = createSaver(t);
    await saver.collectibles(ALICE, [
      firstCollectible.publicCollectibleId,
      MISSING_COLLECTIBLE_ID,
    ]);

    const collection = await listCollectibles(t, ALICE);
    expect(collection.catalogAvailable).toBe(true);
    expect(collection.items.map(({ resolution }) => resolution)).toEqual([
      "unresolved",
      "resolved",
    ]);
    expect(collection.items.at(-1)).toEqual({
      publicCollectibleId: firstCollectible.publicCollectibleId,
      savedAt: savedAt(1),
      resolution: "resolved",
      collectible: {
        name: firstCollectible.name,
        collectibleType: firstCollectible.collectibleType,
      },
    });
  });

  test("reports empty collections for an owner who has saved nothing", async () => {
    const t = createTest();
    await seedCatalog(t);

    await expect(listRepacks(t, ALICE)).resolves.toEqual({
      catalogAvailable: true,
      items: [],
    });
    await expect(listCollectibles(t, ALICE)).resolves.toEqual({
      catalogAvailable: true,
      items: [],
    });
  });

  test("distinguishes an unreadable catalog from references that have left it", async () => {
    const t = createTest();
    const saver = createSaver(t);
    await saver.repacks(ALICE, [availableRepack.publicRepackId]);
    await saver.collectibles(ALICE, [firstCollectible.publicCollectibleId]);

    // No active catalog release exists, so nothing can be resolved and the
    // caller is told that rather than being told the references were removed.
    await expect(listRepacks(t, ALICE)).resolves.toMatchObject({
      catalogAvailable: false,
      items: [{ resolution: "unresolved", repack: null }],
    });
    await expect(listCollectibles(t, ALICE)).resolves.toMatchObject({
      catalogAvailable: false,
      items: [{ resolution: "unresolved", collectible: null }],
    });
  });

  test("returns a cap-sized collection whole and refuses anything beyond the cap", async () => {
    const t = createTest();
    await seedCatalog(t);
    const publicRepackIds = Array.from(
      { length: MAX_SAVED_ITEMS_PER_KIND },
      (_, index) => boundedPublicId(index + 1),
    );
    await t.run(async (ctx) => {
      for (const publicRepackId of publicRepackIds) {
        await ctx.db.insert("savedRepacks", {
          ownerTokenIdentifier: ALICE,
          publicRepackId,
        });
      }
    });

    const collection = await listRepacks(t, ALICE);
    expect(collection.items).toHaveLength(MAX_SAVED_ITEMS_PER_KIND);
    // Saves made in one instant still order deterministically, newest first.
    expect(
      collection.items.map(({ publicRepackId }) => publicRepackId),
    ).toEqual([...publicRepackIds].reverse());
    expect(
      collection.items.every(({ resolution }) => resolution === "unresolved"),
    ).toBe(true);

    await t.run(async (ctx) => {
      await ctx.db.insert("savedRepacks", {
        ownerTokenIdentifier: ALICE,
        publicRepackId: boundedPublicId(MAX_SAVED_ITEMS_PER_KIND + 1),
      });
    });
    await expectErrorCode(listRepacks(t, ALICE), "PRODUCT_USER_STATE_CONFLICT");
  });

  test("bounds the addressing subject", async () => {
    const t = createTest();
    for (const subject of ["", "a".repeat(1_025)]) {
      await expectErrorCode(
        listRepacks(t, subject),
        "PRODUCT_USER_SUBJECT_INVALID",
      );
      await expectErrorCode(
        listCollectibles(t, subject),
        "PRODUCT_USER_SUBJECT_INVALID",
      );
    }
  });

  test("keeps both reads internal, read-only queries", () => {
    for (const registered of [
      listSavedRepacksForSubject,
      listSavedCollectiblesForSubject,
    ]) {
      const visibility = registered as unknown as {
        isPublic?: boolean;
        isInternal?: boolean;
        isQuery?: boolean;
        isMutation?: boolean;
      };
      expect(visibility.isInternal).toBe(true);
      expect(visibility.isPublic).toBeUndefined();
      expect(visibility.isQuery).toBe(true);
      expect(visibility.isMutation).toBeUndefined();
    }
  });
});

describe("admin saved-items integration transport", () => {
  async function post(
    t: SavedItemsTest,
    path: string,
    body: unknown,
    authorization?: string,
  ): Promise<Response> {
    return await t.fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  test("refuses every caller without the configured deployment secret", async () => {
    const t = createTest();

    // Nothing configured: the surface fails closed even for a plausible token.
    const unconfigured = await post(
      t,
      SAVED_ITEMS_PATH,
      { subject: ALICE },
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(unconfigured.status).toBe(401);
    expect(await unconfigured.json()).toEqual({
      error: "The product-user directory integration is not authorized.",
      code: "ADMIN_DIRECTORY_UNAUTHORIZED",
    });

    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);
    for (const authorization of [
      undefined,
      "",
      "Bearer",
      `Bearer ${ADMIN_TOKEN.replace("1", "2")}`,
      // An ordinary authenticated product client holds a token like this one.
      "Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.product-user-access-token",
      ADMIN_TOKEN,
    ]) {
      const response = await post(
        t,
        SAVED_ITEMS_PATH,
        { subject: ALICE },
        authorization,
      );
      expect(response.status).toBe(401);
    }
  });

  test("serves both resolved collections to the admin server", async () => {
    const t = createTest();
    await seedCatalog(t);
    const saver = createSaver(t);
    await saver.repacks(ALICE, [
      availableRepack.publicRepackId,
      MISSING_REPACK_ID,
    ]);
    await saver.collectibles(ALICE, [firstCollectible.publicCollectibleId]);
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);

    const response = await post(
      t,
      SAVED_ITEMS_PATH,
      { subject: ALICE },
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      catalogAvailable: true,
      savedRepacks: [
        {
          publicRepackId: MISSING_REPACK_ID,
          savedAt: savedAt(2),
          resolution: "unresolved",
          repack: null,
        },
        {
          publicRepackId: availableRepack.publicRepackId,
          savedAt: savedAt(1),
          resolution: "resolved",
          repack: {
            name: availableRepack.name,
            vendorDisplayName: availableRepack.vendorDisplayName,
            availability: "available",
            estimatedEv: expect.objectContaining({
              confidenceBand: expect.any(String),
            }),
          },
        },
      ],
      savedCollectibles: [
        {
          publicCollectibleId: firstCollectible.publicCollectibleId,
          savedAt: savedAt(3),
          resolution: "resolved",
          collectible: {
            name: firstCollectible.name,
            collectibleType: firstCollectible.collectibleType,
          },
        },
      ],
    });

    // The surface is a read: the owner's saved rows are untouched by it.
    const stored = await t.run(async (ctx) => ({
      repacks: await ctx.db.query("savedRepacks").take(10),
      collectibles: await ctx.db.query("savedCollectibles").take(10),
    }));
    expect(stored.repacks).toHaveLength(2);
    expect(stored.collectibles).toHaveLength(1);
  });

  test("maps malformed and refused requests without leaking backend errors", async () => {
    const t = createTest();
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);
    const authorization = `Bearer ${ADMIN_TOKEN}`;

    for (const body of [
      "not-json",
      [],
      {},
      { subject: 42 },
      { subject: "a".repeat(1_025) },
    ]) {
      const response = await post(t, SAVED_ITEMS_PATH, body, authorization);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "ADMIN_DIRECTORY_REQUEST_INVALID",
      });
    }

    const emptySubject = await post(
      t,
      SAVED_ITEMS_PATH,
      { subject: "" },
      authorization,
    );
    expect(emptySubject.status).toBe(400);
    expect(await emptySubject.json()).toEqual({
      error: "The product-user directory request was rejected.",
      code: "PRODUCT_USER_SUBJECT_INVALID",
    });
  });

  test("exposes no other method or path for saved items", async () => {
    const t = createTest();
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);

    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await t.fetch(SAVED_ITEMS_PATH, {
        method,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(response.status).toBe(404);
    }
    const wrongPath = await post(
      t,
      "/admin/product-users/saved-items/list",
      { subject: ALICE },
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(wrongPath.status).toBe(404);
  });
});
