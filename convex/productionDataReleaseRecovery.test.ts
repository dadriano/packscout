/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import { recomputeProductionOriginSetHash } from "./productionDataReleaseProtocol";

const modules = import.meta.glob("./**/*.ts");
type RecoveryTest = TestConvex<typeof schema>;
const KEY_ID = "publisher-v1";
const SECRET = "packscout-test-publication-secret-000000000001";

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function signedFetch(
  t: RecoveryTest,
  path: string,
  body: unknown,
  nonce: string,
) {
  const bodyJson = JSON.stringify(body);
  const digest = bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(bodyJson),
      ),
    ),
  );
  const timestamp = String(Date.now());
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          ["v1", "POST", path, digest, timestamp, nonce].join("\n"),
        ),
      ),
    ),
  );
  return await t.fetch(path, {
    method: "POST",
    body: bodyJson,
    headers: {
      "content-type": "application/json",
      "x-packscout-signature-version": "v1",
      "x-packscout-key-id": KEY_ID,
      "x-packscout-timestamp": timestamp,
      "x-packscout-nonce": nonce,
      "x-packscout-content-sha256": digest,
      "x-packscout-signature": signature,
    },
  });
}

async function configure() {
  const originSetHash = await recomputeProductionOriginSetHash([]);
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    JSON.stringify({ [KEY_ID]: SECRET }),
  );
  vi.stubEnv("PACKSCOUT_PUBLIC_ORIGIN_SET_HASH", originSetHash);
  return originSetHash;
}

function metadata(input: {
  publicReleaseId: string;
  fingerprint: string;
  originSetHash: string;
  completedAt: string;
}) {
  return {
    schemaVersion: "data_release_v2" as const,
    dataSource: "canonical" as const,
    publicReleaseId: input.publicReleaseId,
    sourceWatermark: `watermark:${input.publicReleaseId}`,
    manifestFingerprint: input.fingerprint,
    contentHash: input.fingerprint,
    publicConfigRevision: 1,
    publicConfigHash: "2".repeat(64),
    originSetHash: input.originSetHash,
    searchAlgorithmVersion: "repack_search_v2" as const,
    repackSearchIndexHash: "3".repeat(64),
    confidencePolicyVersion: "confidence_v1",
    createdAt: "2026-07-01T00:00:00.000Z",
    completedAt: input.completedAt,
    dataAsOf: "2026-07-01T00:00:00.000Z",
    lastSuccessfulObservationAt: "2026-07-01T00:00:00.000Z",
    staleAt: "2026-07-01T00:15:00.000Z",
    freshness: "fresh" as const,
    delayedVendorCount: 0,
    vendorCount: 0,
    categoryCount: 0,
    repackCount: 0,
    collectibleCount: 0,
    repackChaseCount: 0,
  };
}

async function insertCompleteRelease(
  t: RecoveryTest,
  input: {
    publicReleaseId: string;
    fingerprint: string;
    originSetHash: string;
    completedAt: string;
    retentionEligibleAt?: string;
    observationSequence?: number;
  },
) {
  return await t.run(async (ctx) => {
    const releaseId = await ctx.db.insert("dataReleases", {
      publicReleaseId: input.publicReleaseId,
      lifecycle: "complete",
      metadata: metadata(input),
      searchShardCount: 0,
      retentionEligibleAt: input.retentionEligibleAt,
    });
    await ctx.db.insert("dataReleasePublications", {
      publicationId: input.publicReleaseId,
      releaseId,
      expectedPredecessorPublicReleaseId: null,
      publicAssetOrigins: [],
      expectedBatchCount: 0,
      expectedBatchChainHash: "0".repeat(64),
      acceptedBatchCount: 0,
      acceptedBatchChainHash: "0".repeat(64),
      expectedCounts: {
        vendors: 0,
        categories: 0,
        collectibles: 0,
        repacks: 0,
        repackChases: 0,
        searchShards: 0,
      },
      acceptedCounts: {
        vendors: 0,
        categories: 0,
        collectibles: 0,
        repacks: 0,
        repackChases: 0,
        searchShards: 0,
      },
      observationSequence: input.observationSequence ?? 1,
      lastBatchKind: null,
      lastRecordKey: null,
      lastSearchPublicRepackId: null,
      unresolvedRepackCount: 0,
      latestEvidenceAt: null,
      state: "complete",
      createdAt: input.completedAt,
      completedAt: input.completedAt,
    });
    return releaseId;
  });
}

