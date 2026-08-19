import {
  MAX_PRODUCTION_AUTH_SECRET_BYTES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES,
  PRODUCTION_AUTH_KEY_ID_PATTERN,
  canonicalJson,
  decodeProductionAuthSecretBase64,
  providerCatalogPlatformKeyV1Schema,
} from "@packscout/contracts";
import { env } from "./_generated/server";

export const CATALOG_MANIFEST_KEY_ROLES = [
  "clear",
  "publish",
  "retain",
  "rollback",
] as const;

export type CatalogManifestKeyRole =
  (typeof CATALOG_MANIFEST_KEY_ROLES)[number];

const MAX_CATALOG_MANIFEST_KEYS = 16;
const MAX_HEAT_PUBLICATION_KEYS = 4;
const MAX_PROVIDER_PUBLICATION_KEYS = 16;
const MAX_PRODUCTION_PUBLICATION_KEYS = 64;
const catalogManifestKeyRoleSet = new Set<string>(
  CATALOG_MANIFEST_KEY_ROLES,
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

export function configuredPublicationKeySecret(
  keyId: string,
): Uint8Array | null {
  if (!PRODUCTION_AUTH_KEY_ID_PATTERN.test(keyId)) return null;
  return configuredPublicationKeys()?.get(keyId) ?? null;
}

function configuredPublicationKeys(): ReadonlyMap<string, Uint8Array> | null {
  const raw = env.PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS;
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainRecord(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.length === 0 || entries.length > MAX_PRODUCTION_PUBLICATION_KEYS) {
      return null;
    }
    const resolved = new Map<string, Uint8Array>();
    for (const [configuredKeyId, encoded] of entries) {
      if (
        !PRODUCTION_AUTH_KEY_ID_PATTERN.test(configuredKeyId) ||
        typeof encoded !== "string"
      ) {
        return null;
      }
      const secret = decodeProductionAuthSecretBase64(encoded);
      if (
        secret === null ||
        secret.byteLength < MIN_PRODUCTION_AUTH_SECRET_BYTES ||
        secret.byteLength > MAX_PRODUCTION_AUTH_SECRET_BYTES
      ) {
        return null;
      }
      resolved.set(configuredKeyId, secret);
    }
    return resolved;
  } catch {
    return null;
  }
}

function configuredCatalogManifestRoleMap():
  Readonly<Record<string, readonly CatalogManifestKeyRole[]>> | null {
  const raw = env.PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES;
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainRecord(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.length === 0 || entries.length > MAX_CATALOG_MANIFEST_KEYS) {
      return null;
    }
    const keyIds = entries.map(([keyId]) => keyId);
    if (
      keyIds.some((keyId) => !PRODUCTION_AUTH_KEY_ID_PATTERN.test(keyId)) ||
      keyIds.some((keyId, index) => index > 0 && keyIds[index - 1]! >= keyId)
    ) {
      return null;
    }
    for (const [keyId, roles] of entries) {
      if (
        configuredPublicationKeySecret(keyId) === null ||
        !Array.isArray(roles) ||
        roles.length === 0 ||
        roles.length > CATALOG_MANIFEST_KEY_ROLES.length ||
        roles.some((role) =>
          typeof role !== "string" || !catalogManifestKeyRoleSet.has(role)
        ) ||
        roles.some((role, index) =>
          index > 0 && String(roles[index - 1]) >= String(role)
        ) ||
        (roles.includes("retain") && roles.length !== 1)
      ) {
        return null;
      }
    }
    if (raw !== canonicalJson(parsed)) return null;
    return parsed as Record<string, readonly CatalogManifestKeyRole[]>;
  } catch {
    return null;
  }
}

function configuredProviderPublicationKeyIds(): ReadonlySet<string> | null {
  const raw = env.PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS;
  if (raw === undefined) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainRecord(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.length > MAX_PROVIDER_PUBLICATION_KEYS) return null;
    if (entries.some(([keyId, platformKey]) =>
      !PRODUCTION_AUTH_KEY_ID_PATTERN.test(keyId) ||
      !providerCatalogPlatformKeyV1Schema.safeParse(platformKey).success ||
      configuredPublicationKeySecret(keyId) === null
    )) {
      return null;
    }
    return new Set(entries.map(([keyId]) => keyId));
  } catch {
    return null;
  }
}

function configuredHeatPublicationKeyIds(): ReadonlySet<string> | null {
  const raw = env.PACKSCOUT_HEAT_PUBLICATION_KEY_IDS;
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.length > MAX_HEAT_PUBLICATION_KEYS ||
      parsed.some((keyId) =>
        typeof keyId !== "string" ||
        !PRODUCTION_AUTH_KEY_ID_PATTERN.test(keyId) ||
        configuredPublicationKeySecret(keyId) === null
      ) ||
      parsed.some((keyId, index) =>
        index > 0 && String(parsed[index - 1]) >= String(keyId)
      ) ||
      raw !== canonicalJson(parsed)
    ) {
      return null;
    }
    return new Set(parsed as string[]);
  } catch {
    return null;
  }
}

function equalSecret(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

/**
 * Key IDs are routing metadata, not part of the signed request value. Every
 * independently authorized key ID must therefore own distinct secret bytes or
 * one role could authenticate while claiming another role's ID.
 */
export function publicationAuthorityConfigurationIsIsolated(): boolean {
  const publicationKeys = configuredPublicationKeys();
  const heatKeyIds = env.PACKSCOUT_HEAT_PUBLICATION_KEY_IDS === undefined
    ? new Set<string>()
    : configuredHeatPublicationKeyIds();
  const providerKeyIds = configuredProviderPublicationKeyIds();
  const manifestRoleMap = env.PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES === undefined
    ? {}
    : configuredCatalogManifestRoleMap();
  if (
    publicationKeys === null ||
    heatKeyIds === null ||
    providerKeyIds === null ||
    manifestRoleMap === null
  ) {
    return false;
  }
  const authorities = [
    ...[...heatKeyIds].map((keyId) => ({ keyId, surface: "heat" })),
    ...[...providerKeyIds].map((keyId) => ({ keyId, surface: "provider" })),
    ...Object.keys(manifestRoleMap).map((keyId) => ({
      keyId,
      surface: "manifest",
    })),
  ];
  if (new Set(authorities.map(({ keyId }) => keyId)).size !== authorities.length) {
    return false;
  }
  if (authorities.some(({ keyId }) => !publicationKeys.has(keyId))) return false;
  const configuredSecrets = [...publicationKeys.values()];
  return configuredSecrets.every((secret, index) =>
    configuredSecrets.slice(0, index).every((prior) =>
      !equalSecret(prior, secret)
    )
  );
}

export function catalogManifestKeyHasRole(
  keyId: string,
  requiredRole: CatalogManifestKeyRole,
): boolean {
  const roleMap = configuredCatalogManifestRoleMap();
  return roleMap !== null &&
    Object.prototype.hasOwnProperty.call(roleMap, keyId) &&
    roleMap[keyId]!.includes(requiredRole);
}

export function catalogRetentionKeyIsAuthorized(keyId: string): boolean {
  if (!PRODUCTION_AUTH_KEY_ID_PATTERN.test(keyId)) return false;
  return publicationAuthorityConfigurationIsIsolated() &&
    catalogManifestKeyHasRole(keyId, "retain");
}

export function heatPublicationKeyIsAuthorized(keyId: string): boolean {
  if (!PRODUCTION_AUTH_KEY_ID_PATTERN.test(keyId)) return false;
  return publicationAuthorityConfigurationIsIsolated() &&
    configuredHeatPublicationKeyIds()?.has(keyId) === true;
}
