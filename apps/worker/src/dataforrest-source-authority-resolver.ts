import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  dataforrestEventsConnectionConfigurationV1Schema,
  dataforrestEventsSourceConfigurationV1Schema,
  type LaunchProviderKey,
} from "@packscout/contracts";
import type { CentralQueryClient } from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  type EncryptedProviderCredential,
} from "@packscout/services";
import {
  providerDataforrestLiveIntegrationRegistry,
  type ProviderDataforrestLiveIntegrationRegistry,
} from "./provider-dataforrest-live-integration.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const providerKeyPattern = /^[a-z][a-z0-9_]{0,52}$/u;
const adapterKeyPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/u;

export type DataforrestSourceAuthorityFailureCode =
  | "PROVIDER_SOURCE_AUTHORITY_INPUT_INVALID"
  | "PROVIDER_SOURCE_AUTHORITY_UNAVAILABLE"
  | "PROVIDER_SOURCE_CONFIGURATION_CONFLICT"
  | "PROVIDER_SOURCE_CONFIGURATION_EXPIRED"
  | "PROVIDER_SOURCE_CREDENTIAL_UNAVAILABLE"
  | "PROVIDER_SOURCE_CREDENTIAL_INVALID";

/** Public-safe authority failure that never carries central rows or secrets. */
export class DataforrestSourceAuthorityError extends Error {
  constructor(readonly code: DataforrestSourceAuthorityFailureCode) {
    super(code);
    this.name = "DataforrestSourceAuthorityError";
  }
}

export interface DataforrestSourceAuthorityRequest {
  readonly providerId: string;
  readonly providerKey: string;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly adapterKey: string;
  readonly now?: Date;
}

export interface ResolvedDataforrestSourceAuthority {
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerKey: LaunchProviderKey;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly adapterKey: string;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly sourceCredentialVersionId: string;
  readonly sourceCredentialVersionNumber: bigint;
  readonly expiresAt: Date | null;
  /** Ephemeral only. Callers must never persist or log this object. */
  readonly connectionConfiguration: Readonly<{
    endpoint: typeof DATAFORREST_EVENTS_V1_ENDPOINT;
    bearerToken: string;
  }>;
  readonly sourceConfiguration: Readonly<{ platform: LaunchProviderKey }>;
}

interface StoredSourceCredential {
  readonly id: string;
  readonly provider_id: string;
  readonly credential_kind: string;
  readonly version_number: bigint;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly auth_tag: Uint8Array;
  readonly key_version: number;
  readonly lifecycle: string;
  readonly activated_at: Date | null;
  readonly retired_at: Date | null;
  readonly revoked_at: Date | null;
}

interface StoredSourceConfiguration {
  readonly id: string;
  readonly provider_id: string;
  readonly version_number: bigint;
  readonly adapter_key: string;
  readonly endpoint_url: string;
  readonly source_credential_version_id: string | null;
  readonly configuration: unknown;
  readonly expires_at: Date | null;
  readonly source_credential: StoredSourceCredential | null;
  readonly provider: StoredProviderIdentity;
}

interface StoredProviderIdentity {
  readonly id: string;
  readonly organization_id: string;
  readonly provider_key: string;
  readonly lifecycle: string;
}

function failure(code: DataforrestSourceAuthorityFailureCode): never {
  throw new DataforrestSourceAuthorityError(code);
}

function validRequest(input: DataforrestSourceAuthorityRequest): boolean {
  return typeof input.providerId === "string"
    && uuidPattern.test(input.providerId)
    && typeof input.providerKey === "string"
    && providerKeyPattern.test(input.providerKey)
    && typeof input.configVersionId === "string"
    && uuidPattern.test(input.configVersionId)
    && typeof input.configVersionNumber === "bigint"
    && input.configVersionNumber > 0n
    && typeof input.adapterKey === "string"
    && adapterKeyPattern.test(input.adapterKey)
    && (input.now === undefined || (
      input.now instanceof Date && Number.isFinite(input.now.getTime())
    ));
}

