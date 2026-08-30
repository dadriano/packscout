import {
  DATA_RELEASE_V3_SCHEMA_VERSION,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  containsProtectedEvPublicationKeyV3,
  containsProtectedPublicationField,
  packScoutBuybackEvConfidencePolicyVersionV1Schema,
  packScoutBuybackEvMethodVersionV1Schema,
  packScoutPublicEvPolicyVersionV3Schema,
  packScoutBuybackEvTimestampV1Schema,
  publicCategorySchema,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  publicRepackDetailV3Schema,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
  type PublicRepackDetailV3,
} from "@packscout/contracts";
import { v } from "convex/values";
import { z } from "zod";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { canonicalJson, sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import {
  DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION,
  MAX_DATA_RELEASE_V3_CATEGORIES,
  MAX_DATA_RELEASE_V3_CHASES,
  MAX_DATA_RELEASE_V3_COLLECTIBLES,
  MAX_DATA_RELEASE_V3_REPACKS,
  MAX_ROWS_PER_DATA_RELEASE_V3_SHARD,
  dataReleaseV3SearchRowFromDetail,
} from "./dataReleaseV3Search";
import {
  refuseProductionDataRelease,
  type ProductionDataReleaseErrorCode,
} from "./productionDataReleaseErrors";
import { stageReleaseEvFacts, completeReleaseEvFacts } from "./dataReleaseV3EvFacts";
import { activateRetainedEv, rollbackRetainedEv } from "./dataReleaseV3RetainedEv";

/**
 * data_release_v3 publication lifecycle (task buyback-adjusted-ev/008).
 *
 * One release stages sanitized task-007 entities in deterministic batches,
 * reconciles counts, references, versions, hashes, and derived search rows,
 * completes exactly once, and becomes public only through the atomic
 * activation pointer. The previously active coherent release is retained for
 * environment-scoped rollback. Every operation is idempotent: a byte-identical
 * replay returns the stored receipt, and a conflicting replay fails without
 * changing state or moving the active pointer.
 *
 * Search rows are derived server-side inside the same mutation that stages
 * each repack batch (see `dataReleaseV3Search.ts`), so a search projection can
 * never diverge from its detail inside a completed release.
 */

export const DATA_RELEASE_V3_BATCH_HASH_DOMAIN =
  "packscout.data-release-v3.batch.v1" as const;
export const DATA_RELEASE_V3_BATCH_CHAIN_HASH_DOMAIN =
  "packscout.data-release-v3.batch-chain.v1" as const;
export const DATA_RELEASE_V3_ENTITY_CHAIN_HASH_DOMAIN =
  "packscout.data-release-v3.entity-chain.v1" as const;
export const DATA_RELEASE_V3_SEARCH_ROW_SET_HASH_DOMAIN =
  "packscout.data-release-v3.search-row-set.v1" as const;
export const DATA_RELEASE_V3_CONTENT_HASH_DOMAIN =
  "packscout.data-release-v3.content.v1" as const;
export const DATA_RELEASE_V3_RELEASE_FINGERPRINT_DOMAIN =
  "packscout.data-release-v3.release-fingerprint.v1" as const;
export const DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN =
  "packscout.data-release-v3.receipt.v1" as const;
export const EMPTY_DATA_RELEASE_V3_CHAIN_HASH = "0".repeat(64);

export const MAX_DATA_RELEASE_V3_BATCH_RECORDS = 100;
export const MAX_DATA_RELEASE_V3_REPACK_BATCH_RECORDS =
  MAX_ROWS_PER_DATA_RELEASE_V3_SHARD;

export const DATA_RELEASE_V3_BATCH_KINDS = [
  "categories",
  "collectibles",
  "repacks",
  "chases",
] as const;
export type DataReleaseV3BatchKind = (typeof DATA_RELEASE_V3_BATCH_KINDS)[number];

const BATCH_KIND_RANK: Readonly<Record<DataReleaseV3BatchKind, number>> = {
  categories: 0,
  collectibles: 1,
  repacks: 2,
  chases: 3,
};

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const operationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u);
const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u);
const nonNegativeSafeIntegerSchema = z.number().int().safe().min(0);

const operationEnvelopeSchema = {
  schemaVersion: z.literal(DATA_RELEASE_V3_SCHEMA_VERSION),
  operationId: operationIdSchema,
  idempotencyKey: idempotencyKeySchema,
} as const;

export const dataReleaseV3CountsSchema = z
  .object({
    categories: nonNegativeSafeIntegerSchema.max(MAX_DATA_RELEASE_V3_CATEGORIES),
    collectibles: nonNegativeSafeIntegerSchema.max(
      MAX_DATA_RELEASE_V3_COLLECTIBLES,
    ),
    repacks: nonNegativeSafeIntegerSchema.max(MAX_DATA_RELEASE_V3_REPACKS),
    chases: nonNegativeSafeIntegerSchema.max(MAX_DATA_RELEASE_V3_CHASES),
    searchShards: nonNegativeSafeIntegerSchema.max(MAX_DATA_RELEASE_V3_REPACKS),
  })
  .strict()
  .refine(
    ({ repacks, searchShards }) =>
      searchShards ===
      Math.ceil(repacks / MAX_ROWS_PER_DATA_RELEASE_V3_SHARD),
    { message: "data_release_v3.shard_packing_not_deterministic" },
  );

export const dataReleaseV3EntityChainHashesSchema = z
  .object({
    categories: sha256Schema,
    collectibles: sha256Schema,
    repacks: sha256Schema,
    chases: sha256Schema,
  })
  .strict();

export const dataReleaseV3StartManifestSchema = z
  .object({
    methodVersion: packScoutBuybackEvMethodVersionV1Schema,
    confidencePolicyVersion: packScoutBuybackEvConfidencePolicyVersionV1Schema,
    publicEvPolicyVersion: packScoutPublicEvPolicyVersionV3Schema,
    dataAsOf: packScoutBuybackEvTimestampV1Schema,
    contentHash: sha256Schema,
    searchAlgorithmVersion: z.literal(DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION),
    counts: dataReleaseV3CountsSchema,
    entityChainHashes: dataReleaseV3EntityChainHashesSchema,
    topChaseCount: nonNegativeSafeIntegerSchema.max(MAX_DATA_RELEASE_V3_REPACKS),
    batchCount: nonNegativeSafeIntegerSchema.max(4_096),
    batchChainHash: sha256Schema,
  })
  .strict();

