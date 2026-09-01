import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoundedProviderDatabaseGateway,
  createCentralDatabaseLifecycle,
  readDatabaseRuntimePolicy,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
} from "@packscout/services";
import { drainCatalogBridgeProvider } from "./dataforrest-catalog-bridge-drain.mts";
import {
  assertCatalogBridgeIdleHead,
  assertCatalogBridgePausedDrain,
  type CatalogBridgeDrainProcessObservation,
} from "./dataforrest-catalog-bridge-drain-policy.mts";
import {
  persistCatalogBridgeDrainReceipt,
  readCatalogBridgeDrainReceiptIfPresent,
} from "./dataforrest-catalog-bridge-drain-journal.mts";
import {
  createCatalogBridgeLiveDatabaseAdapter,
  readCatalogBridgeLiveCentralAuthority,
  type CatalogBridgeLiveDatabaseAdapter,
} from "./dataforrest-catalog-bridge-drain-live-database.mts";
import { createCatalogBridgeMacosProcessAdapter } from "./dataforrest-catalog-bridge-drain-macos.mts";
import {
  assertCatalogBridgeLiveDrainInitialBoundary,
  catalogBridgeLiveDrainPins,
  catalogBridgeLiveDrainPolicyDigest,
  readCatalogBridgeLiveDrainPolicy,
} from "./dataforrest-catalog-bridge-drain-live-policy.mts";
import { CatalogBridgeError, catalogBridgeDigest, refuseCatalogBridge } from "./dataforrest-catalog-bridge-plan.mts";

const sha256 = /^[a-f0-9]{64}$/u;

export interface CatalogBridgeLiveDrainEnvironment {
  readonly centralDatabaseUrl: string;
  readonly credentialKey: Buffer;
  readonly credentialKeyVersion: number;
  readonly runtimePolicy: ReturnType<typeof readDatabaseRuntimePolicy>;
}

export function readCatalogBridgeLiveDrainEnvironment(environment: NodeJS.ProcessEnv = process.env):
  CatalogBridgeLiveDrainEnvironment {
  if (environment.NODE_ENV !== "production") refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_PRODUCTION_REQUIRED");
  const centralDatabaseUrl = environment.PACKSCOUT_CENTRAL_DATABASE_URL ?? "";
  let runtimePolicy: ReturnType<typeof readDatabaseRuntimePolicy>;
  try {
    runtimePolicy = readDatabaseRuntimePolicy(environment);
    runtimePolicy.assertCentralDatabaseUrl(centralDatabaseUrl);
  } catch {
    return refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_DATABASE_POLICY_INVALID");
  }
  if (runtimePolicy.mode !== "remote") refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_REMOTE_DATABASE_REQUIRED");
  const encoded = environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64 ?? "";
  const credentialKey = Buffer.from(encoded, "base64");
  const credentialKeyVersion = Number(environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION ?? "");
  if (credentialKey.length !== 32 || credentialKey.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "") ||
    !Number.isSafeInteger(credentialKeyVersion) || credentialKeyVersion < 1) {
    credentialKey.fill(0);
    refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_CREDENTIAL_POLICY_INVALID");
  }
  return Object.freeze({ centralDatabaseUrl, credentialKey, credentialKeyVersion, runtimePolicy });
}

export type CatalogBridgeLiveDrainArguments = Readonly<{
  mode: "check_only" | "apply";
  policyPath: string;
  policySha256: string | null;
}>;

export function parseCatalogBridgeLiveDrainArguments(args: readonly string[]): CatalogBridgeLiveDrainArguments {
  const mode = args[0] === "--check-only" ? "check_only" : args[0] === "--apply" ? "apply" : null;
  if (!mode || args[1] !== "--policy-file" || !args[2] || !path.isAbsolute(args[2]) || /[\r\n\0]/u.test(args[2])) {
    refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_ARGUMENTS_INVALID");
  }
  if (mode === "check_only" && args.length !== 3) {
    refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_ARGUMENTS_INVALID");
  }
  if (mode === "apply" && (args.length !== 5 || args[3] !== "--policy-sha256" || !sha256.test(args[4] ?? ""))) {
    refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_ARGUMENTS_INVALID");
  }
  return Object.freeze({ mode, policyPath: args[2], policySha256: mode === "apply" ? args[4]! : null });
}

function authorizeBootout(database: CatalogBridgeLiveDatabaseAdapter,
  pins: ReturnType<typeof catalogBridgeLiveDrainPins>, policy: Awaited<ReturnType<typeof readCatalogBridgeLiveDrainPolicy>>) {
  return async (expected: Readonly<{ launchdLabel: string; expectedPid: number;
    expectedProcessIdentitySha256: string }>): Promise<CatalogBridgeDrainProcessObservation> => {
    const boundary = await database.readBoundary();
    const expectedGeneration = policy.entryKind === "running"
      ? (BigInt(policy.runtimeGeneration) + 1n).toString() : policy.runtimeGeneration;
    if (boundary.runtime.state === "paused") {
      assertCatalogBridgePausedDrain(boundary, pins, { runId: policy.runId, runFence: policy.runFence,
        generation: expectedGeneration });
    } else if (boundary.runtime.state === "idle") {
      assertCatalogBridgeIdleHead(boundary, pins, { runId: policy.runId, runFence: policy.runFence,
        generation: expectedGeneration });
    } else {
      refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_BOOTOUT_NOT_AUTHORIZED");
    }
    if (boundary.process.launchdLabel !== expected.launchdLabel || boundary.process.pids[0] !== expected.expectedPid ||
      boundary.process.processIdentitySha256 !== expected.expectedProcessIdentitySha256) {
      refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_NOT_EXACT");
    }
    return boundary.process;
  };
}

