import type { CatalogPromotionWorkerConfiguration } from "./catalog-promotion-worker-config.ts";

export type HeatPromotionWorkerConfigurationErrorCode =
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

/** Heat shares the authenticated Convex deployment but owns its cadence. */
export function readHeatPromotionWorkerConfiguration(
  environment: NodeJS.ProcessEnv,
  publication: CatalogPromotionWorkerConfiguration,
): HeatPromotionWorkerConfiguration {
  return Object.freeze({
    convexBaseUrl: publication.convexBaseUrl,
    deploymentKey: publication.deploymentKey,
    keyId: publication.keyId,
    requestTimeoutMilliseconds: publication.requestTimeoutMilliseconds,
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
    secret: publication.secret,
  });
}