export const dataReleaseV3StartRequestSchema = z
  .object({
    ...operationEnvelopeSchema,
    publicReleaseId: z.uuid(),
    releaseFingerprint: sha256Schema,
    manifest: dataReleaseV3StartManifestSchema,
  })
  .strict();

const batchEnvelopeSchema = {
  ...operationEnvelopeSchema,
  publicReleaseId: z.uuid(),
  batchIndex: nonNegativeSafeIntegerSchema.max(4_095),
  batchHash: sha256Schema,
} as const;

export const dataReleaseV3ApplyBatchRequestSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        ...batchEnvelopeSchema,
        kind: z.literal("categories"),
        records: z
          .array(publicCategorySchema)
          .min(1)
          .max(MAX_DATA_RELEASE_V3_BATCH_RECORDS),
      })
      .strict(),
    z
      .object({
        ...batchEnvelopeSchema,
        kind: z.literal("collectibles"),
        records: z
          .array(publicCollectibleSchema)
          .min(1)
          .max(MAX_DATA_RELEASE_V3_BATCH_RECORDS),
      })
      .strict(),
    z
      .object({
        ...batchEnvelopeSchema,
        kind: z.literal("repacks"),
        records: z
          .array(publicRepackDetailV3Schema)
          .min(1)
          .max(MAX_DATA_RELEASE_V3_REPACK_BATCH_RECORDS),
      })
      .strict(),
    z
      .object({
        ...batchEnvelopeSchema,
        kind: z.literal("chases"),
        records: z
          .array(publicRepackChaseSchema)
          .min(1)
          .max(MAX_DATA_RELEASE_V3_BATCH_RECORDS),
      })
      .strict(),
  ],
);

export const dataReleaseV3FinalizeRequestSchema = z
  .object({
    ...operationEnvelopeSchema,
    publicReleaseId: z.uuid(),
    releaseFingerprint: sha256Schema,
    expectedCounts: dataReleaseV3CountsSchema,
    expectedEntityChainHashes: dataReleaseV3EntityChainHashesSchema,
    expectedTopChaseCount: nonNegativeSafeIntegerSchema,
    expectedBatchCount: nonNegativeSafeIntegerSchema.max(4_096),
    expectedBatchChainHash: sha256Schema,
  })
  .strict();

export const dataReleaseV3ActivateRequestSchema = z
  .object({
    ...operationEnvelopeSchema,
    publicReleaseId: z.uuid(),
    releaseFingerprint: sha256Schema,
    expectedActivePublicReleaseId: z.uuid().nullable(),
    /**
     * Operator-intentional override for the dataAsOf monotonicity guard.
     * Activation normally refuses (`PUBLICATION_DATA_REGRESSION`) when the
     * candidate release's canonical dataAsOf watermark is strictly older
     * than the active release's, so replaying an old complete plan can
     * never silently move the public catalog backward in time. Passing
     * `true` documents a deliberate roll-forward to older data when the
     * retained-predecessor `rollback` mutation cannot reach the target.
     */
    allowDataAsOfRegression: z.literal(true).optional(),
  })
  .strict();

export const dataReleaseV3RollbackRequestSchema = z
  .object({
    ...operationEnvelopeSchema,
    expectedActivePublicReleaseId: z.uuid(),
    targetPublicReleaseId: z.uuid(),
  })
  .strict();

export type DataReleaseV3StartRequest = z.infer<
  typeof dataReleaseV3StartRequestSchema
>;
export type DataReleaseV3ApplyBatchRequest = z.infer<
  typeof dataReleaseV3ApplyBatchRequestSchema
>;
export type DataReleaseV3FinalizeRequest = z.infer<
  typeof dataReleaseV3FinalizeRequestSchema
>;
export type DataReleaseV3ActivateRequest = z.infer<
  typeof dataReleaseV3ActivateRequestSchema
>;
export type DataReleaseV3RollbackRequest = z.infer<
  typeof dataReleaseV3RollbackRequestSchema
>;

function refuse(code: ProductionDataReleaseErrorCode): never {
  return refuseProductionDataRelease(code);
}

function parseRequest<T>(bodyJson: string, schema: z.ZodType<T>): T {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyJson);
  } catch {
    refuse("PUBLICATION_REQUEST_INVALID");
  }
  if (
    typeof parsedJson === "object" &&
    parsedJson !== null &&
    "schemaVersion" in parsedJson &&
    parsedJson.schemaVersion !== DATA_RELEASE_V3_SCHEMA_VERSION
  ) {
    refuse("PUBLICATION_SCHEMA_UNSUPPORTED");
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) refuse("PUBLICATION_REQUEST_INVALID");
  return parsed.data;
}

function assertRequestDigest(requestDigest: string): void {
  if (!/^[0-9a-f]{64}$/u.test(requestDigest)) {
    refuse("PUBLICATION_REQUEST_INVALID");
  }
}

interface DataReleaseV3Receipt {
  readonly schemaVersion: typeof DATA_RELEASE_V3_SCHEMA_VERSION;
  readonly operationKind: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly publicReleaseId: string | null;
  readonly result: string;
  readonly serverTime: string;
  readonly requestDigest: string;
  readonly details: Record<string, unknown>;
  readonly receiptDigest: string;
}

async function buildReceipt(
  input: Omit<DataReleaseV3Receipt, "receiptDigest">,
): Promise<DataReleaseV3Receipt> {
  const receiptDigest = await sha256CanonicalJson(
    DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
    input,
  );
  return { ...input, receiptDigest };
}

