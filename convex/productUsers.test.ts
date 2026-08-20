/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import {
  getMyStanding,
  recordSignIn,
} from "./productUsers";
import {
  deriveProductUserAttributes,
  normalizeProductUserAuthMethod,
  normalizeProductUserEmail,
  normalizeProductUserSearchTerm,
  normalizeProductUserWalletAddress,
  PRODUCT_USER_MAX_SUBJECT_LENGTH,
  requireProductUserSubject,
} from "./productUserRecords";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type ProductUsersTest = TestConvex<typeof schema>;

const USER_A = {
  subject: "did:privy:user-a",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:user-a",
};
const USER_B = {
  subject: "did:privy:user-b",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:user-b",
};
const USER_A_WITH_ATTRIBUTES = {
  ...USER_A,
  email: "  Alice@Example.COM ",
  wallet_address: "0xAbCdEf0123456789abcdef0123456789ABCDEF01",
};

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

async function readProductUsers(t: ProductUsersTest) {
  return await t.run(async (ctx) => await ctx.db.query("productUsers").take(5));
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

afterEach(() => {
  vi.useRealTimers();
});

describe("product-user sign-up records", () => {
  test("creates one active record on first authenticated contact", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-19T10:00:00.000Z");
    const t = createTest();

    await expect(
      t
        .withIdentity(USER_A_WITH_ATTRIBUTES)
        .mutation(api.productUsers.recordSignIn, {}),
    ).resolves.toEqual({ created: true, standing: "active" });

    const records = await readProductUsers(t);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      subject: USER_A.tokenIdentifier,
      authMethod: "privy.io",
      email: "alice@example.com",
      walletAddress: "0xAbCdEf0123456789abcdef0123456789ABCDEF01",
      walletAddressKey: "0xabcdef0123456789abcdef0123456789abcdef01",
      firstSeenAt: "2026-08-19T10:00:00.000Z",
      lastSeenAt: "2026-08-19T10:00:00.000Z",
      standing: "active",
    });
  });

  test("keys the record on the same identity that owns saved items", async () => {
    const t = createTest();
    await t.withIdentity(USER_A).mutation(api.productUsers.recordSignIn, {});
    await t.run(async (ctx) => {
      await ctx.db.insert("savedRepacks", {
        ownerTokenIdentifier: USER_A.tokenIdentifier,
        publicRepackId: "10000000-0000-5000-8000-000000000001",
      });
    });

    const [record] = await readProductUsers(t);
    const savedRepack = await t.run(
      async (ctx) => await ctx.db.query("savedRepacks").first(),
    );
    expect(record?.subject).toBe(savedRepack?.ownerTokenIdentifier);
  });

  test("refreshes last-seen and newly exposed attributes without duplicating", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-19T10:00:00.000Z");
    const t = createTest();
    await t.withIdentity(USER_A).mutation(api.productUsers.recordSignIn, {});

    // A repeat sign-in inside the refresh window keeps the stored last-seen.
    vi.setSystemTime("2026-08-19T10:00:05.000Z");
    await expect(
      t.withIdentity(USER_A).mutation(api.productUsers.recordSignIn, {}),
    ).resolves.toEqual({ created: false, standing: "active" });
    expect((await readProductUsers(t))[0]).toMatchObject({
      email: null,
      walletAddress: null,
      lastSeenAt: "2026-08-19T10:00:00.000Z",
    });

    vi.setSystemTime("2026-08-19T11:30:00.000Z");
    await expect(
      t
        .withIdentity(USER_A_WITH_ATTRIBUTES)
        .mutation(api.productUsers.recordSignIn, {}),
    ).resolves.toEqual({ created: false, standing: "active" });

    const records = await readProductUsers(t);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      email: "alice@example.com",
      walletAddress: "0xAbCdEf0123456789abcdef0123456789ABCDEF01",
      firstSeenAt: "2026-08-19T10:00:00.000Z",
      lastSeenAt: "2026-08-19T11:30:00.000Z",
      standing: "active",
    });
  });

  test("never erases attributes a later sign-in stops exposing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-19T10:00:00.000Z");
    const t = createTest();
    await t
      .withIdentity(USER_A_WITH_ATTRIBUTES)
      .mutation(api.productUsers.recordSignIn, {});

    vi.setSystemTime("2026-08-19T12:00:00.000Z");
    await t.withIdentity(USER_A).mutation(api.productUsers.recordSignIn, {});

    expect((await readProductUsers(t))[0]).toMatchObject({
      email: "alice@example.com",
      walletAddress: "0xAbCdEf0123456789abcdef0123456789ABCDEF01",
      lastSeenAt: "2026-08-19T12:00:00.000Z",
    });
  });

  test("establishes exactly one record under concurrent session establishment", async () => {
    const t = createTest();
    const user = t.withIdentity(USER_A);

    const results = await Promise.all([
      user.mutation(api.productUsers.recordSignIn, {}),
      user.mutation(api.productUsers.recordSignIn, {}),
      user.mutation(api.productUsers.recordSignIn, {}),
      user.mutation(api.productUsers.recordSignIn, {}),
    ]);

    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(await readProductUsers(t)).toHaveLength(1);
  });

  test("fails closed when a subject somehow holds duplicate records", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      for (const _duplicate of [1, 2]) {
        await ctx.db.insert("productUsers", {
          subject: USER_A.tokenIdentifier,
          authMethod: "privy.io",
          email: null,
          walletAddress: null,
          walletAddressKey: null,
          firstSeenAt: "2026-08-19T10:00:00.000Z",
          lastSeenAt: "2026-08-19T10:00:00.000Z",
          standing: "active",
        });
      }
    });

    await expectErrorCode(
      t.withIdentity(USER_A).mutation(api.productUsers.recordSignIn, {}),
      "PRODUCT_USER_STATE_CONFLICT",
    );
    await expectErrorCode(
      t.withIdentity(USER_A).query(api.productUsers.getMyStanding, {}),
      "PRODUCT_USER_STATE_CONFLICT",
    );
  });

  test("rejects unauthenticated recording and standing reads", async () => {
    const t = createTest();

    await expectErrorCode(
      t.mutation(api.productUsers.recordSignIn, {}),
      "AUTH_REQUIRED",
    );
    await expectErrorCode(
      t.query(api.productUsers.getMyStanding, {}),
      "AUTH_REQUIRED",
    );
    expect(await readProductUsers(t)).toHaveLength(0);
  });

  test("returns only the caller's own standing", async () => {
    const t = createTest();
    await t.withIdentity(USER_A).mutation(api.productUsers.recordSignIn, {});
    await t.withIdentity(USER_B).mutation(api.productUsers.recordSignIn, {});
    await t.run(async (ctx) => {
      const suspended = await ctx.db
        .query("productUsers")
        .withIndex("by_subject", (index) =>
          index.eq("subject", USER_A.tokenIdentifier),
        )
        .unique();
      if (suspended === null) throw new Error("Expected a recorded user.");
      await ctx.db.patch("productUsers", suspended._id, {
        standing: "suspended",
      });
    });

    await expect(
      t.withIdentity(USER_A).query(api.productUsers.getMyStanding, {}),
    ).resolves.toEqual({ standing: "suspended" });
    await expect(
      t.withIdentity(USER_B).query(api.productUsers.getMyStanding, {}),
    ).resolves.toEqual({ standing: "active" });
  });

  test("tolerates saved items owned by an identity with no record", async () => {
    const t = createTest();
    const publicRepackId = "10000000-0000-5000-8000-000000000002";
    await t.run(async (ctx) => {
      await ctx.db.insert("savedRepacks", {
        ownerTokenIdentifier: USER_A.tokenIdentifier,
        publicRepackId,
      });
    });

    const user = t.withIdentity(USER_A);
    await expect(user.query(api.savedItems.getSavedItemIds, {})).resolves.toEqual(
      { savedRepackIds: [publicRepackId], savedCollectibleIds: [] },
    );
    await expect(
      user.query(api.productUsers.getMyStanding, {}),
    ).resolves.toEqual({ standing: "active" });
    expect(await readProductUsers(t)).toHaveLength(0);

    await expect(
      user.mutation(api.productUsers.recordSignIn, {}),
    ).resolves.toEqual({ created: true, standing: "active" });
    expect(await readProductUsers(t)).toHaveLength(1);
    await expect(user.query(api.savedItems.getSavedItemIds, {})).resolves.toEqual(
      { savedRepackIds: [publicRepackId], savedCollectibleIds: [] },
    );
  });

  test("exposes only recording and self-standing reads publicly", () => {
    for (const registered of [recordSignIn, getMyStanding]) {
      const visibility = registered as unknown as {
        isPublic?: boolean;
        isInternal?: boolean;
      };
      expect(visibility.isPublic).toBe(true);
      expect(visibility.isInternal).toBeUndefined();
    }
  });
});

