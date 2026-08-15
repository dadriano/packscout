/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  REPACK_SEARCH_INDEX_HASH_DOMAIN,
  REPACK_SEARCH_SHARD_HASH_DOMAIN,
  canonicalJson,
  sha256CanonicalJson,
} from "./dataReleaseCanonicalHash";
import {
  MOCK_DATA_RELEASE_PUBLIC_ID,
  buildMockDataReleaseV2,
} from "./mockDataReleaseFixture";
import { buildMockRepackSearchRows } from "./mockDataReleaseSearch";
import {
  extendProductionBatchChain,
  productionBatchByteCount,
  recomputeProductionBatchHash,
  recomputeProductionManifestFingerprint,
  recomputeProductionOriginSetHash,
  type ProductionApplyBatchRequest,
  type ProductionStartRequest,
} from "./productionDataReleaseProtocol";

const modules = import.meta.glob("./**/*.ts");
type PublicationTest = TestConvex<typeof schema>;

const KEY_ID = "publisher-v1";
const KEY_SECRET = "packscout-test-publication-secret-000000000001";
const PUBLICATION_ID = "10000000-0000-4000-8000-000000000001";
const NEXT_PUBLICATION_ID = "10000000-0000-4000-8000-000000000002";

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function configureEnvironment(originSetHash: string) {
  vi.stubEnv("PACKSCOUT_RUNTIME_ENVIRONMENT", "local");
  vi.stubEnv("PACKSCOUT_MOCK_DATA_RELEASE_SEED_ENABLED", "1");
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    JSON.stringify({ [KEY_ID]: KEY_SECRET }),
  );
  vi.stubEnv("PACKSCOUT_PUBLIC_ORIGIN_SET_HASH", originSetHash);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(KEY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(value),
      ),
    ),
  );
}

async function bodyDigest(bodyJson: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(bodyJson),
      ),
    ),
  );
}

let nonceSequence = 0;
async function signedFetch(
  t: PublicationTest,
  path: string,
  body: unknown,
  overrides: Partial<Record<string, string>> = {},
) {
  nonceSequence += 1;
  const bodyJson = JSON.stringify(body);
  const digest = await bodyDigest(bodyJson);
  const timestamp = String(Date.now());
  const nonce = `nonce${String(nonceSequence).padStart(16, "0")}`;
  const signedValue = ["v1", "POST", path, digest, timestamp, nonce].join("\n");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-packscout-signature-version": "v1",
    "x-packscout-key-id": KEY_ID,
    "x-packscout-timestamp": timestamp,
    "x-packscout-nonce": nonce,
    "x-packscout-content-sha256": digest,
    "x-packscout-signature": await hmacHex(signedValue),
    ...overrides,
  };
  return await t.fetch(path, { method: "POST", headers, body: bodyJson });
}

type PublicationPlan = Awaited<ReturnType<typeof buildPublicationPlan>>;

