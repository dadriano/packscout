import {
  canonicalJson,
  dataReleaseV3RetainedEvWitnessReadinessSchema,
  dataReleaseV3RetainedEvWitnessRequestSchema,
  dataReleaseV3RetainedEvWitnessSchema,
  presentLastKnownPackScoutEvV3,
  type DataReleaseV3RetainedEvWitness,
  type DataReleaseV3RetainedEvWitnessRequest,
  type PublicRepackSummaryV3,
} from "@packscout/contracts";
import type {
  DataReleaseV3ActiveState,
  SignedConvexDataReleaseV3PublicationClient,
} from "@packscout/services";
import { DistributedClutchpacksPublicationError } from "./distributed-clutchpacks-publication-plan.mts";

export type LocalClutchpacksPlannedEvRow = Pick<PublicRepackSummaryV3,
  "vendorKey" | "publicVendorId" | "publicRepackId" | "availability" | "evEstimates" | "price">;
type WitnessClient = Pick<SignedConvexDataReleaseV3PublicationClient,
  "activeState" | "retainedEvWitnessReadiness">;

function refuse(): never {
  throw new DistributedClutchpacksPublicationError("LOCAL_CONVEX_PUBLIC_READBACK_FAILED");
}
function scope(row: LocalClutchpacksPlannedEvRow) {
  return { vendorKey: row.vendorKey, publicVendorId: row.publicVendorId, publicRepackId: row.publicRepackId };
}

/** Refuse old or incoherent backends before any provider/manifest/V3 publication. */
export async function withLocalClutchpacksWitnessReady<T>(client: WitnessClient,
  publish: (state: DataReleaseV3ActiveState) => Promise<T>): Promise<T> {
  const state = await client.activeState();
  const request = { expectedGeneration: state.generation,
    expectedActivePublicReleaseId: state.activeRelease?.publicReleaseId ?? null,
    expectedActiveReleaseFingerprint: state.activeRelease?.releaseFingerprint ?? null };
  const parsed = dataReleaseV3RetainedEvWitnessReadinessSchema.safeParse(
    await client.retainedEvWitnessReadiness(request));
  if (!parsed.success || parsed.data.generation !== request.expectedGeneration ||
      parsed.data.activePublicReleaseId !== request.expectedActivePublicReleaseId ||
      parsed.data.activeReleaseFingerprint !== request.expectedActiveReleaseFingerprint) return refuse();
  return await publish(state);
}

export function localClutchpacksRetainedEvWitnessRequest(input: {
  readonly publicReleaseId: string; readonly releaseFingerprint: string;
  readonly rows: readonly LocalClutchpacksPlannedEvRow[];
  readonly state: DataReleaseV3ActiveState;
}): DataReleaseV3RetainedEvWitnessRequest {
  if (input.state.activeRelease?.publicReleaseId !== input.publicReleaseId ||
      input.state.activeRelease.releaseFingerprint !== input.releaseFingerprint) return refuse();
  const parsed = dataReleaseV3RetainedEvWitnessRequestSchema.safeParse({
    expectedActivePublicReleaseId: input.publicReleaseId,
    expectedActiveReleaseFingerprint: input.releaseFingerprint,
    expectedGeneration: input.state.generation, scopes: input.rows.map(scope),
  });
  if (!parsed.success) return refuse();
  return parsed.data;
}

/**
 * Signed transport proves immutable retained-source provenance. Bind its active
 * facts independently to our immutable candidate, never to a prior public view.
 * The canonical presenter alone applies confidence at each server-issued clock.
 */
export function localClutchpacksExpectedEv(input: {
  readonly rows: readonly LocalClutchpacksPlannedEvRow[];
  readonly request: DataReleaseV3RetainedEvWitnessRequest;
  readonly witness: DataReleaseV3RetainedEvWitness;
}) {
  const request = dataReleaseV3RetainedEvWitnessRequestSchema.safeParse(input.request);
  const parsed = dataReleaseV3RetainedEvWitnessSchema.safeParse(input.witness);
  if (!request.success || !parsed.success) return refuse();
  const witness = parsed.data;
  const scopes = input.rows.map(scope);
  if (witness.activePublicReleaseId !== request.data.expectedActivePublicReleaseId ||
      witness.activeReleaseFingerprint !== request.data.expectedActiveReleaseFingerprint ||
      witness.generation !== request.data.expectedGeneration ||
      canonicalJson(scopes) !== canonicalJson(request.data.scopes) ||
      canonicalJson(witness.entries.map(({ vendorKey, publicVendorId, publicRepackId }) =>
        ({ vendorKey, publicVendorId, publicRepackId }))) !== canonicalJson(scopes)) return refuse();
  const byId = new Map(witness.entries.map(entry => [entry.publicRepackId, entry]));
  for (const row of input.rows) {
    const entry = byId.get(row.publicRepackId);
    if (entry === undefined || canonicalJson(entry.activeFacts) !== canonicalJson({
      availability: row.availability, estimate: row.evEstimates.packScout,
      calculationPriceUsdMinor: row.price.usdComparison.status === "available"
        ? row.price.usdComparison.value.minorUnits : null,
    })) return refuse();
  }
  return (row: LocalClutchpacksPlannedEvRow, referenceTimeIso: string) => {
    const entry = byId.get(row.publicRepackId);
    if (entry === undefined) return refuse();
    if (entry.retained === null) return entry.activeFacts.estimate;
    return presentLastKnownPackScoutEvV3({ estimate: entry.retained.estimate,
      calculationPriceUsdMinor: entry.retained.calculationPriceUsdMinor, referenceTimeIso,
      latestUnavailableReason: entry.retained.latestUnavailableAttempt?.reason ?? null });
  };
}

export function assertLocalClutchpacksWitnessUnchanged(
  before: DataReleaseV3RetainedEvWitness, after: DataReleaseV3RetainedEvWitness,
): void {
  if (canonicalJson(before) !== canonicalJson(after)) return refuse();
}
