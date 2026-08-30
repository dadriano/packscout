import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { DATAFORREST_EVENTS_V1_ENDPOINT } from "@packscout/contracts";
import {
  createProviderDatabaseLifecycle,
  initializeProviderDatabaseIdentity,
  PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
  providerMixedCursorFingerprint,
  providerMixedPageDigest,
  PrismaAdminProviderRuntimeRepository,
  PrismaProviderActivityOutboxRepository,
  PrismaProviderCommandRepository,
  PrismaProviderRuntimeRepository,
  PrismaProviderWorkerLeaseRepository,
  providerDatabaseTarget,
  type ProviderDatabaseRoute,
  type ProviderPrismaClient,
} from "@packscout/database";
import type { ResolvedDataforrestSourceAuthority } from
  "./dataforrest-source-authority-resolver.ts";
import {
  providerDataforrestLiveIntegrationRegistry,
  type ProviderDataforrestLiveIntegration,
} from "./provider-dataforrest-live-integration.ts";
import {
  ProviderManualImportExecutor,
  type ProviderManualImportPageSource,
} from "./provider-manual-import-executor.ts";
import { ProviderCaptureMixedPageSource } from
  "./provider-capture-mixed-page-source.ts";
import {
  CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
  CLUTCHPACKS_CAPTURE_FILE_NAME,
  ProviderCaptureSourceError,
} from "./provider-capture-source-contract.ts";
import { runProviderManualImportOnce } from
  "./provider-manual-import-local-runtime.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const databasePackage = path.join(repositoryRoot, "packages/database");
const providerSchema = path.join(
  databasePackage,
  "prisma/provider/schema.prisma",
);
const prismaExecutable = path.join(
  repositoryRoot,
  "node_modules/prisma/build/index.js",
);
const disposableDatabasePattern =
  /^packscout_(?:clutch|courtyard)_test_[0-9]+_[a-f0-9]{10}$/u;

interface ProviderHarness {
  readonly client: ProviderPrismaClient;
  readonly providerId: string;
  readonly providerKey: string;
  close(): Promise<void>;
}

function adminUrl(): URL {
  const configured = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
    ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
  const parsed = new URL(configured);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("PostgreSQL 16 test infrastructure is required.");
  }
  return parsed;
}

function databaseUrl(source: URL, databaseName: string): string {
  const result = new URL(source);
  result.pathname = `/${databaseName}`;
  result.search = "";
  result.hash = "";
  return result.toString();
}

async function createHarness(
  providerLabel: "clutch" | "courtyard" = "clutch",
  exactProviderKey?: "clutchpacks" | "courtyard",
): Promise<ProviderHarness> {
  const rootUrl = adminUrl();
  const databaseKey =
    `${providerLabel}_test_${process.pid}_${randomBytes(5).toString("hex")}`;
  const providerKey = exactProviderKey ?? databaseKey;
  const databaseName = `packscout_${providerKey}`;
  if (
    exactProviderKey === undefined
      ? !disposableDatabasePattern.test(databaseName)
      : process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL === undefined
  ) {
    throw new Error("Refusing to create an unscoped provider test database.");
  }
  const administrator = new Pool({ connectionString: rootUrl.toString(), max: 1 });
  const providerDatabaseUrl = databaseUrl(rootUrl, databaseName);
  let created = false;
  let client: ProviderPrismaClient | undefined;
  try {
    const version = await administrator.query<{ server_version_num: string }>(
      "show server_version_num",
    );
    if (Number(version.rows[0]?.server_version_num ?? 0) < 160_000) {
      throw new Error("PostgreSQL 16 test infrastructure is required.");
    }
    const existing = await administrator.query<{ exists: boolean }>(
      "select exists(select 1 from pg_database where datname = $1) as exists",
      [databaseName],
    );
    if (existing.rows[0]?.exists) {
      throw new Error("Refusing to replace an existing provider test database.");
    }
    await administrator.query(`create database "${databaseName}"`);
    created = true;
    await execFileAsync(
      process.execPath,
      [prismaExecutable, "migrate", "deploy", "--schema", providerSchema],
      {
        cwd: databasePackage,
        env: {
          ...process.env,
          PACKSCOUT_PROVIDER_DATABASE_URL: providerDatabaseUrl,
        },
      },
    );
    const providerId = randomUUID();
    client = createProviderDatabaseLifecycle({
      databaseUrl: providerDatabaseUrl,
      providerId,
      providerKey,
      connectionLimit: 2,
    }).client;
    await client.$connect();
    await initializeProviderDatabaseIdentity({
      client,
      providerId,
      providerKey,
    });
    return {
      client,
      providerId,
      providerKey,
      async close() {
        await client?.$disconnect();
        if (created) {
          await administrator.query(
            `drop database "${databaseName}" with (force)`,
          );
          created = false;
        }
        await administrator.end();
      },
    };
  } catch (error) {
    await client?.$disconnect().catch(() => undefined);
    if (created) {
      await administrator.query(
        `drop database "${databaseName}" with (force)`,
      ).catch(() => undefined);
    }
    await administrator.end().catch(() => undefined);
    throw error;
  }
}

function isolatedClutchSource(captureRoot: string): ProviderManualImportPageSource {
  const source = new ProviderCaptureMixedPageSource({
    captureRoot,
    actorHmacKey: Buffer.alloc(32, 0x5a),
  });
  return {
    supports(adapterKey) {
      return source.supports(adapterKey, "clutchpacks");
    },
    nextPage(input) {
      return source.nextPage({
        ...input,
        authority: { ...input.authority, providerKey: "clutchpacks" },
      });
    },
  };
}

function mixedQuarantineSource(
  includeCandidateFailure = true,
): ProviderManualImportPageSource {
  return {
    supports(adapterKey) {
      return adapterKey === CLUTCHPACKS_CAPTURE_ADAPTER_KEY;
    },
    nextPage(input) {
      const records = [
        {
          position: 0,
          providerId: input.authority.providerId,
          kind: "catalog",
          disposition: "quarantine",
          candidate: {},
          sourceRecordKey: `source:${"a".repeat(64)}`,
          reasonCode: "SOURCE_RECORD_MAPPING_INVALID",
          fieldPath: null,
          sanitizedSummary:
            "The validated source record could not be mapped; no retry artifact is retained.",
        },
        ...(includeCandidateFailure ? [{
          position: 1,
          providerId: input.authority.providerId,
          kind: "catalog",
          operation: "upsert",
          entityType: "pack",
          candidate: {},
        }] : []),
      ];
      const body = {
        contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
        providerId: input.authority.providerId,
        runId: input.runId,
        configVersionId: input.authority.configVersionId,
        configVersionNumber: input.authority.configVersionNumber.toString(),
        leaseFence: input.workerFence.toString(),
        pageId: randomUUID(),
        pageNumber: input.pageNumber,
        inputCursor: input.sourceCheckpoint,
        inputCursorFingerprint: input.sourceCheckpointFingerprint,
        nextCursor: null,
        nextCursorFingerprint: null,
        continuation: "head",
        records,
      };
      return Promise.resolve({
        ...body,
        responseDigest: providerMixedPageDigest(body),
      });
    },
  };
}

