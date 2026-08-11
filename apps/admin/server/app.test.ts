import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Express } from "express";
import { createAdminApp } from "./app.ts";

async function withServer(
  app: Express,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = app.listen(0, "127.0.0.1");

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    const { address, port } = server.address() as AddressInfo;
    await run(`http://${address}:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("unknown admin API routes return the stable structured error contract", async () => {
  await withServer(createAdminApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/not-real`);

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.deepEqual(await response.json(), {
      error: "Admin API route not found.",
      code: "API_ROUTE_NOT_FOUND",
    });
  });
});

test("malformed JSON is rejected without leaking implementation details", async () => {
  await withServer(createAdminApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/not-real`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Request body must contain valid JSON.",
      code: "INVALID_JSON",
    });
  });
});

test("admin app trusts forwarded addresses only from configured proxy ranges", () => {
  assert.equal(createAdminApp().get("trust proxy"), false);
  assert.deepEqual(
    createAdminApp({ trustedProxies: ["10.0.0.0/24"] }).get("trust proxy"),
    ["10.0.0.0/24"],
  );
});
