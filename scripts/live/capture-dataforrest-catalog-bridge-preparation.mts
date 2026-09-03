#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  opaqueCursorEnvelopeSchema,
  type SourceAdapterManifestV1,
} from "@packscout/contracts";
import {
  BoundedProviderDatabaseGateway,
  createCentralDatabaseLifecycle,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  captureHardenedProviderResponse,
  CipherProviderDatabaseCredentialResolver,
} from "@packscout/services";
import {
  CentralDataforrestSourceAuthorityResolver,
  type ResolvedDataforrestSourceAuthority,
} from "../../apps/worker/src/dataforrest-source-authority-resolver.ts";
import { readCatalogBridgeCanonicalEvidenceUnlocked } from
  "./dataforrest-catalog-bridge-catalog-live-database.mts";
import {
  createCatalogBridgeLiveDatabaseAdapter,
  readCatalogBridgeLiveCentralAuthority,
  type CatalogBridgeLiveCentralAuthority,
} from "./dataforrest-catalog-bridge-drain-live-database.mts";
import {
  assertCatalogBridgePausedDrain,
  assertCatalogBridgeProcessOffline,
  catalogBridgeDrainStableDatabaseEvidence,
  type CatalogBridgeDrainBoundary,
  type CatalogBridgePauseCommand,
} from "./dataforrest-catalog-bridge-drain-policy.mts";
import { readCatalogBridgeDrainReceiptIfPresent } from
  "./dataforrest-catalog-bridge-drain-journal.mts";
import { createCatalogBridgeMacosProcessAdapter } from
  "./dataforrest-catalog-bridge-drain-macos.mts";
import {
  catalogBridgeLiveDrainPins,
  catalogBridgeLiveDrainPolicyDigest,
  readCatalogBridgeLiveDrainPolicy,
} from "./dataforrest-catalog-bridge-drain-live-policy.mts";
import { persistCatalogBridgePreparationInput } from
  "./dataforrest-catalog-bridge-journal.mts";
import {
  CatalogBridgeError,
  catalogBridgeDigest,
  catalogBridgeProvider,
  prepareCatalogBridge,
  refuseCatalogBridge,
  type CatalogBridgeCanonicalEvidence,
  type CatalogBridgeOperationPins,
  type CatalogBridgePreflightObservation,
} from "./dataforrest-catalog-bridge-plan.mts";
import {
  catalogBridgeRepositoryRoot,
  observeCatalogBridgeCheckout,
} from "./dataforrest-catalog-bridge-operator-files.mts";
import {
  catalogBridgeSourceCensusDigest,
  readCatalogBridgeSourceCensus,
  type CatalogBridgeSourceCensus,
} from "./dataforrest-catalog-bridge-source-census.mts";
import {
  catalogBridgeSourceCredentialDigest,
  inspectCatalogBridgeSourcePage,
} from "./dataforrest-catalog-bridge-source-inspection.mts";
import { readCatalogBridgeLiveDrainEnvironment } from
  "./run-dataforrest-catalog-bridge-drain.mts";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const canonicalEvidenceTimeoutMilliseconds = 9 * 60_000;
const runnerModule = "scripts/live/run-dataforrest-catalog-bridge-drain.mts";
const planModule = "scripts/live/dataforrest-catalog-bridge-plan.mts";

export interface CatalogBridgePreparationCaptureArguments {
  readonly drainPolicyPath: string;
  readonly drainPolicySha256: string;
  readonly sourceCensusPath: string;
  readonly sourceCensusSha256: string;
  readonly outputPath: string;
}

export interface CatalogBridgePreparationInput {
  readonly pins: CatalogBridgeOperationPins;
  readonly observation: CatalogBridgePreflightObservation;
}

function safeAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value && !/[\r\n\0]/u.test(value);
}

