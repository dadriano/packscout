import type { ProviderClock } from "./provider-configuration-service.ts";
import type {
  OperationalEventService,
  PipelineOperationalReporter,
} from "./operational-events.ts";

export type ProviderFreshnessState = "fresh" | "stale";
export type ProviderQualityState = "healthy" | "warning" | "degraded";
export type ProviderFailureClass =
  | "authentication"
  | "configuration"
  | "contract"
  | "mapping"
  | "persistence"
  | "rate_limit"
  | "timeout"
  | "unreachable"
  | "unknown";

export interface ProviderHealthRunReference {
  readonly id: string;
  readonly state: "queued" | "running" | "succeeded" | "incomplete" | "failed";
  readonly attemptedAt: Date;
}

export interface ProviderHealthEvidence {
  readonly organizationId: string;
  readonly providerId: string;
  readonly platformKey: string;
  readonly displayName: string;
  readonly providerState: "draft" | "active" | "disabled" | "archived";
  readonly configRevisionId: string;
  readonly scheduleSeconds: number;
  readonly staleAfterSeconds: number;
  readonly nextDueAt: Date | null;
  readonly activeRun: ProviderHealthRunReference | null;
  readonly latestRun: ProviderHealthRunReference | null;
  readonly latestIncompleteRunId: string | null;
  readonly lastAttemptedAt: Date | null;
  readonly lastHeadReachedAt: Date | null;
  readonly openQuarantineCount: number;
  readonly consecutiveFailures: number;
  readonly latestFailureCode: string | null;
  readonly recoveredAt: Date | null;
  readonly mappingWarning: {
    readonly occurredAt: Date;
    readonly severity: "warning" | "degraded";
    readonly active: boolean;
  } | null;
  readonly calculationWarning: {
    readonly occurredAt: Date;
    readonly severity: "warning" | "degraded";
    readonly active: boolean;
  } | null;
}

export interface ProviderHealthRepository {
  loadHealthEvidence(input: {
    organizationId: string;
    providerId: string;
  }): Promise<ProviderHealthEvidence | null>;
}

export interface ProviderFreshnessOperationalHooks {
  readonly events: Pick<OperationalEventService, "providerStale">;
  readonly reporter: Pick<PipelineOperationalReporter, "freshness">;
}

export interface ProviderHealthProjectionRepository
  extends ProviderHealthRepository {
  recordRunOutcome(input: {
    organizationId: string;
    providerId: string;
    reachedProviderHead: boolean;
    failureCode: string | null;
    finishedAt: Date;
  }): Promise<void>;
  recordQualitySignal(input: {
    organizationId: string;
    providerId: string;
    kind: "mapping" | "calculation";
    severity: "warning" | "degraded";
    occurredAt: Date;
  }): Promise<void>;
  resolveQualitySignal(input: {
    organizationId: string;
    providerId: string;
    kind: "mapping" | "calculation";
    resolvedAt: Date;
  }): Promise<void>;
}

export interface ProviderHealthDto {
  readonly organizationId: string;
  readonly providerId: string;
  readonly platformKey: string;
  readonly displayName: string;
  readonly providerState: ProviderHealthEvidence["providerState"];
  readonly configRevisionId: string;
  readonly scheduleSeconds: number;
  readonly staleAfterSeconds: number;
  readonly nextDueAt: string | null;
  readonly activeRun: { id: string; state: "queued" | "running" } | null;
  readonly latestRun: { id: string; state: ProviderHealthRunReference["state"] } | null;
  readonly latestIncompleteRunId: string | null;
  readonly lastAttemptedAt: string | null;
  readonly lastHeadReachedAt: string | null;
  readonly freshnessState: ProviderFreshnessState;
  readonly qualityState: ProviderQualityState;
  readonly openQuarantineCount: number;
  readonly consecutiveFailures: number;
  readonly latestFailureClass: ProviderFailureClass | null;
  readonly recoveredAt: string | null;
  readonly latestMappingWarningAt: string | null;
  readonly latestCalculationWarningAt: string | null;
  readonly recoveryHint: string;
}

export class ProviderHealthServiceError extends Error {
  constructor(readonly code: "PROVIDER_NOT_FOUND") {
    super("Provider not found.");
    this.name = "ProviderHealthServiceError";
  }
}

function failureClass(code: string | null): ProviderFailureClass | null {
  if (!code) return null;
  if (code.includes("AUTHENTICATION")) return "authentication";
  if (code.includes("CONFIGURATION") || code.includes("DESTINATION")) {
    return "configuration";
  }
  if (code.includes("CONTRACT") || code.includes("JSON") || code.includes("CURSOR")) {
    return "contract";
  }
  if (code.includes("MAPPING") || code.includes("CALCULATION")) return "mapping";
  if (code.includes("PERSISTENCE")) return "persistence";
  if (code.includes("RATE_LIMIT")) return "rate_limit";
  if (code.includes("TIMEOUT")) return "timeout";
  if (code.includes("UNREACHABLE") || code.includes("HTTP")) return "unreachable";
  return "unknown";
}

function qualityState(evidence: ProviderHealthEvidence): ProviderQualityState {
  if (
    evidence.latestFailureCode?.includes("MAPPING") ||
    evidence.latestFailureCode?.includes("CALCULATION")
  ) {
    return "degraded";
  }
  const signals = [evidence.mappingWarning, evidence.calculationWarning].filter(
    (
      signal,
    ): signal is NonNullable<ProviderHealthEvidence["mappingWarning"]> =>
      signal !== null && signal.active,
  );
  if (signals.some((signal) => signal.severity === "degraded")) return "degraded";
  if (signals.length > 0 || evidence.openQuarantineCount > 0) return "warning";
  return "healthy";
}

