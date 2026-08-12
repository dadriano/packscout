import assert from "node:assert/strict";
import { test } from "node:test";
import { IngestionPersistenceRepository } from "./ingestion-repository.ts";
import { PersistenceError } from "./persistence-error.ts";
import { DrizzleQuarantineRepository } from "./quarantine-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const ids = {
  organization: "30000000-0000-4000-8000-000000000001",
  otherOrganization: "30000000-0000-4000-8000-000000000002",
  provider: "30000000-0000-4000-8000-000000000010",
  configuration: "30000000-0000-4000-8000-000000000020",
  run: "30000000-0000-4000-8000-000000000030",
  attemptOne: "30000000-0000-4000-8000-000000000040",
  attemptTwo: "30000000-0000-4000-8000-000000000041",
  competingAttempt: "30000000-0000-4000-8000-000000000042",
  quarantineTwo: "30000000-0000-4000-8000-000000000050",
  quarantineThree: "30000000-0000-4000-8000-000000000051",
  pageTwo: "30000000-0000-4000-8000-000000000060",
  pageThree: "30000000-0000-4000-8000-000000000061",
} as const;

const committedAt = new Date("2026-08-06T12:00:00.000Z");
const sourceTime = new Date("2026-08-06T11:59:00.000Z");
const collectedAt = new Date("2026-08-06T12:00:00.000Z");
const retryAt = new Date("2026-08-06T12:05:00.000Z");
const expiresAt = new Date("2026-11-04T12:00:00.000Z");
const platform = "fixture-platform";
const rawSecret = "Bearer database-raw-secret";

function rawCatalog(externalId: string) {
  return {
    platform,
    external_id: externalId,
    updated_at: sourceTime.toISOString(),
    collected_at: collectedAt.toISOString(),
    data: {
      username: "private-database-user",
      wallet: "0xprivate-database-wallet",
      secret: rawSecret,
    },
  };
}

async function createHarness() {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  await setup.createOrganization({
    id: ids.organization,
    slug: "quarantine-fixture",
    name: "Quarantine Fixture",
    createdAt: committedAt,
  });
  await setup.createOrganization({
    id: ids.otherOrganization,
    slug: "quarantine-other",
    name: "Quarantine Other",
    createdAt: committedAt,
  });
  await setup.createProviderSource({
    id: ids.provider,
    organizationId: ids.organization,
    platformKey: platform,
    displayName: "Fixture Provider",
    createdAt: committedAt,
  });
  await setup.createConfigRevision({
    id: ids.configuration,
    organizationId: ids.organization,
    providerId: ids.provider,
    version: 1,
    adapterKey: "fixture-mapper-v1",
    endpointUrl: "https://provider.example/feed",
    authMode: "none",
    createdByActorKey: "actor:admin",
    createdAt: committedAt,
  });
  await setup.createImportRun({
    id: ids.run,
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    trigger: "manual",
    requestedByActorKey: "actor:admin",
    state: "incomplete",
    createdAt: committedAt,
  });
  const ingestion = new IngestionPersistenceRepository(harness.database, {
    retentionDays: 90,
    actorPseudonymKey: "test-only-pseudonym-key",
  });
  const catalog = rawCatalog("repaired-asset");
  await ingestion.commitPage({
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    runId: ids.run,
    pageNumber: 1,
    requestedCursor: null,
    nextCursor: "opaque-cursor-after-quarantine",
    hasMore: true,
    payload: {
      catalog: [catalog],
      pulls: [],
      sales: [],
      next_cursor: "opaque-cursor-after-quarantine",
      has_more: true,
    },
    records: [],
    quarantines: [{
      recordKind: "catalog",
      recordIndex: 0,
      externalId: null,
      reasonCode: "ENVELOPE_VALIDATION_FAILED",
      fieldPath: "catalog[0].external_id",
      sanitizedSummary: "Catalog envelope failed validation.",
      payload: catalog,
    }],
    committedAt,
  });
  const quarantineRecord = await harness.database.quarantine_records.findFirst({
    where: { organization_id: ids.organization },
    select: { id: true, page_id: true },
  });
  const quarantine = quarantineRecord
    ? { id: quarantineRecord.id, pageId: quarantineRecord.page_id }
    : null;
  if (!quarantine) throw new Error("Quarantine fixture was not created.");
  return {
    ...harness,
    ingestion,
    repository: new DrizzleQuarantineRepository(harness.database),
    quarantine,
    catalog,
  };
}

