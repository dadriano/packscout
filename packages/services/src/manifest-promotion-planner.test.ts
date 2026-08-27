import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  catalogManifestActivationReceiptSchema,
  catalogManifestReceiptDigest,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestActivateRequest,
  type CatalogManifestRefreshActiveStateRequest,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseImmutableProofV1,
} from "@packscout/contracts";
import { buildProviderCatalogReleasePublishPlan } from "./provider-catalog-release-artifacts.ts";
import { projectProviderCatalogRelease } from "./provider-catalog-release-public-projection.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureCheckpoint,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";
import {
  ManifestPromotionPlanningError,
  prepareManifestPromotion,
} from "./manifest-promotion-planner.ts";
import {
  ManifestPromotionPreparationError,
  parseManifestPromotionOperation,
  validateManifestPromotionReceipt,
} from "./manifest-promotion-operations.ts";
import type {
  ManifestPromotionActiveSelection,
  ManifestPromotionActiveState,
  ManifestPromotionEvaluationSnapshot,
  ManifestPromotionProviderFact,
  ManifestProviderPlanResolver,
} from "./manifest-promotion-types.ts";
import type { ProviderPromotionCompletedHead } from "./provider-promotion-types.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function immutableProof(
  plan: ProviderCatalogReleasePublishPlanV1,
): ProviderReleaseImmutableProofV1 {
  return {
    platformKey: plan.platformKey,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
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
    dataAsOf: plan.dataAsOf,
  };
}

async function providerPlan(input: Readonly<{
  platformKey: "alpha" | "beta";
  settledSequence?: bigint;
  sourceHeadSequence?: bigint;
  revision?: number;
  configurationSequence?: bigint;
  configurationHash?: string;
  name?: string;
}>): Promise<Readonly<{
  plan: ProviderCatalogReleasePublishPlanV1;
  checkpoint: ReturnType<typeof providerFixtureCheckpoint>;
}>> {
  const checkpoint = providerFixtureCheckpoint({
    platformKey: input.platformKey,
    settledSequence: input.settledSequence,
    sourceHeadSequence: input.sourceHeadSequence,
    revision: input.revision,
    configurationSequence: input.configurationSequence,
    configurationHash: input.configurationHash,
  });
  const configuration = providerFixtureApprovedConfiguration({
    platformKey: input.platformKey,
    revision: input.revision,
  });
  const snapshot = providerFixtureSnapshot({
    checkpoint,
    configuration,
    alphaName: input.name,
  });
  const projection = projectProviderCatalogRelease({
    configuration,
    platformKey: input.platformKey,
    revisions: snapshot.revisions,
    assetPackAssociations: snapshot.assetPackAssociations,
    repackIdentities: snapshot.repackIdentities,
  });
  return {
    checkpoint,
    plan: await buildProviderCatalogReleasePublishPlan({
      checkpoint: snapshot.checkpoint,
      configuration: snapshot.configuration,
      projection,
      lastSuccessfulObservationAt:
        snapshot.observation.lastSuccessfulObservationAt,
    }),
  };
}

function completedHead(
  plan: ProviderCatalogReleasePublishPlanV1,
  options: Readonly<{
    checkpoint?: { settledSequence: string; settledAt: string | null };
    observation?: ProviderCatalogReleasePublishPlanV1["observation"];
    kind?: "finalize" | "confirmReuse";
  }> = {},
): ProviderPromotionCompletedHead {
  const checkpoint = options.checkpoint ?? plan.providerCheckpoint;
  const observation = options.observation ?? plan.observation;
  const result = {
    platformKey: plan.platformKey,
    release: immutableProof(plan),
    providerCheckpoint: checkpoint,
    observation,
  };
  const completedHeadBody = canonicalJson(result);
  const canonicalReceiptBody = canonicalJson({
    kind: options.kind ?? "finalize",
    release: plan.publicProviderReleaseId,
    checkpoint,
  });
  return {
    platformKey: plan.platformKey,
    targetCheckpoint: BigInt(checkpoint.settledSequence),
    publicProviderReleaseId: plan.publicProviderReleaseId,
    providerReleaseFingerprint: plan.providerReleaseFingerprint,
    completedHead: result,
    completedHeadBody,
    completedHeadSha256: sha256(completedHeadBody),
    terminalOperationKind: options.kind ?? "finalize",
    terminalOperationId:
      `${options.kind ?? "finalize"}:${plan.publicProviderReleaseId}`,
    terminalReceiptSha256: sha256(canonicalReceiptBody),
    canonicalReceiptBody,
    exactResponseBody: null,
    responseSha256: null,
    completedAt: new Date("2026-08-15T03:00:00.000Z"),
    publishArtifactAttemptId: `${plan.platformKey}-publish-attempt`,
  };
}

