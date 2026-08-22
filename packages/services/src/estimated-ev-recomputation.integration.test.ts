import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PrismaEstimatedEvRecomputationRepository,
  PrismaImportRunRepository,
  IngestionPersistenceRepository,
  PipelineSetupRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { CatalogProjectionService } from "./catalog-projection-service.ts";
import { CanonicalEstimatedEvProjectionRepository } from "./estimated-ev-projection-repository.ts";
import { EstimatedEvRecomputationProcessor } from "./estimated-ev-recomputation-processor.ts";
import { PackScoutEstimatedEvService } from "./estimated-ev-service.ts";
import type {
  CanonicalPackCandidate,
  EvInputCandidate,
  ProviderAdapterCandidate,
  ProviderSourceIdentity,
} from "./provider-adapter.ts";

const ids = {
  organization: "48000000-0000-4000-8000-000000000001",
  provider: "48000000-0000-4000-8000-000000000002",
  configuration: "48000000-0000-4000-8000-000000000003",
  run: "48000000-0000-4000-8000-000000000004",
} as const;

const configuration = {
  providerId: ids.provider,
  configurationRevisionId: ids.configuration,
  platform: "synthetic-platform",
  adapterKey: "synthetic-mapper-v1",
};

function source(page: number, sourceTimestamp: string): ProviderSourceIdentity {
  return {
    platform: configuration.platform,
    recordKind: "catalog",
    recordIndex: 0,
    externalId: `catalog-page-${page}`,
    sourceTimestamp,
    collectedAt: new Date(Date.parse(sourceTimestamp) + 10_000).toISOString(),
  };
}

function pack(
  candidateSource: ProviderSourceIdentity,
  price: number,
): CanonicalPackCandidate {
  return {
    candidateKind: "pack",
    source: candidateSource,
    externalId: "pack-1",
    parentExternalId: null,
    name: "Synthetic Pack",
    description: null,
    category: "fixture",
    availability: "available",
    price: { amount: price, currency: "USD" },
    providerReportedEv: null,
    relationships: [],
    dataQualityEvidence: [],
  };
}

function evInput(
  candidateSource: ProviderSourceIdentity,
  options: { currency?: string; rareProbability?: number; complete?: boolean } = {},
): EvInputCandidate {
  const rareProbability = options.rareProbability ?? 0.5;
  const complete = options.complete ?? true;
  return {
    candidateKind: "ev_input",
    source: candidateSource,
    externalId: "pack-1:odds",
    packExternalId: "pack-1",
    currency: options.currency ?? "USD",
    unitBasis: "per_pack",
    drawCount: 1,
    declaredCoverage: complete ? 1 : rareProbability,
    evidenceCompleteness: complete ? "complete" : "partial",
    buckets: complete
      ? [
          {
            bucketId: "common",
            evidenceKind: "probability_bucket",
            probability: 1 - rareProbability,
            lowerValue: 1,
            upperValue: 3,
          },
          {
            bucketId: "rare",
            evidenceKind: "probability_bucket",
            probability: rareProbability,
            lowerValue: 3,
            upperValue: 5,
          },
        ]
      : [
          {
            bucketId: "partial",
            evidenceKind: "probability_bucket",
            probability: rareProbability,
            lowerValue: 1,
            upperValue: 3,
          },
        ],
    relationships: [],
    dataQualityEvidence: [],
  };
}

function projections(
  candidateSource: ProviderSourceIdentity,
  candidates: readonly ProviderAdapterCandidate[],
) {
  const result = new CatalogProjectionService().project({
    configuration,
    source: candidateSource,
    candidates,
  });
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") throw new Error("Expected projections.");
  return result.projections;
}

