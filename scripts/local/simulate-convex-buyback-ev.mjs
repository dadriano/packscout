#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseEnvironmentFile,
  readLocalConvexConfiguration,
} from "./seed-convex-mock-data-release.mjs";
import {
  beginLocalProcessGroupTermination,
  spawnLocalProcessGroup,
} from "./process-group.mjs";

/**
 * Local production-faithful buyback-adjusted EV simulation
 * (task buyback-adjusted-ev/009). Run with:
 *
 *   node --import tsx scripts/local/simulate-convex-buyback-ev.mjs [options]
 *
 * One-shot is the default (a single frame). `--loop` plays a bounded,
 * stoppable, replayable sequence of frames. Every frame is derived from the
 * explicit {seed, scenario version, start time, frame index, frame step}
 * controls, driven through the real normalization, calculation, confidence,
 * revision, recomputation, assembly, and publication path against the local
 * Convex deployment, then read back through the public v3 query.
 *
 * Local safety: the loopback-only Convex configuration is proven first, a
 * temporary local-only publication key (id
 * `local-buyback-ev-simulation.v1`) is installed for the run, and it is
 * removed again on success, failure, and interruption. Foreign publication
 * keys are never overwritten. The default start time anchors every frame
 * clock in the past, so simulated event time never runs ahead of the wall
 * clock.
 */

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const SIMULATION_KEY_ID = "local-buyback-ev-simulation.v1";
export const PUBLISHING_KEYS_ENV = "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS";
export const PUBLICATION_KEY_IDS_ENV =
  "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS";

const DEFAULT_SEED = "packscout-buyback-ev-demo";
const DEFAULT_FRAME_STEP_MILLISECONDS = 30 * 60 * 1_000;
const DEFAULT_TICK_MILLISECONDS = 5_000;
const DEFAULT_LOOP_FRAMES = 12;
const MAX_LOOP_FRAMES = 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
    frameStepMilliseconds: DEFAULT_FRAME_STEP_MILLISECONDS,
    tickMilliseconds: DEFAULT_TICK_MILLISECONDS,
    loop: false,
    maxFrames: null,
    expectedActive: null,
    publicationUrl: null,
    skipReadBack: false,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--loop" || flag === "--skip-read-back") {
      if (seen.has(flag)) throw new Error(`${flag} may be provided only once.`);
      seen.add(flag);
      if (flag === "--loop") values.loop = true;
      else values.skipReadBack = true;
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
      "--max-frames": (value) => {
        values.maxFrames = parseInteger(value, flag);
      },
      "--expected-active": (value) => {
        values.expectedActive = value;
      },
      "--publication-url": (value) => {
        values.publicationUrl = value;
      },
    };
    const setter = setters[flag];
    if (setter === undefined) {
      throw new Error(`Unknown simulation option: ${flag}`);
    }
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
    values.tickMilliseconds < 1_000 ||
    values.tickMilliseconds > 60_000
  ) {
    throw new Error("--tick-ms must be between 1000 and 60000.");
  }
  if (values.maxFrames !== null && !values.loop) {
    throw new Error("--max-frames requires --loop; one-shot plays one frame.");
  }
  if (
    values.maxFrames !== null &&
    (values.maxFrames < 1 || values.maxFrames > MAX_LOOP_FRAMES)
  ) {
    throw new Error(`--max-frames must be between 1 and ${MAX_LOOP_FRAMES}.`);
  }
  if (values.expectedActive !== null && !UUID_PATTERN.test(values.expectedActive)) {
    throw new Error("--expected-active must be a canonical lowercase UUID.");
  }
  return Object.freeze(values);
}

/**
 * Resolves the deterministic run controls. The default start time is
 * anchored in the past so every frame's virtual calculation clock stays at
 * or before the wall clock; publication cadence is decoupled from the frame
 * step, so loop playback can tick quickly through a past window.
 */
export function resolveSimulationControls(options, now = () => new Date()) {
  const frameCount = options.loop ? options.maxFrames ?? DEFAULT_LOOP_FRAMES : 1;
  const startAt =
    options.startAt ??
    new Date(
      now().getTime() -
        (options.frameIndex + frameCount) * options.frameStepMilliseconds,
    ).toISOString();
  return Object.freeze({
    seed: options.seed,
    startAt,
    frameIndex: options.frameIndex,
    frameStepMilliseconds: options.frameStepMilliseconds,
    frameCount,
    tickMilliseconds: options.tickMilliseconds,
    loop: options.loop,
    expectedActive: options.expectedActive,
    publicationUrl: options.publicationUrl,
    skipReadBack: options.skipReadBack,
  });
}

