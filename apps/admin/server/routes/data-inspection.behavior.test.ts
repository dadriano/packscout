import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { AuthServiceError, type AuthenticatedActor } from "@packscout/services";
import { createSessionCookiePolicy } from "../auth/cookies.ts";
import { CanonicalInspectionError } from "@packscout/services";
import {
  PublishedCatalogError,
  type PublishedCatalogReader,
} from "../published-catalog-reader.ts";
import { createDataInspectionRouter } from "./data-inspection.ts";

const organizationId = "00000000-0000-4000-8000-000000000010";

function actorWith(permissions: string[]): AuthenticatedActor {
  return {
    sessionId: "operator-session",
    operatorId: "00000000-0000-4000-8000-000000000001",
    organizationId,
    organizationName: "PackScout",
    email: "operator@packscout.test",
    displayName: "Data Operator",
    state: "active",
    role: "data_operator",
    permissions: permissions as AuthenticatedActor["permissions"],
    csrfToken: "csrf-token",
  };
}

async function withServer(
  permissions: string[],
  run: (baseUrl: string) => Promise<void>,
  canonical?: Parameters<typeof createDataInspectionRouter>[0]["canonical"],
  published?: Parameters<typeof createDataInspectionRouter>[0]["published"],
) {
  const app = express();
  app.use(
    "/api/data-inspection",
    createDataInspectionRouter({
      canonical,
      published,
      auth: {
        async resolveSession({ sessionToken }) {
          if (!sessionToken) {
            throw new AuthServiceError(
              "AUTH_REQUIRED",
              "Sign in to continue.",
              401,
            );
          }
          return actorWith(permissions);
        },
        requirePermission(authenticated, permission) {
          assert.equal(permission, "data_inspection:view");
          if (!authenticated.permissions.includes(permission)) {
            throw new AuthServiceError(
              "FORBIDDEN",
              "You do not have permission to perform this action.",
              403,
            );
          }
        },
      },
      cookiePolicy: createSessionCookiePolicy({
        production: false,
        maxAgeMs: 43_200_000,
      }),
    }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("comparison scope is refused without the data-inspection permission", async () => {
  await withServer(["providers:view"], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/data-inspection/scope`, {
      headers: { cookie: "packscout_session=operator-session" },
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { code?: string };
    assert.equal(typeof body.code, "string");
  });
});

test("comparison scope requires a session at all", async () => {
  await withServer(["data_inspection:view"], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/data-inspection/scope`);
    assert.equal(response.status, 401);
  });
});

test("comparison scope names publishable and pipeline-only kinds", async () => {
  await withServer(["data_inspection:view"], async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/data-inspection/scope`, {
      headers: { cookie: "packscout_session=operator-session" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as {
      entries: {
        canonicalKind: string;
        publishedKind: string | null;
        comparable: boolean;
        reason: string | null;
      }[];
    };
    const byKind = new Map(body.entries.map((entry) => [entry.canonicalKind, entry]));

    // A pack becomes a published repack, so it is comparable.
    assert.equal(byKind.get("pack")?.comparable, true);
    assert.equal(byKind.get("pack")?.publishedKind, "repacks");

    // Pulls and sales stay in the pipeline. Their absence downstream is scope,
    // not loss, so they must carry a stated reason rather than a null one.
    for (const kind of ["pull", "market_event", "ev_input", "estimated_ev"]) {
      assert.equal(byKind.get(kind)?.comparable, false);
      assert.equal(byKind.get(kind)?.publishedKind, null);
      assert.ok((byKind.get(kind)?.reason ?? "").length > 0);
    }
  });
});


/** Records the organization each read was scoped to. */
function canonicalStub(overrides: Record<string, unknown> = {}) {
  const seenOrganizations: string[] = [];
  return {
    seenOrganizations,
    async listProviders(organizationId: string) {
      seenOrganizations.push(organizationId);
      return [
        { platformKey: "courtyard", displayName: "Courtyard", state: "active" },
        { platformKey: "clutchpacks", displayName: "ClutchPacks", state: "active" },
      ];
    },
    async summarizeProvider(input: { organizationId: string }) {
      seenOrganizations.push(input.organizationId);
      return { platformKey: "courtyard", kinds: [] };
    },
    async listEntities(input: { organizationId: string }) {
      seenOrganizations.push(input.organizationId);
      return { items: [], nextCursor: null };
    },
    async readEntity(input: { organizationId: string }) {
      seenOrganizations.push(input.organizationId);
      throw new CanonicalInspectionError(
        "CANONICAL_ENTITY_UNKNOWN",
        "That record does not exist for this provider.",
        404,
      );
    },
    ...overrides,
  };
}

const publishedReleaseId = "10000000-0000-5000-8000-000000000001";
const publishedManifestId = "10000000-0000-5000-8000-000000000002";
const publishedVendorId = "00000000-0000-5000-8000-000000000001";
const publishedRepackId = "00000000-0000-5000-8000-000000000301";
const publishedHash = "a".repeat(64);

function activePublishedRelease() {
  return {
    status: "active" as const,
    manifestPublicReleaseId: publishedManifestId,
    referenceFingerprint: publishedHash,
    release: {
      publicProviderReleaseId: publishedReleaseId,
      platformKey: "clutchpacks",
      lifecycle: "complete" as const,
      dataAsOf: "2026-08-27T10:00:00.000Z",
      providerReleaseFingerprint: publishedHash,
      contentHash: publishedHash,
      entityHashes: {
        vendors: publishedHash,
        categories: publishedHash,
        collectibles: publishedHash,
        repacks: publishedHash,
        repack_chases: publishedHash,
        search_shards: publishedHash,
      },
      counts: {
        vendors: 1 as const,
        categories: 0,
        collectibles: 0,
        repacks: 1,
        repackChases: 0,
        searchShards: 0,
      },
      batchCount: 2,
      batchChainHash: publishedHash,
      createdAt: "2026-08-27T10:00:00.000Z",
      completedAt: "2026-08-27T10:01:00.000Z",
      completionOperationId: "clutchpacks.finalize.1",
    },
  };
}

function publishedStub(overrides: Partial<PublishedCatalogReader> = {}) {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const reader: PublishedCatalogReader = {
    async activeRelease(platformKey) {
      calls.push({ operation: "activeRelease", input: platformKey });
      return activePublishedRelease();
    },
    async listEntities(input) {
      calls.push({ operation: "listEntities", input });
      return {
        status: "ok",
        items: [],
        isDone: true,
        continueCursor: "",
      };
    },
    async listEntityIds(input) {
      calls.push({ operation: "listEntityIds", input });
      return {
        status: "ok",
        publicEntityIds: [],
        isDone: true,
        continueCursor: "",
      };
    },
    async readDocument(input) {
      calls.push({ operation: "readDocument", input });
      return { status: "not_present" };
    },
    async readChaseReconciliation(input) {
      calls.push({ operation: "readChaseReconciliation", input });
      return {
        status: "ok",
        publicRepackId: publishedRepackId,
        expectedChaseCount: 0,
        acceptedChaseCount: 0,
        complete: true,
      };
    },
    ...overrides,
  };
  return { calls, reader };
}

test("canonical reads are scoped to the caller's own organization", async () => {
  const canonical = canonicalStub();
  await withServer(
    ["data_inspection:view"],
    async (baseUrl) => {
      // A foreign organization id in the path must not become the read's scope.
      const response = await fetch(
        `${baseUrl}/api/data-inspection/canonical/providers/courtyard/summary`,
        { headers: { cookie: "packscout_session=operator-session" } },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(canonical.seenOrganizations, [organizationId]);
    },
    canonical as never,
  );
});

test("a classified read failure keeps its code and status", async () => {
  const canonical = canonicalStub();
  await withServer(
    ["data_inspection:view"],
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/data-inspection/canonical/providers/courtyard/entities/pack/missing`,
        { headers: { cookie: "packscout_session=operator-session" } },
      );
      assert.equal(response.status, 404);
      const body = (await response.json()) as { code?: string };
      assert.equal(body.code, "CANONICAL_ENTITY_UNKNOWN");
    },
    canonical as never,
  );
});

