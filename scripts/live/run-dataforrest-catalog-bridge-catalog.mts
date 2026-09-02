#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
import { runCatalogBridgeCatalogStage } from
  "./dataforrest-catalog-bridge-catalog.mts";
import { runCatalogBridgeEventResumeStage } from
  "./dataforrest-catalog-bridge-event-resume.mts";
import { createCatalogBridgeCatalogLiveDatabaseAdapter } from
  "./dataforrest-catalog-bridge-catalog-live-database.mts";
import { createCatalogBridgeMacosBootstrapAdapter } from
  "./dataforrest-catalog-bridge-bootstrap-macos.mts";
import { createCatalogBridgeEventLiveOrchestrator } from
  "./dataforrest-catalog-bridge-event-live.mts";
import {
  catalogBridgeCatalogLivePolicyDigest,
  readCatalogBridgeCatalogLivePolicy,
} from "./dataforrest-catalog-bridge-catalog-live-policy.mts";
import {
  catalogBridgeCapabilityProofDigest,
  readCatalogBridgeCapabilityProof,
} from "./dataforrest-catalog-bridge-capability-proof.mts";
import { createCatalogBridgeCatalogOneShotExecutor } from
  "./dataforrest-catalog-bridge-catalog-one-shot.mts";
import {
  persistCatalogBridgeJournal,
  readPreparedCatalogBridge,
} from "./dataforrest-catalog-bridge-journal.mts";
import { createCatalogBridgeMacosProcessAdapter } from
  "./dataforrest-catalog-bridge-drain-macos.mts";
import {
  CatalogBridgeError,
  refuseCatalogBridge,
} from "./dataforrest-catalog-bridge-plan.mts";

const sha256 = /^[a-f0-9]{64}$/u;

export function parseCatalogBridgeCatalogArguments(args: readonly string[]) {
  const mode = args[0] === "--check-only" ? "check_only" :
    args[0] === "--apply" ? "apply" : null;
  if (!mode || args[1] !== "--policy-file" || !args[2] ||
    !path.isAbsolute(args[2]) || /[\r\n\0]/u.test(args[2])) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ARGUMENTS_INVALID");
  }
  if (mode === "check_only" && args.length !== 3) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ARGUMENTS_INVALID");
  }
  if (mode === "apply" && (args.length !== 5 || args[3] !== "--policy-sha256" ||
    !sha256.test(args[4] ?? ""))) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ARGUMENTS_INVALID");
  }
  return Object.freeze({ mode, policyPath: args[2],
    policySha256: mode === "apply" ? args[4]! : null });
}

export async function runAfterCatalogBridgeSuccessorCheck<T>(input: Readonly<{
  check(): Promise<void>;
  action(): Promise<T>;
}>): Promise<T> {
  await input.check();
  return input.action();
}

function readEnvironment(environment: NodeJS.ProcessEnv) {
  if (environment.NODE_ENV !== "production") {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PRODUCTION_REQUIRED");
  }
  const centralDatabaseUrl = environment.PACKSCOUT_CENTRAL_DATABASE_URL ?? "";
  let runtimePolicy: ReturnType<typeof readDatabaseRuntimePolicy>;
  try {
    runtimePolicy = readDatabaseRuntimePolicy(environment);
    runtimePolicy.assertCentralDatabaseUrl(centralDatabaseUrl);
  } catch {
    return refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_DATABASE_POLICY_INVALID");
  }
  if (runtimePolicy.mode !== "remote") {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_REMOTE_DATABASE_REQUIRED");
  }
  const encoded = environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64 ?? "";
  const key = Buffer.from(encoded, "base64");
  const version = Number(environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION ?? "");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/u, "") !==
    encoded.replace(/=+$/u, "") || !Number.isSafeInteger(version) || version < 1) {
    key.fill(0);
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_CREDENTIAL_POLICY_INVALID");
  }
  return Object.freeze({ centralDatabaseUrl, runtimePolicy, key, version });
}

