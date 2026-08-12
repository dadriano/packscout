import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PrismaImportRunRepository,
  PrismaProviderConfigurationRepository,
  IngestionPersistenceRepository,
  PipelineSetupRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import {
  safeValidateProviderFeedPageV1,
  type ProviderFeedPageStructureV1,
} from "@packscout/contracts";
import {
  ProviderMappingAdapterRegistry,
  ProviderTransportAdapterRegistry,
} from "./provider-adapter-registry.ts";
import type {
  ProviderMappingAdapter,
  ProviderMappingOutput,
  NormalizedProviderTransportFailure,
  ProviderSourceIdentity,
  ProviderTransportAdapter,
  ProviderTransportPageInput,
} from "./provider-adapter.ts";
import { ProviderTransportRequestError } from "./provider-adapter.ts";
import { AesGcmProviderCredentialCipher } from "./provider-credential-cipher.ts";
import { DefaultProviderImportPagePlanner } from "./provider-import-page-planner.ts";
import {
  ProviderImportService,
  ProviderImportServiceError,
} from "./provider-import-service.ts";
import type {
  ProviderImportPageRepository,
  ProviderProjectionPort,
} from "./provider-import-types.ts";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  otherOrganization: "10000000-0000-4000-8000-000000000002",
  provider: "10000000-0000-4000-8000-000000000010",
  revision: "10000000-0000-4000-8000-000000000020",
} as const;

const platform = "fixture-platform";
const collectedAt = "2026-08-06T12:00:00.000Z";
const sourceTime = "2026-08-06T11:59:00.000Z";

class MutableClock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

class FixtureTransportAdapter implements ProviderTransportAdapter {
  readonly key = "http-cursor-v1";
  readonly requests: Array<string | null> = [];
  failure: NormalizedProviderTransportFailure | null = null;
  onFetch?: () => Promise<void>;

  constructor(
    private readonly pages: ReadonlyMap<string | null, ProviderFeedPageStructureV1>,
    onFetch?: () => Promise<void>,
  ) {
    this.onFetch = onFetch;
  }

  supportsPlatform(value: string): boolean {
    return value === platform;
  }

  async testConnection() {
    return {
      ok: true as const,
      latencyMs: 1,
      responseStatus: 200,
      recordCounts: { catalog: 0, pulls: 0, sales: 0 },
      hasMore: false,
      nextCursorPresent: true,
    };
  }

  async fetchPage(input: ProviderTransportPageInput) {
    this.requests.push(input.cursor);
    if (this.failure) throw new ProviderTransportRequestError(this.failure);
    await this.onFetch?.();
    const raw = this.pages.get(input.cursor);
    if (!raw) throw new Error("Missing fixture page.");
    const parsed = safeValidateProviderFeedPageV1(raw, {
      requestedPlatform: input.platform,
      requestedCursor: input.cursor,
      seenCursors: input.seenCursors,
    });
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  }
}

function source(
  recordKind: "catalog" | "pull" | "sale",
  recordIndex: number,
  envelope: { external_id: string; collected_at: string; updated_at?: string; occurred_at?: string },
): ProviderSourceIdentity {
  return {
    platform,
    recordKind,
    recordIndex,
    externalId: envelope.external_id,
    collectedAt: envelope.collected_at,
    sourceTimestamp: envelope.updated_at ?? envelope.occurred_at!,
  };
}

class FixtureMappingAdapter implements ProviderMappingAdapter {
  readonly key = "fixture-mapper-v1";
  readonly platformKey = platform;

  mapPage(input: Parameters<ProviderMappingAdapter["mapPage"]>[0]): ProviderMappingOutput {
    assert.equal(input.configuration.adapterKey, this.key);
    const outcomes: ProviderMappingOutput["outcomes"][number][] = [];
    input.page.catalog.forEach((envelope, index) => {
      const recordSource = source(
        "catalog",
        input.recordIndexes.catalog[index]!,
        envelope,
      );
      outcomes.push(
        envelope.external_id === "bad-map"
          ? {
              status: "invalid",
              source: recordSource,
              failure: { reasonCode: "UNCLASSIFIABLE_CATALOG", fieldPath: "data" },
            }
          : {
              status: "mapped",
              source: recordSource,
              candidates: [
                {
                  candidateKind: "catalog_asset",
                  source: recordSource,
                  externalId: envelope.external_id,
                  name: envelope.external_id,
                  relationships: [],
                  dataQualityEvidence: [],
                },
              ],
            },
      );
    });
    input.page.pulls.forEach((envelope, index) => {
      const recordSource = source(
        "pull",
        input.recordIndexes.pulls[index]!,
        envelope,
      );
      outcomes.push({
        status: "mapped",
        source: recordSource,
        candidates: [
          {
            candidateKind: "pull",
            source: recordSource,
            packExternalId: envelope.pack_external_id,
            assetExternalId: null,
            occurredAt: envelope.occurred_at,
            pseudonymizationInputs: [],
            relationships: [],
            dataQualityEvidence: [],
          },
        ],
      });
    });
    return { outcomes };
  }
}