async function loadExactReplay(
  ctx: MutationCtx,
  input: {
    readonly operationKind: string;
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
  },
): Promise<DataReleaseV3Receipt | null> {
  const [byOperationId, byIdempotencyKey] = await Promise.all([
    ctx.db
      .query("dataReleaseV3Operations")
      .withIndex("by_operation_id", (index) =>
        index.eq("operationId", input.operationId),
      )
      .take(2),
    ctx.db
      .query("dataReleaseV3Operations")
      .withIndex("by_kind_and_idempotency_key", (index) =>
        index
          .eq("kind", input.operationKind)
          .eq("idempotencyKey", input.idempotencyKey),
      )
      .take(2),
  ]);
  if (byOperationId.length > 1 || byIdempotencyKey.length > 1) {
    refuse("PUBLICATION_STATE_CONFLICT");
  }
  const operation = byOperationId[0] ?? byIdempotencyKey[0] ?? null;
  if (operation === null) return null;
  if (
    byOperationId[0]?._id !== operation._id ||
    byIdempotencyKey[0]?._id !== operation._id ||
    operation.kind !== input.operationKind ||
    operation.bodyHash !== input.requestDigest
  ) {
    refuse("PUBLICATION_OPERATION_CONFLICT");
  }
  let receipt: DataReleaseV3Receipt;
  try {
    receipt = JSON.parse(operation.receiptJson) as DataReleaseV3Receipt;
  } catch {
    refuse("PUBLICATION_STATE_CONFLICT");
  }
  if (
    receipt.operationId !== operation.operationId ||
    receipt.receiptDigest !== operation.receiptDigest ||
    receipt.requestDigest !== operation.bodyHash
  ) {
    refuse("PUBLICATION_STATE_CONFLICT");
  }
  return receipt;
}

async function storeReceipt(
  ctx: MutationCtx,
  receipt: DataReleaseV3Receipt,
): Promise<DataReleaseV3Receipt> {
  await ctx.db.insert("dataReleaseV3Operations", {
    operationId: receipt.operationId,
    kind: receipt.operationKind,
    idempotencyKey: receipt.idempotencyKey,
    bodyHash: receipt.requestDigest,
    publicReleaseId: receipt.publicReleaseId,
    status: "completed",
    result: receipt.result,
    receiptDigest: receipt.receiptDigest,
    completedAt: receipt.serverTime,
    receiptJson: JSON.stringify(receipt),
  });
  return receipt;
}

export async function loadDataReleaseV3ByPublicReleaseId(
  ctx: QueryCtx | MutationCtx,
  publicReleaseId: string,
): Promise<Doc<"dataReleaseV3Releases"> | null> {
  const matches = await ctx.db
    .query("dataReleaseV3Releases")
    .withIndex("by_public_release_id", (index) =>
      index.eq("publicReleaseId", publicReleaseId),
    )
    .take(2);
  if (matches.length > 1) refuse("PUBLICATION_STATE_CONFLICT");
  return matches[0] ?? null;
}

export async function loadActiveDataReleaseV3State(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"activeDataReleaseV3State"> | null> {
  const states = await ctx.db
    .query("activeDataReleaseV3State")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (states.length > 1) refuse("PUBLICATION_STATE_CONFLICT");
  return states[0] ?? null;
}

function releasePointer(release: Doc<"dataReleaseV3Releases">): {
  publicReleaseId: string;
  releaseFingerprint: string;
  methodVersion: "packscout-buyback-adjusted-ev-v1";
  confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1";
  publicEvPolicyVersion: typeof PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3;
  dataAsOf: string;
  completedAt: string;
  counts: Doc<"dataReleaseV3Releases">["expectedCounts"];
} {
  if (
    release.lifecycle !== "complete" ||
    release.completedAt === null ||
    release.publicEvPolicyVersion !== PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3
  ) {
    refuse("PUBLICATION_STATE_CONFLICT");
  }
  return {
    publicReleaseId: release.publicReleaseId,
    releaseFingerprint: release.releaseFingerprint,
    methodVersion: release.methodVersion,
    confidencePolicyVersion: release.confidencePolicyVersion,
    publicEvPolicyVersion: release.publicEvPolicyVersion,
    dataAsOf: release.dataAsOf,
    completedAt: release.completedAt,
    counts: release.expectedCounts,
  };
}

async function expectedRecomputedFingerprint(
  release: Pick<
    Doc<"dataReleaseV3Releases">,
    | "publicReleaseId"
    | "methodVersion"
    | "confidencePolicyVersion"
    | "dataAsOf"
    | "contentHash"
    | "searchAlgorithmVersion"
    | "expectedBatchCount"
    | "expectedBatchChainHash"
  > & Readonly<{
    publicEvPolicyVersion: typeof PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3;
  }>,
): Promise<string> {
  return sha256CanonicalJson(DATA_RELEASE_V3_RELEASE_FINGERPRINT_DOMAIN, {
    schemaVersion: DATA_RELEASE_V3_SCHEMA_VERSION,
    publicReleaseId: release.publicReleaseId,
    methodVersion: release.methodVersion,
    confidencePolicyVersion: release.confidencePolicyVersion,
    publicEvPolicyVersion: release.publicEvPolicyVersion,
    dataAsOf: release.dataAsOf,
    contentHash: release.contentHash,
    searchAlgorithmVersion: release.searchAlgorithmVersion,
    batchCount: release.expectedBatchCount,
    batchChainHash: release.expectedBatchChainHash,
  });
}

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
} as const;

