import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthSessionResponse } from "@packscout/contracts";
import {
  forgetAuthSession,
  getSession,
  subscribeToAuthSession,
} from "./auth.ts";
import {
  requestJson,
  type Fetcher,
} from "./client.ts";

function session(csrfToken: string): AuthSessionResponse {
  return {
    operator: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "admin@packscout.test",
      displayName: "PackScout Admin",
      state: "active",
    },
    membership: {
      organizationId: "00000000-0000-4000-8000-000000000010",
      organizationName: "PackScout",
      role: "admin",
    },
    permissions: ["operators:manage"],
    csrfToken,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("an older session response cannot replace a newer session or CSRF token", async () => {
  forgetAuthSession();
  let resolveOlder!: (response: Response) => void;
  let resolveNewer!: (response: Response) => void;
  const observedTokens: string[] = [];
  const unsubscribe = subscribeToAuthSession((value) => {
    if (value) observedTokens.push(value.csrfToken);
  });
  const olderFetcher: Fetcher = () =>
    new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
  const newerFetcher: Fetcher = () =>
    new Promise<Response>((resolve) => {
      resolveNewer = resolve;
    });

  try {
    const olderRequest = getSession(olderFetcher);
    const newerRequest = getSession(newerFetcher);
    resolveNewer(jsonResponse(session("newer-csrf")));
    await newerRequest;
    resolveOlder(jsonResponse(session("older-csrf")));
    await olderRequest;

    const mutationFetcher: Fetcher = async (_input, init) => {
      assert.equal(
        new Headers(init?.headers).get("X-CSRF-Token"),
        "newer-csrf",
      );
      return new Response(null, { status: 204 });
    };
    await requestJson<void>("/operators/example", { method: "PATCH" }, mutationFetcher);
    assert.deepEqual(observedTokens, ["newer-csrf"]);
  } finally {
    unsubscribe();
    forgetAuthSession();
  }
});

test("a stale session failure cannot clear a newer authenticated session", async () => {
  forgetAuthSession();
  let rejectOlder!: (error: Error) => void;
  const olderFetcher: Fetcher = () =>
    new Promise<Response>((_resolve, reject) => {
      rejectOlder = reject;
    });

  try {
    const olderRequest = getSession(olderFetcher);
    await getSession(async () => jsonResponse(session("current-csrf")));
    rejectOlder(new Error("older request failed"));
    await assert.rejects(olderRequest, /older request failed/);

    const mutationFetcher: Fetcher = async (_input, init) => {
      assert.equal(
        new Headers(init?.headers).get("X-CSRF-Token"),
        "current-csrf",
      );
      return new Response(null, { status: 204 });
    };
    await requestJson<void>("/operators/example", { method: "PATCH" }, mutationFetcher);
  } finally {
    forgetAuthSession();
  }
});
