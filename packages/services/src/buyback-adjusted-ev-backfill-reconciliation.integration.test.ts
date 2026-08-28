import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
} from "@packscout/contracts";
import {
  BuybackEvRevisionRepository,
  PrismaDataReleaseV3CanonicalCatalogSource,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import {
  PackScoutBuybackEvBackfillReconciliationRunnerV1,
  type PackScoutBuybackEvBackfillEvidenceSourceV1,
} from "./buyback-adjusted-ev-backfill-reconciliation.ts";
import { PackScoutBuybackAdjustedEvRecomputationService } from "./buyback-adjusted-ev-recomputation-service.ts";
import { DataReleaseV3ReleaseAssembler } from "./buyback-adjusted-ev-release-assembler.ts";
import type {
  DataReleaseV3ActiveState,
  DataReleaseV3CanonicalCatalogPort,
} from "./buyback-adjusted-ev-release-types.ts";
import { InMemoryDataReleaseV3Port } from "./buyback-adjusted-ev-release.test-support.ts";
import { PackScoutBuybackEvRevisionStore } from "./buyback-adjusted-ev-revision-store.ts";
import { DataReleaseV3CanonicalCatalogAdapter } from "./data-release-v3-canonical-catalog-adapter.ts";
import {
  OPERATIONS_PACKS,
  OPERATIONS_TIMELINE,
  operationsCommand,
  operationsEvidence,
  operationsPublicIdentity,
  seedBuybackEvOperationsCatalog,
} from "./buyback-adjusted-ev-operations.test-support.ts";

const ORGANIZATION_ID = "84000000-0000-4000-8000-000000000001";
const FOREIGN_ORGANIZATION_ID = "84000000-0000-4000-8000-000000000002";

test("the backfill classifies every canonical repack, reconciles the staged release without activation, and replays identically", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const identity = operationsPublicIdentity("84");
    const ingestion = await seedBuybackEvOperationsCatalog(harness, {
      organizationId: ORGANIZATION_ID,
      slug: "buyback-ev-backfill",
      identity,
    });
    const store = new PackScoutBuybackEvRevisionStore(
      new BuybackEvRevisionRepository(harness.database),
    );
    const service = new PackScoutBuybackAdjustedEvRecomputationService(store);
    const catalog = new DataReleaseV3CanonicalCatalogAdapter(
      new PrismaDataReleaseV3CanonicalCatalogSource(
        harness.client,
        ORGANIZATION_ID,
      ),
    );
    const assembler = new DataReleaseV3ReleaseAssembler(catalog, service);
    const port = new InMemoryDataReleaseV3Port();

    const commandFor = (productKey: string) => {
      if (productKey === OPERATIONS_PACKS.noEvidence) return null;
      if (productKey === OPERATIONS_PACKS.available) {
        return operationsCommand({
          organizationId: ORGANIZATION_ID,
          ...ingestion,
          evidence: operationsEvidence({
            productKey,
            sourceRevisionId: "catalog-revision-available-1",
            observedAt: OPERATIONS_TIMELINE.activeObservedAt,
          }),
          calculatedAt: OPERATIONS_TIMELINE.calculatedAt,
        });
      }
      if (productKey === OPERATIONS_PACKS.noBuyback) {
        return operationsCommand({
          organizationId: ORGANIZATION_ID,
          ...ingestion,
          evidence: operationsEvidence({
            productKey,
            sourceRevisionId: "catalog-revision-nobuyback-1",
            observedAt: OPERATIONS_TIMELINE.activeObservedAt,
            priceMinorUnits: 20_000,
            buybackDocumented: false,
          }),
          calculatedAt: OPERATIONS_TIMELINE.calculatedAt,
        });
      }
      if (productKey === OPERATIONS_PACKS.staleEvidence) {
        return operationsCommand({
          organizationId: ORGANIZATION_ID,
          ...ingestion,
          evidence: operationsEvidence({
            productKey,
            sourceRevisionId: "catalog-revision-stale-1",
            observedAt: OPERATIONS_TIMELINE.staleObservedAt,
            priceMinorUnits: 15_000,
          }),
          calculatedAt: OPERATIONS_TIMELINE.calculatedAt,
        });
      }
      return operationsCommand({
        organizationId: ORGANIZATION_ID,
        ...ingestion,
        evidence: operationsEvidence({
          productKey,
          sourceRevisionId: "catalog-revision-soldout-1",
          observedAt: OPERATIONS_TIMELINE.soldOutObservedAt,
          priceMinorUnits: 12_000,
        }),
        calculatedAt: OPERATIONS_TIMELINE.soldOutCalculatedAt,
      });
    };
    const evidence: PackScoutBuybackEvBackfillEvidenceSourceV1 = {
      loadCommand: async ({ productKey }) => commandFor(productKey),
    };
    const runner = new PackScoutBuybackEvBackfillReconciliationRunnerV1({
      catalog,
      recomputation: service,
      assembler,
      evidence,
      publication: port,
    });

    const first = await runner.run({ readAt: OPERATIONS_TIMELINE.readAt });
    assert.deepEqual(first.ledger.blockedReasons, []);
    assert.equal(first.classification, "ready");
    const ledger = first.ledger;
    assert.equal(ledger.organizationId, ORGANIZATION_ID);
    assert.deepEqual(
      {
        total: ledger.counts.total,
        available: ledger.counts.recomputedAvailable,
        unavailable: ledger.counts.deterministicUnavailable,
        soldOut: ledger.counts.soldOutHistorical,
      },
      { total: 5, available: 1, unavailable: 3, soldOut: 1 },
    );
    assert.deepEqual(ledger.counts.byPublicReason, {
      BUYBACK_UNAVAILABLE: 1,
      SOURCE_DATA_STALE: 1,
      SOURCE_EVIDENCE_UNAVAILABLE: 1,
    });
    assert.deepEqual(ledger.counts.byConfidenceBand, {
      low: 0,
      medium: 0,
      high: 2,
    });
    assert.deepEqual(ledger.counts.bySourceAge, {
      fresh_within_15_minutes: 3,
      delayed_over_15_through_30_minutes: 0,
      delayed_over_30_through_60_minutes: 0,
      stale_or_expired: 1,
      unknown_source_time: 1,
    });
    assert.deepEqual(ledger.methodVersions, [
      PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    ]);
    assert.deepEqual(ledger.confidencePolicyVersions, [
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    ]);
    assert.deepEqual(ledger.recomputation, {
      created: 4,
      unchanged: 0,
      superseded: 0,
      rejected: 0,
      unbindable: 0,
      skippedNoEvidence: 1,
    });
    // The staged release is complete and reconciled — and never activated.
    assert.equal(ledger.staging?.staged, true);
    assert.equal(ledger.staging?.lifecycle, "complete");
    assert.equal(ledger.staging?.activePointerMoved, false);
    assert.equal(ledger.staging?.priorActivePublicReleaseId, null);
    assert.equal(port.state.activeRelease, null);
    const status = await port.status(ledger.staging!.publicReleaseId);
    assert.equal(status?.lifecycle, "complete");
    assert.equal(status?.acceptedCounts.repacks, 5);
    // Every classified repack carries its exact revision identity.
    const byProduct = new Map(ledger.rows.map((row) => [row.productKey, row]));
    assert.equal(
      byProduct.get(OPERATIONS_PACKS.available)?.classification,
      "recomputed_available",
    );
    assert.equal(
      byProduct.get(OPERATIONS_PACKS.noBuyback)?.publicReason,
      "BUYBACK_UNAVAILABLE",
    );
    assert.equal(
      byProduct.get(OPERATIONS_PACKS.staleEvidence)?.publicReason,
      "SOURCE_DATA_STALE",
    );
    assert.equal(
      byProduct.get(OPERATIONS_PACKS.noEvidence)?.publicReason,
      "SOURCE_EVIDENCE_UNAVAILABLE",
    );
    assert.equal(
      byProduct.get(OPERATIONS_PACKS.noEvidence)?.recomputationOutcome,
      "skipped_no_evidence",
    );
    assert.equal(
      byProduct.get(OPERATIONS_PACKS.soldOut)?.classification,
      "sold_out_historical",
    );
    for (const row of ledger.rows) {
      if (row.productKey === OPERATIONS_PACKS.noEvidence) {
        assert.equal(row.revisionId, null);
      } else {
        assert.notEqual(row.revisionId, null);
        assert.equal(row.methodVersion, PACKSCOUT_BUYBACK_EV_METHOD_VERSION);
      }
    }
    assert.equal(await harness.database.buyback_ev_revisions.count(), 4);

    // Replay: identical classifications, identities, release id, and no new
    // history — recomputation converges to unchanged, staging replays.
    const replay = await runner.run({ readAt: OPERATIONS_TIMELINE.readAt });
    assert.deepEqual(replay.ledger.blockedReasons, []);
    assert.equal(replay.classification, "ready");
    // Classifications, reasons, and revision identities replay byte-equal;
    // only the recomputation outcome legitimately converges to `unchanged`.
    const identityRows = (rows: typeof ledger.rows) =>
      rows.map((row) => ({ ...row, recomputationOutcome: "normalized" }));
    assert.deepEqual(identityRows(replay.ledger.rows), identityRows(ledger.rows));
    assert.ok(
      replay.ledger.rows.every(({ recomputationOutcome }) =>
        ["unchanged", "skipped_no_evidence"].includes(recomputationOutcome),
      ),
    );
    assert.deepEqual(replay.ledger.counts, ledger.counts);
    assert.equal(
      replay.ledger.staging?.publicReleaseId,
      ledger.staging?.publicReleaseId,
    );
    assert.deepEqual(replay.ledger.recomputation, {
      created: 0,
      unchanged: 4,
      superseded: 0,
      rejected: 0,
      unbindable: 0,
      skippedNoEvidence: 1,
    });
    assert.equal(await harness.database.buyback_ev_revisions.count(), 4);
    assert.equal(port.state.activeRelease, null);

    // Drill: evidence scoped to a foreign organization blocks the run.
    const foreignRunner = new PackScoutBuybackEvBackfillReconciliationRunnerV1({
      catalog,
      recomputation: service,
      assembler,
      evidence: {
        loadCommand: async ({ productKey }) => {
          const command = commandFor(productKey);
          if (command === null || productKey !== OPERATIONS_PACKS.available) {
            return command;
          }
          return { ...command, organizationId: FOREIGN_ORGANIZATION_ID };
        },
      },
      publication: port,
    });
    const foreign = await foreignRunner.run({
      readAt: OPERATIONS_TIMELINE.readAt,
    });
    assert.equal(foreign.classification, "blocked");
    assert.ok(
      foreign.ledger.blockedReasons.some(
        ({ code }) => code === "EVIDENCE_SCOPE_VIOLATION",
      ),
    );

    // Drill: a malformed release projection blocks the plan and leaves the
    // previously staged coherent release readable.
    const corruptingCatalog: DataReleaseV3CanonicalCatalogPort = {
      loadCatalogSnapshot: async (query) => {
        const snapshot = await catalog.loadCatalogSnapshot(query);
        return {
          ...snapshot,
          products: snapshot.products.map((product) =>
            product.productKey === OPERATIONS_PACKS.available
              ? { ...product, name: "" }
              : product,
          ),
        };
      },
    };
    const corruptedRunner = new PackScoutBuybackEvBackfillReconciliationRunnerV1({
      catalog: corruptingCatalog,
      recomputation: service,
      assembler: new DataReleaseV3ReleaseAssembler(corruptingCatalog, service),
      evidence,
      publication: port,
    });
    const corrupted = await corruptedRunner.run({
      readAt: OPERATIONS_TIMELINE.readAt,
    });
    assert.equal(corrupted.classification, "blocked");
    assert.ok(
      corrupted.ledger.blockedReasons.some(
        ({ code, detail }) =>
          code === "PLAN_BLOCKED" && detail.includes("PUBLIC_CONTRACT_INVALID"),
      ),
    );
    const stillStaged = await port.status(ledger.staging!.publicReleaseId);
    assert.equal(stillStaged?.lifecycle, "complete");

    // Drill: an active pointer that moves during staging blocks the run.
    let activeStateReads = 0;
    const activatingPort = new Proxy(port, {
      get(target, property, receiver) {
        if (property === "activeState") {
          return async (): Promise<DataReleaseV3ActiveState> => {
            const state = await target.activeState();
            activeStateReads += 1;
            // The first read is the pre-staging snapshot; a concurrent
            // activation lands before the post-staging read-back.
            return activeStateReads > 1
              ? { ...state, generation: state.generation + 1 }
              : state;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const pointerRunner = new PackScoutBuybackEvBackfillReconciliationRunnerV1({
      catalog,
      recomputation: service,
      assembler,
      evidence,
      publication: activatingPort,
    });
    const moved = await pointerRunner.run({ readAt: OPERATIONS_TIMELINE.readAt });
    assert.equal(moved.classification, "blocked");
    assert.ok(
      moved.ledger.blockedReasons.some(
        ({ code }) => code === "ACTIVE_POINTER_MOVED",
      ),
    );
  } finally {
    await harness.close();
  }
});
