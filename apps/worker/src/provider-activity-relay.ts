import {
  CentralProviderObservationRepository,
  PrismaProviderActivityOutboxRepository,
  PrismaProviderPromotionInvocationProjectionRepository,
  PrismaProviderPromotionJobRepository,
  ProviderReleasePublicationRepository,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
  type ProjectProviderPromotionInvocationInput,
  type ManifestPromotionImmediateDeliveryPort,
  type ProviderActivityBatch,
  type ProviderActivityRelayCursor,
  type ProviderActivityEvent,
  type ProviderActivityRelayTarget,
  type ProviderActivityRelayTargetPage,
  type ProviderActivityObservationReceipt,
  type ProviderLocalHealthObservation,
  type ProviderCompletedPublishPlanRelayProof,
  type ProviderPromotionInvocationProjection,
  type ProviderPromotionProjectionRelayReceipt,
} from "@packscout/database";
import { buildProviderCompletedPublishPlanRelayProof } from
  "@packscout/services";
import {
  promotionImmediateDeliveryTimeout,
  waitForPromotionImmediateDelivery,
} from "./promotion-immediate-delivery-timeout.ts";

export type ProviderActivityRelayAcceptance = Readonly<{
  readonly state: "accepted" | "deduplicated";
  readonly completionGate?: ProviderActivityObservationReceipt["completionGate"];
}>;

/**
 * Generic low-latency hint. Durable central gate state remains authoritative,
 * so implementations may drop or duplicate this request safely.
 */
export type PromotionJobImmediateDeliveryPort =
  ManifestPromotionImmediateDeliveryPort;

export interface ProviderActivityRelayDirectory {
  listRelayTargets(input: {
    readonly limit: number;
    readonly after: ProviderActivityRelayCursor | null;
    readonly providerId?: string;
  }): Promise<ProviderActivityRelayTargetPage>;
  observeReachableHealth(input: {
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
    readonly completionProof?: ProviderCompletedPublishPlanRelayProof;
  }): Promise<ProviderActivityRelayAcceptance>;
  recordDirectProbe(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly state: "reachable" | "unreachable";
    readonly failureCode: string | null;
    readonly retryHint: string | null;
    readonly observedAt: Date;
  }): Promise<void>;
}

