import { z } from "zod";
import {
  launchProviderKeySchema,
  normalizedContinuationSchema,
  providerSourceLaunchBounds,
} from "./provider-source-contract-v1.ts";

export const PROVIDER_SOURCE_SUPERVISOR_SNAPSHOT_VERSION =
  "packscout.provider-source-supervisor-snapshot.v1" as const;

export const providerSourceRunBounds = Object.freeze({
  maximumCommittedPages: 1_000,
  maximumElapsedMilliseconds: 15 * 60 * 1_000,
});

/** Source-owned retry timing. Control-plane transactions use the separate
 * exact 0/100/400 ms policy from provider-source-contract-v1. */
export const providerSourceTransientRetryPolicy = Object.freeze({
  maximumAttempts: 3,
  backoffMilliseconds: Object.freeze([1_000, 5_000, 15_000] as const),
});

export const providerSourceSupervisorPhases = [
  "idle",
  "due",
  "queued",
  "claimed",
  "requesting",
  "validating",
  "committing",
  "retry_wait",
  "waiting",
  "paused",
  "action_required",
  "reached_head",
  "terminal",
] as const;

export const providerSourceSupervisorActivities = [
  "inactive",
  "queued",
  "running",
  "waiting",
  "paused",
  "action_required",
] as const;

export const providerSourceSupervisorWaitReasons = [
  "not_due",
  "profile_capacity",
  "execution_capacity",
  "capacity_blocked",
  "connection_blocked",
  "paused",
  "retry_backoff",
  "action_required",
  "supervisor_offline",
  "graceful_shutdown",
  "source_lane_busy",
] as const;

export type ProviderSourceSupervisorPhase =
  (typeof providerSourceSupervisorPhases)[number];
export type ProviderSourceSupervisorActivity =
  (typeof providerSourceSupervisorActivities)[number];
export type ProviderSourceSupervisorWaitReason =
  (typeof providerSourceSupervisorWaitReasons)[number];

const isoTimestampSchema = z.string().datetime({ offset: true });
const uuidSchema = z.string().uuid();
const safeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const providerSourceSupervisorPhaseSchema = z.enum(
  providerSourceSupervisorPhases,
);
export const providerSourceSupervisorActivitySchema = z.enum(
  providerSourceSupervisorActivities,
);
export const providerSourceSupervisorWaitReasonSchema = z.enum(
  providerSourceSupervisorWaitReasons,
);

export const providerSourceSupervisorPresenceSchema = z
  .object({
    state: z.enum(["offline", "active", "fenced_draining"]),
    environmentKey: z.string().trim().min(1).max(128),
    databaseTime: isoTimestampSchema,
    epochId: uuidSchema.nullable(),
    epochNumber: z.string().regex(/^(?:0|[1-9][0-9]*)$/u).nullable(),
    ownerKey: z.string().trim().min(1).max(128).nullable(),
    lastRenewedAt: isoTimestampSchema.nullable(),
    leaseExpiresAt: isoTimestampSchema.nullable(),
    safeTakeoverAt: isoTimestampSchema.nullable(),
    safeReasonCode: safeCodeSchema.nullable(),
  })
  .strict();

export const providerSourceSupervisorProfileCapacitySchema = z
  .object({
    organizationId: uuidSchema,
    connectionProfileId: uuidSchema,
    used: z.number().int().min(0),
    maximum: z.number().int().min(1),
    waiting: z.number().int().min(0),
  })
  .strict()
  .refine((value) => value.used <= value.maximum, {
    message: "provider_source.supervisor_profile_capacity_invalid",
  });

export const providerSourceSupervisorCapacitySchema = z
  .object({
    state: z.enum(["available", "blocked", "probe_failed"]),
    safeCode: safeCodeSchema.nullable(),
    checkedAt: isoTimestampSchema.nullable(),
    executionSlots: z
      .object({
        used: z.number().int().min(0),
        maximum: z.number().int().min(1).max(64),
      })
      .strict(),
    profiles: z.array(providerSourceSupervisorProfileCapacitySchema),
  })
  .strict()
  .refine(
    (value) => value.executionSlots.used <= value.executionSlots.maximum,
    { message: "provider_source.supervisor_execution_capacity_invalid" },
  )
  .refine(
    (value) => value.state === "available"
      ? value.safeCode === null
      : value.safeCode !== null,
    { message: "provider_source.supervisor_capacity_code_invalid" },
  );

export const providerSourceSupervisorLaneSchema = z
  .object({
    organizationId: uuidSchema,
    providerId: uuidSchema,
    provider: launchProviderKeySchema,
    sourceInstanceId: uuidSchema,
    sourceRevisionId: uuidSchema,
    connectionProfileId: uuidSchema,
    connectionRevisionId: uuidSchema,
    sourceTypeKey: z.string().trim().min(1).max(128),
    sourceAdapterVersion: z.string().trim().min(1).max(128),
    normalizedContractVersion: z.string().trim().min(1).max(128),
    mapperKey: z.string().trim().min(1).max(128),
    mapperVersion: z.string().trim().min(1).max(128),
    identityNamespaceKey: z.string().trim().min(1).max(128),
    checkpointCodecVersion: z.string().trim().min(1).max(128),
    checkpointGeneration: z.string().regex(/^[1-9][0-9]*$/u),
    lifecycle: z.enum(["draft", "paused", "active", "disabled", "replaced"]),
    phase: providerSourceSupervisorPhaseSchema,
    activity: providerSourceSupervisorActivitySchema,
    waitReason: providerSourceSupervisorWaitReasonSchema.nullable(),
    actionRequiredCode: safeCodeSchema.nullable(),
    currentRunId: uuidSchema.nullable(),
    runLeaseAgeMilliseconds: z.number().int().min(0).nullable(),
    retry: z
      .object({
        attempt: z.number().int().min(0),
        notBefore: isoTimestampSchema.nullable(),
      })
      .strict(),
    progress: z
      .object({
        pagesCommitted: z.number().int().min(0),
        recordsCommitted: z.number().int().min(0),
        lastProgressAt: isoTimestampSchema.nullable(),
      })
      .strict(),
    checkpointFingerprint: fingerprintSchema.nullable(),
    continuation: normalizedContinuationSchema.nullable(),
    nextDueAt: isoTimestampSchema.nullable(),
    connectionEpisode: z
      .object({
        episodeId: uuidSchema,
        healthGeneration: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.activity === "waiting") !== (value.waitReason !== null)) {
      context.addIssue({
        code: "custom",
        message: "provider_source.supervisor_wait_shape_invalid",
        path: ["waitReason"],
      });
    }
    if (
      (value.activity === "action_required") !==
        (value.actionRequiredCode !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "provider_source.supervisor_action_shape_invalid",
        path: ["actionRequiredCode"],
      });
    }
  });

export const providerSourceSupervisorSnapshotSchema = z
  .object({
    version: z.literal(PROVIDER_SOURCE_SUPERVISOR_SNAPSHOT_VERSION),
    presence: providerSourceSupervisorPresenceSchema,
    capacity: providerSourceSupervisorCapacitySchema,
    sources: z.array(providerSourceSupervisorLaneSchema),
  })
  .strict();

export type ProviderSourceSupervisorSnapshot = z.infer<
  typeof providerSourceSupervisorSnapshotSchema
>;

export const providerSourceSupervisorDefaults = Object.freeze({
  executionSlots: providerSourceLaunchBounds.genericExecutionSlots,
  pollIntervalMilliseconds: 1_000,
});
