import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestEventsV1SourceAdapterManifest,
  launchRecordIdScopeDeclarations,
  providerIdentityNamespaceByLaunchProvider,
  providerSourceControlPlaneRetry,
  type LaunchProviderKey,
} from "@packscout/contracts";
import { dataforestEventsV1EvidenceFixture } from
  "@packscout/contracts/test-fixtures/dataforrest-events-v1";
import {
  PipelineSetupRepository,
  ProviderSourceAdminLifecycleRepository,
  ProviderSourceDiagnosticRepository,
  ProviderSourceImportRunRepository,
  ProviderSourceLifecycleRepository,
  ProviderSourcePageRepository,
  ProviderSourceRequestRepository,
  ProviderSourceSupervisorRepository,
  ProviderSourceSupervisorWorkRepository,
  ProviderSourceTestResultRepository,
  SourceConnectionAdminRepository,
  type PackscoutPrismaClient,
  type ProviderSourceSupervisorClaimedWork,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import {
  AesGcmSourceConnectionConfigurationCipher,
  DataforrestEventsSourceAdapter,
  OpaqueCursorGuard,
  ProviderSourcePageImportService,
  ProviderSourcePagePlanner,
  ProviderSourceSupervisor,
  SourceAdapterRegistry,
  createProviderObservationMapperRegistryFromManifest,
  launchSourceMapperDescriptors,
  type SourceSupervisorEpoch,
} from "@packscout/services";
import type { PinnedProviderHttpClient } from
  "@packscout/services/pinned-provider-http-client";
import {
  AlternateBookmarkSourceAdapter,
  alternateBookmarkSourceManifest,
} from "@packscout/services/test-support/alternate-bookmark-source-adapter";
import { ProviderSourceSupervisorWorkExecutor } from
  "./provider-source-supervisor-executor.ts";
import { classifyProviderSourceControlPlaneFailure } from
  "./provider-source-supervisor-composition.ts";

const actorKey = new Uint8Array(32).fill(41);
const encryptionKey = new Uint8Array(32).fill(43);
const actor = "operator-admin";

async function databaseNow(database: PackscoutPrismaClient): Promise<Date> {
  const rows = await database.$queryRaw<Array<{ now: Date }>>`
    select clock_timestamp() as now
  `;
  return rows[0]!.now;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (true) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

function epochFence(epoch: SourceSupervisorEpoch) {
  return {
    epochId: epoch.epochId,
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
  } as const;
}

function safeEpoch(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 1) {
    throw new TypeError("Fixture epoch exceeds the safe integer range.");
  }
  return converted;
}

function createRealSupervisor(input: Readonly<{
  database: PackscoutPrismaClient;
  cipher: AesGcmSourceConnectionConfigurationCipher;
  sourceAdapters: SourceAdapterRegistry;
  environmentKey: string;
  pageFailures?: unknown[];
  beforePageImport?: () => Promise<void>;
  importedSourceInstanceIds?: string[];
}>) {
  const ownerKey = `runtime-e2e-${input.environmentKey}`;
  const leaseToken = randomUUID();
  const ownership = new ProviderSourceSupervisorRepository(input.database);
  const work = new ProviderSourceSupervisorWorkRepository(input.database);
  const requests = new ProviderSourceRequestRepository(input.database);
  const testResults = new ProviderSourceTestResultRepository(input.database);
  const diagnostics = new ProviderSourceDiagnosticRepository(input.database);
  const mappers = createProviderObservationMapperRegistryFromManifest();
  const pageImports = new ProviderSourcePageImportService(
    new ProviderSourcePagePlanner(mappers),
    new OpaqueCursorGuard(actorKey),
    new ProviderSourcePageRepository(input.database, {
      actorPseudonymKey: actorKey,
    }),
  );
  const importPage = pageImports.importPage.bind(pageImports);
  pageImports.importPage = async (page) => {
    try {
      await input.beforePageImport?.();
      input.importedSourceInstanceIds?.push(page.pins.sourceInstanceId);
      return await importPage(page);
    } catch (error) {
      input.pageFailures?.push(error);
      throw error;
    }
  };
  const executor = new ProviderSourceSupervisorWorkExecutor({
    sourceAdapters: input.sourceAdapters,
    mappers,
    connectionCipher: input.cipher,
    requests,
    testResults,
    pageImports,
    classifyControlPlaneFailure: classifyProviderSourceControlPlaneFailure,
  });
  return new ProviderSourceSupervisor<ProviderSourceSupervisorClaimedWork>({
    environmentKey: input.environmentKey,
    ownerKey,
    leaseToken,
    ownership: {
      async acquire(identity) {
        const acquired = await ownership.acquire({ ...identity, now: new Date() });
        return {
          epochId: acquired.epochId,
          epochNumber: safeEpoch(acquired.epochNumber),
          ownerKey: identity.ownerKey,
          leaseToken: identity.leaseToken,
          leaseExpiresAt: acquired.leaseExpiresAt,
        };
      },
      renew: (epoch) => ownership.renew({ ...epochFence(epoch), now: new Date() }),
      fence: (epoch, safeReasonCode) => ownership.fence({
        ...epochFence(epoch),
        safeReasonCode,
        fencedAt: new Date(),
      }),
      release: (epoch) => ownership.release({
        ...epochFence(epoch),
        releasedAt: new Date(),
      }),
      listReconcilablePredecessorAttempts: (epoch) =>
        work.listReconcilablePredecessorAttempts(epochFence(epoch)),
      async reconcilePredecessorAttempt() {
        throw new Error("Fixture has no predecessor attempt to reconcile.");
      },
    },
    queue: {
      listDue: (epoch) => work.listDueSources({ ...epochFence(epoch), limit: 100 }),
      materializeDue: (epoch, due, runId) => work.materializeScheduledRun({
        ...epochFence(epoch),
        ...due,
        runId,
      }),
      listRecoverableClaims: (epoch) =>
        work.listRecoverableClaims(epochFence(epoch)),
      recoverClaim: (epoch, claim) => work.recoverClaim({
        ...epochFence(epoch),
        claim,
      }),
      claimNext: (epoch, command) => work.claimNext({
        ...epochFence(epoch),
        ...command,
      }),
      renewClaim: (epoch, claimed) => work.renewClaim({
        ...epochFence(epoch),
        work: claimed,
      }),
      releaseUnstarted: (epoch, claimed, waitReason) =>
        work.releaseUnstartedClaim({
          ...epochFence(epoch),
          work: claimed,
          waitReason,
          releasedAt: new Date(),
        }),
      markAdmissionWaiting: (epoch, claimed, reason) =>
        work.markAdmissionWaiting({ ...epochFence(epoch), work: claimed, reason }),
      markAdmissionGranted: (epoch, claimed) =>
        work.markAdmissionGranted({ ...epochFence(epoch), work: claimed }),
      async complete(epoch, claimed, disposition) {
        if (claimed.kind !== "page_read") {
          if (disposition.kind === "action_required" || disposition.kind === "fenced") {
            await work.finishTestClaim({
              ...epochFence(epoch),
              work: claimed,
              outcome: disposition.kind === "fenced" ? "fenced" : "failed",
              safeCode: disposition.kind === "fenced"
                ? "STALE_WORK_FENCED"
                : disposition.safeCode,
            });
          }
          return;
        }
        if (
          disposition.kind === "test_terminal" ||
          disposition.kind === "connection_blocked"
        ) return;
        if (disposition.kind === "fenced") {
          await work.finishFencedPageClaim({ ...epochFence(epoch), work: claimed });
          return disposition;
        }
        return work.finishPageTurn({
          ...epochFence(epoch),
          work: claimed,
          decision: disposition,
        });
      },
    },
    executor,
    capacity: { async probe() { return { admitted: true as const }; } },
    snapshot: { async publish() {} },
    diagnostics: {
      async record({ work: claimed, transition }) {
        // Work/request/page transactions own the durable row. The production
        // diagnostic port mirrors these already-committed transitions locally.
        if (transition === "adapter_request_started") {
          if (claimed.kind !== "page_read") return;
          assert.equal(
            await diagnostics.listForSource({
              organizationId: claimed.organizationId,
              sourceInstanceId: claimed.sourceInstanceId,
              limit: 100,
            }).then((events) => events.some((event) =>
              event.safeCode === "ADAPTER_REQUEST_STARTED"
            )),
            true,
          );
        }
      },
    },
    classifyControlPlaneFailure: classifyProviderSourceControlPlaneFailure,
    ids: { id: randomUUID },
    pollIntervalMilliseconds: 5,
  });
}

async function createDataforrestFixture(input: Readonly<{
  database: PackscoutPrismaClient;
  testKey: string;
  intervals: readonly number[];
  providers?: readonly LaunchProviderKey[];
  recordsPerRequest?: readonly number[];
}>) {
  const setup = new PipelineSetupRepository(input.database);
  const lifecycle = new ProviderSourceLifecycleRepository(input.database);
  const organizationId = await setup.createOrganization({
    slug: `runtime-e2e-${input.testKey}`,
    name: `Runtime e2e ${input.testKey}`,
    createdAt: await databaseNow(input.database),
  });
  const profileId = randomUUID();
  const revisionId = randomUUID();
  const cipher = new AesGcmSourceConnectionConfigurationCipher({
    primaryVersion: 1,
    keys: new Map([[1, encryptionKey]]),
  });
  const encrypted = cipher.encrypt(JSON.stringify({
    endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
    bearerToken: "fixture-secret-never-returned",
  }), {
    organizationId,
    connectionProfileId: profileId,
    connectionRevisionId: revisionId,
  });
  await new SourceConnectionAdminRepository(input.database).createConnectionProfile({
    organizationId,
    profileId,
    revisionId,
    sourceTypeKey: dataforrestEventsV1SourceAdapterManifest.sourceTypeKey,
    connectionTypeKey:
      dataforrestEventsV1SourceAdapterManifest.compatibleConnectionTypeKey,
    displayName: "Shared DataForrest fixture",
    requestLimit:
      dataforrestEventsV1SourceAdapterManifest.maximumPlatformRequestCap,
    sourceAdapterVersion: dataforrestEventsV1SourceAdapterManifest.adapterVersion,
    encryptedConfiguration: encrypted,
    configurationFingerprint: createHash("sha256")
      .update(encrypted.ciphertext)
      .digest("hex"),
    actorKey: actor,
    createdAt: await databaseNow(input.database),
  });
  const providers = input.providers ?? [
    "courtyard",
    "collector_crypt",
    "phygitals",
    "clutchpacks",
  ] as const;
  assert.equal(input.intervals.length, providers.length);
  if (input.recordsPerRequest) {
    assert.equal(input.recordsPerRequest.length, providers.length);
  }
  const sources = [] as Array<Readonly<{
    provider: LaunchProviderKey;
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
    intervalSeconds: number;
    recordsPerRequest: number;
  }>>;
  for (const [index, provider] of providers.entries()) {
    const createdAt = await databaseNow(input.database);
    const providerId = await setup.createProviderSource({
      organizationId,
      platformKey: provider,
      displayName: provider,
      createdAt,
    });
    await setup.createConfigRevision({
      organizationId,
      providerId,
      version: 1,
      adapterKey: "http-cursor-v1",
      endpointUrl: `https://${provider}.example.test/unused`,
      authMode: "none",
      createdByActorKey: actor,
      createdAt,
    });
    const descriptor = launchSourceMapperDescriptors.find(
      (candidate) => candidate.provider === provider,
    )!;
    const source = await lifecycle.createSourceInstanceRevision({
      organizationId,
      providerId,
      connectionProfileId: profileId,
      sourceTypeKey: dataforrestEventsV1SourceAdapterManifest.sourceTypeKey,
      sourceAdapterVersion: dataforrestEventsV1SourceAdapterManifest.adapterVersion,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      mapperKey: descriptor.mapperKey,
      mapperVersion: descriptor.mapperVersion,
      identityNamespaceKey: providerIdentityNamespaceByLaunchProvider[provider],
      cursorCodecVersion:
        dataforrestEventsV1SourceAdapterManifest.cursorCodecKey,
      revisionNumber: 1,
      intervalSeconds: input.intervals[index]!,
      recordsPerRequest: input.recordsPerRequest?.[index] ?? 500,
      configuration: { platform: provider },
      configurationHash: String(index + 1).repeat(64),
      recordIdScopes: launchRecordIdScopeDeclarations.map(
        ({ recordIdScopeKey }) => recordIdScopeKey,
      ),
      actorKey: actor,
      createdAt,
    });
    sources.push({
      provider,
      providerId,
      ...source,
      intervalSeconds: input.intervals[index]!,
      recordsPerRequest: input.recordsPerRequest?.[index] ?? 500,
    });
  }
  const activatedAt = await databaseNow(input.database);
  await input.database.$transaction(async (transaction) => {
    await transaction.source_connection_revisions.update({
      where: { id: revisionId },
      data: { state: "active", activated_at: activatedAt },
    });
    await transaction.source_connection_profiles.update({
      where: { id: profileId },
      data: {
        state: "active",
        active_revision_id: revisionId,
        updated_at: activatedAt,
      },
    });
    for (const source of sources) {
      await transaction.provider_sources.update({
        where: { id: source.providerId },
        data: { state: "active", updated_at: activatedAt },
      });
      await transaction.provider_source_instances.update({
        where: { id: source.sourceInstanceId },
        data: {
          state: "active",
          activated_at: activatedAt,
          updated_at: activatedAt,
        },
      });
      await transaction.provider_source_schedules.update({
        where: { source_instance_id: source.sourceInstanceId },
        data: { next_due_at: new Date(activatedAt.getTime() + 86_400_000) },
      });
    }
  });
  const runs = new ProviderSourceImportRunRepository(input.database);
  for (const source of sources) {
    const requested = await runs.requestRun({
      organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: actor,
      requestedAt: await databaseNow(input.database),
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    assert.equal(requested.kind, "created");
  }
  return { organizationId, profileId, revisionId, cipher, sources };
}

async function createAlternateFixture(
  database: PackscoutPrismaClient,
) {
  const setup = new PipelineSetupRepository(database);
  const lifecycle = new ProviderSourceLifecycleRepository(database);
  const createdAt = await databaseNow(database);
  const organizationId = await setup.createOrganization({
    slug: "runtime-e2e-alternate",
    name: "Runtime e2e alternate",
    createdAt,
  });
  const profileId = randomUUID();
  const revisionId = randomUUID();
  const cipher = new AesGcmSourceConnectionConfigurationCipher({
    primaryVersion: 1,
    keys: new Map([[1, encryptionKey]]),
  });
  const encrypted = cipher.encrypt(JSON.stringify({ channel: "fixture" }), {
    organizationId,
    connectionProfileId: profileId,
    connectionRevisionId: revisionId,
  });
  await new SourceConnectionAdminRepository(database).createConnectionProfile({
    organizationId,
    profileId,
    revisionId,
    sourceTypeKey: alternateBookmarkSourceManifest.sourceTypeKey,
    connectionTypeKey: alternateBookmarkSourceManifest.compatibleConnectionTypeKey,
    displayName: "Alternate bookmark fixture",
    requestLimit: alternateBookmarkSourceManifest.maximumPlatformRequestCap,
    sourceAdapterVersion: alternateBookmarkSourceManifest.adapterVersion,
    encryptedConfiguration: encrypted,
    configurationFingerprint: createHash("sha256")
      .update(encrypted.ciphertext)
      .digest("hex"),
    actorKey: actor,
    createdAt,
  });
  const providerId = await setup.createProviderSource({
    organizationId,
    platformKey: "courtyard",
    displayName: "Alternate Courtyard",
    createdAt,
  });
  await setup.createConfigRevision({
    organizationId,
    providerId,
    version: 1,
    adapterKey: "http-cursor-v1",
    endpointUrl: "https://alternate.example.test/unused",
    authMode: "none",
    createdByActorKey: actor,
    createdAt,
  });
  const descriptor = launchSourceMapperDescriptors.find(
    ({ provider }) => provider === "courtyard",
  )!;
  const source = await lifecycle.createSourceInstanceRevision({
    organizationId,
    providerId,
    connectionProfileId: profileId,
    sourceTypeKey: alternateBookmarkSourceManifest.sourceTypeKey,
    sourceAdapterVersion: alternateBookmarkSourceManifest.adapterVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    mapperKey: descriptor.mapperKey,
    mapperVersion: descriptor.mapperVersion,
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
    cursorCodecVersion: alternateBookmarkSourceManifest.cursorCodecKey,
    revisionNumber: 1,
    intervalSeconds: 60,
    configuration: { partition: "courtyard" },
    configurationHash: "e".repeat(64),
    recordIdScopes: launchRecordIdScopeDeclarations.map(
      ({ recordIdScopeKey }) => recordIdScopeKey,
    ),
    actorKey: actor,
    createdAt,
  });
  await database.$transaction(async (transaction) => {
    await transaction.source_connection_revisions.update({
      where: { id: revisionId },
      data: { state: "active", activated_at: createdAt },
    });
    await transaction.source_connection_profiles.update({
      where: { id: profileId },
      data: {
        state: "active",
        active_revision_id: revisionId,
        updated_at: createdAt,
      },
    });
    await transaction.provider_sources.update({
      where: { id: providerId },
      data: { state: "active", updated_at: createdAt },
    });
    await transaction.provider_source_instances.update({
      where: { id: source.sourceInstanceId },
      data: { state: "active", activated_at: createdAt, updated_at: createdAt },
    });
    await transaction.provider_source_schedules.update({
      where: { source_instance_id: source.sourceInstanceId },
      data: { next_due_at: new Date(createdAt.getTime() + 86_400_000) },
    });
  });
  const requested = await new ProviderSourceImportRunRepository(database).requestRun({
    organizationId,
    providerId,
    runId: randomUUID(),
    trigger: "manual",
    requestedByActorKey: actor,
    requestedAt: await databaseNow(database),
    expectedSourceRevisionId: source.sourceRevisionId,
  });
  assert.equal(requested.kind, "created");
  return { organizationId, providerId, profileId, revisionId, cipher, source };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("real supervisor overlaps four source lanes and advances sequential pages to poll-after", async () => {
  const fixture = await createMigratedTestDatabase();
  const firstWaveStarted = deferred();
  const releaseFirstWave = deferred();
  const activeByProvider = new Map<LaunchProviderKey, number>();
  const maximumByProvider = new Map<LaunchProviderKey, number>();
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const httpClient: PinnedProviderHttpClient = async (url) => {
    const provider = url.searchParams.get("platform") as LaunchProviderKey;
    assert.ok(provider in dataforestEventsV1EvidenceFixture);
    active += 1;
    calls += 1;
    maximumActive = Math.max(maximumActive, active);
    const providerActive = (activeByProvider.get(provider) ?? 0) + 1;
    activeByProvider.set(provider, providerActive);
    maximumByProvider.set(
      provider,
      Math.max(maximumByProvider.get(provider) ?? 0, providerActive),
    );
    if (calls === 4) firstWaveStarted.resolve();
    if (calls <= 4) await releaseFirstWave.promise;
    const cursor = url.searchParams.get("cursor");
    const pages = dataforestEventsV1EvidenceFixture[provider];
    const body = cursor === null
      ? pages.initial
      : cursor === pages.initial.next_cursor
        ? pages.continuation
        : pages.reachedHead;
    active -= 1;
    activeByProvider.set(provider, providerActive - 1);
    return jsonResponse(body);
  };
  let supervisor: ProviderSourceSupervisor<ProviderSourceSupervisorClaimedWork>
    | null = null;
  const pageFailures: unknown[] = [];
  try {
    const setup = await createDataforrestFixture({
      database: fixture.database,
      testKey: "parallel-pages",
      intervals: [60, 120, 180, 240],
    });
    const adapter = new DataforrestEventsSourceAdapter({
      httpClient,
      resolveHost: async () => ["198.204.245.26"],
    });
    supervisor = createRealSupervisor({
      database: fixture.database,
      cipher: setup.cipher,
      sourceAdapters: new SourceAdapterRegistry([adapter]),
      environmentKey: "runtime-e2e-parallel-pages",
      pageFailures,
    });
    await supervisor.initialize();
    await supervisor.runCycle();
    await waitFor(async () => {
      const runs = await fixture.database.import_runs.findMany({
        select: { id: true, state: true, failure_code: true },
        orderBy: { created_at: "asc" },
      });
      assert.ok(calls >= 4, JSON.stringify(runs));
    }, 3_000);
    await firstWaveStarted.promise;
    assert.equal(maximumActive, 4);
    releaseFirstWave.resolve();
    await waitFor(async () => {
      const [pageCount, runs] = await Promise.all([
        fixture.database.import_pages.count(),
        fixture.database.import_runs.findMany({
          select: { state: true, failure_code: true, failure_summary: true },
          orderBy: { created_at: "asc" },
        }),
      ]);
      assert.equal(pageCount, 4, JSON.stringify({
        runs,
        pageFailures: pageFailures.map((error) =>
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                code: "code" in error ? error.code : null,
              }
            : error
        ),
      }));
    });
    await supervisor.runCycle();
    await waitFor(async () => {
      assert.equal(await fixture.database.import_pages.count(), 8);
    });
    await supervisor.runCycle();
    await waitFor(async () => {
      assert.equal(await fixture.database.import_pages.count(), 12);
      assert.equal(await fixture.database.import_runs.count({
        where: { state: "succeeded" },
      }), 4);
    });
    assert.equal(calls, 12);
    assert.equal(maximumActive, 4);
    assert.deepEqual(
      Object.fromEntries(maximumByProvider),
      {
        courtyard: 1,
        collector_crypt: 1,
        phygitals: 1,
        clutchpacks: 1,
      },
    );
    for (const source of setup.sources) {
      const [sourceCursor, schedule, pages, diagnostics] = await Promise.all([
        fixture.database.provider_source_cursors.findUniqueOrThrow({
          where: { source_instance_id: source.sourceInstanceId },
        }),
        fixture.database.provider_source_schedules.findUniqueOrThrow({
          where: { source_instance_id: source.sourceInstanceId },
        }),
        fixture.database.import_pages.findMany({
          where: { source_instance_id: source.sourceInstanceId },
          orderBy: { page_number: "asc" },
        }),
        fixture.database.source_processor_diagnostic_events.findMany({
          where: { source_instance_id: source.sourceInstanceId },
          orderBy: [{ occurred_at: "asc" }, { id: "asc" }],
        }),
      ]);
      assert.equal(
        sourceCursor.cursor,
        dataforestEventsV1EvidenceFixture[source.provider].reachedHead.next_cursor,
      );
      assert.deepEqual(pages.map(({ page_number }) => page_number), [1, 2, 3]);
      assert.deepEqual(
        pages.map(({ continuation_kind }) => continuation_kind),
        ["continue", "continue", "poll_after"],
      );
      const head = pages[2]!.committed_at;
      assert.ok(
        schedule.next_due_at.getTime() >=
          head.getTime() + source.intervalSeconds * 1_000,
      );
      assert.equal(
        diagnostics.filter(({ phase }) => phase === "work_claimed").length,
        3,
      );
      assert.equal(
        diagnostics.filter(({ phase }) => phase === "adapter_request_started")
          .length,
        3,
      );
      assert.equal(
        diagnostics.filter(({ safe_code }) => safe_code === "PAGE_COMMITTED")
          .length,
        3,
      );
      assert.equal(
        diagnostics.filter(({ phase }) => phase === "head_reached").length,
        1,
      );
    }
    await supervisor.runCycle();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 12, "frequent DB polling made an early upstream call");
  } finally {
    await supervisor?.stop().catch(() => undefined);
    await fixture.close();
  }
});

test("an over-pin provider page fails before import while a sibling lane continues", async () => {
  const fixture = await createMigratedTestDatabase();
  const requestedLimits = new Map<LaunchProviderKey, string | null>();
  const importedSourceInstanceIds: string[] = [];
  const pageFailures: unknown[] = [];
  const httpClient: PinnedProviderHttpClient = async (url) => {
    const provider = url.searchParams.get("platform") as LaunchProviderKey;
    requestedLimits.set(provider, url.searchParams.get("limit"));
    return jsonResponse(dataforestEventsV1EvidenceFixture[provider].initial);
  };
  let supervisor: ProviderSourceSupervisor<ProviderSourceSupervisorClaimedWork>
    | null = null;
  try {
    const setup = await createDataforrestFixture({
      database: fixture.database,
      testKey: "records-per-request-over-pin",
      intervals: [60, 60],
      providers: ["courtyard", "collector_crypt"],
      recordsPerRequest: [1, 500],
    });
    const target = setup.sources[0]!;
    const sibling = setup.sources[1]!;
    supervisor = createRealSupervisor({
      database: fixture.database,
      cipher: setup.cipher,
      sourceAdapters: new SourceAdapterRegistry([
        new DataforrestEventsSourceAdapter({
          httpClient,
          resolveHost: async () => ["198.204.245.26"],
        }),
      ]),
      environmentKey: "runtime-e2e-records-per-request-over-pin",
      pageFailures,
      importedSourceInstanceIds,
    });
    await supervisor.initialize();
    await supervisor.runCycle();
    await waitFor(async () => {
      const [targetRun, siblingPages] = await Promise.all([
        fixture.database.import_runs.findFirstOrThrow({
          where: { source_instance_id: target.sourceInstanceId },
          orderBy: { created_at: "desc" },
        }),
        fixture.database.import_pages.count({
          where: { source_instance_id: sibling.sourceInstanceId },
        }),
      ]);
      assert.equal(targetRun.state, "failed");
      assert.equal(targetRun.failure_code, "INVALID_RESPONSE");
      assert.equal(siblingPages, 1);
    });

    const [targetPages, targetIdentities, targetDeliveries, targetEvRequests,
      targetCursor, targetRuntime, siblingRuntime] = await Promise.all([
      fixture.database.import_pages.count({
        where: { source_instance_id: target.sourceInstanceId },
      }),
      fixture.database.source_record_identities.count({
        where: { source_instance_id: target.sourceInstanceId },
      }),
      fixture.database.source_delivery_occurrences.count({
        where: { source_instance_id: target.sourceInstanceId },
      }),
      fixture.database.estimated_ev_recomputation_requests.count({
        where: { source_instance_id: target.sourceInstanceId },
      }),
      fixture.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: target.sourceInstanceId },
      }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: target.sourceInstanceId },
      }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: sibling.sourceInstanceId },
      }),
    ]);
    assert.equal(requestedLimits.get("courtyard"), "1");
    assert.equal(requestedLimits.get("collector_crypt"), "500");
    assert.equal(targetPages, 0);
    assert.equal(targetIdentities, 0);
    assert.equal(targetDeliveries, 0);
    assert.equal(targetEvRequests, 0);
    assert.equal(targetCursor.cursor, null);
    assert.equal(targetRuntime.activity, "action_required");
    assert.equal(targetRuntime.action_required_code, "INVALID_RESPONSE");
    assert.notEqual(siblingRuntime.activity, "action_required");
    assert.equal(importedSourceInstanceIds.includes(target.sourceInstanceId), false);
    assert.equal(importedSourceInstanceIds.includes(sibling.sourceInstanceId), true);
    assert.deepEqual(pageFailures, []);
    assert.equal(supervisor.state, "active");
  } finally {
    await supervisor?.stop().catch(() => undefined);
    await fixture.close();
  }
});

