import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  PromotionJobLivenessEvaluatorStateRecord,
  PromotionJobEvaluatorWatchdogEvidenceRecord,
} from "@packscout/database";
import {
  DISTRIBUTED_PROMOTION_EXTERNAL_EVIDENCE_REMAINING,
  DistributedPromotionCutoverPreflightError,
  type DistributedPromotionManifestPlanCacheCoverage,
  distributedPromotionEntrypointArtifactDigest,
  readDistributedPromotionCutoverPreflightConfiguration,
  runDistributedPromotionCutoverPreflight,
} from "./distributed-promotion-cutover-preflight.ts";

const checkedAt = new Date("2026-09-01T12:03:30.000Z");

function environment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PACKSCOUT_DISTRIBUTED_CUTOVER_ENVIRONMENT: "preproduction",
    PACKSCOUT_DISTRIBUTED_CUTOVER_PREFLIGHT_DATABASE_URL:
      "postgresql://preflight-read-only:secret@central.example/packscout",
    PACKSCOUT_DISTRIBUTED_PROMOTION_MODE: "split",
    PACKSCOUT_DISTRIBUTED_CUTOVER_LEGACY_COMPOSITE_STATE: "stopped",
    PACKSCOUT_DISTRIBUTED_CUTOVER_LEGACY_ATTEMPTS_STATE: "drained",
    PACKSCOUT_DISTRIBUTED_CUTOVER_LEGACY_STOPPED_AT:
      "2026-09-01T12:00:00.000Z",
    PACKSCOUT_DISTRIBUTED_CUTOVER_SPLIT_ACTIVATED_AT:
      "2026-09-01T12:01:00.000Z",
    PACKSCOUT_DISTRIBUTED_CUTOVER_DETECTOR_ARMED_AT:
      "2026-09-01T12:03:15.000Z",
    PACKSCOUT_DISTRIBUTED_CUTOVER_DETECTOR_ARM_PROOF_SHA256: "6".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_COMMIT: "a".repeat(40),
    PACKSCOUT_DISTRIBUTED_CUTOVER_LEGACY_STOP_PROOF_SHA256: "1".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_DEPLOYMENT_CONFIG_SHA256: "2".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_LIVENESS_DEPLOYMENT_STATE:
      "separate_dynamic_central_routed",
    PACKSCOUT_DISTRIBUTED_CUTOVER_RELAY_DEPLOYMENT_STATE:
      "separate_central_observer",
    PACKSCOUT_DISTRIBUTED_CUTOVER_WATCHDOG_DEPLOYMENT_STATE:
      "separate_dedicated_read_only",
    PACKSCOUT_DISTRIBUTED_CUTOVER_SYSTEM_CONDITION_SINK_STATE:
      "authenticated_https_system_only",
    PACKSCOUT_DISTRIBUTED_CUTOVER_LIVENESS_DEPLOYMENT_PROOF_SHA256:
      "8".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_RELAY_DEPLOYMENT_PROOF_SHA256:
      "f".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_WATCHDOG_DEPLOYMENT_PROOF_SHA256:
      "9".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_SYSTEM_CONDITION_SINK_PROOF_SHA256:
      "c".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_ENTRYPOINT_SET_SHA256:
      "3".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_ENTRYPOINT_SHA256: "4".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_RELAY_ENTRYPOINT_SHA256: "e".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_LIVENESS_ENTRYPOINT_SHA256: "7".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_WATCHDOG_ENTRYPOINT_SHA256: "5".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_SYSTEM_CONDITION_SINK_SHA256:
      "d".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_ROSTER_SHA256: "b".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_ACTIVE_MANIFEST_FINGERPRINT:
      "0".repeat(64),
    PACKSCOUT_DISTRIBUTED_CUTOVER_PREVIOUS_MANIFEST_FINGERPRINT: "none",
    PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_ENTRYPOINT:
      "start:provider-promotion-job:production",
    PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_EXECUTABLE:
      "apps/worker/src/provider-promotion-job-main.ts",
    PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_SCHEDULE_EXECUTABLE:
      "apps/worker/src/provider-promotion-schedule-command-main.ts",
    PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_SCHEDULE_ACTIVATE_ENTRYPOINT:
      "activate:provider-promotion-schedule:production",
    PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_SCHEDULE_PAUSE_ENTRYPOINT:
      "pause:provider-promotion-schedule:production",
    PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_ENTRYPOINT:
      "start:manifest-reconciliation-job:production",
    PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_EXECUTABLE:
      "apps/worker/src/manifest-reconciliation-job-main.ts",
    PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_SCHEDULE_EXECUTABLE:
      "apps/worker/src/manifest-promotion-schedule-command-main.ts",
    PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_SCHEDULE_ACTIVATE_ENTRYPOINT:
      "activate:manifest-reconciliation-schedule:production",
    PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_SCHEDULE_PAUSE_ENTRYPOINT:
      "pause:manifest-reconciliation-schedule:production",
    PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_OPERATION_EXECUTABLE:
      "apps/worker/src/manifest-gate-operation-command-main.ts",
    PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_OPERATION_ENTRYPOINT:
      "authorize:manifest-gate-operation:production",
    PACKSCOUT_DISTRIBUTED_CUTOVER_RELAY_ENTRYPOINT:
      "start:provider-activity-relay:production",
    PACKSCOUT_DISTRIBUTED_CUTOVER_RELAY_EXECUTABLE:
      "apps/worker/src/provider-activity-relay-main.ts",
    PACKSCOUT_DISTRIBUTED_CUTOVER_LIVENESS_ENTRYPOINT:
      "start:promotion-job-liveness-evaluator:production",
    PACKSCOUT_DISTRIBUTED_CUTOVER_LIVENESS_EXECUTABLE:
      "apps/worker/src/promotion-job-liveness-main.ts",
    PACKSCOUT_DISTRIBUTED_CUTOVER_WATCHDOG_ENTRYPOINT:
      "run:promotion-job-evaluator-watchdog:production",
    PACKSCOUT_DISTRIBUTED_CUTOVER_WATCHDOG_EXECUTABLE:
      "apps/worker/src/promotion-job-evaluator-watchdog-cli.ts",
    PACKSCOUT_DISTRIBUTED_CUTOVER_SYSTEM_CONDITION_SINK_ADAPTER:
      "apps/worker/src/promotion-job-system-condition-webhook.ts",
    ...overrides,
  };
}

