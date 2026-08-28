import { DATA_RELEASE_V3_SCHEMA_VERSION } from "@packscout/contracts";
import { v } from "convex/values";
import { z } from "zod";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { canonicalJson } from "./dataReleaseCanonicalHash";
import {
  assertRequestDigest,
  buildReceipt,
  loadActiveDataReleaseV3State,
  loadExactReplay,
  parseRequest,
  storeReceipt,
} from "./dataReleaseV3Lifecycle";
import {
  refuseProductionDataRelease,
  type ProductionDataReleaseErrorCode,
} from "./productionDataReleaseErrors";

/**
 * Independently refreshed provider-health authorization for data_release_v3.
 *
 * Catalog releases remain immutable. One observation is stored per active
 * release and public vendor, and a later release is therefore ineligible until
 * it receives its own aligned observation. The write primitive is internal on
 * purpose: only an authenticated publication boundary may invoke it.
 */

const MAX_OBSERVATION_CLOCK_SKEW_MILLISECONDS = 5 * 60_000;
const MAX_OBSERVATION_FRESHNESS_HORIZON_MILLISECONDS = 24 * 60 * 60_000;
const MAX_DECIMAL_SEQUENCE_DIGITS = 40;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VENDOR_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,63})$/u;
const DECIMAL_SEQUENCE_PATTERN = new RegExp(
  `^(?:0|[1-9][0-9]{0,${MAX_DECIMAL_SEQUENCE_DIGITS - 1}})$`,
  "u",
);

const operationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u);
const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u);
const timestampSchema = z
  .string()
  .refine((value) => timestampMilliseconds(value) !== null);
const decimalSequenceSchema = z
  .string()
  .regex(DECIMAL_SEQUENCE_PATTERN);

export const dataReleaseV3ProviderObservationRefreshRequestSchema = z
  .object({
    schemaVersion: z.literal(DATA_RELEASE_V3_SCHEMA_VERSION),
    operationId: operationIdSchema,
    idempotencyKey: idempotencyKeySchema,
    publicReleaseId: z.uuid(),
    releaseFingerprint: z.string().regex(SHA256_PATTERN),
    publicVendorId: z.uuid(),
    vendorKey: z.string().regex(VENDOR_KEY_PATTERN),
    observationSequence: z.number().int().safe().min(1),
    observedAt: timestampSchema,
    freshThrough: timestampSchema,
    lastHeadReachedAt: timestampSchema.nullable(),
    sourceHeadSequence: decimalSequenceSchema,
    settledSequence: decimalSequenceSchema,
    sourceLifecycle: z.enum(["active", "paused", "disabled"]),
    connectionState: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
    qualityState: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
    releaseAlignment: z.enum(["aligned", "behind"]),
  })
  .strict();

type ProviderObservationInput = Readonly<{
  publicReleaseId: string;
  releaseFingerprint: string;
  publicVendorId: string;
  vendorKey: string;
  observationSequence: number;
  observedAt: string;
  freshThrough: string;
  lastHeadReachedAt: string | null;
  sourceHeadSequence: string;
  settledSequence: string;
  sourceLifecycle: "active" | "paused" | "disabled";
  connectionState: "healthy" | "degraded" | "unhealthy" | "unknown";
  qualityState: "healthy" | "degraded" | "unhealthy" | "unknown";
  releaseAlignment: "aligned" | "behind";
}>;

export type DataReleaseV3ProviderRankingIneligibilityReason =
  | "PROVIDER_HEALTH_UNAVAILABLE"
  | "PROVIDER_OBSERVATION_STALE"
  | "PROVIDER_PAUSED"
  | "PROVIDER_UNHEALTHY"
  | "PROVIDER_BEHIND"
  | "RELEASE_MISMATCH";

export type DataReleaseV3PublicProviderHealth = Readonly<{
  state: "healthy" | "delayed" | "unavailable";
  observedAt: string | null;
  rankingEligible: boolean;
  rankingIneligibilityReason:
    | DataReleaseV3ProviderRankingIneligibilityReason
    | null;
}>;

export type DataReleaseV3ProviderHealthSummary = Readonly<{
  state: "healthy" | "delayed" | "unavailable";
  observedAt: string | null;
  freshThrough: string | null;
  nextHealthEvaluationAt: string | null;
  totalProviderCount: number;
  delayedProviderCount: number;
}>;

export type DataReleaseV3ProviderHealthSnapshot = Readonly<{
  byPublicVendorId: ReadonlyMap<string, DataReleaseV3PublicProviderHealth>;
  summary: DataReleaseV3ProviderHealthSummary;
}>;

function refuse(code: ProductionDataReleaseErrorCode): never {
  return refuseProductionDataRelease(code);
}

function timestampMilliseconds(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    return null;
  }
  return milliseconds;
}

