import assert from "node:assert/strict";
import test from "node:test";
import type { PromotionWakeIntent } from "@packscout/database";
import { ProviderCanonicalPromotionImmediateDelivery } from
  "./provider-canonical-promotion-immediate-delivery.ts";

const requestedAt = new Date("2026-09-02T06:10:00.000Z");

function wake(
  input: Partial<PromotionWakeIntent> = {},
): PromotionWakeIntent {
  return {
    authority: "provider_publication",
    requestedGeneration: 9n,
    acknowledgedGeneration: 8n,
    latestCause: "canonical_settlement",
    latestRequestedAt: requestedAt,
    pending: true,
    latestDeliveryGeneration: null,
    latestDeliveryState: null,
    lastDeliveryAttemptAt: null,
    latestDeliveryFailureCode: null,
    ...input,
  };
}

test("committed canonical wake sends one scoped best-effort hint", async () => {
  const deliveries: unknown[] = [];
  const hints = new ProviderCanonicalPromotionImmediateDelivery({
    wake: { loadWakeIntent: () => Promise.resolve(wake()) },
    delivery: {
      request(input) {
        deliveries.push(input);
        return Promise.resolve();
      },
    },
  });

  await hints.request("00000000-0000-4000-8000-000000000501");
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0], {
    authority: "provider_publication",
    cause: "canonical_settlement",
    scopeId: "00000000-0000-4000-8000-000000000501",
    sourceGeneration: 9n,
    sourceEvidenceDigest:
      "9058bb56a9aa3d2f1f8092d7984c85790ab94e1ee69e5155707f057b7b05ef55",
    requestedAt,
  });
});

test("lost source hint never fails the committed canonical operation", async () => {
  const hints = new ProviderCanonicalPromotionImmediateDelivery({
    wake: { loadWakeIntent: () => Promise.resolve(wake()) },
    delivery: {
      request: () => Promise.reject(new Error("LISTEN host unavailable")),
    },
  });
  await assert.doesNotReject(
    hints.request("00000000-0000-4000-8000-000000000501"),
  );

  const synchronouslyThrowingHints =
    new ProviderCanonicalPromotionImmediateDelivery({
      wake: { loadWakeIntent: () => Promise.resolve(wake()) },
      delivery: {
        request() {
          throw new Error("notification transport rejected the request");
        },
      },
    });
  await assert.doesNotReject(
    synchronouslyThrowingHints.request(
      "00000000-0000-4000-8000-000000000501",
    ),
  );

  const hangingHints = new ProviderCanonicalPromotionImmediateDelivery({
    wake: { loadWakeIntent: () => Promise.resolve(wake()) },
    delivery: { request: () => new Promise<void>(() => undefined) },
    deliveryTimeoutMilliseconds: 5,
  });
  await assert.doesNotReject(
    hangingHints.request("00000000-0000-4000-8000-000000000501"),
  );

  const hangingWakeHints = new ProviderCanonicalPromotionImmediateDelivery({
    wake: {
      loadWakeIntent: () => new Promise<PromotionWakeIntent>(() => undefined),
    },
    delivery: { request: () => Promise.resolve() },
    deliveryTimeoutMilliseconds: 5,
  });
  await assert.doesNotReject(
    hangingWakeHints.request("00000000-0000-4000-8000-000000000501"),
  );

  let called = false;
  const caughtUp = new ProviderCanonicalPromotionImmediateDelivery({
    wake: {
      loadWakeIntent: () => Promise.resolve(wake({
        requestedGeneration: 9n,
        acknowledgedGeneration: 9n,
        pending: false,
      })),
    },
    delivery: {
      request() {
        called = true;
        return Promise.resolve();
      },
    },
  });
  await caughtUp.request("00000000-0000-4000-8000-000000000501");
  assert.equal(called, false);
});