function recoveryHint(
  freshness: ProviderFreshnessState,
  quality: ProviderQualityState,
  failures: number,
): string {
  if (freshness === "stale" && failures > 0) {
    return "Resolve the latest import failure, then reach provider head.";
  }
  if (freshness === "stale") return "Run an import through provider head.";
  if (quality !== "healthy") return "Resolve the open data-quality signals.";
  return "No recovery action required.";
}

export class ProviderHealthService {
  constructor(
    private readonly repository: ProviderHealthRepository,
    private readonly clock: ProviderClock,
    private readonly operational?: ProviderFreshnessOperationalHooks,
  ) {}

  async getHealth(input: {
    organizationId: string;
    providerId: string;
  }): Promise<ProviderHealthDto> {
    const evidence = await this.repository.loadHealthEvidence(input);
    if (!evidence) throw new ProviderHealthServiceError("PROVIDER_NOT_FOUND");
    const now = this.clock.now();
    const fresh =
      evidence.lastHeadReachedAt !== null &&
      now.getTime() - evidence.lastHeadReachedAt.getTime() <=
        evidence.staleAfterSeconds * 1_000;
    const freshness: ProviderFreshnessState = fresh ? "fresh" : "stale";
    const quality = qualityState(evidence);
    const result: ProviderHealthDto = {
      organizationId: evidence.organizationId,
      providerId: evidence.providerId,
      platformKey: evidence.platformKey,
      displayName: evidence.displayName,
      providerState: evidence.providerState,
      configRevisionId: evidence.configRevisionId,
      scheduleSeconds: evidence.scheduleSeconds,
      staleAfterSeconds: evidence.staleAfterSeconds,
      nextDueAt: evidence.nextDueAt?.toISOString() ?? null,
      activeRun: evidence.activeRun
        ? { id: evidence.activeRun.id, state: evidence.activeRun.state as "queued" | "running" }
        : null,
      latestRun: evidence.latestRun
        ? { id: evidence.latestRun.id, state: evidence.latestRun.state }
        : null,
      latestIncompleteRunId: evidence.latestIncompleteRunId,
      lastAttemptedAt: evidence.lastAttemptedAt?.toISOString() ?? null,
      lastHeadReachedAt: evidence.lastHeadReachedAt?.toISOString() ?? null,
      freshnessState: freshness,
      qualityState: quality,
      openQuarantineCount: evidence.openQuarantineCount,
      consecutiveFailures: evidence.consecutiveFailures,
      latestFailureClass: failureClass(evidence.latestFailureCode),
      recoveredAt: evidence.recoveredAt?.toISOString() ?? null,
      latestMappingWarningAt:
        evidence.mappingWarning?.occurredAt.toISOString() ?? null,
      latestCalculationWarningAt:
        evidence.calculationWarning?.occurredAt.toISOString() ?? null,
      recoveryHint: recoveryHint(
        freshness,
        quality,
        evidence.consecutiveFailures,
      ),
    };
    await this.reportFreshness(evidence, freshness, now);
    return result;
  }

  private async reportFreshness(
    evidence: ProviderHealthEvidence,
    freshness: ProviderFreshnessState,
    now: Date,
  ): Promise<void> {
    if (!this.operational) return;
    const ageSeconds = evidence.lastHeadReachedAt
      ? Math.max(
          0,
          Math.floor(
            (now.getTime() - evidence.lastHeadReachedAt.getTime()) / 1_000,
          ),
        )
      : evidence.staleAfterSeconds + 1;
    try {
      this.operational.reporter.freshness({
        organizationId: evidence.organizationId,
        providerId: evidence.providerId,
        ageSeconds,
        state: freshness === "fresh" ? "FRESH" : "STALE",
      });
    } catch {
      // Health remains readable when operational telemetry is unavailable.
    }
    if (freshness === "stale") {
      try {
        await this.operational.events.providerStale({
          organizationId: evidence.organizationId,
          providerId: evidence.providerId,
          ageSeconds,
        });
      } catch {
        // Delivery cannot change the protected health response.
      }
    }
  }
}

export class ProviderHealthProjectionService {
  constructor(
    private readonly repository: ProviderHealthProjectionRepository,
    private readonly clock: ProviderClock,
  ) {}

  async recordRunOutcome(input: {
    organizationId: string;
    providerId: string;
    reachedProviderHead: boolean;
    failureCode: string | null;
  }): Promise<void> {
    if (
      input.failureCode !== null &&
      !/^[A-Z0-9_]{1,128}$/.test(input.failureCode)
    ) {
      throw new RangeError("Provider failure code is invalid.");
    }
    await this.repository.recordRunOutcome({
      ...input,
      finishedAt: this.clock.now(),
    });
  }

  async recordQualitySignal(input: {
    organizationId: string;
    providerId: string;
    kind: "mapping" | "calculation";
    severity: "warning" | "degraded";
  }): Promise<void> {
    await this.repository.recordQualitySignal({
      ...input,
      occurredAt: this.clock.now(),
    });
  }

  async resolveQualitySignal(input: {
    organizationId: string;
    providerId: string;
    kind: "mapping" | "calculation";
  }): Promise<void> {
    await this.repository.resolveQualitySignal({
      ...input,
      resolvedAt: this.clock.now(),
    });
  }
}