/**
 * The temporary enablement may replace only its own documented leftover key
 * set; any other configured publication key belongs to another process and
 * is never overwritten.
 */
export function assertPublicationKeysAvailable(environment) {
  const keys = environment[PUBLISHING_KEYS_ENV];
  const keyIds = environment[PUBLICATION_KEY_IDS_ENV];
  if (keys === undefined && keyIds === undefined) return;
  let parsedIds = null;
  let parsedKeys = null;
  try {
    parsedIds = keyIds === undefined ? null : JSON.parse(keyIds);
    parsedKeys = keys === undefined ? null : JSON.parse(keys);
  } catch {
    parsedIds = null;
    parsedKeys = null;
  }
  const idsAreOurs =
    Array.isArray(parsedIds) &&
    parsedIds.length === 1 &&
    parsedIds[0] === SIMULATION_KEY_ID;
  const keysAreOurs =
    parsedKeys !== null &&
    typeof parsedKeys === "object" &&
    !Array.isArray(parsedKeys) &&
    Object.keys(parsedKeys).length === 1 &&
    Object.keys(parsedKeys)[0] === SIMULATION_KEY_ID;
  if (!idsAreOurs || !keysAreOurs) {
    throw new Error(
      "Refusing to overwrite foreign data-release publication keys; remove them from the local Convex env first.",
    );
  }
}

/** Derives the loopback HTTP-actions origin from the local Convex URL. */
export function derivePublicationUrl(configuration) {
  const configured =
    configuration.childEnvironment?.PACKSCOUT_CONVEX_PUBLICATION_BASE_URL?.trim();
  if (configured) return configured;
  const parsed = new URL(configuration.publicUrl);
  const port = Number.parseInt(parsed.port || "3210", 10);
  return `${parsed.protocol}//${parsed.hostname}:${port + 1}`;
}

/** Verifies one public v3 read-back against the published frame bytes. */
export function verifyPublicReadBackResult(result, output) {
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error("Convex returned a non-JSON public read-back result.");
  }
  if (parsed?.ok !== true || typeof parsed.data !== "object") {
    throw new Error("Convex refused the public v3 read-back.");
  }
  const detail = result.publicDetails[0];
  const view = parsed.data;
  if (
    view.publicRepackId !== detail.publicRepackId ||
    JSON.stringify(view.evEstimates) !== JSON.stringify(detail.evEstimates)
  ) {
    throw new Error(
      "The public read-back diverged from the published simulated release.",
    );
  }
  if (view.heat?.status !== "unavailable") {
    throw new Error(
      "Simulated v3 reads must present Heat as explicitly unavailable.",
    );
  }
  return true;
}

async function loadSimulationModules() {
  const contracts = await import(
    "../../packages/services/src/buyback-adjusted-ev-simulation-contracts.ts"
  );
  const runner = await import(
    "../../packages/services/src/buyback-adjusted-ev-simulation-runner.ts"
  );
  return { contracts, runner };
}

