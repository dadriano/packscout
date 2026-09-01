import assert from "node:assert/strict";
import test from "node:test";
import type {
  ActiveCatalogManifestStateV1,
  CatalogManifestStatusRequest,
  GlobalCatalogManifestV1,
  GlobalCatalogProviderActiveObservationV1,
  ProviderCatalogReleasePublishPlanV1,
  ProviderReleaseCompletedHeadV1,
} from "@packscout/contracts";
import {
  activeCatalogManifestStateV1Schema,
  buildGlobalCatalogAggregateObservationV1,
  providerReleaseCompletedHeadV1Schema,
} from "@packscout/contracts";
import type {
  ExactManifestActivationIntentInput,
  ManifestActivationIntent,
  ManifestActivationLease,
  ManifestActivationMirror,
  ManifestGateClaim,
  SignedManifestActiveStateEvidence,
} from "@packscout/database";
import {
  IndependentProviderManifestCoordinator,
  RotationAwareManifestCoordinatorTransport,
  type IndependentManifestCoordinatorTransport,
  type VerifiedManifestGateProofSource,
} from "./independent-provider-manifest-coordinator.ts";
import type { SignedConvexCatalogManifestPublicationClient } from
  "./convex-catalog-manifest-publication-client.ts";
import { composeGlobalCatalogManifest } from
  "./catalog-manifest-composer.ts";
import type { ProviderManifestCompletedTargetProof } from
  "./independent-provider-manifest-gate.ts";
import { buildProviderCatalogReleasePublishPlan } from
  "./provider-catalog-release-artifacts.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureCheckpoint,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";
import {
  projectProviderCatalogRelease,
  type ProviderCatalogPublicProjection,
} from "./provider-catalog-release-public-projection.ts";

const base = new Date("2026-09-01T20:00:00.000Z");
const digest = "a".repeat(64);
const providerId = "00000000-0000-4000-8000-000000000011";
const betaProviderId = "00000000-0000-4000-8000-000000000012";
const catalogIds = {
  alphaOne: "00000000-0000-4000-8000-000000000021",
  alphaTwo: "00000000-0000-4000-8000-000000000022",
  betaOne: "00000000-0000-4000-8000-000000000023",
} as const;
const releaseIds = {
  alphaOne: "00000000-0000-4000-8000-000000000031",
  alphaTwo: "00000000-0000-4000-8000-000000000032",
  betaOne: "00000000-0000-4000-8000-000000000033",
} as const;

function emptyState(): ActiveCatalogManifestStateV1 {
  return {
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  };
}

function emptyMirror(): ManifestActivationMirror {
  return {
    generation: 0n,
    activeManifest: null,
    activeState: null,
    previousManifest: null,
    lastReceiptId: null,
    rowVersion: 1n,
    updatedAt: base,
  };
}

function claim(): ManifestGateClaim {
  return {
    providerId,
    organizationId: "00000000-0000-4000-8000-000000000001",
    providerKey: "alpha",
    providerLifecycle: "active",
    providerRowVersion: 1n,
    requestedGeneration: 1n,
    acknowledgedGeneration: 0n,
    latestCause: "provider_completion",
    latestEvidenceDigest: digest,
    latestRequestedAt: base,
    operationGeneration: null,
    requestedOperation: null,
    targetProviderReleaseId: null,
    targetCatalogVersionId: null,
    requestedByOperatorId: null,
    authorizationDigest: null,
    attemptCount: 1,
    lastAttemptedAt: base,
    retryAt: null,
    lastFailureCode: null,
    pending: true,
    observedGeneration: 1n,
    claimToken: "00000000-0000-4000-8000-000000000111",
    claimExpiresAt: new Date(base.getTime() + 60_000),
  };
}

