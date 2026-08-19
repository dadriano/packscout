import { z } from "zod";
import { providerPlatformKeySchema } from "./provider.ts";

export const operationalEventKindSchema = z.enum([
  "run_failed",
  "run_incomplete",
  "provider_stale",
  "provider_recovered",
  "quarantine_resolved",
  "quarantine_expired",
  "retention_failed",
  "retention_recovered",
  "promotion_activation_delayed",
  "promotion_settlement_blocked",
  "promotion_failed",
  "promotion_recovered",
]);

export const operationalSeveritySchema = z.enum(["info", "warning", "critical"]);
export const operationalStableCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const promotionLaneSchema = z.enum(["provider", "manifest", "heat"]);
export const promotionOperationalConditionSchema = z.enum([
  "activation_lag",
  "settlement_blocked",
  "terminal_failure",
  "reconciliation_failure",
  "recovered",
]);
const promotionWatermarkSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/);
const boundedKeySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9:._-]*$/);
const unsafeOperationalText =
  /(?:authorization|bearer\s+|cookie|password|secret(?:\s|=|:)|0x[0-9a-f]{16,})/i;
const safeTitleSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => !unsafeOperationalText.test(value));
const safeSummarySchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !unsafeOperationalText.test(value));

export const operationalNotificationSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    kind: operationalEventKindSchema,
    severity: operationalSeveritySchema,
    providerId: z.uuid().nullable(),
    runId: z.uuid().nullable(),
    quarantineId: z.uuid().nullable(),
    dedupeKey: boundedKeySchema,
    recoveryKey: boundedKeySchema,
    title: safeTitleSchema,
    summary: safeSummarySchema,
    evidence: z
      .object({
        failureCode: operationalStableCodeSchema.optional(),
        reasonCode: operationalStableCodeSchema.optional(),
        outcome: operationalStableCodeSchema.optional(),
        count: z.number().int().nonnegative().optional(),
        durationMs: z.number().int().nonnegative().optional(),
        lane: promotionLaneSchema.optional(),
        platformKey: providerPlatformKeySchema.optional(),
        condition: promotionOperationalConditionSchema.optional(),
        targetWatermark: promotionWatermarkSchema.optional(),
        confirmedWatermark: promotionWatermarkSchema.optional(),
        attemptId: z.uuid().optional(),
      })
      .strict(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((event, context) => {
    const promotionEvidence = [
      event.evidence.lane,
      event.evidence.condition,
      event.evidence.targetWatermark,
      event.evidence.confirmedWatermark,
      event.evidence.attemptId,
      event.evidence.platformKey,
    ];
    if (!event.kind.startsWith("promotion_")) {
      if (promotionEvidence.some((value) => value !== undefined)) {
        context.addIssue({
          code: "custom",
          message: "Promotion evidence is not valid for this event kind.",
          path: ["evidence"],
        });
      }
      return;
    }
    if (
      event.providerId !== null ||
      event.runId !== null ||
      event.quarantineId !== null ||
      event.evidence.lane === undefined ||
      event.evidence.condition === undefined ||
      event.evidence.targetWatermark === undefined ||
      event.evidence.confirmedWatermark === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Promotion events require lane-bound public evidence.",
        path: ["evidence"],
      });
      return;
    }
    const condition = event.evidence.condition;
    if ((event.evidence.lane === "provider") !==
      (event.evidence.platformKey !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Provider promotion evidence requires one platform key.",
        path: ["evidence", "platformKey"],
      });
      return;
    }
    const laneKeys = event.evidence.lane === "provider"
      ? ["lane", "platformKey"]
      : ["lane"];
    const allowedEvidenceKeys = new Set<string>(
      event.kind === "promotion_activation_delayed"
        ? [...laneKeys, "condition", "targetWatermark", "confirmedWatermark", "durationMs"]
        : event.kind === "promotion_settlement_blocked"
          ? [...laneKeys, "condition", "targetWatermark", "confirmedWatermark", "count"]
          : event.kind === "promotion_failed"
            ? [
                ...laneKeys,
                "condition",
                "targetWatermark",
                "confirmedWatermark",
                "attemptId",
                "failureCode",
              ]
            : [
                ...laneKeys,
                "condition",
                "targetWatermark",
                "confirmedWatermark",
                "outcome",
              ],
    );
    const exactEvidence = Object.keys(event.evidence).every((key) =>
      allowedEvidenceKeys.has(key)
    );
    const valid =
      exactEvidence &&
      ((event.kind === "promotion_activation_delayed" &&
        condition === "activation_lag" &&
        event.evidence.durationMs !== undefined) ||
      (event.kind === "promotion_settlement_blocked" &&
        condition === "settlement_blocked" &&
        event.evidence.count !== undefined &&
        event.evidence.count > 0) ||
      (event.kind === "promotion_failed" &&
        (condition === "terminal_failure" ||
          condition === "reconciliation_failure") &&
        event.evidence.failureCode !== undefined &&
        event.evidence.attemptId !== undefined) ||
      (event.kind === "promotion_recovered" &&
        condition === "recovered" &&
        event.evidence.outcome === "PROMOTION_RECOVERED"));
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "Promotion event evidence does not match its kind.",
        path: ["evidence"],
      });
    }
  });

