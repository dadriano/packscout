import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  ACCEPTANCE_CREATED_AT,
  activateAcceptanceRuntime,
  createAcceptanceProviderSource,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { PersistenceError } from "./persistence-error.ts";
import { ProviderSourceAdminCatalogRepository } from
  "./provider-source-admin-catalog-repository.ts";
import { ProviderSourceAdminLifecycleRepository } from
  "./provider-source-admin-lifecycle-repository.ts";
import { ProviderSourceImportRunRepository } from
  "./provider-source-import-run-repository.ts";

const sourceDefinition = {
  platformKey: "courtyard",
  displayName: "Courtyard request size",
  mapperKey: "courtyard-provider-observation",
  identityNamespaceKey: "courtyard-v1",
  intervalSeconds: 60,
  hashCharacter: "d",
} as const;

async function activateConnection(
  fixture: Awaited<ReturnType<typeof createProviderSourceAcceptanceFixture>>,
): Promise<void> {
  await fixture.database.$transaction(async (transaction) => {
    await transaction.source_connection_revisions.update({
      where: { id: fixture.connectionRevisionId },
      data: { state: "active", activated_at: ACCEPTANCE_CREATED_AT },
    });
    await transaction.source_connection_profiles.update({
      where: { id: fixture.connectionProfileId },
      data: {
        state: "active",
        active_revision_id: fixture.connectionRevisionId,
        updated_at: ACCEPTANCE_CREATED_AT,
      },
    });
  });
}

test("records per request defaults to 500 and source tests pin each saved revision", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "records-per-request-tests",
  );
  const other = await createProviderSourceAcceptanceFixture(
    "records-per-request-cross-org",
  );
  try {
    const source = await createAcceptanceProviderSource(fixture, sourceDefinition);
    const admin = new ProviderSourceAdminLifecycleRepository(fixture.database);
    const initial = await admin.loadSource({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
    });
    assert.ok(initial);
    assert.equal(initial.recordsPerRequest, 500);

    await activateConnection(fixture);
    const firstTest = await admin.requestSourceTest({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      requestedByActorKey: "operator-admin",
      requestedAt: ACCEPTANCE_CREATED_AT,
    });
    const firstPinned = await fixture.database.provider_source_test_jobs
      .findUniqueOrThrow({ where: { id: firstTest.jobId } });
    assert.equal(firstPinned.records_per_request, 500);

    const revisedAt = new Date(ACCEPTANCE_CREATED_AT.getTime() + 1_000);
    const revised = await admin.reviseRecordsPerRequest({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      expectedScheduleRevisionId: initial.scheduleRevisionId,
      recordsPerRequest: 725,
      actorKey: "operator-admin",
      effectiveAt: revisedAt,
    });
    const current = await admin.loadSource({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
    });
    assert.equal(current?.scheduleRevisionId, revised.scheduleRevisionId);
    assert.equal(current?.recordsPerRequest, 725);
    assert.equal(current?.intervalSeconds, initial.intervalSeconds);
    assert.equal(current?.state, initial.state);
    assert.equal(current?.cursorGeneration, initial.cursorGeneration);
    assert.equal(current?.cursorFingerprint, initial.cursorFingerprint);

    const revisions = await fixture.database.provider_source_schedule_revisions
      .findMany({
        where: { source_instance_id: source.sourceInstanceId },
        orderBy: { revision_number: "asc" },
      });
    assert.deepEqual(
      revisions.map((revision) => ({
        revision: revision.revision_number,
        recordsPerRequest: revision.records_per_request,
      })),
      [
        { revision: 1, recordsPerRequest: 500 },
        { revision: 2, recordsPerRequest: 725 },
      ],
    );
    const audit = await fixture.database.audit_events.findFirstOrThrow({
      where: {
        organization_id: fixture.organizationId,
        action: "provider_source.revise_records_per_request",
        subject_id: source.sourceInstanceId,
      },
      orderBy: [{ occurred_at: "desc" }, { id: "desc" }],
    });
    assert.deepEqual(audit.metadata_json, {
      sourceRevisionId: source.sourceRevisionId,
      previousScheduleRevisionId: initial.scheduleRevisionId,
      scheduleRevisionId: revised.scheduleRevisionId,
      recordsPerRequest: 725,
    });

    const secondTest = await admin.requestSourceTest({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      requestedByActorKey: "operator-admin",
      requestedAt: new Date(revisedAt.getTime() + 1_000),
    });
    assert.notEqual(secondTest.jobId, firstTest.jobId);
    const [preservedFirst, pinnedSecond] = await Promise.all([
      fixture.database.provider_source_test_jobs.findUniqueOrThrow({
        where: { id: firstTest.jobId },
      }),
      fixture.database.provider_source_test_jobs.findUniqueOrThrow({
        where: { id: secondTest.jobId },
      }),
    ]);
    assert.equal(preservedFirst.records_per_request, 500);
    assert.equal(pinnedSecond.records_per_request, 725);

    await assert.rejects(
      fixture.database.provider_source_test_jobs.update({
        where: { id: firstTest.jobId },
        data: { records_per_request: 726 },
      }),
      /source-test records-per-request pin is immutable/u,
    );
    const rejectedSave = {
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      expectedScheduleRevisionId: initial.scheduleRevisionId,
      recordsPerRequest: 900,
      actorKey: "operator-admin",
      effectiveAt: new Date(revisedAt.getTime() + 2_000),
    } as const;
    await assert.rejects(
      admin.reviseRecordsPerRequest(rejectedSave),
      (error) => error instanceof PersistenceError && error.code === "SOURCE_FENCED",
    );
    await assert.rejects(
      admin.reviseRecordsPerRequest({
        ...rejectedSave,
        organizationId: other.organizationId,
        expectedScheduleRevisionId: revised.scheduleRevisionId,
      }),
      (error) => error instanceof PersistenceError && error.code === "SOURCE_FENCED",
    );
    assert.equal(
      (await admin.loadSource({
        organizationId: fixture.organizationId,
        providerId: source.providerId,
        sourceInstanceId: source.sourceInstanceId,
      }))?.recordsPerRequest,
      725,
    );
  } finally {
    await Promise.all([fixture.close(), other.close()]);
  }
});

