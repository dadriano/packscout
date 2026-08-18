/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { buildPrivyAuthConfig } from "./auth.config";
import schema from "./schema";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";
import { compareSavedItemCandidateOrder } from "./savedItems";

const modules = import.meta.glob("./**/*.ts");
type SavedItemsTest = TestConvex<typeof schema>;
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
const MAX_SAVED_ITEMS_PER_KIND = 250;

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

async function seed(t: SavedItemsTest): Promise<void> {
  vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
  vi.stubEnv("PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED", "1");
  await t.mutation(internal.mockDataReleaseSeed.seed, {});
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

function boundedPublicId(prefix: string, index: number): string {
  return `${prefix}-0000-5000-8000-${String(index).padStart(12, "0")}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("authenticated saved items", () => {
  test("configures the exact optional Privy ES256 claims and JWKS contract", () => {
    expect(buildPrivyAuthConfig(undefined)).toEqual({ providers: [] });
    expect(buildPrivyAuthConfig("")).toEqual({ providers: [] });
    expect(buildPrivyAuthConfig("cm1234567890_packscout")).toEqual({
      providers: [
        {
          type: "customJwt",
          applicationID: "cm1234567890_packscout",
          issuer: "privy.io",
          jwks:
            "https://auth.privy.io/api/v1/apps/cm1234567890_packscout/jwks.json",
          algorithm: "ES256",
        },
      ],
    });
    for (const malformed of [
      "short",
      " leading-value",
      "trailing-value ",
      "contains.dot",
      "a".repeat(129),
    ]) {
      expect(() => buildPrivyAuthConfig(malformed)).toThrow(/PRIVY_APP_ID/);
    }
  });

  test("rejects every unauthenticated read and write", async () => {
    const t = createTest();
    const fixture = buildMockDataReleaseV2();

    await expectErrorCode(
      t.query(api.savedItems.getSavedItemIds, {}),
      "AUTH_REQUIRED",
    );
    await expectErrorCode(
      t.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: fixture.repacks[0]!.publicRepackId,
        saved: true,
      }),
      "AUTH_REQUIRED",
    );
    await expectErrorCode(
      t.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId: fixture.collectibles[0]!.publicCollectibleId,
        saved: true,
      }),
      "AUTH_REQUIRED",
    );
  });

  test("isolates saved IDs by the authenticated token identifier", async () => {
    const t = createTest();
    await seed(t);
    const fixture = buildMockDataReleaseV2();
    const userA = t.withIdentity(USER_A);
    const userB = t.withIdentity(USER_B);
    const repackIds = fixture.repacks
      .slice(0, 2)
      .map(({ publicRepackId }) => publicRepackId)
      .sort();
    const collectibleIds = fixture.collectibles
      .slice(0, 2)
      .map(({ publicCollectibleId }) => publicCollectibleId)
      .sort();

    await userA.mutation(api.savedItems.setSavedRepack, {
      publicRepackId: repackIds[1]!,
      saved: true,
    });
    await userA.mutation(api.savedItems.setSavedRepack, {
      publicRepackId: repackIds[0]!,
      saved: true,
    });
    await userA.mutation(api.savedItems.setSavedCollectible, {
      publicCollectibleId: collectibleIds[1]!,
      saved: true,
    });
    await expect(
      userB.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: [],
      savedCollectibleIds: [],
    });

    await userB.mutation(api.savedItems.setSavedCollectible, {
      publicCollectibleId: collectibleIds[0]!,
      saved: true,
    });
    await expect(
      userA.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: repackIds,
      savedCollectibleIds: [collectibleIds[1]!],
    });
    await expect(
      userB.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: [],
      savedCollectibleIds: [collectibleIds[0]!],
    });
  });

  test("saves and unsaves both resource kinds idempotently", async () => {
    const t = createTest();
    await seed(t);
    const fixture = buildMockDataReleaseV2();
    const user = t.withIdentity(USER_A);
    const publicRepackId = fixture.repacks[0]!.publicRepackId;
    const publicCollectibleId = fixture.collectibles[0]!.publicCollectibleId;

    for (const _attempt of [1, 2]) {
      await expect(
        user.mutation(api.savedItems.setSavedRepack, {
          publicRepackId,
          saved: true,
        }),
      ).resolves.toEqual({ saved: true, prunedUnavailable: false });
      await expect(
        user.mutation(api.savedItems.setSavedCollectible, {
          publicCollectibleId,
          saved: true,
        }),
      ).resolves.toEqual({ saved: true, prunedUnavailable: false });
    }
    await expect(
      t.run(async (ctx) => ({
        repacks: (await ctx.db.query("savedRepacks").take(3)).length,
        collectibles: (await ctx.db.query("savedCollectibles").take(3)).length,
      })),
    ).resolves.toEqual({ repacks: 1, collectibles: 1 });

    for (const _attempt of [1, 2]) {
      await expect(
        user.mutation(api.savedItems.setSavedRepack, {
          publicRepackId,
          saved: false,
        }),
      ).resolves.toEqual({ saved: false, prunedUnavailable: false });
      await expect(
        user.mutation(api.savedItems.setSavedCollectible, {
          publicCollectibleId,
          saved: false,
        }),
      ).resolves.toEqual({ saved: false, prunedUnavailable: false });
    }
    await expect(
      user.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: [],
      savedCollectibleIds: [],
    });
  });

  test("validates public IDs and only saves resources in the active complete release", async () => {
    const t = createTest();
    await seed(t);
    const fixture = buildMockDataReleaseV2();
    const user = t.withIdentity(USER_A);
    const missingId = "ffffffff-ffff-5fff-bfff-ffffffffffff";

    await expectErrorCode(
      user.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: "not-a-public-id",
        saved: true,
      }),
      "INVALID_PUBLIC_REPACK_ID",
    );
    await expectErrorCode(
      user.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId: "not-a-public-id",
        saved: true,
      }),
      "INVALID_PUBLIC_COLLECTIBLE_ID",
    );
    await expectErrorCode(
      user.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: missingId,
        saved: true,
      }),
      "SAVED_RESOURCE_UNAVAILABLE",
    );
    await expectErrorCode(
      user.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId: missingId,
        saved: true,
      }),
      "SAVED_RESOURCE_UNAVAILABLE",
    );
    await expect(
      user.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: missingId,
        saved: false,
      }),
    ).resolves.toEqual({ saved: false, prunedUnavailable: false });

    const publicRepackId = fixture.repacks[0]!.publicRepackId;
    await user.mutation(api.savedItems.setSavedRepack, {
      publicRepackId,
      saved: true,
    });
    await t.run(async (ctx) => {
      const state = await ctx.db
        .query("activeCatalogManifestState")
        .withIndex("by_key", (index) => index.eq("key", "singleton"))
        .unique();
      if (state === null) throw new Error("Expected an active manifest.");
      await ctx.db.delete("activeCatalogManifestState", state._id);
    });
    await expect(
      user.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: false,
      }),
    ).resolves.toEqual({ saved: false, prunedUnavailable: false });
    await expectErrorCode(
      user.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: true,
      }),
      "SAVED_RESOURCE_UNAVAILABLE",
    );
  });

  test("fails closed when active resource identities are duplicated", async () => {
    const t = createTest();
    await seed(t);
    const fixture = buildMockDataReleaseV2();
    const user = t.withIdentity(USER_A);
    const publicRepackId = fixture.repacks[0]!.publicRepackId;
    const publicCollectibleId = fixture.collectibles[0]!.publicCollectibleId;

    await t.run(async (ctx) => {
      const repack = (await ctx.db.query("providerCatalogRepacks").collect())
        .find((document) => document.publicRepackId === publicRepackId);
      const collectible = (
        await ctx.db.query("providerCatalogCollectibles").collect()
      ).find(
        (document) => document.publicCollectibleId === publicCollectibleId,
      );
      if (repack === undefined || collectible === undefined) {
        throw new Error("Expected seeded active resources.");
      }
      await ctx.db.insert("providerCatalogRepacks", {
        releaseId: repack.releaseId,
        publicRepackId,
        vendorId: repack.vendorId,
        detail: repack.detail,
      });
      await ctx.db.insert("providerCatalogCollectibles", {
        releaseId: collectible.releaseId,
        publicCollectibleId,
        collectibleType: collectible.collectibleType,
        normalizedName: collectible.normalizedName,
        searchText: collectible.searchText,
        detail: collectible.detail,
      });
    });

    await expectErrorCode(
      user.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: true,
      }),
      "SAVED_ITEMS_STATE_CONFLICT",
    );
    await expectErrorCode(
      user.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId,
        saved: true,
      }),
      "SAVED_ITEMS_STATE_CONFLICT",
    );
    await expect(
      user.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: [],
      savedCollectibleIds: [],
    });
  });

  test("does not prune when a capacity scan encounters a duplicate active resource", async () => {
    const t = createTest();
    await seed(t);
    const user = t.withIdentity(USER_A);
    const duplicateId = boundedPublicId("70000000", 0);
    const requestedId = boundedPublicId("80000000", 0);
    const staleIds = Array.from(
      { length: MAX_SAVED_ITEMS_PER_KIND - 1 },
      (_, index) => boundedPublicId("90000000", index),
    );

    await t.run(async (ctx) => {
      const template = await ctx.db.query("providerCatalogRepacks").first();
      if (template === null) {
        throw new Error("Expected a seeded active repack.");
      }
      for (const publicRepackId of [duplicateId, duplicateId, requestedId]) {
        await ctx.db.insert("providerCatalogRepacks", {
          releaseId: template.releaseId,
          publicRepackId,
          vendorId: template.vendorId,
          detail: { ...template.detail, publicRepackId },
        });
      }
      await ctx.db.insert("savedRepacks", {
        ownerTokenIdentifier: USER_A.tokenIdentifier,
        publicRepackId: duplicateId,
      });
      for (const publicRepackId of staleIds) {
        await ctx.db.insert("savedRepacks", {
          ownerTokenIdentifier: USER_A.tokenIdentifier,
          publicRepackId,
        });
      }
    });

    await expectErrorCode(
      user.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: requestedId,
        saved: true,
      }),
      "SAVED_ITEMS_STATE_CONFLICT",
    );
    const saved = await user.query(api.savedItems.getSavedItemIds, {});
    expect(saved.savedRepackIds).toHaveLength(MAX_SAVED_ITEMS_PER_KIND);
    expect(saved.savedRepackIds).toContain(duplicateId);
    expect(saved.savedRepackIds).not.toContain(requestedId);
  });

  test("prunes only the oldest unavailable repack for the current owner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-14T12:00:00.000Z");
    const t = createTest();
    await seed(t);
    const userA = t.withIdentity(USER_A);
    const userB = t.withIdentity(USER_B);
    const activeOldestId = boundedPublicId("30000000", 0);
    const unavailableOldestId = boundedPublicId("f0000000", 0);
    const unavailableNewerIds = Array.from(
      { length: MAX_SAVED_ITEMS_PER_KIND - 2 },
      (_, index) => boundedPublicId("10000000", index),
    );
    const requestedId = boundedPublicId("40000000", 0);

    await t.run(async (ctx) => {
      const template = await ctx.db.query("providerCatalogRepacks").first();
      if (template === null) {
        throw new Error("Expected a seeded active repack.");
      }
      await ctx.db.insert("providerCatalogRepacks", {
        releaseId: template.releaseId,
        publicRepackId: activeOldestId,
        vendorId: template.vendorId,
        detail: { ...template.detail, publicRepackId: activeOldestId },
      });
      await ctx.db.insert("savedRepacks", {
        ownerTokenIdentifier: USER_A.tokenIdentifier,
        publicRepackId: activeOldestId,
      });
    });

    vi.setSystemTime("2026-08-14T12:00:01.000Z");
    await t.run(async (ctx) => {
      await ctx.db.insert("savedRepacks", {
        ownerTokenIdentifier: USER_A.tokenIdentifier,
        publicRepackId: unavailableOldestId,
      });
      await ctx.db.insert("savedRepacks", {
        ownerTokenIdentifier: USER_B.tokenIdentifier,
        publicRepackId: unavailableOldestId,
      });
      await ctx.db.insert("savedCollectibles", {
        ownerTokenIdentifier: USER_A.tokenIdentifier,
        publicCollectibleId: unavailableOldestId,
      });
    });

    vi.setSystemTime("2026-08-14T12:00:02.000Z");
    await t.run(async (ctx) => {
      for (const publicRepackId of unavailableNewerIds) {
        await ctx.db.insert("savedRepacks", {
          ownerTokenIdentifier: USER_A.tokenIdentifier,
          publicRepackId,
        });
      }
    });

    vi.setSystemTime("2026-08-14T12:00:03.000Z");
    await t.run(async (ctx) => {
      const template = await ctx.db.query("providerCatalogRepacks").first();
      if (template === null) {
        throw new Error("Expected a seeded active repack.");
      }
      await ctx.db.insert("providerCatalogRepacks", {
        releaseId: template.releaseId,
        publicRepackId: requestedId,
        vendorId: template.vendorId,
        detail: { ...template.detail, publicRepackId: requestedId },
      });
    });
    vi.useRealTimers();

    await expect(
      userA.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: requestedId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: true });
    const userAIds = await userA.query(api.savedItems.getSavedItemIds, {});
    expect(userAIds.savedRepackIds).toHaveLength(MAX_SAVED_ITEMS_PER_KIND);
    expect(userAIds.savedRepackIds).toContain(activeOldestId);
    expect(userAIds.savedRepackIds).toContain(requestedId);
    expect(userAIds.savedRepackIds).toContain(unavailableNewerIds[0]);
    expect(userAIds.savedRepackIds).not.toContain(unavailableOldestId);
    expect(userAIds.savedCollectibleIds).toEqual([unavailableOldestId]);
    await expect(
      userB.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: [unavailableOldestId],
      savedCollectibleIds: [],
    });
  });

  test("prunes the oldest unavailable collectible and uses public ID as a tie-break", async () => {
    const t = createTest();
    await seed(t);
    const user = t.withIdentity(USER_A);
    const staleIds = Array.from(
      { length: MAX_SAVED_ITEMS_PER_KIND },
      (_, index) => boundedPublicId("50000000", index),
    ).reverse();
    const expectedPrunedId = staleIds[0]!;
    const requestedId = boundedPublicId("60000000", 0);

    await t.run(async (ctx) => {
      const template = await ctx.db
        .query("providerCatalogCollectibles")
        .first();
      if (template === null) {
        throw new Error("Expected a seeded active collectible.");
      }
      for (const publicCollectibleId of staleIds) {
        await ctx.db.insert("savedCollectibles", {
          ownerTokenIdentifier: USER_A.tokenIdentifier,
          publicCollectibleId,
        });
      }
      await ctx.db.insert("providerCatalogCollectibles", {
        releaseId: template.releaseId,
        publicCollectibleId: requestedId,
        collectibleType: template.collectibleType,
        normalizedName: template.normalizedName,
        searchText: template.searchText,
        detail: { ...template.detail, publicCollectibleId: requestedId },
      });
    });
    expect(
      compareSavedItemCandidateOrder(
        100,
        boundedPublicId("50000000", 2),
        100,
        boundedPublicId("50000000", 1),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareSavedItemCandidateOrder(
        99,
        boundedPublicId("f0000000", 0),
        100,
        boundedPublicId("10000000", 0),
      ),
    ).toBeLessThan(0);

    await expect(
      user.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId: requestedId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: true });
    const result = await user.query(api.savedItems.getSavedItemIds, {});
    expect(result.savedCollectibleIds).toHaveLength(MAX_SAVED_ITEMS_PER_KIND);
    expect(result.savedCollectibleIds).toContain(requestedId);
    expect(result.savedCollectibleIds).not.toContain(expectedPrunedId);
    expect(
      staleIds
        .filter(
          (publicCollectibleId) => publicCollectibleId !== expectedPrunedId,
        )
        .every((publicCollectibleId) =>
          result.savedCollectibleIds.includes(publicCollectibleId),
        ),
    ).toBe(true);
  });

  test("enforces independent 250-item caps and returns bounded canonical arrays", async () => {
    const t = createTest();
    await seed(t);
    const user = t.withIdentity(USER_A);
    const repackIds = Array.from(
      { length: MAX_SAVED_ITEMS_PER_KIND + 1 },
      (_, index) => boundedPublicId("10000000", index),
    );
    const collectibleIds = Array.from(
      { length: MAX_SAVED_ITEMS_PER_KIND + 1 },
      (_, index) => boundedPublicId("20000000", index),
    );

    await t.run(async (ctx) => {
      const templateRepack = await ctx.db
        .query("providerCatalogRepacks")
        .first();
      const templateCollectible = await ctx.db
        .query("providerCatalogCollectibles")
        .first();
      if (templateRepack === null || templateCollectible === null) {
        throw new Error("Expected seeded resource templates.");
      }
      for (const [index, publicRepackId] of repackIds.entries()) {
        await ctx.db.insert("providerCatalogRepacks", {
          releaseId: templateRepack.releaseId,
          publicRepackId,
          vendorId: templateRepack.vendorId,
          detail: {
            ...templateRepack.detail,
            publicRepackId,
          },
        });
        if (index < MAX_SAVED_ITEMS_PER_KIND) {
          await ctx.db.insert("savedRepacks", {
            ownerTokenIdentifier: USER_A.tokenIdentifier,
            publicRepackId,
          });
        }
      }
      for (const [index, publicCollectibleId] of collectibleIds.entries()) {
        await ctx.db.insert("providerCatalogCollectibles", {
          releaseId: templateCollectible.releaseId,
          publicCollectibleId,
          collectibleType: templateCollectible.collectibleType,
          normalizedName: templateCollectible.normalizedName,
          searchText: templateCollectible.searchText,
          detail: {
            ...templateCollectible.detail,
            publicCollectibleId,
          },
        });
        if (index < MAX_SAVED_ITEMS_PER_KIND) {
          await ctx.db.insert("savedCollectibles", {
            ownerTokenIdentifier: USER_A.tokenIdentifier,
            publicCollectibleId,
          });
        }
      }
    });

    await expect(
      user.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: repackIds.slice(0, MAX_SAVED_ITEMS_PER_KIND),
      savedCollectibleIds: collectibleIds.slice(0, MAX_SAVED_ITEMS_PER_KIND),
    });
    await expectErrorCode(
      user.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: repackIds[MAX_SAVED_ITEMS_PER_KIND]!,
        saved: true,
      }),
      "SAVED_ITEM_LIMIT_REACHED",
    );
    await expectErrorCode(
      user.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId: collectibleIds[MAX_SAVED_ITEMS_PER_KIND]!,
        saved: true,
      }),
      "SAVED_ITEM_LIMIT_REACHED",
    );
    await expect(
      user.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: repackIds[0]!,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });
    await expect(
      user.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId: collectibleIds[0]!,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });
    await expect(
      user.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: repackIds.slice(0, MAX_SAVED_ITEMS_PER_KIND),
      savedCollectibleIds: collectibleIds.slice(0, MAX_SAVED_ITEMS_PER_KIND),
    });
  });
});
