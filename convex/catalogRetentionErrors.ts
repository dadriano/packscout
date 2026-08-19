import type { CatalogRetentionErrorCode } from "@packscout/contracts";
import { ConvexError } from "convex/values";

export type { CatalogRetentionErrorCode } from "@packscout/contracts";

const SAFE_MESSAGES: Record<CatalogRetentionErrorCode, string> = {
  CATALOG_RETENTION_AUTH_MISSING: "Catalog retention authentication is required.",
  CATALOG_RETENTION_AUTH_KEY_UNKNOWN:
    "The catalog retention signing key is not accepted.",
  CATALOG_RETENTION_AUTH_INVALID: "Catalog retention authentication failed.",
  CATALOG_RETENTION_AUTH_STALE:
    "The catalog retention request timestamp is outside the accepted window.",
  CATALOG_RETENTION_AUTH_REPLAYED:
    "The catalog retention request nonce has already been used.",
  CATALOG_RETENTION_AUTH_FORBIDDEN:
    "The catalog retention signing key is not authorized for this operation.",
  CATALOG_RETENTION_BODY_TOO_LARGE:
    "The catalog retention request body exceeds the supported limit.",
  CATALOG_RETENTION_SCHEMA_UNSUPPORTED:
    "The catalog retention schema version is not supported.",
  CATALOG_RETENTION_REQUEST_INVALID:
    "The catalog retention request is malformed.",
  CATALOG_RETENTION_PROTECTED_FIELD:
    "The catalog retention request contains a protected field.",
  CATALOG_RETENTION_OPERATION_CONFLICT:
    "The catalog retention operation identity conflicts with stored state.",
  CATALOG_RETENTION_STATE_CONFLICT:
    "The catalog retention state is not valid for this operation.",
  CATALOG_RETENTION_PREDECESSOR_CONFLICT:
    "The catalog retention generation or publication head changed.",
  CATALOG_RETENTION_PROOF_INCOMPLETE:
    "The catalog retention proof snapshot is missing or inconsistent.",
  CATALOG_RETENTION_REFERENCE_INVALID:
    "The catalog retention reference graph is incomplete or inconsistent.",
  CATALOG_RETENTION_RETENTION_UNSAFE:
    "Catalog retention refused an unsafe deletion.",
  CATALOG_RETENTION_INTERNAL_ERROR:
    "The catalog retention request failed safely.",
};

export function refuseCatalogRetention(code: CatalogRetentionErrorCode): never {
  throw new ConvexError({ code, message: SAFE_MESSAGES[code] });
}

export function safeCatalogRetentionMessage(
  code: CatalogRetentionErrorCode,
): string {
  return SAFE_MESSAGES[code];
}
