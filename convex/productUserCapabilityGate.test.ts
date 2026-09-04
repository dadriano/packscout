/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { buildMockDataReleaseV2 } from "./mockDataReleaseFixture";
import {
  PRODUCT_USER_ACCESS_PATH_EXEMPT_ENTRY_POINTS,
  PRODUCT_USER_CAPABILITY_REFUSAL_CODES,
} from "./productUserCapabilityGate";
import schema from "./schema";

/**
 * Closed-beta enforcement on authenticated product capabilities
 * (closed-beta-access/004).
 *
 * The behavioral half proves every authenticated capability re-resolves
 * effective access from the authoritative record at request time — refusing
 * awaiting-review, declined, suspended, and undetermined identities with
 * stable, distinguishable codes, giving a pre-decision session nothing,
 * leaving saved data untouched by refusals, and behaving exactly as today
 * while the switch is off.
 *
 * The enumeration half is structural: it scans every product-backend module's
 * source and fails when an authenticated entry point exists anywhere without
 * the shared gate, so a capability added next month cannot quietly skip it.
 */

const modules = import.meta.glob("./**/*.ts");
type GateTest = TestConvex<typeof schema>;
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
const OPERATOR = "operator-1";

const AWAITING_REVIEW_CODE = "BETA_ACCESS_AWAITING_REVIEW";
const DECLINED_CODE = "BETA_ACCESS_DECLINED";
const SUSPENDED_CODE = "ACCOUNT_SUSPENDED";
const UNDETERMINED_CODE = "BETA_ACCESS_UNDETERMINED";

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function closeBeta() {
  vi.stubEnv("PACKSCOUT_CLOSED_BETA", "1");
}

async function seed(t: GateTest): Promise<void> {
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

function decide(
  t: GateTest,
  operation:
    | typeof internal.productUserAccessReview.approveAccess
    | typeof internal.productUserAccessReview.declineAccess
    | typeof internal.productUserAccessReview.revokeAccess,
  subject: string,
) {
  return t.mutation(operation, { subject, operatorId: OPERATOR });
}

function setStanding(
  t: GateTest,
  subject: string,
  standing: "active" | "suspended",
) {
  return t.mutation(internal.productUserDirectory.setDirectoryStanding, {
    subject,
    standing,
  });
}

/** A record shaped exactly as sign-ins recorded before the closed beta. */
async function insertLegacyRecord(t: GateTest, subject: string): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("productUsers", {
      subject,
      authMethod: "privy.io",
      email: null,
      walletAddress: null,
      walletAddressKey: null,
      firstSeenAt: "2026-08-01T09:00:00.000Z",
      lastSeenAt: "2026-08-01T09:00:00.000Z",
      standing: "active",
    });
  });
}

async function savedRowCounts(t: GateTest) {
  return await t.run(async (ctx) => ({
    repacks: (await ctx.db.query("savedRepacks").take(20)).map(
      ({ ownerTokenIdentifier, publicRepackId }) => ({
        ownerTokenIdentifier,
        publicRepackId,
      }),
    ),
    collectibles: (await ctx.db.query("savedCollectibles").take(20)).map(
      ({ ownerTokenIdentifier, publicCollectibleId }) => ({
        ownerTokenIdentifier,
        publicCollectibleId,
      }),
    ),
  }));
}

