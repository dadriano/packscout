import {
  DATA_RELEASE_SCHEMA_VERSION,
  REPACK_SEARCH_VERSION,
  dataReleaseMetadataSchema,
} from "@packscout/contracts";
import type { z } from "zod";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { env, internalMutation, type MutationCtx } from "./_generated/server";
import {
  REPACK_SEARCH_INDEX_HASH_DOMAIN,
  REPACK_SEARCH_SHARD_HASH_DOMAIN,
  canonicalJson,
  sha256CanonicalJson,
} from "./dataReleaseCanonicalHash";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";
import {
  loadExactOperationReplay,
  loadReceiptByOperationId,
  storeProductionReceipt,
} from "./productionDataReleaseOperations";
import {
  MAX_PRODUCTION_HTTP_BODY_BYTES,
  containsProtectedPublicationField,
  parseStrictJson,
  productionFinalizeRequestSchema,
  productionRefreshRequestSchema,
  productionStartRequestSchema,
  productionStatusRequestSchema,
  recomputeProductionManifestFingerprint,
  recomputeProductionOriginSetHash,
  type ProductionFinalizeRequest,
  type ProductionRefreshRequest,
  type ProductionStartRequest,
  type ProductionStatusRequest,
} from "./productionDataReleaseProtocol";
import { MAX_REPACK_SEARCH_SHARDS } from "./publicRepackValidation";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
};
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_CLOCK_SKEW_MILLISECONDS = 5 * 60 * 1_000;
const STAGING_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const COMPLETE_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

function parseRequest<T>(
  bodyJson: string,
  schema: z.ZodType<T>,
): T {
  if (new TextEncoder().encode(bodyJson).byteLength > MAX_PRODUCTION_HTTP_BODY_BYTES) {
    refuseProductionDataRelease("PUBLICATION_BODY_TOO_LARGE");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bodyJson) as unknown;
  } catch {
    return refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("schemaVersion" in raw) ||
    (raw as { schemaVersion?: unknown }).schemaVersion !==
      DATA_RELEASE_SCHEMA_VERSION
  ) {
    refuseProductionDataRelease("PUBLICATION_SCHEMA_UNSUPPORTED");
  }
  if (containsProtectedPublicationField(raw)) {
    refuseProductionDataRelease("PUBLICATION_PROTECTED_FIELD");
  }
  return parseStrictJson(bodyJson, schema) ??
    refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
}

function assertRequestDigest(requestDigest: string): void {
  if (!SHA256_PATTERN.test(requestDigest)) {
    refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
  }
}

