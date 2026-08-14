import assert from "node:assert/strict";
import { test } from "node:test";
import {
  convexDevArguments,
  unexpectedConvexExitError,
  waitForLoopbackService,
} from "./start-frontend-with-convex-mock.mjs";

test("launcher waits through transient failures until local Convex responds", async () => {
  let attempts = 0;
  let time = 0;
  await waitForLoopbackService("http://127.0.0.1:3210", {
    fetchImplementation: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("not ready");
      return { status: 200 };
    },
    timeoutMilliseconds: 1_000,
    pollMilliseconds: 10,
    now: () => time,
    wait: async (milliseconds) => {
      time += milliseconds;
    },
  });
  assert.equal(attempts, 3);
});

test("launcher fails closed when Convex exits or readiness times out", async () => {
  await assert.rejects(
    waitForLoopbackService("http://127.0.0.1:3210", {
      fetchImplementation: async () => {
        throw new Error("not ready");
      },
      processIsRunning: () => false,
      timeoutMilliseconds: 10,
    }),
    /exited before it became ready/u,
  );

  let time = 0;
  await assert.rejects(
    waitForLoopbackService("http://127.0.0.1:3210", {
      fetchImplementation: async () => {
        throw new Error("not ready");
      },
      timeoutMilliseconds: 20,
      pollMilliseconds: 10,
      now: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
      },
    }),
    /Timed out/u,
  );
});

test("launcher starts a long-lived typed Convex dev watcher", () => {
  assert.deepEqual(convexDevArguments(), [
    "--no-install",
    "convex",
    "dev",
    "--typecheck",
    "enable",
    "--codegen",
    "enable",
    "--tail-logs",
    "disable",
    "--start",
    "node scripts/local/start-frontend-after-convex-ready.mjs",
  ]);
});

test("launcher reports an unexpected signaled Convex exit as failure", () => {
  assert.match(
    unexpectedConvexExitError({
      name: "convex",
      code: null,
      signal: "SIGKILL",
    }).message,
    /exited unexpectedly with SIGKILL/u,
  );
  assert.equal(
    unexpectedConvexExitError({
      name: "convex",
      code: 0,
      signal: null,
    }),
    null,
  );
});
