import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Prisma } from "../prisma/generated/provider/index.js";
import {
  ProviderCanonicalImmutableFactConflictError,
  ProviderCanonicalInputError,
  ProviderCanonicalWriteConflictError,
  type CollectibleWriteInput,
  type PackWriteInput,
} from "./provider-canonical-contract.ts";
import { ProviderCanonicalRepository } from "./provider-canonical-repository.ts";
import { type ProviderQueryClient } from "./provider-database.ts";
import { PrismaProviderWorkerLeaseRepository } from
  "./provider-worker-lease-repository.ts";
import { resolveProviderFactReferencesBatch } from "./provider-fact-reference-reconciliation.ts";

import { createProviderHarness, type ProviderHarness } from "./provider-canonical-integration-support.ts";
const fixedInstant = new Date("2026-08-29T12:34:56.123456Z");

function packInput(categoryId: string): PackWriteInput {
  return {
    packKey: "pack-stable-key",
    categoryId,
    familyKey: "family-one",
    displayName: "Exact Decimal Repack",
    description: null,
    packFormat: "repack",
    availability: "available",
    contentEvidence: "complete",
    totalInventory: 100n,
    remainingInventory: 90n,
    priceAmount: "12345678901234567890.123456789012345678",
    priceCurrency: "USD",
    priceUsdAmount: "12345678901234567890.123456789012345678",
    priceUnavailableReason: null,
    buybackRate: "0.750000000000000000",
    buybackSourceKind: "provider",
    vendorEvAmount: null,
    vendorEvCurrency: null,
    vendorEvObservedAt: null,
    vendorEvUnavailableReason: null,
    packscoutEvAmount: null,
    packscoutEvCurrency: null,
    packscoutEvModelVersion: "model-v1",
    packscoutEvConfidencePolicyVersion: "policy-v1",
    packscoutEvConfidence: null,
    packscoutEvDataAsOf: null,
    packscoutEvCalculatedAt: null,
    packscoutEvUnavailableReason: null,
    primaryImageUrl: null,
    primaryImageAlt: null,
    listingUrl: null,
    attributes: { source: "integration" },
    sourceUpdatedAt: fixedInstant,
  };
}

function collectibleInput(
  categoryId: string,
  collectibleKey: string,
  displayName: string,
  cardNumber: string,
): CollectibleWriteInput {
  return {
    collectibleKey,
    categoryId,
    collectibleType: "card",
    displayName,
    normalizedName: displayName.toLowerCase(),
    year: 2026,
    brand: "PackScout",
    setOrSeries: "Deferred Relationship Test",
    cardNumber,
    referenceNumber: null,
    subject: displayName,
    grade: null,
    grader: null,
    primaryImageUrl: null,
    primaryImageAlt: null,
    valuationAmount: null,
    valuationCurrency: null,
    valuationUsdAmount: null,
    valuationUnavailableReason: "unavailable",
    valuationType: null,
    valuationObservedAt: null,
    dataAsOf: fixedInstant,
    attributes: { source: "deferred-relationship-test" },
  };
}

