import {
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  packScoutBuybackEvMetricsAreConsistentV1,
  packScoutBuybackEvPublicReasonCodeV1Schema,
  packScoutBuybackEvTimestampV1Schema,
  packScoutPublicEvV3Schema,
  type PackScoutPublicEvV3,
  type PublicRepackDetailV3,
} from "@packscout/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { canonicalJson, sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import { loadReleaseEvFacts, type DataReleaseV3EvFacts } from "./dataReleaseV3EvFacts";
import { MAX_DATA_RELEASE_V3_REPACKS } from "./dataReleaseV3Search";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";

export const MAX_RETAINED_EV_TRANSITION_CHANGES = MAX_DATA_RELEASE_V3_REPACKS * 2;
// At most 2,000 small before/after records: <=4,003 writes and <=4,010
// indexed reads in the legacy-seed case. Bound encoded payloads independently
// so large descriptions/images cannot consume the mutation's byte allowance.
export const MAX_RETAINED_EV_TRANSITION_BYTES = 4 * 1_024 * 1_024;
const HASH_DOMAIN = "packscout.data-release-v3.retained-ev-transition.v1";

export type RetainedEvScope = Pick<PublicRepackDetailV3,
  "vendorKey" | "publicVendorId" | "publicRepackId">;
export type RetainedEvValue = Doc<"dataReleaseV3RetainedEv">["value"];
type Change = RetainedEvScope & {
  readonly before: RetainedEvValue | null;
  readonly after: RetainedEvValue | null;
};
type RetentionPointer = {
  readonly retainedEvTransitionId: Id<"dataReleaseV3EvRetentionTransitions">;
  readonly retainedEvTransitionDirection: "forward" | "reverse";
};

function refuse(): never {
  return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
}

function scopeKey(scope: RetainedEvScope): string {
  return canonicalJson([scope.vendorKey, scope.publicVendorId, scope.publicRepackId]);
}

function scopeOf(detail: RetainedEvScope): RetainedEvScope {
  return { vendorKey: detail.vendorKey, publicVendorId: detail.publicVendorId,
    publicRepackId: detail.publicRepackId };
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

export function assertRetainedEvTransitionBounds(changes: readonly Change[]): void {
  if (changes.length > MAX_RETAINED_EV_TRANSITION_CHANGES ||
      bytes(changes) > MAX_RETAINED_EV_TRANSITION_BYTES) refuse();
}

function validValue(value: RetainedEvValue): RetainedEvValue {
  const parsed = packScoutPublicEvV3Schema.safeParse(value.estimate);
  if (!parsed.success || parsed.data.status === "unavailable" ||
      !Number.isSafeInteger(value.calculationPriceUsdMinor) || value.calculationPriceUsdMinor <= 0 ||
      !packScoutBuybackEvMetricsAreConsistentV1({
        grossEvMinorUnits: parsed.data.metrics.grossEvMoney.minorUnits,
        grossReturnBasisPoints: parsed.data.metrics.grossReturnBasisPoints,
        evDollarsMinorUnits: parsed.data.metrics.evDollars.minorUnits,
        evPercentBasisPoints: parsed.data.metrics.evPercentBasisPoints,
        packPriceMinorUnits: value.calculationPriceUsdMinor,
      })) refuse();
  const failed = value.latestUnavailableAttempt;
  if (failed !== null && (!packScoutBuybackEvTimestampV1Schema.safeParse(failed.calculatedAt).success ||
      !packScoutBuybackEvPublicReasonCodeV1Schema.safeParse(failed.reason).success ||
      Date.parse(failed.calculatedAt) <= Date.parse(parsed.data.calculatedAt))) refuse();
  return { ...value, estimate: parsed.data };
}

export async function loadRetainedEv(
  ctx: Pick<QueryCtx, "db">, scope: RetainedEvScope,
): Promise<Doc<"dataReleaseV3RetainedEv"> | null> {
  const stored = await ctx.db.query("dataReleaseV3RetainedEv")
    .withIndex("by_vendor_key_and_public_vendor_id_and_public_repack_id", (index) =>
      index.eq("vendorKey", scope.vendorKey).eq("publicVendorId", scope.publicVendorId)
        .eq("publicRepackId", scope.publicRepackId)).unique();
  if (stored !== null) validValue(stored.value);
  return stored;
}

/** Keep IO concurrency well below Convex's 1,000-operation ceiling. */
export async function loadRetainedEvForScopes(ctx: Pick<QueryCtx, "db">,
  scopes: readonly RetainedEvScope[]): Promise<readonly (Doc<"dataReleaseV3RetainedEv"> | null)[]> {
  if (scopes.length > MAX_RETAINED_EV_TRANSITION_CHANGES) return refuse();
  const values: (Doc<"dataReleaseV3RetainedEv"> | null)[] = [];
  for (let offset = 0; offset < scopes.length; offset += 100) {
    values.push(...await Promise.all(scopes.slice(offset, offset + 100)
      .map((scope) => loadRetainedEv(ctx, scope))));
  }
  return values;
}

function valueFromFacts(facts: DataReleaseV3EvFacts, publicReleaseId: string): RetainedEvValue | null {
  if (facts.estimate.status === "unavailable") return null;
  if (facts.calculationPriceUsdMinor === null) return refuse();
  return validValue({ estimate: facts.estimate,
    calculationPriceUsdMinor: facts.calculationPriceUsdMinor,
    sourcePublicReleaseId: publicReleaseId, latestUnavailableAttempt: null });
}

export function preferRetainedEv(
  current: RetainedEvValue | null, candidate: RetainedEvValue | null,
): RetainedEvValue | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  const candidateTime = Date.parse(candidate.estimate.calculatedAt);
  const currentTime = Date.parse(current.estimate.calculatedAt);
  if (candidateTime <= currentTime) return current;
  const failure = current.latestUnavailableAttempt;
  if (failure !== null && candidateTime === Date.parse(failure.calculatedAt)) return current;
  return { ...candidate, latestUnavailableAttempt: failure !== null &&
    (candidateTime <= currentTime || candidateTime <= Date.parse(failure.calculatedAt)) ? failure : null };
}

