import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  PRODUCTION_AUTH_SIGNATURE_VERSION,
  activeCatalogManifestStateV1Schema,
  buildGlobalCatalogAggregateObservationV1,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestPublicationRequestDigest,
  catalogManifestReceiptDigest,
  catalogManifestSignedReceiptEnvelopeSchema,
  derivePublicCatalogReleaseIdV1,
  recomputeGlobalCatalogIdentityMappingsHashV1,
  recomputeGlobalCatalogManifestContentHashV1,
  recomputeGlobalCatalogManifestEntityHashesV1,
  recomputeGlobalCatalogManifestFingerprintV1,
  recomputeGlobalCatalogManifestOriginSetHashV1,
  recomputeGlobalCatalogManifestSearchIndexHashV1,
  recomputeGlobalCatalogProviderConfigurationsHashV1,
  recomputeGlobalCatalogProviderReferenceSetHashV1,
  recomputeGlobalCatalogSharedCategoriesHashV1,
  verifyGlobalCatalogManifestV1,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestActivateRequest,
  type GlobalCatalogManifestV1,
  type GlobalCatalogProviderActiveObservationV1,
  type GlobalCatalogProviderReferenceV1,
} from "@packscout/contracts";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import {
  ManifestActivationRepositoryError,
  PrismaManifestActivationRepository,
  type ExactManifestActivationIntentInput,
} from "./manifest-activation-repository.ts";
import { PrismaManifestGateIntentRepository } from
  "./manifest-gate-intent-repository.ts";
import { PromotionJobPersistenceError } from
  "./promotion-job-persistence-types.ts";
import { createMigratedCentralTestDatabase } from "./test-support.ts";

const organizationId = "75000000-0000-4000-8000-000000000001";
const otherOrganizationId = "75000000-0000-4000-8000-000000000004";
const providerIds = {
  alpha: "75000000-0000-4000-8000-000000000002",
  beta: "75000000-0000-4000-8000-000000000003",
} as const;
const catalogIds = {
  alphaOne: "75000000-0000-4000-8000-000000000011",
  alphaTwo: "75000000-0000-4000-8000-000000000012",
  betaOne: "75000000-0000-4000-8000-000000000013",
} as const;
const localReleaseIds = {
  alphaOne: "75000000-0000-4000-8000-000000000021",
  alphaTwo: "75000000-0000-4000-8000-000000000022",
  betaOne: "75000000-0000-4000-8000-000000000023",
} as const;
const publicReleaseIds = {
  alphaOne: "75111111-1111-5111-8111-111111111111",
  alphaTwo: "75222222-2222-5222-8222-222222222222",
  betaOne: "75333333-3333-5333-8333-333333333333",
} as const;
const base = new Date("2026-09-01T12:00:00.000Z");
const operatorId = "75000000-0000-4000-8000-000000000099";
const otherOperatorId = "75000000-0000-4000-8000-000000000098";

function hash(value: string | Uint8Array): string {
  const digest = createHash("sha256");
  return (typeof value === "string"
    ? digest.update(value, "utf8")
    : digest.update(value)).digest("hex");
}

function repeated(value: string): string {
  return value.repeat(64);
}

async function reference(input: Readonly<{
  providerKey: "alpha" | "beta";
  publicProviderReleaseId: string;
  catalogVersionId: string;
  marker: string;
  dataAsOf: string;
}>): Promise<GlobalCatalogProviderReferenceV1> {
  const origin = `https://${input.providerKey}.assets.packscout.test`;
  return {
    platformKey: input.providerKey,
    publicProviderReleaseId: input.publicProviderReleaseId,
    sharedConfigurationEpoch: {
      configurationKey: `catalog-version:${input.catalogVersionId}`,
      revision: 1,
      publicChangeSequence: "10",
      configurationHash: repeated(input.marker),
    },
    providerReleaseFingerprint: repeated(input.marker),
    contentHash: repeated(input.marker === "a" ? "b" : "a"),
    publicAssetOrigins: [origin],
    governingHashes: {
      providerConfigurationHash: repeated(input.marker),
      sharedCategoriesHash: repeated("c"),
      identityMappingsHash: repeated(input.marker === "a" ? "d" : "e"),
      originSetHash: await recomputeGlobalCatalogManifestOriginSetHashV1([
        origin,
      ]),
      confidencePolicyHash: repeated("f"),
    },
    entityHashes: {
      vendors: repeated(input.marker),
      categories: repeated("b"),
      collectibles: repeated("c"),
      repacks: repeated(input.marker === "a" ? "d" : "e"),
      repack_chases: repeated("e"),
      search_shards: repeated("f"),
    },
    counts: {
      vendors: 1,
      categories: 0,
      collectibles: 0,
      repacks: 1,
      repackChases: 1,
      searchShards: 1,
    },
    searchAlgorithmVersion: "repack_search_v2",
    providerSearchIndexHash: repeated(input.marker === "a" ? "e" : "d"),
    batchCount: 1,
    batchChainHash: repeated("f"),
    dataAsOf: input.dataAsOf,
  };
}

