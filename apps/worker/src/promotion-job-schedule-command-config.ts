import type {
  PromotionJobScheduleLifecycle,
} from "@packscout/database";

export type PromotionJobScheduleCommandAction = "activate" | "pause";

export type PromotionJobScheduleCommandEnvironment = "local" | "production";

export interface PromotionJobScheduleCommandExpectedState {
  readonly lifecycle: PromotionJobScheduleLifecycle;
  readonly scheduleEpoch: bigint;
  readonly baselineAt: Date | null;
  readonly activatedAt: Date | null;
  readonly pausedAt: Date | null;
}

interface CommonPromotionJobScheduleCommandConfiguration {
  readonly action: PromotionJobScheduleCommandAction;
  readonly environment: PromotionJobScheduleCommandEnvironment;
  readonly expected: PromotionJobScheduleCommandExpectedState;
  readonly effectiveAt: Date;
  readonly activationBaselineAt: Date | null;
}

export interface ProviderPromotionScheduleCommandConfiguration
extends CommonPromotionJobScheduleCommandConfiguration {
  readonly authority: "provider_publication";
  readonly databaseUrl: string;
  readonly providerId: string;
  readonly providerKey: string;
}

export interface ManifestPromotionScheduleCommandConfiguration
extends CommonPromotionJobScheduleCommandConfiguration {
  readonly authority: "manifest_reconciliation";
  readonly databaseUrl: string;
}

export type PromotionJobScheduleCommandConfiguration =
  | ProviderPromotionScheduleCommandConfiguration
  | ManifestPromotionScheduleCommandConfiguration;

export type PromotionJobScheduleCommandConfigurationErrorCode =
  | "PROMOTION_JOB_SCHEDULE_COMMAND_ACTION_INVALID"
  | "PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_INVALID"
  | "PROMOTION_JOB_SCHEDULE_COMMAND_DATABASE_URL_INVALID"
  | "PROMOTION_JOB_SCHEDULE_COMMAND_ENVIRONMENT_INVALID"
  | "PROMOTION_JOB_SCHEDULE_COMMAND_LEGACY_AUTHORITY_CONFIGURED"
  | "PROMOTION_JOB_SCHEDULE_COMMAND_PROVIDER_IDENTITY_INVALID"
  | "PROMOTION_JOB_SCHEDULE_COMMAND_ROLE_CONFLICT"
  | "PROMOTION_JOB_SCHEDULE_COMMAND_SHARED_AUTHORITY_CONFIGURED";

