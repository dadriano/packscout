/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import {
  getDirectoryRecord,
  listDirectoryPage,
} from "./productUserDirectory";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type DirectoryTest = TestConvex<typeof schema>;

const ALICE = "privy.io|did:privy:alice";
const BOB = "privy.io|did:privy:bob";
const CARA = "privy.io|did:privy:cara";
/** Owns saved items but was never recorded in the directory. */
const GHOST = "privy.io|did:privy:ghost";

const ADMIN_TOKEN = "packscout-admin-directory-token-000000000001";
const LIST_PATH = "/admin/product-users/list";
const RECORD_PATH = "/admin/product-users/record";

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function boundedPublicId(prefix: string, index: number): string {
  return `${prefix}-0000-5000-8000-${String(index).padStart(12, "0")}`;
}

async function seedDirectory(t: DirectoryTest): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("productUsers", {
      subject: ALICE,
      authMethod: "privy.io",
      email: "alice@example.com",
      walletAddress: "0xAbCdEf0123456789abcdef0123456789ABCDEF01",
      walletAddressKey: "0xabcdef0123456789abcdef0123456789abcdef01",
      firstSeenAt: "2026-08-01T09:00:00.000Z",
      lastSeenAt: "2026-08-19T12:00:00.000Z",
      standing: "active",
    });
    await ctx.db.insert("productUsers", {
      subject: BOB,
      authMethod: "privy.io",
      email: "bob@example.com",
      walletAddress: null,
      walletAddressKey: null,
      firstSeenAt: "2026-08-02T09:00:00.000Z",
      lastSeenAt: "2026-08-19T11:00:00.000Z",
      standing: "suspended",
    });
    await ctx.db.insert("productUsers", {
      subject: CARA,
      authMethod: "unknown",
      email: null,
      walletAddress: null,
      walletAddressKey: null,
      firstSeenAt: "2026-08-03T09:00:00.000Z",
      lastSeenAt: "2026-08-19T10:00:00.000Z",
      standing: "active",
    });

    for (const [ownerTokenIdentifier, repackCount] of [
      [ALICE, 3],
      [BOB, 1],
      [GHOST, 2],
    ] as const) {
      for (let index = 0; index < repackCount; index += 1) {
        await ctx.db.insert("savedRepacks", {
          ownerTokenIdentifier,
          publicRepackId: boundedPublicId("10000000", index),
        });
      }
    }
    for (let index = 0; index < 2; index += 1) {
      await ctx.db.insert("savedCollectibles", {
        ownerTokenIdentifier: ALICE,
        publicCollectibleId: boundedPublicId("20000000", index),
      });
    }
  });
}

function listPage(
  t: DirectoryTest,
  search: string | null,
  numItems: number,
  cursor: string | null = null,
) {
  return t.query(internal.productUserDirectory.listDirectoryPage, {
    search,
    paginationOpts: { numItems, cursor },
  });
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
  vi.unstubAllEnvs();
});

