import type {
  ManifestReconciliationJobAuthorityConfiguration,
  ProviderPublicationJobAuthorityConfiguration,
} from "./distributed-promotion-authority-config.ts";
import {
  readManifestReconciliationJobAuthorityConfiguration,
  readProviderPublicationJobAuthorityConfiguration,
} from "./distributed-promotion-authority-config.ts";
import { promotionImmediateDeliveryListenDatabaseUrl } from
  "./postgres-promotion-immediate-delivery.ts";

export type DistributedPromotionJobProcessMode =
  | "daemon"
  | "once"
  | "manual"
  | "continuation";

export type DistributedPromotionJobProcessConfigurationErrorCode =
  | "DISTRIBUTED_PROMOTION_PROCESS_DATABASE_URL_INVALID"
  | "DISTRIBUTED_PROMOTION_PROCESS_GATEWAY_CREDENTIAL_INVALID"
  | "DISTRIBUTED_PROMOTION_PROCESS_GATEWAY_URL_INVALID"
  | "DISTRIBUTED_PROMOTION_PROCESS_LISTEN_DATABASE_URL_INVALID"
  | "DISTRIBUTED_PROMOTION_PROCESS_MANUAL_PUBLIC_KEY_INVALID"
  | "DISTRIBUTED_PROMOTION_PROCESS_MODE_INVALID"
  | "DISTRIBUTED_PROMOTION_PROCESS_POLL_INVALID"
  | "DISTRIBUTED_PROMOTION_PROCESS_ROLE_CONFLICT"
  | "DISTRIBUTED_PROMOTION_PROCESS_TRIGGER_INVALID"
  | "DISTRIBUTED_PROMOTION_PROCESS_WORKER_ID_INVALID";

export class DistributedPromotionJobProcessConfigurationError extends Error {
  constructor(
    readonly code: DistributedPromotionJobProcessConfigurationErrorCode,
  ) {
    super("Distributed promotion process configuration is invalid.");
    this.name = "DistributedPromotionJobProcessConfigurationError";
  }
}

interface CommonProcessConfiguration {
  readonly mode: DistributedPromotionJobProcessMode;
  readonly workerId: string;
  readonly pollMilliseconds: number;
  readonly databaseUrl: string;
  readonly listenDatabaseUrl: string | null;
  readonly manualCommandPublicKeyPem: string;
  readonly manualCommandIdentity: string | null;
  readonly continuationGeneration: bigint | null;
}

export interface ProviderPromotionJobProcessConfiguration
extends CommonProcessConfiguration {
  readonly authority: ProviderPublicationJobAuthorityConfiguration;
  readonly bootstrapGateway: Readonly<{
    baseUrl: string;
    bearerToken: Uint8Array;
    timeoutMilliseconds: number;
  }>;
}

export interface ManifestReconciliationJobProcessConfiguration
extends CommonProcessConfiguration {
  readonly authority: ManifestReconciliationJobAuthorityConfiguration;
}

const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const PROVIDER_ONLY_KEYS = [
  "PACKSCOUT_PROVIDER_DATABASE_URL",
  "PACKSCOUT_PROVIDER_DATABASE_LISTEN_URL",
  "PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_BASE_URL",
  "PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_TOKEN_BASE64",
] as const;
const MANIFEST_ONLY_KEYS = [
  "PACKSCOUT_CENTRAL_DATABASE_URL",
  "PACKSCOUT_CENTRAL_DATABASE_LISTEN_URL",
] as const;
const LEGACY_MANIFEST_PROOF_KEYS = [
  "PACKSCOUT_PROMOTION_MANIFEST_PROOF_BASE_URL",
  "PACKSCOUT_PROMOTION_MANIFEST_PROOF_TOKEN_BASE64",
] as const;
const MANUAL_COMMAND_PUBLIC_KEY_ENVIRONMENT_NAME =
  "PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_PUBLIC_KEY_PEM";

function fail(
  code: DistributedPromotionJobProcessConfigurationErrorCode,
): never {
  throw new DistributedPromotionJobProcessConfigurationError(code);
}

function includesAny(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[],
): boolean {
  return keys.some((key) => environment[key] !== undefined);
}

function mode(value: string | undefined): DistributedPromotionJobProcessMode {
  const resolved = value ?? "daemon";
  if (!["daemon", "once", "manual", "continuation"].includes(resolved)) {
    return fail("DISTRIBUTED_PROMOTION_PROCESS_MODE_INVALID");
  }
  return resolved as DistributedPromotionJobProcessMode;
}