async function providerPlan(
  platformKey: "alpha" | "beta",
  input: Readonly<{
    catalogVersionId: string;
    revision: number;
    sequence: bigint;
    configurationHash: string;
    transform?: (
      projection: ProviderCatalogPublicProjection,
    ) => ProviderCatalogPublicProjection;
  }>,
): Promise<ProviderCatalogReleasePublishPlanV1> {
  const configurationKey = `catalog-version:${input.catalogVersionId}`;
  const checkpoint = providerFixtureCheckpoint({
    platformKey,
    configurationKey,
    revision: input.revision,
    configurationHash: input.configurationHash,
    configurationSequence: input.sequence,
  });
  const configuration = providerFixtureApprovedConfiguration({
    platformKey,
    configurationKey,
    revision: input.revision,
  });
  const snapshot = providerFixtureSnapshot({ checkpoint, configuration });
  const projection = projectProviderCatalogRelease({
    configuration,
    platformKey,
    revisions: snapshot.revisions,
    assetPackAssociations: snapshot.assetPackAssociations,
    repackIdentities: snapshot.repackIdentities,
  });
  return buildProviderCatalogReleasePublishPlan({
    checkpoint: snapshot.checkpoint,
    configuration: snapshot.configuration,
    projection: input.transform?.(projection) ?? projection,
    lastSuccessfulObservationAt:
      snapshot.observation.lastSuccessfulObservationAt,
  });
}

async function manifest(
  plans: readonly ProviderCatalogReleasePublishPlanV1[],
): Promise<GlobalCatalogManifestV1> {
  const sorted = [...plans].sort((left, right) =>
    left.platformKey < right.platformKey ? -1 : 1);
  return composeGlobalCatalogManifest({
    enabledPlatformKeys: sorted.map(({ platformKey }) => platformKey),
    providerPlans: sorted,
    approvedConfiguration: {
      sharedConfigurationEpoch: sorted[0]!.sharedConfigurationEpoch,
      confidencePolicyVersion: "confidence-v1",
    },
  });
}

function completedHead(
  plan: ProviderCatalogReleasePublishPlanV1,
  terminalReceiptSha256: string,
): ProviderReleaseCompletedHeadV1 {
  return providerReleaseCompletedHeadV1Schema.parse({
    platformKey: plan.platformKey,
    release: {
      platformKey: plan.platformKey,
      sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
      dataAsOf: plan.dataAsOf,
      publicProviderReleaseId: plan.publicProviderReleaseId,
      providerReleaseFingerprint: plan.providerReleaseFingerprint,
      contentHash: plan.contentHash,
      publicAssetOrigins: plan.publicAssetOrigins,
      governingHashes: plan.governingHashes,
      entityHashes: plan.entityHashes,
      counts: plan.counts,
      searchAlgorithmVersion: plan.searchAlgorithmVersion,
      providerSearchIndexHash: plan.providerSearchIndexHash,
      batchCount: plan.batchCount,
      batchChainHash: plan.batchChainHash,
    },
    providerCheckpoint: plan.providerCheckpoint,
    observation: plan.observation,
    terminalReceiptSha256,
  });
}

function targetProof(input: Readonly<{
  plan: ProviderCatalogReleasePublishPlanV1;
  providerId: string;
  localReleaseId: string;
  catalogVersionId: string;
  terminalReceiptSha256: string;
}>): ProviderManifestCompletedTargetProof {
  const head = completedHead(input.plan, input.terminalReceiptSha256);
  return {
    providerId: input.providerId,
    providerKey: input.plan.platformKey,
    targetProviderReleaseId: input.localReleaseId,
    targetCatalogVersionId: input.catalogVersionId,
    completedHead: head,
    activeObservation: {
      platformKey: head.platformKey,
      publicProviderReleaseId: head.release.publicProviderReleaseId,
      terminalOperationKind: "finalize",
      terminalOperationId: `provider:${head.platformKey}:finalize`,
      terminalReceiptSha256: head.terminalReceiptSha256,
      selectedProviderCheckpoint: head.providerCheckpoint,
      selectedDataAsOf: head.release.dataAsOf,
      latestAffectedSettledSequence: head.providerCheckpoint.settledSequence,
      latestAffectedSourceHeadSequence: head.observation.sourceHeadSequence,
      initialBackfillComplete: true,
      affectedDerivationsSettled: true,
      settledSourceFreshness: head.observation.freshness,
      lastSuccessfulObservationAt:
        head.observation.lastSuccessfulObservationAt,
      staleAt: head.observation.staleAt,
    },
  };
}

