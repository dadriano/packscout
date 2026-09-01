import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Client } from "pg";
import {
  PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
  canonicalJson,
  globalCategoryPublicId,
  packscoutPublicIdentityUuid,
  providerReleaseCatalogPinHash,
  providerReleaseCorrelationSnapshotHash,
  publicVendorSchema,
  sha256CanonicalJson,
} from "@packscout/contracts";
import { PrismaClient as ProviderPrismaClient } from "../prisma/generated/provider/index.js";
import {
  createProviderHarness,
  type ProviderHarness,
} from "./provider-canonical-integration-support.ts";
import { ProviderCanonicalRepository } from "./provider-canonical-repository.ts";
import type { PinnedProviderReleaseInputs } from "./provider-release-central-repository.ts";
import {
  ProviderReleaseAssemblyError,
  ProviderReleaseRepository,
} from "./provider-release-repository.ts";
import { PrismaProviderRuntimeRepository } from "./provider-runtime-repository.ts";

const observedAt = new Date("2026-08-29T12:00:00.000Z");
const providerConfigVersionId = "16000000-0000-4000-8000-000000000005";
const categoryGlobalId = "16000000-0000-4000-8000-000000000001";
const collectiblePublicId = packscoutPublicIdentityUuid("release-integration:collectible");
const protectedMarker = "private-account-pull-event-certification";

interface MigratedProviderDatabase {
  readonly databaseUrl: string;
  readonly db: Client;
  readonly providerId: string;
  readonly providerKey: string;
  readonly harness: ProviderHarness;
}

async function createMigratedProviderDatabasePair(): Promise<{
  readonly first: MigratedProviderDatabase;
  readonly second: MigratedProviderDatabase;
  stop(): Promise<void>;
}> {
  const firstHarness = await createProviderHarness();
  let secondHarness: ProviderHarness | undefined;
  let firstDb: Client | undefined;
  let secondDb: Client | undefined;
  try {
    secondHarness = await createProviderHarness();
    firstDb = new Client({ connectionString: firstHarness.databaseUrl });
    secondDb = new Client({ connectionString: secondHarness.databaseUrl });
    await Promise.all([firstDb.connect(), secondDb.connect()]);
    const first: MigratedProviderDatabase = {
      databaseUrl: firstHarness.databaseUrl,
      db: firstDb,
      providerId: firstHarness.providerId,
      providerKey: firstHarness.providerKey,
      harness: firstHarness,
    };
    const second: MigratedProviderDatabase = {
      databaseUrl: secondHarness.databaseUrl,
      db: secondDb,
      providerId: secondHarness.providerId,
      providerKey: secondHarness.providerKey,
      harness: secondHarness,
    };
    return {
      first,
      second,
      async stop() {
        await Promise.allSettled([
          firstDb!.end(),
          secondDb!.end(),
          firstHarness.close(),
          secondHarness!.close(),
        ]);
      },
    };
  } catch (error) {
    await Promise.allSettled([
      firstDb?.end(),
      secondDb?.end(),
      firstHarness.close(),
      secondHarness?.close(),
    ]);
    throw error;
  }
}

async function configureRuntime(
  database: ProviderPrismaClient,
  migrated: MigratedProviderDatabase,
): Promise<void> {
  const synchronized = await new PrismaProviderRuntimeRepository(database)
    .synchronizeConfiguration({
      centralProviderId: migrated.providerId,
      providerKey: migrated.providerKey,
      configVersionId: providerConfigVersionId,
      configVersionNumber: 1n,
      configuration: { adapterKey: "release-integration" },
      expiresAt: null,
      scheduleSeconds: 300,
      nextDueAt: null,
      synchronizedAt: observedAt,
    });
  assert.equal(synchronized.kind, "updated");
  await database.provider_runtime.update({
    where: { singleton_key: true },
    data: {
      last_head_reached_at: observedAt,
      last_attempted_at: observedAt,
      freshness_state: "fresh",
      row_version: { increment: 1n },
    },
  });
}

