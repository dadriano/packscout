import type {
  ProviderDatabaseFailureCode,
  ProviderDatabaseGatewayOutcome,
} from "@packscout/contracts";
import { isIP } from "node:net";
import type { CentralDatabaseLifecycle } from "./central-database.ts";
import {
  assertDatabaseUuid,
  providerDatabaseTarget,
} from "./database-topology.ts";
import {
  createProviderDatabaseLifecycle,
  type ProviderDatabaseLifecycle,
  type ProviderPrismaClient,
} from "./provider-database.ts";
import {
  ProviderDatabaseDestinationPolicy,
  ProviderDatabaseDestinationPolicyError,
} from "./provider-database-destination-policy.ts";
import {
  locateProviderAdminDatabase,
  locateProviderActivationTestDatabase,
  locateProviderDatabase,
  providerDatabaseRouteFingerprint,
  type ProviderDatabaseRoute,
  type ProviderDatabaseRouteResult,
} from "./provider-database-locator.ts";

export interface ResolvedProviderDatabaseCredential {
  readonly username: string;
  readonly password: string;
}

export interface ProviderDatabaseCredentialResolver {
  resolve(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly credentialVersionId: string;
    readonly encryptedCredential: ProviderDatabaseRoute["node"]["encryptedCredential"];
  }): Promise<ResolvedProviderDatabaseCredential>;
}

export interface BoundedProviderDatabaseGatewayOptions {
  readonly central: CentralDatabaseLifecycle;
  readonly credentialResolver: ProviderDatabaseCredentialResolver;
  readonly destinationPolicy: ProviderDatabaseDestinationPolicy;
  readonly createLifecycle?: (input: {
    readonly databaseUrl: string;
    readonly providerId: string;
    readonly providerKey: string;
    readonly connectionLimit: number;
  }) => ProviderDatabaseLifecycle;
  readonly connectionLimitPerProvider?: number;
  readonly maximumCachedProviders?: number;
  readonly idleLifetimeMs?: number;
  readonly connectionTimeoutMs?: number;
  /** Only atomic import pages may opt into a longer operation window. */
  readonly operationProfile?: "standard" | "atomic_import_page";
  readonly operationTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly now?: () => Date;
}

export type ProviderDatabaseOperationResult<T> =
  | {
      readonly state: "reachable";
      readonly providerId: string;
      readonly value: T;
      readonly observedAt: string;
    }
  | Extract<ProviderDatabaseGatewayOutcome, { state: "unreachable" }>;

interface CachedProviderLifecycle {
  readonly fingerprint: string;
  readonly lifecycle: ProviderDatabaseLifecycle;
  state: "starting" | "ready" | "retiring";
  references: number;
  lastUsedAt: number;
  retireFailureCode: ProviderDatabaseFailureCode;
  closePromise?: Promise<boolean>;
}

interface PendingProviderAcquisition {
  readonly fingerprint: string;
  readonly promise: Promise<Extract<ProviderDatabaseGatewayOutcome, { state: "unreachable" }> | null>;
}

type TimedSettlement<T> =
  | { readonly state: "fulfilled"; readonly value: T }
  | { readonly state: "rejected" }
  | { readonly state: "timed_out" };

function settleBefore<T>(promise: Promise<T>, deadline: number): Promise<TimedSettlement<T>> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    void promise.then(() => undefined, () => undefined);
    return Promise.resolve({ state: "timed_out" });
  }
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve({ state: "timed_out" });
    }, remainingMs);
    void promise.then(
      (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ state: "fulfilled", value });
      },
      () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ state: "rejected" });
      },
    );
  });
}

