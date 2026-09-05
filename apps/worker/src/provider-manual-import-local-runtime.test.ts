import assert from "node:assert/strict";
import test from "node:test";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ENDPOINT,
} from "@packscout/contracts";
import {
  providerDatabaseTarget,
  type ProviderDatabaseRoute,
  type ProviderPrismaClient,
} from "@packscout/database";
import type { ResolvedDataforrestSourceAuthority } from
  "./dataforrest-source-authority-resolver.ts";
import {
  providerDataforrestLiveIntegrationRegistry,
  type ProviderDataforrestLiveIntegration,
} from
  "./provider-dataforrest-live-integration.ts";
import {
  PROVIDER_MANUAL_IMPORT_MAXIMUM_ROUTED_PAGE_STEPS,
  ProviderManualImportLocalError,
  readProviderManualImportLocalConfiguration,
  runProviderManualImportOnce,
  type ProviderManualImportBootstrap,
} from "./provider-manual-import-local-runtime.ts";

const providerId = "00000000-0000-4000-8000-000000000021";
const organizationId = "00000000-0000-4000-8000-000000000001";
const configVersionId = "00000000-0000-4000-8000-000000000022";
const sourceCredentialVersionId =
  "00000000-0000-4000-8000-000000000023";
const credentialVersionId = "00000000-0000-4000-8000-000000000024";
const nodeId = "00000000-0000-4000-8000-000000000025";
const runId = "00000000-0000-4000-8000-000000000031";
const initialNow = new Date("2026-08-29T18:00:00.000Z");

function integrationFor(
  providerKey: string,
  adapterKey: string,
): ProviderDataforrestLiveIntegration {
  const integration = providerDataforrestLiveIntegrationRegistry
    .resolve(providerKey, adapterKey);
  if (integration === null) {
    throw new TypeError(`${providerKey} integration fixture is unavailable.`);
  }
  return integration;
}
const courtyardIntegration = integrationFor(
  "courtyard",
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
);
const clutchIntegration = integrationFor(
  "clutchpacks",
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
);

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PACKSCOUT_PROVIDER_ID: providerId,
    PACKSCOUT_PROVIDER_KEY: "courtyard",
    ...overrides,
  };
}

function databaseRoute(
  overrides: Partial<ProviderDatabaseRoute> = {},
): ProviderDatabaseRoute {
  return Object.freeze({
    target: providerDatabaseTarget({ providerId, providerKey: "courtyard" }),
    organizationId,
    configVersionId,
    providerRowVersion: 1n,
    topologyVersion: 1n,
    node: Object.freeze({
      nodeId,
      host: "127.0.0.1",
      port: 55_433,
      sslMode: "disable",
      credentialVersionId,
      encryptedCredential: Object.freeze({
        ciphertext: new Uint8Array([1]),
        nonce: new Uint8Array(12),
        authTag: new Uint8Array(16),
        keyVersion: 1,
      }),
      rowVersion: 1n,
    }),
    ...overrides,
  });
}

function sourceAuthority(
  overrides: Partial<ResolvedDataforrestSourceAuthority> = {},
): ResolvedDataforrestSourceAuthority {
  return Object.freeze({
    organizationId,
    providerId,
    providerKey: "courtyard",
    configVersionId,
    configVersionNumber: 2n,
    adapterKey: courtyardIntegration.manifest.adapterVersion,
    sourceTypeKey: courtyardIntegration.manifest.sourceTypeKey,
    sourceAdapterVersion: courtyardIntegration.manifest.adapterVersion,
    sourceCredentialVersionId,
    sourceCredentialVersionNumber: 3n,
    expiresAt: new Date("2026-08-29T19:00:00.000Z"),
    connectionConfiguration: Object.freeze({
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerToken: "fixture-dataforrest-token",
    }),
    sourceConfiguration: Object.freeze({ platform: "courtyard" }),
    ...overrides,
  });
}

function bootstrapFixture(
  overrides: Partial<ProviderManualImportBootstrap> = {},
): ProviderManualImportBootstrap {
  return Object.freeze({
    organizationId,
    providerId,
    providerKey: "courtyard",
    databaseRoute: databaseRoute(),
    sourceAuthority: sourceAuthority(),
    integration: courtyardIntegration,
    ...overrides,
  });
}

