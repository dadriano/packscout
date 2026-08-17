/// <reference types="vite/client" />

import {
  CATALOG_RETENTION_SCHEMA_VERSION,
  PRODUCTION_CATALOG_RETENTION_PATHS,
  canonicalJson,
  catalogRetentionPostgresProofSnapshotDigest,
  catalogRetentionPublicationRequestDigest,
  catalogRetentionSignedReceiptEnvelopeSchema,
  type CatalogRetentionPostgresProofSnapshot,
} from "@packscout/contracts";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import {
  PROVIDER_TEST_KEY_ID,
  PROVIDER_TEST_KEY_SECRET,
  emptyProviderHead,
  signedProviderInit,
  verifyProviderResponseSignature,
} from "./providerReleaseSecurity.test-support";

const modules = import.meta.glob("./**/*.ts");
const RETENTION_KEY = "catalog-retain-http-v1";
const PUBLISH_KEY = "catalog-publish-http-v1";
const SERVER_TIME = "2026-08-16T12:00:00.000Z";

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function configureKeys(): void {
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    canonicalJson({
      [PUBLISH_KEY]: btoa(PROVIDER_TEST_KEY_SECRET),
      [RETENTION_KEY]: btoa(PROVIDER_TEST_KEY_SECRET),
    }),
  );
  vi.stubEnv(
    "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
    canonicalJson({
      [PUBLISH_KEY]: ["publish"],
      [RETENTION_KEY]: ["retain"],
    }),
  );
  vi.stubEnv(
    "PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS",
    canonicalJson({ [PROVIDER_TEST_KEY_ID]: "alpha" }),
  );
}

async function manifestRequest(operationId: string) {
  const proofWithoutDigest: Omit<
    CatalogRetentionPostgresProofSnapshot,
    "snapshotDigest"
  > = {
    snapshotId: `retention:snapshot:${operationId}`,
    snapshotSequence: "1",
    evaluatedAt: SERVER_TIME,
    activeState: {
      state: {
        generation: 0,
        activeManifest: null,
        previousManifest: null,
        observation: null,
        terminalReceiptSha256: null,
      },
      terminalOperationId: null,
    },
    completedHeads: [{
      platformKey: "alpha",
      completedHead: emptyProviderHead("alpha"),
      terminalOperationId: null,
    }],
    manifestProtections: [],
    providerProtectionsByPlatform: [],
  };
  return {
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationId,
    idempotencyKey: operationId,
    expectedRetentionGeneration: 0,
    maximumDocuments: 90,
    phase: "manifests" as const,
    postgresProof: {
      ...proofWithoutDigest,
      snapshotDigest:
        await catalogRetentionPostgresProofSnapshotDigest(proofWithoutDigest),
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("catalog retention HTTP security", () => {
  test("requires authentication and the dedicated retain role", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    configureKeys();
    const t = createTest();
    const request = await manifestRequest("retention:http:role");
    const missing = await t.fetch(
      PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests,
      { method: "POST", body: canonicalJson(request) },
    );
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({
      code: "CATALOG_RETENTION_AUTH_MISSING",
    });

    const forbidden = await t.fetch(
      PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests,
      await signedProviderInit(
        PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests,
        request,
        {
          keyId: PUBLISH_KEY,
          secret: PROVIDER_TEST_KEY_SECRET,
          nonce: "retentionHttpForbidden01",
        },
      ),
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({
      code: "CATALOG_RETENTION_AUTH_FORBIDDEN",
    });
  });

  test("returns signed exact replay/status and isolates nonce replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_TIME);
    configureKeys();
    const t = createTest();
    const request = await manifestRequest("retention:http:success");
    const nonce = "retentionHttpSuccess0001";
    const response = await t.fetch(
      PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests,
      await signedProviderInit(
        PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests,
        request,
        {
          keyId: RETENTION_KEY,
          secret: PROVIDER_TEST_KEY_SECRET,
          nonce,
        },
      ),
    );
    expect(response.status).toBe(200);
    const envelope = catalogRetentionSignedReceiptEnvelopeSchema.parse(
      await response.json(),
    );
    expect(envelope.receipt).toMatchObject({
      operationKind: "retainManifests",
      operationId: request.operationId,
      expectedRetentionGeneration: 0,
      retentionGeneration: 1,
    });
    expect(await verifyProviderResponseSignature(
      envelope,
      PROVIDER_TEST_KEY_SECRET,
    )).toBe(true);

    const replayedNonce = await t.fetch(
      PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests,
      await signedProviderInit(
        PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests,
        request,
        {
          keyId: RETENTION_KEY,
          secret: PROVIDER_TEST_KEY_SECRET,
          nonce,
        },
      ),
    );
    expect(replayedNonce.status).toBe(401);
    await expect(replayedNonce.json()).resolves.toMatchObject({
      code: "CATALOG_RETENTION_AUTH_REPLAYED",
    });

    const target = {
      operationKind: "retainManifests" as const,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      phase: "manifests" as const,
      platformKey: null,
      requestDigest: await catalogRetentionPublicationRequestDigest(request),
    };
    const statusRequest = {
      schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
      target,
    };
    const status = await t.fetch(
      PRODUCTION_CATALOG_RETENTION_PATHS.status,
      await signedProviderInit(
        PRODUCTION_CATALOG_RETENTION_PATHS.status,
        statusRequest,
        {
          keyId: RETENTION_KEY,
          secret: PROVIDER_TEST_KEY_SECRET,
          nonce: "retentionHttpStatus00001",
        },
      ),
    );
    expect(status.status).toBe(200);
    const statusEnvelope = catalogRetentionSignedReceiptEnvelopeSchema.parse(
      await status.json(),
    );
    expect(statusEnvelope.receipt).toEqual(envelope.receipt);
  });
});
