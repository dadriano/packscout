/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  approveAccess,
  countAwaitingReview,
  declineAccess,
  listAccessQueuePage,
  revokeAccess,
} from "./productUserAccessReview";
import type { ProductUserAccessDecision } from "./productUserRecords";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type AccessReviewTest = TestConvex<typeof schema>;

const USER_A = {
  subject: "did:privy:user-a",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:user-a",
};
const INVITEE = {
  subject: "did:privy:invitee",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:invitee",
  email: "invitee@example.com",
};

const ADMIN_TOKEN = "packscout-admin-directory-token-000000000001";
const APPROVE_PATH = "/admin/product-users/access/approve";
const DECLINE_PATH = "/admin/product-users/access/decline";
const REVOKE_PATH = "/admin/product-users/access/revoke";
const QUEUE_PATH = "/admin/product-users/access/queue";
const QUEUE_COUNT_PATH = "/admin/product-users/access/queue-count";
const DECIDE_PATHS = [APPROVE_PATH, DECLINE_PATH, REVOKE_PATH];
const REVIEW_PATHS = [...DECIDE_PATHS, QUEUE_PATH, QUEUE_COUNT_PATH];

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function closeBeta() {
  vi.stubEnv("PACKSCOUT_CLOSED_BETA", "1");
}

async function readProductUsers(t: AccessReviewTest) {
  return await t.run(
    async (ctx) => await ctx.db.query("productUsers").take(10),
  );
}

async function readAccessOf(t: AccessReviewTest, subject: string) {
  const record = (await readProductUsers(t)).find(
    (candidate) => candidate.subject === subject,
  );
  if (record === undefined) throw new Error("Expected a recorded user.");
  return record.access;
}

/** A record shaped exactly as sign-ins recorded before the closed beta. */
async function insertLegacyRecord(
  t: AccessReviewTest,
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

async function insertDecidedRecord(
  t: AccessReviewTest,
  subject: string,
  seenAt: string,
  access: ProductUserAccessDecision,
  standing: "active" | "suspended" = "active",
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
      standing,
      access,
    });
  });
}

function defaultDecision(decidedAt: string): ProductUserAccessDecision {
  return { state: "awaiting_review", decidedBy: "default", decidedAt };
}

function approve(t: AccessReviewTest, subject: string, operatorId: string) {
  return t.mutation(internal.productUserAccessReview.approveAccess, {
    subject,
    operatorId,
  });
}

function decline(t: AccessReviewTest, subject: string, operatorId: string) {
  return t.mutation(internal.productUserAccessReview.declineAccess, {
    subject,
    operatorId,
  });
}

function revoke(t: AccessReviewTest, subject: string, operatorId: string) {
  return t.mutation(internal.productUserAccessReview.revokeAccess, {
    subject,
    operatorId,
  });
}

function listQueue(
  t: AccessReviewTest,
  accessState: "awaiting_review" | "approved" | "declined",
  numItems: number,
  cursor: string | null = null,
) {
  return t.query(internal.productUserAccessReview.listAccessQueuePage, {
    accessState,
    paginationOpts: { numItems, cursor },
  });
}

