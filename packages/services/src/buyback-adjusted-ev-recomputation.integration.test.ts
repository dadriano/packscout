import assert from "node:assert/strict";
import { test } from "node:test";
import type { PackScoutBuybackEvEvidenceOutcomeV1 } from "@packscout/contracts";
import {
  BuybackEvRevisionRepository,
  PipelineSetupRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import {
  finalizePackScoutBuybackEvEvidenceV1,
  type PackScoutBuybackEvEvidenceDraftV1,
} from "./providers/buyback-ev-evidence.ts";
import {
  BuybackAdjustedEvRecomputationProcessor,
  type BuybackAdjustedEvRecomputationPort,
} from "./buyback-adjusted-ev-recomputation-processor.ts";
import { PackScoutBuybackAdjustedEvRecomputationService } from "./buyback-adjusted-ev-recomputation-service.ts";
import type { PackScoutBuybackEvRecomputationCommandV1 } from "./buyback-adjusted-ev-recomputation-contracts.ts";
import { InMemoryBuybackEvRecomputationQueue } from "./buyback-adjusted-ev-recomputation.test-support.ts";
import { PackScoutBuybackEvRevisionStore } from "./buyback-adjusted-ev-revision-store.ts";

const ids = {
  organization: "42000000-0000-4000-8000-000000000001",
  provider: "42000000-0000-4000-8000-000000000002",
  configuration: "42000000-0000-4000-8000-000000000003",
} as const;

const PLATFORM_KEY = "courtyard";
const PRODUCT_KEY = "courtyard-ironman-repack";

function draft(input: {
  readonly sourceRevisionId: string;
  readonly observedAt: string;
  readonly priceMinorUnits?: number;
  readonly remainingUnits?: readonly {
    readonly outcomeKey: string;
    readonly units: number;
  }[];
  readonly buybackDocumented?: boolean;
}): PackScoutBuybackEvEvidenceDraftV1 {
  return {
    observation: {
      providerKey: PLATFORM_KEY,
      sourceRevisionId: input.sourceRevisionId,
      sourceManifestSha256: null,
      observedAt: input.observedAt,
      coherence: { kind: "provider_revision" },
    },
    product: {
      productKey: PRODUCT_KEY,
      productRevisionId: "product-revision-42",
    },
    packPrice: {
      minorUnits: input.priceMinorUnits ?? 10_000,
      currency: "USD",
      precision: 2,
    },
    unitBasis: { kind: "per_pack" },
    odds: {
      poolKind: "finite",
      currentPool: {
        completeness: "complete",
        snapshotAtomicity: "atomic",
        countsStability: "stable",
        remainingUnits: input.remainingUnits ?? [
          { outcomeKey: "common-hit", units: 3 },
          { outcomeKey: "rare-hit", units: 1 },
        ],
      },
      published: null,
    },
    uniformBuybackRate:
      (input.buybackDocumented ?? true)
        ? {
          kind: "documented",
          scope: "every_eligible_outcome",
          terms: {
            rateBasisPoints: 8_500,
            percentageFeeBasisPoints: 0,
            fixedFee: null,
            floor: null,
            cap: null,
          },
        }
        : { kind: "none_documented" },
    outcomes: [
      {
        outcomeKey: "common-hit",
        representation: { kind: "atomic_outcome" },
        valueBasis: "stated_collectible_value",
        statedValue: {
          kind: "exact",
          amount: { minorUnits: 5_000, currency: "USD", precision: 2 },
        },
        buyback: { kind: "defer_to_product_terms" },
      },
      {
        outcomeKey: "rare-hit",
        representation: { kind: "atomic_outcome" },
        valueBasis: "stated_collectible_value",
        statedValue: {
          kind: "exact",
          amount: { minorUnits: 30_000, currency: "USD", precision: 2 },
        },
        buyback: { kind: "defer_to_product_terms" },
      },
    ],
  };
}

function normalizedEvidence(
  parameters: Parameters<typeof draft>[0],
): PackScoutBuybackEvEvidenceOutcomeV1 {
  return finalizePackScoutBuybackEvEvidenceV1(draft(parameters), {
    evaluatedAt: new Date(
      Date.parse(parameters.observedAt) + 30_000,
    ).toISOString(),
    stablecoinParityApprovals: [],
  });
}

function command(
  evidence: PackScoutBuybackEvEvidenceOutcomeV1,
  calculatedAt: string,
): PackScoutBuybackEvRecomputationCommandV1 {
  return {
    organizationId: ids.organization,
    providerId: ids.provider,
    configurationRevisionId: ids.configuration,
    evidence,
    calculatedAt,
  };
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

async function setupHarness() {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  await setup.createOrganization({
    id: ids.organization,
    slug: "buyback-ev-recompute",
    name: "Buyback EV Recompute",
  });
  await setup.createProviderSource({
    id: ids.provider,
    organizationId: ids.organization,
    platformKey: PLATFORM_KEY,
    displayName: "Courtyard",
  });
  await setup.createConfigRevision({
    id: ids.configuration,
    organizationId: ids.organization,
    providerId: ids.provider,
    version: 1,
    adapterKey: "synthetic-mapper-v1",
    endpointUrl: "https://provider.example/feed",
    authMode: "none",
    createdByActorKey: "actor:test",
  });
  const store = new PackScoutBuybackEvRevisionStore(
    new BuybackEvRevisionRepository(harness.database),
  );
  const service = new PackScoutBuybackAdjustedEvRecomputationService(store);
  const queue = new InMemoryBuybackEvRecomputationQueue();
  return { ...harness, store, service, queue };
}

function processorFor(
  harness: Awaited<ReturnType<typeof setupHarness>>,
  clock: ReturnType<typeof mutableClock>["clock"],
  recomputations: BuybackAdjustedEvRecomputationPort = harness.service,
) {
  return new BuybackAdjustedEvRecomputationProcessor(
    harness.queue,
    recomputations,
    clock,
    {
      workerId: "buyback-ev-worker-1",
      maximumRequestsPerCycle: 25,
      leaseMilliseconds: 1_000,
      retryDelayMilliseconds: 1_000,
      maximumAttempts: 3,
    },
  );
}

test("recomputation converges evidence changes into immutable revisions with deterministic ordering, staleness, and publication reads", async () => {
  const harness = await setupHarness();
  const time = mutableClock("2026-08-19T18:06:00.000Z");
  const deliveredCommands: PackScoutBuybackEvRecomputationCommandV1[] = [];
  const enqueue = (
    work: PackScoutBuybackEvRecomputationCommandV1,
    scheduledAt: string,
  ) => {
    deliveredCommands.push(work);
    harness.queue.enqueue(work, scheduledAt);
  };
  const revisionCount = () => harness.database.buyback_ev_revisions.count();
  try {
    // Initial complete evidence becomes one available revision.
    const initialEvidence = normalizedEvidence({
      sourceRevisionId: "catalog-revision-100",
      observedAt: "2026-08-19T18:00:00.000Z",
    });
    assert.equal(initialEvidence.status, "complete");
    enqueue(
      command(initialEvidence, "2026-08-19T18:05:00.000Z"),
      "2026-08-19T18:05:00.000Z",
    );
    const first = await processorFor(harness, time.clock).runCycle();
    assert.deepEqual(
      { completed: first.completed, created: first.created },
      { completed: 1, created: 1 },
    );
    assert.equal(await revisionCount(), 1);
    const initialRow = await harness.database.buyback_ev_revisions.findFirstOrThrow();
    assert.equal(initialRow.status, "available");
    assert.equal(initialRow.gross_ev_minor_units, 9_563n);

    // Same evidence re-delivered — with the same clock and with a later
    // freshness-boundary clock — replays unchanged without new history.
    enqueue(
      command(initialEvidence, "2026-08-19T18:05:00.000Z"),
      "2026-08-19T18:06:00.000Z",
    );
    enqueue(
      command(initialEvidence, "2026-08-19T18:35:00.000Z"),
      "2026-08-19T18:06:00.000Z",
    );
    const replays = await processorFor(harness, time.clock).runCycle();
    assert.deepEqual(
      { completed: replays.completed, unchanged: replays.unchanged },
      { completed: 2, unchanged: 2 },
    );
    assert.equal(await revisionCount(), 1);

    // A public price change is a governing change: a new revision.
    const repriced = normalizedEvidence({
      sourceRevisionId: "catalog-revision-200",
      observedAt: "2026-08-19T18:10:00.000Z",
      priceMinorUnits: 12_000,
    });
    enqueue(
      command(repriced, "2026-08-19T18:11:00.000Z"),
      "2026-08-19T18:11:00.000Z",
    );
    time.set("2026-08-19T18:12:00.000Z");
    assert.equal((await processorFor(harness, time.clock).runCycle()).created, 1);
    assert.equal(await revisionCount(), 2);

    // The original observation arriving late is superseded by source order.
    enqueue(
      command(initialEvidence, "2026-08-19T18:13:00.000Z"),
      "2026-08-19T18:13:00.000Z",
    );
    const late = await processorFor(harness, time.clock).runCycle();
    assert.deepEqual(
      { completed: late.completed, superseded: late.superseded },
      { completed: 1, superseded: 1 },
    );
    assert.equal(await revisionCount(), 2);

    // Newly missing buyback terms become a deterministic unavailable result.
    const missingBuyback = normalizedEvidence({
      sourceRevisionId: "catalog-revision-300",
      observedAt: "2026-08-19T18:20:00.000Z",
      buybackDocumented: false,
    });
    assert.equal(missingBuyback.status, "unavailable");
    enqueue(
      command(missingBuyback, "2026-08-19T18:21:00.000Z"),
      "2026-08-19T18:21:00.000Z",
    );
    time.set("2026-08-19T18:22:00.000Z");
    const missing = await processorFor(harness, time.clock).runCycle();
    assert.deepEqual(
      { created: missing.created, unavailable: missing.unavailable },
      { created: 1, unavailable: 1 },
    );
    assert.equal(await revisionCount(), 3);
    const unavailableRow = await harness.database.buyback_ev_revisions.findFirstOrThrow({
      orderBy: { revision_number: "desc" },
    });
    assert.equal(unavailableRow.status, "unavailable");
    assert.deepEqual(unavailableRow.internal_reasons, ["MISSING_BUYBACK"]);
    assert.equal(unavailableRow.public_primary_reason, "BUYBACK_UNAVAILABLE");
    assert.equal(unavailableRow.gross_ev_minor_units, null);

    // Newly complete evidence turns the estimate available again.
    const restored = normalizedEvidence({
      sourceRevisionId: "catalog-revision-400",
      observedAt: "2026-08-19T18:30:00.000Z",
    });
    enqueue(
      command(restored, "2026-08-19T18:31:00.000Z"),
      "2026-08-19T18:31:00.000Z",
    );
    time.set("2026-08-19T18:32:00.000Z");
    assert.equal((await processorFor(harness, time.clock).runCycle()).created, 1);
    assert.equal(await revisionCount(), 4);
    const availableAgain = await harness.service.getPublicationEligibleRevision({
      organizationId: ids.organization,
      platformKey: PLATFORM_KEY,
      productKey: PRODUCT_KEY,
      readAt: "2026-08-19T18:32:00.000Z",
    });
    assert.deepEqual(availableAgain?.readState, {
      state: "publishable",
      availability: "AVAILABLE",
    });

    // Stale transition as resolved: a freshness sweep under a later clock
    // replays unchanged and never mutates the immutable prior revision; the
    // 60-minute boundary is derived at the publication read.
    enqueue(
      command(restored, "2026-08-19T19:45:00.000Z"),
      "2026-08-19T19:45:00.000Z",
    );
    time.set("2026-08-19T19:45:30.000Z");
    const sweep = await processorFor(harness, time.clock).runCycle();
    assert.deepEqual(
      { completed: sweep.completed, unchanged: sweep.unchanged },
      { completed: 1, unchanged: 1 },
    );
    assert.equal(await revisionCount(), 4);
    const expiredRead = await harness.service.getPublicationEligibleRevision({
      organizationId: ids.organization,
      platformKey: PLATFORM_KEY,
      productKey: PRODUCT_KEY,
      readAt: "2026-08-19T19:45:00.000Z",
    });
    assert.deepEqual(expiredRead?.readState, {
      state: "expired_since_calculation",
      staleSince: "2026-08-19T19:30:00.000Z",
    });
    assert.equal(
      expiredRead?.revision.revisionId,
      availableAgain?.revision.revisionId,
    );

    // A newly observed but already stale observation mints the stored
    // STALE_EVIDENCE revision, keyed by what changed: the observation.
    const staleObservation = normalizedEvidence({
      sourceRevisionId: "catalog-revision-500",
      observedAt: "2026-08-19T18:40:00.000Z",
    });
    enqueue(
      command(staleObservation, "2026-08-19T19:50:00.000Z"),
      "2026-08-19T19:50:00.000Z",
    );
    time.set("2026-08-19T19:50:30.000Z");
    const stale = await processorFor(harness, time.clock).runCycle();
    assert.deepEqual(
      { created: stale.created, unavailable: stale.unavailable },
      { created: 1, unavailable: 1 },
    );
    assert.equal(await revisionCount(), 5);
    const staleRow = await harness.database.buyback_ev_revisions.findFirstOrThrow({
      orderBy: { revision_number: "desc" },
    });
    assert.deepEqual(staleRow.internal_reasons, ["STALE_EVIDENCE"]);
    assert.equal(staleRow.freshness_state, "expired");
    assert.equal(staleRow.public_primary_reason, "SOURCE_DATA_STALE");
    const staleRead = await harness.service.getPublicationEligibleRevision({
      organizationId: ids.organization,
      platformKey: PLATFORM_KEY,
      productKey: PRODUCT_KEY,
      readAt: "2026-08-19T19:51:00.000Z",
    });
    assert.deepEqual(staleRead?.readState, {
      state: "publishable",
      availability: "UNAVAILABLE",
    });
    assert.equal(staleRead?.revision.revisionId, staleRow.id);

    // Failed work retries durably without duplicate revisions.
    const recovered = normalizedEvidence({
      sourceRevisionId: "catalog-revision-600",
      observedAt: "2026-08-19T19:55:00.000Z",
    });
    enqueue(
      command(recovered, "2026-08-19T19:56:00.000Z"),
      "2026-08-19T19:56:00.000Z",
    );
    time.set("2026-08-19T19:56:30.000Z");
    let calls = 0;
    const transientThenReal: BuybackAdjustedEvRecomputationPort = {
      recompute: async (work) => {
        calls += 1;
        if (calls === 1) throw { code: "TRANSIENT_RECOMPUTATION_FAILURE" };
        return harness.service.recompute(work);
      },
    };
    const flaky = processorFor(harness, time.clock, transientThenReal);
    assert.equal((await flaky.runCycle()).retrying, 1);
    assert.equal(await revisionCount(), 5);
    time.set("2026-08-19T19:56:32.000Z");
    const retried = await flaky.runCycle();
    assert.deepEqual(
      { completed: retried.completed, created: retried.created },
      { completed: 1, created: 1 },
    );
    assert.equal(await revisionCount(), 6);
    const retriedRequest = harness.queue.requests.at(-1);
    assert.equal(retriedRequest?.state, "completed");
    assert.equal(retriedRequest?.attemptCount, 2);

    // The publication-eligible selection returns the exact completed
    // revision, repeatably, for the next canonical snapshot.
    const eligible = await harness.service.getPublicationEligibleRevision({
      organizationId: ids.organization,
      platformKey: PLATFORM_KEY,
      productKey: PRODUCT_KEY,
      readAt: "2026-08-19T19:57:00.000Z",
    });
    const currentRow = await harness.database.buyback_ev_revisions.findFirstOrThrow({
      orderBy: { revision_number: "desc" },
    });
    assert.equal(eligible?.revision.revisionId, currentRow.id);
    assert.equal(eligible?.revision.revisionNumber, 6);
    assert.deepEqual(eligible?.readState, {
      state: "publishable",
      availability: "AVAILABLE",
    });
    assert.deepEqual(
      eligible,
      await harness.service.getPublicationEligibleRevision({
        organizationId: ids.organization,
        platformKey: PLATFORM_KEY,
        productKey: PRODUCT_KEY,
        readAt: "2026-08-19T19:57:00.000Z",
      }),
    );

    // Recovery: reprocessing every delivered source revision never mutates
    // completed history — replays land as unchanged or superseded only.
    const rowsBefore = await harness.database.buyback_ev_revisions.findMany({
      orderBy: { revision_number: "asc" },
    });
    const recovery = await harness.service.reprocess(deliveredCommands);
    assert.equal(recovery.tally.created, 0);
    assert.equal(recovery.tally.rejected, 0);
    assert.equal(recovery.tally.unbindable, 0);
    assert.equal(
      recovery.tally.unchanged + recovery.tally.superseded,
      deliveredCommands.length,
    );
    assert.deepEqual(
      await harness.database.buyback_ev_revisions.findMany({
        orderBy: { revision_number: "asc" },
      }),
      rowsBefore,
    );
    assert.equal(
      await harness.database.buyback_ev_persistence_failures.count(),
      0,
      "the converging lifecycle never ledgers failures",
    );
  } finally {
    await harness.close();
  }
});
