import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DataReleaseV3Identity,
  FindRepacksByDesiredCollectibleInput,
} from "@packscout/contracts";
import {
  createAccessGuardedHandler,
  type VisitorAccessDecision,
} from "@/lib/access-gate.server";
import { createDesiredCollectibleRepacksHandler } from "@/lib/desired-collectible-repacks-route.server";
import type { FindRepacksByDesiredCollectibleV3Result } from "@/lib/public-repacks-v3";

const ORIGIN = "https://packscout.example";
const COLLECTIBLE_ID = "00000000-0000-5000-8000-000000000201";

function request(path: string) {
  return new Request(`${ORIGIN}${path}`);
}

async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

test("accepts a collectible id and returns no-store chase pack matches", async () => {
  const seen: FindRepacksByDesiredCollectibleInput[] = [];
  const release = {} as DataReleaseV3Identity;
  const handler = createDesiredCollectibleRepacksHandler(async (input) => {
    seen.push(input);
    return {
      ok: true,
      data: {
        release,
        desiredCollectible: { publicCollectibleId: COLLECTIBLE_ID },
        matches: [],
        total: 0,
      },
    } as unknown as FindRepacksByDesiredCollectibleV3Result;
  });

  const response = await handler(
    request(`/api/collectibles/${COLLECTIBLE_ID}/repacks`),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(seen[0]?.publicCollectibleId, COLLECTIBLE_ID);
  assert.equal(seen[0]?.limit, 50);
  assert.equal((await responseBody(response)).ok, true);
});

test("rejects malformed ids and extra query state without reading Convex", async () => {
  let reads = 0;
  const handler = createDesiredCollectibleRepacksHandler(async () => {
    reads += 1;
    throw new Error("invalid requests must not read Convex");
  });
  for (const path of [
    "/api/collectibles/not-a-uuid/repacks",
    `/api/collectibles/${COLLECTIBLE_ID}/repacks?limit=10`,
    "/api/collectibles/00000000-0000-4000-8000-000000000201/repacks",
  ]) {
    const response = await handler(request(path));
    assert.equal(response.status, 400, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await responseBody(response), {
      ok: false,
      code: "INVALID_QUERY",
      error: "Chase details request is invalid.",
      retryable: false,
    });
  }
  assert.equal(reads, 0);
});

test("maps bounded public read errors without leaking the collectible id", async () => {
  for (const [code, expectedStatus] of [
    ["INVALID_QUERY", 400],
    ["COLLECTIBLE_NOT_FOUND", 404],
    ["RELEASE_UNAVAILABLE", 503],
  ] as const) {
    const handler = createDesiredCollectibleRepacksHandler(async () => {
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
    const response = await handler(
      request(`/api/collectibles/${COLLECTIBLE_ID}/repacks`),
    );
    assert.equal(response.status, expectedStatus);
    assert.doesNotMatch(
      JSON.stringify(await responseBody(response)),
      /00000000-0000-5000-8000-000000000201/,
    );
  }
});

test("the deployed route shape gates before parsing: refusal first, reads only for admitted callers", async () => {
  let reads = 0;
  const inner = createDesiredCollectibleRepacksHandler(async () => {
    reads += 1;
    return {
      ok: true,
      data: {
        release: {} as DataReleaseV3Identity,
        desiredCollectible: { publicCollectibleId: COLLECTIBLE_ID },
        matches: [],
        total: 0,
      },
    } as unknown as FindRepacksByDesiredCollectibleV3Result;
  });

  const refused = createAccessGuardedHandler(
    async (): Promise<VisitorAccessDecision> => ({ outcome: "signed_out" }),
    inner,
  );
  for (const path of [
    `/api/collectibles/${COLLECTIBLE_ID}/repacks`,
    "/api/collectibles/not-a-uuid/repacks",
  ]) {
    const refusal = await refused(request(path));
    assert.equal(refusal.status, 401, path);
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
  const response = await admitted(
    request(`/api/collectibles/${COLLECTIBLE_ID}/repacks`),
  );
  assert.equal(response.status, 200);
  assert.equal(reads, 1);
});