const deferredPackKey = "pack:deferred-catalog";
const deferredCollectibleKey = "collectible:deferred-catalog";
const deferredPullKey = "pull:deferred-catalog";
const deferredEventKey = "event:deferred-catalog";
const deferredPageCursor = { after: "deferred-facts" } as const;

function deferredCatalogSource(
  assertFirstPage: (runId: string) => Promise<void>,
): ProviderManualImportPageSource {
  let requestCount = 0;
  return {
    supports(adapterKey) {
      return adapterKey === CLUTCHPACKS_CAPTURE_ADAPTER_KEY;
    },
    async nextPage(input) {
      requestCount += 1;
      assert.equal(input.pageNumber, requestCount);
      const firstPage = requestCount === 1;
      if (!firstPage) {
        assert.equal(requestCount, 2);
        assert.deepEqual(input.sourceCheckpoint, deferredPageCursor);
        assert.equal(
          input.sourceCheckpointFingerprint,
          providerMixedCursorFingerprint(deferredPageCursor),
        );
        await assertFirstPage(input.runId);
      } else {
        assert.equal(input.sourceCheckpoint, null);
        assert.equal(input.sourceCheckpointFingerprint, null);
      }

      const nextCursor = firstPage ? deferredPageCursor : null;
      const records = firstPage
        ? [
            {
              position: 0,
              providerId: input.authority.providerId,
              kind: "pull",
              candidate: {
                pullKey: deferredPullKey,
                factDigest: "a".repeat(64),
                packKey: deferredPackKey,
                providerAccountKey: null,
                occurredAt: "2026-08-29T12:00:00.000Z",
                paidAmount: "25",
                paidCurrency: "USD",
                items: [{
                  collectibleKey: deferredCollectibleKey,
                  collectibleInstanceKey: null,
                  quantity: "1",
                  statedValueAmount: "40",
                  statedValueCurrency: "USD",
                }],
              },
            },
            {
              position: 1,
              providerId: input.authority.providerId,
              kind: "market_event",
              candidate: {
                eventKey: deferredEventKey,
                factDigest: "b".repeat(64),
                eventGroupId: null,
                eventType: "sale",
                packKey: deferredPackKey,
                collectibleKey: deferredCollectibleKey,
                collectibleInstanceKey: null,
                fromProviderAccountKey: null,
                toProviderAccountKey: null,
                quantity: "1",
                occurredAt: "2026-08-29T12:01:00.000Z",
                amount: "40",
                currency: "USD",
                details: {},
              },
            },
          ]
        : [
            {
              position: 0,
              providerId: input.authority.providerId,
              kind: "catalog",
              operation: "upsert",
              entityType: "pack",
              candidate: {
                packKey: deferredPackKey,
                categoryKey: null,
                familyKey: null,
                displayName: "Deferred Pack",
                description: null,
                packFormat: "repack",
                availability: "available",
                contentEvidence: "unknown",
                totalInventory: null,
                remainingInventory: null,
                priceAmount: "25",
                priceCurrency: "USD",
                priceUsdAmount: "25",
                priceUnavailableReason: null,
                buybackRate: null,
                buybackSourceKind: null,
                vendorEvAmount: null,
                vendorEvCurrency: null,
                vendorEvObservedAt: null,
                vendorEvUnavailableReason: "source_unavailable",
                packscoutEvAmount: null,
                packscoutEvCurrency: null,
                packscoutEvModelVersion: "not_calculated",
                packscoutEvConfidencePolicyVersion: "not_calculated",
                packscoutEvConfidence: null,
                packscoutEvDataAsOf: null,
                packscoutEvCalculatedAt: null,
                packscoutEvUnavailableReason: "not_calculated",
                primaryImageUrl: null,
                primaryImageAlt: null,
                listingUrl: null,
                attributes: {},
                sourceUpdatedAt: "2026-08-29T12:02:00.000Z",
                expectedRowVersion: null,
              },
            },
            {
              position: 1,
              providerId: input.authority.providerId,
              kind: "catalog",
              operation: "upsert",
              entityType: "collectible",
              candidate: {
                collectibleKey: deferredCollectibleKey,
                categoryKey: null,
                collectibleType: "card",
                displayName: "Deferred Card",
                normalizedName: "deferred card",
                year: null,
                brand: null,
                setOrSeries: null,
                cardNumber: null,
                referenceNumber: null,
                subject: null,
                grade: null,
                grader: null,
                primaryImageUrl: null,
                primaryImageAlt: null,
                valuationAmount: "40",
                valuationCurrency: "USD",
                valuationUsdAmount: "40",
                valuationUnavailableReason: null,
                valuationType: "provider_statement",
                valuationObservedAt: "2026-08-29T12:02:00.000Z",
                dataAsOf: "2026-08-29T12:02:00.000Z",
                attributes: {},
                expectedRowVersion: null,
              },
            },
          ];
      const body = {
        contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
        providerId: input.authority.providerId,
        runId: input.runId,
        configVersionId: input.authority.configVersionId,
        configVersionNumber: input.authority.configVersionNumber.toString(),
        leaseFence: input.workerFence.toString(),
        pageId: randomUUID(),
        pageNumber: input.pageNumber,
        inputCursor: input.sourceCheckpoint,
        inputCursorFingerprint: input.sourceCheckpointFingerprint,
        nextCursor,
        nextCursorFingerprint: providerMixedCursorFingerprint(nextCursor),
        continuation: firstPage ? "more" : "head",
        records,
      };
      return { ...body, responseDigest: providerMixedPageDigest(body) };
    },
  };
}

