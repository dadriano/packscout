import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  catalogManifestActivationReceiptSchema,
  catalogManifestActiveStateReceiptSchema,
  catalogManifestReceiptDigest,
  catalogManifestRefreshReceiptSchema,
  catalogManifestTerminalReceiptSha256,
  productionPublicationReceiptSigningValue,
  type ActiveCatalogManifestStateCoreV1,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestActivateRequest,
  type CatalogManifestRefreshActiveStateRequest,
  type CatalogManifestStatusRequest,
  type GlobalCatalogManifestV1,
  type ProviderCatalogReleasePublishPlanV1,
} from "@packscout/contracts";
import {
  CatalogManifestPublicationClientError,
  SignedConvexCatalogManifestPublicationClient,
} from "./convex-catalog-manifest-publication-client.ts";
import { composeGlobalCatalogManifest } from "./catalog-manifest-composer.ts";
import { buildProviderCatalogReleasePublishPlan } from "./provider-catalog-release-artifacts.ts";
import { projectProviderCatalogRelease } from "./provider-catalog-release-public-projection.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureCheckpoint,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";

const keyId = "manifest-publisher.v1";
const secret = Buffer.from("manifest-publisher-test-secret-000000000000000000");
const now = new Date("2026-08-15T12:05:00.000Z");

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function providerPlan(
  platformKey: "alpha" | "beta",
): Promise<ProviderCatalogReleasePublishPlanV1> {
  const checkpoint = providerFixtureCheckpoint({ platformKey });
  const configuration = providerFixtureApprovedConfiguration({ platformKey });
  const snapshot = providerFixtureSnapshot({ checkpoint, configuration });
  return await buildProviderCatalogReleasePublishPlan({
    checkpoint: snapshot.checkpoint,
    configuration: snapshot.configuration,
    projection: projectProviderCatalogRelease({
      configuration,
      platformKey,
      revisions: snapshot.revisions,
      repackIdentities: snapshot.repackIdentities,
    }),
    lastSuccessfulObservationAt:
      snapshot.observation.lastSuccessfulObservationAt,
  });
}

async function manifestFixture(): Promise<GlobalCatalogManifestV1> {
  const providerPlans = await Promise.all([
    providerPlan("alpha"),
    providerPlan("beta"),
  ]);
  return await composeGlobalCatalogManifest({
    enabledPlatformKeys: ["alpha", "beta"],
    providerPlans,
    approvedConfiguration: {
      sharedConfigurationEpoch: providerPlans[0]!.sharedConfigurationEpoch,
      confidencePolicyVersion: "confidence-v1",
    },
  });
}

function observation(manifest: GlobalCatalogManifestV1, sequence: number) {
  return buildGlobalCatalogAggregateObservationV1({
    observationSequence: sequence,
    publicReleaseId: manifest.publicReleaseId,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    providerSelections: manifest.providerReferences.map((reference, index) => ({
      platformKey: reference.platformKey,
      publicProviderReleaseId: reference.publicProviderReleaseId,
      terminalOperationKind: "finalize" as const,
      terminalOperationId: `provider:finalize:${reference.platformKey}:20`,
      terminalReceiptSha256: `${index + 1}`.repeat(64),
      selectedProviderCheckpoint: {
        settledSequence: "20",
        settledAt: "2026-08-15T12:00:00.000Z",
      },
      selectedDataAsOf: reference.dataAsOf,
      latestAffectedSettledSequence: "20",
      latestAffectedSourceHeadSequence: "20",
      initialBackfillComplete: true,
      affectedDerivationsSettled: true,
      settledSourceFreshness: "fresh" as const,
      lastSuccessfulObservationAt: "2026-08-15T12:00:00.000Z",
      staleAt: "2026-08-15T12:15:00.000Z",
    })),
  });
}

function emptyState(): ActiveCatalogManifestStateV1 {
  return {
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  };
}

function activeCore(
  manifest: GlobalCatalogManifestV1,
  generation: number,
  activeObservation: ReturnType<typeof observation>,
): ActiveCatalogManifestStateCoreV1 {
  return {
    generation,
    activeManifest: {
      publicReleaseId: manifest.publicReleaseId,
      manifestFingerprint: manifest.manifestFingerprint,
      sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: manifest.providerReferenceSetHash,
      createdAt: "2026-08-15T12:04:00.000Z",
      completedAt: now.toISOString(),
    },
    previousManifest: null,
    observation: activeObservation,
  };
}

async function withDigest<T extends Readonly<Record<string, unknown>>>(
  receipt: T,
): Promise<T & { readonly receiptDigest: string }> {
  return {
    ...receipt,
    receiptDigest: await catalogManifestReceiptDigest(receipt),
  };
}

async function signedEnvelope(receipt: unknown) {
  const receiptDigest = await catalogManifestReceiptDigest(receipt);
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
  return new SignedConvexCatalogManifestPublicationClient({
    baseUrl: "https://convex.example",
    keyId,
    secret,
    fetch: fetchImplementation,
    now: () => now,
    nonce: () => "nonce0000000000000001",
  });
}

