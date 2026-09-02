#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoundedProviderDatabaseGateway,
  createCentralDatabaseLifecycle,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
} from "@packscout/services";
import {
  assertCatalogBridgeIdleHead,
  assertCatalogBridgeProcessOnline,
  assertCatalogBridgeRunningEntry,
  catalogBridgeDrainStableDatabaseEvidence,
  type CatalogBridgeDrainBoundary,
} from "./dataforrest-catalog-bridge-drain-policy.mts";
import {
  assertCatalogBridgeLiveCentralOperationFresh,
  readCatalogBridgeLiveCentralAuthorityObservation,
  readCatalogBridgeLiveDrainCaptureBoundary,
  type CatalogBridgeLiveCentralAuthority,
} from "./dataforrest-catalog-bridge-drain-live-database.mts";
import { createCatalogBridgeMacosProcessAdapter } from
  "./dataforrest-catalog-bridge-drain-macos.mts";
import {
  catalogBridgeLiveDrainPolicyDigest,
  catalogBridgeLiveDrainPolicySchema,
  type CatalogBridgeLiveDrainPolicy,
} from "./dataforrest-catalog-bridge-drain-live-policy.mts";
import {
  CatalogBridgeError,
  catalogBridgeDigest,
  catalogBridgeProvider,
  refuseCatalogBridge,
  type CatalogBridgeProviderKey,
} from "./dataforrest-catalog-bridge-plan.mts";
import { readCatalogBridgeLiveDrainEnvironment } from
  "./run-dataforrest-catalog-bridge-drain.mts";
import {
  catalogBridgePrivateJsonBytes,
  catalogBridgeRepositoryRoot,
  observeCatalogBridgeCheckout,
  persistCatalogBridgePrivateBytes,
} from "./dataforrest-catalog-bridge-operator-files.mts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const runnerModule = "scripts/live/run-dataforrest-catalog-bridge-drain.mts";

export interface CatalogBridgeDrainPolicyCaptureArguments {
  readonly providerKey: CatalogBridgeProviderKey;
  readonly operationId: string;
  readonly operatorId: string;
  readonly executorCheckout: string;
  readonly executorCommit: string;
  readonly receiptPath: string;
  readonly outputPath: string;
}

function absolute(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value && !/[\r\n\0]/u.test(value);
}

export function parseCatalogBridgeDrainPolicyCaptureArguments(
  argv: readonly string[],
): CatalogBridgeDrainPolicyCaptureArguments {
  if (argv[0] !== "--capture") {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_CAPTURE_ARGUMENTS_INVALID");
  }
  const allowed = new Set(["--provider-key", "--operation-id", "--operator-id",
    "--executor-checkout", "--executor-commit", "--receipt-path", "--output"]);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.has(flag) || values.has(flag) || !value || value.startsWith("--")) {
      refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_CAPTURE_ARGUMENTS_INVALID");
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size || argv.length !== 1 + allowed.size * 2) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_CAPTURE_ARGUMENTS_INVALID");
  }
  const providerKey = values.get("--provider-key")! as CatalogBridgeProviderKey;
  catalogBridgeProvider(providerKey);
  const result = Object.freeze({ providerKey,
    operationId: values.get("--operation-id")!, operatorId: values.get("--operator-id")!,
    executorCheckout: values.get("--executor-checkout")!,
    executorCommit: values.get("--executor-commit")!, receiptPath: values.get("--receipt-path")!,
    outputPath: values.get("--output")! });
  if (!uuidPattern.test(result.operationId) || !uuidPattern.test(result.operatorId) ||
    !commitPattern.test(result.executorCommit) || !absolute(result.executorCheckout) ||
    !absolute(result.receiptPath) || !absolute(result.outputPath) ||
    result.receiptPath === result.outputPath) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_CAPTURE_ARGUMENTS_INVALID");
  }
  return result;
}

export function buildCatalogBridgeLiveDrainPolicy(input: Readonly<{
  args: CatalogBridgeDrainPolicyCaptureArguments;
  boundary: CatalogBridgeDrainBoundary;
  authority: CatalogBridgeLiveCentralAuthority;
  executorRunnerModuleSha256: string;
}>): CatalogBridgeLiveDrainPolicy {
  const pins = Object.freeze({ operationId: input.args.operationId,
    providerKey: input.args.providerKey, operatorId: input.args.operatorId });
  let entryKind: "running" | "idle_head";
  if (input.boundary.runtime.state === "running") {
    assertCatalogBridgeRunningEntry(input.boundary, pins);
    entryKind = "running";
  } else if (input.boundary.runtime.state === "idle") {
    assertCatalogBridgeIdleHead(input.boundary, pins);
    assertCatalogBridgeProcessOnline(input.boundary);
    entryKind = "idle_head";
  } else {
    return refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_CAPTURE_ENTRY_INVALID");
  }
  const definition = catalogBridgeProvider(input.args.providerKey);
  return catalogBridgeLiveDrainPolicySchema.parse({
    schemaVersion: "dataforrest_catalog_bridge_live_drain_v1",
    environment: "live",
    authorization: "operator_requested_catalog_bridge_drain",
    operationId: input.args.operationId,
    providerKey: input.args.providerKey,
    providerId: definition.providerId,
    operatorId: input.args.operatorId,
    executor: { checkout: input.args.executorCheckout, commit: input.args.executorCommit,
      runnerModuleSha256: input.executorRunnerModuleSha256 },
    entryKind,
    currentConfigId: definition.currentConfigId,
    currentConfigNumber: definition.currentConfigNumber,
    providerRowVersion: input.boundary.central.providerRowVersion,
    centralAuthorityDigest: input.authority.boundary.authorityDigest,
    databaseRouteDigest: input.authority.routeDigest,
    runtimeGeneration: input.boundary.runtime.generation,
    runtimeRowVersion: input.boundary.runtime.rowVersion,
    runId: input.boundary.run.id,
    runFence: input.boundary.run.workerFence,
    sourceCursorHash: input.boundary.runtime.sourceCursorHash,
    importLeaseOwner: input.boundary.importLease.owner,
    importLeaseFence: input.boundary.importLease.fence,
    processPid: input.boundary.process.pids[0],
    processIdentitySha256: input.boundary.process.processIdentitySha256,
    receiptPath: input.args.receiptPath,
    pollMilliseconds: 1_000,
    maximumObservations: 75,
    bootoutPollMilliseconds: 100,
    bootoutTimeoutMilliseconds: 10_000,
  });
}

