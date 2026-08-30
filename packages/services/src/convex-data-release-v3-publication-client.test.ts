import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  PRODUCTION_AUTH_HEADER_NAMES,
  canonicalJson,
  productionPublicationReceiptSigningValue,
  productionPublicationRequestSigningValue,
  productionReceiptHash,
  sha256CanonicalJson,
  DATA_RELEASE_V3_RETAINED_EV_WITNESS_HASH_DOMAIN,
  MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_BYTES,
  type DataReleaseV3RetainedEvWitnessRequest,
  packScoutPublicEvV3Schema,
} from "@packscout/contracts";
import {
  DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
  DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
  DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION,
  DataReleaseV3PublicationPortError,
  EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
  type DataReleaseV3PublicationPort,
  type DataReleaseV3ProviderObservationPort,
  type DataReleaseV3RefreshProviderObservationRequest,
  type DataReleaseV3StartRequest,
} from "./buyback-adjusted-ev-release-types.ts";
import {
  SignedConvexDataReleaseV3PublicationClient,
  dataReleaseV3ReceiptHash,
} from "./convex-data-release-v3-publication-client.ts";

const keyId = "v3-publisher.v1";
const secret = Buffer.from("v3-publisher-test-secret-00000000000000000000000");
const now = new Date("2026-08-19T12:00:00.000Z");
const releaseId = "90000000-0000-4000-8000-000000000001";
const fingerprint = "4".repeat(64);

const counts = {
  categories: 1,
  collectibles: 1,
  repacks: 1,
  chases: 1,
  searchShards: 1,
};

