import type { PackCatalogErrorCode } from "@packscout/contracts";
import { ConvexError } from "convex/values";

export type { PackCatalogErrorCode } from "@packscout/contracts";

/**
 * Transport-level refusals for the `pack_catalog_v1` store. Domain outcomes
 * (stale sequence, held head, missing profile head, digest mismatch) are not
 * errors: they return signed receipts with `refused` or `conflict` results.
 * Only authentication, authorization, malformed bytes, and internal faults
 * surface here, so a caller never learns catalog state from an error path.
 */
const SAFE_MESSAGES: Record<PackCatalogErrorCode, string> = {
  PACK_CATALOG_AUTH_MISSING: "Pack catalog authentication is required.",
  PACK_CATALOG_AUTH_KEY_UNKNOWN: "The pack catalog signing key is not accepted.",
  PACK_CATALOG_AUTH_INVALID: "Pack catalog authentication failed.",
  PACK_CATALOG_AUTH_STALE:
    "The pack catalog request timestamp is outside the accepted window.",
  PACK_CATALOG_AUTH_REPLAYED:
    "The pack catalog request nonce has already been used.",
  PACK_CATALOG_AUTH_FORBIDDEN:
    "The pack catalog signing key is not authorized for this operation.",
  PACK_CATALOG_BODY_TOO_LARGE:
    "The pack catalog request body exceeds the supported limit.",
  PACK_CATALOG_SCHEMA_UNSUPPORTED:
    "The pack catalog schema version is not supported.",
  PACK_CATALOG_REQUEST_INVALID: "The pack catalog request is malformed.",
  PACK_CATALOG_PROTECTED_FIELD:
    "The pack catalog request contains a protected field.",
  PACK_CATALOG_OPERATION_CONFLICT:
    "The pack catalog operation identity conflicts with stored state.",
  PACK_CATALOG_STATE_CONFLICT:
    "The pack catalog state is not valid for this operation.",
  PACK_CATALOG_INTERNAL_ERROR: "The pack catalog request failed safely.",
};

export function refusePackCatalog(code: PackCatalogErrorCode): never {
  throw new ConvexError({ code, message: SAFE_MESSAGES[code] });
}

export function safePackCatalogMessage(code: PackCatalogErrorCode): string {
  return SAFE_MESSAGES[code];
}
