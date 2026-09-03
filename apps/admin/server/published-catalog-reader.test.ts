import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPublishedCatalogReader,
  PublishedCatalogError,
} from "./published-catalog-reader.ts";

const TOKEN = "s".repeat(48);
const RELEASE_ID = "10000000-0000-5000-8000-000000000001";
const MANIFEST_ID = "10000000-0000-5000-8000-000000000002";
const VENDOR_ID = "00000000-0000-5000-8000-000000000001";
const HASH = "a".repeat(64);
const config = { baseUrl: "https://product.example", token: TOKEN };

const vendor = {
  publicVendorId: VENDOR_ID,
  vendorKey: "clutchpacks",
  displayName: "ClutchPacks",
  logoUrl: null,
  websiteUrl: null,
  listingHosts: [],
  imageOrigins: [],
  referralParameters: [],
  publicPromo: null,
};

function activeRelease() {
  return {
    status: "active",
    manifestPublicReleaseId: MANIFEST_ID,
    referenceFingerprint: HASH,
    release: {
      publicProviderReleaseId: RELEASE_ID,
      platformKey: "clutchpacks",
      lifecycle: "complete",
      dataAsOf: "2026-08-27T10:00:00.000Z",
      providerReleaseFingerprint: HASH,
      contentHash: HASH,
      entityHashes: {
        vendors: HASH,
        categories: HASH,
        collectibles: HASH,
        repacks: HASH,
        repack_chases: HASH,
        search_shards: HASH,
      },
      counts: {
        vendors: 1,
        categories: 0,
        collectibles: 0,
        repacks: 0,
        repackChases: 0,
        searchShards: 0,
      },
      batchCount: 1,
      batchChainHash: HASH,
      createdAt: "2026-08-27T10:00:00.000Z",
      completedAt: "2026-08-27T10:01:00.000Z",
      completionOperationId: "clutchpacks.finalize.1",
    },
  };
}

