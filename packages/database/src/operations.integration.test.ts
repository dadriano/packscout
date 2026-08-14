import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationalNotification } from "@packscout/contracts";
import { IngestionPersistenceRepository } from "./ingestion-repository.ts";
import { PrismaAdminNotificationPublisher } from "./operational-alert-repository.ts";
import { PrismaOperationalHealthRepository } from "./operational-health-repository.ts";
import { PrismaProtectedPayloadRetentionRepository } from "./protected-payload-retention-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const ids = {
  organization: "60000000-0000-4000-8000-000000000001",
  otherOrganization: "60000000-0000-4000-8000-000000000002",
  provider: "60000000-0000-4000-8000-000000000010",
  configuration: "60000000-0000-4000-8000-000000000020",
  run: "60000000-0000-4000-8000-000000000030",
  attempt: "60000000-0000-4000-8000-000000000040",
  runningAttempt: "60000000-0000-4000-8000-000000000041",
  otherRetention: "60000000-0000-4000-8000-000000000050",
  retentionOne: "60000000-0000-4000-8000-000000000051",
  retentionTwo: "60000000-0000-4000-8000-000000000052",
  retentionThree: "60000000-0000-4000-8000-000000000053",
  retentionFour: "60000000-0000-4000-8000-000000000054",
  retentionFive: "60000000-0000-4000-8000-000000000055",
  retentionSix: "60000000-0000-4000-8000-000000000056",
} as const;

const committedAt = new Date("2026-08-06T12:00:00.000Z");
const sourceTime = new Date("2026-08-06T11:59:00.000Z");
const cutoffAt = new Date("2026-11-05T12:00:00.000Z");
const sensitive = "Bearer db-secret private-user 0xprivate-wallet";
const platform = "fixture-platform";

class MutableClock {
  constructor(private value: Date) {}

  now(): Date {
    const current = new Date(this.value);
    this.value = new Date(this.value.getTime() + 10);
    return current;
  }
}

function catalog(externalId: string) {
  return {
    stream: "catalog" as const,
    platform,
    entity: "card" as const,
    record_id: externalId,
    first_seen_at: sourceTime.toISOString(),
    occurred_at: sourceTime.toISOString(),
    collected_at: committedAt.toISOString(),
    data: { secret: sensitive },
  };
}

