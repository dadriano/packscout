import type {
  BoundedProviderDatabaseGateway,
  CentralPrismaClient,
  PromotionJobLivenessConditionDelivery,
} from "@packscout/database";
import {
  CentralAdminNotificationPublisher,
  PrismaManifestReconciliationJobRepository,
  PrismaPromotionJobLivenessRepository,
  PrismaPromotionJobLivenessRosterRepository,
  PrismaProviderPromotionJobRepository,
} from "@packscout/database";
import {
  PromotionJobLivenessEvaluator,
  type ManifestPromotionScheduleSource,
  type PromotionJobLivenessRosterEntry,
  type ProviderPromotionScheduleSource,
} from "@packscout/services";
import {
  PromotionJobLivenessOneShot,
  type PromotionJobLivenessConditionPublisher,
  type PromotionJobLivenessDeliveryDeadline,
} from "./promotion-job-liveness-one-shot.ts";

export interface PromotionJobSystemConditionSink {
  publish(
    delivery: PromotionJobLivenessConditionDelivery & Readonly<{
      scope: "system";
    }>,
    input: PromotionJobLivenessDeliveryDeadline,
  ): Promise<Readonly<{
    state: "delivered";
  }> | Readonly<{
    state: "retryable_failure";
    failureCode: string;
  }>>;
}

export class GatewayProviderPromotionScheduleSource
implements ProviderPromotionScheduleSource {
  constructor(private readonly gateway: Pick<
    BoundedProviderDatabaseGateway,
    "runWithAdminProviderDatabase"
  >) {}

  readSchedule(
    provider: PromotionJobLivenessRosterEntry,
    input: Readonly<{ deadlineAt: number }>,
  ) {
    return this.gateway.runWithAdminProviderDatabase(
      {
        organizationId: provider.organizationId,
        providerId: provider.providerId,
        deadlineAt: input.deadlineAt,
      },
      (database) =>
        new PrismaProviderPromotionJobRepository(database).loadSchedule(),
    );
  }
}

export class CentralManifestPromotionScheduleSource
implements ManifestPromotionScheduleSource {
  readonly #repository: PrismaManifestReconciliationJobRepository;

  constructor(
    central: CentralPrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#repository = new PrismaManifestReconciliationJobRepository(central);
  }

  async readSchedule() {
    const schedule = await this.#repository.loadSchedule();
    return { schedule, observedAt: this.now() };
  }
}

function boundedMissedCount(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(value);
}

/** Routes provider conditions to tenant alerts and system conditions outward. */
export class CentralPromotionJobLivenessConditionPublisher
implements PromotionJobLivenessConditionPublisher {
  readonly #alerts: Pick<CentralAdminNotificationPublisher, "publish">;

  constructor(
    central: CentralPrismaClient,
    private readonly system: PromotionJobSystemConditionSink,
    alerts?: Pick<CentralAdminNotificationPublisher, "publish">,
  ) {
    this.#alerts = alerts ?? new CentralAdminNotificationPublisher(central);
  }

  async publish(
    delivery: PromotionJobLivenessConditionDelivery,
    input: PromotionJobLivenessDeliveryDeadline,
  ) {
    if (delivery.scope === "system") {
      return this.system.publish({ ...delivery, scope: "system" }, input);
    }
    if (input.signal.aborted) {
      return {
        state: "retryable_failure" as const,
        failureCode: "PROMOTION_JOB_CONDITION_DELIVERY_TIMEOUT",
      };
    }
    if (
      delivery.organizationId === null
      || delivery.providerId === null
      || delivery.subject !== "provider_schedule"
    ) {
      return {
        state: "retryable_failure" as const,
        failureCode: "PROMOTION_JOB_CONDITION_SCOPE_INVALID",
      };
    }
    const recoveryKey =
      `promotion-job:provider-schedule:${delivery.providerId}:` +
      delivery.scheduleEpoch.toString();
    const recovering = delivery.action === "recover";
    const result = await this.#alerts.publish({
      id: delivery.eventId,
      organizationId: delivery.organizationId,
      kind: recovering ? "machinery_recovered" : "provider_schedule_overdue",
      severity: recovering ? "info" : "warning",
      providerId: delivery.providerId,
      runId: null,
      quarantineId: null,
      dedupeKey: recovering ? `${recoveryKey}:recovered` : recoveryKey,
      recoveryKey,
      title: recovering
        ? "Provider promotion schedule recovered"
        : "Provider promotion schedule missed three windows",
      summary: recovering
        ? "A strictly newer trusted reconciliation check-in recovered the provider promotion schedule."
        : "The provider promotion schedule missed at least three trusted reconciliation windows.",
      evidence: recovering
        ? { outcome: "PROVIDER_PROMOTION_SCHEDULE_RECOVERED" }
        : {
            outcome: "PROVIDER_PROMOTION_SCHEDULE_ALERTING",
            count: boundedMissedCount(delivery.missedWindowCount),
            thresholdCount: 3,
          },
      occurredAt: delivery.evaluatedAt.toISOString(),
    });
    return result.status === "failed"
      ? {
          state: "retryable_failure" as const,
          failureCode: result.failureCode ??
            "PROMOTION_JOB_CONDITION_DELIVERY_FAILED",
        }
      : { state: "delivered" as const };
  }
}

/** Composes one bounded evaluator pass; scheduling remains an outer concern. */
export function createPromotionJobLivenessOneShot(input: Readonly<{
  central: CentralPrismaClient;
  gateway: Pick<
    BoundedProviderDatabaseGateway,
    "runWithAdminProviderDatabase"
  >;
  systemConditionSink: PromotionJobSystemConditionSink;
  providerConcurrency?: number;
  providerCycleTimeoutMs?: number;
  rosterPageSize?: number;
  maximumProviders?: number;
  deliveryLimit?: number;
  now?: () => Date;
}>): PromotionJobLivenessOneShot {
  const now = input.now ?? (() => new Date());
  const roster = new PrismaPromotionJobLivenessRosterRepository(
    input.central,
    {
      ...(input.rosterPageSize === undefined
        ? {}
        : { pageSize: input.rosterPageSize }),
      ...(input.maximumProviders === undefined
        ? {}
        : { maximumProviders: input.maximumProviders }),
    },
  );
  const store = new PrismaPromotionJobLivenessRepository(input.central);
  const evaluator = new PromotionJobLivenessEvaluator({
    roster,
    providers: new GatewayProviderPromotionScheduleSource(input.gateway),
    manifest: new CentralManifestPromotionScheduleSource(input.central, now),
    store,
    ...(input.providerConcurrency === undefined
      ? {}
      : { providerConcurrency: input.providerConcurrency }),
    ...(input.providerCycleTimeoutMs === undefined
      ? {}
      : { providerCycleTimeoutMs: input.providerCycleTimeoutMs }),
    now,
  });
  return new PromotionJobLivenessOneShot({
    evaluator,
    conditions: store,
    publisher: new CentralPromotionJobLivenessConditionPublisher(
      input.central,
      input.systemConditionSink,
    ),
    ...(input.deliveryLimit === undefined
      ? {}
      : { deliveryLimit: input.deliveryLimit }),
    now,
  });
}