function buildEvidence(overrides: Partial<Readonly<{
  currentCommit: string;
  providerEntrypointSetDigest: string;
  manifestEntrypointDigest: string;
  relayEntrypointDigest: string;
  livenessEntrypointDigest: string;
  watchdogEntrypointDigest: string;
  systemConditionSinkDigest: string;
}>> = {}) {
  return {
    currentCommit: "a".repeat(40),
    providerEntrypointSetDigest: "3".repeat(64),
    manifestEntrypointDigest: "4".repeat(64),
    relayEntrypointDigest: "e".repeat(64),
    livenessEntrypointDigest: "7".repeat(64),
    watchdogEntrypointDigest: "5".repeat(64),
    systemConditionSinkDigest: "d".repeat(64),
    ...overrides,
  };
}

function evidence(
  overrides: Partial<PromotionJobEvaluatorWatchdogEvidenceRecord> = {},
): PromotionJobEvaluatorWatchdogEvidenceRecord {
  const success = new Date("2026-09-01T12:03:00.001Z");
  return {
    lifecycle: "active",
    evaluatorEpoch: 1n,
    cadenceSeconds: 60,
    baselineAt: new Date("2026-09-01T12:00:00.000Z"),
    lastSuccessfulWindowIndex: 3n,
    lastSuccessfulEvaluationAt: success,
    evaluatedThrough: success,
    rosterDigest: "b".repeat(64),
    expectedCount: 4,
    reachableCount: 4,
    unavailableCount: 0,
    ...overrides,
  };
}