async function enqueue(
  harness: ProviderHarness,
  configVersionId: string,
  sequence: number,
): Promise<string> {
  const runtime = await new PrismaProviderRuntimeRepository(
    harness.client,
  ).snapshot();
  const result = await new PrismaAdminProviderRuntimeRepository(
    harness.client,
  ).requestRunNow({
    providerId: harness.providerId,
    operatorId: "10000000-0000-4000-8000-000000000001",
    expectedConfigVersionId: configVersionId,
    expectedConfigVersionNumber: 1n,
    expectedGeneration: runtime.generation,
    idempotencyKey: `clutch-integration-${sequence}-${randomUUID()}`,
    commandId: randomUUID(),
    runId: randomUUID(),
    correlationId: randomUUID(),
  });
  assert.equal(result.kind, "created");
  if (result.kind !== "created") throw new Error("Run was not queued.");
  return result.run.id;
}

const parallelCourtyardCursor = Object.freeze({
  after: "courtyard-page-1",
});

interface ParallelProviderBarrier {
  readonly arrivals: ReadonlySet<string>;
  readonly releaseArrivalCount: number | null;
  readonly maximumInFlight: number;
  enter(providerKey: "clutchpacks" | "courtyard"): Promise<void>;
}

function createParallelProviderBarrier(): ParallelProviderBarrier {
  const arrivals = new Set<string>();
  let currentInFlight = 0;
  let maximumInFlight = 0;
  let releaseArrivalCount: number | null = null;
  let release!: () => void;
  const crossed = new Promise<void>((resolve) => { release = resolve; });
  return {
    arrivals,
    get releaseArrivalCount() {
      return releaseArrivalCount;
    },
    get maximumInFlight() {
      return maximumInFlight;
    },
    async enter(providerKey) {
      currentInFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, currentInFlight);
      arrivals.add(providerKey);
      if (arrivals.size === 2) {
        releaseArrivalCount = arrivals.size;
        release();
      }
      try {
        await crossed;
      } finally {
        currentInFlight -= 1;
      }
    },
  };
}

function parallelProviderSource(
  providerKey: "clutchpacks" | "courtyard",
  expectedAdapterKey: string,
  barrier: ParallelProviderBarrier,
  state: { calls: number },
): ProviderManualImportPageSource {
  return {
    supports(adapterKey, requestedProviderKey) {
      return adapterKey === expectedAdapterKey
        && requestedProviderKey === providerKey;
    },
    async nextPage(input) {
      state.calls += 1;
      assert.equal(input.authority.providerKey, providerKey);
      assert.equal(input.authority.configuration.adapterKey, expectedAdapterKey);
      assert.equal(input.pageNumber, state.calls);
      if (state.calls === 1) {
        assert.equal(input.sourceCheckpoint, null);
        assert.equal(input.sourceCheckpointFingerprint, null);
        await barrier.enter(providerKey);
        if (providerKey === "clutchpacks") {
          throw new ProviderCaptureSourceError(
            "PROVIDER_CAPTURE_RECORD_INVALID",
          );
        }
      } else {
        assert.equal(providerKey, "courtyard");
        assert.equal(state.calls, 2);
        assert.deepEqual(input.sourceCheckpoint, parallelCourtyardCursor);
        assert.equal(
          input.sourceCheckpointFingerprint,
          providerMixedCursorFingerprint(parallelCourtyardCursor),
        );
      }
      const nextCursor = state.calls === 1
        ? parallelCourtyardCursor
        : null;
      const body = {
        contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
        providerId: input.authority.providerId,
        runId: input.runId,
        configVersionId: input.authority.configVersionId,
        configVersionNumber: input.authority.configVersionNumber.toString(),
        leaseFence: input.workerFence.toString(),
        pageId: randomUUID(),
        pageNumber: input.pageNumber,
        inputCursor: input.sourceCheckpoint,
        inputCursorFingerprint: input.sourceCheckpointFingerprint,
        nextCursor,
        nextCursorFingerprint: providerMixedCursorFingerprint(nextCursor),
        continuation: nextCursor === null ? "head" : "more",
        records: [],
      };
      return { ...body, responseDigest: providerMixedPageDigest(body) };
    },
  };
}

function requiredLiveIntegration(
  providerKey: "clutchpacks" | "courtyard",
): ProviderDataforrestLiveIntegration {
  const integration = providerDataforrestLiveIntegrationRegistry
    .resolveProvider(providerKey);
  if (integration === null) {
    throw new TypeError(`Missing ${providerKey} live integration fixture.`);
  }
  return integration;
}

