import type { CentralPrismaClient } from "@packscout/database";
import {
  PrismaPromotionJobLivenessRepository,
  type PromotionJobEvaluatorWatchdogEvidenceRecord,
} from "@packscout/database";
import {
  evaluatePromotionJobEvaluatorWatchdog,
  promotionJobEvaluatorWatchdogResponse,
  type PromotionJobEvaluatorWatchdogResponse,
} from "@packscout/services";

export interface PromotionJobEvaluatorWatchdogEvidenceSource {
  readWatchdogEvidence():
    Promise<PromotionJobEvaluatorWatchdogEvidenceRecord>;
}

/**
 * The independently deployable evaluator detector has one read capability and
 * one safe projection. It cannot enumerate providers or mutate any job state.
 */
export class PromotionJobEvaluatorWatchdogBoundary {
  readonly #now: () => Date;

  constructor(
    private readonly evidence: PromotionJobEvaluatorWatchdogEvidenceSource,
    options: Readonly<{ now?: () => Date }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
  }

  async inspect(): Promise<PromotionJobEvaluatorWatchdogResponse> {
    const observed = await this.evidence.readWatchdogEvidence();
    return promotionJobEvaluatorWatchdogResponse(
      evaluatePromotionJobEvaluatorWatchdog(observed, this.#now()),
    );
  }
}

/** Read-only production composition; scheduling and alerting remain external. */
export function createPromotionJobEvaluatorWatchdogBoundary(
  central: CentralPrismaClient,
  options: Readonly<{ now?: () => Date }> = {},
): PromotionJobEvaluatorWatchdogBoundary {
  return new PromotionJobEvaluatorWatchdogBoundary(
    new PrismaPromotionJobLivenessRepository(central),
    options,
  );
}
