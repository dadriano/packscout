import assert from "node:assert/strict";
import test from "node:test";
import type { CentralPrismaClient } from "./central-database.ts";
import type { ProviderPrismaClient } from "./provider-database.ts";
import {
  PrismaManifestPromotionImmediateDeliveryRepository,
  PrismaProviderPromotionImmediateDeliveryRepository,
} from "./promotion-job-immediate-delivery-repository.ts";

interface CapturedTransactionOptions {
  readonly maxWait: number;
  readonly timeout: number;
  readonly isolationLevel: string;
}

function transactionClient(): Readonly<{
  client: ProviderPrismaClient | CentralPrismaClient;
  options: CapturedTransactionOptions[];
  queryCount(): number;
}> {
  const options: CapturedTransactionOptions[] = [];
  let queries = 0;
  const client = {
    $transaction(
      operation: (transaction: {
        $queryRaw(statement: unknown): Promise<unknown>;
      }) => Promise<unknown>,
      transactionOptions: CapturedTransactionOptions,
    ) {
      options.push(transactionOptions);
      return operation({
        $queryRaw() {
          queries += 1;
          return Promise.resolve([]);
        },
      });
    },
  } as unknown as ProviderPrismaClient | CentralPrismaClient;
  return { client, options, queryCount: () => queries };
}

test("authority-local notification publishers use a sub-second transaction", async () => {
  const provider = transactionClient();
  await new PrismaProviderPromotionImmediateDeliveryRepository(
    provider.client as ProviderPrismaClient,
  ).request({
    authority: "provider_publication",
    cause: "canonical_settlement",
    scopeId: "00000000-0000-4000-8000-000000000501",
    sourceGeneration: 7n,
    sourceEvidenceDigest: "a".repeat(64),
    requestedAt: new Date("2026-09-02T06:00:00.000Z"),
  });

  const central = transactionClient();
  await new PrismaManifestPromotionImmediateDeliveryRepository(
    central.client as CentralPrismaClient,
  ).request({
    authority: "manifest_reconciliation",
    cause: "provider_completion",
    scopeId: "00000000-0000-4000-8000-000000000501",
    sourceGeneration: 9n,
    sourceEvidenceDigest: "b".repeat(64),
    requestedAt: new Date("2026-09-02T06:01:00.000Z"),
  });

  for (const captured of [provider, central]) {
    assert.equal(captured.queryCount(), 1);
    assert.equal(captured.options.length, 1);
    assert.deepEqual(captured.options[0], {
      maxWait: 250,
      timeout: 500,
      isolationLevel: "ReadCommitted",
    });
  }
});
