import type {
  ManifestPromotionAlertSink,
  ManifestPromotionHealth,
  ManifestPromotionHealthSink,
  PromotionOperationalReadinessService,
  ProviderPromotionAlertSink,
  ProviderPromotionHealth,
  ProviderPromotionHealthSink,
} from "@packscout/services";
import { runPromotionObservabilityFanout } from
  "./promotion-observability-fanout.ts";
import type { PromotionV2WorkerLogger } from
  "./promotion-v2-worker-runtime.ts";

type Readiness = Pick<
  PromotionOperationalReadinessService,
  "assess" | "publicationFailed"
>;

const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const publicReleaseId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function sequence(value: bigint): string {
  return value >= 0n && value <= 9_999_999_999_999_999_999n
    ? String(value) : "0";
}

function date(value: Date | null): string | undefined {
  return value !== null && Number.isFinite(value.getTime())
    ? value.toISOString() : undefined;
}

function id(value: string | null): string | undefined {
  return value !== null && publicReleaseId.test(value) ? value : undefined;
}

function attemptTiming(
  startedAt: Date | null,
  now: Date,
): Readonly<{
  activeAttemptStartedAt?: string;
  activeAttemptAgeSeconds?: number;
}> {
  if (startedAt === null || !Number.isFinite(startedAt.getTime()) ||
      !Number.isFinite(now.getTime()) || startedAt > now) return {};
  return {
    activeAttemptStartedAt: startedAt.toISOString(),
    activeAttemptAgeSeconds: Math.min(
      Math.floor((now.getTime() - startedAt.getTime()) / 1_000),
      31_536_000,
    ),
  };
}

/** Platform-scoped durable readiness bridge for one provider lane. */
export class ProviderPromotionOperationalReadinessSink
implements ProviderPromotionAlertSink, ProviderPromotionHealthSink {
  constructor(
    private readonly readiness: Readiness,
    private readonly logger: PromotionV2WorkerLogger,
    private readonly workerId: string,
    private readonly clock: Readonly<{ now(): Date }> = { now: () => new Date() },
  ) {}

  report(health: ProviderPromotionHealth): Promise<void> {
    const lifecycleState = health.lifecycleState ?? "unknown";
    return runPromotionObservabilityFanout(
      () => this.readiness.assess(),
      () => this.logger.write({
        level: "info",
        event: "promotion_v2_provider_health",
        workerId: safeIdentifier.test(this.workerId) ? this.workerId : "invalid",
        platformKey: safeIdentifier.test(health.platformKey)
          ? health.platformKey : "invalid",
        lifecycleState,
        settledCheckpoint: sequence(health.settledCheckpoint),
        sourceHeadCheckpoint: sequence(health.sourceHeadCheckpoint),
        completedCheckpoint: sequence(health.completedCheckpoint),
        ...(health.activeCheckpoint === null ? {} : {
          activeCheckpoint: sequence(health.activeCheckpoint),
        }),
        checkpointLag: sequence(
          health.settledCheckpoint > health.completedCheckpoint
            ? health.settledCheckpoint - health.completedCheckpoint : 0n,
        ),
        completedLag: sequence(
          health.settledCheckpoint > health.completedCheckpoint
            ? health.settledCheckpoint - health.completedCheckpoint : 0n,
        ),
        activeLag: sequence(
          lifecycleState === "active" &&
            health.settledCheckpoint > (health.activeCheckpoint ?? 0n)
            ? health.settledCheckpoint - (health.activeCheckpoint ?? 0n) : 0n,
        ),
        requestedEvaluationSequence: sequence(
          health.requestedEvaluationSequence,
        ),
        confirmedEvaluationSequence: sequence(
          health.confirmedEvaluationSequence,
        ),
        ...(id(health.activeManifestPublicReleaseId) === undefined ? {} : {
          activeManifestPublicReleaseId:
            id(health.activeManifestPublicReleaseId),
        }),
        ...(health.activeAttemptState === null ||
          !safeIdentifier.test(health.activeAttemptState) ? {} : {
            activeAttemptState: health.activeAttemptState,
          }),
        ...attemptTiming(health.activeAttemptStartedAt, this.clock.now()),
        ...(date(health.retryAt) === undefined ? {} : {
          retryAt: date(health.retryAt),
        }),
        ...(date(health.completedAt) === undefined ? {} : {
          completedAt: date(health.completedAt),
        }),
      }),
    );
  }

  notify(input: {
    platformKey: string;
    attemptId: string;
    evaluationSequence: bigint;
    targetCheckpoint: bigint;
    failureCode: string;
    occurredAt: Date;
  }): Promise<void> {
    void input.platformKey;
    void input.evaluationSequence;
    void input.occurredAt;
    return this.readiness.publicationFailed({
      attemptId: input.attemptId,
      targetWatermark: input.targetCheckpoint,
      failureCode: input.failureCode,
    });
  }
}

/** Singleton durable readiness bridge for serialized manifest evaluation. */
export class ManifestPromotionOperationalReadinessSink
implements ManifestPromotionAlertSink, ManifestPromotionHealthSink {
  constructor(
    private readonly readiness: Readiness,
    private readonly logger: PromotionV2WorkerLogger,
    private readonly workerId: string,
    private readonly clock: Readonly<{ now(): Date }> = { now: () => new Date() },
  ) {}

  report(health: ManifestPromotionHealth): Promise<void> {
    return runPromotionObservabilityFanout(
      () => this.readiness.assess(),
      () => this.logger.write({
        level: "info",
        event: "promotion_v2_manifest_health",
        workerId: safeIdentifier.test(this.workerId) ? this.workerId : "invalid",
        bootstrapState: health.bootstrapState,
        requestedEvaluationSequence: sequence(
          health.requestedEvaluationSequence,
        ),
        confirmedEvaluationSequence: sequence(
          health.confirmedEvaluationSequence,
        ),
        activeGeneration: sequence(health.activeGeneration),
        ...(id(health.activePublicReleaseId) === undefined ? {} : {
          activePublicReleaseId: id(health.activePublicReleaseId),
        }),
        ...(health.activeConfigurationEpochSequence === null ? {} : {
          activeConfigurationEpochSequence: sequence(
            health.activeConfigurationEpochSequence,
          ),
        }),
        delayedProviderCount: Number.isSafeInteger(health.delayedProviderCount) &&
          health.delayedProviderCount >= 0 && health.delayedProviderCount <= 8
          ? health.delayedProviderCount : 0,
        ...(health.activeAttemptState === null ||
          !safeIdentifier.test(health.activeAttemptState) ? {} : {
            activeAttemptState: health.activeAttemptState,
          }),
        ...attemptTiming(health.activeAttemptStartedAt, this.clock.now()),
        ...(date(health.retryAt) === undefined ? {} : {
          retryAt: date(health.retryAt),
        }),
        ...(date(health.lastActivatedAt) === undefined ? {} : {
          lastActivatedAt: date(health.lastActivatedAt),
        }),
        ...(date(health.lastReconciledAt) === undefined ? {} : {
          lastReconciledAt: date(health.lastReconciledAt),
        }),
      }),
    );
  }

  notify(input: {
    attemptId: string;
    evaluationSequence: bigint;
    failureCode: string;
    occurredAt: Date;
  }): Promise<void> {
    void input.occurredAt;
    return this.readiness.publicationFailed({
      attemptId: input.attemptId,
      targetWatermark: input.evaluationSequence,
      failureCode: input.failureCode,
    });
  }
}