async function exerciseCanonicalWarehouse(harness: ProviderHarness): Promise<{
  readonly categoryId: string;
  readonly packId: string;
  readonly finalSequence: bigint;
}> {
  const repository = new ProviderCanonicalRepository(harness.client);
  const leases = new PrismaProviderWorkerLeaseRepository(harness.client);
  const leaseOwner = `canonical-integration-${process.pid}`;
  const acquired = await leases.acquire({
    role: "import",
    owner: leaseOwner,
    leaseMilliseconds: 60_000,
  });
  if (acquired.kind === "held") {
    throw new Error("The isolated provider test import lease is unexpectedly held.");
  }
  let reconciliationAuthority = {
    workerId: leaseOwner,
    workerFence: acquired.lease.fence,
  };
  await repository.transaction(async (canonical) => {
    assert.equal("reconcileFactReferences" in canonical, false);
  });
  const category = await repository.upsertCategory({
    categoryKey: "cards",
    parentCategoryId: null,
    displayName: "Cards",
  });
  assert.deepEqual(
    { version: category.rowVersion, changed: category.materialChange, sequence: category.promotionSequence },
    { version: 1n, changed: true, sequence: 1n },
  );

  const categoryReplay = await repository.upsertCategory({
    categoryKey: "cards",
    parentCategoryId: null,
    displayName: "Cards",
  });
  assert.deepEqual(
    {
      id: categoryReplay.id,
      version: categoryReplay.rowVersion,
      changed: categoryReplay.materialChange,
      sequence: categoryReplay.promotionSequence,
    },
    { id: category.id, version: 1n, changed: false, sequence: null },
  );

  const categoryUpdate = await repository.upsertCategory({
    categoryKey: "cards",
    parentCategoryId: null,
    displayName: "Trading Cards",
    expectedRowVersion: 1n,
  });
  assert.equal(categoryUpdate.rowVersion, 2n);
  assert.equal(categoryUpdate.promotionSequence, 2n);

  const collectible = await repository.upsertCollectible({
    collectibleKey: "collectible-stable-key",
    categoryId: category.id,
    collectibleType: "card",
    displayName: "Rookie Card",
    normalizedName: "rookie card",
    year: 2026,
    brand: "PackScout",
    setOrSeries: "Test Set",
    cardNumber: "1",
    referenceNumber: null,
    subject: "Test Subject",
    grade: null,
    grader: null,
    primaryImageUrl: null,
    primaryImageAlt: null,
    valuationAmount: "99999999999999999999.999999999999999999",
    valuationCurrency: "USD",
    valuationUsdAmount: "99999999999999999999.999999999999999999",
    valuationUnavailableReason: null,
    valuationType: "market",
    valuationObservedAt: fixedInstant,
    dataAsOf: fixedInstant,
    attributes: { rarity: "one-of-one" },
  });
  const secondaryCollectible = await repository.upsertCollectible({
    collectibleKey: "collectible-secondary-key",
    categoryId: category.id,
    collectibleType: "card",
    displayName: "Second Card",
    normalizedName: "second card",
    year: 2025,
    brand: "PackScout",
    setOrSeries: "Test Set",
    cardNumber: "2",
    referenceNumber: null,
    subject: "Second Subject",
    grade: null,
    grader: null,
    primaryImageUrl: null,
    primaryImageAlt: null,
    valuationAmount: null,
    valuationCurrency: null,
    valuationUsdAmount: null,
    valuationUnavailableReason: "unavailable",
    valuationType: null,
    valuationObservedAt: null,
    dataAsOf: fixedInstant,
    attributes: {},
  });
  const pack = await repository.upsertPack(packInput(category.id));
  const packReplay = await repository.upsertPack(packInput(category.id));
  assert.deepEqual(
    {
      id: packReplay.id,
      version: packReplay.rowVersion,
      changed: packReplay.materialChange,
      sequence: packReplay.promotionSequence,
    },
    { id: pack.id, version: 1n, changed: false, sequence: null },
  );
  const alias = await repository.upsertCollectibleNameAlias({
    collectibleId: collectible.id,
    displayName: "The Rookie",
    normalizedName: "the rookie",
  });
  assert.equal(alias.materialChange, true);
  const instance = await repository.upsertCollectibleInstance({
    collectibleId: collectible.id,
    instanceKey: "instance-stable-key",
    certifier: "PSA",
    certificationNumber: "12345678",
    attributes: { grade: 10 },
  });
  const content = await repository.upsertPackContent({
    packId: pack.id,
    collectibleId: collectible.id,
    collectibleInstanceId: instance.id,
    totalQuantity: 1n,
    availableQuantity: 1n,
    contentRole: "top_chase",
    probability: "0.123456789012345678",
    statedValueAmount: "99999999999999999999.999999999999999999",
    statedValueCurrency: "USD",
    evidenceKinds: ["vendor_odds", "packscout_resolved"],
    matchConfidenceBasisPoints: 8_000,
    observedAt: fixedInstant,
    displayOrder: 0,
  });
  assert.equal(content.materialChange, true);
  await repository.upsertPackContent({
    packId: pack.id,
    collectibleId: secondaryCollectible.id,
    collectibleInstanceId: null,
    totalQuantity: null,
    availableQuantity: null,
    contentRole: "possible_outcome",
    probability: null,
    statedValueAmount: null,
    statedValueCurrency: null,
    evidenceKinds: ["name_only"],
    matchConfidenceBasisPoints: 4_000,
    observedAt: fixedInstant,
    displayOrder: 1,
  });
  const account = await repository.upsertProviderAccount({
    accountKey: "c".repeat(64),
    displayName: "Pseudonymous Collector",
    attributes: { tier: "member" },
  });

  const pull = await repository.insertPull({
    pullKey: "pull-stable-key",
    factDigest: "a".repeat(64),
    packKey: "pack-stable-key",
    packId: pack.id,
    providerAccountId: account.id,
    occurredAt: fixedInstant,
    paidAmount: "12345678901234567890.123456789012345678",
    paidCurrency: "USD",
    items: [{
      collectibleKey: "collectible-stable-key",
      collectibleId: collectible.id,
      collectibleInstanceId: instance.id,
      quantity: 1n,
      statedValueAmount: "99999999999999999999.999999999999999999",
      statedValueCurrency: "USD",
    }, {
      collectibleKey: "collectible-secondary-key",
      collectibleId: secondaryCollectible.id,
      collectibleInstanceId: null,
      quantity: 2n,
      statedValueAmount: null,
      statedValueCurrency: null,
    }],
  });
  assert.equal(pull.replayed, false);
  assert.ok(pull.promotionRange);
  assert.equal(pull.promotionRange.last - pull.promotionRange.first, 2n);
  const pullReplay = await repository.insertPull({
    pullKey: "pull-stable-key",
    factDigest: "a".repeat(64),
    packKey: "pack-stable-key",
    packId: pack.id,
    providerAccountId: account.id,
    occurredAt: fixedInstant,
    paidAmount: "12345678901234567890.123456789012345678",
    paidCurrency: "USD",
    items: [{
      collectibleKey: "collectible-stable-key",
      collectibleId: collectible.id,
      collectibleInstanceId: instance.id,
      quantity: 1n,
      statedValueAmount: "99999999999999999999.999999999999999999",
      statedValueCurrency: "USD",
    }, {
      collectibleKey: "collectible-secondary-key",
      collectibleId: secondaryCollectible.id,
      collectibleInstanceId: null,
      quantity: 2n,
      statedValueAmount: null,
      statedValueCurrency: null,
    }],
  });
  assert.equal(pullReplay.replayed, true);
  assert.equal(pullReplay.promotionRange, null);
  await assert.rejects(
    repository.insertPull({
      pullKey: "pull-stable-key",
      factDigest: "d".repeat(64),
      packKey: "pack-stable-key",
      packId: pack.id,
      providerAccountId: account.id,
      occurredAt: fixedInstant,
      paidAmount: "1",
      paidCurrency: "USD",
      items: [{
        collectibleKey: "collectible-stable-key",
        collectibleId: collectible.id,
        collectibleInstanceId: instance.id,
        quantity: 1n,
        statedValueAmount: null,
        statedValueCurrency: null,
      }],
    }),
    ProviderCanonicalImmutableFactConflictError,
  );

  const marketEvent = await repository.insertMarketEvent({
    eventKey: "market-stable-key",
    factDigest: "b".repeat(64),
    eventGroupId: randomUUID(),
    eventType: "sale",
    packKey: null,
    packId: null,
    collectibleKey: "collectible-stable-key",
    collectibleId: collectible.id,
    collectibleInstanceId: instance.id,
    fromProviderAccountId: account.id,
    toProviderAccountId: null,
    quantity: 1n,
    occurredAt: fixedInstant,
    amount: "99999999999999999999.999999999999999999",
    currency: "USD",
    details: { channel: "provider" },
  });
  assert.equal(marketEvent.replayed, false);
  const marketReplay = await repository.insertMarketEvent({
    eventKey: "market-stable-key",
    factDigest: "b".repeat(64),
    eventGroupId: randomUUID(),
    eventType: "sale",
    packKey: null,
    packId: null,
    collectibleKey: "collectible-stable-key",
    collectibleId: collectible.id,
    collectibleInstanceId: instance.id,
    fromProviderAccountId: account.id,
    toProviderAccountId: null,
    quantity: 1n,
    occurredAt: fixedInstant,
    amount: "99999999999999999999.999999999999999999",
    currency: "USD",
    details: { channel: "provider" },
  });
  assert.equal(marketReplay.replayed, true);
  assert.equal(marketReplay.id, marketEvent.id);
  await assert.rejects(
    repository.insertMarketEvent({
      eventKey: "market-stable-key",
      factDigest: "e".repeat(64),
      eventGroupId: null,
      eventType: "sale",
      packKey: "pack-stable-key",
      packId: pack.id,
      collectibleKey: null,
      collectibleId: null,
      collectibleInstanceId: null,
      fromProviderAccountId: null,
      toProviderAccountId: account.id,
      quantity: 1n,
      occurredAt: fixedInstant,
      amount: "1",
      currency: "USD",
      details: {},
    }),
    ProviderCanonicalImmutableFactConflictError,
  );

  const unresolvedPull = await repository.insertPull({
    pullKey: "pull-before-catalog",
    factDigest: "1".repeat(64),
    packKey: "future-pack",
    packId: null,
    providerAccountId: null,
    occurredAt: fixedInstant,
    paidAmount: null,
    paidCurrency: null,
    items: [{
      collectibleKey: "future-collectible",
      collectibleId: null,
      collectibleInstanceId: null,
      quantity: 1n,
      statedValueAmount: null,
      statedValueCurrency: null,
    }],
  });
  const packOnlyPull = await repository.insertPull({
    pullKey: "pack-only-pull",
    factDigest: "2".repeat(64),
    packKey: "future-pack",
    packId: null,
    providerAccountId: null,
    occurredAt: fixedInstant,
    paidAmount: null,
    paidCurrency: null,
    items: [{
      collectibleKey: null,
      collectibleId: null,
      collectibleInstanceId: null,
      quantity: 1n,
      statedValueAmount: null,
      statedValueCurrency: null,
    }],
  });
  const unresolvedMarketEvent = await repository.insertMarketEvent({
    eventKey: "market-before-catalog",
    factDigest: "3".repeat(64),
    eventGroupId: null,
    eventType: "sale",
    packKey: "future-pack",
    packId: null,
    collectibleKey: "future-collectible",
    collectibleId: null,
    collectibleInstanceId: null,
    fromProviderAccountId: null,
    toProviderAccountId: null,
    quantity: 1n,
    occurredAt: fixedInstant,
    amount: "10",
    currency: "USD",
    details: {},
  });
  await assert.rejects(
    repository.insertPull({
      pullKey: "subjectless-pull",
      factDigest: "4".repeat(64),
      packKey: null,
      packId: null,
      providerAccountId: null,
      occurredAt: fixedInstant,
      paidAmount: null,
      paidCurrency: null,
      items: [{
        collectibleKey: null,
        collectibleId: null,
        collectibleInstanceId: null,
        quantity: 1n,
        statedValueAmount: null,
        statedValueCurrency: null,
      }],
    }),
    ProviderCanonicalInputError,
  );
  await assert.rejects(
    repository.insertMarketEvent({
      eventKey: "subjectless-event",
      factDigest: "5".repeat(64),
      eventGroupId: null,
      eventType: "sale",
      packKey: null,
      packId: null,
      collectibleKey: null,
      collectibleId: null,
      collectibleInstanceId: null,
      fromProviderAccountId: null,
      toProviderAccountId: null,
      quantity: null,
      occurredAt: fixedInstant,
      amount: null,
      currency: null,
      details: {},
    }),
    ProviderCanonicalInputError,
  );

  const futurePack = await repository.upsertPack({
    ...packInput(category.id),
    packKey: "future-pack",
    displayName: "Future Pack",
  });
  const futureCollectible = await repository.upsertCollectible(
    collectibleInput(category.id, "future-collectible", "Future Card", "F1"),
  );
  const resolution = await repository.reconcileFactReferences(
    reconciliationAuthority,
  );
  assert.ok(resolution);
  assert.deepEqual(
    {
      pullPacks: resolution.pullPackCount,
      pullItemCollectibles: resolution.pullItemCollectibleCount,
      marketPacks: resolution.marketEventPackCount,
      marketCollectibles: resolution.marketEventCollectibleCount,
      changes: resolution.materialChangeCount,
    },
    {
      pullPacks: 2,
      pullItemCollectibles: 1,
      marketPacks: 1,
      marketCollectibles: 1,
      changes: 5,
    },
  );
  assert.ok(resolution.promotionRange);
  assert.equal(
    resolution.promotionRange.last - resolution.promotionRange.first + 1n,
    5n,
  );
  assert.equal(
    (await repository.reconcileFactReferences(reconciliationAuthority))
      ?.materialChangeCount,
    0,
  );

  const resolvedPull = await harness.client.pulls.findUniqueOrThrow({
    where: { id: unresolvedPull.id },
    include: { items: true },
  });
  assert.equal(resolvedPull.pack_key, "future-pack");
  assert.equal(resolvedPull.pack_id, futurePack.id);
  assert.equal(resolvedPull.row_version, 2n);
  assert.equal(resolvedPull.items[0]?.collectible_key, "future-collectible");
  assert.equal(resolvedPull.items[0]?.collectible_id, futureCollectible.id);
  assert.equal(resolvedPull.items[0]?.row_version, 2n);
  const resolvedPackOnlyPull = await harness.client.pulls.findUniqueOrThrow({
    where: { id: packOnlyPull.id },
    include: { items: true },
  });
  assert.equal(resolvedPackOnlyPull.pack_id, futurePack.id);
  assert.equal(resolvedPackOnlyPull.items[0]?.collectible_key, null);
  assert.equal(resolvedPackOnlyPull.items[0]?.collectible_id, null);
  assert.equal(resolvedPackOnlyPull.items[0]?.row_version, 1n);
  const resolvedEvent = await harness.client.market_events.findUniqueOrThrow({
    where: { id: unresolvedMarketEvent.id },
  });
  assert.equal(resolvedEvent.pack_key, "future-pack");
  assert.equal(resolvedEvent.pack_id, futurePack.id);
  assert.equal(resolvedEvent.collectible_key, "future-collectible");
  assert.equal(resolvedEvent.collectible_id, futureCollectible.id);
  assert.equal(resolvedEvent.row_version, 3n);

  const boundedEventIds = Array.from({ length: 501 }, () => randomUUID());
  await harness.client.$transaction(async (transaction) => {
    await transaction.market_events.createMany({
      data: boundedEventIds.map((id, index) => ({
        id,
        event_key: `bounded-unresolved-${index}`,
        fact_digest: "6".repeat(64),
        event_group_id: null,
        event_type: "sale",
        pack_key: null,
        pack_id: null,
        collectible_key: "future-collectible",
        collectible_id: null,
        collectible_instance_id: null,
        from_provider_account_id: null,
        to_provider_account_id: null,
        quantity: 1n,
        occurred_at: fixedInstant,
        amount: null,
        currency: null,
        details: {},
      })),
    });
    const head = await transaction.promotion_ledger.update({
      where: { singleton_key: true },
      data: { last_sequence: { increment: BigInt(boundedEventIds.length) } },
      select: { last_sequence: true },
    });
    const first = head.last_sequence - BigInt(boundedEventIds.length) + 1n;
    await transaction.promotion_changes.createMany({
      data: boundedEventIds.map((id, index) => ({
        sequence: first + BigInt(index),
        entity_type: "market_event",
        entity_id: id,
        entity_version: 1n,
        operation: "upsert",
        changed_at: fixedInstant,
      })),
    });
  }, { maxWait: 5_000, timeout: 30_000 });
  const firstBoundedResolution = await repository.reconcileFactReferences(
    reconciliationAuthority,
  );
  assert.ok(firstBoundedResolution);
  assert.equal(firstBoundedResolution.marketEventCollectibleCount, 500);
  assert.equal(firstBoundedResolution.materialChangeCount, 500);
  const finalBoundedResolution = await repository.reconcileFactReferences(
    reconciliationAuthority,
  );
  assert.ok(finalBoundedResolution);
  assert.equal(finalBoundedResolution.marketEventCollectibleCount, 1);
  assert.equal(finalBoundedResolution.materialChangeCount, 1);
  assert.equal(
    (await repository.reconcileFactReferences(reconciliationAuthority))
      ?.materialChangeCount,
    0,
  );
  assert.equal(
    await harness.client.market_events.count({
      where: { id: { in: boundedEventIds }, collectible_id: null },
    }),
    0,
  );

  const fencedEvent = await repository.insertMarketEvent({
    eventKey: "fenced-unresolved-event",
    factDigest: "7".repeat(64),
    eventGroupId: null,
    eventType: "sale",
    packKey: null,
    packId: null,
    collectibleKey: "fenced-future-collectible",
    collectibleId: null,
    collectibleInstanceId: null,
    fromProviderAccountId: null,
    toProviderAccountId: null,
    quantity: 1n,
    occurredAt: fixedInstant,
    amount: null,
    currency: null,
    details: {},
  });
  const fencedCollectible = await repository.upsertCollectible(
    collectibleInput(
      category.id,
      "fenced-future-collectible",
      "Fenced Future Card",
      "F1",
    ),
  );
  assert.equal(await leases.release({
    role: "import",
    owner: leaseOwner,
    fence: reconciliationAuthority.workerFence,
  }), true);
  assert.equal(
    await repository.reconcileFactReferences(reconciliationAuthority),
    null,
  );
  assert.equal(
    (await harness.client.market_events.findUniqueOrThrow({
      where: { id: fencedEvent.id },
    })).collectible_id,
    null,
  );
  const reacquired = await leases.acquire({
    role: "import",
    owner: leaseOwner,
    leaseMilliseconds: 60_000,
  });
  if (reacquired.kind === "held") {
    throw new Error("The isolated provider test import lease was not reacquired.");
  }
  reconciliationAuthority = {
    workerId: leaseOwner,
    workerFence: reacquired.lease.fence,
  };
  assert.equal(
    (await repository.reconcileFactReferences(reconciliationAuthority))
      ?.marketEventCollectibleCount,
    1,
  );
  assert.equal(
    (await harness.client.market_events.findUniqueOrThrow({
      where: { id: fencedEvent.id },
    })).collectible_id,
    fencedCollectible.id,
  );

  const storedPack = await harness.client.packs.findUniqueOrThrow({ where: { id: pack.id } });
  const storedContent = await harness.client.pack_contents.findUniqueOrThrow({
    where: { id: content.id },
  });
  assert.equal(
    storedPack.price_amount?.toString(),
    "12345678901234567890.123456789012345678",
  );
  assert.equal(storedContent.probability?.toString(), "0.123456789012345678");

  const beforeRollback = await harness.client.promotion_ledger.findUniqueOrThrow({
    where: { singleton_key: true },
  });
  await assert.rejects(
    repository.transaction(async (canonical) => {
      await canonical.upsertCategory({
        categoryKey: "must-roll-back",
        parentCategoryId: null,
        displayName: "Rollback",
      });
      throw new Error("forced transaction failure");
    }),
    /forced transaction failure/,
  );
  assert.equal(
    await harness.client.categories.findUnique({ where: { category_key: "must-roll-back" } }),
    null,
  );
  assert.equal(
    (await harness.client.promotion_ledger.findUniqueOrThrow({
      where: { singleton_key: true },
    })).last_sequence,
    beforeRollback.last_sequence,
  );

  const retiredPack = await repository.retirePack({
    id: pack.id,
    expectedRowVersion: pack.rowVersion,
    retiredAt: new Date("2026-08-30T00:00:00Z"),
  });
  assert.equal(retiredPack.rowVersion, 2n);
  assert.equal(retiredPack.materialChange, true);
  const retireReplay = await repository.retirePack({ id: pack.id, expectedRowVersion: 2n });
  assert.equal(retireReplay.materialChange, false);
  assert.equal(retireReplay.promotionSequence, null);

  const head = await harness.client.promotion_ledger.findUniqueOrThrow({
    where: { singleton_key: true },
  });
  await leases.release({
    role: "import",
    owner: leaseOwner,
    fence: reconciliationAuthority.workerFence,
  });
  return { categoryId: category.id, packId: pack.id, finalSequence: head.last_sequence };
}