type ReleaseObservation = RetainedEvScope & {
  readonly value: RetainedEvValue | null;
  readonly failed: RetainedEvValue["latestUnavailableAttempt"];
};

function applyObservation(current: RetainedEvValue | null, observation: ReleaseObservation): RetainedEvValue | null {
  const value = preferRetainedEv(current, observation.value);
  const failed = observation.failed;
  if (value === null || failed === null ||
      Date.parse(failed.calculatedAt) <= Date.parse(value.estimate.calculatedAt) ||
      (value.latestUnavailableAttempt !== null &&
        Date.parse(failed.calculatedAt) < Date.parse(value.latestUnavailableAttempt.calculatedAt))) return value;
  return { ...value, latestUnavailableAttempt: failed };
}

async function releaseValues(ctx: Pick<QueryCtx, "db">,
  release: Doc<"dataReleaseV3Releases">): Promise<readonly ReleaseObservation[]> {
  if (release.lifecycle !== "complete" || release.completedAt === null ||
      release.expectedCounts.repacks > MAX_DATA_RELEASE_V3_REPACKS) return refuse();
  const facts = await loadReleaseEvFacts(ctx, release);
  return facts.map((item) => ({ ...scopeOf(item), value: valueFromFacts(item, release.publicReleaseId),
    failed: item.estimate.status === "unavailable"
      ? { calculatedAt: item.estimate.calculatedAt, reason: item.estimate.reason } : null }));
}

async function writeValue(ctx: MutationCtx, scope: RetainedEvScope,
  existing: Doc<"dataReleaseV3RetainedEv"> | null, value: RetainedEvValue | null): Promise<void> {
  if (value === null) {
    if (existing !== null) await ctx.db.delete("dataReleaseV3RetainedEv", existing._id);
  } else if (existing === null) {
    await ctx.db.insert("dataReleaseV3RetainedEv", { ...scope, value });
  } else {
    await ctx.db.patch("dataReleaseV3RetainedEv", existing._id, { value });
  }
}