test("quarantine retry claims atomically, materializes repaired evidence, and preserves run progress", async () => {
  const harness = await createHarness();
  try {
    const independentClient = await harness.createIndependentClient();
    const competingRepository = new DrizzleQuarantineRepository(independentClient);
    const beforeRunRecord = await harness.database.import_runs.findUnique({
      where: { id: ids.run },
      select: { state: true, counters_json: true },
    });
    const beforeRun = beforeRunRecord
      ? { state: beforeRunRecord.state, counters: beforeRunRecord.counters_json }
      : null;
    const beforeCursorRecord =
      await harness.database.provider_cursor_checkpoints.findUnique({
        where: { config_revision_id: ids.configuration },
        select: { cursor: true, advanced_by_run_id: true },
      });
    const beforeCursor = beforeCursorRecord
      ? {
          cursor: beforeCursorRecord.cursor,
          runId: beforeCursorRecord.advanced_by_run_id,
        }
      : null;

    const [claimed, competing] = await Promise.all([
      competingRepository.claimRetry({
        organizationId: ids.organization,
        quarantineId: harness.quarantine.id,
        attemptId: ids.attemptOne,
        actorKey: "actor:admin",
        claimedAt: retryAt,
      }),
      harness.repository.claimRetry({
        organizationId: ids.organization,
        quarantineId: harness.quarantine.id,
        attemptId: ids.competingAttempt,
        actorKey: "actor:operator",
        claimedAt: retryAt,
      }),
    ]);
    const outcomes = [claimed.kind, competing.kind].sort();
    assert.deepEqual(outcomes, ["already_retrying", "claimed"]);
    const owner = claimed.kind === "claimed" ? claimed : competing;
    assert.equal(owner.kind, "claimed");
    if (owner.kind !== "claimed") throw new Error("Retry owner was not claimed.");
    assert.equal(owner.evidence.sourceRecordId, null);
    assert.deepEqual(owner.evidence.rawRecord, harness.catalog);

    const staleAttemptId =
      owner.attemptId === ids.attemptOne ? ids.competingAttempt : ids.attemptOne;
    const staleCompletion = await competingRepository.completeRetry({
      organizationId: ids.organization,
      quarantineId: harness.quarantine.id,
      attemptId: staleAttemptId,
      actorKey: "actor:stale",
      completedAt: new Date(retryAt.getTime() + 100),
      canonicalRevisionCount: 9,
    });
    assert.equal(staleCompletion?.state, "retrying");
    assert.equal(
      await harness.database.audit_events.count({
        where: { action: "provider.quarantine.retry" },
      }),
      0,
    );
    assert.equal(
      await competingRepository.completeRetry({
        organizationId: ids.otherOrganization,
        quarantineId: harness.quarantine.id,
        attemptId: owner.attemptId,
        actorKey: "actor:foreign",
        completedAt: new Date(retryAt.getTime() + 200),
        canonicalRevisionCount: 9,
      }),
      null,
    );
    assert.equal(
      (
        await harness.database.quarantine_attempts.findUnique({
          where: { id: owner.attemptId },
          select: { state: true },
        })
      )?.state,
      "running",
    );

    await harness.repository.failRetry({
      organizationId: ids.organization,
      quarantineId: harness.quarantine.id,
      attemptId: owner.attemptId,
      actorKey: "actor:admin",
      failedAt: retryAt,
      failureCode: "ENVELOPE_VALIDATION_FAILED",
      fieldPath: "external_id",
      sanitizedSummary: "Retained evidence still fails envelope validation.",
    });
    const second = await harness.repository.claimRetry({
      organizationId: ids.organization,
      quarantineId: harness.quarantine.id,
      attemptId: ids.attemptTwo,
      actorKey: "actor:admin",
      claimedAt: new Date(retryAt.getTime() + 1_000),
    });
    assert.equal(second.kind, "claimed");

    const projection = {
      platformKey: platform,
      recordKind: "catalog_asset" as const,
      externalId: "repaired-asset",
      content: { name: "Recovered asset" },
      sourceUpdatedAt: sourceTime,
      sourceCollectedAt: collectedAt,
    };
    const firstProjection = await harness.ingestion.materializeAndProjectSourceRecord({
      organizationId: ids.organization,
      providerId: ids.provider,
      configurationRevisionId: ids.configuration,
      quarantineId: harness.quarantine.id,
      attemptId: ids.attemptTwo,
      runId: ids.run,
      pageId: harness.quarantine.pageId,
      recordKind: "catalog",
      recordIndex: 0,
      externalId: "repaired-asset",
      sourceTime,
      collectedAt,
      payload: harness.catalog,
      expiresAt,
      projections: [projection],
      acceptedAt: new Date(retryAt.getTime() + 2_000),
    });
    assert.equal(firstProjection.canonicalRevisionCount, 1);
    const replay = await harness.ingestion.materializeAndProjectSourceRecord({
      organizationId: ids.organization,
      providerId: ids.provider,
      configurationRevisionId: ids.configuration,
      quarantineId: harness.quarantine.id,
      attemptId: ids.attemptTwo,
      runId: ids.run,
      pageId: harness.quarantine.pageId,
      recordKind: "catalog",
      recordIndex: 0,
      externalId: "repaired-asset",
      sourceTime,
      collectedAt,
      payload: harness.catalog,
      expiresAt,
      projections: [projection],
      acceptedAt: new Date(retryAt.getTime() + 3_000),
    });
    assert.equal(replay.sourceRecordId, firstProjection.sourceRecordId);
    assert.equal(replay.canonicalRevisionCount, 0);
    const completed = await harness.repository.completeRetry({
      organizationId: ids.organization,
      quarantineId: harness.quarantine.id,
      attemptId: ids.attemptTwo,
      actorKey: "actor:admin",
      completedAt: new Date(retryAt.getTime() + 4_000),
      canonicalRevisionCount: firstProjection.canonicalRevisionCount,
    });
    assert.equal(completed?.state, "resolved");
    assert.equal(completed?.sourceRecordId, firstProjection.sourceRecordId);

    const afterRunRecord = await harness.database.import_runs.findUnique({
      where: { id: ids.run },
      select: { state: true, counters_json: true },
    });
    const afterRun = afterRunRecord
      ? { state: afterRunRecord.state, counters: afterRunRecord.counters_json }
      : null;
    const afterCursorRecord =
      await harness.database.provider_cursor_checkpoints.findUnique({
        where: { config_revision_id: ids.configuration },
        select: { cursor: true, advanced_by_run_id: true },
      });
    const afterCursor = afterCursorRecord
      ? {
          cursor: afterCursorRecord.cursor,
          runId: afterCursorRecord.advanced_by_run_id,
        }
      : null;
    assert.deepEqual(afterRun, beforeRun);
    assert.deepEqual(afterCursor, beforeCursor);
    assert.equal(await harness.database.source_records.count(), 1);
    assert.equal(await harness.database.canonical_revisions.count(), 1);
    const outcomeRecord = await harness.database.source_record_outcomes.findFirst({
      where: { page_id: harness.quarantine.pageId },
      select: { source_record_id: true, external_id: true },
    });
    const outcome = outcomeRecord
      ? {
          sourceRecordId: outcomeRecord.source_record_id,
          externalId: outcomeRecord.external_id,
        }
      : null;
    assert.deepEqual(outcome, {
      sourceRecordId: firstProjection.sourceRecordId,
      externalId: "repaired-asset",
    });

    const attempts = await harness.repository.listAttempts(
      ids.organization,
      harness.quarantine.id,
    );
    assert.equal(attempts.length, 2);
    assert.deepEqual(
      attempts.map(({ state }) => state).sort(),
      ["failed", "succeeded"],
    );
    assert.equal(
      (await harness.repository.claimRetry({
        organizationId: ids.organization,
        quarantineId: harness.quarantine.id,
        attemptId: ids.competingAttempt,
        actorKey: "actor:admin",
        claimedAt: new Date(retryAt.getTime() + 5_000),
      })).kind,
      "already_resolved",
    );
    assert.equal(
      (await harness.repository.claimRetry({
        organizationId: ids.otherOrganization,
        quarantineId: harness.quarantine.id,
        attemptId: ids.competingAttempt,
        actorKey: "actor:other",
        claimedAt: new Date(retryAt.getTime() + 5_000),
      })).kind,
      "not_found",
    );

    const counts = await harness.repository.countEntries(ids.organization, retryAt);
    assert.deepEqual(counts, {
      outstanding: 0,
      retrying: 0,
      resolved: 1,
      expired: 0,
    });
    const auditRecords = await harness.database.audit_events.findMany({
      where: { action: "provider.quarantine.retry" },
      select: { metadata_json: true },
    });
    const audits = auditRecords.map(({ metadata_json: metadata }) => ({ metadata }));
    const renderedAudit = JSON.stringify(audits);
    assert.equal(renderedAudit.includes(rawSecret), false);
    assert.equal(renderedAudit.includes("private-database-user"), false);
    assert.equal(renderedAudit.includes("0xprivate-database-wallet"), false);
  } finally {
    await harness.close();
  }
});

