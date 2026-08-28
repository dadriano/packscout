import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  type PackScoutBuybackEvPublicReasonCodeV1,
  type PublicRepackDetailV3,
} from "@packscout/contracts";
import {
  BuybackEvRevisionRepository,
  PipelineSetupRepository,
  ProviderSourceLifecycleRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { BuybackAdjustedEvRecomputationProcessor } from "./buyback-adjusted-ev-recomputation-processor.ts";
import type { BuybackAdjustedEvRecomputationPort } from "./buyback-adjusted-ev-recomputation-processor.ts";
import { PackScoutBuybackAdjustedEvRecomputationService } from "./buyback-adjusted-ev-recomputation-service.ts";
import { DataReleaseV3ReleaseAssembler } from "./buyback-adjusted-ev-release-assembler.ts";
import {
  DataReleaseV3PublisherError,
  DataReleaseV3ReleasePublisher,
} from "./buyback-adjusted-ev-release-publisher.ts";
import type { DataReleaseV3PublishPlan } from "./buyback-adjusted-ev-release-types.ts";
import {
  InMemoryDataReleaseV3Port,
  buildReleaseProduct,
  buildReleaseSnapshot,
} from "./buyback-adjusted-ev-release.test-support.ts";
import { InMemoryBuybackEvRecomputationQueue } from "./buyback-adjusted-ev-recomputation.test-support.ts";
import { PackScoutBuybackEvRevisionStore } from "./buyback-adjusted-ev-revision-store.ts";
import {
  OPERATIONS_PLATFORM_KEY,
  operationsCommand,
  operationsEvidence,
  type OperationsEvidenceDraftInput,
} from "./buyback-adjusted-ev-operations.test-support.ts";
import type { PackScoutBuybackEvRecomputationCommandV1 } from "./buyback-adjusted-ev-recomputation-contracts.ts";

/**
 * Task-012 failure and recovery drills, DB-backed through the real
 * recomputation boundary: every deterministic evidence-failure class fails
 * closed into its bounded public reason, expiry removes an estimate from the
 * release without zeroing it or mutating immutable history, an interrupted
 * publication leaves the last coherent release active and converges on retry
 * under the same identity, a malformed projection blocks assembly, and full
 * replay never rewrites completed revisions.
 */

const ids = {
  organization: "85000000-0000-4000-8000-000000000001",
  provider: "85000000-0000-4000-8000-000000000002",
} as const;

const OBSERVED_AT = "2026-08-18T01:00:00.000Z";
const CALCULATED_AT = "2026-08-18T01:05:00.000Z";
const STALE_OBSERVED_AT = "2026-08-18T00:01:00.000Z";
const DRILL_OBSERVED_AT = "2026-08-18T01:20:00.000Z";
const DRILL_CALCULATED_AT = "2026-08-18T01:25:00.000Z";
const READ_FRESH = "2026-08-18T01:30:00.000Z";
const READ_EXPIRED = "2026-08-18T02:30:00.000Z";
const READ_BLOCKED = "2026-08-18T02:45:00.000Z";

interface DrillCase {
  readonly productKey: string;
  readonly expectedReason: PackScoutBuybackEvPublicReasonCodeV1;
  readonly draft: Omit<OperationsEvidenceDraftInput, "productKey" | "sourceRevisionId">;
}

const DRILLS: readonly DrillCase[] = [
  {
    productKey: "drill-partial-evidence",
    expectedReason: "ODDS_UNAVAILABLE",
    draft: {
      observedAt: DRILL_OBSERVED_AT,
      odds: {
        poolKind: "finite",
        currentPool: {
          completeness: "complete",
          snapshotAtomicity: "atomic",
          countsStability: "stable",
          remainingUnits: [{ outcomeKey: "common-hit", units: 3 }],
        },
        published: null,
      },
    },
  },
  {
    productKey: "drill-source-conflict",
    expectedReason: "ODDS_UNAVAILABLE",
    draft: {
      observedAt: DRILL_OBSERVED_AT,
      odds: {
        poolKind: "finite",
        currentPool: {
          completeness: "complete",
          snapshotAtomicity: "atomic",
          countsStability: "stable",
          remainingUnits: [
            { outcomeKey: "common-hit", units: 3 },
            { outcomeKey: "rare-hit", units: 1 },
          ],
        },
        published: {
          entries: [
            {
              outcomeKey: "common-hit",
              probability: { numerator: 1, denominator: 2 },
            },
            {
              outcomeKey: "rare-hit",
              probability: { numerator: 1, denominator: 2 },
            },
          ],
          revisionAgreement: "same_source_revision",
          documentedRoundingPrecisionPartsPerMillion: 0,
        },
      },
    },
  },
  {
    productKey: "drill-stale-data",
    expectedReason: "SOURCE_DATA_STALE",
    draft: { observedAt: STALE_OBSERVED_AT },
  },
  {
    productKey: "drill-invalid-price",
    expectedReason: "PRICE_UNAVAILABLE",
    draft: { observedAt: DRILL_OBSERVED_AT, priceMinorUnits: -1 },
  },
  {
    productKey: "drill-unsupported-currency",
    expectedReason: "CURRENCY_UNSUPPORTED",
    draft: { observedAt: DRILL_OBSERVED_AT, priceCurrency: "EUR" },
  },
  {
    productKey: "drill-ambiguous-draws",
    expectedReason: "SOURCE_EVIDENCE_UNAVAILABLE",
    draft: { observedAt: DRILL_OBSERVED_AT, unitBasis: { kind: "ambiguous" } },
  },
  {
    productKey: "drill-overflow",
    expectedReason: "CALCULATION_UNAVAILABLE",
    draft: {
      observedAt: DRILL_OBSERVED_AT,
      statedValues: [
        {
          outcomeKey: "rare-hit",
          amount: {
            minorUnits: 1_000_000_000_000_000,
            currency: "USD",
            precision: 2,
          },
        },
      ],
    },
  },
];

const AVAILABLE_PRODUCT_KEY = "drill-available";

function repackIdFor(index: number): string {
  return `85555555-5555-5555-8555-${String(index + 1).padStart(12, "0")}`;
}

test("failure, expiry, interruption, malformed-projection, and replay drills fail closed and preserve coherent releases", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createOrganization({
      id: ids.organization,
      slug: "buyback-ev-drills",
      name: "Buyback EV Drills",
    });
    await setup.createProviderSource({
      id: ids.provider,
      organizationId: ids.organization,
      platformKey: OPERATIONS_PLATFORM_KEY,
      displayName: "Vendor",
    });
    const lifecycle = new ProviderSourceLifecycleRepository(harness.database);
    const createdAt = new Date("2026-08-18T00:00:00.000Z");
    const connection = await lifecycle.createConnectionProfileRevision({
      organizationId: ids.organization,
      sourceTypeKey: "synthetic-events-v1",
      connectionTypeKey: "synthetic-events-connection-v1",
      displayName: "Synthetic source",
      requestLimit: 1,
      sourceAdapterVersion: "synthetic-events-adapter-v1",
      revisionNumber: 1,
      configurationCiphertext: new Uint8Array(32).fill(1),
      configurationNonce: new Uint8Array(12).fill(2),
      configurationAuthTag: new Uint8Array(16).fill(3),
      encryptionKeyVersion: 1,
      configurationFingerprint: "a".repeat(64),
      actorKey: "actor:test",
      createdAt,
    });
    const source = await lifecycle.createSourceInstanceRevision({
      organizationId: ids.organization,
      providerId: ids.provider,
      connectionProfileId: connection.profileId,
      sourceTypeKey: "synthetic-events-v1",
      sourceAdapterVersion: "synthetic-events-adapter-v1",
      normalizedContractVersion: "packscout.provider-observation.v1",
      mapperKey: "synthetic-catalog-v1",
      mapperVersion: "1",
      identityNamespaceKey: "synthetic-drills-v1",
      cursorCodecVersion: "synthetic-cursor-v1",
      revisionNumber: 1,
      intervalSeconds: 300,
      configuration: { fixture: "failure-drills" },
      configurationHash: "b".repeat(64),
      recordIdScopes: ["catalog-pack-v1"],
      actorKey: "actor:test",
      createdAt,
    });
    const store = new PackScoutBuybackEvRevisionStore(
      new BuybackEvRevisionRepository(harness.database),
    );
    const service = new PackScoutBuybackAdjustedEvRecomputationService(store);
    const delivered: PackScoutBuybackEvRecomputationCommandV1[] = [];
    const deliver = async (
      command: PackScoutBuybackEvRecomputationCommandV1,
    ) => {
      delivered.push(command);
      return service.recompute(command);
    };

    // Phase A — every deterministic evidence-failure class fails closed into
    // exactly its bounded public reason through the real boundary.
    for (const drill of DRILLS) {
      const outcome = await deliver(
        operationsCommand({
          organizationId: ids.organization,
          providerId: ids.provider,
          providerSourceRevisionId: source.sourceRevisionId,
          evidence: operationsEvidence({
            productKey: drill.productKey,
            sourceRevisionId: `${drill.productKey}-rev-1`,
            ...drill.draft,
          }),
          calculatedAt: DRILL_CALCULATED_AT,
        }),
      );
      assert.equal(outcome.outcome, "created", drill.productKey);
      if (outcome.outcome !== "created") continue;
      assert.equal(outcome.status.availability, "UNAVAILABLE", drill.productKey);
      assert.equal(
        outcome.status.publicReason,
        drill.expectedReason,
        drill.productKey,
      );
    }
    const availableOutcome = await deliver(
      operationsCommand({
        organizationId: ids.organization,
        providerId: ids.provider,
        providerSourceRevisionId: source.sourceRevisionId,
        evidence: operationsEvidence({
          productKey: AVAILABLE_PRODUCT_KEY,
          sourceRevisionId: `${AVAILABLE_PRODUCT_KEY}-rev-1`,
          observedAt: OBSERVED_AT,
        }),
        calculatedAt: CALCULATED_AT,
      }),
    );
    assert.equal(availableOutcome.outcome, "created");
    assert.equal(
      await harness.database.buyback_ev_revisions.count(),
      DRILLS.length + 1,
    );

    // Phase B — one coherent release publishes every repack: the catalog
    // stays available while each failed estimate carries its public reason.
    const productKeys = [
      AVAILABLE_PRODUCT_KEY,
      ...DRILLS.map(({ productKey }) => productKey),
    ];
    const snapshot = buildReleaseSnapshot(
      productKeys.map((productKey, index) =>
        buildReleaseProduct({
          publicRepackId: repackIdFor(index),
          platformKey: OPERATIONS_PLATFORM_KEY,
          productKey,
          sourceUpdatedAt: OBSERVED_AT,
          topChase: null,
        }),
      ),
      { organizationId: ids.organization, chases: [] },
    );
    const catalog = { loadCatalogSnapshot: async () => snapshot };
    const assembler = new DataReleaseV3ReleaseAssembler(catalog, service);
    const port = new InMemoryDataReleaseV3Port();
    const publisher = new DataReleaseV3ReleasePublisher(port);
    const freshPlan = await assembler.assemble({ readAt: READ_FRESH });
    assert.equal(freshPlan.classification, "publish");
    if (freshPlan.classification !== "publish") return;
    const detailsOf = (plan: DataReleaseV3PublishPlan) =>
      plan.batches
        .filter((batch) => batch.kind === "repacks")
        .flatMap((batch) => batch.records as readonly PublicRepackDetailV3[]);
    const freshDetails = detailsOf(freshPlan);
    assert.equal(freshDetails.length, productKeys.length);
    const freshByKey = new Map(
      snapshot.products.map((product) => [
        product.publicRepackId,
        product.productKey,
      ]),
    );
    for (const detail of freshDetails) {
      const productKey = freshByKey.get(detail.publicRepackId);
      const packScout = detail.evEstimates.packScout;
      assert.equal(packScout.methodVersion, PACKSCOUT_BUYBACK_EV_METHOD_VERSION);
      if (productKey === AVAILABLE_PRODUCT_KEY) {
        assert.equal(packScout.status, "current");
      } else {
        const drill = DRILLS.find((entry) => entry.productKey === productKey)!;
        assert.equal(packScout.status, "unavailable", productKey);
        if (packScout.status === "unavailable") {
          assert.equal(packScout.reason, drill.expectedReason, productKey);
          assert.equal(packScout.metrics, null, productKey);
        }
      }
    }
    const activatedFresh = await publisher.publish(freshPlan);
    assert.equal(activatedFresh.outcome, "activated");
    assert.equal(
      port.state.activeRelease?.publicReleaseId,
      freshPlan.publicReleaseId,
    );

    // Phase C — a transient recomputation failure retries durably and
    // converges without new history.
    const queue = new InMemoryBuybackEvRecomputationQueue();
    queue.enqueue(
      operationsCommand({
        organizationId: ids.organization,
        providerId: ids.provider,
        providerSourceRevisionId: source.sourceRevisionId,
        evidence: operationsEvidence({
          productKey: AVAILABLE_PRODUCT_KEY,
          sourceRevisionId: `${AVAILABLE_PRODUCT_KEY}-rev-1`,
          observedAt: OBSERVED_AT,
        }),
        calculatedAt: CALCULATED_AT,
      }),
      READ_FRESH,
    );
    let attempts = 0;
    const flaky: BuybackAdjustedEvRecomputationPort = {
      recompute: async (work) => {
        attempts += 1;
        if (attempts === 1) throw { code: "TRANSIENT_RECOMPUTATION_FAILURE" };
        return service.recompute(work);
      },
    };
    let processorNow = new Date("2026-08-18T01:31:00.000Z");
    const processor = new BuybackAdjustedEvRecomputationProcessor(
      queue,
      flaky,
      { now: () => new Date(processorNow) },
      {
        workerId: "drill-worker",
        maximumRequestsPerCycle: 5,
        leaseMilliseconds: 1_000,
        retryDelayMilliseconds: 1_000,
        maximumAttempts: 3,
      },
    );
    assert.equal((await processor.runCycle()).retrying, 1);
    processorNow = new Date("2026-08-18T01:31:02.000Z");
    const retried = await processor.runCycle();
    assert.deepEqual(
      { completed: retried.completed, unchanged: retried.unchanged },
      { completed: 1, unchanged: 1 },
    );
    const retriedRequest = queue.requests.at(-1);
    assert.equal(retriedRequest?.state, "completed");
    assert.equal(retriedRequest?.attemptCount, 2);
    assert.equal(
      await harness.database.buyback_ev_revisions.count(),
      DRILLS.length + 1,
    );

    // Phase D — expiry removes the estimate from the release without zeroing
    // it and without mutating the immutable revision.
    const availableRowBefore =
      await harness.database.buyback_ev_revisions.findFirstOrThrow({
        where: { product_key: AVAILABLE_PRODUCT_KEY },
      });
    const expiredPlan = await assembler.assemble({ readAt: READ_EXPIRED });
    assert.equal(expiredPlan.classification, "publish");
    if (expiredPlan.classification !== "publish") return;
    const expiredDetail = detailsOf(expiredPlan).find(
      (detail) => freshByKey.get(detail.publicRepackId) === AVAILABLE_PRODUCT_KEY,
    )!;
    const expiredPackScout = expiredDetail.evEstimates.packScout;
    assert.equal(expiredPackScout.status, "unavailable");
    if (expiredPackScout.status === "unavailable") {
      assert.equal(expiredPackScout.reason, "SOURCE_DATA_STALE");
      assert.equal(expiredPackScout.metrics, null);
      assert.deepEqual(expiredPackScout.dataAsOf, {
        state: "known",
        observedAt: OBSERVED_AT,
      });
    }
    const availableRowAfter =
      await harness.database.buyback_ev_revisions.findFirstOrThrow({
        where: { product_key: AVAILABLE_PRODUCT_KEY },
      });
    assert.deepEqual(availableRowAfter, availableRowBefore);
    assert.equal(availableRowAfter.status, "available");
    assert.notEqual(availableRowAfter.gross_ev_minor_units, null);
    assert.notEqual(availableRowAfter.gross_ev_minor_units, 0n);

    // Phase E — an interrupted publication leaves the last coherent release
    // active; the retry converges on the identical release identity.
    port.failNextApplyBatch = true;
    await assert.rejects(
      publisher.publish(expiredPlan),
      (error: unknown) =>
        error instanceof DataReleaseV3PublisherError &&
        error.stage === "apply_batch",
    );
    assert.equal(
      port.state.activeRelease?.publicReleaseId,
      freshPlan.publicReleaseId,
      "the last coherent release stays active through the interruption",
    );
    const freshStatus = await port.status(freshPlan.publicReleaseId);
    assert.equal(freshStatus?.lifecycle, "complete");
    const retriedPublish = await publisher.publish(expiredPlan);
    assert.equal(retriedPublish.outcome, "activated");
    assert.equal(retriedPublish.publicReleaseId, expiredPlan.publicReleaseId);
    assert.equal(
      retriedPublish.outcome === "activated"
        ? retriedPublish.previousPublicReleaseId
        : null,
      freshPlan.publicReleaseId,
    );

    // Phase F — a malformed release projection blocks assembly while the
    // active release stays readable.
    const corrupted = {
      loadCatalogSnapshot: async () => ({
        ...snapshot,
        products: snapshot.products.map((product, index) =>
          index === 0 ? { ...product, name: "" } : product,
        ),
      }),
    };
    const blockedPlan = await new DataReleaseV3ReleaseAssembler(
      corrupted,
      service,
    ).assemble({ readAt: READ_BLOCKED });
    assert.equal(blockedPlan.classification, "blocked");
    if (blockedPlan.classification === "blocked") {
      assert.equal(blockedPlan.reason, "PUBLIC_CONTRACT_INVALID");
    }
    assert.equal(
      port.state.activeRelease?.publicReleaseId,
      expiredPlan.publicReleaseId,
    );

    // Phase G — replaying every delivered command never rewrites history.
    const rowsBefore = await harness.database.buyback_ev_revisions.findMany({
      orderBy: [{ product_key: "asc" }, { revision_number: "asc" }],
    });
    const replay = await service.reprocess(delivered);
    assert.equal(replay.tally.created, 0);
    assert.equal(replay.tally.rejected, 0);
    assert.equal(replay.tally.unbindable, 0);
    assert.equal(
      replay.tally.unchanged + replay.tally.superseded,
      delivered.length,
    );
    assert.deepEqual(
      await harness.database.buyback_ev_revisions.findMany({
        orderBy: [{ product_key: "asc" }, { revision_number: "asc" }],
      }),
      rowsBefore,
    );
  } finally {
    await harness.close();
  }
});
