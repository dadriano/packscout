import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  catalogManifestClearReceiptSchema,
  catalogManifestRollbackReceiptSchema,
  catalogManifestRollbackRequestSchema,
  globalCatalogManifestV1Schema,
  type CatalogManifestRollbackRequest,
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
  catalogManifestIsBlocked,
  catalogManifestPointer,
  loadCatalogManifestByPublicReleaseId,
  writeActiveCatalogManifestState,
} from "./catalogManifestState";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

export async function rollbackCatalogManifestRequest(
  ctx: MutationCtx,
  request: CatalogManifestRollbackRequest,
  requestDigest: string,
) {
  const publicReleaseId = request.rollbackKind === "manifest"
    ? request.targetManifest.publicReleaseId
    : null;
  const manifestFingerprint = request.rollbackKind === "manifest"
    ? request.targetManifest.manifestFingerprint
    : null;
  const replay = await loadExactCatalogManifestReplay(ctx, {
    operationKind: "rollback",
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    publicReleaseId,
    manifestFingerprint,
    rollbackKind: request.rollbackKind,
    requestDigest,
  });
  if (replay !== null) {
    if (
      replay.operationKind !== "rollback" ||
      replay.rollbackKind !== request.rollbackKind
    ) {
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
    current.document === null ||
    current.document.activeManifestId === null
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_ROLLBACK_UNSAFE");
  }
  const serverTime = new Date().toISOString();
  if (request.rollbackKind === "clear") {
    const core = {
      generation: current.state.generation + 1,
      activeManifest: null,
      previousManifest: null,
      observation: null,
    } as const;
    const receipt = await buildCatalogManifestReceipt(
      (value) => catalogManifestClearReceiptSchema.parse(value),
      {
        schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
        operationKind: "rollback",
        rollbackKind: "clear",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        publicReleaseId: null,
        manifestFingerprint: null,
        terminalState: "cleared",
        result: "cleared",
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
      activeManifestId: null,
      previousManifestId: null,
      terminalOperationId: request.operationId,
      terminalReceiptSha256,
      updatedAt: serverTime,
    });
    return receipt;
  }

  const targetDocument = await loadCatalogManifestByPublicReleaseId(
    ctx,
    request.targetManifest.publicReleaseId,
  );
  if (
    targetDocument === null ||
    canonicalJson(request.targetManifest) !== canonicalJson({
      publicReleaseId: targetDocument.publicReleaseId,
      manifestFingerprint: targetDocument.manifestFingerprint,
      sharedConfigurationEpoch:
        targetDocument.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: targetDocument.providerReferenceSetHash,
    }) ||
    targetDocument.manifest.dataSource !== "canonical"
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_ROLLBACK_UNSAFE");
  }
  await assertCatalogManifestNotBlocked(ctx, request.targetManifest);
  const targetManifest = globalCatalogManifestV1Schema.parse(
    targetDocument.manifest,
  );
  // A rollback intentionally selects historical immutable references. Treat the
  // target itself as the retained baseline while still binding latest facts to
  // each current provider head inside the bounded policy check.
  const validated = await assertCatalogManifestSelectionPolicy(
    ctx,
    targetManifest,
    request.observation,
    targetManifest,
  );
  if (
    targetDocument.providerReleaseIds.length !==
      validated.providerReleases.length ||
    targetDocument.providerReleaseIds.some(
      (id, index) => id !== validated.providerReleases[index]!._id,
    )
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_ROLLBACK_UNSAFE");
  }
  const outgoingManifestBlocked = await catalogManifestIsBlocked(
    ctx,
    current.state.activeManifest.manifestFingerprint,
  );
  const pointer = catalogManifestPointer(targetDocument, serverTime);
  const core = {
    generation: current.state.generation + 1,
    activeManifest: pointer,
    previousManifest: outgoingManifestBlocked
      ? null
      : current.state.activeManifest,
    observation: request.observation,
  } as const;
  const receipt = await buildCatalogManifestReceipt(
    (value) => catalogManifestRollbackReceiptSchema.parse(value),
    {
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationKind: "rollback",
      rollbackKind: "manifest",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: targetManifest.publicReleaseId,
      manifestFingerprint: targetManifest.manifestFingerprint,
      terminalState: "complete",
      result: "rolled_back",
      serverTime,
      requestDigest,
      details: {
        expectedActiveState: request.expectedActiveState,
        activeState: core,
        outgoingManifestBlocked,
      },
    },
  );
  const terminalReceiptSha256 = await storeCatalogManifestReceipt(ctx, receipt);
  await writeActiveCatalogManifestState(ctx, current.document, {
    core: activeCatalogManifestStateCore({
      ...core,
      terminalReceiptSha256,
    }),
    activeManifestId: targetDocument._id,
    previousManifestId: outgoingManifestBlocked
      ? null
      : current.document.activeManifestId,
    terminalOperationId: request.operationId,
    terminalReceiptSha256,
    updatedAt: serverTime,
  });
  return receipt;
}

export const rollback = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertCatalogManifestRequestDigest(args.requestDigest);
    const request = parseCatalogManifestRequest(
      args.bodyJson,
      catalogManifestRollbackRequestSchema,
    );
    assertCatalogManifestRole(
      args.authenticatedKeyId,
      request.rollbackKind === "clear" ? "clear" : "rollback",
    );
    return await rollbackCatalogManifestRequest(ctx, request, args.requestDigest);
  },
});
