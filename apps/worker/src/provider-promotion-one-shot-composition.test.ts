import assert from "node:assert/strict";
import test from "node:test";
import type {
  PinnedProviderReleaseInputs,
  ProviderDatabaseRoute,
  ProviderPrismaClient,
  PromotionJobInvocation,
} from "@packscout/database";
import {
  PROMOTION_JOB_DELIVERY_RETENTION_MS,
  providerDatabaseTarget,
  promotionJobSha256,
} from "@packscout/database";
import type {
  DistributedProviderReleasePublicationTransport,
} from "@packscout/services";
import {
  readProviderPublicationJobAuthorityConfiguration,
} from "./distributed-promotion-authority-config.ts";
import {
  PrismaBoundProviderPromotionWork,
  runPinnedProviderPromotionOnce,
  type PinnedProviderPromotionBootstrap,
  type ProviderPromotionPinnedGateway,
} from "./provider-promotion-one-shot-composition.ts";

const providerA = "00000000-0000-4000-8000-000000000201";
const providerB = "00000000-0000-4000-8000-000000000202";
const organizationId = "00000000-0000-4000-8000-000000000203";
const configA = "00000000-0000-4000-8000-000000000204";
const configB = "00000000-0000-4000-8000-000000000205";
const base = new Date("2026-09-01T21:00:00.000Z");

function authority(providerId: string, ordinal: number) {
  return readProviderPublicationJobAuthorityConfiguration({
    PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example",
    PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "production-us",
    PACKSCOUT_PROMOTION_PROVIDER_ID: providerId,
    PACKSCOUT_PROMOTION_PROVIDER_KEY_ID: `provider.${ordinal}.v1`,
    PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64:
      Buffer.alloc(32, ordinal).toString("base64"),
    PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION:
      `provider-${ordinal}-v1`,
  });
}

function route(input: Readonly<{
  providerId: string;
  providerKey: string;
  configVersionId: string;
  ordinal: number;
}>): ProviderDatabaseRoute {
  return {
    target: providerDatabaseTarget({
      providerId: input.providerId,
      providerKey: input.providerKey,
    }),
    organizationId,
    configVersionId: input.configVersionId,
    providerRowVersion: 1n,
    topologyVersion: 1n,
    node: {
      nodeId: `00000000-0000-4000-8000-${String(300 + input.ordinal)
        .padStart(12, "0")}`,
      host: "127.0.0.1",
      port: 54_320 + input.ordinal,
      sslMode: "disable",
      credentialVersionId:
        `00000000-0000-4000-8000-${String(400 + input.ordinal)
          .padStart(12, "0")}`,
      encryptedCredential: {
        ciphertext: new Uint8Array([input.ordinal]),
        nonce: new Uint8Array(12),
        authTag: new Uint8Array(16),
        keyVersion: 1,
      },
      rowVersion: 1n,
    },
  };
}

function pin(input: Readonly<{
  providerId: string;
  providerKey: string;
  configVersionId: string;
}>): PinnedProviderReleaseInputs {
  return {
    providerId: input.providerId,
    providerKey: input.providerKey,
    providerConfigVersionId: input.configVersionId,
  } as unknown as PinnedProviderReleaseInputs;
}

function bootstrap(input: Readonly<{
  providerId: string;
  providerKey: string;
  configVersionId: string;
  ordinal: number;
}>): PinnedProviderPromotionBootstrap {
  return {
    route: route(input),
    pin: pin(input),
  };
}

function terminalInvocation(
  providerOrdinal: number,
): PromotionJobInvocation {
  return {
    runId: `00000000-0000-4000-8000-${String(500 + providerOrdinal)
      .padStart(12, "0")}`,
    authority: "provider_publication",
    deliveryKeyDigest: promotionJobSha256(`delivery:${providerOrdinal}`),
    trigger: { kind: "manual", observedWakeGeneration: null },
    lifecycleState: "terminal",
    outcome: "caught_up",
    requestedAt: base,
    startedAt: base,
    finishedAt: base,
    ownershipExpiresAt: null,
    scheduledCheckinAt: null,
    progress: {
      beforeLanePosition: 2n,
      afterLanePosition: 2n,
      beforeSettledPosition: 0n,
      afterSettledPosition: 2n,
      cycleCount: 1,
      promotionAttemptCount: 1,
      publicationCount: 1,
      operationCount: 3,
    },
    safeFailureCode: null,
    continuationGeneration: null,
    resultActiveGeneration: null,
    resultPublicReleaseId: null,
    resultReleaseFingerprint: null,
    relatedAttemptCount: 1,
    relatedAttemptSetDigest: promotionJobSha256(`attempt:${providerOrdinal}`),
    retentionProtected: true,
  };
}

function request(name: string) {
  return {
    delivery: {
      opaqueKey: name,
      issuedAt: base,
      expiresAt: new Date(
        base.getTime() + PROMOTION_JOB_DELIVERY_RETENTION_MS,
      ),
    },
    trigger: { kind: "manual" as const },
    requestedAt: base,
  };
}

