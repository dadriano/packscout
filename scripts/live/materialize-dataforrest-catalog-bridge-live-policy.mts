#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProviderLaunchdPlan } from "../local/provider-launchd-plan.mts";
import {
  catalogBridgeCapabilityProofDigest,
  readCatalogBridgeCapabilityProof,
  type CatalogBridgeCapabilityProof,
} from "./dataforrest-catalog-bridge-capability-proof.mts";
import {
  catalogBridgeCatalogExecutionBudget,
  catalogBridgeCatalogLivePolicyDigest,
  catalogBridgeCatalogLivePolicySchema,
  type CatalogBridgeCatalogLivePolicy,
} from "./dataforrest-catalog-bridge-catalog-live-policy.mts";
import { readPreparedCatalogBridge, type CatalogBridgeJournalCommit } from
  "./dataforrest-catalog-bridge-journal.mts";
import {
  CatalogBridgeError,
  catalogBridgeConfigurationPlan,
  catalogBridgeDigest,
  catalogBridgeProvider,
  refuseCatalogBridge,
  type CatalogBridgePrivatePreparedState,
} from "./dataforrest-catalog-bridge-plan.mts";
import { catalogBridgeResumeRunId, type CatalogBridgePublicJournal } from
  "./dataforrest-catalog-bridge-state.mts";
import {
  catalogBridgePrivateJsonBytes,
  catalogBridgeRepositoryRoot,
  observeCatalogBridgeCheckout,
  persistCatalogBridgePrivateBytes,
} from "./dataforrest-catalog-bridge-operator-files.mts";

const planModule = "scripts/live/dataforrest-catalog-bridge-plan.mts";
const oneShotModule = "scripts/live/dataforrest-catalog-bridge-catalog-one-shot.mts";
const residentModule = "scripts/local/run-provider-continuous-poller.mts";

export interface CatalogBridgeLivePolicyMaterializationArguments {
  readonly journalDirectory: string;
  readonly capabilityProofPath: string;
  readonly nodePath: string;
  readonly logPath: string;
  readonly stagedPlistPath: string;
  readonly installedPlistPath: string;
  readonly outputPolicyPath: string;
}

function safeAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value && !/[\r\n\0]/u.test(value);
}

export function parseCatalogBridgeLivePolicyMaterializationArguments(
  argv: readonly string[],
): CatalogBridgeLivePolicyMaterializationArguments {
  if (argv[0] !== "--materialize") {
    refuseCatalogBridge("CATALOG_BRIDGE_POLICY_MATERIALIZATION_ARGUMENTS_INVALID");
  }
  const allowed = new Set(["--journal-directory", "--capability-proof", "--node-path",
    "--log-path", "--staged-plist-path", "--installed-plist-path", "--output-policy"]);
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.has(flag) || values.has(flag) || !value || value.startsWith("--")) {
      refuseCatalogBridge("CATALOG_BRIDGE_POLICY_MATERIALIZATION_ARGUMENTS_INVALID");
    }
    values.set(flag, value);
  }
  const paths = [...values.values()];
  if (values.size !== allowed.size || argv.length !== 1 + allowed.size * 2 ||
    paths.some((value) => !safeAbsolutePath(value)) || new Set(paths).size !== paths.length) {
    refuseCatalogBridge("CATALOG_BRIDGE_POLICY_MATERIALIZATION_ARGUMENTS_INVALID");
  }
  return Object.freeze({ journalDirectory: values.get("--journal-directory")!,
    capabilityProofPath: values.get("--capability-proof")!, nodePath: values.get("--node-path")!,
    logPath: values.get("--log-path")!, stagedPlistPath: values.get("--staged-plist-path")!,
    installedPlistPath: values.get("--installed-plist-path")!,
    outputPolicyPath: values.get("--output-policy")! });
}