async function setup() {
  const harness = await createMigratedTestDatabase();
  const setupRepository = new PipelineSetupRepository(harness.database);
  await setupRepository.createOrganization({
    id: ids.organization,
    slug: "ev-queue",
    name: "EV Queue",
  });
  await setupRepository.createProviderSource({
    id: ids.provider,
    organizationId: ids.organization,
    platformKey: configuration.platform,
    displayName: "Synthetic Provider",
  });
  await setupRepository.createConfigRevision({
    id: ids.configuration,
    organizationId: ids.organization,
    providerId: ids.provider,
    version: 1,
    adapterKey: configuration.adapterKey,
    endpointUrl: "https://provider.example/feed",
    authMode: "none",
    createdByActorKey: "actor:test",
  });
  await setupRepository.createImportRun({
    id: ids.run,
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    trigger: "scheduled",
  });
  const persistence = new IngestionPersistenceRepository(harness.database, {
    retentionDays: 90,
    actorPseudonymKey: new Uint8Array(32).fill(4),
  });
  const queue = new PrismaEstimatedEvRecomputationRepository(harness.database);
  const availability: string[] = [];
  const service = new PackScoutEstimatedEvService(
    new CanonicalEstimatedEvProjectionRepository(persistence),
    {
      calculation(input) {
        availability.push(input.availability);
      },
    },
  );
  return { ...harness, persistence, queue, service, availability };
}

async function commit(
  harness: Awaited<ReturnType<typeof setup>>,
  page: number,
  candidateSource: ProviderSourceIdentity,
  candidates: readonly ProviderAdapterCandidate[],
) {
  return harness.persistence.commitPage({
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    runId: ids.run,
    pageNumber: page,
    requestedCursor: page === 1 ? null : `cursor-${page - 1}`,
    nextCursor: `cursor-${page}`,
    hasMore: true,
    payload: { page },
    records: [
      {
        recordKind: "catalog",
        externalId: candidateSource.externalId,
        sourceTime: new Date(candidateSource.sourceTimestamp),
        collectedAt: new Date(candidateSource.collectedAt),
        payload: { page },
        projections: projections(candidateSource, candidates),
      },
    ],
    committedAt: new Date(Date.parse(candidateSource.collectedAt) + 10_000),
  });
}

function mutableClock(initial: string) {
  let now = new Date(initial);
  return {
    clock: { now: () => new Date(now) },
    set(value: string) {
      now = new Date(value);
    },
  };
}

function processor(
  harness: Awaited<ReturnType<typeof setup>>,
  clock: ReturnType<typeof mutableClock>["clock"],
  calculations: ConstructorParameters<
    typeof EstimatedEvRecomputationProcessor
  >[1] = harness.service,
) {
  return new EstimatedEvRecomputationProcessor(
    harness.queue,
    calculations,
    clock,
    {
      workerId: "ev-worker-1",
      maximumRequestsPerCycle: 25,
      leaseMilliseconds: 1_000,
      retryDelayMilliseconds: 1_000,
      maximumAttempts: 3,
    },
  );
}

async function requests(harness: Awaited<ReturnType<typeof setup>>) {
  return harness.database.estimated_ev_recomputation_requests.findMany({
    orderBy: { created_at: "asc" },
  });
}

