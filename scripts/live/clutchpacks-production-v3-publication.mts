import { z } from "zod";
import { canonicalJson, dataReleaseV3RetainedEvWitnessReadinessSchema,
  packScoutDisplayedEvV3Schema, packScoutPublicEvV3Schema,
  type ApprovedPublicCatalogConfigurationV1, type PackScoutDisplayedEvV3 } from "@packscout/contracts";
import { DataReleaseV3ReleasePublisher, type DataReleaseV3ActiveState,
  type DataReleaseV3PublicationPort, type DataReleaseV3PublishPlan,
  type DataReleaseV3RefreshProviderObservationRequest,
  type SignedConvexDataReleaseV3PublicationClient } from "@packscout/services";
import { assertClutchpacksProductionBindings, assertClutchpacksProductionPredecessor,
  buildClutchpacksProductionPublicationReceipt, ClutchpacksProductionPublicationError,
  parseClutchpacksProductionPublicationIntent, productionPublicationSha256,
  withClutchpacksProductionPublicationLease, type ClutchpacksProductionOwnedImportLease,
  type ClutchpacksProductionLeasePort, type ClutchpacksProductionLeaseAttempt, type ClutchpacksProductionPublicationIntent,
  type ClutchpacksProductionPublicationFailure } from "./clutchpacks-production-publication-policy.mts";

type PublicationClient = DataReleaseV3PublicationPort & Pick<SignedConvexDataReleaseV3PublicationClient,
  "retainedEvWitnessReadiness" | "retainedEvWitness" | "refreshProviderObservation">;
const publicationRow = z.object({ publicRepackId: z.uuid(), publicVendorId: z.uuid(),
  vendorKey: z.literal("clutchpacks"), evEstimates: z.object({ packScout: z.unknown() }).passthrough() }).passthrough();
