/// <reference types="vite/client" />

import {
  MAX_PROVIDER_RELEASE_PUBLICATION_BODY_BYTES,
  PRODUCTION_DATA_RELEASE_PATHS,
  PRODUCTION_PROVIDER_RELEASE_PATHS,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  providerReleaseCompletedHeadReceiptSchema,
  providerReleaseSignedReceiptEnvelopeSchema,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseCompletedHeadReceipt,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseStatusOperationKind,
} from "@packscout/contracts";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  MOCK_DATA_RELEASE_ORIGIN_SET_HASH,
  MOCK_DATA_RELEASE_PUBLIC_ID,
} from "./mockDataReleaseFixture";
import {
  PROVIDER_BETA_TEST_KEY_ID,
  PROVIDER_BETA_TEST_KEY_SECRET,
  PROVIDER_TEST_KEY_ID,
  PROVIDER_TEST_KEY_SECRET,
  buildProviderPublishPlan,
  emptyProviderHead,
  providerOperationEnvelope,
  providerReleaseContext,
  providerReleaseProof,
  providerRequestDigest,
  signedProviderBytesInit,
  signedProviderInit,
  verifyProviderResponseSignature,
} from "./providerReleaseSecurity.test-support";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type ProviderTest = TestConvex<typeof schema>;

function createTest(): ProviderTest {
  return convexTest({ schema, modules, transactionLimits: true });
}

let nonceSequence = 0;

async function signedFetch(
  t: ProviderTest,
  path: string,
  body: unknown,
  input: Parameters<typeof signedProviderInit>[2] = {},
): Promise<Response> {
  nonceSequence += 1;
  return await t.fetch(path, await signedProviderInit(path, body, {
    nonce: `nonce${String(nonceSequence).padStart(16, "0")}`,
    ...input,
  }));
}

async function expectError(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body).toMatchObject({ code });
}

async function receipt(
  response: Response,
  secret = PROVIDER_TEST_KEY_SECRET,
) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  const envelope = providerReleaseSignedReceiptEnvelopeSchema.parse(body);
  await expect(verifyProviderResponseSignature(envelope, secret)).resolves.toBe(true);
  return envelope.receipt;
}

function configureProvider(originSetHash: string): void {
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    JSON.stringify({
      [PROVIDER_TEST_KEY_ID]: btoa(PROVIDER_TEST_KEY_SECRET),
      [PROVIDER_BETA_TEST_KEY_ID]: btoa(PROVIDER_BETA_TEST_KEY_SECRET),
    }),
  );
  vi.stubEnv(
    "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
    JSON.stringify({
      [PROVIDER_TEST_KEY_ID]: "alpha",
      [PROVIDER_BETA_TEST_KEY_ID]: "beta",
    }),
  );
  vi.stubEnv("PACKSCOUT_PUBLIC_ORIGIN_SET_HASH", originSetHash);
}

async function seedLegacyRelease(
  t: ProviderTest,
  providerOriginSetHash: string,
): Promise<void> {
  vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
  vi.stubEnv("PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED", "1");
  vi.stubEnv(
    "PACKSCOUT_PUBLIC_ORIGIN_SET_HASH",
    MOCK_DATA_RELEASE_ORIGIN_SET_HASH,
  );
  await t.mutation(internal.mockDataReleaseSeed.seed, {});
  configureProvider(providerOriginSetHash);
}

async function publicVisibility(t: ProviderTest) {
  return {
    shell: await t.query(api.publicRepacks.getPublicShellStatus, {}),
    dashboard: await t.query(api.publicRepacks.getDashboardBundle, {}),
    legacy: await t.run(async (ctx) => ({
      state: await ctx.db.query("dataReleaseState").unique(),
      releases: await ctx.db.query("dataReleases").take(10),
      publications: await ctx.db.query("dataReleasePublications").take(10),
    })),
  };
}

