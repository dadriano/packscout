import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationalNotification } from "@packscout/contracts";
import { and, eq } from "drizzle-orm";
import { IngestionPersistenceRepository } from "./ingestion-repository.ts";
import { DrizzleAdminNotificationPublisher } from "./operational-alert-repository.ts";
import { DrizzleOperationalHealthRepository } from "./operational-health-repository.ts";
import { DrizzleProtectedPayloadRetentionRepository } from "./protected-payload-retention-repository.ts";
import {
  auditEvents,
  canonicalRevisions,
  importPages,
  importRuns,
  operationalEvents,
  quarantineAttempts,
  quarantineRecords,
  retentionExecutions,
  sourceRecords,
} from "./schema/index.ts";
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
    platform,
    external_id: externalId,
    updated_at: sourceTime.toISOString(),
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
    adapterKey: "fixture-mapper-v1",
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
      catalog: [accepted, mappedFailure],
      pulls: [],
      sales: [],
      next_cursor: "cursor-1",
      has_more: true,
    },
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
      catalog: [invalidEnvelope],
      pulls: [],
      sales: [],
      next_cursor: "cursor-2",
      has_more: false,
    },
    records: [],
    quarantines: [{
      recordKind: "catalog",
      recordIndex: 0,
      externalId: null,
      reasonCode: "ENVELOPE_VALIDATION_FAILED",
      fieldPath: "catalog[0]",
      sanitizedSummary: "Provider envelope failed validation.",
      payload: invalidEnvelope,
    }],
    committedAt: new Date(committedAt.getTime() + 1_000),
  });
  const quarantines = await harness.database
    .select({
      id: quarantineRecords.id,
      sourceRecordId: quarantineRecords.sourceRecordId,
    })
    .from(quarantineRecords)
    .where(eq(quarantineRecords.organizationId, ids.organization));
  const resolved = quarantines.find(({ sourceRecordId }) => sourceRecordId !== null);
  const open = quarantines.find(({ sourceRecordId }) => sourceRecordId === null);
  if (!resolved || !open) throw new Error("Quarantine fixtures were not created.");
  const resolvedAt = new Date(committedAt.getTime() + 2_000);
  await harness.database
    .update(quarantineRecords)
    .set({ state: "resolved", resolvedAt })
    .where(eq(quarantineRecords.id, resolved.id));
  await harness.database.insert(quarantineAttempts).values({
    id: ids.attempt,
    organizationId: ids.organization,
    quarantineId: open.id,
    sourceRecordId: null,
    state: "failed",
    requestedByActorKey: "actor:operator",
    failureCode: "ENVELOPE_VALIDATION_FAILED",
    fieldPath: "external_id",
    sanitizedSummary: "Retained evidence still fails envelope validation.",
    canonicalRevisionCount: 0,
    startedAt: resolvedAt,
    finishedAt: resolvedAt,
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
    const retention = new DrizzleProtectedPayloadRetentionRepository(
      harness.database,
      harness.clock,
    );
    const sourceBefore = await harness.database
      .select({ id: sourceRecords.id, hash: sourceRecords.contentHash })
      .from(sourceRecords);
    const pagesBefore = await harness.database
      .select({ id: importPages.id, hash: importPages.payloadHash })
      .from(importPages);
    const [runBefore] = await harness.database
      .select({ state: importRuns.state, counters: importRuns.countersJson })
      .from(importRuns)
      .where(eq(importRuns.id, ids.run));
    const canonicalBefore = await harness.database.select().from(canonicalRevisions);
    const attemptsBefore = await harness.database.select().from(quarantineAttempts);

    const foreign = await retention.expireBatch({
      executionId: ids.otherRetention,
      organizationId: ids.otherOrganization,
      cutoffAt,
      batchSize: 100,
      startedAt: cutoffAt,
    });
    assert.equal(foreign.result.selected, 0);
    const afterForeign = await harness.database
      .select({ id: quarantineRecords.id, payload: quarantineRecords.payloadJson })
      .from(quarantineRecords)
      .where(eq(quarantineRecords.organizationId, ids.organization));
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

    const quarantinesAfter = await harness.database
      .select({
        id: quarantineRecords.id,
        state: quarantineRecords.state,
        reason: quarantineRecords.reasonCode,
        resolvedAt: quarantineRecords.resolvedAt,
        payload: quarantineRecords.payloadJson,
      })
      .from(quarantineRecords);
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
      (await harness.database.select().from(sourceRecords)).every(
        ({ payloadJson }) => payloadJson === null,
      ),
      true,
    );
    assert.equal(
      (await harness.database.select().from(importPages)).every(
        ({ payloadJson }) => payloadJson === null,
      ),
      true,
    );
    assert.deepEqual(
      (await harness.database
        .select({ id: sourceRecords.id, hash: sourceRecords.contentHash })
        .from(sourceRecords)).toSorted((left, right) => left.id.localeCompare(right.id)),
      sourceBefore.toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    assert.deepEqual(
      (await harness.database
        .select({ id: importPages.id, hash: importPages.payloadHash })
        .from(importPages)).toSorted((left, right) => left.id.localeCompare(right.id)),
      pagesBefore.toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    assert.deepEqual(await harness.database.select().from(canonicalRevisions), canonicalBefore);
    assert.deepEqual(await harness.database.select().from(quarantineAttempts), attemptsBefore);
    assert.deepEqual(
      (await harness.database
        .select({ state: importRuns.state, counters: importRuns.countersJson })
        .from(importRuns)
        .where(eq(importRuns.id, ids.run)))[0],
      runBefore,
    );
    const retentionAudits = await harness.database
      .select({ metadata: auditEvents.metadataJson })
      .from(auditEvents)
      .where(eq(auditEvents.action, "provider.retention.expire"));
    assert.equal(retentionAudits.length, 5);
    assert.equal(JSON.stringify(retentionAudits).includes(sensitive), false);
  } finally {
    await harness.close();
  }
});

