#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Prisma } from "@prisma/client";
import {
  createPrismaClientLifecycle,
  type PackscoutPrismaClient,
} from "@packscout/database";
import { runCollectorCryptLiveBootstrap } from "./bootstrap-collector-crypt-live.ts";
import {
  spawnLocalProcessGroup,
  terminateLocalProcessGroup,
} from "./process-group.mjs";
import { PROVIDER_IMPORT_MAXIMUM_PAGE_STORAGE_BYTES } from "@packscout/services";

const gibibyte = 1024n * 1024n * 1024n;
const defaultMinimumFreeBytes = 20n * gibibyte;
const defaultDeadlineMilliseconds = 15 * 60_000;
const defaultPageBudget = 25;
const defaultPollMilliseconds = 1_000;

type ImportRunState =
  "queued" | "running" | "succeeded" | "incomplete" | "failed";

export type CollectorCryptBatchErrorCode =
  | "ARGUMENTS_INVALID"
  | "BATCH_CONFIGURATION_INVALID"
  | "BATCH_CANCELLED"
  | "BATCH_DEADLINE_REACHED"
  | "DATABASE_STATE_INVALID"
  | "DISK_RESERVE_REACHED"
  | "ONE_SHOT_WORKER_FAILED";

export class CollectorCryptBatchError extends Error {
  constructor(readonly code: CollectorCryptBatchErrorCode) {
    super("Collector Crypt batch import could not continue safely.");
    this.name = "CollectorCryptBatchError";
  }
}

export interface CollectorCryptBatchConfiguration {
  readonly deadlineMilliseconds: number;
  readonly minimumFreeBytes: bigint;
  readonly pageBudget: number;
  readonly pollMilliseconds: number;
}

export interface CollectorCryptBatchCounters {
  readonly pages: number;
  readonly records: number;
  readonly accepted: number;
  readonly duplicate: number;
  readonly quarantined: number;
  readonly requestAttempts: number;
  readonly transientRetries: number;
}

export interface CollectorCryptBatchRunSnapshot {
  readonly state: ImportRunState;
  readonly reachedProviderHead: boolean;
  readonly finishedAt: Date | null;
  readonly leaseExpiresAt: Date | null;
  readonly counters: CollectorCryptBatchCounters;
}

export interface CollectorCryptBatchRuntime {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
  requestImport(): Promise<{
    readonly organizationId: string;
    readonly runId: string;
    readonly coalesced: boolean;
  }>;
  readRun(
    organizationId: string,
    runId: string,
  ): Promise<CollectorCryptBatchRunSnapshot | null>;
  freeDiskBytes(): Promise<bigint>;
  executeOneShot(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly pageBudget: number;
    readonly minimumFreeBytes: bigint;
    readonly timeoutMilliseconds: number;
    readonly signal: AbortSignal;
  }): Promise<number>;
  close(): Promise<void>;
}

export interface CollectorCryptBatchSummary {
  readonly outcome: "yielded" | "succeeded" | "incomplete" | "failed";
  readonly reachedProviderHead: boolean;
  readonly coalesced: boolean;
  readonly total: CollectorCryptBatchCounters;
  readonly batch: CollectorCryptBatchCounters;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(resolved)) {
    throw new CollectorCryptBatchError("BATCH_CONFIGURATION_INVALID");
  }
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CollectorCryptBatchError("BATCH_CONFIGURATION_INVALID");
  }
  return parsed;
}

export function readCollectorCryptBatchConfiguration(
  environment: NodeJS.ProcessEnv,
  argumentsList: readonly string[],
): CollectorCryptBatchConfiguration {
  if (argumentsList.length !== 0) {
    throw new CollectorCryptBatchError("ARGUMENTS_INVALID");
  }
  const minimumFreeGibibytes = boundedInteger(
    environment.PACKSCOUT_COLLECTOR_CRYPT_BATCH_MIN_FREE_GIB,
    Number(defaultMinimumFreeBytes / gibibyte),
    5,
    1_024,
  );
  return Object.freeze({
    pageBudget: boundedInteger(
      environment.PACKSCOUT_COLLECTOR_CRYPT_BATCH_PAGES,
      defaultPageBudget,
      1,
      5_000,
    ),
    deadlineMilliseconds:
      boundedInteger(
        environment.PACKSCOUT_COLLECTOR_CRYPT_BATCH_DEADLINE_SECONDS,
        defaultDeadlineMilliseconds / 1_000,
        30,
        3_600,
      ) * 1_000,
    pollMilliseconds: boundedInteger(
      environment.PACKSCOUT_COLLECTOR_CRYPT_BATCH_POLL_MS,
      defaultPollMilliseconds,
      100,
      5_000,
    ),
    minimumFreeBytes: BigInt(minimumFreeGibibytes) * gibibyte,
  });
}

