import {
  CentralProviderObservationRepository,
  PrismaProviderActivityOutboxRepository,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
  type ProviderActivityBatch,
  type ProviderActivityEvent,
  type ProviderActivityRelayTarget,
  type ProviderLocalHealthObservation,
} from "@packscout/database";

export interface ProviderActivityRelayDirectory {
  listRelayTargets(limit: number): Promise<readonly ProviderActivityRelayTarget[]>;
  observeHealth(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly health: ProviderLocalHealthObservation;
  }): Promise<void>;
  acceptProviderActivity(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly event: ProviderActivityEvent;
    readonly health: ProviderLocalHealthObservation;
    readonly receivedAt: Date;
  }): Promise<{ readonly state: "accepted" | "deduplicated" }>;
  recordDirectProbe(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly state: "reachable" | "unreachable";
    readonly failureCode: string | null;
    readonly retryHint: string | null;
    readonly observedAt: Date;
  }): Promise<void>;
}

export interface ProviderActivityLocalStore {
  read(input: ProviderActivityRelayTarget & { readonly limit: number }): Promise<
    | { readonly state: "reachable"; readonly batch: ProviderActivityBatch }
    | {
        readonly state: "unreachable";
        readonly failureCode: string;
        readonly retryHint: string;
        readonly observedAt: Date;
      }
  >;
  markDelivered(
    target: ProviderActivityRelayTarget,
    event: ProviderActivityEvent,
    deliveredAt: Date,
  ): Promise<void>;
  markFailed(
    target: ProviderActivityRelayTarget,
    event: ProviderActivityEvent,
    attemptedAt: Date,
    failureCode: string,
  ): Promise<void>;
}

export interface ProviderActivityRelayCycleResult {
  readonly providers: number;
  readonly delivered: number;
  readonly deduplicated: number;
  readonly unreachable: number;
  readonly failures: number;
  readonly backpressured: number;
}

export interface ProviderActivityRelayObservability {
  log(input: Readonly<{
    level: "info" | "warning";
    event: "provider_activity_relay";
    providerId: string;
    outcome: string;
    failureCode: string | null;
  }>): void;
}

interface BackoffState {
  readonly failures: number;
  readonly retryAt: number;
}

const noopObservability: ProviderActivityRelayObservability = { log() {} };

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError("Provider activity relay bound is invalid.");
  }
  return resolved;
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await operation(values[index]!);
      }
    },
  ));
  return results;
}

/** Routes provider-owned outboxes without sharing a provider connection pool. */
export class GatewayProviderActivityLocalStore
implements ProviderActivityLocalStore {
  constructor(private readonly gateway: BoundedProviderDatabaseGateway) {}

  async read(
    input: ProviderActivityRelayTarget & { readonly limit: number },
  ): ReturnType<ProviderActivityLocalStore["read"]> {
    const result = await this.gateway.runWithProviderDatabase(
      { organizationId: input.organizationId, providerId: input.providerId },
      (database) => new PrismaProviderActivityOutboxRepository(database)
        .readPendingBatch({ providerId: input.providerId, limit: input.limit }),
    );
    return result.state === "reachable"
      ? { state: "reachable", batch: result.value }
      : {
          state: "unreachable",
          failureCode: result.failureCode.toUpperCase(),
          retryHint: result.retryHint,
          observedAt: new Date(result.observedAt),
        };
  }

  async markDelivered(
    target: ProviderActivityRelayTarget,
    event: ProviderActivityEvent,
    deliveredAt: Date,
  ): Promise<void> {
    const result = await this.gateway.runWithProviderDatabase(
      { organizationId: target.organizationId, providerId: target.providerId },
      (database) => new PrismaProviderActivityOutboxRepository(database)
        .markDelivered({
          eventId: event.id,
          eventDigest: event.eventDigest,
          deliveredAt,
        }),
    );
    if (result.state === "unreachable" || result.value === "not_found") {
      throw new Error("Provider activity delivery acknowledgement failed.");
    }
  }

  async markFailed(
    target: ProviderActivityRelayTarget,
    event: ProviderActivityEvent,
    attemptedAt: Date,
    failureCode: string,
  ): Promise<void> {
    const result = await this.gateway.runWithProviderDatabase(
      { organizationId: target.organizationId, providerId: target.providerId },
      (database) => new PrismaProviderActivityOutboxRepository(database)
        .markDeliveryFailed({
          eventId: event.id,
          eventDigest: event.eventDigest,
          attemptedAt,
          failureCode,
        }),
    );
    if (result.state === "unreachable") {
      throw new Error("Provider activity failure acknowledgement failed.");
    }
  }
}

