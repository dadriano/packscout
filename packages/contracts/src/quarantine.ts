import { z } from "zod";

const stableCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);

export const quarantineIdSchema = z.uuid();

export const quarantineListQuerySchema = z.object({
  providerId: z.uuid().optional(),
  state: z.enum(["open", "retrying", "resolved", "expired"]).optional(),
  reasonCode: stableCodeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const quarantineRetryBulkRequestSchema = z
  .object({
    quarantineIds: z.array(z.uuid()).min(1).max(50),
  })
  .strict()
  .refine(
    ({ quarantineIds }) => new Set(quarantineIds).size === quarantineIds.length,
    { message: "quarantine.duplicate_id", path: ["quarantineIds"] },
  );

export type QuarantineLifecycleState =
  | "open"
  | "retrying"
  | "resolved"
  | "expired";

export interface QuarantineEntrySummary {
  readonly id: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly platformKey: string;
  readonly runId: string;
  readonly pageId: string;
  readonly recordKind: "catalog" | "pull" | "trade" | "unknown";
  readonly recordIndex: number;
  readonly externalId: string | null;
  readonly reasonCode: string;
  readonly fieldPath: string | null;
  readonly sanitizedSummary: string;
  readonly state: QuarantineLifecycleState;
  readonly attemptCount: number;
  readonly firstFailureAt: string;
  readonly latestFailureAt: string;
  readonly rawExpiresAt: string;
  readonly resolvedAt: string | null;
  readonly resolutionSummary: string | null;
}

export interface QuarantineAttemptSummary {
  readonly id: string;
  readonly state: "running" | "succeeded" | "failed";
  readonly failureCode: string | null;
  readonly fieldPath: string | null;
  readonly sanitizedSummary: string | null;
  readonly canonicalRevisionCount: number | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface QuarantineEntryDetail extends QuarantineEntrySummary {
  readonly attempts: readonly QuarantineAttemptSummary[];
}

export interface QuarantineCounts {
  readonly outstanding: number;
  readonly retrying: number;
  readonly resolved: number;
  readonly expired: number;
}

export type QuarantineRetryOutcomeCode =
  | "resolved"
  | "failed"
  | "already_retrying"
  | "already_resolved"
  | "expired"
  | "not_found";

export interface QuarantineRetryOutcome {
  readonly quarantineId: string;
  readonly outcome: QuarantineRetryOutcomeCode;
  readonly entry: QuarantineEntrySummary | null;
}

export type QuarantineServiceErrorCode =
  | "FORBIDDEN"
  | "INVALID_QUARANTINE_REQUEST"
  | "QUARANTINE_NOT_FOUND";

export type QuarantineListQuery = z.input<typeof quarantineListQuerySchema>;
export type NormalizedQuarantineListQuery = z.output<typeof quarantineListQuerySchema>;
export type QuarantineRetryBulkRequest = z.input<
  typeof quarantineRetryBulkRequestSchema
>;
