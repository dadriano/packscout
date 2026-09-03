import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const safeCount = z.number().int().nonnegative().safe();
const absolutePath = z.string().min(1).max(4_096).refine((value) =>
  path.isAbsolute(value) && path.resolve(value) === value && !/[\r\n\0]/u.test(value));

export const catalogBridgeSourceCensusPassSchema = z.object({
  passNumber: z.union([z.literal(1), z.literal(2)]),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  pageCount: z.number().int().min(1).max(100_000).safe(),
  sourceRequestCount: z.number().int().min(1).max(100_000).safe(),
  sourceRecordCount: safeCount,
  rawCardObservationCount: safeCount,
  rawPackObservationCount: safeCount,
  distinctCardIdentityCount: safeCount,
  distinctPackIdentityCount: safeCount,
  identityMultisetDigest: sha256,
  traversalChainDigest: sha256,
  finalCursorHash: sha256,
  maximumResponseBytes: z.number().int().positive().safe(),
  totalResponseBytes: z.number().int().positive().safe(),
}).strict();

export const catalogBridgeSourceCensusSchema = z.object({
  schemaVersion: z.literal("dataforrest_catalog_bridge_source_census_v1"),
  authorization: z.literal("operator_requested_read_only_catalog_source_census"),
  operationId: z.string().uuid(),
  providerKey: z.enum(["collector_crypt", "courtyard", "phygitals"]),
  capturedAt: z.string().datetime({ offset: true }),
  executor: z.object({
    checkout: absolutePath,
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    runnerModuleSha256: sha256,
    censusModuleSha256: sha256,
    inspectionModuleSha256: sha256,
  }).strict(),
  source: z.object({
    providerId: z.string().uuid(),
    configId: z.string().uuid(),
    configNumber: z.number().int().positive().safe(),
    activeAdapterVersion: z.string().min(1).max(256),
    catalogAdapterVersion: z.string().min(1).max(256),
    sourceCredentialDigest: sha256,
    pageLimit: z.number().int().positive().safe(),
    requestTimeoutMilliseconds: z.number().int().positive().safe(),
    maximumResponseBytes: z.number().int().positive().safe(),
  }).strict(),
  passes: z.tuple([catalogBridgeSourceCensusPassSchema, catalogBridgeSourceCensusPassSchema]),
  agreement: z.object({
    sourceRecordCount: safeCount,
    cardCount: safeCount,
    packCount: safeCount,
    pageCount: z.number().int().min(1).max(100_000).safe(),
    identityMultisetDigest: sha256,
    traversalChainDigest: sha256,
    finalCursorHash: sha256,
  }).strict(),
  databaseWritesPerformed: z.literal(false),
  sourceRequestsPerformed: z.literal(true),
  rawResponsesPersisted: z.literal(false),
  rawCursorsPersisted: z.literal(false),
  sourceRecordIdsPersisted: z.literal(false),
}).strict().superRefine((proof, context) => {
  const [first, second] = proof.passes;
  for (const [index, pass] of proof.passes.entries()) {
    if (pass.passNumber !== index + 1 || pass.sourceRequestCount !== pass.pageCount ||
      pass.sourceRecordCount !== pass.rawCardObservationCount + pass.rawPackObservationCount ||
      pass.rawCardObservationCount !== pass.distinctCardIdentityCount ||
      pass.rawPackObservationCount !== pass.distinctPackIdentityCount ||
      pass.sourceRecordCount > pass.pageCount * proof.source.pageLimit ||
      pass.maximumResponseBytes > proof.source.maximumResponseBytes ||
      pass.totalResponseBytes < pass.maximumResponseBytes ||
      Date.parse(pass.completedAt) < Date.parse(pass.startedAt)) {
      context.addIssue({ code: "custom", path: ["passes", index],
        message: "Catalog source census pass is internally inconsistent." });
    }
  }
  const agreement = proof.agreement;
  if (Date.parse(second.startedAt) < Date.parse(first.completedAt) ||
    proof.capturedAt !== second.completedAt ||
    first.sourceRecordCount !== second.sourceRecordCount ||
    first.rawCardObservationCount !== second.rawCardObservationCount ||
    first.rawPackObservationCount !== second.rawPackObservationCount ||
    first.distinctCardIdentityCount !== second.distinctCardIdentityCount ||
    first.distinctPackIdentityCount !== second.distinctPackIdentityCount ||
    first.pageCount !== second.pageCount ||
    first.identityMultisetDigest !== second.identityMultisetDigest ||
    first.traversalChainDigest !== second.traversalChainDigest ||
    first.finalCursorHash !== second.finalCursorHash ||
    agreement.sourceRecordCount !== first.sourceRecordCount ||
    agreement.cardCount !== first.distinctCardIdentityCount ||
    agreement.packCount !== first.distinctPackIdentityCount ||
    agreement.pageCount !== first.pageCount ||
    agreement.identityMultisetDigest !== first.identityMultisetDigest ||
    agreement.traversalChainDigest !== first.traversalChainDigest ||
    agreement.finalCursorHash !== first.finalCursorHash) {
    context.addIssue({ code: "custom", path: ["agreement"],
      message: "Catalog source census passes do not agree exactly." });
  }
});

export type CatalogBridgeSourceCensus = z.infer<typeof catalogBridgeSourceCensusSchema>;
export type CatalogBridgeSourceCensusPass = z.infer<typeof catalogBridgeSourceCensusPassSchema>;

export function catalogBridgeSourceCensusBytes(proof: CatalogBridgeSourceCensus): Buffer {
  return Buffer.from(`${JSON.stringify(catalogBridgeSourceCensusSchema.parse(proof), null, 2)}\n`, "utf8");
}

export function catalogBridgeSourceCensusFileSha256(proof: CatalogBridgeSourceCensus): string {
  const bytes = catalogBridgeSourceCensusBytes(proof);
  try {
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}