function jsonFetch(value: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

async function expectCode(
  promise: Promise<unknown>,
  code: PublishedCatalogError["code"],
) {
  await assert.rejects(promise, (reason: unknown) => {
    assert.ok(reason instanceof PublishedCatalogError);
    assert.equal(reason.code, code);
    return true;
  });
}

test("reader keeps credentials server-side and validates active release facts", async () => {
  let capturedUrl = "";
  let capturedAuthorization = "";
  let capturedBody = "";
  const reader = createPublishedCatalogReader({
    config,
    fetchImplementation: (async (url, init) => {
      capturedUrl = String(url);
      capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      capturedBody = String(init?.body);
      return new Response(JSON.stringify(activeRelease()), { status: 200 });
    }) as typeof fetch,
  });

  const result = await reader.activeRelease("clutchpacks");
  assert.equal(result.status, "active");
  assert.equal(capturedUrl, "https://product.example/admin/provider-catalog/active-release");
  assert.equal(capturedAuthorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(capturedBody), { platformKey: "clutchpacks" });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("reader validates entity pages and document identity by selected kind", async () => {
  let entityBody = "";
  const pageReader = createPublishedCatalogReader({
    config,
    fetchImplementation: (async (_url, init) => {
      entityBody = String(init?.body);
      return new Response(
        JSON.stringify({
          status: "ok",
          items: [{ publicEntityId: VENDOR_ID, detail: vendor }],
          isDone: true,
          continueCursor: "",
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  assert.equal(
    (await pageReader.listEntities({
      platformKey: "clutchpacks",
      expectedPublicProviderReleaseId: RELEASE_ID,
      entityKind: "vendors",
      numItems: 25,
      cursor: null,
    })).status,
    "ok",
  );
  assert.deepEqual(JSON.parse(entityBody), {
    platformKey: "clutchpacks",
    expectedPublicProviderReleaseId: RELEASE_ID,
    entityKind: "vendors",
    paginationOpts: { numItems: 25, cursor: null },
  });

  let documentBody = "";
  const invalidDocumentReader = createPublishedCatalogReader({
    config,
    fetchImplementation: (async (_url, init) => {
      documentBody = String(init?.body);
      return new Response(
        JSON.stringify({
          status: "ok",
          publicEntityId: VENDOR_ID,
          detail: { ...vendor, organizationId: "protected" },
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  await expectCode(
    invalidDocumentReader.readDocument({
      platformKey: "clutchpacks",
      expectedPublicProviderReleaseId: RELEASE_ID,
      entityKind: "vendors",
      publicEntityId: VENDOR_ID,
    }),
    "PUBLISHED_CATALOG_UNAVAILABLE",
  );
  assert.deepEqual(JSON.parse(documentBody), {
    platformKey: "clutchpacks",
    expectedPublicProviderReleaseId: RELEASE_ID,
    entityKind: "vendors",
    publicEntityId: VENDOR_ID,
  });
});

test("reader validates chase reconciliation invariants", async () => {
  let chaseBody = "";
  const reader = createPublishedCatalogReader({
    config,
    fetchImplementation: (async (_url, init) => {
      chaseBody = String(init?.body);
      return new Response(
        JSON.stringify({
          status: "ok",
          publicRepackId: "00000000-0000-5000-8000-000000000301",
          expectedChaseCount: 2,
          acceptedChaseCount: 1,
          complete: true,
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  await expectCode(
    reader.readChaseReconciliation({
      platformKey: "clutchpacks",
      expectedPublicProviderReleaseId: RELEASE_ID,
      publicRepackId: "00000000-0000-5000-8000-000000000301",
    }),
    "PUBLISHED_CATALOG_UNAVAILABLE",
  );
  assert.deepEqual(JSON.parse(chaseBody), {
    platformKey: "clutchpacks",
    expectedPublicProviderReleaseId: RELEASE_ID,
    publicRepackId: "00000000-0000-5000-8000-000000000301",
  });
});

test("reader maps upstream status without forwarding its response body", async () => {
  for (const [status, code] of [
    [401, "PUBLISHED_CATALOG_UNAUTHORIZED"],
    [403, "PUBLISHED_CATALOG_UNAUTHORIZED"],
    [400, "PUBLISHED_CATALOG_REQUEST_INVALID"],
    [500, "PUBLISHED_CATALOG_UNAVAILABLE"],
  ] as const) {
    const reader = createPublishedCatalogReader({
      config,
      fetchImplementation: jsonFetch({ secret: "must-not-leak" }, status),
    });
    await assert.rejects(reader.activeRelease("clutchpacks"), (reason: unknown) => {
      assert.ok(reason instanceof PublishedCatalogError);
      assert.equal(reason.code, code);
      assert.equal(reason.message.includes("must-not-leak"), false);
      return true;
    });
  }
});

test("reader deadline covers a response body that stalls after headers", async () => {
  let bodyAborted = false;
  const reader = createPublishedCatalogReader({
    config,
    timeoutMs: 20,
    fetchImplementation: (async (_url, init) => {
      const signal = init?.signal;
      assert.ok(signal);
      const body = new ReadableStream({
        start(controller) {
          const fallback = setTimeout(() => {
            controller.error(new Error("test body fallback"));
          }, 250);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(fallback);
              bodyAborted = true;
              controller.error(new Error("response body aborted"));
            },
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch,
  });

  await expectCode(
    reader.activeRelease("clutchpacks"),
    "PUBLISHED_CATALOG_UNAVAILABLE",
  );
  assert.equal(bodyAborted, true);
});

test("reader collapses missing configuration, transport, JSON, and schema failures", async () => {
  await expectCode(
    createPublishedCatalogReader({ config: null }).activeRelease("clutchpacks"),
    "PUBLISHED_CATALOG_UNCONFIGURED",
  );
  await expectCode(
    createPublishedCatalogReader({
      config,
      fetchImplementation: (async () => {
        throw new Error("private-host:3210");
      }) as typeof fetch,
    }).activeRelease("clutchpacks"),
    "PUBLISHED_CATALOG_UNAVAILABLE",
  );
  await expectCode(
    createPublishedCatalogReader({
      config,
      fetchImplementation: (async () => new Response("not-json")) as typeof fetch,
    }).activeRelease("clutchpacks"),
    "PUBLISHED_CATALOG_UNAVAILABLE",
  );
  await expectCode(
    createPublishedCatalogReader({
      config,
      fetchImplementation: jsonFetch({ ...activeRelease(), extra: true }),
    }).activeRelease("clutchpacks"),
    "PUBLISHED_CATALOG_UNAVAILABLE",
  );
});