const pointer = Object.freeze({
  publicReleaseId: releaseId,
  releaseFingerprint: fingerprint,
  methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  dataAsOf: "2026-08-19T11:55:00.000Z",
  completedAt: "2026-08-19T11:56:00.000Z",
  counts,
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function startRequest(): DataReleaseV3StartRequest {
  return {
    schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
    operationId: `${releaseId}:start`,
    idempotencyKey: `${releaseId}:start`,
    publicReleaseId: releaseId,
    releaseFingerprint: fingerprint,
    manifest: {
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
      dataAsOf: "2026-08-19T11:55:00.000Z",
      contentHash: "5".repeat(64),
      searchAlgorithmVersion: DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION,
      counts,
      entityChainHashes: {
        categories: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
        collectibles: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
        repacks: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
        chases: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
      },
      topChaseCount: 1,
      batchCount: 4,
      batchChainHash: "6".repeat(64),
    },
  };
}

function providerObservationRequest(): DataReleaseV3RefreshProviderObservationRequest {
  return {
    schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
    operationId: `${releaseId}:provider-observation:clutchpacks:1`,
    idempotencyKey: `${releaseId}:provider-observation:clutchpacks:1`,
    publicReleaseId: releaseId,
    releaseFingerprint: fingerprint,
    publicVendorId: "00000000-0000-5000-8000-000000000001",
    vendorKey: "clutchpacks",
    observationSequence: 1,
    observedAt: now.toISOString(),
    freshThrough: new Date(now.getTime() + 15 * 60_000).toISOString(),
    lastHeadReachedAt: now.toISOString(),
    sourceHeadSequence: "17367",
    settledSequence: "17367",
    sourceLifecycle: "active",
    connectionState: "healthy",
    qualityState: "healthy",
    releaseAlignment: "aligned",
  };
}

async function signedEnvelope(receiptBody: Record<string, unknown>) {
  const receipt = {
    ...receiptBody,
    receiptDigest: await sha256CanonicalJson(
      DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
      receiptBody,
    ),
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

function activeStateReceiptBody(bodyJson: string) {
  return {
    schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
    operationKind: "activeState",
    operationId: "data-release-v3-active-state",
    idempotencyKey: "data-release-v3-active-state",
    publicReleaseId: releaseId,
    result: "active_state",
    serverTime: now.toISOString(),
    requestDigest: sha256(bodyJson),
    details: { generation: 3, activeRelease: pointer, previousRelease: null },
  };
}

function client(
  fetchImplementation: typeof fetch,
  nonce = () => "nonce0000000000000001",
): SignedConvexDataReleaseV3PublicationClient {
  return new SignedConvexDataReleaseV3PublicationClient({
    baseUrl: "https://convex.example",
    keyId,
    secret,
    now: () => now,
    nonce,
    fetch: fetchImplementation,
  });
}

function expectsPortError(
  code: string,
  retryable: boolean,
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof DataReleaseV3PublicationPortError &&
    error.name === "DataReleaseV3PublicationPortError" &&
    error.code === code &&
    error.retryable === retryable;
}

function buildWitnessDetail() {
  return { vendorKey: "clutchpacks", publicVendorId: "00000000-0000-5000-8000-000000000001",
    publicRepackId: "00000000-0000-5000-8000-000000000301", availability: "available",
    evEstimates: { packScout: packScoutPublicEvV3Schema.parse({
      status: "current", methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      calculatedAt: now.toISOString(), dataAsOf: { state: "known", observedAt: now.toISOString() },
      sourceAge: { milliseconds: 0, state: "fresh_within_15_minutes" },
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      confidence: { policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
        scoreBasisPoints: 10_000, band: "high", limitationCodes: [] },
      metrics: { grossEvMoney: { minorUnits: 8_500, currency: "USD" }, grossReturnBasisPoints: 8_500,
        evDollars: { minorUnits: -1_500, currency: "USD" }, evPercentBasisPoints: -1_500 },
    }) } };
}

function witnessRequest(): DataReleaseV3RetainedEvWitnessRequest {
  const detail = buildWitnessDetail();
  return { expectedActivePublicReleaseId: releaseId, expectedActiveReleaseFingerprint: fingerprint,
    expectedGeneration: 3, scopes: [{ vendorKey: detail.vendorKey, publicVendorId: detail.publicVendorId,
      publicRepackId: detail.publicRepackId }] };
}

async function witnessReceiptBody(bodyJson: string, patch: Record<string, unknown> = {}) {
  const request = JSON.parse(bodyJson);
  const detail = buildWitnessDetail();
  const rawWitness = { generation: 3, activePublicReleaseId: releaseId, activeReleaseFingerprint: fingerprint,
    retention: { operationId: "activation-3", direction: "forward", changesSha256: "c".repeat(64) },
    entries: [{ ...witnessRequest().scopes[0], activeFacts: { availability: detail.availability,
      estimate: detail.evEstimates.packScout, calculationPriceUsdMinor: 10_000 }, retained: {
      estimate: detail.evEstimates.packScout, calculationPriceUsdMinor: 10_000,
      sourcePublicReleaseId: releaseId, latestUnavailableAttempt: null } }], ...patch };
  return { schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION, operationKind: "retainedEvWitness",
    operationId: request.operationId, idempotencyKey: request.operationId, publicReleaseId: releaseId,
    result: "retained_ev_witness", serverTime: now.toISOString(), requestDigest: sha256(bodyJson),
    details: { ...rawWitness, witnessSha256: await sha256CanonicalJson(DATA_RELEASE_V3_RETAINED_EV_WITNESS_HASH_DOMAIN, rawWitness) } };
}

test("v3 retained witness signs exact scoped active pins and verifies independently authenticated raw facts", async () => {
  const request = witnessRequest();
  let calls = 0;
  const transport = client(async (input, init) => {
    calls += 1;
    assert.equal(String(input), "https://convex.example/internal/data-release/v3/retained-ev-witness");
    const bodyJson = String(init?.body);
    const body = JSON.parse(bodyJson);
    assert.deepEqual(body, { ...request, schemaVersion: "data_release_v3",
      operationId: `data-release-v3-retained-ev:${releaseId}` });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get(PRODUCTION_AUTH_HEADER_NAMES.signature), createHmac("sha256", secret)
      .update(productionPublicationRequestSigningValue({ method: "POST",
        path: "/internal/data-release/v3/retained-ev-witness", bodyDigest: sha256(bodyJson),
        timestamp: String(now.getTime()), nonce: headers.get(PRODUCTION_AUTH_HEADER_NAMES.nonce)! })).digest("hex"));
    return new Response(JSON.stringify(await signedEnvelope(await witnessReceiptBody(bodyJson))), { status: 200 });
  });
  const witness = await transport.retainedEvWitness(request);
  assert.equal(witness.generation, 3);
  assert.equal(witness.entries[0]?.retained?.sourcePublicReleaseId, releaseId);
  await assert.rejects(transport.retainedEvWitness({ ...request, scopes: [] }), expectsPortError("PUBLICATION_REQUEST_INVALID", false));
  assert.equal(calls, 1);
});

test("v3 retained witness rejects signed wrong snapshots/scopes, hash tampering and unauthenticated response changes", async () => {
  for (const kind of ["generation", "fingerprint", "scope", "witness_hash", "request_digest", "outer_signature", "economics"] as const) {
    const transport = client(async (_input, init) => {
      const bodyJson = String(init?.body);
      const receipt = await witnessReceiptBody(bodyJson, kind === "generation" ? { generation: 4 }
        : kind === "fingerprint" ? { activeReleaseFingerprint: "f".repeat(64) } : {});
      if (kind === "scope") receipt.details.entries[0]!.vendorKey = "other_provider";
      if (kind === "economics") receipt.details.entries[0]!.retained.calculationPriceUsdMinor = 20_000;
      if (kind === "witness_hash") receipt.details.witnessSha256 = "f".repeat(64);
      if (kind === "request_digest") receipt.requestDigest = "f".repeat(64);
      const envelope = await signedEnvelope(receipt);
      if (kind === "outer_signature") envelope.responseAuth.signature = "f".repeat(64);
      return new Response(JSON.stringify(envelope), { status: 200 });
    });
    await assert.rejects(transport.retainedEvWitness(witnessRequest()), (error: unknown) =>
      error instanceof DataReleaseV3PublicationPortError && error.retryable === true, kind);
  }
});

test("v3 witness readiness signs a distinct exact-genesis request and refuses old backend or mismatched proof", async () => {
  const request = { expectedGeneration: 0, expectedActivePublicReleaseId: null, expectedActiveReleaseFingerprint: null };
  const transport = client(async (_input, init) => {
    const bodyJson = String(init?.body);
    const body = JSON.parse(bodyJson);
    assert.deepEqual(body, { ...request, schemaVersion: "data_release_v3", mode: "readiness",
      operationId: "data-release-v3-retained-ev-readiness" });
    return new Response(JSON.stringify(await signedEnvelope({ schemaVersion: "data_release_v3",
      operationKind: "retainedEvWitnessReadiness", operationId: body.operationId, idempotencyKey: body.operationId,
      publicReleaseId: null, result: "retained_ev_witness_ready", serverTime: now.toISOString(), requestDigest: sha256(bodyJson),
      details: { generation: 0, activePublicReleaseId: null, activeReleaseFingerprint: null, retention: null } })), { status: 200 });
  });
  assert.deepEqual(await transport.retainedEvWitnessReadiness(request),
    { generation: 0, activePublicReleaseId: null, activeReleaseFingerprint: null, retention: null });
  for (const oldBackend of [true, false]) {
    const invalid = client(async (_input, init) => oldBackend ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(await signedEnvelope({ ...activeStateReceiptBody(String(init?.body)),
        operationKind: "retainedEvWitnessReadiness", result: "retained_ev_witness_ready" })), { status: 200 }));
    await assert.rejects(invalid.retainedEvWitnessReadiness(request), (error: unknown) =>
      error instanceof DataReleaseV3PublicationPortError);
  }
});

test("v3 witness transport refuses a response beyond the fixed 512 KiB signed-envelope budget", async () => {
  const transport = client(async () => new Response("x".repeat(MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_BYTES + 1), { status: 200 }));
  await assert.rejects(transport.retainedEvWitness(witnessRequest()), (error: unknown) =>
    error instanceof DataReleaseV3PublicationPortError && error.retryable);
});

test("v3 active state rides the shared signed HTTP byte and nonce boundary", async () => {
  const bodies: string[] = [];
  let sequence = 0;
  const transport = client(
    async (input, init) => {
      assert.equal(
        String(input),
        "https://convex.example/internal/data-release/v3/active-state",
      );
      const bodyJson = String(init?.body);
      bodies.push(bodyJson);
      const headers = new Headers(init?.headers);
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
            path: "/internal/data-release/v3/active-state",
            bodyDigest,
            timestamp: String(now.getTime()),
            nonce: headers.get(PRODUCTION_AUTH_HEADER_NAMES.nonce)!,
          }),
        ).digest("hex"),
      );
      return new Response(
        JSON.stringify(await signedEnvelope(activeStateReceiptBody(bodyJson))),
        { status: 200 },
      );
    },
    () => `nonce00000000000000${String(++sequence).padStart(2, "0")}`,
  );
  assert.deepEqual(await transport.activeState(), {
    generation: 3,
    activeRelease: pointer,
    previousRelease: null,
  });
  await transport.activeState();
  const expectedBody = canonicalJson({
    schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
    operationId: "data-release-v3-active-state",
  });
  assert.deepEqual(bodies, [expectedBody, expectedBody]);
});

