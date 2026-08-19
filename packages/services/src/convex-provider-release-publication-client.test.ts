import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  PRODUCTION_AUTH_HEADER_NAMES,
  PRODUCTION_PROVIDER_RELEASE_PATHS,
  canonicalJson,
  productionPublicationReceiptSigningValue,
  providerReleaseCompletedHeadReceiptSchema,
  providerReleaseCompletionReceiptSchema,
  providerReleaseReceiptDigest,
  providerReleaseReuseReceiptSchema,
  providerReleaseTerminalReceiptSha256,
  type ProviderReleaseConfirmReuseRequest,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseFinalizeRequest,
  type ProviderReleaseImmutableProofV1,
  type ProviderReleaseReceipt,
  type ProviderReleaseStatusRequest,
} from "@packscout/contracts";
import {
  ProviderReleasePublicationClientError,
  SignedConvexProviderReleasePublicationClient,
} from "./convex-provider-release-publication-client.ts";

const keyId = "provider-publisher.v1";
const secret = Buffer.from("provider-publisher-test-secret-000000000000000000");
const now = new Date("2026-08-15T12:00:00.000Z");
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const releaseId = "10000000-0000-5000-8000-000000000001";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function epoch() {
  return {
    configurationKey: "catalog.v1",
    revision: 1,
    publicChangeSequence: "10",
    configurationHash: hashA,
  } as const;
}

function proof(): ProviderReleaseImmutableProofV1 {
  return {
    platformKey: "alpha",
    sharedConfigurationEpoch: epoch(),
    dataAsOf: "2026-08-15T11:58:00.000Z",
    publicProviderReleaseId: releaseId,
    providerReleaseFingerprint: hashA,
    contentHash: hashB,
    publicAssetOrigins: [],
    governingHashes: {
      providerConfigurationHash: hashA,
      sharedCategoriesHash: hashA,
      identityMappingsHash: hashA,
      originSetHash: hashA,
      confidencePolicyHash: hashA,
    },
    entityHashes: {
      vendors: hashB,
      categories: hashB,
      collectibles: hashB,
      repacks: hashB,
      repack_chases: hashB,
      search_shards: hashB,
    },
    counts: {
      vendors: 1,
      categories: 0,
      collectibles: 0,
      repacks: 0,
      repackChases: 0,
      searchShards: 0,
    },
    searchAlgorithmVersion: "repack_search_v2",
    providerSearchIndexHash: hashA,
    batchCount: 1,
    batchChainHash: hashB,
  };
}

function checkpoint(settledSequence: string) {
  return { settledSequence, settledAt: now.toISOString() };
}

function observation(sourceHeadSequence: string) {
  return {
    sourceHeadSequence,
    lastSuccessfulObservationAt: "2026-08-15T11:59:00.000Z",
    staleAt: "2026-08-15T12:14:00.000Z",
    freshness: "fresh" as const,
  };
}

function emptyHead(): ProviderReleaseExpectedCompletedHeadV1 {
  return {
    platformKey: "alpha",
    publicProviderReleaseId: null,
    sharedConfigurationEpoch: null,
    providerCheckpoint: { settledSequence: "0", settledAt: null },
    observation: null,
    terminalReceiptSha256: null,
  };
}

function predecessor(): ProviderReleaseExpectedCompletedHeadV1 {
  return {
    platformKey: "alpha",
    publicProviderReleaseId: releaseId,
    sharedConfigurationEpoch: epoch(),
    providerCheckpoint: checkpoint("20"),
    observation: observation("20"),
    terminalReceiptSha256: hashA,
  };
}

function finalizeRequest(): ProviderReleaseFinalizeRequest {
  return {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId: "provider:finalize:alpha:20",
    idempotencyKey: "provider:finalize:alpha:20",
    release: proof(),
    providerCheckpoint: checkpoint("20"),
    sourceWatermark: "provider-catalog:alpha:20",
    observation: observation("20"),
    expectedCompletedHead: emptyHead(),
  };
}

function reuseRequest(): ProviderReleaseConfirmReuseRequest {
  return {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId: "provider:reuse:alpha:21",
    idempotencyKey: "provider:reuse:alpha:21",
    release: proof(),
    providerCheckpoint: checkpoint("21"),
    sourceWatermark: "provider-catalog:alpha:21",
    observation: observation("21"),
    expectedCompletedHead: predecessor(),
  };
}

