import type {
  NotificationPublishResult,
  PromotionLane,
} from "@packscout/contracts";
import type { OperationalEventService } from "./operational-events.ts";
import type {
  ProviderClock,
} from "./provider-configuration-service.ts";

export const PROMOTION_ACTIVATION_ALERT_AFTER_MILLISECONDS = 60_000;

export interface PromotionReadinessDiagnostic {
  readonly activeAlertCount: number;
  readonly activeFailureAlertCount: number;
  readonly activeFailureAttemptId: string | null;
  readonly canonicalSettledWatermark: bigint;
  readonly canonicalSettledAt: Date | null;
  readonly canonicalSourceHeadWatermark: bigint;
  readonly confirmedWatermark: bigint;
  readonly laneTargetWatermark: bigint;
  readonly laneTargetAt: Date | null;
  readonly latestFailedAttemptId: string | null;
  readonly latestFailedWatermark: bigint | null;
  readonly latestFailureCode: string | null;
  readonly technicalFailureCount: number;
}

export interface PromotionReadinessDiagnosticPort {
  load(): Promise<PromotionReadinessDiagnostic>;
}

export interface PromotionOperationalReadinessConfiguration {
  readonly organizationId: string;
  readonly deploymentScopeDigest: string;
  readonly lane: PromotionLane;
  readonly targetSource: "canonical_settlement" | "promotion_lane";
  readonly monitorTechnicalSettlement?: boolean;
  readonly activationAlertAfterMilliseconds?: number;
}

const organizationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const deploymentScopeDigestPattern = /^[0-9a-f]{64}$/u;
const reconciliationFailurePattern =
  /(?:BASELINE_CONFLICT|LEDGER|RECEIPT|RESPONSE|RETRY_EXHAUSTED|STATUS|WATERMARK)/u;

