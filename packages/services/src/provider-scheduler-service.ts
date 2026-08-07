import type { ProviderClock } from "./provider-configuration-service.ts";

const DEFAULT_LEASE_MILLISECONDS = 30_000;
const RETRY_DELAY_MILLISECONDS = 30_000;

export type ProviderScheduleOutcome =
  | "started"
  | "coalesced"
  | "not_enabled";

export interface ProviderScheduleClaim {
  readonly organizationId: string;
  readonly providerId: string;
  readonly configRevisionId: string;
  readonly scheduleSeconds: number;
  readonly staleAfterSeconds: number;
  readonly dueAt: Date;
}

export interface ProviderScheduleRepository {
  claimDueProvider(input: {
    workerId: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<ProviderScheduleClaim | null>;
  completeClaim(input: {
    workerId: string;
    organizationId: string;
    providerId: string;
    configRevisionId: string;
    outcome: ProviderScheduleOutcome;
    runId: string | null;
    completedAt: Date;
    nextDueAt: Date | null;
  }): Promise<boolean>;
  releaseClaim(input: {
    workerId: string;
    organizationId: string;
    providerId: string;
    configRevisionId: string;
    releasedAt: Date;
    retryAt: Date;
  }): Promise<void>;
}

export interface ScheduledImportPort {
  requestImport(input: {
    trigger: "scheduled";
    providerId: string;
    organizationId: string;
  }): Promise<{ run: { id: string }; coalesced: boolean }>;
}

export type ProviderSchedulerResult =
  | { readonly kind: "idle" }
  | {
      readonly kind: ProviderScheduleOutcome;
      readonly organizationId: string;
      readonly providerId: string;
      readonly configRevisionId: string;
      readonly runId: string | null;
      readonly nextDueAt: Date | null;
    };

export interface ProviderSchedulerDependencies {
  readonly schedules: ProviderScheduleRepository;
  readonly imports: ScheduledImportPort;
  readonly clock: ProviderClock;
  readonly leaseMilliseconds?: number;
}

function isNotEnabled(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return (
    error.code === "PROVIDER_NOT_IMPORTABLE" ||
    error.code === "PROVIDER_NOT_FOUND"
  );
}

function requireWorkerId(workerId: string): void {
  if (workerId.length < 1 || workerId.length > 256) {
    throw new RangeError("Scheduler worker ID is invalid.");
  }
}

function nextDueAt(now: Date, scheduleSeconds: number): Date {
  if (
    !Number.isInteger(scheduleSeconds) ||
    scheduleSeconds < 60 ||
    scheduleSeconds > 24 * 60 * 60
  ) {
    throw new RangeError("Provider schedule is outside its safe bounds.");
  }
  return new Date(now.getTime() + scheduleSeconds * 1_000);
}

export class ProviderSchedulerService {
  readonly #leaseMilliseconds: number;

  constructor(private readonly dependencies: ProviderSchedulerDependencies) {
    this.#leaseMilliseconds =
      dependencies.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
    if (
      !Number.isInteger(this.#leaseMilliseconds) ||
      this.#leaseMilliseconds < 1_000 ||
      this.#leaseMilliseconds > 5 * 60_000
    ) {
      throw new RangeError("Scheduler lease duration is outside its safe bounds.");
    }
  }

  async runOnce(workerId: string): Promise<ProviderSchedulerResult> {
    requireWorkerId(workerId);
    const now = this.dependencies.clock.now();
    const claim = await this.dependencies.schedules.claimDueProvider({
      workerId,
      now,
      leaseExpiresAt: new Date(now.getTime() + this.#leaseMilliseconds),
    });
    if (!claim) return { kind: "idle" };

    try {
      const requested = await this.dependencies.imports.requestImport({
        trigger: "scheduled",
        providerId: claim.providerId,
        organizationId: claim.organizationId,
      });
      return this.complete(
        workerId,
        claim,
        requested.coalesced ? "coalesced" : "started",
        requested.run.id,
        now,
      );
    } catch (error) {
      if (isNotEnabled(error)) {
        return this.complete(workerId, claim, "not_enabled", null, now);
      }
      await this.dependencies.schedules.releaseClaim({
        workerId,
        organizationId: claim.organizationId,
        providerId: claim.providerId,
        configRevisionId: claim.configRevisionId,
        releasedAt: now,
        retryAt: new Date(now.getTime() + RETRY_DELAY_MILLISECONDS),
      });
      throw error;
    }
  }

  private async complete(
    workerId: string,
    claim: ProviderScheduleClaim,
    outcome: ProviderScheduleOutcome,
    runId: string | null,
    completedAt: Date,
  ): Promise<ProviderSchedulerResult> {
    const nextDue =
      outcome === "not_enabled"
        ? null
        : nextDueAt(completedAt, claim.scheduleSeconds);
    const completed = await this.dependencies.schedules.completeClaim({
      workerId,
      organizationId: claim.organizationId,
      providerId: claim.providerId,
      configRevisionId: claim.configRevisionId,
      outcome,
      runId,
      completedAt,
      nextDueAt: nextDue,
    });
    if (!completed) {
      throw new Error("Provider schedule ownership was lost.");
    }
    return {
      kind: outcome,
      organizationId: claim.organizationId,
      providerId: claim.providerId,
      configRevisionId: claim.configRevisionId,
      runId,
      nextDueAt: nextDue,
    };
  }
}