async function manifest(
  references: readonly GlobalCatalogProviderReferenceV1[],
): Promise<GlobalCatalogManifestV1> {
  const providerReferences = [...references].sort((left, right) =>
    left.platformKey < right.platformKey ? -1 : 1);
  const publicAssetOrigins = [...new Set(providerReferences.flatMap(
    ({ publicAssetOrigins: origins }) => origins,
  ))].sort();
  const [
    providerReferenceSetHash,
    providerConfigurationsHash,
    sharedCategoriesHash,
    identityMappingsHash,
    originSetHash,
    entityHashes,
    repackSearchIndexHash,
  ] = await Promise.all([
    recomputeGlobalCatalogProviderReferenceSetHashV1(providerReferences),
    recomputeGlobalCatalogProviderConfigurationsHashV1(providerReferences),
    recomputeGlobalCatalogSharedCategoriesHashV1(providerReferences),
    recomputeGlobalCatalogIdentityMappingsHashV1(providerReferences),
    recomputeGlobalCatalogManifestOriginSetHashV1(publicAssetOrigins),
    recomputeGlobalCatalogManifestEntityHashesV1(providerReferences),
    recomputeGlobalCatalogManifestSearchIndexHashV1(providerReferences),
  ]);
  const contentHash = await recomputeGlobalCatalogManifestContentHashV1({
    entityHashes,
  });
  const identity = {
    schemaVersion: "global_catalog_manifest_v1" as const,
    dataSource: "canonical" as const,
    sharedConfigurationEpoch: providerReferences[0]!.sharedConfigurationEpoch,
    enabledPlatformKeys: providerReferences.map(({ platformKey }) => platformKey),
    providerReferenceSetHash,
    providerReferences,
    governingHashes: {
      providerConfigurationsHash,
      sharedCategoriesHash,
      identityMappingsHash,
      originSetHash,
      confidencePolicyHash: repeated("f"),
    },
    compositionProof: {
      sharedCategoryIdentityBytesHash: repeated("1"),
      sharedCollectibleIdentityBytesHash: repeated("2"),
      uniqueVendorOwnershipHash: repeated("3"),
      uniqueRepackOwnershipHash: repeated("4"),
      crossReferenceGraphHash: repeated("5"),
    },
    entityHashes,
    counts: {
      vendors: providerReferences.length,
      categories: 0,
      collectibles: 0,
      repacks: providerReferences.length,
      repackChases: providerReferences.length,
      searchShards: providerReferences.length,
    },
    contentHash,
    publicAssetOrigins,
    searchAlgorithmVersion: "repack_search_v2" as const,
    repackSearchIndexHash,
    confidencePolicyVersion: "confidence-v1",
  };
  const [publicReleaseId, manifestFingerprint] = await Promise.all([
    derivePublicCatalogReleaseIdV1(identity),
    recomputeGlobalCatalogManifestFingerprintV1(identity),
  ]);
  return verifyGlobalCatalogManifestV1({
    ...identity,
    publicReleaseId,
    manifestFingerprint,
  });
}