export function parseCatalogBridgePreparationCaptureArguments(
  argv: readonly string[],
): CatalogBridgePreparationCaptureArguments {
  if (argv[0] !== "--capture") {
    refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_ARGUMENTS_INVALID");
  }
  const allowed = new Set(["--drain-policy-file", "--drain-policy-sha256",
    "--source-census-file", "--source-census-sha256", "--output"]);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.has(flag) || values.has(flag) || !value || value.startsWith("--")) {
      refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_ARGUMENTS_INVALID");
    }
    values.set(flag, value);
  }
  const paths = [values.get("--drain-policy-file") ?? "",
    values.get("--source-census-file") ?? "", values.get("--output") ?? ""];
  if (values.size !== allowed.size || argv.length !== 1 + allowed.size * 2 ||
    paths.some((value) => !safeAbsolutePath(value)) || new Set(paths).size !== paths.length ||
    !sha256Pattern.test(values.get("--drain-policy-sha256") ?? "") ||
    !sha256Pattern.test(values.get("--source-census-sha256") ?? "")) {
    refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_ARGUMENTS_INVALID");
  }
  return Object.freeze({ drainPolicyPath: values.get("--drain-policy-file")!,
    drainPolicySha256: values.get("--drain-policy-sha256")!,
    sourceCensusPath: values.get("--source-census-file")!,
    sourceCensusSha256: values.get("--source-census-sha256")!,
    outputPath: values.get("--output")! });
}

export async function captureCatalogBridgeSourceCanaries(input: Readonly<{
  authority: ResolvedDataforrestSourceAuthority;
  savedEventCursor: unknown;
  savedEventCursorHash: string;
  captureResponse?: typeof captureHardenedProviderResponse;
  now?: () => Date;
}>): Promise<CatalogBridgePreflightObservation["sourceCanaries"]> {
  const definition = catalogBridgeProvider(input.authority.providerKey);
  const cursor = opaqueCursorEnvelopeSchema.safeParse(input.savedEventCursor);
  if (!cursor.success || cursor.data.value === null ||
    cursor.data.sourceRevisionId !== definition.currentConfigId ||
    cursor.data.adapterVersion !== definition.currentEventManifest.adapterVersion) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CANARY_CURSOR_INVALID");
  }
  const captureResponse = input.captureResponse ?? captureHardenedProviderResponse;
  const now = input.now ?? (() => new Date());
  const capture = async (manifest: SourceAdapterManifestV1, stream: "catalog" | "event",
    requestedCursor: string | null) => {
    const page = await inspectCatalogBridgeSourcePage({ authority: input.authority,
      manifest, stream, cursor: requestedCursor, captureResponse,
      signal: new AbortController().signal, now });
    if (page.inspection.outcomes.some((outcome) => outcome.status !== "valid")) {
      refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CANARY_RESPONSE_INVALID");
    }
    return page;
  };
  const catalog = await capture(definition.catalogManifest, "catalog", null);
  const cardCount = catalog.inspection.outcomes.filter((outcome) =>
    outcome.status === "valid" && outcome.observation.kind === "catalog" &&
    outcome.observation.entity === "card").length;
  const packCount = catalog.inspection.outcomes.filter((outcome) =>
    outcome.status === "valid" && outcome.observation.kind === "catalog" &&
    outcome.observation.entity === "pack").length;
  const pullCount = catalog.inspection.outcomes.filter((outcome) =>
    outcome.status === "valid" && outcome.observation.kind === "pull").length;
  const tradeCount = catalog.inspection.outcomes.filter((outcome) =>
    outcome.status === "valid" && outcome.observation.kind === "trade").length;
  const event = await capture(
    definition.eventSuccessorManifest,
    "event",
    cursor.data.value,
  );
  return Object.freeze({
    catalogOrigin: Object.freeze({ adapterVersion: definition.catalogAdapterVersion,
      requestedCursorHash: null, status: catalog.status,
      recordCount: catalog.inspection.recordCount, cardCount, packCount, pullCount, tradeCount,
      responseSha256: catalog.responseSha256, nextCursorHash: catalog.nextCursorHash,
      checkedAt: catalog.checkedAt, responseBytes: catalog.responseBytes,
      durationMilliseconds: catalog.durationMilliseconds }),
    savedEventCursor: Object.freeze({
      adapterVersion: definition.eventSuccessorManifest.adapterVersion,
      requestedCursorHash: input.savedEventCursorHash,
      opaqueValueHash: catalogBridgeDigest(cursor.data.value), status: event.status,
      recordCount: event.inspection.recordCount, responseSha256: event.responseSha256,
      checkedAt: event.checkedAt, responseBytes: event.responseBytes,
      durationMilliseconds: event.durationMilliseconds }),
  });
}

