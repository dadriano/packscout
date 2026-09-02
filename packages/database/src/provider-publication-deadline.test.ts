import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderPrismaClient } from "./provider-database.ts";
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
