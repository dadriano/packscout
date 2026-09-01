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
  .regex(/^pj_[A-Za-z0-9_-]{24,120}$/u);

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
  readonly position: string;
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
