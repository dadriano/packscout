import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalKindSummary } from "@packscout/contracts";
import {
  judgeProviderParity,
  outOfScopeKinds,
  type CanonicalParityInput,
  type PublishedParityInput,
} from "./parity-verdict.ts";

const FINGERPRINT = "f".repeat(64);
const OTHER_FINGERPRINT = "e".repeat(64);

function kindSummary(
  recordKind: CanonicalKindSummary["recordKind"],
  count: number,
  precision: "exact" | "at_least" = "exact",
): CanonicalKindSummary {
  return {
    recordKind,
    count,
    precision,
    oldestCollectedAt: "2026-01-01T00:00:00.000Z",
    newestCollectedAt: "2026-08-20T00:00:00.000Z",
    oldestAcceptedAt: "2026-01-01T00:05:00.000Z",
    newestAcceptedAt: "2026-08-20T00:05:00.000Z",
    collectedExtremaComplete: true,
  };
}

function canonicalRead(
  overrides: Partial<Extract<CanonicalParityInput, { kind: "read" }>> = {},
): CanonicalParityInput {
  return {
    kind: "read",
    kinds: [kindSummary("pack", 10), kindSummary("catalog_asset", 4)],
    settledCheckpoint: "100",
    sourceHeadCheckpoint: "100",
    completedCheckpoint: "100",
    completedProviderReleaseFingerprint: FINGERPRINT,
    selectedProviderReleaseFingerprint: FINGERPRINT,
    selectedPublicProviderReleaseId: "release-1",
    ...overrides,
  };
}

function publishedActive(
  overrides: Partial<Extract<PublishedParityInput, { kind: "active" }>> = {},
): PublishedParityInput {
  return {
    kind: "active",
    publicProviderReleaseId: "release-1",
    lifecycle: "complete",
    providerReleaseFingerprint: FINGERPRINT,
    dataAsOf: "2026-08-20T00:10:00.000Z",
    counts: { repacks: 10, collectibles: 4, vendors: 1, categories: 2 },
    ...overrides,
  };
}

function judge(
  canonical: CanonicalParityInput,
  published: PublishedParityInput,
) {
  return judgeProviderParity({ platformKey: "courtyard", canonical, published });
}

test("matching fingerprints with a caught-up checkpoint are in sync", () => {
  const parity = judge(canonicalRead(), publishedActive());
  assert.equal(parity.verdict, "in_sync");
  assert.equal(parity.reasonCode, "FINGERPRINTS_MATCH_AND_CAUGHT_UP");
});

test("matching fingerprints with canonical settled further are behind", () => {
  const parity = judge(
    canonicalRead({ settledCheckpoint: "140", completedCheckpoint: "100" }),
    publishedActive(),
  );
  assert.equal(parity.verdict, "behind");
  assert.equal(parity.reasonCode, "CANONICAL_SETTLED_BEYOND_PUBLISHED");
});

test("a source head beyond the completed checkpoint is also behind", () => {
  const parity = judge(
    canonicalRead({ sourceHeadCheckpoint: "180", completedCheckpoint: "100" }),
    publishedActive(),
  );
  assert.equal(parity.verdict, "behind");
});

test("disagreeing fingerprints are drift", () => {
  const parity = judge(
    canonicalRead(),
    publishedActive({ providerReleaseFingerprint: OTHER_FINGERPRINT }),
  );
  assert.equal(parity.verdict, "drifted");
  assert.equal(parity.reasonCode, "FINGERPRINT_MISMATCH");
});

test("disagreeing counts are drift even when fingerprints match", () => {
  const parity = judge(
    canonicalRead(),
    publishedActive({ counts: { repacks: 9, collectibles: 4 } }),
  );
  assert.equal(parity.verdict, "drifted");
  assert.equal(parity.reasonCode, "COUNTS_DISAGREE");
});

test("a manifest serving a release with no promotion record is drift", () => {
  const parity = judge(
    canonicalRead({ completedProviderReleaseFingerprint: null }),
    publishedActive(),
  );
  assert.equal(parity.verdict, "drifted");
  assert.equal(parity.reasonCode, "MANIFEST_SERVES_UNRECOGNIZED_RELEASE");
});

test("a manifest naming a release the backend lost is drift", () => {
  const parity = judge(canonicalRead(), {
    kind: "release_missing",
    publicProviderReleaseId: "release-gone",
  });
  assert.equal(parity.verdict, "drifted");
  assert.equal(parity.reasonCode, "MANIFEST_SERVES_MISSING_RELEASE");
});

test("a non-complete lifecycle is drift, not silently served", () => {
  for (const lifecycle of ["staging", "failed", "retired"] as const) {
    const parity = judge(canonicalRead(), publishedActive({ lifecycle }));
    assert.equal(parity.verdict, "drifted", lifecycle);
    assert.equal(parity.reasonCode, "RELEASE_LIFECYCLE_NOT_COMPLETE");
  }
});

test("no manifest and an unreferenced platform are both unpublished", () => {
  assert.equal(
    judge(canonicalRead(), { kind: "no_active_manifest" }).reasonCode,
    "NO_ACTIVE_MANIFEST",
  );
  assert.equal(
    judge(canonicalRead(), { kind: "platform_not_referenced" }).verdict,
    "unpublished",
  );
});

