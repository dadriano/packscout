import {
  CATALOG_RETENTION_SCHEMA_VERSION,
  MAX_CATALOG_RETENTION_HTTP_BODY_BYTES,
  PRODUCTION_AUTH_SHA256_PATTERN,
  canonicalJson,
  catalogRetentionPostgresProofSnapshotDigest,
  containsProtectedCatalogRetentionField,
  type CatalogRetentionPostgresProofSnapshot,
} from "@packscout/contracts";
import type { z } from "zod";
import { refuseCatalogRetention } from "./catalogRetentionErrors";
import { catalogManifestKeyHasRole } from "./productionPublicationKeyConfig";

export function assertCatalogRetentionRequestDigest(
  requestDigest: string,
): void {
  if (!PRODUCTION_AUTH_SHA256_PATTERN.test(requestDigest)) {
    refuseCatalogRetention("CATALOG_RETENTION_REQUEST_INVALID");
  }
}

export function assertCatalogRetentionRole(
  authenticatedKeyId: string,
): void {
  if (!catalogManifestKeyHasRole(authenticatedKeyId, "retain")) {
    refuseCatalogRetention("CATALOG_RETENTION_AUTH_FORBIDDEN");
  }
}

export function parseCatalogRetentionRequest<T>(
  bodyJson: string,
  schema: z.ZodType<T>,
): T {
  if (
    new TextEncoder().encode(bodyJson).byteLength >
      MAX_CATALOG_RETENTION_HTTP_BODY_BYTES
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_BODY_TOO_LARGE");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bodyJson) as unknown;
  } catch {
    return refuseCatalogRetention("CATALOG_RETENTION_REQUEST_INVALID");
  }
  if (
    typeof raw !== "object" || raw === null ||
    (raw as { schemaVersion?: unknown }).schemaVersion !==
      CATALOG_RETENTION_SCHEMA_VERSION
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_SCHEMA_UNSUPPORTED");
  }
  if (containsProtectedCatalogRetentionField(raw)) {
    refuseCatalogRetention("CATALOG_RETENTION_PROTECTED_FIELD");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success || bodyJson !== canonicalJson(parsed.data)) {
    refuseCatalogRetention("CATALOG_RETENTION_REQUEST_INVALID");
  }
  return parsed.data;
}

export async function assertCatalogRetentionPostgresProofDigest(
  proof: CatalogRetentionPostgresProofSnapshot,
): Promise<void> {
  if (
    proof.snapshotDigest !==
      await catalogRetentionPostgresProofSnapshotDigest(proof)
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
}