test("source catalog selects the latest test for the current request-size pin", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "records-per-request-catalog-test",
  );
  try {
    const source = await createAcceptanceProviderSource(fixture, sourceDefinition);
    await activateConnection(fixture);
    const admin = new ProviderSourceAdminLifecycleRepository(fixture.database);
    const initial = await admin.loadSource({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
    });
    assert.ok(initial);
    const testAt500 = await admin.requestSourceTest({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      requestedByActorKey: "operator-admin",
      requestedAt: ACCEPTANCE_CREATED_AT,
    });
    const at1000 = await admin.reviseRecordsPerRequest({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      expectedScheduleRevisionId: initial.scheduleRevisionId,
      recordsPerRequest: 1_000,
      actorKey: "operator-admin",
      effectiveAt: new Date(ACCEPTANCE_CREATED_AT.getTime() + 1_000),
    });
    const testAt1000 = await admin.requestSourceTest({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      requestedByActorKey: "operator-admin",
      requestedAt: new Date(ACCEPTANCE_CREATED_AT.getTime() + 2_000),
    });
    await admin.reviseRecordsPerRequest({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      expectedScheduleRevisionId: at1000.scheduleRevisionId,
      recordsPerRequest: 500,
      actorKey: "operator-admin",
      effectiveAt: new Date(ACCEPTANCE_CREATED_AT.getTime() + 3_000),
    });

    const catalogSource = (await new ProviderSourceAdminCatalogRepository(
      fixture.database,
    ).listSources(fixture.organizationId))[0];
    assert.ok(catalogSource);
    assert.equal(catalogSource.recordsPerRequest, 500);
    assert.equal(catalogSource.test.jobId, testAt500.jobId);
    assert.equal(catalogSource.test.recordsPerRequest, 500);
    assert.notEqual(catalogSource.test.jobId, testAt1000.jobId);
  } finally {
    await fixture.close();
  }
});

