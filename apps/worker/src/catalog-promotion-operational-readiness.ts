import type {
  CatalogPromotionAlertSink,
  CatalogPromotionHealth,
  CatalogPromotionHealthSink,
  PromotionOperationalReadinessService,
} from "@packscout/services";

/** Bridges catalog runner callbacks into the lane-generic durable evaluator. */
export class CatalogPromotionOperationalReadinessSink
  implements CatalogPromotionAlertSink, CatalogPromotionHealthSink
{
  constructor(
    private readonly readiness: Pick<
      PromotionOperationalReadinessService,
      "assess" | "publicationFailed"
    >,
  ) {}

  report(health: CatalogPromotionHealth): Promise<void> {
    void health;
    return this.readiness.assess();
  }

  notify(input: {
    attemptId: string;
    requestedWatermark: bigint;
    failureCode: string;
    occurredAt: Date;
  }): Promise<void> {
    return this.readiness.publicationFailed({
      attemptId: input.attemptId,
      targetWatermark: input.requestedWatermark,
      failureCode: input.failureCode,
    });
  }
}