test("test-only alternate adapter uses the unchanged supervisor and durable page path", async () => {
  const fixture = await createMigratedTestDatabase();
  let supervisor: ProviderSourceSupervisor<ProviderSourceSupervisorClaimedWork>
    | null = null;
  try {
    const setup = await createAlternateFixture(fixture.database);
    const adapter = new AlternateBookmarkSourceAdapter();
    supervisor = createRealSupervisor({
      database: fixture.database,
      cipher: setup.cipher,
      sourceAdapters: new SourceAdapterRegistry([adapter]),
      environmentKey: "runtime-e2e-alternate",
    });
    await supervisor.initialize();
    await supervisor.runCycle();
    await waitFor(async () => {
      assert.equal(await fixture.database.import_pages.count(), 1);
      assert.equal(await fixture.database.import_runs.count({
        where: { state: "succeeded" },
      }), 1);
    });
    assert.equal(adapter.captureCount, 1);
    const [sourceCursor, page, events] = await Promise.all([
      fixture.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: setup.source.sourceInstanceId },
      }),
      fixture.database.import_pages.findFirstOrThrow({
        where: { source_instance_id: setup.source.sourceInstanceId },
      }),
      fixture.database.source_processor_diagnostic_events.findMany({
        where: { source_instance_id: setup.source.sourceInstanceId },
      }),
    ]);
    assert.equal(sourceCursor.cursor, "alternate-bookmark-001");
    assert.equal(page.continuation_kind, "poll_after");
    assert.equal(page.minimum_delay_seconds, 60);
    assert.equal(
      events.filter(({ phase }) => phase === "work_claimed").length,
      1,
    );
    assert.equal(
      events.filter(({ phase }) => phase === "adapter_request_started").length,
      1,
    );
    assert.equal(
      events.filter(({ safe_code }) => safe_code === "PAGE_COMMITTED").length,
      1,
    );
    assert.equal(
      events.filter(({ phase }) => phase === "head_reached").length,
      1,
    );
    await supervisor.runCycle();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(adapter.captureCount, 1);
  } finally {
    await supervisor?.stop().catch(() => undefined);
    await fixture.close();
  }
});

