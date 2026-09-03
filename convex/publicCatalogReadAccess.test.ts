/// <reference types="vite/client" />

import { publicReadError } from "@packscout/contracts";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  buildV3Detail,
  buildV3FixturePlan,
  v3ActivateRequest,
  v3BatchRequest,
  v3Body,
  v3FinalizeRequest,
  v3StartRequest,
  V3_COLLECTIBLE_ID,
  V3_FIXTURE_NOW,
  V3_REPACK_ID_A,
} from "./dataReleaseV3Fixture.test-support";
import { seedMockCatalogManifestGraph } from "./mockCatalogManifestSeed";
import {
  MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
  buildMockDataReleaseV2,
} from "./mockDataReleaseFixture";
import { buildMockProviderCatalogReleasePlans } from "./mockProviderCatalogFixture";
import type { ProductUserAccessDecision } from "./productUserRecords";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/**
 * Raw sources of every product-backend module, for the enumeration scan. The
 * scan discovers public query registrations from source rather than from a
 * hand-maintained list, so a newly added read path that skips the gate fails
 * this suite instead of shipping open.
 */
const moduleSources = import.meta.glob("./**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const SEED_TIME = "2026-08-18T12:00:00.000Z";

const READER_IDENTITY = {
  subject: "did:privy:catalog-reader",
  issuer: "privy.io",
  tokenIdentifier: "privy.io|did:privy:catalog-reader",
};

const CATALOG_READ_TOKEN = "catalog-read-credential-0123456789abcdef";
const WRONG_TOKEN_SAME_LENGTH = "x".repeat(CATALOG_READ_TOKEN.length);

const ACCESS_REFUSAL = publicReadError("RELEASE_UNAVAILABLE");

type CatalogAccessTest = TestConvex<typeof schema>;
/** Anything that can run a query: the anonymous test client or an identity. */
type CatalogReader = Readonly<{
  query: CatalogAccessTest["query"];
  action: CatalogAccessTest["action"];
}>;

type SeededCatalog = Readonly<{
  publicReleaseId: string;
  publicRepackId: string;
  publicCollectibleId: string;
  v3PublicReleaseId: string;
  v3PublicRepackId: string;
  v3PublicCollectibleId: string;
}>;

/**
 * The data_release_v3 release the *V3 reads resolve. The frontend now reads
 * exclusively from those queries, so the gate matrix has to exercise them
 * against real activated v3 data, not only the v2 manifest graph.
 */
const V3_PUBLIC_RELEASE_ID = "20000000-0000-4000-8000-000000000001";

type ExtraCatalogArgs = Readonly<{ catalogReadToken?: unknown }>;

function createTest(): CatalogAccessTest {
  return convexTest({ schema, modules, transactionLimits: true });
}

function closeBeta() {
  vi.stubEnv("PACKSCOUT_CLOSED_BETA", "1");
}

function configureCredential(value: string) {
  vi.stubEnv("PACKSCOUT_CATALOG_READ_TOKEN", value);
}

/**
 * Publishes and activates one data_release_v3 release through the real
 * lifecycle mutations. The canonical watermark is pinned to the stubbed
 * runtime clock so it bounds every source timestamp in the fixture.
 */
async function publishActiveDataReleaseV3(t: CatalogAccessTest): Promise<void> {
  const detail = buildV3Detail({ publicRepackId: V3_REPACK_ID_A });
  const estimate = detail.evEstimates.packScout;
  if (estimate.status !== "current") throw new Error("Expected a valid EV fixture.");
  // This suite freezes its request clock independently of the shared fixture
  // module clock. Keep the calculation in that same timeline so the access
  // matrix tests authorization, not rejection of future-dated calculations.
  detail.evEstimates.packScout = { ...estimate, calculatedAt: SEED_TIME,
    dataAsOf: { state: "known", observedAt: SEED_TIME },
    expiresAt: new Date(Date.parse(SEED_TIME) + 60 * 60_000).toISOString() };
  const plan = await buildV3FixturePlan({
    publicReleaseId: V3_PUBLIC_RELEASE_ID,
    dataAsOf: new Date(V3_FIXTURE_NOW).toISOString(),
    details: [detail],
  });
  await t.mutation(
    internal.dataReleaseV3Lifecycle.start,
    await v3Body(v3StartRequest(plan)),
  );
  for (const batch of plan.batches) {
    await t.mutation(
      internal.dataReleaseV3Lifecycle.applyBatch,
      await v3Body(v3BatchRequest(plan, batch)),
    );
  }
  await t.mutation(
    internal.dataReleaseV3Lifecycle.finalize,
    await v3Body(v3FinalizeRequest(plan)),
  );
  await t.mutation(
    internal.dataReleaseV3Lifecycle.activate,
    await v3Body(v3ActivateRequest(plan, null)),
  );
}

async function seedActiveCatalog(t: CatalogAccessTest): Promise<SeededCatalog> {
  const plans = await buildMockProviderCatalogReleasePlans();
  const seeded = await t.run((ctx) =>
    seedMockCatalogManifestGraph(ctx, {
      plans,
      confidencePolicyVersion: MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
      serverTime: SEED_TIME,
    })
  );
  await publishActiveDataReleaseV3(t);
  const fixture = buildMockDataReleaseV2();
  return {
    publicReleaseId: seeded.publicReleaseId,
    publicRepackId: fixture.repacks[0]!.publicRepackId,
    publicCollectibleId: fixture.collectibles[0]!.publicCollectibleId,
    v3PublicReleaseId: V3_PUBLIC_RELEASE_ID,
    v3PublicRepackId: V3_REPACK_ID_A,
    v3PublicCollectibleId: V3_COLLECTIBLE_ID,
  };
}

async function patchReaderRecord(
  t: CatalogAccessTest,
  patch: {
    access?: ProductUserAccessDecision;
    standing?: "active" | "suspended";
  },
) {
  await t.run(async (ctx) => {
    const record = await ctx.db
      .query("productUsers")
      .withIndex("by_subject", (index) =>
        index.eq("subject", READER_IDENTITY.tokenIdentifier)
      )
      .unique();
    if (record === null) throw new Error("Expected a product-user record.");
    await ctx.db.patch("productUsers", record._id, patch);
  });
}

/** Establishes the reader identity and stamps the requested decision. */
async function establishReader(
  t: CatalogAccessTest,
  state: "awaiting_review" | "approved" | "declined",
  standing: "active" | "suspended" = "active",
) {
  await t
    .withIdentity(READER_IDENTITY)
    .mutation(api.productUserAccess.establishAccess, {});
  const patch: {
    access?: ProductUserAccessDecision;
    standing?: "active" | "suspended";
  } = { standing };
  if (state !== "awaiting_review") {
    patch.access = {
      state,
      decidedAt: SEED_TIME,
      decidedBy: "operator",
      operatorId: "operator-catalog-test",
    };
  }
  await patchReaderRecord(t, patch);
  return t.withIdentity(READER_IDENTITY);
}

// --- Enumeration ------------------------------------------------------------

/**
 * Public queries that stay reachable without the two-caller catalog check,
 * each with the reason it is open. Everything else registered as a public
 * query must be a gated catalog read; adding a public query anywhere in
 * convex/ without classifying it here or gating it fails this suite.
 */
const OPEN_PUBLIC_QUERIES: Readonly<Record<string, string>> = Object.freeze({
  "productUserAccess.getGateStatus":
    "the anonymous beta on/off read the signed-out landing depends on " +
    "(closed-beta-access/001); returns no identity, counts, or catalog data",
  "productUserAccess.getMyAccess":
    "the authenticated self effective-access read (closed-beta-access/001); " +
    "refuses anonymous callers and carries no catalog data",
  "productUsers.getMyStanding":
    "the authenticated self standing read; refuses anonymous callers and " +
    "carries no catalog data",
  "savedItems.getSavedItemIds":
    "the authenticated saved-items capability; admission enforcement on it " +
    "belongs to closed-beta-access/004 and it returns only the caller's own " +
    "references",
});

/**
 * Every catalog-serving public query, all of which must run the gate. The
 * data_release_v3 reads are gated on exactly the same terms as their v1/v2
 * twins: the product renders from the *V3 queries, so a v3 read that skipped
 * the check would reopen the whole catalog no matter how well v2 is gated.
 */
const GATED_CATALOG_QUERIES = [
  "publicRepacks.getPublicShellStatus",
  "publicRepacks.getDashboardBundle",
  "publicRepacks.listPublicRepacks",
  "publicRepacks.getPublicRepack",
  "publicRepacks.searchPublicCollectibles",
  "publicRepacks.findRepacksByDesiredCollectible",
  "publicRepacksV3.getPublicShellStatusV3",
  "publicRepacksV3.getPublicCatalogRecordUpdateStatusV3",
  "publicRepacksV3.getDashboardBundleV3",
  "publicRepacksV3.listPublicRepacksV3",
  "publicRepacksV3.getPublicRepackV3",
  "publicRepacksV3.searchPublicCollectiblesV3",
  "publicRepacksV3.findRepacksByDesiredCollectibleV3",
] as const;

type GatedCatalogQuery = (typeof GATED_CATALOG_QUERIES)[number];

function discoverPublicQueryExports(): ReadonlySet<string> {
  const discovered = new Set<string>();
  for (const [path, source] of Object.entries(moduleSources)) {
    if (
      path.startsWith("./_generated/") ||
      path.endsWith(".test.ts") ||
      path.includes("test-support")
    ) {
      continue;
    }
    if (/export\s+default\s+(?:query|mutation|action)\s*\(/u.test(source)) {
      throw new Error(
        `${path} registers a default-exported public function; ` +
          "use a named export so the catalog enumeration can classify it.",
      );
    }
    const moduleName = path.replace(/^\.\//u, "").replace(/\.ts$/u, "");
    const registrationPattern = path.endsWith("/publicRepacksV3.ts")
      ? /^export const (\w+) = (?:query|action)\(\{/gmu
      : /^export const (\w+) = query\(\{/gmu;
    for (const match of source.matchAll(registrationPattern)) {
      discovered.add(`${moduleName}.${match[1]!}`);
    }
  }
  return discovered;
}

/**
 * One valid invocation per gated catalog read, against seeded data. Keyed by
 * the enumerated name so a newly gated query without matrix coverage fails
 * the key-set assertion below.
 */
const CATALOG_QUERY_INVOCATIONS: Readonly<
  Record<
    GatedCatalogQuery,
    (
      reader: CatalogReader,
      seeded: SeededCatalog,
      extra: ExtraCatalogArgs,
    ) => Promise<unknown>
  >
> = Object.freeze({
  "publicRepacks.getPublicShellStatus": (reader, _seeded, extra) =>
    reader.query(api.publicRepacks.getPublicShellStatus, { ...extra }),
  "publicRepacks.getDashboardBundle": (reader, _seeded, extra) =>
    reader.query(api.publicRepacks.getDashboardBundle, {
      currentTime: Date.now(),
      ...extra,
    }),
  "publicRepacks.listPublicRepacks": (reader, _seeded, extra) =>
    reader.query(api.publicRepacks.listPublicRepacks, {
      currentTime: Date.now(),
      ...extra,
    }),
  "publicRepacks.getPublicRepack": (reader, seeded, extra) =>
    reader.query(api.publicRepacks.getPublicRepack, {
      publicRepackId: seeded.publicRepackId,
      publicReleaseId: seeded.publicReleaseId,
      currentTime: Date.now(),
      ...extra,
    }),
  "publicRepacks.searchPublicCollectibles": (reader, _seeded, extra) =>
    reader.query(api.publicRepacks.searchPublicCollectibles, {
      search: "charizard",
      ...extra,
    }),
  "publicRepacks.findRepacksByDesiredCollectible": (reader, seeded, extra) =>
    reader.query(api.publicRepacks.findRepacksByDesiredCollectible, {
      publicCollectibleId: seeded.publicCollectibleId,
      currentTime: Date.now(),
      ...extra,
    }),
  "publicRepacksV3.getPublicShellStatusV3": (reader, _seeded, extra) =>
    reader.action(api.publicRepacksV3.getPublicShellStatusV3, { ...extra }),
  "publicRepacksV3.getPublicCatalogRecordUpdateStatusV3": (
    reader,
    _seeded,
    extra,
  ) =>
    reader.action(
      api.publicRepacksV3.getPublicCatalogRecordUpdateStatusV3,
      { ...extra },
    ),
  "publicRepacksV3.getDashboardBundleV3": (reader, _seeded, extra) =>
    reader.action(api.publicRepacksV3.getDashboardBundleV3, { ...extra }),
  "publicRepacksV3.listPublicRepacksV3": (reader, _seeded, extra) =>
    reader.action(api.publicRepacksV3.listPublicRepacksV3, { ...extra }),
  "publicRepacksV3.getPublicRepackV3": (reader, seeded, extra) =>
    reader.action(api.publicRepacksV3.getPublicRepackV3, {
      publicRepackId: seeded.v3PublicRepackId,
      publicReleaseId: seeded.v3PublicReleaseId,
      ...extra,
    }),
  "publicRepacksV3.searchPublicCollectiblesV3": (reader, _seeded, extra) =>
    reader.query(api.publicRepacksV3.searchPublicCollectiblesV3, {
      search: "charizard",
      ...extra,
    }),
  "publicRepacksV3.findRepacksByDesiredCollectibleV3": (reader, seeded, extra) =>
    reader.action(api.publicRepacksV3.findRepacksByDesiredCollectibleV3, {
      publicCollectibleId: seeded.v3PublicCollectibleId,
      ...extra,
    }),
});

function expectServed(name: string, result: unknown) {
  expect(result, `${name} should serve data for an admitted caller`).toMatchObject({
    ok: true,
  });
}

function expectRefused(name: string, result: unknown) {
  expect(
    result,
    `${name} should refuse with the stable non-leaking unavailable result`,
  ).toEqual(ACCESS_REFUSAL);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function stubLocalRuntime() {
  vi.useFakeTimers();
  vi.setSystemTime(V3_FIXTURE_NOW);
  vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
}

describe("catalog read-model enumeration", () => {
  test("every public query is a gated catalog read or documented open, with no overlap", () => {
    const discovered = discoverPublicQueryExports();
    const classified = new Set<string>([
      ...GATED_CATALOG_QUERIES,
      ...Object.keys(OPEN_PUBLIC_QUERIES),
    ]);
    expect(
      classified.size,
      "a query must be either gated or open-by-design, never both",
    ).toBe(GATED_CATALOG_QUERIES.length + Object.keys(OPEN_PUBLIC_QUERIES).length);
    expect([...discovered].sort()).toEqual([...classified].sort());
    for (const reason of Object.values(OPEN_PUBLIC_QUERIES)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  test("the refusal matrix covers exactly the enumerated catalog reads", () => {
    expect(Object.keys(CATALOG_QUERY_INVOCATIONS).sort()).toEqual(
      [...GATED_CATALOG_QUERIES].sort(),
    );
  });

  test("while the beta is on, no enumerated catalog read is reachable without one of the two admitted callers", async () => {
    stubLocalRuntime();
    const t = createTest();
    const seeded = await seedActiveCatalog(t);

    // The data is provably there: with the switch off every read serves it.
    for (const name of GATED_CATALOG_QUERIES) {
      expectServed(name, await CATALOG_QUERY_INVOCATIONS[name](t, seeded, {}));
    }

    closeBeta();
    configureCredential(CATALOG_READ_TOKEN);
    const awaiting = await establishReader(t, "awaiting_review");

    for (const name of GATED_CATALOG_QUERIES) {
      const invoke = CATALOG_QUERY_INVOCATIONS[name];
      // Anonymous caller with no credential: refused.
      expectRefused(name, await invoke(t, seeded, {}));
      // Anonymous caller with the wrong credential: refused.
      expectRefused(
        name,
        await invoke(t, seeded, { catalogReadToken: WRONG_TOKEN_SAME_LENGTH }),
      );
      // Authenticated but unadmitted identity: refused.
      expectRefused(name, await invoke(awaiting, seeded, {}));
      // The server rendering path presenting the deployment credential: served.
      expectServed(
        name,
        await invoke(t, seeded, { catalogReadToken: CATALOG_READ_TOKEN }),
      );
    }

    // An admitted identity is served on every read without any credential.
    const admitted = await establishReader(t, "approved");
    for (const name of GATED_CATALOG_QUERIES) {
      expectServed(name, await CATALOG_QUERY_INVOCATIONS[name](admitted, seeded, {}));
    }
  });
});

describe("catalog read refusal semantics", () => {
  test("refusals are byte-identical to the release-unavailable result and carry no catalog fields", async () => {
    stubLocalRuntime();
    closeBeta();
    const t = createTest();
    const seeded = await seedActiveCatalog(t);

    const refusal = await t.query(api.publicRepacks.getDashboardBundle, {
      currentTime: Date.now(),
    });
    expect(refusal).toEqual({
      ok: false,
      code: "RELEASE_UNAVAILABLE",
      error: "Repack data is temporarily unavailable.",
      retryable: true,
    });
    // The v3 read refuses with the byte-identical result, so which read model
    // serves the product is not observable from a refusal.
    await expect(
      t.action(api.publicRepacksV3.getDashboardBundleV3, {}),
    ).resolves.toEqual(refusal);

    // Nothing about the seeded release, the credential, or admission leaks.
    const serialized = JSON.stringify(refusal);
    expect(serialized).not.toContain(seeded.publicReleaseId);
    expect(serialized).not.toContain(seeded.publicRepackId);
    expect(serialized).not.toContain(seeded.v3PublicReleaseId);
    expect(serialized).not.toContain("catalogReadToken");
    expect(serialized).not.toContain("admitted");
  });

  test("declined and suspended identities are refused like strangers", async () => {
    stubLocalRuntime();
    closeBeta();
    const t = createTest();
    const seeded = await seedActiveCatalog(t);

    const declined = await establishReader(t, "declined");
    expectRefused(
      "publicRepacks.listPublicRepacks",
      await CATALOG_QUERY_INVOCATIONS["publicRepacks.listPublicRepacks"](
        declined,
        seeded,
        {},
      ),
    );

    const suspended = await establishReader(t, "approved", "suspended");
    expectRefused(
      "publicRepacks.listPublicRepacks",
      await CATALOG_QUERY_INVOCATIONS["publicRepacks.listPublicRepacks"](
        suspended,
        seeded,
        {},
      ),
    );
  });

  test("a suspended admitted account regains catalog reads when reinstated", async () => {
    stubLocalRuntime();
    closeBeta();
    const t = createTest();
    const seeded = await seedActiveCatalog(t);
    const reader = await establishReader(t, "approved", "suspended");
    expectRefused(
      "publicRepacks.getPublicShellStatus",
      await CATALOG_QUERY_INVOCATIONS["publicRepacks.getPublicShellStatus"](
        reader,
        seeded,
        {},
      ),
    );
    await patchReaderRecord(t, { standing: "active" });
    expectServed(
      "publicRepacks.getPublicShellStatus",
      await CATALOG_QUERY_INVOCATIONS["publicRepacks.getPublicShellStatus"](
        reader,
        seeded,
        {},
      ),
    );
  });
});

describe("server catalog-read credential", () => {
  test("an unconfigured deployment refuses every presented credential", async () => {
    stubLocalRuntime();
    closeBeta();
    const t = createTest();
    const seeded = await seedActiveCatalog(t);
    expectRefused(
      "publicRepacks.getDashboardBundle",
      await CATALOG_QUERY_INVOCATIONS["publicRepacks.getDashboardBundle"](
        t,
        seeded,
        { catalogReadToken: CATALOG_READ_TOKEN },
      ),
    );
  });

  test("a configured secret below the minimum length authorizes nobody", async () => {
    stubLocalRuntime();
    closeBeta();
    const shortSecret = "too-short-secret";
    configureCredential(shortSecret);
    const t = createTest();
    const seeded = await seedActiveCatalog(t);
    expectRefused(
      "publicRepacks.getDashboardBundle",
      await CATALOG_QUERY_INVOCATIONS["publicRepacks.getDashboardBundle"](
        t,
        seeded,
        { catalogReadToken: shortSecret },
      ),
    );
  });

  test("an over-long or non-string presented credential is refused in-band, never thrown", async () => {
    stubLocalRuntime();
    closeBeta();
    configureCredential(CATALOG_READ_TOKEN);
    const t = createTest();
    const seeded = await seedActiveCatalog(t);
    const invoke = CATALOG_QUERY_INVOCATIONS["publicRepacks.getDashboardBundle"];
    expectRefused(
      "publicRepacks.getDashboardBundle",
      await invoke(t, seeded, { catalogReadToken: "a".repeat(513) }),
    );
    expectRefused(
      "publicRepacks.getDashboardBundle",
      await invoke(t, seeded, { catalogReadToken: 42 }),
    );
  });

  test("the credential does not bypass the switch-off public contract", async () => {
    stubLocalRuntime();
    configureCredential(CATALOG_READ_TOKEN);
    const t = createTest();
    const seeded = await seedActiveCatalog(t);
    // Beta off: a stray or wrong credential changes nothing — public as today.
    expectServed(
      "publicRepacks.getDashboardBundle",
      await CATALOG_QUERY_INVOCATIONS["publicRepacks.getDashboardBundle"](
        t,
        seeded,
        { catalogReadToken: WRONG_TOKEN_SAME_LENGTH },
      ),
    );
  });
});

describe("operational reads stay reachable", () => {
  test("the unauthenticated gate-status read answers while the beta is on and the catalog is closed", async () => {
    stubLocalRuntime();
    closeBeta();
    const t = createTest();
    await expect(
      t.query(api.productUserAccess.getGateStatus, {}),
    ).resolves.toEqual({ closedBetaActive: true });
  });

  test("the authenticated self-reads stay reachable for a held identity", async () => {
    stubLocalRuntime();
    closeBeta();
    const t = createTest();
    const held = await establishReader(t, "awaiting_review");
    await expect(
      held.query(api.productUserAccess.getMyAccess, {}),
    ).resolves.toEqual({ admitted: false, reason: "awaiting_review" });
  });
});

describe("switch off restores today's public behavior", () => {
  test("every catalog read serves anonymous callers with no credential exactly as before", async () => {
    stubLocalRuntime();
    const t = createTest();
    const seeded = await seedActiveCatalog(t);
    for (const name of GATED_CATALOG_QUERIES) {
      expectServed(name, await CATALOG_QUERY_INVOCATIONS[name](t, seeded, {}));
    }
  });
});