function fact(input: Readonly<{
  plan: ProviderCatalogReleasePublishPlanV1;
  head: ProviderPromotionCompletedHead | null;
  checkpoint?: ReturnType<typeof providerFixtureCheckpoint>;
  minimumEligibleCheckpoint?: bigint;
  activeSelection?: ManifestPromotionActiveSelection | null;
  observedAt?: Date;
}>): ManifestPromotionProviderFact {
  const base = input.checkpoint ?? providerFixtureCheckpoint({
    platformKey: input.plan.platformKey as "alpha" | "beta",
    settledSequence: BigInt(input.plan.providerCheckpoint.settledSequence),
  });
  return {
    platformKey: input.plan.platformKey,
    checkpoint: base,
    minimumEligibleCheckpoint: input.minimumEligibleCheckpoint ?? 1n,
    initialBackfillComplete: true,
    completedBackfillAt: new Date("2026-08-15T02:00:00.000Z"),
    lastSuccessfulObservationAt: input.observedAt ??
      new Date(input.plan.observation.lastSuccessfulObservationAt),
    completedHead: input.head,
    activeSelection: input.activeSelection ?? null,
  };
}

function emptyActiveState(): ManifestPromotionActiveState {
  const state: ActiveCatalogManifestStateV1 = {
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  };
  return {
    state,
    canonicalStateBody: canonicalJson(state),
    stateSha256: sha256(canonicalJson(state)),
    canonicalActiveStateReceiptBody: canonicalJson({ state }),
    activeStateReceiptSha256: sha256(canonicalJson({ state })),
    exactResponseBody: null,
    responseSha256: null,
    activeSelections: [],
  };
}

function snapshot(input: Readonly<{
  sequence: bigint;
  facts: readonly ManifestPromotionProviderFact[];
  activeState?: ManifestPromotionActiveState;
  configuredPlatformKeys?: readonly string[];
  enabledPlatformKeys?: readonly string[];
  confidencePolicyVersion?: string;
}>): ManifestPromotionEvaluationSnapshot {
  const enabledPlatformKeys = input.enabledPlatformKeys ??
    input.facts.map(({ platformKey }) => platformKey);
  const first = input.facts[0]?.checkpoint.sharedConfigurationEpoch ?? {
    configurationKey: "catalog-v1",
    revision: 1,
    publicChangeSequence: 1n,
    configurationHash: "a".repeat(64),
  };
  return {
    evaluationSequence: input.sequence,
    snapshotSha256: sha256(`snapshot:${input.sequence}`),
    eligibility: {
      organizationId: "70000000-0000-4000-8000-000000000001",
      sharedConfigurationEpoch: first,
      confidencePolicyVersion:
        input.confidencePolicyVersion ?? "confidence-v1",
      staleAfterSeconds: 900,
      configuredPlatformKeys: input.configuredPlatformKeys ??
        enabledPlatformKeys,
      enabledPlatformKeys,
      lifecycleDecisionSequence: 100n,
      checkpoints: input.facts.map(({ checkpoint }) => checkpoint),
    },
    providerFacts: input.facts,
    activeState: input.activeState ?? emptyActiveState(),
  };
}

function resolver(
  plans: readonly ProviderCatalogReleasePublishPlanV1[],
): ManifestProviderPlanResolver {
  const byId = new Map(plans.map((plan) => [
    `${plan.platformKey}:${plan.publicProviderReleaseId}`,
    plan,
  ]));
  return {
    loadPublishPlan(input) {
      return Promise.resolve(
        byId.get(`${input.platformKey}:${input.publicProviderReleaseId}`) ??
          null,
      );
    },
  };
}