async function releasePin(input: {
  readonly migrated: MigratedProviderDatabase;
  readonly category?: { readonly id: string; readonly rowVersion: bigint };
  readonly collectible?: { readonly id: string; readonly rowVersion: bigint };
}): Promise<PinnedProviderReleaseInputs> {
  const publicProvider = publicVendorSchema.parse({
    publicVendorId: packscoutPublicIdentityUuid(`provider:${input.migrated.providerId}`),
    vendorKey: input.migrated.providerKey,
    displayName: "Release fixture",
    logoUrl: null,
    websiteUrl: "https://fixture.example",
    listingHosts: ["fixture.example"],
    imageOrigins: [],
    referralParameters: [],
    publicPromo: null,
  });
  const publicCategoryId = globalCategoryPublicId(categoryGlobalId);
  const categoryCorrelations = input.category === undefined ? [] : [{
    localCategoryId: input.category.id,
    localEntityVersion: input.category.rowVersion,
    publicCategoryId,
  }];
  const collectibleCorrelations = input.collectible === undefined ? [] : [{
    localCollectibleId: input.collectible.id,
    localEntityVersion: input.collectible.rowVersion,
    publicCollectibleId: collectiblePublicId,
  }];
  const correlationEventSequence = 8n;
  const catalogVersionId = "16000000-0000-4000-8000-000000000003";
  const catalogSchemaVersion = "catalog-v1";
  const catalogContentHash = "a".repeat(64);
  const catalogThroughChangeSequence = 7n;
  const catalogCategories: PinnedProviderReleaseInputs["catalogCategories"] =
    input.category === undefined ? [] : [{
      publicCategoryId,
      parentPublicCategoryId: null,
      categoryKey: "cards",
      displayName: "Cards",
      categoryKind: "vertical",
      displayOrder: 0,
      depth: 0,
      pathPublicCategoryIds: [publicCategoryId],
      lifecycle: "active",
    }];
  const catalogCollectibles: PinnedProviderReleaseInputs["catalogCollectibles"] =
    input.collectible === undefined ? [] : [{
      publicCollectibleId: collectiblePublicId,
      identityState: "canonical",
      collectibleType: "card",
      displayName: "Fixture Card",
      normalizedName: "fixture card",
      nameAliases: ["Release Card"],
      normalizedNameAliases: ["release card"],
      publicCategoryIds: [publicCategoryId],
      year: 2026,
      brand: "PackScout",
      setOrSeries: "Integration",
      cardNumber: "1",
      referenceNumber: null,
      subject: "Fixture",
      grade: null,
      grader: null,
      primaryImageUrl: null,
      primaryImageAlt: null,
      valuationAmount: "125.00",
      valuationCurrency: "USD",
      valuationUsdAmount: "125.00",
      valuationUnavailableReason: null,
      valuationType: "market_estimate",
      valuationObservedAt: observedAt.toISOString(),
      dataAsOf: observedAt.toISOString(),
    }];
  const catalogAliases: PinnedProviderReleaseInputs["catalogAliases"] = [];
  return {
    providerId: input.migrated.providerId,
    providerKey: input.migrated.providerKey,
    providerConfigVersionId,
    providerConfigExpiresAt: null,
    staleAfterSeconds: 900,
    centralSchemaVersion: "distributed-central-v1",
    catalogVersionId,
    catalogSchemaVersion,
    catalogContentHash,
    catalogThroughChangeSequence,
    catalogCategories,
    catalogCollectibles,
    catalogAliases,
    catalogArtifactVerificationHash: await providerReleaseCatalogPinHash({
      catalogVersionId,
      catalogSchemaVersion,
      catalogContentHash,
      catalogThroughChangeSequence: catalogThroughChangeSequence.toString(),
      categories: catalogCategories,
      collectibles: catalogCollectibles,
      aliases: catalogAliases,
    }),
    correlationEventSequence,
    correlationSnapshotHash: await providerReleaseCorrelationSnapshotHash({
      providerId: input.migrated.providerId,
      correlationEventSequence: correlationEventSequence.toString(),
      categories: categoryCorrelations.map((row) => ({
        ...row,
        localEntityVersion: row.localEntityVersion.toString(),
      })),
      collectibles: collectibleCorrelations.map((row) => ({
        ...row,
        localEntityVersion: row.localEntityVersion.toString(),
      })),
    }),
    categoryCorrelations,
    collectibleCorrelations,
    publicProfileVersionId: "16000000-0000-4000-8000-000000000004",
    publicProfileHash: await sha256CanonicalJson(
      PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
      publicProvider,
    ),
    publicProvider,
  };
}