function zeroCounters(): CollectorCryptBatchCounters {
  return {
    pages: 0,
    records: 0,
    accepted: 0,
    duplicate: 0,
    quarantined: 0,
    requestAttempts: 0,
    transientRetries: 0,
  };
}

function counterDelta(
  after: CollectorCryptBatchCounters,
  before: CollectorCryptBatchCounters,
): CollectorCryptBatchCounters {
  const difference = (key: keyof CollectorCryptBatchCounters) =>
    Math.max(0, after[key] - before[key]);
  return {
    pages: difference("pages"),
    records: difference("records"),
    accepted: difference("accepted"),
    duplicate: difference("duplicate"),
    quarantined: difference("quarantined"),
    requestAttempts: difference("requestAttempts"),
    transientRetries: difference("transientRetries"),
  };
}

function summaryFor(
  snapshot: CollectorCryptBatchRunSnapshot,
  before: CollectorCryptBatchCounters,
  coalesced: boolean,
): CollectorCryptBatchSummary {
  if (snapshot.state === "running") {
    throw new CollectorCryptBatchError("DATABASE_STATE_INVALID");
  }
  return Object.freeze({
    outcome: snapshot.state === "queued" ? "yielded" : snapshot.state,
    reachedProviderHead: snapshot.reachedProviderHead,
    coalesced,
    total: snapshot.counters,
    batch: counterDelta(snapshot.counters, before),
  });
}

function remainingMilliseconds(deadline: number, now: Date): number {
  const remaining = deadline - now.getTime();
  if (remaining <= 0) {
    throw new CollectorCryptBatchError("BATCH_DEADLINE_REACHED");
  }
  return remaining;
}

export async function executeCollectorCryptBatch(
  configuration: CollectorCryptBatchConfiguration,
  runtime: CollectorCryptBatchRuntime,
  signal: AbortSignal = new AbortController().signal,
): Promise<CollectorCryptBatchSummary> {
  if (signal.aborted) throw new CollectorCryptBatchError("BATCH_CANCELLED");
  const deadline = runtime.now().getTime() + configuration.deadlineMilliseconds;
  const requested = await runtime.requestImport();
  const initial = await runtime.readRun(
    requested.organizationId,
    requested.runId,
  );
  if (!initial) throw new CollectorCryptBatchError("DATABASE_STATE_INVALID");
  const before = initial.counters ?? zeroCounters();
  let workerStarted = false;

  while (true) {
    if (signal.aborted) throw new CollectorCryptBatchError("BATCH_CANCELLED");
    const snapshot = await runtime.readRun(
      requested.organizationId,
      requested.runId,
    );
    if (!snapshot) throw new CollectorCryptBatchError("DATABASE_STATE_INVALID");
    if (["succeeded", "incomplete", "failed"].includes(snapshot.state)) {
      return summaryFor(snapshot, before, requested.coalesced);
    }
    const claimableAfterCrash =
      snapshot.state === "running" &&
      snapshot.leaseExpiresAt !== null &&
      snapshot.leaseExpiresAt.getTime() <= runtime.now().getTime();
    if (snapshot.state === "queued" || claimableAfterCrash) {
      if (workerStarted)
        return summaryFor(snapshot, before, requested.coalesced);
      const requiredFreeBytes =
        configuration.minimumFreeBytes +
        BigInt(PROVIDER_IMPORT_MAXIMUM_PAGE_STORAGE_BYTES);
      if ((await runtime.freeDiskBytes()) < requiredFreeBytes) {
        throw new CollectorCryptBatchError("DISK_RESERVE_REACHED");
      }
      const timeoutMilliseconds = remainingMilliseconds(
        deadline,
        runtime.now(),
      );
      workerStarted = true;
      const exitCode = await runtime.executeOneShot({
        organizationId: requested.organizationId,
        runId: requested.runId,
        pageBudget: configuration.pageBudget,
        minimumFreeBytes: configuration.minimumFreeBytes,
        timeoutMilliseconds,
        signal,
      });
      if (signal.aborted) throw new CollectorCryptBatchError("BATCH_CANCELLED");
      if (exitCode !== 0) {
        throw new CollectorCryptBatchError("ONE_SHOT_WORKER_FAILED");
      }
      continue;
    }
    if (snapshot.leaseExpiresAt === null) {
      throw new CollectorCryptBatchError("DATABASE_STATE_INVALID");
    }
    const remaining = remainingMilliseconds(deadline, runtime.now());
    await runtime.sleep(Math.min(configuration.pollMilliseconds, remaining));
  }
}

