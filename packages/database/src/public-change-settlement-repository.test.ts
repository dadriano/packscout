import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
  createPublicDerivationObligations,
  PrismaPublicChangeSettlementRepository,
} from "./public-change-settlement-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const firstOrganizationId = "52000000-0000-4000-8000-000000000001";
const secondOrganizationId = "52000000-0000-4000-8000-000000000002";

function changes(count: number, occurredAt: Date, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    changeKind: "manual_correction" as const,
    entityKey: `canonical:v1:${prefix}-${index}`,
    sourceKey: prefix,
    sourceRevisionKey: `${index}`,
    metadata: { index },
    occurredAt,
    catalogImpact: { kind: "none" } as const,
  }));
}

test("causes roll back with their authoritative write and settlement never skips a pending obligation", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: firstOrganizationId,
        slug: "causal-settlement",
        name: "Causal Settlement",
      },
    });
    await assert.rejects(
      harness.client.$transaction(async (transaction) => {
        await allocatePublicChangeCauses(transaction, {
          organizationId: firstOrganizationId,
          changes: changes(
            1,
            new Date("2026-08-15T01:00:00.000Z"),
            "rollback",
          ),
        });
        await transaction.organizations.update({
          where: { id: firstOrganizationId },
          data: { name: "Must Roll Back" },
        });
        throw new Error("authoritative write rollback sentinel");
      }),
      /rollback sentinel/,
    );
    assert.equal(await harness.client.public_change_causes.count(), 0);
    assert.equal(await harness.client.settled_public_watermarks.count(), 0);
    assert.equal(
      (
        await harness.client.organizations.findUniqueOrThrow({
          where: { id: firstOrganizationId },
        })
      ).name,
      "Causal Settlement",
    );

    const createdAt = new Date("2026-08-15T01:01:00.000Z");
    const causes = await harness.client.$transaction(async (transaction) => {
      const allocated = await allocatePublicChangeCauses(transaction, {
        organizationId: firstOrganizationId,
        changes: changes(3, createdAt, "contiguous"),
      });
      await createPublicDerivationObligations(transaction, {
        organizationId: firstOrganizationId,
        causeSequences: [allocated[1]!.sequence],
        derivationKind: "estimated_ev",
        derivationKey: "settlement-test-obligation",
        createdAt,
      });
      return allocated;
    });
    assert.deepEqual(
      causes.map(({ sequence }) => sequence),
      [1n, 2n, 3n],
    );
    assert.equal(
      new Set(causes.map(({ authoritativeTransactionId }) => authoritativeTransactionId))
        .size,
      1,
    );

    const blocked = await harness.client.$transaction((transaction) =>
      advanceSettledPublicWatermark(transaction, {
        organizationId: firstOrganizationId,
        settledAt: new Date("2026-08-15T01:01:01.000Z"),
      }));
    assert.equal(blocked.settledSequence, 1n);
    assert.equal(blocked.sourceHeadSequence, 3n);

    const acknowledgementToken = randomUUID();
    const completedAt = new Date("2026-08-15T01:01:02.000Z");
    await harness.client.public_derivation_obligations.updateMany({
      where: {
        organization_id: firstOrganizationId,
        cause_sequence: 2n,
      },
      data: {
        state: "succeeded",
        outcome_classification: "success",
        acknowledged_claim_token: acknowledgementToken,
        outcome_at: completedAt,
        updated_at: completedAt,
      },
    });
    const settled = await harness.client.$transaction((transaction) =>
      advanceSettledPublicWatermark(transaction, {
        organizationId: firstOrganizationId,
        settledAt: completedAt,
      }));
    assert.equal(settled.settledSequence, 3n);
    const stale = await harness.client.$transaction((transaction) =>
      advanceSettledPublicWatermark(transaction, {
        organizationId: firstOrganizationId,
        settledAt: new Date("2026-08-15T01:00:00.000Z"),
      }));
    assert.equal(stale.settledSequence, 3n);
    assert.equal(stale.settledAt?.toISOString(), completedAt.toISOString());

    const reader = new PrismaPublicChangeSettlementRepository(harness.client);
    const settledCauses = await reader.listSettledCauses({
      organizationId: firstOrganizationId,
      afterSequence: 0n,
      throughSequence: 3n,
      limit: 10,
    });
    assert.deepEqual(
      settledCauses.map(({ sequence }) => sequence),
      [1n, 2n, 3n],
    );
    await assert.rejects(
      reader.listSettledCauses({
        organizationId: firstOrganizationId,
        afterSequence: 3n,
        throughSequence: 4n,
        limit: 10,
      }),
      /beyond settlement/,
    );
  } finally {
    await harness.close();
  }
});

test("concurrent allocators produce one contiguous organization sequence without regression", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: secondOrganizationId,
        slug: "concurrent-causal-sequence",
        name: "Concurrent Causal Sequence",
      },
    });
    const independent = await harness.createIndependentClient();
    const occurredAt = new Date("2026-08-15T02:00:00.000Z");
    await Promise.all([
      harness.client.$transaction(async (transaction) => {
        await allocatePublicChangeCauses(transaction, {
          organizationId: secondOrganizationId,
          changes: changes(25, occurredAt, "left"),
        });
        await advanceSettledPublicWatermark(transaction, {
          organizationId: secondOrganizationId,
          settledAt: occurredAt,
        });
      }),
      independent.$transaction(async (transaction) => {
        await allocatePublicChangeCauses(transaction, {
          organizationId: secondOrganizationId,
          changes: changes(25, occurredAt, "right"),
        });
        await advanceSettledPublicWatermark(transaction, {
          organizationId: secondOrganizationId,
          settledAt: occurredAt,
        });
      }),
    ]);

    const causes = await harness.client.public_change_causes.findMany({
      where: { organization_id: secondOrganizationId },
      orderBy: { sequence: "asc" },
    });
    assert.deepEqual(
      causes.map(({ sequence }) => sequence),
      Array.from({ length: 50 }, (_, index) => BigInt(index + 1)),
    );
    assert.equal(
      new Set(causes.map(({ authoritative_transaction_id }) => authoritative_transaction_id))
        .size,
      2,
    );
    const checkpoint =
      await harness.client.settled_public_watermarks.findUniqueOrThrow({
        where: { organization_id: secondOrganizationId },
      });
    assert.equal(checkpoint.source_head_sequence, 50n);
    assert.equal(checkpoint.settled_sequence, 50n);
  } finally {
    await harness.close();
  }
});