/** Every capability call, so refusal tests cover the whole surface. */
function capabilityCalls(
  session: ReturnType<GateTest["withIdentity"]>,
  publicRepackId: string,
  publicCollectibleId: string,
): ReadonlyArray<() => Promise<unknown>> {
  return [
    () => session.query(api.savedItems.getSavedItemIds, {}),
    () => session.query(api.savedItems.getOwnerWatchlist, {}),
    () =>
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: true,
      }),
    () =>
      session.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId,
        saved: true,
      }),
  ];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("closed-beta enforcement on authenticated capabilities", () => {
  test("publishes the exact refusal-code vocabulary the frontend maps to notices", () => {
    expect(PRODUCT_USER_CAPABILITY_REFUSAL_CODES).toEqual({
      awaiting_review: AWAITING_REVIEW_CODE,
      declined: DECLINED_CODE,
      suspended: SUSPENDED_CODE,
      undetermined: UNDETERMINED_CODE,
    });
  });

  test("refuses each unadmitted state with its own stable code, distinct from auth failures", async () => {
    const t = createTest();
    await seed(t);
    closeBeta();
    const fixture = buildMockDataReleaseV2();
    const publicRepackId = fixture.repacks[0]!.publicRepackId;
    const publicCollectibleId = fixture.collectibles[0]!.publicCollectibleId;
    const session = t.withIdentity(USER_A);
    const calls = capabilityCalls(session, publicRepackId, publicCollectibleId);

    // An anonymous caller is an ordinary authentication failure — never an
    // admission refusal — in the on position too.
    await expectErrorCode(
      t.query(api.savedItems.getSavedItemIds, {}),
      "AUTH_REQUIRED",
    );

    // Awaiting review: the recorded default for a fresh sign-in.
    await session.mutation(api.productUsers.recordSignIn, {});
    for (const call of calls) {
      await expectErrorCode(call(), AWAITING_REVIEW_CODE);
    }

    // Declined by an operator.
    await decide(
      t,
      internal.productUserAccessReview.declineAccess,
      USER_A.tokenIdentifier,
    );
    for (const call of calls) {
      await expectErrorCode(call(), DECLINED_CODE);
    }

    // Approved but suspended: the composed resolution refuses the read too
    // while the beta is on, with the one shared suspended code.
    await decide(
      t,
      internal.productUserAccessReview.approveAccess,
      USER_A.tokenIdentifier,
    );
    await setStanding(t, USER_A.tokenIdentifier, "suspended");
    for (const call of calls) {
      await expectErrorCode(call(), SUSPENDED_CODE);
    }

    // Declined and suspended: the decline is the operative reason.
    await decide(
      t,
      internal.productUserAccessReview.declineAccess,
      USER_A.tokenIdentifier,
    );
    for (const call of calls) {
      await expectErrorCode(call(), DECLINED_CODE);
    }

    // Undetermined: the record cannot be read (impossible duplicates), and
    // nothing converts that into admission.
    await insertLegacyRecord(t, USER_B.tokenIdentifier);
    await insertLegacyRecord(t, USER_B.tokenIdentifier);
    const duplicated = t.withIdentity(USER_B);
    for (const call of capabilityCalls(
      duplicated,
      publicRepackId,
      publicCollectibleId,
    )) {
      await expectErrorCode(call(), UNDETERMINED_CODE);
    }

    // No refusal wrote anything.
    await expect(savedRowCounts(t)).resolves.toEqual({
      repacks: [],
      collectibles: [],
    });
  });

  test("an approved, unsuspended identity succeeds with today's exact shapes", async () => {
    const t = createTest();
    await seed(t);
    closeBeta();
    const fixture = buildMockDataReleaseV2();
    const publicRepackId = fixture.repacks[0]!.publicRepackId;
    const publicCollectibleId = fixture.collectibles[0]!.publicCollectibleId;
    const session = t.withIdentity(USER_A);

    await session.mutation(api.productUsers.recordSignIn, {});
    await decide(
      t,
      internal.productUserAccessReview.approveAccess,
      USER_A.tokenIdentifier,
    );

    await expect(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });
    await expect(
      session.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });
    await expect(
      session.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: [publicRepackId],
      savedCollectibleIds: [publicCollectibleId],
    });
    await expect(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: false,
      }),
    ).resolves.toEqual({ saved: false, prunedUnavailable: false });
  });

  test("a session established before a decline, revocation, or re-approval sees the change on its very next call, with data intact", async () => {
    const t = createTest();
    await seed(t);
    closeBeta();
    const fixture = buildMockDataReleaseV2();
    const publicRepackId = fixture.repacks[0]!.publicRepackId;
    const otherRepackId = fixture.repacks[1]!.publicRepackId;
    const publicCollectibleId = fixture.collectibles[0]!.publicCollectibleId;

    // The session: established once, before any decision changes below.
    const session = t.withIdentity(USER_A);
    await session.mutation(api.productUsers.recordSignIn, {});
    await decide(
      t,
      internal.productUserAccessReview.approveAccess,
      USER_A.tokenIdentifier,
    );
    await session.mutation(api.savedItems.setSavedRepack, {
      publicRepackId,
      saved: true,
    });
    await session.mutation(api.savedItems.setSavedCollectible, {
      publicCollectibleId,
      saved: true,
    });
    const ownedRows = await savedRowCounts(t);
    expect(ownedRows.repacks).toHaveLength(1);
    expect(ownedRows.collectibles).toHaveLength(1);

    // Declined mid-session: the same session's next calls are refused —
    // including reading what it owns — and the rows are untouched.
    await decide(
      t,
      internal.productUserAccessReview.declineAccess,
      USER_A.tokenIdentifier,
    );
    await expectErrorCode(
      session.query(api.savedItems.getSavedItemIds, {}),
      DECLINED_CODE,
    );
    await expectErrorCode(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: otherRepackId,
        saved: true,
      }),
      DECLINED_CODE,
    );
    await expectErrorCode(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: false,
      }),
      DECLINED_CODE,
    );
    await expect(savedRowCounts(t)).resolves.toEqual(ownedRows);

    // Revoked back to review: still refused, now with the review reason.
    await decide(
      t,
      internal.productUserAccessReview.revokeAccess,
      USER_A.tokenIdentifier,
    );
    await expectErrorCode(
      session.query(api.savedItems.getSavedItemIds, {}),
      AWAITING_REVIEW_CODE,
    );

    // Re-admitted: every capability returns, over exactly the same data.
    await decide(
      t,
      internal.productUserAccessReview.approveAccess,
      USER_A.tokenIdentifier,
    );
    await expect(
      session.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: [publicRepackId],
      savedCollectibleIds: [publicCollectibleId],
    });
    await expect(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: otherRepackId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });
  });

  test("a session admitted while the beta was off gains nothing once it turns on", async () => {
    const t = createTest();
    await seed(t);
    const fixture = buildMockDataReleaseV2();
    const publicRepackId = fixture.repacks[0]!.publicRepackId;

    // Fully public product: the session signs in and saves freely while its
    // recorded decision is still the awaiting-review default.
    const session = t.withIdentity(USER_A);
    await session.mutation(api.productUsers.recordSignIn, {});
    await expect(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });

    // The switch turns on; the pre-existing session carries no privilege
    // from the earlier state, and its data is untouched.
    closeBeta();
    await expectErrorCode(
      session.query(api.savedItems.getSavedItemIds, {}),
      AWAITING_REVIEW_CODE,
    );
    await expectErrorCode(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: false,
      }),
      AWAITING_REVIEW_CODE,
    );
    const rows = await savedRowCounts(t);
    expect(rows.repacks).toEqual([
      { ownerTokenIdentifier: USER_A.tokenIdentifier, publicRepackId },
    ]);
  });
});