export class ProviderActivityRelayCoordinator {
  readonly #batchSize: number;
  readonly #maximumProviders: number;
  readonly #concurrency: number;
  readonly #baseBackoffMs: number;
  readonly #maximumBackoffMs: number;
  readonly #clock: () => Date;
  readonly #observability: ProviderActivityRelayObservability;
  readonly #backoff = new Map<string, BackoffState>();
  #activeCycle: Promise<ProviderActivityRelayCycleResult> | null = null;

  constructor(private readonly dependencies: Readonly<{
    directory: ProviderActivityRelayDirectory;
    local: ProviderActivityLocalStore;
    batchSize?: number;
    maximumProviders?: number;
    maximumConcurrentProviders?: number;
    baseBackoffMilliseconds?: number;
    maximumBackoffMilliseconds?: number;
    clock?: () => Date;
    observability?: ProviderActivityRelayObservability;
  }>) {
    this.#batchSize = boundedInteger(dependencies.batchSize, 25, 1, 100);
    this.#maximumProviders = boundedInteger(
      dependencies.maximumProviders,
      100,
      1,
      1_000,
    );
    this.#concurrency = boundedInteger(
      dependencies.maximumConcurrentProviders,
      8,
      1,
      64,
    );
    this.#baseBackoffMs = boundedInteger(
      dependencies.baseBackoffMilliseconds,
      1_000,
      100,
      60_000,
    );
    this.#maximumBackoffMs = boundedInteger(
      dependencies.maximumBackoffMilliseconds,
      60_000,
      this.#baseBackoffMs,
      3_600_000,
    );
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#observability = dependencies.observability ?? noopObservability;
  }

  runCycle(): Promise<ProviderActivityRelayCycleResult> {
    if (this.#activeCycle) return this.#activeCycle;
    const cycle = this.executeCycle().finally(() => {
      if (this.#activeCycle === cycle) this.#activeCycle = null;
    });
    this.#activeCycle = cycle;
    return cycle;
  }

  private async executeCycle(): Promise<ProviderActivityRelayCycleResult> {
    let targets: readonly ProviderActivityRelayTarget[];
    try {
      targets = await this.dependencies.directory.listRelayTargets(
        this.#maximumProviders,
      );
    } catch {
      return {
        providers: 0,
        delivered: 0,
        deduplicated: 0,
        unreachable: 0,
        failures: 1,
        backpressured: 0,
      };
    }
    const now = this.#clock().getTime();
    const ready: ProviderActivityRelayTarget[] = [];
    let backpressured = 0;
    for (const target of targets) {
      const state = this.#backoff.get(target.providerId);
      if (state && state.retryAt > now) backpressured += 1;
      else ready.push(target);
    }
    const processed = await mapConcurrent(
      ready,
      this.#concurrency,
      (target) => this.processProvider(target),
    );
    return processed.reduce<ProviderActivityRelayCycleResult>(
      (total, result) => ({
        providers: total.providers + 1,
        delivered: total.delivered + result.delivered,
        deduplicated: total.deduplicated + result.deduplicated,
        unreachable: total.unreachable + result.unreachable,
        failures: total.failures + result.failures,
        backpressured: total.backpressured,
      }),
      {
        providers: 0,
        delivered: 0,
        deduplicated: 0,
        unreachable: 0,
        failures: 0,
        backpressured,
      },
    );
  }

  private async processProvider(
    target: ProviderActivityRelayTarget,
  ): Promise<Omit<ProviderActivityRelayCycleResult, "providers" | "backpressured">> {
    const empty = { delivered: 0, deduplicated: 0, unreachable: 0, failures: 0 };
    let read: Awaited<ReturnType<ProviderActivityLocalStore["read"]>>;
    try {
      read = await this.dependencies.local.read({
        ...target,
        limit: this.#batchSize,
      });
    } catch {
      this.fail(target.providerId, "PROVIDER_ACTIVITY_READ_FAILED");
      return { ...empty, failures: 1 };
    }
    if (read.state === "unreachable") {
      this.fail(target.providerId, read.failureCode);
      try {
        await this.dependencies.directory.recordDirectProbe({
          organizationId: target.organizationId,
          providerId: target.providerId,
          state: "unreachable",
          failureCode: read.failureCode,
          retryHint: read.retryHint,
          observedAt: read.observedAt,
        });
      } catch {
        // The provider remains isolated when the observer is unavailable.
      }
      return { ...empty, unreachable: 1 };
    }
    try {
      await this.dependencies.directory.recordDirectProbe({
        organizationId: target.organizationId,
        providerId: target.providerId,
        state: "reachable",
        failureCode: null,
        retryHint: null,
        observedAt: read.batch.health.observedAt,
      });
      await this.dependencies.directory.observeHealth({
        organizationId: target.organizationId,
        providerId: target.providerId,
        health: read.batch.health,
      });
    } catch {
      this.fail(target.providerId, "CENTRAL_OBSERVATION_UNAVAILABLE");
      return { ...empty, failures: 1 };
    }
    let delivered = 0;
    let deduplicated = 0;
    for (const event of read.batch.events) {
      const attemptedAt = this.#clock();
      try {
        const accepted = await this.dependencies.directory.acceptProviderActivity({
          organizationId: target.organizationId,
          providerId: target.providerId,
          event,
          health: read.batch.health,
          receivedAt: attemptedAt,
        });
        await this.dependencies.local.markDelivered(target, event, attemptedAt);
        if (accepted.state === "accepted") delivered += 1;
        else deduplicated += 1;
      } catch {
        await this.dependencies.local.markFailed(
          target,
          event,
          attemptedAt,
          "CENTRAL_ACTIVITY_UNAVAILABLE",
        ).catch(() => undefined);
        this.fail(target.providerId, "CENTRAL_ACTIVITY_UNAVAILABLE");
        return { delivered, deduplicated, unreachable: 0, failures: 1 };
      }
    }
    this.#backoff.delete(target.providerId);
    this.#observability.log({
      level: "info",
      event: "provider_activity_relay",
      providerId: target.providerId,
      outcome: "delivered",
      failureCode: null,
    });
    return { delivered, deduplicated, unreachable: 0, failures: 0 };
  }

  private fail(providerId: string, failureCode: string): void {
    const previous = this.#backoff.get(providerId)?.failures ?? 0;
    const failures = Math.min(previous + 1, 20);
    const delay = Math.min(
      this.#maximumBackoffMs,
      this.#baseBackoffMs * 2 ** Math.min(failures - 1, 10),
    );
    this.#backoff.set(providerId, {
      failures,
      retryAt: this.#clock().getTime() + delay,
    });
    this.#observability.log({
      level: "warning",
      event: "provider_activity_relay",
      providerId,
      outcome: "failed",
      failureCode,
    });
  }
}