function selection(
  reference: GlobalCatalogProviderReferenceV1,
  marker: string,
): GlobalCatalogProviderActiveObservationV1 {
  return {
    platformKey: reference.platformKey,
    publicProviderReleaseId: reference.publicProviderReleaseId,
    terminalOperationKind: "finalize",
    terminalOperationId: `provider:${reference.platformKey}:finalize:${marker}`,
    terminalReceiptSha256: repeated(marker),
    selectedProviderCheckpoint: {
      settledSequence: "20",
      settledAt: "2026-09-01T12:02:00.000Z",
    },
    selectedDataAsOf: reference.dataAsOf,
    latestAffectedSettledSequence: "20",
    latestAffectedSourceHeadSequence: "20",
    initialBackfillComplete: true,
    affectedDerivationsSettled: true,
    settledSourceFreshness: "fresh",
    lastSuccessfulObservationAt: "2026-09-01T12:01:00.000Z",
    staleAt: "2026-09-01T12:11:00.000Z",
  };
}

function emptyState(): ActiveCatalogManifestStateV1 {
  return activeCatalogManifestStateV1Schema.parse({
    generation: 0,
    activeManifest: null,
    previousManifest: null,
    observation: null,
    terminalReceiptSha256: null,
  });
}

function activateRequest(input: Readonly<{
  operationId: string;
  idempotencyKey?: string;
  manifest: GlobalCatalogManifestV1;
  expected: ActiveCatalogManifestStateV1;
  selections: readonly GlobalCatalogProviderActiveObservationV1[];
}>): CatalogManifestActivateRequest {
  return catalogManifestActivateRequestSchema.parse({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey ?? input.operationId,
    manifest: input.manifest,
    observation: buildGlobalCatalogAggregateObservationV1({
      observationSequence:
        (input.expected.observation?.observationSequence ?? 0) + 1,
      publicReleaseId: input.manifest.publicReleaseId,
      providerReferenceSetHash: input.manifest.providerReferenceSetHash,
      providerSelections: [...input.selections].sort((left, right) =>
        left.platformKey < right.platformKey ? -1 : 1),
    }),
    expectedActiveState: input.expected,
  });
}

async function intentInput(input: Readonly<{
  providerId: string;
  operation: "advance" | "add" | "remove" | "rollback";
  targetProviderReleaseId: string | null;
  targetCatalogVersionId: string | null;
  manifest: GlobalCatalogManifestV1;
  request: CatalogManifestActivateRequest;
  requestedAt: Date;
}>): Promise<ExactManifestActivationIntentInput> {
  const canonicalRequestBody = canonicalJson(input.request);
  return {
    providerId: input.providerId,
    operation: input.operation,
    targetProviderReleaseId: input.targetProviderReleaseId,
    targetCatalogVersionId: input.targetCatalogVersionId,
    targetManifest: input.manifest,
    canonicalRequestBody,
    requestDigest: await catalogManifestPublicationRequestDigest(input.request),
    requestedAt: input.requestedAt,
  };
}

async function receiptEvidence(
  request: CatalogManifestActivateRequest,
  serverTime: string,
) {
  const activeState = {
    generation: request.expectedActiveState.generation + 1,
    activeManifest: {
      publicReleaseId: request.manifest.publicReleaseId,
      manifestFingerprint: request.manifest.manifestFingerprint,
      sharedConfigurationEpoch: request.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: request.manifest.providerReferenceSetHash,
      createdAt: serverTime,
      completedAt: serverTime,
    },
    previousManifest: request.expectedActiveState.activeManifest,
    observation: request.observation,
  } as const;
  const withoutDigest = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationKind: "activateManifest" as const,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    publicReleaseId: request.manifest.publicReleaseId,
    manifestFingerprint: request.manifest.manifestFingerprint,
    terminalState: "complete" as const,
    result: "activated" as const,
    serverTime,
    requestDigest: await catalogManifestPublicationRequestDigest(request),
    details: {
      expectedActiveState: request.expectedActiveState,
      activeState,
    },
  };
  const receipt = {
    ...withoutDigest,
    receiptDigest: await catalogManifestReceiptDigest(withoutDigest),
  };
  const envelope = catalogManifestSignedReceiptEnvelopeSchema.parse({
    ok: true,
    receipt,
    responseAuth: {
      signatureVersion: PRODUCTION_AUTH_SIGNATURE_VERSION,
      keyId: "manifest-primary.v1",
      receiptDigest: receipt.receiptDigest,
      signature: repeated("a"),
    },
  });
  const canonicalReceiptBody = canonicalJson(receipt);
  const exactResponseBody = canonicalJson(envelope);
  return {
    canonicalReceiptBody,
    receiptSha256: hash(canonicalReceiptBody),
    exactResponseBody,
    exactResponseSha256: hash(exactResponseBody),
  };
}

