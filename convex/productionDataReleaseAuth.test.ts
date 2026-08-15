/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import {
  recomputeProductionManifestFingerprint,
  recomputeProductionOriginSetHash,
  type ProductionStartRequest,
} from "./productionDataReleaseProtocol";

const modules = import.meta.glob("./**/*.ts");
const PATH = "/internal/data-release/v2/start";
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

async function digest(value: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

async function sign(value: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
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

async function signedInit(
  body: unknown,
  input: {
    timestamp?: string;
    nonce?: string;
    keyId?: string;
    secret?: string;
    signature?: string;
    bodyJson?: string;
  } = {},
): Promise<RequestInit> {
  const bodyJson = input.bodyJson ?? JSON.stringify(body);
  const bodyHash = await digest(bodyJson);
  const timestamp = input.timestamp ?? String(Date.now());
  const nonce = input.nonce ?? "nonce0000000000000001";
  const keyId = input.keyId ?? KEY_ID;
  const signedValue = ["v1", "POST", PATH, bodyHash, timestamp, nonce].join("\n");
  return {
    method: "POST",
    body: bodyJson,
    headers: {
      "content-type": "application/json",
      "x-packscout-signature-version": "v1",
      "x-packscout-key-id": keyId,
      "x-packscout-timestamp": timestamp,
      "x-packscout-nonce": nonce,
      "x-packscout-content-sha256": bodyHash,
      "x-packscout-signature":
        input.signature ?? await sign(signedValue, input.secret),
    },
  };
}

async function startRequest(
  publicReleaseId = "20000000-0000-4000-8000-000000000001",
): Promise<ProductionStartRequest> {
  const originSetHash = await recomputeProductionOriginSetHash([]);
  const request = {
    schemaVersion: "data_release_v2",
    operationId: `start:${publicReleaseId}`,
    idempotencyKey: `start:${publicReleaseId}`,
    publicationId: publicReleaseId,
    expectedPredecessorPublicReleaseId: null,
    manifest: {
      publicReleaseId,
      sourceWatermark: "public-sequence:1",
      observationSequence: 1,
      manifestFingerprint: "0".repeat(64),
      contentHash: "1".repeat(64),
      publicConfigRevision: 1,
      publicConfigHash: "2".repeat(64),
      originSetHash,
      searchAlgorithmVersion: "repack_search_v2",
      repackSearchIndexHash: "3".repeat(64),
      confidencePolicyVersion: "confidence_v1",
      createdAt: "2026-08-15T11:59:00.000Z",
      dataAsOf: "2026-08-15T11:58:00.000Z",
      lastSuccessfulObservationAt: "2026-08-15T11:59:00.000Z",
      staleAt: "2026-08-15T12:14:00.000Z",
      freshness: "fresh",
      delayedVendorCount: 0,
      counts: {
        vendors: 1,
        categories: 0,
        collectibles: 0,
        repacks: 0,
        repackChases: 0,
        searchShards: 0,
      },
      batchCount: 1,
      batchChainHash: "4".repeat(64),
      publicAssetOrigins: [],
    },
  } satisfies ProductionStartRequest;
  request.manifest.manifestFingerprint =
    await recomputeProductionManifestFingerprint(request);
  return request;
}

async function configure() {
  const originSetHash = await recomputeProductionOriginSetHash([]);
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    JSON.stringify({ [KEY_ID]: SECRET }),
  );
  vi.stubEnv("PACKSCOUT_PUBLIC_ORIGIN_SET_HASH", originSetHash);
}

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ code });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("production publication authentication", () => {
  test("rejects missing, unknown, invalid, stale, and oversized requests before writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    await configure();
    const request = await startRequest();
    const t = createTest();

    await expectCode(
      await t.fetch(PATH, { method: "POST", body: JSON.stringify(request) }),
      401,
      "PUBLICATION_AUTH_MISSING",
    );
    await expectCode(
      await t.fetch(
        PATH,
        await signedInit(request, {
          keyId: "retired-v1",
          secret: "packscout-retired-publication-secret-00000000001",
          nonce: "nonce0000000000000002",
        }),
      ),
      401,
      "PUBLICATION_AUTH_KEY_UNKNOWN",
    );
    await expectCode(
      await t.fetch(
        PATH,
        await signedInit(request, {
          signature: "f".repeat(64),
          nonce: "nonce0000000000000003",
        }),
      ),
      401,
      "PUBLICATION_AUTH_INVALID",
    );
    await expectCode(
      await t.fetch(
        PATH,
        await signedInit(request, {
          timestamp: String(Date.now() - 5 * 60 * 1_000 - 1),
          nonce: "nonce0000000000000004",
        }),
      ),
      401,
      "PUBLICATION_AUTH_STALE",
    );
    const oversizedBody = JSON.stringify({ value: "x".repeat(128 * 1_024) });
    await expectCode(
      await t.fetch(
        PATH,
        await signedInit({}, {
          bodyJson: oversizedBody,
          nonce: "nonce0000000000000005",
        }),
      ),
      413,
      "PUBLICATION_BODY_TOO_LARGE",
    );
    const counts = await t.run(async (ctx) => ({
      releases: (await ctx.db.query("dataReleases").take(2)).length,
      nonces: (await ctx.db.query("dataReleaseAuthNonces").take(2)).length,
    }));
    expect(counts).toEqual({ releases: 0, nonces: 0 });
  });

  test("burns a valid nonce and rejects its replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    await configure();
    const t = createTest();
    const init = await signedInit(await startRequest(), {
      nonce: "nonce0000000000000099",
    });
    expect((await t.fetch(PATH, init)).status).toBe(200);
    await expectCode(
      await t.fetch(PATH, init),
      401,
      "PUBLICATION_AUTH_REPLAYED",
    );
    const counts = await t.run(async (ctx) => ({
      releases: (await ctx.db.query("dataReleases").take(2)).length,
      nonces: (await ctx.db.query("dataReleaseAuthNonces").take(2)).length,
    }));
    expect(counts).toEqual({ releases: 1, nonces: 1 });
  });

  test("rejects unsupported schema and protected source fields with stable errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    await configure();
    const t = createTest();
    await expectCode(
      await t.fetch(
        PATH,
        await signedInit(
          { schemaVersion: "data_release_v1" },
          { nonce: "nonce0000000000000010" },
        ),
      ),
      400,
      "PUBLICATION_SCHEMA_UNSUPPORTED",
    );
    const protectedRequest = {
      ...(await startRequest()),
      tenantId: "must-not-cross-the-boundary",
    };
    await expectCode(
      await t.fetch(
        PATH,
        await signedInit(protectedRequest, {
          nonce: "nonce0000000000000011",
        }),
      ),
      400,
      "PUBLICATION_PROTECTED_FIELD",
    );
    expect(
      await t.run((ctx) => ctx.db.query("dataReleases").first()),
    ).toBeNull();
  });

  test("blocks identical unsafe content under every publication identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    await configure();
    const first = await startRequest(
      "20000000-0000-4000-8000-000000000011",
    );
    const second = await startRequest(
      "20000000-0000-4000-8000-000000000012",
    );
    expect(second.manifest.manifestFingerprint).toBe(
      first.manifest.manifestFingerprint,
    );
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("blockedDataReleaseManifests", {
        fingerprint: first.manifest.manifestFingerprint,
        active: true,
        blockSequence: 1,
        originatingOperationId: "security:block:1",
        sanitizedReason: "unsafe public configuration",
        blockedAt: "2026-08-15T11:59:00.000Z",
        releasedAt: null,
        releaseReceiptHash: null,
      });
    });
    await expectCode(
      await t.fetch(
        PATH,
        await signedInit(first, { nonce: "nonce0000000000000020" }),
      ),
      409,
      "PUBLICATION_MANIFEST_BLOCKED",
    );
    await expectCode(
      await t.fetch(
        PATH,
        await signedInit(second, { nonce: "nonce0000000000000021" }),
      ),
      409,
      "PUBLICATION_MANIFEST_BLOCKED",
    );
    expect(
      await t.run((ctx) => ctx.db.query("dataReleases").first()),
    ).toBeNull();
  });

  test("conflicting operation replay changes no staged data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-15T12:00:00.000Z");
    await configure();
    const t = createTest();
    const request = await startRequest();
    expect(
      (await t.fetch(
        PATH,
        await signedInit(request, { nonce: "nonce0000000000000030" }),
      )).status,
    ).toBe(200);
    const conflict = {
      ...request,
      manifest: {
        ...request.manifest,
        sourceWatermark: "public-sequence:changed",
      },
    };
    await expectCode(
      await t.fetch(
        PATH,
        await signedInit(conflict, { nonce: "nonce0000000000000031" }),
      ),
      409,
      "PUBLICATION_OPERATION_CONFLICT",
    );
    const counts = await t.run(async (ctx) => ({
      releases: (await ctx.db.query("dataReleases").take(3)).length,
      publications: (await ctx.db.query("dataReleasePublications").take(3)).length,
      operations: (await ctx.db.query("dataReleaseOperations").take(3)).length,
    }));
    expect(counts).toEqual({ releases: 1, publications: 1, operations: 1 });
  });
});