test("an unclassified read failure surfaces no driver detail", async () => {
  const canonical = canonicalStub({
    async listProviders() {
      throw new Error("connect ECONNREFUSED 10.0.0.4:5432");
    },
  });
  await withServer(
    ["data_inspection:view"],
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/data-inspection/canonical/providers`,
        { headers: { cookie: "packscout_session=operator-session" } },
      );
      assert.equal(response.status, 503);
      const payload = await response.text();
      assert.match(payload, /CANONICAL_STORE_UNAVAILABLE/);
      assert.doesNotMatch(payload, /ECONNREFUSED|5432|10\.0\.0\.4/);
    },
    canonical as never,
  );
});

test("canonical reads are refused without the permission", async () => {
  await withServer(
    ["providers:view"],
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/data-inspection/canonical/providers`,
        { headers: { cookie: "packscout_session=operator-session" } },
      );
      assert.equal(response.status, 403);
    },
    canonicalStub() as never,
  );
});

test("published reads require permission and remain non-cacheable on refusal", async () => {
  const published = publishedStub();
  await withServer(
    ["providers:view"],
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/data-inspection/published/providers/clutchpacks/active-release`,
        { headers: { cookie: "packscout_session=operator-session" } },
      );
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(published.calls.length, 0);
    },
    canonicalStub() as never,
    published.reader,
  );
});

test("published routes use one atomic backend read per requested document", async () => {
  const published = publishedStub();
  await withServer(
    ["data_inspection:view"],
    async (baseUrl) => {
      const headers = { cookie: "packscout_session=operator-session" };
      const active = await fetch(
        `${baseUrl}/api/data-inspection/published/providers/clutchpacks/active-release`,
        { headers },
      );
      assert.equal(active.status, 200);
      assert.equal(active.headers.get("cache-control"), "no-store");
      assert.equal((await active.json() as { status: string }).status, "active");

      const page = await fetch(
        `${baseUrl}/api/data-inspection/published/providers/clutchpacks/entities?entityKind=vendors&expectedPublicProviderReleaseId=${publishedReleaseId}&limit=25&cursor=next`,
        { headers },
      );
      assert.equal(page.status, 200);
      assert.equal((await page.json() as { status: string }).status, "ok");

      const document = await fetch(
        `${baseUrl}/api/data-inspection/published/providers/clutchpacks/entities/vendors/${publishedVendorId}?expectedPublicProviderReleaseId=${publishedReleaseId}`,
        { headers },
      );
      assert.equal(document.status, 200);
      assert.equal(
        (await document.json() as { status: string }).status,
        "not_present",
      );

      const chase = await fetch(
        `${baseUrl}/api/data-inspection/published/providers/clutchpacks/repacks/${publishedRepackId}/chase-reconciliation?expectedPublicProviderReleaseId=${publishedReleaseId}`,
        { headers },
      );
      assert.equal(chase.status, 200);
      assert.equal((await chase.json() as { status: string }).status, "ok");
    },
    canonicalStub() as never,
    published.reader,
  );

  const entityCall = published.calls.find(
    ({ operation }) => operation === "listEntities",
  );
  assert.deepEqual(entityCall?.input, {
    platformKey: "clutchpacks",
    expectedPublicProviderReleaseId: publishedReleaseId,
    entityKind: "vendors",
    numItems: 25,
    cursor: "next",
  });
  assert.deepEqual(
    published.calls.find(({ operation }) => operation === "readDocument")?.input,
    {
      platformKey: "clutchpacks",
      expectedPublicProviderReleaseId: publishedReleaseId,
      entityKind: "vendors",
      publicEntityId: publishedVendorId,
    },
  );
  assert.deepEqual(
    published.calls.find(
      ({ operation }) => operation === "readChaseReconciliation",
    )?.input,
    {
      platformKey: "clutchpacks",
      expectedPublicProviderReleaseId: publishedReleaseId,
      publicRepackId: publishedRepackId,
    },
  );
  assert.equal(
    published.calls.filter(({ operation }) => operation === "activeRelease")
      .length,
    1,
  );
});

test("a provider outside the actor organization is rejected before any published read", async () => {
  const published = publishedStub();
  const canonical = canonicalStub({
    async listProviders(requestOrganizationId: string) {
      assert.equal(requestOrganizationId, organizationId);
      return [
        { platformKey: "courtyard", displayName: "Courtyard", state: "active" },
      ];
    },
  });
  await withServer(
    ["data_inspection:view"],
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/data-inspection/published/providers/clutchpacks/active-release`,
        { headers: { cookie: "packscout_session=operator-session" } },
      );
      assert.equal(response.status, 404);
      assert.equal(
        (await response.json() as { code: string }).code,
        "CANONICAL_PROVIDER_UNKNOWN",
      );
      assert.equal(published.calls.length, 0);
    },
    canonical as never,
    published.reader,
  );
});

