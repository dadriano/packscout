import {
  canonicalRecordKinds,
  outOfComparisonScopeKinds,
  publishedCounterpartFor,
  type CanonicalKindSummary,
  type CanonicalRecordKind,
} from "@packscout/contracts";

/**
 * Whether what the product serves matches what the pipeline landed.
 *
 * This is the cheap path, and it exists because a record-by-record walk over
 * roughly 14.5 million records is far too expensive to answer "is this provider
 * off?" every time an operator opens a page.
 *
 * Both stores carry the same `providerReleaseFingerprint` for a provider's
 * published state. When those agree the payload is identical by construction and
 * no walk is needed; the only remaining question is whether canonical has moved
 * on since. When they disagree, something is genuinely wrong and the expensive
 * identity walk is worth running.
 *
 * Nothing here reads an individual record on either side.
 */

export const parityVerdicts = [
  "in_sync",
  "behind",
  "drifted",
  "unpublished",
  "unknown",
] as const;

export type ParityVerdict = (typeof parityVerdicts)[number];

export const parityReasonCodes = [
  "FINGERPRINTS_MATCH_AND_CAUGHT_UP",
  "CANONICAL_SETTLED_BEYOND_PUBLISHED",
  "FINGERPRINT_MISMATCH",
  "COUNTS_DISAGREE",
  "MANIFEST_SERVES_UNRECOGNIZED_RELEASE",
  "MANIFEST_SERVES_MISSING_RELEASE",
  "RELEASE_LIFECYCLE_NOT_COMPLETE",
  "NO_ACTIVE_MANIFEST",
  "PLATFORM_NOT_REFERENCED",
  "PUBLISHED_SIDE_UNREADABLE",
  "CANONICAL_SIDE_UNREADABLE",
] as const;

export type ParityReasonCode = (typeof parityReasonCodes)[number];

/** The published side as the parity read sees it. */
export type PublishedParityInput =
  | { readonly kind: "unreadable"; readonly detail: string }
  | { readonly kind: "no_active_manifest" }
  | { readonly kind: "platform_not_referenced" }
  | { readonly kind: "release_missing"; readonly publicProviderReleaseId: string }
  | {
      readonly kind: "active";
      readonly publicProviderReleaseId: string;
      readonly lifecycle: "staging" | "complete" | "failed" | "retired";
      readonly providerReleaseFingerprint: string;
      readonly dataAsOf: string;
      readonly counts: Readonly<Record<string, number>>;
    };

/** The canonical side as the parity read sees it. */
export type CanonicalParityInput =
  | { readonly kind: "unreadable"; readonly detail: string }
  | {
      readonly kind: "read";
      readonly kinds: readonly CanonicalKindSummary[];
      readonly settledCheckpoint: string;
      readonly sourceHeadCheckpoint: string;
      readonly completedCheckpoint: string;
      readonly completedProviderReleaseFingerprint: string | null;
      readonly selectedProviderReleaseFingerprint: string | null;
      readonly selectedPublicProviderReleaseId: string | null;
    };

export interface ComparableKindFigures {
  readonly canonicalKind: CanonicalRecordKind;
  readonly publishedKind: string;
  readonly canonicalCount: number;
  readonly canonicalPrecision: "exact" | "at_least";
  readonly publishedCount: number | null;
  /**
   * True only when the two numbers can be compared at all. A canonical count
   * that stopped at its bound is a floor, so it disagrees with a published
   * total only when the floor already exceeds it.
   */
  readonly comparable: boolean;
  readonly disagrees: boolean;
}

export interface ProviderParity {
  readonly platformKey: string;
  readonly verdict: ParityVerdict;
  readonly reasonCode: ParityReasonCode;
  readonly explanation: string;
  readonly canonical: {
    readonly settledCheckpoint: string | null;
    readonly sourceHeadCheckpoint: string | null;
    readonly completedCheckpoint: string | null;
    readonly completedFingerprint: string | null;
    readonly newestAcceptedAt: string | null;
  };
  readonly published: {
    readonly publicProviderReleaseId: string | null;
    readonly lifecycle: string | null;
    readonly fingerprint: string | null;
    readonly dataAsOf: string | null;
  };
  readonly figures: readonly ComparableKindFigures[];
  readonly outOfScope: readonly {
    readonly canonicalKind: CanonicalRecordKind;
    readonly reason: string;
  }[];
}

