import { createHash } from "node:crypto";
import type {
  PromotionJobLivenessEvaluatorStateRecord,
  PromotionJobEvaluatorWatchdogEvidenceRecord,
} from "@packscout/database";
import {
  evaluatePromotionJobEvaluatorWatchdog,
  promotionJobEvaluatorWatchdogResponse,
} from "@packscout/services";
import type {
  PromotionJobEvaluatorWatchdogEvidenceSource,
} from "./promotion-job-evaluator-watchdog-composition.ts";

export const DISTRIBUTED_PROMOTION_CUTOVER_PREFLIGHT_SCHEMA =
  "packscout.distributed-promotion-cutover-preflight.v1";

export const DISTRIBUTED_PROMOTION_ENTRYPOINTS = Object.freeze({
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

export const DISTRIBUTED_PROMOTION_RUNTIME_PREREQUISITES = Object.freeze({
  providerActivityRelay: Object.freeze({
    deployment: "separate_attested" as const,
    authority: "central_observer_bounded_provider_routing" as const,
    pollMilliseconds: 1_000 as const,
  }),
  livenessEvaluator: Object.freeze({
    deployment: "separate_attested" as const,
    authority: "central_dynamic_roster_bounded_provider_routing" as const,
    cadenceSeconds: 60 as const,
  }),
  evaluatorWatchdog: Object.freeze({
    deployment: "separate_attested" as const,
    authority: "dedicated_read_only_central" as const,
    alertingExitCode: 2 as const,
    unavailableExitCode: 1 as const,
  }),
  systemConditionSink: Object.freeze({
    transport: "authenticated_https_attested" as const,
    scope: "manifest_and_evaluator_system_only" as const,
  }),
});

export const DISTRIBUTED_PROMOTION_EXTERNAL_EVIDENCE_REMAINING = Object.freeze([
  "INDEPENDENT_DETECTOR_LIVE_ARM_AND_RECOVERY",
  "ONE_PROVIDER_THEN_MANIFEST_LIVE_CANARY",
  "TWO_PROVIDER_OUTAGE_ISOLATION",
  "ADD_ADVANCE_REMOVE_ROLLBACK_FAILURE_MATRIX",
  "TRIGGER_OVERLAP_CONTINUATION_AND_REPLAY_MATRIX",
  "TWENTY_LIVE_LATENCY_SAMPLES_PER_ACTIVE_PROVIDER",
  "ADMIN_PUBLIC_SECURITY_AND_REDACTION_REGRESSIONS",
  "EXACT_COMMIT_FRAMEWORK_VERIFIER",
] as const);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const MUTATING_OR_LEGACY_AUTHORITY_KEYS = Object.freeze([
  "PACKSCOUT_DATABASE_URL",
  "PACKSCOUT_CATALOG_PLATFORM_KEY",
  "PACKSCOUT_CATALOG_PROVIDER_CREDENTIALS",
  "PACKSCOUT_CATALOG_PROVIDER_KEY_ID",
  "PACKSCOUT_CATALOG_PROVIDER_SECRET_BASE64",
  "PACKSCOUT_CATALOG_PROVIDER_AUTHORITY_VERSION",
  "PACKSCOUT_CATALOG_MANIFEST_PUBLISH_KEY_ID",
  "PACKSCOUT_CATALOG_MANIFEST_PUBLISH_SECRET_BASE64",
  "PACKSCOUT_CATALOG_MANIFEST_PUBLISH_AUTHORITY_VERSION",
  "PACKSCOUT_CATALOG_MANIFEST_CLEAR_KEY_ID",
  "PACKSCOUT_CATALOG_MANIFEST_CLEAR_SECRET_BASE64",
  "PACKSCOUT_CATALOG_MANIFEST_CLEAR_AUTHORITY_VERSION",
  "PACKSCOUT_CATALOG_PROMOTION_POLL_MS",
  "PACKSCOUT_CONVEX_PUBLICATION_KEY_ID",
  "PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64",
  "PACKSCOUT_CONVEX_PUBLICATION_BASE_URL",
  "PACKSCOUT_CATALOG_DEPLOYMENT_KEY",
  "PACKSCOUT_PROVIDER_DATABASE_URL",
  "PACKSCOUT_PROVIDER_DATABASE_LISTEN_URL",
  "PACKSCOUT_PROMOTION_PROVIDER_ID",
  "PACKSCOUT_PROMOTION_PROVIDER_KEY_ID",
  "PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION",
  "PACKSCOUT_PROMOTION_MANIFEST_KEY_ID",
  "PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_MANIFEST_AUTHORITY_VERSION",
  "PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_BASE_URL",
  "PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_TOKEN_BASE64",
  "PACKSCOUT_PROMOTION_MANIFEST_PROOF_BASE_URL",
  "PACKSCOUT_PROMOTION_MANIFEST_PROOF_TOKEN_BASE64",
  "PACKSCOUT_PROMOTION_MANUAL_COMMAND_ID",
  "PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_COMMAND_ATTESTATION",
  "PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PRIVATE_KEY_PEM",
  "PACKSCOUT_PROMOTION_CONTINUATION_GENERATION",
  "PACKSCOUT_PROMOTION_RUN_MODE",
  "PACKSCOUT_PROMOTION_WORKER_ID",
  "PACKSCOUT_PROMOTION_POLL_MS",
  "PACKSCOUT_PROMOTION_SCHEDULE_COMMAND_ENVIRONMENT",
  "PACKSCOUT_PROMOTION_SCHEDULE_COMMAND_ACTION",
  "PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_LIFECYCLE",
  "PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_EPOCH",
  "PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_BASELINE_AT",
  "PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_ACTIVATED_AT",
  "PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_PAUSED_AT",
  "PACKSCOUT_PROMOTION_SCHEDULE_EFFECTIVE_AT",
  "PACKSCOUT_PROMOTION_SCHEDULE_ACTIVATION_BASELINE_AT",
  "PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_DATABASE_URL",
  "PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_PROVIDER_ID",
  "PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_PROVIDER_KEY",
  "PACKSCOUT_MANIFEST_RECONCILIATION_SCHEDULE_DATABASE_URL",
  "PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION",
  "PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_PROVIDER_ID",
  "PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_PROVIDER_RELEASE_ID",
  "PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_CATALOG_VERSION_ID",
  "PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_OPERATOR_ID",
  "PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_AUTHORIZATION_SHA256",
  "PACKSCOUT_DISTRIBUTED_MANIFEST_OPERATION_REQUESTED_AT",
]);
const LIVENESS_RUNTIME_AUTHORITY_KEYS = Object.freeze([
  "PACKSCOUT_CENTRAL_DATABASE_URL",
  "PACKSCOUT_CENTRAL_DATABASE_LISTEN_URL",
  "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
  "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION",
  "PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS",
  "PACKSCOUT_PROMOTION_LIVENESS_RUN_MODE",
  "PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_CONCURRENCY",
  "PACKSCOUT_PROMOTION_LIVENESS_MAXIMUM_PROVIDERS",
  "PACKSCOUT_PROMOTION_LIVENESS_ROSTER_PAGE_SIZE",
  "PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_ALLOWED_PORTS",
  "PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_ALLOWED_SSL_MODES",
  "PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_CONNECTION_LIMIT",
  "PACKSCOUT_PROMOTION_LIVENESS_MAXIMUM_CACHED_PROVIDERS",
  "PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_TIMEOUT_MS",
  "PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_CLOSE_TIMEOUT_MS",
  "PACKSCOUT_PROMOTION_LIVENESS_DELIVERY_LIMIT",
  "PACKSCOUT_PROMOTION_RELAY_RUN_MODE",
  "PACKSCOUT_PROMOTION_RELAY_POLL_MS",
  "PACKSCOUT_PROMOTION_RELAY_BATCH_SIZE",
  "PACKSCOUT_PROMOTION_RELAY_MAXIMUM_PROVIDERS_PER_CYCLE",
  "PACKSCOUT_PROMOTION_RELAY_PROVIDER_CONCURRENCY",
  "PACKSCOUT_PROMOTION_RELAY_BASE_BACKOFF_MS",
  "PACKSCOUT_PROMOTION_RELAY_MAXIMUM_BACKOFF_MS",
  "PACKSCOUT_PROMOTION_RELAY_MAXIMUM_CACHED_PROVIDERS",
  "PACKSCOUT_PROMOTION_RELAY_PROVIDER_ALLOWED_PORTS",
  "PACKSCOUT_PROMOTION_RELAY_PROVIDER_ALLOWED_SSL_MODES",
  "PACKSCOUT_PROMOTION_RELAY_PROVIDER_CONNECTION_LIMIT",
  "PACKSCOUT_PROMOTION_RELAY_PROVIDER_IDLE_LIFETIME_MS",
  "PACKSCOUT_PROMOTION_RELAY_PROVIDER_CONNECTION_TIMEOUT_MS",
  "PACKSCOUT_PROMOTION_RELAY_PROVIDER_OPERATION_TIMEOUT_MS",
  "PACKSCOUT_PROMOTION_RELAY_PROVIDER_CLOSE_TIMEOUT_MS",
  "PACKSCOUT_PROMOTION_EVALUATOR_WATCHDOG_DATABASE_URL",
  "PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_URL",
  "PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_TOKEN_BASE64",
  "PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_TIMEOUT_MS",
  "PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PUBLIC_KEY_PEM",
]);

export type DistributedPromotionCutoverPreflightErrorCode =
  | "DISTRIBUTED_PROMOTION_CUTOVER_COMMIT_INVALID"
  | "DISTRIBUTED_PROMOTION_CUTOVER_BUILD_MISMATCH"
  | "DISTRIBUTED_PROMOTION_CUTOVER_DIGEST_INVALID"
  | "DISTRIBUTED_PROMOTION_CUTOVER_DEPLOYMENT_ATTESTATION_INVALID"
  | "DISTRIBUTED_PROMOTION_CUTOVER_ENTRYPOINT_INVALID"
  | "DISTRIBUTED_PROMOTION_CUTOVER_ENVIRONMENT_INVALID"
  | "DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_NOT_READY"
  | "DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_PARTIAL"
  | "DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_UNHEALTHY"
  | "DISTRIBUTED_PROMOTION_CUTOVER_MANIFEST_CACHE_INCOMPLETE"
  | "DISTRIBUTED_PROMOTION_CUTOVER_MUTATION_AUTHORITY_PRESENT"
  | "DISTRIBUTED_PROMOTION_CUTOVER_RUNTIME_AUTHORITY_PRESENT"
  | "DISTRIBUTED_PROMOTION_CUTOVER_TIMELINE_INVALID";

export class DistributedPromotionCutoverPreflightError extends Error {
  constructor(
    readonly code: DistributedPromotionCutoverPreflightErrorCode,
  ) {
    super("Distributed promotion cutover preflight failed.");
    this.name = "DistributedPromotionCutoverPreflightError";
  }
}

export interface DistributedPromotionCutoverPreflightConfiguration {
  readonly targetCommit: string;
  readonly legacyStoppedAt: Date;
  readonly splitActivatedAt: Date;
  readonly detectorArmedAt: Date;
  readonly detectorArmProofDigest: string;
  readonly legacyStopProofDigest: string;
  readonly deploymentConfigurationDigest: string;
  readonly providerEntrypointSetDigest: string;
  readonly manifestEntrypointDigest: string;
  readonly relayEntrypointDigest: string;
  readonly livenessEntrypointDigest: string;
  readonly watchdogEntrypointDigest: string;
  readonly systemConditionSinkDigest: string;
  readonly livenessDeploymentProofDigest: string;
  readonly relayDeploymentProofDigest: string;
  readonly watchdogDeploymentProofDigest: string;
  readonly systemConditionSinkProofDigest: string;
  readonly activatedRosterDigest: string;
  readonly activeManifestFingerprint: string;
  readonly previousManifestFingerprint: string | null;
}

/** Evidence computed from the checkout that is actually running preflight. */
export interface DistributedPromotionCutoverBuildEvidence {
  readonly currentCommit: string;
  readonly providerEntrypointSetDigest: string;
  readonly manifestEntrypointDigest: string;
  readonly relayEntrypointDigest: string;
  readonly livenessEntrypointDigest: string;
  readonly watchdogEntrypointDigest: string;
  readonly systemConditionSinkDigest: string;
}

export interface DistributedPromotionCutoverPreflightEvidenceSource
extends PromotionJobEvaluatorWatchdogEvidenceSource {
  readEvaluatorState(): Promise<PromotionJobLivenessEvaluatorStateRecord>;
  readManifestPlanCacheCoverage(): Promise<
    DistributedPromotionManifestPlanCacheCoverage
  >;
}

export interface DistributedPromotionManifestPlanCacheCoverage {
  readonly mirrorStable: boolean;
  readonly mirrorGeneration: bigint;
  readonly activeManifestFingerprint: string | null;
  readonly previousManifestFingerprint: string | null;
  readonly activeReferenceCount: number;
  readonly cachedActiveReferenceCount: number;
  readonly previousReferenceCount: number;
  readonly cachedPreviousReferenceCount: number;
}

export interface DistributedPromotionCutoverPreflightResult {
  readonly schemaVersion: typeof DISTRIBUTED_PROMOTION_CUTOVER_PREFLIGHT_SCHEMA;
  readonly status: "preflight_passed";
  readonly evidenceLevel: "preproduction_code_side";
  readonly targetCommit: string;
  readonly checkedAt: string;
  readonly authoritySwitch: Readonly<{
    legacyComposite: "stopped_attested";
    legacyAttempts: "drained_attested";
    distributedMode: "split";
    legacyStoppedAt: string;
    splitActivatedAt: string;
    legacyStopProofDigest: string;
    deploymentConfigurationDigest: string;
    providerEntrypointSetDigest: string;
    manifestEntrypointDigest: string;
    relayEntrypointDigest: string;
    livenessEntrypointDigest: string;
    watchdogEntrypointDigest: string;
    systemConditionSinkDigest: string;
    activatedRosterDigest: string;
    entrypoints: typeof DISTRIBUTED_PROMOTION_ENTRYPOINTS;
  }>;
  readonly runtimePrerequisites: Readonly<{
    providerActivityRelay:
      typeof DISTRIBUTED_PROMOTION_RUNTIME_PREREQUISITES.providerActivityRelay &
      Readonly<{ proofDigest: string }>;
    livenessEvaluator: typeof DISTRIBUTED_PROMOTION_RUNTIME_PREREQUISITES.livenessEvaluator &
      Readonly<{ proofDigest: string }>;
    evaluatorWatchdog: typeof DISTRIBUTED_PROMOTION_RUNTIME_PREREQUISITES.evaluatorWatchdog &
      Readonly<{ proofDigest: string }>;
    systemConditionSink: typeof DISTRIBUTED_PROMOTION_RUNTIME_PREREQUISITES.systemConditionSink &
      Readonly<{
        proofDigest: string;
        adapterDigest: string;
      }>;
  }>;
  readonly evaluator: Readonly<{
    lifecycle: "active";
    health: "healthy";
    evaluatorEpoch: string;
    missedWindowCount: string;
    lastSuccessfulEvaluationAt: string;
    evaluatedThrough: string;
    rosterDigest: string;
    expectedJobCount: number;
    eligibleProviderCount: number;
    reachableJobCount: number;
    unavailableJobCount: 0;
  }>;
  readonly externalDetector: Readonly<{
    state: "armed_attested";
    evidenceSource: "external_attestation";
    armedAfterSuccessfulCycle: true;
    armedAt: string;
    armProofDigest: string;
  }>;
  readonly manifestPlanCache: Readonly<{
    state: "complete";
    mirrorGeneration: string;
    activeManifestFingerprint: string;
    previousManifestFingerprint: string | null;
    activeReferenceCount: number;
    cachedActiveReferenceCount: number;
    previousReferenceCount: number;
    cachedPreviousReferenceCount: number;
  }>;
  readonly externalEvidence: Readonly<{
    status: "required";
    remaining: typeof DISTRIBUTED_PROMOTION_EXTERNAL_EVIDENCE_REMAINING;
  }>;
}

function refuse(code: DistributedPromotionCutoverPreflightErrorCode): never {
  throw new DistributedPromotionCutoverPreflightError(code);
}

/** Length-delimited artifact hashing prevents path/content boundary ambiguity. */
export function distributedPromotionEntrypointArtifactDigest(
  artifacts: readonly Readonly<{ name: string; content: string }>[],
): string {
  if (
    artifacts.length < 1 || artifacts.length > 32
    || artifacts.some(({ name, content }, index) =>
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(name)
      || Buffer.byteLength(content, "utf8") > 4 * 1_024 * 1_024
      || (index > 0 && artifacts[index - 1]!.name >= name))
  ) throw new TypeError("Distributed promotion build artifact is invalid.");
  const hash = createHash("sha256");
  hash.update("packscout/distributed-promotion-entrypoints/v1\0", "utf8");
  for (const artifact of artifacts) {
    const bytes = Buffer.from(artifact.content, "utf8");
    hash.update(`${Buffer.byteLength(artifact.name, "utf8")}:`, "utf8");
    hash.update(artifact.name, "utf8");
    hash.update(`${bytes.byteLength}:`, "utf8");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function exactInstant(value: string | undefined): Date {
  if (!value) refuse("DISTRIBUTED_PROMOTION_CUTOVER_TIMELINE_INVALID");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    refuse("DISTRIBUTED_PROMOTION_CUTOVER_TIMELINE_INVALID");
  }
  return parsed;
}

function sha256(value: string | undefined): string {
  if (!value || !SHA256_PATTERN.test(value)) {
    refuse("DISTRIBUTED_PROMOTION_CUTOVER_DIGEST_INVALID");
  }
  return value;
}

function optionalSha256(value: string | undefined): string | null {
  if (value === "none") return null;
  return sha256(value);
}

function assertEntrypoint(
  value: string | undefined,
  expected: string,
): void {
  if (value !== expected) {
    refuse("DISTRIBUTED_PROMOTION_CUTOVER_ENTRYPOINT_INVALID");
  }
}

/**
 * Reads only target-bound attestations and digests. The preflight process must
 * not carry split runtime secrets, runtime routing, or legacy authority. Its
 * own narrow read-only database URL is consumed only by the outer CLI.
 */
export function readDistributedPromotionCutoverPreflightConfiguration(
  environment: NodeJS.ProcessEnv,
): DistributedPromotionCutoverPreflightConfiguration {
  if (
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_ENVIRONMENT !== "preproduction"
    || environment.PACKSCOUT_DISTRIBUTED_PROMOTION_MODE !== "split"
    || environment.PACKSCOUT_DISTRIBUTED_CUTOVER_LEGACY_COMPOSITE_STATE
      !== "stopped"
    || environment.PACKSCOUT_DISTRIBUTED_CUTOVER_LEGACY_ATTEMPTS_STATE
      !== "drained"
  ) refuse("DISTRIBUTED_PROMOTION_CUTOVER_ENVIRONMENT_INVALID");
  if (MUTATING_OR_LEGACY_AUTHORITY_KEYS.some((key) =>
    environment[key] !== undefined
  )) {
    refuse("DISTRIBUTED_PROMOTION_CUTOVER_MUTATION_AUTHORITY_PRESENT");
  }
  if (LIVENESS_RUNTIME_AUTHORITY_KEYS.some((key) =>
    environment[key] !== undefined
  )) {
    refuse("DISTRIBUTED_PROMOTION_CUTOVER_RUNTIME_AUTHORITY_PRESENT");
  }
  if (
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_LIVENESS_DEPLOYMENT_STATE
      !== "separate_dynamic_central_routed"
    || environment.PACKSCOUT_DISTRIBUTED_CUTOVER_RELAY_DEPLOYMENT_STATE
      !== "separate_central_observer"
    || environment.PACKSCOUT_DISTRIBUTED_CUTOVER_WATCHDOG_DEPLOYMENT_STATE
      !== "separate_dedicated_read_only"
    || environment.PACKSCOUT_DISTRIBUTED_CUTOVER_SYSTEM_CONDITION_SINK_STATE
      !== "authenticated_https_system_only"
  ) {
    refuse("DISTRIBUTED_PROMOTION_CUTOVER_DEPLOYMENT_ATTESTATION_INVALID");
  }
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_ENTRYPOINT,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.providerPublicationScript,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_EXECUTABLE,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.providerPublicationExecutable,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_SCHEDULE_EXECUTABLE,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.providerScheduleCommandExecutable,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_SCHEDULE_ACTIVATE_ENTRYPOINT,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.providerScheduleActivateScript,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_SCHEDULE_PAUSE_ENTRYPOINT,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.providerSchedulePauseScript,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_ENTRYPOINT,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.manifestReconciliationScript,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_EXECUTABLE,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.manifestReconciliationExecutable,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_SCHEDULE_EXECUTABLE,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.manifestScheduleCommandExecutable,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_SCHEDULE_ACTIVATE_ENTRYPOINT,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.manifestScheduleActivateScript,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_SCHEDULE_PAUSE_ENTRYPOINT,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.manifestSchedulePauseScript,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_OPERATION_EXECUTABLE,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.manifestGateOperationExecutable,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_OPERATION_ENTRYPOINT,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.manifestGateOperationScript,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_RELAY_ENTRYPOINT,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.providerActivityRelayScript,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_RELAY_EXECUTABLE,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.providerActivityRelayExecutable,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_LIVENESS_ENTRYPOINT,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.livenessEvaluationScript,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_LIVENESS_EXECUTABLE,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.livenessEvaluationExecutable,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_WATCHDOG_ENTRYPOINT,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.evaluatorWatchdogScript,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_WATCHDOG_EXECUTABLE,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.evaluatorWatchdogExecutable,
  );
  assertEntrypoint(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_SYSTEM_CONDITION_SINK_ADAPTER,
    DISTRIBUTED_PROMOTION_ENTRYPOINTS.systemConditionSinkAdapter,
  );
  const targetCommit = environment.PACKSCOUT_DISTRIBUTED_CUTOVER_COMMIT;
  if (!targetCommit || !COMMIT_PATTERN.test(targetCommit)) {
    refuse("DISTRIBUTED_PROMOTION_CUTOVER_COMMIT_INVALID");
  }
  const legacyStoppedAt = exactInstant(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_LEGACY_STOPPED_AT,
  );
  const splitActivatedAt = exactInstant(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_SPLIT_ACTIVATED_AT,
  );
  const detectorArmedAt = exactInstant(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_DETECTOR_ARMED_AT,
  );
  if (splitActivatedAt.getTime() <= legacyStoppedAt.getTime()) {
    refuse("DISTRIBUTED_PROMOTION_CUTOVER_TIMELINE_INVALID");
  }
  const providerEntrypointSetDigest = sha256(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_PROVIDER_ENTRYPOINT_SET_SHA256,
  );
  const manifestEntrypointDigest = sha256(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_MANIFEST_ENTRYPOINT_SHA256,
  );
  const relayEntrypointDigest = sha256(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_RELAY_ENTRYPOINT_SHA256,
  );
  const livenessEntrypointDigest = sha256(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_LIVENESS_ENTRYPOINT_SHA256,
  );
  const watchdogEntrypointDigest = sha256(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_WATCHDOG_ENTRYPOINT_SHA256,
  );
  const systemConditionSinkDigest = sha256(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_SYSTEM_CONDITION_SINK_SHA256,
  );
  const activatedRosterDigest = sha256(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_ROSTER_SHA256,
  );
  const livenessDeploymentProofDigest = sha256(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_LIVENESS_DEPLOYMENT_PROOF_SHA256,
  );
  const relayDeploymentProofDigest = sha256(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_RELAY_DEPLOYMENT_PROOF_SHA256,
  );
  const watchdogDeploymentProofDigest = sha256(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_WATCHDOG_DEPLOYMENT_PROOF_SHA256,
  );
  const systemConditionSinkProofDigest = sha256(
    environment.PACKSCOUT_DISTRIBUTED_CUTOVER_SYSTEM_CONDITION_SINK_PROOF_SHA256,
  );
  if (new Set([
    providerEntrypointSetDigest,
    manifestEntrypointDigest,
    relayEntrypointDigest,
    livenessEntrypointDigest,
    watchdogEntrypointDigest,
    systemConditionSinkDigest,
  ]).size !== 6) {
    refuse("DISTRIBUTED_PROMOTION_CUTOVER_DIGEST_INVALID");
  }
  if (new Set([
    livenessDeploymentProofDigest,
    relayDeploymentProofDigest,
    watchdogDeploymentProofDigest,
    systemConditionSinkProofDigest,
  ]).size !== 4) refuse("DISTRIBUTED_PROMOTION_CUTOVER_DIGEST_INVALID");
  return Object.freeze({
    targetCommit,
    legacyStoppedAt,
    splitActivatedAt,
    detectorArmedAt,
    detectorArmProofDigest: sha256(
      environment.PACKSCOUT_DISTRIBUTED_CUTOVER_DETECTOR_ARM_PROOF_SHA256,
    ),
    legacyStopProofDigest: sha256(
      environment.PACKSCOUT_DISTRIBUTED_CUTOVER_LEGACY_STOP_PROOF_SHA256,
    ),
    deploymentConfigurationDigest: sha256(
      environment.PACKSCOUT_DISTRIBUTED_CUTOVER_DEPLOYMENT_CONFIG_SHA256,
    ),
    livenessDeploymentProofDigest,
    relayDeploymentProofDigest,
    watchdogDeploymentProofDigest,
    systemConditionSinkProofDigest,
    providerEntrypointSetDigest,
    manifestEntrypointDigest,
    relayEntrypointDigest,
    livenessEntrypointDigest,
    watchdogEntrypointDigest,
    systemConditionSinkDigest,
    activatedRosterDigest,
    activeManifestFingerprint: sha256(
      environment.PACKSCOUT_DISTRIBUTED_CUTOVER_ACTIVE_MANIFEST_FINGERPRINT,
    ),
    previousManifestFingerprint: optionalSha256(
      environment.PACKSCOUT_DISTRIBUTED_CUTOVER_PREVIOUS_MANIFEST_FINGERPRINT,
    ),
  });
}

function assertManifestPlanCacheCoverage(
  coverage: DistributedPromotionManifestPlanCacheCoverage,
  configuration: DistributedPromotionCutoverPreflightConfiguration,
): asserts coverage is DistributedPromotionManifestPlanCacheCoverage &
  Readonly<{ activeManifestFingerprint: string }> {
  if (
    coverage.mirrorStable !== true ||
    coverage.mirrorGeneration < 1n ||
    coverage.activeManifestFingerprint === null ||
    !SHA256_PATTERN.test(coverage.activeManifestFingerprint) ||
    coverage.activeManifestFingerprint !==
      configuration.activeManifestFingerprint ||
    coverage.previousManifestFingerprint !==
      configuration.previousManifestFingerprint ||
    (coverage.previousManifestFingerprint !== null &&
      !SHA256_PATTERN.test(coverage.previousManifestFingerprint)) ||
    !Number.isSafeInteger(coverage.activeReferenceCount) ||
    coverage.activeReferenceCount < 1 ||
    !Number.isSafeInteger(coverage.cachedActiveReferenceCount) ||
    coverage.cachedActiveReferenceCount !== coverage.activeReferenceCount ||
    !Number.isSafeInteger(coverage.previousReferenceCount) ||
    coverage.previousReferenceCount < 0 ||
    !Number.isSafeInteger(coverage.cachedPreviousReferenceCount) ||
    coverage.cachedPreviousReferenceCount !== coverage.previousReferenceCount ||
    (coverage.previousManifestFingerprint === null) !==
      (coverage.previousReferenceCount === 0)
  ) refuse("DISTRIBUTED_PROMOTION_CUTOVER_MANIFEST_CACHE_INCOMPLETE");
}

function assertSuccessfulEvidence(
  evidence: PromotionJobEvaluatorWatchdogEvidenceRecord,
  state: PromotionJobLivenessEvaluatorStateRecord,
  configuration: DistributedPromotionCutoverPreflightConfiguration,
  checkedAt: Date,
): asserts evidence is PromotionJobEvaluatorWatchdogEvidenceRecord & Readonly<{
  lifecycle: "active";
  lastSuccessfulEvaluationAt: Date;
  evaluatedThrough: Date;
  rosterDigest: string;
  expectedCount: number;
  reachableCount: number;
  unavailableCount: number;
}> {
  if (
    evidence.lifecycle !== "active"
    || state.state !== "current"
    || state.lifecycle !== "active"
    || state.manifestEvaluated !== true
    || state.lastFailureCode !== null
    || state.activatedAt === null
    || evidence.lastSuccessfulEvaluationAt === null
    || evidence.evaluatedThrough === null
    || evidence.rosterDigest === null
    || evidence.expectedCount === null
    || evidence.reachableCount === null
    || evidence.unavailableCount === null
  ) refuse("DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_NOT_READY");
  if (
    state.activatedAt.getTime() < configuration.splitActivatedAt.getTime()
    || state.activatedAt.getTime() > checkedAt.getTime()
    || evidence.lastSuccessfulEvaluationAt.getTime()
      < configuration.splitActivatedAt.getTime()
    || state.activatedAt.getTime()
      > evidence.lastSuccessfulEvaluationAt.getTime()
    || evidence.lastSuccessfulEvaluationAt.getTime() > checkedAt.getTime()
    || evidence.evaluatedThrough.getTime() > checkedAt.getTime()
    || configuration.detectorArmedAt.getTime()
      < evidence.lastSuccessfulEvaluationAt.getTime()
    || configuration.detectorArmedAt.getTime() > checkedAt.getTime()
  ) refuse("DISTRIBUTED_PROMOTION_CUTOVER_TIMELINE_INVALID");
  if (evidence.rosterDigest !== configuration.activatedRosterDigest) {
    refuse("DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_NOT_READY");
  }
  if (
    state.evaluatorEpoch !== evidence.evaluatorEpoch
    || state.lastSuccessfulEvaluationAt?.getTime()
      !== evidence.lastSuccessfulEvaluationAt.getTime()
    || state.evaluatedThrough?.getTime() !== evidence.evaluatedThrough.getTime()
    || state.rosterDigest !== evidence.rosterDigest
    || state.expectedCount !== evidence.expectedCount
    || state.reachableCount !== evidence.reachableCount
    || state.unavailableCount !== evidence.unavailableCount
  ) refuse("DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_NOT_READY");
  if (
    evidence.expectedCount < 1
    || evidence.reachableCount !== evidence.expectedCount
    || evidence.unavailableCount !== 0
  ) refuse("DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_PARTIAL");
  if (
    state.healthyCount !== evidence.expectedCount
    || state.overdueCount !== 0
    || state.alertingCount !== 0
  ) refuse("DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_UNHEALTHY");
}

/**
 * Certifies code-side cutover invariants only. Live canary, failure injection,
 * latency samples, UI/security regression, and exact-commit verifier evidence
 * remain explicitly outstanding and cannot be synthesized by this command.
 */
export async function runDistributedPromotionCutoverPreflight(input: Readonly<{
  configuration: DistributedPromotionCutoverPreflightConfiguration;
  build: DistributedPromotionCutoverBuildEvidence;
  evidence: DistributedPromotionCutoverPreflightEvidenceSource;
  now?: () => Date;
}>): Promise<DistributedPromotionCutoverPreflightResult> {
  const checkedAt = input.now?.() ?? new Date();
  if (!Number.isFinite(checkedAt.getTime())) {
    refuse("DISTRIBUTED_PROMOTION_CUTOVER_TIMELINE_INVALID");
  }
  if (
    input.build.currentCommit !== input.configuration.targetCommit
    || input.build.providerEntrypointSetDigest !==
      input.configuration.providerEntrypointSetDigest
    || input.build.manifestEntrypointDigest !==
      input.configuration.manifestEntrypointDigest
    || input.build.relayEntrypointDigest !==
      input.configuration.relayEntrypointDigest
    || input.build.livenessEntrypointDigest !==
      input.configuration.livenessEntrypointDigest
    || input.build.watchdogEntrypointDigest !==
      input.configuration.watchdogEntrypointDigest
    || input.build.systemConditionSinkDigest !==
      input.configuration.systemConditionSinkDigest
  ) refuse("DISTRIBUTED_PROMOTION_CUTOVER_BUILD_MISMATCH");
  const [evidence, state, manifestPlanCache] = await Promise.all([
    input.evidence.readWatchdogEvidence(),
    input.evidence.readEvaluatorState(),
    input.evidence.readManifestPlanCacheCoverage(),
  ]);
  const watchdog = promotionJobEvaluatorWatchdogResponse(
    evaluatePromotionJobEvaluatorWatchdog(evidence, checkedAt),
  );
  assertSuccessfulEvidence(evidence, state, input.configuration, checkedAt);
  assertManifestPlanCacheCoverage(manifestPlanCache, input.configuration);
  if (watchdog.health !== "healthy") {
    refuse("DISTRIBUTED_PROMOTION_CUTOVER_EVALUATOR_UNHEALTHY");
  }
  return Object.freeze({
    schemaVersion: DISTRIBUTED_PROMOTION_CUTOVER_PREFLIGHT_SCHEMA,
    status: "preflight_passed",
    evidenceLevel: "preproduction_code_side",
    targetCommit: input.configuration.targetCommit,
    checkedAt: checkedAt.toISOString(),
    authoritySwitch: Object.freeze({
      legacyComposite: "stopped_attested",
      legacyAttempts: "drained_attested",
      distributedMode: "split",
      legacyStoppedAt: input.configuration.legacyStoppedAt.toISOString(),
      splitActivatedAt: input.configuration.splitActivatedAt.toISOString(),
      legacyStopProofDigest: input.configuration.legacyStopProofDigest,
      deploymentConfigurationDigest:
        input.configuration.deploymentConfigurationDigest,
      providerEntrypointSetDigest:
        input.configuration.providerEntrypointSetDigest,
      manifestEntrypointDigest: input.configuration.manifestEntrypointDigest,
      relayEntrypointDigest: input.configuration.relayEntrypointDigest,
      livenessEntrypointDigest:
        input.configuration.livenessEntrypointDigest,
      watchdogEntrypointDigest: input.configuration.watchdogEntrypointDigest,
      systemConditionSinkDigest:
        input.configuration.systemConditionSinkDigest,
      activatedRosterDigest: input.configuration.activatedRosterDigest,
      entrypoints: DISTRIBUTED_PROMOTION_ENTRYPOINTS,
    }),
    runtimePrerequisites: Object.freeze({
      providerActivityRelay: Object.freeze({
        ...DISTRIBUTED_PROMOTION_RUNTIME_PREREQUISITES.providerActivityRelay,
        proofDigest: input.configuration.relayDeploymentProofDigest,
      }),
      livenessEvaluator: Object.freeze({
        ...DISTRIBUTED_PROMOTION_RUNTIME_PREREQUISITES.livenessEvaluator,
        proofDigest: input.configuration.livenessDeploymentProofDigest,
      }),
      evaluatorWatchdog: Object.freeze({
        ...DISTRIBUTED_PROMOTION_RUNTIME_PREREQUISITES.evaluatorWatchdog,
        proofDigest: input.configuration.watchdogDeploymentProofDigest,
      }),
      systemConditionSink: Object.freeze({
        ...DISTRIBUTED_PROMOTION_RUNTIME_PREREQUISITES.systemConditionSink,
        proofDigest: input.configuration.systemConditionSinkProofDigest,
        adapterDigest: input.configuration.systemConditionSinkDigest,
      }),
    }),
    evaluator: Object.freeze({
      lifecycle: "active",
      health: "healthy",
      evaluatorEpoch: watchdog.evaluatorEpoch,
      missedWindowCount: watchdog.missedWindowCount,
      lastSuccessfulEvaluationAt: watchdog.lastSuccessfulEvaluationAt!,
      evaluatedThrough: watchdog.evaluatedThrough!,
      rosterDigest: watchdog.rosterDigest!,
      expectedJobCount: evidence.expectedCount,
      eligibleProviderCount: evidence.expectedCount - 1,
      reachableJobCount: evidence.reachableCount,
      unavailableJobCount: 0,
    }),
    externalDetector: Object.freeze({
      state: "armed_attested",
      evidenceSource: "external_attestation",
      armedAfterSuccessfulCycle: true,
      armedAt: input.configuration.detectorArmedAt.toISOString(),
      armProofDigest: input.configuration.detectorArmProofDigest,
    }),
    manifestPlanCache: Object.freeze({
      state: "complete",
      mirrorGeneration: manifestPlanCache.mirrorGeneration.toString(),
      activeManifestFingerprint:
        manifestPlanCache.activeManifestFingerprint,
      previousManifestFingerprint:
        manifestPlanCache.previousManifestFingerprint,
      activeReferenceCount: manifestPlanCache.activeReferenceCount,
      cachedActiveReferenceCount:
        manifestPlanCache.cachedActiveReferenceCount,
      previousReferenceCount: manifestPlanCache.previousReferenceCount,
      cachedPreviousReferenceCount:
        manifestPlanCache.cachedPreviousReferenceCount,
    }),
    externalEvidence: Object.freeze({
      status: "required",
      remaining: DISTRIBUTED_PROMOTION_EXTERNAL_EVIDENCE_REMAINING,
    }),
  });
}
