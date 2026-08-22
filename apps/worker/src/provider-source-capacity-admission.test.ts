import assert from "node:assert/strict";
import { test } from "node:test";
import type { PackscoutPrismaClient } from "@packscout/database";
import {
  createProviderSourceCapacityAdmissionHook,
  evaluateProviderSourceOngoingCapacity,
  loadCommittedProviderSourceCapacityArtifact,
  ProviderSourceCapacityAdmissionConfigurationError,
  providerSourceMaximumPageCommitBytes,
} from "./provider-source-capacity-admission.ts";

test("committed capacity evidence remains admitted after one planned page", () => {
  const artifact = loadCommittedProviderSourceCapacityArtifact();
  const capacity = 10_000_000_000_000;
  const initiallyAvailable = artifact.forecast.task010MinimumAvailableBytes;
  const initial = evaluateProviderSourceOngoingCapacity({
    artifact,
    volumeCapacityBytes: capacity,
    volumeAvailableBytes: initiallyAvailable,
    unreconciledAttemptCount: 0,
  });
  const afterOneMeasuredPage = evaluateProviderSourceOngoingCapacity({
    artifact,
    volumeCapacityBytes: capacity,
    volumeAvailableBytes:
      initiallyAvailable - artifact.forecastInput.measuredAverageRawPageBytes,
    unreconciledAttemptCount: 0,
  });

  assert.equal(initial.admitted, true);
  assert.equal(afterOneMeasuredPage.admitted, true);
});

test("ongoing capacity reserves four commits and blocks at the 80 percent boundary", () => {
  const artifact = loadCommittedProviderSourceCapacityArtifact();
  const capacity = 10_000_000_000_000;
  const abortAt = Math.floor(capacity * 8_000 / 10_000);
  const fourMaximumPages = 4 * providerSourceMaximumPageCommitBytes(artifact);
  const justSafeAvailable = capacity - (abortAt - fourMaximumPages - 1);
  const admitted = evaluateProviderSourceOngoingCapacity({
    artifact,
    volumeCapacityBytes: capacity,
    volumeAvailableBytes: justSafeAvailable,
    unreconciledAttemptCount: 0,
  });
  const blocked = evaluateProviderSourceOngoingCapacity({
    artifact,
    volumeCapacityBytes: capacity,
    volumeAvailableBytes: justSafeAvailable - 1,
    unreconciledAttemptCount: 0,
  });
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.projectedUsedBytes, abortAt - 1);
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.projectedUsedBytes, abortAt);
});

test("capacity hook uses the validated volume and fails closed", async () => {
  const artifact = loadCommittedProviderSourceCapacityArtifact();
  const decisions: Array<"approved" | "blocked"> = [];
  const hook = createProviderSourceCapacityAdmissionHook({
    database: {} as PackscoutPrismaClient,
    volumePath: "/configured/database-volume",
    artifact,
    resolveVolumePath(value) {
      assert.equal(value, "/configured/database-volume");
      return "/resolved/database-volume";
    },
    async statVolume(path) {
      assert.equal(path, "/resolved/database-volume");
      const blocked = decisions.length > 0;
      decisions.push(blocked ? "blocked" : "approved");
      return {
        bsize: 1n,
        blocks: 10_000_000_000_000n,
        bavail: blocked
          ? 2_000_000_000_000n
          : BigInt(artifact.forecast.task010MinimumAvailableBytes),
      };
    },
    async countUnreconciledAttempts() { return 0; },
  });

  assert.deepEqual(await hook.probe({} as never), { admitted: true });
  assert.deepEqual(await hook.probe({} as never), {
    admitted: false,
    state: "blocked",
    safeCode: "CAPACITY_ABORT_THRESHOLD_REACHED",
  });

  assert.throws(
    () => createProviderSourceCapacityAdmissionHook({
      database: {} as PackscoutPrismaClient,
      volumePath: "/missing",
      artifact,
      resolveVolumePath() { throw new Error("missing"); },
    }),
    (error: unknown) =>
      error instanceof ProviderSourceCapacityAdmissionConfigurationError &&
      error.code === "CAPACITY_VOLUME_PATH_INVALID",
  );
  assert.throws(
    () => createProviderSourceCapacityAdmissionHook({
      database: {} as PackscoutPrismaClient,
      volumePath: "/configured/symlink-to-root",
      artifact,
      resolveVolumePath() { return "/"; },
    }),
    (error: unknown) =>
      error instanceof ProviderSourceCapacityAdmissionConfigurationError &&
      error.code === "CAPACITY_VOLUME_PATH_INVALID",
  );
});
