import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  assertCatalogBridgeIdleHead,
  assertCatalogBridgeRunningEntry,
  type CatalogBridgeDrainBoundary,
  type CatalogBridgeDrainPins,
} from "./dataforrest-catalog-bridge-drain-policy.mts";
import {
  catalogBridgeDigest,
  catalogBridgeProvider,
  refuseCatalogBridge,
} from "./dataforrest-catalog-bridge-plan.mts";

const positiveInteger = z.string().regex(/^[1-9][0-9]*$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const safeOwner = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const absolutePath = z.string().min(1).max(4_096).refine((value) =>
  path.isAbsolute(value) && !/[\r\n\0]/u.test(value));

export const catalogBridgeLiveDrainPolicySchema = z.object({
  schemaVersion: z.literal("dataforrest_catalog_bridge_live_drain_v1"),
  environment: z.literal("live"),
  authorization: z.literal("operator_requested_catalog_bridge_drain"),
  operationId: z.string().uuid(),
  providerKey: z.enum(["collector_crypt", "courtyard", "phygitals"]),
  providerId: z.string().uuid(),
  operatorId: z.string().uuid(),
  entryKind: z.enum(["running", "idle_head"]),
  currentConfigId: z.string().uuid(),
  currentConfigNumber: z.number().int().positive(),
  providerRowVersion: positiveInteger,
  centralAuthorityDigest: sha256,
  databaseRouteDigest: sha256,
  runtimeGeneration: positiveInteger,
  runtimeRowVersion: positiveInteger,
  runId: z.string().uuid(),
  runFence: positiveInteger,
  sourceCursorHash: sha256,
  importLeaseOwner: safeOwner.nullable(),
  importLeaseFence: positiveInteger,
  processPid: z.number().int().positive(),
  processIdentitySha256: sha256,
  receiptPath: absolutePath,
  pollMilliseconds: z.number().int().min(50).max(5_000).default(1_000),
  maximumObservations: z.number().int().min(1).max(300).default(75),
  bootoutPollMilliseconds: z.number().int().min(25).max(2_000).default(100),
  bootoutTimeoutMilliseconds: z.number().int().min(100).max(30_000).default(10_000),
}).strict().superRefine((policy, context) => {
  const definition = catalogBridgeProvider(policy.providerKey);
  if (policy.providerId !== definition.providerId ||
    policy.currentConfigId !== definition.currentConfigId ||
    policy.currentConfigNumber !== definition.currentConfigNumber) {
    context.addIssue({ code: "custom", message: "Provider definition pins do not match." });
  }
  if ((policy.entryKind === "running") !== (policy.importLeaseOwner !== null)) {
    context.addIssue({ code: "custom", message: "Lease owner does not match the entry kind." });
  }
});

export type CatalogBridgeLiveDrainPolicy = z.infer<typeof catalogBridgeLiveDrainPolicySchema>;

export function catalogBridgeLiveDrainPins(policy: CatalogBridgeLiveDrainPolicy): CatalogBridgeDrainPins {
  return Object.freeze({ operationId: policy.operationId, providerKey: policy.providerKey,
    operatorId: policy.operatorId });
}

export function catalogBridgeLiveDrainPolicyDigest(policy: CatalogBridgeLiveDrainPolicy): string {
  return catalogBridgeDigest(catalogBridgeLiveDrainPolicySchema.parse(policy));
}

export function assertCatalogBridgeLiveDrainInitialBoundary(policy: CatalogBridgeLiveDrainPolicy,
  boundary: CatalogBridgeDrainBoundary): void {
  const definition = catalogBridgeProvider(policy.providerKey);
  if (boundary.central.providerId !== policy.providerId || boundary.central.providerKey !== policy.providerKey ||
    boundary.central.providerRowVersion !== policy.providerRowVersion ||
    boundary.central.activeConfigId !== policy.currentConfigId ||
    boundary.central.activeConfigNumber !== policy.currentConfigNumber ||
    boundary.central.authorityDigest !== policy.centralAuthorityDigest ||
    boundary.runtime.generation !== policy.runtimeGeneration ||
    boundary.runtime.rowVersion !== policy.runtimeRowVersion || boundary.runtime.sourceCursorHash !== policy.sourceCursorHash ||
    boundary.run.id !== policy.runId || boundary.run.workerFence !== policy.runFence ||
    boundary.importLease.owner !== policy.importLeaseOwner || boundary.importLease.fence !== policy.importLeaseFence ||
    boundary.process.launchdLabel !== definition.launchdLabel || boundary.process.residencyPort !== definition.residencyPort ||
    boundary.process.pids.length !== 1 || boundary.process.pids[0] !== policy.processPid ||
    boundary.process.processIdentitySha256 !== policy.processIdentitySha256) {
    refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_POLICY_MISMATCH");
  }
  const pins = catalogBridgeLiveDrainPins(policy);
  if (policy.entryKind === "running") assertCatalogBridgeRunningEntry(boundary, pins);
  else assertCatalogBridgeIdleHead(boundary, pins);
}

export async function readCatalogBridgeLiveDrainPolicy(filePath: string): Promise<CatalogBridgeLiveDrainPolicy> {
  if (!path.isAbsolute(filePath) || /[\r\n\0]/u.test(filePath)) {
    refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_POLICY_PATH_INVALID");
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (!details.isFile() || details.uid !== process.getuid?.() || (details.mode & 0o777) !== 0o600 ||
      details.size < 2 || details.size > 64 * 1_024) {
      refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_POLICY_FILE_UNSAFE");
    }
    return catalogBridgeLiveDrainPolicySchema.parse(JSON.parse(await handle.readFile("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_POLICY_JSON_INVALID");
    throw error;
  } finally {
    await handle?.close();
  }
}