export class PromotionJobScheduleCommandConfigurationError extends Error {
  constructor(
    readonly code: PromotionJobScheduleCommandConfigurationErrorCode,
  ) {
    super("Promotion job schedule command configuration is invalid.");
    this.name = "PromotionJobScheduleCommandConfigurationError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_]{0,52}$/u;
const MAXIMUM_SCHEDULE_EPOCH = 9_223_372_036_854_775_806n;

const PROVIDER_COMMAND_KEYS = Object.freeze([
  "PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_DATABASE_URL",
  "PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_PROVIDER_ID",
  "PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_PROVIDER_KEY",
]);
const MANIFEST_COMMAND_KEYS = Object.freeze([
  "PACKSCOUT_MANIFEST_RECONCILIATION_SCHEDULE_DATABASE_URL",
]);
const SHARED_RUNTIME_AUTHORITY_KEYS = Object.freeze([
  "PACKSCOUT_DATABASE_URL",
  "PACKSCOUT_PROVIDER_DATABASE_URL",
  "PACKSCOUT_CENTRAL_DATABASE_URL",
  "PACKSCOUT_CONVEX_PUBLICATION_BASE_URL",
  "PACKSCOUT_CONVEX_PUBLICATION_KEY_ID",
  "PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64",
  "PACKSCOUT_CATALOG_DEPLOYMENT_KEY",
  "PACKSCOUT_PROMOTION_PROVIDER_ID",
  "PACKSCOUT_PROMOTION_PROVIDER_KEY_ID",
  "PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION",
  "PACKSCOUT_PROMOTION_MANIFEST_KEY_ID",
  "PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_MANIFEST_AUTHORITY_VERSION",
  "PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_BASE_URL",
  "PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_TOKEN_BASE64",
  "PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PUBLIC_KEY_PEM",
  "PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PRIVATE_KEY_PEM",
  "PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_COMMAND_ATTESTATION",
]);
const LEGACY_AUTHORITY_KEYS = Object.freeze([
  "PACKSCOUT_CATALOG_PLATFORM_KEY",
  "PACKSCOUT_CATALOG_PROVIDER_CREDENTIALS",
  "PACKSCOUT_CATALOG_PROVIDER_KEY_ID",
  "PACKSCOUT_CATALOG_PROVIDER_SECRET_BASE64",
  "PACKSCOUT_CATALOG_PROVIDER_AUTHORITY_VERSION",
  "PACKSCOUT_CATALOG_MANIFEST_PUBLISH_KEY_ID",
  "PACKSCOUT_CATALOG_MANIFEST_PUBLISH_SECRET_BASE64",
  "PACKSCOUT_CATALOG_MANIFEST_PUBLISH_AUTHORITY_VERSION",
  "PACKSCOUT_CATALOG_MANIFEST_CLEAR_KEY_ID",
  "PACKSCOUT_CATALOG_MANIFEST_CLEAR_SECRET_BASE64",
  "PACKSCOUT_CATALOG_MANIFEST_CLEAR_AUTHORITY_VERSION",
]);

function refuse(
  code: PromotionJobScheduleCommandConfigurationErrorCode,
): never {
  throw new PromotionJobScheduleCommandConfigurationError(code);
}

function includesAny(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[],
): boolean {
  return keys.some((key) => environment[key] !== undefined);
}

function exactInstant(value: string | undefined): Date {
  if (!value) refuse("PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_INVALID");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    refuse("PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_INVALID");
  }
  return parsed;
}

function optionalExactInstant(value: string | undefined): Date | null {
  return value === "none" ? null : exactInstant(value);
}

function scheduleEpoch(value: string | undefined): bigint {
  if (!value || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
    return refuse("PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_INVALID");
  }
  const epoch = BigInt(value);
  if (epoch > MAXIMUM_SCHEDULE_EPOCH) {
    return refuse("PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_INVALID");
  }
  return epoch;
}

function databaseUrl(value: string | undefined): string {
  if (!value || value.length > 4_096 || /[\r\n\0]/u.test(value)) {
    return refuse("PROMOTION_JOB_SCHEDULE_COMMAND_DATABASE_URL_INVALID");
  }
  try {
    const parsed = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname || parsed.pathname.length < 2 || parsed.hash
    ) throw new Error("invalid");
    return value;
  } catch {
    return refuse("PROMOTION_JOB_SCHEDULE_COMMAND_DATABASE_URL_INVALID");
  }
}

function commandEnvironment(
  environment: NodeJS.ProcessEnv,
): PromotionJobScheduleCommandEnvironment {
  const requested =
    environment.PACKSCOUT_PROMOTION_SCHEDULE_COMMAND_ENVIRONMENT;
  const expectedNodeEnvironment = requested === "local"
    ? "development"
    : requested === "production" ? "production" : null;
  if (
    expectedNodeEnvironment === null ||
    environment.NODE_ENV !== expectedNodeEnvironment
  ) return refuse("PROMOTION_JOB_SCHEDULE_COMMAND_ENVIRONMENT_INVALID");
  return requested as PromotionJobScheduleCommandEnvironment;
}

function action(
  value: string | undefined,
): PromotionJobScheduleCommandAction {
  if (value !== "activate" && value !== "pause") {
    return refuse("PROMOTION_JOB_SCHEDULE_COMMAND_ACTION_INVALID");
  }
  return value;
}

function expectedState(
  environment: NodeJS.ProcessEnv,
): PromotionJobScheduleCommandExpectedState {
  const lifecycle =
    environment.PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_LIFECYCLE;
  if (!lifecycle || ![
    "pending_activation",
    "active",
    "paused",
  ].includes(lifecycle)) {
    return refuse("PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_INVALID");
  }
  const expected = Object.freeze({
    lifecycle: lifecycle as PromotionJobScheduleLifecycle,
    scheduleEpoch: scheduleEpoch(
      environment.PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_EPOCH,
    ),
    baselineAt: optionalExactInstant(
      environment.PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_BASELINE_AT,
    ),
    activatedAt: optionalExactInstant(
      environment.PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_ACTIVATED_AT,
    ),
    pausedAt: optionalExactInstant(
      environment.PACKSCOUT_PROMOTION_SCHEDULE_EXPECTED_PAUSED_AT,
    ),
  });
  const pending = expected.lifecycle === "pending_activation";
  const active = expected.lifecycle === "active";
  if (
    (pending && (
      expected.scheduleEpoch !== 0n || expected.baselineAt !== null ||
      expected.activatedAt !== null || expected.pausedAt !== null
    )) ||
    (!pending && (
      expected.scheduleEpoch < 1n || expected.baselineAt === null ||
      expected.activatedAt === null
    )) ||
    (active && expected.pausedAt !== null) ||
    (expected.lifecycle === "paused" && expected.pausedAt === null) ||
    (expected.baselineAt !== null && expected.activatedAt !== null &&
      expected.baselineAt.getTime() > expected.activatedAt.getTime()) ||
    (expected.activatedAt !== null && expected.pausedAt !== null &&
      expected.activatedAt.getTime() > expected.pausedAt.getTime())
  ) return refuse("PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_INVALID");
  return expected;
}

