import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { PrismaClient as ProviderPrismaClient } from "../prisma/generated/provider/index.js";
import {
  ProviderCanonicalImmutableFactConflictError,
  type PackWriteInput,
} from "./provider-canonical-contract.ts";
import { ProviderCanonicalRepository } from "./provider-canonical-repository.ts";
import { initializeProviderDatabaseIdentity } from "./provider-database.ts";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const providerSchemaPath = fileURLToPath(
  new URL("../prisma/provider/schema.prisma", import.meta.url),
);
const prismaExecutable = fileURLToPath(
  new URL("../../../node_modules/prisma/build/index.js", import.meta.url),
);
const PROVIDER_DATABASE_PATTERN = /^packscout_canonical_[0-9]+_[a-f0-9]{10}$/;
const fixedInstant = new Date("2026-08-29T12:34:56.123456Z");

interface ProviderHarness {
  readonly client: ProviderPrismaClient;
  readonly providerKey: string;
  close(): Promise<void>;
}

function resolveAdminUrl(): URL {
  const configured = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL;
  const value = configured
    ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
  const result = new URL(value);
  if (result.protocol !== "postgresql:" && result.protocol !== "postgres:") {
    throw new Error("PostgreSQL 16 test infrastructure is required.");
  }
  return result;
}

function providerUrl(adminUrl: URL, databaseName: string): string {
  const result = new URL(adminUrl);
  result.pathname = `/${databaseName}`;
  result.search = "";
  result.hash = "";
  return result.toString();
}

async function createProviderHarness(): Promise<ProviderHarness> {
  const adminUrl = resolveAdminUrl();
  const providerKey = `canonical_${process.pid}_${randomBytes(5).toString("hex")}`;
  const databaseName = `packscout_${providerKey}`;
  if (!PROVIDER_DATABASE_PATTERN.test(databaseName)) {
    throw new Error("Refusing to create an unscoped provider test database.");
  }

  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const databaseUrl = providerUrl(adminUrl, databaseName);
  let created = false;
  let client: ProviderPrismaClient | undefined;
  try {
    const version = await admin.query<{ server_version_num: string }>("show server_version_num");
    if (Number(version.rows[0]?.server_version_num ?? 0) < 160_000) {
      throw new Error("PostgreSQL 16 test infrastructure is required.");
    }
    const existing = await admin.query<{ exists: boolean }>(
      "select exists(select 1 from pg_database where datname = $1) as exists",
      [databaseName],
    );
    if (existing.rows[0]?.exists) {
      throw new Error("Refusing to replace an existing provider test database.");
    }
    await admin.query(`create database "${databaseName}"`);
    created = true;
    await execFileAsync(
      process.execPath,
      [prismaExecutable, "migrate", "deploy", "--schema", providerSchemaPath],
      {
        cwd: packageDirectory,
        env: { ...process.env, PACKSCOUT_PROVIDER_DATABASE_URL: databaseUrl },
      },
    );
    client = new ProviderPrismaClient({ datasources: { db: { url: databaseUrl } } });
    await client.$connect();
    await initializeProviderDatabaseIdentity({
      client,
      providerId: randomUUID(),
      providerKey,
    });
  } catch (error) {
    await client?.$disconnect().catch(() => undefined);
    if (created) {
      await admin.query(`drop database "${databaseName}" with (force)`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    client,
    providerKey,
    close() {
      closePromise ??= (async () => {
        await client.$disconnect();
        if (created) {
          await admin.query(`drop database "${databaseName}" with (force)`);
          created = false;
        }
        await admin.end();
      })();
      return closePromise;
    },
  };
}

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

async function exerciseCanonicalWarehouse(harness: ProviderHarness): Promise<{
  readonly categoryId: string;
  readonly packId: string;
  readonly finalSequence: bigint;
}> {
  const repository = new ProviderCanonicalRepository(harness.client);
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
    packId: pack.id,
    providerAccountId: account.id,
    occurredAt: fixedInstant,
    paidAmount: "12345678901234567890.123456789012345678",
    paidCurrency: "USD",
    items: [{
      collectibleId: collectible.id,
      collectibleInstanceId: instance.id,
      quantity: 1n,
      statedValueAmount: "99999999999999999999.999999999999999999",
      statedValueCurrency: "USD",
    }, {
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
    packId: pack.id,
    providerAccountId: account.id,
    occurredAt: fixedInstant,
    paidAmount: "12345678901234567890.123456789012345678",
    paidCurrency: "USD",
    items: [{
      collectibleId: collectible.id,
      collectibleInstanceId: instance.id,
      quantity: 1n,
      statedValueAmount: "99999999999999999999.999999999999999999",
      statedValueCurrency: "USD",
    }, {
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
      packId: pack.id,
      providerAccountId: account.id,
      occurredAt: fixedInstant,
      paidAmount: "1",
      paidCurrency: "USD",
      items: [{
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
    packId: null,
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
    packId: null,
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
      packId: pack.id,
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