export function buildCatalogBridgePreparationInput(input: Readonly<{
  pins: CatalogBridgeOperationPins;
  repository: CatalogBridgePreflightObservation["repository"];
  boundary: CatalogBridgeDrainBoundary;
  authority: CatalogBridgeLiveCentralAuthority;
  sourceCredentialDigest: string;
  pause: CatalogBridgePauseCommand;
  receipt: NonNullable<Awaited<ReturnType<typeof readCatalogBridgeDrainReceiptIfPresent>>>;
  sourceCanaries: CatalogBridgePreflightObservation["sourceCanaries"];
  sourceCensus: Readonly<{ proof: CatalogBridgeSourceCensus; fileSha256: string;
    proofDigest: string }>;
  baseline: CatalogBridgeCanonicalEvidence;
}>): CatalogBridgePreparationInput {
  const boundary = input.boundary;
  const lastPage = boundary.lastPage;
  if (lastPage === null) refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_PAGE_MISSING");
  if (input.pause.targetRunId !== null || input.pause.targetQuarantineId !== null ||
    input.pause.resultingRunId !== null) {
    refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_PAUSE_INVALID");
  }
  const observation: CatalogBridgePreflightObservation = Object.freeze({
    observedAt: boundary.observedAt,
    repository: input.repository,
    worker: Object.freeze({ launchdLabel: boundary.process.launchdLabel,
      gracefullyUnloaded: !boundary.process.launchdLoaded, processCount: boundary.process.processCount,
      residencyPortListening: boundary.process.residencyPortListening,
      gracefulStopReceiptSha256: catalogBridgeDigest(input.receipt),
      gracefulStopReceipt: input.receipt }),
    central: Object.freeze({ ...boundary.central,
      sourceCredentialDigest: input.sourceCredentialDigest,
      databaseRouteDigest: input.authority.routeDigest }),
    runtime: Object.freeze({ providerId: boundary.runtime.providerId,
      providerKey: boundary.runtime.providerKey, databaseName: boundary.runtime.databaseName,
      databasePort: boundary.runtime.databasePort, databaseRole: boundary.runtime.databaseRole,
      schemaVersion: boundary.runtime.schemaVersion, runtimeState: boundary.runtime.state,
      generation: boundary.runtime.generation, rowVersion: boundary.runtime.rowVersion,
      cachedConfigId: boundary.runtime.cachedConfigId,
      cachedConfigNumber: boundary.runtime.cachedConfigNumber,
      cachedConfiguration: boundary.runtime.cachedConfiguration,
      sourceCursor: boundary.runtime.sourceCursor, sourceCursorHash: boundary.runtime.sourceCursorHash,
      activeRunCount: boundary.runtime.activeRunCount,
      actionableCommandCount: boundary.runtime.actionableCommandCount,
      importLeaseOwner: boundary.importLease.owner,
      otherOwnedLeaseCount: boundary.runtime.otherOwnedLeaseCount,
      otherActiveTransactionCount: boundary.runtime.otherActiveTransactionCount,
      pauseProvenance: Object.freeze({ commandId: input.pause.id,
        commandDigest: input.receipt.pause.commandDigest,
        commandType: input.pause.commandType, commandState: input.pause.state,
        idempotencyKey: input.pause.idempotencyKey, targetRunId: null,
        targetQuarantineId: null, resultingRunId: null,
        requestedByOperatorId: input.pause.requestedByOperatorId,
        expectedGeneration: input.pause.expectedGeneration,
        resultOutcome: input.pause.resultOutcome, resultCode: input.pause.resultCode,
        resultGeneration: input.pause.resultGeneration, correlationId: input.pause.correlationId,
        reason: input.pause.reason, requestedAt: input.pause.requestedAt,
        completedAt: input.pause.completedAt }),
      latestTerminalRun: Object.freeze({ terminalKind: input.receipt.terminal.kind,
        runId: boundary.run.id, runDigest: boundary.run.runDigest, state: boundary.run.state,
        finishedAt: boundary.run.finishedAt!, failureCode: boundary.run.failureCode,
        reachedSourceHead: boundary.run.reachedSourceHead,
        headProofDigest: boundary.headProof?.proofDigest ?? null,
        pageCount: boundary.run.pageCount, finalCursorHash: boundary.run.finalCursorHash,
        lastPageNumber: lastPage.pageNumber, lastPageCursorHash: lastPage.nextCursorHash,
        lastPageContinuation: lastPage.continuation, lastPageDigest: lastPage.lastPageDigest }),
    }),
    sourceCanaries: input.sourceCanaries,
    sourceCensus: input.sourceCensus,
    baseline: input.baseline,
  });
  const document = Object.freeze({ pins: input.pins, observation });
  prepareCatalogBridge(document);
  return document;
}

