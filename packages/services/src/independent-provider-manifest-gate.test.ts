import assert from "node:assert/strict";
import test from "node:test";
import {
  activeCatalogManifestStateV1Schema,
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  providerReleaseCompletedHeadV1Schema,
  type ActiveCatalogManifestStateV1,
  type GlobalCatalogManifestV1,
  type GlobalCatalogProviderActiveObservationV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseCompletedHeadV1,
} from "@packscout/contracts";
import { composeGlobalCatalogManifest } from "./catalog-manifest-composer.ts";
import {
  IndependentProviderManifestGateError,
  composeIndependentProviderManifestGate,
  sendIndependentProviderManifestGate,
  type ProviderManifestCompletedTargetProof,
} from "./independent-provider-manifest-gate.ts";
import { buildProviderCatalogReleasePublishPlan } from
  "./provider-catalog-release-artifacts.ts";
import {
  projectProviderCatalogRelease,
  type ProviderCatalogPublicProjection,
} from "./provider-catalog-release-public-projection.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureCheckpoint,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";

const providerIds = {
  alpha: "74000000-0000-4000-8000-000000000001",
  beta: "74000000-0000-4000-8000-000000000002",
} as const;
const catalogIds = {
  alphaOne: "74000000-0000-4000-8000-000000000011",
  alphaTwo: "74000000-0000-4000-8000-000000000012",
  betaOne: "74000000-0000-4000-8000-000000000021",
  betaTwo: "74000000-0000-4000-8000-000000000022",
} as const;
const localReleaseIds = {
  alphaOne: "74000000-0000-4000-8000-000000000031",
  alphaTwo: "74000000-0000-4000-8000-000000000032",
  betaOne: "74000000-0000-4000-8000-000000000041",
  betaTwo: "74000000-0000-4000-8000-000000000042",
} as const;
const hash = {
  alphaOne: "a".repeat(64),
  alphaTwo: "b".repeat(64),
  betaOne: "c".repeat(64),
  betaTwo: "d".repeat(64),
  receiptAlphaOne: "1".repeat(64),
  receiptAlphaTwo: "2".repeat(64),
  receiptBetaOne: "3".repeat(64),
  receiptBetaTwo: "4".repeat(64),
  manifest: "5".repeat(64),
} as const;

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