test(
  "canonical writes are idempotent, exact, atomic, and isolated in two provider databases",
  { concurrency: false },
  async (context) => {
    const harnesses: ProviderHarness[] = [];
    try {
      harnesses.push(await createProviderHarness());
      harnesses.push(await createProviderHarness());
    } catch (error) {
      await Promise.allSettled(harnesses.map((harness) => harness.close()));
      if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) {
        context.skip("PostgreSQL 16 test infrastructure is not available.");
        return;
      }
      throw error;
    }

    try {
      const first = await exerciseCanonicalWarehouse(harnesses[0]!);
      const second = await exerciseCanonicalWarehouse(harnesses[1]!);
      assert.notEqual(first.categoryId, second.categoryId);
      assert.notEqual(first.packId, second.packId);
      assert.equal(first.finalSequence, second.finalSequence);
      assert.equal(
        await harnesses[0]!.client.categories.count(),
        await harnesses[1]!.client.categories.count(),
      );
    } finally {
      await Promise.allSettled(harnesses.map((harness) => harness.close()));
    }
  },
);

test("reconciliation skips empty catalogs and index-probes 150,000 unrelated facts in bounded batches", {
  concurrency: false,
  timeout: 180_000,
}, async (context) => {
  if (process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL === undefined) {
    context.skip("An explicit disposable PostgreSQL test target is required.");
    return;
  }
  const harness = await createProviderHarness();
  const { client } = harness;
  try {
    // 501 facts span two late targets, proving the outer cap is global rather
    // than 500 per catalog key. Another 50,000 keys never receive catalog rows.
    await client.$transaction(async (seed) => {
      await seed.$executeRaw`
        INSERT INTO pulls (id, pull_key, fact_digest, pack_key, item_count, occurred_at)
        SELECT md5('synthetic-pull-' || n)::uuid, 'synthetic-pull-' || n, repeat('a', 64),
          CASE WHEN n <= 251 THEN 'late-pack-a' WHEN n <= 501 THEN 'late-pack-b'
            ELSE 'missing-pack-' || n END, 1, CURRENT_TIMESTAMP
        FROM generate_series(1, 50501) AS n
      `;
      await seed.$executeRaw`
        INSERT INTO pull_items (pull_id, ordinal, collectible_key, quantity)
        SELECT md5('synthetic-pull-' || n)::uuid, 1,
          CASE WHEN n <= 251 THEN 'late-card-a' WHEN n <= 501 THEN 'late-card-b'
            ELSE 'missing-card-' || n END, 1
        FROM generate_series(1, 50501) AS n
      `;
      await seed.$executeRaw`
        INSERT INTO market_events (event_key, fact_digest, event_type, pack_key, collectible_key, occurred_at)
        SELECT 'synthetic-event-' || n, repeat('b', 64), 'sale'::market_event_type,
          CASE WHEN n <= 251 THEN 'late-pack-a' WHEN n <= 501 THEN 'late-pack-b'
            ELSE 'missing-pack-' || n END,
          CASE WHEN n <= 251 THEN 'late-card-a' WHEN n <= 501 THEN 'late-card-b'
            ELSE 'missing-card-' || n END, CURRENT_TIMESTAMP
        FROM generate_series(1, 50501) AS n
      `;
      const head = await seed.promotion_ledger.update({
        where: { singleton_key: true }, data: { last_sequence: { increment: 151_503n } },
        select: { last_sequence: true },
      });
      const first = head.last_sequence - 151_503n + 1n;
      await seed.$executeRaw`
        INSERT INTO promotion_changes (sequence, entity_type, entity_id, entity_version, operation, changed_at)
        SELECT ${first} + row_number() OVER (ORDER BY kind, id) - 1,
          kind, id, 1, 'upsert'::promotion_operation, CURRENT_TIMESTAMP
        FROM (
          SELECT 'pull' AS kind, id FROM pulls
          UNION ALL SELECT 'pull_item' AS kind, id FROM pull_items
          UNION ALL SELECT 'market_event' AS kind, id FROM market_events
        ) AS seeded
      `;
    }, { maxWait: 5_000, timeout: 90_000 });
    await client.$executeRaw`ANALYZE pulls`;
    await client.$executeRaw`ANALYZE pull_items`;
    await client.$executeRaw`ANALYZE market_events`;
    const repository = new ProviderCanonicalRepository(client);
    const workerId = "integration:reconciliation-index-probe";
    const lease = await new PrismaProviderWorkerLeaseRepository(client).acquire({
      role: "import", owner: workerId, leaseMilliseconds: 300_000,
    });
    assert.notEqual(lease.kind, "held");
    if (lease.kind === "held") throw new Error("Synthetic test lease was not acquired.");
    const authority = { workerId, workerFence: lease.lease.fence };
    assert.equal((await repository.reconcileFactReferences(authority))?.materialChangeCount, 0);
    assert.equal(await client.pulls.count({ where: { row_version: 1n } }), 50_501);
    assert.equal(await client.promotion_changes.count(), 151_503);

    const category = await repository.upsertCategory({
      categoryKey: "synthetic", parentCategoryId: null, displayName: "Synthetic",
    });
    for (const suffix of ["a", "b"]) {
      await repository.upsertPack({ ...packInput(category.id), packKey: `late-pack-${suffix}` });
      await repository.upsertCollectible(collectibleInput(category.id, `late-card-${suffix}`, "Late Card", suffix));
    }
    for (const expected of [500, 1, 0]) {
      const result = await repository.reconcileFactReferences(authority);
      assert.ok(result);
      assert.deepEqual([
        result.pullPackCount, result.pullItemCollectibleCount,
        result.marketEventPackCount, result.marketEventCollectibleCount,
      ], [expected, expected, expected, expected]);
      assert.equal(result.materialChangeCount, expected * 4);
      if (expected > 0) {
        assert.ok(result.promotionRange);
        assert.equal(result.promotionRange.last - result.promotionRange.first + 1n, BigInt(expected * 4));
      } else assert.equal(result.promotionRange, null);
    }
    assert.equal(await client.pulls.count({ where: { row_version: 2n } }), 501);
    assert.equal(await client.pull_items.count({ where: { row_version: 2n } }), 501);
    assert.equal(await client.market_events.count({ where: { row_version: 3n } }), 501);
    assert.equal(await client.pulls.count({ where: { row_version: 1n } }), 50_000);
    assert.equal(await client.pull_items.count({ where: { row_version: 1n } }), 50_000);
    assert.equal(await client.market_events.count({ where: { row_version: 1n } }), 50_000);

    // Capture the real production statements, then EXPLAIN ANALYZE the drained
    // no-match case. This is a disposable database, never a source/provider DB.
    const queries: Prisma.Sql[] = [];
    const captureClient = {
      async $queryRaw(query: Prisma.Sql) {
        if (query.sql.includes("SELECT id,")) return client.$queryRaw(query);
        queries.push(query);
        return [];
      },
    } as unknown as Pick<ProviderQueryClient, "$queryRaw">;
    await resolveProviderFactReferencesBatch(captureClient);
    const expectedIndexes = [
      "pulls_unresolved_pack_key_idx", "pull_items_unresolved_collectible_key_idx",
      "market_events_unresolved_pack_key_idx", "market_events_unresolved_collectible_key_idx",
    ];
    for (const [index, query] of queries.entries()) {
      const rows = await client.$queryRaw<Readonly<{ "QUERY PLAN": unknown }>[]>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
      );
      const plan = JSON.stringify(rows[0]?.["QUERY PLAN"]);
      assert.ok(plan.includes(expectedIndexes[index]!));
      assert.doesNotMatch(plan, /"Node Type":"Seq Scan"[^}]*"Relation Name":"(?:pulls|pull_items|market_events)"/u);
    }
    context.diagnostic("All four plans used the unresolved-key index; 150,000 unrelated facts remained unchanged.");
  } finally {
    await harness.close();
  }
});