function mutationRequests(
  plan: ProviderCatalogReleasePublishPlanV1,
  expectedCompletedHead: ProviderReleaseExpectedCompletedHeadV1,
) {
  const suffix = `${plan.platformKey}:${plan.providerCheckpoint.settledSequence}`;
  const context = providerReleaseContext(plan, expectedCompletedHead);
  return {
    start: {
      ...providerOperationEnvelope(`provider:start:${suffix}`),
      ...context,
    },
    batch: {
      ...providerOperationEnvelope(`provider:batch:${suffix}:0`),
      ...context,
      batch: plan.batches[0]!,
    },
    finalize: {
      ...providerOperationEnvelope(`provider:finalize:${suffix}`),
      ...context,
    },
  };
}

async function statusRequest(
  operationKind: ProviderReleaseStatusOperationKind,
  request: {
    operationId: string;
    idempotencyKey: string;
    release?: { platformKey: string; publicProviderReleaseId: string };
    platformKey?: string;
  },
) {
  return {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    target: {
      operationKind,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.release?.platformKey ?? request.platformKey!,
      publicProviderReleaseId:
        operationKind === "cleanup"
          ? null
          : request.release!.publicProviderReleaseId,
      requestDigest: await providerRequestDigest(request),
    },
  };
}

function expectedHeadFromObserved(
  receiptValue: ProviderReleaseCompletedHeadReceipt,
): ProviderReleaseExpectedCompletedHeadV1 {
  if (
    receiptValue.operationKind !== "completedHead" ||
    receiptValue.details.head.release === null
  ) {
    throw new Error("Expected a nonempty completed provider head.");
  }
  const head = receiptValue.details.head;
  return {
    platformKey: head.platformKey,
    publicProviderReleaseId: head.release.publicProviderReleaseId,
    sharedConfigurationEpoch: head.release.sharedConfigurationEpoch,
    providerCheckpoint: head.providerCheckpoint,
    observation: head.observation,
    terminalReceiptSha256: head.terminalReceiptSha256,
  };
}

async function observedHead(
  t: ProviderTest,
  platformKey: string,
  operationId: string,
) {
  return providerReleaseCompletedHeadReceiptSchema.parse(
    await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.completedHead,
      {
        schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
        operationId,
        platformKey,
      },
    )),
  );
}

async function completePlan(
  t: ProviderTest,
  plan: ProviderCatalogReleasePublishPlanV1,
  expected: ProviderReleaseExpectedCompletedHeadV1,
) {
  const requests = mutationRequests(plan, expected);
  await receipt(await signedFetch(
    t,
    PRODUCTION_PROVIDER_RELEASE_PATHS.start,
    requests.start,
  ));
  await receipt(await signedFetch(
    t,
    PRODUCTION_PROVIDER_RELEASE_PATHS.applyBatch,
    requests.batch,
  ));
  const finalized = await receipt(await signedFetch(
    t,
    PRODUCTION_PROVIDER_RELEASE_PATHS.finalize,
    requests.finalize,
  ));
  return { finalized, requests };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  nonceSequence = 0;
});

