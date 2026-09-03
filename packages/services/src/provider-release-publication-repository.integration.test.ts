import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  PROVIDER_RELEASE_PUBLIC_SCHEMA_VERSION,
  canonicalJson,
  providerReleaseMutationRequestSchema,
  providerReleaseReceiptDigest,
  providerReleaseReceiptSchema,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseBatch,
  type ProviderReleaseDescriptor,
  type ProviderReleaseReceipt,
  type ProviderReleaseStatusNotFoundReceipt,
  type ProviderReleaseStatusRequest,
} from "@packscout/contracts";
import {
  ProviderReleasePublicationRepository,
  ProviderReleasePublicationRepositoryError,
  type ProviderReleaseAssemblyResult,
  type ProviderReleasePublicationSource,
} from "@packscout/database";
import { createProviderHarness } from "@packscout/database/test-support";
import { PublicationClientError } from
  "./convex-publication-http-client.ts";
import {
  DistributedProviderReleasePublicationService,
  type DistributedProviderReleasePublicationTransport,
} from "./distributed-provider-release-publication-service.ts";
import { adaptDistributedProviderReleaseToCatalogV1 } from
  "./distributed-provider-release-v1-adapter.ts";
import { buildProviderCatalogReleasePublishPlan } from
  "./provider-catalog-release-artifacts.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";
import { projectProviderCatalogRelease } from
  "./provider-catalog-release-public-projection.ts";
import { prepareProviderPromotion } from
  "./provider-promotion-operations.ts";
import type { ProviderReleasePublicationResult } from
  "./provider-promotion-types.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const observedAt = new Date("2026-08-15T03:00:00.000Z");

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function activePlan(): Promise<ProviderCatalogReleasePublishPlanV1> {
  const configuration = providerFixtureApprovedConfiguration();
  const snapshot = providerFixtureSnapshot({ configuration });
  const projection = projectProviderCatalogRelease({
    configuration,
    platformKey: snapshot.checkpoint.platformKey,
    revisions: snapshot.revisions,
    assetPackAssociations: snapshot.assetPackAssociations,
    repackIdentities: snapshot.repackIdentities,
  });
  return buildProviderCatalogReleasePublishPlan({
    checkpoint: snapshot.checkpoint,
    configuration: snapshot.configuration,
    projection,
    lastSuccessfulObservationAt:
      snapshot.observation.lastSuccessfulObservationAt,
  });
}

function localBatch(
  batchOrdinal: number,
  batchKind: string,
  records: readonly unknown[],
): ProviderReleaseBatch {
  return {
    batchOrdinal,
    batchKind,
    batchIndex: 0,
    records,
    recordCount: records.length,
    byteCount: 1,
    bodyHash: HASH_A,
  } as unknown as ProviderReleaseBatch;
}

