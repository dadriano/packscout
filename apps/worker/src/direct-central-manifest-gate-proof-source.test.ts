import assert from "node:assert/strict";
import test from "node:test";
import {
  activeCatalogManifestStateV1Schema,
  approvedPublicCatalogConfigurationV1Schema,
  buildGlobalCatalogAggregateObservationV1,
  MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES,
  recomputeProviderCatalogReleaseGoverningHashV1,
  sha256CanonicalJson,
  type ActiveCatalogManifestStateV1,
  type GlobalCatalogManifestV1,
} from "@packscout/contracts";
import {
  PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
  ProviderCompletionPublishPlanCapacityError,
  PromotionJobPersistenceError,
  providerCompletionPlanHydrationByteCount,
  verifyProviderCompletedPublishPlanRelayProof,
  type CachedProviderCompletionPublishPlan,
  type ManifestActivationMirror,
  type ManifestGateClaim,
} from "@packscout/database";
import { buildProviderCompletionPlanProofFixture } from
  "@packscout/database/test-support";
import { composeGlobalCatalogManifest } from "@packscout/services";
import {
  type CentralApprovedManifestConfigurationSource,
  DirectCentralManifestGateProofSource,
  UnavailableCentralApprovedManifestConfigurationSource,
} from "./direct-central-manifest-gate-proof-source.ts";

const NOW = new Date("2026-09-01T20:30:00.000Z");
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const PROVIDER_A_ID = "00000000-0000-4000-8000-00000000000a";
const PROVIDER_B_ID = "00000000-0000-4000-8000-00000000000b";
const OPERATOR_ID = "00000000-0000-4000-8000-00000000000c";
const CLAIM_TOKEN = "00000000-0000-4000-8000-00000000000d";
const RECEIPT_HASH = "9".repeat(64);

interface CacheFixtureInput {
  readonly providerId: string;
  readonly providerKey: string;
  readonly providerReleaseId: string;
  readonly catalogVersionId: string;
  readonly artifactAttemptId: string;
  readonly eventId: string;
  readonly evidenceDigest: string;
  readonly releaseSequence: bigint;
  readonly confidencePolicyHash?: string;
}

async function cachedPlan(
  input: CacheFixtureInput,
): Promise<CachedProviderCompletionPublishPlan> {
  const proof = await buildProviderCompletionPlanProofFixture({
    providerId: input.providerId,
    providerKey: input.providerKey,
    providerReleaseId: input.providerReleaseId,
    catalogVersionId: input.catalogVersionId,
    catalogContentHash: "a".repeat(64),
    artifactAttemptId: input.artifactAttemptId,
    releaseSequence: input.releaseSequence,
    ...(input.confidencePolicyHash === undefined
      ? {}
      : { confidencePolicyHash: input.confidencePolicyHash }),
  });
  const verified = await verifyProviderCompletedPublishPlanRelayProof(proof);
  return {
    eventId: input.eventId,
    providerId: verified.providerId,
    providerKey: verified.providerKey,
    providerReleaseId: verified.providerReleaseId,
    publicProviderReleaseId: verified.publicProviderReleaseId,
    providerReleaseFingerprint: verified.providerReleaseFingerprint,
    catalogVersionId: verified.catalogVersionId,
    catalogContentHash: verified.catalogContentHash,
    providerReleaseContentHash: verified.providerReleaseContentHash,
    completedThroughChangeSequence: verified.completedThroughChangeSequence,
    artifactAttemptId: verified.artifactAttemptId,
    terminalOperationKind: verified.terminalOperationKind,
    terminalOperationId: verified.terminalOperationId,
    terminalReceiptSha256: verified.terminalReceiptSha256,
    evidenceDigest: input.evidenceDigest,
    planSha256: verified.planSha256,
    completedHeadSha256: verified.completedHeadSha256,
    activeObservationSha256: verified.activeObservationSha256,
    planByteCount: Buffer.byteLength(verified.canonicalPlanBody, "utf8"),
    completedHeadByteCount: Buffer.byteLength(
      verified.canonicalCompletedHeadBody,
      "utf8",
    ),
    activeObservationByteCount: Buffer.byteLength(
      verified.canonicalActiveObservationBody,
      "utf8",
    ),
    activityEventAt: NOW,
    activityReceivedAt: NOW,
    verifiedAt: NOW,
    createdAt: NOW,
    retentionAnchorAt: NOW,
    plan: verified.plan,
    completedHead: verified.completedHead,
    activeObservation: verified.activeObservation,
  };
}

