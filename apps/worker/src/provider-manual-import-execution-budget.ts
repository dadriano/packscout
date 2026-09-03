export type ProviderImportExecutionMode = "local" | "remote";

/** Runtime resource budgets, not provider configuration or test deadlines. Each
 * page remains atomic; a request ceiling only lowers the adapter's maximum. */
const budgets = Object.freeze({
  local: Object.freeze({ transactionMilliseconds: 30_000, pageMilliseconds: 55_000,
    gatewayMilliseconds: 60_000, leaseMilliseconds: 300_000, maximumPageRecords: undefined }),
  // 500, not higher: this ceiling is a Math.min against each adapter's own
  // pageLimit, so it only binds collector_crypt (manifest 1,000); courtyard and
  // phygitals stay at their manifest 100. 500 was chosen from measured catalog
  // pages, which are each provider's fattest records - collector_crypt catalog is
  // 4.87 MB / 147,952 nodes at 500 against an 8 MiB / 480,000 budget, while 1,000
  // is 9.48 MB and exceeds the byte ceiling. Catalog is only ~2% of that stream,
  // so a larger value looks safe on pulls and trades and fails on the 2%.
  remote: Object.freeze({ transactionMilliseconds: 480_000, pageMilliseconds: 540_000,
    gatewayMilliseconds: 600_000, leaseMilliseconds: 900_000, maximumPageRecords: 500 }),
});

export function providerManualImportExecutionBudget(mode: ProviderImportExecutionMode = "local") {
  if (mode !== "local" && mode !== "remote") throw new TypeError("Provider import execution mode is invalid.");
  return budgets[mode];
}

export function providerManualImportLeaseMilliseconds(mode: ProviderImportExecutionMode, selected?: number) {
  const budget = providerManualImportExecutionBudget(mode);
  const value = selected ?? budget.leaseMilliseconds;
  if (!Number.isInteger(value) || value < 30_000 || value > 900_000 ||
    (mode === "remote" && value < budget.gatewayMilliseconds + 60_000)) {
    throw new TypeError("Provider import lease duration is invalid.");
  }
  return value;
}
