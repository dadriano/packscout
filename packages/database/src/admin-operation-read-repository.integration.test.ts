import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaAdminImportRunRepository } from "./admin-import-run-repository.ts";
import { PrismaAdminProviderOperationRepository } from "./admin-provider-operation-repository.ts";
import { PrismaImportRunRepository } from "./import-run-repository.ts";
import { IngestionPersistenceRepository } from "./ingestion-repository.ts";
import { PrismaQuarantineRepository } from "./quarantine-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const ids = {
  organization: "71000000-0000-4000-8000-000000000001",
  otherOrganization: "71000000-0000-4000-8000-000000000002",
  provider: "71000000-0000-4000-8000-000000000010",
  secondProvider: "71000000-0000-4000-8000-000000000011",
  otherProvider: "71000000-0000-4000-8000-000000000012",
  revision: "71000000-0000-4000-8000-000000000020",
  secondRevision: "71000000-0000-4000-8000-000000000021",
  otherRevision: "71000000-0000-4000-8000-000000000022",
  archiveRevision: "71000000-0000-4000-8000-000000000023",
  acceptedRun: "71000000-0000-4000-8000-000000000030",
  unchangedRun: "71000000-0000-4000-8000-000000000031",
  revisedRun: "71000000-0000-4000-8000-000000000032",
  otherRun: "71000000-0000-4000-8000-000000000033",
  requestRun: "71000000-0000-4000-8000-000000000034",
  retryAttempt: "71000000-0000-4000-8000-000000000040",
} as const;

const startedAt = new Date("2026-08-06T12:00:00.000Z");
const sourceTime = new Date("2026-08-06T11:50:00.000Z");
const rawSecret = "Bearer raw-secret private-user 0xprivate-wallet";

function catalog(content: string) {
  return {
    stream: "catalog" as const,
    platform: "alpha-platform",
    entity: "card" as const,
    record_id: "asset-1",
    first_seen_at: sourceTime.toISOString(),
    occurred_at: sourceTime.toISOString(),
    collected_at: startedAt.toISOString(),
    data: { content, rawSecret },
  };
}

async function seed() {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  await setup.createOrganization({
    id: ids.organization,
    slug: "admin-operations",
    name: "Admin Operations",
    createdAt: startedAt,
  });
  await setup.createOrganization({
    id: ids.otherOrganization,
    slug: "admin-operations-other",
    name: "Admin Operations Other",
    createdAt: startedAt,
  });
  for (const provider of [
    {
      id: ids.provider,
      organizationId: ids.organization,
      platformKey: "alpha-platform",
      displayName: "Alpha Provider",
      revisionId: ids.revision,
    },
    {
      id: ids.secondProvider,
      organizationId: ids.organization,
      platformKey: "beta-platform",
      displayName: "Beta Provider",
      revisionId: ids.secondRevision,
    },
    {
      id: ids.otherProvider,
      organizationId: ids.otherOrganization,
      platformKey: "other-platform",
      displayName: "Other Provider",
      revisionId: ids.otherRevision,
    },
  ]) {
    await setup.createProviderSource({
      id: provider.id,
      organizationId: provider.organizationId,
      platformKey: provider.platformKey,
      displayName: provider.displayName,
      createdAt: startedAt,
    });
    await setup.createConfigRevision({
      id: provider.revisionId,
      organizationId: provider.organizationId,
      providerId: provider.id,
      version: 1,
      adapterKey: "http-cursor-v2",
      endpointUrl: "https://provider.example/feed",
      authMode: "none",
      createdByActorKey: "actor:admin",
      createdAt: startedAt,
    });
  }
  await setup.recordSuccessfulConnectionTest({
    organizationId: ids.organization,
    providerId: ids.secondProvider,
    revisionId: ids.secondRevision,
    actorKey: "actor:admin",
    testedAt: startedAt,
    latencyMs: 5,
  });
  await setup.activateConfiguration({
    organizationId: ids.organization,
    providerId: ids.secondProvider,
    revisionId: ids.secondRevision,
    actorKey: "actor:admin",
    activatedAt: startedAt,
    nextRunAt: new Date(startedAt.getTime() + 300_000),
  });
  for (const [index, runId] of [
    ids.acceptedRun,
    ids.unchangedRun,
    ids.revisedRun,
  ].entries()) {
    await setup.createImportRun({
      id: runId,
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.revision,
      trigger: index === 1 ? "scheduled" : "manual",
      ...(index === 1 ? {} : { requestedByActorKey: "actor:admin" }),
      state: "incomplete",
      createdAt: new Date(startedAt.getTime() + index * 60_000),
    });
  }
  await setup.createImportRun({
    id: ids.otherRun,
    organizationId: ids.otherOrganization,
    providerId: ids.otherProvider,
    configRevisionId: ids.otherRevision,
    trigger: "manual",
    requestedByActorKey: "actor:other",
    state: "failed",
    createdAt: new Date(startedAt.getTime() + 180_000),
  });
  const ingestion = new IngestionPersistenceRepository(harness.database, {
    retentionDays: 90,
    actorPseudonymKey: "admin-operation-test-pseudonym-key",
  });
  const contents = ["initial", "initial", "revised"];
  for (const [index, runId] of [
    ids.acceptedRun,
    ids.unchangedRun,
    ids.revisedRun,
  ].entries()) {
    const envelope = catalog(contents[index]!);
    const invalidTrade = {
      stream: "trades",
      platform: "alpha-platform",
      record_id: "private-user",
      data: { wallet: "0xprivate-wallet", rawSecret },
    };
    await ingestion.commitPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.revision,
      runId,
      pageNumber: 1,
      requestedCursor: index === 0 ? null : `cursor-${index}`,
      nextCursor: `cursor-${index + 1}`,
      hasMore: false,
      payload: {
        requestedCursor: index === 0 ? null : `cursor-${index}`,
        nextCursor: `cursor-${index + 1}`,
        hasMore: false,
        records: index === 0 ? [envelope, invalidTrade] : [envelope],
      },
      checkpointMode: "provider",
      records: [{
        recordKind: "catalog",
        recordIndex: 0,
        externalId: "asset-1",
        sourceTime,
        collectedAt: startedAt,
        payload: envelope,
        projections: [{
          platformKey: "alpha-platform",
          recordKind: "catalog_asset",
          externalId: "asset-1",
          content: { name: contents[index] },
          sourceUpdatedAt: sourceTime,
          sourceCollectedAt: startedAt,
        }],
      }],
      ...(index === 0
        ? {
            quarantines: [{
              recordKind: "trade" as const,
              recordIndex: 1,
              externalId: "private-user",
              reasonCode: "INVALID_TRADE",
              fieldPath: "records[1].data.wallet",
              sanitizedSummary: "Trade envelope failed validation.",
              payload: invalidTrade,
            }],
          }
        : {}),
      committedAt: new Date(startedAt.getTime() + index * 60_000 + 10_000),
    });
    await harness.database.import_runs.update({
      where: { id: runId },
      data: {
        state: "succeeded",
        started_at: new Date(startedAt.getTime() + index * 60_000 + 1_000),
        finished_at: new Date(startedAt.getTime() + index * 60_000 + 20_000),
        reached_provider_head: true,
      },
    });
  }
  return { ...harness, setup };
}

