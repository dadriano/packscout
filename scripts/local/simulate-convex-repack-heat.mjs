#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readLocalConvexConfiguration,
  seedLocalMockDataRelease,
} from "./seed-convex-mock-data-release.mjs";
import {
  beginLocalProcessGroupTermination,
  spawnLocalProcessGroup,
} from "./process-group.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DEFAULT_SEED = "packscout-demo";
const MOCK_HEAT_DEFAULT_FRAME_STEP_MILLISECONDS = 5 * 60 * 1_000;
const DEFAULT_TICK_MILLISECONDS = 5_000;

async function buildMockHeatFrame(controls) {
  const fixture = await import("../../convex/mockHeatSimulationFixture.ts");
  return fixture.buildMockHeatFrame(controls);
}

function validateControls(input) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.seed)) {
    throw new Error("Simulation seed is invalid.");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
      input.startAt,
    ) ||
    new Date(Date.parse(input.startAt)).toISOString() !== input.startAt
  ) {
    throw new Error("Simulation startAt must be a canonical UTC timestamp.");
  }
  if (
    !Number.isSafeInteger(input.frameIndex) ||
    input.frameIndex < 0 ||
    input.frameIndex > 100_000
  ) {
    throw new Error("Simulation frame index is invalid.");
  }
  if (
    !Number.isSafeInteger(input.frameStepMilliseconds) ||
    input.frameStepMilliseconds < 60_000 ||
    input.frameStepMilliseconds > 3_600_000
  ) {
    throw new Error("Simulation frame step is invalid.");
  }
  if (
    !Number.isSafeInteger(input.publicationCadenceMilliseconds) ||
    input.publicationCadenceMilliseconds < 1_000 ||
    input.publicationCadenceMilliseconds > 60_000
  ) {
    throw new Error("Simulation publication cadence is invalid.");
  }
  return Object.freeze({ ...input });
}

function parseInteger(value, flag) {
  if (!/^(?:0|[1-9]\d*)$/u.test(value ?? "")) {
    throw new Error(`${flag} requires a nonnegative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} is outside the safe integer range.`);
  }
  return parsed;
}