function source(
  record: PromotionJobEvaluatorWatchdogEvidenceRecord,
  stateOverrides: Partial<PromotionJobLivenessEvaluatorStateRecord> = {},
  cacheOverrides: Partial<DistributedPromotionManifestPlanCacheCoverage> = {},
) {
  return {
    async readWatchdogEvidence() {
      return record;
    },
    async readEvaluatorState(): Promise<PromotionJobLivenessEvaluatorStateRecord> {
      return {
        state: "current",
        lifecycle: record.lifecycle,
        evaluatorEpoch: record.evaluatorEpoch,
        cadenceSeconds: record.cadenceSeconds,
        baselineAt: record.baselineAt,
        activatedAt: record.lifecycle === "pending_activation"
          ? null
          : new Date("2026-09-01T12:03:00.001Z"),
        pausedAt: record.lifecycle === "paused"
          ? new Date("2026-09-01T12:03:00.001Z")
          : null,
        lastSuccessfulWindowIndex: record.lastSuccessfulWindowIndex,
        lastSuccessfulEvaluationAt: record.lastSuccessfulEvaluationAt,
        evaluatedThrough: record.evaluatedThrough,
        rosterVersion: record.rosterDigest === null ? null : 1n,
        rosterHighWater: record.rosterDigest === null ? null : 2n,
        rosterDigest: record.rosterDigest,
        expectedCount: record.expectedCount,
        reachableCount: record.reachableCount,
        unavailableCount: record.unavailableCount,
        healthyCount: record.expectedCount,
        overdueCount: record.expectedCount === null ? null : 0,
        alertingCount: record.expectedCount === null ? null : 0,
        manifestEvaluated: record.expectedCount === null ? null : true,
        lastFailureCode: null,
        ...stateOverrides,
      };
    },
    async readManifestPlanCacheCoverage(): Promise<
      DistributedPromotionManifestPlanCacheCoverage
    > {
      return {
        mirrorStable: true,
        mirrorGeneration: 7n,
        activeManifestFingerprint: "0".repeat(64),
        previousManifestFingerprint: null,
        activeReferenceCount: 3,
        cachedActiveReferenceCount: 3,
        previousReferenceCount: 0,
        cachedPreviousReferenceCount: 0,
        ...cacheOverrides,
      };
    },
  };
}

function hasCode(code: DistributedPromotionCutoverPreflightError["code"]) {
  return (error: unknown) =>
    error instanceof DistributedPromotionCutoverPreflightError
    && error.code === code;
}

