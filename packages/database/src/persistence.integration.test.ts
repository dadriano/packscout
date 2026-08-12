import assert from "node:assert/strict";
import { test } from "node:test";
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

async function createPipelineHarness() {
  const harness = await createMigratedTestDatabase();
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
  setup: PipelineSetupRepository,
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
    assert.equal(
      await harness.database.import_pages.count({ where: { run_id: ids.run } }),
      1,
    );
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
    assert.equal(await harness.database.import_pages.count(), 0);
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

    assert.ok(await harness.database.source_record_projection_revisions.count() >= 4);
  } finally {
    await harness.close();
  }
});

test("independent clients serialize competing revisions for one canonical identity", async () => {
  const harness = await createPipelineHarness();
  const independentClient = await harness.createIndependentClient();
  try {
    await addRun(harness.setup, ids.secondRun);
    const independentIngestion = new IngestionPersistenceRepository(independentClient, {
      retentionDays: 90,
      actorPseudonymKey: "test-pseudonym-key",
    });
    const pageFor = (
      runId: string,
      pageNumber: number,
      priceCents: number,
      sourceOffset: number,
    ): CommitPageInput => ({
      ...initialPage({
        runId,
        pageNumber,
        payload: { competing: priceCents },
        records: [],
        quarantines: [],
        committedAt: new Date(committedAt.getTime() + sourceOffset),
      }),
      records: [
        {
          recordKind: "catalog",
          recordIndex: 0,
          externalId: `competing-source-${priceCents}`,
          sourceTime: new Date(sourceTime.getTime() + sourceOffset),
          collectedAt: new Date(collectedAt.getTime() + sourceOffset),
          payload: { priceCents },
          projections: [
            {
              platformKey: "beezie",
              recordKind: "pack",
              externalId: "competing-pack",
              content: { name: "Competing Pack", priceCents },
              sourceUpdatedAt: new Date(sourceTime.getTime() + sourceOffset),
              sourceCollectedAt: new Date(collectedAt.getTime() + sourceOffset),
            },
          ],
        },
      ],
    });

    await Promise.all([
      harness.ingestion.commitPage(pageFor(ids.run, 1, 2500, 1_000)),
      independentIngestion.commitPage(pageFor(ids.secondRun, 1, 3000, 2_000)),
    ]);

    const revisions = await harness.ingestion.listCanonicalRevisions(ids.organization, {
      platformKey: "beezie",
      recordKind: "pack",
      externalId: "competing-pack",
    });
    assert.equal(revisions.length, 2);
    assert.deepEqual(
      revisions.map(({ revisionNumber }) => revisionNumber),
      [1, 2],
    );
    assert.equal(
      new Set(revisions.map(({ content }) => content.priceCents)).size,
      2,
    );
  } finally {
    await harness.close();
  }
});

test("large page commits batch writes while preserving evidence, projections, and record counts", async (context) => {
  const harness = await createPipelineHarness();
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

    harness.statementCounter.reset();
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
      harness.statementCounter.count < 80,
      `large page commit issued ${harness.statementCounter.count} SQL statements`,
    );
    context.diagnostic(
      `550-record page commit issued ${harness.statementCounter.count} SQL statements`,
    );

    const storedPage = await harness.database.import_pages.findUnique({
      where: { id: committed.pageId },
      select: { record_counts_json: true },
    });
    assert.deepEqual(storedPage?.record_counts_json, {
      catalog: recordCount,
      pulls: 1,
      sales: 1,
    });
    assert.equal(await harness.database.source_records.count(), recordCount);
    assert.equal(await harness.database.source_record_observations.count(), recordCount);
    assert.equal(await harness.database.source_record_outcomes.count(), recordCount + 2);
    assert.equal(
      await harness.database.source_record_outcomes.count({
        where: { source_record_id: { not: null } },
      }),
      recordCount,
    );
    assert.equal(
      await harness.database.source_record_outcomes.count({
        where: { source_record_id: null },
      }),
      2,
    );
    assert.equal(await harness.database.quarantine_records.count(), 3);
    assert.equal(await harness.database.canonical_revisions.count(), recordCount - 1);
    assert.equal(
      await harness.database.source_record_projection_revisions.count(),
      recordCount - 1,
    );
    assert.equal(await harness.database.canonical_relationships.count(), recordCount - 1);

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
    assert.equal(await harness.database.source_records.count(), recordCount);
    assert.equal(await harness.database.canonical_revisions.count(), recordCount - 1);
    assert.equal(
      await harness.database.source_record_observations.count(),
      recordCount * 2,
    );
  } finally {
    await harness.close();
  }
});

