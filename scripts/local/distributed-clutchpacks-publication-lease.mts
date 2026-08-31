import { randomUUID } from "node:crypto";
import {
  PrismaProviderWorkerLeaseRepository,
  type BoundedProviderDatabaseGateway,
  type ProviderWorkerLease,
} from "@packscout/database";

type LeasePort = Pick<PrismaProviderWorkerLeaseRepository, "acquire" | "renew" | "release">;
export type OwnedPublicationImportLease = Pick<ProviderWorkerLease, "role" | "owner" | "fence">;
export class LocalPublicationImportLeaseError extends Error {
  readonly code = "LOCAL_PUBLICATION_IMPORT_LEASE_UNAVAILABLE";
  constructor() { super("The publication import fence is not owned and live."); }
}
function refuse(): never { throw new LocalPublicationImportLeaseError(); }

export function publicationImportLeasePort(input: {
  readonly gateway: BoundedProviderDatabaseGateway;
  readonly organizationId: string;
  readonly providerId: string;
}): LeasePort {
  const run = async <T,>(operation: (repository: PrismaProviderWorkerLeaseRepository) => Promise<T>): Promise<T> => {
    const result = await input.gateway.runWithProviderDatabase(
      { organizationId: input.organizationId, providerId: input.providerId },
      async (database) => operation(new PrismaProviderWorkerLeaseRepository(database)),
    );
    if (result.state !== "reachable") return refuse();
    return result.value;
  };
  return { acquire: (request) => run((repo) => repo.acquire(request)),
    renew: (request) => run((repo) => repo.renew(request)),
    release: (request) => run((repo) => repo.release(request)) };
}

/**
 * Holds the same fenced import lease required by canonical-write triggers.
 * Renews it during network publication and before each source revalidation.
 * A failed renewal is terminal; it never reacquires a newer fence mid-publish.
 */
export async function withPublicationImportLease<T>(input: {
  readonly port: LeasePort;
  readonly operation: (lease: OwnedPublicationImportLease, assertLive: () => Promise<void>) => Promise<T>;
}): Promise<T> {
  const owner = `local-publication:${randomUUID()}`;
  const leaseMilliseconds = 15 * 60_000;
  const acquired = await input.port.acquire({ role: "import", owner, leaseMilliseconds });
  if (acquired.kind === "held" || acquired.lease.owner !== owner || acquired.lease.role !== "import" || acquired.lease.fence < 1n) return refuse();
  const lease: OwnedPublicationImportLease = { role: "import", owner, fence: acquired.lease.fence };
  let failure: unknown = null;
  let pending = Promise.resolve();
  const renew = async () => {
    if (failure !== null) throw failure;
    const renewed = await input.port.renew({ ...lease, leaseMilliseconds });
    if (renewed === null || renewed.owner !== owner || renewed.role !== "import" || renewed.fence !== lease.fence) return refuse();
  };
  const assertLive = async () => {
    pending = pending.then(renew).catch((error: unknown) => { failure = error; });
    await pending;
    if (failure !== null) throw failure;
  };
  const timer = setInterval(() => { void assertLive().catch(() => undefined); }, 30_000);
  try {
    await assertLive();
    const result = await input.operation(lease, assertLive);
    await assertLive();
    return result;
  } finally {
    clearInterval(timer);
    await pending;
    if (!await input.port.release(lease)) return refuse();
  }
}