async function terminalReceipt(
  request: ProviderReleaseFinalizeRequest | ProviderReleaseConfirmReuseRequest,
): Promise<ProviderReleaseReceipt> {
  const operationKind = request.operationId.includes(":reuse:")
    ? "confirmReuse" as const
    : "finalize" as const;
  const withoutDigest = {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    platformKey: request.release.platformKey,
    publicProviderReleaseId: request.release.publicProviderReleaseId,
    sharedConfigurationEpoch: request.release.sharedConfigurationEpoch,
    providerCheckpoint: request.providerCheckpoint,
    operationKind,
    terminalState: "complete" as const,
    result: operationKind === "finalize" ? "completed" as const : "reused" as const,
    serverTime: now.toISOString(),
    requestDigest: sha256(canonicalJson(request)),
    details: {
      release: request.release,
      providerCheckpoint: request.providerCheckpoint,
      sourceWatermark: request.sourceWatermark,
      observation: request.observation,
      expectedCompletedHead: request.expectedCompletedHead,
      completedHead: {
        platformKey: request.release.platformKey,
        release: request.release,
        providerCheckpoint: request.providerCheckpoint,
        observation: request.observation,
      },
    },
  };
  const candidate = {
    ...withoutDigest,
    receiptDigest: await providerReleaseReceiptDigest(withoutDigest),
  };
  return operationKind === "finalize"
    ? providerReleaseCompletionReceiptSchema.parse(candidate)
    : providerReleaseReuseReceiptSchema.parse(candidate);
}

async function signedEnvelope(receipt: unknown) {
  const receiptDigest = await providerReleaseReceiptDigest(receipt);
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

function client(fetchImplementation: typeof fetch) {
  return new SignedConvexProviderReleasePublicationClient({
    baseUrl: "https://convex.example",
    keyId,
    secret,
    fetch: fetchImplementation,
    now: () => now,
    nonce: () => "nonce0000000000000001",
  });
}

test("provider finalize and reuse preserve exact bytes and terminal receipt proofs", async () => {
  const requests = [finalizeRequest(), reuseRequest()] as const;
  let requestIndex = 0;
  const transport = client(async (input, init) => {
    const request = requests[requestIndex++]!;
    const expectedPath = request.operationId.includes(":reuse:")
      ? PRODUCTION_PROVIDER_RELEASE_PATHS.confirmReuse
      : PRODUCTION_PROVIDER_RELEASE_PATHS.finalize;
    assert.equal(String(input), `https://convex.example${expectedPath}`);
    assert.equal(init?.body, canonicalJson(request));
    assert.equal(
      new Headers(init?.headers).get(PRODUCTION_AUTH_HEADER_NAMES.contentSha256),
      sha256(canonicalJson(request)),
    );
    return new Response(JSON.stringify(
      await signedEnvelope(await terminalReceipt(request)),
    ));
  });

  const finalized = await transport.finalize(requests[0]);
  const reused = await transport.confirmReuse(requests[1]);

  assert.equal(finalized.receipt.result, "completed");
  assert.equal(reused.receipt.result, "reused");
  assert.equal(
    finalized.receiptSha256,
    await providerReleaseTerminalReceiptSha256(finalized.receipt),
  );
  assert.equal(finalized.canonicalReceiptBody, canonicalJson(finalized.receipt));
  assert.notEqual(finalized.exactResponseSha256, finalized.receiptSha256);
});

test("provider retains exact signed response whitespace separately from receipt proof", async () => {
  const request = finalizeRequest();
  const envelope = await signedEnvelope(await terminalReceipt(request));
  const exactResponseBody = `\n{\n  "responseAuth": ${JSON.stringify(envelope.responseAuth)},\n  "receipt": ${JSON.stringify(envelope.receipt)},\n  "ok": true\n}\n`;
  const transport = client(async () => new Response(exactResponseBody));

  const result = await transport.finalize(request);

  assert.equal(result.exactResponseBody, exactResponseBody);
  assert.equal(result.exactResponseSha256, sha256(exactResponseBody));
  assert.equal(result.canonicalReceiptBody, canonicalJson(result.receipt));
  assert.equal(
    result.receiptSha256,
    await providerReleaseTerminalReceiptSha256(result.receipt),
  );
});

test("provider completed-head and not-found status bind the exact identity", async () => {
  const statusRequest: ProviderReleaseStatusRequest = {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    target: {
      operationKind: "finalize",
      operationId: finalizeRequest().operationId,
      idempotencyKey: finalizeRequest().idempotencyKey,
      platformKey: "alpha",
      publicProviderReleaseId: releaseId,
      requestDigest: sha256(canonicalJson(finalizeRequest())),
    },
  };
  const transport = client(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const bodyJson = String(init?.body);
    if (path === PRODUCTION_PROVIDER_RELEASE_PATHS.completedHead) {
      const withoutDigest = {
        schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
        operationKind: "completedHead" as const,
        operationId: "provider-completed-head-alpha",
        platformKey: "alpha",
        publicProviderReleaseId: null,
        terminalState: "observed" as const,
        result: "completed_head" as const,
        serverTime: now.toISOString(),
        requestDigest: sha256(bodyJson),
        details: {
          head: {
            platformKey: "alpha",
            release: null,
            providerCheckpoint: { settledSequence: "0", settledAt: null },
            observation: null,
            terminalReceiptSha256: null,
          },
        },
      };
      const receipt = providerReleaseCompletedHeadReceiptSchema.parse({
        ...withoutDigest,
        receiptDigest: await providerReleaseReceiptDigest(withoutDigest),
      });
      return new Response(JSON.stringify(await signedEnvelope(receipt)));
    }
    assert.equal(path, PRODUCTION_PROVIDER_RELEASE_PATHS.status);
    const receipt = {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      target: statusRequest.target,
      terminalState: "not_found",
      result: "not_found",
      serverTime: now.toISOString(),
      requestDigest: statusRequest.target.requestDigest,
      details: {},
      receiptDigest: null,
    } as const;
    return new Response(JSON.stringify(await signedEnvelope(receipt)));
  });

  const head = await transport.completedHead({
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId: "provider-completed-head-alpha",
    platformKey: "alpha",
  });
  assert.equal(head.receipt.details.head.release, null);
  assert.equal((await transport.status(statusRequest)).receipt.result, "not_found");
});

