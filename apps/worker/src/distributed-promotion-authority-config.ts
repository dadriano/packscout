import { createHash } from "node:crypto";
import { inspect } from "node:util";
import {
  MAX_PRODUCTION_AUTH_SECRET_BYTES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES,
  productionAuthKeyIdSchema,
} from "@packscout/contracts";

export type DistributedPromotionAuthorityConfigurationErrorCode =
  | "DISTRIBUTED_PROMOTION_AUTHORITY_ROLE_CONFLICT"
  | "DISTRIBUTED_PROMOTION_AUTHORITY_VERSION_INVALID"
  | "DISTRIBUTED_PROMOTION_DEPLOYMENT_KEY_INVALID"
  | "DISTRIBUTED_PROMOTION_LEGACY_AUTHORITY_CONFIGURED"
  | "DISTRIBUTED_PROMOTION_MANIFEST_CREDENTIAL_INVALID"
  | "DISTRIBUTED_PROMOTION_PROVIDER_CREDENTIAL_INVALID"
  | "DISTRIBUTED_PROMOTION_PROVIDER_ID_INVALID"
  | "DISTRIBUTED_PROMOTION_PROVIDER_NOT_REGISTERED"
  | "DISTRIBUTED_PROMOTION_REQUEST_TIMEOUT_INVALID"
  | "DISTRIBUTED_PROMOTION_URL_INVALID";

export class DistributedPromotionAuthorityConfigurationError extends Error {
  constructor(
    readonly code: DistributedPromotionAuthorityConfigurationErrorCode,
  ) {
    super("Distributed promotion authority configuration is invalid.");
    this.name = "DistributedPromotionAuthorityConfigurationError";
  }
}
export interface DistributedPromotionCredential {
  readonly keyId: string;
  readonly secret: Uint8Array;
  readonly secretIdentitySha256: string;
  readonly authorityVersion: string;
}

interface CommonConfiguration {
  readonly convexBaseUrl: string;
  readonly deploymentKey: string;
  readonly requestTimeoutMilliseconds: number;
}

export interface ProviderPublicationJobAuthorityConfiguration
  extends CommonConfiguration {
  readonly kind: "provider_publication";
  readonly providerId: string;
  readonly credential: DistributedPromotionCredential;
}

export interface ManifestReconciliationJobAuthorityConfiguration
  extends CommonConfiguration {
  readonly kind: "manifest_reconciliation";
  readonly credential: DistributedPromotionCredential;
}

export type DistributedPromotionJobAuthorityConfiguration =
  | ProviderPublicationJobAuthorityConfiguration
  | ManifestReconciliationJobAuthorityConfiguration;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEPLOYMENT_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const AUTHORITY_VERSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/u;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const PROVIDER_KEYS = [
  "PACKSCOUT_PROMOTION_PROVIDER_ID",
  "PACKSCOUT_PROMOTION_PROVIDER_KEY_ID",
  "PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION",
] as const;

const MANIFEST_KEYS = [
  "PACKSCOUT_PROMOTION_MANIFEST_KEY_ID",
  "PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_MANIFEST_AUTHORITY_VERSION",
] as const;

const LEGACY_COMPOSITE_KEYS = [
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
] as const;