function nonNegativeWatermark(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

function nonNegativeCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function assertNotificationPublished(result: NotificationPublishResult): void {
  if (result.status === "failed") {
    throw new Error("Promotion operational notification failed.");
  }
}

export function isPromotionReconciliationFailureCode(code: string): boolean {
  return reconciliationFailurePattern.test(code);
}

/**
 * Converts a lane's bounded PostgreSQL health projection into durable alerts.
 * It owns no publication state, and notification failures never alter the lane.
 */
export class PromotionOperationalReadinessService {
  readonly #activationAlertAfterMilliseconds: number;
  readonly #configuration: Readonly<
    PromotionOperationalReadinessConfiguration & {
      monitorTechnicalSettlement: boolean;
    }
  >;
  #activationDelayed = false;
  #healthyReported = false;
  #lastFailureAlertedAttemptId: string | null = null;
  #unhealthyObserved = false;
  #settlementBlocked = false;

  constructor(
    private readonly events: Pick<
      OperationalEventService,
      | "promotionActivationDelayed"
      | "promotionFailed"
      | "promotionRecovered"
      | "promotionSettlementBlocked"
    >,
    private readonly diagnostics: PromotionReadinessDiagnosticPort,
    private readonly clock: ProviderClock,
    configuration: PromotionOperationalReadinessConfiguration,
  ) {
    if (
      !organizationIdPattern.test(configuration.organizationId) ||
      !deploymentScopeDigestPattern.test(configuration.deploymentScopeDigest)
    ) {
      throw new RangeError("Promotion readiness scope is invalid.");
    }
    const threshold = configuration.activationAlertAfterMilliseconds ??
      PROMOTION_ACTIVATION_ALERT_AFTER_MILLISECONDS;
    if (!Number.isSafeInteger(threshold) || threshold !== 60_000) {
      throw new RangeError("Promotion readiness activation target is invalid.");
    }
    this.#activationAlertAfterMilliseconds = threshold;
    this.#configuration = Object.freeze({
      ...configuration,
      organizationId: configuration.organizationId.toLowerCase(),
      monitorTechnicalSettlement:
        configuration.monitorTechnicalSettlement ??
        configuration.lane === "catalog",
    });
  }

  async assess(): Promise<void> {
    const diagnostic = await this.diagnostics.load();
    const target = this.#configuration.targetSource === "canonical_settlement"
      ? {
          at: diagnostic.canonicalSettledAt,
          watermark: nonNegativeWatermark(
            diagnostic.canonicalSettledWatermark,
          ),
        }
      : {
          at: diagnostic.laneTargetAt,
          watermark: nonNegativeWatermark(diagnostic.laneTargetWatermark),
        };
    const confirmedWatermark = nonNegativeWatermark(
      diagnostic.confirmedWatermark,
    );
    const technicalFailureCount = nonNegativeCount(
      diagnostic.technicalFailureCount,
    );
    const settlementBlocked =
      this.#configuration.monitorTechnicalSettlement &&
      technicalFailureCount > 0 &&
      diagnostic.canonicalSourceHeadWatermark >
        diagnostic.canonicalSettledWatermark;
    const ageMilliseconds = target.at === null
      ? 0
      : Math.max(0, this.clock.now().getTime() - target.at.getTime());
    const activationDelayed =
      target.at !== null &&
      target.watermark > confirmedWatermark &&
      ageMilliseconds >= this.#activationAlertAfterMilliseconds;
    const unrecoveredFailure =
      diagnostic.latestFailedAttemptId !== null &&
      diagnostic.latestFailedWatermark !== null &&
      diagnostic.latestFailureCode !== null &&
      diagnostic.latestFailedWatermark > confirmedWatermark;

    if (settlementBlocked || activationDelayed || unrecoveredFailure) {
      this.#unhealthyObserved = true;
    }

    if (
      unrecoveredFailure &&
      (
        nonNegativeCount(diagnostic.activeFailureAlertCount) === 0 ||
        diagnostic.activeFailureAttemptId !==
          diagnostic.latestFailedAttemptId
      ) &&
      this.#lastFailureAlertedAttemptId !==
        diagnostic.latestFailedAttemptId
    ) {
      await this.emitFailure({
        attemptId: diagnostic.latestFailedAttemptId,
        targetWatermark: diagnostic.latestFailedWatermark,
        confirmedWatermark,
        failureCode: diagnostic.latestFailureCode,
      });
      this.#lastFailureAlertedAttemptId = diagnostic.latestFailedAttemptId;
    }

    if (settlementBlocked && !this.#settlementBlocked) {
      const result = await this.events.promotionSettlementBlocked({
        organizationId: this.#configuration.organizationId,
        deploymentScopeDigest: this.#configuration.deploymentScopeDigest,
        lane: this.#configuration.lane,
        sourceHeadWatermark: nonNegativeWatermark(
          diagnostic.canonicalSourceHeadWatermark,
        ),
        settledWatermark: nonNegativeWatermark(
          diagnostic.canonicalSettledWatermark,
        ),
        technicalFailureCount,
      });
      assertNotificationPublished(result);
    }
    if (activationDelayed && !this.#activationDelayed) {
      const result = await this.events.promotionActivationDelayed({
        organizationId: this.#configuration.organizationId,
        deploymentScopeDigest: this.#configuration.deploymentScopeDigest,
        lane: this.#configuration.lane,
        targetWatermark: target.watermark,
        confirmedWatermark,
        durationMs: ageMilliseconds,
      });
      assertNotificationPublished(result);
    }

    this.#settlementBlocked = settlementBlocked;
    this.#activationDelayed = activationDelayed;
    const healthy =
      !settlementBlocked &&
      !unrecoveredFailure &&
      target.watermark <= confirmedWatermark;
    const durableRecoveryPending =
      nonNegativeCount(diagnostic.activeAlertCount) > 0;
    if (
      healthy &&
      !this.#healthyReported &&
      (this.#unhealthyObserved || durableRecoveryPending)
    ) {
      const result = await this.events.promotionRecovered({
        organizationId: this.#configuration.organizationId,
        deploymentScopeDigest: this.#configuration.deploymentScopeDigest,
        lane: this.#configuration.lane,
        targetWatermark: target.watermark,
        confirmedWatermark,
      });
      assertNotificationPublished(result);
      this.#unhealthyObserved = false;
    }
    this.#healthyReported = healthy;
    if (healthy) this.#lastFailureAlertedAttemptId = null;
  }

  async publicationFailed(input: {
    attemptId: string;
    targetWatermark: bigint;
    failureCode: string;
  }): Promise<void> {
    this.#healthyReported = false;
    this.#unhealthyObserved = true;
    const diagnostic = await this.diagnostics.load();
    await this.emitFailure({
      ...input,
      confirmedWatermark: nonNegativeWatermark(
        diagnostic.confirmedWatermark,
      ),
    });
    this.#lastFailureAlertedAttemptId = input.attemptId;
  }

  private async emitFailure(input: {
    attemptId: string;
    targetWatermark: bigint;
    confirmedWatermark: bigint;
    failureCode: string;
  }): Promise<void> {
    const result = await this.events.promotionFailed({
      organizationId: this.#configuration.organizationId,
      deploymentScopeDigest: this.#configuration.deploymentScopeDigest,
      lane: this.#configuration.lane,
      attemptId: input.attemptId,
      targetWatermark: nonNegativeWatermark(input.targetWatermark),
      confirmedWatermark: nonNegativeWatermark(input.confirmedWatermark),
      failureCode: input.failureCode,
      reconciliation: isPromotionReconciliationFailureCode(
        input.failureCode,
      ),
    });
    assertNotificationPublished(result);
  }
}