test("a failed disabled-source test terminalizes once without fencing the supervisor", async () => {
  const fixture = await createMigratedTestDatabase();
  let supervisor: ProviderSourceSupervisor<ProviderSourceSupervisorClaimedWork>
    | null = null;
  try {
    const setup = await createAlternateFixture(fixture.database);
    const lifecycle = new ProviderSourceAdminLifecycleRepository(fixture.database);
    const disabledAt = await databaseNow(fixture.database);
    await lifecycle.disable({
      organizationId: setup.organizationId,
      providerId: setup.providerId,
      sourceInstanceId: setup.source.sourceInstanceId,
      expectedSourceRevisionId: setup.source.sourceRevisionId,
      actorKey: actor,
      disabledAt,
    });
    const job = await lifecycle.requestSourceTest({
      organizationId: setup.organizationId,
      providerId: setup.providerId,
      sourceInstanceId: setup.source.sourceInstanceId,
      sourceRevisionId: setup.source.sourceRevisionId,
      connectionProfileId: setup.profileId,
      connectionRevisionId: setup.revisionId,
      requestedByActorKey: actor,
      requestedAt: await databaseNow(fixture.database),
    });
    const adapter = new AlternateBookmarkSourceAdapter(null);
    supervisor = createRealSupervisor({
      database: fixture.database,
      cipher: setup.cipher,
      sourceAdapters: new SourceAdapterRegistry([adapter]),
      environmentKey: "runtime-e2e-failed-source-test",
    });
    await supervisor.initialize();
    await supervisor.runCycle();
    await waitFor(async () => {
      assert.equal((await fixture.database.provider_source_test_jobs
        .findUniqueOrThrow({ where: { id: job.jobId } })).state, "failed");
      assert.equal(await fixture.database.provider_source_test_results.count({
        where: { job_id: job.jobId, outcome: "failure" },
      }), 1);
    });
    await supervisor.runCycle();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const [runtime, result, attempts, terminalEvents, openEpisodes, epochs] =
      await Promise.all([
        fixture.database.provider_source_runtime_states.findUniqueOrThrow({
          where: { source_instance_id: setup.source.sourceInstanceId },
        }),
        fixture.database.provider_source_test_results.findUniqueOrThrow({
          where: { job_id: job.jobId },
        }),
        fixture.database.compact_source_request_attempts.findMany({
          where: { source_test_job_id: job.jobId },
        }),
        fixture.database.source_processor_diagnostic_events.findMany({
          where: {
            source_test_job_id: job.jobId,
            correlation_kind: "source_test",
            phase: "terminal",
          },
        }),
        fixture.database.source_connection_health_episodes.count({
          where: { connection_profile_id: setup.profileId, closed_at: null },
        }),
        fixture.database.source_supervisor_epochs.findMany(),
      ]);
    assert.equal(supervisor.state, "active");
    assert.equal(adapter.captureCount, 1);
    assert.equal(result.outcome, "failure");
    assert.equal(result.safe_code, "invalid_response");
    assert.equal(runtime.phase, "terminal");
    assert.equal(runtime.activity, "inactive");
    assert.equal(runtime.action_required_code, null);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.terminal_state, "captured");
    assert.equal(terminalEvents.length, 1);
    assert.equal(terminalEvents[0]!.severity, "warning");
    assert.equal(terminalEvents[0]!.safe_code, "INVALID_RESPONSE");
    assert.equal(terminalEvents[0]!.request_attempt_id, result.request_attempt_id);
    assert.equal(openEpisodes, 0);
    assert.equal(epochs.length, 1);
    assert.equal(epochs[0]!.state, "active");
  } finally {
    await supervisor?.stop().catch(() => undefined);
    await fixture.close();
  }
});

