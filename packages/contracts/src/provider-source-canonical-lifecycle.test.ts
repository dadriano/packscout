import assert from "node:assert/strict";
import test from "node:test";
import { decideProviderSourceCanonicalLifecycle } from
  "./provider-source-canonical-lifecycle.ts";

const common = {
  recordIdScopeKey: "pull-v1" as const,
  canonicalKind: "pull" as const,
  existingBinding: null,
};

test("duplicate lifecycle decisions identify the retained canonical revision", () => {
  const revisions = [
    {
      canonicalRevisionId: "revision-a",
      contentFingerprint: "a".repeat(64),
      effectiveAt: "2026-08-21T12:00:00.000Z",
    },
    {
      canonicalRevisionId: "revision-b",
      contentFingerprint: "b".repeat(64),
      effectiveAt: "2026-08-21T13:00:00.000Z",
    },
  ];

  assert.deepEqual(decideProviderSourceCanonicalLifecycle({
    ...common,
    contentFingerprint: "a".repeat(64),
    effectiveAt: "2026-08-21T12:00:00.000Z",
    revisions,
  }), {
    disposition: "duplicate",
    becomesCurrent: false,
    reuseCanonicalRevisionId: "revision-a",
  });
  assert.deepEqual(decideProviderSourceCanonicalLifecycle({
    ...common,
    contentFingerprint: "b".repeat(64),
    effectiveAt: "2026-08-21T14:00:00.000Z",
    revisions,
  }), {
    disposition: "duplicate",
    becomesCurrent: false,
    reuseCanonicalRevisionId: "revision-b",
  });
});

test("in-batch duplicates retain the null revision placeholder", () => {
  assert.deepEqual(decideProviderSourceCanonicalLifecycle({
    ...common,
    contentFingerprint: "c".repeat(64),
    effectiveAt: "2026-08-21T12:00:00.000Z",
    revisions: [{
      canonicalRevisionId: null,
      contentFingerprint: "c".repeat(64),
      effectiveAt: "2026-08-21T12:00:00.000Z",
    }],
  }), {
    disposition: "duplicate",
    becomesCurrent: false,
    reuseCanonicalRevisionId: null,
  });
});