function workerId(value: string | undefined, fallback: string): string {
  const resolved = value ?? fallback;
  if (!WORKER_ID_PATTERN.test(resolved)) {
    return fail("DISTRIBUTED_PROMOTION_PROCESS_WORKER_ID_INVALID");
  }
  return resolved;
}

function pollMilliseconds(value: string | undefined): number {
  const resolved = value ?? "1000";
  if (!/^[1-9][0-9]*$/u.test(resolved)) {
    return fail("DISTRIBUTED_PROMOTION_PROCESS_POLL_INVALID");
  }
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 60_000) {
    return fail("DISTRIBUTED_PROMOTION_PROCESS_POLL_INVALID");
  }
  return parsed;
}

function databaseUrl(value: string | undefined): string {
  if (!value || value.length > 4_096 || /[\r\n]/u.test(value)) {
    return fail("DISTRIBUTED_PROMOTION_PROCESS_DATABASE_URL_INVALID");
  }
  try {
    const parsed = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname
    ) throw new Error("invalid");
    return value;
  } catch {
    return fail("DISTRIBUTED_PROMOTION_PROCESS_DATABASE_URL_INVALID");
  }
}

function listenDatabaseUrl(value: string): string {
  if (!value || value.length > 4_096 || /[\r\n]/u.test(value)) {
    return fail("DISTRIBUTED_PROMOTION_PROCESS_LISTEN_DATABASE_URL_INVALID");
  }
  try {
    return promotionImmediateDeliveryListenDatabaseUrl(value);
  } catch {
    return fail("DISTRIBUTED_PROMOTION_PROCESS_LISTEN_DATABASE_URL_INVALID");
  }
}

function optionalListenDatabaseUrl(
  configured: string | undefined,
  database: string,
): string | null {
  if (configured !== undefined) return listenDatabaseUrl(configured);
  try {
    return promotionImmediateDeliveryListenDatabaseUrl(database);
  } catch {
    return null;
  }
}

function gatewayBaseUrl(value: string | undefined): string {
  if (!value || value.length > 2_048 || /[\r\n]/u.test(value)) {
    return fail("DISTRIBUTED_PROMOTION_PROCESS_GATEWAY_URL_INVALID");
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || !parsed.hostname || parsed.username ||
      parsed.password || parsed.pathname !== "/" || parsed.search ||
      parsed.hash
    ) throw new Error("invalid");
    return parsed.origin;
  } catch {
    return fail("DISTRIBUTED_PROMOTION_PROCESS_GATEWAY_URL_INVALID");
  }
}

function gatewayToken(value: string | undefined): Uint8Array {
  if (!value || !CANONICAL_BASE64_PATTERN.test(value)) {
    return fail("DISTRIBUTED_PROMOTION_PROCESS_GATEWAY_CREDENTIAL_INVALID");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value || decoded.byteLength < 32 ||
    decoded.byteLength > 128
  ) return fail("DISTRIBUTED_PROMOTION_PROCESS_GATEWAY_CREDENTIAL_INVALID");
  return new Uint8Array(decoded);
}

function manualCommandPublicKeyPem(value: string | undefined): string {
  const trimmed = value?.trim();
  if (
    value === undefined || trimmed === undefined ||
    Buffer.byteLength(value, "utf8") > 2_048 ||
    !trimmed.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
    !trimmed.endsWith("\n-----END PUBLIC KEY-----") ||
    trimmed.includes("PRIVATE KEY") || /[\0\r]/u.test(trimmed)
  ) return fail("DISTRIBUTED_PROMOTION_PROCESS_MANUAL_PUBLIC_KEY_INVALID");
  return trimmed;
}

