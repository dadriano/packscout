import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "./data-release-v2-canonical.ts";
import {
  CATALOG_RETENTION_SCHEMA_VERSION,
  MAX_CATALOG_RETENTION_ARTIFACT_DOCUMENTS,
  catalogRetentionManifestReceiptSchema,
  catalogRetentionManifestRequestSchema,
  catalogRetentionPostgresProofSnapshotDigest,
  catalogRetentionProviderRequestSchema,
  catalogRetentionReceiptDigest,
  catalogRetentionStatusTargetSchema,
  catalogRetentionTerminalReceiptSha256,
  containsProtectedCatalogRetentionField,
  parseCatalogRetentionPublicationJson,
  type CatalogRetentionPostgresProofSnapshot,
} from "./catalog-retention-v1.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

async function postgresProof(
  overrides: Partial<CatalogRetentionPostgresProofSnapshot> = {},
): Promise<CatalogRetentionPostgresProofSnapshot> {
  const withoutDigest = {
    snapshotId: "retention:snapshot:1",
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
    ...overrides,
  };
  return {
    ...withoutDigest,
    snapshotDigest: await catalogRetentionPostgresProofSnapshotDigest(
      withoutDigest as Omit<CatalogRetentionPostgresProofSnapshot, "snapshotDigest">,
    ),
  } as CatalogRetentionPostgresProofSnapshot;
}

test("retention requests accept only canonical proof snapshots and no candidate allow-list", async () => {
  const request = {
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationId: "retention:manifest:1",
    idempotencyKey: "retention:manifest:1",
    expectedRetentionGeneration: 0,
    maximumDocuments: MAX_CATALOG_RETENTION_ARTIFACT_DOCUMENTS,
    postgresProof: await postgresProof(),
    phase: "manifests" as const,
  };
  assert.deepEqual(
    parseCatalogRetentionPublicationJson(
      canonicalJson(request),
      catalogRetentionManifestRequestSchema,
    ),
    request,
  );
  assert.equal(catalogRetentionManifestRequestSchema.safeParse({
    ...request,
    candidateManifestId: "caller-selected",
  }).success, false);
  assert.equal(catalogRetentionManifestRequestSchema.safeParse({
    ...request,
    organizationId: "00000000-0000-4000-8000-000000000001",
  }).success, false);
  assert.equal(catalogRetentionProviderRequestSchema.safeParse({
    ...request,
    phase: "provider_releases",
    platformKey: "alpha",
    deploymentKey: "production",
  }).success, false);
  assert.equal(containsProtectedCatalogRetentionField({
    nested: { deployment_key: "production" },
  }), true);
});

test("external protections are bounded, ordered, and exact-operation bound", async () => {
  const manifest = {
    publicReleaseId: "00000000-0000-5000-8000-000000000001",
    manifestFingerprint: SHA_A,
    sharedConfigurationEpoch: {
      configurationKey: "catalog",
      revision: 1,
      publicChangeSequence: "1",
      configurationHash: SHA_B,
    },
    providerReferenceSetHash: SHA_C,
  };
  const valid = await postgresProof({
    manifestProtections: [{
      manifest,
      reason: "rollback_recovery",
      operationProof: {
        operationKind: "activateManifest",
        operationId: "manifest:activate:1",
        operationState: "acknowledged",
        canonicalRequestBody: "{}",
        requestDigest: SHA_A,
        terminalReceiptSha256: SHA_B,
      },
    }],
  });
  assert.equal(
    catalogRetentionManifestRequestSchema.safeParse({
      schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
      operationId: "retention:manifest:proof",
      idempotencyKey: "retention:manifest:proof",
      expectedRetentionGeneration: 3,
      maximumDocuments: 10,
      postgresProof: valid,
      phase: "manifests",
    }).success,
    true,
  );
  const invalidKind = await postgresProof({
    manifestProtections: [{
      manifest,
      reason: "block_recovery",
      operationProof: {
        operationKind: "rollback",
        operationId: "manifest:rollback:1",
        operationState: "acknowledged",
        canonicalRequestBody: "{}",
        requestDigest: SHA_A,
        terminalReceiptSha256: SHA_B,
      },
    }],
  });
  assert.equal(catalogRetentionManifestRequestSchema.safeParse({
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationId: "retention:manifest:bad-proof",
    idempotencyKey: "retention:manifest:bad-proof",
    expectedRetentionGeneration: 3,
    maximumDocuments: 10,
    postgresProof: invalidKind,
    phase: "manifests",
  }).success, false);
});

