import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProviderReleaseCompletedActivity,
  providerActivityEventDigest,
  providerReleaseCompletedActivityEvidence,
  type ProviderActivityEvent,
} from "./provider-activity-contract.ts";

const identity = {
  id: "10000000-0000-4000-8000-000000000001",
  eventType: "provider_release_completed",
  severity: "info" as const,
  dedupeKey: "provider-release-completed:10000000-0000-5000-8000-000000000001:21",
  recoveryKey: "provider-release:10000000-0000-5000-8000-000000000001",
  localRunId: null,
  localQuarantineId: null,
  title: "Provider release publication completed",
  summary: "An immutable provider release completed publication.",
  evidence: {
    state: "complete",
    providerReleaseId: "10000000-0000-5000-8000-000000000001",
    publicProviderReleaseId: "20000000-0000-5000-8000-000000000001",
    catalogVersionId: "30000000-0000-4000-8000-000000000001",
    catalogContentHash: "a".repeat(64),
    providerReleaseContentHash: "b".repeat(64),
    providerReleaseFingerprint: "c".repeat(64),
    completedThroughChangeSequence: "21",
    terminalReceiptSha256: "d".repeat(64),
  },
  eventAt: new Date("2026-09-01T20:00:00.000Z"),
};

test("provider completion relay evidence is exact, typed, and digest-bound", () => {
  const event: ProviderActivityEvent = {
    ...identity,
    eventDigest: providerActivityEventDigest(identity),
    deliveryAttemptCount: 0,
    lastFailureCode: null,
  };

  assert.deepEqual(providerReleaseCompletedActivityEvidence(event), {
    ...identity.evidence,
  });
  assert.throws(
    () => providerReleaseCompletedActivityEvidence({
      ...event,
      evidence: { ...event.evidence, databaseUrl: "safe-looking-value" },
    }),
    /invalid key/u,
  );
  assert.throws(
    () => providerReleaseCompletedActivityEvidence({
      ...event,
      evidence: { ...event.evidence, terminalReceiptSha256: "0" },
    }),
    /invalid/u,
  );
  assert.deepEqual(assertProviderReleaseCompletedActivity(event), {
    ...identity.evidence,
  });
  const reusedIdentity = {
    ...identity,
    id: "10000000-0000-4000-8000-000000000002",
    summary:
      "An unchanged immutable provider release confirmed a newer boundary.",
    evidence: { ...identity.evidence, state: "reused" },
  } as const;
  assert.equal(assertProviderReleaseCompletedActivity({
    ...reusedIdentity,
    eventDigest: providerActivityEventDigest(reusedIdentity),
    deliveryAttemptCount: 1,
    lastFailureCode: "CENTRAL_ACTIVITY_UNAVAILABLE",
  }).state, "reused");
  for (const invalid of [
    { ...event, severity: "warning" as const },
    { ...event, dedupeKey: "provider-release-completed:other" },
    { ...event, recoveryKey: "provider-release:other" },
    { ...event, summary: "A generic completion occurred." },
  ]) {
    const redigested = {
      ...invalid,
      eventDigest: providerActivityEventDigest(invalid),
    };
    assert.throws(
      () => assertProviderReleaseCompletedActivity(redigested),
      /envelope is invalid/u,
    );
  }
  const overflow = {
    ...event,
    evidence: {
      ...event.evidence,
      completedThroughChangeSequence: "9223372036854775808",
    },
  };
  assert.throws(
    () => assertProviderReleaseCompletedActivity({
      ...overflow,
      eventDigest: providerActivityEventDigest(overflow),
    }),
    /evidence is invalid/u,
  );
});
