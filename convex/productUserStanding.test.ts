/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";
import schema from "./schema";

/**
 * Fail-closed standing enforcement for authenticated product capabilities.
 *
 * "Fail-closed" here means the check trusts the stored directory record over
 * the session: a suspension takes effect against a session established before
 * it, because standing is re-read inside every write transaction. It does not
 * mean an identity without a record is denied — that identity is an unrecorded
 * sign-up and stays fully capable.
 */

const modules = import.meta.glob("./**/*.ts");
type StandingTest = TestConvex<typeof schema>;
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

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

async function seed(t: StandingTest): Promise<void> {
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

function setStanding(
  t: StandingTest,
  subject: string,
  standing: "active" | "suspended",
) {
  return t.mutation(internal.productUserDirectory.setDirectoryStanding, {
    subject,
    standing,
  });
}

async function savedItemRows(t: StandingTest) {
  return await t.run(async (ctx) => ({
    repacks: (await ctx.db.query("savedRepacks").take(10)).map(
      ({ ownerTokenIdentifier, publicRepackId }) => ({
        ownerTokenIdentifier,
        publicRepackId,
      }),
    ),
    collectibles: (await ctx.db.query("savedCollectibles").take(10)).map(
      ({ ownerTokenIdentifier, publicCollectibleId }) => ({
        ownerTokenIdentifier,
        publicCollectibleId,
      }),
    ),
  }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("suspended standing enforcement", () => {
  test("rejects writes on a session established before the suspension", async () => {
    const t = createTest();
    await seed(t);
    const fixture = buildMockDataReleaseV2();
    const publicRepackId = fixture.repacks[0]!.publicRepackId;
    const otherRepackId = fixture.repacks[1]!.publicRepackId;
    const publicCollectibleId = fixture.collectibles[0]!.publicCollectibleId;

    // This handle is the user's session: it is established once, before the
    // suspension, and is never re-established afterwards.
    const session = t.withIdentity(USER_A);
    await session.mutation(api.productUsers.recordSignIn, {});
    await expect(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });

    await expect(setStanding(t, USER_A.tokenIdentifier, "suspended")).resolves
      .toMatchObject({ changed: true, record: { standing: "suspended" } });

    // The same, older session gains nothing: saving, unsaving, and saving a
    // different kind are all refused with one stable, distinguishable code.
    await expectErrorCode(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: otherRepackId,
        saved: true,
      }),
      "ACCOUNT_SUSPENDED",
    );
    await expectErrorCode(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: false,
      }),
      "ACCOUNT_SUSPENDED",
    );
    await expectErrorCode(
      session.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId,
        saved: true,
      }),
      "ACCOUNT_SUSPENDED",
    );

    // The refusal is distinguishable from an unauthenticated call, which the
    // frontend must present very differently.
    await expectErrorCode(
      t.mutation(api.savedItems.setSavedRepack, { publicRepackId, saved: true }),
      "AUTH_REQUIRED",
    );

    // The pre-suspension session reads its own new standing at request time.
    await expect(
      session.query(api.productUsers.getMyStanding, {}),
    ).resolves.toEqual({ standing: "suspended" });
  });

  test("suspension keeps every saved item, and reinstatement restores capabilities", async () => {
    const t = createTest();
    await seed(t);
    const fixture = buildMockDataReleaseV2();
    const publicRepackId = fixture.repacks[0]!.publicRepackId;
    const publicCollectibleId = fixture.collectibles[0]!.publicCollectibleId;
    const laterRepackId = fixture.repacks[1]!.publicRepackId;

    const session = t.withIdentity(USER_A);
    await session.mutation(api.productUsers.recordSignIn, {});
    await session.mutation(api.savedItems.setSavedRepack, {
      publicRepackId,
      saved: true,
    });
    await session.mutation(api.savedItems.setSavedCollectible, {
      publicCollectibleId,
      saved: true,
    });
    const beforeSuspension = await savedItemRows(t);

    await setStanding(t, USER_A.tokenIdentifier, "suspended");

    // Nothing was deleted or rewritten, and the account can still read what it
    // owns: suspension stops what the account can do, not what it has.
    await expect(savedItemRows(t)).resolves.toEqual(beforeSuspension);
    await expect(
      session.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: [publicRepackId],
      savedCollectibleIds: [publicCollectibleId],
    });

    await expect(setStanding(t, USER_A.tokenIdentifier, "active")).resolves
      .toMatchObject({ changed: true, record: { standing: "active" } });

    // Full capability returns on the very next request, on the same session.
    await expect(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: laterRepackId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });
    await expect(
      session.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId,
        saved: false,
      }),
    ).resolves.toEqual({ saved: false, prunedUnavailable: false });
    await expect(
      session.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: [publicRepackId, laterRepackId].sort(),
      savedCollectibleIds: [],
    });
    await expect(
      session.query(api.productUsers.getMyStanding, {}),
    ).resolves.toEqual({ standing: "active" });
  });

  test("an identity with no directory record keeps full capabilities", async () => {
    const t = createTest();
    await seed(t);
    const fixture = buildMockDataReleaseV2();
    const publicRepackId = fixture.repacks[0]!.publicRepackId;
    const publicCollectibleId = fixture.collectibles[0]!.publicCollectibleId;

    // A user who predates the directory, or whose best-effort record write has
    // not landed: no sign-in was ever recorded for them.
    const unrecorded = t.withIdentity(USER_B);
    await expect(
      t.run(async (ctx) => await ctx.db.query("productUsers").take(1)),
    ).resolves.toEqual([]);

    await expect(
      unrecorded.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });
    await expect(
      unrecorded.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });
    await expect(
      unrecorded.query(api.productUsers.getMyStanding, {}),
    ).resolves.toEqual({ standing: "active" });

    // Another account's suspension is not contagious: only an explicitly
    // suspended record of one's own blocks.
    await t.withIdentity(USER_A).mutation(api.productUsers.recordSignIn, {});
    await setStanding(t, USER_A.tokenIdentifier, "suspended");
    await expect(
      unrecorded.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: false,
      }),
    ).resolves.toEqual({ saved: false, prunedUnavailable: false });

    // Recording the sign-up now must not invent a standing of its own.
    await expect(
      unrecorded.mutation(api.productUsers.recordSignIn, {}),
    ).resolves.toEqual({ created: true, standing: "active" });
  });

  test("repeated and concurrent standing writes converge on the authoritative standing", async () => {
    const t = createTest();
    await t.withIdentity(USER_A).mutation(api.productUsers.recordSignIn, {});

    const first = await setStanding(t, USER_A.tokenIdentifier, "suspended");
    expect(first).toMatchObject({
      changed: true,
      record: { subject: USER_A.tokenIdentifier, standing: "suspended" },
    });

    // Suspending an already-suspended user is not an error; it reports the
    // authoritative current standing and states that nothing changed.
    const repeat = await setStanding(t, USER_A.tokenIdentifier, "suspended");
    expect(repeat).toMatchObject({
      changed: false,
      record: { standing: "suspended" },
    });

    // Two administrators acting at once both succeed and both learn the truth.
    const concurrent = await Promise.all([
      setStanding(t, USER_A.tokenIdentifier, "active"),
      setStanding(t, USER_A.tokenIdentifier, "active"),
    ]);
    expect(
      concurrent.map((outcome) => outcome.record?.standing),
    ).toEqual(["active", "active"]);
    expect(concurrent.filter(({ changed }) => changed)).toHaveLength(1);
    await expect(
      t.withIdentity(USER_A).query(api.productUsers.getMyStanding, {}),
    ).resolves.toEqual({ standing: "active" });

    // The flip never adds, removes, or duplicates a record.
    await expect(
      t.run(async (ctx) => (await ctx.db.query("productUsers").take(5)).length),
    ).resolves.toBe(1);
  });

  test("a subject the directory has never recorded is reported, not created", async () => {
    const t = createTest();

    await expect(
      setStanding(t, USER_B.tokenIdentifier, "suspended"),
    ).resolves.toEqual({ record: null, changed: false });
    await expect(
      t.run(async (ctx) => await ctx.db.query("productUsers").take(1)),
    ).resolves.toEqual([]);

    await expectErrorCode(
      setStanding(t, "", "suspended"),
      "PRODUCT_USER_SUBJECT_INVALID",
    );
    await expectErrorCode(
      setStanding(t, "s".repeat(1_025), "active"),
      "PRODUCT_USER_SUBJECT_INVALID",
    );
  });
});
