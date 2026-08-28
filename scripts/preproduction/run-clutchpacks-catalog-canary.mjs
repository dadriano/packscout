#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const CLUTCHPACKS_PLATFORM_KEY = "clutchpacks";
const PRODUCTION_TOKEN_PATTERN =
  /(?:^|[./:_-])(?:prod|production|live)(?=$|[./:_-])/iu;
const FAILURE_MESSAGES = Object.freeze({
  CLUTCHPACKS_CANARY_ARGUMENT_INVALID:
    "The ClutchPacks catalog canary arguments are invalid.",
  CLUTCHPACKS_CANARY_CYCLE_LIMIT:
    "The ClutchPacks catalog canary reached its cycle limit.",
  CLUTCHPACKS_CANARY_CONFIRMATION_REQUIRED:
    "The ClutchPacks catalog canary target confirmation is required.",
  CLUTCHPACKS_CANARY_ENVIRONMENT_FORBIDDEN:
    "The ClutchPacks catalog canary is restricted to preproduction.",
  CLUTCHPACKS_CANARY_INTERNAL_FAILURE:
    "The ClutchPacks catalog canary failed safely.",
  CLUTCHPACKS_CANARY_MANIFEST_FAILED:
    "The ClutchPacks manifest reconciliation failed.",
  CLUTCHPACKS_CANARY_PLATFORM_SCOPE_INVALID:
    "The catalog canary is not scoped exclusively to ClutchPacks.",
  CLUTCHPACKS_CANARY_PROVIDER_FAILED:
    "The ClutchPacks provider reconciliation failed.",
  CLUTCHPACKS_CANARY_RELATIONSHIP_REPAIR_INCOMPLETE:
    "The source relationship confirmation repair is incomplete.",
  CLUTCHPACKS_CANARY_STOPPED:
    "The ClutchPacks catalog canary was stopped.",
  CLUTCHPACKS_CANARY_TIMEOUT:
    "The ClutchPacks catalog canary reached its time limit.",
  CLUTCHPACKS_CANARY_WORKERS_NOT_STOPPED:
    "All shared preproduction workers must be stopped before the canary.",
});

export class ClutchpacksCatalogCanaryError extends Error {
  constructor(code, options) {
    const safeCode = FAILURE_MESSAGES[code]
      ? code
      : "CLUTCHPACKS_CANARY_INTERNAL_FAILURE";
    super(FAILURE_MESSAGES[safeCode], options);
    this.name = "ClutchpacksCatalogCanaryError";
    this.code = safeCode;
  }
}

function refuse(code, options) {
  throw new ClutchpacksCatalogCanaryError(code, options);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const resolved = value ?? String(fallback);
  if (!/^[1-9][0-9]*$/u.test(resolved)) {
    refuse("CLUTCHPACKS_CANARY_ARGUMENT_INVALID");
  }
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    refuse("CLUTCHPACKS_CANARY_ARGUMENT_INVALID");
  }
  return parsed;
}

export function parseClutchpacksCatalogCanaryCommand({ argv, environment }) {
  const dryRun = argv.length === 0
    || (argv.length === 1 && argv[0] === "--dry-run");
  const execute = argv.length === 1 && argv[0] === "--execute";
  if (!dryRun && !execute) {
    refuse("CLUTCHPACKS_CANARY_ARGUMENT_INVALID");
  }
  if (environment.PACKSCOUT_RUNTIME_ENVIRONMENT?.trim() !== "preproduction") {
    refuse("CLUTCHPACKS_CANARY_ENVIRONMENT_FORBIDDEN");
  }
  if (environment.PACKSCOUT_CUTOVER_WORKERS_STOPPED?.trim() !== "YES") {
    refuse("CLUTCHPACKS_CANARY_WORKERS_NOT_STOPPED");
  }
  const deploymentKey = environment.PACKSCOUT_CATALOG_DEPLOYMENT_KEY?.trim();
  if (!deploymentKey || PRODUCTION_TOKEN_PATTERN.test(deploymentKey)) {
    refuse("CLUTCHPACKS_CANARY_ENVIRONMENT_FORBIDDEN");
  }
  const target = computeClutchpacksCatalogCanaryTargetBinding(environment);
  if (
    execute
    && environment.PACKSCOUT_CLUTCHPACKS_CANARY_CONFIRMATION?.trim()
      !== target.confirmation
  ) {
    refuse("CLUTCHPACKS_CANARY_CONFIRMATION_REQUIRED");
  }
  return Object.freeze({
    dryRun,
    ...target,
    maximumCycles: boundedInteger(
      environment.PACKSCOUT_CLUTCHPACKS_CANARY_MAX_CYCLES,
      120,
      1,
      1_000,
    ),
    timeoutMilliseconds: boundedInteger(
      environment.PACKSCOUT_CLUTCHPACKS_CANARY_TIMEOUT_MS,
      600_000,
      1_000,
      1_800_000,
    ),
  });
}

