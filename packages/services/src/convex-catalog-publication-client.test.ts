import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  DATA_RELEASE_SCHEMA_VERSION,
  PRODUCTION_AUTH_HEADER_NAMES,
  canonicalJson,
  productionPublicationReceiptSigningValue,
  productionPublicationRequestSigningValue,
  productionReceiptHash,
  type ProductionReceipt,
} from "@packscout/contracts";
import {
  CatalogPublicationClientError,
  SignedConvexCatalogPublicationClient,
} from "./convex-catalog-publication-client.ts";
import type { CatalogPromotionOperation } from "./catalog-promotion-types.ts";

const keyId = "catalog-publisher.v1";
const secret = Buffer.from("catalog-publisher-test-secret-00000000000000000000");
const now = new Date("2026-08-15T12:00:00.000Z");
const publicationId = "50000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function refreshOperation(): CatalogPromotionOperation {
  const bodyJson = canonicalJson({
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    operationId: "refresh:release:21",
    idempotencyKey: "refresh:release:21",
    publicReleaseId: publicationId,
    contentHash: hash,
    observationSequence: 21,
    dataAsOf: "2026-08-15T11:59:00.000Z",
    lastSuccessfulObservationAt: "2026-08-15T12:00:00.000Z",
    staleAt: "2026-08-15T12:15:00.000Z",
    freshness: "fresh",
    delayedVendorCount: 0,
  });
  return {
    ordinal: 0,
    kind: "refreshObservation",
    operationId: "refresh:release:21",
    publicationId,
    path: "/internal/data-release/v2/refresh-observation",
    bodyJson,
    bodyDigest: sha256(bodyJson),
    dispatchCount: 0,
    lastDispatchedAt: null,
    acknowledgedAt: null,
    receipt: null,
  };
}

async function signedEnvelope(
  receiptWithoutDigest: Omit<ProductionReceipt, "receiptDigest">,
  options: { tamperInner?: boolean; tamperOuter?: boolean } = {},
) {
  const receipt = {
    ...receiptWithoutDigest,
    receiptDigest: options.tamperInner
      ? "b".repeat(64)
      : await productionReceiptHash(receiptWithoutDigest),
  } as ProductionReceipt;
  const receiptDigest = await productionReceiptHash(receipt);
  return {
    ok: true,
    receipt,
    responseAuth: {
      signatureVersion: "v1",
      keyId,
      receiptDigest,
      signature: options.tamperOuter
        ? "c".repeat(64)
        : createHmac("sha256", secret)
          .update(productionPublicationReceiptSigningValue(receiptDigest))
          .digest("hex"),
    },
  };
}

function refreshReceipt(operation: CatalogPromotionOperation) {
  return {
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    operationId: operation.operationId,
    operationKind: "refreshObservation" as const,
    publicationId,
    terminalState: "complete" as const,
    result: "refreshed" as const,
    serverTime: now.toISOString(),
    requestDigest: operation.bodyDigest,
    details: {
      contentHash: hash,
      observationSequence: 21,
      dataAsOf: "2026-08-15T11:59:00.000Z",
      lastSuccessfulObservationAt: "2026-08-15T12:00:00.000Z",
      staleAt: "2026-08-15T12:15:00.000Z",
      freshness: "fresh" as const,
      delayedVendorCount: 0,
    },
  };
}

function client(fetchImplementation: typeof fetch) {
  return new SignedConvexCatalogPublicationClient({
    baseUrl: "https://convex.example",
    keyId,
    secret,
    fetch: fetchImplementation,
    now: () => now,
    nonce: () => "nonce0000000000000001",
  });
}

