import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fetcher } from "./client.ts";
import {
  getPublishedActiveRelease,
  listPublishedEntities,
  readPublishedChaseReconciliation,
  readPublishedDocument,
} from "./data-inspection.ts";

function capturingFetcher(requests: Array<{ url: string; init?: RequestInit }>): Fetcher {
  return async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ status: "no_active_manifest" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

test("published active-release reads stay on the admin server", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  await getPublishedActiveRelease(
    "courtyard/us",
    undefined,
    capturingFetcher(requests),
  );

  assert.equal(
    requests[0]?.url,
    "/api/data-inspection/published/providers/courtyard%2Fus/active-release",
  );
  assert.equal(requests[0]?.init?.credentials, "include");
  assert.equal(new Headers(requests[0]?.init?.headers).get("accept"), "application/json");
  assert.equal(requests[0]?.init?.headers instanceof Headers, true);
  assert.equal(requests[0]?.url.includes("convex"), false);
});

test("published entity paging preserves its opaque cursor", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  await listPublishedEntities(
    {
      platformKey: "clutchpacks",
      publicProviderReleaseId: "10000000-0000-5000-8000-000000000001",
      entityKind: "repacks",
      limit: 50,
      cursor: "opaque +/=? cursor",
    },
    undefined,
    capturingFetcher(requests),
  );

  const url = new URL(requests[0]!.url, "http://admin.test");
  assert.equal(url.pathname, "/api/data-inspection/published/providers/clutchpacks/entities");
  assert.equal(url.searchParams.get("entityKind"), "repacks");
  assert.equal(
    url.searchParams.get("expectedPublicProviderReleaseId"),
    "10000000-0000-5000-8000-000000000001",
  );
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.get("cursor"), "opaque +/=? cursor");
});

test("published documents encode entity kind and public identity", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  await readPublishedDocument(
    {
      platformKey: "clutchpacks",
      publicProviderReleaseId: "10000000-0000-5000-8000-000000000001",
      entityKind: "collectibles",
      publicEntityId: "card/one?revision=2",
    },
    undefined,
    capturingFetcher(requests),
  );

  const url = new URL(requests[0]!.url, "http://admin.test");
  assert.equal(
    url.pathname,
    "/api/data-inspection/published/providers/clutchpacks/entities/collectibles/card%2Fone%3Frevision%3D2",
  );
  assert.equal(
    url.searchParams.get("expectedPublicProviderReleaseId"),
    "10000000-0000-5000-8000-000000000001",
  );
});

test("chase reconciliation is addressed by its parent repack", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  await readPublishedChaseReconciliation(
    {
      platformKey: "clutchpacks",
      publicProviderReleaseId: "10000000-0000-5000-8000-000000000001",
      publicRepackId: "repack/one",
    },
    undefined,
    capturingFetcher(requests),
  );

  const url = new URL(requests[0]!.url, "http://admin.test");
  assert.equal(
    url.pathname,
    "/api/data-inspection/published/providers/clutchpacks/repacks/repack%2Fone/chase-reconciliation",
  );
  assert.equal(
    url.searchParams.get("expectedPublicProviderReleaseId"),
    "10000000-0000-5000-8000-000000000001",
  );
});