function manifestPointer(manifest: GlobalCatalogManifestV1) {
  return {
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    createdAt: "2026-09-01T20:00:00.000Z",
    completedAt: "2026-09-01T20:00:01.000Z",
  };
}

async function activeFixture(
  plans: readonly CachedProviderCompletionPublishPlan[],
): Promise<Readonly<{
  manifest: GlobalCatalogManifestV1;
  state: ActiveCatalogManifestStateV1;
  mirror: ManifestActivationMirror;
}>> {
  const sorted = [...plans].sort((left, right) =>
    left.providerKey < right.providerKey ? -1 : 1);
  const manifest = await composeGlobalCatalogManifest({
    enabledPlatformKeys: sorted.map(({ providerKey }) => providerKey),
    providerPlans: sorted.map(({ plan }) => plan),
    approvedConfiguration: {
      sharedConfigurationEpoch: sorted[0]!.plan.sharedConfigurationEpoch,
      confidencePolicyVersion: "confidence-v1",
    },
  });
  const state = activeCatalogManifestStateV1Schema.parse({
    generation: 7,
    activeManifest: manifestPointer(manifest),
    previousManifest: null,
    observation: buildGlobalCatalogAggregateObservationV1({
      observationSequence: 7,
      publicReleaseId: manifest.publicReleaseId,
      providerReferenceSetHash: manifest.providerReferenceSetHash,
      providerSelections: sorted.map(({ activeObservation }) =>
        activeObservation),
    }),
    terminalReceiptSha256: RECEIPT_HASH,
  });
  return {
    manifest,
    state,
    mirror: {
      generation: 7n,
      activeManifest: manifest,
      activeState: state,
      previousManifest: null,
      lastReceiptId: "receipt-7",
      rowVersion: 7n,
      updatedAt: NOW,
    },
  };
}

function claim(input: Readonly<{
  providerId?: string;
  providerKey?: string;
  evidenceDigest: string;
  operation?: "advance" | "add" | "remove" | "rollback" | null;
  targetProviderReleaseId?: string | null;
  targetCatalogVersionId?: string | null;
}>): ManifestGateClaim {
  const explicit = input.operation !== undefined && input.operation !== null;
  return {
    providerId: input.providerId ?? PROVIDER_A_ID,
    organizationId: ORGANIZATION_ID,
    providerKey: input.providerKey ?? "alpha",
    providerLifecycle: "active",
    providerRowVersion: 3n,
    requestedGeneration: 4n,
    acknowledgedGeneration: 3n,
    latestCause: explicit
      ? "manifest_eligibility_change"
      : "provider_completion",
    latestEvidenceDigest: input.evidenceDigest,
    latestRequestedAt: NOW,
    operationGeneration: explicit ? 4n : null,
    requestedOperation: input.operation ?? null,
    targetProviderReleaseId: input.targetProviderReleaseId ?? null,
    targetCatalogVersionId: input.targetCatalogVersionId ?? null,
    requestedByOperatorId: explicit ? OPERATOR_ID : null,
    authorizationDigest: explicit ? input.evidenceDigest : null,
    attemptCount: 1,
    lastAttemptedAt: NOW,
    retryAt: null,
    lastFailureCode: null,
    pending: true,
    observedGeneration: 4n,
    claimToken: CLAIM_TOKEN,
    claimExpiresAt: new Date("2026-09-01T20:31:00.000Z"),
  };
}