function countQueue(t: AccessReviewTest) {
  return t.query(internal.productUserAccessReview.countAwaitingReview, {});
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

describe("operator access decisions", () => {
  test("approve admits an awaiting identity with operator provenance and reports the decision pair", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T10:00:00.000Z");
    const t = createTest();
    await t
      .withIdentity(USER_A)
      .mutation(api.productUserAccess.establishAccess, {});

    vi.setSystemTime("2026-08-20T11:00:00.000Z");
    const result = await approve(t, USER_A.tokenIdentifier, "operator-1");
    expect(result).toEqual({
      outcome: "decided",
      action: "approve",
      subject: USER_A.tokenIdentifier,
      operatorId: "operator-1",
      decidedAt: "2026-08-20T11:00:00.000Z",
      changed: true,
      previous: defaultDecision("2026-08-20T10:00:00.000Z"),
      resulting: {
        state: "approved",
        decidedBy: "operator",
        decidedAt: "2026-08-20T11:00:00.000Z",
        operatorId: "operator-1",
      },
      effectiveAccess: { admitted: true, reason: "approved" },
    });

    // The stored decision is the reported one, and the person's own
    // enforcement read reflects it promptly on the same session.
    await expect(readAccessOf(t, USER_A.tokenIdentifier)).resolves.toEqual(
      result.outcome === "decided" ? result.resulting : undefined,
    );
    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual({ admitted: true, reason: "approved" });
  });

  test("decline refuses, revoke returns to review, and every flip is reversible with nothing deleted", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T10:00:00.000Z");
    const t = createTest();
    await t
      .withIdentity(USER_A)
      .mutation(api.productUserAccess.establishAccess, {});
    await approve(t, USER_A.tokenIdentifier, "operator-1");

    vi.setSystemTime("2026-08-20T12:00:00.000Z");
    const declined = await decline(t, USER_A.tokenIdentifier, "operator-2");
    expect(declined).toMatchObject({
      outcome: "decided",
      changed: true,
      previous: {
        state: "approved",
        decidedBy: "operator",
        operatorId: "operator-1",
      },
      resulting: {
        state: "declined",
        decidedBy: "operator",
        decidedAt: "2026-08-20T12:00:00.000Z",
        operatorId: "operator-2",
      },
      effectiveAccess: { admitted: false, reason: "declined" },
    });
    await expect(
      t.withIdentity(USER_A).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual({ admitted: false, reason: "declined" });

    // Revoke also reverses a decline: the identity returns to the queue.
    vi.setSystemTime("2026-08-20T13:00:00.000Z");
    const revoked = await revoke(t, USER_A.tokenIdentifier, "operator-3");
    expect(revoked).toMatchObject({
      outcome: "decided",
      changed: true,
      previous: { state: "declined", operatorId: "operator-2" },
      resulting: {
        state: "awaiting_review",
        decidedBy: "operator",
        decidedAt: "2026-08-20T13:00:00.000Z",
        operatorId: "operator-3",
      },
      effectiveAccess: { admitted: false, reason: "awaiting_review" },
    });

    // And approve reverses the revocation. No flip deleted or duplicated
    // anything: one record, identity intact, throughout.
    vi.setSystemTime("2026-08-20T14:00:00.000Z");
    const reapproved = await approve(t, USER_A.tokenIdentifier, "operator-1");
    expect(reapproved).toMatchObject({
      outcome: "decided",
      changed: true,
      effectiveAccess: { admitted: true, reason: "approved" },
    });
    const records = await readProductUsers(t);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      subject: USER_A.tokenIdentifier,
      standing: "active",
      firstSeenAt: "2026-08-20T10:00:00.000Z",
    });
  });

  test("a suspended identity's approval reports effective access as suspended, not admitted", async () => {
    closeBeta();
    const t = createTest();
    await insertDecidedRecord(
      t,
      USER_A.tokenIdentifier,
      "2026-08-01T09:00:00.000Z",
      defaultDecision("2026-08-01T09:00:00.000Z"),
      "suspended",
    );

    const result = await approve(t, USER_A.tokenIdentifier, "operator-1");
    expect(result).toMatchObject({
      outcome: "decided",
      changed: true,
      resulting: { state: "approved" },
      effectiveAccess: { admitted: false, reason: "suspended" },
    });
  });

  test("repeating a decision converges on the authoritative decision without rewriting its provenance", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T10:00:00.000Z");
    const t = createTest();
    const entry = await t.mutation(internal.betaAllowlist.createEntry, {
      email: INVITEE.email,
      walletAddress: null,
      label: null,
      operatorId: "operator-list",
    });
    await t
      .withIdentity(INVITEE)
      .mutation(api.productUserAccess.establishAccess, {});
    const allowlistDecision = {
      state: "approved",
      decidedBy: "allowlist",
      decidedAt: "2026-08-20T10:00:00.000Z",
      allowlistEntryId: entry.entry.entryId,
    };

    // Approving an already-approved identity states the authoritative
    // decision (the allowlist admission, provenance intact) and changes
    // nothing.
    vi.setSystemTime("2026-08-20T11:00:00.000Z");
    const converged = await approve(t, INVITEE.tokenIdentifier, "operator-1");
    expect(converged).toEqual({
      outcome: "decided",
      action: "approve",
      subject: INVITEE.tokenIdentifier,
      operatorId: "operator-1",
      decidedAt: "2026-08-20T11:00:00.000Z",
      changed: false,
      previous: allowlistDecision,
      resulting: allowlistDecision,
      effectiveAccess: { admitted: true, reason: "approved" },
    });
    await expect(readAccessOf(t, INVITEE.tokenIdentifier)).resolves.toEqual(
      allowlistDecision,
    );

    // The same convergence holds for repeat declines: the second call
    // reports the first decliner's decision as the authoritative one.
    await decline(t, INVITEE.tokenIdentifier, "operator-2");
    vi.setSystemTime("2026-08-20T12:00:00.000Z");
    const repeatDecline = await decline(
      t,
      INVITEE.tokenIdentifier,
      "operator-3",
    );
    expect(repeatDecline).toMatchObject({
      changed: false,
      previous: { state: "declined", operatorId: "operator-2" },
      resulting: {
        state: "declined",
        operatorId: "operator-2",
        decidedAt: "2026-08-20T11:00:00.000Z",
      },
      effectiveAccess: { admitted: false, reason: "declined" },
    });
  });

  test("two operators deciding at once converge on one authoritative decision", async () => {
    closeBeta();
    const t = createTest();
    await t
      .withIdentity(USER_A)
      .mutation(api.productUserAccess.establishAccess, {});

    const concurrent = await Promise.all([
      approve(t, USER_A.tokenIdentifier, "operator-1"),
      approve(t, USER_A.tokenIdentifier, "operator-2"),
    ]);
    for (const outcome of concurrent) {
      expect(outcome).toMatchObject({
        outcome: "decided",
        resulting: { state: "approved" },
        effectiveAccess: { admitted: true, reason: "approved" },
      });
    }
    const changed = concurrent.filter(
      (outcome) => outcome.outcome === "decided" && outcome.changed,
    );
    expect(changed).toHaveLength(1);

    const records = await readProductUsers(t);
    expect(records).toHaveLength(1);
    expect(records[0]?.access).toEqual(
      changed[0]?.outcome === "decided" ? changed[0].resulting : undefined,
    );
  });

  test("an operator decline is not overturned by a later allowlist addition for the same identifier", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T10:00:00.000Z");
    const t = createTest();
    await t
      .withIdentity(INVITEE)
      .mutation(api.productUserAccess.establishAccess, {});

    vi.setSystemTime("2026-08-20T11:00:00.000Z");
    const declined = await decline(
      t,
      INVITEE.tokenIdentifier,
      "operator-guard",
    );
    expect(declined).toMatchObject({ changed: true });
    const declinedDecision = await readAccessOf(t, INVITEE.tokenIdentifier);

    // The list side: adding a matching entry admits nobody who was declined.
    vi.setSystemTime("2026-08-20T12:00:00.000Z");
    const created = await t.mutation(internal.betaAllowlist.createEntry, {
      email: "Invitee@Example.COM",
      walletAddress: null,
      label: "belated invitation",
      operatorId: "operator-list",
    });
    expect(created.admittedCount).toBe(0);
    await expect(readAccessOf(t, INVITEE.tokenIdentifier)).resolves.toEqual(
      declinedDecision,
    );

    // The re-sync tool converges the same way: still nobody admitted.
    const resynced = await t.mutation(internal.betaAllowlist.updateEntry, {
      entryId: created.entry.entryId,
    });
    expect(resynced.admittedCount).toBe(0);

    // The establishment side: signing in with the listed identifier present
    // does not re-evaluate a declined identity either.
    await expect(
      t
        .withIdentity(INVITEE)
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual({ admitted: false, reason: "declined" });
    await expect(readAccessOf(t, INVITEE.tokenIdentifier)).resolves.toEqual(
      declinedDecision,
    );
  });

  test("revocation returns the identity to the normal admission machinery, where a standing invitation applies again", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T10:00:00.000Z");
    const t = createTest();
    const entry = await t.mutation(internal.betaAllowlist.createEntry, {
      email: INVITEE.email,
      walletAddress: null,
      label: null,
      operatorId: "operator-list",
    });
    await t
      .withIdentity(INVITEE)
      .mutation(api.productUserAccess.establishAccess, {});

    vi.setSystemTime("2026-08-20T11:00:00.000Z");
    const revoked = await revoke(t, INVITEE.tokenIdentifier, "operator-1");
    expect(revoked).toMatchObject({
      changed: true,
      resulting: { state: "awaiting_review", decidedBy: "operator" },
      effectiveAccess: { admitted: false, reason: "awaiting_review" },
    });

    // Awaiting review is the same state as a fresh sign-up: the still-listed
    // identifier admits the identity on its next contact. Keeping a person
    // out is a decline (protected above) or removing the entry (002).
    vi.setSystemTime("2026-08-20T12:00:00.000Z");
    await expect(
      t
        .withIdentity(INVITEE)
        .mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual({ admitted: true, reason: "approved" });
    await expect(readAccessOf(t, INVITEE.tokenIdentifier)).resolves.toEqual({
      state: "approved",
      decidedBy: "allowlist",
      decidedAt: "2026-08-20T12:00:00.000Z",
      allowlistEntryId: entry.entry.entryId,
    });
  });

  test("deciding about a subject with no record reports nothing to decide and creates nothing", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T10:00:00.000Z");
    const t = createTest();

    for (const [action, operation] of [
      ["approve", approve],
      ["decline", decline],
      ["revoke", revoke],
    ] as const) {
      await expect(
        operation(t, USER_A.tokenIdentifier, "operator-1"),
      ).resolves.toEqual({
        outcome: "nothing_to_decide",
        action,
        subject: USER_A.tokenIdentifier,
        operatorId: "operator-1",
        decidedAt: "2026-08-20T10:00:00.000Z",
      });
    }
    await expect(readProductUsers(t)).resolves.toEqual([]);
  });

  test("refuses malformed subject and operator references without echoing them", async () => {
    const t = createTest();

    await expectErrorCode(
      approve(t, "", "operator-1"),
      "PRODUCT_USER_SUBJECT_INVALID",
    );
    await expectErrorCode(
      decline(t, "a".repeat(1_025), "operator-1"),
      "PRODUCT_USER_SUBJECT_INVALID",
    );
    for (const operatorId of ["", "   ", "a".repeat(129), "bad operator"]) {
      await expectErrorCode(
        revoke(t, USER_A.tokenIdentifier, operatorId),
        "PRODUCT_USER_OPERATOR_INVALID",
      );
    }
  });
});