export interface ClutchpacksProductionPublicVerification {
  readonly verifiedAt: string;
  readonly publicReadbackSha256: string;
  readonly repackCount: number;
  /** Complete public list after the caller checks list/detail/search/dashboard and witness. */
  readonly rows: readonly unknown[];
}
export interface ClutchpacksProductionV3PublicationInput {
  readonly intent: unknown;
  readonly approvedConfiguration: ApprovedPublicCatalogConfigurationV1;
  readonly plan: DataReleaseV3PublishPlan;
  readonly client: PublicationClient;
  readonly leasePort: ClutchpacksProductionLeasePort;
  readonly prepareLeaseAttempt: (attempt: ClutchpacksProductionLeaseAttempt) => Promise<void>;
  readonly readSource: (ownedLease?: ClutchpacksProductionOwnedImportLease) => Promise<{ scope: unknown; source: unknown }>;
  readonly assertSourceQuiet: (ownedLease?: ClutchpacksProductionOwnedImportLease) => Promise<void>;
  /** Durably save the exact fresh request before returning; an uncertain attempt
   * remains available for reconciliation independently of the immutable EV plan. */
  readonly prepareObservation: () => Promise<{ request: DataReleaseV3RefreshProviderObservationRequest; requestSha256: string }>;
  readonly observationNow?: () => number;
  readonly verifyPublic: (input: { intent: ClutchpacksProductionPublicationIntent;
    plan: DataReleaseV3PublishPlan; client: PublicationClient; activeState: DataReleaseV3ActiveState;
  }) => Promise<ClutchpacksProductionPublicVerification>;
}
function fail(code: ClutchpacksProductionPublicationFailure): never {
  throw new ClutchpacksProductionPublicationError(code);
}
function nonpositiveEv(estimate: PackScoutDisplayedEvV3): boolean {
  return estimate.status === "unavailable" || (estimate.metrics.grossReturnBasisPoints <= 10_000 &&
    estimate.metrics.evDollars.minorUnits <= 0 && estimate.metrics.evPercentBasisPoints <= 0);
}
function plannedRows(plan: DataReleaseV3PublishPlan) {
  const rows = plan.batches.filter(batch => batch.kind === "repacks").flatMap(batch => batch.records);
  if (plan.classification !== "publish" || rows.length !== plan.manifest.counts.repacks || rows.length === 0 ||
    rows.length > 1_000) return fail("PRODUCTION_PUBLIC_EV_INVALID");
  const parsed = z.array(publicationRow).safeParse(rows);
  if (!parsed.success || new Set(parsed.data.map(row => row.publicRepackId)).size !== rows.length ||
    parsed.data.some(row => { const estimate = packScoutPublicEvV3Schema.safeParse(row.evEstimates.packScout);
      return !estimate.success || !nonpositiveEv(estimate.data); })) {
    return fail("PRODUCTION_PUBLIC_EV_INVALID");
  }
  return parsed.data;
}
function validateObservation(input: ClutchpacksProductionV3PublicationInput, intent: ClutchpacksProductionPublicationIntent,
  attempt: Awaited<ReturnType<ClutchpacksProductionV3PublicationInput["prepareObservation"]>>) {
  const observation = attempt.request;
  const operationId = clutchpacksProductionObservationOperationId(intent, observation.observedAt);
  const timestamps = [observation.observedAt, observation.freshThrough];
  const observedAt = Date.parse(observation.observedAt); const freshThrough = Date.parse(observation.freshThrough);
  const now = (input.observationNow ?? Date.now)();
  const fields = ["schemaVersion", "operationId", "idempotencyKey", "publicReleaseId", "releaseFingerprint", "publicVendorId", "vendorKey",
    "observationSequence", "observedAt", "freshThrough", "lastHeadReachedAt", "sourceHeadSequence", "settledSequence",
    "sourceLifecycle", "connectionState", "qualityState", "releaseAlignment"];
  if (canonicalJson(Object.keys(observation).sort()) !== canonicalJson(fields.sort()) ||
    attempt.requestSha256 !== productionPublicationSha256(observation) ||
    observation.schemaVersion !== "data_release_v3" || observation.operationId !== operationId ||
    observation.idempotencyKey !== operationId || observation.publicReleaseId !== intent.candidate.publicReleaseId ||
    observation.releaseFingerprint !== intent.candidate.releaseFingerprint || observation.vendorKey !== "clutchpacks" ||
    observation.publicVendorId !== input.approvedConfiguration.platforms[0]?.vendor.publicVendorId ||
    observation.qualityState !== intent.source.qualityState || observation.lastHeadReachedAt !== intent.source.lastHeadReachedAt ||
    observation.settledSequence !== intent.source.promotionSequence || observation.sourceHeadSequence !== intent.source.promotionSequence ||
    observation.observationSequence !== observedAt || !Number.isSafeInteger(observedAt) || observedAt < 1 ||
    observation.sourceLifecycle !== "active" || observation.connectionState !== "healthy" ||
    observation.releaseAlignment !== "aligned" ||
    timestamps.some(value => !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) ||
    observation.observedAt < intent.source.lastHeadReachedAt || observedAt > now || now - observedAt > 300_000 ||
    freshThrough <= now || freshThrough > Math.min(observedAt + 86_400_000,
      Date.parse(intent.source.lastHeadReachedAt) + input.approvedConfiguration.staleAfterSeconds * 1_000)) {
    return fail("PRODUCTION_OBSERVATION_INVALID");
  }
  // Keep only the validated, persisted bytes; never allow a mutable callback
  // object to change after activation but before the signed refresh request.
  return JSON.parse(canonicalJson(observation)) as DataReleaseV3RefreshProviderObservationRequest;
}
export function clutchpacksProductionObservationOperationId(intent: unknown, observedAt: string): string {
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) fail("PRODUCTION_OBSERVATION_INVALID");
  return `clutchpacks-observation:${productionPublicationSha256(parseClutchpacksProductionPublicationIntent(intent))}:${Date.parse(observedAt)}`;
}
async function witnessReady(client: PublicationClient, state: DataReleaseV3ActiveState) {
  const expected = { expectedGeneration: state.generation,
    expectedActivePublicReleaseId: state.activeRelease?.publicReleaseId ?? null,
    expectedActiveReleaseFingerprint: state.activeRelease?.releaseFingerprint ?? null };
  const result = dataReleaseV3RetainedEvWitnessReadinessSchema.safeParse(await client.retainedEvWitnessReadiness(expected));
  if (!result.success || result.data.generation !== expected.expectedGeneration ||
    result.data.activePublicReleaseId !== expected.expectedActivePublicReleaseId ||
    result.data.activeReleaseFingerprint !== expected.expectedActiveReleaseFingerprint) fail("PRODUCTION_BACKEND_NOT_READY");
}
function assertPublicRows(plan: DataReleaseV3PublishPlan, evidence: ClutchpacksProductionPublicVerification) {
  const expected = plannedRows(plan);
  const parsed = z.array(publicationRow).safeParse(evidence.rows);
  const identity = (row: z.infer<typeof publicationRow>) => `${row.vendorKey}/${row.publicVendorId}/${row.publicRepackId}`;
  if (!parsed.success || evidence.repackCount !== expected.length || parsed.data.length !== expected.length ||
    canonicalJson(parsed.data.map(identity).sort()) !== canonicalJson(expected.map(identity).sort()) ||
    parsed.data.some(row => { const estimate = packScoutDisplayedEvV3Schema.safeParse(row.evEstimates.packScout);
      return !estimate.success || !nonpositiveEv(estimate.data); })) {
    fail("PRODUCTION_PUBLIC_EV_INVALID");
  }
}

