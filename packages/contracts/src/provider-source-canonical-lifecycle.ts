import type {
  LaunchRecordIdScopeKey,
  ProviderCanonicalKind,
} from "./provider-source-contract-v1.ts";

export interface ProviderSourceCanonicalRevisionState {
  readonly contentFingerprint: string;
  readonly effectiveAt: string;
}
export interface ProviderSourceCanonicalBinding {
  readonly recordIdScopeKey: LaunchRecordIdScopeKey;
  readonly canonicalKind: ProviderCanonicalKind;
}

export type ProviderSourceCanonicalLifecycleDecision =
  | Readonly<{
      disposition: "inserted" | "revised";
      becomesCurrent: boolean;
    }>
  | Readonly<{
      disposition: "duplicate";
      becomesCurrent: false;
    }>
  | Readonly<{
      disposition: "quarantined";
      reasonCode: "identity_kind_conflict" | "immutable_content_conflict";
      becomesCurrent: false;
    }>;

function revisionIsLater(
  left: ProviderSourceCanonicalRevisionState,
  right: ProviderSourceCanonicalRevisionState,
): boolean {
  const leftTime = Date.parse(left.effectiveAt);
  const rightTime = Date.parse(right.effectiveAt);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    throw new RangeError("provider_source_canonical.invalid_effective_time");
  }
  return leftTime === rightTime
    ? left.contentFingerprint > right.contentFingerprint
    : leftTime > rightTime;
}

/** Shared catalog-history and immutable-event lifecycle authority. */
export function decideProviderSourceCanonicalLifecycle(input: Readonly<{
  recordIdScopeKey: LaunchRecordIdScopeKey;
  canonicalKind: ProviderCanonicalKind;
  contentFingerprint: string;
  effectiveAt: string;
  existingBinding: ProviderSourceCanonicalBinding | null;
  revisions: readonly ProviderSourceCanonicalRevisionState[];
}>): ProviderSourceCanonicalLifecycleDecision {
  if (
    input.existingBinding !== null &&
    (input.existingBinding.recordIdScopeKey !== input.recordIdScopeKey ||
      input.existingBinding.canonicalKind !== input.canonicalKind)
  ) {
    return {
      disposition: "quarantined",
      reasonCode: "identity_kind_conflict",
      becomesCurrent: false,
    };
  }
  if (
    input.revisions.some(
      (revision) =>
        revision.contentFingerprint === input.contentFingerprint &&
        revision.effectiveAt === input.effectiveAt,
    )
  ) {
    return { disposition: "duplicate", becomesCurrent: false };
  }
  const current = input.revisions.reduce<ProviderSourceCanonicalRevisionState | null>(
    (winner, revision) =>
      winner === null || revisionIsLater(revision, winner)
        ? revision
        : winner,
    null,
  );
  if (current?.contentFingerprint === input.contentFingerprint) {
    return { disposition: "duplicate", becomesCurrent: false };
  }
  if (
    input.revisions.length > 0 &&
    (input.canonicalKind === "pull" || input.canonicalKind === "market_event")
  ) {
    return {
      disposition: "quarantined",
      reasonCode: "immutable_content_conflict",
      becomesCurrent: false,
    };
  }
  const candidate = {
    contentFingerprint: input.contentFingerprint,
    effectiveAt: input.effectiveAt,
  };
  return {
    disposition: input.revisions.length === 0 ? "inserted" : "revised",
    becomesCurrent:
      current === null || revisionIsLater(candidate, current),
  };
}