function refuse(
  code: DistributedPromotionAuthorityConfigurationErrorCode,
): never {
  throw new DistributedPromotionAuthorityConfigurationError(code);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function includesAny(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[],
): boolean {
  return keys.some((key) => environment[key] !== undefined);
}

function safeCredentialDescriptor(value: DistributedPromotionCredential) {
  return Object.freeze({
    authorityVersion: value.authorityVersion,
    keyIdentitySha256: sha256(value.keyId),
  });
}

class PrivateCredential implements DistributedPromotionCredential {
  readonly #keyId: string;
  readonly #secret: Uint8Array;
  readonly #secretIdentitySha256: string;
  readonly #authorityVersion: string;

  constructor(input: {
    readonly keyId: string;
    readonly secret: Uint8Array;
    readonly secretIdentitySha256: string;
    readonly authorityVersion: string;
  }) {
    this.#keyId = input.keyId;
    this.#secret = input.secret.slice();
    this.#secretIdentitySha256 = input.secretIdentitySha256;
    this.#authorityVersion = input.authorityVersion;
  }

  get keyId(): string {
    return this.#keyId;
  }

  get secret(): Uint8Array {
    return this.#secret.slice();
  }

  get secretIdentitySha256(): string {
    return this.#secretIdentitySha256;
  }

  get authorityVersion(): string {
    return this.#authorityVersion;
  }

  toJSON() {
    return safeCredentialDescriptor(this);
  }

  [inspect.custom]() {
    return this.toJSON();
  }
}

class PrivateProviderConfiguration
implements ProviderPublicationJobAuthorityConfiguration {
  readonly #common: CommonConfiguration;
  readonly #providerId: string;
  readonly #credential: DistributedPromotionCredential;

  constructor(
    common: CommonConfiguration,
    providerId: string,
    credential: DistributedPromotionCredential,
  ) {
    this.#common = common;
    this.#providerId = providerId;
    this.#credential = credential;
  }

  get kind(): "provider_publication" {
    return "provider_publication";
  }

  get providerId(): string {
    return this.#providerId;
  }

  get credential(): DistributedPromotionCredential {
    return this.#credential;
  }

  get convexBaseUrl(): string {
    return this.#common.convexBaseUrl;
  }

  get deploymentKey(): string {
    return this.#common.deploymentKey;
  }

  get requestTimeoutMilliseconds(): number {
    return this.#common.requestTimeoutMilliseconds;
  }

  toJSON() {
    return Object.freeze({
      kind: this.kind,
      providerIdentitySha256: sha256(this.providerId.toLowerCase()),
      convexBaseUrlSha256: sha256(this.convexBaseUrl),
      deploymentKeySha256: sha256(this.deploymentKey),
      requestTimeoutMilliseconds: this.requestTimeoutMilliseconds,
      credential: safeCredentialDescriptor(this.credential),
    });
  }

  [inspect.custom]() {
    return this.toJSON();
  }
}

class PrivateManifestConfiguration
implements ManifestReconciliationJobAuthorityConfiguration {
  readonly #common: CommonConfiguration;
  readonly #credential: DistributedPromotionCredential;

  constructor(
    common: CommonConfiguration,
    credential: DistributedPromotionCredential,
  ) {
    this.#common = common;
    this.#credential = credential;
  }

  get kind(): "manifest_reconciliation" {
    return "manifest_reconciliation";
  }

  get credential(): DistributedPromotionCredential {
    return this.#credential;
  }

  get convexBaseUrl(): string {
    return this.#common.convexBaseUrl;
  }

  get deploymentKey(): string {
    return this.#common.deploymentKey;
  }

  get requestTimeoutMilliseconds(): number {
    return this.#common.requestTimeoutMilliseconds;
  }

  toJSON() {
    return Object.freeze({
      kind: this.kind,
      convexBaseUrlSha256: sha256(this.convexBaseUrl),
      deploymentKeySha256: sha256(this.deploymentKey),
      requestTimeoutMilliseconds: this.requestTimeoutMilliseconds,
      credential: safeCredentialDescriptor(this.credential),
    });
  }

  [inspect.custom]() {
    return this.toJSON();
  }
}

function requireNoLegacyAuthority(environment: NodeJS.ProcessEnv): void {
  if (includesAny(environment, LEGACY_COMPOSITE_KEYS)) {
    refuse("DISTRIBUTED_PROMOTION_LEGACY_AUTHORITY_CONFIGURED");
  }
}

function baseUrl(value: string | undefined): string {
  if (!value || value.length > 2_048 || /[\r\n]/u.test(value)) {
    refuse("DISTRIBUTED_PROMOTION_URL_INVALID");
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("invalid");
    }
    return parsed.origin;
  } catch {
    return refuse("DISTRIBUTED_PROMOTION_URL_INVALID");
  }
}

function boundedTimeout(value: string | undefined): number {
  const resolved = value ?? "10000";
  if (!/^[1-9][0-9]*$/u.test(resolved)) {
    refuse("DISTRIBUTED_PROMOTION_REQUEST_TIMEOUT_INVALID");
  }
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 30_000) {
    refuse("DISTRIBUTED_PROMOTION_REQUEST_TIMEOUT_INVALID");
  }
  return parsed;
}

function common(environment: NodeJS.ProcessEnv): CommonConfiguration {
  const deploymentKey = environment.PACKSCOUT_CATALOG_DEPLOYMENT_KEY;
  if (!deploymentKey || !DEPLOYMENT_KEY_PATTERN.test(deploymentKey)) {
    refuse("DISTRIBUTED_PROMOTION_DEPLOYMENT_KEY_INVALID");
  }
  return Object.freeze({
    convexBaseUrl: baseUrl(
      environment.PACKSCOUT_CONVEX_PUBLICATION_BASE_URL,
    ),
    deploymentKey,
    requestTimeoutMilliseconds: boundedTimeout(
      environment.PACKSCOUT_CONVEX_PUBLICATION_TIMEOUT_MS,
    ),
  });
}

