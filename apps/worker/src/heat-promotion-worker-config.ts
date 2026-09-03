import {
  MAX_PRODUCTION_AUTH_SECRET_BYTES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES,
  productionAuthKeyIdSchema,
} from "@packscout/contracts";

export type HeatPromotionWorkerConfigurationErrorCode =
  | "HEAT_DEPLOYMENT_KEY_INVALID"
  | "HEAT_PUBLICATION_KEY_ID_INVALID"
  | "HEAT_PUBLICATION_SECRET_INVALID"
  | "HEAT_PUBLICATION_URL_INVALID"
  | "HEAT_REQUEST_TIMEOUT_INVALID"
  | "HEAT_RETENTION_BATCH_SIZE_INVALID"
  | "HEAT_RETENTION_MAXIMUM_BATCHES_INVALID";

export class HeatPromotionWorkerConfigurationError extends Error {
  constructor(readonly code: HeatPromotionWorkerConfigurationErrorCode) {
    super("Heat promotion worker configuration is invalid.");
    this.name = "HeatPromotionWorkerConfigurationError";
  }
}

export interface HeatPromotionWorkerConfiguration {
  readonly convexBaseUrl: string;
  readonly deploymentKey: string;
  readonly keyId: string;
  readonly requestTimeoutMilliseconds: number;
  readonly retentionBatchSize: number;
  readonly retentionMaximumBatchesPerCycle: number;
  readonly secret: Uint8Array;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: HeatPromotionWorkerConfigurationErrorCode,
): number {
  const resolved = value ?? String(fallback);
  if (!/^[1-9][0-9]*$/u.test(resolved)) {
    throw new HeatPromotionWorkerConfigurationError(code);
  }
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HeatPromotionWorkerConfigurationError(code);
  }
  return parsed;
}

const canonicalBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const deploymentKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

function convexBaseUrl(value: string | undefined): string {
  if (!value || value.length > 2_048 || /[\r\n]/u.test(value)) {
    throw new HeatPromotionWorkerConfigurationError(
      "HEAT_PUBLICATION_URL_INVALID",
    );
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || !parsed.hostname || parsed.username ||
      parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
    ) throw new Error("invalid");
    return parsed.origin;
  } catch {
    throw new HeatPromotionWorkerConfigurationError(
      "HEAT_PUBLICATION_URL_INVALID",
    );
  }
}

function deploymentKey(value: string | undefined): string {
  if (!value || !deploymentKeyPattern.test(value)) {
    throw new HeatPromotionWorkerConfigurationError(
      "HEAT_DEPLOYMENT_KEY_INVALID",
    );
  }
  return value;
}

function heatSecret(value: string | undefined): Uint8Array {
  if (!value || !canonicalBase64Pattern.test(value)) {
    throw new HeatPromotionWorkerConfigurationError(
      "HEAT_PUBLICATION_SECRET_INVALID",
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    decoded.byteLength < MIN_PRODUCTION_AUTH_SECRET_BYTES ||
    decoded.byteLength > MAX_PRODUCTION_AUTH_SECRET_BYTES
  ) {
    throw new HeatPromotionWorkerConfigurationError(
      "HEAT_PUBLICATION_SECRET_INVALID",
    );
  }
  return new Uint8Array(decoded);
}

/** Heat owns the default worker's shared Convex target and its own authority. */
export function readHeatPromotionWorkerConfiguration(
  environment: NodeJS.ProcessEnv,
): HeatPromotionWorkerConfiguration {
  const keyId = productionAuthKeyIdSchema.safeParse(
    environment.PACKSCOUT_CONVEX_PUBLICATION_KEY_ID,
  );
  if (!keyId.success) {
    throw new HeatPromotionWorkerConfigurationError(
      "HEAT_PUBLICATION_KEY_ID_INVALID",
    );
  }
  return Object.freeze({
    convexBaseUrl: convexBaseUrl(
      environment.PACKSCOUT_CONVEX_PUBLICATION_BASE_URL,
    ),
    deploymentKey: deploymentKey(environment.PACKSCOUT_CATALOG_DEPLOYMENT_KEY),
    keyId: keyId.data,
    requestTimeoutMilliseconds: boundedInteger(
      environment.PACKSCOUT_CONVEX_PUBLICATION_TIMEOUT_MS,
      10_000,
      100,
      30_000,
      "HEAT_REQUEST_TIMEOUT_INVALID",
    ),
    retentionBatchSize: boundedInteger(
      environment.PACKSCOUT_HEAT_RETENTION_BATCH_SIZE,
      500,
      1,
      1_000,
      "HEAT_RETENTION_BATCH_SIZE_INVALID",
    ),
    retentionMaximumBatchesPerCycle: boundedInteger(
      environment.PACKSCOUT_HEAT_RETENTION_MAX_BATCHES_PER_CYCLE,
      4,
      1,
      20,
      "HEAT_RETENTION_MAXIMUM_BATCHES_INVALID",
    ),
    secret: heatSecret(
      environment.PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64,
    ),
  });
}
