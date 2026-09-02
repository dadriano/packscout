import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  catalogBridgeDigest,
  catalogBridgeProvider,
  refuseCatalogBridge,
  type CatalogBridgeOperationPins,
} from "./dataforrest-catalog-bridge-plan.mts";
import {
  CATALOG_BRIDGE_EXECUTION_TIMEOUT_MAXIMUM_MILLISECONDS,
  CATALOG_BRIDGE_EXECUTION_TIMEOUT_MINIMUM_MILLISECONDS,
  deriveCatalogBridgeExecutionBudget,
} from "./dataforrest-catalog-bridge-execution-budget.mts";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveInteger = z.string().regex(/^[1-9][0-9]*$/u);
const absolutePath = z.string().min(1).max(4_096).refine((value) =>
  path.isAbsolute(value) && !/[\r\n\0]/u.test(value));
const safeOwner = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);

const operationPinsSchema = z.object({
  operationId: z.string().uuid(),
  providerKey: z.enum(["collector_crypt", "courtyard", "phygitals"]),
  operatorId: z.string().uuid(),
  residentCheckout: absolutePath,
  residentCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  utilityModuleSha256: sha256,
  sourceHeadCountProvenance: z.literal("manually_reviewed_exact_source_head_counts_v1"),
  sourceHeadCounts: z.object({
    card: z.number().int().nonnegative().safe(),
    pack: z.number().int().nonnegative().safe(),
  }).strict(),
}).strict();

export const catalogBridgeCatalogLivePolicySchema = z.object({
  schemaVersion: z.literal("dataforrest_catalog_bridge_catalog_live_v1"),
  environment: z.literal("live"),
  authorization: z.literal("operator_requested_catalog_bridge_catalog_cutover"),
  pins: operationPinsSchema,
  journalDirectory: absolutePath,
  capabilityProof: z.object({
    path: absolutePath,
    fileSha256: sha256,
    proofDigest: sha256,
  }).strict(),
  prepared: z.object({
    privateStateSha256: sha256,
    publicJournalSha256: sha256,
    journalHeadReceiptSha256: sha256,
  }).strict(),
  current: z.object({
    providerId: z.string().uuid(),
    configId: z.string().uuid(),
    configNumber: z.number().int().positive(),
    providerRowVersion: positiveInteger,
    centralAuthorityDigest: sha256,
    databaseRouteDigest: sha256,
    runtimeGeneration: positiveInteger,
    runtimeRowVersion: positiveInteger,
    sourceCursorHash: sha256,
    latestTerminalRunId: z.string().uuid(),
    latestTerminalRunDigest: sha256,
    pauseCommandId: z.string().uuid(),
    pauseCommandDigest: sha256,
  }).strict(),
  evidence: z.object({
    drainReceiptSha256: sha256,
    catalogOriginCanarySha256: sha256,
    savedEventCanarySha256: sha256,
    baselineSha256: sha256,
  }).strict(),
  utility: z.object({
    workerId: safeOwner,
    leaseMilliseconds: z.number().int().min(30_000).max(15 * 60_000),
    oneShotModuleSha256: sha256,
    executionTimeoutMilliseconds: z.number().int()
      .min(CATALOG_BRIDGE_EXECUTION_TIMEOUT_MINIMUM_MILLISECONDS)
      .max(CATALOG_BRIDGE_EXECUTION_TIMEOUT_MAXIMUM_MILLISECONDS),
    pausePollMilliseconds: z.number().int().min(50).max(5_000).default(1_000),
    pauseMaximumObservations: z.number().int().min(1).max(600).default(120),
  }).strict(),
  successorLaunchAgent: z.object({
    stagedPath: absolutePath,
    installedPath: absolutePath,
    fileSha256: sha256,
    nodePath: absolutePath,
    logPath: absolutePath,
    residentModuleSha256: sha256,
    bootstrapPollMilliseconds: z.number().int().min(50).max(2_000).default(100),
    bootstrapTimeoutMilliseconds: z.number().int().min(1_000).max(120_000).default(30_000),
    startupMaximumObservations: z.number().int().min(1).max(3_600).default(600),
    startupPollMilliseconds: z.number().int().min(100).max(5_000).default(1_000),
  }).strict(),
}).strict().superRefine((policy, context) => {
  const definition = catalogBridgeProvider(policy.pins.providerKey);
  const expectedWorkerId = `catalog-bridge/${policy.pins.operationId}/${policy.pins.providerKey}/catalog-utility`;
  if (policy.current.providerId !== definition.providerId ||
    policy.current.configId !== definition.currentConfigId ||
    policy.current.configNumber !== definition.currentConfigNumber ||
    policy.utility.workerId !== expectedWorkerId ||
    path.basename(policy.successorLaunchAgent.stagedPath) !== `${definition.launchdLabel}.plist` ||
    path.basename(policy.successorLaunchAgent.installedPath) !== `${definition.launchdLabel}.plist`) {
    context.addIssue({ code: "custom", message: "Catalog bridge definition pins do not match." });
  }
  try {
    if (policy.utility.executionTimeoutMilliseconds !==
      catalogBridgeCatalogExecutionBudget(policy.pins).executionTimeoutMilliseconds) {
      context.addIssue({ code: "custom", path: ["utility", "executionTimeoutMilliseconds"],
        message: "Catalog bridge execution timeout does not match its source-head evidence." });
    }
  } catch {
    context.addIssue({ code: "custom", path: ["utility", "executionTimeoutMilliseconds"],
      message: "Catalog bridge execution timeout evidence is outside the reviewed bounds." });
  }
});

export type CatalogBridgeCatalogLivePolicy = z.infer<typeof catalogBridgeCatalogLivePolicySchema> &
  Readonly<{ pins: CatalogBridgeOperationPins }>;

export function catalogBridgeCatalogExecutionBudget(
  pins: Pick<CatalogBridgeOperationPins, "providerKey" | "sourceHeadCounts">,
) {
  const definition = catalogBridgeProvider(pins.providerKey);
  return deriveCatalogBridgeExecutionBudget({ sourceHeadCardCount: pins.sourceHeadCounts.card,
    sourceHeadPackCount: pins.sourceHeadCounts.pack,
    adapterPageLimit: definition.catalogManifest.requestBounds.pageLimit,
    adapterRequestTimeoutMilliseconds: definition.catalogManifest.requestBounds.timeoutMilliseconds });
}

export function catalogBridgeCatalogLivePolicyDigest(policy: CatalogBridgeCatalogLivePolicy): string {
  return catalogBridgeDigest(catalogBridgeCatalogLivePolicySchema.parse(policy));
}

export async function readCatalogBridgeCatalogLivePolicy(
  filePath: string,
): Promise<CatalogBridgeCatalogLivePolicy> {
  if (!path.isAbsolute(filePath) || /[\r\n\0]/u.test(filePath)) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_POLICY_PATH_INVALID");
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (!details.isFile() || details.uid !== process.getuid?.() ||
      (details.mode & 0o777) !== 0o600 || details.size < 2 || details.size > 64 * 1_024) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_POLICY_FILE_UNSAFE");
    }
    return catalogBridgeCatalogLivePolicySchema.parse(
      JSON.parse(await handle.readFile("utf8")),
    ) as CatalogBridgeCatalogLivePolicy;
  } catch (error) {
    if (error instanceof SyntaxError) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_POLICY_JSON_INVALID");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
