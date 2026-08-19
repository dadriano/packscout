import assert from "node:assert/strict";
import test from "node:test";
import type {
  ClaimedProviderImportRun,
  ProviderArchiveImportRepository,
  ProviderImportFinishPersistenceResult,
  ProviderImportPageRepository,
  ProviderImportRunRepository,
  ProviderImportRunSummary,
} from "./provider-import-types.ts";
import {
  ProviderArchiveImportError,
  ProviderArchiveImportService,
  type ProviderArchiveChunkV2,
} from "./provider-archive-import-service.ts";

const now = new Date("2026-08-14T12:00:00.000Z");

function claimedRun(
  overrides: Partial<ClaimedProviderImportRun> = {},
): ClaimedProviderImportRun {
  return {
    id: "00000000-0000-4000-8000-000000000030",
    organizationId: "00000000-0000-4000-8000-000000000001",
    providerId: "00000000-0000-4000-8000-000000000010",
    configRevisionId: "00000000-0000-4000-8000-000000000020",
    trigger: "archive",
    archiveSha256: "a".repeat(64),
    state: "running",
    requestedCursor: "archive-v2:0:0",
    finalCursor: null,
    startedAt: now,
    finishedAt: null,
    heartbeatAt: now,
    counters: {
      accepted: 0,
      duplicate: 0,
      quarantined: 0,
      pages: 0,
      records: 0,
      requestAttempts: 0,
      transientRetries: 0,
    },
    reachedProviderHead: false,
    failureCode: null,
    failureSummary: null,
    workerId: "archive-worker",
    leaseExpiresAt: new Date(now.getTime() + 120_000),
    currentCursor: "archive-v2:0:0",
    nextPageNumber: 1,
    committedCursors: [],
    committedArchiveUncompressedBytes: 0,
    archiveMaximumElapsedMs: 4 * 60 * 60 * 1_000,
    ...overrides,
  };
}

function terminalSummary(
  run: ClaimedProviderImportRun,
  input: Parameters<ProviderImportRunRepository["finishRun"]>[0],
): ProviderImportRunSummary {
  return {
    ...run,
    state: input.state,
    finishedAt: input.finishedAt,
    reachedProviderHead: input.reachedProviderHead,
    failureCode: input.failureCode,
    failureSummary: input.failureSummary,
  };
}

function serviceHarness(input: {
  run?: ClaimedProviderImportRun;
  terminalPage?: boolean;
  leaseResults?: readonly boolean[];
}) {
  const run = input.run ?? claimedRun();
  let finishInput: Parameters<ProviderImportRunRepository["finishRun"]>[0] | null = null;
  let pageCommits = 0;
  let plannerCalls = 0;
  const leaseResults = [...(input.leaseResults ?? [true, true])];
  const archives: ProviderArchiveImportRepository = {
    async ensureArchiveRevision() {
      return { created: false };
    },
    async requestArchiveRun() {
      return { kind: "existing", run };
    },
    async claimArchiveRun() {
      return { kind: "claimed", run };
    },
    async getArchiveRevision() {
      return { platformKey: "fixture", mappingAdapterKey: "fixture-v2" };
    },
    async hasCommittedTerminalPage() {
      return input.terminalPage ?? false;
    },
    async requeueFailedArchiveRun() {
      return { kind: "requeued" };
    },
  };
  const runs: ProviderImportRunRepository = {
    async requestRun() {
      throw new Error("not used");
    },
    async claimRun() {
      throw new Error("not used");
    },
    async claimNextRun() {
      return { kind: "idle" };
    },
    async hasCommittedTerminalPage() {
      return false;
    },
    async renewLease() {
      return leaseResults.shift() ?? true;
    },
    async recordRequestAttempt() {
      throw new Error("not used");
    },
    async yieldRun() {
      throw new Error("not used");
    },
    async finishRun(value): Promise<ProviderImportFinishPersistenceResult> {
      finishInput = value;
      return { kind: "finished", run: terminalSummary(run, value) };
    },
  };
  const pages: ProviderImportPageRepository = {
    async commitPage() {
      pageCommits += 1;
      return {
        kind: "committed",
        pageId: "00000000-0000-4000-8000-000000000040",
        counters: run.counters,
        newCanonicalRevisions: 0,
        duplicateSourceRecords: 0,
      };
    },
  };
  const service = new ProviderArchiveImportService({
    archives,
    runs,
    pages,
    pagePlanner: {
      async planArchive() {
        plannerCalls += 1;
        return { records: [], quarantines: [] };
      },
    },
    clock: { now: () => now },
    ids: { id: () => "00000000-0000-4000-8000-000000000099" },
  });
  return {
    service,
    get finishInput() {
      return finishInput;
    },
    get pageCommits() {
      return pageCommits;
    },
    get plannerCalls() {
      return plannerCalls;
    },
  };
}