export async function runCatalogBridgeLiveDrain(argumentsValue: CatalogBridgeLiveDrainArguments,
  environmentValue: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const policy = await readCatalogBridgeLiveDrainPolicy(argumentsValue.policyPath);
  const policyDigest = catalogBridgeLiveDrainPolicyDigest(policy);
  if (argumentsValue.mode === "apply" && argumentsValue.policySha256 !== policyDigest) {
    refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_POLICY_DIGEST_MISMATCH");
  }
  const environment = readCatalogBridgeLiveDrainEnvironment(environmentValue);
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
  let database: CatalogBridgeLiveDatabaseAdapter | null = null;
  try {
    await central.start();
    const readAuthority = () => central.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'");
      return readCatalogBridgeLiveCentralAuthority({ central: transaction, policy });
    }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 15_000 });
    const macos = createCatalogBridgeMacosProcessAdapter({ providerKey: policy.providerKey,
      bootoutPollMilliseconds: policy.bootoutPollMilliseconds,
      bootoutTimeoutMilliseconds: policy.bootoutTimeoutMilliseconds,
      authorizeBootout: (expected) => {
        if (!database) refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_ADAPTER_UNAVAILABLE");
        return authorizeBootout(database, catalogBridgeLiveDrainPins(policy), policy)(expected);
      } });
    database = createCatalogBridgeLiveDatabaseAdapter({ policy, dependencies: { readAuthority,
      runProvider: (route, operation) => gateway.runWithCachedProviderDatabase(route, operation),
      observeProcess: () => macos.observe() } });
    if (argumentsValue.mode === "check_only") {
      const boundary = await database.readBoundaryReadOnly();
      assertCatalogBridgeLiveDrainInitialBoundary(policy, boundary);
      return Object.freeze({ outcome: "ready", mode: "check_only", operationId: policy.operationId,
        providerKey: policy.providerKey, policySha256: policyDigest,
        boundaryEvidenceSha256: catalogBridgeDigest(boundary), authorityDigest: boundary.central.authorityDigest,
        runtimeGeneration: boundary.runtime.generation, runtimeRowVersion: boundary.runtime.rowVersion,
        runId: boundary.run.id, runFence: boundary.run.workerFence, sourceCursorHash: boundary.runtime.sourceCursorHash,
        processPid: boundary.process.pids[0], processIdentitySha256: boundary.process.processIdentitySha256,
        databaseWritesPerformed: false, launchctlBootoutPerformed: false });
    }

    const fileReceipt = await readCatalogBridgeDrainReceiptIfPresent(policy.receiptPath);
    const databaseReceipt = await database.readPersistedReceipt();
    if (fileReceipt && databaseReceipt && catalogBridgeDigest(fileReceipt) !== catalogBridgeDigest(databaseReceipt)) {
      refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_RECEIPT_CONFLICT");
    }
    let existingReceipt = fileReceipt ?? databaseReceipt;
    if (databaseReceipt && !fileReceipt) {
      await persistCatalogBridgeDrainReceipt(policy.receiptPath, databaseReceipt);
    } else if (fileReceipt && !databaseReceipt) {
      await database.readBoundary();
      await database.persistReceipt(fileReceipt);
    }
    let initialBoundary = existingReceipt === null;
    const result = await drainCatalogBridgeProvider({ pins: catalogBridgeLiveDrainPins(policy),
      options: { maximumObservations: policy.maximumObservations, pollMilliseconds: policy.pollMilliseconds },
      dependencies: {
        readExistingReceipt: async () => existingReceipt,
        readBoundary: async () => {
          const boundary = await database!.readBoundary();
          if (initialBoundary) {
            assertCatalogBridgeLiveDrainInitialBoundary(policy, boundary);
            initialBoundary = false;
          }
          return boundary;
        },
        recordPauseIntent: (intent) => database!.recordPauseIntent(intent),
        submitPause: (intent) => database!.submitPause(intent),
        readPauseCommand: (commandId) => database!.readPauseCommand(commandId),
        bootout: (expected) => macos.bootout(expected),
        wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        persistReceipt: async (receipt) => {
          const persistedDatabase = await database!.persistReceipt(receipt);
          const persistedFile = await persistCatalogBridgeDrainReceipt(policy.receiptPath, receipt);
          existingReceipt = receipt;
          return Object.freeze({ sha256: persistedDatabase.sha256,
            exactRetry: persistedDatabase.exactRetry && persistedFile.exactRetry });
        },
      } });
    return Object.freeze({ ...result, mode: "apply", policySha256: policyDigest });
  } finally {
    try { await gateway.close(); } finally {
      try { await central.close(); } finally { environment.credentialKey.fill(0); }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => runCatalogBridgeLiveDrain(parseCatalogBridgeLiveDrainArguments(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`), (error: unknown) => {
      process.stderr.write(`${JSON.stringify({ outcome: "refused", code: error instanceof CatalogBridgeError
        ? error.code : "CATALOG_BRIDGE_LIVE_DRAIN_FAILED" })}\n`);
      process.exitCode = 1;
    });
}