function assertDrainedBoundary(boundary: CatalogBridgeDrainBoundary,
  policy: Awaited<ReturnType<typeof readCatalogBridgeLiveDrainPolicy>>,
  receipt: NonNullable<Awaited<ReturnType<typeof readCatalogBridgeDrainReceiptIfPresent>>>): void {
  assertCatalogBridgeProcessOffline(boundary);
  const terminalKind = assertCatalogBridgePausedDrain(boundary,
    catalogBridgeLiveDrainPins(policy), { runId: receipt.terminal.runId,
      runFence: receipt.terminal.runFence, generation: receipt.pause.resultGeneration });
  if (terminalKind !== receipt.terminal.kind) {
    refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_TERMINAL_CHANGED");
  }
}

export async function captureCatalogBridgePreparation(input: Readonly<{
  args: CatalogBridgePreparationCaptureArguments;
  environment?: NodeJS.ProcessEnv;
}>): Promise<Readonly<Record<string, unknown>>> {
  const policy = await readCatalogBridgeLiveDrainPolicy(input.args.drainPolicyPath);
  if (catalogBridgeLiveDrainPolicyDigest(policy) !== input.args.drainPolicySha256) {
    refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_POLICY_DIGEST_MISMATCH");
  }
  if (policy.providerKey !== "collector_crypt") {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_PROVIDER_UNSUPPORTED");
  }
  const checkout = await observeCatalogBridgeCheckout({ checkout: policy.executor.checkout,
    expectedCommit: policy.executor.commit, executingRoot: catalogBridgeRepositoryRoot(import.meta.url),
    modules: { runner: runnerModule, plan: planModule } });
  if (checkout.moduleSha256.runner !== policy.executor.runnerModuleSha256) {
    refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_EXECUTOR_CHANGED");
  }
  const sourceCensus = await readCatalogBridgeSourceCensus(
    input.args.sourceCensusPath,
    input.args.sourceCensusSha256,
  );
  const sourceCensusProofDigest = catalogBridgeSourceCensusDigest(sourceCensus.proof);
  if (sourceCensus.proof.operationId !== policy.operationId ||
    sourceCensus.proof.providerKey !== policy.providerKey ||
    sourceCensus.proof.executor.checkout !== policy.executor.checkout ||
    sourceCensus.proof.executor.commit !== policy.executor.commit) {
    refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_CENSUS_INVALID");
  }
  const receipt = await readCatalogBridgeDrainReceiptIfPresent(policy.receiptPath);
  if (receipt === null || receipt.operationId !== policy.operationId ||
    receipt.providerKey !== policy.providerKey || receipt.operatorId !== policy.operatorId) {
    refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_RECEIPT_INVALID");
  }
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
    maximumCachedProviders: 1, operationProfile: "atomic_import_page", connectionTimeoutMs: 5_000,
    operationTimeoutMs: 600_000, closeTimeoutMs: 10_000 });
  try {
    await central.start();
    const readAuthority = () => central.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'");
      return readCatalogBridgeLiveCentralAuthority({ central: transaction, policy });
    }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 15_000 });
    const macos = createCatalogBridgeMacosProcessAdapter({ providerKey: policy.providerKey,
      authorizeBootout: async () =>
        refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_BOOTOUT_FORBIDDEN") });
    const database = createCatalogBridgeLiveDatabaseAdapter({ policy, dependencies: { readAuthority,
      runProvider: (route, operation) => gateway.runWithCachedProviderDatabase(route, operation),
      observeProcess: () => macos.observe() } });
    const before = await database.readBoundaryReadOnly();
    assertDrainedBoundary(before, policy, receipt);
    const pause = await database.readPauseCommand(receipt.pause.commandId);
    if (pause === null) refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_PAUSE_MISSING");
    const authority = await readAuthority();
    const canonical = await gateway.runWithCachedProviderDatabase(authority.route,
      (providerDatabase) => readCatalogBridgeCanonicalEvidenceUnlocked(providerDatabase,
        canonicalEvidenceTimeoutMilliseconds));
    if (canonical.state !== "reachable" || canonical.value === undefined) {
      refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_PROVIDER_UNAVAILABLE");
    }
    const definition = catalogBridgeProvider(policy.providerKey);
    const resolver = new CentralDataforrestSourceAuthorityResolver({ central: central.client,
      credentialCipher: cipher });
    const sourceAuthority = await resolver.resolve({ providerId: definition.providerId,
      providerKey: definition.providerKey, configVersionId: definition.currentConfigId,
      configVersionNumber: BigInt(definition.currentConfigNumber),
      adapterKey: definition.currentEventManifest.adapterVersion });
    const sourceCredentialDigest = catalogBridgeSourceCredentialDigest(sourceAuthority);
    if (sourceCensus.proof.source.sourceCredentialDigest !== sourceCredentialDigest) {
      refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_CENSUS_INVALID");
    }
    const canaries = await captureCatalogBridgeSourceCanaries({ authority: sourceAuthority,
      savedEventCursor: before.runtime.sourceCursor,
      savedEventCursorHash: before.runtime.sourceCursorHash });
    const after = await database.readBoundaryReadOnly();
    assertDrainedBoundary(after, policy, receipt);
    if (catalogBridgeDigest(catalogBridgeDrainStableDatabaseEvidence(before)) !==
      catalogBridgeDigest(catalogBridgeDrainStableDatabaseEvidence(after))) {
      refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_BOUNDARY_CHANGED");
    }
    const confirmedSourceAuthority = await resolver.resolve({ providerId: definition.providerId,
      providerKey: definition.providerKey, configVersionId: definition.currentConfigId,
      configVersionNumber: BigInt(definition.currentConfigNumber),
      adapterKey: definition.currentEventManifest.adapterVersion });
    if (catalogBridgeSourceCredentialDigest(confirmedSourceAuthority) !== sourceCredentialDigest) {
      refuseCatalogBridge("CATALOG_BRIDGE_PREPARATION_CAPTURE_CREDENTIAL_CHANGED");
    }
    const pins: CatalogBridgeOperationPins = Object.freeze({ operationId: policy.operationId,
      providerKey: policy.providerKey, operatorId: policy.operatorId,
      residentCheckout: policy.executor.checkout, residentCommit: policy.executor.commit,
      utilityModuleSha256: checkout.moduleSha256.plan!,
      sourceHeadCountProvenance: "two_pass_read_only_catalog_census_v1",
      sourceHeadCounts: Object.freeze({ card: sourceCensus.proof.agreement.cardCount,
        pack: sourceCensus.proof.agreement.packCount }),
      sourceHeadCensusFileSha256: sourceCensus.fileSha256,
      sourceHeadCensusProofDigest,
      sourceHeadIdentityMultisetDigest: sourceCensus.proof.agreement.identityMultisetDigest });
    const document = buildCatalogBridgePreparationInput({ pins,
      repository: Object.freeze({ checkout: pins.residentCheckout,
        expectedCommit: pins.residentCommit, observedCommit: checkout.commit,
        clean: true, utilityModuleSha256: pins.utilityModuleSha256 }),
      boundary: after, authority, sourceCredentialDigest, pause, receipt,
      sourceCanaries: canaries,
      sourceCensus: Object.freeze({ proof: sourceCensus.proof,
        fileSha256: sourceCensus.fileSha256, proofDigest: sourceCensusProofDigest }),
      baseline: canonical.value });
    const persisted = await persistCatalogBridgePreparationInput(input.args.outputPath, document);
    return Object.freeze({ outcome: persisted.exactRetry ? "already_captured" : "captured",
      operationId: pins.operationId, providerKey: pins.providerKey,
      preparationInputSha256: persisted.sha256,
      sourceCensusProofDigest: pins.sourceHeadCensusProofDigest,
      databaseWritesPerformed: false,
      sourceRequestsPerformed: true, sourceRequestCount: 2,
      launchctlMutationsPerformed: false });
  } finally {
    try { await gateway.close(); } finally {
      try { await central.close(); } finally { environment.credentialKey.fill(0); }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => captureCatalogBridgePreparation({
    args: parseCatalogBridgePreparationCaptureArguments(process.argv.slice(2)),
  })).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`), (error: unknown) => {
    process.stderr.write(`${JSON.stringify({ outcome: "refused", code: error instanceof CatalogBridgeError
      ? error.code : "CATALOG_BRIDGE_PREPARATION_CAPTURE_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
