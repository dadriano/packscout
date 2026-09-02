import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  catalogBridgeDigest,
  catalogBridgeProviderDefinitions,
  refuseCatalogBridge,
} from "./dataforrest-catalog-bridge-plan.mts";

const positiveInteger = z.string().regex(/^[1-9][0-9]*$/u);
const nonnegativeInteger = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);

const providerCapabilitySchema = z.object({
  providerId: z.string().uuid(),
  providerKey: z.enum(["collector_crypt", "courtyard", "phygitals"]),
  databaseName: z.string().min(1).max(128),
  databasePort: z.number().int().min(1).max(65_535),
  observedAt: z.string().datetime({ offset: true }),
  databaseNow: z.string().datetime({ offset: true }),
  serverVersionNumber: z.number().int().min(100_000),
  sha256ByteaAvailable: z.literal(true),
  runtimeState: z.enum(["idle", "running", "paused", "stopped", "error"]),
  runtimeGeneration: positiveInteger,
  runtimeRowVersion: positiveInteger,
  activeRunCount: z.number().int().nonnegative(),
  actionableCommandCount: z.number().int().nonnegative(),
  importLeaseOwnerPresent: z.boolean(),
  importLeaseLive: z.boolean(),
  estimatedRows: z.object({
    collectibles: nonnegativeInteger,
    packs: nonnegativeInteger,
    pulls: nonnegativeInteger,
    marketEvents: nonnegativeInteger,
  }).strict(),
}).strict();

export const catalogBridgeCapabilityProofSchema = z.object({
  schemaVersion: z.literal("dataforrest_catalog_bridge_capability_proof_v1"),
  capturedAt: z.string().datetime({ offset: true }),
  authorization: z.literal("operator_requested_read_only_catalog_capability_probe"),
  databaseWritesPerformed: z.literal(false),
  sourceRequestsPerformed: z.literal(false),
  providers: z.array(providerCapabilitySchema).length(3),
}).strict().superRefine((proof, context) => {
  for (const definition of catalogBridgeProviderDefinitions) {
    const matches = proof.providers.filter((entry) => entry.providerKey === definition.providerKey);
    const entry = matches[0];
    if (matches.length !== 1 || !entry || entry.providerId !== definition.providerId ||
      entry.databaseName !== definition.databaseName || entry.databasePort !== definition.databasePort ||
      Date.parse(entry.observedAt) > Date.parse(proof.capturedAt) ||
      Math.abs(Date.parse(entry.observedAt) - Date.parse(entry.databaseNow)) > 5 * 60_000) {
      context.addIssue({ code: "custom", message: "Provider capability identity is invalid." });
    }
  }
});

export type CatalogBridgeCapabilityProof = z.infer<typeof catalogBridgeCapabilityProofSchema>;

export function catalogBridgeCapabilityProofDigest(proof: CatalogBridgeCapabilityProof): string {
  return catalogBridgeDigest(catalogBridgeCapabilityProofSchema.parse(proof));
}

export function catalogBridgeCapabilityProofBytes(proof: CatalogBridgeCapabilityProof): Buffer {
  return Buffer.from(JSON.stringify(catalogBridgeCapabilityProofSchema.parse(proof), null, 2) + "\n", "utf8");
}

export function catalogBridgeCapabilityProofFileSha256(proof: CatalogBridgeCapabilityProof): string {
  return createHash("sha256").update(catalogBridgeCapabilityProofBytes(proof)).digest("hex");
}

export async function readCatalogBridgeCapabilityProof(filePath: string):
Promise<Readonly<{ proof: CatalogBridgeCapabilityProof; fileSha256: string }>> {
  if (!path.isAbsolute(filePath) || /[\r\n\0]/u.test(filePath)) {
    refuseCatalogBridge("CATALOG_BRIDGE_CAPABILITY_PROOF_PATH_INVALID");
  }
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (!details.isFile() || details.uid !== process.getuid?.() ||
      (details.mode & 0o777) !== 0o600 || details.size < 2 || details.size > 64 * 1_024) {
      refuseCatalogBridge("CATALOG_BRIDGE_CAPABILITY_PROOF_FILE_UNSAFE");
    }
    const bytes = await handle.readFile();
    const proof = catalogBridgeCapabilityProofSchema.parse(JSON.parse(bytes.toString("utf8")));
    return Object.freeze({ proof,
      fileSha256: createHash("sha256").update(bytes).digest("hex") });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      refuseCatalogBridge("CATALOG_BRIDGE_CAPABILITY_PROOF_INVALID");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
