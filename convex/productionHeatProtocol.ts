import {
  REPACK_HEAT_MAXIMUM_FUTURE_SKEW_MILLISECONDS,
  REPACK_HEAT_MAXIMUM_PUBLISH_LAG_MILLISECONDS,
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  containsProtectedPublicationField,
  parseRepackHeatTimestampMillis,
  productionHeatFrameEnvelopeSchema,
  recomputeProductionHeatFrameHash,
  type ProductionHeatFrameEnvelope,
} from "@packscout/contracts";
import type { ZodType } from "zod";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";

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

export async function loadActiveCatalogRelease(
  ctx: MutationCtx,
  expectedPublicReleaseId: string,
  heatSourceWatermark?: string,
): Promise<Doc<"dataReleases">> {
  const states = await ctx.db
    .query("dataReleaseState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (states.length !== 1 || states[0]!.activeReleaseId === null) {
    return refuseProductionDataRelease("PUBLICATION_PREDECESSOR_CONFLICT");
  }
  const release = await ctx.db.get("dataReleases", states[0]!.activeReleaseId);
  if (
    release === null ||
    release.lifecycle !== "complete" ||
    release.metadata.dataSource !== "canonical" ||
    release.publicReleaseId !== expectedPublicReleaseId ||
    release.metadata.publicReleaseId !== expectedPublicReleaseId
  ) {
    return refuseProductionDataRelease("PUBLICATION_PREDECESSOR_CONFLICT");
  }
  if (
    !Number.isSafeInteger(states[0]!.latestObservationSequence) ||
    states[0]!.latestObservationSequence <= 0
  ) {
    return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  if (
    heatSourceWatermark !== undefined &&
    BigInt(heatSourceWatermark) < BigInt(states[0]!.latestObservationSequence)
  ) {
    return refuseProductionDataRelease("PUBLICATION_PREDECESSOR_CONFLICT");
  }
  return release;
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

export async function loadHeatState(
  ctx: MutationCtx,
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
  ctx: MutationCtx,
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
    active.expiresAt !== state.expiresAt
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