test("a disabled source can revise its request size before the next source test", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "records-per-request-disabled",
  );
  try {
    const source = await createAcceptanceProviderSource(fixture, sourceDefinition);
    await activateAcceptanceRuntime(
      fixture.database,
      fixture,
      source,
      ACCEPTANCE_CREATED_AT,
    );
    const admin = new ProviderSourceAdminLifecycleRepository(fixture.database);
    const disabledAt = new Date(ACCEPTANCE_CREATED_AT.getTime() + 1_000);
    await admin.disable({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      actorKey: "operator-admin",
      disabledAt,
    });

    const before = await admin.loadSource({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
    });
    assert.ok(before);
    assert.equal(before.state, "disabled");
    const instanceBefore = await fixture.database.provider_source_instances
      .findUniqueOrThrow({
        where: { id: source.sourceInstanceId },
        select: { active_revision_id: true, disabled_at: true },
      });

    const revised = await admin.reviseRecordsPerRequest({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      expectedScheduleRevisionId: before.scheduleRevisionId,
      recordsPerRequest: 250,
      actorKey: "operator-admin",
      effectiveAt: new Date(disabledAt.getTime() + 1_000),
    });

    const [after, instanceAfter] = await Promise.all([
      admin.loadSource({
        organizationId: fixture.organizationId,
        providerId: source.providerId,
        sourceInstanceId: source.sourceInstanceId,
      }),
      fixture.database.provider_source_instances.findUniqueOrThrow({
        where: { id: source.sourceInstanceId },
        select: { active_revision_id: true, disabled_at: true },
      }),
    ]);
    assert.ok(after);
    assert.equal(after.state, before.state);
    assert.equal(
      instanceAfter.disabled_at?.toISOString(),
      disabledAt.toISOString(),
    );
    assert.equal(
      instanceAfter.disabled_at?.toISOString(),
      instanceBefore.disabled_at?.toISOString(),
    );
    assert.equal(instanceAfter.active_revision_id, instanceBefore.active_revision_id);
    assert.equal(after.sourceRevisionId, before.sourceRevisionId);
    assert.equal(after.intervalSeconds, before.intervalSeconds);
    assert.equal(after.cursorGeneration, before.cursorGeneration);
    assert.equal(after.cursorFingerprint, before.cursorFingerprint);
    assert.equal(after.scheduleRevisionId, revised.scheduleRevisionId);
    assert.equal(after.recordsPerRequest, 250);
    const catalogSource = (await new ProviderSourceAdminCatalogRepository(
      fixture.database,
    ).listSources(fixture.organizationId)).find((candidate) =>
      candidate.sourceInstanceId === source.sourceInstanceId
    );
    assert.equal(catalogSource?.disabledAt?.toISOString(), disabledAt.toISOString());

    const nextTest = await admin.requestSourceTest({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      requestedByActorKey: "operator-admin",
      requestedAt: new Date(disabledAt.getTime() + 2_000),
    });
    const pinnedTest = await fixture.database.provider_source_test_jobs
      .findUniqueOrThrow({ where: { id: nextTest.jobId } });
    assert.equal(pinnedTest.records_per_request, 250);
  } finally {
    await fixture.close();
  }
});

test("queued runs retain their pin and the next recovery run uses the latest value", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "records-per-request-runs",
  );
  try {
    const source = await createAcceptanceProviderSource(fixture, sourceDefinition);
    await activateAcceptanceRuntime(
      fixture.database,
      fixture,
      source,
      ACCEPTANCE_CREATED_AT,
    );
    const runs = new ProviderSourceImportRunRepository(fixture.database);
    const first = await runs.requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: ACCEPTANCE_CREATED_AT,
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    assert.equal(first.kind, "created");
    if (first.kind !== "created") return;
    assert.equal(first.run.recordsPerRequest, 500);

    const admin = new ProviderSourceAdminLifecycleRepository(fixture.database);
    const current = await admin.loadSource({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
    });
    assert.ok(current);
    await admin.reviseRecordsPerRequest({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      expectedScheduleRevisionId: current.scheduleRevisionId,
      recordsPerRequest: 900,
      actorKey: "operator-admin",
      effectiveAt: new Date(ACCEPTANCE_CREATED_AT.getTime() + 1_000),
    });
    const queued = await fixture.database.import_runs.findUniqueOrThrow({
      where: { id: first.run.id },
    });
    assert.equal(queued.state, "queued");
    assert.equal(queued.records_per_request, 500);

    await fixture.database.import_runs.update({
      where: { id: first.run.id },
      data: {
        state: "incomplete",
        finished_at: new Date(ACCEPTANCE_CREATED_AT.getTime() + 2_000),
      },
    });
    const recovery = await runs.requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "recovery",
      requestedByActorKey: "operator-admin",
      requestedAt: new Date(ACCEPTANCE_CREATED_AT.getTime() + 3_000),
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    assert.equal(recovery.kind, "created");
    if (recovery.kind !== "created") return;
    assert.equal(recovery.run.recordsPerRequest, 900);
    assert.equal(
      (await fixture.database.import_runs.findUniqueOrThrow({
        where: { id: first.run.id },
      })).records_per_request,
      500,
    );
  } finally {
    await fixture.close();
  }
});