export const start = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertRequestDigest(args.requestDigest);
    const request = parseRequest(args.bodyJson, dataReleaseV3StartRequestSchema);
    const replay = await loadExactReplay(ctx, {
      operationKind: "start",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      requestDigest: args.requestDigest,
    });
    if (replay !== null) return replay;

    const recomputedFingerprint = await expectedRecomputedFingerprint({
      publicReleaseId: request.publicReleaseId,
      methodVersion: request.manifest.methodVersion,
      confidencePolicyVersion: request.manifest.confidencePolicyVersion,
      publicEvPolicyVersion: request.manifest.publicEvPolicyVersion,
      dataAsOf: request.manifest.dataAsOf,
      contentHash: request.manifest.contentHash,
      searchAlgorithmVersion: request.manifest.searchAlgorithmVersion,
      expectedBatchCount: request.manifest.batchCount,
      expectedBatchChainHash: request.manifest.batchChainHash,
    });
    if (recomputedFingerprint !== request.releaseFingerprint) {
      refuse("PUBLICATION_MANIFEST_MISMATCH");
    }
    const existing = await loadDataReleaseV3ByPublicReleaseId(
      ctx,
      request.publicReleaseId,
    );
    const byFingerprint = await ctx.db
      .query("dataReleaseV3Releases")
      .withIndex("by_release_fingerprint", (index) =>
        index.eq("releaseFingerprint", request.releaseFingerprint),
      )
      .take(2);
    if (byFingerprint.length > 1) refuse("PUBLICATION_STATE_CONFLICT");
    if (existing !== null || byFingerprint.length > 0) {
      const release = existing ?? byFingerprint[0]!;
      if (
        release.publicReleaseId !== request.publicReleaseId ||
        release.releaseFingerprint !== request.releaseFingerprint
      ) {
        refuse("PUBLICATION_OPERATION_CONFLICT");
      }
      const serverTime = new Date().toISOString();
      const receipt = await buildReceipt({
        schemaVersion: DATA_RELEASE_V3_SCHEMA_VERSION,
        operationKind: "start",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        publicReleaseId: request.publicReleaseId,
        result:
          release.lifecycle === "complete" ? "already_complete" : "resumed",
        serverTime,
        requestDigest: args.requestDigest,
        details: { lifecycle: release.lifecycle },
      });
      return await storeReceipt(ctx, receipt);
    }
    const serverTime = new Date().toISOString();
    await ctx.db.insert("dataReleaseV3Releases", {
      publicReleaseId: request.publicReleaseId,
      releaseFingerprint: request.releaseFingerprint,
      evFactsRequired: true,
      lifecycle: "staging",
      methodVersion: request.manifest.methodVersion,
      confidencePolicyVersion: request.manifest.confidencePolicyVersion,
      publicEvPolicyVersion: request.manifest.publicEvPolicyVersion,
      dataAsOf: request.manifest.dataAsOf,
      contentHash: request.manifest.contentHash,
      searchAlgorithmVersion: request.manifest.searchAlgorithmVersion,
      expectedCounts: request.manifest.counts,
      expectedEntityChainHashes: request.manifest.entityChainHashes,
      expectedTopChaseCount: request.manifest.topChaseCount,
      expectedBatchCount: request.manifest.batchCount,
      expectedBatchChainHash: request.manifest.batchChainHash,
      acceptedCounts: {
        categories: 0,
        collectibles: 0,
        repacks: 0,
        chases: 0,
        searchShards: 0,
      },
      acceptedEntityChainHashes: {
        categories: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
        collectibles: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
        repacks: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
        chases: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
      },
      acceptedTopChaseCount: 0,
      acceptedVerifiedTopChaseCount: 0,
      acceptedBatchCount: 0,
      acceptedBatchChainHash: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
      acceptedSearchRowCount: 0,
      acceptedSearchRowSetHash: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
      lastBatchKind: null,
      lastRecordKey: null,
      createdAt: serverTime,
      completedAt: null,
    });
    const receipt = await buildReceipt({
      schemaVersion: DATA_RELEASE_V3_SCHEMA_VERSION,
      operationKind: "start",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.publicReleaseId,
      result: "started",
      serverTime,
      requestDigest: args.requestDigest,
      details: { lifecycle: "staging" },
    });
    return await storeReceipt(ctx, receipt);
  },
});

function recordKey(
  kind: DataReleaseV3BatchKind,
  record: PublicCategory | PublicCollectible | PublicRepackDetailV3 | PublicRepackChase,
): string {
  switch (kind) {
    case "categories":
      return (record as PublicCategory).publicCategoryId;
    case "collectibles":
      return (record as PublicCollectible).publicCollectibleId;
    case "repacks":
      return (record as PublicRepackDetailV3).publicRepackId;
    case "chases": {
      const chase = record as PublicRepackChase;
      return `${chase.publicRepackId}:${chase.publicCollectibleId}`;
    }
  }
}

/**
 * Top-chase accounting for one batch, split by provenance.
 *
 * `declared` counts top chases advertised by staged repack details;
 * `verified` counts staged chase rows that canonically match the top chase of
 * the repack they point at. Both are derived by the server from staged bytes,
 * never read from the publisher's manifest, and finalize requires the running
 * totals to agree. Collapsing them into one number lets a release that
 * advertises a top chase whose chase row was never staged reconcile and
 * activate, leaving the desired-collectible lookup unable to resolve it.
 */
interface StagedTopChaseTally {
  readonly declared: number;
  readonly verified: number;
}

const NO_TOP_CHASES: StagedTopChaseTally = { declared: 0, verified: 0 };

