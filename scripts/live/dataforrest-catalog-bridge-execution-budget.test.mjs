import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const budget = await tsImport("./dataforrest-catalog-bridge-execution-budget.mts", import.meta.url);

const providers = [
  { providerKey: "collector_crypt", card: 191_383, pack: 69, pageLimit: 100,
    minimumPages: 1_915, timeout: 30_600_000 },
  { providerKey: "courtyard", card: 1_056_550, pack: 100, pageLimit: 100,
    minimumPages: 10_567, timeout: 161_100_000 },
  { providerKey: "phygitals", card: 276_719, pack: 143, pageLimit: 100,
    minimumPages: 2_769, timeout: 44_100_000 },
];

test("catalog execution budgets cover the reviewed full census and remain bounded", () => {
  for (const provider of providers) {
    const evidence = budget.deriveCatalogBridgeExecutionBudget({
      sourceHeadCardCount: provider.card,
      sourceHeadPackCount: provider.pack,
      adapterPageLimit: provider.pageLimit,
      adapterRequestTimeoutMilliseconds: 10_000,
    });
    assert.equal(evidence.minimumCatalogPageCount, provider.minimumPages, provider.providerKey);
    assert.equal(evidence.executionTimeoutMilliseconds, provider.timeout, provider.providerKey);
    assert.equal(evidence.executionTimeoutMilliseconds <=
      budget.CATALOG_BRIDGE_EXECUTION_TIMEOUT_MAXIMUM_MILLISECONDS, true);
    assert.equal(evidence.executionTimeoutMilliseconds >=
      evidence.sourceRequestCeilingMilliseconds + 30 * 60_000, true);
  }
});

test("Courtyard is no longer admitted under the unsafe one-hour ceiling", () => {
  const courtyard = budget.deriveCatalogBridgeExecutionBudget({
    sourceHeadCardCount: 1_056_550,
    sourceHeadPackCount: 100,
    adapterPageLimit: 100,
    adapterRequestTimeoutMilliseconds: 10_000,
  });
  assert.equal(courtyard.minimumCatalogPageCount, 10_567);
  assert.equal(courtyard.executionTimeoutMilliseconds > 60 * 60_000, true);
  assert.equal(courtyard.executionTimeoutMilliseconds, 44 * 60 * 60_000 + 45 * 60_000);
});

test("budget derivation refuses invalid or larger-than-reviewed inputs", () => {
  for (const changed of [
    { sourceHeadCardCount: -1 }, { sourceHeadPackCount: 1.5 },
    { adapterPageLimit: 0 }, { adapterRequestTimeoutMilliseconds: Number.NaN },
  ]) {
    assert.throws(() => budget.deriveCatalogBridgeExecutionBudget({
      sourceHeadCardCount: 10, sourceHeadPackCount: 1, adapterPageLimit: 100,
      adapterRequestTimeoutMilliseconds: 10_000, ...changed,
    }), /execution_budget_input_invalid/u);
  }
  assert.throws(() => budget.deriveCatalogBridgeExecutionBudget({
    sourceHeadCardCount: 5_000_000, sourceHeadPackCount: 1, adapterPageLimit: 100,
    adapterRequestTimeoutMilliseconds: 10_000,
  }), /execution_budget_exceeds_reviewed_maximum/u);
});