test(
  "provider fact relationships allow deferred source identities and only monotonic promoted resolution",
  { concurrency: false },
  async (context) => {
    let harness: ProviderHarness;
    try {
      harness = await createProviderHarness();
    } catch (error) {
      if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) {
        context.skip("PostgreSQL 16 test infrastructure is not available.");
        return;
      }
      throw error;
    }

    try {
      const repository = new ProviderCanonicalRepository(harness.client);
      const category = await repository.upsertCategory({
        categoryKey: "deferred-facts",
        parentCategoryId: null,
        displayName: "Deferred Facts",
      });
      const pack = await repository.upsertPack({
        ...packInput(category.id),
        packKey: "deferred-pack",
        familyKey: "deferred-family",
        displayName: "Deferred Pack",
      });
      const otherPack = await repository.upsertPack({
        ...packInput(category.id),
        packKey: "other-pack",
        familyKey: "other-family",
        displayName: "Other Pack",
      });
      const collectible = await repository.upsertCollectible(
        collectibleInput(category.id, "deferred-card", "Deferred Card", "1"),
      );
      const otherCollectible = await repository.upsertCollectible(
        collectibleInput(category.id, "other-card", "Other Card", "2"),
      );

      const keyedPull = await repository.insertPull({
        pullKey: "keyed-unresolved-pull",
        factDigest: "1".repeat(64),
        packKey: "deferred-pack",
        packId: null,
        providerAccountId: null,
        occurredAt: fixedInstant,
        paidAmount: null,
        paidCurrency: null,
        items: [{
          collectibleKey: "deferred-card",
          collectibleId: null,
          collectibleInstanceId: null,
          quantity: 1n,
          statedValueAmount: null,
          statedValueCurrency: null,
        }],
      });
      const unreportedPull = await repository.insertPull({
        pullKey: "source-unreported-card-pull",
        factDigest: "2".repeat(64),
        packKey: "deferred-pack",
        packId: null,
        providerAccountId: null,
        occurredAt: fixedInstant,
        paidAmount: null,
        paidCurrency: null,
        items: [{
          collectibleKey: null,
          collectibleId: null,
          collectibleInstanceId: null,
          quantity: 1n,
          statedValueAmount: null,
          statedValueCurrency: null,
        }],
      });
      const marketEvent = await repository.insertMarketEvent({
        eventKey: "keyed-unresolved-market-event",
        factDigest: "3".repeat(64),
        eventGroupId: null,
        eventType: "sale",
        packKey: null,
        packId: null,
        collectibleKey: "deferred-card",
        collectibleId: null,
        collectibleInstanceId: null,
        fromProviderAccountId: null,
        toProviderAccountId: null,
        quantity: 1n,
        occurredAt: fixedInstant,
        amount: "10",
        currency: "USD",
        details: { relationship: "deferred" },
      });

      const keyedPullBefore = await harness.client.pulls.findUniqueOrThrow({
        where: { id: keyedPull.id },
      });
      const keyedItemBefore = await harness.client.pull_items.findUniqueOrThrow({
        where: { id: keyedPull.itemIds[0]! },
      });
      const marketEventBefore = await harness.client.market_events.findUniqueOrThrow({
        where: { id: marketEvent.id },
      });
      const unreportedItem = await harness.client.pull_items.findUniqueOrThrow({
        where: { id: unreportedPull.itemIds[0]! },
      });
      assert.deepEqual(
        {
          packKey: keyedPullBefore.pack_key,
          packId: keyedPullBefore.pack_id,
          version: keyedPullBefore.row_version,
        },
        { packKey: "deferred-pack", packId: null, version: 1n },
      );
      assert.deepEqual(
        {
          collectibleKey: keyedItemBefore.collectible_key,
          collectibleId: keyedItemBefore.collectible_id,
          version: keyedItemBefore.row_version,
        },
        { collectibleKey: "deferred-card", collectibleId: null, version: 1n },
      );
      assert.deepEqual(
        {
          collectibleKey: marketEventBefore.collectible_key,
          collectibleId: marketEventBefore.collectible_id,
          version: marketEventBefore.row_version,
        },
        { collectibleKey: "deferred-card", collectibleId: null, version: 1n },
      );
      assert.deepEqual(
        {
          collectibleKey: unreportedItem.collectible_key,
          collectibleId: unreportedItem.collectible_id,
        },
        { collectibleKey: null, collectibleId: null },
      );

      await assert.rejects(
        harness.client.pulls.update({
          where: { id: keyedPull.id },
          data: { pack_id: otherPack.id, row_version: 2n },
        }),
        /pulls_pack_id_key_fkey|Foreign key constraint violated/iu,
      );
      await assert.rejects(
        harness.client.pull_items.update({
          where: { id: keyedPull.itemIds[0]! },
          data: { collectible_id: otherCollectible.id, row_version: 2n },
        }),
        /pull_items_collectible_id_key_fkey|Foreign key constraint violated/iu,
      );
      await assert.rejects(
        harness.client.pulls.create({
          data: {
            id: randomUUID(),
            pull_key: "resolved-pack-without-source-key",
            fact_digest: "4".repeat(64),
            pack_key: null,
            pack_id: pack.id,
            provider_account_id: null,
            item_count: 1,
            occurred_at: fixedInstant,
            paid_amount: null,
            paid_currency: null,
          },
        }),
        /pulls_pack_resolution_check|check constraint/iu,
      );
      await assert.rejects(
        harness.client.market_events.create({
          data: {
            id: randomUUID(),
            event_key: "market-event-without-source-subject",
            fact_digest: "5".repeat(64),
            event_group_id: null,
            event_type: "sale",
            pack_key: null,
            pack_id: null,
            collectible_key: null,
            collectible_id: null,
            collectible_instance_id: null,
            from_provider_account_id: null,
            to_provider_account_id: null,
            quantity: 1n,
            occurred_at: fixedInstant,
            amount: null,
            currency: null,
            details: {},
          },
        }),
        /market_events_subject_check|check constraint/iu,
      );

      await assert.rejects(
        harness.client.pulls.update({
          where: { id: keyedPull.id },
          data: { pack_id: pack.id, row_version: 2n },
        }),
        /fact_write_requires_promotion_change/u,
      );
      assert.deepEqual(
        await harness.client.pulls.findUniqueOrThrow({
          where: { id: keyedPull.id },
          select: { pack_id: true, row_version: true },
        }),
        { pack_id: null, row_version: 1n },
      );

      await harness.client.$transaction(async (transaction) => {
        const resolvedPull = await transaction.pulls.update({
          where: { id: keyedPull.id },
          data: { pack_id: pack.id, row_version: 2n },
        });
        const resolvedItem = await transaction.pull_items.update({
          where: { id: keyedPull.itemIds[0]! },
          data: { collectible_id: collectible.id, row_version: 2n },
        });
        const resolvedEvent = await transaction.market_events.update({
          where: { id: marketEvent.id },
          data: { collectible_id: collectible.id, row_version: 2n },
        });
        const head = await transaction.promotion_ledger.update({
          where: { singleton_key: true },
          data: { last_sequence: { increment: 3n } },
          select: { last_sequence: true },
        });
        const first = head.last_sequence - 2n;
        await transaction.promotion_changes.createMany({
          data: [{
            sequence: first,
            entity_type: "pull",
            entity_id: resolvedPull.id,
            entity_version: resolvedPull.row_version,
            operation: "upsert",
            changed_at: fixedInstant,
          }, {
            sequence: first + 1n,
            entity_type: "pull_item",
            entity_id: resolvedItem.id,
            entity_version: resolvedItem.row_version,
            operation: "upsert",
            changed_at: fixedInstant,
          }, {
            sequence: first + 2n,
            entity_type: "market_event",
            entity_id: resolvedEvent.id,
            entity_version: resolvedEvent.row_version,
            operation: "upsert",
            changed_at: fixedInstant,
          }],
        });
      });

      const keyedPullAfter = await harness.client.pulls.findUniqueOrThrow({
        where: { id: keyedPull.id },
      });
      const keyedItemAfter = await harness.client.pull_items.findUniqueOrThrow({
        where: { id: keyedPull.itemIds[0]! },
      });
      const marketEventAfter = await harness.client.market_events.findUniqueOrThrow({
        where: { id: marketEvent.id },
      });
      assert.deepEqual(
        {
          packKey: keyedPullAfter.pack_key,
          packId: keyedPullAfter.pack_id,
          version: keyedPullAfter.row_version,
        },
        { packKey: "deferred-pack", packId: pack.id, version: 2n },
      );
      assert.deepEqual(
        {
          collectibleKey: keyedItemAfter.collectible_key,
          collectibleId: keyedItemAfter.collectible_id,
          version: keyedItemAfter.row_version,
        },
        { collectibleKey: "deferred-card", collectibleId: collectible.id, version: 2n },
      );
      assert.deepEqual(
        {
          collectibleKey: marketEventAfter.collectible_key,
          collectibleId: marketEventAfter.collectible_id,
          version: marketEventAfter.row_version,
        },
        { collectibleKey: "deferred-card", collectibleId: collectible.id, version: 2n },
      );
      assert.ok(keyedPullAfter.updated_at > keyedPullBefore.updated_at);
      assert.ok(keyedItemAfter.updated_at > keyedItemBefore.updated_at);
      assert.ok(marketEventAfter.updated_at > marketEventBefore.updated_at);
      assert.equal(
        await harness.client.promotion_changes.count({
          where: {
            entity_id: { in: [keyedPull.id, keyedPull.itemIds[0]!, marketEvent.id] },
            entity_version: 2n,
            operation: "upsert",
          },
        }),
        3,
      );

      await assert.rejects(
        harness.client.pulls.update({
          where: { id: keyedPull.id },
          data: { pack_id: null, row_version: 3n },
        }),
        /pulls_relationship_resolution_not_monotonic/u,
      );
      await assert.rejects(
        harness.client.market_events.update({
          where: { id: marketEvent.id },
          data: { collectible_id: otherCollectible.id, row_version: 3n },
        }),
        /market_events_relationship_resolution_not_monotonic/u,
      );
      await assert.rejects(
        harness.client.pull_items.update({
          where: { id: keyedPull.itemIds[0]! },
          data: { collectible_key: "mutated-source-card", row_version: 3n },
        }),
        /pull_items_source_fact_immutable/u,
      );

      await assert.rejects(
        harness.client.$transaction(async (transaction) => {
          const pullId = randomUUID();
          await transaction.pulls.create({
            data: {
              id: pullId,
              pull_key: "pull-with-zero-items",
              fact_digest: "6".repeat(64),
              pack_key: "deferred-pack",
              pack_id: null,
              provider_account_id: null,
              item_count: 1,
              occurred_at: fixedInstant,
              paid_amount: null,
              paid_currency: null,
            },
          });
          const head = await transaction.promotion_ledger.update({
            where: { singleton_key: true },
            data: { last_sequence: { increment: 1n } },
            select: { last_sequence: true },
          });
          await transaction.promotion_changes.create({
            data: {
              sequence: head.last_sequence,
              entity_type: "pull",
              entity_id: pullId,
              entity_version: 1n,
              operation: "upsert",
              changed_at: fixedInstant,
            },
          });
        }),
        /pull_requires_item/u,
      );

      await assert.rejects(
        harness.client.$transaction(async (transaction) => {
          const eventId = randomUUID();
          await transaction.market_events.create({
            data: {
              id: eventId,
              event_key: "market-event-starting-at-version-two",
              fact_digest: "7".repeat(64),
              event_group_id: null,
              event_type: "sale",
              pack_key: null,
              pack_id: null,
              collectible_key: "deferred-card",
              collectible_id: null,
              collectible_instance_id: null,
              from_provider_account_id: null,
              to_provider_account_id: null,
              quantity: 1n,
              occurred_at: fixedInstant,
              amount: null,
              currency: null,
              details: {},
              row_version: 2n,
            },
          });
          const head = await transaction.promotion_ledger.update({
            where: { singleton_key: true },
            data: { last_sequence: { increment: 2n } },
            select: { last_sequence: true },
          });
          await transaction.promotion_changes.createMany({
            data: [{
              sequence: head.last_sequence - 1n,
              entity_type: "market_event",
              entity_id: eventId,
              entity_version: 1n,
              operation: "upsert",
              changed_at: fixedInstant,
            }, {
              sequence: head.last_sequence,
              entity_type: "market_event",
              entity_id: eventId,
              entity_version: 2n,
              operation: "upsert",
              changed_at: fixedInstant,
            }],
          });
        }),
        /promotion_fact_initial_version_invalid/u,
      );
    } finally {
      await harness.close();
    }
  },
);

