/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  createEntry,
  listEntriesPage,
  removeEntry,
  updateEntry,
} from "./betaAllowlist";
import type { ProductUserAccessDecision } from "./productUserRecords";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type BetaAllowlistTest = TestConvex<typeof schema>;

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
const USER_C = {
  subject: "did:privy:user-c",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:user-c",
};
const USER_D = {
  subject: "did:privy:user-d",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:user-d",
};

const OPERATOR = "operator-1";
const INVITED_EMAIL = "invited@example.com";
const WALLET_CHECKSUMMED = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
const WALLET_LOWERCASE = "0xabcdef0123456789abcdef0123456789abcdef01";
const OTHER_WALLET_LOWER = "0xffffeeeeddddccccbbbbaaaa9999888877776666";
const OTHER_WALLET_UPPER = "0xFFFFEEEEDDDDCCCCBBBBAAAA9999888877776666";

const ADMIN_TOKEN = "packscout-admin-directory-token-000000000001";
const LIST_PATH = "/admin/beta-allowlist/list";
const CREATE_PATH = "/admin/beta-allowlist/create";
const UPDATE_PATH = "/admin/beta-allowlist/update";
const REMOVE_PATH = "/admin/beta-allowlist/remove";

const AWAITING_REVIEW = { admitted: false, reason: "awaiting_review" };
const ADMITTED = { admitted: true, reason: "approved" };

/** The decision shape sign-ins recorded while waiting for review carry. */
const WAITING_BY_DEFAULT: ProductUserAccessDecision = {
  state: "awaiting_review",
  decidedBy: "default",
  decidedAt: "2026-08-10T09:00:00.000Z",
};

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function closeBeta() {
  vi.stubEnv("PACKSCOUT_CLOSED_BETA", "1");
}

function addEntry(
  t: BetaAllowlistTest,
  overrides: Partial<{
    email: string | null;
    walletAddress: string | null;
    label: string | null;
    operatorId: string;
  }> = {},
) {
  return t.mutation(internal.betaAllowlist.createEntry, {
    email: null,
    walletAddress: null,
    label: null,
    operatorId: OPERATOR,
    ...overrides,
  });
}

function listPage(
  t: BetaAllowlistTest,
  search: string | null,
  numItems: number,
  cursor: string | null = null,
) {
  return t.query(internal.betaAllowlist.listEntriesPage, {
    search,
    paginationOpts: { numItems, cursor },
  });
}

async function readEntries(t: BetaAllowlistTest) {
  return await t.run(
    async (ctx) => await ctx.db.query("betaAllowlistEntries").take(30),
  );
}

async function findRecord(t: BetaAllowlistTest, subject: string) {
  return await t.run(
    async (ctx) =>
      await ctx.db
        .query("productUsers")
        .withIndex("by_subject", (index) => index.eq("subject", subject))
        .unique(),
  );
}

