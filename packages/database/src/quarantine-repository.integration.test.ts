import assert from "node:assert/strict";
import { test } from "node:test";
import { eq, sql } from "drizzle-orm";
import { IngestionPersistenceRepository } from "./ingestion-repository.ts";
import { PersistenceError } from "./persistence-error.ts";
import { DrizzleQuarantineRepository } from "./quarantine-repository.ts";
import { quarantineAttempts } from "./schema/quarantine-retry.ts";
import {
  auditEvents,
  canonicalRevisions,
  importPages,
  importRuns,
  providerCursorCheckpoints,
  quarantineRecords,
  sourceRecordOutcomes,
  sourceRecords,
} from "./schema/index.ts";
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
  const [quarantine] = await harness.database
    .select({ id: quarantineRecords.id, pageId: quarantineRecords.pageId })
    .from(quarantineRecords)
    .where(eq(quarantineRecords.organizationId, ids.organization));
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
    const [beforeRun] = await harness.database
      .select({ state: importRuns.state, counters: importRuns.countersJson })
      .from(importRuns)
      .where(eq(importRuns.id, ids.run));
    const [beforeCursor] = await harness.database
      .select({
        cursor: providerCursorCheckpoints.cursor,
        runId: providerCursorCheckpoints.advancedByRunId,
      })
      .from(providerCursorCheckpoints)
      .where(eq(providerCursorCheckpoints.configRevisionId, ids.configuration));

    const [claimed, competing] = await Promise.all([
      harness.repository.claimRetry({
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

    const [afterRun] = await harness.database
      .select({ state: importRuns.state, counters: importRuns.countersJson })
      .from(importRuns)
      .where(eq(importRuns.id, ids.run));
    const [afterCursor] = await harness.database
      .select({
        cursor: providerCursorCheckpoints.cursor,
        runId: providerCursorCheckpoints.advancedByRunId,
      })
      .from(providerCursorCheckpoints)
      .where(eq(providerCursorCheckpoints.configRevisionId, ids.configuration));
    assert.deepEqual(afterRun, beforeRun);
    assert.deepEqual(afterCursor, beforeCursor);
    assert.equal((await harness.database.select().from(sourceRecords)).length, 1);
    assert.equal((await harness.database.select().from(canonicalRevisions)).length, 1);
    const [outcome] = await harness.database
      .select({
        sourceRecordId: sourceRecordOutcomes.sourceRecordId,
        externalId: sourceRecordOutcomes.externalId,
      })
      .from(sourceRecordOutcomes)
      .where(eq(sourceRecordOutcomes.pageId, harness.quarantine.pageId));
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
    const audits = await harness.database
      .select({ metadata: auditEvents.metadataJson })
      .from(auditEvents)
      .where(eq(auditEvents.action, "provider.quarantine.retry"));
    const renderedAudit = JSON.stringify(audits);
    assert.equal(renderedAudit.includes(rawSecret), false);
    assert.equal(renderedAudit.includes("private-database-user"), false);
    assert.equal(renderedAudit.includes("0xprivate-database-wallet"), false);
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
    const [stored] = await harness.database
      .select({ payload: quarantineRecords.payloadJson })
      .from(quarantineRecords)
      .where(eq(quarantineRecords.id, harness.quarantine.id));
    const [page] = await harness.database
      .select({ payload: importPages.payloadJson })
      .from(importPages)
      .where(eq(importPages.id, harness.quarantine.pageId));
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
      (await harness.database
        .select({ count: sql<number>`count(*)::integer` })
        .from(quarantineAttempts))[0]?.count,
      0,
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
    assert.equal((await harness.database.select().from(sourceRecords)).length, 0);
    assert.equal((await harness.database.select().from(canonicalRevisions)).length, 0);
    const [page] = await harness.database
      .select({ payload: importPages.payloadJson })
      .from(importPages)
      .where(eq(importPages.id, harness.quarantine.pageId));
    assert.equal(page?.payload, null);
  } finally {
    await harness.close();
  }
});
