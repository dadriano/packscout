import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, isNull, sql, type Logger } from "drizzle-orm";
import type { PgliteQueryResultHKT } from "drizzle-orm/pglite";
import {
  DrizzleAuthAuditSink,
  DrizzleAuthRepository,
} from "./auth-repository.ts";
import {
  IngestionPersistenceRepository,
  RetentionRepository,
} from "./ingestion-repository.ts";
import { PersistenceError } from "./persistence-error.ts";
import type { CommitPageInput } from "./pipeline-types.ts";
import { ProtectedEvidenceRepository } from "./protected-evidence.ts";
import {
  auditEvents,
  canonicalEntities,
  canonicalRelationships,
  canonicalRevisions,
  importPages,
  importRuns,
  operatorSessions,
  providerCursorCheckpoints,
  providerSources,
  quarantineRecords,
  sourceRecordObservations,
  sourceRecordOutcomes,
  sourceRecordProjectionRevisions,
  sourceRecords,
} from "./schema/index.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const ids = {
  organization: "00000000-0000-4000-8000-000000000001",
  otherOrganization: "00000000-0000-4000-8000-000000000002",
  provider: "00000000-0000-4000-8000-000000000010",
  configuration: "00000000-0000-4000-8000-000000000020",
  secondConfiguration: "00000000-0000-4000-8000-000000000021",
  run: "00000000-0000-4000-8000-000000000030",
  secondRun: "00000000-0000-4000-8000-000000000031",
  thirdRun: "00000000-0000-4000-8000-000000000032",
  operator: "00000000-0000-4000-8000-000000000040",
  secondOperator: "00000000-0000-4000-8000-000000000041",
  session: "00000000-0000-4000-8000-000000000050",
} as const;

const committedAt = new Date("2026-01-01T00:00:00.000Z");
const collectedAt = new Date("2025-12-31T23:59:00.000Z");
const sourceTime = new Date("2025-12-31T23:58:00.000Z");

class QueryCounter implements Logger {
  queryCount = 0;

  logQuery(): void {
    this.queryCount += 1;
  }

  reset(): void {
    this.queryCount = 0;
  }
}

async function createPipelineHarness(options: { logger?: Logger } = {}) {
  const harness = await createMigratedTestDatabase(options);
  const setup = new PipelineSetupRepository(harness.database);
  await setup.createOrganization({
    id: ids.organization,
    slug: "packscout",
    name: "PackScout",
    createdAt: committedAt,
  });
  await setup.createOrganization({
    id: ids.otherOrganization,
    slug: "other",
    name: "Other Organization",
    createdAt: committedAt,
  });
  await setup.createProviderSource({
    id: ids.provider,
    organizationId: ids.organization,
    platformKey: "beezie",
    displayName: "Beezie",
    createdAt: committedAt,
  });
  await setup.createConfigRevision({
    id: ids.configuration,
    organizationId: ids.organization,
    providerId: ids.provider,
    version: 1,
    adapterKey: "http-cursor-v1",
    endpointUrl: "https://provider.example/feed",
    authMode: "none",
    createdByActorKey: "operator:admin",
    createdAt: committedAt,
  });
  await setup.recordSuccessfulConnectionTest({
    organizationId: ids.organization,
    providerId: ids.provider,
    revisionId: ids.configuration,
    actorKey: "operator:admin",
    testedAt: committedAt,
    latencyMs: 25,
  });
  await setup.activateConfiguration({
    organizationId: ids.organization,
    providerId: ids.provider,
    revisionId: ids.configuration,
    actorKey: "operator:admin",
    activatedAt: committedAt,
    nextRunAt: committedAt,
  });
  await setup.createImportRun({
    id: ids.run,
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    trigger: "manual",
    requestedByActorKey: "operator:admin",
    state: "succeeded",
    createdAt: committedAt,
  });
  return {
    ...harness,
    setup,
    ingestion: new IngestionPersistenceRepository(harness.database, {
      retentionDays: 90,
      actorPseudonymKey: "test-pseudonym-key",
    }),
  };
}

