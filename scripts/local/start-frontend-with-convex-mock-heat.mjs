#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseSimulationArguments,
  simulateLocalMockHeat,
} from "./simulate-convex-repack-heat.mjs";
import {
  readLocalConvexConfiguration,
  seedLocalMockDataRelease,
} from "./seed-convex-mock-data-release.mjs";
import { waitForLoopbackService } from "./start-frontend-with-convex-mock.mjs";
import {
  processIsRunning,
  spawnLocalProcessGroup,
  terminateLocalProcessGroup,
} from "./process-group.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function childOutcome(child, name) {
  return new Promise((resolve) => {
    if (!processIsRunning(child)) {
      resolve({ name, code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("error", (error) => resolve({ name, error }));
    child.once("exit", (code, signal) => resolve({ name, code, signal }));
  });
}

export function convexDevWithHeatArguments() {
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
  ];
}

export function mockHeatLaunchArguments(startAt, frameIndex, loop = false) {
  return [
    ...(loop ? ["--loop"] : []),
    "--seed",
    "packscout-demo",
    "--start-at",
    startAt,
    "--frame",
    String(frameIndex),
    "--frame-step-ms",
    "300000",
    "--tick-ms",
    "5000",
  ];
}

export function mockHeatSessionEnvironment(childEnvironment, publicUrl) {
  return {
    ...childEnvironment,
    ...(childEnvironment.CONVEX_DEPLOYMENT?.startsWith("anonymous:")
      ? { CONVEX_AGENT_MODE: "anonymous" }
      : {}),
    NEXT_PUBLIC_CONVEX_URL: publicUrl,
  };
}

export function installMockHeatShutdownHandlers(
  abortController,
  onSignal,
  processTarget = process,
) {
  let requestedSignal = null;
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      if (requestedSignal !== null) return;
      requestedSignal = signal;
      abortController.abort();
      onSignal(signal);
    };
    handlers.set(signal, handler);
    processTarget.on(signal, handler);
  }
  return {
    get requestedSignal() {
      return requestedSignal;
    },
    dispose() {
      for (const [signal, handler] of handlers) {
        processTarget.off(signal, handler);
      }
    },
  };
}

export async function shutdownMockHeatSession({
  abortController,
  simulation,
  frontend,
  convex,
  frontendOutcome,
  convexOutcome,
  signal = "SIGTERM",
  terminate = terminateLocalProcessGroup,
}) {
  abortController.abort();
  if (simulation !== null) await simulation;
  await Promise.all([
    terminate(frontend, frontendOutcome, { signal }),
    terminate(convex, convexOutcome, { signal }),
  ]);
}

function outcomeError(outcome) {
  if (outcome.error instanceof Error) return outcome.error;
  if (outcome.signal !== null) {
    return new Error(`${outcome.name} exited unexpectedly with ${outcome.signal}.`);
  }
  return outcome.code === 0
    ? null
    : new Error(
        `${outcome.name} exited with code ${outcome.code ?? "unknown"}.`,
      );
}

export async function startFrontendWithConvexMockHeat() {
  const simulatorAbort = new AbortController();
  let resolveSignal;
  const signalOutcome = new Promise((resolve) => {
    resolveSignal = resolve;
  });
  // npm can forward the terminal signal after Node receives it directly.
  // Keep every shutdown signal handled until fail-closed cleanup completes.
  const shutdownSignals = installMockHeatShutdownHandlers(
    simulatorAbort,
    (signal) => resolveSignal({ name: "signal", signal }),
  );

  let convex = null;
  let convexOutcome = null;
  let frontend = null;
  let frontendOutcome = null;
  let simulation = null;
  try {
    try {
      await seedLocalMockDataRelease();
    } catch (error) {
      if (shutdownSignals.requestedSignal === null) throw error;
      return;
    }
    if (shutdownSignals.requestedSignal !== null) return;
    const { childEnvironment, publicUrl } = await readLocalConvexConfiguration();
    if (shutdownSignals.requestedSignal !== null) return;
    const sessionEnvironment = mockHeatSessionEnvironment(
      childEnvironment,
      publicUrl,
    );
    convex = spawnLocalProcessGroup("npx", convexDevWithHeatArguments(), {
      cwd: repositoryRoot,
      env: sessionEnvironment,
      stdio: "inherit",
    });
    convexOutcome = childOutcome(convex, "Convex");
    const readiness = await Promise.race([
      waitForLoopbackService(publicUrl, {
        processIsRunning: () => processIsRunning(convex),
      }).then(() => ({ name: "ready" })),
      signalOutcome,
      convexOutcome,
    ]);
    if (readiness.name !== "ready") {
      if (readiness.name !== "signal") {
        const error = outcomeError(readiness);
        if (error !== null) throw error;
      }
      return;
    }
    const startAt = new Date().toISOString();
    let resolveFirstFrame;
    const firstFrame = new Promise((resolve) => {
      resolveFirstFrame = resolve;
    });
    simulation = simulateLocalMockHeat(
      parseSimulationArguments(mockHeatLaunchArguments(startAt, 0, true)),
      {
        abortController: simulatorAbort,
        seedCatalog: async () => {},
        onFrame: ({ frame }) => resolveFirstFrame({ name: "frame", frame }),
      },
    ).then(
      () => ({ name: "Heat simulator", code: 0, signal: null }),
      (error) => ({ name: "Heat simulator", error }),
    );
    const heatReadiness = await Promise.race([
      firstFrame,
      signalOutcome,
      convexOutcome,
      simulation,
    ]);
    if (heatReadiness.name !== "frame") {
      if (heatReadiness.name !== "signal") {
        const error = outcomeError(heatReadiness);
        if (error !== null) throw error;
      }
      return;
    }
    if (shutdownSignals.requestedSignal !== null) return;

    frontend = spawnLocalProcessGroup("npm", ["run", "dev:frontend"], {
      cwd: repositoryRoot,
      env: sessionEnvironment,
      stdio: "inherit",
    });
    frontendOutcome = childOutcome(frontend, "Frontend");

    const outcome = await Promise.race([
      signalOutcome,
      convexOutcome,
      frontendOutcome,
      simulation,
    ]);
    if (outcome.name !== "signal") {
      const error = outcomeError(outcome);
      if (error !== null) throw error;
    }
  } finally {
    await shutdownMockHeatSession({
      abortController: simulatorAbort,
      simulation,
      frontend,
      convex,
      frontendOutcome,
      convexOutcome,
      signal: shutdownSignals.requestedSignal ?? "SIGTERM",
    });
    shutdownSignals.dispose();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  startFrontendWithConvexMockHeat().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Local frontend heat session failed.",
    );
    process.exitCode = 1;
  });
}