const inertTransport: DistributedProviderReleasePublicationTransport = {
  async sendExact() {
    throw new Error("Composition fixture must not dispatch transport directly.");
  },
  async status() {
    throw new Error("Composition fixture must not query transport directly.");
  },
};

test("bounded provider reads normalize Prisma transaction expiry", async () => {
  const work = new PrismaBoundProviderPromotionWork({
    provider: {
      $transaction() {
        return Promise.reject(Object.assign(
          new Error("Simulated Prisma transaction timeout."),
          { code: "P2028" },
        ));
      },
    } as unknown as ProviderPrismaClient,
    providerId: providerA,
    pin: pin({
      providerId: providerA,
      providerKey: "courtyard",
      configVersionId: configA,
    }),
    workerId: "promotion:deadline-test",
    transport: inertTransport,
  });

  await assert.rejects(
    () => work.readBoundary(undefined, Date.now() + 10_000),
    (error: unknown) => error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "PROVIDER_PROMOTION_DEADLINE",
  );
});

test("post-publication evidence reads only compact operation digest fields", async () => {
  const releaseId = "00000000-0000-4000-8000-000000000206";
  const startId = "00000000-0000-4000-8000-000000000207";
  const batchId = "00000000-0000-4000-8000-000000000208";
  const finalizeId = "00000000-0000-4000-8000-000000000209";
  const startRequestedAt = new Date(base.getTime() + 3_000);
  const batchRequestedAt = new Date(base.getTime() + 2_000);
  const finalizeRequestedAt = new Date(base.getTime() + 1_000);
  const batchAttemptedAt = new Date(base.getTime() + 4_000);
  const finalizeAttemptedAt = new Date(base.getTime() + 5_000);
  const finalizeCompletedAt = new Date(base.getTime() + 6_000);
  const receiptDigest = promotionJobSha256("finalize receipt");
  const rows = [{
    id: finalizeId,
    operation_kind: "finalize",
    batch_index: null,
    request_digest: promotionJobSha256("finalize request"),
    state: "accepted",
    attempt_count: 1,
    last_attempted_at: finalizeAttemptedAt,
    requested_at: finalizeRequestedAt,
    completed_at: finalizeCompletedAt,
    receipt: { response_digest: receiptDigest },
  }, {
    id: batchId,
    operation_kind: "applyBatch",
    batch_index: 0,
    request_digest: promotionJobSha256("batch request"),
    state: "ambiguous",
    attempt_count: 2,
    last_attempted_at: batchAttemptedAt,
    requested_at: batchRequestedAt,
    completed_at: null,
    receipt: null,
  }, {
    id: startId,
    operation_kind: "start",
    batch_index: null,
    request_digest: promotionJobSha256("start request"),
    state: "pending",
    attempt_count: 0,
    last_attempted_at: null,
    requested_at: startRequestedAt,
    completed_at: null,
    receipt: null,
  }];
  let receivedQuery: unknown;
  const provider = {
    async $transaction(
      operation: (transaction: Readonly<{
        provider_publication_operations: Readonly<{
          findMany(query: unknown): Promise<typeof rows>;
        }>;
      }>) => Promise<unknown>,
    ) {
      return operation({
        provider_publication_operations: {
          async findMany(query: unknown) {
            receivedQuery = query;
            return rows;
          },
        },
      });
    },
  } as unknown as ProviderPrismaClient;
  const work = new PrismaBoundProviderPromotionWork({
    provider,
    providerId: providerA,
    pin: pin({
      providerId: providerA,
      providerKey: "courtyard",
      configVersionId: configA,
    }),
    workerId: "promotion:compact-evidence-test",
    transport: inertTransport,
  });

  const evidence = await (work as unknown as Readonly<{
    operationEvidence(
      providerReleaseId: string,
      deadlineAt: number,
      signal: AbortSignal,
    ): Promise<unknown>;
  }>).operationEvidence(
    releaseId,
    Date.now() + 10_000,
    new AbortController().signal,
  );

  assert.deepEqual(receivedQuery, {
    where: { provider_release_id: releaseId },
    select: {
      id: true,
      operation_kind: true,
      batch_index: true,
      request_digest: true,
      state: true,
      attempt_count: true,
      last_attempted_at: true,
      requested_at: true,
      completed_at: true,
      receipt: { select: { response_digest: true } },
    },
  });
  const recentOperations = [{
    operationIndex: 0,
    operationKind: "start",
    state: "pending",
    sendCount: 0,
    sentAt: null,
    acknowledgedAt: null,
    operationIdDigest: promotionJobSha256(startId),
    requestDigest: promotionJobSha256("start request"),
    receiptDigest: null,
  }, {
    operationIndex: 1,
    operationKind: "applyBatch",
    state: "sent",
    sendCount: 2,
    sentAt: batchAttemptedAt,
    acknowledgedAt: null,
    operationIdDigest: promotionJobSha256(batchId),
    requestDigest: promotionJobSha256("batch request"),
    receiptDigest: null,
  }, {
    operationIndex: 2,
    operationKind: "finalize",
    state: "acknowledged",
    sendCount: 1,
    sentAt: finalizeAttemptedAt,
    acknowledgedAt: finalizeCompletedAt,
    operationIdDigest: promotionJobSha256(finalizeId),
    requestDigest: promotionJobSha256("finalize request"),
    receiptDigest,
  }];
  const orderedOperationDigest = promotionJobSha256(recentOperations.map(
    (operation) => [
      operation.operationIndex,
      operation.operationKind,
      operation.state,
      operation.sendCount,
      operation.operationIdDigest,
      operation.requestDigest,
      operation.receiptDigest ?? "",
    ].join(":"),
  ).join("\n"));
  assert.deepEqual(evidence, {
    totalOperationCount: 3,
    orderedOperationDigest,
    recentOperations,
  });
});