/** Canonical kinds with no published counterpart, and why. Returned with every verdict. */
export function outOfScopeKinds(): readonly {
  canonicalKind: CanonicalRecordKind;
  reason: string;
}[] {
  return canonicalRecordKinds
    .filter((kind) => publishedCounterpartFor(kind) === null)
    .map((canonicalKind) => ({
      canonicalKind,
      reason: outOfComparisonScopeKinds[canonicalKind] ?? "No published counterpart.",
    }));
}

/** Compares 64-bit checkpoint sequences carried as decimal strings. */
function checkpointAhead(candidate: string, reference: string): boolean {
  try {
    return BigInt(candidate) > BigInt(reference);
  } catch {
    return false;
  }
}

function newestAccepted(kinds: readonly CanonicalKindSummary[]): string | null {
  let newest: string | null = null;
  for (const kind of kinds) {
    if (kind.newestAcceptedAt === null) continue;
    if (newest === null || kind.newestAcceptedAt > newest) {
      newest = kind.newestAcceptedAt;
    }
  }
  return newest;
}

function buildFigures(
  kinds: readonly CanonicalKindSummary[],
  publishedCounts: Readonly<Record<string, number>> | null,
): readonly ComparableKindFigures[] {
  const figures: ComparableKindFigures[] = [];
  for (const summary of kinds) {
    const publishedKind = publishedCounterpartFor(summary.recordKind);
    if (publishedKind === null) continue;
    const publishedCount = publishedCounts?.[publishedKind] ?? null;
    // A floor can only prove disagreement in one direction: if the pipeline has
    // at least N and the product serves fewer than N, records are missing. A
    // floor below the published total proves nothing either way.
    const comparable =
      publishedCount !== null && summary.precision === "exact";
    const disagrees =
      publishedCount !== null &&
      (summary.precision === "exact"
        ? summary.count !== publishedCount
        : summary.count > publishedCount);
    figures.push({
      canonicalKind: summary.recordKind,
      publishedKind,
      canonicalCount: summary.count,
      canonicalPrecision: summary.precision,
      publishedCount,
      comparable,
      disagrees,
    });
  }
  return figures;
}

/**
 * Reaches one provider's verdict from cheap facts only.
 *
 * An unread side is always `unknown` and never zero: reporting "0 published"
 * for a backend that did not answer would read as catastrophic data loss.
 */