async function createHarness() {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  await setup.createOrganization({
    id: ids.organization,
    slug: "operations-fixture",
    name: "Operations Fixture",
    createdAt: committedAt,
  });
  await setup.createOrganization({
    id: ids.otherOrganization,
    slug: "operations-other",
    name: "Operations Other",
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
    adapterKey: "http-cursor-v2",
    endpointUrl: "https://provider.example/feed",
    authMode: "none",
    createdByActorKey: "actor:admin",
    createdAt: committedAt,
  });
  await setup.recordSuccessfulConnectionTest({
    organizationId: ids.organization,
    providerId: ids.provider,
    revisionId: ids.configuration,
    actorKey: "actor:admin",
    testedAt: committedAt,
    latencyMs: 5,
  });
  await setup.activateConfiguration({
    organizationId: ids.organization,
    providerId: ids.provider,
    revisionId: ids.configuration,
    actorKey: "actor:admin",
    activatedAt: committedAt,
    nextRunAt: committedAt,
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
    actorPseudonymKey: "test-pseudonym-key",
  });
  const accepted = catalog("accepted-asset");
  const mappedFailure = catalog("mapped-failure");
  await ingestion.commitPage({
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    runId: ids.run,
    pageNumber: 1,
    requestedCursor: null,
    nextCursor: "cursor-1",
    hasMore: true,
    payload: {
      requestedCursor: null,
      nextCursor: "cursor-1",
      hasMore: true,
      records: [accepted, mappedFailure],
    },
    checkpointMode: "provider",
    records: [
      {
        recordKind: "catalog",
        recordIndex: 0,
        externalId: "accepted-asset",
        sourceTime,
        collectedAt: committedAt,
        payload: accepted,
        projections: [{
          platformKey: platform,
          recordKind: "catalog_asset",
          externalId: "accepted-asset",
          content: { name: "Accepted asset" },
          sourceUpdatedAt: sourceTime,
          sourceCollectedAt: committedAt,
        }],
      },
      {
        recordKind: "catalog",
        recordIndex: 1,
        externalId: "mapped-failure",
        sourceTime,
        collectedAt: committedAt,
        payload: mappedFailure,
        projections: [],
        quarantine: {
          reasonCode: "MAPPING_REJECTED",
          fieldPath: "data",
          sanitizedSummary: "Provider mapping rejected the record.",
        },
      },
    ],
    committedAt,
  });
  const invalidEnvelope = catalog("invalid-envelope");
  await ingestion.commitPage({
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    runId: ids.run,
    pageNumber: 2,
    requestedCursor: "cursor-1",
    nextCursor: "cursor-2",
    hasMore: false,
    payload: {
      requestedCursor: "cursor-1",
      nextCursor: "cursor-2",
      hasMore: false,
      records: [invalidEnvelope],
    },
    checkpointMode: "provider",
    records: [],
    quarantines: [{
      recordKind: "catalog",
      recordIndex: 0,
      externalId: null,
      reasonCode: "ENVELOPE_VALIDATION_FAILED",
      fieldPath: "records[0]",
      sanitizedSummary: "Provider envelope failed validation.",
      payload: invalidEnvelope,
    }],
    committedAt: new Date(committedAt.getTime() + 1_000),
  });
  const quarantines = await harness.client.quarantine_records.findMany({
    where: { organization_id: ids.organization },
    select: { id: true, source_record_id: true },
  });
  const resolved = quarantines.find(
    ({ source_record_id: sourceRecordId }) => sourceRecordId !== null,
  );
  const open = quarantines.find(
    ({ source_record_id: sourceRecordId }) => sourceRecordId === null,
  );
  if (!resolved || !open) throw new Error("Quarantine fixtures were not created.");
  const resolvedAt = new Date(committedAt.getTime() + 2_000);
  await harness.client.quarantine_records.update({
    where: { id: resolved.id },
    data: { state: "resolved", resolved_at: resolvedAt },
  });
  await harness.client.quarantine_attempts.create({
    data: {
      id: ids.attempt,
      organization_id: ids.organization,
      quarantine_id: open.id,
      source_record_id: null,
      state: "failed",
      requested_by_actor_key: "actor:operator",
      failure_code: "ENVELOPE_VALIDATION_FAILED",
      field_path: "record_id",
      sanitized_summary: "Retained evidence still fails envelope validation.",
      canonical_revision_count: 0,
      started_at: resolvedAt,
      finished_at: resolvedAt,
    },
  });
  return {
    ...harness,
    resolved,
    open,
    resolvedAt,
    clock: new MutableClock(cutoffAt),
  };
}