test("v3 active state accepts only the exact retained pre-policy pointer shape", async () => {
  const {
    publicEvPolicyVersion: _legacyMissingPolicyMarker,
    ...legacyPointer
  } = pointer;
  void _legacyMissingPolicyMarker;
  const transport = client(async (_input, init) => {
    const bodyJson = String(init?.body);
    return new Response(JSON.stringify(await signedEnvelope({
      ...activeStateReceiptBody(bodyJson),
      details: {
        generation: 3,
        activeRelease: legacyPointer,
        previousRelease: null,
      },
    })));
  });

  assert.deepEqual(await transport.activeState(), {
    generation: 3,
    activeRelease: legacyPointer,
    previousRelease: null,
  });
});

test("v3 active state rejects non-current markers and other pointer drift", async () => {
  for (const activeRelease of [
    { ...pointer, publicEvPolicyVersion: "some-other-public-policy" },
    { ...pointer, unexpectedLegacyField: true },
    (({ methodVersion: _missingRequiredField, ...rest }) => {
      void _missingRequiredField;
      return rest;
    })(pointer),
  ]) {
    const transport = client(async (_input, init) => {
      const bodyJson = String(init?.body);
      return new Response(JSON.stringify(await signedEnvelope({
        ...activeStateReceiptBody(bodyJson),
        details: { generation: 3, activeRelease, previousRelease: null },
      })));
    });
    await assert.rejects(
      transport.activeState(),
      expectsPortError("PUBLICATION_RESPONSE_INVALID", true),
    );
  }
});