test("quarantine listing is tenant-scoped, filtered, and stable across keyset pages", async () => {
  const harness = await createHarness();
  try {
    await harness.database.quarantine_records.createMany({
      data: [
        {
          id: ids.quarantineTwo,
          organization_id: ids.organization,
          provider_id: ids.provider,
          run_id: ids.run,
          page_id: harness.quarantine.pageId,
          record_kind: "pull",
          record_index: 1,
          external_id: "pull-two",
          reason_code: "PULL_MAPPING_FAILED",
          field_path: "pulls[1]",
          sanitized_summary: "Pull mapping failed.",
          payload_json: rawCatalog("pull-two"),
          expires_at: expiresAt,
          created_at: new Date(committedAt.getTime() + 1_000),
        },
        {
          id: ids.quarantineThree,
          organization_id: ids.organization,
          provider_id: ids.provider,
          run_id: ids.run,
          page_id: harness.quarantine.pageId,
          record_kind: "sale",
          record_index: 2,
          external_id: "sale-three",
          reason_code: "SALE_MAPPING_FAILED",
          field_path: "sales[2]",
          sanitized_summary: "Sale mapping failed.",
          payload_json: rawCatalog("sale-three"),
          expires_at: expiresAt,
          created_at: new Date(committedAt.getTime() + 2_000),
        },
      ],
    });

    const firstPage = await harness.repository.listEntriesPage(
      ids.organization,
      { limit: 2 },
      retryAt,
    );
    assert.equal(firstPage.hasMore, true);
    assert.deepEqual(
      firstPage.items.map(({ id }) => id),
      [ids.quarantineThree, ids.quarantineTwo],
    );
    const cursor = firstPage.items.at(-1)!;
    const secondPage = await harness.repository.listEntriesPage(
      ids.organization,
      {
        limit: 2,
        before: { createdAt: cursor.createdAt, id: cursor.id },
      },
      retryAt,
    );
    assert.equal(secondPage.hasMore, false);
    assert.deepEqual(
      secondPage.items.map(({ id }) => id),
      [harness.quarantine.id],
    );
    assert.deepEqual(
      (
        await harness.repository.listEntriesPage(
          ids.organization,
          { limit: 10, recordKind: "sale", reasonCode: "SALE_MAPPING_FAILED" },
          retryAt,
        )
      ).items.map(({ id }) => id),
      [ids.quarantineThree],
    );
    assert.deepEqual(
      await harness.repository.listEntriesPage(
        ids.otherOrganization,
        { limit: 10 },
        retryAt,
      ),
      { items: [], hasMore: false },
    );
    assert.doesNotMatch(
      JSON.stringify([...firstPage.items, ...secondPage.items]),
      /database-raw-secret|private-database-user|private-database-wallet/,
    );
    await assert.rejects(
      harness.repository.listEntriesPage(
        ids.organization,
        { limit: 101 },
        retryAt,
      ),
      RangeError,
    );
  } finally {
    await harness.close();
  }
});