export function buildCatalogBridgeSuccessorPlist(input: Readonly<{
  state: CatalogBridgePrivatePreparedState;
  nodePath: string;
  logPath: string;
}>): Readonly<{ plist: Buffer; arguments: readonly string[] }> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const configuration = catalogBridgeConfigurationPlan(input.state);
  const generated = createProviderLaunchdPlan({
    pins: { organizationId: definition.organizationId, providerId: definition.providerId,
      providerKey: definition.providerKey, configId: configuration.eventSuccessor.id,
      initialRunId: catalogBridgeResumeRunId(input.state.operationId, input.state.providerKey),
      operationId: input.state.operationId,
      operatorId: input.state.preflight.runtime.pauseProvenance.requestedByOperatorId },
    checkoutRoot: input.state.preflight.repository.checkout,
    nodeExecutable: input.nodePath,
    logPath: input.logPath,
    bootstrapBackfill: true,
    awaitInitialRun: true,
    platform: "darwin",
  });
  return Object.freeze({ plist: Buffer.from(generated.plist, "utf8"),
    arguments: Object.freeze([...generated.arguments]) });
}

type PreparedCatalogBridge = Readonly<{
  privateState: CatalogBridgePrivatePreparedState;
  journal: CatalogBridgePublicJournal;
  commit: CatalogBridgeJournalCommit;
}>;

