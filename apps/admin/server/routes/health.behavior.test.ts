import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { createHealthRouter } from "./health.ts";

test("GET /api/health reports the admin service state", async () => {
  const app = express();
  app.disable("x-powered-by");
  app.use("/api/health", createHealthRouter());

  const server = app.listen(0, "127.0.0.1");

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    const { address, port } = server.address() as AddressInfo;
    const response = await fetch(`http://${address}:${port}/api/health`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "packscout-admin",
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
