import assert from "node:assert/strict";
import { test } from "node:test";
import type { PackscoutPrismaClient } from "./database.ts";
import { ProviderSourceRequestRepository } from "./provider-source-request-repository.ts";

const baseTerminalization = {
  organizationId: "organization-1",
  requestAttemptId: "attempt-1",
  supervisorEpochId: "epoch-1",
  supervisorOwnerKey: "worker-1",
  supervisorLeaseToken: "00000000-0000-4000-8000-000000000001",
  state: "failed",
  outcomeClass: "invalid_response",
  safeCode: "invalid_response",
  safeOutcomeHash: "a".repeat(64),
  terminalAt: new Date("2026-08-21T12:00:00.000Z"),
} as const;

test("only typed connection-owned failures can open a shared profile episode", async () => {
  const repository = new ProviderSourceRequestRepository(
    {} as PackscoutPrismaClient,
  );

  for (const blockingFailure of [
    { failureClass: "invalid_response", safeCode: "invalid_response" },
    { failureClass: "invalid_cursor", safeCode: "invalid_cursor" },
    { failureClass: "authentication_failed", safeCode: "endpoint_invalid" },
  ]) {
    await assert.rejects(
      repository.terminalize({
        ...baseTerminalization,
        blockingFailure: blockingFailure as never,
      }),
      /exact connection-action-required adapter code/u,
    );
  }
});