describe("provider release HTTP security", () => {
  test("fails closed for auth, bounds, schema, and protected fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const plan = await buildProviderPublishPlan();
    configureProvider(plan.governingHashes.originSetHash);
    const t = createTest();
    const request = mutationRequests(
      plan,
      emptyProviderHead(plan.platformKey),
    ).start;
    const path = PRODUCTION_PROVIDER_RELEASE_PATHS.start;

    await expectError(
      await t.fetch(path, { method: "POST", body: JSON.stringify(request) }),
      401,
      "PROVIDER_RELEASE_AUTH_MISSING",
    );
    await expectError(
      await signedFetch(t, path, request, {
        keyId: "retired-v1",
        secret: "packscout-retired-publication-secret-00000000001",
      }),
      401,
      "PROVIDER_RELEASE_AUTH_KEY_UNKNOWN",
    );
    await expectError(
      await signedFetch(t, path, request, { signature: "f".repeat(64) }),
      401,
      "PROVIDER_RELEASE_AUTH_INVALID",
    );
    await expectError(
      await signedFetch(t, path, request, {
        timestamp: String(Date.now() - 5 * 60 * 1_000 - 1),
      }),
      401,
      "PROVIDER_RELEASE_AUTH_STALE",
    );
    await expectError(
      await signedFetch(t, path, request, { nonce: "not-valid" }),
      401,
      "PROVIDER_RELEASE_AUTH_INVALID",
    );
    const digestMismatch = await signedProviderInit(path, request, {
      nonce: "nonce0000000000000501",
    });
    const mismatchedHeaders = new Headers(digestMismatch.headers);
    mismatchedHeaders.set("x-packscout-content-sha256", "f".repeat(64));
    await expectError(
      await t.fetch(path, { ...digestMismatch, headers: mismatchedHeaders }),
      401,
      "PROVIDER_RELEASE_AUTH_INVALID",
    );
    await expectError(
      await t.fetch(
        path,
        await signedProviderInit(
          PRODUCTION_PROVIDER_RELEASE_PATHS.finalize,
          request,
          { nonce: "nonce0000000000000502" },
        ),
      ),
      401,
      "PROVIDER_RELEASE_AUTH_INVALID",
    );
    const oversizedBody = JSON.stringify({
      value: "x".repeat(MAX_PROVIDER_RELEASE_PUBLICATION_BODY_BYTES),
    });
    await expectError(
      await signedFetch(t, path, {}, { bodyJson: oversizedBody }),
      413,
      "PROVIDER_RELEASE_BODY_TOO_LARGE",
    );
    await expectError(
      await signedFetch(t, path, {}, { bodyJson: "{" }),
      400,
      "PROVIDER_RELEASE_REQUEST_INVALID",
    );
    await expectError(
      await signedFetch(t, path, request, {
        bodyJson: ` ${JSON.stringify(request)} `,
      }),
      400,
      "PROVIDER_RELEASE_REQUEST_INVALID",
    );
    await expectError(
      await t.fetch(
        path,
        await signedProviderBytesInit(
          path,
          Uint8Array.from([0xc3, 0x28]),
          { nonce: "nonce0000000000000503" },
        ),
      ),
      400,
      "PROVIDER_RELEASE_REQUEST_INVALID",
    );
    await expectError(
      await signedFetch(t, path, {
        schemaVersion: "provider_release_publication_v0",
      }),
      400,
      "PROVIDER_RELEASE_SCHEMA_UNSUPPORTED",
    );
    await expectError(
      await signedFetch(t, path, { ...request, tenantId: "private" }),
      400,
      "PROVIDER_RELEASE_PROTECTED_FIELD",
    );
    await expectError(
      await signedFetch(t, path, { ...request, unexpected: true }),
      400,
      "PROVIDER_RELEASE_REQUEST_INVALID",
    );
    expect(await t.run(async (ctx) => ({
      releases: (await ctx.db.query("providerCatalogReleases").take(2)).length,
      operations:
        (await ctx.db.query("providerCatalogOperations").take(2)).length,
    }))).toEqual({ releases: 0, operations: 0 });

    const replayInit = await signedProviderInit(path, request, {
      nonce: "nonce0000000000000999",
    });
    await receipt(await t.fetch(path, replayInit));
    await expectError(
      await t.fetch(path, replayInit),
      401,
      "PROVIDER_RELEASE_AUTH_REPLAYED",
    );
    expect(await t.run(async (ctx) => ({
      releases: (await ctx.db.query("providerCatalogReleases").take(2)).length,
      operations:
        (await ctx.db.query("providerCatalogOperations").take(2)).length,
    }))).toEqual({ releases: 1, operations: 1 });
  });

  test("leaves every legacy single-release write route unregistered", async () => {
    const t = createTest();
    const legacyWritePaths = [
      PRODUCTION_DATA_RELEASE_PATHS.start,
      PRODUCTION_DATA_RELEASE_PATHS.applyBatch,
      PRODUCTION_DATA_RELEASE_PATHS.finalize,
      PRODUCTION_DATA_RELEASE_PATHS.status,
      PRODUCTION_DATA_RELEASE_PATHS.refreshObservation,
      PRODUCTION_DATA_RELEASE_PATHS.rollback,
      PRODUCTION_DATA_RELEASE_PATHS.retain,
    ];
    for (const path of legacyWritePaths) {
      expect((await t.fetch(path, { method: "POST" })).status, path).toBe(404);
    }
    expect((await t.fetch(
      PRODUCTION_DATA_RELEASE_PATHS.activeState,
      { method: "POST" },
    )).status).not.toBe(404);
  });

  test("binds provider authority to the authenticated key platform", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const plan = await buildProviderPublishPlan({ platformKey: "beta" });
    configureProvider(plan.governingHashes.originSetHash);
    const t = createTest();
    const expected = emptyProviderHead(plan.platformKey);
    const requests = mutationRequests(plan, expected);
    const betaAuth = {
      keyId: PROVIDER_BETA_TEST_KEY_ID,
      secret: PROVIDER_BETA_TEST_KEY_SECRET,
    };

    await expectError(
      await signedFetch(
        t,
        PRODUCTION_PROVIDER_RELEASE_PATHS.start,
        requests.start,
      ),
      409,
      "PROVIDER_RELEASE_PLATFORM_MISMATCH",
    );
    const started = await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.start,
      requests.start,
      betaAuth,
    ), PROVIDER_BETA_TEST_KEY_SECRET);

    const headRequest = {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      operationId: "provider:head:beta:authority",
      platformKey: plan.platformKey,
    };
    await expectError(
      await signedFetch(
        t,
        PRODUCTION_PROVIDER_RELEASE_PATHS.completedHead,
        headRequest,
      ),
      409,
      "PROVIDER_RELEASE_PLATFORM_MISMATCH",
    );
    await expect(receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.completedHead,
      headRequest,
      betaAuth,
    ), PROVIDER_BETA_TEST_KEY_SECRET)).resolves.toMatchObject({
      operationKind: "completedHead",
      publicProviderReleaseId: null,
    });

    const startStatus = await statusRequest("start", requests.start);
    await expectError(
      await signedFetch(
        t,
        PRODUCTION_PROVIDER_RELEASE_PATHS.status,
        startStatus,
      ),
      409,
      "PROVIDER_RELEASE_PLATFORM_MISMATCH",
    );
    await expect(receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.status,
      startStatus,
      betaAuth,
    ), PROVIDER_BETA_TEST_KEY_SECRET)).resolves.toEqual(started);

    const cleanup = {
      ...providerOperationEnvelope("provider:cleanup:beta:authority"),
      platformKey: plan.platformKey,
      expectedCompletedHead: expected,
      cleanupKind: "expired_provider_artifacts" as const,
      maximumDocuments: 1,
    };
    await expectError(
      await signedFetch(
        t,
        PRODUCTION_PROVIDER_RELEASE_PATHS.cleanup,
        cleanup,
      ),
      409,
      "PROVIDER_RELEASE_PLATFORM_MISMATCH",
    );
    await expect(receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.cleanup,
      cleanup,
      betaAuth,
    ), PROVIDER_BETA_TEST_KEY_SECRET)).resolves.toMatchObject({
      operationKind: "cleanup",
      terminalState: "complete",
      details: { deletedDocumentCount: 0, hasMore: false },
    });
  });

  test("binds lost acknowledgements and exact replay without public activation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const plan = await buildProviderPublishPlan();
    const t = createTest();
    await seedLegacyRelease(t, plan.governingHashes.originSetHash);
    const baseline = await publicVisibility(t);
    expect(baseline.shell).toMatchObject({
      ok: true,
      data: { metadata: { publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID } },
    });

    const emptyHead = await observedHead(
      t,
      plan.platformKey,
      "provider:head:alpha:empty",
    );
    expect(emptyHead).toMatchObject({
      operationKind: "completedHead",
      publicProviderReleaseId: null,
      details: { head: { release: null } },
    });
    expect(await publicVisibility(t)).toEqual(baseline);

    const requests = mutationRequests(
      plan,
      emptyProviderHead(plan.platformKey),
    );
    const operations = [
      {
        kind: "start" as const,
        path: PRODUCTION_PROVIDER_RELEASE_PATHS.start,
        request: requests.start,
      },
      {
        kind: "applyBatch" as const,
        path: PRODUCTION_PROVIDER_RELEASE_PATHS.applyBatch,
        request: requests.batch,
      },
      {
        kind: "finalize" as const,
        path: PRODUCTION_PROVIDER_RELEASE_PATHS.finalize,
        request: requests.finalize,
      },
    ];
    for (const operation of operations) {
      const first = await receipt(await signedFetch(
        t,
        operation.path,
        operation.request,
      ));
      const recovered = await receipt(await signedFetch(
        t,
        PRODUCTION_PROVIDER_RELEASE_PATHS.status,
        await statusRequest(operation.kind, operation.request),
      ));
      expect(recovered).toEqual(first);
      const replay = await receipt(await signedFetch(
        t,
        operation.path,
        operation.request,
      ));
      expect(replay).toEqual(first);
      await expectError(
        await signedFetch(t, operation.path, {
          ...operation.request,
          observation: {
            ...operation.request.observation,
            freshness: "delayed",
          },
        }),
        409,
        "PROVIDER_RELEASE_OPERATION_CONFLICT",
      );
      expect(await publicVisibility(t)).toEqual(baseline);
    }

    const finalizeStatus = await statusRequest("finalize", requests.finalize);
    const mismatchedTargets = [
      { ...finalizeStatus.target, operationKind: "start" as const },
      { ...finalizeStatus.target, idempotencyKey: "provider:wrong-binding" },
      {
        ...finalizeStatus.target,
        publicProviderReleaseId: "f0000000-0000-5000-8000-000000000001",
      },
      { ...finalizeStatus.target, requestDigest: "f".repeat(64) },
    ];
    for (const target of mismatchedTargets) {
      await expectError(
        await signedFetch(t, PRODUCTION_PROVIDER_RELEASE_PATHS.status, {
          ...finalizeStatus,
          target,
        }),
        409,
        "PROVIDER_RELEASE_OPERATION_CONFLICT",
      );
    }
    await expectError(
      await signedFetch(t, PRODUCTION_PROVIDER_RELEASE_PATHS.status, {
        ...finalizeStatus,
        target: { ...finalizeStatus.target, platformKey: "beta" },
      }),
      409,
      "PROVIDER_RELEASE_PLATFORM_MISMATCH",
    );
    const unknownStatus = await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.status,
      {
        ...finalizeStatus,
        target: {
          ...finalizeStatus.target,
          operationId: "provider:finalize:alpha:unknown",
          idempotencyKey: "provider:finalize:alpha:unknown",
        },
      },
    ));
    expect(unknownStatus).toMatchObject({
      terminalState: "not_found",
      result: "not_found",
      receiptDigest: null,
    });

    const completed = await observedHead(
      t,
      plan.platformKey,
      "provider:head:alpha:complete",
    );
    expect(completed).toMatchObject({
      operationKind: "completedHead",
      publicProviderReleaseId: plan.publicProviderReleaseId,
      details: {
        head: {
          release: {
            platformKey: plan.platformKey,
            publicProviderReleaseId: plan.publicProviderReleaseId,
          },
          providerCheckpoint: plan.providerCheckpoint,
        },
      },
    });
    expect(await t.run(async (ctx) => ({
      heads:
        (await ctx.db.query("providerCatalogCompletedHeads").take(2)).length,
      releases:
        (await ctx.db.query("providerCatalogReleases").take(2)).length,
      batches: (await ctx.db.query("providerCatalogBatches").take(2)).length,
      operations:
        (await ctx.db.query("providerCatalogOperations").take(5)).length,
    }))).toEqual({ heads: 1, releases: 1, batches: 1, operations: 3 });
    expect(await publicVisibility(t)).toEqual(baseline);
  });

  test("keeps reuse, block, and bounded cleanup private and monotonic", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const plan = await buildProviderPublishPlan();
    const t = createTest();
    await seedLegacyRelease(t, plan.governingHashes.originSetHash);
    const baseline = await publicVisibility(t);
    await completePlan(t, plan, emptyProviderHead(plan.platformKey));
    let expected = expectedHeadFromObserved(await observedHead(
      t,
      plan.platformKey,
      "provider:head:alpha:before-reuse",
    ));

    const reuseCheckpoint = {
      settledSequence: "21",
      settledAt: "2026-08-15T12:05:00.000Z",
    };
    const reuseObservation = {
      sourceHeadSequence: "21",
      lastSuccessfulObservationAt: "2026-08-15T12:04:00.000Z",
      staleAt: "2026-08-15T12:19:00.000Z",
      freshness: "fresh" as const,
    };
    const reuse = {
      ...providerOperationEnvelope("provider:reuse:alpha:21"),
      release: providerReleaseProof(plan),
      providerCheckpoint: reuseCheckpoint,
      sourceWatermark: buildProviderCatalogSourceWatermarkV1("alpha", "21"),
      observation: reuseObservation,
      expectedCompletedHead: expected,
    };
    const reused = await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.confirmReuse,
      reuse,
    ));
    const recoveredReuse = await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.status,
      await statusRequest("confirmReuse", reuse),
    ));
    expect(recoveredReuse).toEqual(reused);
    expect(await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.confirmReuse,
      reuse,
    ))).toEqual(reused);
    expect(await publicVisibility(t)).toEqual(baseline);
    expect(await t.run(async (ctx) => ({
      releases:
        (await ctx.db.query("providerCatalogReleases").take(3)).length,
      publications:
        (await ctx.db.query("providerCatalogPublications").take(3)).length,
      vendors:
        (await ctx.db.query("providerCatalogVendors").take(3)).length,
      batches: (await ctx.db.query("providerCatalogBatches").take(3)).length,
    }))).toEqual({ releases: 1, publications: 1, vendors: 1, batches: 1 });

    expected = expectedHeadFromObserved(await observedHead(
      t,
      plan.platformKey,
      "provider:head:alpha:after-reuse",
    ));
    expect(expected.providerCheckpoint).toEqual(reuseCheckpoint);
    const block = {
      ...providerOperationEnvelope("provider:block:alpha:1"),
      release: providerReleaseProof(plan),
      providerCheckpoint: reuseCheckpoint,
      sourceWatermark: buildProviderCatalogSourceWatermarkV1("alpha", "21"),
      observation: reuseObservation,
      expectedCompletedHead: expected,
      blockSequence: "1",
      reason: "PUBLICATION_SECURITY_INVALID" as const,
    };
    const blocked = await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.block,
      block,
    ));
    expect(await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.block,
      block,
    ))).toEqual(blocked);
    await expectError(
      await signedFetch(t, PRODUCTION_PROVIDER_RELEASE_PATHS.block, {
        ...block,
        operationId: "provider:block:alpha:stale",
        idempotencyKey: "provider:block:alpha:stale",
      }),
      409,
      "PROVIDER_RELEASE_BLOCK_SEQUENCE_REGRESSED",
    );
    await expectError(
      await signedFetch(t, PRODUCTION_PROVIDER_RELEASE_PATHS.confirmReuse, {
        ...reuse,
        operationId: "provider:reuse:alpha:22-blocked",
        idempotencyKey: "provider:reuse:alpha:22-blocked",
        providerCheckpoint: {
          settledSequence: "22",
          settledAt: "2026-08-15T12:06:00.000Z",
        },
        sourceWatermark: buildProviderCatalogSourceWatermarkV1("alpha", "22"),
        observation: {
          ...reuseObservation,
          sourceHeadSequence: "22",
        },
        expectedCompletedHead: expected,
      }),
      409,
      "PROVIDER_RELEASE_FINGERPRINT_BLOCKED",
    );
    expect(await publicVisibility(t)).toEqual(baseline);

    const abandonedPlan = await buildProviderPublishPlan({
      checkpointSequence: "22",
      vendorDisplayName: "Collector Crypt staged replacement",
    });
    const abandoned = mutationRequests(abandonedPlan, expected).start;
    await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.start,
      abandoned,
    ));
    expect(await publicVisibility(t)).toEqual(baseline);

    vi.setSystemTime("2026-08-16T13:00:00.000Z");
    const cleanupBase = {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      platformKey: plan.platformKey,
      expectedCompletedHead: expected,
      cleanupKind: "expired_provider_artifacts" as const,
      maximumDocuments: 1,
    };
    const cleanupOne = {
      ...cleanupBase,
      operationId: "provider:cleanup:alpha:artifacts:1",
      idempotencyKey: "provider:cleanup:alpha:artifacts:1",
    };
    const firstCleanup = await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.cleanup,
      cleanupOne,
    ));
    expect(firstCleanup).toMatchObject({
      terminalState: "continuation_required",
      details: { deletedDocumentCount: 1, hasMore: true },
    });
    expect(await publicVisibility(t)).toEqual(baseline);
    expect(await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.cleanup,
      cleanupOne,
    ))).toEqual(firstCleanup);
    expect(await publicVisibility(t)).toEqual(baseline);
    const secondCleanup = await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.cleanup,
      {
        ...cleanupBase,
        operationId: "provider:cleanup:alpha:artifacts:2",
        idempotencyKey: "provider:cleanup:alpha:artifacts:2",
      },
    ));
    expect(secondCleanup).toMatchObject({
      terminalState: "complete",
      details: { deletedDocumentCount: 1, hasMore: false },
    });
    expect(await publicVisibility(t)).toEqual(baseline);
    const nonceCleanup = await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.cleanup,
      {
        ...providerOperationEnvelope("provider:cleanup:alpha:nonces"),
        platformKey: plan.platformKey,
        expectedCompletedHead: expected,
        cleanupKind: "expired_auth_nonces",
        maximumDocuments: 100,
      },
    ));
    expect(nonceCleanup).toMatchObject({
      operationKind: "cleanup",
      terminalState: "complete",
      details: { cleanupKind: "expired_auth_nonces", hasMore: false },
    });
    expect(await publicVisibility(t)).toEqual(baseline);
    expect(await receipt(await signedFetch(
      t,
      PRODUCTION_PROVIDER_RELEASE_PATHS.status,
      await statusRequest("confirmReuse", reuse),
    ))).toEqual(reused);

    const stored = await t.run(async (ctx) => ({
      releases: await ctx.db.query("providerCatalogReleases").take(5),
      heads: await ctx.db.query("providerCatalogCompletedHeads").take(5),
      blocked:
        await ctx.db.query("providerCatalogReleaseBlocks").take(5),
    }));
    expect(stored.releases).toHaveLength(1);
    expect(stored.releases[0]).toMatchObject({
      lifecycle: "complete",
      publicProviderReleaseId: plan.publicProviderReleaseId,
    });
    expect(stored.heads).toHaveLength(1);
    expect(stored.heads[0]).toMatchObject({
      publicProviderReleaseId: plan.publicProviderReleaseId,
      providerCheckpoint: reuseCheckpoint,
    });
    expect(stored.blocked).toHaveLength(1);
    expect(await publicVisibility(t)).toEqual(baseline);
  });
});
