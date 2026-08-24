/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type {
  ProductUserAccessDecision,
  ProductUserWelcomeMarker,
} from "./productUserRecords";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type WelcomeTest = TestConvex<typeof schema>;

/**
 * messaging/007: the once-ever welcome marker.
 *
 * The suite covers the whole marker state machine — arming at the first
 * admitted session (and only there), the grandfathering guard against
 * retroactive welcomes, the no-address skip, concurrency-safe claiming,
 * lapse-and-reclaim recovery for a dispatcher that crashes between claiming
 * and enqueueing, terminal settlement, and the once-ever guarantee across
 * revocation and re-admission.
 */

const ADMIN_TOKEN = "welcome-dispatch-integration-token-0001";
const CLAIM_PATH = "/admin/product-users/welcome/claim";
const SETTLE_PATH = "/admin/product-users/welcome/settle";

const INVITEE = {
  subject: "did:privy:invitee",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:invitee",
  email: "invitee@example.com",
};
const WALLET_ONLY = {
  subject: "did:privy:wallet-only",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:wallet-only",
  wallet_address: "0xAbCdEf0123456789abcdef0123456789ABCDEF01",
};
const WAITER = {
  subject: "did:privy:waiter",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:waiter",
  email: "waiter@example.com",
};

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function closeBeta() {
  vi.stubEnv("PACKSCOUT_CLOSED_BETA", "1");
}

async function inviteByEmail(t: WelcomeTest, email: string) {
  await t.mutation(internal.betaAllowlist.createEntry, {
    email,
    walletAddress: null,
    label: null,
    operatorId: "operator-1",
  });
}

async function readRecord(t: WelcomeTest, subject: string) {
  return await t.run(async (ctx) => {
    const record = await ctx.db
      .query("productUsers")
      .withIndex("by_subject", (index) => index.eq("subject", subject))
      .unique();
    if (record === null) throw new Error("Expected a recorded user.");
    return record;
  });
}

async function readMarker(
  t: WelcomeTest,
  subject: string,
): Promise<ProductUserWelcomeMarker | undefined> {
  return (await readRecord(t, subject)).welcome;
}

/** A record shaped exactly as it stood before this task shipped. */
async function insertPreRolloutRecord(
  t: WelcomeTest,
  input: {
    subject: string;
    email: string | null;
    access: ProductUserAccessDecision;
    lastSeenAt: string;
    standing?: "active" | "suspended";
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("productUsers", {
      subject: input.subject,
      authMethod: "privy.io",
      email: input.email,
      walletAddress: null,
      walletAddressKey: null,
      firstSeenAt: "2026-07-01T09:00:00.000Z",
      lastSeenAt: input.lastSeenAt,
      standing: input.standing ?? "active",
      access: input.access,
    });
  });
}