class MemoryPlanStore {
  readonly retainedRequests: string[][] = [];
  readonly readDeadlines: number[] = [];
  readonly aggregateBudgets: number[] = [];

  constructor(
    private readonly values: readonly CachedProviderCompletionPublishPlan[],
  ) {}

  async loadByEvidence(input: Readonly<{
    providerId: string;
    evidenceDigest: string;
  }>, deadline?: Readonly<{ deadlineAt: number }>) {
    if (deadline !== undefined) this.readDeadlines.push(deadline.deadlineAt);
    return this.values.find((value) =>
      value.providerId === input.providerId &&
      value.evidenceDigest === input.evidenceDigest) ?? null;
  }

  async loadExplicitTarget(input: Readonly<{
    providerId: string;
    providerReleaseId: string;
    catalogVersionId: string;
  }>, deadline?: Readonly<{ deadlineAt: number }>) {
    if (deadline !== undefined) this.readDeadlines.push(deadline.deadlineAt);
    const matches = this.values.filter((value) =>
      value.providerId === input.providerId &&
      value.providerReleaseId === input.providerReleaseId &&
      value.catalogVersionId === input.catalogVersionId);
    if (matches.length !== 1) {
      throw new Error("Explicit target is unavailable or ambiguous.");
    }
    return matches[0]!;
  }

  async loadForManifestReferences(references: readonly Readonly<{
    providerKey: string;
    publicProviderReleaseId: string;
    providerReleaseFingerprint: string;
  }>[], deadline?: Readonly<{ deadlineAt: number }>, maximumAggregateBytes =
  MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES) {
    if (deadline !== undefined) this.readDeadlines.push(deadline.deadlineAt);
    this.aggregateBudgets.push(maximumAggregateBytes);
    this.retainedRequests.push(references.map(({ providerKey }) => providerKey));
    const matches = references.map((reference) => this.values.find((value) =>
      value.providerKey === reference.providerKey &&
      value.publicProviderReleaseId === reference.publicProviderReleaseId &&
      value.providerReleaseFingerprint ===
        reference.providerReleaseFingerprint));
    if (matches.some((value) => value === undefined)) return null;
    const plans = matches as readonly CachedProviderCompletionPublishPlan[];
    if (plans.reduce(
      (total, value) => total + providerCompletionPlanHydrationByteCount(value),
      0,
    ) > maximumAggregateBytes) {
      throw new ProviderCompletionPublishPlanCapacityError();
    }
    return plans;
  }
}

function source(input: Readonly<{
  plans: MemoryPlanStore;
  mirror: ManifestActivationMirror;
  staleClaim?: boolean;
  claimDeadlines?: number[];
  initialConfiguration?: CentralApprovedManifestConfigurationSource;
}>) {
  return new DirectCentralManifestGateProofSource({
    claims: {
      async verifyActiveClaim(value, _now, deadline) {
        if (deadline !== undefined) {
          input.claimDeadlines?.push(deadline.deadlineAt);
        }
        if (input.staleClaim === true) {
          throw new PromotionJobPersistenceError(
            "PROMOTION_JOB_GATE_INTENT_INVALID",
          );
        }
        return value;
      },
    },
    plans: input.plans,
    activations: { async loadMirror() { return input.mirror; } },
    initialConfiguration: input.initialConfiguration ??
      new UnavailableCentralApprovedManifestConfigurationSource(),
    now: () => NOW,
  });
}

