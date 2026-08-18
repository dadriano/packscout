import {
  REPACK_HEAT_MAXIMUM_FUTURE_SKEW_MILLISECONDS,
  REPACK_HEAT_MAXIMUM_PUBLISH_LAG_MILLISECONDS,
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  containsProtectedPublicationField,
  parseRepackHeatTimestampMillis,
  productionHeatFrameEnvelopeSchema,
  productionHeatManifestAlignmentSchema,
  recomputeProductionHeatFrameHash,
  type ProductionHeatFrameEnvelope,
  type ProductionHeatManifestAlignment,
} from "@packscout/contracts";
import type { ZodType } from "zod";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { assertExactCatalogManifestProviderReferences } from
  "./catalogManifestRetentionReferences";
import {
  loadCatalogManifestByPublicReleaseId,
  loadValidatedCatalogManifest,
  type LoadedValidatedCatalogManifest,
} from "./catalogManifestState";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";

type ReadCtx = MutationCtx | QueryCtx;

export type ActiveCatalogHeatManifest = Readonly<
  LoadedValidatedCatalogManifest & {
    alignment: ProductionHeatManifestAlignment;
  }
>;

export type OwnedHeatRepack = Readonly<{
  release: Doc<"providerCatalogReleases">;
  repack: Doc<"providerCatalogRepacks">;
}>;

export function parseProductionHeatRequest<T>(
  bodyJson: string,
  schema: ZodType<T>,
): T {
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
      REPACK_HEAT_PUBLICATION_SCHEMA_VERSION
  ) {
    return refuseProductionDataRelease("PUBLICATION_SCHEMA_UNSUPPORTED");
  }
  if (containsProtectedPublicationField(raw)) {
    return refuseProductionDataRelease("PUBLICATION_PROTECTED_FIELD");
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
}

export function heatManifestAlignment(
  loaded: Pick<LoadedValidatedCatalogManifest, "manifest">,
): ProductionHeatManifestAlignment {
  return productionHeatManifestAlignmentSchema.parse({
    publicReleaseId: loaded.manifest.publicReleaseId,
    manifestFingerprint: loaded.manifest.manifestFingerprint,
    sharedConfigurationEpoch: loaded.manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: loaded.manifest.providerReferenceSetHash,
  });
}

