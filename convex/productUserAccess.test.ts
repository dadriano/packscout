/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import {
  establishAccess,
  getGateStatus,
  getMyAccess,
} from "./productUserAccess";
import type { ProductUserAccessDecision } from "./productUserRecords";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type ProductUserAccessTest = TestConvex<typeof schema>;

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

const AWAITING_REVIEW = { admitted: false, reason: "awaiting_review" };
const UNDETERMINED = { admitted: false, reason: "undetermined" };
const ADMITTED = { admitted: true, reason: "approved" };

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function closeBeta() {
  vi.stubEnv("PACKSCOUT_CLOSED_BETA", "1");
}

async function readProductUsers(t: ProductUserAccessTest) {
  return await t.run(async (ctx) => await ctx.db.query("productUsers").take(5));
}

async function patchRecord(
  t: ProductUserAccessTest,
  subject: string,
  patch: {
    access?: ProductUserAccessDecision;
    standing?: "active" | "suspended";
  },
) {
  await t.run(async (ctx) => {
    const record = await ctx.db
      .query("productUsers")
      .withIndex("by_subject", (index) => index.eq("subject", subject))
      .unique();
    if (record === null) throw new Error("Expected a recorded user.");
    await ctx.db.patch("productUsers", record._id, patch);
  });
}

/** A record shaped exactly as sign-ins recorded before this task wrote them. */
async function insertLegacyRecord(
  t: ProductUserAccessTest,
  subject: string,
  seenAt: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("productUsers", {
      subject,
      authMethod: "privy.io",
      email: null,
      walletAddress: null,
      walletAddressKey: null,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      standing: "active",
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

describe("closed-beta access establishment", () => {
  test("first authenticated contact records one awaiting-review decision with default provenance", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T10:00:00.000Z");
    const t = createTest();

    await expect(
      t.withIdentity(USER_A).mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(AWAITING_REVIEW);

    const records = await readProductUsers(t);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      subject: USER_A.tokenIdentifier,
      standing: "active",
      firstSeenAt: "2026-08-20T10:00:00.000Z",
      lastSeenAt: "2026-08-20T10:00:00.000Z",
    });
    // Exact decision shape: default provenance carries no entry or operator
    // reference, and the decision time is the establishment time.
    expect(records[0]?.access).toEqual({
      state: "awaiting_review",
      decidedBy: "default",
      decidedAt: "2026-08-20T10:00:00.000Z",
    });
  });

  test("concurrent first contacts converge on one record with one decision", async () => {
    closeBeta();
    const t = createTest();
    const user = t.withIdentity(USER_A);

    const results = await Promise.all([
      user.mutation(api.productUserAccess.establishAccess, {}),
      user.mutation(api.productUserAccess.establishAccess, {}),
      user.mutation(api.productUserAccess.establishAccess, {}),
      user.mutation(api.productUserAccess.establishAccess, {}),
    ]);

    for (const result of results) expect(result).toEqual(AWAITING_REVIEW);
    const records = await readProductUsers(t);
    expect(records).toHaveLength(1);
    expect(records[0]?.access).toMatchObject({
      state: "awaiting_review",
      decidedBy: "default",
    });
  });

  test("repeat contact refreshes the record without altering an approved decision", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T10:00:00.000Z");
    const t = createTest();
    await t
      .withIdentity(USER_A)
      .mutation(api.productUserAccess.establishAccess, {});
    const approvedByOperator: ProductUserAccessDecision = {
      state: "approved",
      decidedBy: "operator",
      decidedAt: "2026-08-20T10:05:00.000Z",
      operatorId: "operator-1",
    };
    await patchRecord(t, USER_A.tokenIdentifier, {
      access: approvedByOperator,
    });

    vi.setSystemTime("2026-08-20T12:00:00.000Z");
    await expect(
      t
        .withIdentity(USER_A_WITH_ATTRIBUTES)
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(ADMITTED);

    const records = await readProductUsers(t);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      email: "alice@example.com",
      lastSeenAt: "2026-08-20T12:00:00.000Z",
    });
    // The decision is untouched: same state, provenance, and timestamp.
    expect(records[0]?.access).toEqual(approvedByOperator);
  });

  test("repeat contact never overturns a declined decision", async () => {
    closeBeta();
    const t = createTest();
    await t
      .withIdentity(USER_A)
      .mutation(api.productUserAccess.establishAccess, {});
    const declinedByOperator: ProductUserAccessDecision = {
      state: "declined",
      decidedBy: "operator",
      decidedAt: "2026-08-20T11:00:00.000Z",
      operatorId: "operator-2",
    };
    await patchRecord(t, USER_A.tokenIdentifier, {
      access: declinedByOperator,
    });

    await expect(
      t.withIdentity(USER_A).mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual({ admitted: false, reason: "declined" });
    expect((await readProductUsers(t))[0]?.access).toEqual(declinedByOperator);
  });

  test("materializes the default decision for records that predate the closed beta", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T14:00:00.000Z");
    const t = createTest();
    await insertLegacyRecord(
      t,
      USER_A.tokenIdentifier,
      "2026-08-01T09:00:00.000Z",
    );

    // Absence already reads as awaiting review with default provenance.
    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual(AWAITING_REVIEW);

    // The next authenticated contact stores exactly that derived decision.
    await expect(
      t.withIdentity(USER_A).mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(AWAITING_REVIEW);
    const records = await readProductUsers(t);
    expect(records).toHaveLength(1);
    expect(records[0]?.access).toEqual({
      state: "awaiting_review",
      decidedBy: "default",
      decidedAt: "2026-08-01T09:00:00.000Z",
    });

    // The legacy sign-in recorder shares the same write path and stamps too.
    await insertLegacyRecord(
      t,
      USER_B.tokenIdentifier,
      "2026-08-02T09:00:00.000Z",
    );
    await t.withIdentity(USER_B).mutation(api.productUsers.recordSignIn, {});
    const recordB = (await readProductUsers(t)).find(
      (record) => record.subject === USER_B.tokenIdentifier,
    );
    expect(recordB?.access).toEqual({
      state: "awaiting_review",
      decidedBy: "default",
      decidedAt: "2026-08-02T09:00:00.000Z",
    });
  });
});

