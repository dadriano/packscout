import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  catalogManifestRefreshActiveStateRequestSchema,
  catalogManifestRefreshReceiptSchema,
  globalCatalogManifestV1Schema,
  type CatalogManifestRefreshActiveStateRequest,
  type GlobalCatalogProviderActiveObservationV1,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { refuseCatalogManifest } from "./catalogManifestErrors";
import {
  buildCatalogManifestReceipt,
  loadExactCatalogManifestReplay,
  storeCatalogManifestReceipt,
} from "./catalogManifestOperations";
import { assertCatalogManifestSelectionPolicy } from "./catalogManifestProviderProof";
import {
  assertCatalogManifestRequestDigest,
  assertCatalogManifestRole,
  parseCatalogManifestRequest,
} from "./catalogManifestRequests";
import {
  activeCatalogManifestStateCore,
  assertCatalogManifestNotBlocked,
  assertExpectedActiveCatalogManifestState,
  loadCatalogManifestByPublicReleaseId,
  writeActiveCatalogManifestState,
} from "./catalogManifestState";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

function assertSelectionDidNotRegress(
  previous: GlobalCatalogProviderActiveObservationV1,
  next: GlobalCatalogProviderActiveObservationV1,
): void {
  if (
    previous.platformKey !== next.platformKey ||
    previous.publicProviderReleaseId !== next.publicProviderReleaseId ||
    BigInt(next.selectedProviderCheckpoint.settledSequence) <
      BigInt(previous.selectedProviderCheckpoint.settledSequence) ||
    BigInt(next.latestAffectedSettledSequence) <
      BigInt(previous.latestAffectedSettledSequence) ||
    BigInt(next.latestAffectedSourceHeadSequence) <
      BigInt(previous.latestAffectedSourceHeadSequence) ||
    Date.parse(next.lastSuccessfulObservationAt) <
      Date.parse(previous.lastSuccessfulObservationAt) ||
    Date.parse(next.staleAt) < Date.parse(previous.staleAt)
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_REFRESH_STALE");
  }
}

export async function refreshCatalogManifestRequest(
  ctx: MutationCtx,
  request: CatalogManifestRefreshActiveStateRequest,
  requestDigest: string,
): Promise<ReturnType<typeof catalogManifestRefreshReceiptSchema.parse>> {
  const replay = await loadExactCatalogManifestReplay(ctx, {
    operationKind: "refreshActiveState",
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    publicReleaseId: request.manifest.publicReleaseId,
    manifestFingerprint: request.manifest.manifestFingerprint,
    rollbackKind: null,
    requestDigest,
  });
  if (replay !== null) {
    if (replay.operationKind !== "refreshActiveState") {
      refuseCatalogManifest("CATALOG_MANIFEST_OPERATION_CONFLICT");
    }
    return replay;
  }
  const current = await assertExpectedActiveCatalogManifestState(
    ctx,
    request.expectedActiveState,
  );
  if (
    current.state.activeManifest === null ||
    current.state.observation === null ||
    current.document?.activeManifestId === null ||
    current.document === null
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const manifestDocument = await loadCatalogManifestByPublicReleaseId(
    ctx,
    request.manifest.publicReleaseId,
  );
  if (
    manifestDocument === null ||
    manifestDocument._id !== current.document.activeManifestId ||
    canonicalJson(request.manifest) !== canonicalJson({
      publicReleaseId: manifestDocument.publicReleaseId,
      manifestFingerprint: manifestDocument.manifestFingerprint,
      sharedConfigurationEpoch:
        manifestDocument.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: manifestDocument.providerReferenceSetHash,
    }) ||
    manifestDocument.manifest.dataSource !== "canonical"
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_IDENTITY_MISMATCH");
  }
  await assertCatalogManifestNotBlocked(ctx, request.manifest);
  const manifest = globalCatalogManifestV1Schema.parse(
    manifestDocument.manifest,
  );
  await assertCatalogManifestSelectionPolicy(
    ctx,
    manifest,
    request.observation,
    manifest,
  );
  const previousSelections = current.state.observation.providerSelections;
  if (previousSelections.length !== request.observation.providerSelections.length) {
    refuseCatalogManifest("CATALOG_MANIFEST_REFRESH_STALE");
  }
  request.observation.providerSelections.forEach((selection, index) =>
    assertSelectionDidNotRegress(previousSelections[index]!, selection)
  );

  const serverTime = new Date().toISOString();
  const core = {
    generation: current.state.generation + 1,
    activeManifest: current.state.activeManifest,
    previousManifest: current.state.previousManifest,
    observation: request.observation,
  } as const;
  const receipt = await buildCatalogManifestReceipt(
    (value) => catalogManifestRefreshReceiptSchema.parse(value),
    {
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationKind: "refreshActiveState",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.manifest.publicReleaseId,
      manifestFingerprint: request.manifest.manifestFingerprint,
      terminalState: "complete",
      result: "refreshed",
      serverTime,
      requestDigest,
      details: {
        expectedActiveState: request.expectedActiveState,
        activeState: core,
      },
    },
  );
  const terminalReceiptSha256 = await storeCatalogManifestReceipt(ctx, receipt);
  await writeActiveCatalogManifestState(ctx, current.document, {
    core: activeCatalogManifestStateCore({
      ...core,
      terminalReceiptSha256,
    }),
    activeManifestId: current.document.activeManifestId,
    previousManifestId: current.document.previousManifestId,
    terminalOperationId: request.operationId,
    terminalReceiptSha256,
    updatedAt: serverTime,
  });
  return receipt;
}

export const refreshActiveState = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertCatalogManifestRequestDigest(args.requestDigest);
    assertCatalogManifestRole(args.authenticatedKeyId, "publish");
    const request = parseCatalogManifestRequest(
      args.bodyJson,
      catalogManifestRefreshActiveStateRequestSchema,
    );
    return await refreshCatalogManifestRequest(ctx, request, args.requestDigest);
  },
});