export async function loadActiveCatalogHeatManifest(
  ctx: ReadCtx,
  expectedAlignment: ProductionHeatManifestAlignment,
  expectedDataSource: "canonical" | "mock" = "canonical",
): Promise<ActiveCatalogHeatManifest> {
  let loaded: LoadedValidatedCatalogManifest | null;
  try {
    loaded = await loadValidatedCatalogManifest(ctx);
  } catch {
    return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  if (loaded === null) {
    return refuseProductionDataRelease("PUBLICATION_PREDECESSOR_CONFLICT");
  }
  const alignment = heatManifestAlignment(loaded);
  if (
    loaded.manifest.dataSource !== expectedDataSource ||
    canonicalJson(alignment) !== canonicalJson(expectedAlignment)
  ) {
    return refuseProductionDataRelease("PUBLICATION_PREDECESSOR_CONFLICT");
  }
  return { ...loaded, alignment };
}

export async function assertStoredHeatManifest(
  ctx: ReadCtx,
  manifestId: Doc<"globalCatalogManifests">["_id"],
  expectedAlignment: ProductionHeatManifestAlignment,
): Promise<Doc<"globalCatalogManifests">> {
  let document: Doc<"globalCatalogManifests"> | null;
  try {
    document = await loadCatalogManifestByPublicReleaseId(
      ctx,
      expectedAlignment.publicReleaseId,
    );
    if (document !== null) {
      await assertExactCatalogManifestProviderReferences(ctx, document);
    }
  } catch {
    return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  if (
    document === null ||
    document._id !== manifestId ||
    canonicalJson({
      publicReleaseId: document.publicReleaseId,
      manifestFingerprint: document.manifestFingerprint,
      sharedConfigurationEpoch: document.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: document.providerReferenceSetHash,
    }) !== canonicalJson(expectedAlignment)
  ) {
    return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return document;
}

export async function loadOwnedHeatRepacks(
  ctx: ReadCtx,
  manifest: ActiveCatalogHeatManifest,
  publicRepackIds: readonly string[],
): Promise<ReadonlyMap<string, OwnedHeatRepack>> {
  const owned = new Map<string, OwnedHeatRepack>();
  for (const publicRepackId of publicRepackIds) {
    const candidates = await Promise.all(
      manifest.providerReleases.map(async (release) => ({
        release,
        documents: await ctx.db
          .query("providerCatalogRepacks")
          .withIndex("by_release_id_and_public_repack_id", (index) =>
            index
              .eq("releaseId", release._id)
              .eq("publicRepackId", publicRepackId),
          )
          .take(2),
      })),
    );
    const matches = candidates.flatMap(({ release, documents }) =>
      documents.map((repack) => ({ release, repack }))
    );
    if (
      matches.length !== 1 ||
      matches[0]!.repack.releaseId !== matches[0]!.release._id ||
      matches[0]!.repack.publicRepackId !== publicRepackId
    ) {
      return refuseProductionDataRelease("PUBLICATION_REFERENCE_INVALID");
    }
    owned.set(publicRepackId, matches[0]!);
  }
  return owned;
}

export async function assertProductionHeatFrame(
  frameInput: unknown,
  serverNow = Date.now(),
): Promise<ProductionHeatFrameEnvelope> {
  const parsed = productionHeatFrameEnvelopeSchema.safeParse(frameInput);
  if (!parsed.success) {
    return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  const frame = parsed.data;
  const calculatedAt = parseRepackHeatTimestampMillis(frame.calculatedAt)!;
  const expiresAt = parseRepackHeatTimestampMillis(frame.expiresAt)!;
  if (
    frame.frameHash !== await recomputeProductionHeatFrameHash(frame) ||
    calculatedAt > serverNow + REPACK_HEAT_MAXIMUM_FUTURE_SKEW_MILLISECONDS ||
    serverNow - calculatedAt > REPACK_HEAT_MAXIMUM_PUBLISH_LAG_MILLISECONDS ||
    expiresAt <= serverNow
  ) {
    refuseProductionDataRelease("PUBLICATION_REFRESH_STALE");
  }
  return frame;
}

export function productionHeatFrameFromSnapshot(
  snapshot: Doc<"repackHeatSnapshots">,
  signalSet: Doc<"repackHeatSignalSets">,
): ProductionHeatFrameEnvelope {
  return productionHeatFrameEnvelopeSchema.parse({
    publicHeatFrameId: snapshot.publicHeatSnapshotId,
    manifestAlignment: snapshot.manifestAlignment,
    frameSequence: snapshot.sequence,
    sourceWatermark: snapshot.sourceWatermark,
    signalSetHash: signalSet.signalSetHash,
    frameHash: snapshot.contentHash,
    signalCount: snapshot.signalCount,
    aggregationVersion: snapshot.aggregationVersion,
    heatPolicyVersion: snapshot.heatPolicyVersion,
    baselineWindowStartedAt: snapshot.baselineWindowStartedAt,
    baselineWindowEndedAt: snapshot.baselineWindowEndedAt,
    currentWindowStartedAt: snapshot.currentWindowStartedAt,
    currentWindowEndedAt: snapshot.currentWindowEndedAt,
    calculatedAt: snapshot.calculatedAt,
    expiresAt: snapshot.expiresAt,
  });
}

export async function loadHeatState(
  ctx: ReadCtx,
): Promise<Doc<"repackHeatState"> | null> {
  const states = await ctx.db
    .query("repackHeatState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (states.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return states[0] ?? null;
}

export async function loadActiveHeatFrame(
  ctx: ReadCtx,
  state: Doc<"repackHeatState"> | null,
): Promise<Doc<"repackHeatSnapshots"> | null> {
  if (state === null || state.activeHeatSnapshotId === null) return null;
  if (state.activeHeatSnapshotId === state.previousHeatSnapshotId) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  const active = await ctx.db.get(
    "repackHeatSnapshots",
    state.activeHeatSnapshotId,
  );
  if (
    active === null ||
    active.lifecycle !== "complete" ||
    active.sequence !== state.latestSequence ||
    active.expiresAt !== state.expiresAt ||
    !productionHeatManifestAlignmentSchema.safeParse(
      active.manifestAlignment,
    ).success
  ) {
    return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return active;
}

function timestamp(frame: Doc<"repackHeatSnapshots">, field: keyof Pick<
  Doc<"repackHeatSnapshots">,
  | "baselineWindowStartedAt"
  | "baselineWindowEndedAt"
  | "currentWindowStartedAt"
  | "currentWindowEndedAt"
  | "calculatedAt"
  | "expiresAt"
>): number {
  const parsed = parseRepackHeatTimestampMillis(frame[field]);
  return parsed ?? refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
}

export function assertMonotonicHeatFrame(
  active: Doc<"repackHeatSnapshots"> | null,
  next: ProductionHeatFrameEnvelope,
): void {
  if (active === null) return;
  const activeSourceWatermark = active.sourceWatermark;
  const activeWatermarkIsValid = activeSourceWatermark === null ||
    /^[1-9][0-9]{0,18}$/u.test(activeSourceWatermark);
  if (!activeWatermarkIsValid) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  if (
    next.frameSequence <= active.sequence ||
    (activeSourceWatermark !== null &&
      BigInt(next.sourceWatermark) < BigInt(activeSourceWatermark)) ||
    parseRepackHeatTimestampMillis(next.baselineWindowStartedAt)! <=
      timestamp(active, "baselineWindowStartedAt") ||
    parseRepackHeatTimestampMillis(next.baselineWindowEndedAt)! <=
      timestamp(active, "baselineWindowEndedAt") ||
    parseRepackHeatTimestampMillis(next.currentWindowStartedAt)! <=
      timestamp(active, "currentWindowStartedAt") ||
    parseRepackHeatTimestampMillis(next.currentWindowEndedAt)! <=
      timestamp(active, "currentWindowEndedAt") ||
    parseRepackHeatTimestampMillis(next.calculatedAt)! <=
      timestamp(active, "calculatedAt") ||
    parseRepackHeatTimestampMillis(next.expiresAt)! <=
      timestamp(active, "expiresAt")
  ) {
    refuseProductionDataRelease("PUBLICATION_SEQUENCE_REGRESSED");
  }
}
