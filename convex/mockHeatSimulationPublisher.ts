import {
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  REPACK_HEAT_MAXIMUM_FUTURE_SKEW_MILLISECONDS,
  REPACK_HEAT_MAXIMUM_PUBLISH_LAG_MILLISECONDS,
  REPACK_HEAT_MAXIMUM_TTL_MILLISECONDS,
  EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
  extendProductionHeatSignalSetHash,
  parseRepackHeatTimestampMillis,
  productionHeatCoreByteCount,
  publicRepackHeatSignalSchema,
  recomputeProductionHeatBatchHash,
  repackHeatSignalCore,
  type ProductionHeatManifestAlignment,
  type PublicRepackHeatSignal,
} from "@packscout/contracts";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { env, internalMutation, type MutationCtx } from "./_generated/server";
import { canonicalJson, sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import {
  MOCK_HEAT_AGGREGATION_VERSION,
  MOCK_HEAT_FRAME_HASH_DOMAIN,
  MOCK_HEAT_POLICY_VERSION,
  MOCK_HEAT_SCENARIO_VERSION,
  mockHeatFrameBody,
  mockHeatSnapshotIdFromHash,
} from "./mockHeatSimulationFixture";
import {
  productionHeatManifestAlignmentValidator,
  publicRepackHeatSignalValidator,
} from "./schema";
import {
  loadActiveCatalogHeatManifest,
  loadOwnedHeatRepacks,
  assertStoredHeatManifest,
  type ActiveCatalogHeatManifest,
  type OwnedHeatRepack,
} from "./productionHeatProtocol";

const sha256Pattern = /^[0-9a-f]{64}$/u;
const snapshotIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type RefusalCode =
  | "MOCK_HEAT_DISABLED"
  | "MOCK_HEAT_ENVIRONMENT_UNSAFE"
  | "MOCK_HEAT_RELEASE_UNSAFE"
  | "MOCK_HEAT_FRAME_INVALID"
  | "MOCK_HEAT_FRAME_CONFLICT"
  | "MOCK_HEAT_SEQUENCE_INVALID"
  | "MOCK_HEAT_STATE_INVALID";

interface PublishFrameInput {
  readonly manifestAlignment: ProductionHeatManifestAlignment;
  readonly publicHeatSnapshotId: string;
  readonly simulationRunId: string;
  readonly sequence: number;
  readonly sourceKind: "simulated";
  readonly scenarioVersion: string;
  readonly aggregationVersion: string;
  readonly heatPolicyVersion: string;
  readonly calculatedAt: string;
  readonly expiresAt: string;
  readonly signals: readonly unknown[];
  readonly contentHash: string;
}

const publishResultValidator = v.object({
  status: v.union(v.literal("created"), v.literal("unchanged")),
  publicHeatSnapshotId: v.string(),
  simulationRunId: v.string(),
  sequence: v.number(),
  signalCount: v.number(),
});

function refuse(code: RefusalCode): never {
  throw new ConvexError({
    code,
    message: "The mock heat operation was refused without changing data.",
  });
}

function assertLocalEnvironment(): void {
  if (env.PACKSCOUT_RUNTIME_ENVIRONMENT !== "local") {
    refuse("MOCK_HEAT_ENVIRONMENT_UNSAFE");
  }
}

function assertEnvironment(): void {
  assertLocalEnvironment();
  const configured = env as typeof env & {
    readonly PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED?: "1";
  };
  if (configured.PACKSCOUT_MOCK_HEAT_SIMULATION_ENABLED !== "1") {
    refuse("MOCK_HEAT_DISABLED");
  }
}

async function loadMockCatalog(
  ctx: MutationCtx,
  alignment: ProductionHeatManifestAlignment,
): Promise<ActiveCatalogHeatManifest> {
  try {
    return await loadActiveCatalogHeatManifest(ctx, alignment, "mock");
  } catch {
    refuse("MOCK_HEAT_RELEASE_UNSAFE");
  }
}

async function repacksByPublicId(
  ctx: MutationCtx,
  catalog: ActiveCatalogHeatManifest,
  publicRepackIds: readonly string[],
): Promise<ReadonlyMap<string, OwnedHeatRepack>> {
  try {
    return await loadOwnedHeatRepacks(ctx, catalog, publicRepackIds);
  } catch {
    refuse("MOCK_HEAT_RELEASE_UNSAFE");
  }
}

async function mockSignalSetHash(
  signals: readonly PublicRepackHeatSignal[],
): Promise<string> {
  const batchHash = await recomputeProductionHeatBatchHash(signals);
  return await extendProductionHeatSignalSetHash({
    previousHash: EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH,
    batchIndex: 0,
    batchHash,
    recordCount: signals.length,
    coreByteCount: productionHeatCoreByteCount(signals),
  });
}

async function deleteRetainedSnapshot(
  ctx: MutationCtx,
  snapshotId: Id<"repackHeatSnapshots"> | null,
): Promise<void> {
  if (snapshotId === null) return;
  const snapshot = await ctx.db.get("repackHeatSnapshots", snapshotId);
  if (
    snapshot === null ||
    snapshot.lifecycle !== "retired" ||
    snapshot.sourceKind !== "simulated"
  ) {
    refuse("MOCK_HEAT_STATE_INVALID");
  }
  try {
    await assertStoredHeatManifest(
      ctx,
      snapshot.manifestId,
      snapshot.manifestAlignment,
    );
  } catch {
    refuse("MOCK_HEAT_STATE_INVALID");
  }
  await ctx.db.delete("repackHeatSnapshots", snapshotId);
  const remainingFrames = await ctx.db
    .query("repackHeatSnapshots")
    .withIndex("by_signal_set_id", (index) =>
      index.eq("signalSetId", snapshot.signalSetId),
    )
    .take(1);
  if (remainingFrames.length > 0) return;
  const signalSet = await ctx.db.get(
    "repackHeatSignalSets",
    snapshot.signalSetId,
  );
  if (
    signalSet === null ||
    signalSet.manifestId !== snapshot.manifestId ||
    canonicalJson(signalSet.manifestAlignment) !==
      canonicalJson(snapshot.manifestAlignment) ||
    signalSet.sourceKind !== "simulated"
  ) {
    refuse("MOCK_HEAT_STATE_INVALID");
  }
  const signals = await ctx.db
    .query("repackHeatSignals")
    .withIndex("by_signal_set_id_and_public_repack_id", (index) =>
      index.eq("signalSetId", signalSet._id),
    )
    .take(MAX_PUBLIC_REPACKS_PER_RELEASE + 1);
  if (signals.length > MAX_PUBLIC_REPACKS_PER_RELEASE) {
    refuse("MOCK_HEAT_STATE_INVALID");
  }
  for (const signal of signals) {
    await ctx.db.delete("repackHeatSignals", signal._id);
  }
  await ctx.db.delete("repackHeatSignalSets", signalSet._id);
}

async function replayIsExact(
  ctx: MutationCtx,
  manifestId: Id<"globalCatalogManifests">,
  snapshot: Doc<"repackHeatSnapshots">,
  args: Omit<PublishFrameInput, "signals">,
  parsedSignals: readonly PublicRepackHeatSignal[],
): Promise<boolean> {
  const signalSet = await ctx.db.get(
    "repackHeatSignalSets",
    snapshot.signalSetId,
  );
  if (
    signalSet === null ||
    signalSet.lifecycle !== "complete" ||
    signalSet.manifestId !== manifestId ||
    canonicalJson(signalSet.manifestAlignment) !==
      canonicalJson(args.manifestAlignment) ||
    signalSet.sourceKind !== "simulated" ||
    signalSet.signalSetHash !== await mockSignalSetHash(parsedSignals) ||
    signalSet.signalCount !== parsedSignals.length ||
    snapshot.manifestId !== manifestId ||
    canonicalJson(snapshot.manifestAlignment) !==
      canonicalJson(args.manifestAlignment) ||
    snapshot.publicHeatSnapshotId !== args.publicHeatSnapshotId ||
    snapshot.simulationRunId !== args.simulationRunId ||
    snapshot.sequence !== args.sequence ||
    snapshot.lifecycle !== "complete" ||
    snapshot.sourceKind !== "simulated" ||
    snapshot.scenarioVersion !== MOCK_HEAT_SCENARIO_VERSION ||
    snapshot.aggregationVersion !== MOCK_HEAT_AGGREGATION_VERSION ||
    snapshot.heatPolicyVersion !== MOCK_HEAT_POLICY_VERSION ||
    snapshot.contentHash !== args.contentHash ||
    snapshot.signalCount !== parsedSignals.length ||
    snapshot.baselineWindowStartedAt !==
      parsedSignals[0]!.baselineWindow.startedAt ||
    snapshot.baselineWindowEndedAt !== parsedSignals[0]!.baselineWindow.endedAt ||
    snapshot.currentWindowStartedAt !== parsedSignals[0]!.currentWindow.startedAt ||
    snapshot.currentWindowEndedAt !== parsedSignals[0]!.currentWindow.endedAt ||
    snapshot.calculatedAt !== args.calculatedAt ||
    snapshot.expiresAt !== args.expiresAt
  ) {
    return false;
  }
  const stored = await ctx.db
    .query("repackHeatSignals")
    .withIndex("by_signal_set_id_and_public_repack_id", (index) =>
      index.eq("signalSetId", signalSet._id),
    )
    .take(MAX_PUBLIC_REPACKS_PER_RELEASE + 1);
  return (
    stored.length === parsedSignals.length &&
    canonicalJson(stored.map(({ detail }) => detail)) ===
      canonicalJson(parsedSignals.map(repackHeatSignalCore))
  );
}

async function publishMockHeatFrame(
  ctx: MutationCtx,
  args: PublishFrameInput,
) {
  assertEnvironment();
  const serverNow = Date.now();
  const calculatedAt = parseRepackHeatTimestampMillis(args.calculatedAt);
  const expiresAt = parseRepackHeatTimestampMillis(args.expiresAt);
  if (
    args.sourceKind !== "simulated" ||
    args.scenarioVersion !== MOCK_HEAT_SCENARIO_VERSION ||
    args.aggregationVersion !== MOCK_HEAT_AGGREGATION_VERSION ||
    args.heatPolicyVersion !== MOCK_HEAT_POLICY_VERSION ||
    !snapshotIdPattern.test(args.publicHeatSnapshotId) ||
    !sha256Pattern.test(args.simulationRunId) ||
    !sha256Pattern.test(args.contentHash) ||
    !Number.isSafeInteger(args.sequence) ||
    args.sequence < 0 ||
    args.sequence > 100_000 ||
    args.signals.length === 0 ||
    args.signals.length > MAX_PUBLIC_REPACKS_PER_RELEASE ||
    calculatedAt === null ||
    expiresAt === null ||
    calculatedAt > serverNow + REPACK_HEAT_MAXIMUM_FUTURE_SKEW_MILLISECONDS ||
    serverNow - calculatedAt > REPACK_HEAT_MAXIMUM_PUBLISH_LAG_MILLISECONDS ||
    expiresAt <= serverNow ||
    expiresAt - calculatedAt > REPACK_HEAT_MAXIMUM_TTL_MILLISECONDS
  ) {
    refuse("MOCK_HEAT_FRAME_INVALID");
  }

  const parsedSignals = args.signals.map((signal) => {
    const parsed = publicRepackHeatSignalSchema.safeParse(signal);
    if (!parsed.success) refuse("MOCK_HEAT_FRAME_INVALID");
    return parsed.data;
  });
  const frameTimeline = parsedSignals[0]!;
  const publicIds = parsedSignals.map(({ publicRepackId }) => publicRepackId);
  if (
    publicIds.some(
      (id, index) =>
        (index > 0 && id <= publicIds[index - 1]!) ||
        parsedSignals[index]!.provenance.kind !== "simulated" ||
        parsedSignals[index]!.provenance.aggregationVersion !==
          args.aggregationVersion ||
        (parsedSignals[index]!.provenance.kind === "simulated" &&
          parsedSignals[index]!.provenance.scenarioVersion !==
            args.scenarioVersion) ||
        parsedSignals[index]!.heatPolicyVersion !== args.heatPolicyVersion ||
        parsedSignals[index]!.baselineWindow.startedAt !==
          frameTimeline.baselineWindow.startedAt ||
        parsedSignals[index]!.baselineWindow.endedAt !==
          frameTimeline.baselineWindow.endedAt ||
        parsedSignals[index]!.currentWindow.startedAt !==
          frameTimeline.currentWindow.startedAt ||
        parsedSignals[index]!.currentWindow.endedAt !==
          frameTimeline.currentWindow.endedAt ||
        parsedSignals[index]!.calculatedAt !== args.calculatedAt ||
        parsedSignals[index]!.expiresAt !== args.expiresAt,
    )
  ) {
    refuse("MOCK_HEAT_FRAME_INVALID");
  }
  const recomputedHash = await sha256CanonicalJson(
    MOCK_HEAT_FRAME_HASH_DOMAIN,
    mockHeatFrameBody({
      manifestAlignment: args.manifestAlignment,
      simulationRunId: args.simulationRunId,
      sequence: args.sequence,
      sourceKind: "simulated",
      scenarioVersion: MOCK_HEAT_SCENARIO_VERSION,
      aggregationVersion: MOCK_HEAT_AGGREGATION_VERSION,
      heatPolicyVersion: MOCK_HEAT_POLICY_VERSION,
      calculatedAt: args.calculatedAt,
      expiresAt: args.expiresAt,
      signals: parsedSignals,
    }),
  );
  if (
    recomputedHash !== args.contentHash ||
    args.publicHeatSnapshotId !== mockHeatSnapshotIdFromHash(recomputedHash)
  ) {
    refuse("MOCK_HEAT_FRAME_INVALID");
  }
  const signalSetHash = await mockSignalSetHash(parsedSignals);

  const catalog = await loadMockCatalog(ctx, args.manifestAlignment);
  const repacks = await repacksByPublicId(ctx, catalog, publicIds);
  if (
    parsedSignals.length !== catalog.manifest.counts.repacks ||
    parsedSignals.length !== repacks.size ||
    parsedSignals.some(({ publicRepackId }) => !repacks.has(publicRepackId))
  ) {
    refuse("MOCK_HEAT_FRAME_INVALID");
  }

  const existing = await ctx.db
    .query("repackHeatSnapshots")
    .withIndex("by_public_heat_snapshot_id", (index) =>
      index.eq("publicHeatSnapshotId", args.publicHeatSnapshotId),
    )
    .take(2);
  if (existing.length > 1) refuse("MOCK_HEAT_STATE_INVALID");
  if (existing.length === 1) {
    if (
      await replayIsExact(
        ctx,
        catalog.manifestDocument._id,
        existing[0]!,
        args,
        parsedSignals,
      )
    ) {
      return {
        status: "unchanged" as const,
        publicHeatSnapshotId: args.publicHeatSnapshotId,
        simulationRunId: args.simulationRunId,
        sequence: args.sequence,
        signalCount: parsedSignals.length,
      };
    }
    refuse("MOCK_HEAT_FRAME_CONFLICT");
  }

  const states = await ctx.db
    .query("repackHeatState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (states.length > 1) refuse("MOCK_HEAT_STATE_INVALID");
  const state = states[0] ?? null;
  let active: Doc<"repackHeatSnapshots"> | null = null;
  if (state !== null && state.activeHeatSnapshotId !== null) {
    if (state.activeHeatSnapshotId === state.previousHeatSnapshotId) {
      refuse("MOCK_HEAT_STATE_INVALID");
    }
    active = await ctx.db.get("repackHeatSnapshots", state.activeHeatSnapshotId);
    if (
      active === null ||
      active.lifecycle !== "complete" ||
      active.sequence !== state.latestSequence ||
      active.expiresAt !== state.expiresAt ||
      state.freshness === "unavailable"
    ) {
      refuse("MOCK_HEAT_STATE_INVALID");
    }
  } else if (
    state !== null &&
    (state.previousHeatSnapshotId !== null ||
      state.freshness !== "unavailable" ||
      state.expiresAt !== null)
  ) {
    refuse("MOCK_HEAT_STATE_INVALID");
  }
  if (
    (active === null && args.sequence !== 0) ||
    (active !== null &&
      active.simulationRunId === args.simulationRunId &&
      args.sequence !== active.sequence + 1) ||
    (active !== null &&
      active.simulationRunId !== args.simulationRunId &&
      args.sequence !== 0)
  ) {
    refuse("MOCK_HEAT_SEQUENCE_INVALID");
  }
  if (active !== null) {
    const activeCalculatedAt = parseRepackHeatTimestampMillis(
      active.calculatedAt,
    );
    const activeExpiresAt = parseRepackHeatTimestampMillis(active.expiresAt);
    const activeBaselineStartedAt = parseRepackHeatTimestampMillis(
      active.baselineWindowStartedAt,
    );
    const activeBaselineEndedAt = parseRepackHeatTimestampMillis(
      active.baselineWindowEndedAt,
    );
    const activeCurrentStartedAt = parseRepackHeatTimestampMillis(
      active.currentWindowStartedAt,
    );
    const activeCurrentEndedAt = parseRepackHeatTimestampMillis(
      active.currentWindowEndedAt,
    );
    const baselineStartedAt = parseRepackHeatTimestampMillis(
      frameTimeline.baselineWindow.startedAt,
    )!;
    const baselineEndedAt = parseRepackHeatTimestampMillis(
      frameTimeline.baselineWindow.endedAt,
    )!;
    const currentStartedAt = parseRepackHeatTimestampMillis(
      frameTimeline.currentWindow.startedAt,
    )!;
    const currentEndedAt = parseRepackHeatTimestampMillis(
      frameTimeline.currentWindow.endedAt,
    )!;
    if (
      activeCalculatedAt === null ||
      activeExpiresAt === null ||
      activeBaselineStartedAt === null ||
      activeBaselineEndedAt === null ||
      activeCurrentStartedAt === null ||
      activeCurrentEndedAt === null
    ) {
      refuse("MOCK_HEAT_STATE_INVALID");
    }
    if (
      baselineStartedAt <= activeBaselineStartedAt ||
      baselineEndedAt <= activeBaselineEndedAt ||
      currentStartedAt <= activeCurrentStartedAt ||
      currentEndedAt <= activeCurrentEndedAt ||
      calculatedAt <= activeCalculatedAt ||
      expiresAt <= activeExpiresAt
    ) {
      refuse("MOCK_HEAT_SEQUENCE_INVALID");
    }
  }

  const matchingSignalSets = await ctx.db
    .query("repackHeatSignalSets")
    .withIndex("by_manifest_id_and_signal_set_hash", (index) =>
      index
        .eq("manifestId", catalog.manifestDocument._id)
        .eq("signalSetHash", signalSetHash),
    )
    .take(2);
  if (matchingSignalSets.length > 1) refuse("MOCK_HEAT_STATE_INVALID");
  let signalSet = matchingSignalSets[0] ?? null;
  if (signalSet === null) {
    const now = new Date(serverNow).toISOString();
    const signalSetId = await ctx.db.insert("repackHeatSignalSets", {
      manifestId: catalog.manifestDocument._id,
      manifestAlignment: catalog.alignment,
      signalSetHash,
      lifecycle: "complete",
      sourceKind: "simulated",
      scenarioVersion: MOCK_HEAT_SCENARIO_VERSION,
      aggregationVersion: MOCK_HEAT_AGGREGATION_VERSION,
      heatPolicyVersion: MOCK_HEAT_POLICY_VERSION,
      signalCount: parsedSignals.length,
      originatingPublicationId: null,
      createdAt: now,
      completedAt: now,
    });
    for (const detail of parsedSignals) {
      const owned = repacks.get(detail.publicRepackId)!;
      await ctx.db.insert("repackHeatSignals", {
        signalSetId,
        providerReleaseId: owned.release._id,
        repackId: owned.repack._id,
        publicRepackId: detail.publicRepackId,
        detail: repackHeatSignalCore(detail),
      });
    }
    signalSet = (await ctx.db.get("repackHeatSignalSets", signalSetId))!;
  } else {
    const stored = await ctx.db
      .query("repackHeatSignals")
      .withIndex("by_signal_set_id_and_public_repack_id", (index) =>
        index.eq("signalSetId", signalSet!._id),
      )
      .take(MAX_PUBLIC_REPACKS_PER_RELEASE + 1);
    if (
      signalSet.lifecycle !== "complete" ||
      signalSet.manifestId !== catalog.manifestDocument._id ||
      canonicalJson(signalSet.manifestAlignment) !==
        canonicalJson(catalog.alignment) ||
      signalSet.sourceKind !== "simulated" ||
      signalSet.signalCount !== parsedSignals.length ||
      canonicalJson(stored.map(({ detail }) => detail)) !==
        canonicalJson(parsedSignals.map(repackHeatSignalCore))
    ) {
      refuse("MOCK_HEAT_STATE_INVALID");
    }
  }
  const snapshotId = await ctx.db.insert("repackHeatSnapshots", {
    manifestId: catalog.manifestDocument._id,
    manifestAlignment: catalog.alignment,
    signalSetId: signalSet._id,
    publicHeatSnapshotId: args.publicHeatSnapshotId,
    publicationId: null,
    simulationRunId: args.simulationRunId,
    sequence: args.sequence,
    sourceWatermark: null,
    lifecycle: "staging",
    sourceKind: "simulated",
    scenarioVersion: MOCK_HEAT_SCENARIO_VERSION,
    aggregationVersion: MOCK_HEAT_AGGREGATION_VERSION,
    heatPolicyVersion: MOCK_HEAT_POLICY_VERSION,
    contentHash: args.contentHash,
    signalCount: parsedSignals.length,
    baselineWindowStartedAt: frameTimeline.baselineWindow.startedAt,
    baselineWindowEndedAt: frameTimeline.baselineWindow.endedAt,
    currentWindowStartedAt: frameTimeline.currentWindow.startedAt,
    currentWindowEndedAt: frameTimeline.currentWindow.endedAt,
    calculatedAt: args.calculatedAt,
    expiresAt: args.expiresAt,
  });
  await ctx.db.patch("repackHeatSnapshots", snapshotId, {
    lifecycle: "complete",
  });
  await deleteRetainedSnapshot(
    ctx,
    state?.previousHeatSnapshotId ?? null,
  );
  if (active !== null) {
    await ctx.db.patch("repackHeatSnapshots", active._id, {
      lifecycle: "retired",
    });
  }
  const now = new Date(serverNow).toISOString();
  if (state === null) {
    await ctx.db.insert("repackHeatState", {
      key: "singleton",
      activeHeatSnapshotId: snapshotId,
      previousHeatSnapshotId: null,
      freshness: "current",
      expiresAt: args.expiresAt,
      latestSequence: args.sequence,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch("repackHeatState", state._id, {
      activeHeatSnapshotId: snapshotId,
      previousHeatSnapshotId: active?._id ?? null,
      freshness: "current",
      expiresAt: args.expiresAt,
      latestSequence: args.sequence,
      updatedAt: now,
    });
  }
  await ctx.scheduler.runAt(
    expiresAt,
    internal.mockHeatSimulationPublisher.expireActiveFrame,
    {
      publicHeatSnapshotId: args.publicHeatSnapshotId,
      expectedExpiresAt: args.expiresAt,
    },
  );
  return {
    status: "created" as const,
    publicHeatSnapshotId: args.publicHeatSnapshotId,
    simulationRunId: args.simulationRunId,
    sequence: args.sequence,
    signalCount: parsedSignals.length,
  };
}

const frameArgs = {
  manifestAlignment: productionHeatManifestAlignmentValidator,
  publicHeatSnapshotId: v.string(),
  simulationRunId: v.string(),
  sequence: v.number(),
  sourceKind: v.literal("simulated"),
  scenarioVersion: v.string(),
  aggregationVersion: v.string(),
  heatPolicyVersion: v.string(),
  calculatedAt: v.string(),
  expiresAt: v.string(),
  signals: v.array(publicRepackHeatSignalValidator),
  contentHash: v.string(),
};

/** Accept an already aggregated deterministic frame. Raw pull events are not accepted. */
export const publishFrame = internalMutation({
  args: frameArgs,
  returns: publishResultValidator,
  handler: publishMockHeatFrame,
});

/** Mark exactly the named active frame expired; stale callers cannot expire a newer frame. */
export const expireActiveFrame = internalMutation({
  args: {
    publicHeatSnapshotId: v.string(),
    expectedExpiresAt: v.string(),
  },
  returns: v.object({
    status: v.union(v.literal("expired"), v.literal("unchanged")),
    publicHeatSnapshotId: v.string(),
  }),
  handler: async (ctx, args) => {
    assertLocalEnvironment();
    const expectedExpiresAt = parseRepackHeatTimestampMillis(
      args.expectedExpiresAt,
    );
    if (
      !snapshotIdPattern.test(args.publicHeatSnapshotId) ||
      expectedExpiresAt === null
    ) {
      refuse("MOCK_HEAT_FRAME_INVALID");
    }
    const states = await ctx.db
      .query("repackHeatState")
      .withIndex("by_key", (index) => index.eq("key", "singleton"))
      .take(2);
    if (states.length > 1) refuse("MOCK_HEAT_STATE_INVALID");
    const state = states[0] ?? null;
    if (state === null || state.activeHeatSnapshotId === null) {
      return {
        status: "unchanged" as const,
        publicHeatSnapshotId: args.publicHeatSnapshotId,
      };
    }
    const snapshot = await ctx.db.get(
      "repackHeatSnapshots",
      state.activeHeatSnapshotId,
    );
    if (
      snapshot === null ||
      snapshot.lifecycle !== "complete" ||
      snapshot.expiresAt !== state.expiresAt
    ) {
      refuse("MOCK_HEAT_STATE_INVALID");
    }
    let catalog: ActiveCatalogHeatManifest;
    try {
      catalog = await loadMockCatalog(ctx, snapshot.manifestAlignment);
    } catch {
      return {
        status: "unchanged" as const,
        publicHeatSnapshotId: args.publicHeatSnapshotId,
      };
    }
    if (
      snapshot.manifestId !== catalog.manifestDocument._id ||
      snapshot.sourceKind !== "simulated"
    ) {
      return {
        status: "unchanged" as const,
        publicHeatSnapshotId: args.publicHeatSnapshotId,
      };
    }
    if (
      snapshot.publicHeatSnapshotId !== args.publicHeatSnapshotId ||
      snapshot.expiresAt !== args.expectedExpiresAt ||
      state.expiresAt !== args.expectedExpiresAt
    ) {
      return {
        status: "unchanged" as const,
        publicHeatSnapshotId: args.publicHeatSnapshotId,
      };
    }
    if (state.freshness === "expired") {
      return {
        status: "unchanged" as const,
        publicHeatSnapshotId: args.publicHeatSnapshotId,
      };
    }
    if (state.freshness !== "current") refuse("MOCK_HEAT_STATE_INVALID");
    await ctx.db.patch("repackHeatState", state._id, {
      freshness: "expired",
      updatedAt: new Date().toISOString(),
    });
    return {
      status: "expired" as const,
      publicHeatSnapshotId: args.publicHeatSnapshotId,
    };
  },
});
