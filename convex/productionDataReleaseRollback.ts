import {
  DATA_RELEASE_SCHEMA_VERSION,
  dataReleaseMetadataSchema,
} from "@packscout/contracts";
import type { z } from "zod";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { env, internalMutation, type MutationCtx } from "./_generated/server";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";
import {
  loadExactOperationReplay,
  storeProductionReceipt,
} from "./productionDataReleaseOperations";
import {
  MAX_PRODUCTION_HTTP_BODY_BYTES,
  containsProtectedPublicationField,
  parseStrictJson,
  productionRollbackRequestSchema,
  type ProductionRollbackRequest,
} from "./productionDataReleaseProtocol";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function parseRequest<T>(bodyJson: string, schema: z.ZodType<T>): T {
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

async function singletonState(ctx: MutationCtx): Promise<Doc<"dataReleaseState">> {
  const states = await ctx.db
    .query("dataReleaseState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (states.length !== 1 || states[0]!.activeReleaseId === null) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return states[0]!;
}

async function oneReleaseByPublicId(
  ctx: MutationCtx,
  publicReleaseId: string,
): Promise<Doc<"dataReleases"> | null> {
  const releases = await ctx.db
    .query("dataReleases")
    .withIndex("by_public_release_id", (index) =>
      index.eq("publicReleaseId", publicReleaseId),
    )
    .take(2);
  if (releases.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return releases[0] ?? null;
}

async function fingerprintIsBlocked(
  ctx: MutationCtx,
  fingerprint: string,
): Promise<boolean> {
  const blocks = await ctx.db
    .query("blockedDataReleaseManifests")
    .withIndex("by_fingerprint_and_active", (index) =>
      index.eq("fingerprint", fingerprint).eq("active", true),
    )
    .take(2);
  if (blocks.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return blocks.length === 1;
}

async function targetObservationSequence(
  ctx: MutationCtx,
  release: Doc<"dataReleases">,
): Promise<number> {
  const publications = await ctx.db
    .query("dataReleasePublications")
    .withIndex("by_release_id", (index) => index.eq("releaseId", release._id))
    .take(2);
  if (publications.length !== 1 || publications[0]!.state !== "complete") {
    refuseProductionDataRelease("PUBLICATION_ROLLBACK_UNSAFE");
  }
  return publications[0]!.observationSequence;
}

export const rollback = internalMutation({
  args: {
    bodyJson: v.string(),
    requestDigest: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!SHA256_PATTERN.test(args.requestDigest)) {
      refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
    }
    const request: ProductionRollbackRequest = parseRequest(
      args.bodyJson,
      productionRollbackRequestSchema,
    );
    const replay = await loadExactOperationReplay(ctx, {
      kind: "rollback",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      bodyHash: args.requestDigest,
    });
    if (replay !== null) return replay;

    const state = await singletonState(ctx);
    const outgoing = await ctx.db.get("dataReleases", state.activeReleaseId!);
    if (
      outgoing === null ||
      outgoing.lifecycle !== "complete" ||
      outgoing.publicReleaseId !== request.expectedActivePublicReleaseId
    ) {
      refuseProductionDataRelease("PUBLICATION_PREDECESSOR_CONFLICT");
    }
    const now = new Date().toISOString();
    if (request.targetPublicReleaseId === null) {
      if (
        request.clearAuthorization !== "clear_catalog_v1" ||
        env.PACKSCOUT_DATA_RELEASE_CLEAR_ENABLED !== "1"
      ) {
        refuseProductionDataRelease("PUBLICATION_CLEAR_DISABLED");
      }
      await ctx.db.patch("dataReleaseState", state._id, {
        activeReleaseId: null,
        previousReleaseId: null,
        updatedAt: now,
      });
      return await storeProductionReceipt(ctx, {
        operationId: request.operationId,
        operationKind: "rollback",
        idempotencyKey: request.idempotencyKey,
        publicationId: outgoing.publicReleaseId,
        terminalState: "cleared",
        result: "cleared",
        serverTime: now,
        requestDigest: args.requestDigest,
        releaseVersion: outgoing.metadata.manifestFingerprint,
        observationSequence: state.latestObservationSequence,
        details: {
          outgoingPublicReleaseId: outgoing.publicReleaseId,
          activePublicReleaseId: null,
          previousPublicReleaseId: null,
        },
      });
    }

    const target = await oneReleaseByPublicId(
      ctx,
      request.targetPublicReleaseId,
    );
    if (
      target === null ||
      target._id === outgoing._id ||
      target.lifecycle !== "complete" ||
      target.metadata.dataSource !== "canonical" ||
      target.metadata.completedAt === null ||
      target.metadata.originSetHash !== env.PACKSCOUT_PUBLIC_ORIGIN_SET_HASH ||
      (await fingerprintIsBlocked(ctx, target.metadata.manifestFingerprint))
    ) {
      refuseProductionDataRelease("PUBLICATION_ROLLBACK_UNSAFE");
    }
    const parsedMetadata = dataReleaseMetadataSchema.safeParse(target.metadata);
    if (!parsedMetadata.success) {
      refuseProductionDataRelease("PUBLICATION_ROLLBACK_UNSAFE");
    }
    const targetSequence = await targetObservationSequence(ctx, target);
    const outgoingBlocked = await fingerprintIsBlocked(
      ctx,
      outgoing.metadata.manifestFingerprint,
    );
    await ctx.db.patch("dataReleaseState", state._id, {
      activeReleaseId: target._id,
      previousReleaseId: outgoingBlocked ? null : outgoing._id,
      latestObservationSequence: Math.max(
        state.latestObservationSequence,
        targetSequence,
      ),
      dataAsOf: parsedMetadata.data.dataAsOf,
      lastSuccessfulObservationAt:
        parsedMetadata.data.lastSuccessfulObservationAt,
      staleAt: parsedMetadata.data.staleAt,
      freshness: parsedMetadata.data.freshness,
      delayedVendorCount: parsedMetadata.data.delayedVendorCount,
      updatedAt: now,
    });
    return await storeProductionReceipt(ctx, {
      operationId: request.operationId,
      operationKind: "rollback",
      idempotencyKey: request.idempotencyKey,
      publicationId: target.publicReleaseId,
      terminalState: "complete",
      result: "rolled_back",
      serverTime: now,
      requestDigest: args.requestDigest,
      releaseVersion: target.metadata.manifestFingerprint,
      observationSequence: targetSequence,
      details: {
        outgoingPublicReleaseId: outgoing.publicReleaseId,
        activePublicReleaseId: target.publicReleaseId,
        previousPublicReleaseId: outgoingBlocked
          ? null
          : outgoing.publicReleaseId,
        outgoingFingerprintBlocked: outgoingBlocked,
      },
    });
  },
});