function decimalSequence(value: string): bigint | null {
  if (!DECIMAL_SEQUENCE_PATTERN.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function inputFields(input: ProviderObservationInput) {
  return {
    publicReleaseId: input.publicReleaseId,
    releaseFingerprint: input.releaseFingerprint,
    publicVendorId: input.publicVendorId,
    vendorKey: input.vendorKey,
    observationSequence: input.observationSequence,
    observedAt: input.observedAt,
    freshThrough: input.freshThrough,
    lastHeadReachedAt: input.lastHeadReachedAt,
    sourceHeadSequence: input.sourceHeadSequence,
    settledSequence: input.settledSequence,
    sourceLifecycle: input.sourceLifecycle,
    connectionState: input.connectionState,
    qualityState: input.qualityState,
    releaseAlignment: input.releaseAlignment,
  };
}

function storedFields(document: Doc<"dataReleaseV3ProviderObservations">) {
  return inputFields(document);
}

function validateInput(input: ProviderObservationInput, serverNow: number): void {
  const observedAt = timestampMilliseconds(input.observedAt);
  const freshThrough = timestampMilliseconds(input.freshThrough);
  const lastHeadReachedAt = input.lastHeadReachedAt === null
    ? null
    : timestampMilliseconds(input.lastHeadReachedAt);
  const sourceHeadSequence = decimalSequence(input.sourceHeadSequence);
  const settledSequence = decimalSequence(input.settledSequence);
  if (
    !UUID_PATTERN.test(input.publicReleaseId) ||
    !SHA256_PATTERN.test(input.releaseFingerprint) ||
    !UUID_PATTERN.test(input.publicVendorId) ||
    !VENDOR_KEY_PATTERN.test(input.vendorKey) ||
    !Number.isSafeInteger(input.observationSequence) ||
    input.observationSequence < 1 ||
    observedAt === null ||
    freshThrough === null ||
    (input.lastHeadReachedAt !== null && lastHeadReachedAt === null) ||
    sourceHeadSequence === null ||
    settledSequence === null ||
    settledSequence > sourceHeadSequence ||
    observedAt > serverNow ||
    serverNow - observedAt > MAX_OBSERVATION_CLOCK_SKEW_MILLISECONDS ||
    freshThrough < observedAt ||
    freshThrough - observedAt > MAX_OBSERVATION_FRESHNESS_HORIZON_MILLISECONDS ||
    (lastHeadReachedAt !== null && lastHeadReachedAt > observedAt)
  ) {
    refuse("PUBLICATION_REQUEST_INVALID");
  }
}

async function assertVendorBelongsToRelease(
  ctx: MutationCtx,
  release: Doc<"dataReleaseV3Releases">,
  publicVendorId: string,
  vendorKey: string,
): Promise<void> {
  const shards = await ctx.db
    .query("dataReleaseV3SearchShards")
    .withIndex("by_release_id_and_shard_number", (index) =>
      index.eq("releaseId", release._id),
    )
    .take(release.expectedCounts.searchShards + 1);
  if (shards.length !== release.expectedCounts.searchShards) {
    refuse("PUBLICATION_STATE_CONFLICT");
  }
  let found = false;
  for (const shard of shards) {
    for (const row of shard.rows) {
      if (row.publicVendorId !== publicVendorId) continue;
      if (row.vendorKey !== vendorKey) {
        refuse("PUBLICATION_REFERENCE_INVALID");
      }
      found = true;
    }
  }
  if (!found) refuse("PUBLICATION_REFERENCE_INVALID");
}

function validateMonotonicAdvance(
  previous: Doc<"dataReleaseV3ProviderObservations">,
  next: ProviderObservationInput,
): void {
  const previousHead = decimalSequence(previous.sourceHeadSequence)!;
  const nextHead = decimalSequence(next.sourceHeadSequence)!;
  const previousSettled = decimalSequence(previous.settledSequence)!;
  const nextSettled = decimalSequence(next.settledSequence)!;
  const previousLastHead = previous.lastHeadReachedAt === null
    ? null
    : timestampMilliseconds(previous.lastHeadReachedAt)!;
  const nextLastHead = next.lastHeadReachedAt === null
    ? null
    : timestampMilliseconds(next.lastHeadReachedAt)!;
  if (
    next.observationSequence <= previous.observationSequence ||
    timestampMilliseconds(next.observedAt)! <
      timestampMilliseconds(previous.observedAt)! ||
    nextHead < previousHead ||
    nextSettled < previousSettled ||
    (previousLastHead !== null &&
      (nextLastHead === null || nextLastHead < previousLastHead))
  ) {
    refuse("PUBLICATION_REFRESH_STALE");
  }
}

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
} as const;

export const refresh = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertRequestDigest(args.requestDigest);
    const request = parseRequest(
      args.bodyJson,
      dataReleaseV3ProviderObservationRefreshRequestSchema,
    );
    const exactReplay = await loadExactReplay(ctx, {
      operationKind: "refreshProviderObservation",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      requestDigest: args.requestDigest,
    });
    if (exactReplay !== null) return exactReplay;
    const input: ProviderObservationInput = request;
    validateInput(input, Date.now());
    const state = await loadActiveDataReleaseV3State(ctx);
    if (
      state === null ||
      state.activeReleaseId === null ||
      state.activeRelease === null ||
      state.activeRelease.publicReleaseId !== input.publicReleaseId ||
      state.activeRelease.releaseFingerprint !== input.releaseFingerprint
    ) {
      refuse("PUBLICATION_PREDECESSOR_CONFLICT");
    }
    const release = await ctx.db.get(
      "dataReleaseV3Releases",
      state.activeReleaseId,
    );
    if (
      release === null ||
      release.lifecycle !== "complete" ||
      release.publicReleaseId !== input.publicReleaseId ||
      release.releaseFingerprint !== input.releaseFingerprint
    ) {
      refuse("PUBLICATION_PREDECESSOR_CONFLICT");
    }
    await assertVendorBelongsToRelease(
      ctx,
      release,
      input.publicVendorId,
      input.vendorKey,
    );
    const matches = await ctx.db
      .query("dataReleaseV3ProviderObservations")
      .withIndex("by_release_id_and_public_vendor_id", (index) =>
        index
          .eq("releaseId", release._id)
          .eq("publicVendorId", input.publicVendorId),
      )
      .take(2);
    if (matches.length > 1) {
      refuse("PUBLICATION_STATE_CONFLICT");
    }
    const previous = matches[0] ?? null;
    const result: "created" | "updated" | "replayed" = previous === null
      ? "created"
      : previous.observationSequence === input.observationSequence &&
          canonicalJson(storedFields(previous)) === canonicalJson(inputFields(input))
        ? "replayed"
        : "updated";
    if (previous === null) {
      await ctx.db.insert("dataReleaseV3ProviderObservations", {
        releaseId: release._id,
        ...inputFields(input),
      });
    } else if (result === "updated") {
      if (previous.observationSequence === input.observationSequence) {
        refuse("PUBLICATION_OPERATION_CONFLICT");
      }
      validateMonotonicAdvance(previous, input);
      await ctx.db.replace("dataReleaseV3ProviderObservations", previous._id, {
        releaseId: release._id,
        ...inputFields(input),
      });
    }
    const serverTime = new Date().toISOString();
    return await storeReceipt(
      ctx,
      await buildReceipt({
        schemaVersion: DATA_RELEASE_V3_SCHEMA_VERSION,
        operationKind: "refreshProviderObservation",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        publicReleaseId: request.publicReleaseId,
        result: `provider_observation_${result}`,
        serverTime,
        requestDigest: args.requestDigest,
        details: {
          publicVendorId: request.publicVendorId,
          vendorKey: request.vendorKey,
          observationSequence: request.observationSequence,
          observedAt: request.observedAt,
          freshThrough: request.freshThrough,
        },
      }),
    );
  },
});

