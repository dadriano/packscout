import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DataReleaseV3Identity,
  GetPublicRepackInput,
  PublicRepackViewDetailV3,
} from "@packscout/contracts";
import {
  createAccessGuardedHandler,
  type VisitorAccessDecision,
} from "@/lib/access-gate.server";
import { createPublicRepackDetailHandler } from "@/lib/public-repack-detail-route.server";
import type {
  GetPublicRepackV3Result,
  GetPublicShellStatusV3Result,
} from "@/lib/public-repacks-v3";

const ORIGIN = "https://packscout.example";
const REPACK_ID = "00000000-0000-5000-8000-000000000101";
const RELEASE_ID = "00000000-0000-4000-8000-000000000001";

function request(path: string) {
  return new Request(`${ORIGIN}${path}`);
}

async function responseBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

const release = {
  publicReleaseId: RELEASE_ID,
} as DataReleaseV3Identity;

const shellOk = {
  ok: true,
  data: { release },
} as unknown as GetPublicShellStatusV3Result;

function detailHandler(
  readShell: () => Promise<GetPublicShellStatusV3Result> = async () => shellOk,
  readRepack: (
    input: GetPublicRepackInput,
  ) => Promise<GetPublicRepackV3Result> = async () =>
    ({
      ok: true,
      data: { publicRepackId: REPACK_ID } as PublicRepackViewDetailV3,
    }) as GetPublicRepackV3Result,
) {
  return createPublicRepackDetailHandler(readShell, readRepack);
}

test("accepts a pack id and returns no-store pack details against the active release", async () => {
  const seen: GetPublicRepackInput[] = [];
  const handler = detailHandler(async () => shellOk, async (input) => {
    seen.push(input);
    return {
      ok: true,
      data: { publicRepackId: REPACK_ID },
    } as GetPublicRepackV3Result;
  });

  const response = await handler(request(`/api/repacks/${REPACK_ID}`));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(seen[0]?.publicRepackId, REPACK_ID);
  assert.equal(seen[0]?.publicReleaseId, RELEASE_ID);
  const body = await responseBody(response);
  assert.equal(body.ok, true);
  assert.deepEqual(
    (body.data as { release: { publicReleaseId: string } }).release,
    { publicReleaseId: RELEASE_ID },
  );
});

test("rejects malformed ids and extra query state without reading Convex", async () => {
  let reads = 0;
  const handler = detailHandler(async () => {
    reads += 1;
    throw new Error("invalid requests must not read Convex");
  });
  for (const path of [
    "/api/repacks/not-a-uuid",
    `/api/repacks/${REPACK_ID}?selected=1`,
    "/api/repacks/00000000-0000-4000-8000-000000000101",
  ]) {
    const response = await handler(request(path));
    assert.equal(response.status, 400, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await responseBody(response), {
      ok: false,
      code: "INVALID_QUERY",
      error: "Repack details request is invalid.",
      retryable: false,
    });
  }
  assert.equal(reads, 0);
});

test("maps bounded public read errors without leaking the pack id", async () => {
  for (const [code, expectedStatus] of [
    ["INVALID_QUERY", 400],
    ["REPACK_NOT_FOUND", 404],
    ["RELEASE_UNAVAILABLE", 503],
  ] as const) {
    const handler = detailHandler(async () => shellOk, async () => {
      if (code === "INVALID_QUERY") {
        return {
          ok: false,
          code,
          error: "Repack query is invalid.",
          retryable: false,
        };
      }
      if (code === "REPACK_NOT_FOUND") {
        return {
          ok: false,
          code,
          error: "Repack not found.",
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
    const response = await handler(request(`/api/repacks/${REPACK_ID}`));
    assert.equal(response.status, expectedStatus);
    assert.doesNotMatch(
      JSON.stringify(await responseBody(response)),
      /00000000-0000-5000-8000-000000000101/,
    );
  }
});

test("the deployed route shape gates before parsing: refusal first, reads only for admitted callers", async () => {
  let reads = 0;
  const inner = detailHandler(async () => {
    reads += 1;
    return shellOk;
  });

  const refused = createAccessGuardedHandler(
    async (): Promise<VisitorAccessDecision> => ({ outcome: "signed_out" }),
    inner,
  );
  for (const path of [
    `/api/repacks/${REPACK_ID}`,
    "/api/repacks/not-a-uuid",
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
  const response = await admitted(request(`/api/repacks/${REPACK_ID}`));
  assert.equal(response.status, 200);
  assert.equal(reads, 1);
});
