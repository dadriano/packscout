import { z } from "zod";
import { providerLifecycleStates, providerPlatformKeySchema } from "./provider.ts";

export const promotionJobTriggerKinds = [
  "change_wake",
  "reconciliation_cron",
  "manual",
  "continuation",
] as const;

export const promotionJobTerminalOutcomes = [
  "caught_up",
  "no_change",
  "coalesced",
  "continuation_required",
  "deferred",
  "blocked",
  "failed",
] as const;

export const promotionJobScheduleLifecycles = [
  "pending_activation",
  "active",
  "paused",
] as const;

export const promotionJobScheduleHealthStates = [
  "inactive",
  "healthy",
  "overdue",
  "alerting",
] as const;

export const promotionJobEvidenceSources = [
  "live",
  "last_known",
  "unavailable",
] as const;

export const promotionJobProviderStates = [
  "inactive",
  "current",
  "awaiting_publication",
  "awaiting_activation",
  "retry_wait",
  "blocked",
  "failed",
  "unavailable",
  "last_known",
] as const;

export const manifestGateOperationKinds = [
  "advance",
  "add",
  "remove",
  "rollback",
] as const;

export type PromotionJobTriggerKind =
  (typeof promotionJobTriggerKinds)[number];
export type PromotionJobTerminalOutcome =
  (typeof promotionJobTerminalOutcomes)[number];
export type PromotionJobScheduleLifecycle =
  (typeof promotionJobScheduleLifecycles)[number];
export type PromotionJobScheduleHealth =
  (typeof promotionJobScheduleHealthStates)[number];
export type PromotionJobEvidenceSource =
  (typeof promotionJobEvidenceSources)[number];
export type PromotionJobProviderState =
  (typeof promotionJobProviderStates)[number];
export type ManifestGateOperationKind =
  (typeof manifestGateOperationKinds)[number];

const providerFilterSchema = z.string().superRefine((value, context) => {
  if (!value.startsWith("provider:")) {
    context.addIssue({ code: "custom", message: "Use a provider filter." });
    return;
  }
  const providerKey = value.slice(9);
  const parsed = providerPlatformKeySchema.safeParse(providerKey);
  if (!parsed.success || providerKey.startsWith("packscout_canonical_")) {
    context.addIssue({ code: "custom", message: "Use a valid provider filter." });
  }
});

/** `all` is deliberately not a value: omission is the only all-jobs scope. */
export const promotionJobMonitoringFilterSchema = z.union([
  z.literal("manifest"),
  providerFilterSchema,
]);

/** Opaque central reference. UUIDs and provider-local run IDs are rejected. */
export const promotionJobMonitoringIdSchema = z
  .string()
  .regex(/^pj_[A-Za-z0-9_-]{24,160}$/u);