function trigger(input: Readonly<{
  processMode: DistributedPromotionJobProcessMode;
  manualCommandIdentity: string | undefined;
  continuationGeneration: string | undefined;
}>): Readonly<{
  manualCommandIdentity: string | null;
  continuationGeneration: bigint | null;
}> {
  if (input.processMode === "manual") {
    if (
      !input.manualCommandIdentity ||
      input.manualCommandIdentity.length > 512 ||
      /[\r\n\0]/u.test(input.manualCommandIdentity) ||
      input.continuationGeneration !== undefined
    ) return fail("DISTRIBUTED_PROMOTION_PROCESS_TRIGGER_INVALID");
    return {
      manualCommandIdentity: input.manualCommandIdentity,
      continuationGeneration: null,
    };
  }
  if (input.processMode === "continuation") {
    if (
      input.manualCommandIdentity !== undefined ||
      !input.continuationGeneration ||
      !/^[1-9][0-9]{0,18}$/u.test(input.continuationGeneration)
    ) return fail("DISTRIBUTED_PROMOTION_PROCESS_TRIGGER_INVALID");
    return {
      manualCommandIdentity: null,
      continuationGeneration: BigInt(input.continuationGeneration),
    };
  }
  if (
    input.manualCommandIdentity !== undefined ||
    input.continuationGeneration !== undefined
  ) return fail("DISTRIBUTED_PROMOTION_PROCESS_TRIGGER_INVALID");
  return { manualCommandIdentity: null, continuationGeneration: null };
}

function common(input: Readonly<{
  environment: NodeJS.ProcessEnv;
  fallbackWorkerId: string;
  databaseUrl: string | undefined;
  configuredListenDatabaseUrl: string | undefined;
}>): CommonProcessConfiguration {
  const processMode = mode(input.environment.PACKSCOUT_PROMOTION_RUN_MODE);
  const requestedTrigger = trigger({
    processMode,
    manualCommandIdentity:
      input.environment
        .PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_COMMAND_ATTESTATION,
    continuationGeneration:
      input.environment.PACKSCOUT_PROMOTION_CONTINUATION_GENERATION,
  });
  const resolvedDatabaseUrl = databaseUrl(input.databaseUrl);
  return Object.freeze({
    mode: processMode,
    workerId: workerId(
      input.environment.PACKSCOUT_PROMOTION_WORKER_ID,
      input.fallbackWorkerId,
    ),
    pollMilliseconds: pollMilliseconds(
      input.environment.PACKSCOUT_PROMOTION_POLL_MS,
    ),
    databaseUrl: resolvedDatabaseUrl,
    listenDatabaseUrl: optionalListenDatabaseUrl(
      input.configuredListenDatabaseUrl,
      resolvedDatabaseUrl,
    ),
    manualCommandPublicKeyPem: manualCommandPublicKeyPem(
      input.environment[MANUAL_COMMAND_PUBLIC_KEY_ENVIRONMENT_NAME],
    ),
    ...requestedTrigger,
  });
}

export function readProviderPromotionJobProcessConfiguration(
  environment: NodeJS.ProcessEnv,
  fallbackWorkerId: string,
): ProviderPromotionJobProcessConfiguration {
  if (
    includesAny(environment, MANIFEST_ONLY_KEYS) ||
    includesAny(environment, LEGACY_MANIFEST_PROOF_KEYS)
  ) {
    fail("DISTRIBUTED_PROMOTION_PROCESS_ROLE_CONFLICT");
  }
  const authority = readProviderPublicationJobAuthorityConfiguration(
    environment,
  );
  return Object.freeze({
    authority,
    ...common({
      environment,
      fallbackWorkerId,
      databaseUrl: environment.PACKSCOUT_PROVIDER_DATABASE_URL,
      configuredListenDatabaseUrl:
        environment.PACKSCOUT_PROVIDER_DATABASE_LISTEN_URL,
    }),
    bootstrapGateway: Object.freeze({
      baseUrl: gatewayBaseUrl(
        environment.PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_BASE_URL,
      ),
      bearerToken: gatewayToken(
        environment.PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_TOKEN_BASE64,
      ),
      timeoutMilliseconds: authority.requestTimeoutMilliseconds,
    }),
  });
}

export function readManifestReconciliationJobProcessConfiguration(
  environment: NodeJS.ProcessEnv,
  fallbackWorkerId: string,
): ManifestReconciliationJobProcessConfiguration {
  if (
    includesAny(environment, PROVIDER_ONLY_KEYS) ||
    includesAny(environment, LEGACY_MANIFEST_PROOF_KEYS)
  ) {
    fail("DISTRIBUTED_PROMOTION_PROCESS_ROLE_CONFLICT");
  }
  const authority = readManifestReconciliationJobAuthorityConfiguration(
    environment,
  );
  return Object.freeze({
    authority,
    ...common({
      environment,
      fallbackWorkerId,
      databaseUrl: environment.PACKSCOUT_CENTRAL_DATABASE_URL,
      configuredListenDatabaseUrl:
        environment.PACKSCOUT_CENTRAL_DATABASE_LISTEN_URL,
    }),
  });
}