test("page commits durably coalesce same-page EV work and queue later pack and input revisions", async () => {
  const harness = await setup();
  const time = mutableClock("2026-08-06T10:01:00.000Z");
  try {
    const initial = source(1, "2026-08-06T10:00:00.000Z");
    await commit(harness, 1, initial, [pack(initial, 10), evInput(initial)]);
    assert.equal((await requests(harness)).length, 1);
    const pendingCheckpoint =
      await harness.database.settled_public_watermarks.findUniqueOrThrow({
        where: { organization_id: ids.organization },
      });
    assert.equal(pendingCheckpoint.settled_sequence, 0n);
    assert.ok(pendingCheckpoint.source_head_sequence > 0n);
    const runs = new PrismaImportRunRepository(harness.database);
    assert.equal(
      (
        await runs.claimRun({
          organizationId: ids.organization,
          runId: ids.run,
          workerId: "provider-worker-settlement-test",
          claimedAt: new Date("2026-08-06T10:00:20.000Z"),
          leaseExpiresAt: new Date("2026-08-06T10:02:20.000Z"),
        })
      ).kind,
      "claimed",
    );
    assert.equal(
      (
        await runs.finishRun({
          organizationId: ids.organization,
          runId: ids.run,
          workerId: "provider-worker-settlement-test",
          state: "succeeded",
          reachedProviderHead: true,
          failureCode: null,
          failureSummary: null,
          finishedAt: new Date("2026-08-06T10:00:30.000Z"),
        })
      ).kind,
      "finished",
    );
    assert.equal(
      (
        await harness.database.settled_public_watermarks.findUniqueOrThrow({
          where: { organization_id: ids.organization },
        })
      ).settled_sequence,
      0n,
    );
    const first = await processor(harness, time.clock).runCycle();
    assert.deepEqual(
      { completed: first.completed, estimated: first.estimated },
      { completed: 1, estimated: 1 },
    );
    const estimatedCheckpoint =
      await harness.database.settled_public_watermarks.findUniqueOrThrow({
        where: { organization_id: ids.organization },
      });
    assert.equal(
      estimatedCheckpoint.settled_sequence,
      estimatedCheckpoint.source_head_sequence,
    );
    assert.equal(
      await harness.database.public_derivation_obligations.count({
        where: { organization_id: ids.organization, state: "succeeded" },
      }),
      2,
    );

    const repriced = source(2, "2026-08-06T11:00:00.000Z");
    await commit(harness, 2, repriced, [pack(repriced, 12)]);
    time.set("2026-08-06T11:01:00.000Z");
    assert.equal((await processor(harness, time.clock).runCycle()).estimated, 1);

    const revisedInput = source(3, "2026-08-06T12:00:00.000Z");
    await commit(harness, 3, revisedInput, [
      evInput(revisedInput, { rareProbability: 0.25 }),
    ]);
    time.set("2026-08-06T12:01:00.000Z");
    assert.equal((await processor(harness, time.clock).runCycle()).estimated, 1);
    const replay = await commit(harness, 3, revisedInput, [
      evInput(revisedInput, { rareProbability: 0.25 }),
    ]);
    assert.equal(replay.kind, "already_committed");
    assert.equal((await requests(harness)).length, 3);
    assert.equal(
      (
        await harness.persistence.listCanonicalRevisions(ids.organization, {
          platformKey: configuration.platform,
          recordKind: "estimated_ev",
          externalId: "pack-1",
        })
      ).length,
      3,
    );
    assert.deepEqual(harness.availability, ["LIMITED", "LIMITED", "LIMITED"]);
  } finally {
    await harness.close();
  }
});

test("expired claims are recovered without duplicate calculation history or stale acknowledgements", async () => {
  const harness = await setup();
  try {
    const initial = source(1, "2026-08-06T13:00:00.000Z");
    await commit(harness, 1, initial, [pack(initial, 10), evInput(initial)]);
    const claimedAt = new Date("2026-08-06T13:01:00.000Z");
    const [left, right] = await Promise.all([
      harness.queue.claimBatch({
        workerId: "worker-a",
        now: claimedAt,
        limit: 1,
        leaseMilliseconds: 1_000,
      }),
      harness.queue.claimBatch({
        workerId: "worker-b",
        now: claimedAt,
        limit: 1,
        leaseMilliseconds: 1_000,
      }),
    ]);
    assert.equal(left.length + right.length, 1);
    const crashed = [...left, ...right][0];
    assert.ok(crashed);
    const calculated = await harness.service.recalculate({
      organizationId: crashed.organizationId,
      providerId: crashed.providerId,
      origin: crashed.origin,
      platformKey: crashed.platformKey,
      packExternalId: crashed.packExternalId,
      evInputExternalId: crashed.evInputExternalId,
      calculatedAt: "2026-08-06T13:01:00.000Z",
      currencyPolicy: { verifiedUsdStablecoins: [] },
    });
    assert.equal(calculated.persistenceStatus, "revised");

    const time = mutableClock("2026-08-06T13:01:02.000Z");
    const recovered = await processor(harness, time.clock).runCycle();
    assert.deepEqual(
      { completed: recovered.completed, estimated: recovered.estimated },
      { completed: 1, estimated: 1 },
    );
    assert.equal(
      await harness.queue.complete({
        requestId: crashed.id,
        claimToken: crashed.claimToken,
        completedAt: time.clock.now(),
        resultStatus: "estimated",
        calculationRevisionId: calculated.calculationRevisionId,
      }),
      false,
    );
    const [request] = await requests(harness);
    assert.equal(request?.state, "completed");
    assert.equal(request?.attempt_count, 2);
    assert.equal(
      (
        await harness.persistence.listCanonicalRevisions(ids.organization, {
          platformKey: configuration.platform,
          recordKind: "estimated_ev",
          externalId: "pack-1",
        })
      ).length,
      1,
    );
  } finally {
    await harness.close();
  }
});