describe("the beta switch off preserves today's behavior", () => {
  test("unadmitted and even declined identities keep every capability while the switch is off", async () => {
    const t = createTest();
    await seed(t);
    const fixture = buildMockDataReleaseV2();
    const publicRepackId = fixture.repacks[0]!.publicRepackId;
    const publicCollectibleId = fixture.collectibles[0]!.publicCollectibleId;
    const session = t.withIdentity(USER_A);

    await session.mutation(api.productUsers.recordSignIn, {});
    await decide(
      t,
      internal.productUserAccessReview.declineAccess,
      USER_A.tokenIdentifier,
    );

    // Admission state is recorded but not enforced: no new refusals exist.
    await expect(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });
    await expect(
      session.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });
    await expect(
      session.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: [publicRepackId],
      savedCollectibleIds: [publicCollectibleId],
    });
    await expect(
      session.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId,
        saved: false,
      }),
    ).resolves.toEqual({ saved: false, prunedUnavailable: false });
  });

  test("suspension enforcement is exactly today's: writes refuse, reads never do", async () => {
    const t = createTest();
    await seed(t);
    const fixture = buildMockDataReleaseV2();
    const publicRepackId = fixture.repacks[0]!.publicRepackId;
    const otherRepackId = fixture.repacks[1]!.publicRepackId;
    const publicCollectibleId = fixture.collectibles[0]!.publicCollectibleId;
    const session = t.withIdentity(USER_A);

    await session.mutation(api.productUsers.recordSignIn, {});
    await session.mutation(api.savedItems.setSavedRepack, {
      publicRepackId,
      saved: true,
    });
    await setStanding(t, USER_A.tokenIdentifier, "suspended");

    await expectErrorCode(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: otherRepackId,
        saved: true,
      }),
      SUSPENDED_CODE,
    );
    await expectErrorCode(
      session.mutation(api.savedItems.setSavedCollectible, {
        publicCollectibleId,
        saved: true,
      }),
      SUSPENDED_CODE,
    );
    // Identifier-only reads still show what the account owns. Watchlist is
    // save-gated, so it refuses the same way the write does.
    await expect(
      session.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({
      savedRepackIds: [publicRepackId],
      savedCollectibleIds: [],
    });
    await expectErrorCode(
      session.query(api.savedItems.getOwnerWatchlist, {}),
      SUSPENDED_CODE,
    );

    await setStanding(t, USER_A.tokenIdentifier, "active");
    await expect(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId: otherRepackId,
        saved: true,
      }),
    ).resolves.toEqual({ saved: true, prunedUnavailable: false });
  });

  test("an unreadable directory record keeps today's outcomes while the switch is off", async () => {
    const t = createTest();
    await seed(t);
    const fixture = buildMockDataReleaseV2();
    const publicRepackId = fixture.repacks[0]!.publicRepackId;

    await insertLegacyRecord(t, USER_B.tokenIdentifier);
    await insertLegacyRecord(t, USER_B.tokenIdentifier);
    const session = t.withIdentity(USER_B);

    // Identifier-only reads do not consult the directory while the beta is
    // off, exactly as before this task. Watchlist and writes hit the same
    // standing-read conflict they share. Neither outcome is an admission
    // refusal.
    await expect(
      session.query(api.savedItems.getSavedItemIds, {}),
    ).resolves.toEqual({ savedRepackIds: [], savedCollectibleIds: [] });
    await expectErrorCode(
      session.query(api.savedItems.getOwnerWatchlist, {}),
      "PRODUCT_USER_STATE_CONFLICT",
    );
    await expectErrorCode(
      session.mutation(api.savedItems.setSavedRepack, {
        publicRepackId,
        saved: true,
      }),
      "PRODUCT_USER_STATE_CONFLICT",
    );
  });
});