describe("privileged product-user directory reads", () => {
  test("pages the directory newest-seen first with accurate saved-item counts", async () => {
    const t = createTest();
    await seedDirectory(t);

    const first = await listPage(t, null, 2);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toEqual(expect.any(String));
    expect(first.searchTruncated).toBe(false);
    expect(first.page).toEqual([
      {
        subject: ALICE,
        authMethod: "privy.io",
        email: "alice@example.com",
        walletAddress: "0xAbCdEf0123456789abcdef0123456789ABCDEF01",
        firstSeenAt: "2026-08-01T09:00:00.000Z",
        lastSeenAt: "2026-08-19T12:00:00.000Z",
        standing: "active",
        savedRepackCount: 3,
        savedCollectibleCount: 2,
      },
      {
        subject: BOB,
        authMethod: "privy.io",
        email: "bob@example.com",
        walletAddress: null,
        firstSeenAt: "2026-08-02T09:00:00.000Z",
        lastSeenAt: "2026-08-19T11:00:00.000Z",
        standing: "suspended",
        savedRepackCount: 1,
        savedCollectibleCount: 0,
      },
    ]);
    // The lowercase wallet search key is storage detail, never a response field.
    expect(first.page[0]).not.toHaveProperty("walletAddressKey");

    const second = await listPage(t, null, 2, first.continueCursor);
    expect(second.isDone).toBe(true);
    expect(second.continueCursor).toBeNull();
    expect(second.page).toMatchObject([
      {
        subject: CARA,
        email: null,
        walletAddress: null,
        standing: "active",
        savedRepackCount: 0,
        savedCollectibleCount: 0,
      },
    ]);
  });

  test("reports an empty directory without inventing rows for orphan saved items", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("savedRepacks", {
        ownerTokenIdentifier: GHOST,
        publicRepackId: boundedPublicId("10000000", 0),
      });
    });

    await expect(listPage(t, null, 20)).resolves.toEqual({
      page: [],
      isDone: true,
      continueCursor: null,
      searchTruncated: false,
    });
  });

  test("bounds page sizes and rejects cursors from the other listing mode", async () => {
    const t = createTest();
    await seedDirectory(t);

    for (const numItems of [0, -1, 21, 2.5, 1_000]) {
      await expectErrorCode(
        listPage(t, null, numItems),
        "PRODUCT_USER_PAGE_SIZE_INVALID",
      );
    }
    await expectErrorCode(
      listPage(t, null, 2, "offset:2"),
      "PRODUCT_USER_PAGE_CURSOR_INVALID",
    );
    await expectErrorCode(
      listPage(t, "example.com", 2, "not-an-offset-cursor"),
      "PRODUCT_USER_PAGE_CURSOR_INVALID",
    );
    await expectErrorCode(
      listPage(t, "a".repeat(321), 2),
      "PRODUCT_USER_SEARCH_INVALID",
    );
  });

  test("searches by email, wallet address, and subject", async () => {
    const t = createTest();
    await seedDirectory(t);

    const byEmail = await listPage(t, "  ALICE@Example.com ", 20);
    expect(byEmail.page.map(({ subject }) => subject)).toEqual([ALICE]);
    expect(byEmail.isDone).toBe(true);
    expect(byEmail.searchTruncated).toBe(false);

    const byEmailPrefix = await listPage(t, "bo", 20);
    expect(byEmailPrefix.page.map(({ subject }) => subject)).toEqual([BOB]);

    const byWallet = await listPage(t, "0xABCDEF0123", 20);
    expect(byWallet.page.map(({ subject }) => subject)).toEqual([ALICE]);

    const bySubject = await listPage(t, "privy.io|did:privy:c", 20);
    expect(bySubject.page.map(({ subject }) => subject)).toEqual([CARA]);

    const everySubject = await listPage(t, "privy.io|", 20);
    expect(everySubject.page.map(({ subject }) => subject)).toEqual([
      ALICE,
      BOB,
      CARA,
    ]);

    await expect(listPage(t, "nobody@example.com", 20)).resolves.toEqual({
      page: [],
      isDone: true,
      continueCursor: null,
      searchTruncated: false,
    });
    await expect(listPage(t, "   ", 20)).resolves.toMatchObject({
      page: expect.arrayContaining([expect.objectContaining({ subject: CARA })]),
    });
  });

  test("pages search results in recency order with bounded pages", async () => {
    const t = createTest();
    await seedDirectory(t);

    const first = await listPage(t, "privy.io|", 2);
    expect(first.page.map(({ subject }) => subject)).toEqual([ALICE, BOB]);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toBe("offset:2");

    const second = await listPage(t, "privy.io|", 2, first.continueCursor);
    expect(second.page.map(({ subject }) => subject)).toEqual([CARA]);
    expect(second.isDone).toBe(true);
    expect(second.continueCursor).toBeNull();
  });

  test("looks up a single record by subject", async () => {
    const t = createTest();
    await seedDirectory(t);

    await expect(
      t.query(internal.productUserDirectory.getDirectoryRecord, {
        subject: BOB,
      }),
    ).resolves.toEqual({
      subject: BOB,
      authMethod: "privy.io",
      email: "bob@example.com",
      walletAddress: null,
      firstSeenAt: "2026-08-02T09:00:00.000Z",
      lastSeenAt: "2026-08-19T11:00:00.000Z",
      standing: "suspended",
    });
    await expect(
      t.query(internal.productUserDirectory.getDirectoryRecord, {
        subject: GHOST,
      }),
    ).resolves.toBeNull();
    await expectErrorCode(
      t.query(internal.productUserDirectory.getDirectoryRecord, {
        subject: "",
      }),
      "PRODUCT_USER_SUBJECT_INVALID",
    );
    await expectErrorCode(
      t.query(internal.productUserDirectory.getDirectoryRecord, {
        subject: "a".repeat(1_025),
      }),
      "PRODUCT_USER_SUBJECT_INVALID",
    );
  });

  test("keeps both privileged reads out of the public API", () => {
    for (const registered of [listDirectoryPage, getDirectoryRecord]) {
      const visibility = registered as unknown as {
        isPublic?: boolean;
        isInternal?: boolean;
      };
      expect(visibility.isInternal).toBe(true);
      expect(visibility.isPublic).toBeUndefined();
    }
  });
});