function activeFromRequest(
  request: CatalogManifestActivateRequest,
  heads: readonly ProviderPromotionCompletedHead[],
  generation = 1,
): ManifestPromotionActiveState {
  const state: ActiveCatalogManifestStateV1 = {
    generation,
    activeManifest: {
      publicReleaseId: request.manifest.publicReleaseId,
      manifestFingerprint: request.manifest.manifestFingerprint,
      sharedConfigurationEpoch: request.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: request.manifest.providerReferenceSetHash,
      createdAt: "2026-08-15T03:00:01.000Z",
      completedAt: "2026-08-15T03:00:01.000Z",
    },
    previousManifest: request.expectedActiveState.activeManifest,
    observation: request.observation,
    terminalReceiptSha256: "f".repeat(64),
  };
  const activeSelections = request.observation.providerSelections.map(
    (selection): ManifestPromotionActiveSelection => {
      const head = heads.find(({ platformKey }) =>
        platformKey === selection.platformKey)!;
      const selectionBody = canonicalJson(selection);
      return {
        platformKey: selection.platformKey,
        activeGeneration: BigInt(generation),
        manifestPublicReleaseId: request.manifest.publicReleaseId,
        providerPublicReleaseId: selection.publicProviderReleaseId,
        providerReleaseFingerprint:
          head.providerReleaseFingerprint,
        selectedCheckpoint:
          BigInt(selection.selectedProviderCheckpoint.settledSequence),
        selection,
        selectionBody,
        selectionSha256: sha256(selectionBody),
        providerTerminalOperationId: selection.terminalOperationId,
        providerTerminalReceiptSha256: selection.terminalReceiptSha256,
        publishArtifactAttemptId: head.publishArtifactAttemptId,
        activatedAt: new Date("2026-08-15T03:00:01.000Z"),
      };
    },
  );
  return {
    state,
    canonicalStateBody: canonicalJson(state),
    stateSha256: sha256(canonicalJson(state)),
    canonicalActiveStateReceiptBody: canonicalJson({ state }),
    activeStateReceiptSha256: sha256(canonicalJson({ state })),
    exactResponseBody: null,
    responseSha256: null,
    activeSelections,
  };
}

test("initial evaluation composes every enabled provider from completed proofs", async () => {
  const [alpha, beta] = await Promise.all([
    providerPlan({ platformKey: "alpha" }),
    providerPlan({ platformKey: "beta" }),
  ]);
  const alphaHead = completedHead(alpha.plan);
  const betaHead = completedHead(beta.plan);
  const prepared = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 1n,
      confidencePolicyVersion: "approved-confidence-v7",
      facts: [
        fact({ plan: alpha.plan, head: alphaHead, checkpoint: alpha.checkpoint }),
        fact({ plan: beta.plan, head: betaHead, checkpoint: beta.checkpoint }),
      ],
    }),
    providerPlans: resolver([alpha.plan, beta.plan]),
  });

  assert.equal(prepared.outcome, "activate");
  assert.equal(prepared.summary.providerSelections.length, 2);
  assert.ok(prepared.summary.providerSelections.every(
    ({ source }) => source === "completed_head",
  ));
  const request = parseManifestPromotionOperation(prepared.operation!);
  assert.ok("manifest" in request);
  assert.equal(
    (request as CatalogManifestActivateRequest)
      .manifest.confidencePolicyVersion,
    "approved-confidence-v7",
  );
});