test("linked-source retries project through the shared ingestion semantics and reject stale attempts", async () => {
  const harness = await createHarness();
  try {
    const linkedRecord = rawCatalog("linked-asset");
    const committed = await harness.ingestion.commitPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.configuration,
      runId: ids.run,
      pageNumber: 2,
      requestedCursor: "opaque-cursor-after-quarantine",
      nextCursor: "opaque-cursor-after-linked-quarantine",
      hasMore: false,
      payload: {
        catalog: [linkedRecord],
        pulls: [],
        sales: [],
        next_cursor: "opaque-cursor-after-linked-quarantine",
        has_more: false,
      },
      records: [
        {
          recordKind: "catalog",
          recordIndex: 0,
          externalId: "linked-asset",
          sourceTime,
          collectedAt,
          payload: linkedRecord,
          projections: [],
          quarantine: {
            reasonCode: "CANONICAL_MAPPING_FAILED",
            fieldPath: "data.name",
            sanitizedSummary: "Canonical mapping failed.",
          },
        },
      ],
      committedAt: new Date(committedAt.getTime() + 1_000),
    });
    assert.equal(committed.kind, "committed");
    const linkedQuarantine = await harness.database.quarantine_records.findFirst({
      where: { page_id: committed.pageId },
      select: { id: true, source_record_id: true },
    });
    assert.ok(linkedQuarantine?.source_record_id);
    const claim = await harness.repository.claimRetry({
      organizationId: ids.organization,
      quarantineId: linkedQuarantine.id,
      attemptId: ids.attemptOne,
      actorKey: "actor:admin",
      claimedAt: retryAt,
    });
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed" || !claim.evidence.sourceRecordId) {
      throw new Error("Linked source retry was not claimed.");
    }
    assert.equal(claim.evidence.sourceRecordId, linkedQuarantine.source_record_id);
    assert.equal(claim.evidence.source?.externalId, "linked-asset");
    const projection = {
      platformKey: platform,
      recordKind: "catalog_asset" as const,
      externalId: "linked-asset",
      content: { name: "Recovered linked asset" },
      sourceUpdatedAt: sourceTime,
      sourceCollectedAt: collectedAt,
    };
    await assert.rejects(
      harness.ingestion.projectSourceRecord({
        organizationId: ids.organization,
        providerId: ids.provider,
        configurationRevisionId: ids.configuration,
        quarantineId: linkedQuarantine.id,
        attemptId: ids.competingAttempt,
        sourceRecordId: claim.evidence.sourceRecordId,
        projections: [projection],
        acceptedAt: retryAt,
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "TENANT_SCOPE_VIOLATION",
    );
    assert.equal(await harness.database.canonical_revisions.count(), 0);
    const projected = await harness.ingestion.projectSourceRecord({
      organizationId: ids.organization,
      providerId: ids.provider,
      configurationRevisionId: ids.configuration,
      quarantineId: linkedQuarantine.id,
      attemptId: ids.attemptOne,
      sourceRecordId: claim.evidence.sourceRecordId,
      projections: [projection],
      acceptedAt: retryAt,
    });
    assert.equal(projected.canonicalRevisionCount, 1);
    const completed = await harness.repository.completeRetry({
      organizationId: ids.organization,
      quarantineId: linkedQuarantine.id,
      attemptId: ids.attemptOne,
      actorKey: "actor:admin",
      completedAt: new Date(retryAt.getTime() + 1_000),
      canonicalRevisionCount: projected.canonicalRevisionCount,
    });
    assert.equal(completed?.state, "resolved");
    assert.equal(completed?.sourceRecordId, claim.evidence.sourceRecordId);
  } finally {
    await harness.close();
  }
});