export function parseSimulationArguments(args) {
  const values = {
    seed: DEFAULT_SEED,
    startAt: null,
    frameIndex: 0,
    frameStepMilliseconds: MOCK_HEAT_DEFAULT_FRAME_STEP_MILLISECONDS,
    tickMilliseconds: DEFAULT_TICK_MILLISECONDS,
    loop: false,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--loop") {
      if (seen.has(flag)) throw new Error(`${flag} may be provided only once.`);
      seen.add(flag);
      values.loop = true;
      continue;
    }
    const setters = {
      "--seed": (value) => {
        values.seed = value;
      },
      "--start-at": (value) => {
        values.startAt = value;
      },
      "--frame": (value) => {
        values.frameIndex = parseInteger(value, flag);
      },
      "--frame-step-ms": (value) => {
        values.frameStepMilliseconds = parseInteger(value, flag);
      },
      "--tick-ms": (value) => {
        values.tickMilliseconds = parseInteger(value, flag);
      },
    };
    const setter = setters[flag];
    if (setter === undefined) throw new Error(`Unknown simulation option: ${flag}`);
    if (seen.has(flag)) throw new Error(`${flag} may be provided only once.`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.`);
    }
    seen.add(flag);
    setter(value);
    index += 1;
  }
  if (
    !Number.isSafeInteger(values.tickMilliseconds) ||
    values.tickMilliseconds < 1_000 ||
    values.tickMilliseconds > 60_000
  ) {
    throw new Error("--tick-ms must be between 1000 and 60000.");
  }
  return Object.freeze(values);
}

export function resolveSimulationControls(options, now = () => new Date()) {
  const startAt = options.startAt ?? now().toISOString();
  return validateControls({
    seed: options.seed,
    startAt,
    frameIndex: options.frameIndex,
    frameStepMilliseconds: options.frameStepMilliseconds,
    publicationCadenceMilliseconds: options.tickMilliseconds,
  });
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawnLocalProcessGroup(command, args, {
      cwd: repositoryRoot,
      env: options.environment,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (options.capture) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    let cancelEscalation = null;
    const abort = () => {
      cancelEscalation ??= beginLocalProcessGroupTermination(child);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once("error", (error) => {
      cancelEscalation?.();
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cancelEscalation?.();
      options.signal?.removeEventListener("abort", abort);
      if (code === 0) resolve(stdout);
      else {
        reject(
          new Error(
            `${command} exited ${signal ? `with ${signal}` : `with code ${code ?? "unknown"}`}.`,
          ),
        );
      }
    });
  });
}

function wait(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let timeout;
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function convexArguments(...args) {
  return ["--no-install", "convex", ...args];
}

function parsePublishResult(output, frame) {
  let result;
  try {
    result = JSON.parse(output.trim());
  } catch {
    throw new Error("Convex returned a non-JSON mock heat result.");
  }
  if (
    (result.status !== "created" && result.status !== "unchanged") ||
    result.publicHeatSnapshotId !== frame.publicHeatSnapshotId ||
    result.simulationRunId !== frame.simulationRunId ||
    result.sequence !== frame.sequence ||
    result.signalCount !== frame.signals.length
  ) {
    throw new Error("Convex returned an unexpected mock heat result.");
  }
  return result;
}

export async function simulateLocalMockHeat(options, dependencies = {}) {
  const abortController = dependencies.abortController ?? new AbortController();
  const signal = abortController.signal;
  const readConfiguration =
    dependencies.readConfiguration ?? readLocalConvexConfiguration;
  const seedCatalog = dependencies.seedCatalog ?? seedLocalMockDataRelease;
  const buildFrame = dependencies.buildFrame ?? buildMockHeatFrame;
  const waitForNextFrame = dependencies.wait ?? wait;
  const log = dependencies.log ?? console.log;
  const clock = dependencies.now ?? (() => new Date());
  const resolved = resolveSimulationControls(options, clock);
  const { childEnvironment } = await readConfiguration();
  const runNpx =
    dependencies.runNpx ??
    ((args, runOptions = {}) =>
      run("npx", convexArguments(...args), {
        environment: childEnvironment,
        capture: runOptions.capture ?? false,
        signal: runOptions.signal,
      }));

  await seedCatalog();
  await runNpx([
    "env",
    "set",
    "PACKSCOUT_RUNTIME_ENVIRONMENT",
    "local",
  ]);
  await runNpx([
    "env",
    "set",
    "PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED",
    "1",
  ]);
  let flagSet = true;
  let frameIndex = resolved.frameIndex;
  let lastResult = null;
  let lastPublishedFrame = null;
  let announcedRun = false;
  let firstAttempt = true;
  try {
    do {
      if (!firstAttempt) {
        const target =
          Date.parse(resolved.startAt) +
          frameIndex * resolved.publicationCadenceMilliseconds;
        const delay = Math.max(0, target - clock().getTime());
        if (delay > 0) await waitForNextFrame(delay, signal);
        if (signal.aborted) break;
      }
      firstAttempt = false;
      const frame = await buildFrame({ ...resolved, frameIndex });
      if (signal.aborted) break;
      if (!announcedRun) {
        announcedRun = true;
        log(
          `Mock heat run seed=${resolved.seed} startAt=${resolved.startAt} run=${frame.simulationRunId} scenarioStepMs=${resolved.frameStepMilliseconds} publicationCadenceMs=${resolved.publicationCadenceMilliseconds}.`,
        );
      }
      let output;
      try {
        output = await runNpx(
          [
            "run",
            "mockHeatSimulationPublisher:publishFrame",
            JSON.stringify(frame),
            "--typecheck",
            "enable",
          ],
          { capture: true, signal },
        );
      } catch (error) {
        if (signal.aborted) break;
        throw error;
      }
      lastResult = parsePublishResult(output, frame);
      lastPublishedFrame = frame;
      await dependencies.onFrame?.({ frame, result: lastResult });
      log(
        `Mock heat frame ${frameIndex} ${lastResult.status}; ${frame.signals.length} aggregates expire at ${frame.expiresAt}.`,
      );
      if (!options.loop) break;
      frameIndex += 1;
    } while (!signal.aborted);
    return lastResult;
  } finally {
    let expiryError = null;
    try {
      if (options.loop && lastPublishedFrame !== null) {
        try {
          await runNpx(
            [
              "run",
              "mockHeatSimulationPublisher:expireActiveFrame",
              JSON.stringify({
                publicHeatSnapshotId: lastPublishedFrame.publicHeatSnapshotId,
                expectedExpiresAt: lastPublishedFrame.expiresAt,
              }),
              "--typecheck",
              "enable",
            ],
            { capture: true },
          );
        } catch (error) {
          expiryError = error;
        }
      }
    } finally {
      if (flagSet) {
        flagSet = false;
        await runNpx([
          "env",
          "remove",
          "PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED",
        ]);
      }
    }
    if (expiryError !== null) throw expiryError;
  }
}

async function main() {
  const options = parseSimulationArguments(process.argv.slice(2));
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await simulateLocalMockHeat(options, { abortController });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Local heat simulation failed.",
    );
    process.exitCode = 1;
  });
}