test("published inputs are strict and reject unverified release selectors", async () => {
  const published = publishedStub();
  await withServer(
    ["data_inspection:view"],
    async (baseUrl) => {
      const headers = { cookie: "packscout_session=operator-session" };
      for (const path of [
        "/published/providers/ClutchPacks/active-release",
        "/published/providers/clutchpacks/entities?entityKind=vendors",
        "/published/providers/clutchpacks/entities?entityKind=repack_chases",
        "/published/providers/clutchpacks/entities?entityKind=vendors&limit=201",
        `/published/providers/clutchpacks/entities/vendors/${publishedVendorId}?publicProviderReleaseId=${publishedManifestId}`,
        `/published/providers/clutchpacks/repacks/not-a-public-id/chase-reconciliation`,
      ]) {
        const response = await fetch(
          `${baseUrl}/api/data-inspection${path}`,
          { headers },
        );
        assert.equal(response.status, 400, path);
        assert.equal(
          (await response.json() as { code: string }).code,
          "PUBLISHED_CATALOG_REQUEST_INVALID",
        );
      }
      assert.equal(published.calls.length, 0);
    },
    canonicalStub() as never,
    published.reader,
  );
});

test("a stale release is decided by the atomic backend read without a preflight", async () => {
  let entityReads = 0;
  const published = publishedStub({
    async listEntities(input) {
      entityReads += 1;
      assert.deepEqual(input, {
        platformKey: "clutchpacks",
        expectedPublicProviderReleaseId: publishedReleaseId,
        entityKind: "repacks",
        numItems: 50,
        cursor: null,
      });
      return {
        status: "release_unknown",
      };
    },
  });
  await withServer(
    ["data_inspection:view"],
    async (baseUrl) => {
      const headers = { cookie: "packscout_session=operator-session" };
      const active = await fetch(
        `${baseUrl}/api/data-inspection/published/providers/clutchpacks/active-release`,
        { headers },
      );
      assert.equal(active.status, 200);
      assert.equal(
        ((await active.json()) as ReturnType<typeof activePublishedRelease>)
          .release.publicProviderReleaseId,
        publishedReleaseId,
      );

      const page = await fetch(
        `${baseUrl}/api/data-inspection/published/providers/clutchpacks/entities?entityKind=repacks&expectedPublicProviderReleaseId=${publishedReleaseId}`,
        { headers },
      );
      assert.equal(page.status, 200);
      assert.deepEqual(await page.json(), { status: "release_unknown" });
      assert.equal(entityReads, 1);
    },
    canonicalStub() as never,
    published.reader,
  );
  assert.equal(
    published.calls.filter(({ operation }) => operation === "activeRelease")
      .length,
    1,
  );
});

