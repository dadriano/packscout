import { isDeepStrictEqual } from "node:util";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { parse as parsePath } from "node:path";
import { providerSourceLaunchBounds } from "@packscout/contracts";
import type { PackscoutPrismaClient, ProviderSourceSupervisorClaimedWork } from
  "@packscout/database";
import {
  buildProviderSourceCapacityForecast,
  PROVIDER_SOURCE_CAPACITY_FORECAST_VERSION,
  type ProviderSourceCapacityForecast,
  type ProviderSourceCapacityModelInput,
  type SourceSupervisorCapacityAdmissionHook,
} from "@packscout/services";

const CAPACITY_ARTIFACT_URL = new URL(
  "../../../docs/provider-source-capacity-measurement-v1.json",
  import.meta.url,
);
const MAXIMUM_ACTIVE_PAGE_TURNS = 4;
const BASIS_POINTS = 10_000;

export class ProviderSourceCapacityAdmissionConfigurationError extends Error {
  constructor(readonly code:
    | "CAPACITY_ARTIFACT_INVALID"
    | "CAPACITY_VOLUME_PATH_INVALID") {
    super("Provider source capacity admission configuration is invalid.");
    this.name = "ProviderSourceCapacityAdmissionConfigurationError";
  }
}

interface CapacityArtifact {
  readonly forecastInput: ProviderSourceCapacityModelInput;
  readonly forecast: ProviderSourceCapacityForecast;
}

function capacityArtifact(value: unknown): CapacityArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderSourceCapacityAdmissionConfigurationError(
      "CAPACITY_ARTIFACT_INVALID",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== "provider-source-capacity-measurement-v1" ||
    typeof record.forecastInput !== "object" ||
    record.forecastInput === null ||
    typeof record.forecast !== "object" || record.forecast === null
  ) {
    throw new ProviderSourceCapacityAdmissionConfigurationError(
      "CAPACITY_ARTIFACT_INVALID",
    );
  }
  let forecast: ProviderSourceCapacityForecast;
  try {
    forecast = buildProviderSourceCapacityForecast(
      record.forecastInput as ProviderSourceCapacityModelInput,
    );
  } catch {
    throw new ProviderSourceCapacityAdmissionConfigurationError(
      "CAPACITY_ARTIFACT_INVALID",
    );
  }
  if (
    forecast.version !== PROVIDER_SOURCE_CAPACITY_FORECAST_VERSION ||
    !isDeepStrictEqual(forecast, record.forecast)
  ) {
    throw new ProviderSourceCapacityAdmissionConfigurationError(
      "CAPACITY_ARTIFACT_INVALID",
    );
  }
  return {
    forecastInput: record.forecastInput as ProviderSourceCapacityModelInput,
    forecast,
  };
}

export function loadCommittedProviderSourceCapacityArtifact(): CapacityArtifact {
  try {
    return capacityArtifact(JSON.parse(readFileSync(CAPACITY_ARTIFACT_URL, "utf8")));
  } catch (error) {
    if (error instanceof ProviderSourceCapacityAdmissionConfigurationError) {
      throw error;
    }
    throw new ProviderSourceCapacityAdmissionConfigurationError(
      "CAPACITY_ARTIFACT_INVALID",
    );
  }
}

function safeBytes(value: bigint | number): number {
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new TypeError("Capacity volume bytes exceed the safe integer range.");
  }
  return converted;
}

export function providerSourceMaximumPageCommitBytes(
  artifact: CapacityArtifact,
): number {
  const model = artifact.forecastInput;
  const perRecord = model.measuredStructuredPhysicalBytesPerRecord +
    model.measuredPreExpiryNormalizedPayloadPhysicalBytesPerRecord +
    model.measuredQuarantinePhysicalBytes;
  const protectedNativeEvidenceBytes = Math.max(
    providerSourceLaunchBounds.maximumResponseBytes,
    model.pageRecordLimit * Math.max(
      model.measuredAverageRawRecordBytes,
      model.measuredQuarantineEvidencePhysicalBytes,
    ),
  );
  // A captured page may legally fill the transport contract even when the
  // measured fixture was smaller. The raw response and record-local protected
  // native evidence can coexist until retention, so reserve both independently.
  const total = providerSourceLaunchBounds.maximumResponseBytes +
    protectedNativeEvidenceBytes +
    model.pageRecordLimit * perRecord +
    model.measuredImportPagePhysicalBytes +
    model.measuredDiagnosticPhysicalBytesPerPage +
    model.measuredTerminalAttemptPhysicalBytes +
    model.measuredCompactAttemptPhysicalBytes;
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new ProviderSourceCapacityAdmissionConfigurationError(
      "CAPACITY_ARTIFACT_INVALID",
    );
  }
  return total;
}