function unavailableHealth(
  reason: DataReleaseV3ProviderRankingIneligibilityReason,
  observedAt: string | null = null,
): DataReleaseV3PublicProviderHealth {
  return {
    state: reason === "PROVIDER_HEALTH_UNAVAILABLE"
      ? "unavailable"
      : "delayed",
    observedAt: reason === "PROVIDER_HEALTH_UNAVAILABLE" ? null : observedAt,
    rankingEligible: false,
    rankingIneligibilityReason: reason,
  };
}

export function missingDataReleaseV3ProviderHealth(): DataReleaseV3PublicProviderHealth {
  return unavailableHealth("PROVIDER_HEALTH_UNAVAILABLE");
}

function presentObservation(
  release: Doc<"dataReleaseV3Releases">,
  publicVendorId: string,
  vendorKey: string,
  observation: Doc<"dataReleaseV3ProviderObservations">,
  evaluationTime: number,
): DataReleaseV3PublicProviderHealth {
  const observedAt = timestampMilliseconds(observation.observedAt);
  const freshThrough = timestampMilliseconds(observation.freshThrough);
  if (observedAt === null || freshThrough === null) {
    return missingDataReleaseV3ProviderHealth();
  }
  if (
    freshThrough < observedAt ||
    evaluationTime < observedAt
  ) {
    return unavailableHealth("PROVIDER_UNHEALTHY", observation.observedAt);
  }
  if (
    observation.releaseId !== release._id ||
    observation.publicReleaseId !== release.publicReleaseId ||
    observation.releaseFingerprint !== release.releaseFingerprint ||
    observation.publicVendorId !== publicVendorId ||
    observation.vendorKey !== vendorKey
  ) {
    return unavailableHealth("RELEASE_MISMATCH", observation.observedAt);
  }
  if (observation.sourceLifecycle !== "active") {
    return unavailableHealth("PROVIDER_PAUSED", observation.observedAt);
  }
  if (
    observation.connectionState !== "healthy" ||
    observation.qualityState !== "healthy"
  ) {
    return unavailableHealth("PROVIDER_UNHEALTHY", observation.observedAt);
  }
  if (
    observation.releaseAlignment !== "aligned" ||
    observation.lastHeadReachedAt === null ||
    observation.sourceHeadSequence !== observation.settledSequence
  ) {
    return unavailableHealth("PROVIDER_BEHIND", observation.observedAt);
  }
  if (evaluationTime >= freshThrough) {
    return unavailableHealth("PROVIDER_OBSERVATION_STALE", observation.observedAt);
  }
  return {
    state: "healthy",
    observedAt: observation.observedAt,
    rankingEligible: true,
    rankingIneligibilityReason: null,
  };
}

