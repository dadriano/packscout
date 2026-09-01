import assert from "node:assert/strict";
import test from "node:test";
import {
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
});