test("generic local configuration selects Courtyard without a provider DSN", () => {
  const configuration = readProviderManualImportLocalConfiguration(
    environment({ PACKSCOUT_PROVIDER_DATABASE_URL: undefined }),
    "preview:courtyard",
  );
  assert.deepEqual(configuration, {
    providerId,
    providerKey: "courtyard",
    workerId: "preview:courtyard",
  });
});

test("one central bootstrap survives loss after page one and reaches source head from cached pins", async () => {
  const client = {} as ProviderPrismaClient;
  const events: string[] = [];
  const route = databaseRoute();
  const authority = sourceAuthority();
  let centralAvailable = true;
  let routeLookups = 0;
  let authorityLookups = 0;
  let page = 0;
  let retainedResolver: unknown;

  const resolveRoute = async (): Promise<ProviderDatabaseRoute> => {
    routeLookups += 1;
    if (!centralAvailable) throw new Error("central route unavailable");
    events.push("central_route_resolved");
    return route;
  };
  const resolveAuthority = async ():
    Promise<ResolvedDataforrestSourceAuthority> => {
    authorityLookups += 1;
    if (!centralAvailable) throw new Error("central authority unavailable");
    events.push("central_authority_resolved");
    return authority;
  };

  const result = await runProviderManualImportOnce({
    environment: environment({
      PACKSCOUT_PROVIDER_DATABASE_URL:
        "postgresql://must:not-be-read@127.0.0.1/forbidden",
    }),
    fallbackWorkerId: "preview:courtyard",
    dependencies: {
      async bootstrapProvider(input) {
        assert.deepEqual(input, { providerId, providerKey: "courtyard" });
        return bootstrapFixture({
          databaseRoute: await resolveRoute(),
          sourceAuthority: await resolveAuthority(),
        });
      },
      async runWithCachedProviderDatabase(receivedRoute, operation) {
        assert.equal(receivedRoute, route);
        events.push("cached_gateway_entered");
        const value = await operation(client);
        events.push("cached_gateway_released");
        return { state: "reachable" as const, value };
      },
      createExecutor(input) {
        assert.equal(input.database, client);
        assert.equal(input.providerId, providerId);
        assert.equal(input.providerKey, "courtyard");
        assert.equal(input.workerId, "preview:courtyard");
        assert.equal(input.sourceAuthority, authority);
        assert.equal(input.integration, courtyardIntegration);
        retainedResolver ??= input.sourceAuthorityResolver;
        assert.equal(input.sourceAuthorityResolver, retainedResolver);
        return {
          terminalizeProgress() {
            throw new Error("A completed continuation must not be terminalized.");
          },
          async executeNextPage() {
            assert.equal(await input.sourceAuthorityResolver.resolve({
              providerId,
              providerKey: "courtyard",
              configVersionId,
              configVersionNumber: 2n,
              adapterKey: courtyardIntegration.manifest.adapterVersion,
            }), authority);
            page += 1;
            if (page === 1) {
              centralAvailable = false;
              return { kind: "progress", runId, pageCount: 1 };
            }
            return {
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
            };
          },
        };
      },
      now: () => initialNow,
      async relayProviderActivity() {
        assert.equal(centralAvailable, false);
        throw new Error("central relay unavailable");
      },
      observeRelayFailure(code) {
        events.push(`relay_failure:${code}`);
      },
    },
  });

  assert.equal(result.kind, "completed");
  assert.equal(page, 2);
  assert.equal(routeLookups, 1);
  assert.equal(authorityLookups, 1);
  assert.deepEqual(events, [
    "central_route_resolved",
    "central_authority_resolved",
    "cached_gateway_entered",
    "cached_gateway_released",
    "cached_gateway_entered",
    "cached_gateway_released",
    "relay_failure:CENTRAL_ACTIVITY_UNAVAILABLE",
  ]);
});

test("a fresh runner cannot start from cached pins when central bootstrap is unavailable", async () => {
  let cachedGatewayCalls = 0;
  await assert.rejects(runProviderManualImportOnce({
    environment: environment(),
    fallbackWorkerId: "preview:courtyard",
    dependencies: {
      bootstrapProvider: () => Promise.reject(new Error("central unavailable")),
      runWithCachedProviderDatabase() {
        cachedGatewayCalls += 1;
        throw new Error("must not route");
      },
      createExecutor() {
        throw new Error("must not construct");
      },
    },
  }), (error: unknown) =>
    error instanceof ProviderManualImportLocalError
    && error.code === "PROVIDER_IMPORT_IDENTITY_UNAVAILABLE"
  );
  assert.equal(cachedGatewayCalls, 0);
});

