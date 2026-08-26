import { z } from "zod";

export const PROVIDER_SOURCE_CONTRACT_VERSION =
  "packscout.provider-source.v1" as const;
export const PROVIDER_OBSERVATION_CONTRACT_VERSION =
  "packscout.provider-observation.v1" as const;
export const PROVIDER_OBSERVATION_HASH_VERSION =
  "packscout.provider-observation-hash.v1" as const;

export const launchProviderKeys = [
  "courtyard",
  "collector_crypt",
  "phygitals",
  "clutchpacks",
] as const;
export const launchRecordIdScopeKeys = [
  "catalog-pack-v1",
  "catalog-card-v1",
  "pull-v1",
  "trade-v1",
] as const;
export const providerSourceKinds = ["catalog", "pull", "trade"] as const;
export const providerCanonicalKinds = [
  "pack",
  "catalog_asset",
  "pull",
  "market_event",
  "platform",
  "ev_input",
  "estimated_ev",
] as const;
export const providerEventCodes = [
  "sale",
  "buyback",
  "mint",
  "burn",
  "transfer",
  "list",
  "unlist",
  "swap",
  "ship",
] as const;
export const sourceLifecycleStates = [
  "draft",
  "paused",
  "active",
  "disabled",
  "replaced",
] as const;
export const providerSourceDiagnosticSeverities = [
  "info",
  "warning",
  "critical",
] as const;
export const providerSourceDiagnosticCorrelationKinds = [
  "lifecycle",
  "connection_test",
  "source_test",
  "run",
  "page",
  "connection_episode",
] as const;
export const providerSourceDiagnosticEventKinds = [
  "source_lifecycle",
  "connection_test",
  "source_test",
  "source_run",
  "source_page",
  "connection_episode",
] as const;
export const providerSourceDiagnosticEventKindByCorrelationKind = Object.freeze({
  lifecycle: "source_lifecycle",
  connection_test: "connection_test",
  source_test: "source_test",
  run: "source_run",
  page: "source_page",
  connection_episode: "connection_episode",
} as const satisfies Readonly<
  Record<
    (typeof providerSourceDiagnosticCorrelationKinds)[number],
    (typeof providerSourceDiagnosticEventKinds)[number]
  >
>);

export type LaunchProviderKey = (typeof launchProviderKeys)[number];
export type LaunchRecordIdScopeKey =
  (typeof launchRecordIdScopeKeys)[number];
export type ProviderSourceKind = (typeof providerSourceKinds)[number];
export type ProviderCanonicalKind = (typeof providerCanonicalKinds)[number];
export type ProviderEventCode = (typeof providerEventCodes)[number];
export type SourceLifecycleState = (typeof sourceLifecycleStates)[number];
export type ProviderSourceDiagnosticSeverity =
  (typeof providerSourceDiagnosticSeverities)[number];
export type ProviderSourceDiagnosticCorrelationKind =
  (typeof providerSourceDiagnosticCorrelationKinds)[number];
export type ProviderSourceDiagnosticEventKind =
  (typeof providerSourceDiagnosticEventKinds)[number];

/**
 * Stable provider-owned identity namespaces. A source adapter may claim one
 * only after proving it emits the same provider IDs; the namespace authority
 * is deliberately independent of any transport vendor.
 */
export const providerIdentityNamespaceByLaunchProvider = Object.freeze({
  courtyard: "dataforrest-courtyard-records-v1",
  collector_crypt: "dataforrest-collector_crypt-records-v1",
  phygitals: "dataforrest-phygitals-records-v1",
  clutchpacks: "dataforrest-clutchpacks-records-v1",
} as const satisfies Readonly<Record<LaunchProviderKey, string>>);

export const canonicalKindByLaunchScope = Object.freeze({
  "catalog-pack-v1": "pack",
  "catalog-card-v1": "catalog_asset",
  "pull-v1": "pull",
  "trade-v1": "market_event",
} as const satisfies Readonly<Record<LaunchRecordIdScopeKey, ProviderCanonicalKind>>);