async function activeStateEvidence(input: Readonly<{
  activeState: ActiveCatalogManifestStateV1;
  activeManifest: GlobalCatalogManifestV1 | null;
  previousManifest: GlobalCatalogManifestV1 | null;
  serverTime: string;
}>) {
  const request = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "catalog-manifest-active-state",
  } as const;
  const withoutDigest = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationKind: "activeState" as const,
    operationId: request.operationId,
    terminalState: "observed" as const,
    result: "active_state" as const,
    serverTime: input.serverTime,
    requestDigest: await catalogManifestPublicationRequestDigest(request),
    details: { activeState: input.activeState },
  };
  const receipt = {
    ...withoutDigest,
    receiptDigest: await catalogManifestReceiptDigest(withoutDigest),
  };
  const envelope = catalogManifestSignedReceiptEnvelopeSchema.parse({
    ok: true,
    receipt,
    responseAuth: {
      signatureVersion: PRODUCTION_AUTH_SIGNATURE_VERSION,
      keyId: "manifest-primary.v1",
      receiptDigest: receipt.receiptDigest,
      signature: repeated("a"),
    },
  });
  const canonicalReceiptBody = canonicalJson(receipt);
  const exactResponseBody = canonicalJson(envelope);
  return {
    canonicalReceiptBody,
    receiptSha256: hash(canonicalReceiptBody),
    exactResponseBody,
    exactResponseSha256: hash(exactResponseBody),
    activeManifest: input.activeManifest,
    previousManifest: input.previousManifest,
  };
}

async function seedCompleteCatalogs(
  database: Awaited<ReturnType<typeof createMigratedCentralTestDatabase>>["client"],
): Promise<void> {
  const catalogs = [
    { id: catalogIds.alphaOne, operation: "75000000-0000-4000-8000-000000000031", marker: "a" },
    { id: catalogIds.alphaTwo, operation: "75000000-0000-4000-8000-000000000032", marker: "b" },
    { id: catalogIds.betaOne, operation: "75000000-0000-4000-8000-000000000033", marker: "c" },
  ] as const;
  await database.$transaction(async (transaction) => {
    for (const catalog of catalogs) {
      const request = Buffer.from(`{"catalog":"${catalog.marker}"}`, "utf8");
      await transaction.$executeRaw(CentralPrisma.sql`
        insert into catalog_versions (
          id, through_change_sequence, schema_version, lifecycle,
          category_count, collectible_count, alias_count, content_hash
        ) values (
          ${catalog.id}::uuid, 0, 'catalog-v1', 'building',
          0, 0, 0, ${repeated(catalog.marker)}
        )
      `);
      for (const kind of ["categories", "collectibles", "aliases"] as const) {
        await transaction.$executeRaw(CentralPrisma.sql`
          insert into catalog_version_batches (
            catalog_version_id, batch_kind, batch_index, payload,
            record_count, byte_count, body_hash
          ) values (
            ${catalog.id}::uuid, ${kind}, 0, '[]'::jsonb,
            0, 2, ${repeated(catalog.marker)}
          )
        `);
      }
      await transaction.$executeRaw(CentralPrisma.sql`
        update catalog_versions
        set lifecycle = 'assembled', assembled_at = ${base}
        where id = ${catalog.id}::uuid
      `);
      await transaction.$executeRaw(CentralPrisma.sql`
        update catalog_versions
        set lifecycle = 'publishing'
        where id = ${catalog.id}::uuid
      `);
      await transaction.$executeRaw(CentralPrisma.sql`
        insert into catalog_publication_operations (
          id, catalog_version_id, operation_kind, idempotency_key,
          request_digest, request_bytes, lease_fence, state,
          convex_receipt_id, receipt_hash, receipt, requested_at, completed_at
        ) values (
          ${catalog.operation}::uuid, ${catalog.id}::uuid, 'finalize',
          ${`catalog:${catalog.marker}:finalize`},
          ${hash(request)}, ${request}, 1, 'accepted',
          ${`catalog-receipt-${catalog.marker}`},
          encode(digest(convert_to('{"accepted":true}'::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
          '{"accepted":true}'::jsonb, ${base}, ${base}
        )
      `);
      await transaction.$executeRaw(CentralPrisma.sql`
        update catalog_versions
        set lifecycle = 'complete', completed_at = ${base}
        where id = ${catalog.id}::uuid
      `);
    }
  });
}

