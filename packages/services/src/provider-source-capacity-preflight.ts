export const PROVIDER_SOURCE_CAPACITY_FORECAST_VERSION =
  "provider-source-capacity-forecast-v2" as const;
export const PROVIDER_SOURCE_CAPACITY_PREFLIGHT_VERSION =
  "provider-source-capacity-preflight-v2" as const;

const basisPoints = 10_000;
const secondsPerDay = 86_400;

export interface ProviderSourceCapacityModelInput {
  readonly baselineRecordCount: number;
  readonly pageRecordLimit: number;
  readonly sourceCount: number;
  readonly pollIntervalSeconds: number;
  readonly rawRetentionDays: number;
  readonly operationalRetentionDays: number;
  readonly incrementalGrowthDays: number;
  readonly incrementalRecordsPerPollAttempt: number;
  readonly measuredStructuredPhysicalBytesPerRecord: number;
  readonly conservativeRawHistoryBytes: number;
  readonly measuredAverageRawPageBytes: number;
  readonly measuredAverageRawRecordBytes: number;
  readonly measuredPreExpiryNormalizedPayloadPhysicalBytesPerRecord: number;
  readonly measuredImportPagePhysicalBytes: number;
  readonly measuredQuarantinePhysicalBytes: number;
  readonly measuredQuarantineEvidencePhysicalBytes: number;
  readonly representativeQuarantineBasisPoints: number;
  readonly measuredDiagnosticPhysicalBytesPerPage: number;
  readonly measuredTerminalAttemptPhysicalBytes: number;
  readonly measuredCompactAttemptPhysicalBytes: number;
  readonly freeHeadroomBasisPoints: number;
  readonly abortThresholdBasisPoints: number;
}

export interface ProviderSourceCapacityForecast {
  readonly version: typeof PROVIDER_SOURCE_CAPACITY_FORECAST_VERSION;
  readonly baselineRecordCount: number;
  readonly initialPageCount: number;
  readonly sevenDayPollAttempts: number;
  readonly thirtyDayPollAttempts: number;
  readonly firstWindowAttempts: number;
  readonly incrementalPollAttempts: number;
  readonly incrementalRecordCount: number;
  readonly sevenDayIncrementalRecordCount: number;
  readonly thirtyDayIncrementalRecordCount: number;
  readonly structuredBytesPerRecord: number;
  readonly projectedBytes: Readonly<{
    structuredAndCanonical: number;
    conservativeRawHistory: number;
    retainedSteadyPollRaw: number;
    retainedPreExpiryNormalizedPagePayload: number;
    permanentImportPageLineage: number;
    quarantineEvidence: number;
    pageDiagnostics: number;
    terminalRequestAttempts: number;
    permanentCompactAttemptLineage: number;
    total: number;
  }>;
  readonly requiredFreeBytesWithHeadroom: number;
  readonly task010MinimumAvailableBytes: number;
  readonly abortThresholdBasisPoints: number;
  readonly nonterminalAttemptBytesEach: number;
}

export type ProviderSourceCapacityPreflightReason =
  | "insufficient_free_bytes"
  | "volume_above_abort_threshold"
  | "projected_abort_threshold_exceeded";

export interface ProviderSourceCapacityPreflightInput {
  readonly volumeCapacityBytes: number;
  readonly volumeAvailableBytes: number;
  readonly unreconciledNonterminalAttemptCount: number;
}

export interface ProviderSourceCapacityPreflightDecision {
  readonly version: typeof PROVIDER_SOURCE_CAPACITY_PREFLIGHT_VERSION;
  readonly decision: "approved" | "rejected";
  readonly reasons: readonly ProviderSourceCapacityPreflightReason[];
  readonly volumeUsedBytes: number;
  readonly projectedAdditionalBytes: number;
  readonly projectedVolumeUsedBytes: number;
  readonly abortAtUsedBytes: number;
  readonly requiredAvailableBytes: number;
}

export class ProviderSourceCapacityInputError extends TypeError {
  constructor() {
    super("provider_source_capacity.invalid_input");
    this.name = "ProviderSourceCapacityInputError";
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProviderSourceCapacityInputError();
  }
  return value;
}

function nonnegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProviderSourceCapacityInputError();
  }
  return value;
}

function boundedBasisPoints(value: number, allowZero = false): number {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value >= basisPoints
  ) {
    throw new ProviderSourceCapacityInputError();
  }
  return value;
}

function safeCeil(value: number): number {
  const result = Math.ceil(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ProviderSourceCapacityInputError();
  }
  return result;
}

