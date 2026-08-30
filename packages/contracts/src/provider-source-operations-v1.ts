import { z } from "zod";
import {
  launchProviderKeySchema,
  normalizedContinuationSchema,
  providerSourceDiagnosticSeveritySchema,
} from "./provider-source-contract-v1.ts";
import {
  productionProviderSourceTypeKeySchema,
  providerSourceCursorGenerationSchema,
  providerSourceHealthGenerationSchema,
  providerSourceTestStateSchema,
} from "./provider-source-admin.ts";
import {
  providerSourceSupervisorActivitySchema,
  providerSourceSupervisorPhaseSchema,
  providerSourceSupervisorWaitReasonSchema,
} from "./provider-source-supervisor-v1.ts";

export const PROVIDER_SOURCE_OPERATIONS_VERSION =
  "packscout.provider-source-operations.v1" as const;

const uuidSchema = z.string().uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const registrationKeySchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u);
const safeCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedCountSchema = z.number().int().min(0);

export const providerSourceOperationsRunStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "incomplete",
  "failed",
]);

export const providerSourceOperationsRunTriggerSchema = z.enum([
  "scheduled",
  "manual",
  "continuation",
  "recovery",
]);

const safeTestSummarySchema = z.object({
  state: providerSourceTestStateSchema,
  outcome: z.enum(["success", "failure"]).nullable(),
  safeCode: registrationKeySchema.nullable(),
  requestedAt: timestampSchema.nullable(),
  testedAt: timestampSchema.nullable(),
  current: z.boolean(),
}).strict();

export const providerSourceOperationsSourceTypeSchema = z.object({
  sourceTypeKey: productionProviderSourceTypeKeySchema,
  label: z.string().trim().min(1).max(120),
  adapterVersion: registrationKeySchema,
  normalizedContractVersion: registrationKeySchema,
  capabilities: z.object({
    connectionTest: z.boolean(),
    sourceTest: z.boolean(),
    pageRead: z.boolean(),
    cancellation: z.boolean(),
  }).strict(),
}).strict();

export const providerSourceOperationsConnectionSchema = z.object({
  connectionProfileId: uuidSchema,
  displayName: z.string().trim().min(1).max(120),
  sourceType: providerSourceOperationsSourceTypeSchema,
  state: z.enum(["draft", "active", "disabled"]),
  endpointHost: z.string().min(1).max(253),
  credential: z.object({
    configured: z.literal(true),
    mask: z.literal("••••••••"),
  }).strict(),
  test: safeTestSummarySchema,
  health: z.object({
    generation: providerSourceHealthGenerationSchema,
    state: z.enum(["healthy", "blocked", "reconnecting"]),
    blocking: z.object({
      safeCode: safeCodeSchema,
      openedAt: timestampSchema,
    }).strict().nullable(),
  }).strict(),
  supervisor: z.object({
    state: z.enum(["offline", "active", "fenced_draining"]),
    lastRenewedAt: timestampSchema.nullable(),
    leaseExpiresAt: timestampSchema.nullable(),
    safeTakeoverAt: timestampSchema.nullable(),
    safeReasonCode: safeCodeSchema.nullable(),
  }).strict(),
  capacity: z.object({
    state: z.enum(["available", "blocked", "probe_failed"]),
    safeCode: safeCodeSchema.nullable(),
    executionSlots: z.object({
      used: boundedCountSchema,
      maximum: z.number().int().positive(),
    }).strict(),
    requestPermits: z.object({
      used: boundedCountSchema,
      maximum: z.number().int().positive(),
      waiting: boundedCountSchema,
    }).strict(),
  }).strict(),
}).strict();

const runSummarySchema = z.object({
  id: uuidSchema,
  trigger: providerSourceOperationsRunTriggerSchema,
  state: providerSourceOperationsRunStateSchema,
  requestedAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
  lastProgressAt: timestampSchema,
  reachedHead: z.boolean(),
  failureCode: safeCodeSchema.nullable(),
}).strict();

const countSummarySchema = z.object({
  catalog: boundedCountSchema,
  pulls: boundedCountSchema,
  trades: boundedCountSchema,
  total: boundedCountSchema,
}).strict();