test("two disposable provider databases overlap while one source failure remains lane-local", {
  timeout: 180_000,
}, async (context) => {
  if (
    process.env.PACKSCOUT_PROVIDER_PARALLEL_EXECUTION_INTEGRATION !== "1"
    || process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL === undefined
  ) {
    context.skip(
      "Set PACKSCOUT_PROVIDER_PARALLEL_EXECUTION_INTEGRATION=1 and an explicit disposable PACKSCOUT_TEST_ADMIN_DATABASE_URL to run the two-provider proof.",
    );
    return;
  }

  const clutch = await createHarness("clutch", "clutchpacks");
  let courtyard: ProviderHarness | null = null;
  try {
    courtyard = await createHarness("courtyard", "courtyard");
    assert.equal(clutch.providerKey, "clutchpacks");
    assert.equal(courtyard.providerKey, "courtyard");
    assert.notEqual(clutch.client, courtyard.client);

    const definitions = [
      {
        harness: clutch,
        providerKey: "clutchpacks" as const,
        integration: requiredLiveIntegration("clutchpacks"),
        workerId: "parallel:clutchpacks",
      },
      {
        harness: courtyard,
        providerKey: "courtyard" as const,
        integration: requiredLiveIntegration("courtyard"),
        workerId: "parallel:courtyard",
      },
    ];
    const configVersionIds = new Map<string, string>();
    for (const definition of definitions) {
      const configVersionId = randomUUID();
      configVersionIds.set(definition.providerKey, configVersionId);
      const synchronized = await new PrismaProviderRuntimeRepository(
        definition.harness.client,
      ).synchronizeConfiguration({
        centralProviderId: definition.harness.providerId,
        providerKey: definition.providerKey,
        configVersionId,
        configVersionNumber: 1n,
        configuration: {
          adapterKey: definition.integration.manifest.adapterVersion,
          settings: { platform: definition.providerKey },
        },
        expiresAt: null,
        scheduleSeconds: 300,
        nextDueAt: null,
        synchronizedAt: new Date(),
      });
      assert.equal(synchronized.kind, "updated");
    }
    const runIds = new Map<string, string>();
    for (const [index, definition] of definitions.entries()) {
      const configVersionId = configVersionIds.get(definition.providerKey);
      assert.ok(configVersionId);
      runIds.set(
        definition.providerKey,
        await enqueue(definition.harness, configVersionId, index + 1),
      );
    }
    const organizationId = "10000000-0000-4000-8000-000000000002";
    const bootstrapPins = new Map(definitions.map((definition, index) => {
      const configVersionId = configVersionIds.get(definition.providerKey);
      assert.ok(configVersionId);
      const databaseRoute: ProviderDatabaseRoute = Object.freeze({
        target: providerDatabaseTarget({
          providerId: definition.harness.providerId,
          providerKey: definition.providerKey,
        }),
        organizationId,
        configVersionId,
        providerRowVersion: BigInt(index + 1),
        topologyVersion: BigInt(index + 1),
        node: Object.freeze({
          nodeId: randomUUID(),
          host: "127.0.0.1",
          port: 55_432 + index,
          sslMode: "disable",
          credentialVersionId: randomUUID(),
          encryptedCredential: Object.freeze({
            ciphertext: new Uint8Array([index + 1]),
            nonce: new Uint8Array(12),
            authTag: new Uint8Array(16),
            keyVersion: 1,
          }),
          rowVersion: BigInt(index + 1),
        }),
      });
      const sourceAuthority: ResolvedDataforrestSourceAuthority =
        Object.freeze({
          organizationId: databaseRoute.organizationId,
          providerId: definition.harness.providerId,
          providerKey: definition.providerKey,
          configVersionId,
          configVersionNumber: 1n,
          adapterKey: definition.integration.manifest.adapterVersion,
          sourceTypeKey: definition.integration.manifest.sourceTypeKey,
          sourceAdapterVersion:
            definition.integration.manifest.adapterVersion,
          sourceCredentialVersionId: randomUUID(),
          sourceCredentialVersionNumber: 1n,
          expiresAt: null,
          connectionConfiguration: Object.freeze({
            endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
            bearerToken: `fixture-token-${definition.providerKey}`,
          }),
          sourceConfiguration: Object.freeze({
            platform: definition.providerKey,
          }),
        });
      return [definition.providerKey, {
        databaseRoute,
        sourceAuthority,
      }] as const;
    }));

    const barrier = createParallelProviderBarrier();
    const sourceStates = new Map(definitions.map(({ providerKey }) => [
      providerKey,
      { calls: 0 },
    ]));
    const routedOperations = new Map(definitions.map(({ providerKey }) => [
      providerKey,
      0,
    ]));
    const activeGatewayProviders = new Set<string>();
    const authorityResolvers = new Map<string, unknown>();
    let maximumGatewayInFlight = 0;
    const executions = definitions.map((definition) => {
      const sourceState = sourceStates.get(definition.providerKey);
      assert.ok(sourceState);
      const source = parallelProviderSource(
        definition.providerKey,
        definition.integration.manifest.adapterVersion,
        barrier,
        sourceState,
      );
      const pins = bootstrapPins.get(definition.providerKey);
      assert.ok(pins);
      return runProviderManualImportOnce({
        environment: {
          PACKSCOUT_PROVIDER_ID: definition.harness.providerId,
          PACKSCOUT_PROVIDER_KEY: definition.providerKey,
        },
        fallbackWorkerId: definition.workerId,
        dependencies: {
          bootstrapProvider: () => Promise.resolve({
            organizationId,
            providerId: definition.harness.providerId,
            providerKey: definition.providerKey,
            databaseRoute: pins.databaseRoute,
            sourceAuthority: pins.sourceAuthority,
            integration: definition.integration,
          }),
          async runWithCachedProviderDatabase(route, operation) {
            assert.equal(route, pins.databaseRoute);
            assert.deepEqual({
              organizationId: route.organizationId,
              providerId: route.target.providerId,
            }, {
              organizationId,
              providerId: definition.harness.providerId,
            });
            assert.equal(
              activeGatewayProviders.has(definition.providerKey),
              false,
            );
            activeGatewayProviders.add(definition.providerKey);
            maximumGatewayInFlight = Math.max(
              maximumGatewayInFlight,
              activeGatewayProviders.size,
            );
            routedOperations.set(
              definition.providerKey,
              (routedOperations.get(definition.providerKey) ?? 0) + 1,
            );
            try {
              return {
                state: "reachable" as const,
                value: await operation(definition.harness.client),
              };
            } finally {
              activeGatewayProviders.delete(definition.providerKey);
            }
          },
          createExecutor(input) {
            assert.equal(input.database, definition.harness.client);
            assert.equal(input.providerId, definition.harness.providerId);
            assert.equal(input.providerKey, definition.providerKey);
            assert.equal(input.workerId, definition.workerId);
            assert.equal(input.sourceAuthority, pins.sourceAuthority);
            assert.equal(input.integration, definition.integration);
            const retainedResolver = authorityResolvers.get(
              definition.providerKey,
            );
            if (retainedResolver === undefined) {
              authorityResolvers.set(
                definition.providerKey,
                input.sourceAuthorityResolver,
              );
            } else {
              assert.equal(input.sourceAuthorityResolver, retainedResolver);
            }
            return new ProviderManualImportExecutor({
              database: input.database,
              source,
              workerId: input.workerId,
              leaseMilliseconds: 30_000,
            });
          },
        },
      });
    });

    const results = await Promise.all(executions);
    const clutchRunId = runIds.get("clutchpacks");
    const courtyardRunId = runIds.get("courtyard");
    assert.ok(clutchRunId);
    assert.ok(courtyardRunId);
    assert.deepEqual(results, [
      {
        kind: "failed",
        runId: clutchRunId,
        failureCode: "PROVIDER_CAPTURE_RECORD_INVALID",
      },
      {
        kind: "completed",
        runId: courtyardRunId,
        pageCount: 2,
        counters: {
          pages: 2,
          catalog: 0,
          pulls: 0,
          marketEvents: 0,
          accepted: 0,
          duplicate: 0,
          quarantined: 0,
          materialChanges: 0,
        },
      },
    ]);
    assert.deepEqual(
      barrier.arrivals,
      new Set(["clutchpacks", "courtyard"]),
    );
    assert.equal(barrier.releaseArrivalCount, 2);
    assert.equal(barrier.maximumInFlight, 2);
    assert.equal(maximumGatewayInFlight, 2);
    assert.deepEqual(routedOperations, new Map([
      ["clutchpacks", 1],
      ["courtyard", 2],
    ]));
    assert.equal(authorityResolvers.size, 2);
    assert.notEqual(
      authorityResolvers.get("clutchpacks"),
      authorityResolvers.get("courtyard"),
    );
    assert.deepEqual(sourceStates, new Map([
      ["clutchpacks", { calls: 1 }],
      ["courtyard", { calls: 2 }],
    ]));

    const clutchRun = await clutch.client.provider_runs.findUniqueOrThrow({
      where: { id: clutchRunId },
      select: {
        state: true,
        failure_code: true,
        page_count: true,
        reached_source_head: true,
        final_cursor: true,
        worker_fence: true,
      },
    });
    const courtyardRun = await courtyard.client.provider_runs.findUniqueOrThrow({
      where: { id: courtyardRunId },
      select: {
        state: true,
        failure_code: true,
        page_count: true,
        reached_source_head: true,
        final_cursor: true,
        worker_fence: true,
      },
    });
    assert.deepEqual(clutchRun, {
      state: "failed",
      failure_code: "PROVIDER_CAPTURE_RECORD_INVALID",
      page_count: 0,
      reached_source_head: false,
      final_cursor: null,
      worker_fence: 1n,
    });
    assert.deepEqual(courtyardRun, {
      state: "succeeded",
      failure_code: null,
      page_count: 2,
      reached_source_head: true,
      final_cursor: null,
      worker_fence: 1n,
    });
    assert.equal(await clutch.client.provider_runs.count({
      where: { id: courtyardRunId },
    }), 0);
    assert.equal(await courtyard.client.provider_runs.count({
      where: { id: clutchRunId },
    }), 0);

    assert.deepEqual(await clutch.client.provider_run_pages.findMany({
      where: { provider_run_id: clutchRunId },
    }), []);
    assert.deepEqual(await courtyard.client.provider_run_pages.findMany({
      where: { provider_run_id: courtyardRunId },
      orderBy: { page_number: "asc" },
      select: {
        page_number: true,
        requested_cursor: true,
        next_cursor: true,
        continuation: true,
      },
    }), [
      {
        page_number: 1,
        requested_cursor: null,
        next_cursor: parallelCourtyardCursor,
        continuation: "more",
      },
      {
        page_number: 2,
        requested_cursor: parallelCourtyardCursor,
        next_cursor: null,
        continuation: "head",
      },
    ]);
    for (const [harness, runId] of [
      [clutch, clutchRunId],
      [courtyard, courtyardRunId],
    ] as const) {
      assert.deepEqual(await harness.client.control_commands.findMany({
        select: { state: true, resulting_run_id: true },
      }), [{ state: "completed", resulting_run_id: runId }]);
      assert.equal(await harness.client.provider_runs.count(), 1);
      const lease = await harness.client.provider_worker_states
        .findUniqueOrThrow({
          where: { worker_role: "import" },
          select: { lease_owner: true, lease_fence: true },
        });
      assert.equal(lease.lease_owner, null);
      assert.equal(lease.lease_fence, 1n);
      assert.deepEqual(await harness.client.database_identity
        .findUniqueOrThrow({
          where: { singleton_key: true },
          select: { provider_id: true, provider_key: true },
        }), {
          provider_id: harness.providerId,
          provider_key: harness.providerKey,
        });
    }
  } finally {
    await Promise.all([
      clutch.close(),
      ...(courtyard === null ? [] : [courtyard.close()]),
    ]);
  }
});