test("a data-plane page commit is awaited once beyond the control-plane deadline", async () => {
  const fixture = await createMigratedTestDatabase();
  const pageImportStarted = deferred();
  const releasePageImport = deferred();
  let pageImportCalls = 0;
  let supervisor: ProviderSourceSupervisor<ProviderSourceSupervisorClaimedWork>
    | null = null;
  try {
    const setup = await createAlternateFixture(fixture.database);
    supervisor = createRealSupervisor({
      database: fixture.database,
      cipher: setup.cipher,
      sourceAdapters: new SourceAdapterRegistry([
        new AlternateBookmarkSourceAdapter(),
      ]),
      environmentKey: "runtime-e2e-slow-page-commit",
      beforePageImport: async () => {
        pageImportCalls += 1;
        pageImportStarted.resolve();
        await releasePageImport.promise;
      },
    });
    await supervisor.initialize();
    await supervisor.runCycle();
    await pageImportStarted.promise;
    await new Promise<void>((resolve) => setTimeout(
      resolve,
      providerSourceControlPlaneRetry.transactionTimeoutMilliseconds +
        providerSourceControlPlaneRetry.backoffMilliseconds[1] + 100,
    ));
    assert.equal(pageImportCalls, 1);
    assert.equal(supervisor.state, "active");
    assert.equal(await fixture.database.import_pages.count(), 0);

    releasePageImport.resolve();
    await waitFor(async () => {
      assert.equal(await fixture.database.import_pages.count(), 1);
      assert.equal(await fixture.database.import_runs.count({
        where: { state: "succeeded" },
      }), 1);
    });
  } finally {
    releasePageImport.resolve();
    await supervisor?.stop().catch(() => undefined);
    await fixture.close();
  }
});