test("sent but unacknowledged finalize and activate proofs remain representable", async () => {
  const manifest = {
    publicReleaseId: "00000000-0000-5000-8000-000000000001",
    manifestFingerprint: SHA_A,
    sharedConfigurationEpoch: {
      configurationKey: "catalog",
      revision: 1,
      publicChangeSequence: "1",
      configurationHash: SHA_B,
    },
    providerReferenceSetHash: SHA_C,
  };
  const snapshot = await postgresProof({
    manifestProtections: [{
      manifest,
      reason: "in_flight_attempt",
      operationProof: {
        operationKind: "activateManifest",
        operationId: "manifest:activate:sent",
        operationState: "sent",
        canonicalRequestBody: canonicalJson({ operationId: "manifest:activate:sent" }),
        requestDigest: SHA_A,
        terminalReceiptSha256: null,
      },
    }],
    providerProtectionsByPlatform: [{
      platformKey: "alpha",
      releases: [{
        release: {
          platformKey: "alpha",
          publicProviderReleaseId:
            "00000000-0000-5000-8000-000000000002",
          providerReleaseFingerprint: SHA_B,
        },
        reason: "in_flight_attempt",
        operationProof: {
          operationKind: "finalize",
          operationId: "provider:finalize:sent",
          operationState: "sent",
          canonicalRequestBody: canonicalJson({
            operationId: "provider:finalize:sent",
          }),
          requestDigest: SHA_C,
          terminalReceiptSha256: null,
        },
      }],
    }],
  });
  assert.equal(catalogRetentionProviderRequestSchema.safeParse({
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationId: "retention:provider:sent",
    idempotencyKey: "retention:provider:sent",
    expectedRetentionGeneration: 0,
    maximumDocuments: 10,
    postgresProof: snapshot,
    phase: "provider_releases",
    platformKey: "alpha",
  }).success, true);
  const invalid = structuredClone(snapshot);
  invalid.providerProtectionsByPlatform[0]!.releases[0]!
    .operationProof.terminalReceiptSha256 = SHA_A;
  assert.equal(catalogRetentionProviderRequestSchema.safeParse({
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationId: "retention:provider:bad-sent",
    idempotencyKey: "retention:provider:bad-sent",
    expectedRetentionGeneration: 0,
    maximumDocuments: 10,
    postgresProof: invalid,
    phase: "provider_releases",
    platformKey: "alpha",
  }).success, false);
});

test("in-flight block operations remain protectable before acknowledgment", async () => {
  const snapshot = await postgresProof({
    providerProtectionsByPlatform: [{
      platformKey: "alpha",
      releases: [{
        release: {
          platformKey: "alpha",
          publicProviderReleaseId:
            "00000000-0000-5000-8000-000000000002",
          providerReleaseFingerprint: SHA_B,
        },
        reason: "in_flight_attempt",
        operationProof: {
          operationKind: "block",
          operationId: "provider:block:sent",
          operationState: "sent",
          canonicalRequestBody: canonicalJson({
            operationId: "provider:block:sent",
          }),
          requestDigest: SHA_C,
          terminalReceiptSha256: null,
        },
      }],
    }],
  });
  assert.equal(catalogRetentionProviderRequestSchema.safeParse({
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationId: "retention:provider:block-sent",
    idempotencyKey: "retention:provider:block-sent",
    expectedRetentionGeneration: 0,
    maximumDocuments: 10,
    postgresProof: snapshot,
    phase: "provider_releases",
    platformKey: "alpha",
  }).success, true);
});

test("progress receipts bind one generation advance and the complete delete count", async () => {
  const proof = await postgresProof();
  const protectionSet = {
    authoritativeEvaluationTime: "2026-08-16T12:00:01.000Z",
    postgresProofSnapshotId: proof.snapshotId,
    postgresProofSnapshotSequence: proof.snapshotSequence,
    postgresProofSnapshotDigest: proof.snapshotDigest,
    manifests: [],
    providerReleasesByPlatform: [],
  };
  const withoutDigest = {
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationKind: "retainManifests" as const,
    operationId: "retention:manifest:receipt",
    idempotencyKey: "retention:manifest:receipt",
    terminalState: "continuation_required" as const,
    result: "retained" as const,
    serverTime: "2026-08-16T12:00:01.000Z",
    requestDigest: SHA_A,
    expectedRetentionGeneration: 8,
    retentionGeneration: 9,
    phase: "manifests" as const,
    platformKey: null,
    details: {
      maximumDocuments: 90,
      deletedDocumentCount: 3,
      deletedRetentionOperationCount: 1,
      hasMore: true,
      protectionSet,
      selectedManifest: {
        publicReleaseId: "00000000-0000-5000-8000-000000000001",
        manifestFingerprint: SHA_A,
        lifecycle: "complete" as const,
      },
      deletedManifestCount: 1,
      deletedManifestReferenceCount: 1,
    },
  };
  const receipt = {
    ...withoutDigest,
    receiptDigest: await catalogRetentionReceiptDigest(withoutDigest),
  };
  assert.equal(catalogRetentionManifestReceiptSchema.safeParse(receipt).success, true);
  assert.equal(catalogRetentionManifestReceiptSchema.safeParse({
    ...receipt,
    retentionGeneration: 10,
  }).success, false);
  assert.equal(catalogRetentionManifestReceiptSchema.safeParse({
    ...receipt,
    details: { ...receipt.details, deletedDocumentCount: 2 },
  }).success, false);
  assert.notEqual(
    await catalogRetentionTerminalReceiptSha256(receipt),
    receipt.receiptDigest,
  );
});

test("status targets bind phase, platform, and exact request digest", () => {
  assert.equal(catalogRetentionStatusTargetSchema.safeParse({
    operationKind: "retainProviderReleases",
    operationId: "retention:provider:1",
    idempotencyKey: "retention:provider:1",
    phase: "provider_releases",
    platformKey: "alpha",
    requestDigest: SHA_A,
  }).success, true);
  assert.equal(catalogRetentionStatusTargetSchema.safeParse({
    operationKind: "retainManifests",
    operationId: "retention:manifest:1",
    idempotencyKey: "retention:manifest:1",
    phase: "manifests",
    platformKey: "alpha",
    requestDigest: SHA_A,
  }).success, false);
});