test("bounded retention is tenant-scoped, restart-safe, and preserves permanent evidence", async () => {
  const harness = await createHarness();
  try {
    const retention = new PrismaProtectedPayloadRetentionRepository(
      harness.database,
      harness.clock,
    );
    const sourceBefore = (
      await harness.client.source_records.findMany({
        select: { id: true, content_hash: true },
      })
    ).map(({ id, content_hash: hash }) => ({ id, hash }));
    const pagesBefore = (
      await harness.client.import_pages.findMany({
        select: { id: true, payload_hash: true },
      })
    ).map(({ id, payload_hash: hash }) => ({ id, hash }));
    const runBeforeRecord = await harness.client.import_runs.findUniqueOrThrow({
      where: { id: ids.run },
      select: { state: true, counters_json: true },
    });
    const runBefore = {
      state: runBeforeRecord.state,
      counters: runBeforeRecord.counters_json,
    };
    const canonicalBefore = await harness.client.canonical_revisions.findMany({
      orderBy: { id: "asc" },
    });
    const attemptsBefore = await harness.client.quarantine_attempts.findMany({
      orderBy: { id: "asc" },
    });

    const foreign = await retention.expireBatch({
      executionId: ids.otherRetention,
      organizationId: ids.otherOrganization,
      cutoffAt,
      batchSize: 100,
      startedAt: cutoffAt,
    });
    assert.equal(foreign.result.selected, 0);
    const afterForeign = (
      await harness.client.quarantine_records.findMany({
        where: { organization_id: ids.organization },
        select: { id: true, payload_json: true },
      })
    ).map(({ id, payload_json: payload }) => ({ id, payload }));
    assert.equal(
      afterForeign.find(({ id }) => id === harness.open.id)?.payload !== null,
      true,
    );
    assert.equal(
      afterForeign.find(({ id }) => id === harness.resolved.id)?.payload,
      null,
    );

    const first = await retention.expireBatch({
      executionId: ids.retentionOne,
      organizationId: ids.organization,
      cutoffAt,
      batchSize: 2,
      startedAt: cutoffAt,
    });
    assert.equal(first.result.selected, 2);
    assert.equal(first.result.quarantinesExpired, 1);
    assert.equal(first.result.sourceRecordsExpired, 1);
    assert.equal(first.result.alreadyExpired, 0);
    assert.equal(first.result.remaining, 3);
    assert.deepEqual(first.expiredQuarantines.map(({ id }) => id), [harness.open.id]);
    const replay = await retention.expireBatch({
      executionId: ids.retentionOne,
      organizationId: ids.organization,
      cutoffAt,
      batchSize: 2,
      startedAt: cutoffAt,
    });
    assert.equal(replay.result.replayed, true);
    assert.equal(replay.result.expired, first.result.expired);
    assert.deepEqual(replay.expiredQuarantines, []);

    const second = await retention.expireBatch({
      executionId: ids.retentionTwo,
      organizationId: ids.organization,
      cutoffAt,
      batchSize: 2,
      startedAt: cutoffAt,
    });
    const third = await retention.expireBatch({
      executionId: ids.retentionThree,
      organizationId: ids.organization,
      cutoffAt,
      batchSize: 2,
      startedAt: cutoffAt,
    });
    const fourth = await retention.expireBatch({
      executionId: ids.retentionFour,
      organizationId: ids.organization,
      cutoffAt,
      batchSize: 2,
      startedAt: cutoffAt,
    });
    assert.equal(second.result.sourceRecordsExpired, 1);
    assert.equal(second.result.pagesExpired, 1);
    assert.equal(third.result.pagesExpired, 1);
    assert.equal(fourth.result.selected, 0);
    assert.equal(fourth.result.alreadyExpired, 5);
    assert.equal(fourth.result.remaining, 0);

    const quarantinesAfter = (
      await harness.client.quarantine_records.findMany({
        select: {
          id: true,
          state: true,
          reason_code: true,
          resolved_at: true,
          payload_json: true,
        },
      })
    ).map(
      ({ id, state, reason_code: reason, resolved_at: resolvedAt, payload_json: payload }) => ({
        id,
        state,
        reason,
        resolvedAt,
        payload,
      }),
    );
    assert.deepEqual(
      quarantinesAfter.find(({ id }) => id === harness.open.id),
      {
        id: harness.open.id,
        state: "expired",
        reason: "ENVELOPE_VALIDATION_FAILED",
        resolvedAt: null,
        payload: null,
      },
    );
    assert.deepEqual(
      quarantinesAfter.find(({ id }) => id === harness.resolved.id),
      {
        id: harness.resolved.id,
        state: "resolved",
        reason: "MAPPING_REJECTED",
        resolvedAt: harness.resolvedAt,
        payload: null,
      },
    );
    assert.equal(
      (await harness.client.source_records.findMany()).every(
        ({ payload_json: payload }) => payload === null,
      ),
      true,
    );
    assert.equal(
      (await harness.client.import_pages.findMany()).every(
        ({ payload_json: payload }) => payload === null,
      ),
      true,
    );
    assert.deepEqual(
      (
        await harness.client.source_records.findMany({
          select: { id: true, content_hash: true },
        })
      )
        .map(({ id, content_hash: hash }) => ({ id, hash }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
      sourceBefore.toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    assert.deepEqual(
      (
        await harness.client.import_pages.findMany({
          select: { id: true, payload_hash: true },
        })
      )
        .map(({ id, payload_hash: hash }) => ({ id, hash }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
      pagesBefore.toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    assert.deepEqual(
      await harness.client.canonical_revisions.findMany({ orderBy: { id: "asc" } }),
      canonicalBefore,
    );
    assert.deepEqual(
      await harness.client.quarantine_attempts.findMany({ orderBy: { id: "asc" } }),
      attemptsBefore,
    );
    const runAfterRecord = await harness.client.import_runs.findUniqueOrThrow({
      where: { id: ids.run },
      select: { state: true, counters_json: true },
    });
    assert.deepEqual(
      { state: runAfterRecord.state, counters: runAfterRecord.counters_json },
      runBefore,
    );
    const retentionAudits = (
      await harness.client.audit_events.findMany({
        where: { action: "provider.retention.expire" },
        select: { metadata_json: true },
      })
    ).map(({ metadata_json: metadata }) => ({ metadata }));
    assert.equal(retentionAudits.length, 5);
    assert.equal(JSON.stringify(retentionAudits).includes(sensitive), false);
  } finally {
    await harness.close();
  }
});

test("retention discovery returns only tenants whose policy deadlines are due", async () => {
  const harness = await createHarness();
  try {
    const retention = new PrismaProtectedPayloadRetentionRepository(
      harness.database,
      harness.clock,
    );
    const firstDeadline = new Date(
      committedAt.getTime() + 90 * 24 * 60 * 60 * 1_000,
    );
    assert.deepEqual(
      await retention.discoverEligibleOrganizations({
        cutoffAt: new Date(firstDeadline.getTime() - 1),
        limit: 10,
      }),
      [],
    );
    assert.deepEqual(
      await retention.discoverEligibleOrganizations({
        cutoffAt: firstDeadline,
        limit: 10,
      }),
      [ids.organization],
    );
    await retention.expireBatch({
      executionId: ids.retentionOne,
      organizationId: ids.organization,
      cutoffAt,
      batchSize: 100,
      startedAt: cutoffAt,
    });
    assert.deepEqual(
      await retention.discoverEligibleOrganizations({
        cutoffAt,
        limit: 10,
      }),
      [],
    );
  } finally {
    await harness.close();
  }
});

test("concurrent retention executions claim disjoint evidence without double expiry", async () => {
  const harness = await createHarness();
  try {
    const independentClient = await harness.createIndependentClient();
    const firstRetention = new PrismaProtectedPayloadRetentionRepository(
      harness.database,
      harness.clock,
    );
    const secondRetention = new PrismaProtectedPayloadRetentionRepository(
      independentClient,
      harness.clock,
    );
    const results = await Promise.all([
      firstRetention.expireBatch({
        executionId: ids.retentionOne,
        organizationId: ids.organization,
        cutoffAt,
        batchSize: 3,
        startedAt: cutoffAt,
      }),
      secondRetention.expireBatch({
        executionId: ids.retentionTwo,
        organizationId: ids.organization,
        cutoffAt,
        batchSize: 3,
        startedAt: cutoffAt,
      }),
    ]);
    assert.equal(
      results.reduce((total, batch) => total + batch.result.expired, 0),
      5,
    );
    assert.equal(
      (await harness.client.import_pages.findMany()).every(
        ({ payload_json: payload }) => payload === null,
      ),
      true,
    );
    assert.equal(
      (await harness.client.source_records.findMany()).every(
        ({ payload_json: payload }) => payload === null,
      ),
      true,
    );
    assert.equal(
      (await harness.client.quarantine_records.findMany()).every(
        ({ payload_json: payload }) => payload === null,
      ),
      true,
    );
  } finally {
    await harness.close();
  }
});

function event(input: {
  id: string;
  kind: OperationalNotification["kind"];
  occurredAt: Date;
  runId?: string | null;
}): OperationalNotification {
  const active = input.kind !== "provider_recovered";
  const condition =
    input.kind === "run_incomplete"
      ? "run-incomplete"
      : input.kind === "provider_stale"
        ? "stale"
        : "run-failed";
  return {
    id: input.id,
    organizationId: ids.organization,
    kind: input.kind,
    severity: active ? "critical" : "info",
    providerId: ids.provider,
    runId: input.runId ?? null,
    quarantineId: null,
    dedupeKey: active
      ? `provider:${condition}:${ids.provider}`
      : `provider:recovered:${ids.provider}`,
    recoveryKey: `provider:health:${ids.provider}`,
    title: active ? "Provider import failed" : "Provider recovered",
    summary: active
      ? "The provider import stopped with a sanitized failure code."
      : "The provider reached its configured health target.",
    evidence: active
      ? { failureCode: "PROVIDER_IMPORT_FAILED" }
      : { outcome: "PROVIDER_RECOVERED" },
    occurredAt: input.occurredAt.toISOString(),
  };
}

test("admin alerts deduplicate, resolve, reopen, and preserve safe occurrence history", async () => {
  const harness = await createHarness();
  try {
    const publisher = new PrismaAdminNotificationPublisher(harness.database);
    const eventOne = event({
      id: "61000000-0000-4000-8000-000000000001",
      kind: "run_failed",
      runId: ids.run,
      occurredAt: committedAt,
    });
    const eventTwo = event({
      id: "61000000-0000-4000-8000-000000000002",
      kind: "run_failed",
      runId: ids.run,
      occurredAt: new Date(committedAt.getTime() + 1_000),
    });
    const recovery = event({
      id: "61000000-0000-4000-8000-000000000003",
      kind: "provider_recovered",
      occurredAt: new Date(committedAt.getTime() + 2_000),
    });
    const recurrence = event({
      id: "61000000-0000-4000-8000-000000000004",
      kind: "run_failed",
      runId: ids.run,
      occurredAt: new Date(committedAt.getTime() + 3_000),
    });
    const incomplete = event({
      id: "61000000-0000-4000-8000-000000000007",
      kind: "run_incomplete",
      runId: ids.run,
      occurredAt: new Date(committedAt.getTime() + 1_100),
    });
    const stale = event({
      id: "61000000-0000-4000-8000-000000000008",
      kind: "provider_stale",
      occurredAt: new Date(committedAt.getTime() + 1_200),
    });

    const first = await publisher.publish(eventOne);
    assert.equal(first.status, "accepted");
    assert.equal((await publisher.publish(eventOne)).status, "deduplicated");
    assert.equal((await publisher.publish(eventTwo)).status, "deduplicated");
    assert.equal((await publisher.publish(incomplete)).status, "accepted");
    assert.equal((await publisher.publish(stale)).status, "accepted");
    if (!first.alertId) throw new Error("Alert was not created.");
    const acknowledged = await publisher.acknowledge({
      organizationId: ids.organization,
      alertId: first.alertId,
      actorKey: "actor:operator",
      acknowledgedAt: new Date(committedAt.getTime() + 1_500),
    });
    assert.equal(acknowledged?.state, "acknowledged");
    assert.equal((await publisher.publish(recovery)).status, "resolved");
    assert.equal((await publisher.getAlert(ids.organization, first.alertId))?.state, "resolved");
    assert.equal((await publisher.publish(recurrence)).status, "accepted");
    const reopened = await publisher.getAlert(ids.organization, first.alertId);
    assert.equal(reopened?.state, "active");
    assert.equal(reopened?.occurrenceCount, 4);
    assert.equal(reopened?.reopenedCount, 1);
    assert.equal(reopened?.acknowledgedAt, null);
    assert.equal(reopened?.occurrences.length, 6);
    assert.equal((await publisher.listAlerts({
      organizationId: ids.otherOrganization,
      limit: 50,
    })).length, 0);

    const invalid = await publisher.publish({
      ...eventOne,
      id: "61000000-0000-4000-8000-000000000005",
      summary: sensitive,
    } as unknown as OperationalNotification);
    assert.equal(invalid.status, "failed");
    const quarantineExpired: OperationalNotification = {
      id: "61000000-0000-4000-8000-000000000009",
      organizationId: ids.organization,
      kind: "quarantine_expired",
      severity: "warning",
      providerId: ids.provider,
      runId: null,
      quarantineId: harness.open.id,
      dedupeKey: `quarantine:expired:${harness.open.id}`,
      recoveryKey: `quarantine:${harness.open.id}`,
      title: "Quarantine source evidence expired",
      summary: "Retry is unavailable because protected source retention ended.",
      evidence: { reasonCode: "ENVELOPE_VALIDATION_FAILED" },
      occurredAt: new Date(committedAt.getTime() + 4_000).toISOString(),
    };
    assert.equal((await publisher.publish(quarantineExpired)).status, "accepted");
    assert.equal((await publisher.publish({
      ...quarantineExpired,
      id: "61000000-0000-4000-8000-000000000010",
      kind: "quarantine_resolved",
      severity: "info",
      dedupeKey: `quarantine:resolved:${harness.open.id}`,
      title: "Quarantine resolved",
      summary: "The retained source record passed retry and projection.",
      evidence: { outcome: "QUARANTINE_RESOLVED" },
      occurredAt: new Date(committedAt.getTime() + 5_000).toISOString(),
    })).status, "resolved");
    const retentionFailed: OperationalNotification = {
      id: "61000000-0000-4000-8000-000000000011",
      organizationId: ids.organization,
      kind: "retention_failed",
      severity: "critical",
      providerId: null,
      runId: null,
      quarantineId: null,
      dedupeKey: `retention:failed:${ids.organization}`,
      recoveryKey: `retention:${ids.organization}`,
      title: "Protected-data retention failed",
      summary: "A bounded protected-data cleanup did not complete.",
      evidence: { failureCode: "RETENTION_BATCH_FAILED" },
      occurredAt: new Date(committedAt.getTime() + 6_000).toISOString(),
    };
    assert.equal((await publisher.publish(retentionFailed)).status, "accepted");
    assert.equal((await publisher.publish({
      ...retentionFailed,
      id: "61000000-0000-4000-8000-000000000012",
      kind: "retention_recovered",
      severity: "info",
      dedupeKey: `retention:recovered:${ids.organization}`,
      title: "Protected-data retention recovered",
      summary: "The latest bounded protected-data cleanup completed.",
      evidence: { outcome: "RETENTION_RECOVERED" },
      occurredAt: new Date(committedAt.getTime() + 7_000).toISOString(),
    })).status, "resolved");
    assert.equal(await harness.client.operational_events.count(), 10);
    const rendered = JSON.stringify({
      reopened,
      events: await harness.client.operational_events.findMany(),
    });
    assert.equal(rendered.includes(sensitive), false);

    await assert.rejects(
      harness.client.operational_events.create({
        data: {
          id: "61000000-0000-4000-8000-000000000006",
          organization_id: ids.otherOrganization,
          kind: "run_failed",
          severity: "critical",
          provider_id: ids.provider,
          run_id: ids.run,
          quarantine_id: null,
          dedupe_key: "cross-tenant-event",
          recovery_key: "cross-tenant-event",
          title: "Cross tenant",
          summary: "This write must fail.",
          evidence_json: {},
          occurred_at: committedAt,
        },
      }),
    );

    const health = await new PrismaOperationalHealthRepository(
      harness.database,
    ).loadSnapshot({ organizationId: ids.organization, checkedAt: cutoffAt });
    assert.equal(health.configuredProviderCount, 1);
    assert.equal(health.staleProviderCount, 1);
    assert.equal(health.activeAlertCount, 1);
  } finally {
    await harness.close();
  }
});

test("retention skips every protected payload needed by a running quarantine retry", async () => {
  const harness = await createHarness();
  try {
    const linkedRecord = await harness.client.quarantine_records.findUniqueOrThrow({
      where: { id: harness.resolved.id },
      select: { source_record_id: true, page_id: true },
    });
    const linked = {
      sourceRecordId: linkedRecord.source_record_id,
      pageId: linkedRecord.page_id,
    };
    if (!linked?.sourceRecordId) throw new Error("Linked quarantine was not created.");
    await harness.client.quarantine_records.update({
      where: { id: harness.resolved.id },
      data: { state: "open", resolved_at: null },
    });
    await harness.client.quarantine_attempts.create({
      data: {
        id: ids.runningAttempt,
        organization_id: ids.organization,
        quarantine_id: harness.resolved.id,
        source_record_id: linked.sourceRecordId,
        state: "running",
        requested_by_actor_key: "actor:operator",
        started_at: cutoffAt,
      },
    });
    const retention = new PrismaProtectedPayloadRetentionRepository(
      harness.database,
      harness.clock,
    );
    await retention.expireBatch({
      executionId: ids.retentionFive,
      organizationId: ids.organization,
      cutoffAt,
      batchSize: 100,
      startedAt: cutoffAt,
    });
    assert.deepEqual(
      await retention.discoverEligibleOrganizations({
        cutoffAt,
        limit: 10,
      }),
      [],
    );
    const protectedSource = await harness.client.source_records.findUniqueOrThrow({
      where: { id: linked.sourceRecordId },
      select: { payload_json: true },
    });
    const protectedPage = await harness.client.import_pages.findUniqueOrThrow({
      where: { id: linked.pageId },
      select: { payload_json: true },
    });
    assert.notEqual(protectedSource.payload_json, null);
    assert.notEqual(protectedPage.payload_json, null);

    await harness.client.quarantine_attempts.update({
      where: { id: ids.runningAttempt },
      data: {
        state: "failed",
        finished_at: new Date(cutoffAt.getTime() + 100),
      },
    });
    assert.deepEqual(
      await retention.discoverEligibleOrganizations({
        cutoffAt,
        limit: 10,
      }),
      [ids.organization],
    );
    await retention.expireBatch({
      executionId: ids.retentionSix,
      organizationId: ids.organization,
      cutoffAt,
      batchSize: 100,
      startedAt: cutoffAt,
    });
    assert.equal(
      (
        await harness.client.source_records.findUniqueOrThrow({
          where: { id: linked.sourceRecordId },
          select: { payload_json: true },
        })
      ).payload_json,
      null,
    );
    assert.equal(
      (
        await harness.client.import_pages.findUniqueOrThrow({
          where: { id: linked.pageId },
          select: { payload_json: true },
        })
      ).payload_json,
      null,
    );
  } finally {
    await harness.close();
  }
});

test("retention failure evidence is stable and never stores thrown provider material", async () => {
  const harness = await createHarness();
  try {
    const repository = new PrismaProtectedPayloadRetentionRepository(
      harness.database,
      harness.clock,
    );
    const failure = await repository.recordFailure({
      executionId: ids.retentionOne,
      organizationId: ids.organization,
      cutoffAt,
      batchSize: 100,
      startedAt: cutoffAt,
      finishedAt: new Date(cutoffAt.getTime() + 10),
      failureCode: sensitive,
    });
    assert.equal(failure.failed, 1);
    const storedRecord = await harness.client.retention_executions.findFirst({
      where: {
        organization_id: ids.organization,
        id: ids.retentionOne,
      },
      select: { failure_code: true, sanitized_summary: true },
    });
    const stored = storedRecord
      ? {
          code: storedRecord.failure_code,
          summary: storedRecord.sanitized_summary,
        }
      : null;
    assert.equal(stored?.code, "RETENTION_FAILED");
    assert.equal(JSON.stringify(stored).includes(sensitive), false);
    await assert.rejects(
      repository.recordFailure({
        executionId: ids.retentionOne,
        organizationId: ids.otherOrganization,
        cutoffAt,
        batchSize: 100,
        startedAt: cutoffAt,
        finishedAt: new Date(cutoffAt.getTime() + 20),
        failureCode: "RETENTION_FAILED",
      }),
    );
    assert.equal(
      (
        await harness.client.retention_executions.findUniqueOrThrow({
          where: { id: ids.retentionOne },
          select: { organization_id: true },
        })
      ).organization_id,
      ids.organization,
    );
  } finally {
    await harness.close();
  }
});