async function sourceFixture(input: Readonly<{
  providerId: string;
  providerKey: string;
  providerReleaseId: string;
}>): Promise<Readonly<{
  assembly: ProviderReleaseAssemblyResult;
  source: ProviderReleasePublicationSource;
}>> {
  const plan = await activePlan();
  const records = <Kind extends
    ProviderCatalogReleasePublishPlanV1["batches"][number]["kind"]>(
    kind: Kind,
  ): readonly unknown[] => plan.batches
    .filter((batch) => batch.kind === kind)
    .flatMap((batch) => batch.records as readonly unknown[]);
  const vendors = records("vendors").map((vendor) => ({
    ...(vendor as Record<string, unknown>),
    vendorKey: input.providerKey,
  }));
  const repacks = records("repacks").map((repack) => ({
    ...(repack as Record<string, unknown>),
    vendorKey: input.providerKey,
  }));
  const batches = [
    localBatch(0, "provider", vendors),
    localBatch(1, "category", records("categories")),
    localBatch(2, "collectible", records("collectibles")),
    localBatch(3, "repack", repacks),
    localBatch(4, "chase", records("repack_chases")),
    localBatch(5, "retired-repack", []),
    localBatch(6, "search-index", []),
  ];
  const descriptor: ProviderReleaseDescriptor = {
    providerReleaseId: input.providerReleaseId,
    predecessorCompleteReleaseId: null,
    providerId: input.providerId,
    providerKey: input.providerKey,
    publicProviderId:
      (vendors[0] as unknown as { publicVendorId: string }).publicVendorId,
    throughChangeSequence: "1",
    catalogVersionId: "40000000-0000-4000-8000-000000000001",
    catalogContentHash: HASH_A,
    centralSchemaVersion: "distributed-central-v1",
    correlationEventSequence: "1",
    correlationSnapshotHash: HASH_B,
    publicProfileVersionId: "50000000-0000-4000-8000-000000000001",
    publicProfileHash: HASH_C,
    providerSchemaVersion: "distributed-provider-v1",
    publicSchemaVersion: PROVIDER_RELEASE_PUBLIC_SCHEMA_VERSION,
    categoryCount: records("categories").length,
    collectibleReferenceCount: records("collectibles").length,
    repackCount: repacks.length,
    chaseCount: records("repack_chases").length,
    retiredRepackCount: 0,
    batchCount: batches.length,
    contentHash: HASH_D,
    indexHash: HASH_A,
    dataAsOf: plan.observation.lastSuccessfulObservationAt,
    lastSuccessfulObservationAt:
      plan.observation.lastSuccessfulObservationAt,
    staleAt: plan.observation.staleAt,
    freshness: plan.observation.freshness,
  };
  const release = {
    id: input.providerReleaseId,
    predecessorId: null,
    throughChangeSequence: 1n,
    lifecycle: "assembled" as const,
    contentHash: HASH_D,
    indexHash: HASH_A,
    batchCount: batches.length,
    descriptor,
  };
  return {
    assembly: {
      release,
      selectedThroughChangeSequence: 1n,
      publicEquivalenceHash: HASH_E,
      reusedCompleteRelease: false,
      resumedExistingAssembly: false,
    },
    source: {
      release,
      descriptor,
      batches,
      publicEquivalenceHash: HASH_E,
    },
  };
}

