#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCentralDatabaseLifecycle } from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  captureHardenedProviderResponse,
} from "@packscout/services";
import {
  CentralDataforrestSourceAuthorityResolver,
  type ResolvedDataforrestSourceAuthority,
} from "../../apps/worker/src/dataforrest-source-authority-resolver.ts";
import {
  CatalogBridgeError,
  catalogBridgeProvider,
  refuseCatalogBridge,
} from "./dataforrest-catalog-bridge-plan.mts";
import {
  catalogBridgePrivateJsonBytes,
  catalogBridgeRepositoryRoot,
  observeCatalogBridgeCheckout,
  persistCatalogBridgePrivateBytes,
} from "./dataforrest-catalog-bridge-operator-files.mts";
import {
  assertCatalogBridgeSourceCensusAuthority,
  captureCatalogBridgeSourceCensusPass,
  catalogBridgeSourceCensusDigest,
  catalogBridgeSourceCensusSchema,
  type CatalogBridgeSourceCensus,
} from "./dataforrest-catalog-bridge-source-census.mts";
import { inspectCatalogBridgeSourcePage } from
  "./dataforrest-catalog-bridge-source-inspection.mts";
import { readCatalogBridgeLiveDrainEnvironment } from
  "./run-dataforrest-catalog-bridge-drain.mts";

const runnerModule = "scripts/live/capture-dataforrest-catalog-bridge-source-census.mts";
const censusModule = "scripts/live/dataforrest-catalog-bridge-source-census.mts";
const inspectionModule = "scripts/live/dataforrest-catalog-bridge-source-inspection.mts";
const maximumOperationMilliseconds = 48 * 60 * 60_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface CatalogBridgeSourceCensusCaptureArguments {
  readonly operationId: string;
  readonly providerKey: "collector_crypt";
  readonly executorCheckout: string;
  readonly executorCommit: string;
  readonly outputPath: string;
}

function safeAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value && !/[\r\n\0]/u.test(value);
}

export function parseCatalogBridgeSourceCensusCaptureArguments(
  argv: readonly string[],
): CatalogBridgeSourceCensusCaptureArguments {
  if (argv[0] !== "--capture") {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_ARGUMENTS_INVALID");
  }
  const allowed = new Set(["--operation-id", "--provider-key", "--executor-checkout",
    "--executor-commit", "--output"]);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.has(flag) || values.has(flag) || !value || value.startsWith("--")) {
      refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_ARGUMENTS_INVALID");
    }
    values.set(flag, value);
  }
  const checkout = values.get("--executor-checkout") ?? "";
  const output = values.get("--output") ?? "";
  if (values.size !== allowed.size || argv.length !== 1 + allowed.size * 2 ||
    !uuidPattern.test(values.get("--operation-id") ?? "") ||
    values.get("--provider-key") !== "collector_crypt" || !safeAbsolutePath(checkout) ||
    !safeAbsolutePath(output) || output === checkout ||
    !/^[a-f0-9]{40}$/u.test(values.get("--executor-commit") ?? "")) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_ARGUMENTS_INVALID");
  }
  return Object.freeze({
    operationId: values.get("--operation-id")!,
    providerKey: "collector_crypt" as const,
    executorCheckout: checkout,
    executorCommit: values.get("--executor-commit")!,
    outputPath: output,
  });
}

export async function performCatalogBridgeSourceCensus(input: Readonly<{
  args: CatalogBridgeSourceCensusCaptureArguments;
  executor: Readonly<{
    runnerModuleSha256: string;
    censusModuleSha256: string;
    inspectionModuleSha256: string;
  }>;
  resolveAuthority: () => Promise<ResolvedDataforrestSourceAuthority>;
  readPage: (authority: ResolvedDataforrestSourceAuthority, cursor: string | null,
    signal: AbortSignal) => ReturnType<typeof inspectCatalogBridgeSourcePage>;
  signal: AbortSignal;
  now?: () => Date;
  maximumPages?: number;
  onProgress?: Parameters<typeof captureCatalogBridgeSourceCensusPass>[0]["onProgress"];
}>): Promise<CatalogBridgeSourceCensus> {
  if (!uuidPattern.test(input.args.operationId)) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_ARGUMENTS_INVALID");
  }
  const definition = catalogBridgeProvider(input.args.providerKey);
  const firstAuthority = await input.resolveAuthority();
  const authorityDigest = assertCatalogBridgeSourceCensusAuthority(firstAuthority);
  const first = await captureCatalogBridgeSourceCensusPass({
    passNumber: 1,
    authority: firstAuthority,
    readPage: (cursor, signal) => input.readPage(firstAuthority, cursor, signal),
    signal: input.signal,
    now: input.now,
    maximumPages: input.maximumPages,
    onProgress: input.onProgress,
  });
  const secondAuthority = await input.resolveAuthority();
  if (assertCatalogBridgeSourceCensusAuthority(secondAuthority) !== authorityDigest) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_AUTHORITY_CHANGED");
  }
  const second = await captureCatalogBridgeSourceCensusPass({
    passNumber: 2,
    authority: secondAuthority,
    readPage: (cursor, signal) => input.readPage(secondAuthority, cursor, signal),
    signal: input.signal,
    now: input.now,
    maximumPages: input.maximumPages,
    onProgress: input.onProgress,
  });
  const finalAuthority = await input.resolveAuthority();
  if (assertCatalogBridgeSourceCensusAuthority(finalAuthority) !== authorityDigest) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_AUTHORITY_CHANGED");
  }
  return catalogBridgeSourceCensusSchema.parse({
    schemaVersion: "dataforrest_catalog_bridge_source_census_v1",
    authorization: "operator_requested_read_only_catalog_source_census",
    operationId: input.args.operationId,
    providerKey: input.args.providerKey,
    capturedAt: second.completedAt,
    executor: {
      checkout: input.args.executorCheckout,
      commit: input.args.executorCommit,
      ...input.executor,
    },
    source: {
      providerId: definition.providerId,
      configId: definition.currentConfigId,
      configNumber: definition.currentConfigNumber,
      activeAdapterVersion: definition.currentEventManifest.adapterVersion,
      catalogAdapterVersion: definition.catalogAdapterVersion,
      sourceCredentialDigest: authorityDigest,
      pageLimit: definition.catalogManifest.requestBounds.pageLimit,
      requestTimeoutMilliseconds: definition.catalogManifest.requestBounds.timeoutMilliseconds,
      maximumResponseBytes: definition.catalogManifest.requestBounds.maximumResponseBytes,
    },
    passes: [first, second],
    agreement: {
      sourceRecordCount: first.sourceRecordCount,
      cardCount: first.distinctCardIdentityCount,
      packCount: first.distinctPackIdentityCount,
      pageCount: first.pageCount,
      identityMultisetDigest: first.identityMultisetDigest,
      traversalChainDigest: first.traversalChainDigest,
      finalCursorHash: first.finalCursorHash,
    },
    databaseWritesPerformed: false,
    sourceRequestsPerformed: true,
    rawResponsesPersisted: false,
    rawCursorsPersisted: false,
    sourceRecordIdsPersisted: false,
  });
}

