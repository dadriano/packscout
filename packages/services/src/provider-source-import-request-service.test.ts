import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderSourceImportRequestError,
  ProviderSourceImportRequestService,
  type ProviderSourceImportRunRequestRepository,
} from "./provider-source-import-request-service.ts";

test("manual import maps an action-required persistence fence to a stable conflict", async () => {
  const requestedAt = new Date("2026-08-21T13:06:00.000Z");
  const runs: ProviderSourceImportRunRequestRepository = {
    async requestRun(input) {
      assert.equal(input.trigger, "manual");
      assert.equal(input.runId, "00000000-0000-4000-8000-000000000004");
      assert.equal(input.requestedByActorKey, "operator-key");
      return { kind: "source_unavailable" };
    },
  };
  const service = new ProviderSourceImportRequestService({
    runs,
    actorKeyer: { keyFor: () => "operator-key" },
    clock: { now: () => requestedAt },
    ids: { id: () => "00000000-0000-4000-8000-000000000004" },
  });

  await assert.rejects(
    service.requestManual({
      actor: {
        operatorId: "00000000-0000-4000-8000-000000000001",
        organizationId: "00000000-0000-4000-8000-000000000002",
        role: "data_operator",
      },
      providerId: "00000000-0000-4000-8000-000000000003",
      expectedSourceRevisionId: "00000000-0000-4000-8000-000000000005",
    }),
    (error: unknown) =>
      error instanceof ProviderSourceImportRequestError &&
      error.code === "SOURCE_NOT_IMPORTABLE" &&
      error.status === 409,
  );
});