/** Called only after activation CAS and complete-release checks, in that transaction. */
export async function activateRetainedEv(ctx: MutationCtx, input: {
  readonly previousRelease: Doc<"dataReleaseV3Releases"> | null;
  readonly nextRelease: Doc<"dataReleaseV3Releases">;
  readonly seedPrevious: boolean;
  readonly operationId: string;
}): Promise<RetentionPointer> {
  const seed = input.seedPrevious && input.previousRelease !== null &&
      input.previousRelease.publicEvPolicyVersion === PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3
    ? await releaseValues(ctx, input.previousRelease) : [];
  const candidates = await releaseValues(ctx, input.nextRelease);
  const scopes = new Map([...seed, ...candidates].map((value) => [scopeKey(value), scopeOf(value)]));
  const stored = await loadRetainedEvForScopes(ctx, [...scopes.values()]);
  const existing = new Map([...scopes.keys()].map((key, index) => [key, stored[index] ?? null]));
  const before = new Map([...existing].map(([key, stored]) => [key, stored?.value ?? null]));
  for (const item of seed) before.set(scopeKey(item), applyObservation(before.get(scopeKey(item)) ?? null, item));
  const after = new Map(before);
  for (const item of candidates) after.set(scopeKey(item), applyObservation(after.get(scopeKey(item)) ?? null, item));
  const changes: Change[] = [...scopes].flatMap(([key, scope]) => {
    const previous = before.get(key) ?? null;
    const next = after.get(key) ?? null;
    return canonicalJson(existing.get(key)?.value ?? null) === canonicalJson(next)
      ? [] : [{ ...scope, before: previous, after: next }];
  }).sort((left, right) => scopeKey(left).localeCompare(scopeKey(right)));
  assertRetainedEvTransitionBounds(changes);
  const transitionId = await ctx.db.insert("dataReleaseV3EvRetentionTransitions", {
    operationId: input.operationId, fromReleaseId: input.previousRelease?._id ?? null,
    toReleaseId: input.nextRelease._id, changeCount: changes.length,
    changesSha256: await sha256CanonicalJson(HASH_DOMAIN, changes),
  });
  for (const change of changes) {
    await ctx.db.insert("dataReleaseV3EvRetentionChanges", { transitionId, ...change });
    await writeValue(ctx, scopeOf(change), existing.get(scopeKey(change)) ?? null, change.after);
  }
  return { retainedEvTransitionId: transitionId, retainedEvTransitionDirection: "forward" };
}

/** Reverse exactly the immediately preceding activation, including a repeated rollback. */
export async function rollbackRetainedEv(ctx: MutationCtx,
  state: Doc<"activeDataReleaseV3State">): Promise<Partial<RetentionPointer>> {
  if (state.retainedEvTransitionId === undefined && state.retainedEvTransitionDirection === undefined) return {};
  if (state.retainedEvTransitionId === undefined || state.retainedEvTransitionDirection === undefined) return refuse();
  const transition = await ctx.db.get("dataReleaseV3EvRetentionTransitions", state.retainedEvTransitionId);
  const forward = state.retainedEvTransitionDirection === "forward";
  if (transition === null ||
      state.activeReleaseId !== (forward ? transition.toReleaseId : transition.fromReleaseId) ||
      state.previousReleaseId !== (forward ? transition.fromReleaseId : transition.toReleaseId)) return refuse();
  const rows = await ctx.db.query("dataReleaseV3EvRetentionChanges")
    .withIndex("by_transition_id", (index) => index.eq("transitionId", transition._id))
    .take(MAX_RETAINED_EV_TRANSITION_CHANGES + 1);
  const changes: Change[] = rows.map(({ vendorKey, publicVendorId, publicRepackId, before, after }) =>
    ({ vendorKey, publicVendorId, publicRepackId, before, after }))
    .sort((left, right) => scopeKey(left).localeCompare(scopeKey(right)));
  assertRetainedEvTransitionBounds(changes);
  if (changes.length !== transition.changeCount ||
      new Set(changes.map(scopeKey)).size !== changes.length ||
      await sha256CanonicalJson(HASH_DOMAIN, changes) !== transition.changesSha256) return refuse();
  for (const change of changes) {
    const stored = await loadRetainedEv(ctx, change);
    if (canonicalJson(stored?.value ?? null) !== canonicalJson(forward ? change.after : change.before)) return refuse();
    const next = forward ? change.before : change.after;
    if (next !== null) validValue(next);
    await writeValue(ctx, scopeOf(change), stored, next);
  }
  return { retainedEvTransitionId: transition._id,
    retainedEvTransitionDirection: forward ? "reverse" : "forward" };
}

export function retainedEvForFacts(facts: DataReleaseV3EvFacts,
  retained: RetainedEvValue | null, publicReleaseId: string): {
    readonly value: RetainedEvValue | null;
    readonly latestUnavailableReason?: Extract<PackScoutPublicEvV3, { status: "unavailable" }>["reason"];
  } {
  const estimate = facts.estimate;
  const value = applyObservation(retained, { ...scopeOf(facts), value: valueFromFacts(facts, publicReleaseId),
    failed: estimate.status === "unavailable" ? { calculatedAt: estimate.calculatedAt, reason: estimate.reason } : null });
  const reason = value === null && estimate.status === "unavailable" ? estimate.reason
    : value?.latestUnavailableAttempt?.reason;
  return { value, ...(reason === undefined ? {} : { latestUnavailableReason: reason }) };
}
