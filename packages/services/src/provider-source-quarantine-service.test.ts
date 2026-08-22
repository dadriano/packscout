import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  normalizedObservationSemanticContent,
  providerIdentityNamespaceByLaunchProvider,
} from "@packscout/contracts";
import {
  ProviderSourceQuarantineService,
  type ProviderSourceQuarantineServiceRepository,
  type StoredProviderSourceQuarantineEntry,
} from "./provider-source-quarantine-service.ts";
import {
  descriptorFor,
  packObservation,
} from "./providers/provider-observation-mapper.test-support.ts";

const quarantineId = "00000000-0000-4000-8000-000000000001";
const attemptId = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-08-21T12:00:00.000Z");

function entry(
  state: StoredProviderSourceQuarantineEntry["state"],
): StoredProviderSourceQuarantineEntry {
  return {
    id: quarantineId,
    organizationId: "organization-1",
    providerId: "provider-1",
    sourceRevisionId: "source-revision-1",
    platformKey: "courtyard",
    runId: "run-1",
    pageId: "page-1",
    recordKind: "catalog",
    recordIndex: 0,
    externalId: "pack-1",
    reasonCode: "mapping_failure",
    fieldPath: null,
    sanitizedSummary: "A mapper rejected this observation.",
    state,
    retryCount: state === "open" ? 1 : 0,
    createdAt: now,
    lastRetryAt: null,
    expiresAt: new Date("2026-09-20T12:00:00.000Z"),
    resolvedAt: null,
    resolutionSummary: null,
  };
}

test("malformed quarantine mapper output durably fails the retry without canonical writes", async () => {
  const observation = packObservation();
  const descriptor = descriptorFor("courtyard");
  const failures: Array<{ failureCode: string; sanitizedSummary: string }> = [];
  let completionCalls = 0;
  const repository: ProviderSourceQuarantineServiceRepository = {
    async getEntry() {
      return entry("open");
    },
    async listAttempts() {
      return [];
    },
    async claimRetry() {
      return {
        kind: "claimed",
        attemptId,
        entry: entry("retrying"),
        evidence: {
          normalizedObservation: observation,
          evidence: [{ reference: observation.protectedNativeEvidenceRef }],
          semanticContent: normalizedObservationSemanticContent(observation),
          sourceRecordId: "source-record-1",
          semanticObservationId: "semantic-observation-1",
          collectedAt: now,
          mapper: {
            mapperKey: descriptor.mapperKey,
            mapperVersion: descriptor.mapperVersion,
            normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
            identityNamespaceKey:
              providerIdentityNamespaceByLaunchProvider.courtyard,
          },
        },
      };
    },
    async completeRetry() {
      completionCalls += 1;
      return { kind: "resolved", entry: entry("resolved"), canonicalRevisionCount: 1 };
    },
    async failRetry(input) {
      failures.push({
        failureCode: input.failureCode,
        sanitizedSummary: input.sanitizedSummary,
      });
      return { kind: "failed", entry: entry("open"), canonicalRevisionCount: 0 };
    },
  };
  const service = new ProviderSourceQuarantineService({
    repository,
    mappers: {
      resolve() {
        return {
          descriptor,
          map() {
            return { status: "mapped" } as never;
          },
        };
      },
    },
    actorKeyer: { keyFor: () => "actor-key" },
    clock: { now: () => now },
    ids: { id: () => attemptId },
  });

  const result = await service.retryOne({
    organizationId: "organization-1",
    operatorId: "operator-1",
    role: "data_operator",
  }, quarantineId);

  assert.equal(result.outcome, "failed");
  assert.equal(result.entry?.state, "open");
  assert.equal(completionCalls, 0);
  assert.deepEqual(failures, [{
    failureCode: "MAPPING_OUTPUT_INVALID",
    sanitizedSummary: "The pinned source mapper returned an invalid result.",
  }]);
});