function initialPage(overrides: Partial<CommitPageInput> = {}): CommitPageInput {
  const payload = {
    catalog: [{ external_id: "catalog-envelope", data: { username: "public-user" } }],
    pulls: [{ external_id: "pull-1", data: { wallet_address: "0xraw-wallet" } }],
    sales: [],
    next_cursor: "cursor-1",
    has_more: true,
  };
  return {
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    runId: ids.run,
    pageNumber: 1,
    requestedCursor: null,
    nextCursor: "cursor-1",
    hasMore: true,
    payload,
    committedAt,
    records: [
      {
        recordKind: "catalog",
        externalId: "catalog-envelope",
        sourceTime,
        collectedAt,
        payload: payload.catalog[0]!,
        projections: [
          {
            platformKey: "beezie",
            recordKind: "pack",
            externalId: "pack-standard",
            content: { name: "Standard Pack", priceCents: 2500 },
            sourceUpdatedAt: sourceTime,
            sourceCollectedAt: collectedAt,
          },
          {
            platformKey: "beezie",
            recordKind: "pack",
            externalId: "pack-premium",
            content: { name: "Premium Pack", priceCents: 5000 },
            sourceUpdatedAt: sourceTime,
            sourceCollectedAt: collectedAt,
          },
        ],
      },
      {
        recordKind: "pull",
        externalId: "pull-1",
        sourceTime,
        collectedAt,
        payload: payload.pulls[0]!,
        projections: [
          {
            platformKey: "beezie",
            recordKind: "pull",
            externalId: "pull-1",
            content: { cardExternalId: "card-1" },
            sourceUpdatedAt: sourceTime,
            sourceCollectedAt: collectedAt,
            sourceActorIdentifier: "0xraw-wallet",
            relationships: [
              {
                relationshipKind: "opened_from_pack",
                targetPlatformKey: "beezie",
                targetRecordKind: "pack",
                targetExternalId: "pack-arrives-later",
              },
            ],
          },
        ],
      },
    ],
    quarantines: [
      {
        recordKind: "sale",
        recordIndex: 0,
        externalId: null,
        reasonCode: "MISSING_EXTERNAL_ID",
        fieldPath: "sales[0].external_id",
        sanitizedSummary: "A sale record is missing its identity.",
        payload: { wallet_address: "0xquarantine-only" },
      },
    ],
    ...overrides,
  };
}

async function addRun(
  setup: PipelineSetupRepository<PgliteQueryResultHKT>,
  runId: string,
): Promise<void> {
  await setup.createImportRun({
    id: runId,
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    trigger: "recovery",
    state: "succeeded",
    createdAt: new Date(committedAt.getTime() + 1_000),
  });
}

test("empty migration builds PostgreSQL constraints including NULL cursor idempotency", async () => {
  const harness = await createPipelineHarness();
  try {
    await harness.ingestion.commitPage(initialPage());
    await assert.rejects(
      harness.ingestion.commitPage(
        initialPage({
          pageNumber: 2,
          payload: { different: true },
          nextCursor: "cursor-2",
        }),
      ),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "IDEMPOTENCY_CONFLICT",
    );
    const [count] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(importPages)
      .where(eq(importPages.runId, ids.run));
    assert.equal(count?.count, 1);
  } finally {
    await harness.close();
  }
});

test("production page commits reject a worker without the active run lease", async () => {
  const harness = await createPipelineHarness();
  try {
    await assert.rejects(
      harness.ingestion.commitPage(initialPage({ workerId: "foreign-worker" })),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "RUN_OWNERSHIP_LOST",
    );
    assert.equal((await harness.database.select().from(importPages)).length, 0);
  } finally {
    await harness.close();
  }
});