export const promotionJobHistoryQuerySchema = z
  .object({
    filter: promotionJobMonitoringFilterSchema.optional(),
    trigger: z.enum(promotionJobTriggerKinds).optional(),
    outcome: z.enum(promotionJobTerminalOutcomes).optional(),
    cursor: z.string().min(1).max(1_024).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type PromotionJobHistoryQuery = z.output<
  typeof promotionJobHistoryQuerySchema
>;

export interface PromotionJobScheduleMonitoring {
  readonly lifecycle: PromotionJobScheduleLifecycle;
  readonly health: PromotionJobScheduleHealth;
  readonly scheduleEpoch: string;
  readonly missedWindowCount: string;
  readonly lastScheduledCheckinAt: string | null;
  readonly nextExpectedCheckinAt: string | null;
}

export interface PromotionJobWakeMonitoring {
  readonly pending: boolean;
  readonly requestedGeneration: string;
  readonly acknowledgedGeneration: string;
  readonly latestCause: string | null;
  readonly latestRequestedAt: string | null;
  readonly deliveryState: string | null;
  readonly lastDeliveryAttemptAt: string | null;
  readonly failureCode: string | null;
}

export interface PromotionJobInvocationMonitoring {
  readonly monitoringId: string;
  readonly job: "manifest" | `provider:${string}`;
  readonly trigger: PromotionJobTriggerKind;
  readonly state: "running" | "terminal";
  readonly outcome: PromotionJobTerminalOutcome | null;
  readonly requestedAt: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly cycleCount: number;
  readonly attemptCount: number;
  readonly retryCount: number;
  readonly failureCode: string | null;
  readonly continuationPending: boolean;
}

export interface PromotionJobPublicReleaseMonitoring {
  readonly publicReleaseId: string;
  readonly fingerprint: string;
  /** Provider-local position can be absent for a retained historical selection. */
  readonly position: string | null;
}

export interface ManifestGateMonitoring {
  readonly operation: ManifestGateOperationKind;
  readonly state: "pending" | "running" | "retry_wait" | "blocked";
  readonly requestedGeneration: string;
  readonly acknowledgedGeneration: string;
  readonly requestedAt: string;
  readonly attemptCount: number;
  readonly retryAt: string | null;
  readonly failureCode: string | null;
}

export interface ProviderPromotionJobMonitoring {
  readonly providerKey: string;
  readonly displayName: string;
  readonly lifecycle: (typeof providerLifecycleStates)[number];
  readonly evidenceSource: PromotionJobEvidenceSource;
  readonly observedAt: string | null;
  readonly stale: boolean;
  readonly routeFailureCode: string | null;
  readonly state: PromotionJobProviderState;
  readonly schedule: PromotionJobScheduleMonitoring | null;
  readonly wake: PromotionJobWakeMonitoring | null;
  readonly settledPosition: string | null;
  readonly completedRelease: PromotionJobPublicReleaseMonitoring | null;
  readonly activeRelease: PromotionJobPublicReleaseMonitoring | null;
  readonly pendingGate: ManifestGateMonitoring | null;
  readonly latestInvocation: PromotionJobInvocationMonitoring | null;
  readonly projectionLagMs: number | null;
}

export interface ManifestIdentityMonitoring {
  readonly publicManifestId: string;
  readonly fingerprint: string;
  readonly generation: string;
  readonly activatedAt: string;
}

export interface ManifestPromotionJobMonitoring {
  readonly evidenceSource: "live" | "unavailable";
  readonly observedAt: string | null;
  readonly stale: boolean;
  readonly schedule: PromotionJobScheduleMonitoring | null;
  readonly wake: PromotionJobWakeMonitoring | null;
  readonly activeManifest: ManifestIdentityMonitoring | null;
  readonly previousManifest: ManifestIdentityMonitoring | null;
  readonly gateQueueDepth: number;
  readonly oldestGateAgeMs: number | null;
  readonly serializedOperation: Readonly<{
    operation: ManifestGateOperationKind;
    providerKey: string;
    state: "persisted" | "sent" | "accepted" | "retry_wait" | "blocked";
    attemptCount: number;
    failureCode: string | null;
  }> | null;
  readonly lastActivationAt: string | null;
  readonly lastReconciliationAt: string | null;
  readonly latestInvocation: PromotionJobInvocationMonitoring | null;
}

export interface PromotionJobEvaluatorMonitoring {
  readonly state: "pending" | "current" | "stale" | "failed";
  readonly observedAt: string | null;
  readonly evaluatedThrough: string | null;
  readonly rosterVersion: string | null;
  readonly rosterHighWater: string | null;
  readonly rosterDigest: string | null;
  readonly expectedCount: number | null;
  readonly reachableCount: number | null;
  readonly unavailableCount: number | null;
  readonly manifestEvaluated: boolean | null;
  readonly failureCode: string | null;
}

export interface PromotionJobRosterMonitoring {
  readonly observedAt: string;
  readonly version: string;
  readonly highWater: string;
  readonly digest: string;
  /** Every centrally retained row visible to this organization. */
  readonly providerCount: number;
  /** Active rows admitted to the deployment-wide schedule evaluator. */
  readonly eligibleProviderCount: number;
}

export interface PromotionJobMonitoringOverview {
  readonly observedAt: string;
  readonly roster: PromotionJobRosterMonitoring;
  readonly evaluator: PromotionJobEvaluatorMonitoring;
  readonly manifest: ManifestPromotionJobMonitoring;
  readonly providers: readonly ProviderPromotionJobMonitoring[];
}

export interface PromotionJobHistoryPage {
  readonly items: readonly PromotionJobInvocationMonitoring[];
  readonly nextCursor: string | null;
  readonly rosterDigest: string;
}

export interface PromotionJobOperationMonitoring {
  readonly operationNumber: number;
  readonly kind: string;
  readonly state: "pending" | "sent" | "acknowledged";
  readonly sendCount: number;
  readonly sentAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly operationIdDigest: string;
  readonly requestDigest: string;
  readonly receiptDigest: string | null;
}

export interface PromotionJobAttemptMonitoring {
  readonly attemptNumber: number;
  readonly kind: "provider" | "manifest";
  readonly state: string;
  readonly targetPosition: string;
  readonly retryCount: number;
  readonly failureCode: string | null;
  readonly publicReleaseId: string | null;
  readonly releaseFingerprint: string | null;
  readonly totalOperationCount: number;
  readonly truncatedOperationCount: number;
  readonly orderedOperationDigest: string;
  readonly operationSummariesDigest: string;
  readonly operations: readonly PromotionJobOperationMonitoring[];
  readonly observedAt: string;
}

export interface PromotionJobInvocationDetail {
  readonly invocation: PromotionJobInvocationMonitoring;
  readonly totalAttemptCount: number;
  readonly truncatedAttemptCount: number;
  readonly attemptSetDigest: string;
  readonly attempts: readonly PromotionJobAttemptMonitoring[];
}

const decimalSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/u);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const instantSchema = z.iso.datetime({ offset: true });
const safeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
const safeStateSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
const safePublicIdSchema = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);