export async function loadDataReleaseV3ProviderHealthSnapshot(
  ctx: QueryCtx,
  release: Doc<"dataReleaseV3Releases">,
  vendors: readonly Readonly<{
    publicVendorId: string;
    vendorKey: string;
  }>[],
  evaluationTime: number,
): Promise<DataReleaseV3ProviderHealthSnapshot | null> {
  const uniqueVendors = new Map<string, string>();
  for (const vendor of vendors) {
    const previousKey = uniqueVendors.get(vendor.publicVendorId);
    if (previousKey !== undefined && previousKey !== vendor.vendorKey) return null;
    uniqueVendors.set(vendor.publicVendorId, vendor.vendorKey);
  }
  const observations = await ctx.db
    .query("dataReleaseV3ProviderObservations")
    .withIndex("by_release_id_and_public_vendor_id", (index) =>
      index.eq("releaseId", release._id),
    )
    .take(uniqueVendors.size + 1);
  if (observations.length > uniqueVendors.size) return null;
  const byVendor = new Map<string, Doc<"dataReleaseV3ProviderObservations">>();
  for (const observation of observations) {
    if (
      !uniqueVendors.has(observation.publicVendorId) ||
      byVendor.has(observation.publicVendorId)
    ) {
      return null;
    }
    byVendor.set(observation.publicVendorId, observation);
  }
  const byPublicVendorId = new Map<string, DataReleaseV3PublicProviderHealth>();
  for (const [publicVendorId, vendorKey] of uniqueVendors) {
    const observation = byVendor.get(publicVendorId);
    const health = observation === undefined
      ? missingDataReleaseV3ProviderHealth()
      : presentObservation(
          release,
          publicVendorId,
          vendorKey,
          observation,
          evaluationTime,
        );
    byPublicVendorId.set(publicVendorId, health);
  }
  const healthValues = [...byPublicVendorId.values()];
  const missingObservation = [...uniqueVendors.keys()].some(
    (publicVendorId) => !byVendor.has(publicVendorId),
  );
  const observedTimes = observations
    .map((observation) => timestampMilliseconds(observation.observedAt))
    .filter((value): value is number => value !== null);
  const freshThroughTimes = observations
    .map((observation) => timestampMilliseconds(observation.freshThrough))
    .filter((value): value is number => value !== null);
  const nextHealthEvaluationTimes = observations.flatMap((observation) => {
    const health = byPublicVendorId.get(observation.publicVendorId);
    const freshThrough = timestampMilliseconds(observation.freshThrough);
    return health?.rankingEligible === true && freshThrough !== null
      ? [freshThrough]
      : [];
  });
  const delayedProviderCount = healthValues.filter(
    ({ rankingEligible }) => !rankingEligible,
  ).length;
  const unavailableProvider = healthValues.some(
    ({ state }) => state === "unavailable",
  );
  const state: DataReleaseV3ProviderHealthSummary["state"] =
    uniqueVendors.size === 0 ||
      observations.length === 0 ||
      missingObservation ||
      unavailableProvider
      ? "unavailable"
      : delayedProviderCount > 0
        ? "delayed"
        : "healthy";
  return {
    byPublicVendorId,
    summary: {
      state,
      observedAt:
        state === "unavailable" || observedTimes.length === 0
          ? null
          : new Date(Math.min(...observedTimes)).toISOString(),
      freshThrough:
        state === "unavailable" || freshThroughTimes.length === 0
          ? null
          : new Date(Math.min(...freshThroughTimes)).toISOString(),
      nextHealthEvaluationAt:
        nextHealthEvaluationTimes.length === 0
          ? null
          : new Date(Math.min(...nextHealthEvaluationTimes)).toISOString(),
      totalProviderCount: uniqueVendors.size,
      delayedProviderCount,
    },
  };
}
