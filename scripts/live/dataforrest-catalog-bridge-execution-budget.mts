export const CATALOG_BRIDGE_EXECUTION_TIMEOUT_MAXIMUM_MILLISECONDS = 48 * 60 * 60_000;
export const CATALOG_BRIDGE_EXECUTION_TIMEOUT_MINIMUM_MILLISECONDS = 60 * 60_000;

const processingHeadroomBasisPoints = 15_000;
const fixedSettlementHeadroomMilliseconds = 30 * 60_000;
const timeoutRoundingMilliseconds = 15 * 60_000;

export interface CatalogBridgeExecutionBudgetEvidence {
  readonly sourceHeadRecordCount: number;
  readonly adapterPageLimit: number;
  readonly adapterRequestTimeoutMilliseconds: number;
  readonly minimumCatalogPageCount: number;
  readonly sourceRequestCeilingMilliseconds: number;
  readonly processingHeadroomBasisPoints: 15_000;
  readonly fixedSettlementHeadroomMilliseconds: number;
  readonly timeoutRoundingMilliseconds: number;
  readonly executionTimeoutMilliseconds: number;
}

function safeNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Derives a bounded whole-census timeout from reviewed source-head counts and
 * immutable adapter request bounds. The 50% processing allowance covers page
 * translation and atomic persistence; a fixed 30 minutes covers activation,
 * reconciliation, and canonical-evidence reads. This is a refusal ceiling,
 * not an expected duration or retry policy.
 */
export function deriveCatalogBridgeExecutionBudget(input: Readonly<{
  sourceHeadCardCount: number;
  sourceHeadPackCount: number;
  adapterPageLimit: number;
  adapterRequestTimeoutMilliseconds: number;
}>): CatalogBridgeExecutionBudgetEvidence {
  if (!safeNonnegativeInteger(input.sourceHeadCardCount) ||
    !safeNonnegativeInteger(input.sourceHeadPackCount) ||
    !Number.isSafeInteger(input.adapterPageLimit) || input.adapterPageLimit < 1 ||
    !Number.isSafeInteger(input.adapterRequestTimeoutMilliseconds) ||
    input.adapterRequestTimeoutMilliseconds < 1) {
    throw new TypeError("catalog_bridge.execution_budget_input_invalid");
  }
  const sourceHeadRecordCount = input.sourceHeadCardCount + input.sourceHeadPackCount;
  if (!Number.isSafeInteger(sourceHeadRecordCount) || sourceHeadRecordCount < 1) {
    throw new TypeError("catalog_bridge.execution_budget_input_invalid");
  }
  const minimumCatalogPageCount = Math.ceil(sourceHeadRecordCount / input.adapterPageLimit);
  const sourceRequestCeilingMilliseconds = minimumCatalogPageCount *
    input.adapterRequestTimeoutMilliseconds;
  const withProcessing = Math.ceil(sourceRequestCeilingMilliseconds *
    processingHeadroomBasisPoints / 10_000) + fixedSettlementHeadroomMilliseconds;
  const rounded = Math.ceil(withProcessing / timeoutRoundingMilliseconds) *
    timeoutRoundingMilliseconds;
  const executionTimeoutMilliseconds = Math.max(
    CATALOG_BRIDGE_EXECUTION_TIMEOUT_MINIMUM_MILLISECONDS,
    rounded,
  );
  if (!Number.isSafeInteger(sourceRequestCeilingMilliseconds) ||
    !Number.isSafeInteger(executionTimeoutMilliseconds) ||
    executionTimeoutMilliseconds > CATALOG_BRIDGE_EXECUTION_TIMEOUT_MAXIMUM_MILLISECONDS) {
    throw new RangeError("catalog_bridge.execution_budget_exceeds_reviewed_maximum");
  }
  return Object.freeze({ sourceHeadRecordCount, adapterPageLimit: input.adapterPageLimit,
    adapterRequestTimeoutMilliseconds: input.adapterRequestTimeoutMilliseconds,
    minimumCatalogPageCount, sourceRequestCeilingMilliseconds,
    processingHeadroomBasisPoints, fixedSettlementHeadroomMilliseconds,
    timeoutRoundingMilliseconds, executionTimeoutMilliseconds });
}