async function completeRelease(
  migrated: MigratedProviderDatabase,
  releaseId: string,
): Promise<void> {
  const operationId = randomUUID();
  const receiptId = randomUUID();
  const release = await migrated.db.query<{
    content_hash: string;
    record_count: number;
    through_change_sequence: string;
  }>(`
    select release.content_hash, release.through_change_sequence,
           coalesce(sum(batch.record_count), 0)::integer as record_count
    from provider_releases release
    left join provider_release_batches batch on batch.provider_release_id = release.id
    where release.id = $1
    group by release.id
  `, [releaseId]);
  const descriptor = release.rows[0];
  if (!descriptor) throw new Error("Assembled release is missing.");
  const requestDigest = "b".repeat(64);
  const remoteReceiptId = `fixture:${receiptId}`;
  const responseBytes = canonicalJson({
    operationKind: "finalize",
    receiptDigest: remoteReceiptId,
    requestDigest,
    terminalState: "complete",
    result: "completed",
    publicProviderReleaseId: releaseId,
    providerCheckpoint: {
      settledSequence: descriptor.through_change_sequence,
    },
    details: {
      completedHead: {
        providerCheckpoint: {
          settledSequence: descriptor.through_change_sequence,
        },
        release: { publicProviderReleaseId: releaseId },
      },
    },
  });
  const responseDigest = createHash("sha256").update(responseBytes).digest("hex");
  await migrated.db.query(`
    update provider_worker_states
    set lease_owner = 'release-integration', lease_fence = lease_fence + 1,
        heartbeat_at = clock_timestamp(), lease_expires_at = clock_timestamp() + interval '10 minutes',
        row_version = row_version + 1
    where worker_role = 'promotion'
  `);
  const fence = await migrated.db.query<{ lease_fence: string }>(
    "select lease_fence from provider_worker_states where worker_role = 'promotion'",
  );
  await migrated.db.query("update provider_releases set lifecycle = 'publishing' where id = $1", [releaseId]);
  await migrated.db.query(`
    insert into provider_publication_operations (
      id, provider_release_id, operation_kind, idempotency_key,
      request_digest, request_bytes, lease_fence, requested_at
    ) values ($1, $2, 'finalize', $3, $4, $5, $6, clock_timestamp())
  `, [operationId, releaseId, `fixture:${operationId}`, requestDigest, Buffer.from("{}"), fence.rows[0]!.lease_fence]);
  await migrated.db.query("begin");
  try {
    await migrated.db.query(`
      update provider_publication_operations
      set state = 'accepted', attempt_count = 1,
          last_attempted_at = clock_timestamp(), completed_at = clock_timestamp()
      where id = $1
    `, [operationId]);
    await migrated.db.query(`
      insert into provider_publication_receipts (
        id, operation_id, provider_release_id, remote_receipt_id, outcome,
        response_digest, response_bytes, accepted_content_hash,
        accepted_record_count, received_at
      ) values ($1, $2, $3, $4, 'accepted', $5, $6, $7, $8, clock_timestamp())
    `, [
      receiptId,
      operationId,
      releaseId,
      remoteReceiptId,
      responseDigest,
      Buffer.from(responseBytes),
      descriptor.content_hash,
      descriptor.record_count,
    ]);
    await migrated.db.query("commit");
  } catch (error) {
    await migrated.db.query("rollback");
    throw error;
  }
  await migrated.db.query(`
    update provider_releases
    set lifecycle = 'complete', completed_at = clock_timestamp()
    where id = $1
  `, [releaseId]);
}

