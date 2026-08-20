import {
  MAX_APPROVED_PUBLIC_PLATFORMS,
  MAX_PRODUCTION_AUTH_SECRET_BYTES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES,
  canonicalJson,
  productionAuthKeyIdSchema,
  providerPlatformKeySchema,
} from "@packscout/contracts";

export type PromotionV2WorkerConfigurationErrorCode =
  | "PROMOTION_V2_CREDENTIAL_ROLE_CONFLICT"
  | "PROMOTION_V2_DEPLOYMENT_KEY_INVALID"
  | "PROMOTION_V2_MANIFEST_CLEAR_CREDENTIAL_INVALID"
  | "PROMOTION_V2_MANIFEST_PUBLISH_CREDENTIAL_INVALID"
  | "PROMOTION_V2_POLL_INTERVAL_INVALID"
  | "PROMOTION_V2_PROVIDER_CREDENTIALS_INVALID"
  | "PROMOTION_V2_REQUEST_TIMEOUT_INVALID"
  | "PROMOTION_V2_URL_INVALID"
  | "PROMOTION_V2_CREDENTIAL_ELIGIBILITY_MISMATCH";

export class PromotionV2WorkerConfigurationError extends Error {
  constructor(readonly code: PromotionV2WorkerConfigurationErrorCode) {
    super("Provider and manifest promotion configuration is invalid.");
    this.name = "PromotionV2WorkerConfigurationError";
  }
}

export interface PromotionV2Credential {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

export interface ProviderPromotionCredential extends PromotionV2Credential {
  readonly platformKey: string;
}

export interface PromotionV2WorkerConfiguration {
  readonly convexBaseUrl: string;
  readonly deploymentKey: string;
  readonly providerCredentials: readonly ProviderPromotionCredential[];
  readonly manifestPublishCredential: PromotionV2Credential;
  readonly manifestClearCredential: PromotionV2Credential;
  readonly pollIntervalMilliseconds: number;
  readonly requestTimeoutMilliseconds: number;
}

/** Keeps Task011 provider/manifest authorities disjoint from retained roles. */
export function assertPromotionV2CredentialRoleIsolation(
  configuration: PromotionV2WorkerConfiguration,
  reservedKeyIds: readonly string[],
): void {
  const promotionKeyIds = new Set([
    ...configuration.providerCredentials.map(({ keyId }) => keyId),
    configuration.manifestPublishCredential.keyId,
    configuration.manifestClearCredential.keyId,
  ]);
  if (reservedKeyIds.some((keyId) => promotionKeyIds.has(keyId))) {
    refuse("PROMOTION_V2_CREDENTIAL_ROLE_CONFLICT");
  }
}

const deploymentKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const canonicalBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function refuse(code: PromotionV2WorkerConfigurationErrorCode): never {
  throw new PromotionV2WorkerConfigurationError(code);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: PromotionV2WorkerConfigurationErrorCode,
): number {
  const resolved = value ?? String(fallback);
  if (!/^[1-9][0-9]*$/u.test(resolved)) refuse(code);
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    refuse(code);
  }
  return parsed;
}

function baseUrl(value: string | undefined): string {
  if (!value || value.length > 2_048 || /[\r\n]/u.test(value)) {
    refuse("PROMOTION_V2_URL_INVALID");
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !parsed.hostname ||
        parsed.username || parsed.password || parsed.pathname !== "/" ||
        parsed.search || parsed.hash) throw new Error("invalid");
    return parsed.origin;
  } catch {
    return refuse("PROMOTION_V2_URL_INVALID");
  }
}

function secret(
  value: unknown,
  code: PromotionV2WorkerConfigurationErrorCode,
): Uint8Array {
  if (typeof value !== "string" || !canonicalBase64Pattern.test(value)) {
    refuse(code);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value ||
      decoded.byteLength < MIN_PRODUCTION_AUTH_SECRET_BYTES ||
      decoded.byteLength > MAX_PRODUCTION_AUTH_SECRET_BYTES) refuse(code);
  return new Uint8Array(decoded);
}

function credential(
  keyIdValue: unknown,
  secretValue: unknown,
  code: PromotionV2WorkerConfigurationErrorCode,
): PromotionV2Credential {
  const keyId = productionAuthKeyIdSchema.safeParse(keyIdValue);
  if (!keyId.success) refuse(code);
  return Object.freeze({ keyId: keyId.data, secret: secret(secretValue, code) });
}

function manifestCredential(
  environment: NodeJS.ProcessEnv,
  kind: "PUBLISH" | "CLEAR",
): PromotionV2Credential {
  const code = kind === "PUBLISH"
    ? "PROMOTION_V2_MANIFEST_PUBLISH_CREDENTIAL_INVALID"
    : "PROMOTION_V2_MANIFEST_CLEAR_CREDENTIAL_INVALID";
  return credential(
    environment[`PACKSCOUT_CATALOG_MANIFEST_${kind}_KEY_ID`],
    environment[`PACKSCOUT_CATALOG_MANIFEST_${kind}_SECRET_BASE64`],
    code,
  );
}