test("ninety-day expiry removes protected evidence but preserves quarantine metadata", async () => {
  const harness = await createHarness();
  try {
    const expiredAt = new Date("2026-11-05T00:00:00.000Z");
    assert.equal(
      await harness.repository.expireEvidence({
        organizationId: ids.organization,
        before: expiredAt,
        expiredAt,
        batchSize: 10,
      }),
      1,
    );
    const entry = await harness.repository.getEntry(
      ids.organization,
      harness.quarantine.id,
      expiredAt,
    );
    assert.equal(entry?.state, "expired");
    assert.equal(entry?.reasonCode, "ENVELOPE_VALIDATION_FAILED");
    assert.equal(entry?.recordKind, "catalog");
    const storedRecord = await harness.database.quarantine_records.findUnique({
      where: { id: harness.quarantine.id },
      select: { payload_json: true },
    });
    const stored = storedRecord ? { payload: storedRecord.payload_json } : null;
    const pageRecord = await harness.database.import_pages.findUnique({
      where: { id: harness.quarantine.pageId },
      select: { payload_json: true },
    });
    const page = pageRecord ? { payload: pageRecord.payload_json } : null;
    assert.equal(stored?.payload, null);
    assert.equal(page?.payload, null);
    assert.equal(
      (await harness.repository.claimRetry({
        organizationId: ids.organization,
        quarantineId: harness.quarantine.id,
        attemptId: ids.attemptOne,
        actorKey: "actor:admin",
        claimedAt: expiredAt,
      })).kind,
      "expired",
    );
    assert.equal(
      await harness.database.quarantine_attempts.count(),
      0,
    );
  } finally {
    await harness.close();
  }
});