const dispositionSummarySchema = z.object({
  inserted: boundedCountSchema.nullable(),
  revised: boundedCountSchema.nullable(),
  duplicate: boundedCountSchema,
  quarantined: boundedCountSchema,
}).strict().refine(
  ({ inserted, revised }) => (inserted === null) === (revised === null),
  { message: "Insert/update counts must be measured together or both unavailable." },
);

export const providerSourceOperationsSourceSchema = z.object({
  providerId: uuidSchema,
  provider: launchProviderKeySchema,
  displayName: z.string().trim().min(1).max(120),
  configured: z.boolean(),
  source: z.object({
    sourceInstanceId: uuidSchema,
    sourceRevisionId: uuidSchema,
    sourceTypeKey: productionProviderSourceTypeKeySchema,
    sourceAdapterVersion: registrationKeySchema,
    normalizedContractVersion: registrationKeySchema,
    mapperKey: registrationKeySchema,
    mapperVersion: registrationKeySchema,
    identityNamespaceKey: registrationKeySchema,
    recordIdScopes: z.array(registrationKeySchema).min(1).max(32),
    lifecycle: z.enum(["draft", "paused", "active", "disabled", "replaced"]),
    pauseRequested: z.boolean(),
    configuration: z.object({
      validated: z.literal(true),
      fields: z.array(z.object({
        label: z.string().trim().min(1).max(80),
        value: z.string().trim().min(1).max(160),
        masked: z.boolean(),
      }).strict()).max(16),
    }).strict(),
  }).strict().nullable(),
  schedule: z.object({
    scheduleRevisionId: uuidSchema,
    intervalSeconds: z.number().int().min(60).max(86_400),
    freshnessGraceSeconds: z.number().int().min(0).max(86_400),
    nextDueAt: timestampSchema.nullable(),
  }).strict().nullable(),
  processor: z.object({
    activity: providerSourceSupervisorActivitySchema,
    phase: providerSourceSupervisorPhaseSchema,
    waitReason: providerSourceSupervisorWaitReasonSchema.nullable(),
    actionRequiredCode: safeCodeSchema.nullable(),
    continuation: normalizedContinuationSchema.nullable(),
    retryCount: boundedCountSchema,
    retryNotBefore: timestampSchema.nullable(),
    runLeaseAgeMilliseconds: boundedCountSchema.nullable(),
  }).strict().nullable(),
  freshness: z.object({
    state: z.enum(["fresh", "stale", "unknown"]),
    lastHeadReachedAt: timestampSchema.nullable(),
    lastProgressAt: timestampSchema.nullable(),
  }).strict(),
  quality: z.object({
    state: z.enum(["healthy", "warning", "degraded", "unknown"]),
    consecutiveFailures: boundedCountSchema,
    latestFailureCode: safeCodeSchema.nullable(),
    recoveredAt: timestampSchema.nullable(),
  }).strict(),
  cursor: z.object({
    generation: providerSourceCursorGenerationSchema,
    fingerprint: fingerprintSchema.nullable(),
    resumeLabel: z.enum(["Feed start", "Saved cursor"]),
  }).strict().nullable(),
  progress: z.object({
    pages: boundedCountSchema,
    records: countSummarySchema,
    dispositions: dispositionSummarySchema,
    throughputRecordsPerSecond: z.number().min(0).nullable(),
    elapsedMilliseconds: boundedCountSchema,
    openQuarantine: boundedCountSchema,
    total: z.object({
      kind: z.literal("unknown"),
      label: z.literal("Total unknown"),
    }).strict(),
  }).strict(),
  activeRun: runSummarySchema.nullable(),
  latestRun: runSummarySchema.nullable(),
  connectionImpact: z.object({
    state: z.enum(["none", "blocked", "reconnecting", "uncertain"]),
    safeCode: safeCodeSchema.nullable(),
    healthGeneration: providerSourceHealthGenerationSchema.nullable(),
  }).strict(),
}).strict();

export const providerSourceOperationsConnectionModeSchema = z.enum([
  "none",
  "shared",
  "split",
]);

export const providerSourceOperationsOverviewSchema = z.object({
  version: z.literal(PROVIDER_SOURCE_OPERATIONS_VERSION),
  refreshedAt: timestampSchema,
  connectionMode: providerSourceOperationsConnectionModeSchema,
  connection: providerSourceOperationsConnectionSchema.nullable(),
  sources: z.array(providerSourceOperationsSourceSchema).min(1).max(50),
}).strict().superRefine((overview, context) => {
  const requiresConnection = overview.connectionMode === "shared";
  if (requiresConnection !== (overview.connection !== null)) {
    context.addIssue({
      code: "custom",
      message: "Shared overviews require exactly one representative connection",
      path: ["connection"],
    });
  }
});