function providerCredentials(value: string | undefined):
readonly ProviderPromotionCredential[] {
  if (!value || value.length > 32_768) {
    refuse("PROMOTION_V2_PROVIDER_CREDENTIALS_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return refuse("PROMOTION_V2_PROVIDER_CREDENTIALS_INVALID");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse("PROMOTION_V2_PROVIDER_CREDENTIALS_INVALID");
  }
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > MAX_APPROVED_PUBLIC_PLATFORMS ||
      canonicalJson(parsed) !== value) {
    refuse("PROMOTION_V2_PROVIDER_CREDENTIALS_INVALID");
  }
  const credentials = entries.map(([platformKey, candidate]) => {
    const platform = providerPlatformKeySchema.safeParse(platformKey);
    if (!platform.success || typeof candidate !== "object" ||
        candidate === null || Array.isArray(candidate) ||
        Object.keys(candidate).sort().join("\u0000") !==
          "keyId\u0000secretBase64") {
      refuse("PROMOTION_V2_PROVIDER_CREDENTIALS_INVALID");
    }
    const record = candidate as Record<string, unknown>;
    return Object.freeze({
      platformKey: platform.data,
      ...credential(
        record.keyId,
        record.secretBase64,
        "PROMOTION_V2_PROVIDER_CREDENTIALS_INVALID",
      ),
    });
  });
  if (credentials.some(({ platformKey }, index) =>
    index > 0 && credentials[index - 1]!.platformKey >= platformKey) ||
    new Set(credentials.map(({ keyId }) => keyId)).size !== credentials.length) {
    refuse("PROMOTION_V2_PROVIDER_CREDENTIALS_INVALID");
  }
  return Object.freeze(credentials);
}

export function assertPromotionV2CredentialEligibility(
  configuration: PromotionV2WorkerConfiguration,
  snapshot: Readonly<{
    configuredPlatformKeys: readonly string[];
    enabledPlatformKeys: readonly string[];
  }>,
): void {
  const registered = new Set(snapshot.configuredPlatformKeys);
  const credentials = new Set(
    configuration.providerCredentials.map(({ platformKey }) => platformKey),
  );
  if (
    credentials.size !== registered.size ||
    configuration.providerCredentials.some(
      ({ platformKey }) => !registered.has(platformKey),
    ) ||
    snapshot.configuredPlatformKeys.some((platformKey) =>
      !credentials.has(platformKey)) ||
    snapshot.enabledPlatformKeys.some((platformKey) =>
      !credentials.has(platformKey))
  ) refuse("PROMOTION_V2_CREDENTIAL_ELIGIBILITY_MISMATCH");
}

export function readPromotionV2WorkerConfiguration(
  environment: NodeJS.ProcessEnv,
): PromotionV2WorkerConfiguration {
  const deploymentKey = environment.PACKSCOUT_CATALOG_DEPLOYMENT_KEY;
  if (!deploymentKey || !deploymentKeyPattern.test(deploymentKey)) {
    refuse("PROMOTION_V2_DEPLOYMENT_KEY_INVALID");
  }
  const providers = providerCredentials(
    environment.PACKSCOUT_CATALOG_PROVIDER_CREDENTIALS,
  );
  const manifestPublishCredential = manifestCredential(environment, "PUBLISH");
  const manifestClearCredential = manifestCredential(environment, "CLEAR");
  const keyIds = [
    ...providers.map(({ keyId }) => keyId),
    manifestPublishCredential.keyId,
    manifestClearCredential.keyId,
  ];
  const roleCredentials = [
    ...providers,
    manifestPublishCredential,
    manifestClearCredential,
  ];
  const secretIds = roleCredentials.map(({ secret }) =>
    Buffer.from(secret).toString("base64"));
  if (new Set(keyIds).size !== keyIds.length ||
      new Set(secretIds).size !== secretIds.length) {
    refuse("PROMOTION_V2_CREDENTIAL_ROLE_CONFLICT");
  }
  const configuration = Object.freeze({
    convexBaseUrl: baseUrl(environment.PACKSCOUT_CONVEX_PUBLICATION_BASE_URL),
    deploymentKey,
    providerCredentials: providers,
    manifestPublishCredential,
    manifestClearCredential,
    pollIntervalMilliseconds: boundedInteger(
      environment.PACKSCOUT_CATALOG_PROMOTION_POLL_MS,
      5_000,
      100,
      5_000,
      "PROMOTION_V2_POLL_INTERVAL_INVALID",
    ),
    requestTimeoutMilliseconds: boundedInteger(
      environment.PACKSCOUT_CONVEX_PUBLICATION_TIMEOUT_MS,
      10_000,
      100,
      30_000,
      "PROMOTION_V2_REQUEST_TIMEOUT_INVALID",
    ),
  });
  const retainedHeatKeyId = environment.PACKSCOUT_CONVEX_PUBLICATION_KEY_ID;
  if (retainedHeatKeyId !== undefined) {
    assertPromotionV2CredentialRoleIsolation(configuration, [retainedHeatKeyId]);
  }
  return configuration;
}
