import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  createProviderPromotionBootstrapRouter,
  type ProviderPromotionBootstrapRouterDependencies,
} from
  "./promotion-job-provider-bootstrap.ts";

async function withServer(
  load: (input: {
    providerId: string;
    bearerTokenBase64: string;
  }) => Promise<unknown>,
  visit: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/api/internal/promotion-jobs/provider-bootstrap",
    createProviderPromotionBootstrapRouter({
      bootstrap: {
        load: load as ProviderPromotionBootstrapRouterDependencies[
          "bootstrap"
        ]["load"],
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address() as AddressInfo;
    await visit(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

test("machine route rejects forged scope before bootstrap work", async () => {
  let calls = 0;
  await withServer(async () => {
    calls += 1;
    return { pin: {} };
  }, async (baseUrl) => {
    for (const request of [
      { body: { providerId: "not-a-provider" } },
      { body: { providerId: "17000000-0000-4000-8000-000000000001" } },
      {
        body: {
          providerId: "17000000-0000-4000-8000-000000000001",
          databaseUrl: "postgresql://forged.invalid/db",
        },
        authorization: "Bearer protected-token",
      },
    ]) {
      const response = await fetch(
        `${baseUrl}/api/internal/promotion-jobs/provider-bootstrap`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(request.authorization === undefined
              ? {}
              : { authorization: request.authorization }),
          },
          body: JSON.stringify(request.body),
        },
      );
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {
        error: "The provider promotion bootstrap request was rejected.",
        code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAUTHORIZED",
      });
    }
  });
  assert.equal(calls, 0);
});

test("machine route forwards only provider identity and bearer token", async () => {
  const observed: unknown[] = [];
  await withServer(async (input) => {
    observed.push(input);
    return { pin: { providerId: input.providerId } };
  }, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/internal/promotion-jobs/provider-bootstrap`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer protected-token",
        },
        body: JSON.stringify({
          providerId: "17000000-0000-4000-8000-000000000001",
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      pin: { providerId: "17000000-0000-4000-8000-000000000001" },
    });
  });
  assert.deepEqual(observed, [{
    providerId: "17000000-0000-4000-8000-000000000001",
    bearerTokenBase64: "protected-token",
  }]);
});