test("an unread side is unknown and never reported as zero", () => {
  const parity = judge(canonicalRead(), {
    kind: "unreadable",
    detail: "the backend did not answer",
  });
  assert.equal(parity.verdict, "unknown");
  assert.equal(parity.reasonCode, "PUBLISHED_SIDE_UNREADABLE");
  // The published side must carry no fabricated numbers.
  assert.equal(parity.published.fingerprint, null);
  for (const figure of parity.figures) {
    assert.equal(figure.publishedCount, null);
  }
  // The canonical side still returns its own figures.
  assert.ok(parity.figures.length > 0);
});

test("an unreadable canonical side is unknown too", () => {
  const parity = judge(
    { kind: "unreadable", detail: "the database did not answer" },
    publishedActive(),
  );
  assert.equal(parity.verdict, "unknown");
  assert.equal(parity.reasonCode, "CANONICAL_SIDE_UNREADABLE");
});

test("a floor below the published total is not reported as drift", () => {
  // The pipeline reports "at least 10" and the product serves 12. The floor
  // proves nothing, so this must not read as a disagreement.
  const parity = judge(
    canonicalRead({
      kinds: [kindSummary("pack", 10, "at_least"), kindSummary("catalog_asset", 4)],
    }),
    publishedActive({ counts: { repacks: 12, collectibles: 4 } }),
  );
  assert.equal(parity.verdict, "in_sync");
  const packs = parity.figures.find((figure) => figure.canonicalKind === "pack");
  assert.equal(packs?.comparable, false);
  assert.equal(packs?.disagrees, false);
});

test("a floor above the published total does prove drift", () => {
  // "At least 50,000" against 40 published records is a disagreement the floor
  // is strong enough to establish.
  const parity = judge(
    canonicalRead({
      kinds: [
        kindSummary("pack", 50_000, "at_least"),
        kindSummary("catalog_asset", 4),
      ],
    }),
    publishedActive({ counts: { repacks: 40, collectibles: 4 } }),
  );
  assert.equal(parity.verdict, "drifted");
  assert.equal(parity.reasonCode, "COUNTS_DISAGREE");
});

test("pipeline-only kinds are named out of scope, not missing", () => {
  const scope = outOfScopeKinds();
  const kinds = scope.map((entry) => entry.canonicalKind).sort();
  assert.deepEqual(kinds, ["estimated_ev", "ev_input", "market_event", "pull"]);
  for (const entry of scope) assert.ok(entry.reason.length > 0);

  // Every verdict carries the list, so a consumer never hard-codes it.
  const parity = judge(canonicalRead(), publishedActive());
  assert.equal(parity.outOfScope.length, 4);
  // And no out-of-scope kind appears among the compared figures.
  const compared = parity.figures.map((figure) => figure.canonicalKind);
  for (const entry of scope) assert.ok(!compared.includes(entry.canonicalKind));
});

test("ordinary ingestion since the last promotion is behind, not drift", () => {
  // The pipeline landed one new pack. Fingerprints agree, nothing is wrong.
  // The published count is frozen at its release and the canonical count is
  // read live, so they differ by construction — that is what `behind` names.
  const parity = judge(
    canonicalRead({
      kinds: [kindSummary("pack", 11), kindSummary("catalog_asset", 4)],
      settledCheckpoint: "140",
      completedCheckpoint: "100",
    }),
    publishedActive({ counts: { repacks: 10, collectibles: 4 } }),
  );
  assert.equal(parity.verdict, "behind");
  assert.equal(parity.reasonCode, "CANONICAL_SETTLED_BEYOND_PUBLISHED");
  // And the differing count is not presented as a comparison that failed.
  const packs = parity.figures.find((figure) => figure.canonicalKind === "pack");
  assert.equal(packs?.comparable, false);
  assert.equal(packs?.disagrees, false);
});

test("counts only prove drift once the lane has caught up", () => {
  // Same count difference, but nothing has settled since the promotion, so
  // there is no ingestion to explain it.
  const parity = judge(
    canonicalRead({
      kinds: [kindSummary("pack", 11), kindSummary("catalog_asset", 4)],
      settledCheckpoint: "100",
      sourceHeadCheckpoint: "100",
      completedCheckpoint: "100",
    }),
    publishedActive({ counts: { repacks: 10, collectibles: 4 } }),
  );
  assert.equal(parity.verdict, "drifted");
  assert.equal(parity.reasonCode, "COUNTS_DISAGREE");
});

test("a moved source head is behind, and says the changes have not settled", () => {
  const parity = judge(
    canonicalRead({
      settledCheckpoint: "100",
      sourceHeadCheckpoint: "180",
      completedCheckpoint: "100",
    }),
    publishedActive(),
  );
  assert.equal(parity.verdict, "behind");
  // The wording must not claim the pipeline settled further when it did not.
  assert.match(parity.explanation, /have not settled yet/);
});

test("checkpoints compare numerically, not as strings", () => {
  // "1000" sorts before "999" lexically and after it numerically. A string
  // comparison here would report a caught-up lane as behind, or worse, miss a
  // lane that is genuinely behind.
  const caughtUp = judge(
    canonicalRead({
      settledCheckpoint: "999",
      sourceHeadCheckpoint: "999",
      completedCheckpoint: "1000",
    }),
    publishedActive(),
  );
  assert.equal(caughtUp.verdict, "in_sync");

  const genuinelyBehind = judge(
    canonicalRead({
      settledCheckpoint: "1000",
      sourceHeadCheckpoint: "1000",
      completedCheckpoint: "999",
    }),
    publishedActive(),
  );
  assert.equal(genuinelyBehind.verdict, "behind");
});