const pageProgressSchema = z.object({
  runId: uuidSchema,
  pageNumber: z.number().int().positive(),
  committedAt: timestampSchema,
  records: countSummarySchema,
  dispositions: dispositionSummarySchema,
  continuation: normalizedContinuationSchema.nullable(),
  cursorFingerprint: fingerprintSchema.nullable(),
}).strict();

export const providerSourceOperationsDetailSchema = z.object({
  version: z.literal(PROVIDER_SOURCE_OPERATIONS_VERSION),
  refreshedAt: timestampSchema,
  connection: providerSourceOperationsConnectionSchema.nullable(),
  source: providerSourceOperationsSourceSchema,
  runHistory: z.array(runSummarySchema).max(25),
  pageProgress: z.array(pageProgressSchema).max(50),
  sourceTest: safeTestSummarySchema.nullable(),
}).strict();

export const providerSourceDiagnosticFilterSchema = z.object({
  severity: providerSourceDiagnosticSeveritySchema.optional(),
  phase: registrationKeySchema.optional(),
  runId: uuidSchema.optional(),
}).strict();

const diagnosticReferenceSchema = z.object({
  kind: z.enum(["run", "test", "command", "quarantine"]),
  label: z.string().trim().min(1).max(120),
  href: z.string().startsWith("/").max(512),
}).strict();

export const providerSourceDiagnosticEventSchema = z.object({
  scope: z.enum(["source", "connection"]),
  scopeLabel: z.enum(["Selected source", "Shared connection"]),
  eventKind: registrationKeySchema,
  severity: providerSourceDiagnosticSeveritySchema,
  phase: registrationKeySchema,
  safeCode: safeCodeSchema,
  occurredAt: timestampSchema,
  durationMilliseconds: boundedCountSchema.nullable(),
  responseBytes: boundedCountSchema.nullable(),
  retryDelayMilliseconds: boundedCountSchema.nullable(),
  continuation: normalizedContinuationSchema.nullable(),
  cursorFingerprint: fingerprintSchema.nullable(),
  counters: z.record(registrationKeySchema, boundedCountSchema),
  references: z.array(diagnosticReferenceSchema).max(4),
}).strict();

export const providerSourceDiagnosticHistorySchema = z.object({
  version: z.literal(PROVIDER_SOURCE_OPERATIONS_VERSION),
  refreshedAt: timestampSchema,
  snapshot: providerSourceOperationsSourceSchema,
  events: z.array(providerSourceDiagnosticEventSchema).max(50),
  nextCursor: z.string().min(1).max(2_048).nullable(),
  history: z.discriminatedUnion("state", [
    z.object({ state: z.literal("current") }).strict(),
    z.object({
      state: z.literal("expired"),
      message: z.literal(
        "Older diagnostic history has expired. Current source state is shown above.",
      ),
    }).strict(),
  ]),
  filter: z.object({
    severity: providerSourceDiagnosticSeveritySchema.nullable(),
    phase: registrationKeySchema.nullable(),
    runId: uuidSchema.nullable(),
    contextEventsHidden: z.boolean(),
  }).strict(),
  availablePhases: z.array(registrationKeySchema).max(64),
}).strict();

export type ProviderSourceOperationsOverview = z.infer<
  typeof providerSourceOperationsOverviewSchema
>;
export type ProviderSourceOperationsConnection = z.infer<
  typeof providerSourceOperationsConnectionSchema
>;
export type ProviderSourceOperationsConnectionMode = z.infer<
  typeof providerSourceOperationsConnectionModeSchema
>;
export type ProviderSourceOperationsSource = z.infer<
  typeof providerSourceOperationsSourceSchema
>;
export type ProviderSourceOperationsDetail = z.infer<
  typeof providerSourceOperationsDetailSchema
>;
export type ProviderSourceDiagnosticFilter = z.infer<
  typeof providerSourceDiagnosticFilterSchema
>;
export type ProviderSourceDiagnosticHistory = z.infer<
  typeof providerSourceDiagnosticHistorySchema
>;