async function waitForBlockedPackRead(migrated: MigratedProviderDatabase): Promise<void> {
  const observer = new Client({ connectionString: migrated.databaseUrl });
  await observer.connect();
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await observer.query<{ found: boolean }>(`
        select exists (
          select 1 from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
            and query ilike '%packs%'
        ) as found
      `);
      if (result.rows[0]?.found) return;
      await delay(20);
    }
  } finally {
    await observer.end();
  }
  throw new Error("Provider snapshot did not reach its blocked pack read.");
}

async function changePackDescription(input: {
  readonly migrated: MigratedProviderDatabase;
  readonly packId: string;
  readonly description: string;
}): Promise<void> {
  await input.migrated.db.query("begin");
  try {
    const mutation = await input.migrated.db.query<{ row_version: string }>(`
      update packs
      set description = $2, row_version = row_version + 1, updated_at = $3
      where id = $1
      returning row_version
    `, [input.packId, input.description, observedAt]);
    const head = await input.migrated.db.query<{ last_sequence: string }>(`
      update promotion_ledger
      set last_sequence = last_sequence + 1
      where singleton_key
      returning last_sequence
    `);
    await input.migrated.db.query(`
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values ($1, 'pack', $2, $3, 'upsert', $4)
    `, [
      head.rows[0]!.last_sequence,
      input.packId,
      mutation.rows[0]!.row_version,
      observedAt,
    ]);
    await input.migrated.db.query("commit");
  } catch (error) {
    await input.migrated.db.query("rollback");
    throw error;
  }
}