const retryHints: Readonly<Record<ProviderDatabaseFailureCode, string>> = {
  destination_not_allowed: "Review the provider database destination policy.",
  credential_unavailable: "Rotate or restore the provider database credential.",
  database_unreachable: "Verify provider database reachability and retry.",
  database_identity_missing: "Initialize the provider database identity and retry.",
  database_name_mismatch: "Verify the provider database name and topology.",
  database_role_mismatch: "Route this provider to a provider-role database.",
  database_schema_mismatch: "Deploy the required provider schema version.",
  provider_identity_mismatch: "Verify the provider database identity binding.",
  route_changed: "Refresh the provider configuration and retry the test.",
};

function routeFailure(
  providerId: string,
  now: Date,
  route: Extract<ProviderDatabaseRouteResult, { state: "unavailable" }>,
): Extract<ProviderDatabaseGatewayOutcome, { state: "unreachable" }> {
  const failureCode: ProviderDatabaseFailureCode =
    route.failureCode === "PROVIDER_DATABASE_CREDENTIAL_UNAVAILABLE"
      ? "credential_unavailable"
      : route.failureCode === "PROVIDER_DATABASE_NAME_MISMATCH"
        ? "database_name_mismatch"
        : route.failureCode === "PROVIDER_CONFIG_VERSION_CONFLICT"
          || route.failureCode === "PROVIDER_ROW_VERSION_CONFLICT"
          || route.failureCode === "PROVIDER_CONFIG_EXPIRED"
          || route.failureCode === "PROVIDER_NOT_ROUTABLE"
          ? "route_changed"
          : "database_unreachable";
  return {
    state: "unreachable",
    providerId,
    failureCode,
    observedAt: now.toISOString(),
    retryHint: retryHints[failureCode],
  };
}

function readinessFailureCode(code: string): ProviderDatabaseFailureCode {
  switch (code) {
    case "DATABASE_IDENTITY_MISSING": return "database_identity_missing";
    case "DATABASE_NAME_MISMATCH": return "database_name_mismatch";
    case "DATABASE_ROLE_MISMATCH": return "database_role_mismatch";
    case "DATABASE_SCHEMA_MISMATCH": return "database_schema_mismatch";
    case "PROVIDER_IDENTITY_MISMATCH": return "provider_identity_mismatch";
    default: return "database_unreachable";
  }
}

function unavailable(
  providerId: string,
  now: Date,
  failureCode: ProviderDatabaseFailureCode,
): Extract<ProviderDatabaseGatewayOutcome, { state: "unreachable" }> {
  return {
    state: "unreachable",
    providerId,
    failureCode,
    observedAt: now.toISOString(),
    retryHint: retryHints[failureCode],
  };
}

function databaseUrl(
  route: ProviderDatabaseRoute,
  credential: ResolvedProviderDatabaseCredential,
  connectionTimeoutMs: number,
): string {
  const host = isIP(route.node.host) === 6
    ? `[${route.node.host}]`
    : route.node.host;
  const url = new URL(`postgresql://${host}:${route.node.port}`);
  url.username = credential.username;
  url.password = credential.password;
  url.pathname = `/${route.target.databaseName}`;
  url.searchParams.set("sslmode", route.node.sslMode);
  url.searchParams.set("connect_timeout", String(Math.max(1, Math.ceil(connectionTimeoutMs / 1_000))));
  return url.toString();
}

function assertCachedRoute(route: ProviderDatabaseRoute): void {
  assertDatabaseUuid(route.target.providerId, "Provider ID");
  assertDatabaseUuid(route.organizationId, "Organization ID");
  assertDatabaseUuid(route.configVersionId, "Configuration version ID");
  assertDatabaseUuid(route.node.nodeId, "Database node ID");
  assertDatabaseUuid(
    route.node.credentialVersionId,
    "Database credential version ID",
  );
  const expected = providerDatabaseTarget({
    providerId: route.target.providerId,
    providerKey: route.target.providerKey,
  });
  if (
    route.target.databaseRole !== expected.databaseRole
    || route.target.databaseName !== expected.databaseName
    || route.target.schemaVersion !== expected.schemaVersion
    || route.providerRowVersion < 1n
    || route.topologyVersion < 0n
    || route.node.rowVersion < 1n
    || route.node.encryptedCredential.ciphertext.byteLength < 1
    || route.node.encryptedCredential.nonce.byteLength !== 12
    || route.node.encryptedCredential.authTag.byteLength !== 16
    || !Number.isInteger(route.node.encryptedCredential.keyVersion)
    || route.node.encryptedCredential.keyVersion < 1
  ) {
    throw new TypeError("Cached provider database route is invalid.");
  }
}