test("unchanged replay is a no-op while changed content advances one current revision", async () => {
  const harness = await createPipelineHarness();
  try {
    const first = await harness.ingestion.commitPage(initialPage());
    assert.equal(first.newCanonicalRevisions, 3);
    await addRun(harness.setup, ids.secondRun);
    const replay = await harness.ingestion.commitPage(
      initialPage({ runId: ids.secondRun, committedAt: new Date(committedAt.getTime() + 1_000) }),
    );
    assert.equal(replay.newCanonicalRevisions, 0);
    assert.equal(replay.duplicateSourceRecords, 2);

    await addRun(harness.setup, ids.thirdRun);
    const changed = initialPage({
      runId: ids.thirdRun,
      committedAt: new Date(committedAt.getTime() + 2_000),
    });
    const firstRecord = changed.records[0]!;
    changed.records = [
      {
        ...firstRecord,
        payload: { ...firstRecord.payload, data: { release: 2 } },
        projections: [
          {
            ...firstRecord.projections[0]!,
            content: { name: "Standard Pack", priceCents: 3000 },
          },
          firstRecord.projections[1]!,
        ],
      },
    ];
    changed.payload = { ...changed.payload as object, release: 2 };
    const changedResult = await harness.ingestion.commitPage(changed);
    assert.equal(changedResult.newCanonicalRevisions, 2);
    const revisions = await harness.ingestion.listCanonicalRevisions(ids.organization, {
      platformKey: "beezie",
      recordKind: "pack",
      externalId: "pack-standard",
    });
    assert.equal(revisions.length, 2);
    assert.deepEqual(revisions.map((revision) => revision.revisionNumber), [1, 2]);
    const current = await harness.ingestion.getCurrentProjection(ids.organization, {
      platformKey: "beezie",
      recordKind: "pack",
      externalId: "pack-standard",
    });
    assert.equal(current?.content.priceCents, 3000);

    const [projectionLinks] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(sourceRecordProjectionRevisions);
    assert.ok((projectionLinks?.count ?? 0) >= 4);
  } finally {
    await harness.close();
  }
});

test("large page commits batch writes while preserving evidence, projections, and record counts", async () => {
  const queryCounter = new QueryCounter();
  const harness = await createPipelineHarness({ logger: queryCounter });
  try {
    const recordCount = 550;
    const records: CommitPageInput["records"] = Array.from(
      { length: recordCount },
      (_, index) => ({
        recordKind: "catalog" as const,
        externalId: `large-source-${index}`,
        sourceTime,
        collectedAt,
        payload: { id: `large-source-${index}`, value: index },
        projections: [
          {
            platformKey: "beezie",
            recordKind: "catalog_asset" as const,
            externalId: `large-asset-${index}`,
            content: { name: `Asset ${index}` },
            sourceUpdatedAt: sourceTime,
            sourceCollectedAt: collectedAt,
            relationships: [
              {
                relationshipKind: "belongs_to_platform",
                targetPlatformKey: "beezie",
                targetRecordKind: "platform" as const,
                targetExternalId: "beezie-platform",
              },
            ],
          },
        ],
        ...(index === recordCount - 1
          ? {
              quarantine: {
                reasonCode: "INVALID_CATALOG_RECORD",
                fieldPath: `catalog[${index}]`,
                sanitizedSummary: "The catalog record failed validation.",
              },
            }
          : {}),
      }),
    );
    const page = initialPage({
      payload: { kind: "large-page", recordCount },
      records,
      quarantines: [
        {
          recordKind: "pull",
          recordIndex: recordCount,
          externalId: null,
          reasonCode: "INVALID_PULL_RECORD",
          sanitizedSummary: "The pull record failed envelope validation.",
          payload: { invalid: "pull" },
        },
        {
          recordKind: "sale",
          recordIndex: recordCount + 1,
          externalId: null,
          reasonCode: "INVALID_SALE_RECORD",
          sanitizedSummary: "The sale record failed envelope validation.",
          payload: { invalid: "sale" },
        },
      ],
    });

    queryCounter.reset();
    const committed = await harness.ingestion.commitPage(page);
    assert.equal(committed.newCanonicalRevisions, recordCount - 1);
    assert.deepEqual(committed.counters, {
      accepted: recordCount - 1,
      duplicate: 0,
      quarantined: 3,
      pages: 1,
      records: recordCount + 2,
      requestAttempts: 0,
      transientRetries: 0,
    });
    assert.ok(
      queryCounter.queryCount < 80,
      `large page commit issued ${queryCounter.queryCount} SQL statements`,
    );

    const [storedPage] = await harness.database
      .select({ recordCounts: importPages.recordCountsJson })
      .from(importPages)
      .where(eq(importPages.id, committed.pageId));
    assert.deepEqual(storedPage?.recordCounts, {
      catalog: recordCount,
      pulls: 1,
      sales: 1,
    });
    const [sourceCount] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(sourceRecords);
    const [observationCount] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(sourceRecordObservations);
    const [outcomeCount] = await harness.database
      .select({
        count: sql<number>`count(*)::integer`,
        linked: sql<number>`count(*) filter (where ${sourceRecordOutcomes.sourceRecordId} is not null)::integer`,
        standalone: sql<number>`count(*) filter (where ${sourceRecordOutcomes.sourceRecordId} is null)::integer`,
      })
      .from(sourceRecordOutcomes);
    const [quarantineCount] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(quarantineRecords);
    const [revisionCount] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(canonicalRevisions);
    const [projectionLinkCount] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(sourceRecordProjectionRevisions);
    const [relationshipCount] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(canonicalRelationships);
    assert.equal(sourceCount?.count, recordCount);
    assert.equal(observationCount?.count, recordCount);
    assert.equal(outcomeCount?.count, recordCount + 2);
    assert.equal(outcomeCount?.linked, recordCount);
    assert.equal(outcomeCount?.standalone, 2);
    assert.equal(quarantineCount?.count, 3);
    assert.equal(revisionCount?.count, recordCount - 1);
    assert.equal(projectionLinkCount?.count, recordCount - 1);
    assert.equal(relationshipCount?.count, recordCount - 1);

    await addRun(harness.setup, ids.secondRun);
    const replay = await harness.ingestion.commitPage({
      ...page,
      runId: ids.secondRun,
      committedAt: new Date(committedAt.getTime() + 1_000),
    });
    assert.equal(replay.newCanonicalRevisions, 0);
    assert.equal(replay.duplicateSourceRecords, recordCount - 1);
    assert.deepEqual(replay.counters, {
      accepted: 0,
      duplicate: recordCount - 1,
      quarantined: 3,
      pages: 1,
      records: recordCount + 2,
      requestAttempts: 0,
      transientRetries: 0,
    });
    const [sourcesAfterReplay] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(sourceRecords);
    const [revisionsAfterReplay] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(canonicalRevisions);
    const [observationsAfterReplay] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(sourceRecordObservations);
    assert.equal(sourcesAfterReplay?.count, recordCount);
    assert.equal(revisionsAfterReplay?.count, recordCount - 1);
    assert.equal(observationsAfterReplay?.count, recordCount * 2);
  } finally {
    await harness.close();
  }
});