export function evaluateProviderSourceOngoingCapacity(input: Readonly<{
  artifact: CapacityArtifact;
  volumeCapacityBytes: number;
  volumeAvailableBytes: number;
  unreconciledAttemptCount: number;
  minimumAvailableBytes?: number;
}>): Readonly<{
  admitted: boolean;
  projectedAvailableBytes: number;
  minimumAvailableBytes: number;
  safeCode: "CAPACITY_ABORT_THRESHOLD_REACHED" |
    "CAPACITY_DISK_RESERVE_REACHED";
}> {
  const {
    volumeCapacityBytes,
    volumeAvailableBytes,
    unreconciledAttemptCount,
  } = input;
  if (
    !Number.isSafeInteger(volumeCapacityBytes) || volumeCapacityBytes < 1 ||
    !Number.isSafeInteger(volumeAvailableBytes) || volumeAvailableBytes < 0 ||
    volumeAvailableBytes > volumeCapacityBytes ||
    !Number.isSafeInteger(unreconciledAttemptCount) ||
    unreconciledAttemptCount < 0 ||
    (input.minimumAvailableBytes !== undefined &&
      (!Number.isSafeInteger(input.minimumAvailableBytes) ||
        input.minimumAvailableBytes < 0))
  ) throw new TypeError("Provider source ongoing capacity input is invalid.");
  const outstandingReserveBytes =
    MAXIMUM_ACTIVE_PAGE_TURNS *
      providerSourceMaximumPageCommitBytes(input.artifact) +
    unreconciledAttemptCount *
      input.artifact.forecast.nonterminalAttemptBytesEach;
  const abortAtUsedBytes = Math.floor(
    volumeCapacityBytes * input.artifact.forecast.abortThresholdBasisPoints /
      BASIS_POINTS,
  );
  const usesExplicitDiskReserve = input.minimumAvailableBytes !== undefined;
  const minimumAvailableBytes = input.minimumAvailableBytes ??
    volumeCapacityBytes - abortAtUsedBytes;
  const projectedAvailableBytes = Math.max(
    0,
    volumeAvailableBytes - outstandingReserveBytes,
  );
  return {
    admitted: projectedAvailableBytes > minimumAvailableBytes,
    projectedAvailableBytes,
    minimumAvailableBytes,
    safeCode: usesExplicitDiskReserve
      ? "CAPACITY_DISK_RESERVE_REACHED"
      : "CAPACITY_ABORT_THRESHOLD_REACHED",
  };
}

interface VolumeStats {
  readonly bsize: bigint | number;
  readonly blocks: bigint | number;
  readonly bavail: bigint | number;
}

export function createProviderSourceCapacityAdmissionHook(input: Readonly<{
  database: PackscoutPrismaClient;
  volumePath: string;
  minimumAvailableBytes?: number;
  artifact?: CapacityArtifact;
  resolveVolumePath?: (path: string) => string;
  statVolume?: (path: string) => Promise<VolumeStats>;
  countUnreconciledAttempts?: () => Promise<number>;
}>): SourceSupervisorCapacityAdmissionHook<
  ProviderSourceSupervisorClaimedWork
> {
  const artifact = input.artifact ?? loadCommittedProviderSourceCapacityArtifact();
  const resolveVolumePath = input.resolveVolumePath ?? ((value: string) => {
    const resolved = realpathSync(value);
    if (!statSync(resolved).isDirectory()) {
      throw new ProviderSourceCapacityAdmissionConfigurationError(
        "CAPACITY_VOLUME_PATH_INVALID",
      );
    }
    return resolved;
  });
  let volumePath: string;
  try {
    volumePath = resolveVolumePath(input.volumePath);
  } catch (error) {
    if (error instanceof ProviderSourceCapacityAdmissionConfigurationError) {
      throw error;
    }
    throw new ProviderSourceCapacityAdmissionConfigurationError(
      "CAPACITY_VOLUME_PATH_INVALID",
    );
  }
  if (!volumePath || parsePath(volumePath).root === volumePath) {
    throw new ProviderSourceCapacityAdmissionConfigurationError(
      "CAPACITY_VOLUME_PATH_INVALID",
    );
  }
  const statVolume = input.statVolume ?? (async (value: string) =>
    await statfs(value, { bigint: true }));
  const countUnreconciledAttempts = input.countUnreconciledAttempts ??
    (async () => await input.database.source_request_attempts.count({
      where: { state: "in_flight" },
    }));
  return {
    async probe() {
      try {
        const [volume, unreconciledAttemptCount] = await Promise.all([
          statVolume(volumePath),
          countUnreconciledAttempts(),
        ]);
        const blockSize = safeBytes(volume.bsize);
        const decision = evaluateProviderSourceOngoingCapacity({
          artifact,
          volumeCapacityBytes: safeBytes(volume.blocks) * blockSize,
          volumeAvailableBytes: safeBytes(volume.bavail) * blockSize,
          unreconciledAttemptCount,
          ...(input.minimumAvailableBytes === undefined
            ? {}
            : { minimumAvailableBytes: input.minimumAvailableBytes }),
        });
        return decision.admitted
          ? { admitted: true as const }
          : {
              admitted: false as const,
              state: "blocked" as const,
              safeCode: decision.safeCode,
            };
      } catch {
        return {
          admitted: false,
          state: "probe_failed",
          safeCode: "CAPACITY_PROBE_FAILED",
        };
      }
    },
  };
}