export class BoundedProviderDatabaseGateway {
  readonly #createLifecycle: NonNullable<BoundedProviderDatabaseGatewayOptions["createLifecycle"]>;
  readonly #connectionLimit: number;
  readonly #maximumCachedProviders: number;
  readonly #idleLifetimeMs: number;
  readonly #connectionTimeoutMs: number;
  readonly #operationTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #now: () => Date;
  readonly #cache = new Map<string, CachedProviderLifecycle>();
  readonly #acquisitions = new Map<string, PendingProviderAcquisition>();
  #closed = false;

  constructor(private readonly options: BoundedProviderDatabaseGatewayOptions) {
    this.#createLifecycle = options.createLifecycle
      ?? ((input) => createProviderDatabaseLifecycle(input));
    this.#connectionLimit = options.connectionLimitPerProvider ?? 4;
    this.#maximumCachedProviders = options.maximumCachedProviders ?? 16;
    this.#idleLifetimeMs = options.idleLifetimeMs ?? 60_000;
    this.#connectionTimeoutMs = options.connectionTimeoutMs ?? 10_000;
    this.#operationTimeoutMs = options.operationTimeoutMs ?? 10_000;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.#now = options.now ?? (() => new Date());
    const operationProfile = options.operationProfile ?? "standard";
    if (
      (operationProfile !== "standard" && operationProfile !== "atomic_import_page")
      || !Number.isInteger(this.#connectionLimit)
      || this.#connectionLimit < 1
      || this.#connectionLimit > 16
      || !Number.isInteger(this.#maximumCachedProviders)
      || this.#maximumCachedProviders < 1
      || this.#maximumCachedProviders > 128
      || !Number.isInteger(this.#idleLifetimeMs)
      || this.#idleLifetimeMs < 1_000
      || this.#idleLifetimeMs > 3_600_000
      || !Number.isInteger(this.#connectionTimeoutMs)
      || this.#connectionTimeoutMs < 100
      || this.#connectionTimeoutMs > 60_000
      || !Number.isInteger(this.#operationTimeoutMs)
      || this.#operationTimeoutMs < 100
      || this.#operationTimeoutMs > (operationProfile === "atomic_import_page" ? 600_000 : 60_000)
      || !Number.isInteger(this.#closeTimeoutMs)
      || this.#closeTimeoutMs < 100
      || this.#closeTimeoutMs > 60_000
    ) {
      throw new TypeError("Provider database gateway bounds are invalid.");
    }
  }

  assertDestinationAllowed(input: {
    readonly host: string;
    readonly port: number;
    readonly sslMode: "disable" | "require" | "verify-ca" | "verify-full";
  }): void {
    this.options.destinationPolicy.assertAllowed(input);
  }

  async testActivationTarget(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly configVersionId: string;
    readonly expectedRowVersion: bigint;
  }): Promise<ProviderDatabaseGatewayOutcome> {
    if (this.#closed) {
      return unavailable(input.providerId, this.#now(), "database_unreachable");
    }
    const deadline = Date.now() + this.#operationTimeoutMs;
    const started = await settleBefore(
      Promise.resolve().then(() => this.options.central.start()),
      deadline,
    );
    if (started.state !== "fulfilled") {
      return unavailable(input.providerId, this.#now(), "database_unreachable");
    }
    const located = await settleBefore(locateProviderActivationTestDatabase(
      this.options.central.client,
      {
        organizationId: input.organizationId,
        providerId: input.providerId,
        expectedConfigVersionId: input.configVersionId,
        expectedRowVersion: input.expectedRowVersion,
        now: this.#now(),
      },
    ), deadline);
    if (located.state !== "fulfilled") {
      return unavailable(input.providerId, this.#now(), "database_unreachable");
    }
    const initial = located.value;
    if (initial.state === "unavailable") {
      return routeFailure(input.providerId, this.#now(), initial);
    }
    const lifecycle = await this.createRouteLifecycle(initial.route, deadline);
    if ("state" in lifecycle) return lifecycle;
    try {
      const settledReadiness = await settleBefore(
        Promise.resolve().then(() => lifecycle.readiness()),
        deadline,
      );
      if (settledReadiness.state !== "fulfilled") {
        return unavailable(input.providerId, this.#now(), "database_unreachable");
      }
      const readiness = settledReadiness.value;
      if (readiness.state === "unavailable") {
        return unavailable(
          input.providerId,
          readiness.observedAt,
          readinessFailureCode(readiness.failureCode),
        );
      }
      const settledConfirmation = await settleBefore(locateProviderActivationTestDatabase(
        this.options.central.client,
        {
          organizationId: input.organizationId,
          providerId: input.providerId,
          expectedConfigVersionId: input.configVersionId,
          expectedRowVersion: input.expectedRowVersion,
          now: this.#now(),
        },
      ), deadline);
      if (
        settledConfirmation.state !== "fulfilled"
      ) {
        return unavailable(input.providerId, this.#now(), "database_unreachable");
      }
      const confirmed = settledConfirmation.value;
      if (
        confirmed.state === "unavailable"
        || providerDatabaseRouteFingerprint(confirmed.route)
          !== providerDatabaseRouteFingerprint(initial.route)
      ) {
        return unavailable(input.providerId, this.#now(), "route_changed");
      }
      return {
        state: "reachable",
        providerId: input.providerId,
        observedSchemaVersion: readiness.observedSchemaVersion,
        observedAt: readiness.observedAt.toISOString(),
      };
    } finally {
      await settleBefore(
        Promise.resolve().then(() => lifecycle.close()),
        Date.now() + this.#closeTimeoutMs,
      );
    }
  }

  async runWithProviderDatabase<T>(
    input: { readonly organizationId: string; readonly providerId: string },
    operation: (database: ProviderPrismaClient) => Promise<T>,
  ): Promise<ProviderDatabaseOperationResult<T>> {
    if (this.#closed) {
      return unavailable(input.providerId, this.#now(), "database_unreachable");
    }
    const deadline = Date.now() + this.#operationTimeoutMs;
    this.evictIdle();
    const started = await settleBefore(
      Promise.resolve().then(() => this.options.central.start()),
      deadline,
    );
    if (started.state !== "fulfilled") {
      return unavailable(input.providerId, this.#now(), "database_unreachable");
    }
    const settledRoute = await settleBefore(
      locateProviderDatabase(this.options.central.client, input),
      deadline,
    );
    if (settledRoute.state !== "fulfilled") {
      return unavailable(input.providerId, this.#now(), "database_unreachable");
    }
    const located = settledRoute.value;
    if (located.state === "unavailable") {
      return routeFailure(input.providerId, this.#now(), located);
    }
    return this.runWithRoute(located.route, operation, deadline);
  }

  async runWithAdminProviderDatabase<T>(
    input: { readonly organizationId: string; readonly providerId: string },
    operation: (database: ProviderPrismaClient) => Promise<T>,
  ): Promise<ProviderDatabaseOperationResult<T>> {
    if (this.#closed) {
      return unavailable(input.providerId, this.#now(), "database_unreachable");
    }
    const deadline = Date.now() + this.#operationTimeoutMs;
    this.evictIdle();
    const started = await settleBefore(
      Promise.resolve().then(() => this.options.central.start()),
      deadline,
    );
    if (started.state !== "fulfilled") {
      return unavailable(input.providerId, this.#now(), "database_unreachable");
    }
    const settledRoute = await settleBefore(
      locateProviderAdminDatabase(this.options.central.client, input),
      deadline,
    );
    if (settledRoute.state !== "fulfilled") {
      return unavailable(input.providerId, this.#now(), "database_unreachable");
    }
    const located = settledRoute.value;
    if (located.state === "unavailable") {
      return routeFailure(input.providerId, this.#now(), located);
    }
    return this.runWithRoute(located.route, operation, deadline);
  }

  /**
   * Executes against an exact central-authorized route already held in this
   * process. This is the provider-local continuity seam: it deliberately does
   * not query central, but still re-applies destination, credential, readiness,
   * capacity, timeout, and provider-identity checks before exposing a client.
   */
  async runWithCachedProviderDatabase<T>(
    route: ProviderDatabaseRoute,
    operation: (database: ProviderPrismaClient) => Promise<T>,
  ): Promise<ProviderDatabaseOperationResult<T>> {
    try {
      assertCachedRoute(route);
    } catch {
      return unavailable(route.target.providerId, this.#now(), "route_changed");
    }
    if (this.#closed) {
      return unavailable(route.target.providerId, this.#now(), "database_unreachable");
    }
    const deadline = Date.now() + this.#operationTimeoutMs;
    this.evictIdle();
    return this.runWithRoute(route, operation, deadline);
  }

  private async runWithRoute<T>(
    route: ProviderDatabaseRoute,
    operation: (database: ProviderPrismaClient) => Promise<T>,
    deadline: number,
  ): Promise<ProviderDatabaseOperationResult<T>> {
    const acquired = await this.acquire(route, deadline);
    if (acquired.state === "unreachable") return acquired;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.release(route.target.providerId, acquired);
    };
    const operationPromise = Promise.resolve().then(() =>
      operation(acquired.lifecycle.client)
    );
    const settledOperation = await settleBefore(operationPromise, deadline);
    if (settledOperation.state === "timed_out") {
      acquired.state = "retiring";
      acquired.retireFailureCode = "database_unreachable";
      void operationPromise.then(release, release);
      return unavailable(route.target.providerId, this.#now(), "database_unreachable");
    }
    release();
    if (settledOperation.state === "fulfilled") {
      return {
        state: "reachable",
        providerId: route.target.providerId,
        value: settledOperation.value,
        observedAt: this.#now().toISOString(),
      };
    }
    return unavailable(route.target.providerId, this.#now(), "database_unreachable");
  }

  async close(): Promise<void> {
    this.#closed = true;
    const deadline = Date.now() + this.#closeTimeoutMs;
    await Promise.all([...this.#acquisitions.values()].map(({ promise }) =>
      settleBefore(promise, deadline)
    ));
    const entries = [...this.#cache.entries()];
    for (const [, entry] of entries) {
      entry.state = "retiring";
      entry.retireFailureCode = "database_unreachable";
      this.beginClose(entry);
    }
    await Promise.all(entries.map(([, entry]) =>
      this.awaitClose(entry, deadline)
    ));
  }

  private async createRouteLifecycle(
    route: ProviderDatabaseRoute,
    deadline: number,
  ): Promise<ProviderDatabaseLifecycle | Extract<ProviderDatabaseGatewayOutcome, { state: "unreachable" }>> {
    try {
      this.options.destinationPolicy.assertAllowed(route.node);
    } catch (error) {
      if (error instanceof ProviderDatabaseDestinationPolicyError) {
        return unavailable(route.target.providerId, this.#now(), "destination_not_allowed");
      }
      throw error;
    }
    const credentialResult = await settleBefore(
      Promise.resolve().then(() => this.options.credentialResolver.resolve({
        organizationId: route.organizationId,
        providerId: route.target.providerId,
        credentialVersionId: route.node.credentialVersionId,
        encryptedCredential: route.node.encryptedCredential,
      })),
      deadline,
    );
    if (credentialResult.state !== "fulfilled") {
      return unavailable(route.target.providerId, this.#now(), "credential_unavailable");
    }
    try {
      return this.#createLifecycle({
        databaseUrl: databaseUrl(
          route,
          credentialResult.value,
          this.#connectionTimeoutMs,
        ),
        providerId: route.target.providerId,
        providerKey: route.target.providerKey,
        connectionLimit: this.#connectionLimit,
      });
    } catch {
      return unavailable(route.target.providerId, this.#now(), "database_unreachable");
    }
  }

  private async acquire(
    route: ProviderDatabaseRoute,
    deadline: number,
  ): Promise<CachedProviderLifecycle | Extract<ProviderDatabaseGatewayOutcome, { state: "unreachable" }>> {
    const fingerprint = providerDatabaseRouteFingerprint(route);
    while (Date.now() < deadline) {
      if (this.#closed) {
        return unavailable(route.target.providerId, this.#now(), "database_unreachable");
      }
      const pending = this.#acquisitions.get(route.target.providerId);
      if (pending) {
        const settled = await settleBefore(pending.promise, deadline);
        if (settled.state !== "fulfilled") {
          return unavailable(route.target.providerId, this.#now(), "database_unreachable");
        }
        if (settled.value) return settled.value;
        continue;
      }
      const existing = this.#cache.get(route.target.providerId);
      if (existing?.state === "ready" && existing.fingerprint === fingerprint) {
        existing.references += 1;
        existing.lastUsedAt = this.#now().getTime();
        return existing;
      }
      if (existing) {
        if (existing.state !== "retiring") {
          existing.state = "retiring";
          existing.retireFailureCode = existing.fingerprint === fingerprint
            ? "database_unreachable"
            : "route_changed";
        }
        if (existing.references > 0) {
          return unavailable(
            route.target.providerId,
            this.#now(),
            existing.retireFailureCode,
          );
        }
        this.beginClose(existing);
        if (!await this.awaitClose(existing, deadline)) {
          return unavailable(
            route.target.providerId,
            this.#now(),
            existing.retireFailureCode,
          );
        }
        continue;
      }
      const acquisition = this.beginAcquisition(route, fingerprint, deadline);
      const settled = await settleBefore(acquisition.promise, deadline);
      if (settled.state !== "fulfilled") {
        return unavailable(route.target.providerId, this.#now(), "database_unreachable");
      }
      if (settled.value) return settled.value;
    }
    return unavailable(route.target.providerId, this.#now(), "database_unreachable");
  }

  private beginAcquisition(
    route: ProviderDatabaseRoute,
    fingerprint: string,
    deadline: number,
  ): PendingProviderAcquisition {
    let resolve!: (
      result: Extract<ProviderDatabaseGatewayOutcome, { state: "unreachable" }> | null,
    ) => void;
    const promise = new Promise<Extract<ProviderDatabaseGatewayOutcome, { state: "unreachable" }> | null>(
      (complete) => { resolve = complete; },
    );
    const acquisition = { fingerprint, promise };
    this.#acquisitions.set(route.target.providerId, acquisition);
    void this.initializeAcquisition(route, fingerprint, deadline).then(
      (result) => {
        if (this.#acquisitions.get(route.target.providerId) === acquisition) {
          this.#acquisitions.delete(route.target.providerId);
        }
        resolve(result);
      },
      () => {
        if (this.#acquisitions.get(route.target.providerId) === acquisition) {
          this.#acquisitions.delete(route.target.providerId);
        }
        resolve(unavailable(route.target.providerId, this.#now(), "database_unreachable"));
      },
    );
    return acquisition;
  }

  private async initializeAcquisition(
    route: ProviderDatabaseRoute,
    fingerprint: string,
    deadline: number,
  ): Promise<Extract<ProviderDatabaseGatewayOutcome, { state: "unreachable" }> | null> {
    if (!await this.prepareCapacity(route.target.providerId, deadline)) {
      return unavailable(route.target.providerId, this.#now(), "database_unreachable");
    }
    const lifecycle = await this.createRouteLifecycle(route, deadline);
    if ("state" in lifecycle) return lifecycle;
    const entry: CachedProviderLifecycle = {
      fingerprint,
      lifecycle,
      state: "starting",
      references: 0,
      lastUsedAt: this.#now().getTime(),
      retireFailureCode: "database_unreachable",
    };
    this.#cache.set(route.target.providerId, entry);
    const readinessResult = await settleBefore(
      Promise.resolve().then(() => lifecycle.readiness()),
      deadline,
    );
    if (
      readinessResult.state !== "fulfilled"
      || readinessResult.value.state === "unavailable"
      || this.#closed
    ) {
      entry.state = "retiring";
      const failureCode = readinessResult.state === "fulfilled"
        && readinessResult.value.state === "unavailable"
        ? readinessFailureCode(readinessResult.value.failureCode)
        : "database_unreachable";
      entry.retireFailureCode = failureCode;
      this.beginClose(entry);
      await this.awaitClose(entry, Date.now() + this.#closeTimeoutMs);
      return unavailable(
        route.target.providerId,
        readinessResult.state === "fulfilled"
          ? readinessResult.value.observedAt
          : this.#now(),
        failureCode,
      );
    }
    entry.state = "ready";
    return null;
  }

  private async prepareCapacity(
    providerId: string,
    deadline: number,
  ): Promise<boolean> {
    while (this.usedCapacity() > this.#maximumCachedProviders) {
      const oldest = [...this.#cache.entries()]
        .filter(([candidateProviderId, entry]) =>
          candidateProviderId !== providerId
          && entry.state === "ready"
          && entry.references === 0
        )
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (!oldest) return false;
      oldest[1].state = "retiring";
      oldest[1].retireFailureCode = "database_unreachable";
      this.beginClose(oldest[1]);
      if (!await this.awaitClose(oldest[1], deadline)) return false;
    }
    return true;
  }

  private usedCapacity(): number {
    let reservations = 0;
    for (const providerId of this.#acquisitions.keys()) {
      if (!this.#cache.has(providerId)) reservations += 1;
    }
    return this.#cache.size + reservations;
  }

  private release(providerId: string, entry: CachedProviderLifecycle): void {
    if (entry.references > 0) entry.references -= 1;
    entry.lastUsedAt = this.#now().getTime();
    if (entry.references === 0 && entry.state === "retiring") {
      this.beginClose(entry);
      void this.awaitClose(entry, Date.now() + this.#closeTimeoutMs);
    }
    if (this.#cache.get(providerId) !== entry && entry.references === 0) {
      this.beginClose(entry);
    }
  }

  private beginClose(entry: CachedProviderLifecycle): void {
    entry.state = "retiring";
    if (entry.references > 0 || entry.closePromise) return;
    entry.closePromise = Promise.resolve()
      .then(() => entry.lifecycle.close())
      .then(
        () => {
          for (const [providerId, cached] of this.#cache) {
            if (cached === entry) this.#cache.delete(providerId);
          }
          return true;
        },
        () => false,
      );
  }

  private async awaitClose(
    entry: CachedProviderLifecycle,
    deadline: number,
  ): Promise<boolean> {
    this.beginClose(entry);
    if (!entry.closePromise) return false;
    const closeDeadline = Math.min(deadline, Date.now() + this.#closeTimeoutMs);
    const settled = await settleBefore(entry.closePromise, closeDeadline);
    return settled.state === "fulfilled" && settled.value;
  }

  private evictIdle(): void {
    const cutoff = this.#now().getTime() - this.#idleLifetimeMs;
    const expired = [...this.#cache.entries()]
      .filter(([, value]) =>
        value.state === "ready"
        && value.references === 0
        && value.lastUsedAt <= cutoff
      );
    for (const [, value] of expired) {
      value.state = "retiring";
      value.retireFailureCode = "database_unreachable";
      this.beginClose(value);
    }
  }
}