test("unresolved pull relationships persist and reconcile when a pack arrives", async () => {
  const harness = await createPipelineHarness();
  try {
    await harness.ingestion.commitPage(initialPage());
    const [unresolved] = await harness.database
      .select({ id: canonicalRelationships.id, targetId: canonicalRelationships.targetEntityId })
      .from(canonicalRelationships)
      .where(eq(canonicalRelationships.targetExternalId, "pack-arrives-later"));
    assert.ok(unresolved);
    assert.equal(unresolved.targetId, null);

    await addRun(harness.setup, ids.secondRun);
    const packPage = initialPage({
      runId: ids.secondRun,
      committedAt: new Date(committedAt.getTime() + 1_000),
      payload: { catalog: [{ id: "pack-arrives-later" }] },
      records: [
        {
          recordKind: "catalog",
          externalId: "late-pack-source",
          sourceTime,
          collectedAt,
          payload: { id: "pack-arrives-later" },
          projections: [
            {
              platformKey: "beezie",
              recordKind: "pack",
              externalId: "pack-arrives-later",
              content: { name: "Late Pack" },
              sourceUpdatedAt: sourceTime,
              sourceCollectedAt: collectedAt,
            },
          ],
        },
      ],
      quarantines: [],
    });
    await harness.ingestion.commitPage(packPage);
    const [linked] = await harness.database
      .select({ targetId: canonicalRelationships.targetEntityId })
      .from(canonicalRelationships)
      .where(eq(canonicalRelationships.id, unresolved.id));
    assert.ok(linked?.targetId);
    const reconciled = await harness.ingestion.reconcileRelationships({
      organizationId: ids.organization,
      target: {
        platformKey: "beezie",
        recordKind: "pack",
        externalId: "pack-arrives-later",
      },
      resolvedAt: new Date(committedAt.getTime() + 2_000),
    });
    assert.equal(reconciled, 0);
  } finally {
    await harness.close();
  }
});

