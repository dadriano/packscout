import { DATA_RELEASE_V3_SCHEMA_VERSION, dataReleaseV3RetainedEvWitnessRequestSchema,
  dataReleaseV3RetainedEvWitnessReadinessRequestSchema,
  dataReleaseV3RetainedEvWitnessWithinByteLimit } from "@packscout/contracts";
import { v } from "convex/values";
import { z } from "zod";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { canonicalJson, sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import {
  DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
  loadActiveDataReleaseV3State,
  loadDataReleaseV3ByPublicReleaseId,
} from "./dataReleaseV3Lifecycle";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";
import { readRetainedEvWitness, readRetainedEvWitnessReadiness } from "./dataReleaseV3RetainedEvWitness";

/**
 * Authenticated read endpoints for the data_release_v3 publication transport
 * (task buyback-adjusted-ev/008).
 *
 * The lifecycle module owns the internal `activeState`/`status` queries used
 * by other Convex functions; this module wraps the same reads as
 * `{bodyJson, requestDigest}` mutations so `convex/http.ts` can serve them
 * through the shared signed publication boundary. Each response is a
 * self-digesting receipt in the exact lifecycle receipt shape, so the
 * publishing client verifies every read with the same
 * `DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN` digest it uses for writes. Read
 * receipts are never stored: they carry fresh server time and bind to the
 * request digest of the exact bytes received.
 */

const operationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u);

const activeStateRequestSchema = z
  .object({
    schemaVersion: z.literal(DATA_RELEASE_V3_SCHEMA_VERSION),
    operationId: operationIdSchema,
  })
  .strict();

const statusRequestSchema = z
  .object({
    schemaVersion: z.literal(DATA_RELEASE_V3_SCHEMA_VERSION),
    operationId: operationIdSchema,
    publicReleaseId: z.uuid(),
  })
  .strict();

function parseReadRequest<T>(bodyJson: string, schema: z.ZodType<T>): T {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyJson);
  } catch {
    refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
  }
  if (
    typeof parsedJson === "object" &&
    parsedJson !== null &&
    "schemaVersion" in parsedJson &&
    parsedJson.schemaVersion !== DATA_RELEASE_V3_SCHEMA_VERSION
  ) {
    refuseProductionDataRelease("PUBLICATION_SCHEMA_UNSUPPORTED");
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
  }
  return parsed.data;
}

function assertReadRequestDigest(requestDigest: string): void {
  if (!/^[0-9a-f]{64}$/u.test(requestDigest)) {
    refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
  }
}

async function buildReadReceipt(input: {
  readonly operationKind: "activeState" | "status" | "retainedEvWitness" | "retainedEvWitnessReadiness";
  readonly operationId: string;
  readonly publicReleaseId: string | null;
  readonly result: string;
  readonly requestDigest: string;
  readonly details: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const receiptWithoutDigest = {
    schemaVersion: DATA_RELEASE_V3_SCHEMA_VERSION,
    operationKind: input.operationKind,
    operationId: input.operationId,
    idempotencyKey: input.operationId,
    publicReleaseId: input.publicReleaseId,
    result: input.result,
    serverTime: new Date().toISOString(),
    requestDigest: input.requestDigest,
    details: input.details,
  };
  return {
    ...receiptWithoutDigest,
    receiptDigest: await sha256CanonicalJson(
      DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
      receiptWithoutDigest,
    ),
  };
}

/**
 * A pointer the transport reports must still name a stored, complete,
 * fully reconciled release; anything else is a state conflict, never a
 * silently degraded answer.
 */
async function assertReleasePointerCoherent(
  ctx: MutationCtx,
  releaseId: Id<"dataReleaseV3Releases">,
  pointer: NonNullable<Doc<"activeDataReleaseV3State">["activeRelease"]>,
): Promise<void> {
  const release = await ctx.db.get("dataReleaseV3Releases", releaseId);
  if (
    release === null ||
    release.lifecycle !== "complete" ||
    release.completedAt === null ||
    release.publicReleaseId !== pointer.publicReleaseId ||
    release.releaseFingerprint !== pointer.releaseFingerprint ||
    release.completedAt !== pointer.completedAt ||
    canonicalJson(release.expectedCounts) !== canonicalJson(pointer.counts) ||
    canonicalJson(release.acceptedCounts) !==
      canonicalJson(release.expectedCounts) ||
    canonicalJson(release.acceptedEntityChainHashes) !==
      canonicalJson(release.expectedEntityChainHashes) ||
    release.acceptedBatchCount !== release.expectedBatchCount ||
    release.acceptedBatchChainHash !== release.expectedBatchChainHash ||
    release.acceptedSearchRowCount !== release.expectedCounts.repacks
  ) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
}

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
} as const;

