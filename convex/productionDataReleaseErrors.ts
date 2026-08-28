import { ConvexError } from "convex/values";
import type { ProductionDataReleaseErrorCode } from "@packscout/contracts";

export type { ProductionDataReleaseErrorCode } from "@packscout/contracts";

const SAFE_MESSAGES: Record<ProductionDataReleaseErrorCode, string> = {
  PUBLICATION_AUTH_MISSING: "Publication authentication is required.",
  PUBLICATION_AUTH_KEY_UNKNOWN: "The publication signing key is not accepted.",
  PUBLICATION_AUTH_INVALID: "Publication authentication failed.",
  PUBLICATION_AUTH_STALE: "The publication request timestamp is outside the accepted window.",
  PUBLICATION_AUTH_REPLAYED: "The publication request nonce has already been used.",
  PUBLICATION_BODY_TOO_LARGE: "The publication request body exceeds the supported limit.",
  PUBLICATION_SCHEMA_UNSUPPORTED: "The publication schema version is not supported.",
  PUBLICATION_REQUEST_INVALID: "The publication request is malformed.",
  PUBLICATION_OPERATION_CONFLICT: "The publication operation identity conflicts with stored state.",
  PUBLICATION_STATE_CONFLICT: "The publication state is not valid for this operation.",
  PUBLICATION_PREDECESSOR_CONFLICT: "The active release does not match the expected predecessor.",
  PUBLICATION_SEQUENCE_REGRESSED: "The publication observation sequence did not advance.",
  PUBLICATION_DATA_REGRESSION: "The candidate release's data is older than the active release's.",
  PUBLICATION_MANIFEST_BLOCKED: "The publication manifest is blocked.",
  PUBLICATION_MANIFEST_MISMATCH: "The publication manifest does not reconcile.",
  PUBLICATION_BATCH_CONFLICT: "The publication batch conflicts with the stored receipt.",
  PUBLICATION_BATCH_OUT_OF_ORDER: "The publication batch is not in deterministic order.",
  PUBLICATION_BATCH_TOO_LARGE: "The publication batch exceeds the supported limit.",
  PUBLICATION_ENTITY_INVALID: "The publication contains invalid public data.",
  PUBLICATION_REFERENCE_INVALID: "The publication contains an invalid public reference.",
  PUBLICATION_PROTECTED_FIELD: "The publication contains a protected field.",
  PUBLICATION_RECONCILIATION_FAILED: "The staged publication does not reconcile.",
  PUBLICATION_REFRESH_STALE: "The observation refresh did not advance monotonically.",
  PUBLICATION_ROLLBACK_UNSAFE: "The requested rollback target is not safe.",
  PUBLICATION_CLEAR_DISABLED: "Catalog clearing is not enabled for this deployment.",
  PUBLICATION_RETENTION_UNSAFE: "Retention refused to delete protected release data.",
  PUBLICATION_INTERNAL_ERROR: "The publication request failed safely.",
};

export function refuseProductionDataRelease(
  code: ProductionDataReleaseErrorCode,
): never {
  throw new ConvexError({ code, message: SAFE_MESSAGES[code] });
}

export function safeProductionDataReleaseMessage(
  code: ProductionDataReleaseErrorCode,
): string {
  return SAFE_MESSAGES[code];
}
