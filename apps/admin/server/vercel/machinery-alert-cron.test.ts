import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import {
  createMachineryAlertCronHandler,
  type MachineryAlertCycleGuard,
} from "./machinery-alert-cron.ts";

const secret = "packscout-vercel-cron-secret-000000000001";

async function withCronServer(
  input: {
    readSecret?: () => string;
    guard?: MachineryAlertCycleGuard;
    runCycle?: () => Promise<unknown>;
  },
  visit: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.get(
    "/api/internal/machinery-alert-cycle",
    createMachineryAlertCronHandler({
      readSecret: input.readSecret ?? (() => secret),
      getGuard:
        () =>
          input.guard ?? {
            async run(operation) {
              return { kind: "executed", value: await operation() } as const;
            },
          },
      runCycle: input.runCycle ?? (() => Promise.resolve()),
      reportFailure: () => undefined,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  try {
    await visit(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("cron admission rejects a missing or incorrect secret before database work", async () => {
  let guarded = 0;
  let cycles = 0;
  const guard: MachineryAlertCycleGuard = {
    async run() {
      guarded += 1;
      return { kind: "busy" };
    },
  };
  await withCronServer(
    {
      guard,
      runCycle: async () => {
        cycles += 1;
      },
    },
    async (baseUrl) => {
      for (const authorization of [undefined, "Bearer wrong-secret"]) {
        const response = await fetch(
          `${baseUrl}/api/internal/machinery-alert-cycle`,
          authorization ? { headers: { authorization } } : undefined,
        );
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), {
          error: "The machinery alert request was rejected.",
          code: "MACHINERY_ALERT_CRON_UNAUTHORIZED",
        });
      }
    },
  );
  assert.equal(guarded, 0);
  assert.equal(cycles, 0);
});

test("an admitted cron runs once and reports lock contention without a cycle", async () => {
  let cycles = 0;
  let busy = false;
  const guard: MachineryAlertCycleGuard = {
    async run(operation) {
      if (busy) return { kind: "busy" };
      return { kind: "executed", value: await operation() };
    },
  };
  await withCronServer(
    {
      guard,
      runCycle: async () => {
        cycles += 1;
      },
    },
    async (baseUrl) => {
      const headers = { authorization: `Bearer ${secret}` };
      const completed = await fetch(
        `${baseUrl}/api/internal/machinery-alert-cycle`,
        { headers },
      );
      assert.equal(completed.status, 200);
      assert.deepEqual(await completed.json(), { status: "completed" });

      busy = true;
      const skipped = await fetch(
        `${baseUrl}/api/internal/machinery-alert-cycle`,
        { headers },
      );
      assert.equal(skipped.status, 202);
      assert.deepEqual(await skipped.json(), {
        status: "skipped",
        code: "MACHINERY_ALERT_CYCLE_ALREADY_RUNNING",
      });
    },
  );
  assert.equal(cycles, 1);
});

test("configuration and cycle failures return stable secret-free errors", async () => {
  await withCronServer(
    { readSecret: () => "short" },
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/internal/machinery-alert-cycle`,
        { headers: { authorization: `Bearer ${secret}` } },
      );
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "The machinery alert scheduler is unavailable.",
        code: "MACHINERY_ALERT_SCHEDULER_UNAVAILABLE",
      });
    },
  );

  await withCronServer(
    { runCycle: () => Promise.reject(new Error("sensitive database error")) },
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/internal/machinery-alert-cycle`,
        { headers: { authorization: `Bearer ${secret}` } },
      );
      assert.equal(response.status, 503);
      const body = await response.text();
      assert.doesNotMatch(body, /sensitive database error/);
      assert.deepEqual(JSON.parse(body), {
        error: "The machinery alert cycle could not be completed.",
        code: "MACHINERY_ALERT_CYCLE_FAILED",
      });
    },
  );
});