describe("effective-access composition", () => {
  test("admits only approved-and-not-suspended identities and distinguishes reasons", async () => {
    closeBeta();
    const t = createTest();
    await t
      .withIdentity(USER_A)
      .mutation(api.productUserAccess.establishAccess, {});
    const decidedAt = "2026-08-20T10:00:00.000Z";
    const cases: ReadonlyArray<{
      access: ProductUserAccessDecision;
      standing: "active" | "suspended";
      expected: { admitted: boolean; reason: string };
    }> = [
      {
        access: { state: "approved", decidedBy: "operator", decidedAt, operatorId: "op" },
        standing: "active",
        expected: ADMITTED,
      },
      {
        access: { state: "approved", decidedBy: "operator", decidedAt, operatorId: "op" },
        standing: "suspended",
        expected: { admitted: false, reason: "suspended" },
      },
      {
        access: { state: "declined", decidedBy: "operator", decidedAt, operatorId: "op" },
        standing: "suspended",
        expected: { admitted: false, reason: "declined" },
      },
      {
        access: { state: "awaiting_review", decidedBy: "default", decidedAt },
        standing: "suspended",
        expected: AWAITING_REVIEW,
      },
    ];

    for (const { access, standing, expected } of cases) {
      await patchRecord(t, USER_A.tokenIdentifier, { access, standing });
      await expect(
        t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
      ).resolves.toEqual(expected);
    }
  });

  test("resolves an identity with no record to awaiting review without creating one", async () => {
    closeBeta();
    const t = createTest();

    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual(AWAITING_REVIEW);
    expect(await readProductUsers(t)).toHaveLength(0);
  });

  test("resolves a failed establishment to undetermined, never admitted", async () => {
    closeBeta();
    const t = createTest();
    // A subject impossibly holding duplicate records makes both establishment
    // and reads fail; the outcome is explicit and is not an entry.
    for (const _duplicate of [1, 2]) {
      await insertLegacyRecord(
        t,
        USER_A.tokenIdentifier,
        "2026-08-01T09:00:00.000Z",
      );
    }

    await expect(
      t.withIdentity(USER_A).mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(UNDETERMINED);
    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual(UNDETERMINED);
    // Nothing was written or repaired behind the failure.
    expect(await readProductUsers(t)).toHaveLength(2);
  });

  test("carries provenance as data and reflects a decision change on the next read", async () => {
    closeBeta();
    const t = createTest();
    await t
      .withIdentity(USER_A)
      .mutation(api.productUserAccess.establishAccess, {});

    await patchRecord(t, USER_A.tokenIdentifier, {
      access: {
        state: "approved",
        decidedBy: "allowlist",
        decidedAt: "2026-08-20T10:10:00.000Z",
        allowlistEntryId: "allowlist-entry-7",
      },
    });
    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual(ADMITTED);

    // A later operator decline is authoritative on the very next read; no
    // re-establishment or fresh sign-in is required.
    await patchRecord(t, USER_A.tokenIdentifier, {
      access: {
        state: "declined",
        decidedBy: "operator",
        decidedAt: "2026-08-20T10:20:00.000Z",
        operatorId: "operator-3",
      },
    });
    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual({ admitted: false, reason: "declined" });
  });
});

describe("self-read isolation", () => {
  test("returns only the caller's own state", async () => {
    closeBeta();
    const t = createTest();
    await t
      .withIdentity(USER_A)
      .mutation(api.productUserAccess.establishAccess, {});
    await patchRecord(t, USER_A.tokenIdentifier, {
      access: {
        state: "approved",
        decidedBy: "operator",
        decidedAt: "2026-08-20T10:00:00.000Z",
        operatorId: "operator-1",
      },
    });

    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual(ADMITTED);
    await expect(
      t.withIdentity(USER_B).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual(AWAITING_REVIEW);
  });

  test("cannot be pointed at another user and requires authentication", async () => {
    closeBeta();
    const t = createTest();

    // No argument exists that could name another subject.
    await expect(
      t
        .withIdentity(USER_B)
        .query(api.productUserAccess.getMyAccess, {
          subject: USER_A.tokenIdentifier,
        } as never),
    ).rejects.toThrow(/unexpected field/i);
    await expect(
      t
        .withIdentity(USER_B)
        .mutation(api.productUserAccess.establishAccess, {
          subject: USER_A.tokenIdentifier,
        } as never),
    ).rejects.toThrow(/unexpected field/i);

    await expectErrorCode(
      t.query(api.productUserAccess.getMyAccess, {}),
      "AUTH_REQUIRED",
    );
    await expectErrorCode(
      t.mutation(api.productUserAccess.establishAccess, {}),
      "AUTH_REQUIRED",
    );
    expect(await readProductUsers(t)).toHaveLength(0);
  });

  test("establishment requires authentication even while the beta is off", async () => {
    const t = createTest();
    await expectErrorCode(
      t.mutation(api.productUserAccess.establishAccess, {}),
      "AUTH_REQUIRED",
    );
  });
});

describe("the deployment switch", () => {
  test("reports gate status to unauthenticated callers and nothing else", async () => {
    const t = createTest();

    // Exact equality: the payload carries one boolean and no identity,
    // count, or catalog data.
    await expect(
      t.query(api.productUserAccess.getGateStatus, {}),
    ).resolves.toEqual({ closedBetaActive: false });

    closeBeta();
    await expect(
      t.query(api.productUserAccess.getGateStatus, {}),
    ).resolves.toEqual({ closedBetaActive: true });

    await expect(
      t.query(api.productUserAccess.getGateStatus, {
        closedBetaActive: false,
      } as never),
    ).rejects.toThrow(/unexpected field/i);
  });

  test("only the exact configured value closes the beta", async () => {
    const t = createTest();
    for (const configured of ["0", "", "true", "on", " 1"]) {
      vi.stubEnv("PACKSCOUT_CLOSED_BETA", configured);
      await expect(
        t.query(api.productUserAccess.getGateStatus, {}),
      ).resolves.toEqual({ closedBetaActive: false });
    }
  });

  test("switch off resolves every caller to admitted while still recording contact", async () => {
    const t = createTest();

    await expect(
      t.withIdentity(USER_A).mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(ADMITTED);
    // The record and its awaiting-review decision are still established, so
    // turning the beta on later holds this identity for review.
    const records = await readProductUsers(t);
    expect(records).toHaveLength(1);
    expect(records[0]?.access).toMatchObject({ state: "awaiting_review" });

    // Even a declined-and-suspended identity is admitted while the product is
    // fully public; suspension enforcement on write paths is unchanged.
    await patchRecord(t, USER_A.tokenIdentifier, {
      access: {
        state: "declined",
        decidedBy: "operator",
        decidedAt: "2026-08-20T10:00:00.000Z",
        operatorId: "operator-1",
      },
      standing: "suspended",
    });
    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual(ADMITTED);

    // A broken record cannot lock anyone out of a public product: admission
    // does not depend on the record while the switch is off.
    for (const _duplicate of [1, 2]) {
      await insertLegacyRecord(
        t,
        USER_B.tokenIdentifier,
        "2026-08-01T09:00:00.000Z",
      );
    }
    await expect(
      t.withIdentity(USER_B).mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(ADMITTED);
  });

  test("switch on denies by default for the same identity the off position admits", async () => {
    const t = createTest();
    await expect(
      t.withIdentity(USER_A).mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual(ADMITTED);

    closeBeta();
    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual(AWAITING_REVIEW);
  });
});

describe("surface visibility", () => {
  test("exposes establishment, self-read, and gate status publicly and nothing internally", () => {
    for (const registered of [establishAccess, getMyAccess, getGateStatus]) {
      const visibility = registered as unknown as {
        isPublic?: boolean;
        isInternal?: boolean;
      };
      expect(visibility.isPublic).toBe(true);
      expect(visibility.isInternal).toBeUndefined();
    }
  });
});
