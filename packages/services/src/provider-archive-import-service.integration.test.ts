import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderStreamRecordV2 } from "@packscout/contracts";
import {
  IngestionPersistenceRepository,
  PipelineSetupRepository,
  PersistenceError,
  PrismaArchiveImportRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { ProviderArchiveImportService } from "./provider-archive-import-service.ts";
import { providerArchiveCursorV2 } from "./provider-archive-reader.ts";
import type { ProviderImportMappedPage } from "./provider-import-types.ts";

const ids = {
  organization: "30000000-0000-4000-8000-000000000001",
  provider: "30000000-0000-4000-8000-000000000010",
  revision: "30000000-0000-4000-8000-000000000020",
  run: "30000000-0000-4000-8000-000000000030",
} as const;
const digest = "c".repeat(64);
const baseTime = new Date("2026-08-14T12:00:00.000Z");

function catalog(recordId: string): ProviderStreamRecordV2 {
  return {
    stream: "catalog",
    platform: "fixture",
    entity: "pack",
    record_id: recordId,
    first_seen_at: baseTime.toISOString(),
    occurred_at: baseTime.toISOString(),
    collected_at: baseTime.toISOString(),
    data: { name: recordId },
  };
}

function plannedRecords(records: readonly ProviderStreamRecordV2[]): ProviderImportMappedPage {
  return {
    records: records.map((record, recordIndex) => ({
      recordKind:
        record.stream === "catalog"
          ? "catalog" as const
          : record.stream === "pulls"
            ? "pull" as const
            : "trade" as const,
      recordIndex,
      externalId: record.record_id,
      sourceTime: new Date(record.occurred_at ?? record.collected_at),
      collectedAt: new Date(record.collected_at),
      payload: record,
      projections: [],
    })),
    quarantines: [],
  };
}

async function createArchiveHarness(
  limits: {
    maximumOperationUncompressedBytes?: number;
    maximumOperationElapsedMs?: number;
  } = {},
) {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  await setup.createOrganization({
    id: ids.organization,
    slug: "archive-recovery",
    name: "Archive Recovery",
    createdAt: baseTime,
  });
  await setup.createProviderSource({
    id: ids.provider,
    organizationId: ids.organization,
    platformKey: "fixture",
    displayName: "Fixture",
    createdAt: baseTime,
  });
  const archives = new PrismaArchiveImportRepository(harness.database);
  await archives.ensureArchiveRevision({
    organizationId: ids.organization,
    providerId: ids.provider,
    configurationRevisionId: ids.revision,
    platformKey: "fixture",
    mappingAdapterKey: "fixture-v2",
    actorPseudonymKeyFingerprint: "d".repeat(64),
    archiveImporterBuildSha: "e".repeat(40),
    archiveSha256: digest,
    actorKey: "operator:archive",
    createdAt: baseTime,
  });
  let clockOffset = 0;
  const now = () => new Date(Date.now() + clockOffset);
  const service = new ProviderArchiveImportService({
    archives,
    runs: archives,
    pages: new IngestionPersistenceRepository(harness.database, {
      retentionDays: 90,
      actorPseudonymKey: "archive-integration-key",
    }),
    pagePlanner: {
      async planArchive({ page }) {
        return plannedRecords(page.page.records);
      },
    },
    clock: { now },
    ids: { id: () => ids.run },
    ...limits,
  });
  await service.requestArchive({
    organizationId: ids.organization,
    providerId: ids.provider,
    configurationRevisionId: ids.revision,
    archiveSha256: digest,
    requestedByActorKey: "operator:archive",
    initialCursor: providerArchiveCursorV2(0, 0),
  });
  return {
    ...harness,
    archives,
    service,
    now,
    advanceClock(milliseconds: number) {
      clockOffset += milliseconds;
    },
  };
}

test("partial archive failure is explicitly requeued and resumes without duplicating pages", async () => {
  const harness = await createArchiveHarness();
  try {
    async function* partialThenFail() {
      yield {
        requestedCursor: providerArchiveCursorV2(0, 0),
        nextCursor: providerArchiveCursorV2(0, 1),
        hasMore: true,
        records: [catalog("pack-1")],
        uncompressedBytes: 128,
        pageEvidence: {
          member: 0,
          firstLine: 0,
          nextLine: 1,
          recordCount: 1,
          uncompressedBytes: 128,
        },
        payloadHash: "d".repeat(64),
      };
      throw new Error("synthetic archive interruption");
    }
    const failed = await harness.service.executeArchive({
      organizationId: ids.organization,
      runId: ids.run,
      workerId: "archive-worker",
      chunks: () => partialThenFail(),
    });
    assert.equal(failed.state, "failed");
    assert.equal(failed.counters.pages, 1);
    assert.equal(failed.finalCursor, providerArchiveCursorV2(0, 1));

    await harness.service.recoverFailedArchive({
      organizationId: ids.organization,
      providerId: ids.provider,
      runId: ids.run,
      archiveSha256: digest,
      requestedByActorKey: "operator:archive",
    });
    let resumedAt: string | null = null;
    async function* terminalChunk() {
      yield {
        requestedCursor: providerArchiveCursorV2(0, 1),
        nextCursor: providerArchiveCursorV2(3, 1),
        hasMore: false,
        records: [catalog("pack-2")],
        uncompressedBytes: 128,
        pageEvidence: {
          member: 3,
          firstLine: 0,
          nextLine: 1,
          recordCount: 1,
          uncompressedBytes: 128,
        },
        payloadHash: "e".repeat(64),
      };
    }
    const succeeded = await harness.service.executeArchive({
      organizationId: ids.organization,
      runId: ids.run,
      workerId: "archive-worker",
      chunks: (cursor) => {
        resumedAt = cursor;
        return terminalChunk();
      },
    });

    assert.equal(resumedAt, providerArchiveCursorV2(0, 1));
    assert.equal(succeeded.state, "succeeded");
    assert.equal(succeeded.counters.pages, 2);
    assert.equal(succeeded.counters.accepted, 2);
    assert.equal(await harness.database.import_pages.count(), 2);
    assert.equal(await harness.database.source_records.count(), 2);
    assert.equal(await harness.database.provider_cursor_checkpoints.count(), 0);
    assert.equal(await harness.database.audit_events.count({
      where: { action: "provider.archive_import.requeue", subject_id: ids.run },
    }), 1);

    const replay = await harness.service.requestArchive({
      organizationId: ids.organization,
      providerId: ids.provider,
      configurationRevisionId: ids.revision,
      archiveSha256: digest,
      requestedByActorKey: "operator:archive",
      initialCursor: providerArchiveCursorV2(0, 0),
    });
    assert.equal(replay.existing, true);
    assert.equal(replay.run.id, ids.run);
    assert.equal(replay.run.state, "succeeded");
  } finally {
    await harness.close();
  }
});

test("archive byte budget remains cumulative across members and explicit recovery", async () => {
  const harness = await createArchiveHarness({
    maximumOperationUncompressedBytes: 200,
  });
  try {
    async function* firstMemberThenFail() {
      yield {
        requestedCursor: providerArchiveCursorV2(0, 0),
        nextCursor: providerArchiveCursorV2(1, 0),
        hasMore: true,
        records: [catalog("pack-first-member")],
        uncompressedBytes: 120,
        pageEvidence: {
          member: 0,
          firstLine: 0,
          nextLine: 1,
          recordCount: 1,
          uncompressedBytes: 120,
        },
        payloadHash: "a".repeat(64),
      };
      throw new Error("synthetic archive interruption");
    }
    const firstAttempt = await harness.service.executeArchive({
      organizationId: ids.organization,
      runId: ids.run,
      workerId: "archive-worker",
      chunks: () => firstMemberThenFail(),
    });
    assert.equal(firstAttempt.state, "failed");
    assert.equal(firstAttempt.counters.pages, 1);

    const durableCounters = await harness.database.import_runs.findUnique({
      where: { id: ids.run },
      select: { counters_json: true },
    });
    assert.equal(
      (durableCounters?.counters_json as { archiveUncompressedBytes?: number })
        .archiveUncompressedBytes,
      120,
    );

    await harness.service.recoverFailedArchive({
      organizationId: ids.organization,
      providerId: ids.provider,
      runId: ids.run,
      archiveSha256: digest,
      requestedByActorKey: "operator:archive",
    });
    async function* secondMember() {
      yield {
        requestedCursor: providerArchiveCursorV2(1, 0),
        nextCursor: providerArchiveCursorV2(2, 0),
        hasMore: false,
        records: [catalog("pack-second-member")],
        uncompressedBytes: 81,
        pageEvidence: {
          member: 1,
          firstLine: 0,
          nextLine: 1,
          recordCount: 1,
          uncompressedBytes: 81,
        },
        payloadHash: "b".repeat(64),
      };
    }
    const recoveredAttempt = await harness.service.executeArchive({
      organizationId: ids.organization,
      runId: ids.run,
      workerId: "archive-worker",
      chunks: () => secondMember(),
    });

    assert.equal(recoveredAttempt.state, "failed");
    assert.equal(recoveredAttempt.failureCode, "ARCHIVE_INVALID");
    assert.match(recoveredAttempt.failureSummary ?? "", /operation resource limit/i);
    assert.equal(recoveredAttempt.counters.pages, 1);
    assert.equal(await harness.database.import_pages.count(), 1);
    const finalCounters = await harness.database.import_runs.findUnique({
      where: { id: ids.run },
      select: { counters_json: true },
    });
    assert.equal(
      (finalCounters?.counters_json as { archiveUncompressedBytes?: number })
        .archiveUncompressedBytes,
      120,
    );
  } finally {
    await harness.close();
  }
});

test("archive elapsed-time budget retains the first durable start across recovery", async () => {
  const harness = await createArchiveHarness({ maximumOperationElapsedMs: 10_000 });
  try {
    async function* onePageThenFail() {
      yield {
        requestedCursor: providerArchiveCursorV2(0, 0),
        nextCursor: providerArchiveCursorV2(1, 0),
        hasMore: true,
        records: [catalog("pack-before-timeout")],
        uncompressedBytes: 64,
        pageEvidence: {
          member: 0,
          firstLine: 0,
          nextLine: 1,
          recordCount: 1,
          uncompressedBytes: 64,
        },
        payloadHash: "9".repeat(64),
      };
      throw new Error("synthetic archive interruption");
    }
    const firstAttempt = await harness.service.executeArchive({
      organizationId: ids.organization,
      runId: ids.run,
      workerId: "archive-worker",
      chunks: () => onePageThenFail(),
    });
    assert.equal(firstAttempt.state, "failed");
    const originalStartedAt = firstAttempt.startedAt;

    await harness.service.recoverFailedArchive({
      organizationId: ids.organization,
      providerId: ids.provider,
      runId: ids.run,
      archiveSha256: digest,
      requestedByActorKey: "operator:archive",
    });
    harness.advanceClock(10_001);
    let readerCalled = false;
    const recoveredAttempt = await harness.service.executeArchive({
      organizationId: ids.organization,
      runId: ids.run,
      workerId: "archive-worker",
      chunks: () => {
        readerCalled = true;
        return (async function* () {})();
      },
    });

    assert.equal(readerCalled, false);
    assert.equal(recoveredAttempt.state, "failed");
    assert.match(recoveredAttempt.failureSummary ?? "", /elapsed-time limit/i);
    assert.deepEqual(recoveredAttempt.startedAt, originalStartedAt);
    assert.equal(recoveredAttempt.counters.pages, 1);
  } finally {
    await harness.close();
  }
});

test("database-clock deadline rolls back an archive page after DB work crosses it", async () => {
  const harness = await createArchiveHarness({ maximumOperationElapsedMs: 500 });
  try {
    await harness.database.$executeRawUnsafe(`
      create function public.packscout_test_delay_archive_commit()
      returns trigger
      language plpgsql
      as $$
      begin
        perform pg_sleep(0.75);
        return new;
      end;
      $$
    `);
    await harness.database.$executeRawUnsafe(`
      create trigger packscout_test_delay_archive_commit
      before insert on public.source_records
      for each row execute function public.packscout_test_delay_archive_commit()
    `);
    const claimedAt = harness.now();
    const claim = await harness.archives.claimArchiveRun({
      organizationId: ids.organization,
      runId: ids.run,
      workerId: "delayed-worker",
      claimedAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + 10_000),
    });
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") return;

    const pages = new IngestionPersistenceRepository(harness.database, {
      retentionDays: 90,
      actorPseudonymKey: "archive-integration-key",
    });
    await assert.rejects(
      pages.commitPage({
        organizationId: ids.organization,
        providerId: ids.provider,
        configRevisionId: ids.revision,
        runId: ids.run,
        workerId: "delayed-worker",
        pageNumber: 1,
        requestedCursor: providerArchiveCursorV2(0, 0),
        nextCursor: providerArchiveCursorV2(3, 1),
        hasMore: false,
        payload: {
          member: 3,
          firstLine: 0,
          nextLine: 1,
          recordCount: 1,
          uncompressedBytes: 128,
        },
        payloadHash: "7".repeat(64),
        archiveUncompressedBytes: 128,
        checkpointMode: "archive",
        ...plannedRecords([catalog("pack-db-delayed")]),
        committedAt: harness.now(),
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "ARCHIVE_DEADLINE_EXCEEDED",
    );

    assert.equal(await harness.database.import_pages.count(), 0);
    assert.equal(await harness.database.source_records.count(), 0);
    const run = await harness.database.import_runs.findUniqueOrThrow({
      where: { id: ids.run },
      select: { final_cursor: true, counters_json: true },
    });
    assert.equal(run.final_cursor, null);
    assert.equal((run.counters_json as { pages?: number }).pages, 0);
  } finally {
    await harness.close();
  }
});

test("a reclaimed run completes from an in-budget terminal page after delayed finalization", async () => {
  const harness = await createArchiveHarness({ maximumOperationElapsedMs: 10_000 });
  try {
    const claimedAt = harness.now();
    const claim = await harness.archives.claimArchiveRun({
      organizationId: ids.organization,
      runId: ids.run,
      workerId: "crashed-worker",
      claimedAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + 10_000),
    });
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") return;
    await new IngestionPersistenceRepository(harness.database, {
      retentionDays: 90,
      actorPseudonymKey: "archive-integration-key",
    }).commitPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.revision,
      runId: ids.run,
      workerId: "crashed-worker",
      pageNumber: 1,
      requestedCursor: providerArchiveCursorV2(0, 0),
      nextCursor: providerArchiveCursorV2(3, 1),
      hasMore: false,
      payload: {
        member: 3,
        firstLine: 0,
        nextLine: 1,
        recordCount: 1,
        uncompressedBytes: 128,
      },
      payloadHash: "f".repeat(64),
      archiveUncompressedBytes: 128,
      checkpointMode: "archive",
      ...plannedRecords([catalog("pack-terminal")]),
      committedAt: harness.now(),
    });
    await harness.database.import_runs.update({
      where: { id: ids.run },
      data: { lease_expires_at: new Date(harness.now().getTime() - 1) },
    });
    harness.advanceClock(10_001);
    let readerCalled = false;
    const result = await harness.service.executeArchive({
      organizationId: ids.organization,
      runId: ids.run,
      workerId: "recovery-worker",
      chunks: () => {
        readerCalled = true;
        return (async function* () {})();
      },
    });

    assert.equal(readerCalled, false);
    assert.equal(result.state, "succeeded");
    assert.equal(result.counters.pages, 1);
    assert.equal(await harness.database.import_pages.count(), 1);
  } finally {
    await harness.close();
  }
});