const A1 = {
  providerId: PROVIDER_A_ID,
  providerKey: "alpha",
  providerReleaseId: "10000000-0000-4000-8000-000000000001",
  catalogVersionId: "20000000-0000-4000-8000-000000000001",
  artifactAttemptId: "30000000-0000-4000-8000-000000000001",
  eventId: "40000000-0000-4000-8000-000000000001",
  evidenceDigest: "1".repeat(64),
  releaseSequence: 1n,
} as const;
const A2 = {
  ...A1,
  providerReleaseId: "10000000-0000-4000-8000-000000000002",
  catalogVersionId: "20000000-0000-4000-8000-000000000002",
  artifactAttemptId: "30000000-0000-4000-8000-000000000002",
  eventId: "40000000-0000-4000-8000-000000000002",
  evidenceDigest: "2".repeat(64),
  releaseSequence: 2n,
} as const;
const B1 = {
  providerId: PROVIDER_B_ID,
  providerKey: "beta",
  providerReleaseId: "10000000-0000-4000-8000-00000000000b",
  catalogVersionId: "20000000-0000-4000-8000-00000000000b",
  artifactAttemptId: "30000000-0000-4000-8000-00000000000b",
  eventId: "40000000-0000-4000-8000-00000000000b",
  evidenceDigest: "b".repeat(64),
  releaseSequence: 1n,
} as const;

test("advances A from central cache while unavailable B needs no provider read", async () => {
  const [a1, a2, b1] = await Promise.all([
    cachedPlan(A1), cachedPlan(A2), cachedPlan(B1),
  ]);
  const active = await activeFixture([a1, b1]);
  const plans = new MemoryPlanStore([a1, a2, b1]);
  const claimDeadlines: number[] = [];
  const deadlineAt = NOW.getTime() + 40_000;
  const result = await source({
    plans,
    mirror: active.mirror,
    claimDeadlines,
  }).resolveTarget({
    claim: claim({ evidenceDigest: a2.evidenceDigest }),
    currentManifest: active.manifest,
    currentActiveState: active.state,
    deadlineAt,
  });
  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  assert.equal(result.target.operation, "advance");
  assert.deepEqual(plans.retainedRequests, [["beta"]]);
  assert.deepEqual(claimDeadlines, [deadlineAt]);
  assert.deepEqual(plans.readDeadlines, [deadlineAt, deadlineAt]);
  const beforeB = active.manifest.providerReferences.find(
    ({ platformKey }) => platformKey === "beta",
  );
  const afterB = result.target.candidateManifest.providerReferences.find(
    ({ platformKey }) => platformKey === "beta",
  );
  assert.deepEqual(afterB, beforeB);
  assert.deepEqual(result.target.proof.completedHead, a2.completedHead);
  assert.deepEqual(result.target.proof.activeObservation, a2.activeObservation);
});

test("blocks before composition when target and retained plans exceed capacity", async () => {
  const [a1, a2Base, b1] = await Promise.all([
    cachedPlan(A1), cachedPlan(A2), cachedPlan(B1),
  ]);
  const active = await activeFixture([a1, b1]);
  const a2 = {
    ...a2Base,
    planByteCount: MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES -
      a2Base.completedHeadByteCount - a2Base.activeObservationByteCount - 1,
  };
  const plans = new MemoryPlanStore([a1, a2, b1]);
  const result = await source({ plans, mirror: active.mirror }).resolveTarget({
    claim: claim({ evidenceDigest: a2.evidenceDigest }),
    currentManifest: active.manifest,
    currentActiveState: active.state,
  });

  assert.deepEqual(result, {
    state: "blocked",
    failureCode: "PROVIDER_MANIFEST_GATE_PLAN_CAPACITY_EXCEEDED",
  });
  assert.deepEqual(plans.aggregateBudgets, [1]);
});