test("classified and unclassified published failures remain stable and redacted", async () => {
  const classified = publishedStub({
    async activeRelease() {
      throw new PublishedCatalogError(
        "PUBLISHED_CATALOG_UNAUTHORIZED",
        "The published catalog integration is not authorized.",
        502,
      );
    },
  });
  await withServer(
    ["data_inspection:view"],
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/data-inspection/published/providers/clutchpacks/active-release`,
        { headers: { cookie: "packscout_session=operator-session" } },
      );
      assert.equal(response.status, 502);
      assert.equal(
        (await response.json() as { code: string }).code,
        "PUBLISHED_CATALOG_UNAUTHORIZED",
      );
    },
    canonicalStub() as never,
    classified.reader,
  );

  const unclassified = publishedStub({
    async activeRelease() {
      throw new Error("secret.internal:3210");
    },
  });
  await withServer(
    ["data_inspection:view"],
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/data-inspection/published/providers/clutchpacks/active-release`,
        { headers: { cookie: "packscout_session=operator-session" } },
      );
      assert.equal(response.status, 503);
      const body = await response.text();
      assert.match(body, /PUBLISHED_CATALOG_UNAVAILABLE/);
      assert.doesNotMatch(body, /secret\.internal|3210/);
    },
    canonicalStub() as never,
    unclassified.reader,
  );
});