async function insertProductUser(
  t: BetaAllowlistTest,
  seed: {
    subject: string;
    email?: string | null;
    walletAddress?: string | null;
    /** Omit entirely to seed a record from before the closed beta existed. */
    access?: ProductUserAccessDecision;
    standing?: "active" | "suspended";
  },
): Promise<void> {
  await t.run(async (ctx) => {
    const walletAddress = seed.walletAddress ?? null;
    await ctx.db.insert("productUsers", {
      subject: seed.subject,
      authMethod: "privy.io",
      email: seed.email ?? null,
      walletAddress,
      walletAddressKey:
        walletAddress === null ? null : walletAddress.toLowerCase(),
      firstSeenAt: "2026-08-10T09:00:00.000Z",
      lastSeenAt: "2026-08-10T09:00:00.000Z",
      standing: seed.standing ?? "active",
      ...(seed.access === undefined ? {} : { access: seed.access }),
    });
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
  vi.useRealTimers();
});

describe("beta-allowlist entry maintenance", () => {
  test("creates entries with an email, a wallet address, or both, normalizing identifiers on the way in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-21T10:00:00.000Z");
    const t = createTest();

    const byEmail = await addEntry(t, {
      email: "  Invited@Example.COM ",
      label: "  design partner  ",
    });
    expect(byEmail.admittedCount).toBe(0);
    expect(byEmail.entry).toEqual({
      entryId: expect.any(String),
      email: INVITED_EMAIL,
      walletAddress: null,
      label: "design partner",
      createdAt: "2026-08-21T10:00:00.000Z",
      updatedAt: "2026-08-21T10:00:00.000Z",
      createdByOperatorId: OPERATOR,
    });

    const byWallet = await addEntry(t, { walletAddress: WALLET_CHECKSUMMED });
    expect(byWallet.entry).toMatchObject({
      email: null,
      walletAddress: WALLET_CHECKSUMMED,
      label: null,
    });
    // The lowercase match key is storage detail, never a response field.
    expect(byWallet.entry).not.toHaveProperty("walletAddressKey");

    const byBoth = await addEntry(t, {
      email: "both@example.com",
      walletAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(byBoth.entry).toMatchObject({
      email: "both@example.com",
      walletAddress: "0x1111111111111111111111111111111111111111",
    });

    const stored = await readEntries(t);
    expect(stored).toHaveLength(3);
    // Wallet casing is preserved for display while the key matches lowercase.
    expect(
      stored.find((entry) => entry._id === byWallet.entry.entryId),
    ).toMatchObject({
      walletAddress: WALLET_CHECKSUMMED,
      walletAddressKey: WALLET_LOWERCASE,
    });
  });

  test("refuses an entry with no identifier or malformed fields, creating nothing", async () => {
    const t = createTest();

    await expectErrorCode(addEntry(t), "BETA_ALLOWLIST_IDENTIFIER_REQUIRED");
    await expectErrorCode(
      addEntry(t, { email: "not-an-email" }),
      "BETA_ALLOWLIST_EMAIL_INVALID",
    );
    await expectErrorCode(
      addEntry(t, { email: "spaced address@example.com" }),
      "BETA_ALLOWLIST_EMAIL_INVALID",
    );
    await expectErrorCode(
      addEntry(t, { walletAddress: "0x with space" }),
      "BETA_ALLOWLIST_WALLET_ADDRESS_INVALID",
    );
    await expectErrorCode(
      addEntry(t, { email: INVITED_EMAIL, label: "x".repeat(121) }),
      "BETA_ALLOWLIST_LABEL_INVALID",
    );
    await expectErrorCode(
      addEntry(t, { email: INVITED_EMAIL, operatorId: "   " }),
      "BETA_ALLOWLIST_OPERATOR_INVALID",
    );
    await expectErrorCode(
      addEntry(t, { email: INVITED_EMAIL, operatorId: "x".repeat(129) }),
      "BETA_ALLOWLIST_OPERATOR_INVALID",
    );
    expect(await readEntries(t)).toHaveLength(0);
  });

  test("rejects a duplicate normalized identifier without a shadow entry or an overwrite", async () => {
    const t = createTest();
    const first = await addEntry(t, { email: INVITED_EMAIL, label: "original" });
    await addEntry(t, { walletAddress: WALLET_CHECKSUMMED });

    // Same address in different casing and padding is the same identifier.
    await expectErrorCode(
      addEntry(t, { email: "  INVITED@example.COM " }),
      "BETA_ALLOWLIST_DUPLICATE_EMAIL",
    );
    await expectErrorCode(
      addEntry(t, { walletAddress: WALLET_LOWERCASE }),
      "BETA_ALLOWLIST_DUPLICATE_WALLET_ADDRESS",
    );
    // A combined entry cannot smuggle a taken identifier in either slot.
    await expectErrorCode(
      addEntry(t, {
        email: "fresh@example.com",
        walletAddress: WALLET_CHECKSUMMED.toUpperCase(),
      }),
      "BETA_ALLOWLIST_DUPLICATE_WALLET_ADDRESS",
    );

    const entries = await readEntries(t);
    expect(entries).toHaveLength(2);
    expect(
      entries.find((entry) => entry._id === first.entry.entryId),
    ).toMatchObject({ email: INVITED_EMAIL, label: "original" });
  });

  test("updates an entry in place, keeping creation facts and refusing duplicates against other entries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-21T10:00:00.000Z");
    const t = createTest();
    const a = await addEntry(t, { email: "a@example.com", label: "first" });
    const b = await addEntry(t, { email: "b@example.com" });

    vi.setSystemTime("2026-08-21T11:00:00.000Z");
    const relabeled = await t.mutation(internal.betaAllowlist.updateEntry, {
      entryId: a.entry.entryId,
      label: "renamed",
    });
    expect(relabeled.entry).toEqual({
      entryId: a.entry.entryId,
      email: "a@example.com",
      walletAddress: null,
      label: "renamed",
      createdAt: "2026-08-21T10:00:00.000Z",
      updatedAt: "2026-08-21T11:00:00.000Z",
      createdByOperatorId: OPERATOR,
    });

    // A change-free update leaves the edit timestamp alone.
    vi.setSystemTime("2026-08-21T12:00:00.000Z");
    const untouched = await t.mutation(internal.betaAllowlist.updateEntry, {
      entryId: a.entry.entryId,
    });
    expect(untouched.entry?.updatedAt).toBe("2026-08-21T11:00:00.000Z");

    // Keeping your own identifier is not a duplicate of yourself; taking
    // another entry's is, and normalization applies before the comparison.
    await t.mutation(internal.betaAllowlist.updateEntry, {
      entryId: a.entry.entryId,
      email: "a@example.com",
    });
    await expectErrorCode(
      t.mutation(internal.betaAllowlist.updateEntry, {
        entryId: a.entry.entryId,
        email: " B@Example.com ",
      }),
      "BETA_ALLOWLIST_DUPLICATE_EMAIL",
    );
    // The last identifier cannot be cleared away.
    await expectErrorCode(
      t.mutation(internal.betaAllowlist.updateEntry, {
        entryId: a.entry.entryId,
        email: null,
      }),
      "BETA_ALLOWLIST_IDENTIFIER_REQUIRED",
    );
    await expectErrorCode(
      t.mutation(internal.betaAllowlist.updateEntry, {
        entryId: "not-an-entry-id",
      }),
      "BETA_ALLOWLIST_ENTRY_INVALID",
    );

    expect(
      (await readEntries(t)).find((entry) => entry._id === b.entry.entryId),
    ).toMatchObject({ email: "b@example.com" });
  });

  test("removes entries idempotently; updating a vanished entry reports null rather than failing", async () => {
    const t = createTest();
    const created = await addEntry(t, { email: INVITED_EMAIL });

    await expect(
      t.mutation(internal.betaAllowlist.removeEntry, {
        entryId: created.entry.entryId,
      }),
    ).resolves.toEqual({ removed: true });
    expect(await readEntries(t)).toHaveLength(0);

    await expect(
      t.mutation(internal.betaAllowlist.removeEntry, {
        entryId: created.entry.entryId,
      }),
    ).resolves.toEqual({ removed: false });
    await expect(
      t.mutation(internal.betaAllowlist.updateEntry, {
        entryId: created.entry.entryId,
        label: "late edit",
      }),
    ).resolves.toEqual({ entry: null, admittedCount: 0 });
    await expectErrorCode(
      t.mutation(internal.betaAllowlist.removeEntry, {
        entryId: "not-an-entry-id",
      }),
      "BETA_ALLOWLIST_ENTRY_INVALID",
    );
  });
});