async function singletonState(
  ctx: MutationCtx,
): Promise<Doc<"dataReleaseState"> | null> {
  const states = await ctx.db
    .query("dataReleaseState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (states.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return states[0] ?? null;
}

async function activeRelease(
  ctx: MutationCtx,
  state: Doc<"dataReleaseState"> | null,
): Promise<Doc<"dataReleases"> | null> {
  if (state?.activeReleaseId === null || state === null) return null;
  const release = await ctx.db.get("dataReleases", state.activeReleaseId);
  if (release === null || release.lifecycle !== "complete") {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return release;
}

async function assertExpectedPredecessor(
  ctx: MutationCtx,
  expectedPublicReleaseId: string | null,
): Promise<{
  state: Doc<"dataReleaseState"> | null;
  active: Doc<"dataReleases"> | null;
}> {
  const state = await singletonState(ctx);
  const active = await activeRelease(ctx, state);
  if ((active?.publicReleaseId ?? null) !== expectedPublicReleaseId) {
    refuseProductionDataRelease("PUBLICATION_PREDECESSOR_CONFLICT");
  }
  return { state, active };
}

async function assertManifestNotBlocked(
  ctx: MutationCtx,
  fingerprint: string,
): Promise<void> {
  const blocks = await ctx.db
    .query("blockedDataReleaseManifests")
    .withIndex("by_fingerprint_and_active", (index) =>
      index.eq("fingerprint", fingerprint).eq("active", true),
    )
    .take(2);
  if (blocks.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  if (blocks.length === 1) {
    refuseProductionDataRelease("PUBLICATION_MANIFEST_BLOCKED");
  }
}

function approvedOriginSetHash(): string {
  const configured = env.PACKSCOUT_PUBLIC_ORIGIN_SET_HASH ?? "";
  if (!SHA256_PATTERN.test(configured)) {
    refuseProductionDataRelease("PUBLICATION_MANIFEST_MISMATCH");
  }
  return configured;
}

async function assertStartManifest(
  request: ProductionStartRequest,
  serverNow: number,
): Promise<void> {
  const manifest = request.manifest;
  const createdAt = Date.parse(manifest.createdAt);
  const dataAsOf = Date.parse(manifest.dataAsOf);
  const observedAt = Date.parse(manifest.lastSuccessfulObservationAt);
  const staleAt = Date.parse(manifest.staleAt);
  if (
    request.publicationId !== manifest.publicReleaseId ||
    manifest.counts.searchShards === 0 !== (manifest.counts.repacks === 0) ||
    manifest.delayedVendorCount > manifest.counts.vendors ||
    (manifest.freshness === "fresh" && manifest.delayedVendorCount !== 0) ||
    createdAt > serverNow + MAX_CLOCK_SKEW_MILLISECONDS ||
    dataAsOf > observedAt ||
    staleAt <= observedAt ||
    manifest.publicAssetOrigins.some(
      (origin, index) =>
        index > 0 && origin <= manifest.publicAssetOrigins[index - 1]!,
    ) ||
    manifest.originSetHash !==
      await recomputeProductionOriginSetHash(manifest.publicAssetOrigins) ||
    manifest.originSetHash !== approvedOriginSetHash() ||
    manifest.manifestFingerprint !==
      await recomputeProductionManifestFingerprint(request)
  ) {
    refuseProductionDataRelease("PUBLICATION_MANIFEST_MISMATCH");
  }
}

async function onePublication(
  ctx: MutationCtx,
  publicationId: string,
): Promise<Doc<"dataReleasePublications"> | null> {
  const publications = await ctx.db
    .query("dataReleasePublications")
    .withIndex("by_publication_id", (index) =>
      index.eq("publicationId", publicationId),
    )
    .take(2);
  if (publications.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return publications[0] ?? null;
}

export const start = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertRequestDigest(args.requestDigest);
    const request = parseRequest(args.bodyJson, productionStartRequestSchema);
    const replay = await loadExactOperationReplay(ctx, {
      kind: "start",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      bodyHash: args.requestDigest,
    });
    if (replay !== null) return replay;

    const serverNow = Date.now();
    await assertStartManifest(request, serverNow);
    await assertManifestNotBlocked(ctx, request.manifest.manifestFingerprint);
    const { state, active } = await assertExpectedPredecessor(
      ctx,
      request.expectedPredecessorPublicReleaseId,
    );
    if (
      state !== null &&
      request.manifest.observationSequence <= state.latestObservationSequence
    ) {
      refuseProductionDataRelease("PUBLICATION_SEQUENCE_REGRESSED");
    }
    if (active?.metadata.contentHash === request.manifest.contentHash) {
      refuseProductionDataRelease("PUBLICATION_MANIFEST_MISMATCH");
    }
    const [existingPublication, existingReleases] = await Promise.all([
      onePublication(ctx, request.publicationId),
      ctx.db
        .query("dataReleases")
        .withIndex("by_public_release_id", (index) =>
          index.eq("publicReleaseId", request.publicationId),
        )
        .take(2),
    ]);
    if (existingPublication !== null || existingReleases.length !== 0) {
      refuseProductionDataRelease("PUBLICATION_OPERATION_CONFLICT");
    }

    const now = new Date(serverNow).toISOString();
    const manifest = request.manifest;
    const releaseId = await ctx.db.insert("dataReleases", {
      publicReleaseId: request.publicationId,
      lifecycle: "staging",
      metadata: {
        schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
        dataSource: "canonical",
        publicReleaseId: request.publicationId,
        sourceWatermark: manifest.sourceWatermark,
        manifestFingerprint: manifest.manifestFingerprint,
        contentHash: manifest.contentHash,
        publicConfigRevision: manifest.publicConfigRevision,
        publicConfigHash: manifest.publicConfigHash,
        originSetHash: manifest.originSetHash,
        searchAlgorithmVersion: REPACK_SEARCH_VERSION,
        repackSearchIndexHash: manifest.repackSearchIndexHash,
        confidencePolicyVersion: manifest.confidencePolicyVersion,
        createdAt: manifest.createdAt,
        completedAt: null,
        dataAsOf: manifest.dataAsOf,
        lastSuccessfulObservationAt: manifest.lastSuccessfulObservationAt,
        staleAt: manifest.staleAt,
        freshness: manifest.freshness,
        delayedVendorCount: manifest.delayedVendorCount,
        vendorCount: manifest.counts.vendors,
        categoryCount: manifest.counts.categories,
        repackCount: manifest.counts.repacks,
        collectibleCount: manifest.counts.collectibles,
        repackChaseCount: manifest.counts.repackChases,
      },
      searchShardCount: manifest.counts.searchShards,
      retentionEligibleAt: new Date(
        serverNow + STAGING_RETENTION_MILLISECONDS,
      ).toISOString(),
    });
    const zeroCounts = {
      vendors: 0,
      categories: 0,
      collectibles: 0,
      repacks: 0,
      repackChases: 0,
      searchShards: 0,
    };
    await ctx.db.insert("dataReleasePublications", {
      publicationId: request.publicationId,
      releaseId,
      expectedPredecessorPublicReleaseId:
        request.expectedPredecessorPublicReleaseId,
      publicAssetOrigins: manifest.publicAssetOrigins,
      expectedBatchCount: manifest.batchCount,
      expectedBatchChainHash: manifest.batchChainHash,
      acceptedBatchCount: 0,
      acceptedBatchChainHash: "0".repeat(64),
      expectedCounts: manifest.counts,
      acceptedCounts: zeroCounts,
      observationSequence: manifest.observationSequence,
      lastBatchKind: null,
      lastRecordKey: null,
      lastSearchPublicRepackId: null,
      unresolvedRepackCount: 0,
      latestEvidenceAt: null,
      state: "staging",
      createdAt: now,
      completedAt: null,
    });
    return await storeProductionReceipt(ctx, {
      operationId: request.operationId,
      operationKind: "start",
      idempotencyKey: request.idempotencyKey,
      publicationId: request.publicationId,
      terminalState: "staging",
      result: "created",
      serverTime: now,
      requestDigest: args.requestDigest,
      releaseVersion: manifest.manifestFingerprint,
      observationSequence: manifest.observationSequence,
      details: {
        sourceWatermark: manifest.sourceWatermark,
        manifestFingerprint: manifest.manifestFingerprint,
        contentHash: manifest.contentHash,
        expectedBatchCount: manifest.batchCount,
        expectedBatchChainHash: manifest.batchChainHash,
        expectedCounts: manifest.counts,
      },
    });
  },
});

async function reconcileSearchIndex(
  ctx: MutationCtx,
  release: Doc<"dataReleases">,
): Promise<boolean> {
  const shards = await ctx.db
    .query("repackSearchShards")
    .withIndex("by_release_id_and_shard_number", (index) =>
      index.eq("releaseId", release._id),
    )
    .order("asc")
    .take(MAX_REPACK_SEARCH_SHARDS + 1);
  if (shards.length !== release.searchShardCount) return false;
  const descriptors = [];
  let totalRows = 0;
  let lastPublicRepackId: string | null = null;
  for (const [index, shard] of shards.entries()) {
    const byteCount = new TextEncoder().encode(canonicalJson(shard.rows)).byteLength;
    if (
      shard.shardNumber !== index ||
      shard.rowCount !== shard.rows.length ||
      shard.byteCount !== byteCount ||
      shard.contentHash !==
        await sha256CanonicalJson(REPACK_SEARCH_SHARD_HASH_DOMAIN, shard.rows)
    ) {
      return false;
    }
    for (const row of shard.rows) {
      if (
        lastPublicRepackId !== null &&
        row.publicRepackId <= lastPublicRepackId
      ) {
        return false;
      }
      lastPublicRepackId = row.publicRepackId;
      totalRows += 1;
    }
    descriptors.push({
      shardNumber: shard.shardNumber,
      rowCount: shard.rowCount,
      byteCount: shard.byteCount,
      contentHash: shard.contentHash,
    });
  }
  return totalRows === release.metadata.repackCount &&
    release.metadata.repackSearchIndexHash ===
    await sha256CanonicalJson(REPACK_SEARCH_INDEX_HASH_DOMAIN, descriptors);
}

export const finalize = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertRequestDigest(args.requestDigest);
    const request: ProductionFinalizeRequest = parseRequest(
      args.bodyJson,
      productionFinalizeRequestSchema,
    );
    const replay = await loadExactOperationReplay(ctx, {
      kind: "finalize",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      bodyHash: args.requestDigest,
    });
    if (replay !== null) return replay;

    const publication = await onePublication(ctx, request.publicationId);
    if (publication === null || publication.state !== "staging") {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    const release = await ctx.db.get("dataReleases", publication.releaseId);
    if (release === null || release.lifecycle !== "staging") {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    await assertManifestNotBlocked(ctx, release.metadata.manifestFingerprint);
    const { state, active } = await assertExpectedPredecessor(
      ctx,
      request.expectedPredecessorPublicReleaseId,
    );
    const serverNow = Date.now();
    const completedAt = new Date(serverNow).toISOString();
    if (
      request.expectedPredecessorPublicReleaseId !==
        publication.expectedPredecessorPublicReleaseId ||
      canonicalJson(request.expectedCounts) !==
        canonicalJson(publication.expectedCounts) ||
      request.expectedBatchCount !== publication.expectedBatchCount ||
      request.expectedBatchChainHash !== publication.expectedBatchChainHash ||
      publication.acceptedBatchCount !== publication.expectedBatchCount ||
      publication.acceptedBatchChainHash !==
        publication.expectedBatchChainHash ||
      canonicalJson(publication.acceptedCounts) !==
        canonicalJson(publication.expectedCounts) ||
      publication.unresolvedRepackCount !== 0 ||
      (publication.latestEvidenceAt !== null &&
        Date.parse(publication.latestEvidenceAt) > serverNow) ||
      !(await reconcileSearchIndex(ctx, release))
    ) {
      refuseProductionDataRelease("PUBLICATION_RECONCILIATION_FAILED");
    }
    if (
      state !== null &&
      publication.observationSequence <= state.latestObservationSequence
    ) {
      refuseProductionDataRelease("PUBLICATION_SEQUENCE_REGRESSED");
    }
    if (release.metadata.originSetHash !== approvedOriginSetHash()) {
      refuseProductionDataRelease("PUBLICATION_MANIFEST_MISMATCH");
    }
    const parsedMetadata = dataReleaseMetadataSchema.safeParse({
      ...release.metadata,
      completedAt,
    });
    if (!parsedMetadata.success) {
      refuseProductionDataRelease("PUBLICATION_RECONCILIATION_FAILED");
    }

    await ctx.db.patch("dataReleases", release._id, {
      lifecycle: "complete",
      metadata: parsedMetadata.data,
      retentionEligibleAt: new Date(
        serverNow + COMPLETE_RETENTION_MILLISECONDS,
      ).toISOString(),
    });
    await ctx.db.patch("dataReleasePublications", publication._id, {
      state: "complete",
      completedAt,
    });
    const stateFields = {
      activeReleaseId: release._id,
      previousReleaseId: active?._id ?? null,
      latestObservationSequence: publication.observationSequence,
      dataAsOf: parsedMetadata.data.dataAsOf,
      lastSuccessfulObservationAt:
        parsedMetadata.data.lastSuccessfulObservationAt,
      staleAt: parsedMetadata.data.staleAt,
      freshness: parsedMetadata.data.freshness,
      delayedVendorCount: parsedMetadata.data.delayedVendorCount,
      updatedAt: completedAt,
    } as const;
    if (state === null) {
      await ctx.db.insert("dataReleaseState", {
        key: "singleton",
        ...stateFields,
      });
    } else {
      await ctx.db.patch("dataReleaseState", state._id, stateFields);
    }
    return await storeProductionReceipt(ctx, {
      operationId: request.operationId,
      operationKind: "finalize",
      idempotencyKey: request.idempotencyKey,
      publicationId: request.publicationId,
      terminalState: "complete",
      result: "activated",
      serverTime: completedAt,
      requestDigest: args.requestDigest,
      releaseVersion: release.metadata.manifestFingerprint,
      observationSequence: publication.observationSequence,
      details: {
        manifestFingerprint: release.metadata.manifestFingerprint,
        contentHash: release.metadata.contentHash,
        sourceWatermark: release.metadata.sourceWatermark,
        activePublicReleaseId: release.publicReleaseId,
        previousPublicReleaseId: active?.publicReleaseId ?? null,
        counts: publication.acceptedCounts,
        batchCount: publication.acceptedBatchCount,
        batchChainHash: publication.acceptedBatchChainHash,
      },
    });
  },
});