class ExactMemoryTransport
implements DistributedProviderReleasePublicationTransport {
  readonly receipts = new Map<string, ProviderReleasePublicationResult>();
  readonly sentBodies = new Map<string, string[]>();
  readonly statusCounts = new Map<string, number>();
  loseAfterStore: "finalize" | null = "finalize";

  async sendExact(input: Readonly<{
    kind: "start" | "applyBatch" | "finalize" | "confirmReuse" | "block";
    canonicalRequestBody: string;
  }>): Promise<ProviderReleasePublicationResult> {
    const request = providerReleaseMutationRequestSchema.parse(
      JSON.parse(input.canonicalRequestBody),
    );
    assert.ok("release" in request);
    const sent = this.sentBodies.get(request.operationId) ?? [];
    sent.push(input.canonicalRequestBody);
    this.sentBodies.set(request.operationId, sent);
    const common = {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      operationKind: input.kind,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.release.platformKey,
      publicProviderReleaseId: request.release.publicProviderReleaseId,
      sharedConfigurationEpoch: request.release.sharedConfigurationEpoch,
      providerCheckpoint: request.providerCheckpoint,
      serverTime: "2026-08-15T03:00:01.000Z",
      requestDigest: sha256(input.canonicalRequestBody),
    };
    const context = {
      release: request.release,
      providerCheckpoint: request.providerCheckpoint,
      sourceWatermark: request.sourceWatermark,
      observation: request.observation,
      expectedCompletedHead: request.expectedCompletedHead,
    };
    let body: Record<string, unknown>;
    if (input.kind === "start") {
      body = {
        ...common,
        terminalState: "staging",
        result: "created",
        details: { ...context, acceptedBatchCount: 0 },
      };
    } else if (input.kind === "applyBatch" && "batch" in request) {
      body = {
        ...common,
        terminalState: "staging",
        result: "accepted",
        details: {
          ...context,
          batchIndex: request.batch.batchIndex,
          kind: request.batch.kind,
          batchHash: request.batch.batchHash,
          recordCount: request.batch.records.length,
          byteCount: request.batch.byteCount,
          acceptedBatchCount: request.batch.batchIndex + 1,
          acceptedCounts: request.release.counts,
          acceptedEntityHashes: request.release.entityHashes,
          acceptedBatchChainHash: request.release.batchChainHash,
        },
      };
    } else {
      body = {
        ...common,
        terminalState: "complete",
        result: input.kind === "finalize" ? "completed" : "reused",
        details: {
          ...context,
          completedHead: {
            platformKey: request.release.platformKey,
            release: request.release,
            providerCheckpoint: request.providerCheckpoint,
            observation: request.observation,
          },
        },
      };
    }
    const receipt = providerReleaseReceiptSchema.parse({
      ...body,
      receiptDigest: await providerReleaseReceiptDigest(body),
    });
    const canonicalReceiptBody = canonicalJson(receipt);
    const result = {
      receipt,
      canonicalReceiptBody,
      receiptSha256: sha256(canonicalReceiptBody),
    } satisfies ProviderReleasePublicationResult;
    this.receipts.set(request.operationId, result);
    if (this.loseAfterStore === input.kind) {
      this.loseAfterStore = null;
      throw new PublicationClientError(
        "PUBLICATION_NETWORK_ERROR",
        "retryable",
        true,
      );
    }
    return result;
  }

  status(request: ProviderReleaseStatusRequest): Promise<
    ProviderReleasePublicationResult<
      ProviderReleaseReceipt | ProviderReleaseStatusNotFoundReceipt
    >
  > {
    const operationId = request.target.operationId;
    this.statusCounts.set(
      operationId,
      (this.statusCounts.get(operationId) ?? 0) + 1,
    );
    const receipt = this.receipts.get(operationId);
    if (receipt === undefined) throw new Error("Fixture receipt is missing.");
    return Promise.resolve(receipt);
  }
}

async function appendCanonicalChange(
  provider: Awaited<ReturnType<typeof createProviderHarness>>["client"],
  sequence: bigint,
): Promise<void> {
  const categoryId = randomUUID();
  await provider.$transaction(async (transaction) => {
    await transaction.promotion_changes.create({
      data: {
        sequence,
        entity_type: "category",
        entity_id: categoryId,
        entity_version: 1n,
        operation: "upsert",
        changed_at: observedAt,
      },
    });
    await transaction.categories.create({
      data: {
        id: categoryId,
        category_key: `publication_${sequence}`,
        display_name: `Publication ${sequence}`,
      },
    });
    await transaction.promotion_ledger.update({
      where: { singleton_key: true },
      data: { last_sequence: sequence },
    });
  });
}