export function buildProviderSourceCapacityForecast(
  input: ProviderSourceCapacityModelInput,
): ProviderSourceCapacityForecast {
  const baselineRecordCount = positiveInteger(input.baselineRecordCount);
  const pageRecordLimit = positiveInteger(input.pageRecordLimit);
  const sourceCount = positiveInteger(input.sourceCount);
  const pollIntervalSeconds = positiveInteger(input.pollIntervalSeconds);
  const rawRetentionDays = positiveInteger(input.rawRetentionDays);
  const operationalRetentionDays = positiveInteger(
    input.operationalRetentionDays,
  );
  const incrementalGrowthDays = positiveInteger(input.incrementalGrowthDays);
  const incrementalRecordsPerPollAttempt = positiveInteger(
    input.incrementalRecordsPerPollAttempt,
  );
  const measuredStructuredPhysicalBytesPerRecord = positiveInteger(
    input.measuredStructuredPhysicalBytesPerRecord,
  );
  const conservativeRawHistoryBytes = positiveInteger(
    input.conservativeRawHistoryBytes,
  );
  const measuredAverageRawPageBytes = positiveInteger(
    input.measuredAverageRawPageBytes,
  );
  const measuredAverageRawRecordBytes = positiveInteger(
    input.measuredAverageRawRecordBytes,
  );
  const measuredPreExpiryNormalizedPayloadPhysicalBytesPerRecord =
    positiveInteger(
      input.measuredPreExpiryNormalizedPayloadPhysicalBytesPerRecord,
    );
  const measuredImportPagePhysicalBytes = positiveInteger(
    input.measuredImportPagePhysicalBytes,
  );
  const measuredQuarantinePhysicalBytes = positiveInteger(
    input.measuredQuarantinePhysicalBytes,
  );
  const measuredQuarantineEvidencePhysicalBytes = positiveInteger(
    input.measuredQuarantineEvidencePhysicalBytes,
  );
  const representativeQuarantineBasisPoints = boundedBasisPoints(
    input.representativeQuarantineBasisPoints,
    true,
  );
  const measuredDiagnosticPhysicalBytesPerPage = positiveInteger(
    input.measuredDiagnosticPhysicalBytesPerPage,
  );
  const measuredTerminalAttemptPhysicalBytes = positiveInteger(
    input.measuredTerminalAttemptPhysicalBytes,
  );
  const measuredCompactAttemptPhysicalBytes = positiveInteger(
    input.measuredCompactAttemptPhysicalBytes,
  );
  const freeHeadroomBasisPoints = boundedBasisPoints(
    input.freeHeadroomBasisPoints,
  );
  const abortThresholdBasisPoints = boundedBasisPoints(
    input.abortThresholdBasisPoints,
  );
  const initialPageCount = Math.ceil(baselineRecordCount / pageRecordLimit);
  const attemptsForDays = (days: number) =>
    safeCeil(sourceCount * days * secondsPerDay / pollIntervalSeconds);
  const sevenDayPollAttempts = attemptsForDays(rawRetentionDays);
  const thirtyDayPollAttempts = attemptsForDays(operationalRetentionDays);
  const incrementalPollAttempts = attemptsForDays(
    incrementalGrowthDays,
  );
  const incrementalRecordCount = safeCeil(
    incrementalPollAttempts * incrementalRecordsPerPollAttempt,
  );
  const sevenDayIncrementalRecordCount = safeCeil(
    sevenDayPollAttempts * incrementalRecordsPerPollAttempt,
  );
  const thirtyDayIncrementalRecordCount = safeCeil(
    thirtyDayPollAttempts * incrementalRecordsPerPollAttempt,
  );
  const firstWindowAttempts = safeCeil(
    initialPageCount + thirtyDayPollAttempts,
  );
  const structuredBytesPerRecord = measuredStructuredPhysicalBytesPerRecord;
  const projectedBytes = {
    structuredAndCanonical: safeCeil(
      (baselineRecordCount + incrementalRecordCount) *
        structuredBytesPerRecord,
    ),
    conservativeRawHistory: conservativeRawHistoryBytes,
    retainedSteadyPollRaw: safeCeil(
      sevenDayPollAttempts * measuredAverageRawPageBytes,
    ),
    retainedPreExpiryNormalizedPagePayload: safeCeil(
      (baselineRecordCount + sevenDayIncrementalRecordCount) *
        measuredPreExpiryNormalizedPayloadPhysicalBytesPerRecord,
    ),
    permanentImportPageLineage: safeCeil(
      (initialPageCount + incrementalPollAttempts) *
        measuredImportPagePhysicalBytes,
    ),
    quarantineEvidence: safeCeil(
      (baselineRecordCount + thirtyDayIncrementalRecordCount) *
        representativeQuarantineBasisPoints /
        basisPoints *
        (measuredQuarantinePhysicalBytes + Math.max(
          measuredAverageRawRecordBytes,
          measuredQuarantineEvidencePhysicalBytes,
        )),
    ),
    pageDiagnostics: safeCeil(
      firstWindowAttempts * measuredDiagnosticPhysicalBytesPerPage,
    ),
    terminalRequestAttempts: safeCeil(
      firstWindowAttempts * measuredTerminalAttemptPhysicalBytes,
    ),
    permanentCompactAttemptLineage: safeCeil(
      (initialPageCount + incrementalPollAttempts) *
        measuredCompactAttemptPhysicalBytes,
    ),
  };
  const total = safeCeil(
    Object.values(projectedBytes).reduce((sum, value) => sum + value, 0),
  );
  const requiredFreeBytesWithHeadroom = safeCeil(
    total * basisPoints / (basisPoints - freeHeadroomBasisPoints),
  );
  return Object.freeze({
    version: PROVIDER_SOURCE_CAPACITY_FORECAST_VERSION,
    baselineRecordCount,
    initialPageCount,
    sevenDayPollAttempts,
    thirtyDayPollAttempts,
    firstWindowAttempts,
    incrementalPollAttempts,
    incrementalRecordCount,
    sevenDayIncrementalRecordCount,
    thirtyDayIncrementalRecordCount,
    structuredBytesPerRecord,
    projectedBytes: Object.freeze({ ...projectedBytes, total }),
    requiredFreeBytesWithHeadroom,
    task010MinimumAvailableBytes: requiredFreeBytesWithHeadroom,
    abortThresholdBasisPoints,
    nonterminalAttemptBytesEach: measuredTerminalAttemptPhysicalBytes,
  });
}