function activeCredentialAt(
  credential: StoredSourceCredential,
  now: Date,
): boolean {
  return credential.credential_kind === "source"
    && credential.lifecycle === "active"
    && typeof credential.version_number === "bigint"
    && credential.version_number > 0n
    && (credential.activated_at === null || (
      credential.activated_at instanceof Date
      && Number.isFinite(credential.activated_at.getTime())
      && credential.activated_at.getTime() <= now.getTime()
    ))
    && credential.retired_at === null
    && credential.revoked_at === null;
}

function encryptedCredential(
  credential: StoredSourceCredential,
): EncryptedProviderCredential {
  return Object.freeze({
    ciphertext: new Uint8Array(credential.ciphertext),
    nonce: new Uint8Array(credential.nonce),
    authTag: new Uint8Array(credential.auth_tag),
    keyVersion: credential.key_version,
  });
}

/**
 * Resolves one restart-safe, immutable DataForrest authority from central.
 * The provider database contributes only identity/config pins; credential
 * bytes and plaintext never cross into provider-local persistence.
 */
export class CentralDataforrestSourceAuthorityResolver {
  constructor(private readonly dependencies: Readonly<{
    central: CentralQueryClient;
    credentialCipher: AesGcmProviderCredentialCipher;
    integrations?: Pick<ProviderDataforrestLiveIntegrationRegistry, "resolve">;
  }>) {}

  async resolve(
    input: DataforrestSourceAuthorityRequest,
  ): Promise<ResolvedDataforrestSourceAuthority> {
    if (!validRequest(input)) {
      return failure("PROVIDER_SOURCE_AUTHORITY_INPUT_INVALID");
    }
    const integration = (
      this.dependencies.integrations ?? providerDataforrestLiveIntegrationRegistry
    ).resolve(input.providerKey, input.adapterKey);
    if (integration === null) {
      return failure("PROVIDER_SOURCE_AUTHORITY_INPUT_INVALID");
    }
    const now = input.now ?? new Date();
    let config: StoredSourceConfiguration | null;
    try {
      config = await this.dependencies.central.provider_config_versions.findUnique({
        where: { id: input.configVersionId },
        select: {
          id: true,
          provider_id: true,
          version_number: true,
          adapter_key: true,
          endpoint_url: true,
          source_credential_version_id: true,
          configuration: true,
          expires_at: true,
          source_credential: {
            select: {
              id: true,
              provider_id: true,
              credential_kind: true,
              version_number: true,
              ciphertext: true,
              nonce: true,
              auth_tag: true,
              key_version: true,
              lifecycle: true,
              activated_at: true,
              retired_at: true,
              revoked_at: true,
            },
          },
          provider: {
            select: {
              id: true,
              organization_id: true,
              provider_key: true,
              lifecycle: true,
            },
          },
        },
      }) as StoredSourceConfiguration | null;
    } catch {
      return failure("PROVIDER_SOURCE_AUTHORITY_UNAVAILABLE");
    }
    const provider = config?.provider ?? null;
    if (
      provider === null
      || provider.lifecycle !== "active"
      || !uuidPattern.test(provider.organization_id)
    ) {
      return failure("PROVIDER_SOURCE_AUTHORITY_UNAVAILABLE");
    }
    if (
      provider.id !== input.providerId
      || provider.provider_key !== input.providerKey
      || config === null
      || config.id !== input.configVersionId
      || config.provider_id !== input.providerId
      || config.version_number !== input.configVersionNumber
      || config.adapter_key !== input.adapterKey
      || config.adapter_key !== integration.manifest.adapterVersion
    ) {
      return failure("PROVIDER_SOURCE_CONFIGURATION_CONFLICT");
    }
    if (
      config.expires_at !== null
      && (!(config.expires_at instanceof Date)
        || !Number.isFinite(config.expires_at.getTime()))
    ) {
      return failure("PROVIDER_SOURCE_CONFIGURATION_CONFLICT");
    }
    if (
      config.expires_at !== null
      && config.expires_at.getTime() <= now.getTime()
    ) {
      return failure("PROVIDER_SOURCE_CONFIGURATION_EXPIRED");
    }
    if (config.endpoint_url !== DATAFORREST_EVENTS_V1_ENDPOINT) {
      return failure("PROVIDER_SOURCE_CONFIGURATION_CONFLICT");
    }
    const source = dataforrestEventsSourceConfigurationV1Schema.safeParse(
      config.configuration,
    );
    if (
      !source.success
      || source.data.platform !== provider.provider_key
      || source.data.platform !== input.providerKey
    ) {
      return failure("PROVIDER_SOURCE_CONFIGURATION_CONFLICT");
    }
    const credential = config.source_credential;
    if (
      config.source_credential_version_id === null
      || credential === null
      || !uuidPattern.test(config.source_credential_version_id)
      || credential.id !== config.source_credential_version_id
      || credential.provider_id !== provider.id
      || !activeCredentialAt(credential, now)
    ) {
      return failure("PROVIDER_SOURCE_CREDENTIAL_UNAVAILABLE");
    }

    let bearerToken: string;
    try {
      bearerToken = this.dependencies.credentialCipher.decrypt(
        encryptedCredential(credential),
        {
          organizationId: provider.organization_id,
          providerId: provider.id,
          revisionId: credential.id,
        },
      );
    } catch {
      return failure("PROVIDER_SOURCE_CREDENTIAL_INVALID");
    }
    const connection = dataforrestEventsConnectionConfigurationV1Schema
      .safeParse({ endpoint: config.endpoint_url, bearerToken });
    if (!connection.success) {
      bearerToken = "";
      return failure("PROVIDER_SOURCE_CREDENTIAL_INVALID");
    }
    return Object.freeze({
      organizationId: provider.organization_id,
      providerId: provider.id,
      providerKey: source.data.platform,
      configVersionId: config.id,
      configVersionNumber: config.version_number,
      adapterKey: config.adapter_key,
      sourceTypeKey: integration.manifest.sourceTypeKey,
      sourceAdapterVersion: integration.manifest.adapterVersion,
      sourceCredentialVersionId: credential.id,
      sourceCredentialVersionNumber: credential.version_number,
      expiresAt: config.expires_at === null
        ? null
        : new Date(config.expires_at.getTime()),
      connectionConfiguration: Object.freeze({ ...connection.data }),
      sourceConfiguration: Object.freeze({ ...source.data }),
    });
  }
}