/** No import scheduling, source controls, key installation or environment writes.
 * The caller owns authenticated transport and full public/witness verification. */
export async function publishClutchpacksProductionV3(input: ClutchpacksProductionV3PublicationInput) {
  const intent = parseClutchpacksProductionPublicationIntent(input.intent);
  plannedRows(input.plan);
  // Validate all reviewed bindings before acquiring execution authority.
  assertClutchpacksProductionBindings(intent, { ...await input.readSource(),
    approvedConfiguration: input.approvedConfiguration, plan: input.plan, activeState: await input.client.activeState() });
  return withClutchpacksProductionPublicationLease({ intent, port: input.leasePort, prepareLeaseAttempt: input.prepareLeaseAttempt,
    assertSourceQuiet: input.assertSourceQuiet, operation: async (lease, assertLive, assertNotLost) => {
      const guard = async (fullSourceBinding = false) => {
        await assertLive();
        const activeState = await input.client.activeState();
        // The renewed import fence excludes canonical writes. assertSourceQuiet
        // checks the cheap owner/runtime pins every time; full card snapshots
        // are loaded only at staging, activation and final verification boundaries.
        const disposition = fullSourceBinding
          ? assertClutchpacksProductionBindings(intent, { ...await input.readSource(lease),
            approvedConfiguration: input.approvedConfiguration, plan: input.plan, activeState })
          : assertClutchpacksProductionPredecessor(intent, activeState);
        assertNotLost();
        return { activeState, disposition };
      };
      const write = <T,>(operation: () => Promise<T>): Promise<T> => {
        // No await may separate this latch check from the transport call.
        assertNotLost(); return operation();
      };
      const initial = await guard();
      await witnessReady(input.client, initial.activeState);
      let preparedObservation: DataReleaseV3RefreshProviderObservationRequest | undefined;
      const guarded: DataReleaseV3PublicationPort = {
        activeState: () => input.client.activeState(), status: id => input.client.status(id),
        start: async request => { await guard(true); return write(() => input.client.start(request)); },
        applyBatch: async request => { await guard(); return write(() => input.client.applyBatch(request)); },
        finalize: async request => { await guard(); return write(() => input.client.finalize(request)); },
        activate: async request => {
          await guard(true);
          const attempt = await input.prepareObservation();
          const { activeState, disposition } = await guard();
          preparedObservation = validateObservation(input, intent, attempt);
          if (disposition !== "publish" || activeState.generation !== intent.predecessor.generation ||
            request.expectedActivePublicReleaseId !== intent.predecessor.publicReleaseId ||
            request.publicReleaseId !== intent.candidate.publicReleaseId ||
            request.releaseFingerprint !== intent.candidate.releaseFingerprint || request.allowDataAsOfRegression !== undefined) {
            return fail("PRODUCTION_PREDECESSOR_CHANGED");
          }
          // Server enforces atomic ID CAS; generation/fingerprint are also
          // checked immediately above. This does not extend the wire protocol.
          return write(() => input.client.activate(request));
        },
        rollback: async request => {
          const { activeState, disposition } = await guard();
          if (disposition !== "already_active" || activeState.generation !== intent.predecessor.generation + 1 ||
            request.expectedActivePublicReleaseId !== intent.candidate.publicReleaseId ||
            request.targetPublicReleaseId !== intent.predecessor.publicReleaseId) {
            return fail("PRODUCTION_VERIFICATION_RECOVERY_REQUIRED");
          }
          return write(() => input.client.rollback(request));
        },
      };
      const publisher = new DataReleaseV3ReleasePublisher(guarded);
      const published = await publisher.publish(input.plan);
      try {
        if (preparedObservation === undefined) {
          const attempt = await input.prepareObservation();
          await guard();
          preparedObservation = validateObservation(input, intent, attempt);
        }
        const { activeState } = await guard();
        if (assertClutchpacksProductionPredecessor(intent, activeState) !== "already_active") {
          fail("PRODUCTION_READBACK_MISMATCH");
        }
        const observationRequest = preparedObservation;
        const observation = await write(() => input.client.refreshProviderObservation(observationRequest));
        if (observation.publicReleaseId !== intent.candidate.publicReleaseId ||
          observation.operationId !== preparedObservation.operationId || observation.operationKind !== "refreshProviderObservation" ||
          !/^[a-f0-9]{64}$/u.test(observation.receiptDigest)) fail("PRODUCTION_OBSERVATION_INVALID");
        const verification = await input.verifyPublic({ intent, plan: input.plan, client: input.client, activeState });
        assertPublicRows(input.plan, verification);
        const final = await guard(true);
        assertNotLost();
        return { ...buildClutchpacksProductionPublicationReceipt(intent, { ...verification, activeState: final.activeState }),
          publicationOutcome: published.outcome, observationReceiptDigest: observation.receiptDigest,
          activateReceiptDigest: published.outcome === "activated" ? published.receipts.activate.receiptDigest : null };
      } catch {
        // Never overwrite a moved/unknown pointer. A release with no retained
        // predecessor, or one already active before this intent, needs review.
        try {
          const current = await guard();
          if (current.disposition !== "already_active" || current.activeState.generation !== intent.predecessor.generation + 1 ||
            intent.predecessor.publicReleaseId === null) return fail("PRODUCTION_VERIFICATION_RECOVERY_REQUIRED");
          await publisher.rollback({ expectedActivePublicReleaseId: intent.candidate.publicReleaseId,
            targetPublicReleaseId: intent.predecessor.publicReleaseId });
          const restored = await input.client.activeState();
          if (restored.generation !== intent.predecessor.generation + 2 ||
            restored.activeRelease?.publicReleaseId !== intent.predecessor.publicReleaseId ||
            restored.activeRelease?.releaseFingerprint !== intent.predecessor.releaseFingerprint) {
            return fail("PRODUCTION_VERIFICATION_RECOVERY_REQUIRED");
          }
        } catch { return fail("PRODUCTION_VERIFICATION_RECOVERY_REQUIRED"); }
        return fail("PRODUCTION_VERIFICATION_FAILED_ROLLED_BACK");
      }
    },
  });
}