export interface ProviderPromotionInvocationProjectionRelay {
  project(
    input: ProjectProviderPromotionInvocationInput,
  ): Promise<ProviderPromotionInvocationProjection>;
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
  loadCompletionProof?(
    target: ProviderActivityRelayTarget,
    event: ProviderActivityEvent,
  ): Promise<ProviderCompletedPublishPlanRelayProof>;
  loadPromotionProjection?(
    target: ProviderActivityRelayTarget,
    event: ProviderActivityEvent,
    projectedAt: Date,
  ): Promise<ProjectProviderPromotionInvocationInput>;
  markDelivered(
    target: ProviderActivityRelayTarget,
    event: ProviderActivityEvent,
    deliveredAt: Date,
    projected?: ProviderPromotionProjectionRelayReceipt,
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
const digestPattern = /^[0-9a-f]{64}$/u;

function completionGateFromAcceptance(
  target: ProviderActivityRelayTarget,
  event: ProviderActivityEvent,
  acceptance: ProviderActivityRelayAcceptance,
): NonNullable<ProviderActivityRelayAcceptance["completionGate"]> | null {
  const gate = acceptance.completionGate ?? null;
  if (event.eventType !== "provider_release_completed") {
    if (gate !== null) {
      throw new Error("Provider activity acceptance scope is invalid.");
    }
    return null;
  }
  if (
    gate === null
    || gate.providerId !== target.providerId
    || gate.observedCompletionGeneration < 1n
    || gate.requestedGeneration < 1n
    || gate.manifestWakeGeneration < 1n
    || gate.acknowledgedGeneration < 0n
    || gate.acknowledgedGeneration > gate.requestedGeneration
    || gate.pending !==
      (gate.requestedGeneration > gate.acknowledgedGeneration)
    || !digestPattern.test(gate.evidenceDigest)
  ) {
    throw new Error("Provider completion acceptance scope is invalid.");
  }
  return gate;
}

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
    const result = await this.gateway.runWithAdminProviderDatabase(
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
    projected?: ProviderPromotionProjectionRelayReceipt,
  ): Promise<void> {
    const result = await this.gateway.runWithAdminProviderDatabase(
      { organizationId: target.organizationId, providerId: target.providerId },
      (database) => event.eventType ===
          "provider_promotion_invocation_terminal"
        ? projected === undefined
          ? Promise.reject(new Error(
              "Provider promotion projection receipt is unavailable.",
            ))
          : new PrismaProviderPromotionJobRepository(database)
              .acknowledgeProjectionDelivery({
                providerId: target.providerId,
                event,
                projected,
                deliveredAt,
              })
        : new PrismaProviderActivityOutboxRepository(database)
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

  async loadCompletionProof(
    target: ProviderActivityRelayTarget,
    event: ProviderActivityEvent,
  ): Promise<ProviderCompletedPublishPlanRelayProof> {
    const result = await this.gateway.runWithAdminProviderDatabase(
      { organizationId: target.organizationId, providerId: target.providerId },
      async (database) => buildProviderCompletedPublishPlanRelayProof(
        await new ProviderReleasePublicationRepository(database)
          .loadCompletedPublishPlanSource({ event }),
      ),
    );
    if (result.state === "unreachable") {
      throw new Error("Provider completion plan proof is unavailable.");
    }
    return result.value;
  }

  async loadPromotionProjection(
    target: ProviderActivityRelayTarget,
    event: ProviderActivityEvent,
    projectedAt: Date,
  ): Promise<ProjectProviderPromotionInvocationInput> {
    const result = await this.gateway.runWithAdminProviderDatabase(
      { organizationId: target.organizationId, providerId: target.providerId },
      (database) => new PrismaProviderPromotionJobRepository(database)
        .loadProjectionForRelay({
          providerId: target.providerId,
          event,
          projectedAt,
        }),
    );
    if (result.state === "unreachable") {
      throw new Error("Provider promotion projection is unavailable.");
    }
    return result.value;
  }

  async markFailed(
    target: ProviderActivityRelayTarget,
    event: ProviderActivityEvent,
    attemptedAt: Date,
    failureCode: string,
  ): Promise<void> {
    const result = await this.gateway.runWithAdminProviderDatabase(
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
  readonly #immediateDeliveryTimeoutMilliseconds: number;
  readonly #observability: ProviderActivityRelayObservability;
  readonly #backoff = new Map<string, BackoffState>();
  #cursor: ProviderActivityRelayCursor | null = null;
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
    immediateDelivery?: PromotionJobImmediateDeliveryPort;
    immediateDeliveryTimeoutMilliseconds?: number;
    projections?: ProviderPromotionInvocationProjectionRelay;
    providerId?: string;
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
    this.#immediateDeliveryTimeoutMilliseconds =
      promotionImmediateDeliveryTimeout(
        dependencies.immediateDeliveryTimeoutMilliseconds,
      );
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
    let page: ProviderActivityRelayTargetPage;
    try {
      page = await this.dependencies.directory.listRelayTargets({
        limit: this.#maximumProviders,
        after: this.#cursor,
        ...(this.dependencies.providerId === undefined
          ? {}
          : { providerId: this.dependencies.providerId }),
      });
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
    this.#cursor = page.nextCursor;
    const targets = page.targets;
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
      await this.dependencies.directory.observeReachableHealth({
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
        const promotionProjection = event.eventType ===
            "provider_promotion_invocation_terminal"
          ? await this.dependencies.local.loadPromotionProjection?.(
              target,
              event,
              attemptedAt,
            )
          : undefined;
        if (
          event.eventType === "provider_promotion_invocation_terminal"
          && (promotionProjection === undefined
            || this.dependencies.projections === undefined)
        ) throw new Error("Provider promotion projection relay is unavailable.");
        const projected = promotionProjection === undefined
          ? undefined
          : await this.dependencies.projections!.project(promotionProjection);
        const completionProof = event.eventType === "provider_release_completed"
          ? await this.dependencies.local.loadCompletionProof?.(target, event)
          : undefined;
        if (
          event.eventType === "provider_release_completed" &&
          completionProof === undefined
        ) throw new Error("Provider completion plan proof reader is unavailable.");
        // Projection envelopes are transport-only. Reachable health already
        // authenticated the routed provider above, and project() is the
        // durable central record, so do not create an unbounded duplicate in
        // the generic central activity history.
        const accepted = projected === undefined
          ? await this.dependencies.directory.acceptProviderActivity({
              organizationId: target.organizationId,
              providerId: target.providerId,
              event,
              health: read.batch.health,
              receivedAt: attemptedAt,
              ...(completionProof === undefined ? {} : { completionProof }),
            })
          : { state: "accepted" as const };
        const completionGate = projected === undefined
          ? completionGateFromAcceptance(target, event, accepted)
          : null;
        await this.dependencies.local.markDelivered(
          target,
          event,
          attemptedAt,
          projected,
        );
        if (accepted.state === "accepted") delivered += 1;
        else deduplicated += 1;
        if (completionGate?.pending === true) {
          await waitForPromotionImmediateDelivery(
            () => this.dependencies.immediateDelivery?.request({
              authority: "manifest_reconciliation",
              cause: "provider_completion",
              scopeId: completionGate.providerId,
              sourceGeneration: completionGate.manifestWakeGeneration,
              sourceEvidenceDigest: completionGate.evidenceDigest,
              requestedAt: attemptedAt,
            }) ?? Promise.resolve(),
            this.#immediateDeliveryTimeoutMilliseconds,
          ).catch(() => {
            this.#observability.log({
              level: "warning",
              event: "provider_activity_relay",
              providerId: target.providerId,
              outcome: "immediate_delivery_failed",
              failureCode: "IMMEDIATE_DELIVERY_FAILED",
            });
          });
        }
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
  immediateDelivery?: PromotionJobImmediateDeliveryPort;
  immediateDeliveryTimeoutMilliseconds?: number;
  projections?: ProviderPromotionInvocationProjectionRelay;
  providerId?: string;
}>): ProviderActivityRelayCoordinator {
  return new ProviderActivityRelayCoordinator({
    directory: new CentralProviderObservationRepository(input.central),
    local: new GatewayProviderActivityLocalStore(input.gateway),
    projections: input.projections ??
      new PrismaProviderPromotionInvocationProjectionRepository(input.central),
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
    ...(input.immediateDelivery === undefined
      ? {}
      : { immediateDelivery: input.immediateDelivery }),
    ...(input.immediateDeliveryTimeoutMilliseconds === undefined
      ? {}
      : {
          immediateDeliveryTimeoutMilliseconds:
            input.immediateDeliveryTimeoutMilliseconds,
        }),
    ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
  });
}