async function patchRecord(
  t: WelcomeTest,
  subject: string,
  patch: { standing?: "active" | "suspended" },
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

async function claim(t: WelcomeTest, limit = 20, leaseMilliseconds?: number) {
  return await t.mutation(internal.productUserWelcome.claimDueWelcomes, {
    limit,
    ...(leaseMilliseconds === undefined ? {} : { leaseMilliseconds }),
  });
}

async function settle(
  t: WelcomeTest,
  subject: string,
  outcome: "sent" | "no_verified_email",
) {
  return await t.mutation(internal.productUserWelcome.settleWelcome, {
    subject,
    outcome,
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

describe("arming at the first admitted session", () => {
  test("sign-ins while awaiting review arm nothing — a welcome never precedes admission", async () => {
    closeBeta();
    const t = createTest();
    const user = t.withIdentity(WAITER);
    await user.mutation(api.productUserAccess.establishAccess, {});
    await user.mutation(api.productUserAccess.establishAccess, {});
    expect(await readMarker(t, WAITER.tokenIdentifier)).toBeUndefined();
    await expect(claim(t)).resolves.toEqual({ claims: [] });
  });

  test("allowlist admission at the very first contact arms the welcome in that same session", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-23T10:00:00.000Z");
    const t = createTest();
    await inviteByEmail(t, INVITEE.email);

    await expect(
      t.withIdentity(INVITEE).mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual({ admitted: true, reason: "approved" });

    expect(await readMarker(t, INVITEE.tokenIdentifier)).toEqual({
      state: "due",
      dueAt: "2026-08-23T10:00:00.000Z",
    });
  });

  test("an operator approval alone arms nothing; the next session is the first admitted one and arms it", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-23T10:00:00.000Z");
    const t = createTest();
    const user = t.withIdentity(WAITER);
    await user.mutation(api.productUserAccess.establishAccess, {});

    vi.setSystemTime("2026-08-23T11:00:00.000Z");
    await t.mutation(internal.productUserAccessReview.approveAccess, {
      subject: WAITER.tokenIdentifier,
      operatorId: "operator-1",
    });
    // The decision alone is not a session: nothing is armed yet.
    expect(await readMarker(t, WAITER.tokenIdentifier)).toBeUndefined();

    vi.setSystemTime("2026-08-23T12:00:00.000Z");
    await user.mutation(api.productUserAccess.establishAccess, {});
    expect(await readMarker(t, WAITER.tokenIdentifier)).toEqual({
      state: "due",
      dueAt: "2026-08-23T12:00:00.000Z",
    });
  });

  test("an approval between contacts arms even inside the last-seen refresh window", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-23T10:00:00.000Z");
    const t = createTest();
    const user = t.withIdentity(WAITER);
    await user.mutation(api.productUserAccess.establishAccess, {});
    vi.setSystemTime("2026-08-23T10:00:10.000Z");
    await t.mutation(internal.productUserAccessReview.approveAccess, {
      subject: WAITER.tokenIdentifier,
      operatorId: "operator-1",
    });
    // Twenty seconds after first contact: attribute and last-seen refresh
    // would normally be elided, but the marker write must still land.
    vi.setSystemTime("2026-08-23T10:00:20.000Z");
    await user.mutation(api.productUserAccess.establishAccess, {});
    expect(await readMarker(t, WAITER.tokenIdentifier)).toMatchObject({
      state: "due",
    });
  });

  test("an admitted identity with no verified email is recorded not applicable and never revisited", async () => {
    closeBeta();
    const t = createTest();
    await t.mutation(internal.betaAllowlist.createEntry, {
      email: null,
      walletAddress: WALLET_ONLY.wallet_address,
      label: null,
      operatorId: "operator-1",
    });

    await t
      .withIdentity(WALLET_ONLY)
      .mutation(api.productUserAccess.establishAccess, {});
    expect(await readMarker(t, WALLET_ONLY.tokenIdentifier)).toMatchObject({
      state: "not_applicable",
      reason: "no_verified_email",
    });
    await expect(claim(t)).resolves.toEqual({ claims: [] });

    // A later sign-in that exposes an address does not re-arm: the skip was
    // recorded once, as a normal outcome, and is never retried.
    await t
      .withIdentity({ ...WALLET_ONLY, email: "late@example.com" })
      .mutation(api.productUserAccess.establishAccess, {});
    expect(await readMarker(t, WALLET_ONLY.tokenIdentifier)).toMatchObject({
      state: "not_applicable",
      reason: "no_verified_email",
    });
    await expect(claim(t)).resolves.toEqual({ claims: [] });
  });
});

describe("no retroactive welcome for identities active before this shipped", () => {
  test("an approved identity that already had a contact while approved is grandfathered, not welcomed", async () => {
    closeBeta();
    const t = createTest();
    // Approved 2026-07-02, last seen 2026-07-10: at least one session
    // happened while approved, all before the marker machinery existed.
    await insertPreRolloutRecord(t, {
      subject: WAITER.tokenIdentifier,
      email: WAITER.email,
      access: {
        state: "approved",
        decidedBy: "operator",
        operatorId: "operator-1",
        decidedAt: "2026-07-02T09:00:00.000Z",
      },
      lastSeenAt: "2026-07-10T09:00:00.000Z",
    });

    await expect(
      t.withIdentity(WAITER).mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual({ admitted: true, reason: "approved" });
    expect(await readMarker(t, WAITER.tokenIdentifier)).toMatchObject({
      state: "not_applicable",
      reason: "grandfathered",
    });
    await expect(claim(t)).resolves.toEqual({ claims: [] });
  });

  test("an approval stamped at the identity's last contact reads as already admitted then — grandfathered", async () => {
    closeBeta();
    const t = createTest();
    // The allowlist-at-establishment shape from before this shipped:
    // decidedAt equals lastSeenAt because that contact was the admission.
    await insertPreRolloutRecord(t, {
      subject: WAITER.tokenIdentifier,
      email: WAITER.email,
      access: {
        state: "approved",
        decidedBy: "allowlist",
        allowlistEntryId: "entry-1",
        decidedAt: "2026-07-10T09:00:00.000Z",
      },
      lastSeenAt: "2026-07-10T09:00:00.000Z",
    });

    await t.withIdentity(WAITER).mutation(api.productUserAccess.establishAccess, {});
    expect(await readMarker(t, WAITER.tokenIdentifier)).toMatchObject({
      state: "not_applicable",
      reason: "grandfathered",
    });
  });

  test("an approval that landed after the identity's last contact is a first admitted session and arms", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-23T10:00:00.000Z");
    const t = createTest();
    // Last seen 2026-07-10, approved 2026-07-20: no session has happened
    // while admitted, so the next one is genuinely the first — this
    // identity is newly reaching its first admitted session, not being
    // welcomed retroactively.
    await insertPreRolloutRecord(t, {
      subject: WAITER.tokenIdentifier,
      email: WAITER.email,
      access: {
        state: "approved",
        decidedBy: "operator",
        operatorId: "operator-1",
        decidedAt: "2026-07-20T09:00:00.000Z",
      },
      lastSeenAt: "2026-07-10T09:00:00.000Z",
    });

    await t.withIdentity(WAITER).mutation(api.productUserAccess.establishAccess, {});
    expect(await readMarker(t, WAITER.tokenIdentifier)).toEqual({
      state: "due",
      dueAt: "2026-08-23T10:00:00.000Z",
    });
  });

  test("suspension defers arming; contacts made while suspended then read as grandfathered after reinstatement", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-23T10:00:00.000Z");
    const t = createTest();
    const user = t.withIdentity(WAITER);
    await user.mutation(api.productUserAccess.establishAccess, {});
    vi.setSystemTime("2026-08-23T11:00:00.000Z");
    await t.mutation(internal.productUserAccessReview.approveAccess, {
      subject: WAITER.tokenIdentifier,
      operatorId: "operator-1",
    });
    await patchRecord(t, WAITER.tokenIdentifier, { standing: "suspended" });

    // Approved but suspended: not admitted, so nothing arms — and the
    // contact still refreshes last-seen like any other.
    vi.setSystemTime("2026-08-23T12:00:00.000Z");
    await expect(
      user.mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual({ admitted: false, reason: "suspended" });
    expect(await readMarker(t, WAITER.tokenIdentifier)).toBeUndefined();

    // Deliberate, documented consequence of the arming rule: contact
    // recency is the only durable trace of past sessions, so the suspended
    // contact makes the reinstated identity read as grandfathered. The rule
    // errs toward silence, never toward a duplicate or retroactive welcome.
    await patchRecord(t, WAITER.tokenIdentifier, { standing: "active" });
    vi.setSystemTime("2026-08-23T13:00:00.000Z");
    await user.mutation(api.productUserAccess.establishAccess, {});
    expect(await readMarker(t, WAITER.tokenIdentifier)).toMatchObject({
      state: "not_applicable",
      reason: "grandfathered",
    });
  });
});

describe("sign-in is unaffected by the marker", () => {
  test("establishment contracts are unchanged through every arming outcome", async () => {
    closeBeta();
    const t = createTest();
    await inviteByEmail(t, INVITEE.email);
    // The arming session returns exactly the composed access, nothing more.
    await expect(
      t.withIdentity(INVITEE).mutation(api.productUserAccess.establishAccess, {}),
    ).resolves.toEqual({ admitted: true, reason: "approved" });
    // recordSignIn keeps its deployed { created, standing } contract while
    // its shared write path stamps the marker for an admitted first contact.
    await expect(
      t.withIdentity(WALLET_ONLY).mutation(api.productUsers.recordSignIn, {}),
    ).resolves.toEqual({ created: true, standing: "active" });
    // Claiming and settling change nothing the product caller can observe.
    await claim(t);
    await settle(t, INVITEE.tokenIdentifier, "sent");
    await expect(
      t.withIdentity(INVITEE).query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual({ admitted: true, reason: "approved" });
  });
});

describe("claiming", () => {
  test("claims are bounded and hand out oldest-armed identities first", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-23T10:00:00.000Z");
    const t = createTest();
    for (const [index, minute] of [0, 1, 2].entries()) {
      const email = `user-${index}@example.com`;
      await inviteByEmail(t, email);
      vi.setSystemTime(`2026-08-23T10:0${minute}:00.000Z`);
      await t
        .withIdentity({
          subject: `did:privy:user-${index}`,
          issuer: "privy.io",
          tokenIdentifier: `privy.io|did:privy:user-${index}`,
          email,
        })
        .mutation(api.productUserAccess.establishAccess, {});
    }

    vi.setSystemTime("2026-08-23T11:00:00.000Z");
    const first = await claim(t, 2, 60_000);
    expect(first.claims).toEqual([
      { subject: "privy.io|did:privy:user-0", email: "user-0@example.com" },
      { subject: "privy.io|did:privy:user-1", email: "user-1@example.com" },
    ]);
    expect(await readMarker(t, "privy.io|did:privy:user-0")).toEqual({
      state: "claimed",
      dueAt: "2026-08-23T10:00:00.000Z",
      claimedAt: "2026-08-23T11:00:00.000Z",
      claimExpiresAt: "2026-08-23T11:01:00.000Z",
    });
    // The pass is bounded: the third identity stays due for the next one.
    expect(await readMarker(t, "privy.io|did:privy:user-2")).toMatchObject({
      state: "due",
    });
  });

  test("concurrent discovery never hands the same identity to two dispatchers", async () => {
    closeBeta();
    const t = createTest();
    await inviteByEmail(t, INVITEE.email);
    await t.withIdentity(INVITEE).mutation(api.productUserAccess.establishAccess, {});

    const [left, right] = await Promise.all([claim(t, 20), claim(t, 20)]);
    const total = [...left.claims, ...right.claims];
    expect(total).toEqual([
      { subject: INVITEE.tokenIdentifier, email: INVITEE.email },
    ]);
  });

  test("a crash between claiming and enqueueing lapses back into discovery — retried, not lost, and never doubled", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-23T10:00:00.000Z");
    const t = createTest();
    await inviteByEmail(t, INVITEE.email);
    await t.withIdentity(INVITEE).mutation(api.productUserAccess.establishAccess, {});

    // Dispatcher A claims and then crashes: no settle ever arrives.
    const claimed = await claim(t, 20, 60_000);
    expect(claimed.claims).toHaveLength(1);

    // While the claim is live, discovery yields nothing — no double claim.
    await expect(claim(t, 20, 60_000)).resolves.toEqual({ claims: [] });

    // Past the expiry the identity is rediscovered exactly once, and the
    // outbox idempotency key (derived from the subject) converges whatever
    // both passes enqueued onto one message.
    vi.setSystemTime("2026-08-23T10:01:30.000Z");
    const reclaimed = await claim(t, 20, 60_000);
    expect(reclaimed.claims).toEqual([
      { subject: INVITEE.tokenIdentifier, email: INVITEE.email },
    ]);
    await settle(t, INVITEE.tokenIdentifier, "sent");
    expect(await readMarker(t, INVITEE.tokenIdentifier)).toMatchObject({
      state: "sent",
    });
  });

  test("claim bounds are refused, never clamped", async () => {
    const t = createTest();
    for (const limit of [0, 21, 2.5]) {
      await expectErrorCode(
        t.mutation(internal.productUserWelcome.claimDueWelcomes, { limit }),
        "PRODUCT_USER_WELCOME_REQUEST_INVALID",
      );
    }
    for (const leaseMilliseconds of [999, 900_001, 0.5]) {
      await expectErrorCode(
        t.mutation(internal.productUserWelcome.claimDueWelcomes, {
          limit: 1,
          leaseMilliseconds,
        }),
        "PRODUCT_USER_WELCOME_REQUEST_INVALID",
      );
    }
  });
});

describe("settlement", () => {
  test("sent is terminal: settlement is idempotent and the identity is never discovered again", async () => {
    closeBeta();
    const t = createTest();
    await inviteByEmail(t, INVITEE.email);
    const user = t.withIdentity(INVITEE);
    await user.mutation(api.productUserAccess.establishAccess, {});
    await claim(t);

    await expect(settle(t, INVITEE.tokenIdentifier, "sent")).resolves.toEqual({
      outcome: "settled",
      state: "sent",
    });
    await expect(settle(t, INVITEE.tokenIdentifier, "sent")).resolves.toEqual({
      outcome: "already_settled",
      state: "sent",
    });
    await expect(claim(t)).resolves.toEqual({ claims: [] });

    // However many times the person signs in afterwards, nothing re-arms.
    await user.mutation(api.productUserAccess.establishAccess, {});
    await user.mutation(api.productUserAccess.establishAccess, {});
    expect(await readMarker(t, INVITEE.tokenIdentifier)).toMatchObject({
      state: "sent",
    });
    await expect(claim(t)).resolves.toEqual({ claims: [] });
  });

  test("a claim found without a usable address settles as the recorded skip", async () => {
    closeBeta();
    const t = createTest();
    await inviteByEmail(t, INVITEE.email);
    await t.withIdentity(INVITEE).mutation(api.productUserAccess.establishAccess, {});
    await claim(t);

    await expect(
      settle(t, INVITEE.tokenIdentifier, "no_verified_email"),
    ).resolves.toEqual({ outcome: "settled", state: "not_applicable" });
    await expect(claim(t)).resolves.toEqual({ claims: [] });
  });

  test("a dispatcher whose claim lapsed after a durable enqueue may still settle truthfully", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-23T10:00:00.000Z");
    const t = createTest();
    await inviteByEmail(t, INVITEE.email);
    await t.withIdentity(INVITEE).mutation(api.productUserAccess.establishAccess, {});
    await claim(t, 20, 1_000);

    vi.setSystemTime("2026-08-23T10:00:05.000Z");
    await expect(settle(t, INVITEE.tokenIdentifier, "sent")).resolves.toEqual({
      outcome: "settled",
      state: "sent",
    });
  });

  test("settling an identity that was never armed reports nothing to settle", async () => {
    closeBeta();
    const t = createTest();
    await expect(settle(t, "privy.io|did:privy:unknown", "sent")).resolves.toEqual(
      { outcome: "nothing_to_settle" },
    );
    await t.withIdentity(WAITER).mutation(api.productUserAccess.establishAccess, {});
    await expect(settle(t, WAITER.tokenIdentifier, "sent")).resolves.toEqual({
      outcome: "nothing_to_settle",
    });
  });
});