test("initial and new-epoch evaluations require every enabled release", async () => {
  const [alpha, beta] = await Promise.all([
    providerPlan({ platformKey: "alpha" }),
    providerPlan({ platformKey: "beta" }),
  ]);
  await assert.rejects(
    () => prepareManifestPromotion({
      snapshot: snapshot({
        sequence: 1n,
        facts: [
          fact({ plan: alpha.plan, head: completedHead(alpha.plan) }),
          fact({ plan: beta.plan, head: null }),
        ],
      }),
      providerPlans: resolver([alpha.plan, beta.plan]),
    }),
    (error: unknown) => error instanceof ManifestPromotionPlanningError &&
      error.code === "MANIFEST_CONFIGURATION_EPOCH_BARRIER",
  );

  const initial = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 1n,
      facts: [
        fact({ plan: alpha.plan, head: completedHead(alpha.plan) }),
        fact({ plan: beta.plan, head: completedHead(beta.plan) }),
      ],
    }),
    providerPlans: resolver([alpha.plan, beta.plan]),
  });
  const initialRequest = parseManifestPromotionOperation(initial.operation!);
  assert.ok("manifest" in initialRequest);
  const active = activeFromRequest(
    initialRequest as CatalogManifestActivateRequest,
    [completedHead(alpha.plan), completedHead(beta.plan)],
  );
  const alphaNextEpoch = await providerPlan({
    platformKey: "alpha",
    revision: 2,
    configurationSequence: 30n,
    configurationHash: "b".repeat(64),
    settledSequence: 30n,
    name: "Alpha epoch two",
  });
  const betaNextEpoch = await providerPlan({
    platformKey: "beta",
    revision: 2,
    configurationSequence: 30n,
    configurationHash: "b".repeat(64),
    settledSequence: 30n,
  });
  await assert.rejects(
    () => prepareManifestPromotion({
      snapshot: snapshot({
        sequence: 2n,
        activeState: active,
        facts: [
          fact({
            plan: alphaNextEpoch.plan,
            head: completedHead(alphaNextEpoch.plan),
            checkpoint: alphaNextEpoch.checkpoint,
          }),
          fact({
            plan: betaNextEpoch.plan,
            head: completedHead(beta.plan),
            checkpoint: betaNextEpoch.checkpoint,
            activeSelection: active.activeSelections[1],
          }),
        ],
      }),
      providerPlans: resolver([
        alphaNextEpoch.plan, betaNextEpoch.plan, beta.plan,
      ]),
    }),
    (error: unknown) => error instanceof ManifestPromotionPlanningError &&
      error.code === "MANIFEST_CONFIGURATION_EPOCH_BARRIER",
  );
});

test("empty or cleared activation rejects a pre-enable head until current reuse", async () => {
  const alpha = await providerPlan({
    platformKey: "alpha",
    settledSequence: 10n,
    sourceHeadSequence: 10n,
  });
  const currentCheckpoint = providerFixtureCheckpoint({
    platformKey: "alpha",
    settledSequence: 11n,
    sourceHeadSequence: 11n,
  });
  const staleFact = fact({
    plan: alpha.plan,
    head: completedHead(alpha.plan),
    checkpoint: currentCheckpoint,
    minimumEligibleCheckpoint: 11n,
  });
  const clearedState: ActiveCatalogManifestStateV1 = {
    generation: 1,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: "f".repeat(64),
  };
  const clearedStateBody = canonicalJson(clearedState);
  const clearedReceiptBody = canonicalJson({ state: clearedState });
  const cleared: ManifestPromotionActiveState = {
    state: clearedState,
    canonicalStateBody: clearedStateBody,
    stateSha256: sha256(clearedStateBody),
    canonicalActiveStateReceiptBody: clearedReceiptBody,
    activeStateReceiptSha256: sha256(clearedReceiptBody),
    exactResponseBody: null,
    responseSha256: null,
    activeSelections: [],
  };

  for (const activeState of [emptyActiveState(), cleared]) {
    await assert.rejects(
      () => prepareManifestPromotion({
        snapshot: snapshot({
          sequence: 2n,
          activeState,
          facts: [staleFact],
        }),
        providerPlans: resolver([alpha.plan]),
      }),
      (error: unknown) => error instanceof ManifestPromotionPlanningError &&
        error.code === "MANIFEST_CONFIGURATION_EPOCH_BARRIER",
    );
  }

  const original = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 1n,
      facts: [fact({
        plan: alpha.plan,
        head: completedHead(alpha.plan),
        minimumEligibleCheckpoint: 1n,
      })],
    }),
    providerPlans: resolver([alpha.plan]),
  });
  const originalRequest = parseManifestPromotionOperation(original.operation!);
  assert.ok("manifest" in originalRequest);
  const preDisableActive = activeFromRequest(
    originalRequest as CatalogManifestActivateRequest,
    [completedHead(alpha.plan)],
  );
  const continuousPublicFallback = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 2n,
      activeState: preDisableActive,
      facts: [fact({
        plan: alpha.plan,
        head: null,
        checkpoint: currentCheckpoint,
        minimumEligibleCheckpoint: 11n,
        activeSelection: preDisableActive.activeSelections[0],
      })],
    }),
    providerPlans: resolver([alpha.plan]),
  });
  assert.equal(continuousPublicFallback.outcome, "refresh");
  assert.equal(
    continuousPublicFallback.summary.providerSelections[0]!.source,
    "active_fallback",
  );

  const refreshedHead = completedHead(alpha.plan, {
    kind: "confirmReuse",
    checkpoint: {
      settledSequence: "11",
      settledAt: currentCheckpoint.settledAt!.toISOString(),
    },
  });
  const prepared = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 3n,
      activeState: cleared,
      facts: [fact({
        plan: alpha.plan,
        head: refreshedHead,
        checkpoint: currentCheckpoint,
        minimumEligibleCheckpoint: 11n,
      })],
    }),
    providerPlans: resolver([alpha.plan]),
  });

  assert.equal(prepared.outcome, "activate");
  assert.equal(prepared.summary.providerSelections[0]!.selectedCheckpoint, "11");
});

