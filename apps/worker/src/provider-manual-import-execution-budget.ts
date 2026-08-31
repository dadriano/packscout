export type ProviderImportExecutionMode = "local" | "remote";

/** Runtime budgets, not source request limits or test deadlines. Each remote
 * page remains atomic; its transaction and gateway expire before its lease. */
const budgets = Object.freeze({
  local: Object.freeze({ transactionMilliseconds: 30_000, pageMilliseconds: 55_000,
    gatewayMilliseconds: 60_000, leaseMilliseconds: 300_000 }),
  remote: Object.freeze({ transactionMilliseconds: 480_000, pageMilliseconds: 540_000,
    gatewayMilliseconds: 600_000, leaseMilliseconds: 900_000 }),
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
