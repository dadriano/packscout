import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES,
  packscoutPublicIdentityUuid,
} from "@packscout/contracts";
import type { ProviderPrismaClient } from "./provider-database.ts";
import { PROVIDER_SCHEMA_VERSION } from "./database-topology.ts";
import {
  ProviderReleasePublicationRepository,
  ProviderReleasePublicationRepositoryError,
} from "./provider-release-publication-repository.ts";
import {
  ProviderReleaseAssemblyError,
  ProviderReleaseRepository,
} from "./provider-release-repository.ts";
import { PrismaProviderWorkerLeaseRepository } from
  "./provider-worker-lease-repository.ts";

function transactionTimeoutProvider(code: "P2024" | "P2028"):
  ProviderPrismaClient {
  return {
    $transaction() {
      return Promise.reject(Object.assign(
        new Error("Simulated Prisma transaction timeout."),
        { code },
      ));
    },
  } as unknown as ProviderPrismaClient;
}

const deadline = () => ({ deadlineAt: Date.now() + 10_000 });

test("deadline-bounded publication transactions normalize Prisma expiry", async () => {
  const repository = new ProviderReleasePublicationRepository(
    transactionTimeoutProvider("P2028"),
  );

  await assert.rejects(
    () => repository.loadExpectedCompletedHead(deadline()),
    (error: unknown) =>
      error instanceof ProviderReleasePublicationRepositoryError
      && error.code === "PROVIDER_PUBLICATION_DEADLINE",
  );
});

test("deadline-bounded publication source reads normalize pool expiry", async () => {
  const repository = new ProviderReleaseRepository(
    transactionTimeoutProvider("P2024"),
  );

  await assert.rejects(
    () => repository.publicationSource(
      "30000000-0000-5000-8000-000000000001",
      deadline(),
    ),
    (error: unknown) => error instanceof ProviderReleaseAssemblyError
      && error.code === "PROVIDER_RELEASE_DEADLINE",
  );
});

test("publication source rejects actual JSON bytes before batch hydration", async () => {
  const providerId = "30000000-0000-4000-8000-000000000002";
  const releaseId = "30000000-0000-5000-8000-000000000001";
  let payloadHydrated = false;
  const transaction = {
    database_identity: {
      findUniqueOrThrow: () => Promise.resolve({
        database_role: "provider",
        provider_id: providerId,
        provider_key: "capacity_provider",
        schema_version: PROVIDER_SCHEMA_VERSION,
      }),
    },
    provider_releases: {
      findUnique: () => Promise.resolve({
        id: releaseId,
        predecessor_id: null,
        provider_id: providerId,
        provider_key: "capacity_provider",
        public_provider_id: packscoutPublicIdentityUuid(`provider:${providerId}`),
        through_change_sequence: 1n,
        lifecycle: "assembled",
        catalog_version_id: "30000000-0000-4000-8000-000000000003",
        catalog_content_hash: "a".repeat(64),
        central_schema_version: "central-v1",
        correlation_event_sequence: 1n,
        correlation_snapshot_hash: "b".repeat(64),
        public_profile_version_id: "30000000-0000-4000-8000-000000000004",
        public_profile_hash: "c".repeat(64),
        provider_schema_version: PROVIDER_SCHEMA_VERSION,
        public_schema_version: "provider_catalog_release_v1",
        category_count: 0,
        repack_count: 0,
        collectible_reference_count: 0,
        chase_count: 0,
        retired_repack_count: 0,
        batch_count: 1,
        content_hash: "d".repeat(64),
        index_hash: "e".repeat(64),
        data_as_of: new Date("2026-09-02T12:00:00.000Z"),
        last_successful_observation_at:
          new Date("2026-09-02T12:00:00.000Z"),
        stale_at: new Date("2026-09-02T13:00:00.000Z"),
        freshness: "fresh",
      }),
    },
    $queryRaw: () => Promise.resolve([{
      batchCount: 1n,
      batchRecordCount: 1n,
      payloadByteCount:
        BigInt(MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES) + 1n,
    }]),
  };
  const provider = {
    $transaction: (read: (client: typeof transaction) => unknown) =>
      Promise.resolve(read(transaction)),
    provider_release_batches: {
      findMany: () => {
        payloadHydrated = true;
        return Promise.resolve([]);
      },
    },
  } as unknown as ProviderPrismaClient;

  await assert.rejects(
    new ProviderReleaseRepository(provider).publicationSource(releaseId),
    (error: unknown) => error instanceof ProviderReleaseAssemblyError &&
      error.code === "PROVIDER_RELEASE_PUBLICATION_TOO_LARGE",
  );
  assert.equal(payloadHydrated, false);
});

test("deadline-bounded worker leases normalize Prisma expiry", async () => {
  const repository = new PrismaProviderWorkerLeaseRepository(
    transactionTimeoutProvider("P2028"),
  );

  await assert.rejects(
    () => repository.acquire({
      role: "promotion",
      owner: "provider-publication-deadline-test",
      leaseMilliseconds: 60_000,
    }, deadline()),
    (error: unknown) => error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "PROVIDER_WORKER_LEASE_DEADLINE",
  );
});