describe("establishment-time allowlist matching", () => {
  test("admits a first sign-in whose verified email matches an entry, with provenance naming it", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-21T10:00:00.000Z");
    const t = createTest();
    const { entry } = await addEntry(t, { email: INVITED_EMAIL });

    vi.setSystemTime("2026-08-21T12:00:00.000Z");
    await expect(
      t
        .withIdentity({ ...USER_A, email: "  Invited@Example.COM " })
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(ADMITTED);

    const record = await findRecord(t, USER_A.tokenIdentifier);
    expect(record?.access).toEqual({
      state: "approved",
      decidedBy: "allowlist",
      decidedAt: "2026-08-21T12:00:00.000Z",
      allowlistEntryId: entry.entryId,
    });
  });

  test("matches a verified wallet address case-insensitively in both directions", async () => {
    closeBeta();
    const t = createTest();
    await addEntry(t, { walletAddress: WALLET_CHECKSUMMED });
    await addEntry(t, { walletAddress: OTHER_WALLET_LOWER });

    // Checksum-cased entry, lowercase claim.
    await expect(
      t
        .withIdentity({ ...USER_A, wallet_address: WALLET_LOWERCASE })
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(ADMITTED);
    // Lowercase entry, upper-cased claim.
    await expect(
      t
        .withIdentity({ ...USER_B, wallet_address: OTHER_WALLET_UPPER })
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(ADMITTED);
  });

  test("never admits an identity without a verified matching identifier", async () => {
    closeBeta();
    const t = createTest();
    await addEntry(t, {
      email: INVITED_EMAIL,
      walletAddress: WALLET_CHECKSUMMED,
    });

    // No verified attributes at all: nothing binds the entry to this caller.
    await expect(
      t.withIdentity(USER_B).mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(AWAITING_REVIEW);
    expect((await findRecord(t, USER_B.tokenIdentifier))?.access).toMatchObject(
      { state: "awaiting_review", decidedBy: "default" },
    );

    // A different verified email does not match.
    await expect(
      t
        .withIdentity({ ...USER_C, email: "someone-else@example.com" })
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(AWAITING_REVIEW);

    // And no argument exists through which a caller could assert one.
    await expect(
      t.withIdentity(USER_B).mutation(api.productUserAccess.establishAccess, {
        email: INVITED_EMAIL,
      } as never),
    ).rejects.toThrow(/unexpected field/i);
  });

  test("admits an already-waiting identity the moment a later contact verifies a listed identifier", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-21T10:00:00.000Z");
    const t = createTest();
    await addEntry(t, { email: INVITED_EMAIL });

    await expect(
      t.withIdentity(USER_A).mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(AWAITING_REVIEW);

    // Five seconds later — inside the last-seen refresh window — the provider
    // exposes the verified email. Admission is not gated on that window.
    vi.setSystemTime("2026-08-21T10:00:05.000Z");
    await expect(
      t
        .withIdentity({ ...USER_A, email: INVITED_EMAIL })
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(ADMITTED);
    expect((await findRecord(t, USER_A.tokenIdentifier))?.access).toMatchObject(
      { state: "approved", decidedBy: "allowlist" },
    );
  });

  test("recordSignIn shares the establishment path, so allowlisted first contacts are admitted", async () => {
    closeBeta();
    const t = createTest();
    const { entry } = await addEntry(t, { email: INVITED_EMAIL });

    await t
      .withIdentity({ ...USER_A, email: INVITED_EMAIL })
      .mutation(api.productUsers.recordSignIn, {});
    expect((await findRecord(t, USER_A.tokenIdentifier))?.access).toEqual({
      state: "approved",
      decidedBy: "allowlist",
      decidedAt: expect.any(String),
      allowlistEntryId: entry.entryId,
    });
  });

  test("never overturns a declined decision, no matter what the list says", async () => {
    closeBeta();
    const t = createTest();
    await addEntry(t, { email: INVITED_EMAIL });
    const declinedByOperator: ProductUserAccessDecision = {
      state: "declined",
      decidedBy: "operator",
      decidedAt: "2026-08-21T11:00:00.000Z",
      operatorId: "operator-9",
    };
    await insertProductUser(t, {
      subject: USER_A.tokenIdentifier,
      email: INVITED_EMAIL,
      access: declinedByOperator,
    });

    await expect(
      t
        .withIdentity({ ...USER_A, email: INVITED_EMAIL })
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual({ admitted: false, reason: "declined" });
    expect((await findRecord(t, USER_A.tokenIdentifier))?.access).toEqual(
      declinedByOperator,
    );
  });

  test("maintains allowlist decisions even while the beta switch is off", async () => {
    const t = createTest();
    const { entry } = await addEntry(t, { email: INVITED_EMAIL });

    // Everyone is admitted while the product is public, but the decision is
    // still recorded, so turning the beta on later honors the invitation.
    await expect(
      t
        .withIdentity({ ...USER_A, email: INVITED_EMAIL })
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(ADMITTED);
    expect((await findRecord(t, USER_A.tokenIdentifier))?.access).toMatchObject(
      {
        state: "approved",
        decidedBy: "allowlist",
        allowlistEntryId: entry.entryId,
      },
    );
  });

  test("an entry can predate its person; removal stops future admission and evicts nobody", async () => {
    closeBeta();
    const t = createTest();
    const { entry } = await addEntry(t, { email: INVITED_EMAIL });

    // The invited person has never signed in; first contact simply admits.
    await expect(
      t
        .withIdentity({ ...USER_A, email: INVITED_EMAIL })
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(ADMITTED);

    await t.mutation(internal.betaAllowlist.removeEntry, {
      entryId: entry.entryId,
    });

    // The admitted account stays admitted with its provenance intact.
    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual(ADMITTED);
    expect((await findRecord(t, USER_A.tokenIdentifier))?.access).toMatchObject(
      { decidedBy: "allowlist", allowlistEntryId: entry.entryId },
    );

    // A new identity with the same verified email is no longer auto-admitted.
    await expect(
      t
        .withIdentity({ ...USER_B, email: INVITED_EMAIL })
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(AWAITING_REVIEW);
  });
});

describe("retroactive admission", () => {
  test("adding an entry immediately admits matching awaiting-review accounts and reports the count", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-21T10:00:00.000Z");
    const t = createTest();
    // A waits with the email; B waits with the wallet (different casing); C
    // waits with an unrelated email; D predates the closed beta entirely.
    await insertProductUser(t, {
      subject: USER_A.tokenIdentifier,
      email: INVITED_EMAIL,
      access: WAITING_BY_DEFAULT,
    });
    await insertProductUser(t, {
      subject: USER_B.tokenIdentifier,
      walletAddress: WALLET_LOWERCASE,
      access: WAITING_BY_DEFAULT,
    });
    await insertProductUser(t, {
      subject: USER_C.tokenIdentifier,
      email: "other@example.com",
      access: WAITING_BY_DEFAULT,
    });
    await insertProductUser(t, {
      subject: USER_D.tokenIdentifier,
      email: INVITED_EMAIL,
    });

    const { entry, admittedCount } = await addEntry(t, {
      email: INVITED_EMAIL,
      walletAddress: WALLET_CHECKSUMMED,
    });
    expect(admittedCount).toBe(3);

    for (const subject of [
      USER_A.tokenIdentifier,
      USER_B.tokenIdentifier,
      USER_D.tokenIdentifier,
    ]) {
      expect((await findRecord(t, subject))?.access).toEqual({
        state: "approved",
        decidedBy: "allowlist",
        decidedAt: "2026-08-21T10:00:00.000Z",
        allowlistEntryId: entry.entryId,
      });
    }
    expect((await findRecord(t, USER_C.tokenIdentifier))?.access).toEqual(
      WAITING_BY_DEFAULT,
    );

    // The flip is live on the very next read, with no fresh sign-in.
    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual(ADMITTED);
  });

  test("leaves declined and operator-approved accounts untouched and admits zero on a repeated run", async () => {
    closeBeta();
    const t = createTest();
    const declinedByOperator: ProductUserAccessDecision = {
      state: "declined",
      decidedBy: "operator",
      decidedAt: "2026-08-15T09:00:00.000Z",
      operatorId: "operator-9",
    };
    const approvedByOperator: ProductUserAccessDecision = {
      state: "approved",
      decidedBy: "operator",
      decidedAt: "2026-08-15T09:00:00.000Z",
      operatorId: "operator-9",
    };
    await insertProductUser(t, {
      subject: USER_A.tokenIdentifier,
      email: INVITED_EMAIL,
      access: declinedByOperator,
    });
    await insertProductUser(t, {
      subject: USER_B.tokenIdentifier,
      email: INVITED_EMAIL,
      access: WAITING_BY_DEFAULT,
    });
    await insertProductUser(t, {
      subject: USER_C.tokenIdentifier,
      walletAddress: WALLET_LOWERCASE,
      access: approvedByOperator,
    });

    const { entry, admittedCount } = await addEntry(t, {
      email: INVITED_EMAIL,
      walletAddress: WALLET_CHECKSUMMED,
    });
    // Only the waiting account moved; the decline outranks the list and the
    // operator approval keeps its own provenance.
    expect(admittedCount).toBe(1);
    expect((await findRecord(t, USER_A.tokenIdentifier))?.access).toEqual(
      declinedByOperator,
    );
    expect((await findRecord(t, USER_C.tokenIdentifier))?.access).toEqual(
      approvedByOperator,
    );

    // Re-running the admission converges: nothing left to admit.
    const rerun = await t.mutation(internal.betaAllowlist.updateEntry, {
      entryId: entry.entryId,
    });
    expect(rerun.admittedCount).toBe(0);
    expect((await findRecord(t, USER_A.tokenIdentifier))?.access).toEqual(
      declinedByOperator,
    );
  });

  test("updating an entry admits waiters matching its new identifier", async () => {
    closeBeta();
    const t = createTest();
    await insertProductUser(t, {
      subject: USER_A.tokenIdentifier,
      email: "second@example.com",
      access: WAITING_BY_DEFAULT,
    });

    const { entry, admittedCount } = await addEntry(t, {
      email: "first@example.com",
    });
    expect(admittedCount).toBe(0);

    const updated = await t.mutation(internal.betaAllowlist.updateEntry, {
      entryId: entry.entryId,
      email: "second@example.com",
    });
    expect(updated.admittedCount).toBe(1);
    expect((await findRecord(t, USER_A.tokenIdentifier))?.access).toMatchObject(
      { state: "approved", decidedBy: "allowlist" },
    );

    // The edited-away identifier no longer admits future sign-ins.
    await expect(
      t
        .withIdentity({ ...USER_B, email: "first@example.com" })
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(AWAITING_REVIEW);
  });
});

describe("list, search, and pagination", () => {
  test("pages the allowlist most recently updated first with bounded pages", async () => {
    vi.useFakeTimers();
    const t = createTest();
    const created: string[] = [];
    for (const minute of [0, 1, 2, 3, 4]) {
      vi.setSystemTime(`2026-08-21T10:0${minute}:00.000Z`);
      const { entry } = await addEntry(t, {
        email: `entry-${minute}@example.com`,
      });
      created.push(entry.entryId);
    }

    const first = await listPage(t, null, 2);
    expect(first.page.map(({ email }) => email)).toEqual([
      "entry-4@example.com",
      "entry-3@example.com",
    ]);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toEqual(expect.any(String));
    expect(first.searchTruncated).toBe(false);

    const second = await listPage(t, null, 2, first.continueCursor);
    expect(second.page.map(({ email }) => email)).toEqual([
      "entry-2@example.com",
      "entry-1@example.com",
    ]);

    const third = await listPage(t, null, 2, second.continueCursor);
    expect(third.page.map(({ email }) => email)).toEqual([
      "entry-0@example.com",
    ]);
    expect(third.isDone).toBe(true);
    expect(third.continueCursor).toBeNull();

    // An edit moves an entry to the front of recency.
    vi.setSystemTime("2026-08-21T11:00:00.000Z");
    await t.mutation(internal.betaAllowlist.updateEntry, {
      entryId: created[1]!,
      label: "edited",
    });
    const refreshed = await listPage(t, null, 2);
    expect(refreshed.page.map(({ email }) => email)).toEqual([
      "entry-1@example.com",
      "entry-4@example.com",
    ]);
  });

  test("searches by identifier prefix case-insensitively and pages the matches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-21T10:00:00.000Z");
    const t = createTest();
    await addEntry(t, { email: INVITED_EMAIL });
    vi.setSystemTime("2026-08-21T10:01:00.000Z");
    await addEntry(t, { email: "invitee-2@example.com" });
    vi.setSystemTime("2026-08-21T10:02:00.000Z");
    await addEntry(t, { walletAddress: WALLET_CHECKSUMMED });

    const byExactEmail = await listPage(t, "  INVITED@Example.com ", 20);
    expect(byExactEmail.page.map(({ email }) => email)).toEqual([
      INVITED_EMAIL,
    ]);
    expect(byExactEmail.isDone).toBe(true);
    expect(byExactEmail.searchTruncated).toBe(false);

    // A shared prefix matches both email entries and pages them, most
    // recently updated first, through the offset cursor.
    const firstMatches = await listPage(t, "invit", 1);
    expect(firstMatches.page.map(({ email }) => email)).toEqual([
      "invitee-2@example.com",
    ]);
    expect(firstMatches.isDone).toBe(false);
    expect(firstMatches.continueCursor).toBe("offset:1");
    const secondMatches = await listPage(
      t,
      "invit",
      1,
      firstMatches.continueCursor,
    );
    expect(secondMatches.page.map(({ email }) => email)).toEqual([
      INVITED_EMAIL,
    ]);
    expect(secondMatches.isDone).toBe(true);
    expect(secondMatches.continueCursor).toBeNull();

    // Wallet search matches through the lowercase key regardless of casing.
    const byWallet = await listPage(t, "0xABCDEF0123", 20);
    expect(byWallet.page.map(({ walletAddress }) => walletAddress)).toEqual([
      WALLET_CHECKSUMMED,
    ]);

    await expect(listPage(t, "nobody@example.com", 20)).resolves.toEqual({
      page: [],
      isDone: true,
      continueCursor: null,
      searchTruncated: false,
    });
    // A blank search is the unfiltered listing.
    expect((await listPage(t, "   ", 20)).page).toHaveLength(3);
  });

  test("bounds page sizes and rejects mismatched cursors and oversized searches", async () => {
    const t = createTest();
    await addEntry(t, { email: INVITED_EMAIL });

    for (const numItems of [0, -1, 21, 2.5, 1_000]) {
      await expectErrorCode(
        listPage(t, null, numItems),
        "BETA_ALLOWLIST_PAGE_SIZE_INVALID",
      );
    }
    await expectErrorCode(
      listPage(t, null, 2, "offset:2"),
      "BETA_ALLOWLIST_PAGE_CURSOR_INVALID",
    );
    await expectErrorCode(
      listPage(t, "example", 2, "not-an-offset-cursor"),
      "BETA_ALLOWLIST_PAGE_CURSOR_INVALID",
    );
    await expectErrorCode(
      listPage(t, "a".repeat(321), 2),
      "BETA_ALLOWLIST_SEARCH_INVALID",
    );
  });
});

describe("operator-integration access control", () => {
  test("keeps every allowlist operation out of the public API", () => {
    for (const registered of [
      createEntry,
      updateEntry,
      removeEntry,
      listEntriesPage,
    ]) {
      const visibility = registered as unknown as {
        isPublic?: boolean;
        isInternal?: boolean;
      };
      expect(visibility.isInternal).toBe(true);
      expect(visibility.isPublic).toBeUndefined();
    }
  });
});

describe("admin allowlist integration transport", () => {
  async function post(
    t: BetaAllowlistTest,
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

  const createBody = { email: INVITED_EMAIL, operatorId: OPERATOR };

  test("refuses every caller without the configured integration secret", async () => {
    const t = createTest();

    // No secret configured: the surface fails closed even with a plausible
    // token, exactly like the directory reads that share the credential.
    const unconfigured = await post(
      t,
      CREATE_PATH,
      createBody,
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
      // A product user's own bearer token is not the integration secret.
      "Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.product-user-access-token",
      ADMIN_TOKEN,
    ]) {
      const response = await post(t, CREATE_PATH, createBody, authorization);
      expect(response.status).toBe(401);
    }
    for (const path of [LIST_PATH, CREATE_PATH, UPDATE_PATH, REMOVE_PATH]) {
      const response = await post(t, path, createBody, undefined);
      expect(response.status).toBe(401);
    }
    // No refused call wrote anything.
    expect(await readEntries(t)).toHaveLength(0);
  });

  test("serves create, list, update, and remove to the authenticated admin server", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-21T10:00:00.000Z");
    const t = createTest();
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);
    const authorization = `Bearer ${ADMIN_TOKEN}`;
    // A waiting account the create call should admit and report.
    await insertProductUser(t, {
      subject: USER_A.tokenIdentifier,
      email: INVITED_EMAIL,
      access: WAITING_BY_DEFAULT,
    });

    const created = await post(
      t,
      CREATE_PATH,
      {
        email: " Invited@Example.COM ",
        label: "design partner",
        operatorId: OPERATOR,
      },
      authorization,
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      entry: Record<string, unknown>;
      admittedCount: number;
    };
    expect(createdBody).toEqual({
      entry: {
        entryId: expect.any(String),
        email: INVITED_EMAIL,
        walletAddress: null,
        label: "design partner",
        createdAt: "2026-08-21T10:00:00.000Z",
        updatedAt: "2026-08-21T10:00:00.000Z",
        createdByOperatorId: OPERATOR,
      },
      admittedCount: 1,
    });

    const listed = await post(
      t,
      LIST_PATH,
      { search: "invited", paginationOpts: { numItems: 20, cursor: null } },
      authorization,
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      page: [createdBody.entry],
      isDone: true,
      continueCursor: null,
      searchTruncated: false,
    });

    // An omitted field keeps its value; an explicit null clears it.
    vi.setSystemTime("2026-08-21T11:00:00.000Z");
    const updated = await post(
      t,
      UPDATE_PATH,
      {
        entryId: createdBody.entry.entryId,
        walletAddress: WALLET_CHECKSUMMED,
        label: null,
      },
      authorization,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      entry: {
        ...createdBody.entry,
        walletAddress: WALLET_CHECKSUMMED,
        label: null,
        updatedAt: "2026-08-21T11:00:00.000Z",
      },
      admittedCount: 0,
    });

    const removed = await post(
      t,
      REMOVE_PATH,
      { entryId: createdBody.entry.entryId },
      authorization,
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    const removedAgain = await post(
      t,
      REMOVE_PATH,
      { entryId: createdBody.entry.entryId },
      authorization,
    );
    expect(await removedAgain.json()).toEqual({ removed: false });

    // Deleting the entry changed no existing decision.
    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual(ADMITTED);
  });

  test("maps malformed and refused requests without leaking backend errors", async () => {
    const t = createTest();
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);
    const authorization = `Bearer ${ADMIN_TOKEN}`;

    for (const body of [
      "not-json",
      [],
      {},
      { email: 42, operatorId: OPERATOR },
      { email: INVITED_EMAIL },
      { email: INVITED_EMAIL, operatorId: "" },
    ]) {
      const response = await post(t, CREATE_PATH, body, authorization);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "ADMIN_ALLOWLIST_REQUEST_INVALID",
      });
    }
    for (const body of [{}, { entryId: "x", email: 42 }]) {
      const response = await post(t, UPDATE_PATH, body, authorization);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "ADMIN_ALLOWLIST_REQUEST_INVALID",
      });
    }

    // Semantic refusals surface their own codes with fixed messages.
    const noIdentifier = await post(
      t,
      CREATE_PATH,
      { operatorId: OPERATOR },
      authorization,
    );
    expect(noIdentifier.status).toBe(400);
    expect(await noIdentifier.json()).toEqual({
      error: "The beta-allowlist request was rejected.",
      code: "BETA_ALLOWLIST_IDENTIFIER_REQUIRED",
    });
    const badEmail = await post(
      t,
      CREATE_PATH,
      { email: "not-an-email", operatorId: OPERATOR },
      authorization,
    );
    expect(badEmail.status).toBe(400);
    expect(await badEmail.json()).toMatchObject({
      code: "BETA_ALLOWLIST_EMAIL_INVALID",
    });

    // A duplicate identifier is a conflict, and the identifier itself never
    // appears in the refusal.
    await post(t, CREATE_PATH, createBody, authorization);
    const duplicate = await post(t, CREATE_PATH, createBody, authorization);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: "The beta-allowlist entry conflicts with an existing entry.",
      code: "BETA_ALLOWLIST_DUPLICATE_EMAIL",
    });

    const badPage = await post(
      t,
      LIST_PATH,
      { search: null, paginationOpts: { numItems: 500, cursor: null } },
      authorization,
    );
    expect(badPage.status).toBe(400);
    expect(await badPage.json()).toMatchObject({
      code: "BETA_ALLOWLIST_PAGE_SIZE_INVALID",
    });
    const badEntryReference = await post(
      t,
      UPDATE_PATH,
      { entryId: "not-an-entry-id" },
      authorization,
    );
    expect(badEntryReference.status).toBe(400);
    expect(await badEntryReference.json()).toMatchObject({
      code: "BETA_ALLOWLIST_ENTRY_INVALID",
    });

    const wrongMethod = await t.fetch(LIST_PATH, {
      method: "GET",
      headers: { authorization },
    });
    expect(wrongMethod.status).toBe(404);
    const wrongPath = await post(
      t,
      "/admin/beta-allowlist",
      createBody,
      authorization,
    );
    expect(wrongPath.status).toBe(404);
  });
});