function populatedState(input: Readonly<{
  manifest: GlobalCatalogManifestV1;
  observations: readonly GlobalCatalogProviderActiveObservationV1[];
  generation: number;
}>): ActiveCatalogManifestStateV1 {
  return activeCatalogManifestStateV1Schema.parse({
    generation: input.generation,
    activeManifest: {
      publicReleaseId: input.manifest.publicReleaseId,
      manifestFingerprint: input.manifest.manifestFingerprint,
      sharedConfigurationEpoch: input.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: input.manifest.providerReferenceSetHash,
      createdAt: "2026-09-01T19:55:00.000Z",
      completedAt: "2026-09-01T19:56:00.000Z",
    },
    previousManifest: null,
    observation: buildGlobalCatalogAggregateObservationV1({
      observationSequence: input.generation,
      publicReleaseId: input.manifest.publicReleaseId,
      providerReferenceSetHash: input.manifest.providerReferenceSetHash,
      providerSelections: input.observations,
    }),
    terminalReceiptSha256: "f".repeat(64),
  });
}

function failedIntent(
  input: ExactManifestActivationIntentInput,
  failureCode: string,
): ManifestActivationIntent {
  const request = JSON.parse(input.canonicalRequestBody) as {
    operationId: string;
    idempotencyKey: string;
    expectedActiveState: {
      activeManifest: { publicReleaseId: string } | null;
    };
  };
  return {
    id: request.operationId,
    providerId: input.providerId,
    operation: input.operation,
    expectedManifestId:
      request.expectedActiveState.activeManifest?.publicReleaseId ?? null,
    targetProviderReleaseId: input.targetProviderReleaseId,
    targetCatalogVersionId: input.targetCatalogVersionId,
    targetManifest: input.targetManifest,
    idempotencyKey: request.idempotencyKey,
    requestDigest: input.requestDigest,
    canonicalRequestBody: input.canonicalRequestBody,
    leaseFence: 1n,
    state: "failed",
    attemptCount: 1,
    lastAttemptedAt: base,
    completionLeaseFence: 1n,
    canonicalReceiptBody: null,
    receiptSha256: null,
    exactResponseBody: null,
    exactResponseSha256: null,
    failureCode,
    requestedAt: input.requestedAt,
    completedAt: base,
  };
}

test("signed bootstrap adopts the already-active empty state without issuing a mutation", async () => {
  const lease: ManifestActivationLease = {
    owner: "test",
    fence: 1n,
    expiresAt: new Date(base.getTime() + 60_000),
  };
  let mirror = emptyMirror();
  const adopted: SignedManifestActiveStateEvidence[] = [];
  let mutations = 0;
  let released = 0;
  const activeState = emptyState();
  const transport: IndependentManifestCoordinatorTransport = {
    async activeState() {
      return {
        receipt: { details: { activeState } },
        canonicalReceiptBody: "{\"signed\":\"active-state\"}",
        receiptSha256: digest,
        exactResponseBody: "{\"receipt\":{\"signed\":\"active-state\"}}",
        exactResponseSha256: "b".repeat(64),
      };
    },
    async sendExact() {
      mutations += 1;
      throw new Error("bootstrap must not mutate");
    },
    async status() {
      throw new Error("bootstrap must not query operation status");
    },
  };
  const proofs: VerifiedManifestGateProofSource = {
    async resolveSignedState() {
      return {
        state: "ready",
        activeManifest: null,
        previousManifest: null,
      };
    },
    async resolveTarget() {
      return { state: "no_change", failureCode: null };
    },
  };
  const activations = {
    async loadMirror() {
      return mirror;
    },
    async claimLease() {
      return lease;
    },
    async releaseLease() {
      released += 1;
      return true;
    },
    async reconcileSignedActiveState(input: {
      evidence: SignedManifestActiveStateEvidence;
    }) {
      adopted.push(input.evidence);
      mirror = { ...mirror, activeState, rowVersion: 2n };
      return mirror;
    },
  };
  const coordinator = new IndependentProviderManifestCoordinator({
    workerId: "manifest:test",
    activations: activations as never,
    proofs,
    transport,
    now: () => base,
  });

  const result = await coordinator.reconcile({
    claim: claim(),
    attemptId: "00000000-0000-4000-8000-000000000211",
  });
  assert.equal(result.disposition, "no_change");
  assert.equal(result.activeGeneration, 0n);
  assert.equal(mutations, 0);
  assert.equal(released, 1);
  assert.equal(adopted[0]?.canonicalReceiptBody, "{\"signed\":\"active-state\"}");
  assert.equal(adopted[0]?.activeManifest, null);
  assert.equal(adopted[0]?.previousManifest, null);
});

