import {
  MAX_PRODUCTION_AUTH_SECRET_BYTES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES,
  PRODUCTION_AUTH_KEY_ID_PATTERN,
  canonicalJson,
  decodeProductionAuthSecretBase64,
} from "@packscout/contracts";
import { env } from "./_generated/server";

export const CATALOG_MANIFEST_KEY_ROLES = [
  "clear",
  "publish",
  "rollback",
] as const;

export type CatalogManifestKeyRole =
  (typeof CATALOG_MANIFEST_KEY_ROLES)[number];

const MAX_CATALOG_MANIFEST_KEYS = 16;
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
  const raw = env.PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS;
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainRecord(parsed)) return null;
    if (!Object.prototype.hasOwnProperty.call(parsed, keyId)) return null;
    const encoded = parsed[keyId];
    if (typeof encoded !== "string") return null;
    const secret = decodeProductionAuthSecretBase64(encoded);
    return secret !== null &&
        secret.byteLength >= MIN_PRODUCTION_AUTH_SECRET_BYTES &&
        secret.byteLength <= MAX_PRODUCTION_AUTH_SECRET_BYTES
      ? secret
      : null;
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
        )
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

export function catalogManifestKeyHasRole(
  keyId: string,
  requiredRole: CatalogManifestKeyRole,
): boolean {
  const roleMap = configuredCatalogManifestRoleMap();
  return roleMap !== null &&
    Object.prototype.hasOwnProperty.call(roleMap, keyId) &&
    roleMap[keyId]!.includes(requiredRole);
}
