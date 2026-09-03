import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type Response } from "express";
import {
  createProviderPromotionBootstrapRouter,
  type ProviderPromotionBootstrapRouterDependencies,
  waitForProviderPromotionBootstrapDrain,
} from
  "./promotion-job-provider-bootstrap.ts";

async function withServer(
  load: (input: {
    providerId: string;
    bearerTokenBase64: string;
    signal: AbortSignal;
    deadlineAt: number;
  }) => Promise<unknown>,
  visit: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/api/internal/promotion-jobs/provider-bootstrap",
    createProviderPromotionBootstrapRouter({
      bootstrap: {
        async stream(input) {
          const frame = await load(input);
          return {
            async *[Symbol.asyncIterator]() { yield frame; },
          } as Awaited<ReturnType<ProviderPromotionBootstrapRouterDependencies[
            "bootstrap"
          ]["stream"]>>;
        },
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
          requestBudgetMilliseconds: 1_000,
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
  const observed: Parameters<Parameters<typeof withServer>[0]>[0][] = [];
  const requestedAt = Date.now();
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
          requestBudgetMilliseconds: 1_000,
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^application\/x-ndjson;/u,
    );
    const body = await response.text();
    assert.deepEqual(
      body.trim().split("\n").map((line) => JSON.parse(line) as unknown),
      [{
        pin: { providerId: "17000000-0000-4000-8000-000000000001" },
      }],
    );
  });
  assert.equal(observed.length, 1);
  const input = observed[0]!;
  assert.equal(input.providerId, "17000000-0000-4000-8000-000000000001");
  assert.equal(input.bearerTokenBase64, "protected-token");
  assert.equal(input.signal.aborted, false);
  assert.ok(input.deadlineAt >= requestedAt + 900);
  assert.ok(input.deadlineAt <= Date.now() + 1_000);
});

test("machine route rejects request budgets outside the owned range", async () => {
  let calls = 0;
  await withServer(async () => {
    calls += 1;
    return { pin: {} };
  }, async (baseUrl) => {
    for (const requestBudgetMilliseconds of [99, 30_001, 100.5, "1000"]) {
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
            requestBudgetMilliseconds,
          }),
        },
      );
      assert.equal(response.status, 401);
    }
  });
  assert.equal(calls, 0);
});

test("machine route aborts an in-flight pin when the client disconnects", async () => {
  let started!: () => void;
  const pinStarted = new Promise<void>((resolve) => { started = resolve; });
  let aborted!: () => void;
  const pinAborted = new Promise<void>((resolve) => { aborted = resolve; });
  await withServer(async (input) => {
    started();
    return new Promise((_resolve, reject) => {
      const cancelled = () => {
        aborted();
        reject(new Error("cancelled"));
      };
      input.signal.addEventListener("abort", cancelled, { once: true });
      if (input.signal.aborted) cancelled();
    });
  }, async (baseUrl) => {
    const controller = new AbortController();
    const request = fetch(
      `${baseUrl}/api/internal/promotion-jobs/provider-bootstrap`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer protected-token",
        },
        body: JSON.stringify({
          providerId: "17000000-0000-4000-8000-000000000001",
          requestBudgetMilliseconds: 30_000,
        }),
        signal: controller.signal,
      },
    );
    await pinStarted;
    controller.abort();
    await assert.rejects(request, { name: "AbortError" });
    await pinAborted;
  });
});

test("drain waiting stops on ownership abort and an already-destroyed response", async () => {
  const response = Object.assign(
    new EventEmitter(),
    { destroyed: false },
  ) as unknown as Response;
  const controller = new AbortController();
  const waiting = waitForProviderPromotionBootstrapDrain(
    response,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(waiting, {
    code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE",
  });

  const destroyed = Object.assign(
    new EventEmitter(),
    { destroyed: true },
  ) as unknown as Response;
  await assert.rejects(
    waitForProviderPromotionBootstrapDrain(
      destroyed,
      new AbortController().signal,
    ),
    { code: "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE" },
  );
});