function canonicalDatabaseTarget(value) {
  try {
    const parsed = new URL(value ?? "");
    if (
      typeof value !== "string"
      || value.length > 2_048
      || !["postgres:", "postgresql:"].includes(parsed.protocol)
      || !parsed.hostname
      || !parsed.username
      || parsed.pathname.length <= 1
      || parsed.hash
      || /[\r\n]/u.test(value ?? "")
    ) {
      throw new Error("invalid");
    }
    const target = new URL(parsed.href);
    target.password = "";
    target.hostname = target.hostname.toLowerCase();
    return target.href;
  } catch {
    refuse("CLUTCHPACKS_CANARY_ENVIRONMENT_FORBIDDEN");
  }
}

function canonicalConvexTarget(value) {
  try {
    const parsed = new URL(value ?? "");
    if (
      parsed.protocol !== "https:"
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      throw new Error("invalid");
    }
    return parsed.host.toLowerCase();
  } catch {
    refuse("CLUTCHPACKS_CANARY_ENVIRONMENT_FORBIDDEN");
  }
}

export function computeClutchpacksCatalogCanaryTargetBinding(environment) {
  const organizationId = environment.PACKSCOUT_PUBLIC_ORGANIZATION_ID?.trim()
    .toLowerCase();
  const deploymentKey = environment.PACKSCOUT_CATALOG_DEPLOYMENT_KEY?.trim();
  if (
    !organizationId
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(organizationId)
    || !deploymentKey
  ) {
    refuse("CLUTCHPACKS_CANARY_ENVIRONMENT_FORBIDDEN");
  }
  const databaseTarget = canonicalDatabaseTarget(
    environment.PACKSCOUT_DATABASE_URL,
  );
  const convexTarget = canonicalConvexTarget(
    environment.PACKSCOUT_CONVEX_PUBLICATION_BASE_URL,
  );
  if (
    PRODUCTION_TOKEN_PATTERN.test(databaseTarget)
    || PRODUCTION_TOKEN_PATTERN.test(convexTarget)
  ) {
    refuse("CLUTCHPACKS_CANARY_ENVIRONMENT_FORBIDDEN");
  }
  const targetDigest = createHash("sha256").update([
    "packscout.clutchpacks-catalog-canary-target.v1",
    "preproduction",
    databaseTarget,
    organizationId,
    deploymentKey,
    convexTarget,
    CLUTCHPACKS_PLATFORM_KEY,
  ].join("\n")).digest("hex");
  return Object.freeze({
    targetDigest,
    confirmation:
      `PUBLISH CLUTCHPACKS PREPRODUCTION ${targetDigest.slice(0, 16)}`,
  });
}

function exactClutchpacksScope(snapshot, promotion) {
  return snapshot.configuredPlatformKeys.length === 1
    && snapshot.configuredPlatformKeys[0] === CLUTCHPACKS_PLATFORM_KEY
    && snapshot.enabledPlatformKeys.length === 1
    && snapshot.enabledPlatformKeys[0] === CLUTCHPACKS_PLATFORM_KEY
    && promotion.providerCredentials.length === 1
    && promotion.providerCredentials[0]?.platformKey ===
      CLUTCHPACKS_PLATFORM_KEY;
}

function assertClutchpacksScope(snapshot, promotion) {
  if (!exactClutchpacksScope(snapshot, promotion)) {
    refuse("CLUTCHPACKS_CANARY_PLATFORM_SCOPE_INVALID");
  }
}