export const sourceKindByLaunchScope = Object.freeze({
  "catalog-pack-v1": "catalog",
  "catalog-card-v1": "catalog",
  "pull-v1": "pull",
  "trade-v1": "trade",
} as const satisfies Readonly<Record<LaunchRecordIdScopeKey, ProviderSourceKind>>);

export const providerSourceLaunchBounds = Object.freeze({
  pageTargetRecords: 250,
  maximumResponseBytes: 8 * 1024 * 1024,
  requestTimeoutMilliseconds: 10_000,
  stableProfileRequestCap: 2,
  genericExecutionSlots: 4,
  sourceIntervalSeconds: Object.freeze({
    minimum: 60,
    default: 60,
    maximum: 86_400,
  }),
  freshnessGraceSeconds: 15 * 60,
});

export const providerSourceRetention = Object.freeze({
  protectedRawPageDays: 7,
  protectedQuarantineDays: 30,
  sanitizedDiagnosticDays: 30,
  terminalRequestAttemptDays: 30,
});

export const providerSourceSingletonTiming = Object.freeze({
  leaseSeconds: 30,
  maximumRenewalIntervalSeconds: 5,
  takeoverGraceSeconds: 15,
});

export const OPAQUE_CURSOR_VALUE_MAXIMUM_UTF8_BYTES = 16_384;
export const OPAQUE_CURSOR_VALUE_INVALID_TEXT_ERROR =
  "provider_source.cursor_value_invalid_text";

const cursorTextEncoder = new TextEncoder();
const cursorTextDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export const providerSourceControlPlaneRetry = Object.freeze({
  maximumAttempts: 3,
  backoffMilliseconds: Object.freeze([0, 100, 400] as const),
  transactionTimeoutMilliseconds: 750,
  wallClockLimitMilliseconds: 3_000,
});

const registrationKeySchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/u);
const opaqueIdentifierSchema = z.string().trim().min(1).max(256);
const positiveBoundedIntegerSchema = z.number().int().min(1).max(86_400);

export const launchProviderKeySchema = z.enum(launchProviderKeys);
export const launchRecordIdScopeKeySchema = z.enum(launchRecordIdScopeKeys);
export const providerSourceKindSchema = z.enum(providerSourceKinds);
export const providerCanonicalKindSchema = z.enum(providerCanonicalKinds);
export const providerEventCodeSchema = z.enum(providerEventCodes);
export const sourceLifecycleStateSchema = z.enum(sourceLifecycleStates);
export const providerSourceDiagnosticSeveritySchema = z.enum(
  providerSourceDiagnosticSeverities,
);
export const providerSourceDiagnosticCorrelationKindSchema = z.enum(
  providerSourceDiagnosticCorrelationKinds,
);
export const providerSourceDiagnosticEventKindSchema = z.enum(
  providerSourceDiagnosticEventKinds,
);
export const providerSourceDiagnosticCursorFingerprintSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u);
export const providerSourceDiagnosticCommandCorrelationKeySchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9_.:-]{0,126}[a-z0-9])?$/u);

export const providerSourceRequestBoundsSchema = z
  .object({
    pageLimit: z.number().int().min(1).max(5_000),
    maximumResponseBytes: z.number().int().min(1),
    timeoutMilliseconds: z.number().int().min(1).max(60_000),
  })
  .strict();

export const normalizedContinuationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("continue") }).strict(),
  z
    .object({
      kind: z.literal("poll_after"),
      minimumDelaySeconds: z.number().int().min(0).max(86_400),
    })
    .strict(),
]);

export const recordIdScopeDeclarationSchema = z
  .object({
    recordIdScopeKey: launchRecordIdScopeKeySchema,
    sourceKind: providerSourceKindSchema,
    catalogEntity: z.enum(["pack", "card"]).nullable(),
    canonicalKind: providerCanonicalKindSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedSource = sourceKindByLaunchScope[value.recordIdScopeKey];
    if (value.sourceKind !== expectedSource) {
      context.addIssue({
        code: "custom",
        message: "provider_source.scope_source_kind_mismatch",
        path: ["sourceKind"],
      });
    }
    const expectedCanonical = canonicalKindByLaunchScope[value.recordIdScopeKey];
    if (value.canonicalKind !== expectedCanonical) {
      context.addIssue({
        code: "custom",
        message: "provider_source.scope_canonical_mismatch",
        path: ["canonicalKind"],
      });
    }
    const expectedEntity = value.recordIdScopeKey === "catalog-pack-v1"
      ? "pack"
      : value.recordIdScopeKey === "catalog-card-v1"
        ? "card"
        : null;
    if (value.catalogEntity !== expectedEntity) {
      context.addIssue({
        code: "custom",
        message: "provider_source.scope_entity_mismatch",
        path: ["catalogEntity"],
      });
    }
  });