describe("review queue and count", () => {
  /**
   * Four identities awaiting review — two stamped defaults, one operator
   * revocation, and one record from before the closed beta — plus one
   * approved and one declined, inserted out of queue order.
   */
  const OLDEST = "privy.io|did:privy:oldest";
  const LEGACY = "privy.io|did:privy:legacy";
  const NEWER = "privy.io|did:privy:newer";
  const REVOKED = "privy.io|did:privy:revoked";
  const APPROVED = "privy.io|did:privy:approved";
  const DECLINED = "privy.io|did:privy:declined";

  async function seedQueue(t: AccessReviewTest) {
    await insertDecidedRecord(t, REVOKED, "2026-08-01T08:00:00.000Z", {
      state: "awaiting_review",
      decidedBy: "operator",
      decidedAt: "2026-08-04T09:00:00.000Z",
      operatorId: "operator-r",
    });
    await insertDecidedRecord(
      t,
      NEWER,
      "2026-08-03T09:00:00.000Z",
      defaultDecision("2026-08-03T09:00:00.000Z"),
    );
    await insertLegacyRecord(t, LEGACY, "2026-08-02T09:00:00.000Z");
    await insertDecidedRecord(
      t,
      OLDEST,
      "2026-08-01T09:00:00.000Z",
      defaultDecision("2026-08-01T09:00:00.000Z"),
    );
    await insertDecidedRecord(t, APPROVED, "2026-08-01T10:00:00.000Z", {
      state: "approved",
      decidedBy: "operator",
      decidedAt: "2026-08-05T09:00:00.000Z",
      operatorId: "operator-a",
    });
    await insertDecidedRecord(t, DECLINED, "2026-08-01T11:00:00.000Z", {
      state: "declined",
      decidedBy: "operator",
      decidedAt: "2026-08-06T09:00:00.000Z",
      operatorId: "operator-d",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("savedRepacks", {
        ownerTokenIdentifier: OLDEST,
        publicRepackId: "10000000-0000-5000-8000-000000000001",
      });
    });
  }

  test("lists awaiting-review identities oldest-request-first, including records that predate the closed beta", async () => {
    const t = createTest();
    await seedQueue(t);

    const queue = await listQueue(t, "awaiting_review", 20);
    expect(queue.page.map(({ subject }) => subject)).toEqual([
      OLDEST,
      LEGACY,
      NEWER,
      REVOKED,
    ]);
    expect(queue.isDone).toBe(true);
    expect(queue.continueCursor).toBeNull();
    expect(queue.queueTruncated).toBe(false);

    // Rows are full directory rows: identity, standing, saved-item counts,
    // and the decision with its provenance, so one screen shows it all.
    expect(queue.page[0]).toEqual({
      subject: OLDEST,
      authMethod: "privy.io",
      email: null,
      walletAddress: null,
      firstSeenAt: "2026-08-01T09:00:00.000Z",
      lastSeenAt: "2026-08-01T09:00:00.000Z",
      standing: "active",
      access: defaultDecision("2026-08-01T09:00:00.000Z"),
      savedRepackCount: 1,
      savedCollectibleCount: 0,
    });
    // The pre-closed-beta record reports the derived default decision.
    expect(queue.page[1]?.access).toEqual(
      defaultDecision("2026-08-02T09:00:00.000Z"),
    );
    // The revocation queues by when it returned the identity to review.
    expect(queue.page[3]?.access).toMatchObject({
      decidedBy: "operator",
      decidedAt: "2026-08-04T09:00:00.000Z",
    });
  });

  test("pages the queue in bounded pages with a stable cursor contract", async () => {
    const t = createTest();
    await seedQueue(t);

    const first = await listQueue(t, "awaiting_review", 2);
    expect(first.page.map(({ subject }) => subject)).toEqual([OLDEST, LEGACY]);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).toBe("offset:2");

    const second = await listQueue(
      t,
      "awaiting_review",
      2,
      first.continueCursor,
    );
    expect(second.page.map(({ subject }) => subject)).toEqual([NEWER, REVOKED]);
    expect(second.isDone).toBe(true);
    expect(second.continueCursor).toBeNull();

    for (const numItems of [0, -1, 21, 2.5]) {
      await expectErrorCode(
        listQueue(t, "awaiting_review", numItems),
        "PRODUCT_USER_PAGE_SIZE_INVALID",
      );
    }
    await expectErrorCode(
      listQueue(t, "awaiting_review", 2, "not-an-offset-cursor"),
      "PRODUCT_USER_PAGE_CURSOR_INVALID",
    );
  });

  test("filters by the approved and declined decision states too", async () => {
    const t = createTest();
    await seedQueue(t);

    const approvedPage = await listQueue(t, "approved", 20);
    expect(approvedPage.page.map(({ subject }) => subject)).toEqual([APPROVED]);
    expect(approvedPage.page[0]?.access).toMatchObject({
      state: "approved",
      operatorId: "operator-a",
    });

    const declinedPage = await listQueue(t, "declined", 20);
    expect(declinedPage.page.map(({ subject }) => subject)).toEqual([DECLINED]);
  });

  test("counts the awaiting-review queue, and a decision moves it", async () => {
    const t = createTest();
    await seedQueue(t);

    await expect(countQueue(t)).resolves.toEqual({
      count: 4,
      truncated: false,
    });

    await approve(t, OLDEST, "operator-1");
    await expect(countQueue(t)).resolves.toEqual({
      count: 3,
      truncated: false,
    });
    const queue = await listQueue(t, "awaiting_review", 20);
    expect(queue.page.map(({ subject }) => subject)).toEqual([
      LEGACY,
      NEWER,
      REVOKED,
    ]);
  });

  test("stays bounded on a queue larger than one scan, and says so", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      for (let index = 0; index < 501; index += 1) {
        await ctx.db.insert("productUsers", {
          subject: `privy.io|did:privy:bulk-${String(index).padStart(4, "0")}`,
          authMethod: "privy.io",
          email: null,
          walletAddress: null,
          walletAddressKey: null,
          firstSeenAt: "2026-08-01T09:00:00.000Z",
          lastSeenAt: "2026-08-01T09:00:00.000Z",
          standing: "active",
        });
      }
    });

    const queue = await listQueue(t, "awaiting_review", 20);
    expect(queue.page).toHaveLength(20);
    expect(queue.queueTruncated).toBe(true);

    // The count reports its bound and that the real number is at least it.
    await expect(countQueue(t)).resolves.toEqual({
      count: 500,
      truncated: true,
    });
  });

  test("keeps every operation and read out of the public API", () => {
    for (const registered of [
      approveAccess,
      declineAccess,
      revokeAccess,
      listAccessQueuePage,
      countAwaitingReview,
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

describe("admin access-review integration transport", () => {
  async function post(
    t: AccessReviewTest,
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

  const decideBody = {
    subject: USER_A.tokenIdentifier,
    operatorId: "operator-1",
  };

  test("refuses every caller without the configured deployment secret", async () => {
    const t = createTest();

    // No secret configured: the surface fails closed even with a plausible
    // token presented.
    for (const path of REVIEW_PATHS) {
      const unconfigured = await post(
        t,
        path,
        decideBody,
        `Bearer ${ADMIN_TOKEN}`,
      );
      expect(unconfigured.status).toBe(401);
      expect(await unconfigured.json()).toEqual({
        error: "The product-user directory integration is not authorized.",
        code: "ADMIN_DIRECTORY_UNAUTHORIZED",
      });
    }

    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);
    for (const path of REVIEW_PATHS) {
      for (const authorization of [
        undefined,
        "Bearer",
        `Bearer ${ADMIN_TOKEN.replace("1", "2")}`,
        ADMIN_TOKEN,
      ]) {
        const response = await post(t, path, decideBody, authorization);
        expect(response.status).toBe(401);
      }
    }
  });

  test("serves decisions, the queue, and the count to the admin server", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T10:00:00.000Z");
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);
    const t = createTest();
    const authorization = `Bearer ${ADMIN_TOKEN}`;
    await t
      .withIdentity(USER_A)
      .mutation(api.productUserAccess.establishAccess, {});
    await t
      .withIdentity(INVITEE)
      .mutation(api.productUserAccess.establishAccess, {});

    vi.setSystemTime("2026-08-20T11:00:00.000Z");
    const approved = await post(t, APPROVE_PATH, decideBody, authorization);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({
      outcome: "decided",
      action: "approve",
      subject: USER_A.tokenIdentifier,
      operatorId: "operator-1",
      decidedAt: "2026-08-20T11:00:00.000Z",
      changed: true,
      previous: defaultDecision("2026-08-20T10:00:00.000Z"),
      resulting: {
        state: "approved",
        decidedBy: "operator",
        decidedAt: "2026-08-20T11:00:00.000Z",
        operatorId: "operator-1",
      },
      effectiveAccess: { admitted: true, reason: "approved" },
    });

    // The queue defaults to awaiting review and no longer lists the
    // just-approved identity; rows carry the decision alongside the
    // directory's identity, standing, and saved-item fields.
    const queue = await post(
      t,
      QUEUE_PATH,
      { paginationOpts: { numItems: 20, cursor: null } },
      authorization,
    );
    expect(queue.status).toBe(200);
    expect(await queue.json()).toEqual({
      page: [
        {
          subject: INVITEE.tokenIdentifier,
          authMethod: "privy.io",
          email: INVITEE.email,
          walletAddress: null,
          firstSeenAt: "2026-08-20T10:00:00.000Z",
          lastSeenAt: "2026-08-20T10:00:00.000Z",
          standing: "active",
          access: defaultDecision("2026-08-20T10:00:00.000Z"),
          savedRepackCount: 0,
          savedCollectibleCount: 0,
        },
      ],
      isDone: true,
      continueCursor: null,
      queueTruncated: false,
    });

    const count = await post(t, QUEUE_COUNT_PATH, {}, authorization);
    expect(count.status).toBe(200);
    expect(await count.json()).toEqual({ count: 1, truncated: false });

    // A subject the directory has never recorded is a reported outcome, not
    // an error and not a created record.
    const unknown = await post(
      t,
      DECLINE_PATH,
      { subject: "privy.io|did:privy:never-seen", operatorId: "operator-1" },
      authorization,
    );
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({
      outcome: "nothing_to_decide",
      action: "decline",
    });
  });

  test("maps malformed and refused requests without leaking backend errors", async () => {
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);
    const t = createTest();
    const authorization = `Bearer ${ADMIN_TOKEN}`;
    await t
      .withIdentity(USER_A)
      .mutation(api.productUserAccess.establishAccess, {});

    for (const body of [
      "not-json",
      [],
      {},
      { subject: 42, operatorId: "operator-1" },
      { subject: USER_A.tokenIdentifier, operatorId: "" },
      { subject: USER_A.tokenIdentifier },
    ]) {
      const response = await post(t, APPROVE_PATH, body, authorization);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "ADMIN_DIRECTORY_REQUEST_INVALID",
      });
    }

    // Semantic refusals surface their stable codes, never the identifier.
    const emptySubject = await post(
      t,
      REVOKE_PATH,
      { subject: "", operatorId: "operator-1" },
      authorization,
    );
    expect(emptySubject.status).toBe(400);
    expect(await emptySubject.json()).toEqual({
      error: "The product-user directory request was rejected.",
      code: "PRODUCT_USER_SUBJECT_INVALID",
    });
    const blankOperator = await post(
      t,
      DECLINE_PATH,
      { subject: USER_A.tokenIdentifier, operatorId: "   " },
      authorization,
    );
    expect(blankOperator.status).toBe(400);
    expect(await blankOperator.json()).toMatchObject({
      code: "PRODUCT_USER_OPERATOR_INVALID",
    });
    const oversizedOperator = await post(
      t,
      DECLINE_PATH,
      { subject: USER_A.tokenIdentifier, operatorId: "a".repeat(200) },
      authorization,
    );
    expect(oversizedOperator.status).toBe(400);
    expect(await oversizedOperator.json()).toMatchObject({
      code: "PRODUCT_USER_OPERATOR_INVALID",
    });

    const badState = await post(
      t,
      QUEUE_PATH,
      {
        accessState: "banished",
        paginationOpts: { numItems: 20, cursor: null },
      },
      authorization,
    );
    expect(badState.status).toBe(400);
    expect(await badState.json()).toMatchObject({
      code: "ADMIN_DIRECTORY_REQUEST_INVALID",
    });
    const oversizedPage = await post(
      t,
      QUEUE_PATH,
      { paginationOpts: { numItems: 500, cursor: null } },
      authorization,
    );
    expect(oversizedPage.status).toBe(400);
    expect(await oversizedPage.json()).toMatchObject({
      code: "PRODUCT_USER_PAGE_SIZE_INVALID",
    });
    const badCursor = await post(
      t,
      QUEUE_PATH,
      { paginationOpts: { numItems: 20, cursor: "garbage" } },
      authorization,
    );
    expect(badCursor.status).toBe(400);
    expect(await badCursor.json()).toMatchObject({
      code: "PRODUCT_USER_PAGE_CURSOR_INVALID",
    });
    const countBody = await post(
      t,
      QUEUE_COUNT_PATH,
      "not-json",
      authorization,
    );
    expect(countBody.status).toBe(400);
  });

  test("exposes no other method or path", async () => {
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);
    const t = createTest();

    const wrongMethod = await t.fetch(APPROVE_PATH, {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(wrongMethod.status).toBe(404);

    const wrongPath = await post(
      t,
      "/admin/product-users/access",
      decideBody,
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(wrongPath.status).toBe(404);
  });
});
