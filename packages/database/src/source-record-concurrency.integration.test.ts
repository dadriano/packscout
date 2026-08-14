import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogRecordV2, PullRecordV2 } from "@packscout/contracts";
import type { PackscoutPrismaClient } from "./database.ts";
import { IngestionPersistenceRepository } from "./ingestion-repository.ts";
import type { CommitPageInput, SourceRecordKind } from "./pipeline-types.ts";
import { PrismaQuarantineRepository } from "./quarantine-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  provider: "10000000-0000-4000-8000-000000000010",
  configuration: "10000000-0000-4000-8000-000000000020",
  firstRun: "10000000-0000-4000-8000-000000000030",
  secondRun: "10000000-0000-4000-8000-000000000031",
} as const;
const occurredAt = new Date("2026-08-13T00:00:00.000Z");
const collectedAt = new Date("2026-08-13T00:01:00.000Z");
const committedAt = new Date("2026-08-14T00:00:00.000Z");

async function createHarness() {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  await setup.createOrganization({
    id: ids.organization,
    slug: "source-race",
    name: "Source Race",
    createdAt: committedAt,
  });
  await setup.createProviderSource({
    id: ids.provider,
    organizationId: ids.organization,
    platformKey: "fixture",
    displayName: "Fixture",
    createdAt: committedAt,
  });
  await setup.createConfigRevision({
    id: ids.configuration,
    organizationId: ids.organization,
    providerId: ids.provider,
    version: 1,
    adapterKey: "fixture-v2",
    endpointUrl: "https://provider.example/feed",
    authMode: "none",
    createdByActorKey: "operator:test",
    createdAt: committedAt,
  });
  for (const runId of [ids.firstRun, ids.secondRun]) {
    await setup.createImportRun({
      id: runId,
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.configuration,
      trigger: "recovery",
      state: "succeeded",
      createdAt: committedAt,
    });
  }
  const independentClient = await harness.createIndependentClient();
  return {
    ...harness,
    first: new IngestionPersistenceRepository(harness.database, {
      retentionDays: 90,
      actorPseudonymKey: "concurrency-test-key",
    }),
    second: new IngestionPersistenceRepository(independentClient, {
      retentionDays: 90,
      actorPseudonymKey: "concurrency-test-key",
    }),
  };
}

function page(input: {
  runId: string;
  recordKind: SourceRecordKind;
  externalId: string;
  payload: CatalogRecordV2 | PullRecordV2;
  suffix: string;
}): CommitPageInput {
  return {
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    runId: input.runId,
    pageNumber: 1,
    requestedCursor: null,
    nextCursor: `cursor-${input.suffix}`,
    hasMore: false,
    payload: { fixture: input.suffix },
    checkpointMode: "provider",
    committedAt,
    records: [{
      recordKind: input.recordKind,
      recordIndex: 0,
      externalId: input.externalId,
      sourceTime: occurredAt,
      collectedAt,
      payload: input.payload,
      projections: [],
    }],
    quarantines: [],
  };
}

async function assertConflictRetryIsNoop(input: {
  database: PackscoutPrismaClient;
  reasonCode: "CATALOG_IDENTITY_CONFLICT" | "IMMUTABLE_EVENT_CONFLICT";
  attemptId: string;
}): Promise<void> {
  const quarantine = await input.database.quarantine_records.findFirst({
    where: { reason_code: input.reasonCode },
    select: {
      id: true,
      state: true,
      retry_count: true,
      last_retry_at: true,
      resolved_at: true,
      payload_json: true,
      payload_expired_at: true,
    },
  });
  assert.ok(quarantine);
  assert.equal(quarantine.state, "open");
  const beforeCounts = await Promise.all([
    input.database.source_records.count(),
    input.database.canonical_revisions.count(),
    input.database.quarantine_attempts.count({
      where: { quarantine_id: quarantine.id },
    }),
    input.database.audit_events.count({
      where: {
        action: "provider.quarantine.retry",
        subject_id: quarantine.id,
      },
    }),
  ]);

  const outcome = await new PrismaQuarantineRepository(input.database).claimRetry({
    organizationId: ids.organization,
    quarantineId: quarantine.id,
    attemptId: input.attemptId,
    actorKey: "operator:crafted-retry",
    claimedAt: new Date("2026-08-14T00:05:00.000Z"),
  });

  assert.equal(outcome.kind, "non_retryable");
  const after = await input.database.quarantine_records.findUnique({
    where: { id: quarantine.id },
    select: {
      id: true,
      state: true,
      retry_count: true,
      last_retry_at: true,
      resolved_at: true,
      payload_json: true,
      payload_expired_at: true,
    },
  });
  assert.deepEqual(after, quarantine);
  assert.deepEqual(await Promise.all([
    input.database.source_records.count(),
    input.database.canonical_revisions.count(),
    input.database.quarantine_attempts.count({
      where: { quarantine_id: quarantine.id },
    }),
    input.database.audit_events.count({
      where: {
        action: "provider.quarantine.retry",
        subject_id: quarantine.id,
      },
    }),
  ]), beforeCounts);
}