describe("once ever across decision changes", () => {
  test("admitted, revoked, and admitted again is never welcomed a second time", async () => {
    closeBeta();
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-23T10:00:00.000Z");
    const t = createTest();
    await inviteByEmail(t, INVITEE.email);
    const user = t.withIdentity(INVITEE);
    await user.mutation(api.productUserAccess.establishAccess, {});
    await claim(t);
    await settle(t, INVITEE.tokenIdentifier, "sent");

    vi.setSystemTime("2026-08-23T11:00:00.000Z");
    await t.mutation(internal.productUserAccessReview.revokeAccess, {
      subject: INVITEE.tokenIdentifier,
      operatorId: "operator-1",
    });
    vi.setSystemTime("2026-08-23T11:30:00.000Z");
    await user.mutation(api.productUserAccess.establishAccess, {});

    vi.setSystemTime("2026-08-23T12:00:00.000Z");
    await t.mutation(internal.productUserAccessReview.approveAccess, {
      subject: INVITEE.tokenIdentifier,
      operatorId: "operator-1",
    });
    // The re-approval postdates the last contact, which is exactly the
    // shape that arms a first welcome — only the persisted marker stops it.
    vi.setSystemTime("2026-08-23T13:00:00.000Z");
    await user.mutation(api.productUserAccess.establishAccess, {});

    expect(await readMarker(t, INVITEE.tokenIdentifier)).toMatchObject({
      state: "sent",
    });
    await expect(claim(t)).resolves.toEqual({ claims: [] });
  });

  test("a revocation racing ahead of the dispatcher neither duplicates nor loses the one welcome", async () => {
    closeBeta();
    const t = createTest();
    await inviteByEmail(t, INVITEE.email);
    const user = t.withIdentity(INVITEE);
    await user.mutation(api.productUserAccess.establishAccess, {});

    // Revoked and re-approved before any dispatcher pass ran: the due
    // marker survives both decision flips untouched.
    await t.mutation(internal.productUserAccessReview.revokeAccess, {
      subject: INVITEE.tokenIdentifier,
      operatorId: "operator-1",
    });
    await user.mutation(api.productUserAccess.establishAccess, {});
    await t.mutation(internal.productUserAccessReview.approveAccess, {
      subject: INVITEE.tokenIdentifier,
      operatorId: "operator-1",
    });
    await user.mutation(api.productUserAccess.establishAccess, {});

    const claimed = await claim(t);
    expect(claimed.claims).toEqual([
      { subject: INVITEE.tokenIdentifier, email: INVITEE.email },
    ]);
    await settle(t, INVITEE.tokenIdentifier, "sent");
    await expect(claim(t)).resolves.toEqual({ claims: [] });
  });
});