test("A2 activates with delayed active B1, then B1 reuse refreshes facts only", async () => {
  const [alpha1, beta1] = await Promise.all([
    providerPlan({ platformKey: "alpha" }),
    providerPlan({ platformKey: "beta" }),
  ]);
  const alpha1Head = completedHead(alpha1.plan);
  const beta1Head = completedHead(beta1.plan);
  const initial = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 1n,
      facts: [
        fact({ plan: alpha1.plan, head: alpha1Head }),
        fact({ plan: beta1.plan, head: beta1Head }),
      ],
    }),
    providerPlans: resolver([alpha1.plan, beta1.plan]),
  });
  const initialRequest = parseManifestPromotionOperation(initial.operation!);
  assert.ok("manifest" in initialRequest);
  const active1 = activeFromRequest(
    initialRequest as CatalogManifestActivateRequest,
    [alpha1Head, beta1Head],
  );
  const alpha2 = await providerPlan({
    platformKey: "alpha",
    settledSequence: 30n,
    name: "Alpha second release",
  });
  const alpha2Head = completedHead(alpha2.plan);
  const delayedBetaCheckpoint = providerFixtureCheckpoint({
    platformKey: "beta",
    settledSequence: 20n,
    sourceHeadSequence: 25n,
    sourceHeadAt: new Date("2026-08-15T03:05:00.000Z"),
    blockedState: {
      kind: "blocked",
      reason: "pending_derivation",
      causeSequence: 21n,
    },
  });
  const delayed = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 2n,
      activeState: active1,
      facts: [
        fact({ plan: alpha2.plan, head: alpha2Head, checkpoint: alpha2.checkpoint }),
        fact({
          plan: beta1.plan,
          head: null,
          checkpoint: delayedBetaCheckpoint,
          activeSelection: active1.activeSelections[1],
          observedAt: new Date("2026-08-15T03:05:00.000Z"),
        }),
      ],
    }),
    providerPlans: resolver([alpha1.plan, alpha2.plan, beta1.plan]),
  });
  assert.equal(delayed.outcome, "activate");
  assert.deepEqual(
    delayed.summary.providerSelections.map(({ platformKey, source }) => ({
      platformKey, source,
    })),
    [
      { platformKey: "alpha", source: "completed_head" },
      { platformKey: "beta", source: "active_fallback" },
    ],
  );
  const delayedRequest = parseManifestPromotionOperation(delayed.operation!);
  assert.ok("manifest" in delayedRequest);
  assert.equal(delayedRequest.observation.freshness, "delayed");
  const active2 = activeFromRequest(
    delayedRequest as CatalogManifestActivateRequest,
    [alpha2Head, beta1Head],
    2,
  );
  const betaReuseHead = completedHead(beta1.plan, {
    kind: "confirmReuse",
    checkpoint: {
      settledSequence: "25",
      settledAt: "2026-08-15T03:05:00.000Z",
    },
    observation: {
      sourceHeadSequence: "25",
      lastSuccessfulObservationAt: "2026-08-15T03:05:00.000Z",
      staleAt: "2026-08-15T03:20:00.000Z",
      freshness: "fresh",
    },
  });
  const recoveredBetaCheckpoint = providerFixtureCheckpoint({
    platformKey: "beta",
    settledSequence: 25n,
    sourceHeadSequence: 26n,
    settledAt: new Date("2026-08-15T03:05:00.000Z"),
    sourceHeadAt: new Date("2026-08-15T03:06:00.000Z"),
    blockedState: {
      kind: "blocked",
      reason: "pending_derivation",
      causeSequence: 26n,
    },
  });
  const refreshed = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 3n,
      activeState: active2,
      facts: [
        fact({ plan: alpha2.plan, head: alpha2Head, checkpoint: alpha2.checkpoint }),
        fact({
          plan: beta1.plan,
          head: betaReuseHead,
          checkpoint: recoveredBetaCheckpoint,
          activeSelection: active2.activeSelections[1],
          observedAt: new Date("2026-08-15T03:06:00.000Z"),
        }),
      ],
    }),
    providerPlans: resolver([alpha2.plan, beta1.plan]),
  });
  assert.equal(refreshed.outcome, "refresh");
  const refreshRequest = parseManifestPromotionOperation(refreshed.operation!);
  assert.equal(refreshRequest.schemaVersion, "catalog_manifest_publication_v1");
  const refreshObservation =
    (refreshRequest as CatalogManifestRefreshActiveStateRequest).observation;
  assert.equal(refreshObservation.freshness, "delayed");
  assert.equal(
    refreshObservation.providerSelections[1]!
      .selectedProviderCheckpoint.settledSequence,
    "25",
  );
  assert.equal(
    refreshObservation.providerSelections[1]!
      .latestAffectedSourceHeadSequence,
    "26",
  );
  assert.equal(
    (refreshRequest as CatalogManifestRefreshActiveStateRequest)
      .manifest.publicReleaseId,
    (delayedRequest as CatalogManifestActivateRequest).manifest.publicReleaseId,
  );
});