test("signed Convex client sends exact bytes and verifies both receipt digests", async () => {
  const operation = refreshOperation();
  const transport = client(async (input, init) => {
    assert.equal(String(input), "https://convex.example/internal/data-release/v2/refresh-observation");
    assert.equal(init?.body, operation.bodyJson);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get(PRODUCTION_AUTH_HEADER_NAMES.contentSha256), operation.bodyDigest);
    const signingValue = productionPublicationRequestSigningValue({
      method: "POST",
      path: "/internal/data-release/v2/refresh-observation",
      bodyDigest: operation.bodyDigest,
      timestamp: String(now.getTime()),
      nonce: "nonce0000000000000001",
    });
    assert.equal(
      headers.get(PRODUCTION_AUTH_HEADER_NAMES.signature),
      createHmac("sha256", secret).update(signingValue).digest("hex"),
    );
    return new Response(JSON.stringify(await signedEnvelope(refreshReceipt(operation))), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const receipt = await transport.send(operation);
  assert.equal(receipt.operationId, operation.operationId);
  assert.equal(receipt.operationKind, "refreshObservation");
});

test("signed Convex client rejects outer signatures and inner digest drift", async () => {
  const operation = refreshOperation();
  for (const tampering of [{ tamperOuter: true }, { tamperInner: true }]) {
    const transport = client(async () => new Response(
      JSON.stringify(await signedEnvelope(refreshReceipt(operation), tampering)),
      { status: 200 },
    ));
    await assert.rejects(
      transport.send(operation),
      (error: unknown) => error instanceof CatalogPublicationClientError &&
        error.code === "PUBLICATION_RESPONSE_AUTH_INVALID" &&
        error.disposition === "terminal",
    );
  }
});

test("signed Convex client classifies retryable server responses without leaking bodies", async () => {
  const transport = client(async () => new Response(JSON.stringify({
    error: "The publication request failed safely.",
    code: "PUBLICATION_INTERNAL_ERROR",
  }), { status: 500, headers: { "retry-after": "2" } }));
  await assert.rejects(
    transport.send(refreshOperation()),
    (error: unknown) => error instanceof CatalogPublicationClientError &&
      error.code === "PUBLICATION_INTERNAL_ERROR" &&
      error.disposition === "retryable" && error.ambiguous &&
      error.retryAfterMilliseconds === 2_000,
  );
});

test("network, timeout, 408, 429, 5xx, and auth-stale failures are bounded retries", async () => {
  const operation = refreshOperation();
  const responses: Array<readonly [number, unknown]> = [
    [408, {}],
    [429, {}],
    [503, {}],
    [401, {
      error: "The request timestamp is outside the accepted window.",
      code: "PUBLICATION_AUTH_STALE",
    }],
  ];
  for (const [status, body] of responses) {
    await assert.rejects(
      client(async () => new Response(JSON.stringify(body), { status }))
        .send(operation),
      (error: unknown) => error instanceof CatalogPublicationClientError &&
        error.disposition === "retryable" && error.ambiguous,
    );
  }
  await assert.rejects(
    client(async () => { throw new Error("socket closed"); }).send(operation),
    (error: unknown) => error instanceof CatalogPublicationClientError &&
      error.code === "PUBLICATION_NETWORK_ERROR" &&
      error.disposition === "retryable" && error.ambiguous,
  );
  const timeoutClient = new SignedConvexCatalogPublicationClient({
    baseUrl: "https://convex.example",
    keyId,
    secret,
    now: () => now,
    nonce: () => "nonce0000000000000001",
    timeoutMilliseconds: 100,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  });
  await assert.rejects(
    timeoutClient.send(operation),
    (error: unknown) => error instanceof CatalogPublicationClientError &&
      error.code === "PUBLICATION_TIMEOUT" &&
      error.disposition === "retryable" && error.ambiguous,
  );
  const responseBodyTimeoutClient = new SignedConvexCatalogPublicationClient({
    baseUrl: "https://convex.example",
    keyId,
    secret,
    now: () => now,
    nonce: () => "nonce0000000000000001",
    timeoutMilliseconds: 100,
    fetch: async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => {
          controller.error(new Error("aborted"));
        });
      },
    })),
  });
  await assert.rejects(
    responseBodyTimeoutClient.send(operation),
    (error: unknown) => error instanceof CatalogPublicationClientError &&
      error.code === "PUBLICATION_TIMEOUT" &&
      error.disposition === "retryable" && error.ambiguous,
  );
});

test("deterministic authentication refusals are terminal", async () => {
  const transport = client(async () => new Response(JSON.stringify({
    error: "Publication authentication failed.",
    code: "PUBLICATION_AUTH_INVALID",
  }), { status: 401 }));
  await assert.rejects(
    transport.send(refreshOperation()),
    (error: unknown) => error instanceof CatalogPublicationClientError &&
      error.code === "PUBLICATION_AUTH_INVALID" &&
      error.disposition === "terminal" && !error.ambiguous,
  );
});

test("signed Convex client refuses changed persisted bytes before transport", async () => {
  let calls = 0;
  const transport = client(async () => {
    calls += 1;
    return new Response();
  });
  const operation = { ...refreshOperation(), bodyJson: "{}" };
  await assert.rejects(
    transport.send(operation),
    (error: unknown) => error instanceof CatalogPublicationClientError &&
      error.code === "PUBLICATION_REQUEST_INVALID" &&
      error.disposition === "terminal",
  );
  const protectedBodyJson = canonicalJson({
    ...(JSON.parse(refreshOperation().bodyJson) as object),
    organizationId: "10000000-0000-4000-8000-000000000001",
  });
  await assert.rejects(
    transport.send({
      ...refreshOperation(),
      bodyJson: protectedBodyJson,
      bodyDigest: sha256(protectedBodyJson),
    }),
    (error: unknown) => error instanceof CatalogPublicationClientError &&
      error.code === "PUBLICATION_REQUEST_INVALID" &&
      error.disposition === "terminal",
  );
  assert.equal(calls, 0);
});

test("authenticated status returns not found only for the exact operation identity", async () => {
  const operation = refreshOperation();
  const transport = client(async (_input, init) => {
    const bodyJson = String(init?.body);
    const receipt = {
      schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
      operationId: operation.operationId,
      publicationId,
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
    }), { status: 200 });
  });
  assert.equal(await transport.status({
    operationId: operation.operationId,
    publicationId,
    expectedRequestDigest: operation.bodyDigest,
    expectedKind: operation.kind,
  }), null);
});

test("exact request replay keeps persisted bytes and rotates the authentication nonce", async () => {
  const operation = refreshOperation();
  const bodies: string[] = [];
  const nonces: string[] = [];
  let nonceSequence = 0;
  const transport = new SignedConvexCatalogPublicationClient({
    baseUrl: "https://convex.example",
    keyId,
    secret,
    now: () => now,
    nonce: () => `nonce000000000000000${++nonceSequence}`,
    fetch: async (_input, init) => {
      bodies.push(String(init?.body));
      nonces.push(new Headers(init?.headers).get(
        PRODUCTION_AUTH_HEADER_NAMES.nonce,
      )!);
      return new Response(JSON.stringify(
        await signedEnvelope(refreshReceipt(operation)),
      ), { status: 200 });
    },
  });
  await transport.send(operation);
  await transport.send(operation);
  assert.deepEqual(bodies, [operation.bodyJson, operation.bodyJson]);
  assert.deepEqual(nonces, [
    "nonce0000000000000001",
    "nonce0000000000000002",
  ]);
});