async function jsonReceipt(response: Response) {
  const body = await response.json() as {
    ok?: boolean;
    receipt?: { details?: Record<string, unknown> };
    code?: string;
  };
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.ok).toBe(true);
  return body.receipt!;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("production release recovery and retention", () => {
  test("rollback never retains a known unsafe outgoing release as previous and clear is explicit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const originSetHash = await configure();
    const t = createTest();
    const targetPublicReleaseId = "30000000-0000-4000-8000-000000000001";
    const outgoingPublicReleaseId = "30000000-0000-4000-8000-000000000002";
    const targetId = await insertCompleteRelease(t, {
      publicReleaseId: targetPublicReleaseId,
      fingerprint: "a".repeat(64),
      originSetHash,
      completedAt: "2026-08-01T00:00:00.000Z",
      observationSequence: 1,
    });
    const outgoingId = await insertCompleteRelease(t, {
      publicReleaseId: outgoingPublicReleaseId,
      fingerprint: "b".repeat(64),
      originSetHash,
      completedAt: "2026-08-02T00:00:00.000Z",
      observationSequence: 2,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("dataReleaseState", {
        key: "singleton",
        activeReleaseId: outgoingId,
        previousReleaseId: targetId,
        latestObservationSequence: 2,
        dataAsOf: "2026-08-02T00:00:00.000Z",
        lastSuccessfulObservationAt: "2026-08-02T00:00:00.000Z",
        staleAt: "2026-08-02T00:15:00.000Z",
        freshness: "fresh",
        delayedVendorCount: 0,
        updatedAt: "2026-08-02T00:00:00.000Z",
      });
      await ctx.db.insert("blockedDataReleaseManifests", {
        fingerprint: "b".repeat(64),
        active: true,
        blockSequence: 2,
        originatingOperationId: "block:outgoing",
        sanitizedReason: "unsafe outgoing release",
        blockedAt: "2026-08-15T11:00:00.000Z",
        releasedAt: null,
        releaseReceiptHash: null,
      });
    });
    const rollback = {
      schemaVersion: "data_release_v2",
      operationId: "rollback:1",
      idempotencyKey: "rollback:1",
      expectedActivePublicReleaseId: outgoingPublicReleaseId,
      targetPublicReleaseId,
      clearAuthorization: null,
    };
    const first = await jsonReceipt(
      await signedFetch(
        t,
        "/internal/data-release/v2/rollback",
        rollback,
        "nonce0000000000001001",
      ),
    );
    expect(first.details).toMatchObject({
      activePublicReleaseId: targetPublicReleaseId,
      previousPublicReleaseId: null,
      outgoingFingerprintBlocked: true,
    });
    const state = await t.run((ctx) => ctx.db.query("dataReleaseState").unique());
    expect(state).toMatchObject({
      activeReleaseId: targetId,
      previousReleaseId: null,
    });

    const clear = {
      schemaVersion: "data_release_v2",
      operationId: "rollback:clear",
      idempotencyKey: "rollback:clear",
      expectedActivePublicReleaseId: targetPublicReleaseId,
      targetPublicReleaseId: null,
      clearAuthorization: "clear_catalog_v1",
    };
    const refused = await signedFetch(
      t,
      "/internal/data-release/v2/rollback",
      clear,
      "nonce0000000000001002",
    );
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      code: "PUBLICATION_CLEAR_DISABLED",
    });
    vi.stubEnv("PACKSCOUT_DATA_RELEASE_CLEAR_ENABLED", "1");
    await jsonReceipt(
      await signedFetch(
        t,
        "/internal/data-release/v2/rollback",
        clear,
        "nonce0000000000001003",
      ),
    );
    expect(
      await t.run((ctx) => ctx.db.query("dataReleaseState").unique()),
    ).toMatchObject({ activeReleaseId: null, previousReleaseId: null });
  });

  test("retention preserves pointers, keeps three other complete releases, and deletes in chunks of 100", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const originSetHash = await configure();
    const t = createTest();
    const ids: Id<"dataReleases">[] = [];
    for (let index = 0; index < 7; index += 1) {
      ids.push(
        await insertCompleteRelease(t, {
          publicReleaseId: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          fingerprint: await sha256CanonicalJson("packscout.test.retention", index),
          originSetHash,
          completedAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
          retentionEligibleAt: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
          observationSequence: index + 1,
        }),
      );
    }
    await t.run(async (ctx) => {
      await ctx.db.insert("dataReleaseState", {
        key: "singleton",
        activeReleaseId: ids[6]!,
        previousReleaseId: ids[5]!,
        latestObservationSequence: 7,
        dataAsOf: "2026-07-07T00:00:00.000Z",
        lastSuccessfulObservationAt: "2026-07-07T00:00:00.000Z",
        staleAt: "2026-07-07T00:15:00.000Z",
        freshness: "fresh",
        delayedVendorCount: 0,
        updatedAt: "2026-07-07T00:00:00.000Z",
      });
      const candidate = await ctx.db.get("dataReleases", ids[1]!);
      if (candidate === null) throw new Error("Expected retention candidate.");
      for (let index = 0; index < 105; index += 1) {
        await ctx.db.insert("dataReleaseOperations", {
          operationId: `fixture:${index}`,
          kind: "fixture",
          idempotencyKey: `fixture:${index}`,
          bodyHash: "d".repeat(64),
          publicReleaseId: candidate.publicReleaseId,
          observationSequence: null,
          status: "completed",
          result: "fixture",
          convexReleaseVersion: null,
          confirmationReceiptHash: null,
          acceptedAt: "2026-07-01T00:00:00.000Z",
          completedAt: "2026-07-01T00:00:00.000Z",
        });
      }
    });

    const retain = async (sequence: number) =>
      await jsonReceipt(
        await signedFetch(
          t,
          "/internal/data-release/v2/retain",
          {
            schemaVersion: "data_release_v2",
            operationId: `retain:${sequence}`,
            idempotencyKey: `retain:${sequence}`,
          },
          `nonce${String(sequence).padStart(16, "0")}`,
        ),
      );
    expect((await retain(1)).details).toMatchObject({
      deletedDocumentCount: 100,
      hasMore: true,
    });
    expect(await t.run((ctx) => ctx.db.get("dataReleases", ids[1]!))).not.toBeNull();
    expect((await retain(2)).details).toMatchObject({ hasMore: false });
    expect(await t.run((ctx) => ctx.db.get("dataReleases", ids[1]!))).toBeNull();
    await retain(3);

    const remaining = await t.run((ctx) =>
      ctx.db.query("dataReleases").collect(),
    );
    expect(remaining).toHaveLength(5);
    expect(remaining.some(({ _id }) => _id === ids[6])).toBe(true);
    expect(remaining.some(({ _id }) => _id === ids[5])).toBe(true);
    const state = await t.run((ctx) => ctx.db.query("dataReleaseState").unique());
    expect(state).toMatchObject({
      activeReleaseId: ids[6],
      previousReleaseId: ids[5],
    });
  });

  test("retention finds an age-expired release beyond the newest result window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const originSetHash = await configure();
    const t = createTest();
    const expiredPublicReleaseId =
      "50000000-0000-4000-8000-000000000000";
    const expiredId = await insertCompleteRelease(t, {
      publicReleaseId: expiredPublicReleaseId,
      fingerprint: "e".repeat(64),
      originSetHash,
      completedAt: "2026-06-01T00:00:00.000Z",
      retentionEligibleAt: "2026-06-08T00:00:00.000Z",
    });
    const recentIds: Id<"dataReleases">[] = [];
    for (let index = 1; index <= 12; index += 1) {
      recentIds.push(
        await insertCompleteRelease(t, {
          publicReleaseId: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          fingerprint: await sha256CanonicalJson(
            "packscout.test.retention-recent",
            index,
          ),
          originSetHash,
          completedAt: `2026-08-${String(index).padStart(2, "0")}T00:00:00.000Z`,
          retentionEligibleAt: `2026-09-${String(index).padStart(2, "0")}T00:00:00.000Z`,
        }),
      );
    }
    await t.run(async (ctx) => {
      await ctx.db.insert("dataReleaseState", {
        key: "singleton",
        activeReleaseId: recentIds[11]!,
        previousReleaseId: recentIds[10]!,
        latestObservationSequence: 12,
        dataAsOf: "2026-08-12T00:00:00.000Z",
        lastSuccessfulObservationAt: "2026-08-12T00:00:00.000Z",
        staleAt: "2026-08-12T00:15:00.000Z",
        freshness: "fresh",
        delayedVendorCount: 0,
        updatedAt: "2026-08-12T00:00:00.000Z",
      });
    });
    const retained = await jsonReceipt(
      await signedFetch(
        t,
        "/internal/data-release/v2/retain",
        {
          schemaVersion: "data_release_v2",
          operationId: "retain:expired",
          idempotencyKey: "retain:expired",
        },
        "nonce0000000000009001",
      ),
    );
    expect(retained.details).toMatchObject({
      deletedPublicReleaseId: expiredPublicReleaseId,
      hasMore: false,
    });
    expect(await t.run((ctx) => ctx.db.get("dataReleases", expiredId))).toBeNull();
    expect(
      await t.run((ctx) => ctx.db.get("dataReleases", recentIds[11]!)),
    ).not.toBeNull();
    expect(
      await t.run((ctx) => ctx.db.get("dataReleases", recentIds[10]!)),
    ).not.toBeNull();
  });

  test("retention preserves Heat pointer targets and expires abandoned staging and failed releases", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    const originSetHash = await configure();
    const t = createTest();
    const heatReleaseId = await insertCompleteRelease(t, {
      publicReleaseId: "60000000-0000-4000-8000-000000000001",
      fingerprint: "6".repeat(64),
      originSetHash,
      completedAt: "2026-06-01T00:00:00.000Z",
      retentionEligibleAt: "2026-06-08T00:00:00.000Z",
    });
    await t.run(async (ctx) => {
      const snapshotId = await ctx.db.insert("repackHeatSnapshots", {
        releaseId: heatReleaseId,
        publicHeatSnapshotId: "heat-pointer-target",
        simulationRunId: null,
        sequence: 1,
        lifecycle: "complete",
        sourceKind: "observed",
        scenarioVersion: null,
        aggregationVersion: "aggregate_v1",
        heatPolicyVersion: "heat_v1",
        contentHash: "7".repeat(64),
        signalCount: 0,
        baselineWindowStartedAt: "2026-08-14T11:45:00.000Z",
        baselineWindowEndedAt: "2026-08-15T11:45:00.000Z",
        currentWindowStartedAt: "2026-08-15T11:45:00.000Z",
        currentWindowEndedAt: "2026-08-15T12:00:00.000Z",
        calculatedAt: "2026-08-15T12:00:00.000Z",
        expiresAt: "2026-08-15T12:15:00.000Z",
      });
      await ctx.db.insert("repackHeatState", {
        key: "singleton",
        activeHeatSnapshotId: snapshotId,
        previousHeatSnapshotId: null,
        freshness: "current",
        expiresAt: "2026-08-15T12:15:00.000Z",
        latestSequence: 1,
        updatedAt: "2026-08-15T12:00:00.000Z",
      });
    });
    const protectedReceipt = await jsonReceipt(
      await signedFetch(
        t,
        "/internal/data-release/v2/retain",
        {
          schemaVersion: "data_release_v2",
          operationId: "retain:heat-protected",
          idempotencyKey: "retain:heat-protected",
        },
        "nonce0000000000009101",
      ),
    );
    expect(protectedReceipt.details).toMatchObject({
      deletedPublicReleaseId: null,
    });
    expect(
      await t.run((ctx) => ctx.db.get("dataReleases", heatReleaseId)),
    ).not.toBeNull();

    const abandoned = await t.run(async (ctx) => {
      const create = async (
        publicReleaseId: string,
        lifecycle: "staging" | "failed",
      ) => {
        const releaseId = await ctx.db.insert("dataReleases", {
          publicReleaseId,
          lifecycle,
          metadata: {
            ...metadata({
              publicReleaseId,
              fingerprint: await sha256CanonicalJson(
                "packscout.test.abandoned",
                publicReleaseId,
              ),
              originSetHash,
              completedAt: "2026-08-01T00:00:00.000Z",
            }),
            completedAt: null,
          },
          searchShardCount: 0,
          retentionEligibleAt: "2026-08-14T11:59:59.000Z",
        });
        return releaseId;
      };
      return {
        staging: await create(
          "60000000-0000-4000-8000-000000000002",
          "staging",
        ),
        failed: await create(
          "60000000-0000-4000-8000-000000000003",
          "failed",
        ),
      };
    });
    for (const [sequence, releaseId] of [
      [2, abandoned.staging],
      [3, abandoned.failed],
    ] as const) {
      await jsonReceipt(
        await signedFetch(
          t,
          "/internal/data-release/v2/retain",
          {
            schemaVersion: "data_release_v2",
            operationId: `retain:abandoned:${sequence}`,
            idempotencyKey: `retain:abandoned:${sequence}`,
          },
          `nonce${String(9100 + sequence).padStart(16, "0")}`,
        ),
      );
      expect(await t.run((ctx) => ctx.db.get("dataReleases", releaseId))).toBeNull();
    }
    expect(
      await t.run((ctx) => ctx.db.get("dataReleases", heatReleaseId)),
    ).not.toBeNull();
  });
});
