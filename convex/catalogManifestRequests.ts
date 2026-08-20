import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  MAX_CATALOG_MANIFEST_PUBLICATION_BODY_BYTES,
  PRODUCTION_AUTH_SHA256_PATTERN,
  canonicalJson,
  containsProtectedCatalogManifestPublicationField,
} from "@packscout/contracts";
import type { z } from "zod";
import { refuseCatalogManifest } from "./catalogManifestErrors";
import {
  catalogManifestKeyHasRole,
  type CatalogManifestKeyRole,
} from "./productionPublicationKeyConfig";

export function assertCatalogManifestRequestDigest(requestDigest: string): void {
  if (!PRODUCTION_AUTH_SHA256_PATTERN.test(requestDigest)) {
    refuseCatalogManifest("CATALOG_MANIFEST_REQUEST_INVALID");
  }
}

export function assertCatalogManifestRole(
  authenticatedKeyId: string,
  role: CatalogManifestKeyRole,
): void {
  if (!catalogManifestKeyHasRole(authenticatedKeyId, role)) {
    refuseCatalogManifest("CATALOG_MANIFEST_AUTH_FORBIDDEN");
  }
}

export function parseCatalogManifestRequest<T>(
  bodyJson: string,
  schema: z.ZodType<T>,
): T {
  if (
    new TextEncoder().encode(bodyJson).byteLength >
      MAX_CATALOG_MANIFEST_PUBLICATION_BODY_BYTES
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_BODY_TOO_LARGE");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bodyJson) as unknown;
  } catch {
    return refuseCatalogManifest("CATALOG_MANIFEST_REQUEST_INVALID");
  }
  if (
    typeof raw !== "object" || raw === null ||
    (raw as { schemaVersion?: unknown }).schemaVersion !==
      CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_SCHEMA_UNSUPPORTED");
  }
  if (containsProtectedCatalogManifestPublicationField(raw)) {
    refuseCatalogManifest("CATALOG_MANIFEST_PROTECTED_FIELD");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success || bodyJson !== canonicalJson(parsed.data)) {
    refuseCatalogManifest("CATALOG_MANIFEST_REQUEST_INVALID");
  }
  return parsed.data;
}
