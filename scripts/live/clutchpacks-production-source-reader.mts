import {
  BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy, PrismaProviderWorkerLeaseRepository,
  createCentralDatabaseLifecycle, createProviderDatabaseLifecycle, readDatabaseReadiness,
  type ProviderDatabaseRoute, type ProviderPrismaClient, type ProviderTransactionClient, type CentralTransactionClient,
} from "@packscout/database";
import { ClutchpacksProductionSourceError, validateProductionSourceOptions, drainSourceOperation,
  readProductionSourceAuthority, refuseSource, type ClutchpacksProductionSourceOptions } from "./clutchpacks-production-source-policy.mts";
import { readProductionSourceState } from "./clutchpacks-production-source-state.mts";
import { readProductionSourceCatalog } from "./clutchpacks-production-source-catalog.mts";
import { createProductionSourceController } from "./clutchpacks-production-source-controller.mts";
import { releaseKnownProductionSourceLease } from "./clutchpacks-production-source-lease.mts";

export type { ClutchpacksProductionSourceOptions } from "./clutchpacks-production-source-policy.mts";
export { ClutchpacksProductionSourceError } from "./clutchpacks-production-source-policy.mts";
export type { ProductionSourceImportLease } from "./clutchpacks-production-source-state.mts";
export type { ClutchpacksProductionSourceReadOptions } from "./clutchpacks-production-source-controller.mts";
const TX_OPTIONS = { isolationLevel: "RepeatableRead" as const, maxWait: 5_000, timeout: 30_000 };

/** Lazy, strict-TLS source access only. No environment files, source HTTP, Convex calls, or implicit lease acquisition. */
export function createClutchpacksProductionSourceReader(options: ClutchpacksProductionSourceOptions) {
  const input = Object.freeze({ ...options, scope: Object.freeze({ ...options.scope }), expected: Object.freeze({ ...options.expected }),
    approvedPublicAssetOrigins: Object.freeze([...options.approvedPublicAssetOrigins]) });
  const databaseUrl = validateProductionSourceOptions(input);
  const resolveCredential = input.credentialResolver.resolve.bind(input.credentialResolver);
  const central = createCentralDatabaseLifecycle({ databaseUrl, connectionLimit: 1 });
  const pending = new Set<Promise<unknown>>();
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  }
  async function providerTransaction<T>(database: ProviderPrismaClient, read: (tx: ProviderTransactionClient) => Promise<T>): Promise<T> {
    return drainSourceOperation(callback => database.$transaction(callback, TX_OPTIONS), async (tx: ProviderTransactionClient) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`; await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`; return read(tx);
    });
  }
  const gateway = new BoundedProviderDatabaseGateway({ central, credentialResolver: { resolve: request => track(resolveCredential(request)) },
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: [input.providerHost], allowedPorts: [5432], allowedSslModes: ["verify-full"] }),
    connectionLimitPerProvider: 1, maximumCachedProviders: 1, connectionTimeoutMs: 5_000, operationTimeoutMs: 60_000, closeTimeoutMs: 30_000,
    createLifecycle: configuration => {
      const lifecycle = createProviderDatabaseLifecycle(configuration), readinessPending = new Set<Promise<unknown>>();
      return { ...lifecycle, readiness: () => {
        const promise = track(providerTransaction(lifecycle.client, tx => readDatabaseReadiness({ client: tx, target: lifecycle.target })));
        readinessPending.add(promise); void promise.then(() => readinessPending.delete(promise), () => readinessPending.delete(promise)); return promise;
      }, close: async () => {
        // The gateway can retire timed-out startup independently; its close must drain too.
        while (readinessPending.size) await Promise.allSettled([...readinessPending]); await lifecycle.close();
      } };
    },
  });
  async function withRoute<T>(route: ProviderDatabaseRoute, operation: (database: ProviderPrismaClient) => Promise<T>): Promise<T> {
    let failure: unknown;
    const result = await drainSourceOperation(callback => gateway.runWithCachedProviderDatabase(route, callback), async (database: ProviderPrismaClient) => {
      try { return await operation(database); } catch (error) { failure = error; throw error; }
    });
    if (result.state !== "reachable") {
      if (failure instanceof ClutchpacksProductionSourceError) throw failure;
      return refuseSource("PRODUCTION_SOURCE_DATABASE_UNREACHABLE");
    }
    return result.value;
  }
  return createProductionSourceController(input, {
    authority: pinned => drainSourceOperation(callback => central.client.$transaction(callback, TX_OPTIONS), async (tx: CentralTransactionClient) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`; await tx.$executeRaw`SET LOCAL statement_timeout = '10s'`;
      return readProductionSourceAuthority(tx, pinned);
    }),
    state: (pinned, before, lease) => withRoute(before.route, database => providerTransaction(database,
      tx => readProductionSourceState(tx, pinned, before, lease))),
    snapshot: (pinned, before, lease) => withRoute(before.route, database => providerTransaction(database, async tx => {
      const current = await readProductionSourceState(tx, pinned, before, lease);
      const catalog = await readProductionSourceCatalog(tx, pinned, before, current);
      const final = await readProductionSourceState(tx, pinned, before, lease);
      if (final.digest !== current.digest) refuseSource("PRODUCTION_SOURCE_CHANGED_DURING_READ");
      return { current, catalog };
    })),
    leases: before => ({ acquire: request => withRoute(before.route, database => new PrismaProviderWorkerLeaseRepository(database).acquire(request)),
      renew: request => withRoute(before.route, database => new PrismaProviderWorkerLeaseRepository(database).renew(request)),
      release: request => withRoute(before.route, database => new PrismaProviderWorkerLeaseRepository(database).release(request)) }),
    cleanup: (pinned, before, lease) => withRoute(before.route, database => releaseKnownProductionSourceLease(database, pinned.scope, lease)),
    close: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      try { await gateway.close(); } finally { await central.close(); }
    },
  });
}
export type ClutchpacksProductionSourceReader = ReturnType<typeof createClutchpacksProductionSourceReader>;
export type ClutchpacksProductionSourceSnapshot = Awaited<ReturnType<ClutchpacksProductionSourceReader["read"]>>;