test("actor PII stays in protected evidence and unsafe canonical writes roll back atomically", async () => {
  const harness = await createPipelineHarness();
  try {
    const committed = await harness.ingestion.commitPage(initialPage());
    const pull = await harness.ingestion.getCurrentProjection(ids.organization, {
      platformKey: "beezie",
      recordKind: "pull",
      externalId: "pull-1",
    });
    assert.match(pull?.actorKey ?? "", /^actor:v1:[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(pull), /public-user|0xraw-wallet/);
    assert.equal(
      await harness.ingestion.getCurrentProjection(ids.otherOrganization, {
        platformKey: "beezie",
        recordKind: "pull",
        externalId: "pull-1",
      }),
      null,
    );

    const protectedEvidence = new ProtectedEvidenceRepository(harness.database);
    assert.equal(
      await protectedEvidence.getRawPage(
        {
          organizationId: ids.otherOrganization,
          actorKey: "operator:other",
          purpose: "provider_debug",
        },
        committed.pageId,
        committedAt,
      ),
      null,
    );
    const raw = await protectedEvidence.getRawPage(
      {
        organizationId: ids.organization,
        actorKey: "operator:admin",
        purpose: "provider_debug",
      },
      committed.pageId,
      committedAt,
    );
    assert.match(JSON.stringify(raw?.payload), /0xraw-wallet/);

    const bad = initialPage({
      pageNumber: 2,
      requestedCursor: "cursor-1",
      nextCursor: "cursor-2",
      payload: { bad: true },
      records: [
        {
          ...initialPage().records[0]!,
          externalId: "unsafe-source",
          payload: { id: "unsafe-source" },
          projections: [
            {
              ...initialPage().records[0]!.projections[0]!,
              externalId: "unsafe-canonical",
              content: { wallet_address: "0xmust-not-persist" },
            },
          ],
        },
      ],
      quarantines: [],
    });
    await assert.rejects(
      harness.ingestion.commitPage(bad),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "UNSAFE_CANONICAL_ACTOR_DATA",
    );
    const [failedPage] = await harness.database
      .select({ id: importPages.id })
      .from(importPages)
      .where(and(eq(importPages.runId, ids.run), eq(importPages.pageNumber, 2)));
    assert.equal(failedPage, undefined);
    const [checkpoint] = await harness.database
      .select({ cursor: providerCursorCheckpoints.cursor })
      .from(providerCursorCheckpoints)
      .where(eq(providerCursorCheckpoints.configRevisionId, ids.configuration));
    assert.equal(checkpoint?.cursor, "cursor-1");
    const [run] = await harness.database
      .select({ counters: importRuns.countersJson })
      .from(importRuns)
      .where(eq(importRuns.id, ids.run));
    assert.deepEqual(run?.counters, committed.counters);
  } finally {
    await harness.close();
  }
});

test("90-day retention clears payloads but preserves canonical, outcomes, runs, and audit", async () => {
  const harness = await createPipelineHarness();
  try {
    await harness.ingestion.commitPage(initialPage());
    const retention = new RetentionRepository(harness.database);
    const expired = await retention.expireRawEvidence({
      organizationId: ids.organization,
      before: new Date("2026-04-02T00:00:00.000Z"),
      expiredAt: new Date("2026-04-02T00:00:00.000Z"),
      batchSize: 100,
    });
    assert.deepEqual(expired, { pages: 1, sourceRecords: 2, quarantines: 1 });
    const [page] = await harness.database.select().from(importPages);
    const [source] = await harness.database.select().from(sourceRecords);
    const [quarantine] = await harness.database.select().from(quarantineRecords);
    assert.equal(page?.payloadJson, null);
    assert.equal(source?.payloadJson, null);
    assert.equal(quarantine?.payloadJson, null);
    assert.equal(quarantine?.reasonCode, "MISSING_EXTERNAL_ID");

    const [revisionCount] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(canonicalRevisions);
    const [outcomeCount] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(sourceRecordOutcomes);
    const [runCount] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(importRuns);
    const [auditCount] = await harness.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(auditEvents);
    assert.equal(revisionCount?.count, 3);
    assert.equal(outcomeCount?.count, 3);
    assert.equal(runCount?.count, 1);
    assert.ok((auditCount?.count ?? 0) >= 1);
  } finally {
    await harness.close();
  }
});

test("auth repository keeps last-admin checks tenant-scoped and revokes sessions atomically", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({ id: ids.organization, slug: "packscout", name: "PackScout" });
    await setup.createOrganization({ id: ids.otherOrganization, slug: "other", name: "Other" });
    const repository = new DrizzleAuthRepository(harness.database);
    const now = new Date("2026-08-06T12:00:00.000Z");
    assert.equal(
      (await repository.provisionOperator({
        id: ids.operator,
        organizationId: ids.organization,
        emailNormalized: "admin@packscout.test",
        displayName: "Primary Admin",
        passwordHash: "argon2id:hash",
        role: "admin",
        state: "active",
        now,
      })).kind,
      "created",
    );
    await repository.rotateSession({
      previousTokenHash: null,
      session: {
        id: ids.session,
        operatorId: ids.operator,
        tokenHash: "token-hash",
        csrfHash: "csrf-hash",
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt: new Date(now.getTime() + 60_000),
        absoluteExpiresAt: new Date(now.getTime() + 120_000),
      },
    });
    assert.equal(
      (await repository.updateOperator({
        organizationId: ids.organization,
        operatorId: ids.operator,
        role: "data_operator",
        now,
      })).kind,
      "last_active_admin",
    );
    assert.equal(
      (await repository.updateOperator({
        organizationId: ids.otherOrganization,
        operatorId: ids.operator,
        state: "disabled",
        now,
      })).kind,
      "not_found",
    );
    await repository.provisionOperator({
      id: ids.secondOperator,
      organizationId: ids.organization,
      emailNormalized: "second@packscout.test",
      displayName: "Second Admin",
      passwordHash: "argon2id:hash",
      role: "admin",
      state: "active",
      now,
    });
    assert.equal(
      (await repository.updateOperator({
        organizationId: ids.organization,
        operatorId: ids.operator,
        role: "data_operator",
        now: new Date(now.getTime() + 1_000),
      })).kind,
      "updated",
    );
    const [session] = await harness.database
      .select({ revokedAt: operatorSessions.revokedAt })
      .from(operatorSessions)
      .where(eq(operatorSessions.id, ids.session));
    assert.ok(session?.revokedAt);

    const audit = new DrizzleAuthAuditSink(harness.database);
    await audit.append({
      organizationId: null,
      actorId: null,
      action: "auth.login",
      subjectId: null,
      outcome: "failure",
      occurredAt: now,
      metadata: {},
    });
    const [unscoped] = await harness.database
      .select({ organizationId: auditEvents.organizationId, actorKey: auditEvents.actorKey })
      .from(auditEvents)
      .where(isNull(auditEvents.organizationId));
    assert.deepEqual(unscoped, { organizationId: null, actorKey: "anonymous" });
  } finally {
    await harness.close();
  }
});

