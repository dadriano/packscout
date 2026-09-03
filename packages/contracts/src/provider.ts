import { z } from "zod";

export const providerLifecycleStates = [
  "draft",
  "active",
  "disabled",
  "archived",
] as const;
export const providerAuthModes = ["none", "bearer"] as const;

export type ProviderLifecycleState = (typeof providerLifecycleStates)[number];
export type ProviderAuthMode = (typeof providerAuthModes)[number];

export const providerPlatformKeySchema = z
  .string()
  .trim()
  .min(1, "Enter a platform key.")
  .max(128, "Platform key must be 128 characters or fewer.")
  .regex(
    /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/,
    "Use lowercase letters, numbers, hyphens, or underscores.",
  );

export const providerAdapterKeySchema = providerPlatformKeySchema;

const providerDisplayNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a provider name.")
  .max(120, "Provider name must be 120 characters or fewer.");

const providerEndpointSchema = z
  .string()
  .trim()
  .min(1, "Enter an endpoint.")
  .max(2048, "Endpoint must be 2048 characters or fewer.");

const scheduleSecondsSchema = z.coerce
  .number()
  .int()
  .min(60, "Schedule must be at least 60 seconds.")
  .max(86_400, "Schedule must be 24 hours or fewer.")
  .default(300);

const staleAfterSecondsSchema = z.coerce
  .number()
  .int()
  .min(1, "Stale threshold must be positive.")
  .max(604_800, "Stale threshold must be 7 days or fewer.")
  .default(900);

const bearerSecretSchema = z
  .string()
  .min(1, "Enter a bearer secret.")
  .max(4096, "Bearer secret must be 4096 characters or fewer.")
  .refine((value) => !/[\r\n]/.test(value), "Bearer secret cannot contain line breaks.");

const createProviderAuthSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("bearer"), bearerSecret: bearerSecretSchema }).strict(),
]);

const replaceProviderAuthSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z
    .object({
      mode: z.literal("bearer"),
      bearerSecret: bearerSecretSchema.optional(),
      reuseExistingSecret: z.literal(true).optional(),
    })
    .strict()
    .refine(
      (value) =>
        (value.bearerSecret === undefined) !==
        (value.reuseExistingSecret === undefined),
      "Provide a replacement bearer secret or explicitly reuse the current secret.",
    ),
]);

const revisionSettingsSchema = {
  adapterKey: providerAdapterKeySchema,
  endpoint: providerEndpointSchema,
  scheduleSeconds: scheduleSecondsSchema,
  staleAfterSeconds: staleAfterSecondsSchema,
} as const;

export const createProviderRequestSchema = z
  .object({
    platformKey: providerPlatformKeySchema,
    displayName: providerDisplayNameSchema,
    ...revisionSettingsSchema,
    auth: createProviderAuthSchema,
  })
  .strict();

export const replaceProviderRevisionRequestSchema = z
  .object({
    expectedRevisionId: z.string().uuid(),
    displayName: providerDisplayNameSchema.optional(),
    ...revisionSettingsSchema,
    auth: replaceProviderAuthSchema,
  })
  .strict();

export const providerRevisionCommandSchema = z
  .object({
    expectedRevisionId: z.string().uuid(),
  })
  .strict();

export type CreateProviderRequest = z.input<typeof createProviderRequestSchema>;
export type NormalizedCreateProviderRequest = z.output<typeof createProviderRequestSchema>;
export type ReplaceProviderRevisionRequest = z.input<
  typeof replaceProviderRevisionRequestSchema
>;
export type NormalizedReplaceProviderRevisionRequest = z.output<
  typeof replaceProviderRevisionRequestSchema
>;

export interface ProviderConnectionRecordCounts {
  catalog: number;
  pulls: number;
  trades: number;
}

export type ProviderConnectionVerdict =
  | "success"
  | "authentication_failure"
  | "contract_failure"
  | "timeout"
  | "unreachable";

export interface ProviderConnectionTestSummary {
  verdict: ProviderConnectionVerdict;
  checkedAt: string;
  latencyMs: number;
  responseStatus: number | null;
  recordCounts: ProviderConnectionRecordCounts | null;
  hasMore: boolean | null;
  nextCursorPresent: boolean | null;
  sanitizedCode: string | null;
}

export interface ProviderRevisionSummary {
  id: string;
  version: number;
  adapterKey: string;
  endpoint: string;
  endpointHost: string;
  authMode: ProviderAuthMode;
  hasBearerSecret: boolean;
  scheduleSeconds: number;
  staleAfterSeconds: number;
  testedAt: string | null;
  createdAt: string;
  lastConnectionTest: ProviderConnectionTestSummary | null;
}

export interface ProviderConfigurationSummary {
  id: string;
  platformKey: string;
  displayName: string;
  state: ProviderLifecycleState;
  latestRevision: ProviderRevisionSummary;
  activeRevisionId: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Source-native provider identity stored at the root of Provider Sources.
 * It deliberately excludes the retired provider configuration projection.
 */
export interface ProviderSourceRootSummary {
  id: string;
  platformKey: string;
  displayName: string;
  state: ProviderLifecycleState;
  createdAt: string;
  updatedAt: string;
}

/** Public-safe outcome of resolving and checking one server-owned provider DB route. */
export type ProviderDatabaseFailureCode =
  | "destination_not_allowed"
  | "credential_unavailable"
  | "database_unreachable"
  | "database_identity_missing"
  | "database_name_mismatch"
  | "database_role_mismatch"
  | "database_schema_mismatch"
  | "provider_identity_mismatch"
  | "route_changed";

export type ProviderDatabaseGatewayOutcome =
  | {
      readonly state: "reachable";
      readonly providerId: string;
      readonly observedSchemaVersion: string;
      readonly observedAt: string;
    }
  | {
      readonly state: "unreachable";
      readonly providerId: string;
      readonly failureCode: ProviderDatabaseFailureCode;
      readonly observedAt: string;
      readonly retryHint: string;
    };

export const providerConfigurationErrorCodes = [
  "BEARER_SECRET_REQUIRED",
  "CONFIG_REVISION_CONFLICT",
  "FORBIDDEN",
  "INVALID_PROVIDER_CONFIGURATION",
  "PROVIDER_CONNECTION_FAILED",
  "PROVIDER_LIFECYCLE_CONFLICT",
  "PROVIDER_NOT_FOUND",
  "PROVIDER_PLATFORM_CONFLICT",
  "UNKNOWN_ADAPTER",
] as const;

export type ProviderConfigurationErrorCode =
  (typeof providerConfigurationErrorCodes)[number];