test("preflight binds stopped legacy authority, split entrypoints, and roster plus one", async () => {
  const result = await runDistributedPromotionCutoverPreflight({
    configuration:
      readDistributedPromotionCutoverPreflightConfiguration(environment()),
    build: buildEvidence(),
    evidence: source(evidence()),
    now: () => checkedAt,
  });

  assert.equal(result.status, "preflight_passed");
  assert.equal(result.authoritySwitch.legacyComposite, "stopped_attested");
  assert.equal(result.authoritySwitch.distributedMode, "split");
  assert.deepEqual([
    result.evaluator.lifecycle,
    result.evaluator.health,
    result.externalDetector.state,
    result.externalDetector.armedAfterSuccessfulCycle,
    result.externalDetector.armedAt,
    result.externalDetector.evidenceSource,
    result.externalDetector.armProofDigest,
    result.evaluator.expectedJobCount,
    result.evaluator.eligibleProviderCount,
    result.evaluator.unavailableJobCount,
  ], [
    "active",
    "healthy",
    "armed_attested",
    true,
    "2026-09-01T12:03:15.000Z",
    "external_attestation",
    "6".repeat(64),
    4,
    3,
    0,
  ]);
  assert.deepEqual(
    result.externalEvidence.remaining,
    DISTRIBUTED_PROMOTION_EXTERNAL_EVIDENCE_REMAINING,
  );
  assert.deepEqual(result.manifestPlanCache, {
    state: "complete",
    mirrorGeneration: "7",
    activeManifestFingerprint: "0".repeat(64),
    previousManifestFingerprint: null,
    activeReferenceCount: 3,
    cachedActiveReferenceCount: 3,
    previousReferenceCount: 0,
    cachedPreviousReferenceCount: 0,
  });
  assert.deepEqual(result.runtimePrerequisites, {
    providerActivityRelay: {
      deployment: "separate_attested",
      authority: "central_observer_bounded_provider_routing",
      pollMilliseconds: 1_000,
      proofDigest: "f".repeat(64),
    },
    livenessEvaluator: {
      deployment: "separate_attested",
      authority: "central_dynamic_roster_bounded_provider_routing",
      cadenceSeconds: 60,
      proofDigest: "8".repeat(64),
    },
    evaluatorWatchdog: {
      deployment: "separate_attested",
      authority: "dedicated_read_only_central",
      alertingExitCode: 2,
      unavailableExitCode: 1,
      proofDigest: "9".repeat(64),
    },
    systemConditionSink: {
      transport: "authenticated_https_attested",
      scope: "manifest_and_evaluator_system_only",
      proofDigest: "c".repeat(64),
      adapterDigest: "d".repeat(64),
    },
  });
  assert.deepEqual(result.authoritySwitch.entrypoints, {
    providerPublicationExecutable:
      "apps/worker/src/provider-promotion-job-main.ts",
    providerPublicationScript: "start:provider-promotion-job:production",
    providerScheduleCommandExecutable:
      "apps/worker/src/provider-promotion-schedule-command-main.ts",
    providerScheduleActivateScript:
      "activate:provider-promotion-schedule:production",
    providerSchedulePauseScript:
      "pause:provider-promotion-schedule:production",
    manifestReconciliationExecutable:
      "apps/worker/src/manifest-reconciliation-job-main.ts",
    manifestReconciliationScript:
      "start:manifest-reconciliation-job:production",
    manifestScheduleCommandExecutable:
      "apps/worker/src/manifest-promotion-schedule-command-main.ts",
    manifestScheduleActivateScript:
      "activate:manifest-reconciliation-schedule:production",
    manifestSchedulePauseScript:
      "pause:manifest-reconciliation-schedule:production",
    manifestGateOperationExecutable:
      "apps/worker/src/manifest-gate-operation-command-main.ts",
    manifestGateOperationScript:
      "authorize:manifest-gate-operation:production",
    providerActivityRelayExecutable:
      "apps/worker/src/provider-activity-relay-main.ts",
    providerActivityRelayScript: "start:provider-activity-relay:production",
    livenessEvaluationExecutable:
      "apps/worker/src/promotion-job-liveness-main.ts",
    livenessEvaluationScript:
      "start:promotion-job-liveness-evaluator:production",
    evaluatorWatchdogExecutable:
      "apps/worker/src/promotion-job-evaluator-watchdog-cli.ts",
    evaluatorWatchdogScript:
      "run:promotion-job-evaluator-watchdog:production",
    systemConditionSinkAdapter:
      "apps/worker/src/promotion-job-system-condition-webhook.ts",
  });
  assert.equal(
    result.externalEvidence.remaining.includes(
      "TWENTY_LIVE_LATENCY_SAMPLES_PER_ACTIVE_PROVIDER",
    ),
    true,
  );
});

test("zero-provider roster remains dynamic and still proves the manifest job", async () => {
  const result = await runDistributedPromotionCutoverPreflight({
    configuration:
      readDistributedPromotionCutoverPreflightConfiguration(environment()),
    build: buildEvidence(),
    evidence: source(evidence({ expectedCount: 1, reachableCount: 1 })),
    now: () => checkedAt,
  });
  assert.deepEqual(
    [result.evaluator.expectedJobCount, result.evaluator.eligibleProviderCount],
    [1, 0],
  );
});

test("preflight refuses pending paused unhealthy or partial evaluator evidence", async () => {
  const configuration =
    readDistributedPromotionCutoverPreflightConfiguration(environment());
  const cases: readonly [
    PromotionJobEvaluatorWatchdogEvidenceRecord,
    DistributedPromotionCutoverPreflightError["code"],
    Date,
  ][] = [
    [{
      lifecycle: "pending_activation",
      evaluatorEpoch: 0n,
      cadenceSeconds: 60,
      baselineAt: null,
      lastSuccessfulWindowIndex: null,
      lastSuccessfulEvaluationAt: null,
      evaluatedThrough: null,
      rosterDigest: null,
      expectedCount: null,
      reachableCount: null,
      unavailableCount: null,
    }, "DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_NOT_READY", checkedAt],
    [evidence({ lifecycle: "paused" }),
      "DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_NOT_READY", checkedAt],
    [evidence({ reachableCount: 3, unavailableCount: 1 }),
      "DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_PARTIAL", checkedAt],
    [evidence(), "DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_UNHEALTHY",
      new Date("2026-09-01T12:06:00.001Z")],
  ];
  for (const [record, code, now] of cases) {
    await assert.rejects(
      runDistributedPromotionCutoverPreflight({
        configuration,
        build: buildEvidence(),
        evidence: source(record),
        now: () => now,
      }),
      hasCode(code),
    );
  }
});

