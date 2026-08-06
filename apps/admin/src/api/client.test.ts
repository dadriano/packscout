import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AdminApiError,
  requestJson,
  setAdminCsrfToken,
  subscribeToAuthRequired,
  type Fetcher,
} from "./client.ts";

test("admin client sends JSON through the canonical API boundary", async () => {
  const fetcher: Fetcher = async (input, init) => {
    assert.equal(input, "/api/example");
    assert.equal(init?.credentials, "include");
    assert.equal(new Headers(init?.headers).get("Accept"), "application/json");
    assert.equal(
      new Headers(init?.headers).get("Content-Type"),
      "application/json",
    );
    assert.equal(init?.body, JSON.stringify({ enabled: true }));

    return new Response(JSON.stringify({ saved: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await requestJson<{ saved: boolean }>(
    "/example",
    { method: "POST", json: { enabled: true } },
    fetcher,
  );

  assert.deepEqual(result, { saved: true });
});

test("admin client preserves structured API errors", async () => {
  const fetcher: Fetcher = async () =>
    new Response(
      JSON.stringify({ error: "Access denied.", code: "FORBIDDEN" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    );

  await assert.rejects(
    () => requestJson("/example", {}, fetcher),
    (error: unknown) => {
      assert.ok(error instanceof AdminApiError);
      assert.equal(error.message, "Access denied.");
      assert.equal(error.status, 403);
      assert.equal(error.code, "FORBIDDEN");
      return true;
    },
  );
});

test("admin client fails closed when a successful response is not JSON", async () => {
  const fetcher: Fetcher = async () =>
    new Response("<html>not the API</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });

  await assert.rejects(
    () => requestJson("/example", {}, fetcher),
    (error: unknown) => {
      assert.ok(error instanceof AdminApiError);
      assert.equal(error.code, "INVALID_RESPONSE");
      return true;
    },
  );
});

test("admin client attaches the session CSRF token to every mutation", async () => {
  setAdminCsrfToken("session-bound-csrf");
  const fetcher: Fetcher = async (_input, init) => {
    assert.equal(
      new Headers(init?.headers).get("X-CSRF-Token"),
      "session-bound-csrf",
    );
    return new Response(null, { status: 204 });
  };

  try {
    await requestJson<void>("/operators/example", { method: "PATCH" }, fetcher);
  } finally {
    setAdminCsrfToken(null);
  }
});

test("admin client announces session expiry for protected requests", async () => {
  let notifications = 0;
  const unsubscribe = subscribeToAuthRequired(() => {
    notifications += 1;
  });
  const fetcher: Fetcher = async () =>
    new Response(
      JSON.stringify({ error: "Sign in required.", code: "AUTH_REQUIRED" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );

  try {
    await assert.rejects(() => requestJson("/operators", {}, fetcher));
    assert.equal(notifications, 1);
    await assert.rejects(() => requestJson("/auth/session", {}, fetcher));
    assert.equal(notifications, 1);
  } finally {
    unsubscribe();
  }
});