export const launchRecordIdScopeDeclarations = Object.freeze([
  {
    recordIdScopeKey: "catalog-pack-v1",
    sourceKind: "catalog",
    catalogEntity: "pack",
    canonicalKind: "pack",
  },
  {
    recordIdScopeKey: "catalog-card-v1",
    sourceKind: "catalog",
    catalogEntity: "card",
    canonicalKind: "catalog_asset",
  },
  {
    recordIdScopeKey: "pull-v1",
    sourceKind: "pull",
    catalogEntity: null,
    canonicalKind: "pull",
  },
  {
    recordIdScopeKey: "trade-v1",
    sourceKind: "trade",
    catalogEntity: null,
    canonicalKind: "market_event",
  },
] as const);

export const opaqueCursorValueSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const encoded = cursorTextEncoder.encode(value);
    if (
      value.includes("\u0000") ||
      cursorTextDecoder.decode(encoded) !== value
    ) {
      context.addIssue({
        code: "custom",
        message: OPAQUE_CURSOR_VALUE_INVALID_TEXT_ERROR,
      });
    }
    if (encoded.byteLength > OPAQUE_CURSOR_VALUE_MAXIMUM_UTF8_BYTES) {
      context.addIssue({
        code: "custom",
        message: "provider_source.cursor_value_too_large",
      });
    }
  });

export const opaqueCursorEnvelopeSchema = z
  .object({
    sourceInstanceId: opaqueIdentifierSchema,
    sourceRevisionId: opaqueIdentifierSchema,
    sourceTypeKey: registrationKeySchema,
    adapterVersion: registrationKeySchema,
    cursorCodecKey: registrationKeySchema,
    cursorGeneration: z.number().int().min(1),
    value: opaqueCursorValueSchema.nullable(),
  })
  .strict();

export const sourceAdapterFailureCodes = [
  "cancelled",
  "lost_ownership",
  "request_timeout",
  "network_interruption",
  "server_failure",
  "rate_limited",
  "invalid_source_configuration",
  "invalid_cursor",
  "invalid_response",
  "unsupported_provider",
  "authentication_failed",
  "authorization_failed",
  "endpoint_invalid",
  "tls_failed",
  "destination_rejected",
  "profile_configuration_invalid",
] as const;

const safeUpstreamStatusSchema = z.number().int().min(300).max(599);
const retryAfterSecondsSchema = z.number().int().min(0).max(86_400);

export const sourceAdapterFailureSchema = z
  .discriminatedUnion("disposition", [
    z
      .object({
        disposition: z.literal("cancelled"),
        code: z.enum(["cancelled", "lost_ownership"]),
      })
      .strict(),
    z
      .object({
        disposition: z.literal("retryable"),
        code: z.enum([
          "request_timeout",
          "network_interruption",
          "server_failure",
          "rate_limited",
        ]),
        retryAfterSeconds: retryAfterSecondsSchema.optional(),
        safeStatus: safeUpstreamStatusSchema.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (
          value.retryAfterSeconds !== undefined &&
          value.code !== "rate_limited" &&
          value.code !== "server_failure"
        ) {
          context.addIssue({
            code: "custom",
            message: "provider_source.retry_after_not_applicable",
            path: ["retryAfterSeconds"],
          });
        }
      }),
    z
      .object({
        disposition: z.literal("source_action_required"),
        code: z.enum([
          "invalid_source_configuration",
          "invalid_cursor",
          "invalid_response",
          "unsupported_provider",
        ]),
        safeStatus: safeUpstreamStatusSchema.optional(),
      })
      .strict(),
    z
      .object({
        disposition: z.literal("connection_action_required"),
        code: z.enum([
          "authentication_failed",
          "authorization_failed",
          "endpoint_invalid",
          "tls_failed",
          "destination_rejected",
          "profile_configuration_invalid",
        ]),
        safeStatus: safeUpstreamStatusSchema.optional(),
      })
      .strict(),
  ]);