test("executor retains facts before catalog and promotes monotonic reference reconciliation", async (context) => {
  if (process.env.PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION !== "1") {
    context.skip(
      "Set PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION=1 to run the disposable database proof.",
    );
    return;
  }

  const harness = await createHarness();
  try {
    const configVersionId = randomUUID();
    const runtime = new PrismaProviderRuntimeRepository(harness.client);
    assert.equal((await runtime.synchronizeConfiguration({
      centralProviderId: harness.providerId,
      providerKey: harness.providerKey,
      configVersionId,
      configVersionNumber: 1n,
      configuration: {
        adapterKey: CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
        settings: { lanes: [{ name: "catalog", enabled: true }] },
      },
      expiresAt: null,
      scheduleSeconds: 300,
      nextDueAt: null,
      synchronizedAt: new Date(),
    })).kind, "updated");

    let firstPageState: Readonly<{
      pullId: string;
      pullItemId: string;
      marketEventId: string;
    }> | undefined;
    const runId = await enqueue(harness, configVersionId, 1);
    const source = deferredCatalogSource(async (pageRunId) => {
      assert.equal(pageRunId, runId);
      assert.deepEqual(await harness.client.provider_runs.findUniqueOrThrow({
        where: { id: runId },
        select: {
          state: true,
          page_count: true,
          catalog_record_count: true,
          pull_record_count: true,
          market_event_record_count: true,
          accepted_count: true,
          quarantined_count: true,
          reached_source_head: true,
        },
      }), {
        state: "running",
        page_count: 1,
        catalog_record_count: 0,
        pull_record_count: 1,
        market_event_record_count: 1,
        accepted_count: 2,
        quarantined_count: 0,
        reached_source_head: false,
      });
      const pull = await harness.client.pulls.findUniqueOrThrow({
        where: { pull_key: deferredPullKey },
        select: {
          id: true,
          pack_key: true,
          pack_id: true,
          row_version: true,
          items: {
            select: {
              id: true,
              collectible_key: true,
              collectible_id: true,
              row_version: true,
            },
          },
        },
      });
      const marketEvent = await harness.client.market_events.findUniqueOrThrow({
        where: { event_key: deferredEventKey },
        select: {
          id: true,
          pack_key: true,
          pack_id: true,
          collectible_key: true,
          collectible_id: true,
          row_version: true,
        },
      });
      const pullItem = pull.items[0];
      assert.ok(pullItem);
      assert.deepEqual({
        packKey: pull.pack_key,
        packId: pull.pack_id,
        rowVersion: pull.row_version,
        itemCollectibleKey: pullItem.collectible_key,
        itemCollectibleId: pullItem.collectible_id,
        itemRowVersion: pullItem.row_version,
      }, {
        packKey: deferredPackKey,
        packId: null,
        rowVersion: 1n,
        itemCollectibleKey: deferredCollectibleKey,
        itemCollectibleId: null,
        itemRowVersion: 1n,
      });
      assert.deepEqual({
        packKey: marketEvent.pack_key,
        packId: marketEvent.pack_id,
        collectibleKey: marketEvent.collectible_key,
        collectibleId: marketEvent.collectible_id,
        rowVersion: marketEvent.row_version,
      }, {
        packKey: deferredPackKey,
        packId: null,
        collectibleKey: deferredCollectibleKey,
        collectibleId: null,
        rowVersion: 1n,
      });
      assert.deepEqual((await harness.client.promotion_changes.findMany({
        where: {
          entity_id: { in: [pull.id, pullItem.id, marketEvent.id] },
        },
        orderBy: { sequence: "asc" },
        select: {
          entity_type: true,
          entity_id: true,
          entity_version: true,
          operation: true,
        },
      })), [
        {
          entity_type: "pull",
          entity_id: pull.id,
          entity_version: 1n,
          operation: "upsert",
        },
        {
          entity_type: "pull_item",
          entity_id: pullItem.id,
          entity_version: 1n,
          operation: "upsert",
        },
        {
          entity_type: "market_event",
          entity_id: marketEvent.id,
          entity_version: 1n,
          operation: "upsert",
        },
      ]);
      assert.equal(await harness.client.quarantine_records.count(), 0);
      firstPageState = {
        pullId: pull.id,
        pullItemId: pullItem.id,
        marketEventId: marketEvent.id,
      };
    });

    const executorInput = {
      database: harness.client,
      source,
      workerId: "integration:clutchpacks-deferred-catalog",
      leaseMilliseconds: 30_000,
    } as const;
    const firstStep = await new ProviderManualImportExecutor(
      executorInput,
    ).executeNextPage();
    assert.deepEqual(firstStep, {
      kind: "progress",
      runId,
      pageCount: 1,
    });
    const retainedLease = await harness.client.provider_worker_states
      .findUniqueOrThrow({
        where: { worker_role: "import" },
        select: { lease_owner: true, lease_fence: true },
      });
    assert.equal(retainedLease.lease_owner, executorInput.workerId);
    const firstPageRun = await harness.client.provider_runs.findUniqueOrThrow({
      where: { id: runId },
      select: { worker_fence: true, state: true },
    });
    assert.equal(firstPageRun.state, "running");
    assert.equal(firstPageRun.worker_fence, retainedLease.lease_fence);
    assert.deepEqual(await new ProviderManualImportExecutor({
      ...executorInput,
      workerId: "integration:clutchpacks-competing-worker",
    }).executeNextPage(), { kind: "contended" });
    const result = await new ProviderManualImportExecutor(
      executorInput,
    ).executeNextPage();
    assert.deepEqual(result, {
      kind: "completed",
      runId,
      pageCount: 2,
      counters: {
        pages: 2,
        catalog: 2,
        pulls: 1,
        marketEvents: 1,
        accepted: 4,
        duplicate: 0,
        quarantined: 0,
        materialChanges: 4,
      },
    });
    assert.equal(await harness.client.provider_runs.count(), 1);
    assert.deepEqual(await harness.client.provider_worker_states
      .findUniqueOrThrow({
        where: { worker_role: "import" },
        select: { lease_owner: true, lease_fence: true },
      }), {
      lease_owner: null,
      lease_fence: retainedLease.lease_fence,
    });
    assert.equal((await harness.client.provider_runs.findUniqueOrThrow({
      where: { id: runId },
      select: { worker_fence: true },
    })).worker_fence, retainedLease.lease_fence);
    assert.ok(firstPageState);
    const retainedFacts = firstPageState;
    const pack = await harness.client.packs.findUniqueOrThrow({
      where: { pack_key: deferredPackKey },
      select: { id: true },
    });
    const collectible = await harness.client.collectibles.findUniqueOrThrow({
      where: { collectible_key: deferredCollectibleKey },
      select: { id: true },
    });
    const pull = await harness.client.pulls.findUniqueOrThrow({
      where: { pull_key: deferredPullKey },
      select: {
        id: true,
        pack_key: true,
        pack_id: true,
        row_version: true,
        items: {
          select: {
            id: true,
            collectible_key: true,
            collectible_id: true,
            row_version: true,
          },
        },
      },
    });
    const marketEvent = await harness.client.market_events.findUniqueOrThrow({
      where: { event_key: deferredEventKey },
      select: {
        id: true,
        pack_key: true,
        pack_id: true,
        collectible_key: true,
        collectible_id: true,
        row_version: true,
      },
    });
    assert.deepEqual(pull, {
      id: retainedFacts.pullId,
      pack_key: deferredPackKey,
      pack_id: pack.id,
      row_version: 2n,
      items: [{
        id: retainedFacts.pullItemId,
        collectible_key: deferredCollectibleKey,
        collectible_id: collectible.id,
        row_version: 2n,
      }],
    });
    assert.deepEqual(marketEvent, {
      id: retainedFacts.marketEventId,
      pack_key: deferredPackKey,
      pack_id: pack.id,
      collectible_key: deferredCollectibleKey,
      collectible_id: collectible.id,
      row_version: 3n,
    });
    assert.deepEqual((await harness.client.promotion_changes.findMany({
      where: {
        entity_id: {
          in: [
            retainedFacts.pullId,
            retainedFacts.pullItemId,
            retainedFacts.marketEventId,
          ],
        },
      },
      orderBy: { sequence: "asc" },
      select: {
        entity_type: true,
        entity_id: true,
        entity_version: true,
        operation: true,
      },
    })), [
      {
        entity_type: "pull",
        entity_id: retainedFacts.pullId,
        entity_version: 1n,
        operation: "upsert",
      },
      {
        entity_type: "pull_item",
        entity_id: retainedFacts.pullItemId,
        entity_version: 1n,
        operation: "upsert",
      },
      {
        entity_type: "market_event",
        entity_id: retainedFacts.marketEventId,
        entity_version: 1n,
        operation: "upsert",
      },
      {
        entity_type: "pull",
        entity_id: retainedFacts.pullId,
        entity_version: 2n,
        operation: "upsert",
      },
      {
        entity_type: "pull_item",
        entity_id: retainedFacts.pullItemId,
        entity_version: 2n,
        operation: "upsert",
      },
      {
        entity_type: "market_event",
        entity_id: retainedFacts.marketEventId,
        entity_version: 2n,
        operation: "upsert",
      },
      {
        entity_type: "market_event",
        entity_id: retainedFacts.marketEventId,
        entity_version: 3n,
        operation: "upsert",
      },
    ]);
    assert.equal(await harness.client.quarantine_records.count(), 0);
  } finally {
    await harness.close();
  }
});

