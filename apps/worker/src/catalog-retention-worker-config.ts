import {
  MAX_PRODUCTION_AUTH_SECRET_BYTES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES,
  productionAuthKeyIdSchema,
} from "@packscout/contracts";
import type { HeatPromotionWorkerConfiguration } from
  "./heat-promotion-worker-config.ts";
import type {
  PromotionV2Credential,
  PromotionV2WorkerConfiguration,
} from "./promotion-v2-worker-config.ts";

export type CatalogRetentionWorkerConfigurationErrorCode =
  | "CATALOG_RETENTION_CONTINUATION_INTERVAL_INVALID"
  | "CATALOG_RETENTION_CREDENTIAL_INVALID"
  | "CATALOG_RETENTION_CREDENTIAL_ROLE_CONFLICT"
  | "CATALOG_RETENTION_INTERVAL_INVALID"
  | "CATALOG_RETENTION_MAXIMUM_DOCUMENTS_INVALID"
  | "CATALOG_RETENTION_MAXIMUM_POSTGRES_ROWS_INVALID"
  | "CATALOG_RETENTION_MAXIMUM_STEPS_INVALID";

export class CatalogRetentionWorkerConfigurationError extends Error {
  constructor(readonly code: CatalogRetentionWorkerConfigurationErrorCode) {
    super("Catalog retention worker configuration is invalid.");
    this.name = "CatalogRetentionWorkerConfigurationError";
  }
}

export interface CatalogRetentionWorkerConfiguration {
  readonly convexBaseUrl: string;
  readonly deploymentKey: string;
  readonly keyId: string;
  readonly secret: Uint8Array;
  readonly requestTimeoutMilliseconds: number;
  readonly intervalMilliseconds: number;
  readonly continuationIntervalMilliseconds: number;
  readonly maximumDocuments: number;
  readonly maximumPostgresRowsPerStep: number;
  readonly maximumStepsPerCycle: number;
}

const canonicalBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function refuse(code: CatalogRetentionWorkerConfigurationErrorCode): never {
  throw new CatalogRetentionWorkerConfigurationError(code);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: CatalogRetentionWorkerConfigurationErrorCode,
): number {
  const resolved = value ?? String(fallback);
  if (!/^[1-9][0-9]*$/u.test(resolved)) return refuse(code);
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return refuse(code);
  }
  return parsed;
}

function retentionSecret(value: string | undefined): Uint8Array {
  if (!value || !canonicalBase64Pattern.test(value)) {
    return refuse("CATALOG_RETENTION_CREDENTIAL_INVALID");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    decoded.byteLength < MIN_PRODUCTION_AUTH_SECRET_BYTES ||
    decoded.byteLength > MAX_PRODUCTION_AUTH_SECRET_BYTES
  ) return refuse("CATALOG_RETENTION_CREDENTIAL_INVALID");
  return new Uint8Array(decoded);
}

type RoleCredential = Pick<PromotionV2Credential, "keyId" | "secret">;

function credentialIdentity(credential: RoleCredential): string {
  return Buffer.from(credential.secret).toString("base64");
}

/** Key IDs and signing bytes are both authorities and must be pairwise unique. */
export function assertCatalogRetentionCredentialRoleIsolation(input: Readonly<{
  promotion: PromotionV2WorkerConfiguration;
  heat: Pick<HeatPromotionWorkerConfiguration, "keyId" | "secret">;
  retention: Pick<CatalogRetentionWorkerConfiguration, "keyId" | "secret">;
}>): void {
  const credentials: readonly RoleCredential[] = [
    ...input.promotion.providerCredentials,
    input.promotion.manifestPublishCredential,
    input.promotion.manifestClearCredential,
    input.heat,
    input.retention,
  ];
  const keyIds = new Set<string>();
  const secrets = new Set<string>();
  for (const credential of credentials) {
    if (keyIds.has(credential.keyId) ||
        secrets.has(credentialIdentity(credential))) {
      return refuse("CATALOG_RETENTION_CREDENTIAL_ROLE_CONFLICT");
    }
    keyIds.add(credential.keyId);
    secrets.add(credentialIdentity(credential));
  }
}

/** Reads the dedicated retain credential and independent bounded cadence. */
export function readCatalogRetentionWorkerConfiguration(
  environment: NodeJS.ProcessEnv,
  promotion: Pick<
    PromotionV2WorkerConfiguration,
    "convexBaseUrl" | "deploymentKey" | "requestTimeoutMilliseconds"
  >,
): CatalogRetentionWorkerConfiguration {
  const keyId = productionAuthKeyIdSchema.safeParse(
    environment.PACKSCOUT_CATALOG_RETENTION_KEY_ID,
  );
  if (!keyId.success) return refuse("CATALOG_RETENTION_CREDENTIAL_INVALID");
  const intervalMilliseconds = boundedInteger(
    environment.PACKSCOUT_CATALOG_RETENTION_INTERVAL_MS,
    3_600_000,
    60_000,
    86_400_000,
    "CATALOG_RETENTION_INTERVAL_INVALID",
  );
  const continuationIntervalMilliseconds = boundedInteger(
    environment.PACKSCOUT_CATALOG_RETENTION_CONTINUATION_INTERVAL_MS,
    1_000,
    100,
    60_000,
    "CATALOG_RETENTION_CONTINUATION_INTERVAL_INVALID",
  );
  if (continuationIntervalMilliseconds > intervalMilliseconds) {
    return refuse("CATALOG_RETENTION_CONTINUATION_INTERVAL_INVALID");
  }
  return Object.freeze({
    convexBaseUrl: promotion.convexBaseUrl,
    deploymentKey: promotion.deploymentKey,
    keyId: keyId.data,
    secret: retentionSecret(
      environment.PACKSCOUT_CATALOG_RETENTION_SECRET_BASE64,
    ),
    requestTimeoutMilliseconds: promotion.requestTimeoutMilliseconds,
    intervalMilliseconds,
    continuationIntervalMilliseconds,
    maximumDocuments: boundedInteger(
      environment.PACKSCOUT_CATALOG_RETENTION_MAXIMUM_DOCUMENTS,
      90,
      9,
      90,
      "CATALOG_RETENTION_MAXIMUM_DOCUMENTS_INVALID",
    ),
    maximumPostgresRowsPerStep: boundedInteger(
      environment.PACKSCOUT_CATALOG_RETENTION_MAXIMUM_POSTGRES_ROWS,
      100,
      10,
      100,
      "CATALOG_RETENTION_MAXIMUM_POSTGRES_ROWS_INVALID",
    ),
    maximumStepsPerCycle: boundedInteger(
      environment.PACKSCOUT_CATALOG_RETENTION_MAXIMUM_STEPS_PER_CYCLE,
      25,
      1,
      100,
      "CATALOG_RETENTION_MAXIMUM_STEPS_INVALID",
    ),
  });
}
