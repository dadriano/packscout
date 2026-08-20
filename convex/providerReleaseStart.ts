import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  initializeProviderCatalogReleaseEntityHashV1,
  providerReleaseStartReceiptSchema,
  providerReleaseStartRequestSchema,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { refuseProviderRelease } from "./providerReleaseErrors";
import {
  buildProviderReleaseReceipt,
  loadExactProviderOperationReplay,
  storeProviderReleaseReceipt,
} from "./providerReleaseOperations";
import {
  assertExpectedProviderHead,
  assertProviderPlatformAuthority,
  assertProviderReleaseNotBlocked,
  assertProviderReleaseProof,
  assertProviderRequestDigest,
  parseProviderReleaseRequest,
} from "./providerReleaseRequests";
import {
  oneProviderPublication,
  oneProviderRelease,
} from "./providerReleaseState";

const STAGING_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

export const start = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertProviderRequestDigest(args.requestDigest);
    const request = parseProviderReleaseRequest(
      args.bodyJson,
      providerReleaseStartRequestSchema,
    );
    assertProviderPlatformAuthority(
      args.authenticatedKeyId,
      request.release.platformKey,
    );
    const replay = await loadExactProviderOperationReplay(ctx, {
      operationKind: "start",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.release.platformKey,
      publicProviderReleaseId: request.release.publicProviderReleaseId,
      requestDigest: args.requestDigest,
    });
    if (replay !== null) return replay;

    await assertProviderReleaseProof(request);
    await assertProviderReleaseNotBlocked(
      ctx,
      request.release.platformKey,
      request.release.providerReleaseFingerprint,
    );
    await assertExpectedProviderHead(ctx, request);

    const [existingRelease, existingPublication, staging] = await Promise.all([
      oneProviderRelease(
        ctx,
        request.release.platformKey,
        request.release.publicProviderReleaseId,
      ),
      oneProviderPublication(ctx, request.release.publicProviderReleaseId),
      ctx.db
        .query("providerCatalogPublications")
        .withIndex("by_platform_key_and_state", (index) =>
          index
            .eq("platformKey", request.release.platformKey)
            .eq("state", "staging"),
        )
        .take(2),
    ]);
    if (
      existingRelease !== null ||
      existingPublication !== null ||
      staging.length !== 0
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_OPERATION_CONFLICT");
    }

    const acceptedEntityHashes = {} as Record<
      (typeof PROVIDER_CATALOG_RELEASE_BATCH_KINDS)[number],
      string
    >;
    for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
      acceptedEntityHashes[kind] =
        await initializeProviderCatalogReleaseEntityHashV1(kind);
    }
    const serverTime = new Date().toISOString();
    const retentionEligibleAt = new Date(
      Date.parse(serverTime) + STAGING_RETENTION_MILLISECONDS,
    ).toISOString();
    const releaseId = await ctx.db.insert("providerCatalogReleases", {
      ...request.release,
      lifecycle: "staging",
      createdAt: serverTime,
      completedAt: null,
      completionOperationId: null,
      completionReceiptSha256: null,
      retentionEligibleAt,
    });
    await ctx.db.insert("providerCatalogPublications", {
      platformKey: request.release.platformKey,
      publicProviderReleaseId: request.release.publicProviderReleaseId,
      releaseId,
      providerCheckpoint: request.providerCheckpoint,
      sourceWatermark: request.sourceWatermark,
      observation: request.observation,
      expectedCompletedHeadPublicProviderReleaseId:
        request.expectedCompletedHead.publicProviderReleaseId,
      expectedCompletedHeadCheckpoint:
        request.expectedCompletedHead.providerCheckpoint,
      expectedCompletedHeadSharedConfigurationEpoch:
        request.expectedCompletedHead.sharedConfigurationEpoch,
      expectedCompletedHeadObservation:
        request.expectedCompletedHead.observation,
      expectedCompletedHeadTerminalReceiptSha256:
        request.expectedCompletedHead.terminalReceiptSha256,
      expectedBatchCount: request.release.batchCount,
      expectedBatchChainHash: request.release.batchChainHash,
      acceptedBatchCount: 0,
      acceptedBatchChainHash:
        EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
      expectedCounts: request.release.counts,
      acceptedCounts: {
        vendors: 0,
        categories: 0,
        collectibles: 0,
        repacks: 0,
        repackChases: 0,
        searchShards: 0,
      },
      acceptedEntityHashes,
      lastBatchKind: null,
      lastRecordKey: null,
      lastSearchPublicRepackId: null,
      acceptedSearchRowCount: 0,
      unresolvedRepackCount: 0,
      latestEvidenceAt: null,
      state: "staging",
      createdAt: serverTime,
      completedAt: null,
    });
    const receipt = await buildProviderReleaseReceipt(
      (value) => providerReleaseStartReceiptSchema.parse(value),
      {
        schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
        operationKind: "start",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        platformKey: request.release.platformKey,
        publicProviderReleaseId: request.release.publicProviderReleaseId,
        sharedConfigurationEpoch: request.release.sharedConfigurationEpoch,
        providerCheckpoint: request.providerCheckpoint,
        terminalState: "staging",
        result: "created",
        serverTime,
        requestDigest: args.requestDigest,
        details: {
          release: request.release,
          providerCheckpoint: request.providerCheckpoint,
          sourceWatermark: request.sourceWatermark,
          observation: request.observation,
          expectedCompletedHead: request.expectedCompletedHead,
          acceptedBatchCount: 0,
        },
      },
    );
    await storeProviderReleaseReceipt(ctx, receipt);
    return receipt;
  },
});
