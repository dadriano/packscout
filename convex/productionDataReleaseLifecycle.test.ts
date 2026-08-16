/// <reference types="vite/client" />

import {
  PRODUCTION_DATA_RELEASE_PATHS,
  recomputeProductionManifestFingerprint,
  type ProductionStartManifest,
} from "@packscout/contracts";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  PROVIDER_TEST_KEY_ID,
  PROVIDER_TEST_KEY_SECRET,
  signedProviderInit,
} from "./providerReleaseSecurity.test-support";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function configureEnvironment(): void {
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    JSON.stringify({
      [PROVIDER_TEST_KEY_ID]: btoa(PROVIDER_TEST_KEY_SECRET),
    }),
  );
  vi.stubEnv("PACKSCOUT_PUBLIC_ORIGIN_SET_HASH", "a".repeat(64));
}

function manifest(
  publicReleaseId: string,
  changes: Partial<ProductionStartManifest> = {},
): ProductionStartManifest {
  return {
    publicReleaseId,
    sourceWatermark: "public-sequence:1",
    observationSequence: 1,
    manifestFingerprint: "0".repeat(64),
    contentHash: "1".repeat(64),
    publicConfigRevision: 1,
    publicConfigHash: "2".repeat(64),
    originSetHash: "3".repeat(64),
    searchAlgorithmVersion: "repack_search_v2",
    repackSearchIndexHash: "4".repeat(64),
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
    batchChainHash: "5".repeat(64),
    publicAssetOrigins: [],
    ...changes,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("legacy production data release reads and hashes", () => {
  test("authenticated active state reports an empty deployment", async () => {
    configureEnvironment();
    const body = {
      schemaVersion: "data_release_v2",
      operationId: "catalog-active-state",
    };
    const response = await convexTest({
      schema,
      modules,
      transactionLimits: true,
    }).fetch(
      PRODUCTION_DATA_RELEASE_PATHS.activeState,
      await signedProviderInit(PRODUCTION_DATA_RELEASE_PATHS.activeState, body),
    );
    const envelope = await response.json();
    expect(response.status, JSON.stringify(envelope)).toBe(200);
    expect(envelope).toMatchObject({
      ok: true,
      receipt: {
        operationKind: "activeState",
        publicationId: null,
        details: {
          activePublicReleaseId: null,
          observationSequence: 0,
          terminalReceiptSha256: null,
        },
      },
      responseAuth: {
        signatureVersion: "v1",
        keyId: PROVIDER_TEST_KEY_ID,
      },
    });
  });

  test("manifest fingerprint ignores release and observation identity", async () => {
    const first = manifest("10000000-0000-4000-8000-000000000001");
    const second = manifest("10000000-0000-4000-8000-000000000002", {
      sourceWatermark: "public-sequence:99",
      observationSequence: 99,
      createdAt: "2026-08-16T11:59:00.000Z",
      dataAsOf: "2026-08-16T11:58:00.000Z",
      lastSuccessfulObservationAt: "2026-08-16T11:59:00.000Z",
      staleAt: "2026-08-16T12:14:00.000Z",
      freshness: "delayed",
      delayedVendorCount: 1,
    });
    await expect(
      recomputeProductionManifestFingerprint(second),
    ).resolves.toBe(await recomputeProductionManifestFingerprint(first));
  });
});