function assertRefreshTimeline(
  request: ProductionRefreshRequest,
  state: Doc<"dataReleaseState">,
): void {
  if (
    request.observationSequence <= state.latestObservationSequence ||
    Date.parse(request.dataAsOf) < Date.parse(state.dataAsOf) ||
    Date.parse(request.lastSuccessfulObservationAt) <=
      Date.parse(state.lastSuccessfulObservationAt) ||
    Date.parse(request.dataAsOf) >
      Date.parse(request.lastSuccessfulObservationAt) ||
    Date.parse(request.staleAt) <=
      Date.parse(request.lastSuccessfulObservationAt) ||
    (request.freshness === "fresh" && request.delayedVendorCount !== 0)
  ) {
    refuseProductionDataRelease("PUBLICATION_REFRESH_STALE");
  }
}

export const refreshObservation = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertRequestDigest(args.requestDigest);
    const request: ProductionRefreshRequest = parseRequest(
      args.bodyJson,
      productionRefreshRequestSchema,
    );
    const replay = await loadExactOperationReplay(ctx, {
      kind: "refreshObservation",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      bodyHash: args.requestDigest,
    });
    if (replay !== null) return replay;
    const state = await singletonState(ctx);
    if (state === null || state.activeReleaseId === null) {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    const release = await ctx.db.get("dataReleases", state.activeReleaseId);
    if (
      release === null ||
      release.lifecycle !== "complete" ||
      release.publicReleaseId !== request.publicReleaseId ||
      release.metadata.contentHash !== request.contentHash
    ) {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    assertRefreshTimeline(request, state);
    const now = new Date().toISOString();
    await ctx.db.patch("dataReleaseState", state._id, {
      latestObservationSequence: request.observationSequence,
      dataAsOf: request.dataAsOf,
      lastSuccessfulObservationAt: request.lastSuccessfulObservationAt,
      staleAt: request.staleAt,
      freshness: request.freshness,
      delayedVendorCount: request.delayedVendorCount,
      updatedAt: now,
    });
    return await storeProductionReceipt(ctx, {
      operationId: request.operationId,
      operationKind: "refreshObservation",
      idempotencyKey: request.idempotencyKey,
      publicationId: request.publicReleaseId,
      terminalState: "complete",
      result: "refreshed",
      serverTime: now,
      requestDigest: args.requestDigest,
      releaseVersion: release.metadata.manifestFingerprint,
      observationSequence: request.observationSequence,
      details: {
        contentHash: request.contentHash,
        observationSequence: request.observationSequence,
        dataAsOf: request.dataAsOf,
        lastSuccessfulObservationAt: request.lastSuccessfulObservationAt,
        staleAt: request.staleAt,
        freshness: request.freshness,
        delayedVendorCount: request.delayedVendorCount,
      },
    });
  },
});

export const status = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertRequestDigest(args.requestDigest);
    const request: ProductionStatusRequest = parseRequest(
      args.bodyJson,
      productionStatusRequestSchema,
    );
    const receipt = await loadReceiptByOperationId(
      ctx,
      request.operationId,
      request.publicationId,
    );
    return receipt === null
      ? {
          schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
          operationId: request.operationId,
          publicationId: request.publicationId,
          terminalState: "not_found",
          result: "not_found",
          serverTime: new Date().toISOString(),
          requestDigest: args.requestDigest,
          details: {},
          receiptDigest: null,
        }
      : receipt;
  },
});

export function productionErrorCode(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as { code?: unknown };
  return typeof data.code === "string" ? data.code : null;
}