async function createSignedPort(input) {
  const client = await import(
    "../../packages/services/src/convex-data-release-v3-publication-client.ts"
  );
  return new client.SignedConvexDataReleaseV3PublicationClient({
    baseUrl: input.baseUrl,
    keyId: input.keyId,
    secret: input.secret,
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

export async function simulateLocalBuybackEv(options, dependencies = {}) {
  const abortController = dependencies.abortController ?? new AbortController();
  const signal = abortController.signal;
  const readConfiguration =
    dependencies.readConfiguration ?? readLocalConvexConfiguration;
  const loadModules = dependencies.loadModules ?? loadSimulationModules;
  const createPort = dependencies.createPort ?? createSignedPort;
  const waitForNextFrame = dependencies.wait ?? wait;
  const log = dependencies.log ?? console.log;
  const clock = dependencies.now ?? (() => new Date());
  const randomSecret = dependencies.randomSecret ?? (() => randomBytes(32));
  const resolved = resolveSimulationControls(options, clock);

  const configuration = await readConfiguration();
  const modules = await loadModules();
  const { contracts, runner } = modules;
  const baseUrl = contracts.assertPackScoutBuybackEvSimulationLoopbackUrlV1(
    resolved.publicationUrl ?? derivePublicationUrl(configuration),
  );
  const controls = {
    seed: resolved.seed,
    scenarioVersion: contracts.PACKSCOUT_BUYBACK_EV_SIMULATION_SCENARIO_VERSION,
    startAt: resolved.startAt,
    frameStepMilliseconds: resolved.frameStepMilliseconds,
  };
  contracts.validatePackScoutBuybackEvSimulationControlsV1(controls);
  const lastFrameClock = contracts.packScoutBuybackEvSimulationFrameClockV1(
    controls,
    resolved.frameIndex + resolved.frameCount - 1,
  );
  contracts.assertPackScoutBuybackEvSimulationEventTimeV1(
    lastFrameClock,
    clock().toISOString(),
  );

  const runNpx =
    dependencies.runNpx ??
    ((args, runOptions = {}) =>
      run("npx", convexArguments(...args), {
        environment: configuration.childEnvironment,
        capture: runOptions.capture ?? false,
        signal: runOptions.signal,
      }));

  const environmentListing = await runNpx(["env", "list"], { capture: true });
  assertPublicationKeysAvailable(parseEnvironmentFile(environmentListing));

  const secret = randomSecret();
  await runNpx(["env", "set", "PACKSCOUT_RUNTIME_ENVIRONMENT", "local"]);
  await runNpx([
    "env",
    "set",
    PUBLISHING_KEYS_ENV,
    JSON.stringify({
      [SIMULATION_KEY_ID]: Buffer.from(secret).toString("base64"),
    }),
  ]);
  let cleanupState = "pending";
  try {
    await runNpx([
      "env",
      "set",
      PUBLICATION_KEY_IDS_ENV,
      JSON.stringify([SIMULATION_KEY_ID]),
    ]);
    const port = await createPort({
      baseUrl,
      keyId: SIMULATION_KEY_ID,
      secret,
    });
    const session = await runner.openPackScoutBuybackEvSimulationSessionV1({
      port,
      controls,
      publicationOrigin: baseUrl,
      allowedActiveReleaseIds:
        resolved.expectedActive === null ? [] : [resolved.expectedActive],
      wallClock: clock,
    });
    let lastResult = null;
    try {
      log(
        `Buyback EV simulation run=${session.simulationRunId} seed=${resolved.seed} ` +
          `scenarioVersion=${controls.scenarioVersion} startAt=${resolved.startAt} ` +
          `frames=${resolved.frameIndex}..${resolved.frameIndex + resolved.frameCount - 1} ` +
          `frameStepMs=${resolved.frameStepMilliseconds}.`,
      );
      log(
        `Reproduce with: --seed ${resolved.seed} --start-at ${resolved.startAt} ` +
          `--frame ${resolved.frameIndex} --frame-step-ms ${resolved.frameStepMilliseconds}` +
          `${resolved.loop ? ` --loop --max-frames ${resolved.frameCount}` : ""}.`,
      );
      for (
        let frameIndex = resolved.frameIndex;
        frameIndex < resolved.frameIndex + resolved.frameCount;
        frameIndex += 1
      ) {
        if (signal.aborted) break;
        if (frameIndex > resolved.frameIndex) {
          await waitForNextFrame(resolved.tickMilliseconds, signal);
          if (signal.aborted) break;
        }
        const result = await session.simulator.runFrame(frameIndex);
        lastResult = result;
        if (!resolved.skipReadBack) {
          const detail = result.publicDetails[0];
          const output = await runNpx(
            [
              "run",
              "publicRepacksV3:getPublicRepackV3",
              JSON.stringify({
                publicRepackId: detail.publicRepackId,
                publicReleaseId: result.publicReleaseId,
                currentTime: Date.parse(result.readAt),
              }),
              "--typecheck",
              "enable",
            ],
            { capture: true, signal },
          );
          verifyPublicReadBackResult(result, output);
        }
        log(
          `Simulated EV frame ${frameIndex} ${result.publishOutcome}; ` +
            `readAt=${result.readAt} release=${result.publicReleaseId} ` +
            `fingerprint=${result.releaseFingerprint}.`,
        );
        await dependencies.onFrame?.(result);
      }
      return lastResult;
    } finally {
      session.close();
    }
  } finally {
    let removalError = null;
    try {
      await runNpx(["env", "remove", PUBLICATION_KEY_IDS_ENV]);
      await runNpx(["env", "remove", PUBLISHING_KEYS_ENV]);
      cleanupState = "complete";
    } catch (error) {
      cleanupState = "failed";
      removalError = error;
    }
    log(`Buyback EV simulation cleanup ${cleanupState}.`);
    if (removalError !== null) {
      throw new Error(
        "The simulation finished, but the temporary publication keys could not be removed.",
        { cause: removalError },
      );
    }
  }
}

async function main() {
  const options = parseSimulationArguments(process.argv.slice(2));
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await simulateLocalBuybackEv(options, { abortController });
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
      error instanceof Error
        ? error.message
        : "Local buyback EV simulation failed.",
    );
    process.exitCode = 1;
  });
}