test("transient page retry keeps the exact cursor and cannot run before DB backoff", async () => {
  const fixture = await createMigratedTestDatabase();
  const requestedCursors: Array<string | null> = [];
  let calls = 0;
  const httpClient: PinnedProviderHttpClient = async (url) => {
    calls += 1;
    requestedCursors.push(url.searchParams.get("cursor"));
    if (calls === 1) throw new Error("synthetic network interruption");
    return jsonResponse(dataforestEventsV1EvidenceFixture.courtyard.initial);
  };
  let supervisor: ProviderSourceSupervisor<ProviderSourceSupervisorClaimedWork>
    | null = null;
  try {
    const setup = await createDataforrestFixture({
      database: fixture.database,
      testKey: "retry-same-cursor",
      intervals: [60],
      providers: ["courtyard"],
    });
    supervisor = createRealSupervisor({
      database: fixture.database,
      cipher: setup.cipher,
      sourceAdapters: new SourceAdapterRegistry([
        new DataforrestEventsSourceAdapter({
          httpClient,
          resolveHost: async () => ["198.204.245.26"],
        }),
      ]),
      environmentKey: "runtime-e2e-retry",
    });
    await supervisor.initialize();
    await supervisor.runCycle();
    let retryNotBefore!: Date;
    await waitFor(async () => {
      const [runtime, run] = await Promise.all([
        fixture.database.provider_source_runtime_states.findUniqueOrThrow({
          where: { source_instance_id: setup.sources[0]!.sourceInstanceId },
        }),
        fixture.database.import_runs.findFirstOrThrow(),
      ]);
      assert.equal(calls, 1);
      assert.equal(run.state, "queued");
      assert.equal(runtime.phase, "retry_wait");
      assert.equal(runtime.retry_attempt, 1);
      assert.ok(runtime.retry_not_before);
      retryNotBefore = runtime.retry_not_before;
    });
    const retryEvent = await fixture.database.source_processor_diagnostic_events
      .findFirstOrThrow({ where: { phase: "retry_scheduled" } });
    assert.equal(retryEvent.retry_delay_ms, 1_000);
    assert.equal(retryEvent.correlation_kind, "page");
    assert.ok(retryEvent.request_attempt_id);
    assert.ok(retryEvent.duration_ms !== null);
    assert.deepEqual(retryEvent.evidence_json, { attempt_state: "failed" });
    assert.equal(
      retryNotBefore.getTime() - retryEvent.occurred_at.getTime(),
      1_000,
    );
    assert.equal(await fixture.database.import_pages.count(), 0);
    assert.equal((await fixture.database.provider_source_cursors
      .findUniqueOrThrow({
        where: { source_instance_id: setup.sources[0]!.sourceInstanceId },
      })).cursor, null);

    await supervisor.runCycle();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 1, "retry ran before the authoritative DB deadline");
    await new Promise<void>((resolve) => setTimeout(
      resolve,
      Math.max(0, retryNotBefore.getTime() - Date.now() + 30),
    ));
    await supervisor.runCycle();
    await waitFor(async () => {
      assert.equal(await fixture.database.import_pages.count(), 1);
    });
    assert.equal(calls, 2);
    assert.deepEqual(requestedCursors, [null, null]);
  } finally {
    await supervisor?.stop().catch(() => undefined);
    await fixture.close();
  }
});

