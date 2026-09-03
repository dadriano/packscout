import type { Prisma } from "../prisma/generated/provider/index.js";

export const providerHeadUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const digest = /^[0-9a-f]{64}$/u;
export interface ProviderHeadProgress {
  schemaVersion: number; headPageId: string; configVersionId: string; checkpointHash: string | null;
  leaseFence: string; batchNumber: number; phase: "facts" | "quarantines" | "complete";
  packAfterId: string | null; collectibleAfterId: string | null; packScanDone: boolean; collectibleScanDone: boolean;
  quarantineAfterId: string | null; quarantineAfterAt: string | null;
}
const fields = new Set(["schemaVersion", "headPageId", "configVersionId", "checkpointHash", "leaseFence", "batchNumber", "phase",
  "packAfterId", "collectibleAfterId", "packScanDone", "collectibleScanDone", "quarantineAfterId", "quarantineAfterAt"]);
export function invalidProviderHeadProof(): never { throw new Error("Provider head reconciliation proof is invalid."); }
export function parseProviderHeadProgress(value: Prisma.JsonValue): ProviderHeadProgress {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalidProviderHeadProof();
  const row = value as unknown as ProviderHeadProgress;
  if (Object.keys(row).length !== fields.size || Object.keys(row).some(key => !fields.has(key))
    || row.schemaVersion !== 1 || !providerHeadUuidPattern.test(row.headPageId) || !providerHeadUuidPattern.test(row.configVersionId)
    || (row.checkpointHash !== null && !digest.test(row.checkpointHash))
    || !/^[1-9][0-9]*$/u.test(row.leaseFence) || !Number.isSafeInteger(row.batchNumber) || row.batchNumber < 1
    || !["facts", "quarantines", "complete"].includes(row.phase)
    || typeof row.packScanDone !== "boolean" || typeof row.collectibleScanDone !== "boolean"
    || [row.packAfterId, row.collectibleAfterId, row.quarantineAfterId].some(id => id !== null && !providerHeadUuidPattern.test(id))
    || (row.quarantineAfterId === null) !== (row.quarantineAfterAt === null)
    || (row.quarantineAfterAt !== null && !Number.isFinite(Date.parse(row.quarantineAfterAt)))) return invalidProviderHeadProof();
  return row;
}
