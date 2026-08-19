import {
  activeCatalogManifestStateCoreV1Schema,
  activeCatalogManifestStateV1Schema,
  canonicalJson,
  globalCatalogManifestPointerV1Schema,
  verifyGlobalCatalogManifestV1,
  type ActiveCatalogManifestStateCoreV1,
  type ActiveCatalogManifestStateV1,
  type ExpectedActiveCatalogManifestStateV1,
  type GlobalCatalogManifestPointerV1,
  type GlobalCatalogManifestV1,
} from "@packscout/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { refuseCatalogManifest } from "./catalogManifestErrors";
import { loadCatalogManifestOperationById } from "./catalogManifestOperations";
import { validateCatalogManifestProviders } from "./catalogManifestProviderProof";

type ReadCtx = MutationCtx | QueryCtx;

export type StoredActiveCatalogManifestState = Readonly<{
  state: ActiveCatalogManifestStateV1;
  document: Doc<"activeCatalogManifestState"> | null;
}>;

export type LoadedValidatedCatalogManifest = Readonly<{
  state: ActiveCatalogManifestStateV1;
  stateDocument: Doc<"activeCatalogManifestState">;
  manifest: GlobalCatalogManifestV1;
  manifestDocument: Doc<"globalCatalogManifests">;
  providerReleases: readonly Doc<"providerCatalogReleases">[];
}>;

export const PRISTINE_ACTIVE_CATALOG_MANIFEST_STATE =
  activeCatalogManifestStateV1Schema.parse({
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  });

export function activeCatalogManifestStateCore(
  state: ActiveCatalogManifestStateV1,
): ActiveCatalogManifestStateCoreV1 {
  return activeCatalogManifestStateCoreV1Schema.parse({
    generation: state.generation,
    activeManifest: state.activeManifest,
    previousManifest: state.previousManifest,
    observation: state.observation,
  });
}

