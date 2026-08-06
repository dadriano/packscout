import assert from "node:assert/strict";
import { test } from "node:test";
import { AdminApiError, requestJson, type Fetcher } from "./client.ts";

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