test("independent commits serialize catalog stable identities and quarantine the loser", async () => {
  const harness = await createHarness();
  try {
    const catalog = (recordId: string, revision: number): CatalogRecordV2 => ({
      stream: "catalog",
      platform: "fixture",
      entity: "pack",
      record_id: recordId,
      first_seen_at: occurredAt.toISOString(),
      occurred_at: occurredAt.toISOString(),
      collected_at: collectedAt.toISOString(),
      data: { revision },
    });
    const results = await Promise.all([
      harness.first.commitPage(page({
        runId: ids.firstRun,
        recordKind: "catalog",
        externalId: "catalog-stable-key",
        payload: catalog("catalog-identity-a", 1),
        suffix: "catalog-a",
      })),
      harness.second.commitPage(page({
        runId: ids.secondRun,
        recordKind: "catalog",
        externalId: "catalog-stable-key",
        payload: catalog("catalog-identity-b", 2),
        suffix: "catalog-b",
      })),
    ]);

    assert.equal(results.reduce((sum, result) => sum + result.counters.accepted, 0), 1);
    assert.equal(results.reduce((sum, result) => sum + result.counters.quarantined, 0), 1);
    assert.equal(await harness.database.source_records.count({
      where: { external_id: "catalog-stable-key" },
    }), 1);
    assert.equal(await harness.database.quarantine_records.count({
      where: { reason_code: "CATALOG_IDENTITY_CONFLICT" },
    }), 1);
    await assertConflictRetryIsNoop({
      database: harness.database,
      reasonCode: "CATALOG_IDENTITY_CONFLICT",
      attemptId: "10000000-0000-4000-8000-000000000090",
    });
  } finally {
    await harness.close();
  }
});

test("independent immutable-event commits quarantine conflicting source facts", async () => {
  const harness = await createHarness();
  try {
    const pull = (variant: number): PullRecordV2 => ({
      stream: "pulls",
      platform: "fixture",
      record_id: "pull-stable-key",
      pack_id: "pack-1",
      card_id: "card-1",
      occurred_at: occurredAt.toISOString(),
      collected_at: collectedAt.toISOString(),
      data: { variant },
    });
    const results = await Promise.all([
      harness.first.commitPage(page({
        runId: ids.firstRun,
        recordKind: "pull",
        externalId: "pull-stable-key",
        payload: pull(1),
        suffix: "pull-a",
      })),
      harness.second.commitPage(page({
        runId: ids.secondRun,
        recordKind: "pull",
        externalId: "pull-stable-key",
        payload: pull(2),
        suffix: "pull-b",
      })),
    ]);

    assert.equal(results.reduce((sum, result) => sum + result.counters.accepted, 0), 1);
    assert.equal(results.reduce((sum, result) => sum + result.counters.quarantined, 0), 1);
    assert.equal(await harness.database.source_records.count({
      where: { external_id: "pull-stable-key" },
    }), 1);
    assert.equal(await harness.database.quarantine_records.count({
      where: { reason_code: "IMMUTABLE_EVENT_CONFLICT" },
    }), 1);
    await assertConflictRetryIsNoop({
      database: harness.database,
      reasonCode: "IMMUTABLE_EVENT_CONFLICT",
      attemptId: "10000000-0000-4000-8000-000000000091",
    });
  } finally {
    await harness.close();
  }
});