function common(
  environment: NodeJS.ProcessEnv,
): CommonPromotionJobScheduleCommandConfiguration {
  if (includesAny(environment, LEGACY_AUTHORITY_KEYS)) {
    refuse("PROMOTION_JOB_SCHEDULE_COMMAND_LEGACY_AUTHORITY_CONFIGURED");
  }
  if (includesAny(environment, SHARED_RUNTIME_AUTHORITY_KEYS)) {
    refuse("PROMOTION_JOB_SCHEDULE_COMMAND_SHARED_AUTHORITY_CONFIGURED");
  }
  const commandAction = action(
    environment.PACKSCOUT_PROMOTION_SCHEDULE_COMMAND_ACTION,
  );
  const expected = expectedState(environment);
  const effectiveAt = exactInstant(
    environment.PACKSCOUT_PROMOTION_SCHEDULE_EFFECTIVE_AT,
  );
  const activationBaselineAt = optionalExactInstant(
    environment.PACKSCOUT_PROMOTION_SCHEDULE_ACTIVATION_BASELINE_AT,
  );
  if (
    (commandAction === "activate" && (
      expected.lifecycle === "active" || activationBaselineAt === null ||
      activationBaselineAt.getTime() > effectiveAt.getTime() ||
      (expected.pausedAt !== null &&
        effectiveAt.getTime() < expected.pausedAt.getTime())
    )) ||
    (commandAction === "pause" && (
      expected.lifecycle !== "active" || activationBaselineAt !== null ||
      expected.activatedAt === null ||
      effectiveAt.getTime() < expected.activatedAt.getTime()
    )) ||
    (activationBaselineAt !== null &&
      activationBaselineAt.getTime() > 8_639_999_999_940_000)
  ) return refuse("PROMOTION_JOB_SCHEDULE_COMMAND_BASELINE_INVALID");
  return Object.freeze({
    action: commandAction,
    environment: commandEnvironment(environment),
    expected,
    effectiveAt,
    activationBaselineAt,
  });
}

export function readProviderPromotionScheduleCommandConfiguration(
  environment: NodeJS.ProcessEnv,
): ProviderPromotionScheduleCommandConfiguration {
  if (includesAny(environment, MANIFEST_COMMAND_KEYS)) {
    refuse("PROMOTION_JOB_SCHEDULE_COMMAND_ROLE_CONFLICT");
  }
  const providerId =
    environment.PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_PROVIDER_ID;
  const providerKey =
    environment.PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_PROVIDER_KEY;
  if (
    !providerId || !UUID_PATTERN.test(providerId) ||
    !providerKey || !PROVIDER_KEY_PATTERN.test(providerKey)
  ) return refuse("PROMOTION_JOB_SCHEDULE_COMMAND_PROVIDER_IDENTITY_INVALID");
  return Object.freeze({
    ...common(environment),
    authority: "provider_publication",
    databaseUrl: databaseUrl(
      environment.PACKSCOUT_PROVIDER_PROMOTION_SCHEDULE_DATABASE_URL,
    ),
    providerId: providerId.toLowerCase(),
    providerKey,
  });
}

export function readManifestPromotionScheduleCommandConfiguration(
  environment: NodeJS.ProcessEnv,
): ManifestPromotionScheduleCommandConfiguration {
  if (includesAny(environment, PROVIDER_COMMAND_KEYS)) {
    refuse("PROMOTION_JOB_SCHEDULE_COMMAND_ROLE_CONFLICT");
  }
  return Object.freeze({
    ...common(environment),
    authority: "manifest_reconciliation",
    databaseUrl: databaseUrl(
      environment.PACKSCOUT_MANIFEST_RECONCILIATION_SCHEDULE_DATABASE_URL,
    ),
  });
}