async function* noChunks(): AsyncIterable<ProviderArchiveChunkV2> {
  // Deliberately empty.
}

test("reclaimed archive finishes from its durable terminal page without rereading bytes", async () => {
  const run = claimedRun({
    currentCursor: "archive-v2:3:1",
    finalCursor: "archive-v2:3:1",
    nextPageNumber: 5,
    committedCursors: ["archive-v2:3:1"],
    counters: {
      accepted: 4,
      duplicate: 0,
      quarantined: 1,
      pages: 4,
      records: 5,
      requestAttempts: 0,
      transientRetries: 0,
    },
  });
  const harness = serviceHarness({ run, terminalPage: true });
  let readerCalled = false;
  const result = await harness.service.executeArchive({
    organizationId: run.organizationId,
    runId: run.id,
    workerId: run.workerId,
    chunks: () => {
      readerCalled = true;
      return noChunks();
    },
  });

  assert.equal(readerCalled, false);
  assert.equal(result.state, "incomplete");
  assert.equal(harness.finishInput?.state, "incomplete");
  assert.equal(harness.finishInput?.reachedProviderHead, true);
});

test("an archive with no committed terminal page and no chunks fails closed", async () => {
  const run = claimedRun();
  const harness = serviceHarness({ run });
  const result = await harness.service.executeArchive({
    organizationId: run.organizationId,
    runId: run.id,
    workerId: run.workerId,
    chunks: () => noChunks(),
  });

  assert.equal(result.state, "failed");
  assert.equal(harness.finishInput?.failureCode, "ARCHIVE_INVALID");
  assert.match(harness.finishInput?.failureSummary ?? "", /no import chunks/i);
});

test("archive ownership is renewed after mapping and before persistence", async () => {
  const run = claimedRun();
  const harness = serviceHarness({ run, leaseResults: [true, false] });
  const record = {
    stream: "catalog",
    platform: "fixture",
    entity: "pack",
    record_id: "pack-1",
    first_seen_at: now.toISOString(),
    occurred_at: now.toISOString(),
    collected_at: now.toISOString(),
    data: {},
  } as const;
  async function* oneChunk(): AsyncIterable<ProviderArchiveChunkV2> {
    yield {
      requestedCursor: run.currentCursor!,
      nextCursor: "archive-v2:1:0",
      hasMore: false,
      records: [record],
      uncompressedBytes: 128,
      pageEvidence: { archive: true, recordCount: 1, uncompressedBytes: 128 },
      payloadHash: "b".repeat(64),
    };
  }

  await assert.rejects(
    harness.service.executeArchive({
      organizationId: run.organizationId,
      runId: run.id,
      workerId: run.workerId,
      chunks: () => oneChunk(),
    }),
    (error: unknown) =>
      error instanceof ProviderArchiveImportError &&
      error.code === "ARCHIVE_OWNERSHIP_LOST",
  );
  assert.equal(harness.plannerCalls, 1);
  assert.equal(harness.pageCommits, 0);
  assert.equal(harness.finishInput, null);
});