const projectionPort: ProviderProjectionPort = {
  project: ({ configuration, source: recordSource }) => {
    assert.equal(configuration.adapterKey, "fixture-mapper-v1");
    return recordSource.externalId === "projection-bad"
      ? { status: "invalid", reasonCode: "PROJECTION_SCHEMA_INVALID" }
      : {
          status: "accepted",
          projections: [
            {
              platformKey: platform,
              recordKind:
                recordSource.recordKind === "catalog" ? "catalog_asset" : "pull",
              externalId: recordSource.externalId,
              content: { sourceExternalId: recordSource.externalId },
              sourceUpdatedAt: new Date(recordSource.sourceTimestamp),
              sourceCollectedAt: new Date(recordSource.collectedAt),
            },
          ],
        };
  },
};

function catalog(externalId: string) {
  return {
    platform,
    external_id: externalId,
    updated_at: sourceTime,
    collected_at: collectedAt,
    data: { display: externalId },
  };
}

function pull(externalId: string) {
  return {
    platform,
    external_id: externalId,
    pack_external_id: null,
    occurred_at: sourceTime,
    collected_at: collectedAt,
    data: { display: externalId },
  };
}

async function createHarness(
  pages: ReadonlyMap<string | null, ProviderFeedPageStructureV1>,
  options: {
    onFetch?: () => Promise<void>;
    pageRepository?: (
      repository: IngestionPersistenceRepository,
    ) => ProviderImportPageRepository;
  } = {},
) {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  const clock = new MutableClock(new Date("2026-08-06T12:05:00.000Z"));
  await setup.createOrganization({
    id: ids.organization,
    slug: "fixture",
    name: "Fixture",
    createdAt: clock.now(),
  });
  await setup.createOrganization({
    id: ids.otherOrganization,
    slug: "other-fixture",
    name: "Other Fixture",
    createdAt: clock.now(),
  });
  await setup.createProviderSource({
    id: ids.provider,
    organizationId: ids.organization,
    platformKey: platform,
    displayName: "Fixture Provider",
    createdAt: clock.now(),
  });
  await setup.createConfigRevision({
    id: ids.revision,
    organizationId: ids.organization,
    providerId: ids.provider,
    version: 1,
    adapterKey: "http-cursor-v1",
    endpointUrl: "https://provider.example/feed",
    authMode: "none",
    createdByActorKey: "operator:admin",
    createdAt: clock.now(),
  });
  await setup.recordSuccessfulConnectionTest({
    organizationId: ids.organization,
    providerId: ids.provider,
    revisionId: ids.revision,
    actorKey: "operator:admin",
    testedAt: clock.now(),
    latencyMs: 1,
  });
  await setup.activateConfiguration({
    organizationId: ids.organization,
    providerId: ids.provider,
    revisionId: ids.revision,
    actorKey: "operator:admin",
    activatedAt: clock.now(),
    nextRunAt: clock.now(),
  });
  const runs = new PrismaImportRunRepository(harness.database);
  const ingestion = new IngestionPersistenceRepository(harness.database, {
    retentionDays: 90,
    actorPseudonymKey: "fixture-pseudonym-key",
  });
  const transport = new FixtureTransportAdapter(pages, options.onFetch);
  let nextId = 100;
  const service = new ProviderImportService({
    runs,
    revisions: new PrismaProviderConfigurationRepository(harness.database),
    pages: options.pageRepository?.(ingestion as never) ?? ingestion,
    transportAdapters: new ProviderTransportAdapterRegistry([transport]),
    pagePlanner: new DefaultProviderImportPagePlanner(
      new ProviderMappingAdapterRegistry([new FixtureMappingAdapter()]),
      projectionPort,
    ),
    credentialCipher: new AesGcmProviderCredentialCipher({
      primaryVersion: 1,
      keys: new Map([[1, new Uint8Array(32).fill(7)]]),
    }),
    actorKeyer: {
      keyFor: ({ operatorId }) => `operator:${operatorId}`,
    },
    clock,
    ids: {
      id: () => `20000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    },
    environment: "test",
    sleeper: { sleep: async () => undefined },
    random: { value: () => 0 },
    leaseDurationMs: 20_000,
    maximumRunDurationMs: 20_000,
  });
  return { ...harness, clock, service, transport };
}

test("manual and scheduled requests share one run while a disabled-after-start import reaches head with linked quarantine", async () => {
  let disabled = false;
  const pages = new Map<string | null, ProviderFeedPageStructureV1>([
    [
      null,
      {
        catalog: [catalog("good-1"), catalog("bad-map"), { platform, data: {} }],
        pulls: [pull("projection-bad")],
        sales: [],
        next_cursor: "opaque-page-2",
        has_more: true,
      },
    ],
    [
      "opaque-page-2",
      {
        catalog: [catalog("good-2")],
        pulls: [],
        sales: [],
        next_cursor: "opaque-head",
        has_more: false,
      },
    ],
  ]);
  const harness = await createHarness(pages);
  harness.transport.onFetch = async () => {
    if (disabled) return;
    disabled = true;
    await harness.database.provider_sources.update({
      where: { id: ids.provider },
      data: { state: "disabled", next_run_at: null },
    });
  };
  try {
    const raced = await Promise.all([
      harness.service.requestImport({
        trigger: "scheduled",
        organizationId: ids.organization,
        providerId: ids.provider,
      }),
      harness.service.requestImport({
        trigger: "scheduled",
        organizationId: ids.organization,
        providerId: ids.provider,
      }),
    ]);
    const requested = raced.find((result) => !result.coalesced)!;
    const coalesced = raced.find((result) => result.coalesced)!;
    assert.ok(requested);
    assert.ok(coalesced);
    assert.equal(coalesced.run.id, requested.run.id);
    const manualDuplicate = await harness.service.requestImport({
      trigger: "manual",
      providerId: ids.provider,
      expectedConfigurationRevisionId: ids.revision,
      actor: {
        organizationId: ids.organization,
        operatorId: "admin",
        role: "admin",
      },
    });
    assert.equal(manualDuplicate.coalesced, true);
    assert.equal(manualDuplicate.run.id, requested.run.id);
    await assert.rejects(
      harness.service.executeImport({
        organizationId: ids.otherOrganization,
        runId: requested.run.id,
        workerId: "worker-wrong-tenant",
      }),
      (error: unknown) =>
        error instanceof ProviderImportServiceError &&
        error.code === "IMPORT_RUN_NOT_FOUND",
    );
    const finished = await harness.service.executeImport({
      organizationId: ids.organization,
      runId: requested.run.id,
      workerId: "worker-1",
    });
    assert.equal(finished.state, "incomplete");
    assert.equal(finished.reachedProviderHead, true);
    assert.deepEqual(finished.counters, {
      accepted: 2,
      duplicate: 0,
      quarantined: 3,
      pages: 2,
      records: 5,
      requestAttempts: 2,
      transientRetries: 0,
    });
    assert.deepEqual(harness.transport.requests, [null, "opaque-page-2"]);
    const checkpoint = await harness.database.provider_cursor_checkpoints.findUnique({
      where: { config_revision_id: ids.revision },
      select: { cursor: true },
    });
    assert.equal(checkpoint?.cursor, "opaque-head");
    assert.equal(await harness.database.import_pages.count(), 2);
    assert.equal(await harness.database.source_records.count(), 4);
    assert.equal(await harness.database.canonical_revisions.count(), 2);
    assert.equal(await harness.database.source_record_outcomes.count(), 5);
    const linkedQuarantines = await harness.database.quarantine_records.findMany({
      where: { source_record_id: { not: null } },
    });
    const unlinkedQuarantines = await harness.database.quarantine_records.findMany({
      where: { source_record_id: null },
    });
    assert.equal(linkedQuarantines.length, 2);
    assert.equal(unlinkedQuarantines.length, 1);
    assert.equal(unlinkedQuarantines[0]?.record_index, 2);
    const audits = await harness.database.audit_events.findMany();
    const serializedAudits = JSON.stringify(audits);
    assert.equal(serializedAudits.includes("display"), false);
    assert.equal(serializedAudits.includes("provider.example"), false);
    await assert.rejects(
      harness.service.requestImport({
        trigger: "scheduled",
        organizationId: ids.organization,
        providerId: ids.provider,
      }),
      (error: unknown) =>
        error instanceof ProviderImportServiceError &&
        error.code === "PROVIDER_NOT_IMPORTABLE",
    );
  } finally {
    await harness.close();
  }
});

test("the shared import workflow claims and executes a queued manual run", async () => {
  const harness = await createHarness(
    new Map([
      [
        null,
        {
          catalog: [catalog("manual-queue-record")],
          pulls: [],
          sales: [],
          next_cursor: "manual-queue-head",
          has_more: false,
        },
      ],
    ]),
  );
  try {
    const requested = await harness.service.requestImport({
      trigger: "manual",
      providerId: ids.provider,
      expectedConfigurationRevisionId: ids.revision,
      actor: {
        organizationId: ids.organization,
        operatorId: "admin",
        role: "admin",
      },
    });
    assert.equal(requested.run.state, "queued");

    const executed = await harness.service.executeNextImport({
      workerId: "manual-queue-worker",
    });

    assert.equal(executed.kind, "executed");
    if (executed.kind === "executed") {
      assert.equal(executed.run.id, requested.run.id);
      assert.equal(executed.run.trigger, "manual");
      assert.equal(executed.run.state, "succeeded");
      assert.equal(executed.run.reachedProviderHead, true);
    }
    assert.deepEqual(await harness.service.executeNextImport({
      workerId: "manual-queue-worker",
    }), { kind: "idle" });
  } finally {
    await harness.close();
  }
});

test("a crash after atomic page commit resumes from the durable opaque cursor without replaying source history", async () => {
  let simulateCrash = true;
  const pages = new Map<string | null, ProviderFeedPageStructureV1>([
    [
      null,
      {
        catalog: [catalog("crash-page-1")],
        pulls: [],
        sales: [],
        next_cursor: "opaque-resume",
        has_more: true,
      },
    ],
    [
      "opaque-resume",
      {
        catalog: [catalog("crash-page-2")],
        pulls: [],
        sales: [],
        next_cursor: "opaque-final",
        has_more: false,
      },
    ],
  ]);
  const harness = await createHarness(pages, {
    pageRepository: (repository) => ({
      commitPage: async (input) => {
        const result = await repository.commitPage(input);
        if (simulateCrash) {
          simulateCrash = false;
          throw { code: "RUN_OWNERSHIP_LOST" };
        }
        return result;
      },
    }),
  });
  try {
    const requested = await harness.service.requestImport({
      trigger: "scheduled",
      organizationId: ids.organization,
      providerId: ids.provider,
    });
    await assert.rejects(
      harness.service.executeImport({
        organizationId: ids.organization,
        runId: requested.run.id,
        workerId: "worker-before-crash",
      }),
      (error: unknown) =>
        error instanceof ProviderImportServiceError &&
        error.code === "RUN_OWNERSHIP_LOST",
    );
    const interruptedRecord = await harness.database.import_runs.findUnique({
      where: { id: requested.run.id },
      select: { state: true, final_cursor: true },
    });
    const interrupted = interruptedRecord && {
      state: interruptedRecord.state,
      cursor: interruptedRecord.final_cursor,
    };
    assert.deepEqual(interrupted, { state: "running", cursor: "opaque-resume" });
    harness.clock.advance(20_001);
    const finished = await harness.service.executeImport({
      organizationId: ids.organization,
      runId: requested.run.id,
      workerId: "worker-after-crash",
    });
    assert.equal(finished.state, "succeeded");
    assert.equal(finished.finalCursor, "opaque-final");
    assert.deepEqual(harness.transport.requests, [null, "opaque-resume"]);
    assert.equal(await harness.database.import_pages.count(), 2);
    assert.equal(await harness.database.source_records.count(), 2);
    assert.equal(await harness.database.canonical_revisions.count(), 2);
    const next = await harness.service.requestImport({
      trigger: "scheduled",
      organizationId: ids.organization,
      providerId: ids.provider,
    });
    assert.equal(next.run.requestedCursor, "opaque-final");
  } finally {
    await harness.close();
  }
});

test("transport failures retain distinct sanitized terminal codes and retry only transient classes", async () => {
  const harness = await createHarness(new Map());
  const cases: ReadonlyArray<{
    failure: NormalizedProviderTransportFailure;
    expectedCode: string;
    attempts: number;
  }> = [
    {
      failure: { code: "http_error", retryable: false, httpStatus: 401 },
      expectedCode: "IMPORT_AUTHENTICATION_FAILED",
      attempts: 1,
    },
    {
      failure: { code: "http_error", retryable: true, httpStatus: 429 },
      expectedCode: "IMPORT_RATE_LIMITED",
      attempts: 3,
    },
    {
      failure: { code: "timeout", retryable: true },
      expectedCode: "IMPORT_TIMEOUT",
      attempts: 3,
    },
    {
      failure: { code: "network_error", retryable: true },
      expectedCode: "IMPORT_UNREACHABLE",
      attempts: 3,
    },
    {
      failure: { code: "http_error", retryable: true, httpStatus: 503 },
      expectedCode: "IMPORT_HTTP_ERROR",
      attempts: 3,
    },
    {
      failure: { code: "invalid_json", retryable: false },
      expectedCode: "IMPORT_INVALID_JSON",
      attempts: 1,
    },
    {
      failure: { code: "invalid_response", retryable: false },
      expectedCode: "IMPORT_INVALID_CONTRACT",
      attempts: 1,
    },
    {
      failure: {
        code: "invalid_response",
        retryable: false,
        issueCodes: ["cursor_not_advanced"],
        fieldPaths: ["secret.response.body"],
      },
      expectedCode: "IMPORT_CURSOR_SAFETY_FAILED",
      attempts: 1,
    },
  ];
  try {
    for (const [index, scenario] of cases.entries()) {
      harness.transport.failure = scenario.failure;
      const requested = await harness.service.requestImport({
        trigger: "scheduled",
        organizationId: ids.organization,
        providerId: ids.provider,
      });
      const failed = await harness.service.executeImport({
        organizationId: ids.organization,
        runId: requested.run.id,
        workerId: `failure-worker-${index}`,
      });
      assert.equal(failed.state, "failed");
      assert.equal(failed.failureCode, scenario.expectedCode);
      assert.equal(failed.counters.requestAttempts, scenario.attempts);
      assert.equal(
        failed.counters.transientRetries,
        Math.max(0, scenario.attempts - 1),
      );
      assert.equal(failed.failureSummary?.includes("secret.response.body"), false);
    }
    const audits = JSON.stringify(await harness.database.audit_events.findMany());
    assert.equal(audits.includes("secret.response.body"), false);
  } finally {
    await harness.close();
  }
});

test("a page persistence failure leaves the checkpoint untouched and records only a sanitized terminal result", async () => {
  const pages = new Map<string | null, ProviderFeedPageStructureV1>([
    [
      null,
      {
        catalog: [catalog("persistence-failure")],
        pulls: [],
        sales: [],
        next_cursor: "must-not-advance",
        has_more: false,
      },
    ],
  ]);
  const rawFailure = "raw-database-secret-detail";
  const harness = await createHarness(pages, {
    pageRepository: () => ({
      commitPage: async () => {
        throw new Error(rawFailure);
      },
    }),
  });
  try {
    const requested = await harness.service.requestImport({
      trigger: "scheduled",
      organizationId: ids.organization,
      providerId: ids.provider,
    });
    const failed = await harness.service.executeImport({
      organizationId: ids.organization,
      runId: requested.run.id,
      workerId: "persistence-failure-worker",
    });
    assert.equal(failed.state, "failed");
    assert.equal(failed.failureCode, "IMPORT_PERSISTENCE_FAILED");
    assert.equal(failed.failureSummary?.includes(rawFailure), false);
    assert.equal(await harness.database.import_pages.count(), 0);
    const checkpoint = await harness.database.provider_cursor_checkpoints.findUnique({
      where: { config_revision_id: ids.revision },
      select: { cursor: true },
    });
    assert.equal(checkpoint?.cursor, null);
    assert.equal(
      JSON.stringify(await harness.database.audit_events.findMany()).includes(rawFailure),
      false,
    );
  } finally {
    await harness.close();
  }
});
