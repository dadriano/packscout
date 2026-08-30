import { isDeepStrictEqual } from "node:util";

function refuse() {
  throw new Error("CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT");
}

function repacks(plan) {
  return plan.batches.filter((batch) => batch.kind === "repacks")
    .flatMap((batch) => batch.records);
}

function scope(detail) {
  return {
    vendorKey: detail.vendorKey,
    publicVendorId: detail.publicVendorId,
    publicRepackId: detail.publicRepackId,
  };
}

function price(detail) {
  return detail.price?.usdComparison?.status === "available"
    ? detail.price.usdComparison.value.minorUnits : null;
}

/** The same authenticated endpoint must prove readiness before the first CAS. */
export async function requireClutchpacksEvWitnessReadiness(publication, active) {
  const request = {
    expectedGeneration: active.generation,
    expectedActivePublicReleaseId: active.activeRelease?.publicReleaseId ?? null,
    expectedActiveReleaseFingerprint: active.activeRelease?.releaseFingerprint ?? null,
  };
  const ready = await publication.retainedEvWitnessReadiness(request);
  if (ready?.generation !== request.expectedGeneration ||
      ready.activePublicReleaseId !== request.expectedActivePublicReleaseId ||
      ready.activeReleaseFingerprint !== request.expectedActiveReleaseFingerprint ||
      (request.expectedActivePublicReleaseId === null
        ? ready.retention !== null : ready.retention === null)) refuse();
}

/** Pins the authenticated read to the precise post-CAS publication state. */
export function clutchpacksRetainedEvWitnessRequest(plan, active) {
  if (active?.activeRelease?.publicReleaseId !== plan.publicReleaseId ||
      active.activeRelease.releaseFingerprint !== plan.releaseFingerprint ||
      !Number.isSafeInteger(active.generation) || active.generation < 1) refuse();
  const scopes = repacks(plan).map(scope);
  if (scopes.length !== 17 || scopes.some((entry) => entry.vendorKey !== "clutchpacks") ||
      new Set(scopes.map((entry) => entry.publicRepackId)).size !== scopes.length) refuse();
  return {
    expectedActivePublicReleaseId: plan.publicReleaseId,
    expectedActiveReleaseFingerprint: plan.releaseFingerprint,
    expectedGeneration: active.generation,
    scopes,
  };
}

/**
 * The signed read boundary proves retained provenance against original release
 * facts. Public display bytes are never used as evidence for their own validity.
 * This verifier separately binds every active raw fact to the immutable local
 * candidate, then applies the canonical confidence policy to the selected fact.
 */
export function clutchpacksExpectedDisplayedEv(plan, verification) {
  const schema = verification?.retainedEvWitnessSchema;
  const present = verification?.presentPackScoutPublicEv;
  if (typeof schema?.safeParse !== "function" || typeof present !== "function") refuse();
  const parsed = schema.safeParse(verification.retainedEvWitness);
  if (!parsed.success) refuse();
  const witness = parsed.data;
  const records = repacks(plan);
  if (witness.activePublicReleaseId !== plan.publicReleaseId ||
      witness.activeReleaseFingerprint !== plan.releaseFingerprint ||
      records.length !== 17 || witness.entries.length !== records.length) refuse();
  const byId = new Map(witness.entries.map((entry) => [entry.publicRepackId, entry]));
  if (byId.size !== records.length) refuse();
  for (const detail of records) {
    const entry = byId.get(detail.publicRepackId);
    if (entry === undefined || !isDeepStrictEqual(scope(entry), scope(detail)) ||
        !isDeepStrictEqual(entry.activeFacts, {
          availability: detail.availability,
          estimate: detail.evEstimates.packScout,
          calculationPriceUsdMinor: price(detail),
        }) || (entry.retained === null && detail.evEstimates.packScout.status !== "unavailable")) refuse();
  }
  return (detail, referenceTimeIso) => {
    const entry = detail === undefined ? undefined : byId.get(detail.publicRepackId);
    if (entry === undefined || !isDeepStrictEqual(scope(entry), scope(detail))) refuse();
    if (entry.retained === null) return entry.activeFacts.estimate;
    try {
      return present({
        estimate: entry.retained.estimate,
        calculationPriceUsdMinor: entry.retained.calculationPriceUsdMinor,
        referenceTimeIso,
        latestUnavailableReason: entry.retained.latestUnavailableAttempt?.reason ?? null,
      });
    } catch {
      refuse();
    }
  };
}

/** Both signed reads must straddle public reads without a transition change. */
export function assertClutchpacksRetainedEvWitnessUnchanged(before, after) {
  if (!isDeepStrictEqual(before, after)) refuse();
}