test("runner rejects crossed route, authority, and integration pins before cached routing", async () => {
  const crossedBootstraps: readonly ProviderManualImportBootstrap[] = [
    bootstrapFixture({
      databaseRoute: databaseRoute({
        configVersionId: "00000000-0000-4000-8000-000000000099",
      }),
    }),
    bootstrapFixture({
      sourceAuthority: sourceAuthority({
        organizationId: "00000000-0000-4000-8000-000000000099",
      }),
    }),
    bootstrapFixture({ integration: clutchIntegration }),
    bootstrapFixture({ providerKey: "clutchpacks" }),
  ];
  for (const crossed of crossedBootstraps) {
    let cachedGatewayCalls = 0;
    await assert.rejects(runProviderManualImportOnce({
      environment: environment(),
      fallbackWorkerId: "preview:courtyard",
      dependencies: {
        bootstrapProvider: () => Promise.resolve(crossed),
        runWithCachedProviderDatabase() {
          cachedGatewayCalls += 1;
          throw new Error("must not route");
        },
        createExecutor() {
          throw new Error("must not construct");
        },
        now: () => initialNow,
      },
    }), (error: unknown) =>
      error instanceof ProviderManualImportLocalError
      && error.code === "PROVIDER_IMPORT_AUTHORITY_INVALID"
    );
    assert.equal(cachedGatewayCalls, 0);
  }
});

test("cached source authority expiration terminalizes prior progress without another source page", async () => {
  const expiresAt = new Date("2026-08-29T18:01:00.000Z");
  const authority = sourceAuthority({ expiresAt });
  let observedAt = initialNow;
  let cachedGatewayCalls = 0;
  let sourcePages = 0;
  let cleanupCalls = 0;
  await assert.rejects(runProviderManualImportOnce({
    environment: environment(),
    fallbackWorkerId: "preview:courtyard",
    dependencies: {
      bootstrapProvider: () => Promise.resolve(bootstrapFixture({
        sourceAuthority: authority,
      })),
      async runWithCachedProviderDatabase(_route, operation) {
        cachedGatewayCalls += 1;
        return {
          state: "reachable" as const,
          value: await operation({} as ProviderPrismaClient),
        };
      },
      createExecutor(input) {
        return {
          terminalizeProgress(cleanup) {
            cleanupCalls += 1;
            assert.deepEqual(cleanup, {
              progress: { kind: "progress", runId, pageCount: 1 },
              failureCode: "PROVIDER_IMPORT_AUTHORITY_EXPIRED",
            });
            return Promise.resolve({
              kind: "failed",
              runId,
              failureCode: cleanup.failureCode,
            });
          },
          async executeNextPage() {
            sourcePages += 1;
            assert.equal(sourcePages, 1);
            assert.equal(await input.sourceAuthorityResolver.resolve({
              providerId,
              providerKey: "courtyard",
              configVersionId,
              configVersionNumber: 2n,
              adapterKey: courtyardIntegration.manifest.adapterVersion,
            }), authority);
            observedAt = expiresAt;
            return { kind: "progress", runId, pageCount: 1 };
          },
        };
      },
      now: () => observedAt,
    },
  }), (error: unknown) =>
    error instanceof ProviderManualImportLocalError
    && error.code === "PROVIDER_IMPORT_AUTHORITY_EXPIRED"
  );
  assert.equal(cachedGatewayCalls, 2);
  assert.equal(sourcePages, 1);
  assert.equal(cleanupCalls, 1);
});