test("admin operation reads are keyset-paginated, tenant-scoped, and reconcile run outcomes", async () => {
  const harness = await seed();
  try {
    const providers = new PrismaAdminProviderOperationRepository(harness.database);
    await harness.database.provider_config_revisions.create({
      data: {
        id: ids.archiveRevision,
        organization_id: ids.organization,
        provider_id: ids.provider,
        version: 2,
        adapter_key: "provider-archive-v2",
        mapping_adapter_key: "collector-crypt-v2",
        actor_pseudonym_key_fingerprint: "a".repeat(64),
        archive_importer_build_sha: "b".repeat(40),
        endpoint_url: `archive://sha256/${"c".repeat(64)}`,
        auth_mode: "none",
        schedule_seconds: 60,
        stale_after_seconds: 1,
        source_mode: "archive",
        created_by_actor_key: "actor:archive",
        created_at: new Date(startedAt.getTime() + 600_000),
      },
    });
    const firstProviders = await providers.listPage({
      organizationId: ids.organization,
      limit: 1,
    });
    assert.equal(firstProviders.items[0]?.providerId, ids.provider);
    assert.equal(firstProviders.items[0]?.configurationRevisionId, ids.revision);
    assert.equal(firstProviders.items[0]?.configurationVersion, 1);
    assert.equal(firstProviders.hasMore, true);
    const secondProviders = await providers.listPage({
      organizationId: ids.organization,
      limit: 1,
      after: {
        platformKey: firstProviders.items[0]!.platformKey,
        providerId: firstProviders.items[0]!.providerId,
      },
    });
    assert.deepEqual(secondProviders.items.map(({ providerId }) => providerId), [
      ids.secondProvider,
    ]);
    assert.deepEqual(
      await providers.listPage({
        organizationId: ids.otherOrganization,
        limit: 50,
      }),
      {
        items: [{
          providerId: ids.otherProvider,
          platformKey: "other-platform",
          configurationRevisionId: ids.otherRevision,
          configurationVersion: 1,
        }],
        hasMore: false,
      },
    );
    await assert.rejects(
      providers.listPage({ organizationId: ids.organization, limit: 51 }),
      RangeError,
    );

    const runs = new PrismaAdminImportRunRepository(harness.database);
    const firstRuns = await runs.listPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      limit: 1,
    });
    assert.equal(firstRuns.items[0]?.id, ids.revisedRun);
    assert.deepEqual(firstRuns.items[0]?.counters, {
      pages: 1,
      catalog: 1,
      pulls: 0,
      trades: 0,
      accepted: 0,
      unchanged: 0,
      revised: 1,
      quarantined: 0,
      resolvedQuarantines: 0,
    });
    const nextRuns = await runs.listPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      limit: 2,
      after: {
        requestedAt: firstRuns.items[0]!.requestedAt,
        runId: firstRuns.items[0]!.id,
      },
    });
    assert.deepEqual(nextRuns.items.map(({ id }) => id), [
      ids.unchangedRun,
      ids.acceptedRun,
    ]);
    assert.equal(nextRuns.items[0]?.counters.unchanged, 1);
    assert.equal(nextRuns.items[1]?.counters.accepted, 1);
    assert.equal(nextRuns.items[1]?.counters.quarantined, 1);
    assert.equal(nextRuns.items[1]?.counters.trades, 1);
    const scheduledRuns = await runs.listPage({
      organizationId: ids.organization,
      state: "succeeded",
      trigger: "scheduled",
      limit: 50,
    });
    assert.deepEqual(scheduledRuns.items.map(({ id }) => id), [ids.unchangedRun]);
    const detail = await runs.get({
      organizationId: ids.organization,
      runId: ids.revisedRun,
    });
    assert.equal(detail?.pages.length, 1);
    assert.equal(detail?.pages[0]?.catalog, 1);
    assert.equal(detail?.pages[0]?.revised, 1);
    assert.equal(await runs.get({
      organizationId: ids.otherOrganization,
      runId: ids.acceptedRun,
    }), null);
    assert.equal(await runs.get({
      organizationId: ids.organization,
      runId: "71000000-0000-4000-8000-000000000099",
    }), null);
    await assert.rejects(
      runs.listPage({ organizationId: ids.organization, limit: 0 }),
      RangeError,
    );
    assert.doesNotMatch(JSON.stringify([...firstRuns.items, ...nextRuns.items]), /raw-secret|private-user|wallet/);
  } finally {
    await harness.close();
  }
});

