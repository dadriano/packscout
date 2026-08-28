import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clutchpacksCatalogCanaryProviderIsComplete,
} from "./clutchpacks-catalog-canary-composition.ts";

function proof(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    checkpoint: { settledSequence: 20n },
    completedHead: {
      targetCheckpoint: 20n,
      publicProviderReleaseId: "provider-release-complete",
    },
    health: {
      requestedEvaluationSequence: 7n,
      confirmedEvaluationSequence: 7n,
      completedCheckpoint: 20n,
      completedPublicProviderReleaseId: "provider-release-complete",
      activeAttemptId: null,
    },
    ...overrides,
  };
}

test("canary requires every durable provider evaluation before manifest", () => {
  assert.equal(clutchpacksCatalogCanaryProviderIsComplete(proof()), true);
  assert.equal(clutchpacksCatalogCanaryProviderIsComplete(proof({
    health: {
      ...proof().health,
      requestedEvaluationSequence: 8n,
      confirmedEvaluationSequence: 7n,
    },
  })), false);
  assert.equal(clutchpacksCatalogCanaryProviderIsComplete(proof({
    health: { ...proof().health, activeAttemptId: "pending-attempt" },
  })), false);
});