test("independent expiry workers claim disjoint evidence while a running retry stays protected", async () => {
  const harness = await createHarness();
  try {
    const claimedAt = new Date("2026-11-04T11:59:00.000Z");
    assert.equal(
      (
        await harness.repository.claimRetry({
          organizationId: ids.organization,
          quarantineId: harness.quarantine.id,
          attemptId: ids.attemptOne,
          actorKey: "actor:admin",
          claimedAt,
        })
      ).kind,
      "claimed",
    );
    await harness.database.import_pages.createMany({
      data: [
        {
          id: ids.pageTwo,
          organization_id: ids.organization,
          provider_id: ids.provider,
          run_id: ids.run,
          page_number: 2,
          requested_cursor: "expiry-two",
          has_more: false,
          payload_json: { catalog: [rawCatalog("expiry-two")], pulls: [], sales: [] },
          payload_hash: "expiry-two-hash",
          record_counts_json: { catalog: 1, pulls: 0, sales: 0 },
          committed_at: committedAt,
          expires_at: expiresAt,
        },
        {
          id: ids.pageThree,
          organization_id: ids.organization,
          provider_id: ids.provider,
          run_id: ids.run,
          page_number: 3,
          requested_cursor: "expiry-three",
          has_more: false,
          payload_json: {
            catalog: [rawCatalog("expiry-three")],
            pulls: [],
            sales: [],
          },
          payload_hash: "expiry-three-hash",
          record_counts_json: { catalog: 1, pulls: 0, sales: 0 },
          committed_at: committedAt,
          expires_at: expiresAt,
        },
      ],
    });
    await harness.database.quarantine_records.createMany({
      data: [
        {
          id: ids.quarantineTwo,
          organization_id: ids.organization,
          provider_id: ids.provider,
          run_id: ids.run,
          page_id: ids.pageTwo,
          record_kind: "catalog",
          record_index: 0,
          external_id: "expiry-two",
          reason_code: "MAPPING_FAILED",
          sanitized_summary: "Mapping failed.",
          payload_json: rawCatalog("expiry-two"),
          expires_at: expiresAt,
          created_at: committedAt,
        },
        {
          id: ids.quarantineThree,
          organization_id: ids.organization,
          provider_id: ids.provider,
          run_id: ids.run,
          page_id: ids.pageThree,
          record_kind: "catalog",
          record_index: 0,
          external_id: "expiry-three",
          reason_code: "MAPPING_FAILED",
          sanitized_summary: "Mapping failed.",
          payload_json: rawCatalog("expiry-three"),
          expires_at: expiresAt,
          created_at: new Date(committedAt.getTime() + 1_000),
        },
      ],
    });
    const independentClient = await harness.createIndependentClient();
    const independentRepository = new DrizzleQuarantineRepository(independentClient);
    const expiredAt = new Date("2026-11-05T00:00:00.000Z");
    const expiredCounts = await Promise.all([
      harness.repository.expireEvidence({
        organizationId: ids.organization,
        before: expiredAt,
        expiredAt,
        batchSize: 1,
      }),
      independentRepository.expireEvidence({
        organizationId: ids.organization,
        before: expiredAt,
        expiredAt,
        batchSize: 1,
      }),
    ]);
    assert.deepEqual(expiredCounts.sort(), [1, 1]);
    assert.equal(
      await harness.database.quarantine_records.count({
        where: { id: { in: [ids.quarantineTwo, ids.quarantineThree] }, state: "expired" },
      }),
      2,
    );
    assert.deepEqual(
      await harness.database.quarantine_records.findUnique({
        where: { id: harness.quarantine.id },
        select: { state: true, payload_json: true },
      }),
      { state: "open", payload_json: harness.catalog },
    );
    assert.notEqual(
      (
        await harness.database.import_pages.findUnique({
          where: { id: harness.quarantine.pageId },
          select: { payload_json: true },
        })
      )?.payload_json,
      null,
    );
  } finally {
    await harness.close();
  }
});

