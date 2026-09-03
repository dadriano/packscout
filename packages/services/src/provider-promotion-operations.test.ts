import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  providerReleaseReceiptDigest,
  type ProviderReleaseExpectedCompletedHeadV1,
} from "@packscout/contracts";
import { buildProviderCatalogReleasePublishPlan } from "./provider-catalog-release-artifacts.ts";
import { projectProviderCatalogRelease } from "./provider-catalog-release-public-projection.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureCheckpoint,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";
import {
  ProviderPromotionPreparationError,
  parseProviderPromotionOperation,
  prepareProviderPromotion,
  providerPromotionStatusRequest,
  reconstructVerifiedProviderPromotionPlan,
  validateProviderPromotionReceipt,
} from "./provider-promotion-operations.ts";

async function fixture() {
  const checkpoint = providerFixtureCheckpoint();
  const configuration = providerFixtureApprovedConfiguration();
  const snapshot = providerFixtureSnapshot({ checkpoint, configuration });
  const projection = projectProviderCatalogRelease({
    configuration,
    platformKey: "alpha",
    revisions: snapshot.revisions,
    assetPackAssociations: snapshot.assetPackAssociations,
    repackIdentities: snapshot.repackIdentities,
  });
  const plan = await buildProviderCatalogReleasePublishPlan({
    checkpoint: snapshot.checkpoint,
    configuration: snapshot.configuration,
    projection,
    lastSuccessfulObservationAt:
      snapshot.observation.lastSuccessfulObservationAt,
  });
  const expectedCompletedHead: ProviderReleaseExpectedCompletedHeadV1 = {
    platformKey: "alpha",
    publicProviderReleaseId: null,
    sharedConfigurationEpoch: null,
    providerCheckpoint: { settledSequence: "0", settledAt: null },
    observation: null,
    terminalReceiptSha256: null,
  };
  return { plan, expectedCompletedHead, checkpointSha256: "a".repeat(64) };
}

test("prepares exact ordered start, batches, and finalize operations", async () => {
  const input = await fixture();
  const prepared = prepareProviderPromotion(input);

  assert.equal(prepared.operations.length, input.plan.batches.length + 2);
  assert.equal(prepared.operations[0]!.operationKind, "start");
  assert.equal(prepared.operations.at(-1)!.operationKind, "finalize");
  assert.ok(prepared.operations.slice(1, -1).every(
    ({ operationKind }) => operationKind === "applyBatch",
  ));
  prepared.operations.forEach((operation, index) => {
    assert.equal(operation.operationIndex, index);
    parseProviderPromotionOperation(operation);
    assert.equal(
      providerPromotionStatusRequest(operation).target.requestDigest,
      operation.requestSha256,
    );
  });
  assert.deepEqual(
    await reconstructVerifiedProviderPromotionPlan({
      summary: prepared.summary,
      operations: prepared.operations,
    }),
    input.plan,
  );
});

test("receipt proof uses persisted operation kind, never an ID-prefix guess", async () => {
  const input = await fixture();
  const operation = prepareProviderPromotion(input).operations[0]!;
  const request = parseProviderPromotionOperation(operation);
  assert.ok("release" in request);
  const withoutDigest = {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationKind: "start" as const,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    platformKey: request.release.platformKey,
    publicProviderReleaseId: request.release.publicProviderReleaseId,
    sharedConfigurationEpoch: request.release.sharedConfigurationEpoch,
    providerCheckpoint: request.providerCheckpoint,
    terminalState: "staging" as const,
    result: "created" as const,
    serverTime: "2026-08-15T03:00:01.000Z",
    requestDigest: operation.requestSha256,
    details: {
      release: request.release,
      providerCheckpoint: request.providerCheckpoint,
      sourceWatermark: request.sourceWatermark,
      observation: request.observation,
      expectedCompletedHead: request.expectedCompletedHead,
      acceptedBatchCount: 0 as const,
    },
  };
  const receipt = {
    ...withoutDigest,
    receiptDigest: await providerReleaseReceiptDigest(withoutDigest),
  };
  validateProviderPromotionReceipt({ operation, receipt });

  const mismatched = {
    ...operation,
    operationKind: "finalize" as const,
    requestPath: "/internal/provider-release/v1/finalize" as const,
  };
  assert.throws(
    () => validateProviderPromotionReceipt({ operation: mismatched, receipt }),
    (error: unknown) =>
      error instanceof ProviderPromotionPreparationError &&
      error.code === "PROVIDER_RECEIPT_INVALID",
  );
});
