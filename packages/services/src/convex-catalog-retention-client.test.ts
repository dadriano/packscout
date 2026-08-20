import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  CATALOG_RETENTION_SCHEMA_VERSION,
  PRODUCTION_CATALOG_RETENTION_PATHS,
  canonicalJson,
  catalogRetentionManifestReceiptSchema,
  catalogRetentionManifestRequestSchema,
  catalogRetentionPostgresProofSnapshotDigest,
  catalogRetentionProviderReceiptSchema,
  catalogRetentionProviderRequestSchema,
  catalogRetentionPublicationRequestDigest,
  catalogRetentionReceiptDigest,
  catalogRetentionTerminalReceiptSha256,
  productionPublicationReceiptSigningValue,
  type CatalogRetentionManifestRequest,
  type CatalogRetentionPostgresProofSnapshot,
  type CatalogRetentionProviderRequest,
  type CatalogRetentionStatusRequest,
} from "@packscout/contracts";
import {
  CatalogRetentionPublicationClientError,
  SignedConvexCatalogRetentionClient,
} from "./convex-catalog-retention-client.ts";

const keyId = "retention-publisher.v1";
const secret = Buffer.from(
  "retention-publisher-test-secret-000000000000000000",
);
const now = new Date("2026-08-16T12:05:00.000Z");

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function postgresProof(): Promise<CatalogRetentionPostgresProofSnapshot> {
  const withoutDigest: Omit<
    CatalogRetentionPostgresProofSnapshot,
    "snapshotDigest"
  > = {
    snapshotId: "retention:snapshot:transport:1",
    snapshotSequence: "1",
    evaluatedAt: "2026-08-16T12:00:00.000Z",
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
      completedHead: {
        platformKey: "alpha",
        publicProviderReleaseId: null,
        sharedConfigurationEpoch: null,
        providerCheckpoint: { settledSequence: "0", settledAt: null },
        observation: null,
        terminalReceiptSha256: null,
      },
      terminalOperationId: null,
    }],
    manifestProtections: [],
    providerProtectionsByPlatform: [],
  };
  return {
    ...withoutDigest,
    snapshotDigest:
      await catalogRetentionPostgresProofSnapshotDigest(withoutDigest),
  };
}

async function requests(): Promise<Readonly<{
  manifest: CatalogRetentionManifestRequest;
  provider: CatalogRetentionProviderRequest;
}>> {
  const proof = await postgresProof();
  return {
    manifest: catalogRetentionManifestRequestSchema.parse({
      schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
      operationId: "retention:transport:manifest:1",
      idempotencyKey: "retention:transport:manifest:1",
      expectedRetentionGeneration: 0,
      maximumDocuments: 90,
      phase: "manifests",
      postgresProof: proof,
    }),
    provider: catalogRetentionProviderRequestSchema.parse({
      schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
      operationId: "retention:transport:provider:1",
      idempotencyKey: "retention:transport:provider:1",
      expectedRetentionGeneration: 1,
      maximumDocuments: 90,
      phase: "provider_releases",
      platformKey: "alpha",
      postgresProof: proof,
    }),
  };
}

function protectionSet(
  request: CatalogRetentionManifestRequest | CatalogRetentionProviderRequest,
) {
  return {
    authoritativeEvaluationTime: now.toISOString(),
    postgresProofSnapshotId: request.postgresProof.snapshotId,
    postgresProofSnapshotSequence: request.postgresProof.snapshotSequence,
    postgresProofSnapshotDigest: request.postgresProof.snapshotDigest,
    manifests: [],
    providerReleasesByPlatform: [{ platformKey: "alpha", releases: [] }],
  };
}

async function manifestReceipt(request: CatalogRetentionManifestRequest) {
  const withoutDigest = {
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationKind: "retainManifests" as const,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    terminalState: "complete" as const,
    result: "retained" as const,
    serverTime: now.toISOString(),
    requestDigest: await catalogRetentionPublicationRequestDigest(request),
    expectedRetentionGeneration: request.expectedRetentionGeneration,
    retentionGeneration: request.expectedRetentionGeneration + 1,
    phase: "manifests" as const,
    platformKey: null,
    details: {
      maximumDocuments: request.maximumDocuments,
      deletedDocumentCount: 0,
      deletedRetentionOperationCount: 0,
      hasMore: false,
      protectionSet: protectionSet(request),
      selectedManifest: null,
      deletedManifestCount: 0,
      deletedManifestReferenceCount: 0,
    },
  };
  return catalogRetentionManifestReceiptSchema.parse({
    ...withoutDigest,
    receiptDigest: await catalogRetentionReceiptDigest(withoutDigest),
  });
}

async function providerReceipt(request: CatalogRetentionProviderRequest) {
  const withoutDigest = {
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationKind: "retainProviderReleases" as const,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    terminalState: "complete" as const,
    result: "retained" as const,
    serverTime: now.toISOString(),
    requestDigest: await catalogRetentionPublicationRequestDigest(request),
    expectedRetentionGeneration: request.expectedRetentionGeneration,
    retentionGeneration: request.expectedRetentionGeneration + 1,
    phase: "provider_releases" as const,
    platformKey: request.platformKey,
    details: {
      maximumDocuments: request.maximumDocuments,
      deletedDocumentCount: 0,
      deletedRetentionOperationCount: 0,
      hasMore: false,
      protectionSet: protectionSet(request),
      manifestPhaseComplete: true,
      selectedProviderRelease: null,
      deletedProviderReleaseCount: 0,
      deletedProviderOwnedDocumentCount: 0,
    },
  };
  return catalogRetentionProviderReceiptSchema.parse({
    ...withoutDigest,
    receiptDigest: await catalogRetentionReceiptDigest(withoutDigest),
  });
}

