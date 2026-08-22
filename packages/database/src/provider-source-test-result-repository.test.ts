import assert from "node:assert/strict";
import { test } from "node:test";
import type { PackscoutPrismaClient } from "./database.ts";
import { ProviderSourceTestResultRepository } from "./provider-source-test-result-repository.ts";

const baseInput = {
  organizationId: "organization-1",
  jobId: "job-1",
  requestAttemptId: "attempt-1",
  claimOwner: "worker-1",
  claimToken: "00000000-0000-4000-8000-000000000001",
  supervisorEpochId: "epoch-1",
  supervisorOwnerKey: "worker-1",
  supervisorLeaseToken: "00000000-0000-4000-8000-000000000002",
  outcome: "success",
  completedAt: new Date("2026-08-21T12:00:00.000Z"),
} as const;

test("connection-test result metrics fail before persistence when out of bounds", async () => {
  const repository = new ProviderSourceTestResultRepository(
    {} as PackscoutPrismaClient,
  );

  for (const responseStatus of [99, 600, 200.5]) {
    await assert.rejects(
      repository.completeConnectionTest({ ...baseInput, responseStatus }),
      /response status must be an integer from 100 through 599/u,
    );
  }
  for (const latencyMs of [-1, 1.5, 2_147_483_648]) {
    await assert.rejects(
      repository.completeConnectionTest({ ...baseInput, latencyMs }),
      /latency must be a nonnegative 32-bit integer/u,
    );
  }
});
