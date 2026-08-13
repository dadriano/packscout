#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readLocalConvexConfiguration,
  seedLocalMockDataRelease,
} from "./seed-convex-mock-data-release.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const STARTUP_TIMEOUT_MILLISECONDS = 45_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForLoopbackService(
  publicUrl,
  {
    fetchImplementation = globalThis.fetch,
    timeoutMilliseconds = STARTUP_TIMEOUT_MILLISECONDS,
    pollMilliseconds = 150,
    processIsRunning = () => true,
    now = Date.now,
    wait = delay,
  } = {},
) {
  const deadline = now() + timeoutMilliseconds;
  while (now() < deadline) {
    if (!processIsRunning()) {
      throw new Error("The local Convex process exited before it became ready.");
    }
    try {
      await fetchImplementation(publicUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(1_000),
      });
      return;
    } catch {
      await wait(pollMilliseconds);
    }
  }
  throw new Error("Timed out waiting for the local Convex backend.");
}

function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function childOutcome(child, name) {
  return new Promise((resolve) => {
    if (!childIsRunning(child)) {
      resolve({ name, code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("error", (error) => resolve({ name, error }));
    child.once("exit", (code, signal) => resolve({ name, code, signal }));
  });
}

function signalChild(child, signal) {
  if (!childIsRunning(child)) return;
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the liveness check and signal.
  }
}

function installShutdownSignalHandlers(child) {
  let resolveSignal;
  const promise = new Promise((resolve) => {
    resolveSignal = resolve;
  });
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      signalChild(child, signal);
      resolveSignal({ name: "signal", signal });
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return {
    promise,
    dispose() {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    },
  };
}

export function convexDevArguments() {
  return [
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
  ];
}

export function unexpectedConvexExitError(outcome) {
  if (outcome.error instanceof Error) return outcome.error;
  if (outcome.signal !== null) {
    return new Error(
      `The local Convex development session exited unexpectedly with ${outcome.signal}.`,
    );
  }
  if (outcome.code !== 0) {
    return new Error(
      `The local Convex development session exited with code ${outcome.code ?? "unknown"}.`,
    );
  }
  return null;
}

export async function startFrontendWithConvexMock() {
  await seedLocalMockDataRelease();
  const { childEnvironment, publicUrl } = await readLocalConvexConfiguration();
  const sessionEnvironment = {
    ...childEnvironment,
    NEXT_PUBLIC_CONVEX_URL: publicUrl,
  };
  const convex = spawn("npx", convexDevArguments(), {
    cwd: repositoryRoot,
    env: sessionEnvironment,
    stdio: "inherit",
    shell: false,
  });
  const convexOutcome = childOutcome(convex, "convex");
  const signals = installShutdownSignalHandlers(convex);

  try {
    const outcome = await Promise.race([
      signals.promise,
      convexOutcome,
    ]);
    if (outcome.name === "signal") {
      await convexOutcome;
      return;
    }
    const exitError = unexpectedConvexExitError(outcome);
    if (exitError !== null) throw exitError;
  } finally {
    signals.dispose();
    signalChild(convex, "SIGTERM");
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  startFrontendWithConvexMock().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Local frontend startup failed.",
    );
    process.exitCode = 1;
  });
}