export function collectorCryptBatchSummaryJson(
  summary: CollectorCryptBatchSummary,
): string {
  return JSON.stringify(summary);
}

function normalizedCounters(
  value: Prisma.JsonValue,
): CollectorCryptBatchCounters {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? value
      : {};
  const count = (key: keyof CollectorCryptBatchCounters): number => {
    const candidate = record[key];
    return typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0
      ? candidate
      : 0;
  };
  return {
    pages: count("pages"),
    records: count("records"),
    accepted: count("accepted"),
    duplicate: count("duplicate"),
    quarantined: count("quarantined"),
    requestAttempts: count("requestAttempts"),
    transientRetries: count("transientRetries"),
  };
}

function requiredChildEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = environment[key];
  if (!value || value.length > 4_096 || /[\r\n]/.test(value)) {
    throw new CollectorCryptBatchError("BATCH_CONFIGURATION_INVALID");
  }
  return value;
}

export function collectorCryptOneShotEnvironment(
  environment: NodeJS.ProcessEnv,
  input: Parameters<CollectorCryptBatchRuntime["executeOneShot"]>[0],
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {
    NODE_ENV: "development",
    PACKSCOUT_DATABASE_URL: requiredChildEnvironmentValue(
      environment,
      "PACKSCOUT_DATABASE_URL",
    ),
    PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: requiredChildEnvironmentValue(
      environment,
      "PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64",
    ),
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: requiredChildEnvironmentValue(
      environment,
      "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
    ),
    PACKSCOUT_WORKER_MODE: "one-shot",
    PACKSCOUT_WORKER_ONE_SHOT_ORGANIZATION_ID: input.organizationId,
    PACKSCOUT_WORKER_ONE_SHOT_RUN_ID: input.runId,
    PACKSCOUT_WORKER_IMPORT_PAGE_BUDGET: String(input.pageBudget),
    PACKSCOUT_WORKER_IMPORT_MIN_FREE_BYTES: String(input.minimumFreeBytes),
    PACKSCOUT_WORKER_IMPORT_MAX_RUN_MS:
      environment.PACKSCOUT_WORKER_IMPORT_MAX_RUN_MS ??
      String(12 * 60 * 60_000),
    PACKSCOUT_WORKER_MAX_CLAIMS_PER_CYCLE: "1",
    PACKSCOUT_WORKER_ID: `collector-crypt-batch:${process.pid}:${randomUUID()}`,
    PACKSCOUT_WORKER_SKIP_DOTENV: "1",
  };
  for (const key of [
    "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION",
    "PACKSCOUT_WORKER_DATABASE_POOL_MAX",
  ]) {
    if (environment[key] !== undefined) {
      childEnvironment[key] = requiredChildEnvironmentValue(environment, key);
    }
  }
  return childEnvironment;
}

export interface CollectorCryptOneShotProcessDependencies {
  readonly spawn: typeof spawnLocalProcessGroup;
  readonly terminate: typeof terminateLocalProcessGroup;
}

const defaultOneShotProcessDependencies: CollectorCryptOneShotProcessDependencies =
  {
    spawn: spawnLocalProcessGroup,
    terminate: terminateLocalProcessGroup,
  };

function forwardedTerminationSignal(signal: AbortSignal): "SIGINT" | "SIGTERM" {
  return signal.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
}