test("invalid NUL and oversized evidence cannot roll back a valid mixed-page sibling", async () => {
  const harness = await createHarness();
  try {
    const valid: CatalogRecordV2 = {
      stream: "catalog",
      platform: "fixture",
      entity: "pack",
      record_id: "valid-pack",
      first_seen_at: occurredAt.toISOString(),
      occurred_at: occurredAt.toISOString(),
      collected_at: collectedAt.toISOString(),
      data: { name: "Valid Pack" },
    };
    const nulRecord = {
      stream: "catalog",
      platform: "fixture",
      entity: "pack",
      record_id: "invalid\u0000pack",
      first_seen_at: occurredAt.toISOString(),
      occurred_at: occurredAt.toISOString(),
      collected_at: collectedAt.toISOString(),
      data: { nested: { value: "invalid\u0000value" } },
    };
    const oversizedId = "x".repeat(513);
    const oversizedRecord = { ...nulRecord, record_id: oversizedId, data: {} };
    const surrogateRecord = {
      ...nulRecord,
      record_id: "invalid\ud800pack",
      data: { nested: { value: "invalid\ud800value" } },
    };
    let deeplyNested: unknown = { leaf: "poison" };
    for (let depth = 0; depth < 500; depth += 1) {
      deeplyNested = { nested: deeplyNested };
    }
    const deepRecord = {
      ...nulRecord,
      record_id: "deep-record",
      data: deeplyNested,
    };
    const result = await harness.first.commitPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.configuration,
      runId: ids.firstRun,
      pageNumber: 1,
      requestedCursor: null,
      nextCursor: "cursor-mixed-invalid",
      hasMore: false,
      payload: {
        records: [valid, nulRecord, oversizedRecord, surrogateRecord, deepRecord],
      },
      checkpointMode: "provider",
      committedAt,
      records: [{
        recordKind: "catalog",
        recordIndex: 0,
        externalId: valid.record_id,
        sourceTime: occurredAt,
        collectedAt,
        payload: valid,
        projections: [],
      }],
      quarantines: [
        {
          recordKind: "catalog",
          recordIndex: 1,
          externalId: nulRecord.record_id,
          reasonCode: "INVALID_PROVIDER_RECORD",
          fieldPath: "records[1].record_id",
          sanitizedSummary: "Provider record failed validation.",
          payload: nulRecord,
        },
        {
          recordKind: "catalog",
          recordIndex: 2,
          externalId: oversizedId,
          reasonCode: "INVALID_PROVIDER_RECORD",
          fieldPath: "records[2].record_id",
          sanitizedSummary: "Provider record failed validation.",
          payload: oversizedRecord,
        },
        {
          recordKind: "catalog",
          recordIndex: 3,
          externalId: surrogateRecord.record_id,
          reasonCode: "INVALID_PROVIDER_RECORD",
          fieldPath: "records[3].record_id",
          sanitizedSummary: "Provider record failed validation.",
          payload: surrogateRecord,
        },
        {
          recordKind: "catalog",
          recordIndex: 4,
          externalId: deepRecord.record_id,
          reasonCode: "INVALID_PROVIDER_RECORD",
          fieldPath: "records[4].data",
          sanitizedSummary: "Provider record failed validation.",
          payload: deepRecord,
        },
      ],
    });

    assert.equal(result.counters.accepted, 1);
    assert.equal(result.counters.quarantined, 4);
    assert.equal(await harness.database.source_records.count({
      where: { external_id: valid.record_id },
    }), 1);
    const quarantines = await harness.database.quarantine_records.findMany({
      orderBy: { record_index: "asc" },
      select: { external_id: true, payload_json: true },
    });
    assert.deepEqual(
      quarantines.map(({ external_id }) => external_id),
      [null, null, null, "deep-record"],
    );
    assert.deepEqual(quarantines[0]?.payload_json, {
      __packscout_protected_json_v1: {
        kind: "text",
        json: JSON.stringify(nulRecord),
      },
    });
    assert.deepEqual(quarantines[2]?.payload_json, {
      __packscout_protected_json_v1: {
        kind: "text",
        json: JSON.stringify(surrogateRecord),
      },
    });
    assert.deepEqual(quarantines[3]?.payload_json, {
      __packscout_protected_json_v1: {
        kind: "text",
        json: JSON.stringify(deepRecord),
      },
    });
    const importedPage = await harness.database.import_pages.findFirstOrThrow({
      select: { payload_json: true },
    });
    assert.deepEqual(importedPage.payload_json, {
      __packscout_protected_json_v1: {
        kind: "text",
        json: JSON.stringify({
          records: [valid, nulRecord, oversizedRecord, surrogateRecord, deepRecord],
        }),
      },
    });
  } finally {
    await harness.close();
  }
});