test("configuration refuses role overlap, legacy settings, drift, and overlap", () => {
  for (const [overrides, code] of [
    [{ PACKSCOUT_PROMOTION_MANIFEST_KEY_ID: "mutating-key" },
      "DISTRIBUTED_PROMOTION_CUTOVER_MUTATION_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_CATALOG_PROMOTION_POLL_MS: "60000" },
      "DISTRIBUTED_PROMOTION_CUTOVER_MUTATION_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_PROVIDER_DATABASE_URL: "postgresql://provider.invalid/db" },
      "DISTRIBUTED_PROMOTION_CUTOVER_MUTATION_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_TOKEN_BASE64: "secret" },
      "DISTRIBUTED_PROMOTION_CUTOVER_MUTATION_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_PROMOTION_MANIFEST_PROOF_TOKEN_BASE64: "secret" },
      "DISTRIBUTED_PROMOTION_CUTOVER_MUTATION_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_COMMAND_ATTESTATION: "signed" },
      "DISTRIBUTED_PROMOTION_CUTOVER_MUTATION_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PRIVATE_KEY_PEM: "secret" },
      "DISTRIBUTED_PROMOTION_CUTOVER_MUTATION_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_DATABASE_URL:
      "postgresql://schedule.invalid/db" },
    "DISTRIBUTED_PROMOTION_CUTOVER_MUTATION_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION: "rollback" },
      "DISTRIBUTED_PROMOTION_CUTOVER_MUTATION_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://evaluator.invalid/db" },
      "DISTRIBUTED_PROMOTION_CUTOVER_RUNTIME_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: "secret" },
      "DISTRIBUTED_PROMOTION_CUTOVER_RUNTIME_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_PROMOTION_RELAY_RUN_MODE: "daemon" },
      "DISTRIBUTED_PROMOTION_CUTOVER_RUNTIME_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_PROMOTION_EVALUATOR_WATCHDOG_DATABASE_URL:
      "postgresql://watchdog.invalid/db" },
    "DISTRIBUTED_PROMOTION_CUTOVER_RUNTIME_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_TOKEN_BASE64: "secret" },
      "DISTRIBUTED_PROMOTION_CUTOVER_RUNTIME_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PUBLIC_KEY_PEM: "public" },
      "DISTRIBUTED_PROMOTION_CUTOVER_RUNTIME_AUTHORITY_PRESENT"],
    [{ PACKSCOUT_DISTRIBUTED_CUTOVER_WATCHDOG_DEPLOYMENT_STATE:
      "shared_with_evaluator" },
    "DISTRIBUTED_PROMOTION_CUTOVER_DEPLOYMENT_ATTESTATION_INVALID"],
    [{ PACKSCOUT_DISTRIBUTED_CUTOVER_RELAY_DEPLOYMENT_STATE:
      "shared_with_manifest" },
    "DISTRIBUTED_PROMOTION_CUTOVER_DEPLOYMENT_ATTESTATION_INVALID"],
    [{ PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_ENTRYPOINT: "legacy-loop" },
      "DISTRIBUTED_PROMOTION_CUTOVER_ENTRYPOINT_INVALID"],
    [{ PACKSCOUT_DISTRIBUTED_CUTOVER_WATCHDOG_EXECUTABLE:
      "apps/worker/src/promotion-job-liveness-main.ts" },
    "DISTRIBUTED_PROMOTION_CUTOVER_ENTRYPOINT_INVALID"],
    [{ PACKSCOUT_DISTRIBUTED_CUTOVER_SPLIT_ACTIVATED_AT:
      "2026-09-01T11:59:59.999Z" },
    "DISTRIBUTED_PROMOTION_CUTOVER_TIMELINE_INVALID"],
    [{ PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_ENTRYPOINT_SHA256:
      "3".repeat(64) }, "DISTRIBUTED_PROMOTION_CUTOVER_DIGEST_INVALID"],
    [{ PACKSCOUT_DISTRIBUTED_CUTOVER_SYSTEM_CONDITION_SINK_PROOF_SHA256:
      "8".repeat(64) }, "DISTRIBUTED_PROMOTION_CUTOVER_DIGEST_INVALID"],
  ] as const) {
    assert.throws(
      () => readDistributedPromotionCutoverPreflightConfiguration(
        environment(overrides),
      ),
      hasCode(code),
    );
  }
});