function providerStableFailure(cycle) {
  for (const entry of cycle.results) {
    const result = entry?.result;
    if (typeof result !== "object" || result === null) continue;
    if (result.outcome === "failed") {
      return "CLUTCHPACKS_CANARY_PROVIDER_FAILED";
    }
    if (result.outcome === "reconciliation_lost") {
      return "CLUTCHPACKS_CANARY_PROVIDER_FAILED";
    }
  }
  return null;
}

function manifestStableFailure(cycle) {
  const result = cycle.result;
  if (typeof result !== "object" || result === null) return null;
  return result.outcome === "failed"
    ? "CLUTCHPACKS_CANARY_MANIFEST_FAILED"
    : null;
}

function abortableSleep(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function assertNotStopped({ signal, timedOut }) {
  if (!signal.aborted) return;
  refuse(
    timedOut()
      ? "CLUTCHPACKS_CANARY_TIMEOUT"
      : "CLUTCHPACKS_CANARY_STOPPED",
  );
}

function resultSummary(repair, providerCycleCount, manifestCycleCount) {
  return Object.freeze({
    schemaVersion: "packscout.clutchpacks-catalog-canary-result.v1",
    status: "published",
    platformCount: 1,
    relationshipSourceRevisionCount: repair.sourceRevisionCount.toString(),
    relationshipTargetCount: repair.targetSemanticSetCount.toString(),
    relationshipConfirmedCount: repair.confirmedSemanticSetCount.toString(),
    providerCycleCount,
    manifestCycleCount,
    totalCycleCount: providerCycleCount + manifestCycleCount,
  });
}

function planSummary(command) {
  return Object.freeze({
    schemaVersion: "packscout.clutchpacks-catalog-canary-plan.v1",
    status: "planned",
    platformCount: 1,
    targetDigest: command.targetDigest,
    requiredConfirmation: command.confirmation,
  });
}

export async function createProductionDependencies() {
  const [database, workerConfiguration, promotionConfiguration, composition] =
    await Promise.all([
      import("@packscout/database"),
      import("../../apps/worker/src/runtime-config.ts"),
      import("../../apps/worker/src/promotion-v2-worker-config.ts"),
      import("../../apps/worker/src/clutchpacks-catalog-canary-composition.ts"),
    ]);
  return Object.freeze({
    readConfiguration(environment) {
      const fallbackWorkerId =
        `clutchpacks-canary:${process.pid}:${randomUUID()}`;
      return Object.freeze({
        provider: workerConfiguration.readProviderWorkerSharedConfiguration(
          environment,
          fallbackWorkerId,
        ),
        promotion: promotionConfiguration.readPromotionV2WorkerConfiguration(
          environment,
        ),
      });
    },
    async open(configuration) {
      const lifecycle = database.createPrismaClientLifecycle({
        databaseUrl: configuration.provider.databaseUrl,
      });
      try {
        await lifecycle.start();
        const runtime = composition.createClutchpacksCatalogCanaryRuntime({
          provider: configuration.provider,
          promotion: configuration.promotion,
          database: lifecycle.client,
          logger: { write() {} },
        });
        return Object.freeze({
          runtime,
          close: () => lifecycle.close(),
        });
      } catch (error) {
        await lifecycle.close().catch(() => undefined);
        throw error;
      }
    },
    sleep: abortableSleep,
  });
}

export async function runClutchpacksCatalogCanary({
  argv,
  environment,
  dependencies,
  signal,
  writeOutput = (value) => process.stdout.write(`${value}\n`),
  scheduleTimeout = (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancelTimeout = (handle) => clearTimeout(handle),
}) {
  const command = parseClutchpacksCatalogCanaryCommand({ argv, environment });
  const runtimeDependencies = dependencies ?? await createProductionDependencies();
  const configuration = runtimeDependencies.readConfiguration(environment);
  const timeoutController = new AbortController();
  let deadlineElapsed = false;
  const timeoutHandle = scheduleTimeout(() => {
    deadlineElapsed = true;
    timeoutController.abort();
  }, command.timeoutMilliseconds);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  timeoutController.signal.addEventListener("abort", forwardAbort, { once: true });
  signal?.addEventListener("abort", forwardAbort, { once: true });
  let session;
  let operationFailed = false;
  try {
    assertNotStopped({
      signal: controller.signal,
      timedOut: () => deadlineElapsed,
    });
    session = await runtimeDependencies.open(configuration);
    assertNotStopped({
      signal: controller.signal,
      timedOut: () => deadlineElapsed,
    });
    let state = await session.runtime.loadState();
    assertClutchpacksScope(state.snapshot, configuration.promotion);
    if (command.dryRun) {
      const summary = planSummary(command);
      writeOutput(JSON.stringify(summary));
      return summary;
    }
    const repair = await session.runtime.runRelationshipConfirmationRepair(
      controller.signal,
    );
    assertNotStopped({
      signal: controller.signal,
      timedOut: () => deadlineElapsed,
    });
    if (
      !repair.ready
      || repair.completeSourceRevisionCount !== repair.sourceRevisionCount
      || repair.confirmedSemanticSetCount !== repair.targetSemanticSetCount
    ) {
      refuse("CLUTCHPACKS_CANARY_RELATIONSHIP_REPAIR_INCOMPLETE");
    }

    let providerCycleCount = 0;
    let manifestCycleCount = 0;
    for (;;) {
      assertNotStopped({
        signal: controller.signal,
        timedOut: () => deadlineElapsed,
      });
      state = await session.runtime.loadState();
      assertClutchpacksScope(state.snapshot, configuration.promotion);
      if (state.manifestComplete) {
        const summary = resultSummary(
          repair,
          providerCycleCount,
          manifestCycleCount,
        );
        writeOutput(JSON.stringify(summary));
        return summary;
      }
      if (providerCycleCount + manifestCycleCount >= command.maximumCycles) {
        refuse("CLUTCHPACKS_CANARY_CYCLE_LIMIT");
      }

      if (!state.providerComplete) {
        const cycle = await session.runtime.runProviderCycle(controller.signal);
        providerCycleCount += 1;
        assertClutchpacksScope(cycle.snapshot, configuration.promotion);
        const failureCode = providerStableFailure(cycle);
        if (failureCode !== null) refuse(failureCode);
      } else {
        const cycle = await session.runtime.runManifestCycle(controller.signal);
        manifestCycleCount += 1;
        assertClutchpacksScope(cycle.snapshot, configuration.promotion);
        const failureCode = manifestStableFailure(cycle);
        if (failureCode !== null) refuse(failureCode);
      }
      assertNotStopped({
        signal: controller.signal,
        timedOut: () => deadlineElapsed,
      });
      await runtimeDependencies.sleep(
        configuration.promotion.pollIntervalMilliseconds,
        controller.signal,
      );
    }
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    cancelTimeout(timeoutHandle);
    timeoutController.signal.removeEventListener("abort", forwardAbort);
    signal?.removeEventListener("abort", forwardAbort);
    try {
      await session?.close();
    } catch (error) {
      if (!operationFailed) {
        refuse("CLUTCHPACKS_CANARY_INTERNAL_FAILURE", { cause: error });
      }
    }
  }
}

function failureCodeFor(error) {
  if (error instanceof ClutchpacksCatalogCanaryError) return error.code;
  return "CLUTCHPACKS_CANARY_INTERNAL_FAILURE";
}

export function clutchpacksCatalogCanaryUsage() {
  return `Usage:
  npm run catalog:canary:clutchpacks:preproduction -- --dry-run
  npm run catalog:canary:clutchpacks:preproduction -- --execute

Required protected environment:
  PACKSCOUT_RUNTIME_ENVIRONMENT=preproduction
  PACKSCOUT_CUTOVER_WORKERS_STOPPED=YES
  PACKSCOUT_CLUTCHPACKS_CANARY_CONFIRMATION=<dry-run confirmation for execute>
  shared provider worker and Promotion V2 configuration`;
}

async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runClutchpacksCatalogCanary({
      argv: process.argv.slice(2),
      environment: process.env,
      signal: controller.signal,
    });
  } catch (error) {
    const failureCode = failureCodeFor(error);
    process.stderr.write(`${JSON.stringify({
      schemaVersion: "packscout.clutchpacks-catalog-canary-result.v1",
      status: "failed",
      failureCode,
    })}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
