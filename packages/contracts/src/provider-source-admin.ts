import { z } from "zod";
import {
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
} from "./dataforrest-events-v1.ts";
import { launchProviderKeySchema } from "./provider-source-contract-v1.ts";

export const productionProviderSourceTypeKeys = [
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
] as const;

export const productionProviderSourceTypeKeySchema = z.enum(
  productionProviderSourceTypeKeys,
);

const uuidSchema = z.string().uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const providerSourceHealthGenerationSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/u);
export const providerSourceCursorGenerationSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/u);

const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120);
const endpointSchema = z.string().trim().min(1).max(2_048);
const bearerCredentialSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      value === value.trim() &&
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      }),
  );
const registrationKeySchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u);
const testResultSafeCodeSchema = z.union([
  registrationKeySchema,
  z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
]);

export const providerSourceIntervalSecondsSchema = z.coerce
  .number()
  .int()
  .min(60)
  .max(86_400);

export const providerSourceAdminErrorCodes = [
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "INVALID_SOURCE_CONFIGURATION",
  "SOURCE_NOT_FOUND",
  "CONNECTION_NOT_FOUND",
  "SOURCE_CONFLICT",
  "SOURCE_DEPENDENCY_REQUIRED",
  "SOURCE_TEST_REQUIRED",
  "SOURCE_UPSTREAM_UNAVAILABLE",
  "RESET_CONFIRMATION_REQUIRED",
] as const;

export type ProviderSourceAdminErrorCode =
  (typeof providerSourceAdminErrorCodes)[number];

const providerSourceAdminAuditReceiptBaseSchema = z
  .object({
    actor: z.literal("current_operator"),
    action: z.enum([
      "connection_profile_created",
      "connection_test_requested",
      "connection_revision_activated",
      "connection_credential_rotated",
      "connection_revision_revoked",
      "connection_recovery_revision_created",
      "connection_recovery_test_requested",
      "connection_recovery_activated",
      "source_created",
      "source_test_requested",
      "source_activated_paused",
      "source_pause_requested",
      "source_paused",
      "source_resumed",
      "source_disabled",
      "source_interval_revised",
      "source_cursor_reset",
    ]),
    subjectType: z.enum(["source_connection_profile", "provider_source"]),
    subjectId: uuidSchema.nullable(),
    revisionId: uuidSchema.nullable(),
    occurredAt: timestampSchema,
  })
  .strict();

export const providerSourceAdminAuditReceiptSchema = z.discriminatedUnion(
  "outcome",
  [
    providerSourceAdminAuditReceiptBaseSchema.extend({
      outcome: z.literal("success"),
    }).strict(),
    providerSourceAdminAuditReceiptBaseSchema.extend({
      outcome: z.literal("failure"),
      safeCode: z.enum(providerSourceAdminErrorCodes),
    }).strict(),
  ],
);

export type ProviderSourceAdminAuditReceipt = z.infer<
  typeof providerSourceAdminAuditReceiptSchema
>;

export const providerSourceTestStateSchema = z.enum([
  "not_requested",
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "fenced",
]);

const providerSourceTestSummarySchema = z
  .object({
    jobId: uuidSchema.nullable(),
    connectionRevisionId: uuidSchema.nullable(),
    current: z.boolean(),
    state: providerSourceTestStateSchema,
    outcome: z.enum(["success", "failure"]).nullable(),
    safeCode: testResultSafeCodeSchema.nullable(),
    requestedAt: timestampSchema.nullable(),
    testedAt: timestampSchema.nullable(),
  })
  .strict();

export const sourceConnectionRevisionAdminSummarySchema = z
  .object({
    id: uuidSchema,
    revisionNumber: z.number().int().positive(),
    sourceAdapterVersion: registrationKeySchema,
    state: z.enum(["candidate", "active", "retired", "revoked"]),
    endpointHost: z.string().min(1).max(253),
    credentialConfigured: z.literal(true),
    credentialMask: z.literal("••••••••"),
    encryptionKeyVersion: z.number().int().positive(),
    healthGeneration: providerSourceHealthGenerationSchema,
    revokedAt: timestampSchema.nullable(),
    test: providerSourceTestSummarySchema,
    createdAt: timestampSchema,
  })
  .strict();