export async function spawnCollectorCryptOneShotWorker(
  environment: NodeJS.ProcessEnv,
  workspaceRoot: string,
  input: Parameters<CollectorCryptBatchRuntime["executeOneShot"]>[0],
  dependencies: CollectorCryptOneShotProcessDependencies = defaultOneShotProcessDependencies,
): Promise<number> {
  const child = dependencies.spawn(
    process.execPath,
    ["--import", "tsx", path.join(workspaceRoot, "apps/worker/src/index.ts")],
    {
      cwd: workspaceRoot,
      env: collectorCryptOneShotEnvironment(environment, input),
      stdio: "ignore",
    },
  );
  const outcome = new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.once("error", () => finish(1));
    child.once("exit", (code) => finish(code ?? 1));
  });
  let resolveInterrupted: ((value: "aborted" | "timeout") => void) | undefined;
  const interrupted = new Promise<"aborted" | "timeout">((resolve) => {
    resolveInterrupted = resolve;
  });
  const onAbort = () => resolveInterrupted?.("aborted");
  if (input.signal.aborted) onAbort();
  else input.signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => resolveInterrupted?.("timeout"),
    input.timeoutMilliseconds,
  );
  const first = await Promise.race([
    outcome.then((code) => ({ kind: "exit" as const, code })),
    interrupted.then((reason) => ({ kind: reason })),
  ]);
  clearTimeout(timeout);
  input.signal.removeEventListener("abort", onAbort);
  if (first.kind === "exit") return first.code;
  await dependencies.terminate(child, outcome, {
    signal:
      first.kind === "aborted"
        ? forwardedTerminationSignal(input.signal)
        : "SIGTERM",
  });
  return 1;
}

async function createProductionRuntime(
  environment: NodeJS.ProcessEnv,
): Promise<CollectorCryptBatchRuntime> {
  const requested = await runCollectorCryptLiveBootstrap(
    ["--request-only"],
    environment,
  );
  const lifecycle = createPrismaClientLifecycle({
    databaseUrl: environment.PACKSCOUT_DATABASE_URL!,
  });
  await lifecycle.start();
  const database: PackscoutPrismaClient = lifecycle.client;
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  return {
    now: () => new Date(),
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    requestImport: async () => ({
      organizationId: requested.organizationId,
      runId: requested.runId,
      coalesced: requested.coalesced,
    }),
    readRun: async (organizationId, runId) => {
      const row = await database.import_runs.findFirst({
        where: { id: runId, organization_id: organizationId },
        select: {
          state: true,
          reached_provider_head: true,
          finished_at: true,
          lease_expires_at: true,
          counters_json: true,
        },
      });
      return row
        ? {
            state: row.state,
            reachedProviderHead: row.reached_provider_head,
            finishedAt: row.finished_at,
            leaseExpiresAt: row.lease_expires_at,
            counters: normalizedCounters(row.counters_json),
          }
        : null;
    },
    freeDiskBytes: async () => {
      const [dataDirectory] = await database.$queryRaw<
        Array<{ path: string }>
      >(Prisma.sql`
        select current_setting('data_directory') as path
      `);
      if (!dataDirectory?.path) {
        throw new CollectorCryptBatchError("DATABASE_STATE_INVALID");
      }
      const fileSystem = await statfs(dataDirectory.path, { bigint: true });
      return fileSystem.bavail * fileSystem.bsize;
    },
    executeOneShot: (input) =>
      spawnCollectorCryptOneShotWorker(environment, workspaceRoot, input),
    close: () => lifecycle.close(),
  };
}

export async function runCollectorCryptBatchCommand(
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CollectorCryptBatchSummary> {
  const configuration = readCollectorCryptBatchConfiguration(
    environment,
    argumentsList,
  );
  const controller = new AbortController();
  const onSigint = () => controller.abort("SIGINT");
  const onSigterm = () => controller.abort("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  let runtime: CollectorCryptBatchRuntime | null = null;
  try {
    runtime = await createProductionRuntime(environment);
    return await executeCollectorCryptBatch(
      configuration,
      runtime,
      controller.signal,
    );
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await runtime?.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCollectorCryptBatchCommand(process.argv.slice(2))
    .then((summary) => {
      process.stdout.write(`${collectorCryptBatchSummaryJson(summary)}\n`);
      if (summary.outcome === "failed") process.exitCode = 1;
    })
    .catch(() => {
      process.stderr.write("Collector Crypt live batch failed.\n");
      process.exitCode = 1;
    });
}