test("recovery rejects a terminal page whose DB commit marker is after the deadline", async () => {
  const harness = await createArchiveHarness({ maximumOperationElapsedMs: 10_000 });
  try {
    const claimedAt = harness.now();
    const claim = await harness.archives.claimArchiveRun({
      organizationId: ids.organization,
      runId: ids.run,
      workerId: "crashed-worker",
      claimedAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + 10_000),
    });
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed" || !claim.run.startedAt) return;
    await new IngestionPersistenceRepository(harness.database, {
      retentionDays: 90,
      actorPseudonymKey: "archive-integration-key",
    }).commitPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.revision,
      runId: ids.run,
      workerId: "crashed-worker",
      pageNumber: 1,
      requestedCursor: providerArchiveCursorV2(0, 0),
      nextCursor: providerArchiveCursorV2(3, 1),
      hasMore: false,
      payload: {
        member: 3,
        firstLine: 0,
        nextLine: 1,
        recordCount: 1,
        uncompressedBytes: 128,
      },
      payloadHash: "6".repeat(64),
      archiveUncompressedBytes: 128,
      checkpointMode: "archive",
      ...plannedRecords([catalog("pack-late-terminal")]),
      committedAt: harness.now(),
    });
    const lateCommitMarker = new Date(claim.run.startedAt.getTime() + 10_001);
    await harness.database.import_pages.updateMany({
      where: { run_id: ids.run },
      data: { committed_at: lateCommitMarker },
    });
    await harness.database.import_runs.update({
      where: { id: ids.run },
      data: { lease_expires_at: new Date(harness.now().getTime() - 1) },
    });
    assert.equal(await harness.archives.hasCommittedTerminalPage({
      organizationId: ids.organization,
      runId: ids.run,
      pageNumber: 1,
      finalCursor: providerArchiveCursorV2(3, 1),
    }), false);
    harness.advanceClock(10_001);
    let readerCalled = false;
    const result = await harness.service.executeArchive({
      organizationId: ids.organization,
      runId: ids.run,
      workerId: "recovery-worker",
      chunks: () => {
        readerCalled = true;
        return (async function* () {})();
      },
    });

    assert.equal(readerCalled, false);
    assert.equal(result.state, "failed");
    assert.match(result.failureSummary ?? "", /elapsed-time limit/i);
    assert.equal(result.reachedProviderHead, false);
  } finally {
    await harness.close();
  }
});