/** Exact process-local authority. It never queries central or refreshes pins. */
export class StaticDataforrestSourceAuthorityResolver {
  readonly #authority: ResolvedDataforrestSourceAuthority;
  readonly #expiresAtMilliseconds: number | null;
  readonly #now: () => Date;

  constructor(input: Readonly<{
    authority: ResolvedDataforrestSourceAuthority;
    now?: () => Date;
  }>) {
    this.#authority = input.authority;
    this.#expiresAtMilliseconds = input.authority.expiresAt === null
      ? null
      : input.authority.expiresAt instanceof Date
        ? input.authority.expiresAt.getTime()
        : Number.NaN;
    this.#now = input.now ?? (() => new Date());
  }

  resolve(
    input: DataforrestSourceAuthorityRequest,
  ): Promise<ResolvedDataforrestSourceAuthority> {
    if (!validRequest(input)) {
      return Promise.reject(new DataforrestSourceAuthorityError(
        "PROVIDER_SOURCE_AUTHORITY_INPUT_INVALID",
      ));
    }
    const authority = this.#authority;
    if (
      authority.providerId !== input.providerId
      || authority.providerKey !== input.providerKey
      || authority.configVersionId !== input.configVersionId
      || authority.configVersionNumber !== input.configVersionNumber
      || authority.adapterKey !== input.adapterKey
      || authority.sourceAdapterVersion !== input.adapterKey
      || authority.sourceConfiguration.platform !== input.providerKey
    ) {
      return Promise.reject(new DataforrestSourceAuthorityError(
        "PROVIDER_SOURCE_CONFIGURATION_CONFLICT",
      ));
    }
    const observedAt = this.#now();
    if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
      return Promise.reject(new DataforrestSourceAuthorityError(
        "PROVIDER_SOURCE_AUTHORITY_INPUT_INVALID",
      ));
    }
    if (
      this.#expiresAtMilliseconds !== null
      && (!Number.isFinite(this.#expiresAtMilliseconds)
        || this.#expiresAtMilliseconds <= observedAt.getTime())
    ) {
      return Promise.reject(new DataforrestSourceAuthorityError(
        "PROVIDER_SOURCE_CONFIGURATION_EXPIRED",
      ));
    }
    return Promise.resolve(authority);
  }
}
