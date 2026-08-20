import {
  MAX_PRODUCTION_AUTH_SECRET_BYTES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES,
  productionAuthKeyIdSchema,
} from "@packscout/contracts";
import type { PromotionV2WorkerConfiguration } from
  "./promotion-v2-worker-config.ts";

export type HeatPromotionWorkerConfigurationErrorCode =
  | "HEAT_PUBLICATION_KEY_ID_INVALID"
  | "HEAT_PUBLICATION_SECRET_INVALID"
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

/** Heat shares Promotion V2's Convex deployment but owns its credential/cadence. */
export function readHeatPromotionWorkerConfiguration(
  environment: NodeJS.ProcessEnv,
  promotion: Pick<
    PromotionV2WorkerConfiguration,
    "convexBaseUrl" | "deploymentKey" | "requestTimeoutMilliseconds"
  >,
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
    convexBaseUrl: promotion.convexBaseUrl,
    deploymentKey: promotion.deploymentKey,
    keyId: keyId.data,
    requestTimeoutMilliseconds: promotion.requestTimeoutMilliseconds,
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
