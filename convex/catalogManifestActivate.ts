import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  catalogManifestActivationReceiptSchema,
  catalogManifestActivateRequestSchema,
  globalCatalogManifestV1Schema,
  type CatalogManifestActivateRequest,
  type GlobalCatalogManifestV1,
} from "@packscout/contracts";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
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
  catalogManifestPointer,
  loadCatalogManifestByPublicReleaseId,
  writeActiveCatalogManifestState,
} from "./catalogManifestState";
import {
  assertExactCatalogManifestProviderReferences,
  insertCatalogManifestProviderReferences,
} from "./catalogManifestRetentionReferences";

const COMPLETE_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

async function expectedManifestDocument(
  ctx: MutationCtx,
  state: Awaited<ReturnType<typeof assertExpectedActiveCatalogManifestState>>,
): Promise<Doc<"globalCatalogManifests"> | null> {
  if (state.state.activeManifest === null) return null;
  const document = await loadCatalogManifestByPublicReleaseId(
    ctx,
    state.state.activeManifest.publicReleaseId,
  );
  if (
    document === null || state.document?.activeManifestId !== document._id ||
    canonicalJson(document.manifest.sharedConfigurationEpoch) !==
      canonicalJson(state.state.activeManifest.sharedConfigurationEpoch) ||
    document.manifestFingerprint !==
      state.state.activeManifest.manifestFingerprint ||
    document.providerReferenceSetHash !==
      state.state.activeManifest.providerReferenceSetHash
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  return document;
}

export async function ensureImmutableCatalogManifest(
  ctx: MutationCtx,
  input: Readonly<{
    manifest: GlobalCatalogManifestV1;
    providerReleaseIds: readonly Id<"providerCatalogReleases">[];
    serverTime: string;
  }>,
): Promise<Doc<"globalCatalogManifests">> {
  const existing = await loadCatalogManifestByPublicReleaseId(
    ctx,
    input.manifest.publicReleaseId,
  );
  if (existing !== null) {
    if (
      canonicalJson(existing.manifest) !== canonicalJson(input.manifest) ||
      canonicalJson(existing.providerReleaseIds) !==
        canonicalJson(input.providerReleaseIds)
    ) {
      refuseCatalogManifest("CATALOG_MANIFEST_IDENTITY_MISMATCH");
    }
    await assertExactCatalogManifestProviderReferences(ctx, existing);
    return existing;
  }
  const fingerprintMatches = await ctx.db
    .query("globalCatalogManifests")
    .withIndex("by_manifest_fingerprint", (index) =>
      index.eq("manifestFingerprint", input.manifest.manifestFingerprint),
    )
    .take(2);
  if (fingerprintMatches.length !== 0) {
    refuseCatalogManifest("CATALOG_MANIFEST_IDENTITY_MISMATCH");
  }
  const id = await ctx.db.insert("globalCatalogManifests", {
    publicReleaseId: input.manifest.publicReleaseId,
    manifestFingerprint: input.manifest.manifestFingerprint,
    providerReferenceSetHash: input.manifest.providerReferenceSetHash,
    manifest: input.manifest,
    providerReleaseIds: [...input.providerReleaseIds],
    lifecycle: "complete",
    createdAt: input.serverTime,
    retentionEligibleAt: new Date(
      Date.parse(input.serverTime) + COMPLETE_RETENTION_MILLISECONDS,
    ).toISOString(),
  });
  const inserted = await ctx.db.get("globalCatalogManifests", id);
  if (inserted === null) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  await insertCatalogManifestProviderReferences(ctx, inserted);
  await assertExactCatalogManifestProviderReferences(ctx, inserted);
  return inserted;
}

export async function activateCatalogManifestRequest(
  ctx: MutationCtx,
  request: CatalogManifestActivateRequest,
  requestDigest: string,
  options: Readonly<{ allowMock: boolean }> = { allowMock: false },
): Promise<ReturnType<typeof catalogManifestActivationReceiptSchema.parse>> {
  const replay = await loadExactCatalogManifestReplay(ctx, {
    operationKind: "activateManifest",
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    publicReleaseId: request.manifest.publicReleaseId,
    manifestFingerprint: request.manifest.manifestFingerprint,
    rollbackKind: null,
    requestDigest,
  });
  if (replay !== null) {
    if (replay.operationKind !== "activateManifest") {
      refuseCatalogManifest("CATALOG_MANIFEST_OPERATION_CONFLICT");
    }
    return replay;
  }
  if (request.manifest.dataSource !== "canonical" && !options.allowMock) {
    refuseCatalogManifest("CATALOG_MANIFEST_REQUEST_INVALID");
  }
  const current = await assertExpectedActiveCatalogManifestState(
    ctx,
    request.expectedActiveState,
  );
  const previousDocument = await expectedManifestDocument(ctx, current);
  if (
    previousDocument?.providerReferenceSetHash ===
      request.manifest.providerReferenceSetHash
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_REFERENCE_SET_UNCHANGED");
  }
  await assertCatalogManifestNotBlocked(ctx, request.manifest);
  const validated = await assertCatalogManifestSelectionPolicy(
    ctx,
    request.manifest,
    request.observation,
    previousDocument === null
      ? null
      : globalCatalogManifestV1Schema.parse(previousDocument.manifest),
  );
  const serverTime = new Date().toISOString();
  const manifestDocument = await ensureImmutableCatalogManifest(ctx, {
    manifest: request.manifest,
    providerReleaseIds: validated.providerReleases.map(({ _id }) => _id),
    serverTime,
  });
  const pointer = catalogManifestPointer(manifestDocument, serverTime);
  const core = {
    generation: current.state.generation + 1,
    activeManifest: pointer,
    previousManifest: current.state.activeManifest,
    observation: request.observation,
  } as const;
  const receipt = await buildCatalogManifestReceipt(
    (value) => catalogManifestActivationReceiptSchema.parse(value),
    {
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationKind: "activateManifest",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.manifest.publicReleaseId,
      manifestFingerprint: request.manifest.manifestFingerprint,
      terminalState: "complete",
      result: "activated",
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
    activeManifestId: manifestDocument._id,
    previousManifestId: current.document?.activeManifestId ?? null,
    terminalOperationId: request.operationId,
    terminalReceiptSha256,
    updatedAt: serverTime,
  });
  return receipt;
}

export const activateManifest = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertCatalogManifestRequestDigest(args.requestDigest);
    assertCatalogManifestRole(args.authenticatedKeyId, "publish");
    const request = parseCatalogManifestRequest(
      args.bodyJson,
      catalogManifestActivateRequestSchema,
    );
    return await activateCatalogManifestRequest(ctx, request, args.requestDigest);
  },
});
