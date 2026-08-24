import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type {
  PackscoutPrismaClient,
  PackscoutTransactionClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import {
  ACCEPTANCE_CURSOR_CODEC_VERSION,
  ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  activateAcceptanceRuntime,
  createAcceptanceProviderSource,
  createPinnedSourceRun,
  createProviderSourceAcceptanceFixture,
  type AcceptanceSource,
  type ProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { ProviderSourceCursorRepository } from "./provider-source-cursor-repository.ts";
import { ProviderSourceImportRunRepository } from "./provider-source-import-run-repository.ts";
import { ProviderSourceSupervisorRepository } from "./provider-source-supervisor-repository.ts";

const courtyardDefinition = {
  platformKey: "courtyard",
  displayName: "Courtyard",
  mapperKey: "courtyard-provider-observation",
  identityNamespaceKey: "dataforrest-courtyard-records-v1",
  intervalSeconds: 60,
  hashCharacter: "b",
} as const;

const cursorA = "cursor-a";
const cursorB = "cursor-b";
const fingerprintA = "4".repeat(64);
const fingerprintB = "5".repeat(64);

async function databaseClock(database: PackscoutPrismaClient): Promise<Date> {
  const rows = await database.$queryRaw<Array<{ now: Date }>>`
    select clock_timestamp() as "now"
  `;
  return rows[0]!.now;
}

interface SupervisorProof {
  readonly epochId: string;
  readonly ownerKey: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

interface CursorCommitInput {
  readonly requestedCursor: string | null;
  readonly requestedFingerprint: string | null;
  readonly nextCursor: string | null;
  readonly nextFingerprint: string | null;
  readonly continuation?:
    | Readonly<{ kind: "continue" }>
    | Readonly<{ kind: "poll_after"; minimumDelaySeconds: number }>;
  readonly runLeaseToken: string;
  readonly committedAt: Date;
}

async function createOwnedPage(
  transaction: PackscoutTransactionClient,
  fixture: ProviderSourceAcceptanceFixture,
  source: AcceptanceSource,
  supervisor: SupervisorProof,
  input: CursorCommitInput,
  runId: string,
): Promise<{
  pageId: string;
  requestAttemptId: string;
}> {
  const requestAttemptId = randomUUID();
  const pageId = randomUUID();
  const requestedCursorKey = input.requestedFingerprint ?? "initial";
  const continuation = input.continuation ?? { kind: "continue" };
  await transaction.compact_source_request_attempts.create({
    data: {
      request_attempt_id: requestAttemptId,
      organization_id: fixture.organizationId,
      operation_kind: "page_read",
      terminal_state: "captured",
      outcome_class: "response_captured",
      safe_outcome_hash: "6".repeat(64),
      request_lease_id: randomUUID(),
      claim_owner: supervisor.ownerKey,
      claim_token: input.runLeaseToken,
      supervisor_epoch_id: supervisor.epochId,
      connection_profile_id: fixture.connectionProfileId,
      connection_revision_id: fixture.connectionRevisionId,
      expected_health_generation: 0n,
      provider_id: source.providerId,
      source_instance_id: source.sourceInstanceId,
      source_revision_id: source.sourceRevisionId,
      run_id: runId,
      page_number: 1,
      cursor_generation: 1n,
      requested_cursor_fingerprint: input.requestedFingerprint,
      requested_cursor_key: requestedCursorKey,
      started_at: input.committedAt,
      terminal_at: input.committedAt,
    },
  });
  await transaction.import_pages.create({
    data: {
      id: pageId,
      organization_id: fixture.organizationId,
      provider_id: source.providerId,
      run_id: runId,
      page_number: 1,
      payload_json: { protectedEvidenceRef: `page:${pageId}` },
      payload_hash: "7".repeat(64),
      record_counts_json: { records: 0 },
      committed_at: input.committedAt,
      expires_at: new Date(input.committedAt.getTime() + 7 * 86_400_000),
      source_instance_id: source.sourceInstanceId,
      source_revision_id: source.sourceRevisionId,
      source_type_key: ACCEPTANCE_SOURCE_TYPE_KEY,
      source_adapter_version: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      normalized_contract_version: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
      mapper_key: source.mapperKey,
      mapper_version: "1",
      identity_namespace_key: source.identityNamespaceKey,
      connection_profile_id: fixture.connectionProfileId,
      connection_revision_id: fixture.connectionRevisionId,
      connection_health_generation: 0n,
      request_attempt_id: requestAttemptId,
      supervisor_epoch_id: supervisor.epochId,
      cursor_codec_version: ACCEPTANCE_CURSOR_CODEC_VERSION,
      cursor_generation: 1n,
      requested_cursor: input.requestedCursor,
      requested_cursor_fingerprint: input.requestedFingerprint,
      requested_cursor_key: requestedCursorKey,
      next_cursor: input.nextCursor,
      next_cursor_fingerprint: input.nextFingerprint,
      continuation_kind: continuation.kind,
      minimum_delay_seconds:
        continuation.kind === "poll_after"
          ? continuation.minimumDelaySeconds
          : null,
      protected_raw_response: new TextEncoder().encode("protected-page"),
      protected_raw_response_sha256: "7".repeat(64),
      normalized_commit_hash: "8".repeat(64),
    },
  });
  return { pageId, requestAttemptId };
}

async function commitCursor(
  database: PackscoutPrismaClient,
  fixture: ProviderSourceAcceptanceFixture,
  source: AcceptanceSource,
  supervisor: SupervisorProof,
  input: CursorCommitInput,
): Promise<{ runId: string; pageId: string }> {
  const run = await createPinnedSourceRun(database, fixture, source, {
    state: "running",
    trigger: "continuation",
    createdAt: input.committedAt,
    requestedCursor: input.requestedCursor,
    requestedCursorFingerprint: input.requestedFingerprint,
    leaseOwner: supervisor.ownerKey,
    leaseToken: input.runLeaseToken,
    leaseExpiresAt: supervisor.leaseExpiresAt,
  });
  const repository = new ProviderSourceCursorRepository(database);
  const page = await database.$transaction(async (transaction) => {
    const ownedPage = await createOwnedPage(
      transaction,
      fixture,
      source,
      supervisor,
      input,
      run.id,
    );
    await repository.advanceInTransaction(transaction, {
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      cursorCodecVersion: ACCEPTANCE_CURSOR_CODEC_VERSION,
      cursorGeneration: 1n,
      expectedCursorFingerprint: input.requestedFingerprint,
      nextCursor: input.nextCursor,
      nextCursorFingerprint: input.nextFingerprint,
      continuation: input.continuation ?? { kind: "continue" },
      runId: run.id,
      pageId: ownedPage.pageId,
      pageNumber: 1,
      requestAttemptId: ownedPage.requestAttemptId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 0n,
      supervisorEpochId: supervisor.epochId,
      supervisorOwnerKey: supervisor.ownerKey,
      supervisorLeaseToken: supervisor.leaseToken,
      runLeaseOwner: supervisor.ownerKey,
      runLeaseToken: input.runLeaseToken,
      committedAt: input.committedAt,
    });
    return ownedPage;
  });
  await database.import_runs.update({
    where: { id: run.id },
    data: { state: "succeeded", finished_at: input.committedAt },
  });
  return { runId: run.id, pageId: page.pageId };
}

test("A to B to A cursor cycles remain rejected after the database client restarts", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "cursor-cycle-restart",
  );
  try {
    const source = await createAcceptanceProviderSource(
      fixture,
      courtyardDefinition,
    );
    const now = await databaseClock(fixture.database);
    await activateAcceptanceRuntime(fixture.database, fixture, source, now);
    const supervisorOwner = "cursor-cycle-worker";
    const supervisorLeaseToken = "74000000-0000-4000-8000-000000000001";
    const supervisorRepository = new ProviderSourceSupervisorRepository(
      fixture.database,
    );
    const epoch = await supervisorRepository.acquire({
      environmentKey: "cursor-cycle-restart",
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      now,
    });
    const supervisor: SupervisorProof = {
      epochId: epoch.epochId,
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      leaseExpiresAt: epoch.leaseExpiresAt,
    };

    await commitCursor(fixture.database, fixture, source, supervisor, {
      requestedCursor: null,
      requestedFingerprint: null,
      nextCursor: cursorA,
      nextFingerprint: fingerprintA,
      runLeaseToken: "74000000-0000-4000-8000-000000000002",
      committedAt: await databaseClock(fixture.database),
    });
    await commitCursor(fixture.database, fixture, source, supervisor, {
      requestedCursor: cursorA,
      requestedFingerprint: fingerprintA,
      nextCursor: cursorB,
      nextFingerprint: fingerprintB,
      runLeaseToken: "74000000-0000-4000-8000-000000000003",
      committedAt: await databaseClock(fixture.database),
    });

    await fixture.database.$disconnect();
    const reopened = await fixture.createIndependentClient();
    const renewedLeaseExpiresAt = await new ProviderSourceSupervisorRepository(
      reopened,
    ).renew({
      epochId: supervisor.epochId,
      ownerKey: supervisor.ownerKey,
      leaseToken: supervisor.leaseToken,
      now: await databaseClock(reopened),
    });
    const renewedSupervisor: SupervisorProof = {
      ...supervisor,
      leaseExpiresAt: renewedLeaseExpiresAt,
    };
    const repeatedRun = await createPinnedSourceRun(reopened, fixture, source, {
      state: "running",
      trigger: "continuation",
      createdAt: await databaseClock(reopened),
      requestedCursor: cursorB,
      requestedCursorFingerprint: fingerprintB,
      leaseOwner: renewedSupervisor.ownerKey,
      leaseToken: "74000000-0000-4000-8000-000000000004",
      leaseExpiresAt: renewedSupervisor.leaseExpiresAt,
    });
    const repeatedAt = await databaseClock(reopened);
    const repository = new ProviderSourceCursorRepository(reopened);
    await assert.rejects(
      reopened.$transaction(async (transaction) => {
        const page = await createOwnedPage(
          transaction,
          fixture,
          source,
          renewedSupervisor,
          {
            requestedCursor: cursorB,
            requestedFingerprint: fingerprintB,
            nextCursor: cursorA,
            nextFingerprint: fingerprintA,
            runLeaseToken: "74000000-0000-4000-8000-000000000004",
            committedAt: repeatedAt,
          },
          repeatedRun.id,
        );
        await repository.advanceInTransaction(transaction, {
          organizationId: fixture.organizationId,
          providerId: source.providerId,
          sourceInstanceId: source.sourceInstanceId,
          sourceRevisionId: source.sourceRevisionId,
          sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
          cursorCodecVersion: ACCEPTANCE_CURSOR_CODEC_VERSION,
          cursorGeneration: 1n,
          expectedCursorFingerprint: fingerprintB,
          nextCursor: cursorA,
          nextCursorFingerprint: fingerprintA,
          continuation: { kind: "continue" },
          runId: repeatedRun.id,
          pageId: page.pageId,
          pageNumber: 1,
          requestAttemptId: page.requestAttemptId,
          connectionProfileId: fixture.connectionProfileId,
          connectionRevisionId: fixture.connectionRevisionId,
          expectedHealthGeneration: 0n,
          supervisorEpochId: renewedSupervisor.epochId,
          supervisorOwnerKey: renewedSupervisor.ownerKey,
          supervisorLeaseToken: renewedSupervisor.leaseToken,
          runLeaseOwner: renewedSupervisor.ownerKey,
          runLeaseToken: "74000000-0000-4000-8000-000000000004",
          committedAt: repeatedAt,
        });
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "CURSOR_CYCLE_DETECTED",
    );

    const cursor =
      await reopened.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      });
    assert.equal(cursor.cursor_fingerprint, fingerprintB);
    assert.deepEqual(
      (
        await reopened.provider_source_cursor_fingerprints.findMany({
          where: { source_instance_id: source.sourceInstanceId },
          orderBy: { committed_at: "asc" },
        })
      ).map(({ cursor_fingerprint: fingerprint }) => fingerprint),
      [fingerprintA, fingerprintB],
    );
    assert.equal(
      await reopened.import_pages.count({ where: { run_id: repeatedRun.id } }),
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("poll_after commits a null cursor with exact provenance and resumes from the initial cursor", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "null-cursor-poll-after",
  );
  try {
    const source = await createAcceptanceProviderSource(
      fixture,
      courtyardDefinition,
    );
    const now = await databaseClock(fixture.database);
    await activateAcceptanceRuntime(fixture.database, fixture, source, now);
    await assert.rejects(
      fixture.database.provider_source_cursors.update({
        where: { source_instance_id: source.sourceInstanceId },
        data: {
          cursor: cursorA,
          cursor_fingerprint: fingerprintA,
        },
      }),
      /provider_source_cursors_page_run_check|check constraint/i,
    );
    const supervisorOwner = "null-cursor-poll-after-worker";
    const supervisorLeaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(
      fixture.database,
    ).acquire({
      environmentKey: "null-cursor-poll-after",
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      now,
    });
    const supervisor: SupervisorProof = {
      epochId: epoch.epochId,
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      leaseExpiresAt: epoch.leaseExpiresAt,
    };
    const committedAt = await databaseClock(fixture.database);
    const runLeaseToken = randomUUID();
    const run = await createPinnedSourceRun(
      fixture.database,
      fixture,
      source,
      {
        state: "running",
        trigger: "scheduled",
        createdAt: committedAt,
        requestedCursor: null,
        requestedCursorFingerprint: null,
        leaseOwner: supervisor.ownerKey,
        leaseToken: runLeaseToken,
        leaseExpiresAt: supervisor.leaseExpiresAt,
      },
    );
    const repository = new ProviderSourceCursorRepository(fixture.database);
    const page = await fixture.database.$transaction(async (transaction) => {
      const ownedPage = await createOwnedPage(
        transaction,
        fixture,
        source,
        supervisor,
        {
          requestedCursor: null,
          requestedFingerprint: null,
          nextCursor: null,
          nextFingerprint: null,
          continuation: {
            kind: "poll_after",
            minimumDelaySeconds: 90,
          },
          runLeaseToken,
          committedAt,
        },
        run.id,
      );
      const advanced = await repository.advanceInTransaction(transaction, {
        organizationId: fixture.organizationId,
        providerId: source.providerId,
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
        cursorCodecVersion: ACCEPTANCE_CURSOR_CODEC_VERSION,
        cursorGeneration: 1n,
        expectedCursorFingerprint: null,
        nextCursor: null,
        nextCursorFingerprint: null,
        continuation: { kind: "poll_after", minimumDelaySeconds: 90 },
        runId: run.id,
        pageId: ownedPage.pageId,
        pageNumber: 1,
        requestAttemptId: ownedPage.requestAttemptId,
        connectionProfileId: fixture.connectionProfileId,
        connectionRevisionId: fixture.connectionRevisionId,
        expectedHealthGeneration: 0n,
        supervisorEpochId: supervisor.epochId,
        supervisorOwnerKey: supervisor.ownerKey,
        supervisorLeaseToken: supervisor.leaseToken,
        runLeaseOwner: supervisor.ownerKey,
        runLeaseToken,
        committedAt,
      });
      assert.equal(advanced.fingerprint, null);
      return ownedPage;
    });

    const [savedCursor, committedPage, advancedRun, historyCount] =
      await Promise.all([
        fixture.database.provider_source_cursors.findUniqueOrThrow({
          where: { source_instance_id: source.sourceInstanceId },
        }),
        fixture.database.import_pages.findUniqueOrThrow({
          where: { id: page.pageId },
        }),
        fixture.database.import_runs.findUniqueOrThrow({
          where: { id: run.id },
        }),
        fixture.database.provider_source_cursor_fingerprints.count({
          where: { source_instance_id: source.sourceInstanceId },
        }),
      ]);
    assert.equal(savedCursor.cursor, null);
    assert.equal(savedCursor.cursor_fingerprint, null);
    assert.equal(savedCursor.advanced_by_run_id, run.id);
    assert.equal(savedCursor.advanced_by_page_id, page.pageId);
    assert.equal(committedPage.next_cursor, null);
    assert.equal(committedPage.next_cursor_fingerprint, null);
    assert.equal(committedPage.continuation_kind, "poll_after");
    assert.equal(committedPage.minimum_delay_seconds, 90);
    assert.equal(advancedRun.current_cursor, null);
    assert.equal(advancedRun.current_cursor_fingerprint, null);
    assert.equal(advancedRun.current_cursor_key, "initial");
    assert.equal(advancedRun.next_page_number, 2);
    assert.equal(historyCount, 0);

    await assert.rejects(
      fixture.database.provider_source_cursors.update({
        where: { source_instance_id: source.sourceInstanceId },
        data: { cursor: "cursor-without-a-fingerprint" },
      }),
      /provider_source_cursors_envelope_check|check constraint/i,
    );
    await assert.rejects(
      fixture.database.provider_source_cursors.update({
        where: { source_instance_id: source.sourceInstanceId },
        data: { advanced_by_page_id: randomUUID() },
      }),
      /provider_source_cursors_page_fk|foreign key/i,
    );

    await fixture.database.import_runs.update({
      where: { id: run.id },
      data: {
        state: "succeeded",
        reached_provider_head: true,
        finished_at: committedAt,
      },
    });
    const resumed = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "scheduled",
      requestedByActorKey: null,
      requestedAt: await databaseClock(fixture.database),
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    assert.equal(resumed.kind, "created");
    if (resumed.kind !== "created") {
      throw new Error("Expected a scheduled run to resume from the null cursor.");
    }
    const resumedRun = await fixture.database.import_runs.findUniqueOrThrow({
      where: { id: resumed.run.id },
    });
    assert.equal(resumedRun.requested_cursor, null);
    assert.equal(resumedRun.requested_cursor_fingerprint, null);
    assert.equal(resumedRun.requested_cursor_key, "initial");
    assert.equal(resumedRun.current_cursor, null);
    assert.equal(resumedRun.current_cursor_fingerprint, null);
    assert.equal(resumedRun.current_cursor_key, "initial");
    assert.equal(resumedRun.next_page_number, 1);
  } finally {
    await fixture.close();
  }
});

test("source-owned cursor pins and page-read shape reject malformed nulls", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "cursor-null-pin-guards",
  );
  try {
    const source = await createAcceptanceProviderSource(
      fixture,
      courtyardDefinition,
    );
    const now = await databaseClock(fixture.database);
    await activateAcceptanceRuntime(fixture.database, fixture, source, now);
    const supervisorOwner = "cursor-null-pin-guards-worker";
    const supervisorLeaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(
      fixture.database,
    ).acquire({
      environmentKey: "cursor-null-pin-guards",
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      now,
    });
    const runLeaseToken = randomUUID();
    const run = await createPinnedSourceRun(
      fixture.database,
      fixture,
      source,
      {
        state: "running",
        trigger: "scheduled",
        createdAt: now,
        requestedCursor: null,
        requestedCursorFingerprint: null,
        leaseOwner: supervisorOwner,
        leaseToken: runLeaseToken,
        leaseExpiresAt: epoch.leaseExpiresAt,
      },
    );
    const malformedRunBase = {
      organization_id: fixture.organizationId,
      provider_id: source.providerId,
      config_revision_id: null,
      trigger: "scheduled" as const,
      state: "succeeded" as const,
      started_at: now,
      finished_at: now,
      created_at: now,
      source_instance_id: source.sourceInstanceId,
      source_revision_id: source.sourceRevisionId,
      source_type_key: ACCEPTANCE_SOURCE_TYPE_KEY,
      source_adapter_version: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      normalized_contract_version: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
      mapper_key: source.mapperKey,
      mapper_version: "1",
      identity_namespace_key: source.identityNamespaceKey,
      connection_profile_id: fixture.connectionProfileId,
      connection_revision_id: fixture.connectionRevisionId,
      cursor_codec_version: ACCEPTANCE_CURSOR_CODEC_VERSION,
      cursor_generation: 1n,
      requested_cursor: null,
      requested_cursor_fingerprint: null,
      requested_cursor_key: "initial",
      current_cursor: null,
      current_cursor_fingerprint: null,
      current_cursor_key: "initial",
      next_page_number: 1,
    };
    const nullableRunPins = [
      "source_type_key",
      "source_adapter_version",
      "normalized_contract_version",
      "mapper_key",
      "mapper_version",
      "identity_namespace_key",
      "cursor_codec_version",
      "cursor_generation",
      "requested_cursor_key",
    ] as const;
    for (const pin of nullableRunPins) {
      await assert.rejects(
        fixture.database.import_runs.create({
          data: {
            ...malformedRunBase,
            id: randomUUID(),
            [pin]: null,
          },
        }),
        /import_runs_source_pins_check|check constraint/i,
      );
    }
    await assert.rejects(
      fixture.database.import_runs.update({
        where: { id: run.id },
        data: { current_cursor_key: null },
      }),
      /import_runs_exactly_one_runtime_owner_check|check constraint/i,
    );

    const pageReadAttempt = {
      organization_id: fixture.organizationId,
      operation_kind: "page_read" as const,
      request_lease_id: randomUUID(),
      claim_owner: supervisorOwner,
      claim_token: runLeaseToken,
      supervisor_epoch_id: epoch.epochId,
      connection_profile_id: fixture.connectionProfileId,
      connection_revision_id: fixture.connectionRevisionId,
      expected_health_generation: 0n,
      provider_id: source.providerId,
      source_instance_id: source.sourceInstanceId,
      source_revision_id: source.sourceRevisionId,
      run_id: run.id,
      page_number: 1,
      cursor_generation: 1n,
      requested_cursor_fingerprint: null,
      requested_cursor_key: null,
      started_at: now,
    };
    await assert.rejects(
      fixture.database.source_request_attempts.create({
        data: {
          id: randomUUID(),
          state: "in_flight",
          ...pageReadAttempt,
        },
      }),
      /source_request_attempts_scope_check|check constraint/i,
    );
    await assert.rejects(
      fixture.database.compact_source_request_attempts.create({
        data: {
          request_attempt_id: randomUUID(),
          terminal_state: "captured",
          outcome_class: "response_captured",
          safe_outcome_hash: "6".repeat(64),
          terminal_at: now,
          ...pageReadAttempt,
        },
      }),
      /compact_source_request_attempts_scope_check|check constraint/i,
    );

    const supervisor: SupervisorProof = {
      epochId: epoch.epochId,
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      leaseExpiresAt: epoch.leaseExpiresAt,
    };
    const ownedPage = await fixture.database.$transaction((transaction) =>
      createOwnedPage(
        transaction,
        fixture,
        source,
        supervisor,
        {
          requestedCursor: null,
          requestedFingerprint: null,
          nextCursor: cursorA,
          nextFingerprint: fingerprintA,
          runLeaseToken,
          committedAt: now,
        },
        run.id,
      ),
    );
    const nullablePagePins = [
      "source_type_key",
      "source_adapter_version",
      "normalized_contract_version",
      "mapper_key",
      "mapper_version",
      "identity_namespace_key",
      "connection_health_generation",
      "cursor_codec_version",
      "cursor_generation",
      "requested_cursor_key",
    ] as const;
    for (const pin of nullablePagePins) {
      await assert.rejects(
        fixture.database.import_pages.update({
          where: { id: ownedPage.pageId },
          data: { [pin]: null },
        }),
        /import_pages_source_pins_check|check constraint/i,
      );
    }
    await assert.rejects(
      fixture.database.import_pages.update({
        where: { id: ownedPage.pageId },
        data: { continuation_kind: null },
      }),
      /import_pages_source_continuation_check|check constraint/i,
    );
    await assert.rejects(
      fixture.database.import_pages.update({
        where: { id: ownedPage.pageId },
        data: {
          continuation_kind: "poll_after",
          minimum_delay_seconds: null,
        },
      }),
      /import_pages_source_continuation_check|check constraint/i,
    );
  } finally {
    await fixture.close();
  }
});

test("source cursors above the legacy bound commit and seed the next run while legacy cursors remain bounded", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "cursor-storage-bounds",
  );
  try {
    const source = await createAcceptanceProviderSource(
      fixture,
      courtyardDefinition,
    );
    const now = await databaseClock(fixture.database);
    await activateAcceptanceRuntime(fixture.database, fixture, source, now);
    const supervisorOwner = "cursor-storage-bounds-worker";
    const supervisorLeaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(
      fixture.database,
    ).acquire({
      environmentKey: "cursor-storage-bounds",
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      now,
    });
    const supervisor: SupervisorProof = {
      epochId: epoch.epochId,
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      leaseExpiresAt: epoch.leaseExpiresAt,
    };
    const sourceCursor = "s".repeat(4_096);
    const sourceCursorFingerprint = "9".repeat(64);
    const committed = await commitCursor(
      fixture.database,
      fixture,
      source,
      supervisor,
      {
        requestedCursor: null,
        requestedFingerprint: null,
        nextCursor: sourceCursor,
        nextFingerprint: sourceCursorFingerprint,
        runLeaseToken: randomUUID(),
        committedAt: await databaseClock(fixture.database),
      },
    );

    const [savedCursor, committedPage] = await Promise.all([
      fixture.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
      fixture.database.import_pages.findUniqueOrThrow({
        where: { id: committed.pageId },
      }),
    ]);
    assert.equal(savedCursor.cursor, sourceCursor);
    assert.equal(savedCursor.cursor_fingerprint, sourceCursorFingerprint);
    assert.equal(committedPage.next_cursor, sourceCursor);

    const nextRun = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "continuation",
      requestedByActorKey: null,
      requestedAt: await databaseClock(fixture.database),
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    assert.equal(nextRun.kind, "created");
    if (nextRun.kind !== "created") {
      throw new Error("Expected the committed source cursor to seed a continuation run.");
    }
    const resumed = await fixture.database.import_runs.findUniqueOrThrow({
      where: { id: nextRun.run.id },
    });
    assert.equal(resumed.requested_cursor, sourceCursor);
    assert.equal(resumed.current_cursor, sourceCursor);
    assert.equal(
      resumed.requested_cursor_fingerprint,
      sourceCursorFingerprint,
    );

    const oversizedLegacyCursor = "l".repeat(2_049);
    await assert.rejects(
      fixture.database.import_runs.create({
        data: {
          organization_id: fixture.organizationId,
          provider_id: source.providerId,
          config_revision_id: source.configRevisionId,
          trigger: "scheduled",
          state: "succeeded",
          requested_cursor: oversizedLegacyCursor,
          started_at: now,
          finished_at: now,
          created_at: now,
        },
      }),
      /import_runs_requested_cursor_bounded|check constraint/i,
    );

    const legacyRun = await fixture.database.import_runs.create({
      data: {
        organization_id: fixture.organizationId,
        provider_id: source.providerId,
        config_revision_id: source.configRevisionId,
        trigger: "scheduled",
        state: "succeeded",
        started_at: now,
        finished_at: now,
        created_at: now,
      },
    });
    await assert.rejects(
      fixture.database.import_pages.create({
        data: {
          organization_id: fixture.organizationId,
          provider_id: source.providerId,
          run_id: legacyRun.id,
          page_number: 1,
          requested_cursor: null,
          next_cursor: oversizedLegacyCursor,
          has_more: true,
          payload_json: {},
          payload_hash: "a".repeat(64),
          record_counts_json: {},
          committed_at: now,
          expires_at: new Date(now.getTime() + 86_400_000),
        },
      }),
      /import_pages_cursors_bounded|check constraint/i,
    );
  } finally {
    await fixture.close();
  }
});
