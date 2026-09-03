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
  catalogBridgeSourceCensusFileSha256,
  catalogBridgeSourceCensusSchema,
  readCatalogBridgeSourceCensusIfPresent,
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
const sha256Pattern = /^[a-f0-9]{64}$/u;

export interface CatalogBridgeSourceCensusCaptureArguments {
  readonly operationId: string;
  readonly providerKey: "collector_crypt";
  readonly executorCheckout: string;
  readonly executorCommit: string;
  readonly outputPath: string;
}

export interface CatalogBridgeSourceCensusExecutorEvidence {
  readonly runnerModuleSha256: string;
  readonly censusModuleSha256: string;
  readonly inspectionModuleSha256: string;
}

export interface CatalogBridgeSourceCensusCaptureResult {
  readonly outcome: "already_captured" | "captured";
  readonly operationId: string;
  readonly providerKey: "collector_crypt";
  readonly sourceCensusFileSha256: string;
  readonly sourceCensusProofDigest: string;
  readonly sourceHeadCardCount: number;
  readonly sourceHeadPackCount: number;
  readonly sourceHeadIdentityMultisetDigest: string;
  readonly sourceRequestsPerformed: boolean;
  readonly sourceRequestCount: number;
  readonly databaseWritesPerformed: false;
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
  executor: CatalogBridgeSourceCensusExecutorEvidence;
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

function captureProofBinding(input: Readonly<{
  args: CatalogBridgeSourceCensusCaptureArguments;
  executor: CatalogBridgeSourceCensusExecutorEvidence;
  proof: unknown;
  failureCode: "CATALOG_BRIDGE_OPERATOR_OUTPUT_CONFLICT" |
    "CATALOG_BRIDGE_SOURCE_CENSUS_INVALID";
}>): CatalogBridgeSourceCensus {
  const parsed = catalogBridgeSourceCensusSchema.safeParse(input.proof);
  if (!parsed.success) refuseCatalogBridge(input.failureCode);
  const proof = parsed.data;
  const definition = catalogBridgeProvider(input.args.providerKey);
  if (!uuidPattern.test(input.args.operationId) ||
    input.args.providerKey !== "collector_crypt" ||
    !safeAbsolutePath(input.args.executorCheckout) ||
    !safeAbsolutePath(input.args.outputPath) ||
    input.args.outputPath === input.args.executorCheckout ||
    !/^[a-f0-9]{40}$/u.test(input.args.executorCommit) ||
    Object.values(input.executor).some((digest) => !sha256Pattern.test(digest)) ||
    proof.operationId !== input.args.operationId ||
    proof.providerKey !== input.args.providerKey ||
    proof.executor.checkout !== input.args.executorCheckout ||
    proof.executor.commit !== input.args.executorCommit ||
    proof.executor.runnerModuleSha256 !== input.executor.runnerModuleSha256 ||
    proof.executor.censusModuleSha256 !== input.executor.censusModuleSha256 ||
    proof.executor.inspectionModuleSha256 !== input.executor.inspectionModuleSha256 ||
    proof.source.providerId !== definition.providerId ||
    proof.source.configId !== definition.currentConfigId ||
    proof.source.configNumber !== definition.currentConfigNumber ||
    proof.source.activeAdapterVersion !== definition.currentEventManifest.adapterVersion ||
    proof.source.catalogAdapterVersion !== definition.catalogAdapterVersion ||
    proof.source.pageLimit !== definition.catalogManifest.requestBounds.pageLimit ||
    proof.source.requestTimeoutMilliseconds !==
      definition.catalogManifest.requestBounds.timeoutMilliseconds ||
    proof.source.maximumResponseBytes !==
      definition.catalogManifest.requestBounds.maximumResponseBytes ||
    proof.agreement.cardCount < definition.documentedCatalogFloor.card ||
    proof.agreement.packCount < definition.documentedCatalogFloor.pack) {
    refuseCatalogBridge(input.failureCode);
  }
  return proof;
}

function captureResult(input: Readonly<{
  proof: CatalogBridgeSourceCensus;
  fileSha256: string;
  outcome: "already_captured" | "captured";
  sourceRequestsPerformed: boolean;
}>): CatalogBridgeSourceCensusCaptureResult {
  return Object.freeze({
    outcome: input.outcome,
    operationId: input.proof.operationId,
    providerKey: input.proof.providerKey as "collector_crypt",
    sourceCensusFileSha256: input.fileSha256,
    sourceCensusProofDigest: catalogBridgeSourceCensusDigest(input.proof),
    sourceHeadCardCount: input.proof.agreement.cardCount,
    sourceHeadPackCount: input.proof.agreement.packCount,
    sourceHeadIdentityMultisetDigest: input.proof.agreement.identityMultisetDigest,
    sourceRequestsPerformed: input.sourceRequestsPerformed,
    sourceRequestCount: input.sourceRequestsPerformed
      ? input.proof.passes.reduce((sum, pass) => sum + pass.sourceRequestCount, 0)
      : 0,
    databaseWritesPerformed: false,
  });
}

/** Resolves a completed operation before lazily invoking any fresh source work. */
export async function captureOrReuseCatalogBridgeSourceCensus(input: Readonly<{
  args: CatalogBridgeSourceCensusCaptureArguments;
  executor: CatalogBridgeSourceCensusExecutorEvidence;
  readExisting: () => Promise<Readonly<{
    proof: CatalogBridgeSourceCensus;
    fileSha256: string;
  }> | null>;
  captureFresh: () => Promise<CatalogBridgeSourceCensus>;
  persistFresh: (proof: CatalogBridgeSourceCensus) => Promise<Readonly<{
    fileSha256: string;
    exactRetry: boolean;
  }>>;
}>): Promise<CatalogBridgeSourceCensusCaptureResult> {
  const existing = await input.readExisting();
  if (existing !== null) {
    const proof = captureProofBinding({ args: input.args, executor: input.executor,
      proof: existing.proof, failureCode: "CATALOG_BRIDGE_OPERATOR_OUTPUT_CONFLICT" });
    if (!sha256Pattern.test(existing.fileSha256) ||
      existing.fileSha256 !== catalogBridgeSourceCensusFileSha256(proof)) {
      refuseCatalogBridge("CATALOG_BRIDGE_OPERATOR_OUTPUT_CONFLICT");
    }
    return captureResult({ proof, fileSha256: existing.fileSha256,
      outcome: "already_captured", sourceRequestsPerformed: false });
  }

  const proof = captureProofBinding({ args: input.args, executor: input.executor,
    proof: await input.captureFresh(), failureCode: "CATALOG_BRIDGE_SOURCE_CENSUS_INVALID" });
  const persisted = await input.persistFresh(proof);
  const expectedFileSha256 = catalogBridgeSourceCensusFileSha256(proof);
  if (!sha256Pattern.test(persisted.fileSha256) ||
    persisted.fileSha256 !== expectedFileSha256 ||
    typeof persisted.exactRetry !== "boolean") {
    refuseCatalogBridge("CATALOG_BRIDGE_OPERATOR_OUTPUT_CONFLICT");
  }
  return captureResult({ proof, fileSha256: persisted.fileSha256,
    outcome: persisted.exactRetry ? "already_captured" : "captured",
    sourceRequestsPerformed: true });
}

async function captureFreshCatalogBridgeSourceCensus(input: Readonly<{
  args: CatalogBridgeSourceCensusCaptureArguments;
  executor: CatalogBridgeSourceCensusExecutorEvidence;
  environment?: NodeJS.ProcessEnv;
}>): Promise<CatalogBridgeSourceCensus> {
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
      executor: input.executor,
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
    return proof;
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    try { await central.close(); } finally { environment.credentialKey.fill(0); }
  }
}