async function seedRelease(
  provider: Awaited<ReturnType<typeof createProviderHarness>>["client"],
  fixture: Awaited<ReturnType<typeof sourceFixture>>,
): Promise<void> {
  const descriptor = fixture.source.descriptor;
  await provider.$transaction(async (transaction) => {
    await transaction.provider_releases.create({
      data: {
        id: descriptor.providerReleaseId,
        provider_id: descriptor.providerId,
        provider_key: descriptor.providerKey,
        public_provider_id: descriptor.publicProviderId,
        through_change_sequence: BigInt(descriptor.throughChangeSequence),
        catalog_version_id: descriptor.catalogVersionId,
        catalog_content_hash: descriptor.catalogContentHash,
        central_schema_version: descriptor.centralSchemaVersion,
        correlation_event_sequence:
          BigInt(descriptor.correlationEventSequence),
        correlation_snapshot_hash: descriptor.correlationSnapshotHash,
        public_profile_version_id: descriptor.publicProfileVersionId,
        public_profile_hash: descriptor.publicProfileHash,
        provider_schema_version: descriptor.providerSchemaVersion,
        public_schema_version: descriptor.publicSchemaVersion,
        lifecycle: "building",
        category_count: descriptor.categoryCount,
        repack_count: descriptor.repackCount,
        collectible_reference_count: descriptor.collectibleReferenceCount,
        chase_count: descriptor.chaseCount,
        retired_repack_count: descriptor.retiredRepackCount,
        batch_count: descriptor.batchCount,
        content_hash: descriptor.contentHash,
        index_hash: descriptor.indexHash,
        data_as_of: new Date(descriptor.dataAsOf),
        last_successful_observation_at:
          new Date(descriptor.lastSuccessfulObservationAt),
        stale_at: new Date(descriptor.staleAt),
        freshness: descriptor.freshness,
        created_at: observedAt,
      },
    });
    const seedRecords = new Map<string, readonly unknown[]>(
      fixture.source.batches.map((batch) => [
        batch.batchKind,
        batch.records,
      ]),
    );
    seedRecords.set(
      "search-index",
      Array.from({ length: descriptor.repackCount }, () => ({})),
    );
    for (const [ordinal, kind] of [
      "provider", "category", "collectible", "repack", "chase",
      "retired-repack", "search-index",
    ].entries()) {
      const records = seedRecords.get(kind) ?? [];
      await transaction.provider_release_batches.create({
        data: {
          provider_release_id: descriptor.providerReleaseId,
          batch_kind: kind,
          batch_index: 0,
          payload: records as never,
          record_count: records.length,
          byte_count: ordinal + 1,
          body_hash: sha256(`stored:${kind}`),
        },
      });
    }
    await transaction.provider_releases.update({
      where: { id: descriptor.providerReleaseId },
      data: { lifecycle: "assembled", assembled_at: observedAt },
    });
  });
}

function repositoryCode(expected: string) {
  return (error: unknown): boolean =>
    error instanceof ProviderReleasePublicationRepositoryError
    && error.code === expected;
}