export function buildCatalogBridgeCatalogLivePolicy(input: Readonly<{
  args: CatalogBridgeLivePolicyMaterializationArguments;
  prepared: PreparedCatalogBridge;
  capabilityProof: CatalogBridgeCapabilityProof;
  capabilityProofFileSha256: string;
  stagedPlistFileSha256: string;
  oneShotModuleSha256: string;
  residentModuleSha256: string;
}>): CatalogBridgeCatalogLivePolicy {
  const { privateState: state, journal, commit } = input.prepared;
  if (journal.phase !== "prepared" || journal.receipts.length !== 1 ||
    journal.receipts[0]?.phase !== "prepared" ||
    commit.privateStateSha256 !== catalogBridgeDigest(state) ||
    commit.publicJournalSha256 !== catalogBridgeDigest(journal)) {
    refuseCatalogBridge("CATALOG_BRIDGE_POLICY_MATERIALIZATION_JOURNAL_INVALID");
  }
  const preparedReceipt = journal.receipts[0];
  const sourceHeadCountProvenance = preparedReceipt.evidence.sourceHeadCountProvenance;
  const sourceHeadCardCount = preparedReceipt.evidence.sourceHeadCardCount;
  const sourceHeadPackCount = preparedReceipt.evidence.sourceHeadPackCount;
  const sourceHeadCensusFileSha256 = preparedReceipt.evidence.sourceHeadCensusFileSha256;
  const sourceHeadCensusProofDigest = preparedReceipt.evidence.sourceHeadCensusProofDigest;
  const sourceHeadIdentityMultisetDigest = preparedReceipt.evidence.sourceHeadIdentityMultisetDigest;
  const sha256 = (value: unknown): value is string =>
    typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  if (preparedReceipt.operationId !== state.operationId ||
    preparedReceipt.providerKey !== state.providerKey ||
    preparedReceipt.planDigest !== state.planDigest ||
    sourceHeadCountProvenance !== "two_pass_read_only_catalog_census_v1" ||
    typeof sourceHeadCardCount !== "number" || typeof sourceHeadPackCount !== "number" ||
    !sha256(sourceHeadCensusFileSha256) || !sha256(sourceHeadCensusProofDigest) ||
    !sha256(sourceHeadIdentityMultisetDigest)) {
    refuseCatalogBridge("CATALOG_BRIDGE_POLICY_MATERIALIZATION_JOURNAL_INVALID");
  }
  const definition = catalogBridgeProvider(state.providerKey);
  const capability = input.capabilityProof.providers.filter((entry) =>
    entry.providerId === definition.providerId && entry.providerKey === definition.providerKey);
  if (capability.length !== 1 || capability[0]?.sha256ByteaAvailable !== true) {
    refuseCatalogBridge("CATALOG_BRIDGE_POLICY_MATERIALIZATION_CAPABILITY_INVALID");
  }
  const pins = Object.freeze({ operationId: state.operationId, providerKey: state.providerKey,
    operatorId: state.preflight.runtime.pauseProvenance.requestedByOperatorId,
    residentCheckout: state.preflight.repository.checkout,
    residentCommit: state.preflight.repository.expectedCommit,
    utilityModuleSha256: state.preflight.repository.utilityModuleSha256,
    sourceHeadCountProvenance,
    sourceHeadCounts: Object.freeze({ card: sourceHeadCardCount,
      pack: sourceHeadPackCount }),
    sourceHeadCensusFileSha256,
    sourceHeadCensusProofDigest,
    sourceHeadIdentityMultisetDigest });
  if (catalogBridgeDigest(pins) !== state.planDigest) {
    refuseCatalogBridge("CATALOG_BRIDGE_POLICY_MATERIALIZATION_JOURNAL_INVALID");
  }
  const timeout = catalogBridgeCatalogExecutionBudget(pins);
  const preflight = state.preflight;
  const terminal = preflight.runtime.latestTerminalRun;
  const pause = preflight.runtime.pauseProvenance;
  return catalogBridgeCatalogLivePolicySchema.parse({
    schemaVersion: "dataforrest_catalog_bridge_catalog_live_v1",
    environment: "live",
    authorization: "operator_requested_catalog_bridge_catalog_cutover",
    pins,
    journalDirectory: input.args.journalDirectory,
    capabilityProof: { path: input.args.capabilityProofPath,
      fileSha256: input.capabilityProofFileSha256,
      proofDigest: catalogBridgeCapabilityProofDigest(input.capabilityProof) },
    prepared: { privateStateSha256: commit.privateStateSha256,
      publicJournalSha256: commit.publicJournalSha256,
      journalHeadReceiptSha256: journal.headReceiptHash },
    current: { providerId: definition.providerId, configId: definition.currentConfigId,
      configNumber: definition.currentConfigNumber,
      providerRowVersion: preflight.central.providerRowVersion,
      centralAuthorityDigest: preflight.central.authorityDigest,
      databaseRouteDigest: preflight.central.databaseRouteDigest,
      runtimeGeneration: preflight.runtime.generation,
      runtimeRowVersion: preflight.runtime.rowVersion,
      sourceCursorHash: preflight.runtime.sourceCursorHash,
      latestTerminalRunId: terminal.runId,
      latestTerminalRunDigest: terminal.runDigest,
      pauseCommandId: pause.commandId,
      pauseCommandDigest: pause.commandDigest },
    evidence: { drainReceiptSha256: preflight.worker.gracefulStopReceiptSha256,
      catalogOriginCanarySha256: preflight.sourceCanaries.catalogOrigin.responseSha256,
      savedEventCanarySha256: preflight.sourceCanaries.savedEventCursor.responseSha256,
      baselineSha256: catalogBridgeDigest(preflight.baseline) },
    utility: { workerId: `catalog-bridge/${state.operationId}/${state.providerKey}/catalog-utility`,
      leaseMilliseconds: 900_000,
      oneShotModuleSha256: input.oneShotModuleSha256,
      executionTimeoutMilliseconds: timeout.executionTimeoutMilliseconds,
      pausePollMilliseconds: 1_000,
      pauseMaximumObservations: 120 },
    successorLaunchAgent: { stagedPath: input.args.stagedPlistPath,
      installedPath: input.args.installedPlistPath,
      fileSha256: input.stagedPlistFileSha256,
      nodePath: input.args.nodePath,
      logPath: input.args.logPath,
      residentModuleSha256: input.residentModuleSha256,
      bootstrapPollMilliseconds: 100,
      bootstrapTimeoutMilliseconds: 30_000,
      startupMaximumObservations: 600,
      startupPollMilliseconds: 1_000 },
  }) as CatalogBridgeCatalogLivePolicy;
}