async function fixturePlans() {
  const [alphaOne, alphaTwo, betaOne, betaTwo] = await Promise.all([
    providerPlan("alpha", {
      catalogVersionId: catalogIds.alphaOne,
      revision: 1,
      sequence: 10n,
      configurationHash: hash.alphaOne,
    }),
    providerPlan("alpha", {
      catalogVersionId: catalogIds.alphaTwo,
      revision: 2,
      sequence: 11n,
      configurationHash: hash.alphaTwo,
    }),
    providerPlan("beta", {
      catalogVersionId: catalogIds.betaOne,
      revision: 1,
      sequence: 10n,
      configurationHash: hash.betaOne,
    }),
    providerPlan("beta", {
      catalogVersionId: catalogIds.betaTwo,
      revision: 2,
      sequence: 11n,
      configurationHash: hash.betaTwo,
    }),
  ]);
  return { alphaOne, alphaTwo, betaOne, betaTwo };
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

function activeObservation(
  head: ProviderReleaseCompletedHeadV1,
  operationId: string,
): GlobalCatalogProviderActiveObservationV1 {
  return {
    platformKey: head.platformKey,
    publicProviderReleaseId: head.release.publicProviderReleaseId,
    terminalOperationKind: "finalize",
    terminalOperationId: operationId,
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
  };
}

function targetProof(input: Readonly<{
  plan: ProviderCatalogReleasePublishPlanV1;
  providerId: string;
  localReleaseId: string;
  catalogVersionId: string;
  terminalReceiptSha256: string;
  terminalOperationId: string;
}>): ProviderManifestCompletedTargetProof {
  const head = completedHead(input.plan, input.terminalReceiptSha256);
  return {
    providerId: input.providerId,
    providerKey: input.plan.platformKey,
    targetProviderReleaseId: input.localReleaseId,
    targetCatalogVersionId: input.catalogVersionId,
    completedHead: head,
    activeObservation: activeObservation(head, input.terminalOperationId),
  };
}

function activeState(input: Readonly<{
  manifest: GlobalCatalogManifestV1;
  observations: readonly GlobalCatalogProviderActiveObservationV1[];
  generation?: number;
  observationSequence?: number;
}>): ActiveCatalogManifestStateV1 {
  const generation = input.generation ?? 1;
  const observation = buildGlobalCatalogAggregateObservationV1({
    observationSequence: input.observationSequence ?? generation,
    publicReleaseId: input.manifest.publicReleaseId,
    providerReferenceSetHash: input.manifest.providerReferenceSetHash,
    providerSelections: [...input.observations].sort((left, right) =>
      left.platformKey < right.platformKey ? -1 : 1),
  });
  return activeCatalogManifestStateV1Schema.parse({
    generation,
    activeManifest: {
      publicReleaseId: input.manifest.publicReleaseId,
      manifestFingerprint: input.manifest.manifestFingerprint,
      sharedConfigurationEpoch: input.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: input.manifest.providerReferenceSetHash,
      createdAt: "2026-09-01T12:00:00.000Z",
      completedAt: "2026-09-01T12:00:01.000Z",
    },
    previousManifest: null,
    observation,
    terminalReceiptSha256: hash.manifest,
  });
}

function expectedError(code: IndependentProviderManifestGateError["code"]) {
  return (error: unknown) =>
    error instanceof IndependentProviderManifestGateError &&
    error.code === code;
}

test("advances only alpha while preserving beta bytes across independent catalog epochs", async () => {
  const plans = await fixturePlans();
  const [current, candidate] = await Promise.all([
    manifest([plans.alphaOne, plans.betaOne]),
    manifest([plans.alphaTwo, plans.betaOne]),
  ]);
  const alphaOne = targetProof({
    plan: plans.alphaOne,
    providerId: providerIds.alpha,
    localReleaseId: localReleaseIds.alphaOne,
    catalogVersionId: catalogIds.alphaOne,
    terminalReceiptSha256: hash.receiptAlphaOne,
    terminalOperationId: "provider:alpha:finalize:one",
  });
  const betaOne = targetProof({
    plan: plans.betaOne,
    providerId: providerIds.beta,
    localReleaseId: localReleaseIds.betaOne,
    catalogVersionId: catalogIds.betaOne,
    terminalReceiptSha256: hash.receiptBetaOne,
    terminalOperationId: "provider:beta:finalize:one",
  });
  const currentState = activeState({
    manifest: current,
    observations: [alphaOne.activeObservation, betaOne.activeObservation],
  });
  const alphaTwo = targetProof({
    plan: plans.alphaTwo,
    providerId: providerIds.alpha,
    localReleaseId: localReleaseIds.alphaTwo,
    catalogVersionId: catalogIds.alphaTwo,
    terminalReceiptSha256: hash.receiptAlphaTwo,
    terminalOperationId: "provider:alpha:finalize:two",
  });

  const command = await composeIndependentProviderManifestGate({
    operationId: "manifest:alpha:advance:two",
    idempotencyKey: "manifest:alpha:advance:two",
    currentManifest: current,
    currentActiveState: currentState,
    target: {
      operation: "advance",
      candidateManifest: candidate,
      proof: alphaTwo,
    },
  });

  assert.equal(command.convexMutationKind, "activateManifest");
  assert.equal(command.unchangedProviderCount, 1);
  assert.notEqual(
    candidate.providerReferences[0]!.sharedConfigurationEpoch.configurationKey,
    candidate.providerReferences[1]!.sharedConfigurationEpoch.configurationKey,
  );
  assert.equal(
    canonicalJson(current.providerReferences[1]),
    canonicalJson(candidate.providerReferences[1]),
  );
  assert.equal(
    canonicalJson(currentState.observation!.providerSelections[1]),
    canonicalJson(command.observation.providerSelections[1]),
  );
  const request = catalogManifestActivateRequestSchema.parse(
    JSON.parse(command.canonicalRequestBody),
  );
  assert.equal(request.manifest.publicReleaseId, candidate.publicReleaseId);
  assert.equal(request.expectedActiveState.generation, 1);

  const sent = await sendIndependentProviderManifestGate({
    sendExact(operation) {
      assert.deepEqual(operation, {
        kind: "activateManifest",
        canonicalRequestBody: command.canonicalRequestBody,
      });
      return Promise.resolve({
        receipt: {} as never,
        canonicalReceiptBody: "{}",
        receiptSha256: "0".repeat(64),
        exactResponseBody: "{}",
        exactResponseSha256: "0".repeat(64),
      });
    },
  }, command);
  assert.equal(sent.canonicalReceiptBody, "{}");
});

test("rejects a candidate that changes two providers in one gate", async () => {
  const plans = await fixturePlans();
  const [current, candidate] = await Promise.all([
    manifest([plans.alphaOne, plans.betaOne]),
    manifest([plans.alphaTwo, plans.betaTwo]),
  ]);
  const alphaOne = targetProof({
    plan: plans.alphaOne,
    providerId: providerIds.alpha,
    localReleaseId: localReleaseIds.alphaOne,
    catalogVersionId: catalogIds.alphaOne,
    terminalReceiptSha256: hash.receiptAlphaOne,
    terminalOperationId: "provider:alpha:finalize:one",
  });
  const betaOne = targetProof({
    plan: plans.betaOne,
    providerId: providerIds.beta,
    localReleaseId: localReleaseIds.betaOne,
    catalogVersionId: catalogIds.betaOne,
    terminalReceiptSha256: hash.receiptBetaOne,
    terminalOperationId: "provider:beta:finalize:one",
  });
  await assert.rejects(
    composeIndependentProviderManifestGate({
      operationId: "manifest:alpha:advance:invalid",
      idempotencyKey: "manifest:alpha:advance:invalid",
      currentManifest: current,
      currentActiveState: activeState({
        manifest: current,
        observations: [alphaOne.activeObservation, betaOne.activeObservation],
      }),
      target: {
        operation: "advance",
        candidateManifest: candidate,
        proof: targetProof({
          plan: plans.alphaTwo,
          providerId: providerIds.alpha,
          localReleaseId: localReleaseIds.alphaTwo,
          catalogVersionId: catalogIds.alphaTwo,
          terminalReceiptSha256: hash.receiptAlphaTwo,
          terminalOperationId: "provider:alpha:finalize:two",
        }),
      },
    }),
    expectedError("PROVIDER_MANIFEST_GATE_MULTI_PROVIDER_CHANGE"),
  );
});

test("rejects cross-provider and catalog-mismatched completion proofs", async () => {
  const plans = await fixturePlans();
  const [current, candidate] = await Promise.all([
    manifest([plans.alphaOne, plans.betaOne]),
    manifest([plans.alphaTwo, plans.betaOne]),
  ]);
  const alphaOne = targetProof({
    plan: plans.alphaOne,
    providerId: providerIds.alpha,
    localReleaseId: localReleaseIds.alphaOne,
    catalogVersionId: catalogIds.alphaOne,
    terminalReceiptSha256: hash.receiptAlphaOne,
    terminalOperationId: "provider:alpha:finalize:one",
  });
  const betaOne = targetProof({
    plan: plans.betaOne,
    providerId: providerIds.beta,
    localReleaseId: localReleaseIds.betaOne,
    catalogVersionId: catalogIds.betaOne,
    terminalReceiptSha256: hash.receiptBetaOne,
    terminalOperationId: "provider:beta:finalize:one",
  });
  const currentState = activeState({
    manifest: current,
    observations: [alphaOne.activeObservation, betaOne.activeObservation],
  });
  const proof = targetProof({
    plan: plans.alphaTwo,
    providerId: providerIds.alpha,
    localReleaseId: localReleaseIds.alphaTwo,
    catalogVersionId: catalogIds.alphaTwo,
    terminalReceiptSha256: hash.receiptAlphaTwo,
    terminalOperationId: "provider:alpha:finalize:two",
  });
  await assert.rejects(
    composeIndependentProviderManifestGate({
      operationId: "manifest:alpha:provider-mismatch",
      idempotencyKey: "manifest:alpha:provider-mismatch",
      currentManifest: current,
      currentActiveState: currentState,
      target: {
        operation: "advance",
        candidateManifest: candidate,
        proof: {
          ...proof,
          completedHead: completedHead(
            plans.betaTwo,
            hash.receiptBetaTwo,
          ),
        },
      },
    }),
    expectedError("PROVIDER_MANIFEST_GATE_PROVIDER_MISMATCH"),
  );
  await assert.rejects(
    composeIndependentProviderManifestGate({
      operationId: "manifest:alpha:catalog-mismatch",
      idempotencyKey: "manifest:alpha:catalog-mismatch",
      currentManifest: current,
      currentActiveState: currentState,
      target: {
        operation: "advance",
        candidateManifest: candidate,
        proof: { ...proof, targetCatalogVersionId: catalogIds.betaTwo },
      },
    }),
    expectedError("PROVIDER_MANIFEST_GATE_CATALOG_MISMATCH"),
  );
});

test("remove is explicit, keeps beta exact, and never emits clear", async () => {
  const plans = await fixturePlans();
  const [current, candidate] = await Promise.all([
    manifest([plans.alphaOne, plans.betaOne]),
    manifest([plans.betaOne]),
  ]);
  const alpha = targetProof({
    plan: plans.alphaOne,
    providerId: providerIds.alpha,
    localReleaseId: localReleaseIds.alphaOne,
    catalogVersionId: catalogIds.alphaOne,
    terminalReceiptSha256: hash.receiptAlphaOne,
    terminalOperationId: "provider:alpha:finalize:one",
  });
  const beta = targetProof({
    plan: plans.betaOne,
    providerId: providerIds.beta,
    localReleaseId: localReleaseIds.betaOne,
    catalogVersionId: catalogIds.betaOne,
    terminalReceiptSha256: hash.receiptBetaOne,
    terminalOperationId: "provider:beta:finalize:one",
  });
  const command = await composeIndependentProviderManifestGate({
    operationId: "manifest:alpha:remove",
    idempotencyKey: "manifest:alpha:remove",
    currentManifest: current,
    currentActiveState: activeState({
      manifest: current,
      observations: [alpha.activeObservation, beta.activeObservation],
    }),
    target: {
      operation: "remove",
      candidateManifest: candidate,
      proof: {
        providerId: providerIds.alpha,
        providerKey: "alpha",
        targetProviderReleaseId: null,
        targetCatalogVersionId: null,
      },
    },
  });
  assert.equal(command.convexMutationKind, "activateManifest");
  assert.equal(command.targetProviderReleaseId, null);
  assert.equal(command.targetCatalogVersionId, null);
  assert.equal(command.observation.providerSelections.length, 1);
  assert.equal(
    canonicalJson(command.observation.providerSelections[0]),
    canonicalJson(beta.activeObservation),
  );
  assert.doesNotMatch(command.canonicalRequestBody, /clear/u);
});

test("rollback activates the newly composed hybrid and preserves beta", async () => {
  const plans = await fixturePlans();
  const [targetManifest, current] = await Promise.all([
    manifest([plans.alphaOne, plans.betaOne]),
    manifest([plans.alphaTwo, plans.betaOne]),
  ]);
  const alphaOne = targetProof({
    plan: plans.alphaOne,
    providerId: providerIds.alpha,
    localReleaseId: localReleaseIds.alphaOne,
    catalogVersionId: catalogIds.alphaOne,
    terminalReceiptSha256: hash.receiptAlphaOne,
    terminalOperationId: "provider:alpha:finalize:one",
  });
  const alphaTwo = targetProof({
    plan: plans.alphaTwo,
    providerId: providerIds.alpha,
    localReleaseId: localReleaseIds.alphaTwo,
    catalogVersionId: catalogIds.alphaTwo,
    terminalReceiptSha256: hash.receiptAlphaTwo,
    terminalOperationId: "provider:alpha:finalize:two",
  });
  const beta = targetProof({
    plan: plans.betaOne,
    providerId: providerIds.beta,
    localReleaseId: localReleaseIds.betaOne,
    catalogVersionId: catalogIds.betaOne,
    terminalReceiptSha256: hash.receiptBetaOne,
    terminalOperationId: "provider:beta:finalize:one",
  });
  const command = await composeIndependentProviderManifestGate({
    operationId: "manifest:alpha:rollback:one",
    idempotencyKey: "manifest:alpha:rollback:one",
    currentManifest: current,
    currentActiveState: activeState({
      manifest: current,
      observations: [alphaTwo.activeObservation, beta.activeObservation],
      generation: 2,
      observationSequence: 2,
    }),
    target: {
      operation: "rollback",
      candidateManifest: targetManifest,
      proof: alphaOne,
    },
  });
  assert.equal(command.semanticOperation, "rollback");
  assert.equal(command.convexMutationKind, "activateManifest");
  assert.equal(command.unchangedProviderCount, 1);
  const request = catalogManifestActivateRequestSchema.parse(
    JSON.parse(command.canonicalRequestBody),
  );
  assert.equal(
    request.manifest.publicReleaseId,
    targetManifest.publicReleaseId,
  );
  assert.equal(
    request.manifest.manifestFingerprint,
    targetManifest.manifestFingerprint,
  );
  assert.equal(
    canonicalJson(current.providerReferences[1]),
    canonicalJson(targetManifest.providerReferences[1]),
  );
});