export const sourceConnectionProfileAdminSummarySchema = z
  .object({
    id: uuidSchema,
    displayName: displayNameSchema,
    sourceTypeKey: productionProviderSourceTypeKeySchema,
    connectionTypeKey: registrationKeySchema,
    state: z.enum(["draft", "active", "disabled"]),
    requestLimit: z.literal(2),
    activeRevisionId: uuidSchema.nullable(),
    activeRevision: sourceConnectionRevisionAdminSummarySchema.nullable(),
    recoveryFence: z
      .object({
        blockedRevisionId: uuidSchema,
        blockingEpisodeId: uuidSchema.nullable(),
      })
      .strict()
      .nullable(),
    latestRevision: sourceConnectionRevisionAdminSummarySchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const providerSourceAdminSummarySchema = z
  .object({
    providerId: uuidSchema,
    provider: launchProviderKeySchema,
    sourceInstanceId: uuidSchema,
    sourceRevisionId: uuidSchema,
    sourceTypeKey: productionProviderSourceTypeKeySchema,
    sourceAdapterVersion: registrationKeySchema,
    connectionProfileId: uuidSchema,
    connectionRevisionId: uuidSchema.nullable(),
    state: z.enum(["draft", "paused", "active", "disabled", "replaced"]),
    pauseRequested: z.boolean(),
    normalizedContractVersion: registrationKeySchema,
    mapperKey: registrationKeySchema,
    mapperVersion: registrationKeySchema,
    identityNamespaceKey: registrationKeySchema,
    recordIdScopes: z.array(registrationKeySchema).min(1).max(32),
    intervalSeconds: providerSourceIntervalSecondsSchema,
    freshnessGraceSeconds: z.literal(900),
    scheduleRevisionId: uuidSchema,
    cursor: z
      .object({
        generation: providerSourceCursorGenerationSchema,
        fingerprint: sha256Schema.nullable(),
        resumeLabel: z.enum(["Feed start", "Saved cursor"]),
      })
      .strict(),
    test: providerSourceTestSummarySchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const providerSourceAdminCatalogSchema = z
  .object({
    availableSourceTypes: z
      .array(
        z
          .object({
            sourceTypeKey: productionProviderSourceTypeKeySchema,
            sourceAdapterVersion: registrationKeySchema,
            label: z.string().min(1).max(120),
          })
          .strict(),
      )
      .length(1),
    providers: z.array(
      z
        .object({
          id: uuidSchema,
          provider: launchProviderKeySchema,
          sourceRegistration: z
            .object({
              sourceTypeKey: productionProviderSourceTypeKeySchema,
              sourceAdapterVersion: registrationKeySchema,
              normalizedContractVersion: registrationKeySchema,
              mapperKey: registrationKeySchema,
              mapperVersion: registrationKeySchema,
              identityNamespaceKey: registrationKeySchema,
              recordIdScopes: z.array(registrationKeySchema).min(1).max(32),
            })
            .strict(),
        })
        .strict(),
    ),
    connections: z.array(sourceConnectionProfileAdminSummarySchema),
    sources: z.array(providerSourceAdminSummarySchema),
  })
  .strict();

export const createSourceConnectionProfileRequestSchema = z
  .object({
    sourceTypeKey: productionProviderSourceTypeKeySchema,
    displayName: displayNameSchema,
    endpoint: endpointSchema,
    bearerCredential: bearerCredentialSchema,
    requestLimit: z.coerce.number().pipe(z.literal(2)),
  })
  .strict();

export const rotateSourceConnectionCredentialRequestSchema = z
  .object({
    expectedRevisionId: uuidSchema,
    bearerCredential: bearerCredentialSchema,
  })
  .strict();

export const createSourceConnectionRecoveryRevisionRequestSchema = z
  .object({
    expectedBlockedRevisionId: uuidSchema,
    expectedLatestRevisionId: uuidSchema,
    blockingEpisodeId: uuidSchema.nullable(),
    bearerCredential: bearerCredentialSchema,
  })
  .strict();

export const requestSourceConnectionRecoveryTestSchema = z
  .object({
    expectedRevisionId: uuidSchema,
    expectedHealthGeneration: providerSourceHealthGenerationSchema,
    blockedRevisionId: uuidSchema,
    blockingEpisodeId: uuidSchema.nullable(),
  })
  .strict();

export const activateSourceConnectionRecoveryRequestSchema =
  requestSourceConnectionRecoveryTestSchema;

export const sourceConnectionRevisionCommandSchema = z
  .object({ expectedRevisionId: uuidSchema })
  .strict();

export const revokeSourceConnectionRevisionRequestSchema = z
  .object({
    expectedRevisionId: uuidSchema,
    confirmation: z.literal("REVOKE"),
  })
  .strict();

const sourcePinInputSchema = z
  .object({
    providerId: uuidSchema,
    connectionProfileId: uuidSchema,
    sourceTypeKey: productionProviderSourceTypeKeySchema,
    mapperKey: registrationKeySchema,
    mapperVersion: registrationKeySchema,
    intervalSeconds: providerSourceIntervalSecondsSchema.default(60),
  })
  .strict();

export const createProviderSourceRequestSchema = sourcePinInputSchema;

export const providerSourceRevisionCommandSchema = z
  .object({
    expectedSourceRevisionId: uuidSchema,
    expectedConnectionRevisionId: uuidSchema.optional(),
  })
  .strict();

export const reviseProviderSourceIntervalRequestSchema = z
  .object({
    expectedSourceRevisionId: uuidSchema,
    expectedScheduleRevisionId: uuidSchema,
    intervalSeconds: providerSourceIntervalSecondsSchema,
  })
  .strict();

export const previewProviderSourceCursorResetRequestSchema = z
  .object({ expectedSourceRevisionId: uuidSchema })
  .strict();

export const providerSourceCursorResetPreviewSchema = z
  .object({
    providerId: uuidSchema,
    provider: launchProviderKeySchema,
    sourceInstanceId: uuidSchema,
    sourceRevisionId: uuidSchema,
    sourceState: z.enum(["paused", "disabled"]),
    cursorGeneration: providerSourceCursorGenerationSchema,
    cursorFingerprint: sha256Schema.nullable(),
    confirmation: z.string().min(1).max(80),
    consequence: z.literal(
      "The saved cursor will be cleared and the next resume will start from Feed start.",
    ),
  })
  .strict();

export const confirmProviderSourceCursorResetRequestSchema = z
  .object({
    expectedSourceRevisionId: uuidSchema,
    expectedCursorGeneration: providerSourceCursorGenerationSchema,
    expectedCursorFingerprint: sha256Schema.nullable(),
    confirmation: z.string().min(1).max(80),
  })
  .strict();

export type ProviderSourceAdminCatalog = z.infer<
  typeof providerSourceAdminCatalogSchema
>;
export type SourceConnectionProfileAdminSummary = z.infer<
  typeof sourceConnectionProfileAdminSummarySchema
>;
export type ProviderSourceAdminSummary = z.infer<
  typeof providerSourceAdminSummarySchema
>;
export type ProviderSourceCursorResetPreview = z.infer<
  typeof providerSourceCursorResetPreviewSchema
>;
export type CreateSourceConnectionProfileRequest = z.input<
  typeof createSourceConnectionProfileRequestSchema
>;
export type RotateSourceConnectionCredentialRequest = z.input<
  typeof rotateSourceConnectionCredentialRequestSchema
>;
export type CreateSourceConnectionRecoveryRevisionRequest = z.input<
  typeof createSourceConnectionRecoveryRevisionRequestSchema
>;
export type CreateProviderSourceRequest = z.input<
  typeof createProviderSourceRequestSchema
>;
export type ProviderSourceRevisionCommand = z.input<
  typeof providerSourceRevisionCommandSchema
>;
export type ReviseProviderSourceIntervalRequest = z.input<
  typeof reviseProviderSourceIntervalRequestSchema
>;
export type ConfirmProviderSourceCursorResetRequest = z.input<
  typeof confirmProviderSourceCursorResetRequestSchema
>;