test("blocks an implicit completion from adding an absent provider", async () => {
  const [a1, b1] = await Promise.all([cachedPlan(A1), cachedPlan(B1)]);
  const active = await activeFixture([b1]);
  const plans = new MemoryPlanStore([a1, b1]);
  const result = await source({ plans, mirror: active.mirror }).resolveTarget({
    claim: claim({ evidenceDigest: a1.evidenceDigest }),
    currentManifest: active.manifest,
    currentActiveState: active.state,
  });
  assert.deepEqual(result, {
    state: "blocked",
    failureCode: "PROVIDER_MANIFEST_GATE_ADD_REQUIRES_AUTHORIZATION",
  });
  assert.deepEqual(plans.retainedRequests, []);
});

test("adds one absent provider only from an explicit authorized intent", async () => {
  const [a1, b1] = await Promise.all([cachedPlan(A1), cachedPlan(B1)]);
  const active = await activeFixture([b1]);
  const plans = new MemoryPlanStore([a1, b1]);
  const result = await source({ plans, mirror: active.mirror }).resolveTarget({
    claim: claim({
      evidenceDigest: a1.evidenceDigest,
      operation: "add",
      targetProviderReleaseId: a1.providerReleaseId,
      targetCatalogVersionId: a1.catalogVersionId,
    }),
    currentManifest: active.manifest,
    currentActiveState: active.state,
  });
  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  assert.equal(result.target.operation, "add");
  assert.deepEqual(result.target.candidateManifest.providerReferences.find(
    ({ platformKey }) => platformKey === "beta",
  ), active.manifest.providerReferences[0]);
});

test("removes only the explicitly authorized provider without target proof", async () => {
  const [a1, b1] = await Promise.all([cachedPlan(A1), cachedPlan(B1)]);
  const active = await activeFixture([a1, b1]);
  const authorization = "c".repeat(64);
  const result = await source({
    plans: new MemoryPlanStore([a1, b1]),
    mirror: active.mirror,
  }).resolveTarget({
    claim: claim({ evidenceDigest: authorization, operation: "remove" }),
    currentManifest: active.manifest,
    currentActiveState: active.state,
  });
  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  assert.equal(result.target.operation, "remove");
  assert.equal(result.target.proof.targetProviderReleaseId, null);
  assert.deepEqual(
    result.target.candidateManifest.enabledPlatformKeys,
    ["beta"],
  );
});

test("rolls one provider back to its exact cached release and catalog", async () => {
  const [a1, a2, b1] = await Promise.all([
    cachedPlan(A1), cachedPlan(A2), cachedPlan(B1),
  ]);
  const active = await activeFixture([a2, b1]);
  const authorization = "d".repeat(64);
  const result = await source({
    plans: new MemoryPlanStore([a1, a2, b1]),
    mirror: active.mirror,
  }).resolveTarget({
    claim: claim({
      evidenceDigest: authorization,
      operation: "rollback",
      targetProviderReleaseId: a1.providerReleaseId,
      targetCatalogVersionId: a1.catalogVersionId,
    }),
    currentManifest: active.manifest,
    currentActiveState: active.state,
  });
  assert.equal(result.state, "ready");
  if (result.state !== "ready") return;
  assert.equal(result.target.operation, "rollback");
  assert.equal(
    result.target.proof.targetProviderReleaseId,
    a1.providerReleaseId,
  );
  assert.equal(result.target.proof.targetCatalogVersionId, a1.catalogVersionId);
});

test("blocks a stale central claim before reading cached proof", async () => {
  const [a1, b1] = await Promise.all([cachedPlan(A1), cachedPlan(B1)]);
  const active = await activeFixture([b1]);
  const plans = new MemoryPlanStore([a1, b1]);
  const result = await source({
    plans,
    mirror: active.mirror,
    staleClaim: true,
  }).resolveTarget({
    claim: claim({ evidenceDigest: a1.evidenceDigest }),
    currentManifest: active.manifest,
    currentActiveState: active.state,
  });
  assert.deepEqual(result, {
    state: "blocked",
    failureCode: "MANIFEST_GATE_CLAIM_STALE",
  });
  assert.deepEqual(plans.retainedRequests, []);
});