test("v3 start sends canonical bytes and returns the bound verified receipt", async () => {
  const request = startRequest();
  const transport = client(async (input, init) => {
    assert.equal(
      String(input),
      "https://convex.example/internal/data-release/v3/start",
    );
    const bodyJson = String(init?.body);
    assert.equal(bodyJson, canonicalJson(request));
    return new Response(JSON.stringify(await signedEnvelope({
      schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
      operationKind: "start",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: releaseId,
      result: "started",
      serverTime: now.toISOString(),
      requestDigest: sha256(bodyJson),
      details: { lifecycle: "staging" },
    })));
  });
  const receipt = await transport.start(request);
  assert.equal(receipt.result, "started");
  assert.equal(receipt.operationId, `${releaseId}:start`);
  assert.equal(
    receipt.receiptDigest,
    await dataReleaseV3ReceiptHash(receipt),
  );
  const port: DataReleaseV3PublicationPort = transport;
  assert.equal(typeof port.rollback, "function");
});

test("v3 provider health refresh uses the signed release boundary", async () => {
  const request = providerObservationRequest();
  const transport = client(async (input, init) => {
    assert.equal(
      String(input),
      "https://convex.example/internal/data-release/v3/refresh-provider-observation",
    );
    const bodyJson = String(init?.body);
    assert.equal(bodyJson, canonicalJson(request));
    return new Response(JSON.stringify(await signedEnvelope({
      schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
      operationKind: "refreshProviderObservation",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: releaseId,
      result: "provider_observation_created",
      serverTime: now.toISOString(),
      requestDigest: sha256(bodyJson),
      details: {
        publicVendorId: request.publicVendorId,
        observationSequence: request.observationSequence,
      },
    })));
  });

  const receipt = await transport.refreshProviderObservation(request);
  assert.equal(receipt.operationKind, "refreshProviderObservation");
  assert.equal(receipt.result, "provider_observation_created");
  const port: DataReleaseV3ProviderObservationPort = transport;
  assert.equal(typeof port.refreshProviderObservation, "function");
});

