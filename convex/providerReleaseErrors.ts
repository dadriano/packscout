import type { ProviderReleaseErrorCode } from "@packscout/contracts";
import { ConvexError } from "convex/values";

export type { ProviderReleaseErrorCode } from "@packscout/contracts";

const SAFE_MESSAGES: Record<ProviderReleaseErrorCode, string> = {
  PROVIDER_RELEASE_AUTH_MISSING: "Provider release authentication is required.",
  PROVIDER_RELEASE_AUTH_KEY_UNKNOWN:
    "The provider release signing key is not accepted.",
  PROVIDER_RELEASE_AUTH_INVALID: "Provider release authentication failed.",
  PROVIDER_RELEASE_AUTH_STALE:
    "The provider release request timestamp is outside the accepted window.",
  PROVIDER_RELEASE_AUTH_REPLAYED:
    "The provider release request nonce has already been used.",
  PROVIDER_RELEASE_BODY_TOO_LARGE:
    "The provider release request body exceeds the supported limit.",
  PROVIDER_RELEASE_SCHEMA_UNSUPPORTED:
    "The provider release schema version is not supported.",
  PROVIDER_RELEASE_REQUEST_INVALID: "The provider release request is malformed.",
  PROVIDER_RELEASE_OPERATION_CONFLICT:
    "The provider release operation identity conflicts with stored state.",
  PROVIDER_RELEASE_STATE_CONFLICT:
    "The provider release state is not valid for this operation.",
  PROVIDER_RELEASE_PLATFORM_MISMATCH:
    "The provider release platform binding does not match.",
  PROVIDER_RELEASE_IDENTITY_MISMATCH:
    "The provider release immutable identity does not match.",
  PROVIDER_RELEASE_EPOCH_CONFLICT:
    "The provider release configuration epoch conflicts with stored state.",
  PROVIDER_RELEASE_CHECKPOINT_REGRESSED:
    "The provider release checkpoint did not advance.",
  PROVIDER_RELEASE_PREDECESSOR_CONFLICT:
    "The completed provider head does not match the expected predecessor.",
  PROVIDER_RELEASE_FINGERPRINT_BLOCKED:
    "The provider release fingerprint is blocked.",
  PROVIDER_RELEASE_BLOCK_SEQUENCE_REGRESSED:
    "The provider release block sequence did not advance.",
  PROVIDER_RELEASE_BATCH_CONFLICT:
    "The provider release batch conflicts with stored state.",
  PROVIDER_RELEASE_BATCH_OUT_OF_ORDER:
    "The provider release batch is not in canonical order.",
  PROVIDER_RELEASE_BATCH_TOO_LARGE:
    "The provider release batch exceeds the supported limit.",
  PROVIDER_RELEASE_COUNT_MISMATCH:
    "The provider release counts do not reconcile.",
  PROVIDER_RELEASE_HASH_MISMATCH:
    "The provider release hashes do not reconcile.",
  PROVIDER_RELEASE_ENTITY_INVALID:
    "The provider release contains invalid public data.",
  PROVIDER_RELEASE_REFERENCE_INVALID:
    "The provider release contains an invalid public reference.",
  PROVIDER_RELEASE_OWNERSHIP_MISMATCH:
    "The provider release contains content owned by another platform.",
  PROVIDER_RELEASE_PROTECTED_FIELD:
    "The provider release contains a protected field.",
  PROVIDER_RELEASE_RECONCILIATION_FAILED:
    "The staged provider release does not reconcile.",
  PROVIDER_RELEASE_CLEANUP_UNSAFE:
    "Provider release cleanup refused an unsafe deletion.",
  PROVIDER_RELEASE_INTERNAL_ERROR: "The provider release request failed safely.",
};

export function refuseProviderRelease(code: ProviderReleaseErrorCode): never {
  throw new ConvexError({ code, message: SAFE_MESSAGES[code] });
}

export function safeProviderReleaseMessage(
  code: ProviderReleaseErrorCode,
): string {
  return SAFE_MESSAGES[code];
}