function publicStateFromDocument(
  document: Doc<"activeCatalogManifestState">,
): ActiveCatalogManifestStateV1 {
  const parsed = activeCatalogManifestStateV1Schema.safeParse({
    generation: document.generation,
    activeManifest: document.activeManifest,
    previousManifest: document.previousManifest,
    observation: document.observation,
    terminalReceiptSha256: document.terminalReceiptSha256,
  });
  if (
    !parsed.success ||
    (document.activeManifestId === null) !==
      (document.activeManifest === null) ||
    (document.previousManifestId === null) !==
      (document.previousManifest === null) ||
    (document.generation === 0) !== (document.terminalOperationId === null)
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  return parsed.data;
}

async function assertStateTerminalReceipt(
  ctx: ReadCtx,
  document: Doc<"activeCatalogManifestState">,
  state: ActiveCatalogManifestStateV1,
): Promise<void> {
  if (state.generation === 0) return;
  if (
    document.terminalOperationId === null ||
    state.terminalReceiptSha256 === null
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const loaded = await loadCatalogManifestOperationById(
    ctx,
    document.terminalOperationId,
  );
  if (
    loaded === null ||
    loaded.operation.terminalReceiptSha256 !==
      state.terminalReceiptSha256 ||
    loaded.receipt.operationKind === "block" ||
    canonicalJson(loaded.receipt.details.activeState) !==
      canonicalJson(activeCatalogManifestStateCore(state))
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
}

export async function loadActiveCatalogManifestState(
  ctx: ReadCtx,
): Promise<StoredActiveCatalogManifestState> {
  const documents = await ctx.db
    .query("activeCatalogManifestState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (documents.length > 1) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const document = documents[0] ?? null;
  if (document === null) {
    return {
      state: PRISTINE_ACTIVE_CATALOG_MANIFEST_STATE,
      document: null,
    };
  }
  const state = publicStateFromDocument(document);
  await assertStateTerminalReceipt(ctx, document, state);
  return { state, document };
}

export async function assertExpectedActiveCatalogManifestState(
  ctx: MutationCtx,
  expected: ExpectedActiveCatalogManifestStateV1,
): Promise<StoredActiveCatalogManifestState> {
  const stored = await loadActiveCatalogManifestState(ctx);
  if (canonicalJson(stored.state) !== canonicalJson(expected)) {
    refuseCatalogManifest("CATALOG_MANIFEST_PREDECESSOR_CONFLICT");
  }
  return stored;
}

export async function loadCatalogManifestByPublicReleaseId(
  ctx: ReadCtx,
  publicReleaseId: string,
): Promise<Doc<"globalCatalogManifests"> | null> {
  const byPublicReleaseId = await ctx.db
    .query("globalCatalogManifests")
    .withIndex("by_public_release_id", (index) =>
      index.eq("publicReleaseId", publicReleaseId),
    )
    .take(2);
  if (byPublicReleaseId.length > 1) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const document = byPublicReleaseId[0] ?? null;
  if (document === null) return null;
  let manifest: GlobalCatalogManifestV1;
  try {
    manifest = await verifyGlobalCatalogManifestV1(document.manifest);
  } catch {
    return refuseCatalogManifest("CATALOG_MANIFEST_RECONCILIATION_FAILED");
  }
  if (
    document.lifecycle !== "complete" ||
    document.publicReleaseId !== manifest.publicReleaseId ||
    document.manifestFingerprint !== manifest.manifestFingerprint ||
    document.providerReferenceSetHash !== manifest.providerReferenceSetHash ||
    document.providerReleaseIds.length !== manifest.providerReferences.length
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const fingerprintMatches = await ctx.db
    .query("globalCatalogManifests")
    .withIndex("by_manifest_fingerprint", (index) =>
      index.eq("manifestFingerprint", document.manifestFingerprint),
    )
    .take(2);
  if (
    fingerprintMatches.length !== 1 ||
    fingerprintMatches[0]!._id !== document._id
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  return document;
}

export async function assertCatalogManifestNotBlocked(
  ctx: ReadCtx,
  identity: Readonly<{
    publicReleaseId: string;
    manifestFingerprint: string;
  }>,
): Promise<void> {
  if (await catalogManifestIsBlocked(ctx, identity.manifestFingerprint)) {
    refuseCatalogManifest("CATALOG_MANIFEST_FINGERPRINT_BLOCKED");
  }
}

export async function catalogManifestIsBlocked(
  ctx: ReadCtx,
  manifestFingerprint: string,
): Promise<boolean> {
  const blocks = await ctx.db
    .query("catalogManifestBlocks")
    .withIndex("by_manifest_fingerprint", (index) =>
      index.eq("manifestFingerprint", manifestFingerprint),
    )
    .take(2);
  if (blocks.length > 1) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  return blocks[0] !== undefined;
}

export function catalogManifestPointer(
  document: Doc<"globalCatalogManifests">,
  completedAt: string,
): GlobalCatalogManifestPointerV1 {
  return globalCatalogManifestPointerV1Schema.parse({
    publicReleaseId: document.publicReleaseId,
    manifestFingerprint: document.manifestFingerprint,
    sharedConfigurationEpoch: document.manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: document.providerReferenceSetHash,
    createdAt: document.createdAt,
    completedAt,
  });
}

async function assertPointerDocument(
  ctx: ReadCtx,
  pointer: GlobalCatalogManifestPointerV1,
  id: Id<"globalCatalogManifests">,
): Promise<Doc<"globalCatalogManifests">> {
  const document = await ctx.db.get("globalCatalogManifests", id);
  if (
    document === null ||
    document.publicReleaseId !== pointer.publicReleaseId ||
    document.manifestFingerprint !== pointer.manifestFingerprint ||
    document.providerReferenceSetHash !== pointer.providerReferenceSetHash ||
    document.createdAt !== pointer.createdAt ||
    canonicalJson(document.manifest.sharedConfigurationEpoch) !==
      canonicalJson(pointer.sharedConfigurationEpoch)
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  return document;
}

export async function loadValidatedCatalogManifest(
  ctx: ReadCtx,
): Promise<LoadedValidatedCatalogManifest | null> {
  const loadedState = await loadActiveCatalogManifestState(ctx);
  const { state, document: stateDocument } = loadedState;
  if (state.activeManifest === null) {
    if (
      state.observation !== null ||
      stateDocument?.activeManifestId !== null && stateDocument !== null
    ) {
      refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
    }
    return null;
  }
  if (
    stateDocument === null ||
    stateDocument.activeManifestId === null ||
    state.observation === null
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const manifestDocument = await assertPointerDocument(
    ctx,
    state.activeManifest,
    stateDocument.activeManifestId,
  );
  await assertCatalogManifestNotBlocked(ctx, state.activeManifest);
  const validated = await validateCatalogManifestProviders(
    ctx,
    manifestDocument.manifest,
    state.observation,
  );
  if (
    manifestDocument.providerReleaseIds.length !==
      validated.providerReleases.length ||
    manifestDocument.providerReleaseIds.some(
      (releaseId, index) => releaseId !== validated.providerReleases[index]!._id,
    )
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  if (
    state.previousManifest !== null &&
    stateDocument.previousManifestId !== null
  ) {
    await assertPointerDocument(
      ctx,
      state.previousManifest,
      stateDocument.previousManifestId,
    );
  }
  return {
    state,
    stateDocument,
    manifest: validated.manifest,
    manifestDocument,
    providerReleases: validated.providerReleases,
  };
}

export async function writeActiveCatalogManifestState(
  ctx: MutationCtx,
  current: Doc<"activeCatalogManifestState"> | null,
  input: Readonly<{
    core: ActiveCatalogManifestStateCoreV1;
    activeManifestId: Id<"globalCatalogManifests"> | null;
    previousManifestId: Id<"globalCatalogManifests"> | null;
    terminalOperationId: string;
    terminalReceiptSha256: string;
    updatedAt: string;
  }>,
): Promise<void> {
  const parsedCore = activeCatalogManifestStateCoreV1Schema.parse(input.core);
  const fields = {
    key: "singleton" as const,
    generation: parsedCore.generation,
    activeManifestId: input.activeManifestId,
    previousManifestId: input.previousManifestId,
    activeManifest: parsedCore.activeManifest,
    previousManifest: parsedCore.previousManifest,
    observation: parsedCore.observation,
    terminalOperationId: input.terminalOperationId,
    terminalReceiptSha256: input.terminalReceiptSha256,
    updatedAt: input.updatedAt,
  };
  activeCatalogManifestStateV1Schema.parse({
    generation: fields.generation,
    activeManifest: fields.activeManifest,
    previousManifest: fields.previousManifest,
    observation: fields.observation,
    terminalReceiptSha256: fields.terminalReceiptSha256,
  });
  if (current === null) {
    await ctx.db.insert("activeCatalogManifestState", fields);
  } else {
    await ctx.db.replace("activeCatalogManifestState", current._id, fields);
  }
}