export type OperationalEventKind = z.infer<typeof operationalEventKindSchema>;
export type OperationalSeverity = z.infer<typeof operationalSeveritySchema>;
export type PromotionLane = z.infer<typeof promotionLaneSchema>;
export type PromotionOperationalCondition = z.infer<
  typeof promotionOperationalConditionSchema
>;
export type OperationalNotification = z.infer<
  typeof operationalNotificationSchema
>;

export type NotificationPublishStatus =
  | "accepted"
  | "deduplicated"
  | "resolved"
  | "failed";

export interface NotificationPublishResult {
  readonly status: NotificationPublishStatus;
  readonly alertId: string | null;
  readonly failureCode: string | null;
}

export type AdminAlertState = "active" | "acknowledged" | "resolved";

export interface AdminAlertSummary {
  readonly id: string;
  readonly kind: OperationalEventKind;
  readonly severity: OperationalSeverity;
  readonly state: AdminAlertState;
  readonly title: string;
  readonly summary: string;
  readonly providerId: string | null;
  readonly runId: string | null;
  readonly quarantineId: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly occurrenceCount: number;
  readonly reopenedCount: number;
  readonly acknowledgedAt: string | null;
  readonly resolvedAt: string | null;
}

export interface AdminAlertOccurrence {
  readonly id: string;
  readonly kind: OperationalEventKind;
  readonly severity: OperationalSeverity;
  readonly occurredAt: string;
  readonly evidence: OperationalNotification["evidence"];
}

export interface AdminAlertDetail extends AdminAlertSummary {
  readonly occurrences: readonly AdminAlertOccurrence[];
}

export interface RetentionBatchResult {
  readonly executionId: string;
  readonly selected: number;
  readonly expired: number;
  readonly alreadyExpired: number;
  readonly failed: number;
  readonly remaining: number;
  readonly pagesExpired: number;
  readonly sourceRecordsExpired: number;
  readonly quarantinesExpired: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly replayed: boolean;
}

export type OperationalDependencyState =
  | "unconfigured"
  | "healthy"
  | "stale"
  | "degraded"
  | "failed";

export interface ProtectedOperationalHealthDetail {
  readonly state: OperationalDependencyState;
  readonly checkedAt: string;
  readonly configuredProviderCount: number;
  readonly staleProviderCount: number;
  readonly degradedProviderCount: number;
  readonly failedProviderCount: number;
  readonly activeAlertCount: number;
  readonly latestRetentionState: "never_run" | "succeeded" | "failed";
  readonly latestRetentionAt: string | null;
  readonly latestRetentionFailureCode: string | null;
}

export interface ShallowLiveness {
  readonly status: "live";
}