test("database constraints reject cross-tenant run and current-revision references", async () => {
  const harness = await createPipelineHarness();
  try {
    await assert.rejects(
      harness.database.insert(importRuns).values({
        organizationId: ids.otherOrganization,
        providerId: ids.provider,
        configRevisionId: ids.configuration,
        trigger: "manual",
      }),
    );
    await harness.ingestion.commitPage(initialPage());
    const [entity] = await harness.database
      .select({ id: canonicalEntities.id })
      .from(canonicalEntities)
      .where(eq(canonicalEntities.externalId, "pack-standard"));
    const [otherRevision] = await harness.database
      .select({ id: canonicalRevisions.id })
      .from(canonicalRevisions)
      .where(eq(canonicalRevisions.entityId, entity!.id));
    const [differentEntity] = await harness.database
      .select({ id: canonicalEntities.id })
      .from(canonicalEntities)
      .where(eq(canonicalEntities.externalId, "pack-premium"));
    await assert.rejects(
      harness.database
        .update(canonicalEntities)
        .set({ currentRevisionId: otherRevision!.id })
        .where(eq(canonicalEntities.id, differentEntity!.id)),
    );

    const [provider] = await harness.database
      .select({ activeRevisionId: providerSources.activeRevisionId })
      .from(providerSources)
      .where(eq(providerSources.id, ids.provider));
    assert.equal(provider?.activeRevisionId, ids.configuration);
  } finally {
    await harness.close();
  }
});