test("provider exact replay rejects changed bytes and retains bounded error evidence", async () => {
  let calls = 0;
  const invalid = client(async () => {
    calls += 1;
    return new Response();
  });
  await assert.rejects(
    invalid.sendExact({
      kind: "finalize",
      canonicalRequestBody: JSON.stringify(finalizeRequest(), null, 2),
    }),
    (error: unknown) => error instanceof ProviderReleasePublicationClientError &&
      error.code === "PROVIDER_RELEASE_REQUEST_INVALID" && !error.ambiguous,
  );
  assert.equal(calls, 0);

  const refused = client(async () => new Response(JSON.stringify({
    error: "Provider release predecessor changed.",
    code: "PROVIDER_RELEASE_PREDECESSOR_CONFLICT",
  }), { status: 409 }));
  await assert.rejects(
    refused.finalize(finalizeRequest()),
    (error: unknown) => {
      if (!(error instanceof ProviderReleasePublicationClientError)) return false;
      const expectedBody = canonicalJson({
        error: "Provider release predecessor changed.",
        code: "PROVIDER_RELEASE_PREDECESSOR_CONFLICT",
      });
      return error.code === "PROVIDER_RELEASE_PREDECESSOR_CONFLICT" &&
        error.disposition === "terminal" && !error.ambiguous &&
        error.canonicalErrorResponseBody === expectedBody &&
        error.errorResponseSha256 === sha256(expectedBody);
    },
  );
});

test("provider mutation cancellation aborts the shared signed request", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const transport = client(async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      started();
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
  const request = transport.finalize(finalizeRequest(), controller.signal);
  const rejected = assert.rejects(
    request,
    (error: unknown) => error instanceof ProviderReleasePublicationClientError &&
      error.code === "PUBLICATION_CANCELLED" && error.ambiguous,
  );
  await requestStarted;
  controller.abort();
  await rejected;
});