export function judgeProviderParity(input: {
  readonly platformKey: string;
  readonly canonical: CanonicalParityInput;
  readonly published: PublishedParityInput;
}): ProviderParity {
  const outOfScope = outOfScopeKinds();

  if (input.canonical.kind === "unreadable") {
    return {
      platformKey: input.platformKey,
      verdict: "unknown",
      reasonCode: "CANONICAL_SIDE_UNREADABLE",
      explanation: `The canonical side could not be read: ${input.canonical.detail}`,
      canonical: {
        settledCheckpoint: null,
        sourceHeadCheckpoint: null,
        completedCheckpoint: null,
        completedFingerprint: null,
        newestAcceptedAt: null,
      },
      published: {
        publicProviderReleaseId: null,
        lifecycle: null,
        fingerprint: null,
        dataAsOf: null,
      },
      figures: [],
      outOfScope,
    };
  }

  const canonical = {
    settledCheckpoint: input.canonical.settledCheckpoint,
    sourceHeadCheckpoint: input.canonical.sourceHeadCheckpoint,
    completedCheckpoint: input.canonical.completedCheckpoint,
    completedFingerprint: input.canonical.completedProviderReleaseFingerprint,
    newestAcceptedAt: newestAccepted(input.canonical.kinds),
  };

  const settle = (
    verdict: ParityVerdict,
    reasonCode: ParityReasonCode,
    explanation: string,
    published: ProviderParity["published"],
    figures: readonly ComparableKindFigures[],
  ): ProviderParity => ({
    platformKey: input.platformKey,
    verdict,
    reasonCode,
    explanation,
    canonical,
    published,
    figures,
    outOfScope,
  });

  const noPublished = {
    publicProviderReleaseId: null,
    lifecycle: null,
    fingerprint: null,
    dataAsOf: null,
  };

  if (input.published.kind === "unreadable") {
    return settle(
      "unknown",
      "PUBLISHED_SIDE_UNREADABLE",
      `The published side could not be read: ${input.published.detail}`,
      noPublished,
      buildFigures(input.canonical.kinds, null),
    );
  }

  if (input.published.kind === "no_active_manifest") {
    return settle(
      "unpublished",
      "NO_ACTIVE_MANIFEST",
      "The product is serving no catalog manifest at all, so nothing is published for any provider.",
      noPublished,
      buildFigures(input.canonical.kinds, null),
    );
  }

  if (input.published.kind === "platform_not_referenced") {
    return settle(
      "unpublished",
      "PLATFORM_NOT_REFERENCED",
      "The active manifest does not reference this provider, so the product serves nothing for it.",
      noPublished,
      buildFigures(input.canonical.kinds, null),
    );
  }

  if (input.published.kind === "release_missing") {
    return settle(
      "drifted",
      "MANIFEST_SERVES_MISSING_RELEASE",
      "The active manifest names a release the product backend no longer holds.",
      {
        publicProviderReleaseId: input.published.publicProviderReleaseId,
        lifecycle: null,
        fingerprint: null,
        dataAsOf: null,
      },
      buildFigures(input.canonical.kinds, null),
    );
  }

  const active = input.published;
  const published = {
    publicProviderReleaseId: active.publicProviderReleaseId,
    lifecycle: active.lifecycle,
    fingerprint: active.providerReleaseFingerprint,
    dataAsOf: active.dataAsOf,
  };
  const figures = buildFigures(input.canonical.kinds, active.counts);

  if (active.lifecycle !== "complete") {
    return settle(
      "drifted",
      "RELEASE_LIFECYCLE_NOT_COMPLETE",
      `The active manifest serves a release whose lifecycle is ${active.lifecycle}, not complete.`,
      published,
      figures,
    );
  }

  const completedFingerprint =
    input.canonical.completedProviderReleaseFingerprint;
  if (completedFingerprint === null) {
    return settle(
      "drifted",
      "MANIFEST_SERVES_UNRECOGNIZED_RELEASE",
      "The product serves a release this workspace has no completed promotion record for.",
      published,
      figures,
    );
  }

  if (completedFingerprint !== active.providerReleaseFingerprint) {
    return settle(
      "drifted",
      "FINGERPRINT_MISMATCH",
      "The release the product serves was not published by the last completed promotion.",
      published,
      figures,
    );
  }

  const countDisagreement = figures.find((figure) => figure.disagrees);
  if (countDisagreement) {
    return settle(
      "drifted",
      "COUNTS_DISAGREE",
      `The pipeline and the product disagree on how many ${countDisagreement.publishedKind} exist for this provider.`,
      published,
      figures,
    );
  }

  const behind =
    checkpointAhead(
      input.canonical.settledCheckpoint,
      input.canonical.completedCheckpoint,
    ) ||
    checkpointAhead(
      input.canonical.sourceHeadCheckpoint,
      input.canonical.completedCheckpoint,
    );

  if (behind) {
    return settle(
      "behind",
      "CANONICAL_SETTLED_BEYOND_PUBLISHED",
      "What the product serves matches the last completed promotion, but the pipeline has settled further since.",
      published,
      figures,
    );
  }

  return settle(
    "in_sync",
    "FINGERPRINTS_MATCH_AND_CAUGHT_UP",
    "The release the product serves is the one the last completed promotion published, and the pipeline has not settled past it.",
    published,
    figures,
  );
}