test("detector arm attestation must follow the successful roster cycle", async () => {
  const configuration = readDistributedPromotionCutoverPreflightConfiguration(
    environment({
      PACKSCOUT_DISTRIBUTED_CUTOVER_DETECTOR_ARMED_AT:
        "2026-09-01T12:02:59.999Z",
    }),
  );
  await assert.rejects(runDistributedPromotionCutoverPreflight({
    configuration,
    build: buildEvidence(),
    evidence: source(evidence()),
    now: () => checkedAt,
  }), hasCode("DISTRIBUTED_PROMOTION_CUTOVER_TIMELINE_INVALID"));
});

test("successful evaluator evidence must follow evaluator activation", async () => {
  const configuration = readDistributedPromotionCutoverPreflightConfiguration(
    environment(),
  );
  await assert.rejects(runDistributedPromotionCutoverPreflight({
    configuration,
    build: buildEvidence(),
    evidence: source(evidence({
      lastSuccessfulEvaluationAt: new Date("2026-09-01T12:02:00.000Z"),
      evaluatedThrough: new Date("2026-09-01T12:02:00.000Z"),
    }), {
      activatedAt: new Date("2026-09-01T12:03:00.000Z"),
      lastSuccessfulEvaluationAt: new Date("2026-09-01T12:02:00.000Z"),
      evaluatedThrough: new Date("2026-09-01T12:02:00.000Z"),
    }),
    now: () => checkedAt,
  }), hasCode("DISTRIBUTED_PROMOTION_CUTOVER_TIMELINE_INVALID"));
});

test("preflight binds the claimed commit and exact entrypoint artifacts", async () => {
  const configuration = readDistributedPromotionCutoverPreflightConfiguration(
    environment(),
  );
  for (const build of [
    buildEvidence({ currentCommit: "f".repeat(40) }),
    buildEvidence({ providerEntrypointSetDigest: "e".repeat(64) }),
    buildEvidence({ manifestEntrypointDigest: "d".repeat(64) }),
    buildEvidence({ relayEntrypointDigest: "a".repeat(64) }),
    buildEvidence({ livenessEntrypointDigest: "9".repeat(64) }),
    buildEvidence({ watchdogEntrypointDigest: "c".repeat(64) }),
    buildEvidence({ systemConditionSinkDigest: "e".repeat(64) }),
  ]) {
    await assert.rejects(runDistributedPromotionCutoverPreflight({
      configuration,
      build,
      evidence: source(evidence()),
      now: () => checkedAt,
    }), hasCode("DISTRIBUTED_PROMOTION_CUTOVER_BUILD_MISMATCH"));
  }
});

test("entrypoint artifact digest binds ordered names and exact contents", () => {
  const original = distributedPromotionEntrypointArtifactDigest([
    { name: "package-script", content: "tsx src/job.ts" },
    { name: "source", content: "export const version = 1;" },
  ]);
  const changed = distributedPromotionEntrypointArtifactDigest([
    { name: "package-script", content: "tsx src/job.ts" },
    { name: "source", content: "export const version = 2;" },
  ]);
  assert.match(original, /^[0-9a-f]{64}$/u);
  assert.notEqual(changed, original);
  assert.throws(() => distributedPromotionEntrypointArtifactDigest([
    { name: "source", content: "one" },
    { name: "package-script", content: "two" },
  ]), TypeError);
});

