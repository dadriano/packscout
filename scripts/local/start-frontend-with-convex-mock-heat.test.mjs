import assert from "node:assert/strict";
import { test } from "node:test";
import {
  convexDevWithHeatArguments,
  installMockHeatShutdownHandlers,
  mockHeatLaunchArguments,
  mockHeatSessionEnvironment,
  shutdownMockHeatSession,
} from "./start-frontend-with-convex-mock-heat.mjs";

test("mock heat launcher keeps the existing frontend launcher independent", () => {
  const args = convexDevWithHeatArguments();
  assert.deepEqual(args.slice(0, 3), ["--no-install", "convex", "dev"]);
  assert.equal(args.includes("--start"), false);
});

test("anonymous local sessions suppress account-link prompts", () => {
  assert.deepEqual(
    mockHeatSessionEnvironment(
      { CONVEX_DEPLOYMENT: "anonymous:agent" },
      "http://127.0.0.1:3210",
    ),
    {
      CONVEX_DEPLOYMENT: "anonymous:agent",
      CONVEX_AGENT_MODE: "anonymous",
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
    },
  );
  assert.equal(
    mockHeatSessionEnvironment(
      { CONVEX_DEPLOYMENT: "local:linked" },
      "http://127.0.0.1:3210",
    ).CONVEX_AGENT_MODE,
    undefined,
  );
});

test("shutdown handlers absorb repeated forwarded signals until cleanup disposes them", () => {
  const listeners = new Map();
  const removed = [];
  const target = {
    on(signal, handler) {
      listeners.set(signal, handler);
    },
    off(signal, handler) {
      removed.push([signal, handler]);
    },
  };
  const abortController = new AbortController();
  const received = [];
  const signals = installMockHeatShutdownHandlers(
    abortController,
    (signal) => received.push(signal),
    target,
  );
  listeners.get("SIGINT")();
  listeners.get("SIGINT")();
  listeners.get("SIGTERM")();
  assert.equal(abortController.signal.aborted, true);
  assert.equal(signals.requestedSignal, "SIGINT");
  assert.deepEqual(received, ["SIGINT"]);
  signals.dispose();
  assert.equal(removed.length, 3);
});

test("shutdown finishes heat cleanup before terminating Convex", async () => {
  const order = [];
  const abortController = new AbortController();
  abortController.signal.addEventListener("abort", () => order.push("abort"));
  await shutdownMockHeatSession({
    abortController,
    simulation: Promise.resolve().then(() => order.push("heat cleanup")),
    frontend: { name: "frontend" },
    convex: { name: "convex" },
    frontendOutcome: Promise.resolve(),
    convexOutcome: Promise.resolve(),
    terminate: (child) => order.push(`terminate ${child.name}`),
  });
  assert.deepEqual(order, [
    "abort",
    "heat cleanup",
    "terminate frontend",
    "terminate convex",
  ]);
});

test("mock heat launcher uses one stable run anchor and explicit cadence", () => {
  const startAt = "2027-01-01T00:00:00.000Z";
  assert.deepEqual(mockHeatLaunchArguments(startAt, 0), [
    "--seed",
    "packscout-demo",
    "--start-at",
    startAt,
    "--frame",
    "0",
    "--frame-step-ms",
    "300000",
    "--tick-ms",
    "5000",
  ]);
  assert.deepEqual(mockHeatLaunchArguments(startAt, 1, true).slice(0, 3), [
    "--loop",
    "--seed",
    "packscout-demo",
  ]);
});
