import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DataReleaseV3Identity,
  SearchPublicCollectiblesInput,
} from "@packscout/contracts";
import {
  createAccessGuardedHandler,
  type VisitorAccessDecision,
} from "@/lib/access-gate.server";
import { createDesiredCollectibleSearchHandler } from "@/lib/desired-collectible-search-route.server";

const ORIGIN = "https://packscout.example";

function request(query: string) {
  return new Request(`${ORIGIN}/api/collectibles/search?${query}`);
}

async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

test("accepts one strict q and returns no-store collectible matches", async () => {
  const seen: SearchPublicCollectiblesInput[] = [];
  const release = {} as DataReleaseV3Identity;
  const handler = createDesiredCollectibleSearchHandler(async (input) => {
    seen.push(input);
    return { ok: true, data: { release, matches: [] } };
  });

  const response = await handler(request("q=%20Charizard%20%20EX%20"));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(seen, [
    { search: "charizard ex", collectibleTypes: [], limit: 20 },
  ]);
  assert.deepEqual(await responseBody(response), {
    ok: true,
    data: { release, matches: [] },
  });
});

test("rejects short, duplicate, missing, and unknown query state", async () => {
  let reads = 0;
  const handler = createDesiredCollectibleSearchHandler(async () => {
    reads += 1;
    throw new Error("invalid requests must not read Convex");
  });
  for (const query of [
    "",
    "q=c",
    "q=charizard&q=pikachu",
    "q=charizard&limit=50",
  ]) {
    const response = await handler(request(query));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await responseBody(response), {
      ok: false,
      code: "INVALID_QUERY",
      error: "Collectible search is invalid.",
      retryable: false,
    });
  }
  assert.equal(reads, 0);
});

test("maps bounded public read errors without leaking search text", async () => {
  for (const [code, expectedStatus] of [
    ["INVALID_QUERY", 400],
    ["COLLECTIBLE_NOT_FOUND", 404],
    ["RELEASE_UNAVAILABLE", 503],
  ] as const) {
    const handler = createDesiredCollectibleSearchHandler(async () => {
      if (code === "INVALID_QUERY") {
        return {
          ok: false,
          code,
          error: "Repack query is invalid.",
          retryable: false,
        };
      }
      if (code === "COLLECTIBLE_NOT_FOUND") {
        return {
          ok: false,
          code,
          error: "Collectible not found.",
          retryable: false,
        };
      }
      return {
        ok: false,
        code,
        error: "Repack data is temporarily unavailable.",
        retryable: true,
      };
    });
    const response = await handler(request("q=private-search-term"));
    assert.equal(response.status, expectedStatus);
    assert.doesNotMatch(JSON.stringify(await responseBody(response)), /private-search-term/);
  }
});

test("the deployed route shape gates before parsing: refusal first, reads only for admitted callers", async () => {
  // The route composes createAccessGuardedHandler around this same search
  // handler with the request-scoped resolver (see app/route-access-gate
  // .source.test.ts); here the composition runs with injected decisions.
  let reads = 0;
  const inner = createDesiredCollectibleSearchHandler(async () => {
    reads += 1;
    return {
      ok: true,
      data: { release: {} as DataReleaseV3Identity, matches: [] },
    };
  });

  const refused = createAccessGuardedHandler(
    async (): Promise<VisitorAccessDecision> => ({ outcome: "signed_out" }),
    inner,
  );
  for (const query of ["q=charizard", ""]) {
    const refusal = await refused(request(query));
    assert.equal(refusal.status, 401, query);
    assert.deepEqual(await responseBody(refusal), {
      ok: false,
      code: "ACCESS_REQUIRED",
      error: "An approved beta account is required.",
      retryable: false,
    });
  }
  assert.equal(reads, 0);

  const admitted = createAccessGuardedHandler(
    async (): Promise<VisitorAccessDecision> => ({ outcome: "admitted" }),
    inner,
  );
  const response = await admitted(request("q=charizard"));
  assert.equal(response.status, 200);
  assert.equal(reads, 1);
});