export async function captureCatalogBridgeSourceCensus(input: Readonly<{
  args: CatalogBridgeSourceCensusCaptureArguments;
  environment?: NodeJS.ProcessEnv;
}>): Promise<Readonly<Record<string, unknown>>> {
  const checkout = await observeCatalogBridgeCheckout({
    checkout: input.args.executorCheckout,
    expectedCommit: input.args.executorCommit,
    executingRoot: catalogBridgeRepositoryRoot(import.meta.url),
    modules: { runner: runnerModule, census: censusModule, inspection: inspectionModule },
  });
  const environment = readCatalogBridgeLiveDrainEnvironment(input.environment ?? process.env);
  const centralUrl = new URL(environment.centralDatabaseUrl);
  centralUrl.searchParams.set("connect_timeout", "5");
  centralUrl.searchParams.set("pool_timeout", "5");
  const central = createCentralDatabaseLifecycle({ databaseUrl: centralUrl.toString(), connectionLimit: 1 });
  const cipher = new AesGcmProviderCredentialCipher({
    primaryVersion: environment.credentialKeyVersion,
    keys: new Map([[environment.credentialKeyVersion, environment.credentialKey]]),
  });
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const deadline = setTimeout(abort, maximumOperationMilliseconds);
  try {
    await central.start();
    const definition = catalogBridgeProvider(input.args.providerKey);
    const resolver = new CentralDataforrestSourceAuthorityResolver({
      central: central.client,
      credentialCipher: cipher,
    });
    const resolveAuthority = () => resolver.resolve({
      providerId: definition.providerId,
      providerKey: definition.providerKey,
      configVersionId: definition.currentConfigId,
      configVersionNumber: BigInt(definition.currentConfigNumber),
      adapterKey: definition.currentEventManifest.adapterVersion,
    });
    const proof = await performCatalogBridgeSourceCensus({
      args: input.args,
      executor: {
        runnerModuleSha256: checkout.moduleSha256.runner!,
        censusModuleSha256: checkout.moduleSha256.census!,
        inspectionModuleSha256: checkout.moduleSha256.inspection!,
      },
      resolveAuthority,
      readPage: (authority, cursor, signal) => inspectCatalogBridgeSourcePage({
        authority,
        manifest: definition.catalogManifest,
        stream: "catalog",
        cursor,
        signal,
        captureResponse: captureHardenedProviderResponse,
      }),
      signal: controller.signal,
      onProgress: (progress) => process.stderr.write(`${JSON.stringify({
        outcome: "progress", providerKey: definition.providerKey, ...progress,
      })}\n`),
    });
    if (controller.signal.aborted) refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_ABORTED");
    const bytes = catalogBridgePrivateJsonBytes(proof);
    try {
      const persisted = await persistCatalogBridgePrivateBytes(input.args.outputPath, bytes);
      return Object.freeze({
        outcome: persisted.exactRetry ? "already_captured" : "captured",
        operationId: proof.operationId,
        providerKey: proof.providerKey,
        sourceCensusFileSha256: persisted.fileSha256,
        sourceCensusProofDigest: catalogBridgeSourceCensusDigest(proof),
        sourceHeadCardCount: proof.agreement.cardCount,
        sourceHeadPackCount: proof.agreement.packCount,
        sourceHeadIdentityMultisetDigest: proof.agreement.identityMultisetDigest,
        sourceRequestCount: proof.passes.reduce((sum, pass) => sum + pass.sourceRequestCount, 0),
        databaseWritesPerformed: false,
      });
    } finally {
      bytes.fill(0);
    }
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    try { await central.close(); } finally { environment.credentialKey.fill(0); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => captureCatalogBridgeSourceCensus({
    args: parseCatalogBridgeSourceCensusCaptureArguments(process.argv.slice(2)),
  })).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`), (error: unknown) => {
    process.stderr.write(`${JSON.stringify({ outcome: "refused", code: error instanceof CatalogBridgeError
      ? error.code : "CATALOG_BRIDGE_SOURCE_CENSUS_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