async function assertStagedReferences(
  ctx: MutationCtx,
  releaseId: Id<"dataReleaseV3Releases">,
  request: DataReleaseV3ApplyBatchRequest,
): Promise<StagedTopChaseTally> {
  if (request.kind === "categories") return NO_TOP_CHASES;
  if (request.kind === "collectibles") {
    for (const record of request.records) {
      for (const publicCategoryId of record.publicCategoryIds) {
        const category = await ctx.db
          .query("dataReleaseV3Categories")
          .withIndex("by_release_id_and_public_category_id", (index) =>
            index
              .eq("releaseId", releaseId)
              .eq("publicCategoryId", publicCategoryId),
          )
          .unique();
        if (category === null) refuse("PUBLICATION_REFERENCE_INVALID");
      }
    }
    return NO_TOP_CHASES;
  }
  if (request.kind === "repacks") {
    for (const record of request.records) {
      for (const { publicCategoryId } of record.categories) {
        const category = await ctx.db
          .query("dataReleaseV3Categories")
          .withIndex("by_release_id_and_public_category_id", (index) =>
            index
              .eq("releaseId", releaseId)
              .eq("publicCategoryId", publicCategoryId),
          )
          .unique();
        if (category === null) refuse("PUBLICATION_REFERENCE_INVALID");
      }
      if (record.topChase !== null) {
        const collectible = await ctx.db
          .query("dataReleaseV3Collectibles")
          .withIndex("by_release_id_and_public_collectible_id", (index) =>
            index
              .eq("releaseId", releaseId)
              .eq(
                "publicCollectibleId",
                record.topChase!.publicCollectibleId,
              ),
          )
          .unique();
        if (collectible === null) refuse("PUBLICATION_REFERENCE_INVALID");
      }
    }
    // A repack detail advertising a top chase only *declares* one: its chase
    // row arrives in a later batch and is verified there.
    return {
      declared: request.records.filter(({ topChase }) => topChase !== null)
        .length,
      verified: 0,
    };
  }
  let topChaseMatches = 0;
  for (const record of request.records) {
    const repack = await ctx.db
      .query("dataReleaseV3Repacks")
      .withIndex("by_release_id_and_public_repack_id", (index) =>
        index
          .eq("releaseId", releaseId)
          .eq("publicRepackId", record.publicRepackId),
      )
      .unique();
    const collectible = await ctx.db
      .query("dataReleaseV3Collectibles")
      .withIndex("by_release_id_and_public_collectible_id", (index) =>
        index
          .eq("releaseId", releaseId)
          .eq("publicCollectibleId", record.publicCollectibleId),
      )
      .unique();
    if (repack === null || collectible === null) {
      refuse("PUBLICATION_REFERENCE_INVALID");
    }
    if (
      record.collectible.publicCollectibleId !== record.publicCollectibleId ||
      canonicalJson(record.collectible) !==
        canonicalJson({
          publicCollectibleId: collectible.detail.publicCollectibleId,
          name: collectible.detail.name,
          collectibleType: collectible.detail.collectibleType,
          publicCategoryIds: collectible.detail.publicCategoryIds,
          primaryImage: collectible.detail.primaryImage,
          valuation: collectible.detail.valuation,
        })
    ) {
      refuse("PUBLICATION_REFERENCE_INVALID");
    }
    if (record.role === "top_chase") {
      if (
        repack.detail.topChase === null ||
        canonicalJson(repack.detail.topChase) !== canonicalJson(record)
      ) {
        refuse("PUBLICATION_REFERENCE_INVALID");
      }
      topChaseMatches += 1;
    }
  }
  // Chase keys are `${publicRepackId}:${publicCollectibleId}` and are strictly
  // ascending across the whole release, and a match requires the row to equal
  // the repack's own `topChase`, so at most one chase row can verify each
  // declared top chase: `verified` can never exceed `declared`.
  return { declared: 0, verified: topChaseMatches };
}

async function insertBatchRecords(
  ctx: MutationCtx,
  release: Doc<"dataReleaseV3Releases">,
  request: DataReleaseV3ApplyBatchRequest,
): Promise<{
  readonly searchShard: { rowCount: number; contentHash: string } | null;
}> {
  if (request.kind === "categories") {
    for (const record of request.records) {
      await ctx.db.insert("dataReleaseV3Categories", {
        releaseId: release._id,
        publicCategoryId: record.publicCategoryId,
        detail: record,
      });
    }
    return { searchShard: null };
  }
  if (request.kind === "collectibles") {
    for (const record of request.records) {
      await ctx.db.insert("dataReleaseV3Collectibles", {
        releaseId: release._id,
        publicCollectibleId: record.publicCollectibleId,
        collectibleType: record.collectibleType,
        normalizedName: record.normalizedName,
        searchText: record.searchText,
        detail: record,
      });
    }
    return { searchShard: null };
  }
  if (request.kind === "repacks") {
    const rows = request.records.map((record) => {
      if (
        record.evEstimates.packScout.methodVersion !== release.methodVersion ||
        record.evEstimates.packScout.confidencePolicyVersion !==
          release.confidencePolicyVersion
      ) {
        refuse("PUBLICATION_ENTITY_INVALID");
      }
      const estimate = record.evEstimates.packScout;
      if (
        estimate.status !== "unavailable" &&
        (estimate.metrics.grossReturnBasisPoints > 10_000 ||
          estimate.metrics.evDollars.minorUnits > 0 ||
          estimate.metrics.evPercentBasisPoints > 0)
      ) {
        refuse("PUBLICATION_ENTITY_INVALID");
      }
      return dataReleaseV3SearchRowFromDetail(record);
    });
    const remaining =
      release.expectedCounts.repacks - release.acceptedCounts.repacks;
    if (
      request.records.length !==
      Math.min(remaining, MAX_DATA_RELEASE_V3_REPACK_BATCH_RECORDS)
    ) {
      // Deterministic full packing keeps replay byte-stable and bounds the
      // shard-read budget for every public query.
      refuse("PUBLICATION_BATCH_OUT_OF_ORDER");
    }
    for (const record of request.records) {
      await ctx.db.insert("dataReleaseV3Repacks", {
        releaseId: release._id,
        publicRepackId: record.publicRepackId,
        detail: record,
      });
    }
    await stageReleaseEvFacts(ctx, release, request.records);
    const contentHash = await sha256CanonicalJson(
      DATA_RELEASE_V3_SEARCH_ROW_SET_HASH_DOMAIN,
      rows,
    );
    await ctx.db.insert("dataReleaseV3SearchShards", {
      releaseId: release._id,
      shardNumber: release.acceptedCounts.searchShards,
      rowCount: rows.length,
      contentHash,
      rows,
    });
    return { searchShard: { rowCount: rows.length, contentHash } };
  }
  for (const record of request.records) {
    await ctx.db.insert("dataReleaseV3Chases", {
      releaseId: release._id,
      publicRepackId: record.publicRepackId,
      publicCollectibleId: record.publicCollectibleId,
      detail: record,
    });
  }
  return { searchShard: null };
}

