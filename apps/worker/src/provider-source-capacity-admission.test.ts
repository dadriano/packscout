import assert from "node:assert/strict";
import { test } from "node:test";
import {
  providerSourceLaunchBounds,
  providerSourceRecordsPerRequest,
} from "@packscout/contracts";
import type { PackscoutPrismaClient } from "@packscout/database";
import {
  buildProviderSourceCapacityForecast,
} from "@packscout/services";
import {
  createProviderSourceCapacityAdmissionHook,
  evaluateProviderSourceOngoingCapacity,
  loadCommittedProviderSourceCapacityArtifact,
  ProviderSourceCapacityAdmissionConfigurationError,
  parseProviderSourceCapacityArtifact,
  providerSourceMaximumPageCommitBytes,
} from "./provider-source-capacity-admission.ts";

test("capacity evidence must match the initial and ongoing launch limits", () => {
  const current = loadCommittedProviderSourceCapacityArtifact();
  for (const patch of [
    { pageRecordLimit: providerSourceLaunchBounds.pageTargetRecords - 1 },
    {
      incrementalRecordsPerPollAttempt:
        providerSourceRecordsPerRequest.maximum - 1,
    },
  ]) {
    const staleInput = { ...current.forecastInput, ...patch };
    assert.throws(
      () => parseProviderSourceCapacityArtifact({
        version: "provider-source-capacity-measurement-v1",
        forecastInput: staleInput,
        forecast: buildProviderSourceCapacityForecast(staleInput),
      }),
      (error: unknown) =>
        error instanceof ProviderSourceCapacityAdmissionConfigurationError &&
        error.code === "CAPACITY_ARTIFACT_INVALID",
    );
  }
});

test("committed capacity evidence remains admitted after one planned page", () => {
  const artifact = loadCommittedProviderSourceCapacityArtifact();
  const initiallyAvailable = artifact.forecast.task010MinimumAvailableBytes;
  const capacity = initiallyAvailable * 2;
  assert.ok(Number.isSafeInteger(capacity));
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

test("ongoing capacity reserves four commits and blocks at the default 80 percent boundary", () => {
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
  assert.equal(admitted.projectedAvailableBytes, capacity - abortAt + 1);
  assert.equal(admitted.minimumAvailableBytes, capacity - abortAt);
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.projectedAvailableBytes, capacity - abortAt);
  assert.equal(blocked.safeCode, "CAPACITY_ABORT_THRESHOLD_REACHED");
});

test("one maximum commit reserves independent raw and protected-evidence copies", () => {
  const artifact = loadCommittedProviderSourceCapacityArtifact();
  const model = artifact.forecastInput;
  const maximumPageRecords = Math.max(
    model.pageRecordLimit,
    model.incrementalRecordsPerPollAttempt,
    providerSourceRecordsPerRequest.maximum,
  );
  const bytesWithoutProtectedNativeEvidence =
    providerSourceLaunchBounds.maximumResponseBytes +
    maximumPageRecords * (
      model.measuredStructuredPhysicalBytesPerRecord +
      model.measuredPreExpiryNormalizedPayloadPhysicalBytesPerRecord +
      model.measuredQuarantinePhysicalBytes
    ) +
    model.measuredImportPagePhysicalBytes +
    model.measuredDiagnosticPhysicalBytesPerPage +
    model.measuredTerminalAttemptPhysicalBytes +
    model.measuredCompactAttemptPhysicalBytes;

  assert.equal(
    providerSourceMaximumPageCommitBytes(artifact) -
      bytesWithoutProtectedNativeEvidence,
    Math.max(
      providerSourceLaunchBounds.maximumResponseBytes,
      maximumPageRecords * Math.max(
        model.measuredAverageRawRecordBytes,
        model.measuredQuarantineEvidencePhysicalBytes,
      ),
    ),
  );
});

test("local disk reserve projects remaining free bytes instead of host utilization", () => {
  const artifact = loadCommittedProviderSourceCapacityArtifact();
  const capacity = 1_000_000_000_000;
  const diskReserve = 16 * 1_073_741_824;
  const fourMaximumPages = 4 * providerSourceMaximumPageCommitBytes(artifact);
  const admitted = evaluateProviderSourceOngoingCapacity({
    artifact,
    volumeCapacityBytes: capacity,
    volumeAvailableBytes: diskReserve + fourMaximumPages + 1,
    unreconciledAttemptCount: 0,
    minimumAvailableBytes: diskReserve,
  });
  const blocked = evaluateProviderSourceOngoingCapacity({
    artifact,
    volumeCapacityBytes: capacity,
    volumeAvailableBytes: diskReserve + fourMaximumPages,
    unreconciledAttemptCount: 0,
    minimumAvailableBytes: diskReserve,
  });

  assert.equal(admitted.admitted, true);
  assert.equal(admitted.projectedAvailableBytes, diskReserve + 1);
  assert.equal(blocked.admitted, false);
  assert.equal(blocked.projectedAvailableBytes, diskReserve);
  assert.equal(blocked.safeCode, "CAPACITY_DISK_RESERVE_REACHED");
});

test("capacity hook uses the validated volume and fails closed", async () => {
  const artifact = loadCommittedProviderSourceCapacityArtifact();
  const capacity = artifact.forecast.task010MinimumAvailableBytes * 2;
  assert.ok(Number.isSafeInteger(capacity));
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
        blocks: BigInt(capacity),
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
