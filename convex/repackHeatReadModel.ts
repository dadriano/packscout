import {
  REPACK_HEAT_MAXIMUM_TTL_MILLISECONDS,
  canonicalJson,
  hydrateRepackHeatSignal,
  parseRepackHeatTimestampMillis,
  publicRepackHeatSignalSchema,
  unavailableRepackHeat,
  type GlobalCatalogManifestV1,
  type ProductionHeatManifestAlignment,
  type PublicRepackHeat,
  type PublicRepackDetail,
  type PublicRepackViewDetail,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import type { PublicProviderCatalog } from "./publicProviderCatalogReadModel";

export type PublicCatalogHeatContext = Readonly<{
  manifestDocument: Doc<"globalCatalogManifests">;
  manifest: GlobalCatalogManifestV1;
  alignment: ProductionHeatManifestAlignment;
  catalog: PublicProviderCatalog;
}>;

type HeatSnapshotContext =
  | Readonly<{
      status: "current";
      snapshot: Doc<"repackHeatSnapshots">;
      signalSet: Doc<"repackHeatSignalSets">;
    }>
  | Readonly<{
      status: "expired";
      lastCalculatedAt: string;
      expiredAt: string;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "NOT_PUBLISHED" | "RELEASE_MISMATCH";
    }>;

function unavailable(reason: "NOT_PUBLISHED" | "RELEASE_MISMATCH") {
  return { status: "unavailable" as const, reason };
}

async function loadHeatSnapshotContext(
  ctx: QueryCtx,
  active: PublicCatalogHeatContext,
  currentTime: number,
): Promise<HeatSnapshotContext> {
  const states = await ctx.db
    .query("repackHeatState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (states.length === 0) return unavailable("NOT_PUBLISHED");
  if (states.length !== 1) return unavailable("RELEASE_MISMATCH");
  const state = states[0]!;
  if (state.activeHeatSnapshotId === null) {
    return unavailable("NOT_PUBLISHED");
  }
  const snapshot = await ctx.db.get(
    "repackHeatSnapshots",
    state.activeHeatSnapshotId,
  );
  const signalSet = snapshot === null
    ? null
    : await ctx.db.get("repackHeatSignalSets", snapshot.signalSetId);
  const baselineWindowStartedAt = snapshot === null
    ? null
    : parseRepackHeatTimestampMillis(snapshot.baselineWindowStartedAt);
  const baselineWindowEndedAt = snapshot === null
    ? null
    : parseRepackHeatTimestampMillis(snapshot.baselineWindowEndedAt);
  const currentWindowStartedAt = snapshot === null
    ? null
    : parseRepackHeatTimestampMillis(snapshot.currentWindowStartedAt);
  const currentWindowEndedAt = snapshot === null
    ? null
    : parseRepackHeatTimestampMillis(snapshot.currentWindowEndedAt);
  const calculatedAt = snapshot === null
    ? null
    : parseRepackHeatTimestampMillis(snapshot.calculatedAt);
  const expiresAt = snapshot === null
    ? null
    : parseRepackHeatTimestampMillis(snapshot.expiresAt);
  if (
    snapshot === null ||
    signalSet === null ||
    snapshot.lifecycle !== "complete" ||
    signalSet.lifecycle !== "complete" ||
    snapshot.manifestId !== active.manifestDocument._id ||
    signalSet.manifestId !== active.manifestDocument._id ||
    canonicalJson(snapshot.manifestAlignment) !==
      canonicalJson(active.alignment) ||
    canonicalJson(signalSet.manifestAlignment) !==
      canonicalJson(active.alignment) ||
    signalSet._id !== snapshot.signalSetId ||
    !Number.isSafeInteger(snapshot.sequence) ||
    snapshot.sequence < 0 ||
    state.latestSequence !== snapshot.sequence ||
    state.activeHeatSnapshotId === state.previousHeatSnapshotId ||
    !Number.isSafeInteger(snapshot.signalCount) ||
    snapshot.signalCount !== active.manifest.counts.repacks ||
    signalSet.signalCount !== snapshot.signalCount ||
    baselineWindowStartedAt === null ||
    baselineWindowEndedAt === null ||
    currentWindowStartedAt === null ||
    currentWindowEndedAt === null ||
    calculatedAt === null ||
    expiresAt === null ||
    baselineWindowStartedAt >= baselineWindowEndedAt ||
    baselineWindowEndedAt > currentWindowStartedAt ||
    currentWindowStartedAt >= currentWindowEndedAt ||
    currentWindowEndedAt > calculatedAt ||
    calculatedAt >= expiresAt ||
    expiresAt - calculatedAt > REPACK_HEAT_MAXIMUM_TTL_MILLISECONDS ||
    state.expiresAt !== snapshot.expiresAt ||
    (active.manifest.dataSource === "mock" &&
      snapshot.sourceKind !== "simulated") ||
    (active.manifest.dataSource === "canonical" &&
      snapshot.sourceKind !== "observed") ||
    signalSet.sourceKind !== snapshot.sourceKind ||
    signalSet.scenarioVersion !== snapshot.scenarioVersion ||
    signalSet.aggregationVersion !== snapshot.aggregationVersion ||
    signalSet.heatPolicyVersion !== snapshot.heatPolicyVersion ||
    (snapshot.sourceKind === "observed" &&
      (snapshot.simulationRunId !== null ||
        snapshot.scenarioVersion !== null ||
        snapshot.publicationId === null ||
        snapshot.publicationId !== snapshot.publicHeatSnapshotId ||
        snapshot.sourceWatermark === null ||
        !/^[1-9][0-9]{0,18}$/u.test(snapshot.sourceWatermark))) ||
    (snapshot.sourceKind === "simulated" &&
      (snapshot.simulationRunId === null ||
        snapshot.scenarioVersion === null ||
        snapshot.publicationId !== null ||
        snapshot.sourceWatermark !== null))
  ) {
    return unavailable("RELEASE_MISMATCH");
  }
  if (state.freshness === "expired" || expiresAt <= currentTime) {
    return {
      status: "expired",
      lastCalculatedAt: snapshot.calculatedAt,
      expiredAt: snapshot.expiresAt,
    };
  }
  if (state.freshness !== "current") {
    return unavailable("NOT_PUBLISHED");
  }
  return { status: "current", snapshot, signalSet };
}

function heatWrapperFromContext(
  context: Exclude<HeatSnapshotContext, { status: "current" }>,
): PublicRepackHeat {
  return context.status === "expired"
    ? {
        status: "expired",
        signal: null,
        lastCalculatedAt: context.lastCalculatedAt,
        expiredAt: context.expiredAt,
      }
    : unavailableRepackHeat(context.reason);
}

async function loadCurrentHeat(
  ctx: QueryCtx,
  active: PublicCatalogHeatContext,
  snapshot: Doc<"repackHeatSnapshots">,
  signalSet: Doc<"repackHeatSignalSets">,
  publicRepackId: string,
): Promise<PublicRepackHeat> {
  const documents = await ctx.db
    .query("repackHeatSignals")
    .withIndex("by_signal_set_id_and_public_repack_id", (index) =>
      index
        .eq("signalSetId", signalSet._id)
        .eq("publicRepackId", publicRepackId),
    )
    .take(2);
  if (documents.length === 0) return unavailableRepackHeat("NOT_PUBLISHED");
  if (documents.length !== 1) return unavailableRepackHeat("RELEASE_MISMATCH");
  const document = documents[0]!;
  const release = active.catalog.repackReleaseByPublicId.get(publicRepackId);
  const repack = await ctx.db.get("providerCatalogRepacks", document.repackId);
  let hydrated: unknown;
  try {
    hydrated = hydrateRepackHeatSignal(document.detail, {
      baselineWindowStartedAt: snapshot.baselineWindowStartedAt,
      baselineWindowEndedAt: snapshot.baselineWindowEndedAt,
      currentWindowStartedAt: snapshot.currentWindowStartedAt,
      currentWindowEndedAt: snapshot.currentWindowEndedAt,
      calculatedAt: snapshot.calculatedAt,
      expiresAt: snapshot.expiresAt,
    });
  } catch {
    return unavailableRepackHeat("RELEASE_MISMATCH");
  }
  const parsed = publicRepackHeatSignalSchema.safeParse(hydrated);
  if (
    !parsed.success ||
    release === undefined ||
    repack === null ||
    repack.releaseId !== release._id ||
    repack.publicRepackId !== publicRepackId ||
    document.providerReleaseId !== release._id ||
    document.signalSetId !== signalSet._id ||
    document.publicRepackId !== publicRepackId ||
    parsed.data.publicRepackId !== publicRepackId ||
    parsed.data.baselineWindow.startedAt !== snapshot.baselineWindowStartedAt ||
    parsed.data.baselineWindow.endedAt !== snapshot.baselineWindowEndedAt ||
    parsed.data.currentWindow.startedAt !== snapshot.currentWindowStartedAt ||
    parsed.data.currentWindow.endedAt !== snapshot.currentWindowEndedAt ||
    parsed.data.calculatedAt !== snapshot.calculatedAt ||
    parsed.data.expiresAt !== snapshot.expiresAt ||
    parsed.data.heatPolicyVersion !== snapshot.heatPolicyVersion ||
    parsed.data.provenance.kind !== snapshot.sourceKind ||
    parsed.data.provenance.aggregationVersion !== snapshot.aggregationVersion ||
    (parsed.data.provenance.kind === "simulated" &&
      parsed.data.provenance.scenarioVersion !== snapshot.scenarioVersion)
  ) {
    return unavailableRepackHeat("RELEASE_MISMATCH");
  }
  return { status: "current", signal: parsed.data };
}

export async function attachHeatToRepackDetails(
  ctx: QueryCtx,
  active: PublicCatalogHeatContext,
  details: readonly PublicRepackDetail[],
  currentTime: number,
): Promise<PublicRepackViewDetail[]> {
  const context = await loadHeatSnapshotContext(ctx, active, currentTime);
  if (context.status !== "current") {
    const heat = heatWrapperFromContext(context);
    return details.map((detail) => ({ ...detail, heat }));
  }
  const heat = await Promise.all(
    details.map((detail) =>
      loadCurrentHeat(
        ctx,
        active,
        context.snapshot,
        context.signalSet,
        detail.publicRepackId,
      )
    ),
  );
  return details.map((detail, index) => ({ ...detail, heat: heat[index]! }));
}