export const retainedEvWitness = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertReadRequestDigest(args.requestDigest);
    const request = parseReadRequest(args.bodyJson, z.union([dataReleaseV3RetainedEvWitnessRequestSchema.extend({
      schemaVersion: z.literal(DATA_RELEASE_V3_SCHEMA_VERSION), operationId: operationIdSchema,
    }).strict(), dataReleaseV3RetainedEvWitnessReadinessRequestSchema.safeExtend({
      schemaVersion: z.literal(DATA_RELEASE_V3_SCHEMA_VERSION), operationId: operationIdSchema,
      mode: z.literal("readiness"),
    })]));
    if ("mode" in request) {
      return buildReadReceipt({ operationKind: "retainedEvWitnessReadiness", operationId: request.operationId,
        publicReleaseId: request.expectedActivePublicReleaseId, result: "retained_ev_witness_ready",
        requestDigest: args.requestDigest, details: await readRetainedEvWitnessReadiness(ctx, request) });
    }
    const witness = await readRetainedEvWitness(ctx, request);
    const receipt = await buildReadReceipt({ operationKind: "retainedEvWitness", operationId: request.operationId,
      publicReleaseId: request.expectedActivePublicReleaseId, result: "retained_ev_witness",
      requestDigest: args.requestDigest, details: witness });
    if (!dataReleaseV3RetainedEvWitnessWithinByteLimit(receipt)) refuseProductionDataRelease("PUBLICATION_BODY_TOO_LARGE");
    return receipt;
  },
});

export const activeState = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertReadRequestDigest(args.requestDigest);
    const request = parseReadRequest(args.bodyJson, activeStateRequestSchema);
    const state = await loadActiveDataReleaseV3State(ctx);
    if (state !== null) {
      if (
        (state.activeReleaseId === null) !== (state.activeRelease === null) ||
        (state.previousReleaseId === null) !== (state.previousRelease === null)
      ) {
        refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
      }
      if (state.activeReleaseId !== null && state.activeRelease !== null) {
        await assertReleasePointerCoherent(
          ctx,
          state.activeReleaseId,
          state.activeRelease,
        );
      }
      if (state.previousReleaseId !== null && state.previousRelease !== null) {
        await assertReleasePointerCoherent(
          ctx,
          state.previousReleaseId,
          state.previousRelease,
        );
      }
    }
    return await buildReadReceipt({
      operationKind: "activeState",
      operationId: request.operationId,
      publicReleaseId: state?.activeRelease?.publicReleaseId ?? null,
      result: "active_state",
      requestDigest: args.requestDigest,
      details: {
        generation: state?.generation ?? 0,
        activeRelease: state?.activeRelease ?? null,
        previousRelease: state?.previousRelease ?? null,
      },
    });
  },
});

export const status = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertReadRequestDigest(args.requestDigest);
    const request = parseReadRequest(args.bodyJson, statusRequestSchema);
    const release = await loadDataReleaseV3ByPublicReleaseId(
      ctx,
      request.publicReleaseId,
    );
    if (release === null) {
      return await buildReadReceipt({
        operationKind: "status",
        operationId: request.operationId,
        publicReleaseId: request.publicReleaseId,
        result: "not_found",
        requestDigest: args.requestDigest,
        details: {},
      });
    }
    return await buildReadReceipt({
      operationKind: "status",
      operationId: request.operationId,
      publicReleaseId: request.publicReleaseId,
      result: "status",
      requestDigest: args.requestDigest,
      details: {
        status: {
          publicReleaseId: release.publicReleaseId,
          releaseFingerprint: release.releaseFingerprint,
          lifecycle: release.lifecycle,
          acceptedCounts: release.acceptedCounts,
          acceptedBatchCount: release.acceptedBatchCount,
          acceptedBatchChainHash: release.acceptedBatchChainHash,
          acceptedEntityChainHashes: release.acceptedEntityChainHashes,
          acceptedSearchRowCount: release.acceptedSearchRowCount,
          acceptedSearchRowSetHash: release.acceptedSearchRowSetHash,
          // Declared and verified top chases are both reported: when the
          // verified guard is what refuses a finalize, the declared count
          // still matches the manifest, so this pair is the only thing that
          // explains a `PUBLICATION_RECONCILIATION_FAILED` to an operator.
          // The verified count is reported verbatim and its key omitted when
          // the field is absent, so a release staged before the counter
          // existed stays distinguishable from one this server verified as
          // zero — the publisher's divergence checks are presence-guarded.
          acceptedTopChaseCount: release.acceptedTopChaseCount,
          ...(release.acceptedVerifiedTopChaseCount === undefined
            ? {}
            : {
              acceptedVerifiedTopChaseCount:
                release.acceptedVerifiedTopChaseCount,
            }),
          completedAt: release.completedAt,
        },
      },
    });
  },
});
