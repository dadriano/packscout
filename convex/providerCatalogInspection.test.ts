/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { seedMockCatalogManifestGraph } from "./mockCatalogManifestSeed";
import {
  buildMockProviderCatalogReleasePlans,
  MOCK_PROVIDER_PLATFORM_KEYS,
} from "./mockProviderCatalogFixture";
import { MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION } from "./mockDataReleaseFixture";
import {
  boundedPageSize,
  MAX_ID_PAGE_ITEMS,
  MAX_PAGE_ITEMS,
} from "./providerCatalogInspection";
import schema from "./schema";

const SEED_TIME = "2026-08-24T00:00:00.000Z";

const modules = import.meta.glob("./**/*.ts");

const ACTIVE_RELEASE_PATH = "/admin/provider-catalog/active-release";
const ENTITIES_PATH = "/admin/provider-catalog/entities";
const ENTITY_IDS_PATH = "/admin/provider-catalog/entity-ids";
const DOCUMENT_PATH = "/admin/provider-catalog/document";
const CHASE_RECONCILIATION_PATH =
  "/admin/provider-catalog/chase-reconciliation";

const INTEGRATION_TOKEN = "a".repeat(48);

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function authorize() {
  vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", INTEGRATION_TOKEN);
}

function post(
  convex: ReturnType<typeof createTest>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {
    authorization: `Bearer ${INTEGRATION_TOKEN}`,
  },
) {
  return convex.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * A real published catalog, seeded through the repository's own mock graph so
 * the fixture stays valid as the published schema evolves. Hand-authored
 * documents would drift from the validators the moment a field is added.
 */
async function seedActiveCatalog(convex: ReturnType<typeof createTest>) {
  const plans = await buildMockProviderCatalogReleasePlans();
  const seeded = await convex.run((ctx) =>
    seedMockCatalogManifestGraph(ctx, {
      plans,
      confidencePolicyVersion: MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
      serverTime: SEED_TIME,
    }),
  );
  const platformKey = MOCK_PROVIDER_PLATFORM_KEYS[0]!;
  const publicProviderReleaseId = await convex.run(async (ctx) => {
    const release = await ctx.db
      .query("providerCatalogReleases")
      .withIndex("by_platform_key_and_public_provider_release_id", (index) =>
        index.eq("platformKey", platformKey),
      )
      .first();
    return release!.publicProviderReleaseId;
  });
  return { ...seeded, platformKey, publicProviderReleaseId };
}

describe("provider catalog inspection is server-to-server only", () => {
  test("an unauthenticated call is refused and does no work", async () => {
    const convex = createTest();
    authorize();
    const response = await post(
      convex,
      ACTIVE_RELEASE_PATH,
      { platformKey: "courtyard" },
      {},
    );
    expect(response.status).toBe(401);
  });

  test("a token that is too short is refused", async () => {
    const convex = createTest();
    vi.stubEnv("PACKSCOUT_ADMIN_DIRECTORY_TOKEN", "short");
    const response = await post(convex, ACTIVE_RELEASE_PATH, {
      platformKey: "courtyard",
    });
    expect(response.status).toBe(401);
  });

  test("a wrong token is refused", async () => {
    const convex = createTest();
    authorize();
    const response = await post(
      convex,
      ACTIVE_RELEASE_PATH,
      { platformKey: "courtyard" },
      { authorization: `Bearer ${"b".repeat(48)}` },
    );
    expect(response.status).toBe(401);
  });

  test("a malformed request is refused with a stable code", async () => {
    const convex = createTest();
    authorize();
    const response = await post(convex, ACTIVE_RELEASE_PATH, {
      platformKey: 42,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "PROVIDER_CATALOG_REQUEST_INVALID",
    });

    const missingPlatform = await post(convex, ENTITIES_PATH, {
      expectedPublicProviderReleaseId: "release-id",
      entityKind: "repacks",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(missingPlatform.status).toBe(400);
    expect(await missingPlatform.json()).toMatchObject({
      code: "PROVIDER_CATALOG_REQUEST_INVALID",
    });
  });
});

describe("the active release reads three absences apart", () => {
  test("no active manifest at all", async () => {
    const convex = createTest();
    authorize();
    const response = await post(convex, ACTIVE_RELEASE_PATH, {
      platformKey: "courtyard",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "no_active_manifest",
    });
  });

  test("an active manifest that does not reference this platform", async () => {
    const convex = createTest();
    authorize();
    await seedActiveCatalog(convex);
    const response = await post(convex, ACTIVE_RELEASE_PATH, {
      platformKey: "a-platform-that-was-never-published",
    });
    expect(await response.json()).toMatchObject({
      status: "platform_not_referenced",
    });
  });

  test("a referenced release reports its own lifecycle, not an assumed one", async () => {
    const convex = createTest();
    authorize();
    const seeded = await seedActiveCatalog(convex);

    // Retire the release the manifest still points at. An operator needs to
    // see that, so it must not be presented as the served, complete release.
    await convex.run(async (ctx) => {
      const release = await ctx.db
        .query("providerCatalogReleases")
        .withIndex("by_public_provider_release_id", (index) =>
          index.eq("publicProviderReleaseId", seeded.publicProviderReleaseId),
        )
        .unique();
      await ctx.db.patch(release!._id, { lifecycle: "retired" });
    });

    const body = (await (
      await post(convex, ACTIVE_RELEASE_PATH, { platformKey: seeded.platformKey })
    ).json()) as { status: string; release: { lifecycle: string } };
    expect(body.status).toBe("active");
    expect(body.release.lifecycle).toBe("retired");
  });
});

describe("entity paging is stable, complete, and server-bounded", () => {
  test("identity paging visits every id exactly once", async () => {
    const convex = createTest();
    authorize();
    const seeded = await seedActiveCatalog(convex);
    const total = await convex.run(async (ctx) => {
      const release = await ctx.db
        .query("providerCatalogReleases")
        .withIndex("by_public_provider_release_id", (index) =>
          index.eq("publicProviderReleaseId", seeded.publicProviderReleaseId),
        )
        .unique();
      return release!.counts.repacks;
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = (await (
        await post(convex, ENTITY_IDS_PATH, {
          publicProviderReleaseId: seeded.publicProviderReleaseId,
          entityKind: "repacks",
          paginationOpts: { numItems: 2, cursor },
        })
      ).json()) as {
        publicEntityIds: string[];
        isDone: boolean;
        continueCursor: string;
      };
      seen.push(...page.publicEntityIds);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  /**
   * Asserted on the clamp itself.
   *
   * The seeded release holds a single repack per platform, so any assertion of
   * the form "the returned page is at most the ceiling" passes whether or not
   * the server clamps anything. The bound is observable here instead.
   */
  test("the server clamps a caller's requested page size to its own ceiling", () => {
    expect(boundedPageSize(100_000, MAX_PAGE_ITEMS)).toBe(MAX_PAGE_ITEMS);
    expect(boundedPageSize(100_000, MAX_ID_PAGE_ITEMS)).toBe(MAX_ID_PAGE_ITEMS);
    // A sane request passes through untouched.
    expect(boundedPageSize(25, MAX_PAGE_ITEMS)).toBe(25);
    // Nonsense falls back to the ceiling rather than to zero or a negative
    // page, either of which would page forever.
    for (const nonsense of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(boundedPageSize(nonsense, MAX_PAGE_ITEMS)).toBe(MAX_PAGE_ITEMS);
    }
    // Identity pages are allowed to be wider than document pages.
    expect(MAX_ID_PAGE_ITEMS).toBeGreaterThan(MAX_PAGE_ITEMS);
  });

  test("an oversized request still returns a usable page", async () => {
    const convex = createTest();
    authorize();
    const seeded = await seedActiveCatalog(convex);
    const page = (await (
      await post(convex, ENTITIES_PATH, {
        platformKey: seeded.platformKey,
        expectedPublicProviderReleaseId: seeded.publicProviderReleaseId,
        entityKind: "repacks",
        paginationOpts: { numItems: 100_000, cursor: null },
      })
    ).json()) as { status: string; items: unknown[] };
    expect(page.status).toBe("ok");
    expect(page.items.length).toBeGreaterThan(0);
  });

  test("an unknown release is representable, not an error", async () => {
    const convex = createTest();
    authorize();
    const response = await post(convex, ENTITIES_PATH, {
      platformKey: "courtyard",
      expectedPublicProviderReleaseId: "release-that-does-not-exist",
      entityKind: "repacks",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "release_unknown" });
  });
});

describe("single document reads", () => {
  test("a present document is returned and an absent one is representable", async () => {
    const convex = createTest();
    authorize();
    const seeded = await seedActiveCatalog(convex);
    const knownRepackId = (await (
      await post(convex, ENTITY_IDS_PATH, {
        publicProviderReleaseId: seeded.publicProviderReleaseId,
        entityKind: "repacks",
        paginationOpts: { numItems: 1, cursor: null },
      })
    ).json() as { publicEntityIds: string[] }).publicEntityIds[0]!;

    const present = (await (
      await post(convex, DOCUMENT_PATH, {
        platformKey: seeded.platformKey,
        expectedPublicProviderReleaseId: seeded.publicProviderReleaseId,
        entityKind: "repacks",
        publicEntityId: knownRepackId,
      })
    ).json()) as { status: string; publicEntityId: string };
    expect(present.status).toBe("ok");
    expect(present.publicEntityId).toBe(knownRepackId);

    const absent = (await (
      await post(convex, DOCUMENT_PATH, {
        platformKey: seeded.platformKey,
        expectedPublicProviderReleaseId: seeded.publicProviderReleaseId,
        entityKind: "repacks",
        publicEntityId: "a-repack-that-was-never-published",
      })
    ).json()) as { status: string };
    expect(absent.status).toBe("not_present");
  });
});

describe("published reads pin validation and data to one manifest snapshot", () => {
  test("a retained release becomes unreadable after a newer manifest is active", async () => {
    const convex = createTest();
    authorize();
    const first = await seedActiveCatalog(convex);

    const staleRepackId = (await (
      await post(convex, ENTITY_IDS_PATH, {
        publicProviderReleaseId: first.publicProviderReleaseId,
        entityKind: "repacks",
        paginationOpts: { numItems: 1, cursor: null },
      })
    ).json() as { publicEntityIds: string[] }).publicEntityIds[0]!;

    const revisedPlans = await buildMockProviderCatalogReleasePlans({
      providerRevisions: { [first.platformKey]: 1 },
    });
    const revised = await convex.run((ctx) =>
      seedMockCatalogManifestGraph(ctx, {
        plans: revisedPlans,
        confidencePolicyVersion: MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
        serverTime: "2026-08-24T01:00:00.000Z",
        observationSequence: 2,
      }),
    );
    const activePublicProviderReleaseId = revised.manifest.providerReferences
      .find(({ platformKey }) => platformKey === first.platformKey)!
      .publicProviderReleaseId;

    const requests = [
      {
        path: ENTITIES_PATH,
        body: {
          platformKey: first.platformKey,
          entityKind: "repacks",
          paginationOpts: { numItems: 10, cursor: null },
        },
      },
      {
        path: DOCUMENT_PATH,
        body: {
          platformKey: first.platformKey,
          entityKind: "repacks",
          publicEntityId: staleRepackId,
        },
      },
      {
        path: CHASE_RECONCILIATION_PATH,
        body: {
          platformKey: first.platformKey,
          publicRepackId: staleRepackId,
        },
      },
    ] as const;

    for (const request of requests) {
      const stale = await post(convex, request.path, {
        ...request.body,
        expectedPublicProviderReleaseId: first.publicProviderReleaseId,
      });
      expect(stale.status).toBe(200);
      expect(await stale.json()).toEqual({ status: "release_unknown" });

      const active = await post(convex, request.path, {
        ...request.body,
        expectedPublicProviderReleaseId: activePublicProviderReleaseId,
      });
      expect(active.status).toBe(200);
      expect(await active.json()).toMatchObject({ status: "ok" });
    }

    const wrongPlatform = await post(convex, DOCUMENT_PATH, {
      platformKey: MOCK_PROVIDER_PLATFORM_KEYS[1],
      expectedPublicProviderReleaseId: activePublicProviderReleaseId,
      entityKind: "repacks",
      publicEntityId: staleRepackId,
    });
    expect(await wrongPlatform.json()).toEqual({ status: "release_unknown" });
  });
});