test("preflight CLI uses its own read-only URL and binds every runtime artifact", async () => {
  const source = await readFile(new URL(
    "../../../scripts/preproduction/preflight-distributed-promotion-cutover.mts",
    import.meta.url,
  ), "utf8");
  assert.match(
    source,
    /PACKSCOUT_DISTRIBUTED_CUTOVER_PREFLIGHT_DATABASE_URL/u,
  );
  assert.doesNotMatch(
    source,
    /environment\.PACKSCOUT_CENTRAL_DATABASE_URL/u,
  );
  for (const exactArtifact of [
    "apps/worker/src/promotion-job-liveness-main.ts",
    "apps/worker/src/provider-activity-relay-main.ts",
    "apps/worker/src/provider-promotion-schedule-command-main.ts",
    "apps/worker/src/manifest-promotion-schedule-command-main.ts",
    "apps/worker/src/manifest-gate-operation-command-main.ts",
    "apps/worker/src/promotion-job-evaluator-watchdog-cli.ts",
    "apps/worker/src/promotion-job-system-condition-webhook.ts",
    "scripts/preproduction/preflight-distributed-promotion-cutover.mts",
  ]) assert.match(source, new RegExp(exactArtifact, "u"), exactArtifact);
});

test("preflight binds the activated roster and refuses unhealthy job rows", async () => {
  const configuration = readDistributedPromotionCutoverPreflightConfiguration(
    environment(),
  );
  await assert.rejects(runDistributedPromotionCutoverPreflight({
    configuration,
    build: buildEvidence(),
    evidence: source(evidence({ rosterDigest: "c".repeat(64) })),
    now: () => checkedAt,
  }), hasCode("DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_NOT_READY"));

  await assert.rejects(runDistributedPromotionCutoverPreflight({
    configuration,
    build: buildEvidence(),
    evidence: source(evidence(), {
      healthyCount: 3,
      overdueCount: 1,
    }),
    now: () => checkedAt,
  }), hasCode("DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_UNHEALTHY"));
});

test("preflight refuses incomplete or unstable manifest plan cache coverage", async () => {
  const configuration = readDistributedPromotionCutoverPreflightConfiguration(
    environment(),
  );
  for (const cache of [
    { cachedActiveReferenceCount: 2 },
    { mirrorStable: false },
    { activeManifestFingerprint: "f".repeat(64) },
    {
      previousManifestFingerprint: "1".repeat(64),
      previousReferenceCount: 1,
      cachedPreviousReferenceCount: 1,
    },
  ] satisfies readonly Partial<DistributedPromotionManifestPlanCacheCoverage>[]) {
    await assert.rejects(runDistributedPromotionCutoverPreflight({
      configuration,
      build: buildEvidence(),
      evidence: source(evidence(), {}, cache),
      now: () => checkedAt,
    }), hasCode("DISTRIBUTED_PROMOTION_CUTOVER_MANIFEST_CACHE_INCOMPLETE"));
  }
});

test("preflight binds an attested previous manifest with complete cache", async () => {
  const previousFingerprint = "1".repeat(64);
  const result = await runDistributedPromotionCutoverPreflight({
    configuration: readDistributedPromotionCutoverPreflightConfiguration(
      environment({
        PACKSCOUT_DISTRIBUTED_CUTOVER_PREVIOUS_MANIFEST_FINGERPRINT:
          previousFingerprint,
      }),
    ),
    build: buildEvidence(),
    evidence: source(evidence(), {}, {
      previousManifestFingerprint: previousFingerprint,
      previousReferenceCount: 2,
      cachedPreviousReferenceCount: 2,
    }),
    now: () => checkedAt,
  });
  assert.deepEqual([
    result.manifestPlanCache.previousManifestFingerprint,
    result.manifestPlanCache.previousReferenceCount,
    result.manifestPlanCache.cachedPreviousReferenceCount,
  ], [previousFingerprint, 2, 2]);
});

test("preflight artifact is redacted and explicitly not live certification", async () => {
  const result = await runDistributedPromotionCutoverPreflight({
    configuration:
      readDistributedPromotionCutoverPreflightConfiguration(environment()),
    build: buildEvidence(),
    evidence: source(evidence()),
    now: () => checkedAt,
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("preflight_passed"), true);
  assert.equal(serialized.includes("certificationStatus"), false);
  assert.equal(serialized.includes("postgresql://"), false);
  assert.equal(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu
      .test(serialized),
    false,
  );
  for (const protectedToken of [
    "organizationId",
    "providerId",
    "databaseTarget",
    "credential",
    "claimToken",
    "requestBody",
    "responseBody",
    "receiptBody",
  ]) assert.equal(serialized.includes(protectedToken), false, protectedToken);
});