export const applyBatch = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertRequestDigest(args.requestDigest);
    // Protected or raw-like keys are rejected on the raw body before strict
    // schema validation can reduce them to a generic parse failure.
    try {
      const raw = JSON.parse(args.bodyJson) as unknown;
      if (
        typeof raw === "object" &&
        raw !== null &&
        "records" in raw &&
        (containsProtectedEvPublicationKeyV3(raw.records) ||
          containsProtectedPublicationField(raw.records))
      ) {
        refuse("PUBLICATION_PROTECTED_FIELD");
      }
    } catch (error) {
      if (error instanceof SyntaxError) refuse("PUBLICATION_REQUEST_INVALID");
      throw error;
    }
    const request = parseRequest(
      args.bodyJson,
      dataReleaseV3ApplyBatchRequestSchema,
    );
    const replay = await loadExactReplay(ctx, {
      operationKind: "applyBatch",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      requestDigest: args.requestDigest,
    });
    if (replay !== null) return replay;

    const declaredHash = await sha256CanonicalJson(
      DATA_RELEASE_V3_BATCH_HASH_DOMAIN,
      { kind: request.kind, records: request.records },
    );
    if (declaredHash !== request.batchHash) {
      refuse("PUBLICATION_BATCH_CONFLICT");
    }
    const release = await loadDataReleaseV3ByPublicReleaseId(
      ctx,
      request.publicReleaseId,
    );
    if (release === null) refuse("PUBLICATION_STATE_CONFLICT");
    if (release.lifecycle !== "staging") refuse("PUBLICATION_STATE_CONFLICT");
    if (request.batchIndex !== release.acceptedBatchCount) {
      refuse("PUBLICATION_BATCH_OUT_OF_ORDER");
    }
    if (request.batchIndex >= release.expectedBatchCount) {
      refuse("PUBLICATION_BATCH_OUT_OF_ORDER");
    }

    const keys = request.records.map((record) =>
      recordKey(request.kind, record),
    );
    const sortedUnique = keys.every(
      (key, index) => index === 0 || keys[index - 1]! < key,
    );
    if (!sortedUnique) refuse("PUBLICATION_BATCH_OUT_OF_ORDER");
    const kindRank = BATCH_KIND_RANK[request.kind];
    if (release.lastBatchKind !== null) {
      const lastRank =
        BATCH_KIND_RANK[release.lastBatchKind as DataReleaseV3BatchKind];
      if (kindRank < lastRank) refuse("PUBLICATION_BATCH_OUT_OF_ORDER");
      if (
        kindRank === lastRank &&
        (release.lastRecordKey === null || keys[0]! <= release.lastRecordKey)
      ) {
        refuse("PUBLICATION_BATCH_OUT_OF_ORDER");
      }
    }
    const newCount =
      release.acceptedCounts[request.kind] + request.records.length;
    if (newCount > release.expectedCounts[request.kind]) {
      refuse("PUBLICATION_RECONCILIATION_FAILED");
    }

    const topChases = await assertStagedReferences(ctx, release._id, request);
    const { searchShard } = await insertBatchRecords(ctx, release, request);

    const acceptedBatchChainHash = await sha256CanonicalJson(
      DATA_RELEASE_V3_BATCH_CHAIN_HASH_DOMAIN,
      {
        previousHash: release.acceptedBatchChainHash,
        batchIndex: request.batchIndex,
        kind: request.kind,
        batchHash: request.batchHash,
        recordCount: request.records.length,
      },
    );
    const acceptedEntityChainHashes = {
      ...release.acceptedEntityChainHashes,
      [request.kind]: await sha256CanonicalJson(
        DATA_RELEASE_V3_ENTITY_CHAIN_HASH_DOMAIN,
        {
          previousHash: release.acceptedEntityChainHashes[request.kind],
          batchHash: request.batchHash,
        },
      ),
    };
    const acceptedSearchRowSetHash =
      searchShard === null
        ? release.acceptedSearchRowSetHash
        : await sha256CanonicalJson(DATA_RELEASE_V3_SEARCH_ROW_SET_HASH_DOMAIN, {
            previousHash: release.acceptedSearchRowSetHash,
            shardContentHash: searchShard.contentHash,
          });
    await ctx.db.patch("dataReleaseV3Releases", release._id, {
      acceptedCounts: {
        ...release.acceptedCounts,
        [request.kind]: newCount,
        searchShards:
          release.acceptedCounts.searchShards + (searchShard === null ? 0 : 1),
      },
      acceptedEntityChainHashes,
      acceptedTopChaseCount:
        release.acceptedTopChaseCount + topChases.declared,
      // `?? 0` covers only a release staged before the verified counter
      // existed (the field is `v.optional` in the schema for exactly that
      // reason). Restarting the verified tally at 0 while the declared tally
      // carries on is the fail-safe direction: such a release can only end up
      // with verified < declared, and finalize refuses it.
      acceptedVerifiedTopChaseCount:
        (release.acceptedVerifiedTopChaseCount ?? 0) + topChases.verified,
      acceptedBatchCount: release.acceptedBatchCount + 1,
      acceptedBatchChainHash,
      acceptedSearchRowCount:
        release.acceptedSearchRowCount +
        (searchShard === null ? 0 : searchShard.rowCount),
      acceptedSearchRowSetHash,
      lastBatchKind: request.kind,
      lastRecordKey: keys[keys.length - 1]!,
    });
    const receipt = await buildReceipt({
      schemaVersion: DATA_RELEASE_V3_SCHEMA_VERSION,
      operationKind: "applyBatch",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.publicReleaseId,
      result: "accepted",
      serverTime: new Date().toISOString(),
      requestDigest: args.requestDigest,
      details: {
        batchIndex: request.batchIndex,
        kind: request.kind,
        recordCount: request.records.length,
        acceptedBatchChainHash,
      },
    });
    return await storeReceipt(ctx, receipt);
  },
});

async function assertCategoryHierarchy(
  ctx: MutationCtx,
  releaseId: Id<"dataReleaseV3Releases">,
): Promise<void> {
  const categories = await ctx.db
    .query("dataReleaseV3Categories")
    .withIndex("by_release_id_and_public_category_id", (index) =>
      index.eq("releaseId", releaseId),
    )
    .take(MAX_DATA_RELEASE_V3_CATEGORIES + 1);
  if (categories.length > MAX_DATA_RELEASE_V3_CATEGORIES) {
    refuse("PUBLICATION_RECONCILIATION_FAILED");
  }
  const byId = new Map(
    categories.map((category) => [category.publicCategoryId, category.detail]),
  );
  for (const { detail } of categories) {
    if (detail.parentPublicCategoryId === null) continue;
    const parent = byId.get(detail.parentPublicCategoryId);
    if (parent === undefined || parent.depth !== detail.depth - 1) {
      refuse("PUBLICATION_REFERENCE_INVALID");
    }
  }
}