test("blocks an active observation with an extra provider selection", async () => {
  const [a1, a2, b1] = await Promise.all([
    cachedPlan(A1), cachedPlan(A2), cachedPlan(B1),
  ]);
  const active = await activeFixture([a1, b1]);
  const currentActiveState = {
    ...active.state,
    observation: {
      ...active.state.observation!,
      providerSelections: [
        ...active.state.observation!.providerSelections,
        a1.activeObservation,
      ],
    },
  } as ActiveCatalogManifestStateV1;
  const result = await source({
    plans: new MemoryPlanStore([a1, a2, b1]),
    mirror: active.mirror,
  }).resolveTarget({
    claim: claim({ evidenceDigest: a2.evidenceDigest }),
    currentManifest: active.manifest,
    currentActiveState,
  });
  assert.deepEqual(result, {
    state: "blocked",
    failureCode: "PROVIDER_MANIFEST_GATE_CURRENT_STATE_INVALID",
  });
});

test("defers when the immutable target plan has not reached central cache", async () => {
  const a1 = await cachedPlan(A1);
  const active = await activeFixture([a1]);
  const result = await source({
    plans: new MemoryPlanStore([a1]),
    mirror: active.mirror,
  }).resolveTarget({
    claim: claim({ evidenceDigest: "e".repeat(64) }),
    currentManifest: active.manifest,
    currentActiveState: active.state,
  });
  assert.deepEqual(result, {
    state: "deferred",
    failureCode: "PROVIDER_MANIFEST_GATE_PLAN_CACHE_MISSING",
  });
});

test("empty bootstrap fails closed without an approved central configuration", async () => {
  const a1 = await cachedPlan(A1);
  const emptyState = activeCatalogManifestStateV1Schema.parse({
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  });
  const mirror: ManifestActivationMirror = {
    generation: 0n,
    activeManifest: null,
    activeState: null,
    previousManifest: null,
    lastReceiptId: null,
    rowVersion: 1n,
    updatedAt: NOW,
  };
  const result = await source({
    plans: new MemoryPlanStore([a1]),
    mirror,
  }).resolveTarget({
    claim: claim({
      evidenceDigest: a1.evidenceDigest,
      operation: "add",
      targetProviderReleaseId: a1.providerReleaseId,
      targetCatalogVersionId: a1.catalogVersionId,
    }),
    currentManifest: null,
    currentActiveState: emptyState,
  });
  assert.deepEqual(result, {
    state: "blocked",
    failureCode: "MANIFEST_BOOTSTRAP_CONFIGURATION_UNAVAILABLE",
  });
});