test("manifest activate, refresh, and active-state return exact pointer proofs", async () => {
  const manifest = await manifestFixture();
  const firstObservation = observation(manifest, 1);
  const activateRequest: CatalogManifestActivateRequest = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "manifest:activate:1",
    idempotencyKey: "manifest:activate:1",
    manifest,
    observation: firstObservation,
    expectedActiveState: emptyState(),
  };
  let expectedRefreshState: ActiveCatalogManifestStateV1 | null = null;
  let refreshedState: ActiveCatalogManifestStateV1 | null = null;
  const transport = client(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const bodyJson = String(init?.body);
    if (path === PRODUCTION_CATALOG_MANIFEST_PATHS.activateManifest) {
      assert.equal(bodyJson, canonicalJson(activateRequest));
      const receipt = catalogManifestActivationReceiptSchema.parse(
        await withDigest({
          schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
          operationKind: "activateManifest" as const,
          operationId: activateRequest.operationId,
          idempotencyKey: activateRequest.idempotencyKey,
          publicReleaseId: manifest.publicReleaseId,
          manifestFingerprint: manifest.manifestFingerprint,
          terminalState: "complete" as const,
          result: "activated" as const,
          serverTime: now.toISOString(),
          requestDigest: sha256(bodyJson),
          details: {
            expectedActiveState: activateRequest.expectedActiveState,
            activeState: activeCore(manifest, 1, firstObservation),
          },
        }),
      );
      return new Response(JSON.stringify(await signedEnvelope(receipt)));
    }
    if (path === PRODUCTION_CATALOG_MANIFEST_PATHS.refreshActiveState) {
      assert.ok(expectedRefreshState !== null);
      const request = JSON.parse(bodyJson) as CatalogManifestRefreshActiveStateRequest;
      const receipt = catalogManifestRefreshReceiptSchema.parse(
        await withDigest({
          schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
          operationKind: "refreshActiveState" as const,
          operationId: request.operationId,
          idempotencyKey: request.idempotencyKey,
          publicReleaseId: manifest.publicReleaseId,
          manifestFingerprint: manifest.manifestFingerprint,
          terminalState: "complete" as const,
          result: "refreshed" as const,
          serverTime: now.toISOString(),
          requestDigest: sha256(bodyJson),
          details: {
            expectedActiveState: expectedRefreshState,
            activeState: activeCore(manifest, 2, request.observation),
          },
        }),
      );
      return new Response(JSON.stringify(await signedEnvelope(receipt)));
    }
    assert.equal(path, PRODUCTION_CATALOG_MANIFEST_PATHS.activeState);
    assert.ok(refreshedState !== null);
    const request = JSON.parse(bodyJson) as { operationId: string };
    const receipt = catalogManifestActiveStateReceiptSchema.parse(
      await withDigest({
        schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
        operationKind: "activeState" as const,
        operationId: request.operationId,
        terminalState: "observed" as const,
        result: "active_state" as const,
        serverTime: now.toISOString(),
        requestDigest: sha256(bodyJson),
        details: { activeState: refreshedState },
      }),
    );
    return new Response(JSON.stringify(await signedEnvelope(receipt)));
  });

  const activated = await transport.activateManifest(activateRequest);
  expectedRefreshState = {
    ...activated.receipt.details.activeState,
    terminalReceiptSha256: activated.receiptSha256,
  };
  assert.equal(
    activated.receiptSha256,
    await catalogManifestTerminalReceiptSha256(activated.receipt),
  );

  const secondObservation = observation(manifest, 2);
  const refreshed = await transport.refreshActiveState({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "manifest:refresh:2",
    idempotencyKey: "manifest:refresh:2",
    manifest: {
      publicReleaseId: manifest.publicReleaseId,
      manifestFingerprint: manifest.manifestFingerprint,
      sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: manifest.providerReferenceSetHash,
    },
    observation: secondObservation,
    expectedActiveState: expectedRefreshState,
  });
  refreshedState = {
    ...refreshed.receipt.details.activeState,
    terminalReceiptSha256: refreshed.receiptSha256,
  };
  const observed = await transport.activeState();

  assert.equal(refreshed.receipt.result, "refreshed");
  assert.deepEqual(observed.receipt.details.activeState, refreshedState);
  assert.equal(observed.canonicalReceiptBody, canonicalJson(observed.receipt));
});

test("manifest exact replay rejects noncanonical bytes before transport", async () => {
  const manifest = await manifestFixture();
  const request: CatalogManifestActivateRequest = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "manifest:activate:invalid",
    idempotencyKey: "manifest:activate:invalid",
    manifest,
    observation: observation(manifest, 1),
    expectedActiveState: emptyState(),
  };
  let calls = 0;
  const transport = client(async () => {
    calls += 1;
    return new Response();
  });
  await assert.rejects(
    transport.sendExact({
      kind: "activateManifest",
      canonicalRequestBody: JSON.stringify(request, null, 2),
    }),
    (error: unknown) => error instanceof CatalogManifestPublicationClientError &&
      error.code === "CATALOG_MANIFEST_REQUEST_INVALID" && !error.ambiguous,
  );
  assert.equal(calls, 0);
});

test("manifest status binds not-found to the full compare-and-swap identity", async () => {
  const request: CatalogManifestStatusRequest = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    target: {
      operationKind: "activateManifest",
      operationId: "manifest:activate:status",
      idempotencyKey: "manifest:activate:status",
      publicReleaseId: "10000000-0000-5000-8000-000000000001",
      manifestFingerprint: "a".repeat(64),
      requestDigest: "b".repeat(64),
    },
  };
  const transport = client(async (input) => {
    assert.equal(
      new URL(String(input)).pathname,
      PRODUCTION_CATALOG_MANIFEST_PATHS.status,
    );
    const receipt = {
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      target: request.target,
      terminalState: "not_found",
      result: "not_found",
      serverTime: now.toISOString(),
      requestDigest: request.target.requestDigest,
      details: {},
      receiptDigest: null,
    } as const;
    return new Response(JSON.stringify(await signedEnvelope(receipt)));
  });

  const status = await transport.status(request);
  assert.equal(status.receipt.result, "not_found");
  assert.ok(status.exactResponseBody.includes("not_found"));
});