test("migrated provider assembly is immutable, resumable, reusable, isolated, and frontend-safe", { concurrency: false }, async (context) => {
  let pair: Awaited<ReturnType<typeof createMigratedProviderDatabasePair>>;
  try {
    pair = await createMigratedProviderDatabasePair();
  } catch (error) {
    if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) {
      context.skip("PostgreSQL 16 test infrastructure is not available.");
      return;
    }
    throw error;
  }
  const first = new ProviderPrismaClient({ datasources: { db: { url: pair.first.databaseUrl } } });
  const second = new ProviderPrismaClient({ datasources: { db: { url: pair.second.databaseUrl } } });
  await Promise.all([first.$connect(), second.$connect()]);
  try {
    await Promise.all([
      configureRuntime(first, pair.first),
      configureRuntime(second, pair.second),
    ]);
    const canonical = new ProviderCanonicalRepository(first);
    const category = await canonical.upsertCategory({
      categoryKey: "cards",
      parentCategoryId: null,
      displayName: "Cards",
    });
    const collectible = await canonical.upsertCollectible({
      collectibleKey: "fixture-card",
      categoryId: category.id,
      collectibleType: "card",
      displayName: "Fixture Card",
      normalizedName: "fixture card",
      year: 2026,
      brand: "PackScout",
      setOrSeries: "Integration",
      cardNumber: "1",
      referenceNumber: null,
      subject: "Fixture",
      grade: null,
      grader: null,
      primaryImageUrl: null,
      primaryImageAlt: null,
      valuationAmount: "125",
      valuationCurrency: "USD",
      valuationUsdAmount: "125",
      valuationUnavailableReason: null,
      valuationType: "market_estimate",
      valuationObservedAt: observedAt,
      dataAsOf: observedAt,
      attributes: { protectedMarker },
    });
    const instance = await canonical.upsertCollectibleInstance({
      collectibleId: collectible.id,
      instanceKey: "fixture-instance",
      certifier: "private-certifier",
      certificationNumber: protectedMarker,
      attributes: { protectedMarker },
    });
    await canonical.upsertCollectibleNameAlias({
      collectibleId: collectible.id,
      displayName: "Release Card",
      normalizedName: "release card",
    });
    const pack = await canonical.upsertPack({
      packKey: "fixture-pack",
      categoryId: category.id,
      familyKey: null,
      displayName: "Initial Public Pack",
      description: "A frontend-safe fixture",
      packFormat: "repack",
      availability: "available",
      contentEvidence: "complete",
      totalInventory: 10n,
      remainingInventory: 8n,
      priceAmount: "100",
      priceCurrency: "USD",
      priceUsdAmount: "100",
      priceUnavailableReason: null,
      buybackRate: null,
      buybackSourceKind: null,
      vendorEvAmount: "120",
      vendorEvCurrency: "USD",
      vendorEvObservedAt: observedAt,
      vendorEvUnavailableReason: null,
      packscoutEvAmount: null,
      packscoutEvCurrency: null,
      packscoutEvModelVersion: "model-v1",
      packscoutEvConfidencePolicyVersion: "policy-v1",
      packscoutEvConfidence: null,
      packscoutEvDataAsOf: null,
      packscoutEvCalculatedAt: null,
      packscoutEvUnavailableReason: "ESTIMATE_INPUT_INCOMPLETE",
      primaryImageUrl: null,
      primaryImageAlt: null,
      listingUrl: null,
      attributes: { protectedMarker },
      sourceUpdatedAt: observedAt,
    });
    await canonical.upsertPackContent({
      packId: pack.id,
      collectibleId: collectible.id,
      collectibleInstanceId: instance.id,
      totalQuantity: 1n,
      availableQuantity: 1n,
      contentRole: "top_chase",
      probability: "0.1",
      statedValueAmount: "125",
      statedValueCurrency: "USD",
      evidenceKinds: ["vendor_inventory"],
      matchConfidenceBasisPoints: 9_000,
      observedAt,
      displayOrder: 0,
    });
    const pin = await releasePin({ migrated: pair.first, category, collectible });
    const repository = new ProviderReleaseRepository(first);
    const initial = await repository.assemble({ workerId: "assembly-a", leaseMilliseconds: 10_000, pin });
    assert.equal(initial.release.lifecycle, "assembled");
    const assembledSource = await repository.publicationSource(initial.release.id);
    assert.equal(assembledSource.release.lifecycle, "assembled");
    assert.equal(assembledSource.descriptor.providerReleaseId, initial.release.id);
    assert.equal(
      assembledSource.batches
        .filter(({ batchKind }) => batchKind === "collectible")
        .reduce((count, batch) => count + batch.recordCount, 0),
      1,
    );
    assert.throws(
      () => repository.publicationSource("not-a-uuid"),
      TypeError,
    );
    const restarted = await repository.assemble({ workerId: "assembly-b", leaseMilliseconds: 10_000, pin });
    assert.equal(restarted.release.id, initial.release.id);
    assert.equal(restarted.resumedExistingAssembly, true);
    await first.provider_releases.update({
      where: { id: initial.release.id },
      data: { lifecycle: "publishing" },
    });
    assert.equal(
      (await repository.publicationSource(initial.release.id)).release.lifecycle,
      "publishing",
    );
    await completeRelease(pair.first, initial.release.id);
    assert.equal(
      (await repository.publicationSource(initial.release.id)).release.lifecycle,
      "complete",
    );
    const staleCollectibleCorrelations = pin.collectibleCorrelations.map((row) => ({
      ...row,
      localEntityVersion: row.localEntityVersion + 1n,
    }));
    const stalePin: PinnedProviderReleaseInputs = {
      ...pin,
      collectibleCorrelations: staleCollectibleCorrelations,
      correlationSnapshotHash: await providerReleaseCorrelationSnapshotHash({
        providerId: pin.providerId,
        correlationEventSequence: pin.correlationEventSequence.toString(),
        categories: pin.categoryCorrelations.map((row) => ({
          ...row,
          localEntityVersion: row.localEntityVersion.toString(),
        })),
        collectibles: staleCollectibleCorrelations.map((row) => ({
          ...row,
          localEntityVersion: row.localEntityVersion.toString(),
        })),
      }),
    };
    await assert.rejects(
      repository.assemble({ workerId: "assembly-stale", leaseMilliseconds: 10_000, pin: stalePin }),
      (error: unknown) => error instanceof ProviderReleaseAssemblyError
        && error.code === "CORRELATION_STALE",
    );
    assert.equal((await first.provider_releases.findUniqueOrThrow({
      where: { id: initial.release.id },
    })).lifecycle, "complete");
    assert.equal(await second.provider_releases.count(), 0);

    const account = await canonical.upsertProviderAccount({
      accountKey: "d".repeat(64),
      displayName: protectedMarker,
      attributes: { protectedMarker },
    });
    await canonical.insertPull({
      pullKey: `pull-${protectedMarker}`,
      factDigest: "e".repeat(64),
      packId: pack.id,
      packKey: "fixture-pack",
      providerAccountId: account.id,
      occurredAt: observedAt,
      paidAmount: "100",
      paidCurrency: "USD",
      items: [{
        collectibleId: collectible.id,
        collectibleKey: "fixture-card",
        collectibleInstanceId: instance.id,
        quantity: 1n,
        statedValueAmount: "125",
        statedValueCurrency: "USD",
      }],
    });
    await canonical.insertMarketEvent({
      eventKey: `event-${protectedMarker}`,
      factDigest: "f".repeat(64),
      eventGroupId: null,
      eventType: "sale",
      packId: pack.id,
      packKey: "fixture-pack",
      collectibleId: collectible.id,
      collectibleKey: "fixture-card",
      collectibleInstanceId: instance.id,
      fromProviderAccountId: account.id,
      toProviderAccountId: null,
      quantity: 1n,
      occurredAt: observedAt,
      amount: "125",
      currency: "USD",
      details: { protectedMarker },
    });
    const privateOnly = await repository.assemble({ workerId: "assembly-c", leaseMilliseconds: 10_000, pin });
    assert.equal(privateOnly.reusedCompleteRelease, true);
    assert.equal(privateOnly.release.id, initial.release.id);
    assert.ok(privateOnly.selectedThroughChangeSequence > privateOnly.release.throughChangeSequence);
    assert.equal(privateOnly.release.descriptor.throughChangeSequence, initial.release.descriptor.throughChangeSequence);

    await changePackDescription({
      migrated: pair.first,
      packId: pack.id,
      description: "A different public description",
    });
    const differentBody = await repository.assemble({
      workerId: "assembly-different-body",
      leaseMilliseconds: 10_000,
      pin,
    });
    assert.equal(differentBody.reusedCompleteRelease, false);
    await completeRelease(pair.first, differentBody.release.id);
    await changePackDescription({
      migrated: pair.first,
      packId: pack.id,
      description: "A frontend-safe fixture",
    });
    const scannedReuse = await repository.assemble({
      workerId: "assembly-scanned-reuse",
      leaseMilliseconds: 10_000,
      pin,
    });
    assert.equal(scannedReuse.reusedCompleteRelease, true);
    assert.equal(scannedReuse.release.id, initial.release.id);

    await pair.first.db.query("begin");
    await pair.first.db.query("lock table packs in access exclusive mode");
    const stablePromise = repository.assemble({ workerId: "assembly-d", leaseMilliseconds: 10_000, pin });
    await waitForBlockedPackRead(pair.first);
    await assert.rejects(
      repository.assemble({ workerId: "assembly-d", leaseMilliseconds: 10_000, pin }),
      (error: unknown) => error instanceof ProviderReleaseAssemblyError
        && error.code === "PROVIDER_RELEASE_LEASE_HELD",
    );
    const mutation = await pair.first.db.query<{ row_version: string }>(`
      update packs
      set display_name = 'Later Public Pack', row_version = row_version + 1, updated_at = clock_timestamp()
      where id = $1
      returning row_version
    `, [pack.id]);
    const head = await pair.first.db.query<{ last_sequence: string }>(`
      update promotion_ledger
      set last_sequence = last_sequence + 1
      where singleton_key
      returning last_sequence
    `);
    await pair.first.db.query(`
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values ($1, 'pack', $2, $3, 'upsert', clock_timestamp())
    `, [head.rows[0]!.last_sequence, pack.id, mutation.rows[0]!.row_version]);
    await pair.first.db.query("commit");
    const stable = await stablePromise;
    assert.equal(stable.reusedCompleteRelease, true);
    assert.equal(stable.release.id, initial.release.id);
    assert.notEqual(stable.selectedThroughChangeSequence.toString(), head.rows[0]!.last_sequence);

    const changed = await repository.assemble({ workerId: "assembly-e", leaseMilliseconds: 10_000, pin });
    assert.equal(changed.reusedCompleteRelease, false);
    assert.notEqual(changed.release.id, initial.release.id);
    const payloads = await first.provider_release_batches.findMany({
      where: { provider_release_id: changed.release.id },
      select: { payload: true },
    });
    const publicBytes = JSON.stringify(payloads);
    assert.equal(publicBytes.includes("Later Public Pack"), true);
    assert.equal(publicBytes.includes(protectedMarker), false);
    for (const protectedName of [
      "collectibleInstanceId", "providerAccount", "pullKey", "eventKey",
      "certificationNumber", "attributes", "promotion_changes", "provider_runtime",
    ]) assert.equal(publicBytes.includes(protectedName), false, protectedName);
    assert.equal(await second.provider_releases.count(), 0);
    assert.equal((await first.provider_change_consumers.findUniqueOrThrow({
      where: { consumer_key: "provider_release" },
    })).last_confirmed_sequence, 0n);
    assert.equal((await first.provider_releases.findUniqueOrThrow({
      where: { id: initial.release.id },
    })).lifecycle, "complete");

    await pair.first.db.query(
      "alter table provider_release_batches disable trigger provider_release_batches_guard_trigger",
    );
    await pair.first.db.query(`
      update provider_release_batches
      set body_hash = $2
      where provider_release_id = $1 and batch_kind = 'collectible'
    `, [changed.release.id, "0".repeat(64)]);
    await pair.first.db.query(
      "alter table provider_release_batches enable trigger provider_release_batches_guard_trigger",
    );
    await assert.rejects(
      repository.publicationSource(changed.release.id),
      (error: unknown) => error instanceof ProviderReleaseAssemblyError
        && error.code === "PROVIDER_RELEASE_STORED_CONFLICT",
    );

    const secondRepository = new ProviderReleaseRepository(second);
    const secondConsumerBefore = await second.provider_change_consumers.findUniqueOrThrow({
      where: { consumer_key: "provider_release" },
    });
    await assert.rejects(
      secondRepository.assemble({
        workerId: "assembly-cross-provider",
        leaseMilliseconds: 10_000,
        pin,
      }),
      (error: unknown) => error instanceof ProviderReleaseAssemblyError
        && error.code === "PROVIDER_IDENTITY_MISMATCH",
    );
    const secondConsumerAfter = await second.provider_change_consumers.findUniqueOrThrow({
      where: { consumer_key: "provider_release" },
    });
    assert.equal(secondConsumerAfter.lease_fence, secondConsumerBefore.lease_fence);
    assert.equal(secondConsumerAfter.row_version, secondConsumerBefore.row_version);
    await assert.rejects(
      secondRepository.publicationSource(initial.release.id),
      (error: unknown) => error instanceof ProviderReleaseAssemblyError
        && error.code === "PROVIDER_RELEASE_NOT_FOUND",
    );
    assert.equal(await second.provider_releases.count(), 0);
    const secondPin = await releasePin({ migrated: pair.second });
    const secondRelease = await secondRepository.assemble({
      workerId: "assembly-second",
      leaseMilliseconds: 10_000,
      pin: secondPin,
    });
    await second.provider_releases.update({
      where: { id: secondRelease.release.id },
      data: { lifecycle: "failed" },
    });
    await assert.rejects(
      secondRepository.assemble({
        workerId: "assembly-second-restart",
        leaseMilliseconds: 10_000,
        pin: secondPin,
      }),
      (error: unknown) => error instanceof ProviderReleaseAssemblyError
        && error.code === "PROVIDER_RELEASE_STORED_CONFLICT",
    );
    assert.equal((await second.provider_releases.findUniqueOrThrow({
      where: { id: secondRelease.release.id },
    })).lifecycle, "failed");
    await assert.rejects(
      secondRepository.publicationSource(secondRelease.release.id),
      (error: unknown) => error instanceof ProviderReleaseAssemblyError
        && error.code === "PROVIDER_RELEASE_NOT_PUBLISHABLE",
    );
  } finally {
    await Promise.allSettled([first.$disconnect(), second.$disconnect()]);
    await pair.stop();
  }
});
