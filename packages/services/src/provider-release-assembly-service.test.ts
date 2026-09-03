import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PinnedProviderReleaseInputs,
  ProviderReleaseAssemblyResult,
} from "@packscout/database";
import { ProviderReleaseAssemblyService } from "./provider-release-assembly-service.ts";

const providerId = "15000000-0000-4000-8000-000000000001";
const releaseId = "15000000-0000-4000-8000-000000000002";

const pin = {
  providerId,
  providerKey: "service_fixture",
  providerConfigVersionId: "15000000-0000-4000-8000-000000000006",
  staleAfterSeconds: 900,
  catalogVersionId: "15000000-0000-4000-8000-000000000003",
} as PinnedProviderReleaseInputs;

const descriptor = {
  providerReleaseId: releaseId,
  predecessorCompleteReleaseId: null,
  providerId,
  providerKey: "service_fixture",
  publicProviderId: "15000000-0000-5000-8000-000000000004",
  throughChangeSequence: "9",
  catalogVersionId: pin.catalogVersionId,
  catalogContentHash: "a".repeat(64),
  centralSchemaVersion: "distributed-central-v1",
  correlationEventSequence: "4",
  correlationSnapshotHash: "b".repeat(64),
  publicProfileVersionId: "15000000-0000-4000-8000-000000000005",
  publicProfileHash: "c".repeat(64),
  providerSchemaVersion: "distributed-provider-v1",
  publicSchemaVersion: "provider-release-v1",
  categoryCount: 0,
  repackCount: 0,
  collectibleReferenceCount: 0,
  chaseCount: 0,
  retiredRepackCount: 0,
  batchCount: 7,
  contentHash: "d".repeat(64),
  indexHash: "e".repeat(64),
  dataAsOf: "2026-08-29T12:00:00.000Z",
  lastSuccessfulObservationAt: "2026-08-29T12:00:00.000Z",
  staleAt: "2026-08-29T12:10:00.000Z",
  freshness: "fresh",
} as const;

const assembly: ProviderReleaseAssemblyResult = {
  release: {
    id: releaseId,
    predecessorId: null,
    throughChangeSequence: 9n,
    lifecycle: "complete",
    contentHash: descriptor.contentHash,
    indexHash: descriptor.indexHash,
    batchCount: 7,
    descriptor,
  },
  selectedThroughChangeSequence: 12n,
  publicEquivalenceHash: "f".repeat(64),
  reusedCompleteRelease: true,
  resumedExistingAssembly: false,
};

test("central inputs are pinned before routing to the isolated provider store", async () => {
  const calls: string[] = [];
  const service = new ProviderReleaseAssemblyService({
    workerId: "release-worker",
    leaseMilliseconds: 10_000,
    central: {
      async pin() {
        calls.push("central-pin");
        return pin;
      },
    },
    async providerFor(identity) {
      calls.push(`provider-route:${identity.providerKey}`);
      return {
        async assemble(input) {
          calls.push(`provider-snapshot:${input.pin.catalogVersionId}`);
          return assembly;
        },
      };
    },
  });

  const result = await service.assemble({ providerId });
  assert.deepEqual(calls, [
    "central-pin",
    "provider-route:service_fixture",
    `provider-snapshot:${pin.catalogVersionId}`,
  ]);
  assert.equal(result.status, "assembled");
  if (result.status !== "assembled") return;
  assert.equal(result.assembly.release.descriptor.throughChangeSequence, "9");
  assert.equal(result.assembly.selectedThroughChangeSequence, 12n);
  assert.equal(result.assembly.reusedCompleteRelease, true);
});

test("central failure prevents provider access and returns a bounded diagnostic", async () => {
  let providerOpened = false;
  const service = new ProviderReleaseAssemblyService({
    workerId: "release-worker",
    leaseMilliseconds: 10_000,
    central: {
      async pin() {
        throw Object.assign(new Error("contains secret"), { code: "CATALOG_VERSION_INCOMPLETE" });
      },
    },
    async providerFor() {
      providerOpened = true;
      throw new Error("must not run");
    },
  });

  const result = await service.assemble({ providerId });
  assert.equal(providerOpened, false);
  assert.deepEqual(result, {
    status: "failed",
    diagnostic: {
      providerId,
      providerKey: null,
      claimedSequence: null,
      catalogVersionId: null,
      stage: "central_pin",
      failureCode: "CATALOG_VERSION_INCOMPLETE",
      retryable: true,
    },
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("provider failure reports the claimed boundary without exposing exception text", async () => {
  const service = new ProviderReleaseAssemblyService({
    workerId: "release-worker",
    leaseMilliseconds: 10_000,
    central: { async pin() { return pin; } },
    async providerFor() {
      return {
        async assemble() {
          throw Object.assign(new Error("credential-in-error"), {
            code: "CORRELATION_STALE",
            selectedThroughChangeSequence: 44n,
          });
        },
      };
    },
  });

  const result = await service.assemble({ providerId });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.diagnostic.claimedSequence, "44");
  assert.equal(result.diagnostic.failureCode, "CORRELATION_STALE");
  assert.equal(JSON.stringify(result).includes("credential"), false);
});
