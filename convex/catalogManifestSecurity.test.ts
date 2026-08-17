/// <reference types="vite/client" />

import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  MAX_CATALOG_MANIFEST_PUBLICATION_BODY_BYTES,
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  canonicalJson,
  catalogManifestSignedReceiptEnvelopeSchema,
} from "@packscout/contracts";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import {
  PROVIDER_TEST_KEY_SECRET,
  signedProviderInit,
  verifyProviderResponseSignature,
} from "./providerReleaseSecurity.test-support";

const modules = import.meta.glob("./**/*.ts");
const PUBLISH_KEY = "catalog-http-publish-v1";
const ROLLBACK_KEY = "catalog-http-rollback-v1";

function createTest() {
  return convexTest({ schema, modules, transactionLimits: true });
}

function configureKeys(): void {
  vi.stubEnv(
    "PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS",
    canonicalJson({
      [PUBLISH_KEY]: btoa(PROVIDER_TEST_KEY_SECRET),
      [ROLLBACK_KEY]: btoa(PROVIDER_TEST_KEY_SECRET),
    }),
  );
  vi.stubEnv(
    "PACKSCOUT_CATALOG_MANIFEST_KEY_ROLES",
    canonicalJson({
      [PUBLISH_KEY]: ["publish"],
      [ROLLBACK_KEY]: ["rollback"],
    }),
  );
}

function activeStateRequest(operationId: string) {
  return {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("catalog manifest HTTP security", () => {
  test("requires auth and a route-specific publish role", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-16T12:00:00.000Z");
    configureKeys();
    const t = createTest();
    const missing = await t.fetch(PRODUCTION_CATALOG_MANIFEST_PATHS.activeState, {
      method: "POST",
      body: canonicalJson(activeStateRequest("catalog:http:missing")),
    });
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({
      code: "CATALOG_MANIFEST_AUTH_MISSING",
    });

    const forbidden = await t.fetch(
      PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
      await signedProviderInit(
        PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
        activeStateRequest("catalog:http:forbidden"),
        {
          keyId: ROLLBACK_KEY,
          secret: PROVIDER_TEST_KEY_SECRET,
          nonce: "catalogHttpForbidden0001",
        },
      ),
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({
      code: "CATALOG_MANIFEST_AUTH_FORBIDDEN",
    });
  });

  test("returns a signed exact pristine state and exact status not-found", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-16T12:00:00.000Z");
    configureKeys();
    const t = createTest();
    const activeResponse = await t.fetch(
      PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
      await signedProviderInit(
        PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
        activeStateRequest("catalog:http:active"),
        {
          keyId: PUBLISH_KEY,
          secret: PROVIDER_TEST_KEY_SECRET,
          nonce: "catalogHttpActive000001",
        },
      ),
    );
    expect(activeResponse.status).toBe(200);
    const activeEnvelope = catalogManifestSignedReceiptEnvelopeSchema.parse(
      await activeResponse.json(),
    );
    expect(activeEnvelope.receipt).toMatchObject({
      operationKind: "activeState",
      details: {
        activeState: {
          generation: 0,
          activeManifest: null,
          terminalReceiptSha256: null,
        },
      },
    });
    expect(
      await verifyProviderResponseSignature(
        activeEnvelope,
        PROVIDER_TEST_KEY_SECRET,
      ),
    ).toBe(true);

    const target = {
      operationKind: "activateManifest" as const,
      operationId: "catalog:missing:operation",
      idempotencyKey: "catalog:missing:operation",
      requestDigest: "a".repeat(64),
      publicReleaseId: "11111111-1111-5111-8111-111111111111",
      manifestFingerprint: "b".repeat(64),
    };
    const statusRequest = {
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      target,
    };
    const statusResponse = await t.fetch(
      PRODUCTION_CATALOG_MANIFEST_PATHS.status,
      await signedProviderInit(
        PRODUCTION_CATALOG_MANIFEST_PATHS.status,
        statusRequest,
        {
          keyId: PUBLISH_KEY,
          secret: PROVIDER_TEST_KEY_SECRET,
          nonce: "catalogHttpStatus000001",
        },
      ),
    );
    expect(statusResponse.status).toBe(200);
    const statusEnvelope = catalogManifestSignedReceiptEnvelopeSchema.parse(
      await statusResponse.json(),
    );
    expect(statusEnvelope.receipt).toMatchObject({
      target,
      terminalState: "not_found",
      requestDigest: target.requestDigest,
      receiptDigest: null,
    });
    expect(
      await verifyProviderResponseSignature(
        statusEnvelope,
        PROVIDER_TEST_KEY_SECRET,
      ),
    ).toBe(true);
  });

  test("enforces canonical JSON, the catalog body cap, and nonce replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-16T12:00:00.000Z");
    configureKeys();
    const t = createTest();
    const request = activeStateRequest("catalog:http:canonical");
    const noncanonical = await t.fetch(
      PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
      await signedProviderInit(
        PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
        request,
        {
          bodyJson: JSON.stringify(request, null, 2),
          keyId: PUBLISH_KEY,
          secret: PROVIDER_TEST_KEY_SECRET,
          nonce: "catalogHttpCanonical001",
        },
      ),
    );
    expect(noncanonical.status).toBe(400);
    await expect(noncanonical.json()).resolves.toMatchObject({
      code: "CATALOG_MANIFEST_REQUEST_INVALID",
    });

    const oversizedBody = `"${"x".repeat(
      MAX_CATALOG_MANIFEST_PUBLICATION_BODY_BYTES,
    )}"`;
    const oversized = await t.fetch(
      PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
      await signedProviderInit(
        PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
        {},
        {
          bodyJson: oversizedBody,
          keyId: PUBLISH_KEY,
          secret: PROVIDER_TEST_KEY_SECRET,
          nonce: "catalogHttpOversized001",
        },
      ),
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      code: "CATALOG_MANIFEST_BODY_TOO_LARGE",
    });

    const replayNonce = "catalogHttpReplay000001";
    const first = await t.fetch(
      PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
      await signedProviderInit(
        PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
        activeStateRequest("catalog:http:replay:one"),
        {
          keyId: PUBLISH_KEY,
          secret: PROVIDER_TEST_KEY_SECRET,
          nonce: replayNonce,
        },
      ),
    );
    expect(first.status).toBe(200);
    const second = await t.fetch(
      PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
      await signedProviderInit(
        PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
        activeStateRequest("catalog:http:replay:two"),
        {
          keyId: PUBLISH_KEY,
          secret: PROVIDER_TEST_KEY_SECRET,
          nonce: replayNonce,
        },
      ),
    );
    expect(second.status).toBe(401);
    await expect(second.json()).resolves.toMatchObject({
      code: "CATALOG_MANIFEST_AUTH_REPLAYED",
    });
  });
});