test("a retry crossing the retention deadline cannot commit canonical data", async () => {
  const harness = await createHarness();
  try {
    const claimedAt = new Date("2026-11-04T11:59:00.000Z");
    const expiredAt = new Date("2026-11-04T12:01:00.000Z");
    const claim = await harness.repository.claimRetry({
      organizationId: ids.organization,
      quarantineId: harness.quarantine.id,
      attemptId: ids.attemptOne,
      actorKey: "actor:admin",
      claimedAt,
    });
    assert.equal(claim.kind, "claimed");
    await assert.rejects(
      harness.ingestion.materializeAndProjectSourceRecord({
        organizationId: ids.organization,
        providerId: ids.provider,
        configurationRevisionId: ids.configuration,
        quarantineId: harness.quarantine.id,
        attemptId: ids.attemptOne,
        runId: ids.run,
        pageId: harness.quarantine.pageId,
        recordKind: "catalog",
        recordIndex: 0,
        externalId: "repaired-asset",
        sourceTime,
        collectedAt,
        payload: harness.catalog,
        expiresAt,
        projections: [{
          platformKey: platform,
          recordKind: "catalog_asset",
          externalId: "repaired-asset",
          content: { name: "Must not persist" },
          sourceUpdatedAt: sourceTime,
          sourceCollectedAt: collectedAt,
        }],
        acceptedAt: expiredAt,
      }),
      (error: unknown) => error instanceof PersistenceError,
    );
    const failed = await harness.repository.failRetry({
      organizationId: ids.organization,
      quarantineId: harness.quarantine.id,
      attemptId: ids.attemptOne,
      actorKey: "actor:admin",
      failedAt: expiredAt,
      failureCode: "PROJECTION_PERSISTENCE_FAILED",
      fieldPath: null,
      sanitizedSummary: "Canonical projection could not be durably committed.",
    });
    assert.equal(failed?.state, "expired");
    assert.equal(await harness.database.source_records.count(), 0);
    assert.equal(await harness.database.canonical_revisions.count(), 0);
    const pageRecord = await harness.database.import_pages.findUnique({
      where: { id: harness.quarantine.pageId },
      select: { payload_json: true },
    });
    const page = pageRecord ? { payload: pageRecord.payload_json } : null;
    assert.equal(page?.payload, null);
  } finally {
    await harness.close();
  }
});