async function assertResidentModules(input: Readonly<{
  checkout: string; commit: string; utilityModuleSha256: string;
  oneShotModuleSha256: string; residentModuleSha256: string;
}>): Promise<void> {
  const currentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const planPath = path.join(input.checkout, "scripts/live/dataforrest-catalog-bridge-plan.mts");
  const oneShotPath = path.join(input.checkout,
    "scripts/live/dataforrest-catalog-bridge-catalog-one-shot.mts");
  const residentPath = path.join(input.checkout,
    "scripts/local/run-provider-continuous-poller.mts");
  try {
    const observedCommit = execFileSync("git", ["-C", input.checkout, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const status = execFileSync("git", ["-C", input.checkout, "status", "--porcelain=v1",
      "--untracked-files=normal"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const [plan, oneShot, resident] = await Promise.all([
      readFile(planPath), readFile(oneShotPath), readFile(residentPath),
    ]);
    if (path.resolve(input.checkout) !== currentRoot || observedCommit !== input.commit ||
      status.length !== 0 ||
      createHash("sha256").update(plan).digest("hex") !== input.utilityModuleSha256 ||
      createHash("sha256").update(oneShot).digest("hex") !== input.oneShotModuleSha256 ||
      createHash("sha256").update(resident).digest("hex") !== input.residentModuleSha256) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RESIDENT_DRIFT");
    }
  } catch (error) {
    if (error instanceof CatalogBridgeError) throw error;
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RESIDENT_UNAVAILABLE");
  }
}

export async function runCatalogBridgeCatalogLive(input: Readonly<{
  args: ReturnType<typeof parseCatalogBridgeCatalogArguments>;
  environment?: NodeJS.ProcessEnv;
}>): Promise<unknown> {
  const policy = await readCatalogBridgeCatalogLivePolicy(input.args.policyPath);
  const policySha256 = catalogBridgeCatalogLivePolicyDigest(policy);
  if (input.args.mode === "apply" && input.args.policySha256 !== policySha256) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_POLICY_DIGEST_MISMATCH");
  }
  const capabilityDocument = await readCatalogBridgeCapabilityProof(policy.capabilityProof.path);
  const capabilityProof = capabilityDocument.proof;
  if (capabilityDocument.fileSha256 !== policy.capabilityProof.fileSha256 ||
    catalogBridgeCapabilityProofDigest(capabilityProof) !== policy.capabilityProof.proofDigest ||
    !capabilityProof.providers.some((entry) => entry.providerId === policy.current.providerId &&
      entry.providerKey === policy.pins.providerKey && entry.sha256ByteaAvailable)) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_CAPABILITY_PROOF_CHANGED");
  }
  await assertResidentModules({ checkout: policy.pins.residentCheckout,
    commit: policy.pins.residentCommit, utilityModuleSha256: policy.pins.utilityModuleSha256,
    oneShotModuleSha256: policy.utility.oneShotModuleSha256,
    residentModuleSha256: policy.successorLaunchAgent.residentModuleSha256 });
  const prepared = await readPreparedCatalogBridge(policy.journalDirectory);
  const environment = readEnvironment(input.environment ?? process.env);
  const centralUrl = new URL(environment.centralDatabaseUrl);
  centralUrl.searchParams.set("connect_timeout", "5");
  centralUrl.searchParams.set("pool_timeout", "5");
  const central = createCentralDatabaseLifecycle({ databaseUrl: centralUrl.toString(),
    connectionLimit: 1 });
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.version,
    keys: new Map([[environment.version, environment.key]]) });
  const gateway = new BoundedProviderDatabaseGateway({ central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: environment.runtimePolicy.destinationPolicy,
    connectionLimitPerProvider: 1, maximumCachedProviders: 1,
    operationProfile: "atomic_import_page", connectionTimeoutMs: 5_000,
    operationTimeoutMs: 600_000, closeTimeoutMs: 10_000 });
  try {
    await central.start();
    const processAdapter = createCatalogBridgeMacosProcessAdapter({
      providerKey: policy.pins.providerKey,
      authorizeBootout: async () =>
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_BOOTOUT_FORBIDDEN"),
    });
    const residentOffline = async () => {
      const observation = await processAdapter.observe();
      return !observation.launchdLoaded && observation.processCount === 0 &&
        observation.pids.length === 0 && !observation.residencyPortListening;
    };
    const bootstrap = createCatalogBridgeMacosBootstrapAdapter({ policy,
      state: prepared.privateState, observeProcess: () => processAdapter.observe() });
    const oneShot = createCatalogBridgeCatalogOneShotExecutor({
      central: central.client, gateway, credentialCipher: cipher,
      timeoutMilliseconds: policy.utility.executionTimeoutMilliseconds,
    });
    const database = createCatalogBridgeCatalogLiveDatabaseAdapter({
      policy, state: prepared.privateState,
      dependencies: { central: central.client,
        runProvider: (route, operation) => gateway.runWithCachedProviderDatabase(route, operation),
        residentOffline, executeOneShot: oneShot },
    });
    const persistJournal = async ({ expected, next }: Readonly<{
      expected: Parameters<typeof persistCatalogBridgeJournal>[0]["expected"];
      next: Parameters<typeof persistCatalogBridgeJournal>[0]["next"];
    }>) => (await persistCatalogBridgeJournal({ directory: policy.journalDirectory,
      expected, next })).commit;
    const catalogPhases = new Set(["prepared", "catalog_activated",
      "catalog_run_admitted", "catalog_completed"]);
    let snapshot = prepared;
    let catalogResult: Readonly<Record<string, unknown>> | null = null;
    if (catalogPhases.has(snapshot.journal.phase) &&
      !(input.args.mode === "check_only" && snapshot.journal.phase === "catalog_completed")) {
      catalogResult = await runAfterCatalogBridgeSuccessorCheck({
        check: bootstrap.check,
        action: () => runCatalogBridgeCatalogStage({
          mode: input.args.mode, policy, state: snapshot.privateState,
          journal: snapshot.journal, commit: snapshot.commit,
          dependencies: { ...database, persistJournal },
        }),
      });
      if (input.args.mode === "check_only") {
        return Object.freeze({ ...catalogResult, policySha256 });
      }
      snapshot = await readPreparedCatalogBridge(policy.journalDirectory);
    }
    const eventLive = createCatalogBridgeEventLiveOrchestrator({ policy,
      state: snapshot.privateState, dependencies: { database, bootstrap,
        observeProcess: () => processAdapter.observe(),
        async bootoutExact(bootoutInput) {
          const recoveryProcess = createCatalogBridgeMacosProcessAdapter({
            providerKey: policy.pins.providerKey,
            authorizeBootout: bootoutInput.authorize,
          });
          await recoveryProcess.bootout({ launchdLabel: bootoutInput.launchdLabel,
            expectedPid: bootoutInput.expectedPid,
            expectedProcessIdentitySha256: bootoutInput.expectedProcessIdentitySha256 });
        } } });
    const eventDependencies = {
      readEventBoundary: eventLive.readEventBoundary,
      stageEventSuccessor: database.stageEventSuccessor,
      restoreEventCursor: database.restoreEventCursor,
      resumeResident: eventLive.resumeResident,
      readResumed: eventLive.readResumed,
      releaseResidentAfterJournal: database.releaseResidentAfterJournal,
      persistJournal,
      ensureResidentOfflineAndPaused: eventLive.ensureResidentOfflineAndPaused,
    };
    const eventResult = await runCatalogBridgeEventResumeStage({
      mode: input.args.mode, policy, state: snapshot.privateState,
      journal: snapshot.journal, commit: snapshot.commit,
      dependencies: eventDependencies,
    });
    return Object.freeze({ ...eventResult, policySha256,
      ...(catalogResult === null ? {} : { catalogStage: catalogResult }) });
  } finally {
    try { await gateway.close(); } finally {
      try { await central.close(); } finally { environment.key.fill(0); }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => runCatalogBridgeCatalogLive({
    args: parseCatalogBridgeCatalogArguments(process.argv.slice(2)),
  })).then((result) => process.stdout.write(JSON.stringify(result) + "\n"), (error: unknown) => {
    process.stderr.write(JSON.stringify({ outcome: "refused",
      code: error instanceof CatalogBridgeError ? error.code :
        "CATALOG_BRIDGE_CATALOG_LIVE_FAILED" }) + "\n");
    process.exitCode = 1;
  });
}
