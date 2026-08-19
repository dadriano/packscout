import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  PRODUCTION_AUTH_HEADER_NAMES,
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  productionHeatReceiptHash,
  productionPublicationReceiptSigningValue,
  productionPublicationRequestSigningValue,
  productionReceiptHash,
} from "@packscout/contracts";
import { CatalogPublicationClientError } from "./convex-catalog-publication-client.ts";
import { SignedConvexHeatPublicationClient } from "./convex-heat-publication-client.ts";

const keyId = "catalog-publisher.v1";
const secret = Buffer.from("heat-publisher-test-secret-000000000000000000000");
const now = new Date("2026-08-15T12:00:00.000Z");
const frameId = "84000000-0000-4000-8000-000000000001";
const releaseId = "82000000-0000-5000-8000-000000000001";
const manifestAlignment = Object.freeze({
  publicReleaseId: releaseId,
  manifestFingerprint: "1".repeat(64),
  sharedConfigurationEpoch: Object.freeze({
    configurationKey: "catalog-v1",
    revision: 1,
    publicChangeSequence: "20",
    configurationHash: "2".repeat(64),
  }),
  providerReferenceSetHash: "3".repeat(64),
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function activeStateEnvelope(bodyJson: string) {
  const receiptWithoutDigest = {
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    operationId: "heat-active-state",
    operationKind: "activeState" as const,
    publicationId: frameId,
    terminalState: "observed" as const,
    result: "active_state" as const,
    serverTime: now.toISOString(),
    requestDigest: sha256(bodyJson),
    details: {
      activePublicHeatFrameId: frameId,
      manifestAlignment,
      sourceWatermark: "44",
      frameSequence: 29_779_200,
      terminalReceiptSha256: "a".repeat(64),
    },
  };
  const receipt = {
    ...receiptWithoutDigest,
    receiptDigest: await productionHeatReceiptHash(receiptWithoutDigest),
  };
  const receiptDigest = await productionReceiptHash(receipt);
  return {
    ok: true,
    receipt,
    responseAuth: {
      signatureVersion: "v1",
      keyId,
      receiptDigest,
      signature: createHmac("sha256", secret)
        .update(productionPublicationReceiptSigningValue(receiptDigest))
        .digest("hex"),
    },
  };
}

test("Heat uses the shared signed HTTP byte and nonce boundary", async () => {
  const bodies: string[] = [];
  const nonces: string[] = [];
  let sequence = 0;
  const client = new SignedConvexHeatPublicationClient({
    baseUrl: "https://convex.example",
    keyId,
    secret,
    now: () => now,
    nonce: () => `nonce000000000000000${++sequence}`,
    fetch: async (input, init) => {
      assert.equal(
        String(input),
        "https://convex.example/internal/repack-heat/v1/active-state",
      );
      const bodyJson = String(init?.body);
      bodies.push(bodyJson);
      const headers = new Headers(init?.headers);
      const nonce = headers.get(PRODUCTION_AUTH_HEADER_NAMES.nonce)!;
      nonces.push(nonce);
      const bodyDigest = sha256(bodyJson);
      assert.equal(
        headers.get(PRODUCTION_AUTH_HEADER_NAMES.contentSha256),
        bodyDigest,
      );
      assert.equal(
        headers.get(PRODUCTION_AUTH_HEADER_NAMES.signature),
        createHmac("sha256", secret).update(
          productionPublicationRequestSigningValue({
            method: "POST",
            path: "/internal/repack-heat/v1/active-state",
            bodyDigest,
            timestamp: String(now.getTime()),
            nonce,
          }),
        ).digest("hex"),
      );
      return new Response(JSON.stringify(await activeStateEnvelope(bodyJson)), {
        status: 200,
      });
    },
  });
  assert.deepEqual(await client.activeState(), {
    activePublicHeatFrameId: frameId,
    manifestAlignment,
    sourceWatermark: 44n,
    frameSequence: 29_779_200,
    terminalReceiptSha256: "a".repeat(64),
  });
  await client.activeState();
  const expectedBody = canonicalJson({
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    operationId: "heat-active-state",
  });
  assert.deepEqual(bodies, [expectedBody, expectedBody]);
  assert.deepEqual(nonces, [
    "nonce0000000000000001",
    "nonce0000000000000002",
  ]);
});

test("Heat shares catalog cancellation, timeout, and error identity", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const cancelled = new SignedConvexHeatPublicationClient({
    baseUrl: "https://convex.example",
    keyId,
    secret,
    now: () => now,
    nonce: () => "nonce0000000000000001",
    timeoutMilliseconds: 30_000,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      started();
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  });
  const cancellation = assert.rejects(
    cancelled.activeState(controller.signal),
    (error: unknown) => error instanceof CatalogPublicationClientError &&
      error.name === "CatalogPublicationClientError" &&
      error.code === "PUBLICATION_CANCELLED" && error.ambiguous,
  );
  await requestStarted;
  controller.abort();
  await cancellation;

  const timedOut = new SignedConvexHeatPublicationClient({
    baseUrl: "https://convex.example",
    keyId,
    secret,
    now: () => now,
    nonce: () => "nonce0000000000000002",
    timeoutMilliseconds: 100,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  });
  await assert.rejects(
    timedOut.activeState(),
    (error: unknown) => error instanceof CatalogPublicationClientError &&
      error.code === "PUBLICATION_TIMEOUT" && error.ambiguous,
  );
});

test("Heat status binds not-found to the exact operation identity", async () => {
  const client = new SignedConvexHeatPublicationClient({
    baseUrl: "https://convex.example",
    keyId,
    secret,
    now: () => now,
    nonce: () => "nonce0000000000000001",
    fetch: async (input, init) => {
      assert.equal(
        String(input),
        "https://convex.example/internal/repack-heat/v1/status",
      );
      const bodyJson = String(init?.body);
      assert.deepEqual(JSON.parse(bodyJson), {
        schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
        operationId: "heat:start:frame",
        publicationId: frameId,
      });
      const receipt = {
        schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
        operationId: "heat:start:frame",
        publicationId: frameId,
        terminalState: "not_found",
        result: "not_found",
        serverTime: now.toISOString(),
        requestDigest: sha256(bodyJson),
        details: {},
        receiptDigest: null,
      } as const;
      const receiptDigest = await productionReceiptHash(receipt);
      return new Response(JSON.stringify({
        ok: true,
        receipt,
        responseAuth: {
          signatureVersion: "v1",
          keyId,
          receiptDigest,
          signature: createHmac("sha256", secret)
            .update(productionPublicationReceiptSigningValue(receiptDigest))
            .digest("hex"),
        },
      }));
    },
  });
  assert.equal(await client.status({
    operationId: "heat:start:frame",
    publicationId: frameId,
    expectedRequestDigest: "b".repeat(64),
    expectedKind: "start",
  }), null);
});

test("Heat keeps corrupt, oversized, and malformed responses ambiguous", async () => {
  const bodyJson = canonicalJson({
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    operationId: "heat-active-state",
  });
  const tampered = await activeStateEnvelope(bodyJson);
  tampered.receipt.receiptDigest = "c".repeat(64);
  const tamperedOuterDigest = await productionReceiptHash(tampered.receipt);
  tampered.responseAuth.receiptDigest = tamperedOuterDigest;
  tampered.responseAuth.signature = createHmac("sha256", secret)
    .update(productionPublicationReceiptSigningValue(tamperedOuterDigest))
    .digest("hex");
  const responses = [
    () => new Response(new Uint8Array([0xff])),
    () => new Response("{}", { headers: { "content-length": "1025" } }),
    () => new Response("{not-json"),
    () => new Response(JSON.stringify(tampered)),
  ];
  for (const response of responses) {
    const client = new SignedConvexHeatPublicationClient({
      baseUrl: "https://convex.example",
      keyId,
      secret,
      now: () => now,
      nonce: () => "nonce0000000000000001",
      maximumResponseBytes: 1_024,
      fetch: async () => response(),
    });
    await assert.rejects(
      client.activeState(),
      (error: unknown) => error instanceof CatalogPublicationClientError &&
        error.ambiguous && error.disposition === "retryable" &&
        (error.code === "PUBLICATION_RESPONSE_INVALID" ||
          error.code === "PUBLICATION_RESPONSE_AUTH_INVALID"),
    );
  }
});
