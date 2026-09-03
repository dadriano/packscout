import {
  PrismaProviderPromotionImmediateDeliveryRepository,
  PrismaProviderPromotionJobRepository,
  promotionJobSha256,
  type PromotionWakeIntent,
  type ProviderPrismaClient,
  type ProviderPromotionImmediateDeliveryPort,
} from "@packscout/database";
import {
  promotionImmediateDeliveryTimeout,
  waitForPromotionImmediateDelivery,
} from "./promotion-immediate-delivery-timeout.ts";

export interface ProviderCanonicalPromotionWakeReader {
  loadWakeIntent(): Promise<PromotionWakeIntent>;
}

/**
 * Post-commit source seam. It can only nudge the provider ID already bound to
 * the provider database, and deliberately absorbs every lossy-channel error.
 */
export class ProviderCanonicalPromotionImmediateDelivery {
  readonly #deliveryTimeoutMilliseconds: number;

  constructor(private readonly dependencies: Readonly<{
    wake: ProviderCanonicalPromotionWakeReader;
    delivery: ProviderPromotionImmediateDeliveryPort;
    now?: () => Date;
    deliveryTimeoutMilliseconds?: number;
  }>) {
    this.#deliveryTimeoutMilliseconds = promotionImmediateDeliveryTimeout(
      dependencies.deliveryTimeoutMilliseconds,
    );
  }

  async request(providerId: string): Promise<void> {
    try {
      await waitForPromotionImmediateDelivery(
        async () => {
          const wake = await this.dependencies.wake.loadWakeIntent();
          if (!wake.pending || wake.requestedGeneration < 1n) return;
          const requestedAt = wake.latestRequestedAt ??
            this.dependencies.now?.() ?? new Date();
          await this.dependencies.delivery.request({
            authority: "provider_publication",
            cause: wake.latestCause === "central_invalidation"
              ? "central_invalidation"
              : "canonical_settlement",
            scopeId: providerId,
            sourceGeneration: wake.requestedGeneration,
            sourceEvidenceDigest: promotionJobSha256([
              "packscout-provider-promotion-immediate-v1",
              providerId.toLowerCase(),
              wake.requestedGeneration.toString(),
              wake.latestCause ?? "unknown",
              requestedAt.toISOString(),
            ].join(":")),
            requestedAt,
          });
        },
        this.#deliveryTimeoutMilliseconds,
      );
    } catch {
      // Correctness belongs to the durable wake and one-minute schedule.
    }
  }
}

export function createProviderCanonicalPromotionImmediateDelivery(
  provider: ProviderPrismaClient,
  delivery: ProviderPromotionImmediateDeliveryPort =
    new PrismaProviderPromotionImmediateDeliveryRepository(provider),
): ProviderCanonicalPromotionImmediateDelivery {
  return new ProviderCanonicalPromotionImmediateDelivery({
    wake: new PrismaProviderPromotionJobRepository(provider),
    delivery,
  });
}