export const promotionJobScheduleMonitoringSchema = z.object({
  lifecycle: z.enum(promotionJobScheduleLifecycles),
  health: z.enum(promotionJobScheduleHealthStates),
  scheduleEpoch: decimalSchema,
  missedWindowCount: decimalSchema,
  lastScheduledCheckinAt: instantSchema.nullable(),
  nextExpectedCheckinAt: instantSchema.nullable(),
});

export const promotionJobWakeMonitoringSchema = z.object({
  pending: z.boolean(),
  requestedGeneration: decimalSchema,
  acknowledgedGeneration: decimalSchema,
  latestCause: safeStateSchema.nullable(),
  latestRequestedAt: instantSchema.nullable(),
  deliveryState: safeStateSchema.nullable(),
  lastDeliveryAttemptAt: instantSchema.nullable(),
  failureCode: safeCodeSchema.nullable(),
});

export const promotionJobInvocationMonitoringSchema = z.object({
  monitoringId: promotionJobMonitoringIdSchema,
  job: promotionJobMonitoringFilterSchema,
  trigger: z.enum(promotionJobTriggerKinds),
  state: z.enum(["running", "terminal"]),
  outcome: z.enum(promotionJobTerminalOutcomes).nullable(),
  requestedAt: instantSchema,
  startedAt: instantSchema,
  finishedAt: instantSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  cycleCount: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  failureCode: safeCodeSchema.nullable(),
  continuationPending: z.boolean(),
});

export const promotionJobPublicReleaseMonitoringSchema = z.object({
  publicReleaseId: safePublicIdSchema,
  fingerprint: digestSchema,
  position: decimalSchema.nullable(),
});

export const manifestGateMonitoringSchema = z.object({
  operation: z.enum(manifestGateOperationKinds),
  state: z.enum(["pending", "running", "retry_wait", "blocked"]),
  requestedGeneration: decimalSchema,
  acknowledgedGeneration: decimalSchema,
  requestedAt: instantSchema,
  attemptCount: z.number().int().nonnegative(),
  retryAt: instantSchema.nullable(),
  failureCode: safeCodeSchema.nullable(),
});

export const providerPromotionJobMonitoringSchema = z.object({
  providerKey: providerPlatformKeySchema,
  displayName: z.string().trim().min(1).max(120),
  lifecycle: z.enum(providerLifecycleStates),
  evidenceSource: z.enum(promotionJobEvidenceSources),
  observedAt: instantSchema.nullable(),
  stale: z.boolean(),
  routeFailureCode: safeCodeSchema.nullable(),
  state: z.enum(promotionJobProviderStates),
  schedule: promotionJobScheduleMonitoringSchema.nullable(),
  wake: promotionJobWakeMonitoringSchema.nullable(),
  settledPosition: decimalSchema.nullable(),
  completedRelease: promotionJobPublicReleaseMonitoringSchema.nullable(),
  activeRelease: promotionJobPublicReleaseMonitoringSchema.nullable(),
  pendingGate: manifestGateMonitoringSchema.nullable(),
  latestInvocation: promotionJobInvocationMonitoringSchema.nullable(),
  projectionLagMs: z.number().int().nonnegative().nullable(),
}).superRefine((provider, context) => {
  if (
    provider.completedRelease !== null
    && provider.completedRelease.position === null
  ) {
    context.addIssue({
      code: "custom",
      message: "Completed provider release position is required.",
      path: ["completedRelease", "position"],
    });
  }
});