async function buildPublicationPlan(
  publicationId = PUBLICATION_ID,
  expectedPredecessorPublicReleaseId: string | null =
    MOCK_DATA_RELEASE_PUBLIC_ID,
) {
  const fixture = buildMockDataReleaseV2();
  const rows = buildMockRepackSearchRows(fixture);
  const shard = {
    shardNumber: 0,
    rowCount: rows.length,
    byteCount: new TextEncoder().encode(canonicalJson(rows)).byteLength,
    contentHash: await sha256CanonicalJson(
      REPACK_SEARCH_SHARD_HASH_DOMAIN,
      rows,
    ),
    rows,
  };
  const repackSearchIndexHash = await sha256CanonicalJson(
    REPACK_SEARCH_INDEX_HASH_DOMAIN,
    [{
      shardNumber: shard.shardNumber,
      rowCount: shard.rowCount,
      byteCount: shard.byteCount,
      contentHash: shard.contentHash,
    }],
  );
  const rawBatches = [
    { kind: "vendors" as const, records: fixture.vendors },
    {
      kind: "categories" as const,
      records: [...fixture.categories].sort(
        (left, right) =>
          left.depth - right.depth ||
          left.publicCategoryId.localeCompare(right.publicCategoryId),
      ),
    },
    { kind: "collectibles" as const, records: fixture.collectibles },
    { kind: "repacks" as const, records: fixture.repacks },
    { kind: "repack_chases" as const, records: fixture.repackChases },
    { kind: "search_shards" as const, records: [shard] },
  ];
  const batches: ProductionApplyBatchRequest[] = [];
  let chainHash = "0".repeat(64);
  for (const [batchIndex, batch] of rawBatches.entries()) {
    const batchHash = await recomputeProductionBatchHash(batch);
    const request = {
      schemaVersion: "data_release_v2" as const,
      operationId: `apply:${publicationId}:${batchIndex}`,
      idempotencyKey: `apply:${publicationId}:${batchIndex}`,
      publicationId,
      batchIndex,
      batchHash,
      ...batch,
    } as ProductionApplyBatchRequest;
    chainHash = await extendProductionBatchChain({
      previousHash: chainHash,
      batchIndex,
      kind: request.kind,
      batchHash,
      recordCount: request.records.length,
      byteCount: productionBatchByteCount(request.records),
    });
    batches.push(request);
  }
  const originSetHash = await recomputeProductionOriginSetHash(
    fixture.publicAssetOrigins,
  );
  const contentHash = await sha256CanonicalJson(
    "packscout.test.production-content.v2",
    { publication: 1, repacks: fixture.repacks },
  );
  const start = {
    schemaVersion: "data_release_v2",
    operationId: `start:${publicationId}`,
    idempotencyKey: `start:${publicationId}`,
    publicationId,
    expectedPredecessorPublicReleaseId,
    manifest: {
      publicReleaseId: publicationId,
      sourceWatermark: "public-sequence:2",
      observationSequence: 2,
      manifestFingerprint: "0".repeat(64),
      contentHash,
      publicConfigRevision: fixture.metadata.publicConfigRevision,
      publicConfigHash: fixture.metadata.publicConfigHash,
      originSetHash,
      searchAlgorithmVersion: "repack_search_v2",
      repackSearchIndexHash,
      confidencePolicyVersion: fixture.metadata.confidencePolicyVersion,
      createdAt: fixture.metadata.createdAt,
      dataAsOf: fixture.metadata.dataAsOf,
      lastSuccessfulObservationAt:
        fixture.metadata.lastSuccessfulObservationAt,
      staleAt: fixture.metadata.staleAt,
      freshness: fixture.metadata.freshness,
      delayedVendorCount: fixture.metadata.delayedVendorCount,
      counts: {
        vendors: fixture.vendors.length,
        categories: fixture.categories.length,
        collectibles: fixture.collectibles.length,
        repacks: fixture.repacks.length,
        repackChases: fixture.repackChases.length,
        searchShards: 1,
      },
      batchCount: batches.length,
      batchChainHash: chainHash,
      publicAssetOrigins: fixture.publicAssetOrigins,
    },
  } satisfies ProductionStartRequest;
  start.manifest.manifestFingerprint =
    await recomputeProductionManifestFingerprint(start);
  const finalize = {
    schemaVersion: "data_release_v2" as const,
    operationId: `finalize:${publicationId}`,
    idempotencyKey: `finalize:${publicationId}`,
    publicationId,
    expectedPredecessorPublicReleaseId,
    expectedCounts: start.manifest.counts,
    expectedBatchCount: batches.length,
    expectedBatchChainHash: chainHash,
  };
  return { start, batches, finalize, originSetHash, contentHash };
}

async function receipt(response: Response) {
  const body = await response.json() as {
    ok?: boolean;
    receipt?: Record<string, unknown>;
    responseAuth?: {
      signatureVersion?: string;
      keyId?: string;
      receiptDigest?: string;
      signature?: string;
    };
    code?: string;
  };
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.responseAuth).toMatchObject({
    signatureVersion: "v1",
    keyId: KEY_ID,
  });
  expect(body.responseAuth?.receiptDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(body.responseAuth?.signature).toMatch(/^[0-9a-f]{64}$/);
  return body.receipt!;
}

async function seedPriorRelease(t: PublicationTest, plan: PublicationPlan) {
  configureEnvironment(plan.originSetHash);
  await t.mutation(internal.mockDataReleaseSeed.seed, {});
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  nonceSequence = 0;
});