export const finalize = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertRequestDigest(args.requestDigest);
    const request = parseRequest(
      args.bodyJson,
      dataReleaseV3FinalizeRequestSchema,
    );
    const replay = await loadExactReplay(ctx, {
      operationKind: "finalize",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      requestDigest: args.requestDigest,
    });
    if (replay !== null) return replay;

    const release = await loadDataReleaseV3ByPublicReleaseId(
      ctx,
      request.publicReleaseId,
    );
    if (release === null) refuse("PUBLICATION_STATE_CONFLICT");
    if (release.lifecycle !== "staging") refuse("PUBLICATION_STATE_CONFLICT");
    if (release.releaseFingerprint !== request.releaseFingerprint) {
      refuse("PUBLICATION_MANIFEST_MISMATCH");
    }
    const reconciles =
      canonicalJson(release.acceptedCounts) ===
        canonicalJson(request.expectedCounts) &&
      canonicalJson(release.acceptedCounts) ===
        canonicalJson(release.expectedCounts) &&
      canonicalJson(release.acceptedEntityChainHashes) ===
        canonicalJson(request.expectedEntityChainHashes) &&
      canonicalJson(release.acceptedEntityChainHashes) ===
        canonicalJson(release.expectedEntityChainHashes) &&
      release.acceptedTopChaseCount === request.expectedTopChaseCount &&
      release.acceptedTopChaseCount === release.expectedTopChaseCount &&
      // Both sides of this equality are derived by the server from staged
      // bytes: every top chase a staged repack detail advertises must have a
      // staged chase row that canonically matches it. The manifest comparisons
      // above cannot stand in for this — they only prove the publisher's own
      // declared number matches what its repack details declare.
      //
      // `?? 0` covers a release staged before the verified counter existed.
      // It refuses such a release whenever it declared a top chase, and admits
      // it only when it declared none — the one case where nothing needed
      // verifying.
      (release.acceptedVerifiedTopChaseCount ?? 0) ===
        release.acceptedTopChaseCount &&
      release.acceptedBatchCount === request.expectedBatchCount &&
      release.acceptedBatchCount === release.expectedBatchCount &&
      release.acceptedBatchChainHash === request.expectedBatchChainHash &&
      release.acceptedBatchChainHash === release.expectedBatchChainHash &&
      release.acceptedSearchRowCount === release.expectedCounts.repacks;
    if (!reconciles) refuse("PUBLICATION_RECONCILIATION_FAILED");
    const contentHash = await sha256CanonicalJson(
      DATA_RELEASE_V3_CONTENT_HASH_DOMAIN,
      {
        counts: release.acceptedCounts,
        entityChainHashes: release.acceptedEntityChainHashes,
        topChaseCount: release.acceptedTopChaseCount,
      },
    );
    if (contentHash !== release.contentHash) {
      refuse("PUBLICATION_RECONCILIATION_FAILED");
    }
    await assertCategoryHierarchy(ctx, release._id);
    const serverTime = new Date().toISOString();
    if (Date.parse(release.dataAsOf) > Date.parse(serverTime)) {
      refuse("PUBLICATION_RECONCILIATION_FAILED");
    }
    await completeReleaseEvFacts(ctx, release);
    await ctx.db.patch("dataReleaseV3Releases", release._id, {
      lifecycle: "complete",
      completedAt: serverTime,
    });
    const receipt = await buildReceipt({
      schemaVersion: DATA_RELEASE_V3_SCHEMA_VERSION,
      operationKind: "finalize",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.publicReleaseId,
      result: "complete",
      serverTime,
      requestDigest: args.requestDigest,
      details: {
        counts: release.acceptedCounts,
        entityChainHashes: release.acceptedEntityChainHashes,
        searchRowSetHash: release.acceptedSearchRowSetHash,
        contentHash,
        completedAt: serverTime,
      },
    });
    return await storeReceipt(ctx, receipt);
  },
});