function credential(
  keyIdValue: unknown,
  secretValue: unknown,
  authorityVersionValue: unknown,
  code:
    | "DISTRIBUTED_PROMOTION_PROVIDER_CREDENTIAL_INVALID"
    | "DISTRIBUTED_PROMOTION_MANIFEST_CREDENTIAL_INVALID",
): DistributedPromotionCredential {
  const keyId = productionAuthKeyIdSchema.safeParse(keyIdValue);
  if (
    !keyId.success ||
    typeof secretValue !== "string" ||
    !CANONICAL_BASE64_PATTERN.test(secretValue)
  ) {
    refuse(code);
  }
  if (
    typeof authorityVersionValue !== "string" ||
    !AUTHORITY_VERSION_PATTERN.test(authorityVersionValue)
  ) {
    refuse("DISTRIBUTED_PROMOTION_AUTHORITY_VERSION_INVALID");
  }
  const decoded = Buffer.from(secretValue, "base64");
  if (
    decoded.toString("base64") !== secretValue ||
    decoded.byteLength < MIN_PRODUCTION_AUTH_SECRET_BYTES ||
    decoded.byteLength > MAX_PRODUCTION_AUTH_SECRET_BYTES
  ) {
    refuse(code);
  }
  return Object.freeze(new PrivateCredential({
    keyId: keyId.data,
    secret: new Uint8Array(decoded),
    secretIdentitySha256: sha256(decoded),
    authorityVersion: authorityVersionValue,
  }));
}

export function readProviderPublicationJobAuthorityConfiguration(
  environment: NodeJS.ProcessEnv,
): ProviderPublicationJobAuthorityConfiguration {
  requireNoLegacyAuthority(environment);
  if (includesAny(environment, MANIFEST_KEYS)) {
    refuse("DISTRIBUTED_PROMOTION_AUTHORITY_ROLE_CONFLICT");
  }
  const providerId = environment.PACKSCOUT_PROMOTION_PROVIDER_ID;
  if (!providerId || !UUID_PATTERN.test(providerId)) {
    refuse("DISTRIBUTED_PROMOTION_PROVIDER_ID_INVALID");
  }
  return Object.freeze(new PrivateProviderConfiguration(
    common(environment),
    providerId.toLowerCase(),
    credential(
      environment.PACKSCOUT_PROMOTION_PROVIDER_KEY_ID,
      environment.PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64,
      environment.PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION,
      "DISTRIBUTED_PROMOTION_PROVIDER_CREDENTIAL_INVALID",
    ),
  ));
}

export function readManifestReconciliationJobAuthorityConfiguration(
  environment: NodeJS.ProcessEnv,
): ManifestReconciliationJobAuthorityConfiguration {
  requireNoLegacyAuthority(environment);
  if (includesAny(environment, PROVIDER_KEYS)) {
    refuse("DISTRIBUTED_PROMOTION_AUTHORITY_ROLE_CONFLICT");
  }
  return Object.freeze(new PrivateManifestConfiguration(
    common(environment),
    credential(
      environment.PACKSCOUT_PROMOTION_MANIFEST_KEY_ID,
      environment.PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64,
      environment.PACKSCOUT_PROMOTION_MANIFEST_AUTHORITY_VERSION,
      "DISTRIBUTED_PROMOTION_MANIFEST_CREDENTIAL_INVALID",
    ),
  ));
}

export function assertProviderPublicationJobRegistration(
  configuration: ProviderPublicationJobAuthorityConfiguration,
  registered: Readonly<{ providerId: string }>,
): void {
  if (
    !UUID_PATTERN.test(registered.providerId) ||
    registered.providerId.toLowerCase() !== configuration.providerId
  ) {
    refuse("DISTRIBUTED_PROMOTION_PROVIDER_NOT_REGISTERED");
  }
}

export function assertDistributedPromotionAuthorityIsolation(
  configuration: DistributedPromotionJobAuthorityConfiguration,
  reserved: readonly Readonly<{
    keyId: string;
    secretIdentitySha256: string;
  }>[],
): void {
  if (reserved.some((candidate) =>
    candidate.keyId === configuration.credential.keyId ||
    candidate.secretIdentitySha256 ===
      configuration.credential.secretIdentitySha256
  )) {
    refuse("DISTRIBUTED_PROMOTION_AUTHORITY_ROLE_CONFLICT");
  }
}