async function assertNodeExecutable(nodePath: string): Promise<void> {
  try {
    const details = await lstat(nodePath);
    if (!details.isFile() || ![0, process.getuid?.()].includes(details.uid) ||
      (details.mode & 0o111) === 0 || (details.mode & 0o022) !== 0) {
      refuseCatalogBridge("CATALOG_BRIDGE_POLICY_MATERIALIZATION_NODE_INVALID");
    }
  } catch (error) {
    if (error instanceof CatalogBridgeError) throw error;
    refuseCatalogBridge("CATALOG_BRIDGE_POLICY_MATERIALIZATION_NODE_INVALID");
  }
}

function lintPlist(filePath: string): void {
  try {
    execFileSync("/usr/bin/plutil", ["-lint", filePath], {
      encoding: "utf8", stdio: ["ignore", "ignore", "ignore"], timeout: 5_000,
    });
  } catch {
    refuseCatalogBridge("CATALOG_BRIDGE_POLICY_MATERIALIZATION_PLIST_INVALID");
  }
}

export async function materializeCatalogBridgeLivePolicy(input: Readonly<{
  args: CatalogBridgeLivePolicyMaterializationArguments;
}>): Promise<Readonly<Record<string, unknown>>> {
  const prepared = await readPreparedCatalogBridge(input.args.journalDirectory);
  const checkout = await observeCatalogBridgeCheckout({
    checkout: prepared.privateState.preflight.repository.checkout,
    expectedCommit: prepared.privateState.preflight.repository.expectedCommit,
    executingRoot: catalogBridgeRepositoryRoot(import.meta.url),
    modules: { plan: planModule, oneShot: oneShotModule, resident: residentModule },
  });
  if (checkout.moduleSha256.plan !==
    prepared.privateState.preflight.repository.utilityModuleSha256) {
    refuseCatalogBridge("CATALOG_BRIDGE_POLICY_MATERIALIZATION_REPOSITORY_CHANGED");
  }
  await assertNodeExecutable(input.args.nodePath);
  const capability = await readCatalogBridgeCapabilityProof(input.args.capabilityProofPath);
  const successor = buildCatalogBridgeSuccessorPlist({ state: prepared.privateState,
    nodePath: input.args.nodePath, logPath: input.args.logPath });
  const plist = await persistCatalogBridgePrivateBytes(input.args.stagedPlistPath, successor.plist);
  lintPlist(input.args.stagedPlistPath);
  const policy = buildCatalogBridgeCatalogLivePolicy({ args: input.args, prepared,
    capabilityProof: capability.proof, capabilityProofFileSha256: capability.fileSha256,
    stagedPlistFileSha256: plist.fileSha256,
    oneShotModuleSha256: checkout.moduleSha256.oneShot!,
    residentModuleSha256: checkout.moduleSha256.resident! });
  const policyFile = await persistCatalogBridgePrivateBytes(input.args.outputPolicyPath,
    catalogBridgePrivateJsonBytes(policy));
  const timeout = catalogBridgeCatalogExecutionBudget(policy.pins);
  return Object.freeze({ outcome: policyFile.exactRetry && plist.exactRetry
    ? "already_materialized" : "materialized",
  operationId: policy.pins.operationId, providerKey: policy.pins.providerKey,
  policySha256: catalogBridgeCatalogLivePolicyDigest(policy),
  policyFileSha256: policyFile.fileSha256, successorPlistFileSha256: plist.fileSha256,
  executionTimeoutMilliseconds: timeout.executionTimeoutMilliseconds,
  minimumCatalogPageCount: timeout.minimumCatalogPageCount,
  databaseWritesPerformed: false, sourceRequestsPerformed: false,
  launchctlMutationsPerformed: false });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => materializeCatalogBridgeLivePolicy({
    args: parseCatalogBridgeLivePolicyMaterializationArguments(process.argv.slice(2)),
  })).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`), (error: unknown) => {
    process.stderr.write(`${JSON.stringify({ outcome: "refused", code: error instanceof CatalogBridgeError
      ? error.code : "CATALOG_BRIDGE_POLICY_MATERIALIZATION_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