export const activate = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertRequestDigest(args.requestDigest);
    const request = parseRequest(
      args.bodyJson,
      dataReleaseV3ActivateRequestSchema,
    );
    const replay = await loadExactReplay(ctx, {
      operationKind: "activate",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      requestDigest: args.requestDigest,
    });
    if (replay !== null) return replay;

    const release = await loadDataReleaseV3ByPublicReleaseId(
      ctx,
      request.publicReleaseId,
    );
    if (release === null || release.lifecycle !== "complete") {
      refuse("PUBLICATION_STATE_CONFLICT");
    }
    if (release.releaseFingerprint !== request.releaseFingerprint) {
      refuse("PUBLICATION_MANIFEST_MISMATCH");
    }
    const state = await loadActiveDataReleaseV3State(ctx);
    const activePublicReleaseId =
      state?.activeRelease?.publicReleaseId ?? null;
    if (activePublicReleaseId !== request.expectedActivePublicReleaseId) {
      refuse("PUBLICATION_PREDECESSOR_CONFLICT");
    }
    if (activePublicReleaseId === request.publicReleaseId) {
      refuse("PUBLICATION_PREDECESSOR_CONFLICT");
    }
    // dataAsOf monotonicity: the candidate's canonical watermark (stamped by
    // the assembler as the release read clock) must not be strictly older
    // than the active release's, so replaying an older complete plan whose
    // predecessor expectation happens to match can never move the public
    // catalog backward in time. Pointer reversal remains the job of the
    // `rollback` mutation; the explicit request override documents the rare
    // operator-intentional roll-forward to older data.
    if (
      request.allowDataAsOfRegression !== true &&
      state !== null &&
      state.activeRelease !== null &&
      Date.parse(release.dataAsOf) < Date.parse(state.activeRelease.dataAsOf)
    ) {
      refuse("PUBLICATION_DATA_REGRESSION");
    }
    const serverTime = new Date().toISOString();
    const pointer = releasePointer(release);
    const previousRelease = state?.activeReleaseId
      ? await ctx.db.get("dataReleaseV3Releases", state.activeReleaseId) : null;
    if (state?.activeReleaseId && previousRelease === null) refuse("PUBLICATION_STATE_CONFLICT");
    const retainedEv = await activateRetainedEv(ctx, {
      previousRelease,
      nextRelease: release,
      seedPrevious: state?.retainedEvTransitionId === undefined,
      operationId: request.operationId,
    });
    // Seeding legacy history is also a one-way reader cutover. Rollback must
    // not make this predecessor eligible for snapshot reads again.
    if (state?.retainedEvTransitionId === undefined && previousRelease !== null &&
        previousRelease.publicEvPolicyVersion === PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3 &&
        previousRelease.evFactsRequired === undefined) {
      await ctx.db.patch("dataReleaseV3Releases", previousRelease._id, { evFactsRequired: true });
    }
    const core = {
      generation: (state?.generation ?? 0) + 1,
      activeReleaseId: release._id,
      previousReleaseId: state?.activeReleaseId ?? null,
      activeRelease: pointer,
      previousRelease: state?.activeRelease ?? null,
      terminalOperationId: request.operationId,
      ...retainedEv,
      updatedAt: serverTime,
    };
    if (state === null) {
      await ctx.db.insert("activeDataReleaseV3State", {
        key: "singleton",
        ...core,
      });
    } else {
      await ctx.db.patch("activeDataReleaseV3State", state._id, core);
    }
    const receipt = await buildReceipt({
      schemaVersion: DATA_RELEASE_V3_SCHEMA_VERSION,
      operationKind: "activate",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.publicReleaseId,
      result: "activated",
      serverTime,
      requestDigest: args.requestDigest,
      details: {
        generation: core.generation,
        activeRelease: core.activeRelease,
        previousRelease: core.previousRelease,
      },
    });
    return await storeReceipt(ctx, receipt);
  },
});

export const rollback = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertRequestDigest(args.requestDigest);
    const request = parseRequest(
      args.bodyJson,
      dataReleaseV3RollbackRequestSchema,
    );
    const replay = await loadExactReplay(ctx, {
      operationKind: "rollback",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      requestDigest: args.requestDigest,
    });
    if (replay !== null) return replay;

    const state = await loadActiveDataReleaseV3State(ctx);
    if (
      state === null ||
      state.activeRelease === null ||
      state.activeRelease.publicReleaseId !==
        request.expectedActivePublicReleaseId
    ) {
      refuse("PUBLICATION_PREDECESSOR_CONFLICT");
    }
    if (
      state.previousRelease === null ||
      state.previousReleaseId === null ||
      state.previousRelease.publicReleaseId !== request.targetPublicReleaseId
    ) {
      refuse("PUBLICATION_ROLLBACK_UNSAFE");
    }
    const target = await ctx.db.get(
      "dataReleaseV3Releases",
      state.previousReleaseId,
    );
    if (
      target === null ||
      target.lifecycle !== "complete" ||
      target.publicReleaseId !== request.targetPublicReleaseId ||
      target.publicEvPolicyVersion !== PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3 ||
      state.previousRelease.publicEvPolicyVersion !==
        PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3
    ) {
      refuse("PUBLICATION_ROLLBACK_UNSAFE");
    }
    const serverTime = new Date().toISOString();
    const retainedEv = await rollbackRetainedEv(ctx, state);
    const core = {
      generation: state.generation + 1,
      activeReleaseId: state.previousReleaseId,
      previousReleaseId: state.activeReleaseId,
      activeRelease: state.previousRelease,
      previousRelease: state.activeRelease,
      terminalOperationId: request.operationId,
      ...retainedEv,
      updatedAt: serverTime,
    };
    await ctx.db.patch("activeDataReleaseV3State", state._id, core);
    const receipt = await buildReceipt({
      schemaVersion: DATA_RELEASE_V3_SCHEMA_VERSION,
      operationKind: "rollback",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.targetPublicReleaseId,
      result: "rolled_back",
      serverTime,
      requestDigest: args.requestDigest,
      details: {
        generation: core.generation,
        activeRelease: core.activeRelease,
        previousRelease: core.previousRelease,
      },
    });
    return await storeReceipt(ctx, receipt);
  },
});

export const activeState = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const state = await loadActiveDataReleaseV3State(ctx);
    return {
      generation: state?.generation ?? 0,
      activeRelease: state?.activeRelease ?? null,
      previousRelease: state?.previousRelease ?? null,
    };
  },
});

export const status = internalQuery({
  args: { publicReleaseId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const release = await loadDataReleaseV3ByPublicReleaseId(
      ctx,
      args.publicReleaseId,
    );
    if (release === null) return null;
    return {
      publicReleaseId: release.publicReleaseId,
      releaseFingerprint: release.releaseFingerprint,
      lifecycle: release.lifecycle,
      acceptedCounts: release.acceptedCounts,
      acceptedBatchCount: release.acceptedBatchCount,
      acceptedBatchChainHash: release.acceptedBatchChainHash,
      acceptedEntityChainHashes: release.acceptedEntityChainHashes,
      acceptedSearchRowCount: release.acceptedSearchRowCount,
      acceptedSearchRowSetHash: release.acceptedSearchRowSetHash,
      // Both top-chase counters are exposed so a reconciliation refusal is
      // diagnosable from outside Convex. When the verified guard is what
      // trips, the declared count still equals the manifest, so every check
      // the publisher can run on its own passes and the refusal is otherwise
      // opaque. The verified count is reported verbatim and the key is
      // omitted when the field is absent: a release staged before the counter
      // existed must stay distinguishable from one this server verified as
      // zero, because the publisher's divergence checks are presence-guarded.
      acceptedTopChaseCount: release.acceptedTopChaseCount,
      ...(release.acceptedVerifiedTopChaseCount === undefined
        ? {}
        : {
          acceptedVerifiedTopChaseCount:
            release.acceptedVerifiedTopChaseCount,
        }),
      completedAt: release.completedAt,
    };
  },
});
