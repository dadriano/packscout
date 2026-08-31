import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { Prisma, PrismaClient } from "../prisma/generated/provider/index.js";
import { ProviderCanonicalRepository } from "./provider-canonical-repository.ts";
import { initializeProviderDatabaseIdentity } from "./provider-database.ts";
import { PrismaProviderPulseMetricsRepository } from "./provider-pulse-metrics-repository.ts";
import { PrismaProviderWorkerLeaseRepository } from "./provider-worker-lease-repository.ts";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const providerSchemaPath = fileURLToPath(new URL("../prisma/provider/schema.prisma", import.meta.url));
const prismaExecutable = fileURLToPath(new URL("../../../node_modules/prisma/build/index.js", import.meta.url));
const fixedInstant = new Date("2026-08-29T12:00:00.000Z");
const emptyCounts = {
  total: 0, categories: 0, packs: 0, collectibles: 0, aliases: 0,
  instances: 0, packContents: 0, accounts: 0, pulls: 0, pullItems: 0, marketEvents: 0,
};

async function createHarness() {
  const administratorUrl = new URL(process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
    ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`);
  if (!["postgresql:", "postgres:"].includes(administratorUrl.protocol)) {
    throw new Error("PostgreSQL 16 test infrastructure is required.");
  }
  const providerKey = `pulse_${process.pid}_${randomBytes(5).toString("hex")}`;
  const databaseName = `packscout_${providerKey}`;
  if (!/^packscout_pulse_[0-9]+_[a-f0-9]{10}$/u.test(databaseName)) {
    throw new Error("Refusing to create an unscoped provider test database.");
  }
  const databaseUrl = new URL(administratorUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const administrator = new Pool({ connectionString: administratorUrl.toString(), max: 1 });
  let created = false;
  let client: PrismaClient | undefined;
  try {
    const version = await administrator.query<{ server_version_num: string }>("show server_version_num");
    assert.ok(Number(version.rows[0]?.server_version_num) >= 160_000);
    await administrator.query(`create database "${databaseName}"`);
    created = true;
    await execFileAsync(process.execPath,
      [prismaExecutable, "migrate", "deploy", "--schema", providerSchemaPath], {
        cwd: packageDirectory,
        env: { ...process.env, PACKSCOUT_PROVIDER_DATABASE_URL: databaseUrl.toString() },
      });
    client = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
    await client.$connect();
    await initializeProviderDatabaseIdentity({ client, providerId: randomUUID(), providerKey });
    return {
      client,
      async close() {
        await client?.$disconnect();
        try {
          if (created) await administrator.query(`drop database "${databaseName}" with (force)`);
        } finally {
          created = false;
          await administrator.end();
        }
      },
    };
  } catch (error) {
    await client?.$disconnect().catch(() => undefined);
    if (created) {
      await administrator.query(`drop database "${databaseName}" with (force)`).catch(() => undefined);
    }
    await administrator.end().catch(() => undefined);
    throw error;
  }
}

async function seedCanonicalRows(client: PrismaClient) {
  const canonical = new ProviderCanonicalRepository(client);
  const category = await canonical.upsertCategory({
    categoryKey: "cards", parentCategoryId: null, displayName: "Cards",
  });
  const pack = await canonical.upsertPack({
    packKey: "pack-one", categoryId: category.id, familyKey: null,
    displayName: "Pack one", description: null, packFormat: "repack",
    availability: "available", contentEvidence: "complete",
    totalInventory: null, remainingInventory: null, priceAmount: null,
    priceCurrency: null, priceUsdAmount: null, priceUnavailableReason: "unavailable",
    buybackRate: "0.75", buybackSourceKind: "provider", vendorEvAmount: null,
    vendorEvCurrency: null, vendorEvObservedAt: null, vendorEvUnavailableReason: null,
    packscoutEvAmount: "50", packscoutEvCurrency: "USD", packscoutEvModelVersion: "v1",
    packscoutEvConfidencePolicyVersion: "v1", packscoutEvConfidence: null,
    packscoutEvDataAsOf: fixedInstant, packscoutEvCalculatedAt: fixedInstant,
    packscoutEvUnavailableReason: null, primaryImageUrl: null,
    primaryImageAlt: null, listingUrl: null, attributes: {}, sourceUpdatedAt: fixedInstant,
  });
  const collectible = await canonical.upsertCollectible({
    collectibleKey: "card-one", categoryId: category.id, collectibleType: "card",
    displayName: "Card one", normalizedName: "card one", year: null, brand: null,
    setOrSeries: null, cardNumber: null, referenceNumber: null, subject: null,
    grade: null, grader: null, primaryImageUrl: null, primaryImageAlt: null,
    valuationAmount: null, valuationCurrency: null, valuationUsdAmount: null,
    valuationUnavailableReason: "unavailable", valuationType: null,
    valuationObservedAt: null, dataAsOf: fixedInstant, attributes: {},
  });
  const alias = await canonical.upsertCollectibleNameAlias({
    collectibleId: collectible.id, displayName: "First card", normalizedName: "first card",
  });
  const instance = await canonical.upsertCollectibleInstance({
    collectibleId: collectible.id, instanceKey: "instance-one",
    certifier: null, certificationNumber: null, attributes: {},
  });
  const content = await canonical.upsertPackContent({
    packId: pack.id, collectibleId: collectible.id, collectibleInstanceId: instance.id,
    totalQuantity: 1n, availableQuantity: 1n, contentRole: "possible_outcome",
    probability: null, statedValueAmount: null, statedValueCurrency: null,
    evidenceKinds: ["name_only"], matchConfidenceBasisPoints: 4_000,
    observedAt: fixedInstant, displayOrder: 0,
  });
  const account = await canonical.upsertProviderAccount({
    accountKey: "c".repeat(64), displayName: null, attributes: {},
  });
  await canonical.insertPull({
    pullKey: "pull-one", factDigest: "d".repeat(64), packKey: "pack-one", packId: pack.id,
    providerAccountId: account.id, occurredAt: fixedInstant,
    paidAmount: null, paidCurrency: null,
    items: [1n, 2n].map((quantity) => ({
      collectibleKey: "card-one", collectibleId: collectible.id,
      collectibleInstanceId: instance.id, quantity,
      statedValueAmount: null, statedValueCurrency: null,
    })),
  });
  await canonical.insertMarketEvent({
    eventKey: "event-one", factDigest: "e".repeat(64), eventGroupId: null,
    eventType: "sale", packKey: "pack-one", packId: pack.id,
    collectibleKey: "card-one", collectibleId: collectible.id,
    collectibleInstanceId: instance.id, fromProviderAccountId: account.id,
    toProviderAccountId: null, quantity: 1n, occurredAt: fixedInstant,
    amount: null, currency: null, details: {},
  });
  // Every mutable kind remains stored after retirement; promotion history
  // grows without being added to the displayed canonical row count.
  await canonical.retirePackContent({ id: content.id, expectedRowVersion: 1n, retiredAt: fixedInstant });
  await canonical.retireCollectibleNameAlias({ id: alias.id, expectedRowVersion: 1n, retiredAt: fixedInstant });
  await canonical.retireCollectibleInstance({ id: instance.id, expectedRowVersion: 1n, retiredAt: fixedInstant });
  await canonical.retireProviderAccount({ id: account.id, expectedRowVersion: 1n, retiredAt: fixedInstant });
  await canonical.retirePack({ id: pack.id, expectedRowVersion: 1n, retiredAt: fixedInstant });
  await canonical.retireCollectible({ id: collectible.id, expectedRowVersion: 1n, retiredAt: fixedInstant });
  await canonical.retireCategory({ id: category.id, expectedRowVersion: 1n, retiredAt: fixedInstant });
}

async function seedRetainedRuns(client: PrismaClient) {
  const lease = await new PrismaProviderWorkerLeaseRepository(client).acquire({
    role: "import", owner: "pulse-test-private-worker", leaseMilliseconds: 120_000,
  });
  assert.notEqual(lease.kind, "held");
  if (lease.kind === "held") throw new Error("Disposable import lease was held.");
  let lastCommittedPageAt = fixedInstant;
  let lastRunId = "";
  for (let index = 0; index < 27; index += 1) {
    lastCommittedPageAt = new Date(fixedInstant.getTime() + index * 1_000);
    lastRunId = randomUUID();
    const pageId = randomUUID();
    await client.$transaction(async (transaction) => {
      const counts = {
        catalog_record_count: 3, pull_record_count: 2, market_event_record_count: 1,
        accepted_count: index === 26 ? 1 : 5,
        duplicate_count: index === 26 ? 0 : 1,
        quarantined_count: index === 26 ? 5 : 0, material_change_count: 0,
      };
      await transaction.provider_runs.create({ data: {
        id: lastRunId, idempotency_key: `pulse-run-${index}`, trigger: "manual",
        state: "running", config_version_id: randomUUID(), config_version_number: 1n,
        worker_fence: lease.lease.fence, requested_at: fixedInstant, started_at: fixedInstant,
        heartbeat_at: new Date(), last_progress_at: new Date(),
        reached_source_head: true, page_count: 1, ...counts,
      } });
      await transaction.provider_run_pages.create({ data: {
        id: pageId, provider_run_id: lastRunId, page_number: 1, contract_version: "v1",
        continuation: "head", response_digest: "a".repeat(64), record_count: 6,
        committed_at: lastCommittedPageAt, ...counts,
      } });
      if (index < 26) {
        await transaction.provider_runs.update({
          where: { id: lastRunId },
          data: { state: "succeeded", finished_at: new Date(), row_version: { increment: 1n } },
        });
      } else {
        await transaction.quarantine_records.createMany({
          data: (["open", "open", "resolved", "expired", "expired"] as const).map((state, recordIndex) => ({
            provider_run_id: lastRunId, provider_run_page_id: pageId,
            record_index: recordIndex, record_kind: "pull", reason_code: "INVALID_SOURCE",
            sanitized_summary: "Source record is invalid.", candidate_schema_version: "v1",
            state, created_at: fixedInstant,
            resolved_at: state === "resolved" ? fixedInstant : null,
            evidence_expired_at: state === "expired" ? fixedInstant : null,
          })),
        });
      }
    });
  }
  return { lastRunId, lastCommittedPageAt };
}

test("provider pulse counts exact stored rows and all retained runs without inferring writes from heartbeat", async () => {
  const harness = await createHarness();
  try {
    const repository = new PrismaProviderPulseMetricsRepository(harness.client);
    const empty = await repository.readTotals();
    assert.deepEqual(empty.counts, emptyCounts);
    assert.equal(empty.processed, 0);
    assert.equal(empty.accepted, 0);
    const emptyHistory = await repository.readHistory();
    const emptyLeases = await repository.readLeases();
    assert.equal(emptyHistory.lastCommittedPageAt, null);
    assert.deepEqual(emptyLeases.importLease, { state: "unowned", heartbeatAt: null, expiresAt: null });
    assert.deepEqual(emptyLeases.promotionLease, emptyLeases.importLease);
    assert.deepEqual(emptyHistory.quarantine, { open: 0, resolved: 0, expired: 0, retained: 0 });

    await seedCanonicalRows(harness.client);
    const seeded = await seedRetainedRuns(harness.client);
    const totals = await repository.readTotals();
    assert.deepEqual(totals.counts, {
      total: 11, categories: 1, packs: 1, collectibles: 1, aliases: 1,
      instances: 1, packContents: 1, accounts: 1, pulls: 1, pullItems: 2, marketEvents: 1,
    });
    assert.equal(await harness.client.promotion_changes.count(), 18);
    assert.equal(totals.processed, 162);
    assert.equal(totals.accepted, 131);
    const history = await repository.readHistory();
    const leases = await repository.readLeases();
    assert.equal(history.lastCommittedPageAt, seeded.lastCommittedPageAt.toISOString());
    assert.equal(leases.importLease.state, "active");
    assert.equal(leases.promotionLease.state, "unowned");
    assert.deepEqual(history.quarantine, { open: 2, resolved: 1, expired: 2, retained: 5 });
    assert.ok(Date.parse(leases.importLease.expiresAt!) > Date.parse(leases.measuredAt));
    assert.ok(Date.parse(leases.importLease.heartbeatAt!) > Date.parse(history.lastCommittedPageAt!));
    assert.ok(Date.parse(leases.measuredAt) >= Date.parse(history.measuredAt));
    assert.equal(JSON.stringify(leases).includes("pulse-test-private-worker"), false);
    assert.deepEqual(Object.keys(leases.importLease), ["state", "heartbeatAt", "expiresAt"]);
    await harness.client.provider_runs.update({
      where: { id: seeded.lastRunId },
      data: { heartbeat_at: new Date(), last_progress_at: new Date(), row_version: { increment: 1n } },
    });
    assert.equal((await repository.readHistory()).lastCommittedPageAt, history.lastCommittedPageAt);

    await harness.client.quarantine_records.updateMany({
      where: { state: "open" },
      data: { state: "resolved", resolved_at: new Date(), row_version: { increment: 1n } },
    });
    const resolvedHistory = await repository.readHistory();
    assert.deepEqual(resolvedHistory.quarantine, { open: 0, resolved: 3, expired: 2, retained: 5 });
    assert.deepEqual(history.quarantine, { open: 2, resolved: 1, expired: 2, retained: 5 },
      "an earlier history snapshot keeps its own observed counts");
    assert.deepEqual((await repository.readLeases()).importLease, leases.importLease,
      "history changes do not alter the separately observed worker lease");

    await harness.client.$executeRaw(Prisma.sql`
      update public.provider_worker_states
      set heartbeat_at = statement_timestamp() - interval '1 second',
          lease_expires_at = statement_timestamp(), row_version = row_version + 1
      where worker_role = 'import'
    `);
    const expired = await repository.readLeases();
    assert.equal(expired.importLease.state, "expired");
    assert.ok(Date.parse(expired.importLease.expiresAt!) <= Date.parse(expired.measuredAt));
    const unchangedHistory = await repository.readHistory();
    assert.equal(unchangedHistory.lastCommittedPageAt, resolvedHistory.lastCommittedPageAt);
    assert.deepEqual(unchangedHistory.quarantine, resolvedHistory.quarantine,
      "a lease transition does not masquerade as committed data or a quarantine change");
  } finally {
    await harness.close();
  }
});

test("provider pulse reads are read-only, bounded, and do not wait for runtime or worker row locks", async () => {
  const harness = await createHarness();
  try {
    const settings: { read_only: string; timeout: string }[] = [];
    const observingClient = {
      $transaction: (
        read: (transaction: Prisma.TransactionClient) => Promise<unknown>,
        options: Parameters<PrismaClient["$transaction"]>[1],
      ) => harness.client.$transaction(async (transaction) => read({
        $executeRaw: transaction.$executeRaw.bind(transaction),
        $queryRaw: async (query: Prisma.Sql) => {
          if (query.sql.includes("statement_timestamp()")) {
            settings.push(...await transaction.$queryRaw<{ read_only: string; timeout: string }[]>(Prisma.sql`
              select current_setting('transaction_read_only') as read_only,
                     current_setting('statement_timeout') as timeout
            `));
          }
          return transaction.$queryRaw(query);
        },
      } as Prisma.TransactionClient), options),
    } as unknown as PrismaClient;
    const repository = new PrismaProviderPulseMetricsRepository(observingClient);
    await harness.client.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`select singleton_key from provider_runtime for update`);
      await transaction.$queryRaw(Prisma.sql`select worker_role from provider_worker_states for update`);
      assert.deepEqual((await repository.readTotals()).counts, emptyCounts);
      assert.equal((await repository.readLeases()).importLease.state, "unowned");
      assert.equal((await repository.readHistory()).lastCommittedPageAt, null);
    });
    assert.deepEqual(settings, [
      { read_only: "on", timeout: "6s" },
      { read_only: "on", timeout: "2s" }, { read_only: "on", timeout: "2s" },
    ]);
    await harness.client.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        lock table provider_run_pages, quarantine_records in access exclusive mode
      `);
      assert.equal((await repository.readLeases()).importLease.state, "unowned",
        "lease polling must not touch locked history or quarantine tables");
      await assert.rejects(repository.readHistory(), /statement timeout/u);
    });
    assert.equal((await repository.readHistory()).lastCommittedPageAt, null);
    await harness.client.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`lock table provider_worker_states in access exclusive mode`);
      assert.equal((await repository.readHistory()).lastCommittedPageAt, null,
        "history aggregation must not touch locked worker rows");
      await assert.rejects(repository.readLeases(), /statement timeout/u);
    });
    assert.equal((await repository.readLeases()).importLease.state, "unowned");
  } finally {
    await harness.close();
  }
});