test("provider A completes from its cached pin while provider B is independently unreachable", async () => {
  const authorityA = authority(providerA, 1);
  const authorityB = authority(providerB, 2);
  const bootstrapA = bootstrap({
    providerId: providerA,
    providerKey: "courtyard",
    configVersionId: configA,
    ordinal: 1,
  });
  const bootstrapB = bootstrap({
    providerId: providerB,
    providerKey: "clutchpacks",
    configVersionId: configB,
    ordinal: 2,
  });
  const providerClient = {} as ProviderPrismaClient;
  let centralAvailable = true;
  let aGatewayEntries = 0;
  let bGatewayEntries = 0;
  const gatewayA: ProviderPromotionPinnedGateway = {
    async runWithCachedProviderDatabase(receivedRoute, operation) {
      aGatewayEntries += 1;
      assert.equal(receivedRoute, bootstrapA.route);
      assert.equal(centralAvailable, false);
      return {
        state: "reachable",
        providerId: providerA,
        value: await operation(providerClient),
        observedAt: base.toISOString(),
      };
    },
  };
  const gatewayB: ProviderPromotionPinnedGateway = {
    async runWithCachedProviderDatabase(receivedRoute) {
      bGatewayEntries += 1;
      assert.equal(receivedRoute, bootstrapB.route);
      return {
        state: "unreachable",
        providerId: providerB,
        failureCode: "database_unreachable",
        retryHint: "retry",
        observedAt: base.toISOString(),
      };
    },
  };

  const [a, b] = await Promise.all([
    runPinnedProviderPromotionOnce({
      authority: authorityA,
      workerId: "promotion:a",
      request: request("provider-a"),
      dependencies: {
        async bootstrapProvider(input) {
          assert.deepEqual(input, { providerId: providerA });
          centralAvailable = false;
          return bootstrapA;
        },
        gateway: gatewayA,
        createTransport(received) {
          assert.equal(received, authorityA);
          return inertTransport;
        },
        createBoundRunner(input) {
          assert.equal(input.provider, providerClient);
          assert.equal(input.providerId, providerA);
          assert.equal(input.pin, bootstrapA.pin);
          return {
            async run() {
              return {
                state: "terminal",
                invocation: terminalInvocation(1),
              };
            },
          };
        },
      },
    }),
    runPinnedProviderPromotionOnce({
      authority: authorityB,
      workerId: "promotion:b",
      request: request("provider-b"),
      dependencies: {
        async bootstrapProvider(input) {
          assert.deepEqual(input, { providerId: providerB });
          return bootstrapB;
        },
        gateway: gatewayB,
        createTransport: () => inertTransport,
        createBoundRunner() {
          throw new Error("An unreachable provider must not bind a runner.");
        },
      },
    }),
  ]);

  assert.equal(a.state, "terminal");
  assert.equal(a.state === "terminal" ? a.invocation.outcome : null, "caught_up");
  assert.deepEqual(b, {
    state: "database_unreachable",
    providerId: providerB,
    failureCode: "database_unreachable",
    retryHint: "retry",
    observedAt: base.toISOString(),
  });
  assert.equal(aGatewayEntries, 1);
  assert.equal(bGatewayEntries, 1);
});

test("a mismatched provider pin or route fails before gateway and credential use", async () => {
  const configured = authority(providerA, 1);
  let gatewayEntries = 0;
  let transports = 0;
  const result = await runPinnedProviderPromotionOnce({
    authority: configured,
    workerId: "promotion:a",
    request: request("mismatched-authority"),
    dependencies: {
      async bootstrapProvider(input) {
        assert.deepEqual(input, { providerId: providerA });
        return bootstrap({
          providerId: providerB,
          providerKey: "clutchpacks",
          configVersionId: configB,
          ordinal: 2,
        });
      },
      gateway: {
        async runWithCachedProviderDatabase() {
          gatewayEntries += 1;
          throw new Error("must not route");
        },
      },
      createTransport() {
        transports += 1;
        return inertTransport;
      },
    },
  });
  assert.deepEqual(result, {
    state: "authority_unavailable",
    providerId: providerA,
    failureCode: "PROVIDER_PROMOTION_AUTHORITY_UNAVAILABLE",
  });
  assert.equal(gatewayEntries, 0);
  assert.equal(transports, 0);
});