function repositoryCode(expected: ManifestActivationRepositoryError["code"]) {
  return (error: unknown) =>
    error instanceof ManifestActivationRepositoryError &&
    error.code === expected;
}

test("manifest activation ledger recovers lost acknowledgements and preserves unrelated providers", async () => {
  const harness = await createMigratedCentralTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "manifest-activation-integration",
        name: "Manifest activation integration",
      },
    });
    await harness.client.organizations.create({
      data: {
        id: otherOrganizationId,
        slug: "manifest-activation-other-organization",
        name: "Manifest activation other organization",
      },
    });
    await harness.client.providers.createMany({
      data: [{
        id: providerIds.alpha,
        organization_id: organizationId,
        provider_key: "alpha",
        display_name: "Alpha",
      }, {
        id: providerIds.beta,
        organization_id: organizationId,
        provider_key: "beta",
        display_name: "Beta",
      }],
    });
    await harness.client.operators.create({
      data: {
        id: operatorId,
        email_normalized: "manifest-activation@example.test",
        display_name: "Manifest activation operator",
        password_hash: "argon2id$manifest-activation-test",
        state: "active",
      },
    });
    await harness.client.operators.create({
      data: {
        id: otherOperatorId,
        email_normalized: "manifest-activation-other@example.test",
        display_name: "Other organization operator",
        password_hash: "argon2id$manifest-activation-other-test",
        state: "active",
      },
    });
    await harness.client.operator_memberships.createMany({
      data: [{
        organization_id: organizationId,
        operator_id: operatorId,
        role: "admin",
      }, {
        organization_id: otherOrganizationId,
        operator_id: otherOperatorId,
        role: "admin",
      }],
    });
    await seedCompleteCatalogs(harness.client);

    const gateRepository = new PrismaManifestGateIntentRepository(
      harness.client,
    );
    const authorizationDigest = hash("authorized alpha removal");
    await assert.rejects(
      gateRepository.authorizeExplicit({
        providerId: providerIds.alpha,
        operation: "remove",
        targetProviderReleaseId: null,
        targetCatalogVersionId: null,
        requestedByOperatorId: otherOperatorId,
        authorizationDigest,
        requestedAt: base,
      }),
      (error: unknown) =>
        error instanceof PromotionJobPersistenceError &&
        error.code === "PROMOTION_JOB_GATE_INTENT_INVALID",
      "an active admin from another organization cannot authorize a gate",
    );
    const explicit = await gateRepository.authorizeExplicit({
      providerId: providerIds.alpha,
      operation: "remove",
      targetProviderReleaseId: null,
      targetCatalogVersionId: null,
      requestedByOperatorId: operatorId,
      authorizationDigest,
      requestedAt: base,
    });
    assert.equal(explicit.operationGeneration, 1n);
    assert.equal(
      (await gateRepository.authorizeExplicit({
        providerId: providerIds.alpha,
        operation: "remove",
        targetProviderReleaseId: null,
        targetCatalogVersionId: null,
        requestedByOperatorId: operatorId,
        authorizationDigest,
        requestedAt: new Date(base.getTime() + 1),
      })).operationGeneration,
      1n,
      "exact explicit authorization replay is idempotent",
    );
    await gateRepository.coalesce({
      providerId: providerIds.alpha,
      requestedGeneration: 2n,
      cause: "provider_completion",
      evidenceDigest: hash("newer automatic gate"),
      requestedAt: new Date(base.getTime() + 1_000),
    });
    const explicitClaim = await gateRepository.claimNext({
      owner: "manifest-explicit-test",
      now: new Date(base.getTime() + 2_000),
      claimMilliseconds: 60_000,
    });
    assert.equal(explicitClaim?.observedGeneration, 1n);
    assert.equal(explicitClaim?.requestedOperation, "remove");
    const remaining = await gateRepository.acknowledgeClaim({
      providerId: explicitClaim!.providerId,
      claimToken: explicitClaim!.claimToken,
      observedGeneration: explicitClaim!.observedGeneration,
      acknowledgedAt: new Date(base.getTime() + 3_000),
    });
    assert.equal(remaining.pending, true);
    assert.equal(remaining.requestedOperation, null);
    const automaticClaim = await gateRepository.claimNext({
      owner: "manifest-explicit-test",
      now: new Date(base.getTime() + 4_000),
      claimMilliseconds: 60_000,
    });
    assert.equal(automaticClaim?.observedGeneration, 2n);
    await gateRepository.acknowledgeClaim({
      providerId: automaticClaim!.providerId,
      claimToken: automaticClaim!.claimToken,
      observedGeneration: automaticClaim!.observedGeneration,
      acknowledgedAt: new Date(base.getTime() + 5_000),
    });

    const [alphaOne, alphaTwo, betaOne] = await Promise.all([
      reference({
        providerKey: "alpha",
        publicProviderReleaseId: publicReleaseIds.alphaOne,
        catalogVersionId: catalogIds.alphaOne,
        marker: "a",
        dataAsOf: "2026-09-01T12:00:00.000Z",
      }),
      reference({
        providerKey: "alpha",
        publicProviderReleaseId: publicReleaseIds.alphaTwo,
        catalogVersionId: catalogIds.alphaTwo,
        marker: "b",
        dataAsOf: "2026-09-01T12:00:30.000Z",
      }),
      reference({
        providerKey: "beta",
        publicProviderReleaseId: publicReleaseIds.betaOne,
        catalogVersionId: catalogIds.betaOne,
        marker: "c",
        dataAsOf: "2026-09-01T12:00:00.000Z",
      }),
    ]);
    const [alphaManifest, betaManifest, bothManifest, advancedManifest] =
      await Promise.all([
        manifest([alphaOne]),
        manifest([betaOne]),
        manifest([alphaOne, betaOne]),
        manifest([alphaTwo, betaOne]),
      ]);
    const alphaOneSelection = selection(alphaOne, "1");
    const alphaTwoSelection = selection(alphaTwo, "2");
    const betaSelection = selection(betaOne, "3");
    const repository = new PrismaManifestActivationRepository(harness.client);
    const firstLease = await repository.claimLease("manifest-worker-one", 60_000);
    await assert.rejects(
      repository.claimLease("manifest-worker-one", 60_000),
      repositoryCode("MANIFEST_ACTIVATION_LEASE_HELD"),
      "a shared worker name cannot create concurrent live owners",
    );
    const bootstrapEvidence = await activeStateEvidence({
      activeState: emptyState(),
      activeManifest: null,
      previousManifest: null,
      serverTime: "2026-09-01T12:00:00.000Z",
    });
    const bootstrapped = await repository.reconcileSignedActiveState({
      lease: firstLease,
      observationKind: "bootstrap",
      evidence: bootstrapEvidence,
      observedAt: base,
    });
    assert.equal(bootstrapped.generation, 0n);
    const bootstrapRows = await harness.client.$queryRaw<Array<{
      responseBytes: Uint8Array;
    }>>(CentralPrisma.sql`
      select response_bytes as "responseBytes"
      from manifest_activation_state_observations
    `);
    assert.equal(bootstrapRows.length, 1);
    assert.equal(
      Buffer.from(bootstrapRows[0]!.responseBytes).toString("utf8"),
      bootstrapEvidence.exactResponseBody,
    );

    const alphaRequest = activateRequest({
      operationId: "manifest:alpha:add:one",
      manifest: alphaManifest,
      expected: emptyState(),
      selections: [alphaOneSelection],
    });
    const alphaInput = await intentInput({
      providerId: providerIds.alpha,
      operation: "add",
      targetProviderReleaseId: localReleaseIds.alphaOne,
      targetCatalogVersionId: catalogIds.alphaOne,
      manifest: alphaManifest,
      request: alphaRequest,
      requestedAt: base,
    });
    const alphaIntent = await repository.persistIntent(firstLease, alphaInput);
    assert.equal(
      (await repository.persistIntent(firstLease, alphaInput)).id,
      alphaIntent.id,
    );

    const conflictingRequest = activateRequest({
      operationId: "manifest:alpha:add:one",
      idempotencyKey: alphaRequest.idempotencyKey,
      manifest: betaManifest,
      expected: emptyState(),
      selections: [betaSelection],
    });
    await assert.rejects(
      repository.persistIntent(firstLease, await intentInput({
        providerId: providerIds.beta,
        operation: "add",
        targetProviderReleaseId: localReleaseIds.betaOne,
        targetCatalogVersionId: catalogIds.betaOne,
        manifest: betaManifest,
        request: conflictingRequest,
        requestedAt: new Date(base.getTime() + 1_000),
      })),
      repositoryCode("MANIFEST_ACTIVATION_IDEMPOTENCY_CONFLICT"),
    );

    const staleRequest = activateRequest({
      operationId: "manifest:beta:add:stale",
      manifest: betaManifest,
      expected: emptyState(),
      selections: [betaSelection],
    });
    const staleIntent = await repository.persistIntent(
      firstLease,
      await intentInput({
        providerId: providerIds.beta,
        operation: "add",
        targetProviderReleaseId: localReleaseIds.betaOne,
        targetCatalogVersionId: catalogIds.betaOne,
        manifest: betaManifest,
        request: staleRequest,
        requestedAt: new Date(base.getTime() + 2_000),
      }),
    );
    await repository.recordAttempt({
      lease: firstLease,
      operationId: alphaIntent.id,
      attemptedAt: new Date(base.getTime() + 3_000),
    });
    await repository.recordAmbiguous({
      lease: firstLease,
      operationId: alphaIntent.id,
      failureCode: "PUBLICATION_TIMEOUT",
      observedAt: new Date(base.getTime() + 4_000),
    });
    await repository.releaseLease(firstLease);

    const recoveryLease = await repository.claimLease(
      "manifest-worker-recovery",
      60_000,
    );
    await assert.rejects(
      repository.recordAttempt({
        lease: firstLease,
        operationId: staleIntent.id,
        attemptedAt: new Date(base.getTime() + 5_000),
      }),
      repositoryCode("MANIFEST_ACTIVATION_LEASE_LOST"),
    );
    const recovering = await repository.recordAttempt({
      lease: recoveryLease,
      operationId: alphaIntent.id,
      attemptedAt: new Date(base.getTime() + 5_000),
    });
    assert.equal(recovering.attemptCount, 2);
    assert.deepEqual(repository.statusRequest(recovering).target, {
      operationKind: "activateManifest",
      operationId: alphaRequest.operationId,
      idempotencyKey: alphaRequest.idempotencyKey,
      requestDigest: alphaInput.requestDigest,
      publicReleaseId: alphaManifest.publicReleaseId,
      manifestFingerprint: alphaManifest.manifestFingerprint,
    });
    const alphaEvidence = await receiptEvidence(
      alphaRequest,
      "2026-09-01T12:00:06.000Z",
    );
    const statusObservation = await repository.recordStatusObservation({
      lease: recoveryLease,
      operationId: alphaIntent.id,
      evidence: alphaEvidence,
      observedAt: new Date(base.getTime() + 5_500),
    });
    assert.equal(statusObservation.resultKind, "terminal");
    const statusRows = await harness.client.$queryRaw<Array<{
      responseBytes: Uint8Array;
    }>>(CentralPrisma.sql`
      select response_bytes as "responseBytes"
      from manifest_activation_status_observations
      where operation_id = ${alphaIntent.id}::uuid
    `);
    assert.equal(statusRows.length, 1);
    assert.equal(
      Buffer.from(statusRows[0]!.responseBytes).toString("utf8"),
      alphaEvidence.exactResponseBody,
    );
    const alphaAccepted = await repository.accept({
      lease: recoveryLease,
      operationId: alphaIntent.id,
      evidence: alphaEvidence,
      receivedAt: new Date(base.getTime() + 6_000),
    });
    assert.equal(alphaAccepted.mirror.generation, 1n);
    assert.equal(
      alphaAccepted.mirror.activeManifest?.publicReleaseId,
      alphaManifest.publicReleaseId,
    );
    assert.equal(
      (await repository.accept({
        lease: recoveryLease,
        operationId: alphaIntent.id,
        evidence: alphaEvidence,
        receivedAt: new Date(base.getTime() + 6_000),
      })).operation.state,
      "accepted",
    );

    await repository.recordAttempt({
      lease: recoveryLease,
      operationId: staleIntent.id,
      attemptedAt: new Date(base.getTime() + 7_000),
    });
    await assert.rejects(
      repository.accept({
        lease: recoveryLease,
        operationId: staleIntent.id,
        evidence: await receiptEvidence(
          staleRequest,
          "2026-09-01T12:00:08.000Z",
        ),
        receivedAt: new Date(base.getTime() + 8_000),
      }),
      repositoryCode("MANIFEST_ACTIVATION_STATE_CONFLICT"),
    );
    assert.equal(
      (await repository.loadMirror()).activeManifest?.publicReleaseId,
      alphaManifest.publicReleaseId,
    );

    const addBetaRequest = activateRequest({
      operationId: "manifest:beta:add:one",
      manifest: bothManifest,
      expected: alphaAccepted.mirror.activeState!,
      selections: [alphaOneSelection, betaSelection],
    });
    const addBeta = await repository.persistIntent(
      recoveryLease,
      await intentInput({
        providerId: providerIds.beta,
        operation: "add",
        targetProviderReleaseId: localReleaseIds.betaOne,
        targetCatalogVersionId: catalogIds.betaOne,
        manifest: bothManifest,
        request: addBetaRequest,
        requestedAt: new Date(base.getTime() + 9_000),
      }),
    );
    await repository.recordAttempt({
      lease: recoveryLease,
      operationId: addBeta.id,
      attemptedAt: new Date(base.getTime() + 10_000),
    });
    const betaAccepted = await repository.accept({
      lease: recoveryLease,
      operationId: addBeta.id,
      evidence: await receiptEvidence(
        addBetaRequest,
        "2026-09-01T12:00:11.000Z",
      ),
      receivedAt: new Date(base.getTime() + 11_000),
    });

    const advanceAlphaRequest = activateRequest({
      operationId: "manifest:alpha:advance:two",
      manifest: advancedManifest,
      expected: betaAccepted.mirror.activeState!,
      selections: [alphaTwoSelection, betaSelection],
    });
    const advanceAlpha = await repository.persistIntent(
      recoveryLease,
      await intentInput({
        providerId: providerIds.alpha,
        operation: "advance",
        targetProviderReleaseId: localReleaseIds.alphaTwo,
        targetCatalogVersionId: catalogIds.alphaTwo,
        manifest: advancedManifest,
        request: advanceAlphaRequest,
        requestedAt: new Date(base.getTime() + 12_000),
      }),
    );
    await repository.recordAttempt({
      lease: recoveryLease,
      operationId: advanceAlpha.id,
      attemptedAt: new Date(base.getTime() + 13_000),
    });
    const advanceEvidence = await receiptEvidence(
      advanceAlphaRequest,
      "2026-09-01T12:00:14.000Z",
    );
    const advanced = await repository.accept({
      lease: recoveryLease,
      operationId: advanceAlpha.id,
      evidence: advanceEvidence,
      receivedAt: new Date(base.getTime() + 14_000),
    });
    assert.equal(advanced.mirror.generation, 3n);
    assert.equal(
      canonicalJson(advanced.mirror.activeManifest!.providerReferences[1]),
      canonicalJson(advanced.mirror.previousManifest!.providerReferences[1]),
      "beta survives alpha activation byte-for-byte",
    );
    assert.equal(
      advanced.operation.canonicalRequestBody,
      canonicalJson(advanceAlphaRequest),
    );
    assert.equal(
      advanced.operation.canonicalReceiptBody,
      advanceEvidence.canonicalReceiptBody,
    );
    assert.equal(
      advanced.operation.exactResponseBody,
      advanceEvidence.exactResponseBody,
    );
    assert.equal(
      advanced.operation.exactResponseSha256,
      advanceEvidence.exactResponseSha256,
    );
    const clearedState = activeCatalogManifestStateV1Schema.parse({
      generation: 4,
      activeManifest: null,
      previousManifest: null,
      observation: null,
      terminalReceiptSha256: repeated("9"),
    });
    await assert.rejects(
      repository.reconcileSignedActiveState({
        lease: recoveryLease,
        observationKind: "reconciliation",
        evidence: await activeStateEvidence({
          activeState: clearedState,
          activeManifest: null,
          previousManifest: null,
          serverTime: "2026-09-01T12:00:15.000Z",
        }),
        observedAt: new Date(base.getTime() + 15_000),
      }),
      repositoryCode("MANIFEST_ACTIVATION_CLEAR_FORBIDDEN"),
    );
  } finally {
    await harness.close();
  }
});
