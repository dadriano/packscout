import { z } from "zod";

export const operationalEventKindSchema = z.enum([
  "run_failed",
  "run_incomplete",
  "provider_stale",
  "provider_recovered",
  "quarantine_resolved",
  "quarantine_expired",
  "retention_failed",
  "retention_recovered",
]);

export const operationalSeveritySchema = z.enum(["info", "warning", "critical"]);
export const operationalStableCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,127}$/);
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
      })
      .strict(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type OperationalEventKind = z.infer<typeof operationalEventKindSchema>;
export type OperationalSeverity = z.infer<typeof operationalSeveritySchema>;
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