export const manifestPromotionJobMonitoringSchema = z.object({
  evidenceSource: z.enum(["live", "unavailable"]),
  observedAt: instantSchema.nullable(),
  stale: z.boolean(),
  schedule: promotionJobScheduleMonitoringSchema.nullable(),
  wake: promotionJobWakeMonitoringSchema.nullable(),
  activeManifest: z.object({
    publicManifestId: safePublicIdSchema,
    fingerprint: digestSchema,
    generation: decimalSchema,
    activatedAt: instantSchema,
  }).nullable(),
  previousManifest: z.object({
    publicManifestId: safePublicIdSchema,
    fingerprint: digestSchema,
    generation: decimalSchema,
    activatedAt: instantSchema,
  }).nullable(),
  gateQueueDepth: z.number().int().nonnegative(),
  oldestGateAgeMs: z.number().int().nonnegative().nullable(),
  serializedOperation: z.object({
    operation: z.enum(manifestGateOperationKinds),
    providerKey: providerPlatformKeySchema,
    state: z.enum(["persisted", "sent", "accepted", "retry_wait", "blocked"]),
    attemptCount: z.number().int().nonnegative(),
    failureCode: safeCodeSchema.nullable(),
  }).nullable(),
  lastActivationAt: instantSchema.nullable(),
  lastReconciliationAt: instantSchema.nullable(),
  latestInvocation: promotionJobInvocationMonitoringSchema.nullable(),
});

export const promotionJobEvaluatorMonitoringSchema = z.object({
  state: z.enum(["pending", "current", "stale", "failed"]),
  observedAt: instantSchema.nullable(),
  evaluatedThrough: instantSchema.nullable(),
  rosterVersion: decimalSchema.nullable(),
  rosterHighWater: decimalSchema.nullable(),
  rosterDigest: digestSchema.nullable(),
  expectedCount: z.number().int().nonnegative().nullable(),
  reachableCount: z.number().int().nonnegative().nullable(),
  unavailableCount: z.number().int().nonnegative().nullable(),
  manifestEvaluated: z.boolean().nullable(),
  failureCode: safeCodeSchema.nullable(),
});

export const promotionJobMonitoringOverviewSchema = z.object({
  observedAt: instantSchema,
  roster: z.object({
    observedAt: instantSchema,
    version: decimalSchema,
    highWater: decimalSchema,
    digest: digestSchema,
    providerCount: z.number().int().nonnegative(),
    eligibleProviderCount: z.number().int().nonnegative(),
  }),
  evaluator: promotionJobEvaluatorMonitoringSchema,
  manifest: manifestPromotionJobMonitoringSchema,
  providers: z.array(providerPromotionJobMonitoringSchema),
}).superRefine((overview, context) => {
  if (
    overview.providers.length !== overview.roster.providerCount
    || new Set(overview.providers.map(({ providerKey }) => providerKey)).size
      !== overview.providers.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Promotion job roster evidence is inconsistent.",
      path: ["providers"],
    });
  }
});

export const promotionJobHistoryPageSchema = z.object({
  items: z.array(promotionJobInvocationMonitoringSchema).max(100),
  nextCursor: z.string().min(1).max(1_024).nullable(),
  rosterDigest: digestSchema,
});

const promotionJobOperationMonitoringSchema = z.object({
  operationNumber: z.number().int().nonnegative(),
  kind: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  state: z.enum(["pending", "sent", "acknowledged"]),
  sendCount: z.number().int().nonnegative(),
  sentAt: instantSchema.nullable(),
  acknowledgedAt: instantSchema.nullable(),
  operationIdDigest: digestSchema,
  requestDigest: digestSchema,
  receiptDigest: digestSchema.nullable(),
});

const promotionJobAttemptMonitoringSchema = z.object({
  attemptNumber: z.number().int().nonnegative(),
  kind: z.enum(["provider", "manifest"]),
  state: safeStateSchema,
  targetPosition: decimalSchema,
  retryCount: z.number().int().nonnegative(),
  failureCode: safeCodeSchema.nullable(),
  publicReleaseId: safePublicIdSchema.nullable(),
  releaseFingerprint: digestSchema.nullable(),
  totalOperationCount: z.number().int().nonnegative(),
  truncatedOperationCount: z.number().int().nonnegative(),
  orderedOperationDigest: digestSchema,
  operationSummariesDigest: digestSchema,
  operations: z.array(promotionJobOperationMonitoringSchema).max(25),
  observedAt: instantSchema,
});

export const promotionJobInvocationDetailSchema = z.object({
  invocation: promotionJobInvocationMonitoringSchema,
  totalAttemptCount: z.number().int().nonnegative(),
  truncatedAttemptCount: z.number().int().nonnegative(),
  attemptSetDigest: digestSchema,
  attempts: z.array(promotionJobAttemptMonitoringSchema).max(25),
});