export async function captureCatalogBridgeSourceCensus(input: Readonly<{
  args: CatalogBridgeSourceCensusCaptureArguments;
  environment?: NodeJS.ProcessEnv;
}>): Promise<CatalogBridgeSourceCensusCaptureResult> {
  const checkout = await observeCatalogBridgeCheckout({
    checkout: input.args.executorCheckout,
    expectedCommit: input.args.executorCommit,
    executingRoot: catalogBridgeRepositoryRoot(import.meta.url),
    modules: { runner: runnerModule, census: censusModule, inspection: inspectionModule },
  });
  const executor = Object.freeze({
    runnerModuleSha256: checkout.moduleSha256.runner!,
    censusModuleSha256: checkout.moduleSha256.census!,
    inspectionModuleSha256: checkout.moduleSha256.inspection!,
  });
  return captureOrReuseCatalogBridgeSourceCensus({
    args: input.args,
    executor,
    readExisting: () => readCatalogBridgeSourceCensusIfPresent(input.args.outputPath),
    captureFresh: () => captureFreshCatalogBridgeSourceCensus({
      args: input.args,
      executor,
      environment: input.environment,
    }),
    persistFresh: async (proof) => {
      const bytes = catalogBridgePrivateJsonBytes(proof);
      try {
        return await persistCatalogBridgePrivateBytes(input.args.outputPath, bytes);
      } finally {
        bytes.fill(0);
      }
    },
  });
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