test("v3 auth rejection and conflict envelopes pass through as terminal port errors", async () => {
  const rejected = client(async () =>
    new Response(
      JSON.stringify({
        error: "The publication signing key is not accepted.",
        code: "PUBLICATION_AUTH_KEY_UNKNOWN",
      }),
      { status: 401 },
    ),
  );
  await assert.rejects(
    rejected.activeState(),
    expectsPortError("PUBLICATION_AUTH_KEY_UNKNOWN", false),
  );

  const conflicted = client(async () =>
    new Response(
      JSON.stringify({
        error: "The publication operation identity conflicts with stored state.",
        code: "PUBLICATION_OPERATION_CONFLICT",
      }),
      { status: 409 },
    ),
  );
  await assert.rejects(
    conflicted.finalize({
      schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
      operationId: `${releaseId}:finalize`,
      idempotencyKey: `${releaseId}:finalize`,
      publicReleaseId: releaseId,
      releaseFingerprint: fingerprint,
      expectedCounts: counts,
      expectedEntityChainHashes: {
        categories: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
        collectibles: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
        repacks: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
        chases: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
      },
      expectedTopChaseCount: 1,
      expectedBatchCount: 4,
      expectedBatchChainHash: "6".repeat(64),
    }),
    expectsPortError("PUBLICATION_OPERATION_CONFLICT", false),
  );
});

test("v3 receipt digest tampering stays ambiguous and retryable", async () => {
  const transport = client(async (_input, init) => {
    const bodyJson = String(init?.body);
    const receiptBody = activeStateReceiptBody(bodyJson);
    const receipt = { ...receiptBody, receiptDigest: "c".repeat(64) };
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
  });
  await assert.rejects(
    transport.activeState(),
    expectsPortError("PUBLICATION_RESPONSE_AUTH_INVALID", true),
  );
});

test("v3 status binds not-found and found receipts to the exact release identity", async () => {
  const notFound = client(async (input, init) => {
    assert.equal(
      String(input),
      "https://convex.example/internal/data-release/v3/status",
    );
    const bodyJson = String(init?.body);
    assert.deepEqual(JSON.parse(bodyJson), {
      schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
      operationId: `data-release-v3-status:${releaseId}`,
      publicReleaseId: releaseId,
    });
    return new Response(JSON.stringify(await signedEnvelope({
      schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
      operationKind: "status",
      operationId: `data-release-v3-status:${releaseId}`,
      idempotencyKey: `data-release-v3-status:${releaseId}`,
      publicReleaseId: releaseId,
      result: "not_found",
      serverTime: now.toISOString(),
      requestDigest: sha256(bodyJson),
      details: {},
    })));
  });
  assert.equal(await notFound.status(releaseId), null);

  const foreignRelease = "90000000-0000-4000-8000-0000000000ff";
  const misbound = client(async (_input, init) => {
    const bodyJson = String(init?.body);
    return new Response(JSON.stringify(await signedEnvelope({
      schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
      operationKind: "status",
      operationId: `data-release-v3-status:${releaseId}`,
      idempotencyKey: `data-release-v3-status:${releaseId}`,
      publicReleaseId: releaseId,
      result: "status",
      serverTime: now.toISOString(),
      requestDigest: sha256(bodyJson),
      details: {
        status: {
          publicReleaseId: foreignRelease,
          releaseFingerprint: fingerprint,
          lifecycle: "complete",
          acceptedCounts: counts,
          acceptedBatchCount: 4,
          acceptedBatchChainHash: "6".repeat(64),
          acceptedEntityChainHashes: {
            categories: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
            collectibles: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
            repacks: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
            chases: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
          },
          acceptedSearchRowCount: 1,
          acceptedSearchRowSetHash: "7".repeat(64),
          acceptedTopChaseCount: 1,
          completedAt: now.toISOString(),
        },
      },
    })));
  });
  await assert.rejects(
    misbound.status(releaseId),
    expectsPortError("PUBLICATION_RESPONSE_INVALID", true),
  );
});

test("v3 client refuses malformed local requests before any bytes are sent", async () => {
  const transport = client(async () => {
    throw new Error("must not reach the network");
  });
  await assert.rejects(
    transport.status("not-a-uuid"),
    expectsPortError("PUBLICATION_REQUEST_INVALID", false),
  );
  await assert.rejects(
    transport.start({
      ...startRequest(),
      operationId: "***invalid***",
    }),
    expectsPortError("PUBLICATION_REQUEST_INVALID", false),
  );
});
