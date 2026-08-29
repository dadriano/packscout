import assert from "node:assert/strict";
import test from "node:test";
import type { SourceAdapterRequestTerminalizationInput } from
  "@packscout/services";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_PAGE_TARGET_RECORDS,
} from "@packscout/contracts";
import { createProviderDataforrestRequestTerminalizer } from
  "./provider-dataforrest-request-terminalizer.ts";

const attempt = Object.freeze({
  requestAttemptId: "11111111-1111-4111-8111-111111111111",
  requestLeaseId: "22222222-2222-4222-8222-222222222222",
  operationScope: Object.freeze({
    operationKind: "page_read" as const,
    requestAttemptId: "11111111-1111-4111-8111-111111111111",
    requestLeaseId: "22222222-2222-4222-8222-222222222222",
    organizationId: "33333333-3333-4333-8333-333333333333",
    sourceTypeKey: "dataforrest-events-v1",
    adapterVersion: DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
    singletonFencingEpoch: 7,
    connectionProfileId: "44444444-4444-4444-8444-444444444444",
    connectionProfileRevisionId: "44444444-4444-4444-8444-444444444444",
    connectionHealthGeneration: 0,
    provider: "clutchpacks" as const,
    providerId: "55555555-5555-4555-8555-555555555555",
    sourceInstanceId: "55555555-5555-4555-8555-555555555555",
    sourceRevisionId: "66666666-6666-4666-8666-666666666666",
    normalizedContractVersion: "packscout.provider-observation.v1",
    identityNamespaceKey: "clutchpacks",
    importRunId: "77777777-7777-4777-8777-777777777777",
    runClaimLeaseId: "run:7",
    pageAttemptId: "88888888-8888-4888-8888-888888888888",
    pageNumber: 3,
    pageLimit: DATAFORREST_CLUTCHPACKS_DISTRIBUTED_PAGE_TARGET_RECORDS,
    cursorGeneration: 1,
    requestedCursorFingerprint: null,
  }),
  outcome: Object.freeze({
    ok: true as const,
    protectedRawResponseSha256: "a".repeat(64),
    measurements: Object.freeze({
      durationMilliseconds: 41,
      responseBytes: 8_192,
    }),
    diagnostics: Object.freeze([]),
  }),
}) satisfies SourceAdapterRequestTerminalizationInput;

test("DataForrest terminalizer persists exact fenced request metadata before receipt", async () => {
  const writes: unknown[] = [];
  const terminalize = createProviderDataforrestRequestTerminalizer({
    workerId: "preview:clutchpacks",
    audit: {
      async record(input) {
        writes.push(input);
        return { kind: "recorded" as const };
      },
    },
  });
  const receipt = await terminalize(attempt);
  assert.deepEqual(writes, [{
    runId: attempt.operationScope.importRunId,
    workerId: "preview:clutchpacks",
    workerFence: 7n,
    requestAttemptId: attempt.requestAttemptId,
    requestLeaseId: attempt.requestLeaseId,
    pageNumber: 3,
    outcome: "success",
    resultCode: "SOURCE_REQUEST_SUCCEEDED",
    durationMilliseconds: 41,
    responseBytes: 8_192,
  }]);
  assert.deepEqual(receipt, {
    requestAttemptId: attempt.requestAttemptId,
    requestLeaseId: attempt.requestLeaseId,
    operationScope: attempt.operationScope,
  });
});

test("DataForrest terminalizer withholds a receipt after fenced authority loss", async () => {
  const terminalize = createProviderDataforrestRequestTerminalizer({
    workerId: "preview:clutchpacks",
    audit: { record: () => Promise.resolve({ kind: "lease_lost" as const }) },
  });
  await assert.rejects(terminalize(attempt), /authority was lost/u);
});