test("quarantine keysets apply run, kind, reason, and effective-state filters before bounding", async () => {
  const harness = await seed();
  try {
    const repository = new PrismaQuarantineRepository(harness.database);
    const entry = await harness.database.quarantine_records.findFirst({
      where: { organization_id: ids.organization },
      select: { id: true },
    });
    assert.ok(entry);
    await harness.database.quarantine_attempts.create({
      data: {
        id: ids.retryAttempt,
        organization_id: ids.organization,
        quarantine_id: entry.id,
        state: "running",
        requested_by_actor_key: "actor:admin",
        started_at: new Date(startedAt.getTime() + 30_000),
      },
    });
    const page = await repository.listEntriesPage(
      ids.organization,
      {
        runId: ids.acceptedRun,
        recordKind: "trade",
        reasonCode: "INVALID_TRADE",
        state: "retrying",
        limit: 1,
      },
      new Date(startedAt.getTime() + 40_000),
    );
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.state, "retrying");
    const crossTenant = await repository.listEntriesPage(
      ids.otherOrganization,
      { runId: ids.acceptedRun, limit: 50 },
      new Date(startedAt.getTime() + 40_000),
    );
    assert.equal(crossTenant.items.length, 0);
  } finally {
    await harness.close();
  }
});

test("manual run persistence validates the expected active revision under the provider lock", async () => {
  const harness = await seed();
  try {
    const repository = new PrismaImportRunRepository(harness.database);
    const stale = await repository.requestRun({
      organizationId: ids.organization,
      providerId: ids.secondProvider,
      runId: ids.requestRun,
      trigger: "manual",
      requestedByActorKey: "actor:admin",
      requestedAt: startedAt,
      expectedConfigurationRevisionId: ids.revision,
    });
    assert.deepEqual(stale, {
      kind: "revision_conflict",
      activeConfigurationRevisionId: ids.secondRevision,
    });
    const created = await repository.requestRun({
      organizationId: ids.organization,
      providerId: ids.secondProvider,
      runId: ids.requestRun,
      trigger: "manual",
      requestedByActorKey: "actor:admin",
      requestedAt: startedAt,
      expectedConfigurationRevisionId: ids.secondRevision,
    });
    assert.equal(created.kind, "created");
    const duplicate = await repository.requestRun({
      organizationId: ids.organization,
      providerId: ids.secondProvider,
      runId: "71000000-0000-4000-8000-000000000035",
      trigger: "manual",
      requestedByActorKey: "actor:admin",
      requestedAt: new Date(startedAt.getTime() + 1),
      expectedConfigurationRevisionId: ids.secondRevision,
    });
    assert.equal(duplicate.kind, "active");
    assert.equal(duplicate.kind === "active" ? duplicate.run.id : null, ids.requestRun);
  } finally {
    await harness.close();
  }
});