test("transient page exhaustion applies the exact three durable backoffs", async () => {
  const fixture = await createMigratedTestDatabase();
  let calls = 0;
  const httpClient: PinnedProviderHttpClient = async () => {
    calls += 1;
    throw new Error("synthetic persistent network interruption");
  };
  let supervisor: ProviderSourceSupervisor<ProviderSourceSupervisorClaimedWork>
    | null = null;
  try {
    const setup = await createDataforrestFixture({
      database: fixture.database,
      testKey: "retry-exhaustion",
      intervals: [60],
      providers: ["courtyard"],
    });
    supervisor = createRealSupervisor({
      database: fixture.database,
      cipher: setup.cipher,
      sourceAdapters: new SourceAdapterRegistry([
        new DataforrestEventsSourceAdapter({
          httpClient,
          resolveHost: async () => ["198.204.245.26"],
        }),
      ]),
      environmentKey: "runtime-e2e-retry-exhaustion",
    });
    await supervisor.initialize();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await supervisor.runCycle();
      await waitFor(async () => {
        const run = await fixture.database.import_runs.findFirstOrThrow();
        assert.equal(calls, attempt);
        assert.equal(run.state, attempt < 4 ? "queued" : "failed");
      });
      if (attempt < 4) {
        await fixture.database.provider_source_runtime_states.update({
          where: { source_instance_id: setup.sources[0]!.sourceInstanceId },
          data: { retry_not_before: new Date(0) },
        });
      }
    }
    const [runtime, sourceCursor, attempts, retryEvents, terminalEvent] =
      await Promise.all([
        fixture.database.provider_source_runtime_states.findUniqueOrThrow({
          where: { source_instance_id: setup.sources[0]!.sourceInstanceId },
        }),
        fixture.database.provider_source_cursors.findUniqueOrThrow({
          where: { source_instance_id: setup.sources[0]!.sourceInstanceId },
        }),
        fixture.database.compact_source_request_attempts.count({
          where: { source_instance_id: setup.sources[0]!.sourceInstanceId },
        }),
        fixture.database.source_processor_diagnostic_events.findMany({
          where: {
            source_instance_id: setup.sources[0]!.sourceInstanceId,
            phase: "retry_scheduled",
          },
          orderBy: { occurred_at: "asc" },
        }),
        fixture.database.source_processor_diagnostic_events.findFirstOrThrow({
          where: {
            source_instance_id: setup.sources[0]!.sourceInstanceId,
            phase: "terminal",
            safe_code: "TRANSIENT_RETRIES_EXHAUSTED",
          },
        }),
      ]);
    assert.equal(supervisor.state, "active");
    assert.equal(runtime.activity, "action_required");
    assert.equal(runtime.action_required_code, "TRANSIENT_RETRIES_EXHAUSTED");
    assert.equal(sourceCursor.cursor, null);
    assert.equal(attempts, 4);
    assert.deepEqual(
      retryEvents.map(({ retry_delay_ms }) => retry_delay_ms),
      [1_000, 5_000, 15_000],
    );
    assert.ok(retryEvents.every((event) =>
      event.correlation_kind === "page" &&
      event.request_attempt_id !== null &&
      event.duration_ms !== null
    ));
    assert.equal(terminalEvent.severity, "warning");
    assert.equal(terminalEvent.correlation_kind, "page");
    assert.ok(terminalEvent.request_attempt_id);
    assert.ok(terminalEvent.duration_ms !== null);
  } finally {
    await supervisor?.stop().catch(() => undefined);
    await fixture.close();
  }
});