test("empty bootstrap accepts only a cryptographically bound approved policy", async () => {
  const confidencePolicy = {
    version: "confidence-v7",
    completeScoreBasisPoints: 9_000,
    partialScoreBasisPoints: 6_000,
    unknownScoreBasisPoints: 2_000,
    limitationPenaltyBasisPoints: 500,
  } as const;
  const confidencePolicyHash =
    await recomputeProviderCatalogReleaseGoverningHashV1({
      kind: "confidence_policy",
      value: confidencePolicy,
    });
  const a1 = await cachedPlan({ ...A1, confidencePolicyHash });
  const vendorBatch = a1.plan.batches.find(({ kind }) => kind === "vendors");
  assert.ok(vendorBatch !== undefined);
  const configuration = approvedPublicCatalogConfigurationV1Schema.parse({
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: "approved-config-v7",
    revision: 7,
    approvedAt: "2026-09-01T19:00:00.000Z",
    staleAfterSeconds: 3_600,
    confidencePolicy,
    publicAssetOrigins: a1.plan.publicAssetOrigins,
    verifiedUsdStablecoins: [],
    categories: [],
    platforms: [{
      platformKey: "alpha",
      vendor: vendorBatch.records[0],
      format: "repack",
      defaultPublicCategoryIds: [],
      categoryMappings: [],
      collectibleTypeMappings: [],
    }],
    repacks: [],
    collectibles: [],
  });
  const configurationHash = await sha256CanonicalJson(
    PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
    configuration,
  );
  const approved: CentralApprovedManifestConfigurationSource = {
    async loadForInitialManifest() {
      return {
        organizationId: ORGANIZATION_ID,
        catalogVersionId: a1.catalogVersionId,
        configuration,
        configurationHash,
        publicChangeSequence: 7n,
      };
    },
  };
  const emptyState = activeCatalogManifestStateV1Schema.parse({
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  });
  const mirror: ManifestActivationMirror = {
    generation: 0n,
    activeManifest: null,
    activeState: null,
    previousManifest: null,
    lastReceiptId: null,
    rowVersion: 1n,
    updatedAt: NOW,
  };
  const request = {
    claim: claim({
      evidenceDigest: a1.evidenceDigest,
      operation: "add",
      targetProviderReleaseId: a1.providerReleaseId,
      targetCatalogVersionId: a1.catalogVersionId,
    }),
    currentManifest: null,
    currentActiveState: emptyState,
  } as const;
  const ready = await source({
    plans: new MemoryPlanStore([a1]),
    mirror,
    initialConfiguration: approved,
  }).resolveTarget(request);
  assert.equal(ready.state, "ready");
  if (ready.state === "ready") {
    assert.equal(
      ready.target.candidateManifest.confidencePolicyVersion,
      "confidence-v7",
    );
    assert.deepEqual(
      ready.target.candidateManifest.sharedConfigurationEpoch,
      a1.plan.sharedConfigurationEpoch,
    );
  }

  const invalid = await source({
    plans: new MemoryPlanStore([a1]),
    mirror,
    initialConfiguration: {
      async loadForInitialManifest() {
        return {
          organizationId: ORGANIZATION_ID,
          catalogVersionId: a1.catalogVersionId,
          configuration,
          configurationHash: "0".repeat(64),
          publicChangeSequence: 7n,
        };
      },
    },
  }).resolveTarget(request);
  assert.deepEqual(invalid, {
    state: "blocked",
    failureCode: "MANIFEST_BOOTSTRAP_CONFIGURATION_INVALID",
  });
});

test("signed-state resolution returns only the exact central mirror", async () => {
  const [a1, b1] = await Promise.all([cachedPlan(A1), cachedPlan(B1)]);
  const active = await activeFixture([a1, b1]);
  const proofSource = source({
    plans: new MemoryPlanStore([a1, b1]),
    mirror: active.mirror,
  });
  assert.deepEqual(await proofSource.resolveSignedState({
    reason: "cas_reconciliation",
    activeState: active.state,
  }), {
    state: "ready",
    activeManifest: active.manifest,
    previousManifest: null,
  });

  const mismatched = activeCatalogManifestStateV1Schema.parse({
    ...active.state,
    activeManifest: {
      ...active.state.activeManifest!,
      manifestFingerprint: "f".repeat(64),
    },
  });
  assert.deepEqual(await proofSource.resolveSignedState({
    reason: "cas_reconciliation",
    activeState: mismatched,
  }), {
    state: "blocked",
    failureCode: "MANIFEST_SIGNED_STATE_MIRROR_MISMATCH",
  });
});

test("signed-state resolution accepts only the exact empty bootstrap", async () => {
  const emptyState = activeCatalogManifestStateV1Schema.parse({
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  });
  const result = await source({
    plans: new MemoryPlanStore([]),
    mirror: {
      generation: 0n,
      activeManifest: null,
      activeState: null,
      previousManifest: null,
      lastReceiptId: null,
      rowVersion: 1n,
      updatedAt: NOW,
    },
  }).resolveSignedState({ reason: "bootstrap", activeState: emptyState });
  assert.deepEqual(result, {
    state: "ready",
    activeManifest: null,
    previousManifest: null,
  });
});