describe("admin directory integration transport", () => {
  async function post(
    t: DirectoryTest,
    path: string,
    body: unknown,
    authorization?: string,
  ): Promise<Response> {
    return await t.fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined
          ? {}
          : { authorization: authorization }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  const listBody = { search: null, paginationOpts: { numItems: 20, cursor: null } };

  test("refuses every caller without the configured deployment secret", async () => {
    const t = createTest();
    await seedDirectory(t);

    // No secret configured: the surface fails closed even with a plausible token.
    const unconfigured = await post(
      t,
      LIST_PATH,
      listBody,
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
      "Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.product-user-access-token",
      ADMIN_TOKEN,
    ]) {
      const response = await post(t, LIST_PATH, listBody, authorization);
      expect(response.status).toBe(401);
    }
    for (const path of [LIST_PATH, RECORD_PATH]) {
      const response = await post(t, path, { subject: ALICE }, undefined);
      expect(response.status).toBe(401);
    }
  });

  test("refuses a secret that is too short to be safe", async () => {
    const t = createTest();
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", "short-token");
    const response = await post(t, LIST_PATH, listBody, "Bearer short-token");
    expect(response.status).toBe(401);
  });

  test("serves the directory listing and record lookup to the admin server", async () => {
    const t = createTest();
    await seedDirectory(t);
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);

    const listed = await post(
      t,
      LIST_PATH,
      { search: "alice", paginationOpts: { numItems: 20, cursor: null } },
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      page: [
        {
          subject: ALICE,
          authMethod: "privy.io",
          email: "alice@example.com",
          walletAddress: "0xAbCdEf0123456789abcdef0123456789ABCDEF01",
          firstSeenAt: "2026-08-01T09:00:00.000Z",
          lastSeenAt: "2026-08-19T12:00:00.000Z",
          standing: "active",
          savedRepackCount: 3,
          savedCollectibleCount: 2,
        },
      ],
      isDone: true,
      continueCursor: null,
      searchTruncated: false,
    });

    const record = await post(
      t,
      RECORD_PATH,
      { subject: CARA },
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(record.status).toBe(200);
    expect(await record.json()).toMatchObject({
      record: { subject: CARA, standing: "active", email: null },
    });

    const missing = await post(
      t,
      RECORD_PATH,
      { subject: GHOST },
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(await missing.json()).toEqual({ record: null });
  });

  test("maps malformed and refused requests without leaking backend errors", async () => {
    const t = createTest();
    await seedDirectory(t);
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);
    const authorization = `Bearer ${ADMIN_TOKEN}`;

    for (const body of [
      "not-json",
      [],
      { search: null },
      { search: 42, paginationOpts: { numItems: 5, cursor: null } },
      { search: null, paginationOpts: { numItems: "5", cursor: null } },
      { search: null, paginationOpts: { numItems: 5, cursor: 7 } },
    ]) {
      const response = await post(t, LIST_PATH, body, authorization);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "ADMIN_DIRECTORY_REQUEST_INVALID",
      });
    }

    const oversizedPage = await post(
      t,
      LIST_PATH,
      { search: null, paginationOpts: { numItems: 500, cursor: null } },
      authorization,
    );
    expect(oversizedPage.status).toBe(400);
    expect(await oversizedPage.json()).toEqual({
      error: "The product-user directory request was rejected.",
      code: "PRODUCT_USER_PAGE_SIZE_INVALID",
    });

    const emptySubject = await post(
      t,
      RECORD_PATH,
      { subject: "" },
      authorization,
    );
    expect(emptySubject.status).toBe(400);
    expect(await emptySubject.json()).toMatchObject({
      code: "PRODUCT_USER_SUBJECT_INVALID",
    });
  });

  test("exposes no other method or path", async () => {
    const t = createTest();
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);

    const wrongMethod = await t.fetch(LIST_PATH, {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(wrongMethod.status).toBe(404);

    const wrongPath = await post(
      t,
      "/admin/product-users",
      listBody,
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(wrongPath.status).toBe(404);
  });
});