export const sourceAdapterMeasurementsSchema = z
  .object({
    durationMilliseconds: z.number().int().min(0),
    responseBytes: z.number().int().min(0),
    recordCount: z.number().int().min(0),
  })
  .strict();

export const sourceAdapterSafeDiagnosticSchema = z
  .object({
    severity: providerSourceDiagnosticSeveritySchema,
    phase: registrationKeySchema,
    code: registrationKeySchema,
    counters: z.record(registrationKeySchema, z.number().int().min(0)).optional(),
  })
  .strict();

export const sourceAdapterProviderDeclarationSchema = z
  .object({
    provider: launchProviderKeySchema,
    identityNamespaceKey: registrationKeySchema,
    recordIdScopes: z.array(recordIdScopeDeclarationSchema).length(4),
  })
  .strict()
  .superRefine((value, context) => {
    const scopes = value.recordIdScopes.map(({ recordIdScopeKey }) => recordIdScopeKey);
    if (new Set(scopes).size !== scopes.length) {
      context.addIssue({
        code: "custom",
        message: "provider_source.duplicate_record_id_scope",
        path: ["recordIdScopes"],
      });
    }
    const canonicalKinds = value.recordIdScopes.map(({ canonicalKind }) => canonicalKind);
    if (new Set(canonicalKinds).size !== canonicalKinds.length) {
      context.addIssue({
        code: "custom",
        message: "provider_source.non_injective_canonical_mapping",
        path: ["recordIdScopes"],
      });
    }
  });

export const sourceAdapterManifestV1Schema = z
  .object({
    providerSourceContractVersion: z.literal(PROVIDER_SOURCE_CONTRACT_VERSION),
    sourceTypeKey: registrationKeySchema,
    adapterVersion: registrationKeySchema,
    normalizedContractVersion: z.literal(PROVIDER_OBSERVATION_CONTRACT_VERSION),
    compatibleConnectionTypeKey: registrationKeySchema,
    cursorCodecKey: registrationKeySchema,
    operatorLabel: z.string().trim().min(1).max(80),
    requestBounds: providerSourceRequestBoundsSchema,
    maximumConnectionRequestCap: z.number().int().min(1).max(4),
    capabilities: z
      .object({
        connectionTest: z.literal(true),
        sourceTest: z.literal(true),
        pageRead: z.literal(true),
        cancellation: z.literal(true),
      })
      .strict(),
    supportedProviders: z.array(sourceAdapterProviderDeclarationSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const providers = value.supportedProviders.map(({ provider }) => provider);
    if (new Set(providers).size !== providers.length) {
      context.addIssue({
        code: "custom",
        message: "provider_source.duplicate_supported_provider",
        path: ["supportedProviders"],
      });
    }
  });

export type ProviderSourceRequestBounds = z.infer<
  typeof providerSourceRequestBoundsSchema
>;
export type NormalizedContinuation = z.infer<typeof normalizedContinuationSchema>;
export type RecordIdScopeDeclaration = z.infer<
  typeof recordIdScopeDeclarationSchema
>;
export type OpaqueCursorEnvelope = z.infer<
  typeof opaqueCursorEnvelopeSchema
>;
export type SourceAdapterFailure = z.infer<typeof sourceAdapterFailureSchema>;
export type SourceAdapterMeasurements = z.infer<
  typeof sourceAdapterMeasurementsSchema
>;
export type SourceAdapterSafeDiagnostic = z.infer<
  typeof sourceAdapterSafeDiagnosticSchema
>;
export type SourceAdapterManifestV1 = z.infer<
  typeof sourceAdapterManifestV1Schema
>;

export function validateSourceIntervalSeconds(value: unknown): number {
  return positiveBoundedIntegerSchema
    .min(providerSourceLaunchBounds.sourceIntervalSeconds.minimum)
    .max(providerSourceLaunchBounds.sourceIntervalSeconds.maximum)
    .parse(value);
}