test("transient processor failures retry durably and incomplete unsupported inputs complete as unavailable", async () => {
  const harness = await setup();
  const time = mutableClock("2026-08-06T14:01:00.000Z");
  try {
    const initial = source(1, "2026-08-06T14:00:00.000Z");
    await commit(harness, 1, initial, [
      pack(initial, 10),
      evInput(initial, { currency: "EUR", rareProbability: 0.5, complete: false }),
    ]);
    let calls = 0;
    const transientThenReal = {
      recalculate: async (...args: Parameters<typeof harness.service.recalculate>) => {
        calls += 1;
        if (calls === 1) throw { code: "TRANSIENT_CALCULATION_FAILURE" };
        return harness.service.recalculate(...args);
      },
    };
    const worker = processor(harness, time.clock, transientThenReal);
    assert.equal((await worker.runCycle()).retrying, 1);
    assert.equal(
      (
        await harness.database.settled_public_watermarks.findUniqueOrThrow({
          where: { organization_id: ids.organization },
        })
      ).settled_sequence,
      0n,
    );
    let [request] = await requests(harness);
    assert.deepEqual(
      { state: request?.state, attempts: request?.attempt_count, code: request?.failure_code },
      { state: "queued", attempts: 1, code: "TRANSIENT_CALCULATION_FAILURE" },
    );
    time.set("2026-08-06T14:01:02.000Z");
    const second = await worker.runCycle();
    assert.deepEqual(
      { completed: second.completed, unavailable: second.unavailable },
      { completed: 1, unavailable: 1 },
    );
    [request] = await requests(harness);
    assert.deepEqual(
      { state: request?.state, attempts: request?.attempt_count, result: request?.result_status },
      { state: "completed", attempts: 2, result: "unavailable" },
    );
    const explanation = await harness.service.explain({
      organizationId: ids.organization,
      platformKey: configuration.platform,
      packExternalId: "pack-1",
    });
    assert.equal(explanation?.status, "unavailable");
    assert.ok(explanation?.reasonCodes.includes("unsupported_currency"));
    assert.ok(explanation?.reasonCodes.includes("incomplete_probability_coverage"));
    const unavailableObligations =
      await harness.database.public_derivation_obligations.findMany({
        where: {
          organization_id: ids.organization,
          state: "business_unavailable",
        },
      });
    assert.equal(unavailableObligations.length, 2);
    assert.ok(
      unavailableObligations.every(
        ({ outcome_reason_code }) =>
          outcome_reason_code === "unsupported_currency",
      ),
    );
    const unavailableCheckpoint =
      await harness.database.settled_public_watermarks.findUniqueOrThrow({
        where: { organization_id: ids.organization },
      });
    assert.equal(
      unavailableCheckpoint.settled_sequence,
      unavailableCheckpoint.source_head_sequence,
    );
    assert.deepEqual(harness.availability, ["UNAVAILABLE"]);
  } finally {
    await harness.close();
  }
});