async function exactSignedEnvelope(receipt: unknown): Promise<string> {
  const receiptDigest = await catalogRetentionReceiptDigest(receipt);
  const responseAuth = {
    signatureVersion: "v1",
    keyId,
    receiptDigest,
    signature: createHmac("sha256", secret)
      .update(productionPublicationReceiptSigningValue(receiptDigest))
      .digest("hex"),
  };
  return [
    "{",
    `  "responseAuth": ${JSON.stringify(responseAuth)},`,
    `  "receipt": ${JSON.stringify(receipt)},`,
    "  \"ok\": true",
    "}",
  ].join("\n");
}

function client(fetchImplementation: typeof fetch) {
  return new SignedConvexCatalogRetentionClient({
    baseUrl: "https://convex.example",
    keyId,
    secret,
    fetch: fetchImplementation,
    now: () => now,
    nonce: () => "nonce0000000000000001",
  });
}

test("retention phases preserve exact response bytes and canonical receipt proof", async () => {
  const fixture = await requests();
  const manifest = await manifestReceipt(fixture.manifest);
  const provider = await providerReceipt(fixture.provider);
  const responseBodies = new Map<string, string>();
  const transport = client(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const bodyJson = String(init?.body);
    if (path === PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests) {
      assert.equal(bodyJson, canonicalJson(fixture.manifest));
      const exact = await exactSignedEnvelope(manifest);
      responseBodies.set(path, exact);
      return new Response(exact);
    }
    assert.equal(
      path,
      PRODUCTION_CATALOG_RETENTION_PATHS.retainProviderReleases,
    );
    assert.equal(bodyJson, canonicalJson(fixture.provider));
    const exact = await exactSignedEnvelope(provider);
    responseBodies.set(path, exact);
    return new Response(exact);
  });

  const retainedManifests = await transport.retainManifests(fixture.manifest);
  const retainedProviders = await transport.retainProviderReleases(
    fixture.provider,
  );
  for (const [result, path] of [
    [retainedManifests, PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests],
    [retainedProviders, PRODUCTION_CATALOG_RETENTION_PATHS.retainProviderReleases],
  ] as const) {
    const exact = responseBodies.get(path)!;
    assert.equal(result.exactResponseBody, exact);
    assert.equal(result.exactResponseSha256, sha256(exact));
    assert.equal(result.canonicalReceiptBody, canonicalJson(result.receipt));
    assert.equal(
      result.receiptSha256,
      await catalogRetentionTerminalReceiptSha256(result.receipt),
    );
    assert.notEqual(result.exactResponseSha256, result.receiptSha256);
  }
});

test("retention status binds the complete target identity", async () => {
  const fixture = await requests();
  const target = {
    operationKind: "retainProviderReleases" as const,
    operationId: fixture.provider.operationId,
    idempotencyKey: fixture.provider.idempotencyKey,
    phase: "provider_releases" as const,
    platformKey: fixture.provider.platformKey,
    requestDigest: await catalogRetentionPublicationRequestDigest(
      fixture.provider,
    ),
  };
  const request: CatalogRetentionStatusRequest = {
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    target,
  };
  const transport = client(async (input, init) => {
    assert.equal(
      new URL(String(input)).pathname,
      PRODUCTION_CATALOG_RETENTION_PATHS.status,
    );
    assert.equal(String(init?.body), canonicalJson(request));
    const receipt = {
      schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
      target,
      terminalState: "not_found",
      result: "not_found",
      serverTime: now.toISOString(),
      requestDigest: target.requestDigest,
      details: {},
      receiptDigest: null,
    } as const;
    return new Response(await exactSignedEnvelope(receipt));
  });
  const result = await transport.status(request);
  assert.equal(result.receipt.result, "not_found");
  assert.deepEqual(result.receipt.target, target);
});

test("retention errors are lane-specific and preflight cancellation is stable", async () => {
  const fixture = await requests();
  const errorEnvelope = {
    error: "The retention predecessor no longer matches.",
    code: "CATALOG_RETENTION_PREDECESSOR_CONFLICT",
  } as const;
  const rejected = client(async () =>
    new Response(JSON.stringify(errorEnvelope), { status: 409 })
  );
  await assert.rejects(
    rejected.retainManifests(fixture.manifest),
    (error: unknown) =>
      error instanceof CatalogRetentionPublicationClientError &&
      error.code === "CATALOG_RETENTION_PREDECESSOR_CONFLICT" &&
      error.disposition === "terminal" &&
      !error.ambiguous &&
      error.canonicalErrorResponseBody === canonicalJson(errorEnvelope) &&
      error.errorResponseSha256 === sha256(canonicalJson(errorEnvelope)),
  );

  let calls = 0;
  const cancelled = client(async () => {
    calls += 1;
    return new Response();
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    cancelled.retainProviderReleases(fixture.provider, controller.signal),
    (error: unknown) =>
      error instanceof CatalogRetentionPublicationClientError &&
      error.code === "PUBLICATION_CANCELLED" && error.ambiguous,
  );
  assert.equal(calls, 0);
});