describe("production data release lifecycle", () => {
  test("authenticated active state reports an empty deployment", async () => {
    configureEnvironment("a".repeat(64));
    const observed = await receipt(await signedFetch(
      createTest(),
      "/internal/data-release/v2/active-state",
      {
        schemaVersion: "data_release_v2",
        operationId: "catalog-active-state",
      },
    ));
    expect(observed).toMatchObject({
      operationKind: "activeState",
      publicationId: null,
      details: {
        activePublicReleaseId: null,
        observationSequence: 0,
        terminalReceiptSha256: null,
      },
    });
  });

  test("keeps the prior release visible until exact reconciliation atomically finalizes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const plan = await buildPublicationPlan();
    const t = createTest();
    await seedPriorRelease(t, plan);

    const before = await t.query(api.publicRepacks.getPublicShellStatus, {});
    expect(before).toMatchObject({
      ok: true,
      data: { metadata: { publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID } },
    });

    const firstStart = await receipt(
      await signedFetch(t, "/internal/data-release/v2/start", plan.start),
    );
    const replayedStart = await receipt(
      await signedFetch(t, "/internal/data-release/v2/start", plan.start),
    );
    expect(replayedStart).toEqual(firstStart);
    const staged = await t.run(async (ctx) => ({
      release: await ctx.db
        .query("dataReleases")
        .withIndex("by_public_release_id", (index) =>
          index.eq("publicReleaseId", PUBLICATION_ID),
        )
        .unique(),
      pointer: await ctx.db.query("dataReleaseState").unique(),
    }));
    expect(staged.release).toMatchObject({
      lifecycle: "staging",
      metadata: { completedAt: null },
    });
    expect(staged.pointer?.activeReleaseId).not.toBe(staged.release?._id);

    const vendorBatch = plan.batches[0]!;
    if (vendorBatch.kind !== "vendors") {
      throw new Error("Expected the deterministic vendor batch first.");
    }
    const badHashBatch = {
      ...vendorBatch,
      operationId: "apply:bad-hash",
      idempotencyKey: "apply:bad-hash",
      batchHash: "f".repeat(64),
    };
    const badHashResponse = await signedFetch(
      t,
      "/internal/data-release/v2/apply-batch",
      badHashBatch,
    );
    expect(badHashResponse.status).toBe(409);
    await expect(badHashResponse.json()).resolves.toMatchObject({
      code: "PUBLICATION_BATCH_CONFLICT",
    });
    const unapprovedVendorBatch = {
      ...vendorBatch,
      operationId: "apply:unapproved-origin",
      idempotencyKey: "apply:unapproved-origin",
      records: [
        {
          ...vendorBatch.records[0],
          imageOrigins: ["https://unapproved.example"],
        },
      ],
    };
    unapprovedVendorBatch.batchHash = await recomputeProductionBatchHash({
      kind: "vendors",
      records: unapprovedVendorBatch.records,
    });
    const unapprovedOriginResponse = await signedFetch(
      t,
      "/internal/data-release/v2/apply-batch",
      unapprovedVendorBatch,
    );
    expect(unapprovedOriginResponse.status).toBe(400);
    await expect(unapprovedOriginResponse.json()).resolves.toMatchObject({
      code: "PUBLICATION_ENTITY_INVALID",
    });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("vendors")
          .withIndex("by_release_id_and_public_vendor_id", (index) =>
            index.eq("releaseId", staged.release!._id),
          )
          .first(),
      ),
    ).toBeNull();

    for (const batch of plan.batches) {
      if (batch.kind === "repacks") {
        const firstRepack = batch.records[0]!;
        const unapprovedAction = {
          ...firstRepack,
          actions: {
            ...firstRepack.actions,
            promo: firstRepack.actions.promo === undefined
              ? { code: "UNAPPROVED", label: "Unapproved" }
              : {
                  ...firstRepack.actions.promo,
                  label: `${firstRepack.actions.promo.label} changed`,
                },
          },
          actionAvailability: {
            ...firstRepack.actionAvailability,
            promo: true,
          },
        };
        const invalidActionBatch = {
          ...batch,
          operationId: "apply:unapproved-action",
          idempotencyKey: "apply:unapproved-action",
          records: [unapprovedAction],
          batchHash: await recomputeProductionBatchHash({
            kind: "repacks",
            records: [unapprovedAction],
          }),
        };
        const invalidActionResponse = await signedFetch(
          t,
          "/internal/data-release/v2/apply-batch",
          invalidActionBatch,
        );
        expect(invalidActionResponse.status).toBe(400);
        await expect(invalidActionResponse.json()).resolves.toMatchObject({
          code: "PUBLICATION_ENTITY_INVALID",
        });
      }
      const first = await receipt(
        await signedFetch(
          t,
          "/internal/data-release/v2/apply-batch",
          batch,
        ),
      );
      const replay = await receipt(
        await signedFetch(
          t,
          "/internal/data-release/v2/apply-batch",
          batch,
        ),
      );
      expect(replay).toEqual(first);
      if (batch.kind === "vendors") {
        const conflictingReplay = {
          ...batch,
          records: [
            {
              ...batch.records[0],
              displayName: `${batch.records[0]!.displayName} conflict`,
            },
          ],
        };
        conflictingReplay.batchHash = await recomputeProductionBatchHash({
          kind: "vendors",
          records: conflictingReplay.records,
        });
        const conflictResponse = await signedFetch(
          t,
          "/internal/data-release/v2/apply-batch",
          conflictingReplay,
        );
        expect(conflictResponse.status).toBe(409);
        await expect(conflictResponse.json()).resolves.toMatchObject({
          code: "PUBLICATION_OPERATION_CONFLICT",
        });
      }
      const during = await t.query(api.publicRepacks.getPublicShellStatus, {});
      expect(during).toMatchObject({
        ok: true,
        data: { metadata: { publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID } },
      });
    }

    const blockId = await t.run((ctx) =>
      ctx.db.insert("blockedDataReleaseManifests", {
        fingerprint: plan.start.manifest.manifestFingerprint,
        active: true,
        blockSequence: 2,
        originatingOperationId: "block:before-finalize",
        sanitizedReason: "unsafe before activation",
        blockedAt: "2026-08-15T12:00:00.000Z",
        releasedAt: null,
        releaseReceiptHash: null,
      }),
    );
    const blockedFinalizeResponse = await signedFetch(
      t,
      "/internal/data-release/v2/finalize",
      {
        ...plan.finalize,
        operationId: "finalize:blocked",
        idempotencyKey: "finalize:blocked",
      },
    );
    expect(blockedFinalizeResponse.status).toBe(409);
    await expect(blockedFinalizeResponse.json()).resolves.toMatchObject({
      code: "PUBLICATION_MANIFEST_BLOCKED",
    });
    await t.run((ctx) =>
      ctx.db.patch("blockedDataReleaseManifests", blockId, {
        active: false,
        releasedAt: "2026-08-15T12:00:00.000Z",
      }),
    );

    const mismatchedFinalizeResponse = await signedFetch(
      t,
      "/internal/data-release/v2/finalize",
      {
        ...plan.finalize,
        operationId: "finalize:mismatch",
        idempotencyKey: "finalize:mismatch",
        expectedBatchChainHash: "f".repeat(64),
      },
    );
    expect(mismatchedFinalizeResponse.status).toBe(409);
    await expect(mismatchedFinalizeResponse.json()).resolves.toMatchObject({
      code: "PUBLICATION_RECONCILIATION_FAILED",
    });
    const afterMismatch = await t.query(
      api.publicRepacks.getPublicShellStatus,
      {},
    );
    expect(afterMismatch).toMatchObject({
      ok: true,
      data: { metadata: { publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID } },
    });

    const finalized = await receipt(
      await signedFetch(t, "/internal/data-release/v2/finalize", plan.finalize),
    );
    const activeAfterFinalize = await receipt(await signedFetch(
      t,
      "/internal/data-release/v2/active-state",
      {
        schemaVersion: "data_release_v2",
        operationId: "catalog-active-state",
      },
    ));
    expect(activeAfterFinalize).toMatchObject({
      operationKind: "activeState",
      publicationId: PUBLICATION_ID,
      details: {
        activePublicReleaseId: PUBLICATION_ID,
        observationSequence: 2,
        terminalReceiptSha256: await bodyDigest(canonicalJson(finalized)),
      },
    });
    expect(finalized).toMatchObject({
      operationId: plan.finalize.operationId,
      terminalState: "complete",
      result: "activated",
      publicationId: PUBLICATION_ID,
    });
    const replayedFinalize = await receipt(
      await signedFetch(t, "/internal/data-release/v2/finalize", plan.finalize),
    );
    expect(replayedFinalize).toEqual(finalized);
    const finalizeConflictResponse = await signedFetch(
      t,
      "/internal/data-release/v2/finalize",
      {
        ...plan.finalize,
        expectedBatchChainHash: "e".repeat(64),
      },
    );
    expect(finalizeConflictResponse.status).toBe(409);
    await expect(finalizeConflictResponse.json()).resolves.toMatchObject({
      code: "PUBLICATION_OPERATION_CONFLICT",
    });

    const after = await t.query(api.publicRepacks.getPublicShellStatus, {});
    expect(after).toMatchObject({
      ok: true,
      data: { metadata: { publicReleaseId: PUBLICATION_ID } },
    });
    const state = await t.run((ctx) => ctx.db.query("dataReleaseState").unique());
    const previous = await t.run((ctx) =>
      state?.previousReleaseId === null || state === null
        ? Promise.resolve(null)
        : ctx.db.get("dataReleases", state.previousReleaseId),
    );
    expect(previous?.publicReleaseId).toBe(MOCK_DATA_RELEASE_PUBLIC_ID);
  });

  test("status recovers the exact terminal receipt and refresh changes freshness only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const plan = await buildPublicationPlan();
    const t = createTest();
    await seedPriorRelease(t, plan);
    await receipt(await signedFetch(t, "/internal/data-release/v2/start", plan.start));
    for (const batch of plan.batches) {
      await receipt(
        await signedFetch(t, "/internal/data-release/v2/apply-batch", batch),
      );
    }
    const finalized = await receipt(
      await signedFetch(t, "/internal/data-release/v2/finalize", plan.finalize),
    );
    const status = await receipt(
      await signedFetch(t, "/internal/data-release/v2/status", {
        schemaVersion: "data_release_v2",
        operationId: plan.finalize.operationId,
        publicationId: PUBLICATION_ID,
      }),
    );
    expect(status).toEqual(finalized);

    const before = await t.run(async (ctx) => ({
      release: await ctx.db
        .query("dataReleases")
        .withIndex("by_public_release_id", (index) =>
          index.eq("publicReleaseId", PUBLICATION_ID),
        )
        .unique(),
      state: await ctx.db.query("dataReleaseState").unique(),
      entityIds: (await ctx.db.query("repacks").collect()).map(({ _id }) => _id),
    }));
    vi.setSystemTime("2026-08-15T12:05:00.000Z");
    const refresh = {
      schemaVersion: "data_release_v2",
      operationId: "refresh:3",
      idempotencyKey: "refresh:3",
      publicReleaseId: PUBLICATION_ID,
      contentHash: plan.contentHash,
      observationSequence: 3,
      dataAsOf: "2026-08-11T12:01:00.000Z",
      lastSuccessfulObservationAt: "2026-08-15T12:05:00.000Z",
      staleAt: "2026-08-15T12:20:00.000Z",
      freshness: "delayed",
      delayedVendorCount: 1,
    };
    const refreshed = await receipt(
      await signedFetch(
        t,
        "/internal/data-release/v2/refresh-observation",
        refresh,
      ),
    );
    const activeAfterRefresh = await receipt(await signedFetch(
      t,
      "/internal/data-release/v2/active-state",
      {
        schemaVersion: "data_release_v2",
        operationId: "catalog-active-state",
      },
    ));
    expect(activeAfterRefresh).toMatchObject({
      publicationId: PUBLICATION_ID,
      details: {
        observationSequence: 3,
        terminalReceiptSha256: await bodyDigest(canonicalJson(refreshed)),
      },
    });
    const after = await t.run(async (ctx) => ({
      release: await ctx.db
        .query("dataReleases")
        .withIndex("by_public_release_id", (index) =>
          index.eq("publicReleaseId", PUBLICATION_ID),
        )
        .unique(),
      state: await ctx.db.query("dataReleaseState").unique(),
      entityIds: (await ctx.db.query("repacks").collect()).map(({ _id }) => _id),
    }));
    expect(after.release).toEqual(before.release);
    expect(after.entityIds).toEqual(before.entityIds);
    expect(after.state).toMatchObject({
      activeReleaseId: before.state?.activeReleaseId,
      previousReleaseId: before.state?.previousReleaseId,
      latestObservationSequence: 3,
      freshness: "delayed",
      delayedVendorCount: 1,
    });
    const staleRefreshResponse = await signedFetch(
      t,
      "/internal/data-release/v2/refresh-observation",
      {
        ...refresh,
        operationId: "refresh:stale",
        idempotencyKey: "refresh:stale",
        lastSuccessfulObservationAt: "2026-08-15T12:06:00.000Z",
        staleAt: "2026-08-15T12:21:00.000Z",
      },
    );
    expect(staleRefreshResponse.status).toBe(409);
    await expect(staleRefreshResponse.json()).resolves.toMatchObject({
      code: "PUBLICATION_REFRESH_STALE",
    });
    expect(
      await t.run((ctx) => ctx.db.query("dataReleaseState").unique()),
    ).toEqual(after.state);
  });

  test("fingerprint identity cannot be changed by publication or predecessor identity", async () => {
    const first = await buildPublicationPlan(PUBLICATION_ID);
    const second = await buildPublicationPlan(
      NEXT_PUBLICATION_ID,
      "10000000-0000-4000-8000-000000000099",
    );
    expect(first.start.manifest.manifestFingerprint).toBe(
      second.start.manifest.manifestFingerprint,
    );
  });
});