test("retention discovery returns only tenants whose policy deadlines are due", async () => {
  const harness = await createHarness();
  try {
    const retention = new DrizzleProtectedPayloadRetentionRepository(
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
    const retention = new DrizzleProtectedPayloadRetentionRepository(
      harness.database,
      harness.clock,
    );
    const results = await Promise.all([
      retention.expireBatch({
        executionId: ids.retentionOne,
        organizationId: ids.organization,
        cutoffAt,
        batchSize: 3,
        startedAt: cutoffAt,
      }),
      retention.expireBatch({
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
      (await harness.database.select().from(importPages)).every(
        ({ payloadJson }) => payloadJson === null,
      ),
      true,
    );
    assert.equal(
      (await harness.database.select().from(sourceRecords)).every(
        ({ payloadJson }) => payloadJson === null,
      ),
      true,
    );
    assert.equal(
      (await harness.database.select().from(quarantineRecords)).every(
        ({ payloadJson }) => payloadJson === null,
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
    const publisher = new DrizzleAdminNotificationPublisher(harness.database);
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
    assert.equal((await harness.database.select().from(operationalEvents)).length, 10);
    const rendered = JSON.stringify({
      reopened,
      events: await harness.database.select().from(operationalEvents),
    });
    assert.equal(rendered.includes(sensitive), false);

    await assert.rejects(
      harness.database.insert(operationalEvents).values({
        id: "61000000-0000-4000-8000-000000000006",
        organizationId: ids.otherOrganization,
        kind: "run_failed",
        severity: "critical",
        providerId: ids.provider,
        runId: ids.run,
        quarantineId: null,
        dedupeKey: "cross-tenant-event",
        recoveryKey: "cross-tenant-event",
        title: "Cross tenant",
        summary: "This write must fail.",
        evidenceJson: {},
        occurredAt: committedAt,
      }),
    );

    const health = await new DrizzleOperationalHealthRepository(
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
    const [linked] = await harness.database
      .select({
        sourceRecordId: quarantineRecords.sourceRecordId,
        pageId: quarantineRecords.pageId,
      })
      .from(quarantineRecords)
      .where(eq(quarantineRecords.id, harness.resolved.id));
    if (!linked?.sourceRecordId) throw new Error("Linked quarantine was not created.");
    await harness.database
      .update(quarantineRecords)
      .set({ state: "open", resolvedAt: null })
      .where(eq(quarantineRecords.id, harness.resolved.id));
    await harness.database.insert(quarantineAttempts).values({
      id: ids.runningAttempt,
      organizationId: ids.organization,
      quarantineId: harness.resolved.id,
      sourceRecordId: linked.sourceRecordId,
      state: "running",
      requestedByActorKey: "actor:operator",
      startedAt: cutoffAt,
    });
    const retention = new DrizzleProtectedPayloadRetentionRepository(
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
    const [protectedSource] = await harness.database
      .select({ payload: sourceRecords.payloadJson })
      .from(sourceRecords)
      .where(eq(sourceRecords.id, linked.sourceRecordId));
    const [protectedPage] = await harness.database
      .select({ payload: importPages.payloadJson })
      .from(importPages)
      .where(eq(importPages.id, linked.pageId));
    assert.notEqual(protectedSource?.payload, null);
    assert.notEqual(protectedPage?.payload, null);

    await harness.database
      .update(quarantineAttempts)
      .set({ state: "failed", finishedAt: new Date(cutoffAt.getTime() + 100) })
      .where(eq(quarantineAttempts.id, ids.runningAttempt));
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
      (await harness.database
        .select({ payload: sourceRecords.payloadJson })
        .from(sourceRecords)
        .where(eq(sourceRecords.id, linked.sourceRecordId)))[0]?.payload,
      null,
    );
    assert.equal(
      (await harness.database
        .select({ payload: importPages.payloadJson })
        .from(importPages)
        .where(eq(importPages.id, linked.pageId)))[0]?.payload,
      null,
    );
  } finally {
    await harness.close();
  }
});

test("retention failure evidence is stable and never stores thrown provider material", async () => {
  const harness = await createHarness();
  try {
    const repository = new DrizzleProtectedPayloadRetentionRepository(
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
    const [stored] = await harness.database
      .select({
        code: retentionExecutions.failureCode,
        summary: retentionExecutions.sanitizedSummary,
      })
      .from(retentionExecutions)
      .where(
        and(
          eq(retentionExecutions.organizationId, ids.organization),
          eq(retentionExecutions.id, ids.retentionOne),
        ),
      );
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
      (await harness.database
        .select({ organizationId: retentionExecutions.organizationId })
        .from(retentionExecutions)
        .where(eq(retentionExecutions.id, ids.retentionOne)))[0]?.organizationId,
      ids.organization,
    );
  } finally {
    await harness.close();
  }
});
