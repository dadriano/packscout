import type {
  ProtectedOperationalHealthDetail,
  ShallowLiveness,
} from "@packscout/contracts";
import type { ProviderClock } from "./provider-configuration-service.ts";

export interface OperationalHealthSnapshot {
  readonly configuredProviderCount: number;
  readonly staleProviderCount: number;
  readonly degradedProviderCount: number;
  readonly failedProviderCount: number;
  readonly activeAlertCount: number;
  readonly latestRetentionState: "never_run" | "succeeded" | "failed";
  readonly latestRetentionAt: Date | null;
  readonly latestRetentionFailureCode: string | null;
}

export interface OperationalHealthRepository {
  loadSnapshot(input: {
    organizationId: string;
    checkedAt: Date;
  }): Promise<OperationalHealthSnapshot>;
}

export class OperationalHealthService {
  constructor(
    private readonly repository: OperationalHealthRepository,
    private readonly clock: ProviderClock,
  ) {}

  liveness(): ShallowLiveness {
    return { status: "live" };
  }

  async protectedDetail(
    organizationId: string,
  ): Promise<ProtectedOperationalHealthDetail> {
    const checkedAt = this.clock.now();
    const snapshot = await this.repository.loadSnapshot({
      organizationId,
      checkedAt,
    });
    const state =
      snapshot.configuredProviderCount === 0
        ? "unconfigured"
        : snapshot.failedProviderCount > 0 ||
            snapshot.latestRetentionState === "failed"
          ? "failed"
          : snapshot.staleProviderCount > 0
            ? "stale"
            : snapshot.degradedProviderCount > 0 || snapshot.activeAlertCount > 0
              ? "degraded"
              : "healthy";
    return {
      state,
      checkedAt: checkedAt.toISOString(),
      configuredProviderCount: snapshot.configuredProviderCount,
      staleProviderCount: snapshot.staleProviderCount,
      degradedProviderCount: snapshot.degradedProviderCount,
      failedProviderCount: snapshot.failedProviderCount,
      activeAlertCount: snapshot.activeAlertCount,
      latestRetentionState: snapshot.latestRetentionState,
      latestRetentionAt: snapshot.latestRetentionAt?.toISOString() ?? null,
      latestRetentionFailureCode: snapshot.latestRetentionFailureCode,
    };
  }
}