function sameAuthority(left: CatalogBridgeLiveCentralAuthority,
  right: CatalogBridgeLiveCentralAuthority): boolean {
  return left.routeDigest === right.routeDigest &&
    catalogBridgeDigest(left.boundary) === catalogBridgeDigest(right.boundary);
}

export async function captureCatalogBridgeDrainPolicy(input: Readonly<{
  args: CatalogBridgeDrainPolicyCaptureArguments;
  environment?: NodeJS.ProcessEnv;
}>): Promise<Readonly<Record<string, unknown>>> {
  const checkout = await observeCatalogBridgeCheckout({ checkout: input.args.executorCheckout,
    expectedCommit: input.args.executorCommit, executingRoot: catalogBridgeRepositoryRoot(import.meta.url),
    modules: { runner: runnerModule } });
  const environment = readCatalogBridgeLiveDrainEnvironment(input.environment ?? process.env);
  const centralUrl = new URL(environment.centralDatabaseUrl);
  centralUrl.searchParams.set("connect_timeout", "5");
  centralUrl.searchParams.set("pool_timeout", "5");
  const central = createCentralDatabaseLifecycle({ databaseUrl: centralUrl.toString(), connectionLimit: 1 });
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.credentialKeyVersion,
    keys: new Map([[environment.credentialKeyVersion, environment.credentialKey]]) });
  const gateway = new BoundedProviderDatabaseGateway({ central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: environment.runtimePolicy.destinationPolicy, connectionLimitPerProvider: 1,
    maximumCachedProviders: 1, connectionTimeoutMs: 5_000, operationTimeoutMs: 35_000,
    closeTimeoutMs: 5_000 });
  try {
    await central.start();
    const readAuthority = () => central.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'");
      await assertCatalogBridgeLiveCentralOperationFresh({ central: transaction,
        operationId: input.args.operationId, providerKey: input.args.providerKey });
      return readCatalogBridgeLiveCentralAuthorityObservation({ central: transaction,
        providerKey: input.args.providerKey, operatorId: input.args.operatorId });
    }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 15_000 });
    const processAdapter = createCatalogBridgeMacosProcessAdapter({ providerKey: input.args.providerKey,
      authorizeBootout: async () => refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_CAPTURE_BOOTOUT_FORBIDDEN") });
    const processBefore = await processAdapter.observe();
    const authorityBefore = await readAuthority();
    const readBoundary = () => gateway.runWithCachedProviderDatabase(authorityBefore.route,
      (database) => readCatalogBridgeLiveDrainCaptureBoundary({ database,
        authority: authorityBefore, process: processBefore, providerKey: input.args.providerKey,
        operationId: input.args.operationId, operatorId: input.args.operatorId }));
    const before = await readBoundary();
    const after = await readBoundary();
    if (before.state !== "reachable" || before.value === undefined ||
      after.state !== "reachable" || after.value === undefined) {
      refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_CAPTURE_PROVIDER_UNAVAILABLE");
    }
    const authorityAfter = await readAuthority();
    const processAfter = await processAdapter.observe();
    if (!sameAuthority(authorityBefore, authorityAfter) ||
      catalogBridgeDigest(processBefore) !== catalogBridgeDigest(processAfter) ||
      catalogBridgeDigest(catalogBridgeDrainStableDatabaseEvidence(before.value)) !==
        catalogBridgeDigest(catalogBridgeDrainStableDatabaseEvidence(after.value))) {
      refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_CAPTURE_BOUNDARY_CHANGED");
    }
    const policy = buildCatalogBridgeLiveDrainPolicy({ args: input.args, boundary: after.value,
      authority: authorityAfter, executorRunnerModuleSha256: checkout.moduleSha256.runner! });
    const persisted = await persistCatalogBridgePrivateBytes(input.args.outputPath,
      catalogBridgePrivateJsonBytes(policy));
    return Object.freeze({ outcome: persisted.exactRetry ? "already_captured" : "captured",
      providerKey: policy.providerKey, operationId: policy.operationId,
      policySha256: catalogBridgeLiveDrainPolicyDigest(policy),
      policyFileSha256: persisted.fileSha256, databaseWritesPerformed: false,
      sourceRequestsPerformed: false, launchctlMutationsPerformed: false });
  } finally {
    try {
      await gateway.close();
    } finally {
      try { await central.close(); } finally { environment.credentialKey.fill(0); }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => captureCatalogBridgeDrainPolicy({
    args: parseCatalogBridgeDrainPolicyCaptureArguments(process.argv.slice(2)),
  })).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`), (error: unknown) => {
    process.stderr.write(`${JSON.stringify({ outcome: "refused", code: error instanceof CatalogBridgeError
      ? error.code : "CATALOG_BRIDGE_DRAIN_CAPTURE_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
