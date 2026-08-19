import {
  MAX_PRODUCTION_AUTH_SECRET_BYTES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES,
  productionAuthKeyIdSchema,
} from "@packscout/contracts";

export type CatalogPromotionWorkerConfigurationErrorCode =
  | "CATALOG_DEPLOYMENT_KEY_INVALID"
  | "CATALOG_PROMOTION_POLL_INTERVAL_INVALID"
  | "CONVEX_PUBLICATION_KEY_ID_INVALID"
  | "CONVEX_PUBLICATION_SECRET_INVALID"
  | "CONVEX_PUBLICATION_TIMEOUT_INVALID"
  | "CONVEX_PUBLICATION_URL_INVALID";

export class CatalogPromotionWorkerConfigurationError extends Error {
  constructor(readonly code: CatalogPromotionWorkerConfigurationErrorCode) {
    super("Catalog promotion worker configuration is invalid.");
    this.name = "CatalogPromotionWorkerConfigurationError";
  }
}

export interface CatalogPromotionWorkerConfiguration {
  readonly convexBaseUrl: string;
  readonly deploymentKey: string;
  readonly keyId: string;
  readonly pollIntervalMilliseconds: number;
  readonly requestTimeoutMilliseconds: number;
  readonly secret: Uint8Array;
}

const deploymentKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const canonicalBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: CatalogPromotionWorkerConfigurationErrorCode,
): number {
  const resolved = value ?? String(fallback);
  if (!/^[1-9][0-9]*$/u.test(resolved)) {
    throw new CatalogPromotionWorkerConfigurationError(code);
  }
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CatalogPromotionWorkerConfigurationError(code);
  }
  return parsed;
}

function baseUrl(value: string | undefined): string {
  if (!value || value.length > 2_048 || /[\r\n]/u.test(value)) {
    throw new CatalogPromotionWorkerConfigurationError(
      "CONVEX_PUBLICATION_URL_INVALID",
    );
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !parsed.hostname ||
        parsed.username || parsed.password || parsed.pathname !== "/" ||
        parsed.search || parsed.hash) {
      throw new Error("invalid");
    }
    return parsed.origin;
  } catch {
    throw new CatalogPromotionWorkerConfigurationError(
      "CONVEX_PUBLICATION_URL_INVALID",
    );
  }
}

function secret(value: string | undefined): Uint8Array {
  if (!value || !canonicalBase64Pattern.test(value)) {
    throw new CatalogPromotionWorkerConfigurationError(
      "CONVEX_PUBLICATION_SECRET_INVALID",
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value ||
      decoded.byteLength < MIN_PRODUCTION_AUTH_SECRET_BYTES ||
      decoded.byteLength > MAX_PRODUCTION_AUTH_SECRET_BYTES) {
    throw new CatalogPromotionWorkerConfigurationError(
      "CONVEX_PUBLICATION_SECRET_INVALID",
    );
  }
  return new Uint8Array(decoded);
}

export function readCatalogPromotionWorkerConfiguration(
  environment: NodeJS.ProcessEnv,
): CatalogPromotionWorkerConfiguration {
  const keyId = productionAuthKeyIdSchema.safeParse(
    environment.PACKSCOUT_CONVEX_PUBLICATION_KEY_ID,
  );
  if (!keyId.success) {
    throw new CatalogPromotionWorkerConfigurationError(
      "CONVEX_PUBLICATION_KEY_ID_INVALID",
    );
  }
  const deploymentKey = environment.PACKSCOUT_CATALOG_DEPLOYMENT_KEY;
  if (!deploymentKey || !deploymentKeyPattern.test(deploymentKey)) {
    throw new CatalogPromotionWorkerConfigurationError(
      "CATALOG_DEPLOYMENT_KEY_INVALID",
    );
  }
  return Object.freeze({
    convexBaseUrl: baseUrl(
      environment.PACKSCOUT_CONVEX_PUBLICATION_BASE_URL,
    ),
    deploymentKey,
    keyId: keyId.data,
    pollIntervalMilliseconds: boundedInteger(
      environment.PACKSCOUT_CATALOG_PROMOTION_POLL_MS,
      5_000,
      1_000,
      30_000,
      "CATALOG_PROMOTION_POLL_INTERVAL_INVALID",
    ),
    requestTimeoutMilliseconds: boundedInteger(
      environment.PACKSCOUT_CONVEX_PUBLICATION_TIMEOUT_MS,
      10_000,
      100,
      30_000,
      "CONVEX_PUBLICATION_TIMEOUT_INVALID",
    ),
    secret: secret(environment.PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64),
  });
}