test("admin queue executes one isolated Clutch page and replay stays canonical-idempotent", async (context) => {
  if (process.env.PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION !== "1") {
    context.skip("Set PACKSCOUT_CLUTCHPACKS_EXECUTION_INTEGRATION=1 to run the disposable database proof.");
    return;
  }
  const captureRoot = process.env.PACKSCOUT_PROVIDER_CAPTURE_ROOT;
  if (captureRoot === undefined || captureRoot.length === 0) {
    context.skip(
      "Set PACKSCOUT_PROVIDER_CAPTURE_ROOT to run the protected capture proof.",
    );
    return;
  }
  if (!path.isAbsolute(captureRoot)) {
    throw new Error("PACKSCOUT_PROVIDER_CAPTURE_ROOT must be absolute.");
  }
  try {
    await access(path.join(captureRoot, CLUTCHPACKS_CAPTURE_FILE_NAME));
  } catch {
    context.skip("The protected ClutchPacks capture is not available.");
    return;
  }

  const harness = await createHarness();
  try {
    const configVersionId = randomUUID();
    const configuration = {
      adapterKey: CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
      settings: {
        captureDirectory: "clutchpacks",
        lanes: [{ name: "catalog", enabled: true }],
      },
    };
    const runtime = new PrismaProviderRuntimeRepository(harness.client);
    const synchronized = await runtime.synchronizeConfiguration({
      centralProviderId: harness.providerId,
      providerKey: harness.providerKey,
      configVersionId,
      configVersionNumber: 1n,
      configuration,
      expiresAt: null,
      scheduleSeconds: 300,
      nextDueAt: null,
      synchronizedAt: new Date(),
    });
    assert.equal(synchronized.kind, "updated");
    const unchanged = await runtime.synchronizeConfiguration({
      centralProviderId: harness.providerId,
      providerKey: harness.providerKey,
      configVersionId,
      configVersionNumber: 1n,
      configuration,
      expiresAt: null,
      scheduleSeconds: 300,
      nextDueAt: null,
      synchronizedAt: new Date(),
    });
    assert.equal(unchanged.kind, "unchanged");

    const executor = new ProviderManualImportExecutor({
      database: harness.client,
      source: isolatedClutchSource(captureRoot),
      workerId: "integration:clutchpacks",
      leaseMilliseconds: 30_000,
    });
    const firstRunId = await enqueue(harness, configVersionId, 1);
    assert.equal(
      (await new PrismaProviderCommandRepository(harness.client)
        .nextAccepted())?.resulting_run_id,
      firstRunId,
    );
    const leaseProbe = await new PrismaProviderWorkerLeaseRepository(
      harness.client,
    ).acquire({
      role: "import",
      owner: "integration:lease-probe",
      leaseMilliseconds: 30_000,
    });
    if (leaseProbe.kind === "held") throw new Error("Lease probe was held.");
    assert.equal(leaseProbe.kind, "acquired");
    assert.equal(await new PrismaProviderWorkerLeaseRepository(harness.client)
      .release({
        role: "import",
        owner: "integration:lease-probe",
        fence: leaseProbe.lease.fence,
      }), true);
    const first = await executor.executeNext();
    assert.deepEqual(first, {
      kind: "completed",
      runId: firstRunId,
      pageCount: 1,
      counters: {
        pages: 1,
        catalog: 946,
        pulls: 15,
        marketEvents: 15,
        accepted: 976,
        duplicate: 0,
        quarantined: 0,
        materialChanges: 976,
      },
    });

    const counts = await Promise.all([
      harness.client.categories.count(),
      harness.client.packs.count(),
      harness.client.collectibles.count(),
      harness.client.provider_accounts.count(),
      harness.client.pack_contents.count(),
      harness.client.pulls.count(),
      harness.client.pull_items.count(),
      harness.client.market_events.count(),
      harness.client.quarantine_records.count(),
      harness.client.provider_run_pages.count({ where: { provider_run_id: firstRunId } }),
    ]);
    assert.deepEqual(counts, [8, 14, 907, 17, 0, 15, 15, 15, 0, 1]);
    const storedPulls = await harness.client.pulls.findMany({
      select: {
        pack_key: true,
        pack_id: true,
        items: {
          select: { collectible_key: true, collectible_id: true },
        },
      },
    });
    assert.equal(storedPulls.length, 15);
    assert.equal(storedPulls.every((pull) =>
      pull.pack_key === null
      && pull.pack_id === null
      && pull.items.length === 1
      && pull.items[0]?.collectible_key !== null
      && pull.items[0]?.collectible_id !== null
    ), true);
    const quarantines = await harness.client.quarantine_records.findMany({
      where: { provider_run_id: firstRunId },
      select: { record_kind: true, reason_code: true, field_path: true },
    });
    assert.deepEqual(quarantines, []);
    const outbox = new PrismaProviderActivityOutboxRepository(harness.client);
    const pendingActivity = await outbox.readPendingBatch({
      providerId: harness.providerId,
      limit: 100,
    });
    assert.equal(pendingActivity.health.providerId, harness.providerId);
    const quarantineActivity = pendingActivity.events.filter(
      ({ eventType }) => eventType === "provider.quarantine.opened",
    );
    assert.equal(quarantineActivity.length, 0);
    const terminalActivity = pendingActivity.events.find((event) =>
      event.eventType === "provider.run.terminal"
      && event.localRunId === firstRunId
    );
    assert.ok(terminalActivity);
    assert.equal(await outbox.markDeliveryFailed({
      eventId: terminalActivity.id,
      eventDigest: terminalActivity.eventDigest,
      attemptedAt: new Date(),
      failureCode: "CENTRAL_ACTIVITY_UNAVAILABLE",
    }), "recorded");
    assert.equal(await outbox.markDelivered({
      eventId: terminalActivity.id,
      eventDigest: terminalActivity.eventDigest,
      deliveredAt: new Date(),
    }), "delivered");
    assert.deepEqual(await harness.client.provider_activity_outbox.findUniqueOrThrow({
      where: { id: terminalActivity.id },
      select: { delivery_state: true, delivery_attempt_count: true },
    }), { delivery_state: "delivered", delivery_attempt_count: 2 });
    const firstSequence = (await harness.client.promotion_ledger.findUniqueOrThrow({
      where: { singleton_key: true },
      select: { last_sequence: true },
    })).last_sequence;

    const secondRunId = await enqueue(harness, configVersionId, 2);
    const replay = await executor.executeNext();
    assert.equal(replay.kind, "completed");
    assert.equal(replay.runId, secondRunId);
    if (replay.kind !== "completed") throw new Error("Replay did not complete.");
    assert.equal(replay.pageCount, 1);
    assert.equal(replay.counters.duplicate, 976);
    assert.equal(replay.counters.quarantined, 0);
    assert.equal(replay.counters.materialChanges, 0);
    assert.deepEqual(await Promise.all([
      harness.client.packs.count(),
      harness.client.collectibles.count(),
      harness.client.pulls.count(),
      harness.client.market_events.count(),
      harness.client.quarantine_records.count(),
    ]), [14, 907, 15, 15, 0]);
    assert.equal((await harness.client.promotion_ledger.findUniqueOrThrow({
      where: { singleton_key: true },
      select: { last_sequence: true },
    })).last_sequence, firstSequence);

    const quarantineRunId = await enqueue(harness, configVersionId, 3);
    const quarantineResult = await new ProviderManualImportExecutor({
      database: harness.client,
      source: mixedQuarantineSource(),
      workerId: "integration:clutchpacks-quarantine",
      leaseMilliseconds: 30_000,
    }).executeNext();
    assert.deepEqual(quarantineResult, {
      kind: "completed",
      runId: quarantineRunId,
      pageCount: 1,
      counters: {
        pages: 1,
        catalog: 2,
        pulls: 0,
        marketEvents: 0,
        accepted: 0,
        duplicate: 0,
        quarantined: 2,
        materialChanges: 0,
      },
    });
    const storedQuarantines = await harness.client.quarantine_records.findMany({
      where: { provider_run_id: quarantineRunId },
      orderBy: { record_index: "asc" },
      select: {
        record_index: true,
        record_kind: true,
        source_record_key: true,
        reason_code: true,
        sanitized_summary: true,
        normalized_candidate: true,
        protected_evidence: true,
        evidence_expires_at: true,
        evidence_expired_at: true,
        retry_count: true,
        state: true,
      },
    });
    const sourceQuarantine = storedQuarantines[0];
    const candidateQuarantine = storedQuarantines[1];
    assert.ok(sourceQuarantine);
    assert.deepEqual({
      record_index: sourceQuarantine.record_index,
      record_kind: sourceQuarantine.record_kind,
      source_record_key: sourceQuarantine.source_record_key,
      reason_code: sourceQuarantine.reason_code,
      sanitized_summary: sourceQuarantine.sanitized_summary,
      normalized_candidate: sourceQuarantine.normalized_candidate,
      protected_evidence: sourceQuarantine.protected_evidence,
      retry_count: sourceQuarantine.retry_count,
      state: sourceQuarantine.state,
    }, {
      record_index: 0,
      record_kind: "catalog",
      source_record_key: `source:${"a".repeat(64)}`,
      reason_code: "SOURCE_RECORD_MAPPING_INVALID",
      sanitized_summary:
        "The validated source record could not be mapped; no retry artifact is retained.",
      normalized_candidate: null,
      protected_evidence: null,
      retry_count: 0,
      state: "expired",
    });
    assert.deepEqual(
      sourceQuarantine.evidence_expired_at,
      sourceQuarantine.evidence_expires_at,
    );
    assert.ok(candidateQuarantine);
    assert.equal(candidateQuarantine.record_index, 1);
    assert.equal(candidateQuarantine.source_record_key, null);
    assert.equal(candidateQuarantine.state, "open");
    assert.equal(candidateQuarantine.evidence_expired_at, null);
    assert.deepEqual(candidateQuarantine.normalized_candidate, {});
    const quarantineEvents = await harness.client.provider_activity_outbox.findMany({
      where: { local_run_id: quarantineRunId },
      orderBy: { event_at: "asc" },
      select: {
        event_type: true,
        title: true,
        summary: true,
        evidence: true,
      },
    });
    assert.deepEqual(
      quarantineEvents.filter(({ event_type }) =>
        event_type.startsWith("provider.quarantine.")
      ),
      [
        {
          event_type: "provider.quarantine.expired",
          title: "Provider source record rejected",
          summary:
            "A source record was rejected before canonical persistence and has no retained retry artifact.",
          evidence: { quarantineState: "expired" },
        },
        {
          event_type: "provider.quarantine.opened",
          title: "Provider record quarantined",
          summary:
            "A normalized provider record requires operator review before retry.",
          evidence: { quarantineState: "open" },
        },
      ],
    );
    const replayedQuarantineRunId = await enqueue(
      harness,
      configVersionId,
      4,
    );
    const replayedQuarantine = await new ProviderManualImportExecutor({
      database: harness.client,
      source: mixedQuarantineSource(false),
      workerId: "integration:clutchpacks-quarantine-replay",
      leaseMilliseconds: 30_000,
    }).executeNext();
    assert.deepEqual(replayedQuarantine, {
      kind: "completed",
      runId: replayedQuarantineRunId,
      pageCount: 1,
      counters: {
        pages: 1,
        catalog: 1,
        pulls: 0,
        marketEvents: 0,
        accepted: 0,
        duplicate: 1,
        quarantined: 0,
        materialChanges: 0,
      },
    });
    assert.equal(await harness.client.quarantine_records.count({
      where: { source_record_key: `source:${"a".repeat(64)}` },
    }), 1);
    assert.equal(await harness.client.provider_activity_outbox.count({
      where: {
        local_run_id: replayedQuarantineRunId,
        event_type: { startsWith: "provider.quarantine." },
      },
    }), 0);
    assert.equal((await harness.client.promotion_ledger.findUniqueOrThrow({
      where: { singleton_key: true },
      select: { last_sequence: true },
    })).last_sequence, firstSequence);
    assert.deepEqual(await harness.client.database_identity.findUniqueOrThrow({
      where: { singleton_key: true },
      select: { provider_id: true, provider_key: true },
    }), {
      provider_id: harness.providerId,
      provider_key: harness.providerKey,
    });

    const nextConfigurationId = randomUUID();
    const advanced = await runtime.synchronizeConfiguration({
      centralProviderId: harness.providerId,
      providerKey: harness.providerKey,
      configVersionId: nextConfigurationId,
      configVersionNumber: 2n,
      configuration: {
        adapterKey: "dataforrest-events-adapter-v3",
        settings: { platform: "clutchpacks" },
      },
      expiresAt: null,
      scheduleSeconds: 300,
      nextDueAt: null,
      synchronizedAt: new Date(),
    });
    assert.equal(advanced.kind, "updated");
    assert.equal(advanced.runtime.cursorFingerprint, null);
    assert.deepEqual(await harness.client.provider_runtime.findUniqueOrThrow({
      where: { singleton_key: true },
      select: { source_cursor: true, source_cursor_hash: true },
    }), { source_cursor: null, source_cursor_hash: null });
  } finally {
    await harness.close();
  }
});