test("lifecycle disable composes B-only omission before configuration removal and last-provider disable clears", async () => {
  const [alpha, beta] = await Promise.all([
    providerPlan({ platformKey: "alpha" }),
    providerPlan({ platformKey: "beta" }),
  ]);
  const alphaHead = completedHead(alpha.plan);
  const betaHead = completedHead(beta.plan);
  const initial = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 1n,
      facts: [
        fact({ plan: alpha.plan, head: alphaHead }),
        fact({ plan: beta.plan, head: betaHead }),
      ],
    }),
    providerPlans: resolver([alpha.plan, beta.plan]),
  });
  const request = parseManifestPromotionOperation(initial.operation!);
  assert.ok("manifest" in request);
  const active = activeFromRequest(
    request as CatalogManifestActivateRequest,
    [alphaHead, betaHead],
  );
  const omitted = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 2n,
      activeState: active,
      configuredPlatformKeys: ["alpha", "beta"],
      enabledPlatformKeys: ["beta"],
      facts: [fact({
        plan: beta.plan,
        head: betaHead,
        activeSelection: active.activeSelections[1],
      })],
    }),
    providerPlans: resolver([beta.plan]),
  });
  assert.equal(omitted.outcome, "activate");
  const omissionRequest = parseManifestPromotionOperation(omitted.operation!);
  assert.ok("manifest" in omissionRequest);
  assert.deepEqual(
    (omissionRequest as CatalogManifestActivateRequest)
      .manifest.enabledPlatformKeys,
    ["beta"],
  );

  const clear = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 3n,
      activeState: active,
      configuredPlatformKeys: ["alpha", "beta"],
      enabledPlatformKeys: [],
      facts: [],
    }),
    providerPlans: resolver([]),
  });
  assert.equal(clear.outcome, "clear");
  assert.equal(clear.summary.manifestIdentity, null);
  const clearRequest = parseManifestPromotionOperation(clear.operation!);
  assert.ok("rollbackKind" in clearRequest);
  assert.deepEqual(clearRequest, {
    schemaVersion: "catalog_manifest_publication_v1",
    operationId: "manifest:3:rollback",
    idempotencyKey: "manifest:3:rollback",
    rollbackKind: "clear",
    clearAuthorization: "clear_catalog_manifest_v1",
    expectedActiveState: active.state,
  });
  assert.equal(alphaHead.publicProviderReleaseId, alpha.plan.publicProviderReleaseId);
});

