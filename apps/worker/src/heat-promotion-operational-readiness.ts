import type {
  HeatPromotionAlertSink,
  HeatPromotionHealth,
  HeatPromotionHealthSink,
  PromotionOperationalReadinessService,
} from "@packscout/services";

/** Bridges Heat runner callbacks into the lane-generic durable evaluator. */
export class HeatPromotionOperationalReadinessSink
  implements HeatPromotionAlertSink, HeatPromotionHealthSink
{
  constructor(
    private readonly readiness: Pick<
      PromotionOperationalReadinessService,
      "assess" | "publicationFailed"
    >,
  ) {}

  report(health: HeatPromotionHealth): Promise<void> {
    void health;
    return this.readiness.assess();
  }

  notify(input: {
    attemptId: string;
    frameSequence: bigint;
    failureCode: string;
    occurredAt: Date;
  }): Promise<void> {
    return this.readiness.publicationFailed({
      attemptId: input.attemptId,
      targetWatermark: input.frameSequence,
      failureCode: input.failureCode,
    });
  }
}