/**
 * Structural enumeration: discover every public entry point in the product
 * backend from module source, prove identity acquisition is confined, the
 * exemption list is exact, and every authenticated capability passes the
 * shared gate before touching the database. A new authenticated entry point
 * that skips the gate fails here, at build time.
 */
const rawModuleLoaders = import.meta.glob("./**/*.ts", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

/** Modules that register or support functions, excluding generated code and tests. */
function isScannedModulePath(path: string): boolean {
  return (
    !path.includes("_generated") &&
    !path.endsWith(".test.ts") &&
    !path.endsWith(".d.ts") &&
    !path.endsWith(".test-support.ts")
  );
}

/**
 * Removes block comments and whole-line `//` comments so documentation that
 * mentions an identity API (as `productUserRecords.ts` does) never counts as
 * using it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
}

async function loadScannedSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const [path, load] of Object.entries(rawModuleLoaders)) {
    if (!isScannedModulePath(path)) continue;
    sources.set(path.replace(/^\.\//u, ""), stripComments(await load()));
  }
  return sources;
}

type PublicRegistration = Readonly<{
  name: string;
  kind: "query" | "mutation" | "action";
  segment: string;
}>;

/**
 * Every public function registration in a module, each with the source
 * segment from its declaration to the next top-level export. Internal
 * registrations are excluded on purpose: they are unreachable from product
 * clients, and the admin integration authenticates server-side in `http.ts`.
 */
function publicRegistrationsOf(source: string): PublicRegistration[] {
  const pattern = /^export const (\w+) = (query|mutation|action)\(\{/gmu;
  return [...source.matchAll(pattern)].map((match) => {
    const start = match.index ?? 0;
    const tail = source.slice(start + match[0].length);
    const nextExport = tail.search(/^export /mu);
    return {
      name: match[1]!,
      kind: match[2] as PublicRegistration["kind"],
      segment: match[0] + (nextExport === -1 ? tail : tail.slice(0, nextExport)),
    };
  });
}

const IDENTITY_TOKENS = [
  "ctx.auth",
  "getUserIdentity",
  "requireProductUserIdentity",
] as const;

/**
 * The catalog read model's authorization helpers (closed-beta-access/005).
 * They answer "may this caller read the catalog?" with a bare boolean and no
 * subject, so they can never authorize an effect: a mutation or action that
 * consulted them instead of the capability gate would skip the refusal
 * vocabulary and the standing composition, and is refused below.
 */
const CATALOG_READ_AUTHORIZATION_TOKENS = [
  "catalogReadAuthorized",
  "identityIsAdmitted",
] as const;

const GATE_CALL = "requireAdmittedProductUser(";

describe("authenticated entry-point enumeration", () => {
  test("identity acquisition is confined to the access path and the catalog-read boundary", async () => {
    const sources = await loadScannedSources();
    const acquiring = [...sources]
      .filter(
        ([, source]) =>
          source.includes("ctx.auth") || source.includes("getUserIdentity"),
      )
      .map(([path]) => path)
      .sort();
    // Exactly two modules may talk to `ctx.auth`: the identity helper the
    // access path and the shared gate both use, and the catalog read model's
    // own enforcement boundary (closed-beta-access/005) — a sibling gate,
    // not a bypass: it composes the same effective-access resolution, never
    // throws, returns no subject, and authorizes reads only, so no
    // capability can be built on it. Equality also proves the scan is alive
    // — an empty result would fail, not pass vacuously.
    expect(acquiring).toEqual(["productUsers.ts", "publicCatalogReadAccess.ts"]);
  });

  test("the identity helper is reachable only from the access path and the shared gate", async () => {
    const sources = await loadScannedSources();
    const referencing = [...sources]
      .filter(([, source]) => source.includes("requireProductUserIdentity"))
      .map(([path]) => path)
      .sort();
    expect(referencing).toEqual([
      "productUserAccess.ts",
      "productUserCapabilityGate.ts",
      "productUsers.ts",
    ]);
  });

  test("the access-path exemption list is exact and every exempt entry point is genuinely on the access path", async () => {
    const sources = await loadScannedSources();
    const productUsers = publicRegistrationsOf(
      sources.get("productUsers.ts") ?? "",
    );
    const productUserAccess = publicRegistrationsOf(
      sources.get("productUserAccess.ts") ?? "",
    );
    const gateModule = publicRegistrationsOf(
      sources.get("productUserCapabilityGate.ts") ?? "",
    );

    // The gate is a helper boundary, never an entry point of its own.
    expect(gateModule).toEqual([]);

    // The registration inventory of the access-path modules is pinned: a new
    // public function in either module must be classified here first.
    expect(productUsers.map(({ name }) => name).sort()).toEqual([
      "getMyStanding",
      "recordSignIn",
    ]);
    expect(productUserAccess.map(({ name }) => name).sort()).toEqual([
      "establishAccess",
      "getGateStatus",
      "getMyAccess",
    ]);

    // The documented exemption list matches the identity-requiring
    // registrations of those modules exactly — no more, no fewer.
    const identityRequiring = (registrations: PublicRegistration[]) =>
      registrations
        .filter(({ segment }) =>
          IDENTITY_TOKENS.some((token) => segment.includes(token)),
        )
        .map(({ name }) => name)
        .sort();
    expect(identityRequiring(productUsers)).toEqual(
      [...PRODUCT_USER_ACCESS_PATH_EXEMPT_ENTRY_POINTS["productUsers.ts"]].sort(),
    );
    expect(identityRequiring(productUserAccess)).toEqual(
      [
        ...PRODUCT_USER_ACCESS_PATH_EXEMPT_ENTRY_POINTS["productUserAccess.ts"],
      ].sort(),
    );

    // The anonymous gate-status read consults no identity and no gate.
    const gateStatus = productUserAccess.find(
      ({ name }) => name === "getGateStatus",
    );
    expect(gateStatus).toBeDefined();
    expect(
      IDENTITY_TOKENS.some((token) => gateStatus!.segment.includes(token)),
    ).toBe(false);
    expect(gateStatus!.segment.includes(GATE_CALL)).toBe(false);
  });

  test("every authenticated entry point outside the access path passes the shared gate before any database effect", async () => {
    const sources = await loadScannedSources();
    const accessPathModules = new Set([
      "productUsers.ts",
      "productUserAccess.ts",
      "productUserCapabilityGate.ts",
    ]);
    const gatedByModule = new Map<string, string[]>();

    for (const [path, source] of sources) {
      if (accessPathModules.has(path)) continue;
      for (const { name, kind, segment } of publicRegistrationsOf(source)) {
        // No entry point outside the access path may acquire identity by any
        // means other than the shared gate.
        for (const token of IDENTITY_TOKENS) {
          expect
            .soft(
              segment.includes(token),
              `${path} / ${name} uses ${token}; authenticated entry points must use requireAdmittedProductUser`,
            )
            .toBe(false);
        }
        // Catalog-read authorization is a read-model boundary: it never
        // authorizes a mutation or action.
        if (kind !== "query") {
          for (const token of CATALOG_READ_AUTHORIZATION_TOKENS) {
            expect
              .soft(
                segment.includes(token),
                `${path} / ${name} is a ${kind} consulting ${token}; effects must pass requireAdmittedProductUser`,
              )
              .toBe(false);
          }
        }
        const gateIndex = segment.indexOf(GATE_CALL);
        if (gateIndex === -1) continue; // Public unauthenticated surface.
        const effectIndex = segment.indexOf("ctx.db");
        if (effectIndex !== -1) {
          expect(
            gateIndex,
            `${path} / ${name} must pass the gate before touching ctx.db`,
          ).toBeLessThan(effectIndex);
        }
        gatedByModule.set(path, [...(gatedByModule.get(path) ?? []), name]);
      }
    }

    // Scanner liveness: the shipped saved-item capabilities are discovered and
    // gated. If the registration style ever changes, this fails loudly
    // instead of the scan going quietly blind.
    expect(gatedByModule.get("savedItems.ts")?.sort()).toEqual([
      "getOwnerWatchlist",
      "getSavedItemIds",
      "setSavedCollectible",
      "setSavedRepack",
    ]);
  });
});