describe("product-user attribute normalization", () => {
  test("derives every stored attribute from the verified identity", () => {
    expect(
      deriveProductUserAttributes({
        ...USER_A_WITH_ATTRIBUTES,
      } as never),
    ).toEqual({
      subject: USER_A.tokenIdentifier,
      authMethod: "privy.io",
      email: "alice@example.com",
      walletAddress: "0xAbCdEf0123456789abcdef0123456789ABCDEF01",
      walletAddressKey: "0xabcdef0123456789abcdef0123456789abcdef01",
    });
  });

  test("drops malformed optional attributes instead of storing them", () => {
    for (const malformed of [
      undefined,
      null,
      42,
      "",
      "   ",
      "not-an-email",
      "spaced address@example.com",
      `${"a".repeat(320)}@example.com`,
    ]) {
      expect(normalizeProductUserEmail(malformed)).toBeNull();
    }
    for (const malformed of [undefined, null, 7, "", "  ", "0x with space"]) {
      expect(normalizeProductUserWalletAddress(malformed)).toBeNull();
    }
    expect(normalizeProductUserWalletAddress("  0xAbC  ")).toBe("0xAbC");
    expect(normalizeProductUserAuthMethod(undefined)).toBe("unknown");
    expect(normalizeProductUserAuthMethod("Privy.IO")).toBe("privy.io");
  });

  test("requires a bounded, server-derived subject", () => {
    expect(requireProductUserSubject("privy.io|did:privy:user-a")).toBe(
      "privy.io|did:privy:user-a",
    );
    for (const malformed of [
      undefined,
      "",
      "a".repeat(PRODUCT_USER_MAX_SUBJECT_LENGTH + 1),
    ]) {
      expect(() => requireProductUserSubject(malformed)).toThrow();
    }
  });

  test("treats blank search terms as an unfiltered listing", () => {
    expect(normalizeProductUserSearchTerm(null)).toBeNull();
    expect(normalizeProductUserSearchTerm("   ")).toBeNull();
    expect(normalizeProductUserSearchTerm(" Alice ")).toMatchObject({
      verbatim: "Alice",
      lowercase: "alice",
    });
    expect(() => normalizeProductUserSearchTerm("a".repeat(321))).toThrow();
  });
});
