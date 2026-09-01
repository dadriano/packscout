import type { PrismaProviderWorkerLeaseRepository } from "@packscout/database";
import { ClutchpacksProductionSourceError, refuseSource, sourceDigest, validateProductionSourceOptions,
  type ClutchpacksProductionSourceOptions, type ProductionSourceAuthority } from "./clutchpacks-production-source-policy.mts";
import { assertProductionSourceLeaseBudget, type ProductionSourceImportLease, type ProductionSourceState } from "./clutchpacks-production-source-state.mts";
import type { ClutchpacksProductionSourceCatalog } from "./clutchpacks-production-source-catalog.mts";
import { acquireCheckedProductionSourceLease } from "./clutchpacks-production-source-lease.mts";
export { ClutchpacksProductionSourceError } from "./clutchpacks-production-source-policy.mts";

export type ClutchpacksProductionSourceReadOptions = Readonly<{ expectedImportLease?: ProductionSourceImportLease }>;
type LeasePort = Pick<PrismaProviderWorkerLeaseRepository, "acquire" | "renew" | "release">;
/** Internal orchestration ports. The production factory supplies only policy-checked Prisma implementations. */
export interface ProductionSourcePorts {
  authority(input: ClutchpacksProductionSourceOptions): Promise<ProductionSourceAuthority>;
  state(input: ClutchpacksProductionSourceOptions, authority: ProductionSourceAuthority, lease?: ProductionSourceImportLease): Promise<ProductionSourceState>;
  snapshot(input: ClutchpacksProductionSourceOptions, authority: ProductionSourceAuthority, lease?: ProductionSourceImportLease): Promise<{ current: ProductionSourceState; catalog: ClutchpacksProductionSourceCatalog }>;
  leases(authority: ProductionSourceAuthority): LeasePort;
  cleanup(input: ClutchpacksProductionSourceOptions, authority: ProductionSourceAuthority, lease: ProductionSourceImportLease): Promise<boolean>;
  close(): Promise<void>;
}