test(
  "older catalog redelivery cannot regress newer pack or collectible state",
  { concurrency: false },
  async (context) => {
    let harness: ProviderHarness;
    try {
      harness = await createProviderHarness();
    } catch (error) {
      if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) {
        context.skip("PostgreSQL 16 test infrastructure is not available.");
        return;
      }
      throw error;
    }

    try {
      const repository = new ProviderCanonicalRepository(harness.client);
      const category = await repository.upsertCategory({
        categoryKey: "temporal-catalog",
        parentCategoryId: null,
        displayName: "Temporal Catalog",
      });
      const newerAt = new Date("2026-08-30T12:34:56.123Z");
      const initialPack = {
        ...packInput(category.id),
        packKey: "temporal-pack",
        displayName: "Initial Pack",
      };
      await repository.upsertPack(initialPack);
      const newerPack = await repository.upsertPack({
        ...initialPack,
        displayName: "Newer Pack",
        sourceUpdatedAt: newerAt,
      });
      assert.equal(newerPack.rowVersion, 2n);
      assert.deepEqual(await repository.upsertPack(initialPack), {
        id: newerPack.id,
        rowVersion: 2n,
        materialChange: false,
        promotionSequence: null,
      });
      assert.deepEqual(
        await harness.client.packs.findUniqueOrThrow({
          where: { id: newerPack.id },
          select: {
            display_name: true,
            source_updated_at: true,
            row_version: true,
          },
        }),
        {
          display_name: "Newer Pack",
          source_updated_at: newerAt,
          row_version: 2n,
        },
      );
      await assert.rejects(
        repository.upsertPack({
          ...initialPack,
          displayName: "Contradictory Pack",
          sourceUpdatedAt: newerAt,
        }),
        ProviderCanonicalWriteConflictError,
      );

      const initialCollectible = collectibleInput(
        category.id,
        "temporal-collectible",
        "Initial Card",
        "T1",
      );
      await repository.upsertCollectible(initialCollectible);
      const newerCollectible = await repository.upsertCollectible({
        ...initialCollectible,
        displayName: "Newer Card",
        normalizedName: "newer card",
        dataAsOf: newerAt,
      });
      assert.equal(newerCollectible.rowVersion, 2n);
      assert.deepEqual(
        await repository.upsertCollectible(initialCollectible),
        {
          id: newerCollectible.id,
          rowVersion: 2n,
          materialChange: false,
          promotionSequence: null,
        },
      );
      assert.deepEqual(
        await harness.client.collectibles.findUniqueOrThrow({
          where: { id: newerCollectible.id },
          select: {
            display_name: true,
            data_as_of: true,
            row_version: true,
          },
        }),
        {
          display_name: "Newer Card",
          data_as_of: newerAt,
          row_version: 2n,
        },
      );
      await assert.rejects(
        repository.upsertCollectible({
          ...initialCollectible,
          displayName: "Contradictory Card",
          normalizedName: "contradictory card",
          dataAsOf: newerAt,
        }),
        ProviderCanonicalWriteConflictError,
      );
    } finally {
      await harness.close();
    }
  },
);