export function evaluateProviderSourceCapacityPreflight(
  forecast: ProviderSourceCapacityForecast,
  input: ProviderSourceCapacityPreflightInput,
): ProviderSourceCapacityPreflightDecision {
  const volumeCapacityBytes = positiveInteger(input.volumeCapacityBytes);
  const volumeAvailableBytes = nonnegativeInteger(input.volumeAvailableBytes);
  const unreconciledNonterminalAttemptCount = nonnegativeInteger(
    input.unreconciledNonterminalAttemptCount,
  );
  if (
    volumeAvailableBytes > volumeCapacityBytes ||
    forecast.version !== PROVIDER_SOURCE_CAPACITY_FORECAST_VERSION
  ) {
    throw new ProviderSourceCapacityInputError();
  }
  const nonterminalReserveBytes = safeCeil(
    unreconciledNonterminalAttemptCount * forecast.nonterminalAttemptBytesEach,
  );
  const projectedAdditionalBytes = safeCeil(
    forecast.projectedBytes.total + nonterminalReserveBytes,
  );
  const requiredAvailableBytes = safeCeil(
    forecast.task010MinimumAvailableBytes + nonterminalReserveBytes,
  );
  const volumeUsedBytes = volumeCapacityBytes - volumeAvailableBytes;
  const projectedVolumeUsedBytes = safeCeil(
    volumeUsedBytes + projectedAdditionalBytes,
  );
  const abortAtUsedBytes = Math.floor(
    volumeCapacityBytes * forecast.abortThresholdBasisPoints / basisPoints,
  );
  const reasons: ProviderSourceCapacityPreflightReason[] = [];
  if (volumeAvailableBytes < requiredAvailableBytes) {
    reasons.push("insufficient_free_bytes");
  }
  if (volumeUsedBytes >= abortAtUsedBytes) {
    reasons.push("volume_above_abort_threshold");
  }
  if (projectedVolumeUsedBytes >= abortAtUsedBytes) {
    reasons.push("projected_abort_threshold_exceeded");
  }
  return Object.freeze({
    version: PROVIDER_SOURCE_CAPACITY_PREFLIGHT_VERSION,
    decision: reasons.length === 0 ? "approved" : "rejected",
    reasons: Object.freeze(reasons),
    volumeUsedBytes,
    projectedAdditionalBytes,
    projectedVolumeUsedBytes,
    abortAtUsedBytes,
    requiredAvailableBytes,
  });
}