export function createProductionSourceController(options: ClutchpacksProductionSourceOptions, ports: ProductionSourcePorts) {
  const input = Object.freeze({ ...options, scope: Object.freeze({ ...options.scope }), expected: Object.freeze({ ...options.expected }),
    approvedPublicAssetOrigins: Object.freeze([...options.approvedPublicAssetOrigins]) });
  validateProductionSourceOptions(input);
  let closed = false, busy = false, pending: Promise<unknown> | undefined;
  let baselineQuiet: string | undefined, baselineFull: string | undefined, ownedLease: ProductionSourceImportLease | undefined;
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (closed || busy) refuseSource("PRODUCTION_SOURCE_CLOSED_OR_BUSY");
    busy = true;
    try { const work = operation(); pending = work; return await work; }
    catch (error) {
      if (error instanceof ClutchpacksProductionSourceError && /^PRODUCTION_SOURCE_[A-Z_]{1,80}$/u.test(error.code)) throw error;
      return refuseSource("PRODUCTION_SOURCE_READ_UNAVAILABLE");
    } finally { busy = false; pending = undefined; }
  }
  const authority = () => ports.authority(input);
  const state = (before: ProductionSourceAuthority, lease?: ProductionSourceImportLease) => ports.state(input, before, lease);
  function assertOwned(lease?: ProductionSourceImportLease) {
    if (lease !== undefined && (!ownedLease || lease.role !== ownedLease.role || lease.owner !== ownedLease.owner || lease.fence !== ownedLease.fence)) {
      refuseSource("PRODUCTION_SOURCE_IMPORT_LEASE_NOT_ACQUIRED_HERE");
    }
  }
  async function finishQuiet(before: ProductionSourceAuthority, firstDigest: string, lease?: ProductionSourceImportLease) {
    const after = await authority();
    if (after.digest !== before.digest) refuseSource("PRODUCTION_SOURCE_AUTHORITY_CHANGED");
    const fresh = await state(after, lease);
    if (fresh.digest !== firstDigest) refuseSource("PRODUCTION_SOURCE_CHANGED_DURING_READ");
    if ((await authority()).digest !== before.digest) refuseSource("PRODUCTION_SOURCE_AUTHORITY_CHANGED");
    assertProductionSourceLeaseBudget(fresh.leaseValidThrough);
    const quietDigest = sourceDigest({ authority: before.digest, state: fresh.digest });
    if (baselineQuiet !== undefined && quietDigest !== baselineQuiet) refuseSource("PRODUCTION_SOURCE_QUIET_BASELINE_CHANGED");
    return { fresh, quietDigest };
  }
  function read(readOptions: ClutchpacksProductionSourceReadOptions = {}) {
    const lease = readOptions.expectedImportLease && { ...readOptions.expectedImportLease };
    return exclusive(async () => {
      assertOwned(lease);
      const before = await authority(), snapshot = await ports.snapshot(input, before, lease);
      const confirmed = await finishQuiet(before, snapshot.current.digest, lease);
      const fingerprint = sourceDigest({ quiet: confirmed.quietDigest, catalog: snapshot.catalog.catalogDigest });
      if (baselineFull !== undefined && baselineFull !== fingerprint) refuseSource("PRODUCTION_SOURCE_CATALOG_CHANGED");
      baselineQuiet = confirmed.quietDigest; baselineFull = fingerprint;
      return { facts: snapshot.catalog.facts, canonicalCatalog: snapshot.catalog.canonicalCatalog,
        sourceCheckpoint: snapshot.current.checkpoint, sourceObservation: snapshot.current.observation, stabilityFingerprint: fingerprint };
    });
  }
  function assertQuiet(readOptions: ClutchpacksProductionSourceReadOptions = {}) {
    const lease = readOptions.expectedImportLease && { ...readOptions.expectedImportLease };
    return exclusive(async () => {
      if (baselineQuiet === undefined) refuseSource("PRODUCTION_SOURCE_FULL_READ_REQUIRED");
      assertOwned(lease);
      const before = await authority(), current = await state(before, lease);
      const confirmed = await finishQuiet(before, current.digest, lease);
      return { sourceCheckpoint: confirmed.fresh.checkpoint, quietFingerprint: confirmed.quietDigest };
    });
  }
  async function leaseOperation<T>(operation: (repository: LeasePort) => Promise<T>, checkBefore: boolean): Promise<T> {
    const before = await authority();
    if (checkBefore) {
      if (baselineQuiet === undefined) refuseSource("PRODUCTION_SOURCE_FULL_READ_REQUIRED");
      await finishQuiet(before, (await state(before, ownedLease)).digest, ownedLease);
    }
    const result = await operation(ports.leases(before));
    if ((await authority()).digest !== before.digest) refuseSource("PRODUCTION_SOURCE_AUTHORITY_CHANGED");
    return result;
  }
  const leasePort: LeasePort = {
    acquire: original => { const request = { ...original }; return exclusive(async () => {
      if (request.role !== "import" || ownedLease) refuseSource("PRODUCTION_SOURCE_IMPORT_LEASE_INVALID");
      if (baselineQuiet === undefined) refuseSource("PRODUCTION_SOURCE_FULL_READ_REQUIRED");
      const before = await authority(), current = await state(before);
      await finishQuiet(before, current.digest);
      return acquireCheckedProductionSourceLease({ request, acquire: captured => ports.leases(before).acquire(captured),
        postcheck: async lease => { ownedLease = lease; await finishQuiet(before, current.digest, lease); },
        cleanup: async lease => {
          const cleanupAuthority = await authority();
          if (cleanupAuthority.digest !== before.digest) return false;
          const released = await ports.cleanup(input, cleanupAuthority, lease);
          if ((await authority()).digest !== before.digest) return false;
          if (released) ownedLease = undefined;
          return released;
        } });
    }); },
    renew: original => { const request = { ...original }; return exclusive(async () => {
      assertOwned(request);
      if (request.role !== "import") refuseSource("PRODUCTION_SOURCE_IMPORT_LEASE_INVALID");
      return leaseOperation(repository => repository.renew(request), true);
    }); },
    release: original => { const request = { ...original }; return exclusive(async () => {
      assertOwned(request);
      if (request.role !== "import") refuseSource("PRODUCTION_SOURCE_IMPORT_LEASE_INVALID");
      const released = await leaseOperation(repository => repository.release(request), false);
      if (released) ownedLease = undefined;
      return released;
    }); },
  };
  let closing: Promise<void> | undefined;
  function close() {
    closed = true;
    closing ??= (async () => {
      if (pending) await pending.catch(() => undefined);
      try { await ports.close(); } catch { refuseSource("PRODUCTION_SOURCE_CLOSE_UNAVAILABLE"); }
    })();
    return closing;
  }
  return Object.freeze({ read, assertQuiet, leasePort, close });
}
