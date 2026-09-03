import type { PromotionJobPruneResult } from "@packscout/database";

export interface PromotionJobInvocationRetentionPort {
  prune(input: Readonly<{
    now: Date;
    maximumRows?: number;
  }>): Promise<PromotionJobPruneResult>;
}

export interface PromotionJobProtectionReleasePort {
  releasePrunableRetentionProtection(input: Readonly<{
    now: Date;
    maximumRows?: number;
  }>): Promise<Readonly<{ released: number; moreEligible: boolean }>>;
}

export interface PromotionJobProjectionRetentionPort {
  pruneScheduled(input: Readonly<{
    now: Date;
    maximumRows?: number;
  }>): Promise<Readonly<{ deleted: number; moreEligible: boolean }>>;
}

export interface PromotionJobRetentionCycleResult {
  readonly protectionsReleased: number;
  readonly invocationSummariesDeleted: number;
  readonly tombstonesDeleted: number;
  readonly providerProjectionsDeleted: number;
  readonly moreEligible: boolean;
}

/**
 * One bounded retention pass for one physical promotion authority. Provider
 * protection is released by the projection relay; the central authority may
 * additionally release manifest detail after its full retention window.
 */
export class PromotionJobRetentionCoordinator {
  readonly #maximumRows: number;

  constructor(private readonly dependencies: Readonly<{
    invocations: PromotionJobInvocationRetentionPort;
    protectionRelease?: PromotionJobProtectionReleasePort;
    projections?: PromotionJobProjectionRetentionPort;
    maximumRows?: number;
  }>) {
    this.#maximumRows = dependencies.maximumRows ?? 100;
    if (
      !Number.isSafeInteger(this.#maximumRows) || this.#maximumRows < 1 ||
      this.#maximumRows > 1_000
    ) throw new RangeError("Promotion job retention bounds are invalid.");
  }

  async runCycle(now: Date): Promise<PromotionJobRetentionCycleResult> {
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError("Promotion job retention time is invalid.");
    }
    const protection = this.dependencies.protectionRelease === undefined
      ? { released: 0, moreEligible: false }
      : await this.dependencies.protectionRelease
        .releasePrunableRetentionProtection({
          now,
          maximumRows: this.#maximumRows,
        });
    const invocations = await this.dependencies.invocations.prune({
      now,
      maximumRows: this.#maximumRows,
    });
    const projections = this.dependencies.projections === undefined
      ? { deleted: 0, moreEligible: false }
      : await this.dependencies.projections.pruneScheduled({
          now,
          maximumRows: this.#maximumRows,
        });
    return {
      protectionsReleased: protection.released,
      invocationSummariesDeleted: invocations.invocationSummariesDeleted,
      tombstonesDeleted: invocations.tombstonesDeleted,
      providerProjectionsDeleted: projections.deleted,
      moreEligible: protection.moreEligible ||
        invocations.moreEligibleSummaries ||
        invocations.moreExpiredTombstones || projections.moreEligible,
    };
  }
}
