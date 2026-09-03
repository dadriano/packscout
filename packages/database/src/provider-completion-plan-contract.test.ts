import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderCompletionPlanProofError,
  verifyProviderCompletedPublishPlanRelayProof,
} from "./provider-completion-plan-contract.ts";
import { buildProviderCompletionPlanProofFixture } from
  "./provider-completion-plan-test-support.ts";

const fixtureInput = {
  providerId: "72000000-0000-4000-8000-000000000002",
  providerKey: "contract_provider",
  providerReleaseId: "72000000-0000-5000-8000-000000000021",
  catalogVersionId: "72000000-0000-4000-8000-000000000010",
  catalogContentHash: "a".repeat(64),
  artifactAttemptId: "72000000-0000-4000-8000-000000000041",
  releaseSequence: 21n,
} as const;

test("completion plan proof verifies every exact public artifact", async () => {
  const proof = await buildProviderCompletionPlanProofFixture(fixtureInput);
  const verified = await verifyProviderCompletedPublishPlanRelayProof(proof);

  assert.equal(verified.planSha256.length, 64);
  assert.equal(verified.completedHeadSha256.length, 64);
  assert.equal(verified.activeObservationSha256.length, 64);
  assert.equal(verified.plan.platformKey, fixtureInput.providerKey);
  assert.equal(
    verified.completedHead.terminalReceiptSha256,
    verified.terminalReceiptSha256,
  );
});

test("completion plan proof rejects tamper and redacts untrusted values", async () => {
  const proof = await buildProviderCompletionPlanProofFixture(fixtureInput);
  const secret = "postgresql://operator:secret@private.internal/provider";
  const withUnexpectedSecret = {
    ...proof,
    databaseUrl: secret,
  };

  await assert.rejects(
    verifyProviderCompletedPublishPlanRelayProof(withUnexpectedSecret),
    (error: unknown) => {
      assert.ok(error instanceof ProviderCompletionPlanProofError);
      assert.equal(error.code, "PROVIDER_COMPLETION_PLAN_PROOF_INVALID");
      assert.doesNotMatch(error.message, /operator|secret|private\.internal/u);
      assert.doesNotMatch(JSON.stringify(error), /operator|secret|private\.internal/u);
      return true;
    },
  );

  await assert.rejects(
    verifyProviderCompletedPublishPlanRelayProof({
      ...proof,
      activeObservation: {
        ...proof.activeObservation,
        terminalOperationId: "tampered-operation",
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderCompletionPlanProofError);
      assert.equal(error.code, "PROVIDER_COMPLETION_PLAN_PROOF_INVALID");
      return true;
    },
  );
});