test("unchanged trigger coalesces as a durable no-change evaluation", async () => {
  const alpha = await providerPlan({ platformKey: "alpha" });
  const alphaHead = completedHead(alpha.plan);
  const initial = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 1n,
      facts: [fact({ plan: alpha.plan, head: alphaHead })],
    }),
    providerPlans: resolver([alpha.plan]),
  });
  const request = parseManifestPromotionOperation(initial.operation!);
  assert.ok("manifest" in request);
  const active = activeFromRequest(
    request as CatalogManifestActivateRequest,
    [alphaHead],
  );
  const unchanged = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 2n,
      activeState: active,
      facts: [fact({
        plan: alpha.plan,
        head: alphaHead,
        activeSelection: active.activeSelections[0],
      })],
    }),
    providerPlans: resolver([alpha.plan]),
  });
  assert.equal(unchanged.outcome, "no_change");
  assert.equal(unchanged.operation, null);
  assert.equal(unchanged.summary.evaluationSnapshotSha256, sha256("snapshot:2"));
});

test("refuses a schema-valid receipt that changes persisted provider facts", async () => {
  const alpha = await providerPlan({ platformKey: "alpha" });
  const head = completedHead(alpha.plan);
  const prepared = await prepareManifestPromotion({
    snapshot: snapshot({
      sequence: 1n,
      facts: [fact({ plan: alpha.plan, head })],
    }),
    providerPlans: resolver([alpha.plan]),
  });
  assert.ok(prepared.operation !== null);
  const request = parseManifestPromotionOperation(prepared.operation);
  assert.ok("manifest" in request);
  const activate = request as CatalogManifestActivateRequest;

  async function receiptFor(
    observation: CatalogManifestActivateRequest["observation"],
  ) {
    const withoutDigest = {
      schemaVersion: "catalog_manifest_publication_v1" as const,
      operationKind: "activateManifest" as const,
      operationId: activate.operationId,
      idempotencyKey: activate.idempotencyKey,
      publicReleaseId: activate.manifest.publicReleaseId,
      manifestFingerprint: activate.manifest.manifestFingerprint,
      terminalState: "complete" as const,
      result: "activated" as const,
      serverTime: "2026-08-15T03:00:01.000Z",
      requestDigest: prepared.operation!.requestSha256,
      details: {
        expectedActiveState: activate.expectedActiveState,
        activeState: {
          generation: activate.expectedActiveState.generation + 1,
          activeManifest: {
            publicReleaseId: activate.manifest.publicReleaseId,
            manifestFingerprint: activate.manifest.manifestFingerprint,
            sharedConfigurationEpoch:
              activate.manifest.sharedConfigurationEpoch,
            providerReferenceSetHash:
              activate.manifest.providerReferenceSetHash,
            createdAt: "2026-08-15T03:00:01.000Z",
            completedAt: "2026-08-15T03:00:01.000Z",
          },
          previousManifest: activate.expectedActiveState.activeManifest,
          observation,
        },
      },
    };
    return {
      ...withoutDigest,
      receiptDigest: await catalogManifestReceiptDigest(withoutDigest),
    };
  }

  const valid = await receiptFor(activate.observation);
  validateManifestPromotionReceipt({
    operation: prepared.operation,
    receipt: valid,
  });

  const changedSelection = {
    ...activate.observation.providerSelections[0]!,
    latestAffectedSourceHeadSequence: "21",
    settledSourceFreshness: "delayed" as const,
  };
  const changedObservation = buildGlobalCatalogAggregateObservationV1({
    observationSequence: activate.observation.observationSequence + 1,
    publicReleaseId: activate.manifest.publicReleaseId,
    providerReferenceSetHash: activate.manifest.providerReferenceSetHash,
    providerSelections: [changedSelection],
  });
  const changed = await receiptFor(changedObservation);
  catalogManifestActivationReceiptSchema.parse(changed);
  assert.throws(
    () => validateManifestPromotionReceipt({
      operation: prepared.operation!,
      receipt: changed,
    }),
    (error: unknown) => error instanceof ManifestPromotionPreparationError &&
      error.code === "MANIFEST_RECEIPT_INVALID",
  );
});