test("an already-aborted signal between page steps terminalizes prior progress without another source page", async () => {
  const controller = new AbortController();
  let sourcePages = 0;
  let cleanupCalls = 0;
  let cachedGatewayCalls = 0;
  const result = await runProviderManualImportOnce({
    environment: environment(),
    fallbackWorkerId: "preview:courtyard",
    signal: controller.signal,
    dependencies: {
      bootstrapProvider: () => Promise.resolve(bootstrapFixture()),
      async runWithCachedProviderDatabase(_route, operation) {
        cachedGatewayCalls += 1;
        return {
          state: "reachable" as const,
          value: await operation({} as ProviderPrismaClient),
        };
      },
      createExecutor() {
        return {
          executeNextPage() {
            sourcePages += 1;
            assert.equal(sourcePages, 1);
            controller.abort();
            return Promise.resolve({ kind: "progress", runId, pageCount: 1 });
          },
          terminalizeProgress(cleanup) {
            cleanupCalls += 1;
            assert.deepEqual(cleanup, {
              progress: { kind: "progress", runId, pageCount: 1 },
              failureCode: "PROVIDER_CAPTURE_ABORTED",
            });
            return Promise.resolve({
              kind: "failed",
              runId,
              failureCode: cleanup.failureCode,
            });
          },
        };
      },
      now: () => initialNow,
    },
  });
  assert.deepEqual(result, {
    kind: "failed",
    runId,
    failureCode: "PROVIDER_CAPTURE_ABORTED",
  });
  assert.equal(sourcePages, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(cachedGatewayCalls, 2);
});

test("an abort during the next gateway entry still cleans the prior continuation", async () => {
  const controller = new AbortController();
  let sourcePages = 0;
  let cleanupCalls = 0;
  let cachedGatewayCalls = 0;
  const result = await runProviderManualImportOnce({
    environment: environment(),
    fallbackWorkerId: "preview:courtyard",
    signal: controller.signal,
    dependencies: {
      bootstrapProvider: () => Promise.resolve(bootstrapFixture()),
      async runWithCachedProviderDatabase(_route, operation) {
        cachedGatewayCalls += 1;
        if (cachedGatewayCalls === 2) controller.abort();
        return {
          state: "reachable" as const,
          value: await operation({} as ProviderPrismaClient),
        };
      },
      createExecutor() {
        return {
          executeNextPage(signal) {
            if (signal?.aborted) {
              return Promise.resolve({
                kind: "blocked",
                runId: null,
                failureCode: "PROVIDER_CAPTURE_ABORTED",
              });
            }
            sourcePages += 1;
            return Promise.resolve({ kind: "progress", runId, pageCount: 1 });
          },
          terminalizeProgress(cleanup) {
            cleanupCalls += 1;
            assert.deepEqual(cleanup, {
              progress: { kind: "progress", runId, pageCount: 1 },
              failureCode: "PROVIDER_CAPTURE_ABORTED",
            });
            return Promise.resolve({
              kind: "failed",
              runId,
              failureCode: cleanup.failureCode,
            });
          },
        };
      },
      now: () => initialNow,
    },
  });
  assert.deepEqual(result, {
    kind: "failed",
    runId,
    failureCode: "PROVIDER_CAPTURE_ABORTED",
  });
  assert.equal(sourcePages, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(cachedGatewayCalls, 3);
});

test("runner completes on step 50,000 and never admits a 50,001st page step", async () => {
  assert.equal(PROVIDER_MANUAL_IMPORT_MAXIMUM_ROUTED_PAGE_STEPS, 50_000);

  const runScenario = async (completeAtBound: boolean): Promise<number> => {
    let pageSteps = 0;
    let cleanupCalls = 0;
    const execution = runProviderManualImportOnce({
      environment: environment(),
      fallbackWorkerId: "preview:courtyard",
      dependencies: {
        bootstrapProvider: () => Promise.resolve(bootstrapFixture({
          sourceAuthority: sourceAuthority({ expiresAt: null }),
        })),
        async runWithCachedProviderDatabase(_route, operation) {
          return {
            state: "reachable" as const,
            value: await operation({} as ProviderPrismaClient),
          };
        },
        createExecutor() {
          return {
            terminalizeProgress(cleanup) {
              cleanupCalls += 1;
              assert.equal(completeAtBound, false);
              assert.deepEqual(cleanup, {
                progress: {
                  kind: "progress",
                  runId,
                  pageCount: PROVIDER_MANUAL_IMPORT_MAXIMUM_ROUTED_PAGE_STEPS,
                },
                failureCode: "PROVIDER_IMPORT_STEP_LIMIT_EXCEEDED",
              });
              return Promise.resolve({
                kind: "failed",
                runId,
                failureCode: cleanup.failureCode,
              });
            },
            executeNextPage() {
              pageSteps += 1;
              if (
                completeAtBound
                && pageSteps ===
                  PROVIDER_MANUAL_IMPORT_MAXIMUM_ROUTED_PAGE_STEPS
              ) {
                return Promise.resolve({
                  kind: "completed" as const,
                  runId,
                  pageCount: pageSteps,
                  counters: {
                    pages: pageSteps,
                    catalog: 0,
                    pulls: 0,
                    marketEvents: 0,
                    accepted: 0,
                    duplicate: 0,
                    quarantined: 0,
                    materialChanges: 0,
                  },
                });
              }
              return Promise.resolve({
                kind: "progress" as const,
                runId,
                pageCount: pageSteps,
              });
            },
          };
        },
        now: () => initialNow,
      },
    });
    if (completeAtBound) {
      assert.equal((await execution).kind, "completed");
    } else {
      await assert.rejects(execution, (error: unknown) =>
        error instanceof ProviderManualImportLocalError
        && error.code === "PROVIDER_IMPORT_STEP_LIMIT_EXCEEDED"
      );
    }
    assert.equal(cleanupCalls, completeAtBound ? 0 : 1);
    return pageSteps;
  };

  assert.equal(
    await runScenario(true),
    PROVIDER_MANUAL_IMPORT_MAXIMUM_ROUTED_PAGE_STEPS,
  );
  assert.equal(
    await runScenario(false),
    PROVIDER_MANUAL_IMPORT_MAXIMUM_ROUTED_PAGE_STEPS,
  );
});

/**
 * Mirrors the executor at head: the page that reaches head is reported as
 * pending without head work, each head batch is a stamped progress, and the
 * final batch is a stamped completion.
 */
function headReconciliationExecutor(input: {
  advanceClock(): void;
  headBatches: number;
}) {
  let step = 0;
  return {
    terminalizeProgress() {
      throw new Error("A completed continuation must not be terminalized.");
    },
    async executeNextPage() {
      step += 1;
      input.advanceClock();
      if (step === 1) {
        return {
          kind: "progress" as const,
          runId,
          pageCount: 1,
          reconciliationPending: true as const,
        };
      }
      if (step <= input.headBatches) {
        return {
          kind: "progress" as const,
          runId,
          pageCount: 1,
          reconciliationPending: true as const,
          headReconciliationExecuted: true as const,
        };
      }
      return {
        kind: "completed" as const,
        runId,
        pageCount: 1,
        counters: {
          pages: 1,
          catalog: 1,
          pulls: 0,
          marketEvents: 0,
          accepted: 1,
          duplicate: 0,
          quarantined: 0,
          materialChanges: 1,
        },
        headReconciliationExecuted: true as const,
      };
    },
  };
}

test("only executed head reconciliation steps are observed, through the completing one", async () => {
  const client = {} as ProviderPrismaClient;
  let clock = initialNow.getTime();
  const observed: unknown[] = [];
  // One executor for the whole run: the runtime creates a fresh executor per step.
  const executor = headReconciliationExecutor({
    advanceClock: () => { clock += 11_000; },
    headBatches: 3,
  });

  const result = await runProviderManualImportOnce({
    environment: environment(),
    fallbackWorkerId: "preview:courtyard",
    dependencies: {
      async bootstrapProvider() {
        return bootstrapFixture();
      },
      async runWithCachedProviderDatabase(_route, operation) {
        return { state: "reachable" as const, value: await operation(client) };
      },
      createExecutor() {
        return executor;
      },
      now: () => new Date(clock),
      observeHeadReconciliationProgress(progress) {
        observed.push(progress);
      },
    },
  });

  assert.equal(result.kind, "completed");
  // The pending-only page step is not observed; the completing step is.
  assert.deepEqual(observed, [
    { runId, pageCount: 1, headReconciliationSteps: 1, elapsedMilliseconds: 0 },
    { runId, pageCount: 1, headReconciliationSteps: 2, elapsedMilliseconds: 11_000 },
    { runId, pageCount: 1, headReconciliationSteps: 3, elapsedMilliseconds: 22_000 },
  ]);
});

test("a failing head reconciliation observer never changes the run outcome", async () => {
  const client = {} as ProviderPrismaClient;
  let observations = 0;
  const executor = headReconciliationExecutor({
    advanceClock: () => {},
    headBatches: 3,
  });

  const result = await runProviderManualImportOnce({
    environment: environment(),
    fallbackWorkerId: "preview:courtyard",
    dependencies: {
      async bootstrapProvider() {
        return bootstrapFixture();
      },
      async runWithCachedProviderDatabase(_route, operation) {
        return { state: "reachable" as const, value: await operation(client) };
      },
      createExecutor() {
        return executor;
      },
      now: () => initialNow,
      observeHeadReconciliationProgress() {
        observations += 1;
        throw new Error("observer unavailable");
      },
    },
  });

  assert.equal(result.kind, "completed");
  assert.equal(observations, 3);
});
