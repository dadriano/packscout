import type { CatalogManifestErrorCode } from "@packscout/contracts";
import { ConvexError } from "convex/values";

export type { CatalogManifestErrorCode } from "@packscout/contracts";

const SAFE_MESSAGES: Record<CatalogManifestErrorCode, string> = {
  CATALOG_MANIFEST_AUTH_MISSING: "Catalog manifest authentication is required.",
  CATALOG_MANIFEST_AUTH_KEY_UNKNOWN:
    "The catalog manifest signing key is not accepted.",
  CATALOG_MANIFEST_AUTH_INVALID: "Catalog manifest authentication failed.",
  CATALOG_MANIFEST_AUTH_STALE:
    "The catalog manifest request timestamp is outside the accepted window.",
  CATALOG_MANIFEST_AUTH_REPLAYED:
    "The catalog manifest request nonce has already been used.",
  CATALOG_MANIFEST_AUTH_FORBIDDEN:
    "The catalog manifest signing key is not authorized for this operation.",
  CATALOG_MANIFEST_BODY_TOO_LARGE:
    "The catalog manifest request body exceeds the supported limit.",
  CATALOG_MANIFEST_SCHEMA_UNSUPPORTED:
    "The catalog manifest schema version is not supported.",
  CATALOG_MANIFEST_REQUEST_INVALID: "The catalog manifest request is malformed.",
  CATALOG_MANIFEST_PROTECTED_FIELD:
    "The catalog manifest request contains a protected field.",
  CATALOG_MANIFEST_OPERATION_CONFLICT:
    "The catalog manifest operation identity conflicts with stored state.",
  CATALOG_MANIFEST_STATE_CONFLICT:
    "The catalog manifest state is not valid for this operation.",
  CATALOG_MANIFEST_PREDECESSOR_CONFLICT:
    "The active catalog manifest does not match the expected predecessor.",
  CATALOG_MANIFEST_IDENTITY_MISMATCH:
    "The catalog manifest immutable identity does not match.",
  CATALOG_MANIFEST_FINGERPRINT_BLOCKED:
    "The catalog manifest fingerprint is blocked.",
  CATALOG_MANIFEST_MANIFEST_BLOCKED:
    "The selected catalog manifest is blocked.",
  CATALOG_MANIFEST_BLOCK_SEQUENCE_REGRESSED:
    "The catalog manifest block sequence did not advance.",
  CATALOG_MANIFEST_PLATFORM_SET_MISMATCH:
    "The catalog manifest platform set does not reconcile.",
  CATALOG_MANIFEST_PLATFORM_DISABLED:
    "The catalog manifest references a disabled platform.",
  CATALOG_MANIFEST_PROVIDER_RELEASE_MISSING:
    "A referenced provider release does not exist.",
  CATALOG_MANIFEST_PROVIDER_RELEASE_INCOMPLETE:
    "A referenced provider release is not complete.",
  CATALOG_MANIFEST_PROVIDER_RELEASE_BLOCKED:
    "A referenced provider release is blocked.",
  CATALOG_MANIFEST_PROVIDER_RELEASE_INVALID:
    "A referenced provider release proof is invalid.",
  CATALOG_MANIFEST_PROVIDER_REFERENCE_MISMATCH:
    "A referenced provider release proof does not match stored state.",
  CATALOG_MANIFEST_CONFIGURATION_EPOCH_CONFLICT:
    "Referenced provider releases do not share the manifest configuration epoch.",
  CATALOG_MANIFEST_EPOCH_CONFLICT:
    "The catalog manifest configuration epoch conflicts with selected state.",
  CATALOG_MANIFEST_BACKFILL_INCOMPLETE:
    "A referenced provider has not completed its initial backfill.",
  CATALOG_MANIFEST_DERIVATION_UNSETTLED:
    "A referenced provider has unsettled affected derivations.",
  CATALOG_MANIFEST_ELIGIBILITY_INCOMPLETE:
    "The catalog manifest eligibility snapshot is incomplete.",
  CATALOG_MANIFEST_REFERENCE_SET_UNCHANGED:
    "The provider reference set is unchanged and requires an observation refresh.",
  CATALOG_MANIFEST_AGGREGATE_LIMIT_EXCEEDED:
    "The catalog manifest exceeds a supported aggregate limit.",
  CATALOG_MANIFEST_COUNT_MISMATCH:
    "The catalog manifest counts do not reconcile.",
  CATALOG_MANIFEST_HASH_MISMATCH:
    "The catalog manifest hashes do not reconcile.",
  CATALOG_MANIFEST_CONTENT_INVALID:
    "The catalog manifest content proof is invalid.",
  CATALOG_MANIFEST_SEARCH_INVALID:
    "The catalog manifest search proof is invalid.",
  CATALOG_MANIFEST_REFERENCE_INVALID:
    "The catalog manifest contains an invalid public reference.",
  CATALOG_MANIFEST_OWNERSHIP_MISMATCH:
    "The catalog manifest ownership proof does not reconcile.",
  CATALOG_MANIFEST_OBSERVATION_STALE:
    "The catalog manifest observation is stale.",
  CATALOG_MANIFEST_REFRESH_STALE:
    "The catalog manifest observation refresh is stale.",
  CATALOG_MANIFEST_FRESHNESS_INVALID:
    "The catalog manifest freshness facts do not reconcile.",
  CATALOG_MANIFEST_ROLLBACK_UNSAFE:
    "The requested catalog manifest rollback is unsafe.",
  CATALOG_MANIFEST_CLEAR_UNAUTHORIZED:
    "Clearing the active catalog manifest is not authorized.",
  CATALOG_MANIFEST_RECONCILIATION_FAILED:
    "The catalog manifest proof does not reconcile.",
  CATALOG_MANIFEST_INTERNAL_ERROR:
    "The catalog manifest request failed safely.",
};

export function refuseCatalogManifest(code: CatalogManifestErrorCode): never {
  throw new ConvexError({ code, message: SAFE_MESSAGES[code] });
}

export function safeCatalogManifestMessage(
  code: CatalogManifestErrorCode,
): string {
  return SAFE_MESSAGES[code];
}
