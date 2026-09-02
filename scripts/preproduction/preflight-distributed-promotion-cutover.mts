#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createCentralDatabaseLifecycle,
  type CentralDatabaseLifecycle,
} from "@packscout/database";
import {
  createDistributedPromotionCutoverPreflightEvidenceSource,
} from "../../apps/worker/src/distributed-promotion-cutover-preflight-composition.ts";
import {
  DISTRIBUTED_PROMOTION_CUTOVER_PREFLIGHT_SCHEMA,
  DistributedPromotionCutoverPreflightError,
  distributedPromotionEntrypointArtifactDigest,
  readDistributedPromotionCutoverPreflightConfiguration,
  runDistributedPromotionCutoverPreflight,
} from "../../apps/worker/src/distributed-promotion-cutover-preflight.ts";

const SAFE_UNAVAILABLE_CODE =
  "DISTRIBUTED_PROMOTION_CUTOVER_PREFLIGHT_UNAVAILABLE";
const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const WORKER_PACKAGE_PATH = "apps/worker/package.json";
const BUILD_ROOTS = Object.freeze([
  "apps/worker/src",
  "apps/worker/package.json",
  "packages/contracts/src",
  "packages/database/src",
  "packages/database/prisma",
  "packages/services/src",
  "convex",
  "package.json",
  "scripts/preproduction/preflight-distributed-promotion-cutover.mts",
]);

interface WorkerPackage {
  readonly scripts?: Readonly<Record<string, unknown>>;
}

function packageScript(workerPackage: WorkerPackage, name: string): string {
  const value = workerPackage.scripts?.[name];
  if (typeof value !== "string" || value.length < 1 || /[\r\n\0]/u.test(value)) {
    throw new TypeError("Distributed promotion build evidence is invalid.");
  }
  return value;
}

async function artifact(
  name: string,
): Promise<Readonly<{ name: string; content: string }>> {
  return {
    name: `source:${name}`,
    content: await readFile(path.join(workspaceRoot, name), "utf8"),
  };
}

function digest(
  values: readonly Readonly<{ name: string; content: string }>[],
): string {
  return distributedPromotionEntrypointArtifactDigest(
    [...values].sort((left, right) => left.name < right.name ? -1 : 1),
  );
}

async function assertExactCheckout(): Promise<string> {
  const revision = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceRoot,
  });
  const currentCommit = revision.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(currentCommit)) {
    throw new TypeError("Distributed promotion build evidence is invalid.");
  }
  await execFileAsync("git", ["diff", "--quiet", "HEAD", "--", ...BUILD_ROOTS], {
    cwd: workspaceRoot,
  });
  const untracked = await execFileAsync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", ...BUILD_ROOTS],
    { cwd: workspaceRoot },
  );
  if (untracked.stdout.trim().length > 0) {
    throw new TypeError("Distributed promotion build evidence is invalid.");
  }
  return currentCommit;
}

async function buildEvidence() {
  const currentCommit = await assertExactCheckout();
  const workerPackage = JSON.parse(
    await readFile(path.join(workspaceRoot, WORKER_PACKAGE_PATH), "utf8"),
  ) as WorkerPackage;
  const scriptArtifacts = (names: readonly string[]) => names.map((name) => ({
    name: `script:${name}`,
    content: packageScript(workerPackage, name),
  }));
  const [
    providerMain,
    providerScheduleMain,
    manifestMain,
    manifestScheduleMain,
    manifestOperationMain,
    relayMain,
    livenessMain,
    watchdogCli,
    systemConditionSink,
  ] =
    await Promise.all([
      artifact("apps/worker/src/provider-promotion-job-main.ts"),
      artifact("apps/worker/src/provider-promotion-schedule-command-main.ts"),
      artifact("apps/worker/src/manifest-reconciliation-job-main.ts"),
      artifact("apps/worker/src/manifest-promotion-schedule-command-main.ts"),
      artifact("apps/worker/src/manifest-gate-operation-command-main.ts"),
      artifact("apps/worker/src/provider-activity-relay-main.ts"),
      artifact("apps/worker/src/promotion-job-liveness-main.ts"),
      artifact("apps/worker/src/promotion-job-evaluator-watchdog-cli.ts"),
      artifact("apps/worker/src/promotion-job-system-condition-webhook.ts"),
    ]);
  return Object.freeze({
    currentCommit,
    providerEntrypointSetDigest: digest([
      providerMain,
      providerScheduleMain,
      ...scriptArtifacts([
        "start:provider-promotion-job:production",
        "run:provider-promotion-job-once:production",
        "run:provider-promotion-job-manual:production",
        "run:provider-promotion-job-continuation:production",
        "activate:provider-promotion-schedule:production",
        "pause:provider-promotion-schedule:production",
      ]),
    ]),
    manifestEntrypointDigest: digest([
      manifestMain,
      manifestScheduleMain,
      manifestOperationMain,
      ...scriptArtifacts([
        "start:manifest-reconciliation-job:production",
        "run:manifest-reconciliation-job-once:production",
        "run:manifest-reconciliation-job-manual:production",
        "run:manifest-reconciliation-job-continuation:production",
        "activate:manifest-reconciliation-schedule:production",
        "pause:manifest-reconciliation-schedule:production",
        "authorize:manifest-gate-operation:production",
      ]),
    ]),
    relayEntrypointDigest: digest([
      relayMain,
      ...scriptArtifacts([
        "start:provider-activity-relay:production",
        "run:provider-activity-relay-once:production",
      ]),
    ]),
    livenessEntrypointDigest: digest([
      livenessMain,
      ...scriptArtifacts([
        "start:promotion-job-liveness-evaluator:production",
        "run:promotion-job-liveness-evaluator-once:production",
      ]),
    ]),
    watchdogEntrypointDigest: digest([
      watchdogCli,
      ...scriptArtifacts([
        "run:promotion-job-evaluator-watchdog:production",
      ]),
    ]),
    systemConditionSinkDigest: digest([systemConditionSink]),
  });
}

function databaseUrl(environment: NodeJS.ProcessEnv): string {
  const value =
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_PREFLIGHT_DATABASE_URL;
  if (!value || value.length > 4_096 || /[\r\n\0]/u.test(value)) {
    throw new TypeError("Distributed promotion cutover preflight failed.");
  }
  try {
    const parsed = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol)
      || !parsed.hostname || parsed.pathname.length < 2 || parsed.hash
    ) throw new TypeError("invalid");
    return parsed.toString();
  } catch {
    throw new TypeError("Distributed promotion cutover preflight failed.");
  }
}

async function main(): Promise<void> {
  let database: CentralDatabaseLifecycle | undefined;
  try {
    const configuration =
      readDistributedPromotionCutoverPreflightConfiguration(process.env);
    database = createCentralDatabaseLifecycle({
      databaseUrl: databaseUrl(process.env),
      connectionLimit: 1,
    });
    await database.start();
    const result = await runDistributedPromotionCutoverPreflight({
      configuration,
      build: await buildEvidence(),
      evidence: createDistributedPromotionCutoverPreflightEvidenceSource(
        database.client,
      ),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failureCode = error instanceof DistributedPromotionCutoverPreflightError
      ? error.code
      : SAFE_UNAVAILABLE_CODE;
    process.stderr.write(`${JSON.stringify({
      schemaVersion: DISTRIBUTED_PROMOTION_CUTOVER_PREFLIGHT_SCHEMA,
      status: "preflight_failed",
      failureCode,
    })}\n`);
    process.exitCode = 1;
  } finally {
    await database?.close().catch(() => undefined);
  }
}

void main();