test("status recovery queries retained historical role keys after a current-key miss", async () => {
  const request = {
    schemaVersion: "catalog_manifest_publication_v1",
    operationId: "manifest-gate:test",
    requestDigest: digest,
  } as unknown as CatalogManifestStatusRequest;
  const calls: string[] = [];
  const current = {
    async status() {
      calls.push("current");
      return {
        receipt: { result: "not_found" },
        canonicalReceiptBody: "current-not-found",
        receiptSha256: digest,
        exactResponseBody: "current-response",
        exactResponseSha256: digest,
      };
    },
  } as unknown as SignedConvexCatalogManifestPublicationClient;
  const historical = {
    async status() {
      calls.push("historical");
      return {
        receipt: { result: "accepted" },
        canonicalReceiptBody: "historic-terminal",
        receiptSha256: "b".repeat(64),
        exactResponseBody: "historic-response",
        exactResponseSha256: "c".repeat(64),
      };
    },
  } as unknown as Pick<
    SignedConvexCatalogManifestPublicationClient,
    "status"
  >;
  const transport = new RotationAwareManifestCoordinatorTransport(
    current,
    [historical],
  );
  const observed = await transport.status(request);
  assert.deepEqual(calls, ["current", "historical"]);
  assert.equal(observed.canonicalReceiptBody, "historic-terminal");
});