/** Production composition seam for the central observer and routed outboxes. */
export function createProviderActivityRelayCoordinator(input: Readonly<{
  central: CentralPrismaClient;
  gateway: BoundedProviderDatabaseGateway;
  batchSize?: number;
  maximumProviders?: number;
  maximumConcurrentProviders?: number;
  baseBackoffMilliseconds?: number;
  maximumBackoffMilliseconds?: number;
  clock?: () => Date;
  observability?: ProviderActivityRelayObservability;
}>): ProviderActivityRelayCoordinator {
  return new ProviderActivityRelayCoordinator({
    directory: new CentralProviderObservationRepository(input.central),
    local: new GatewayProviderActivityLocalStore(input.gateway),
    ...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
    ...(input.maximumProviders === undefined
      ? {}
      : { maximumProviders: input.maximumProviders }),
    ...(input.maximumConcurrentProviders === undefined
      ? {}
      : { maximumConcurrentProviders: input.maximumConcurrentProviders }),
    ...(input.baseBackoffMilliseconds === undefined
      ? {}
      : { baseBackoffMilliseconds: input.baseBackoffMilliseconds }),
    ...(input.maximumBackoffMilliseconds === undefined
      ? {}
      : { maximumBackoffMilliseconds: input.maximumBackoffMilliseconds }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.observability === undefined
      ? {}
      : { observability: input.observability }),
  });
}
