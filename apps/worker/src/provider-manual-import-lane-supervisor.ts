import type { LaunchProviderKey } from "@packscout/contracts";
import { providerDataforrestLiveIntegrationRegistry } from
  "./provider-dataforrest-live-integration.ts";
import type { ProviderManualImportExecutionResult } from
  "./provider-manual-import-executor.ts";
import {
  ProviderManualImportLocalError,
  readProviderManualImportLocalConfiguration,
  type ProviderManualImportLocalFailureCode,
} from "./provider-manual-import-local-runtime.ts";

const MINIMUM_LANE_CONCURRENCY = 2;
const MAXIMUM_LANE_CONCURRENCY = 8;
const MINIMUM_LANE_COUNT = 2;
const MAXIMUM_LANE_COUNT = 16;

export interface ProviderManualImportLane {
  readonly providerId: string;
  readonly providerKey: LaunchProviderKey;
  readonly workerId: string;
}

export interface ProviderManualImportLaneSupervisorConfiguration {
  readonly lanes: readonly ProviderManualImportLane[];
  readonly maximumConcurrency: number;
}

export type ProviderManualImportLaneFailureCode =
  | ProviderManualImportLocalFailureCode
  | "PROVIDER_IMPORT_CAPABILITY_UNAVAILABLE"
  | "PROVIDER_IMPORT_FAILED";

export type ProviderManualImportLaneOutcome =
  | Readonly<{
      providerId: string;
      providerKey: LaunchProviderKey;
      status: "fulfilled";
      result: ProviderManualImportExecutionResult;
    }>
  | Readonly<{
      providerId: string;
      providerKey: LaunchProviderKey;
      status: "rejected";
      failureCode: ProviderManualImportLaneFailureCode;
    }>;

function configurationError(): never {
  throw new ProviderManualImportLocalError(
    "PROVIDER_IMPORT_CONFIGURATION_INVALID",
  );
}

function exactLaneCandidate(value: unknown): value is Readonly<{
  providerId: string;
  providerKey: string;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "providerId,providerKey"
    && typeof record.providerId === "string"
    && typeof record.providerKey === "string";
}

function normalizeLanes(
  lanes: readonly ProviderManualImportLane[],
): readonly ProviderManualImportLane[] {
  if (
    lanes.length < MINIMUM_LANE_COUNT
    || lanes.length > MAXIMUM_LANE_COUNT
  ) {
    configurationError();
  }
  const providerIds = new Set<string>();
  const providerKeys = new Set<LaunchProviderKey>();
  const normalized = lanes.map((lane) => {
    const configuration = readProviderManualImportLocalConfiguration({
      PACKSCOUT_PROVIDER_ID: lane.providerId,
      PACKSCOUT_PROVIDER_KEY: lane.providerKey,
      PACKSCOUT_PROVIDER_WORKER_ID: lane.workerId,
    }, lane.workerId);
    if (
      providerIds.has(configuration.providerId)
      || providerKeys.has(configuration.providerKey)
    ) {
      configurationError();
    }
    providerIds.add(configuration.providerId);
    providerKeys.add(configuration.providerKey);
    return Object.freeze({
      providerId: configuration.providerId,
      providerKey: configuration.providerKey,
      workerId: configuration.workerId,
    });
  });
  return Object.freeze(normalized);
}

function maximumConcurrency(value: string | undefined): number {
  const normalized = value?.trim() ?? "2";
  const parsed = Number(normalized);
  if (
    !/^[0-9]+$/u.test(normalized)
    || !Number.isSafeInteger(parsed)
    || parsed < MINIMUM_LANE_CONCURRENCY
    || parsed > MAXIMUM_LANE_CONCURRENCY
  ) {
    configurationError();
  }
  return parsed;
}

export function readProviderManualImportLaneSupervisorConfiguration(
  environment: NodeJS.ProcessEnv,
  fallbackWorkerId: string,
): ProviderManualImportLaneSupervisorConfiguration {
  const serialized = environment.PACKSCOUT_PROVIDER_LANES_JSON?.trim() ?? "";
  if (
    serialized.length === 0
    || serialized.length > 8_192
    || /[\r\n\0]/u.test(serialized)
  ) {
    configurationError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    configurationError();
  }
  if (
    !Array.isArray(parsed)
    || !parsed.every(exactLaneCandidate)
  ) {
    configurationError();
  }
  const lanes = normalizeLanes(parsed.map((lane, index) => ({
    providerId: lane.providerId,
    providerKey: lane.providerKey as LaunchProviderKey,
    workerId: `${fallbackWorkerId}:lane-${index + 1}`,
  })));
  return Object.freeze({
    lanes,
    maximumConcurrency: maximumConcurrency(
      environment.PACKSCOUT_PROVIDER_LANE_CONCURRENCY,
    ),
  });
}

function rejectedOutcome(
  lane: ProviderManualImportLane,
  failureCode: ProviderManualImportLaneFailureCode,
): ProviderManualImportLaneOutcome {
  return Object.freeze({
    providerId: lane.providerId,
    providerKey: lane.providerKey,
    status: "rejected" as const,
    failureCode,
  });
}

function failureCode(error: unknown): ProviderManualImportLaneFailureCode {
  return error instanceof ProviderManualImportLocalError
    ? error.code
    : "PROVIDER_IMPORT_FAILED";
}

/**
 * Runs explicit admitted provider lanes with no shared execution lease. Each
 * lane owns its provider-local route, lease, cursor, and terminal outcome.
 */
export async function runProviderManualImportLanesOnce(input: Readonly<{
  lanes: readonly ProviderManualImportLane[];
  maximumConcurrency: number;
  runLane(
    lane: ProviderManualImportLane,
  ): Promise<ProviderManualImportExecutionResult>;
}>): Promise<readonly ProviderManualImportLaneOutcome[]> {
  const lanes = normalizeLanes(input.lanes);
  if (
    !Number.isSafeInteger(input.maximumConcurrency)
    || input.maximumConcurrency < MINIMUM_LANE_CONCURRENCY
    || input.maximumConcurrency > MAXIMUM_LANE_CONCURRENCY
  ) {
    configurationError();
  }

  const outcomes = new Array<ProviderManualImportLaneOutcome>(lanes.length);
  let nextLaneIndex = 0;
  const workers = Array.from({
    length: Math.min(input.maximumConcurrency, lanes.length),
  }, async () => {
    while (nextLaneIndex < lanes.length) {
      const laneIndex = nextLaneIndex;
      nextLaneIndex += 1;
      const lane = lanes[laneIndex]!;
      if (
        providerDataforrestLiveIntegrationRegistry.resolveProvider(
          lane.providerKey,
        ) === null
      ) {
        outcomes[laneIndex] = rejectedOutcome(
          lane,
          "PROVIDER_IMPORT_CAPABILITY_UNAVAILABLE",
        );
        continue;
      }
      const [settled] = await Promise.allSettled([
        Promise.resolve().then(() => input.runLane(lane)),
      ]);
      outcomes[laneIndex] = settled.status === "fulfilled"
        ? Object.freeze({
            providerId: lane.providerId,
            providerKey: lane.providerKey,
            status: "fulfilled" as const,
            result: settled.value,
          })
        : rejectedOutcome(lane, failureCode(settled.reason));
    }
  });
  await Promise.allSettled(workers);
  for (const [laneIndex, lane] of lanes.entries()) {
    outcomes[laneIndex] ??= rejectedOutcome(
      lane,
      "PROVIDER_IMPORT_FAILED",
    );
  }
  return Object.freeze(outcomes);
}