describe("the admin-integration surface", () => {
  async function post(
    t: WelcomeTest,
    path: string,
    body: unknown,
    authorization?: string,
  ) {
    return await t.fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify(body),
    });
  }

  test("both operations require the deployment secret and fail closed without it", async () => {
    const t = createTest();
    // No secret configured: the surface refuses even a plausible token.
    for (const path of [CLAIM_PATH, SETTLE_PATH]) {
      const unconfigured = await post(t, path, {}, `Bearer ${ADMIN_TOKEN}`);
      expect(unconfigured.status).toBe(401);
    }
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);
    for (const authorization of [undefined, "Bearer wrong-token-wrong-token-wrong-token"]) {
      const response = await post(t, CLAIM_PATH, { limit: 5 }, authorization);
      expect(response.status).toBe(401);
    }
  });

  test("the dispatcher claims and settles through the surface; identifiers travel only in bodies", async () => {
    closeBeta();
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);
    const t = createTest();
    await inviteByEmail(t, INVITEE.email);
    await t.withIdentity(INVITEE).mutation(api.productUserAccess.establishAccess, {});

    const claimed = await post(
      t,
      CLAIM_PATH,
      { limit: 5, leaseMilliseconds: 60_000 },
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual({
      claims: [{ subject: INVITEE.tokenIdentifier, email: INVITEE.email }],
    });

    const settled = await post(
      t,
      SETTLE_PATH,
      { subject: INVITEE.tokenIdentifier, outcome: "sent" },
      `Bearer ${ADMIN_TOKEN}`,
    );
    expect(settled.status).toBe(200);
    expect(await settled.json()).toEqual({ outcome: "settled", state: "sent" });
  });

  test("malformed requests are refused with fixed strings that echo nothing", async () => {
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", ADMIN_TOKEN);
    const t = createTest();
    for (const body of [
      { limit: 0 },
      { limit: 21 },
      { limit: "5" },
      { limit: 5, leaseMilliseconds: 10 },
      {},
    ]) {
      const response = await post(t, CLAIM_PATH, body, `Bearer ${ADMIN_TOKEN}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "The product-user directory request was rejected.",
        code: "ADMIN_DIRECTORY_REQUEST_INVALID",
      });
    }
    for (const body of [
      { subject: "x", outcome: "delivered" },
      { outcome: "sent" },
      { subject: 7, outcome: "sent" },
    ]) {
      const response = await post(t, SETTLE_PATH, body, `Bearer ${ADMIN_TOKEN}`);
      expect(response.status).toBe(400);
    }
  });
});