test("unresolved pull relationships persist and reconcile when a pack arrives", async () => {
  const harness = await createPipelineHarness();
  try {
    await harness.ingestion.commitPage(initialPage());
    const unresolved = await harness.database.canonical_relationships.findFirst({
      where: { target_external_id: "pack-arrives-later" },
      select: { id: true, target_entity_id: true },
    });
    assert.ok(unresolved);
    assert.equal(unresolved.target_entity_id, null);

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
    const linked = await harness.database.canonical_relationships.findUnique({
      where: { id: unresolved.id },
      select: { target_entity_id: true },
    });
    assert.ok(linked?.target_entity_id);
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
    const failedPage = await harness.database.import_pages.findFirst({
      where: { run_id: ids.run, page_number: 2 },
      select: { id: true },
    });
    assert.equal(failedPage, null);
    const checkpoint = await harness.database.provider_cursor_checkpoints.findUnique({
      where: { config_revision_id: ids.configuration },
      select: { cursor: true },
    });
    assert.equal(checkpoint?.cursor, "cursor-1");
    const run = await harness.database.import_runs.findUnique({
      where: { id: ids.run },
      select: { counters_json: true },
    });
    assert.deepEqual(run?.counters_json, committed.counters);
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
    const page = await harness.database.import_pages.findFirst();
    const source = await harness.database.source_records.findFirst();
    const quarantine = await harness.database.quarantine_records.findFirst();
    assert.equal(page?.payload_json, null);
    assert.equal(source?.payload_json, null);
    assert.equal(quarantine?.payload_json, null);
    assert.equal(quarantine?.reason_code, "MISSING_EXTERNAL_ID");

    assert.equal(await harness.database.canonical_revisions.count(), 3);
    assert.equal(await harness.database.source_record_outcomes.count(), 3);
    assert.equal(await harness.database.import_runs.count(), 1);
    assert.ok(await harness.database.audit_events.count() >= 1);
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
    const session = await harness.database.operator_sessions.findUnique({
      where: { id: ids.session },
      select: { revoked_at: true },
    });
    assert.ok(session?.revoked_at);

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
    const unscoped = await harness.database.audit_events.findFirst({
      where: { organization_id: null },
      select: { organization_id: true, actor_key: true },
    });
    assert.deepEqual(unscoped, { organization_id: null, actor_key: "anonymous" });
  } finally {
    await harness.close();
  }
});

test("database constraints reject cross-tenant run and current-revision references", async () => {
    const harness = await createPipelineHarness();
  try {
    await assert.rejects(
      harness.database.import_runs.create({ data: {
        organization_id: ids.otherOrganization,
        provider_id: ids.provider,
        config_revision_id: ids.configuration,
        trigger: "manual",
        requested_by_actor_key: "operator:other",
      } }),
    );
    await harness.ingestion.commitPage(initialPage());
    const entity = await harness.database.canonical_entities.findFirstOrThrow({
      where: { external_id: "pack-standard" },
      select: { id: true },
    });
    const otherRevision = await harness.database.canonical_revisions.findFirstOrThrow({
      where: { entity_id: entity.id },
      select: { id: true },
    });
    const differentEntity = await harness.database.canonical_entities.findFirstOrThrow({
      where: { external_id: "pack-premium" },
      select: { id: true },
    });
    await assert.rejects(
      harness.database.canonical_entities.update({
        where: { id: differentEntity.id },
        data: { current_revision_id: otherRevision.id },
      }),
    );

    const provider = await harness.database.provider_sources.findUnique({
      where: { id: ids.provider },
      select: { active_revision_id: true },
    });
    assert.equal(provider?.active_revision_id, ids.configuration);
  } finally {
    await harness.close();
  }
});