test("CAS-lost intents keep reconciling after an unavailable probe and admit a new identity after recovery", async () => {
  const [alphaOnePlan, alphaTwoPlan, betaOnePlan] = await Promise.all([
    providerPlan("alpha", {
      catalogVersionId: catalogIds.alphaOne,
      revision: 1,
      sequence: 10n,
      configurationHash: "1".repeat(64),
    }),
    providerPlan("alpha", {
      catalogVersionId: catalogIds.alphaTwo,
      revision: 2,
      sequence: 11n,
      configurationHash: "2".repeat(64),
    }),
    providerPlan("beta", {
      catalogVersionId: catalogIds.betaOne,
      revision: 1,
      sequence: 10n,
      configurationHash: "3".repeat(64),
    }),
  ]);
  const [manifestOne, manifestTwo] = await Promise.all([
    manifest([alphaOnePlan, betaOnePlan]),
    manifest([alphaTwoPlan, betaOnePlan]),
  ]);
  const alphaOne = targetProof({
    plan: alphaOnePlan,
    providerId,
    localReleaseId: releaseIds.alphaOne,
    catalogVersionId: catalogIds.alphaOne,
    terminalReceiptSha256: "4".repeat(64),
  });
  const alphaTwo = targetProof({
    plan: alphaTwoPlan,
    providerId,
    localReleaseId: releaseIds.alphaTwo,
    catalogVersionId: catalogIds.alphaTwo,
    terminalReceiptSha256: "5".repeat(64),
  });
  const betaOne = targetProof({
    plan: betaOnePlan,
    providerId: betaProviderId,
    localReleaseId: releaseIds.betaOne,
    catalogVersionId: catalogIds.betaOne,
    terminalReceiptSha256: "6".repeat(64),
  });
  const stateOne = populatedState({
    manifest: manifestOne,
    observations: [alphaOne.activeObservation, betaOne.activeObservation],
    generation: 1,
  });
  const stateTwo = populatedState({
    manifest: manifestTwo,
    observations: [alphaTwo.activeObservation, betaOne.activeObservation],
    generation: 2,
  });
  const lease: ManifestActivationLease = {
    owner: "manifest:test",
    fence: 1n,
    expiresAt: new Date(base.getTime() + 60_000),
  };
  let mirror: ManifestActivationMirror = {
    generation: 1n,
    activeManifest: manifestOne,
    activeState: stateOne,
    previousManifest: null,
    lastReceiptId: null,
    rowVersion: 1n,
    updatedAt: base,
  };
  let reconciliationCalls = 0;
  const operationIds: string[] = [];
  const activations = {
    async loadMirror() {
      return mirror;
    },
    async claimLease() {
      return lease;
    },
    async releaseLease() {
      return true;
    },
    async persistIntent(
      _lease: ManifestActivationLease,
      input: ExactManifestActivationIntentInput,
    ) {
      const operationId = (JSON.parse(input.canonicalRequestBody) as {
        operationId: string;
      }).operationId;
      operationIds.push(operationId);
      return failedIntent(
        input,
        operationIds.length <= 2
          ? "MANIFEST_ACTIVATION_CAS_LOST"
          : "MANIFEST_ACTIVATION_TERMINAL_FIXTURE",
      );
    },
    async reconcileSignedActiveState(input: {
      evidence: SignedManifestActiveStateEvidence;
    }) {
      assert.equal(input.evidence.activeManifest?.publicReleaseId,
        manifestTwo.publicReleaseId);
      mirror = {
        ...mirror,
        generation: 2n,
        activeManifest: manifestTwo,
        activeState: stateTwo,
        rowVersion: 2n,
      };
      return mirror;
    },
  };
  const transport: IndependentManifestCoordinatorTransport = {
    async activeState() {
      reconciliationCalls += 1;
      if (reconciliationCalls === 1) {
        const error = new Error("signed state temporarily unavailable") as
          Error & { code: string };
        error.code = "MANIFEST_SIGNED_STATE_UNAVAILABLE";
        throw error;
      }
      return {
        receipt: { details: { activeState: stateTwo } },
        canonicalReceiptBody: "{\"signed\":\"state-two\"}",
        receiptSha256: "7".repeat(64),
        exactResponseBody: "{\"receipt\":{\"signed\":\"state-two\"}}",
        exactResponseSha256: "8".repeat(64),
      };
    },
    async sendExact() {
      throw new Error("failed intents must not be resent");
    },
    async status() {
      throw new Error("failed intents must not query status");
    },
  };
  const proofs: VerifiedManifestGateProofSource = {
    async resolveSignedState() {
      return {
        state: "ready",
        activeManifest: manifestTwo,
        previousManifest: manifestOne,
      };
    },
    async resolveTarget({ currentManifest }) {
      return currentManifest?.publicReleaseId === manifestOne.publicReleaseId
        ? {
            state: "ready",
            target: {
              operation: "advance",
              candidateManifest: manifestTwo,
              proof: alphaTwo,
            },
          }
        : {
            state: "ready",
            target: {
              operation: "advance",
              candidateManifest: manifestOne,
              proof: alphaOne,
            },
          };
    },
  };
  const coordinator = new IndependentProviderManifestCoordinator({
    workerId: "manifest:test",
    activations: activations as never,
    proofs,
    transport,
    now: () => base,
  });

  const first = await coordinator.reconcile({
    claim: claim(),
    attemptId: "00000000-0000-4000-8000-000000000211",
  });
  const second = await coordinator.reconcile({
    claim: claim(),
    attemptId: "00000000-0000-4000-8000-000000000212",
  });
  const third = await coordinator.reconcile({
    claim: claim(),
    attemptId: "00000000-0000-4000-8000-000000000213",
  });

  assert.equal(first.disposition, "cas_lost");
  assert.equal(first.failureCode, "MANIFEST_SIGNED_STATE_UNAVAILABLE");
  assert.equal(second.disposition, "cas_lost");
  assert.equal(second.failureCode, "MANIFEST_ACTIVATION_CAS_LOST");
  assert.equal(third.disposition, "blocked");
  assert.equal(reconciliationCalls, 2);
  assert.equal(operationIds[0], operationIds[1],
    "the failed deterministic CAS intent is retried until reconciliation works");
  assert.notEqual(operationIds[1], operationIds[2],
    "the refreshed signed generation permits a new deterministic intent");
});