test("real provider DB preserves the exact transcript and atomically advances completion evidence", async () => {
  const harness = await createProviderHarness();
  try {
    await appendCanonicalChange(harness.client, 1n);
    const fixture = await sourceFixture({
      providerId: harness.providerId,
      providerKey: harness.providerKey,
      providerReleaseId: randomUUID(),
    });
    await seedRelease(harness.client, fixture);
    const publications = new ProviderReleasePublicationRepository(
      harness.client,
    );
    const transport = new ExactMemoryTransport();
    const publisher = new DistributedProviderReleasePublicationService({
      workerId: "provider-publication-integration",
      releases: {
        publicationSource: () => Promise.resolve(fixture.source),
      },
      publications,
      transport,
      now: () => observedAt,
    });

    const published = await publisher.publish(fixture.assembly);
    assert.equal(published.confirmedThroughChangeSequence, 1n);
    const operations = await harness.client
      .provider_publication_operations.findMany({
        where: { provider_release_id: fixture.source.release.id },
        include: { receipt: true },
        orderBy: [{ requested_at: "asc" }, { id: "asc" }],
      });
    assert.ok(operations.length >= 3);
    assert.equal(operations[0]?.operation_kind, "start");
    assert.equal(operations.at(-1)?.operation_kind, "finalize");
    for (const operation of operations) {
      const exactRequest = new TextDecoder().decode(operation.request_bytes);
      assert.equal(sha256(exactRequest), operation.request_digest);
      assert.deepEqual(
        transport.sentBodies.get(operation.idempotency_key),
        [exactRequest],
      );
      assert.equal(operation.state, "accepted");
      assert.ok(operation.receipt);
      const exactReceipt = new TextDecoder().decode(
        operation.receipt!.response_bytes,
      );
      assert.equal(sha256(exactReceipt), operation.receipt!.response_digest);
      assert.equal(canonicalJson(JSON.parse(exactReceipt)), exactReceipt);
    }
    const finalize = operations.at(-1)!;
    assert.equal(
      transport.statusCounts.get(finalize.idempotency_key),
      1,
      "lost terminal acknowledgement is recovered by exact status",
    );
    const [release, state, checkpoint, outbox] = await Promise.all([
      harness.client.provider_releases.findUniqueOrThrow({
        where: { id: fixture.source.release.id },
      }),
      harness.client.provider_publication_state.findUniqueOrThrow({
        where: { singleton_key: true },
      }),
      harness.client.provider_change_consumers.findUniqueOrThrow({
        where: { consumer_key: "provider_release" },
      }),
      harness.client.provider_activity_outbox.findMany({
        where: { event_type: "provider_release_completed" },
      }),
    ]);
    assert.equal(release.lifecycle, "complete");
    assert.equal(state.completed_release_id, release.id);
    assert.equal(state.completed_through_change_sequence, 1n);
    assert.equal(state.completion_receipt_id, finalize.receipt!.id);
    assert.equal(checkpoint.last_confirmed_sequence, 1n);
    assert.equal(checkpoint.confirmation_id, finalize.receipt!.id);
    assert.equal(outbox.length, 1);
    assert.deepEqual(outbox[0]?.evidence, {
      state: "complete",
      providerReleaseId: release.id,
      publicProviderReleaseId: published.publicProviderReleaseId,
      catalogVersionId: release.catalog_version_id,
      catalogContentHash: release.catalog_content_hash,
      providerReleaseContentHash: release.content_hash,
      providerReleaseFingerprint: published.providerReleaseFingerprint,
      completedThroughChangeSequence: "1",
      terminalReceiptSha256: published.terminalReceiptSha256,
    });

    await appendCanonicalChange(harness.client, 2n);
    const reusePlan = await adaptDistributedProviderReleaseToCatalogV1({
      descriptor: fixture.source.descriptor,
      batches: fixture.source.batches,
      selectedThroughChangeSequence: 2n,
      classification: "reuse",
    });
    const expectedHead = await publications.loadExpectedCompletedHead();
    const reuse = prepareProviderPromotion({
      plan: reusePlan,
      expectedCompletedHead: expectedHead,
      checkpointSha256: fixture.source.publicEquivalenceHash,
    }).operations[0]!;
    assert.equal(reuse.operationKind, "confirmReuse");
    const oldLease = await publications.claimLease("old-fence", 60_000);
    await publications.recordIntent({
      lease: oldLease,
      providerReleaseId: release.id,
      operation: reuse,
    });
    await publications.recordAttempt({
      lease: oldLease,
      idempotencyKey: reuse.operationId,
    });
    const reuseReceipt = await transport.sendExact({
      kind: "confirmReuse",
      canonicalRequestBody: reuse.canonicalRequestBody,
    });
    await publications.releaseLease(oldLease);
    const newLease = await publications.claimLease("new-fence", 60_000);
    await assert.rejects(publications.accept({
      lease: oldLease,
      providerReleaseId: release.id,
      operation: reuse,
      evidence: {
        canonicalReceiptBody: reuseReceipt.canonicalReceiptBody,
        receiptSha256: reuseReceipt.receiptSha256,
      },
    }), repositoryCode("PROVIDER_PUBLICATION_LEASE_LOST"));
    const reconciled = await publications.accept({
      lease: newLease,
      providerReleaseId: release.id,
      operation: reuse,
      evidence: {
        canonicalReceiptBody: reuseReceipt.canonicalReceiptBody,
        receiptSha256: reuseReceipt.receiptSha256,
      },
    });
    await publications.releaseLease(newLease);
    assert.equal(reconciled.completed, true);
    assert.equal(
      (await harness.client.provider_publication_state.findUniqueOrThrow({
        where: { singleton_key: true },
      })).completed_through_change_sequence,
      2n,
    );
    assert.equal(await harness.client.provider_activity_outbox.count({
      where: { event_type: "provider_release_completed" },
    }), 2);
  } finally {
    await harness.close();
  }
});
