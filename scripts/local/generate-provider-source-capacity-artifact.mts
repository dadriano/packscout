import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { promisify } from "node:util";
import {
  providerSourceLaunchBounds,
  providerSourceRecordsPerRequest,
} from "@packscout/contracts";
import {
  buildProviderSourceCapacityForecast,
  evaluateProviderSourceCapacityPreflight,
} from "../../packages/services/src/provider-source-capacity-preflight.ts";

const execFileAsync = promisify(execFile);
const storageMarker = "PROVIDER_SOURCE_STORAGE_MEASUREMENT=";

async function commandOutput(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    return (await execFileAsync(executable, args, {
      cwd: process.cwd(),
      env,
      maxBuffer: 8 * 1024 * 1024,
    })).stdout;
  } catch (error) {
    const output = (error as { stdout?: string }).stdout;
    if (typeof output === "string" && output.includes(storageMarker)) {
      return output;
    }
    throw error;
  }
}

const storageOutput = await commandOutput(process.execPath, [
  "--import",
  "tsx",
  "--test",
  "--test-name-pattern=representative mixed commit measures",
  "packages/services/src/provider-source-atomic-page.integration.test.ts",
], {
  ...process.env,
  PACKSCOUT_PRINT_PROVIDER_SOURCE_CAPACITY: "1",
});
const storageLine = storageOutput.split("\n").find((line) =>
  line.includes(storageMarker)
);
if (!storageLine) throw new Error("provider source storage measurement missing");
const storageMeasurement = JSON.parse(
  storageLine.slice(storageLine.indexOf(storageMarker) + storageMarker.length),
) as Record<string, unknown>;

// Physical PostgreSQL allocation windows can move by an 8 KiB page between
// otherwise identical fresh databases. Never let a new sample lower a bound
// that was already measured and admitted into the versioned artifact.
const committedArtifact = JSON.parse(
  await readFile(
    new URL(
      "../../docs/provider-source-capacity-measurement-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  readonly storageMeasurement?: Readonly<Record<string, unknown>>;
};
const storageWindowBoundKeys = [
  "structuredPhysicalBytesPerRecord",
  "normalizedPayloadPhysicalBytesPerRecord",
  "importPagePhysicalBytes",
  "quarantinePhysicalBytes",
  "quarantineEvidencePhysicalBytes",
  "diagnosticPhysicalBytesPerPage",
  "terminalAttemptPhysicalBytes",
  "compactAttemptPhysicalBytes",
] as const;
const measuredWindows = storageMeasurement.windows;
const committedWindows = committedArtifact.storageMeasurement?.windows;
if (!Array.isArray(measuredWindows)) {
  throw new Error("provider source storage measurement windows invalid");
}
storageMeasurement.windows = measuredWindows.map((measured, index) => {
  if (typeof measured !== "object" || measured === null) {
    throw new Error("provider source storage measurement window invalid");
  }
  const merged = { ...measured } as Record<string, unknown>;
  const committed = Array.isArray(committedWindows)
    ? committedWindows[index]
    : undefined;
  for (const key of ["structuredPhysicalBytes", ...storageWindowBoundKeys]) {
    const measuredValue = merged[key];
    if (typeof measuredValue !== "number" || !Number.isFinite(measuredValue)) {
      throw new Error(`provider source storage window ${key} invalid`);
    }
    const committedValue = typeof committed === "object" && committed !== null
      ? (committed as Record<string, unknown>)[key]
      : undefined;
    if (typeof committedValue === "number" && Number.isFinite(committedValue)) {
      merged[key] = Math.max(measuredValue, committedValue);
    }
  }
  return merged;
});
const allocationPageBytes = storageMeasurement.allocationPageBytes;
if (typeof allocationPageBytes !== "number" || !Number.isFinite(allocationPageBytes)) {
  throw new Error("provider source allocation page measurement invalid");
}
const storageBoundInputs = {
  structuredPhysicalBytesPerRecord: { denominator: 96, allocationPages: 9 },
  normalizedPayloadPhysicalBytesPerRecord: { denominator: 96, allocationPages: 1 },
  importPagePhysicalBytes: { denominator: 24, allocationPages: 1 },
  quarantinePhysicalBytes: { denominator: 24, allocationPages: 1 },
  quarantineEvidencePhysicalBytes: { denominator: 24, allocationPages: 1 },
  diagnosticPhysicalBytesPerPage: { denominator: 24, allocationPages: 1 },
  terminalAttemptPhysicalBytes: { denominator: 24, allocationPages: 1 },
  compactAttemptPhysicalBytes: { denominator: 24, allocationPages: 1 },
} as const;
for (const [key, { denominator, allocationPages }] of Object.entries(
  storageBoundInputs,
)) {
  storageMeasurement[key] = Math.max(
    ...(storageMeasurement.windows as readonly Record<string, unknown>[]).map(
      (window) => window[key] as number,
    ),
  ) + Math.ceil(allocationPages * allocationPageBytes / denominator);
}
const measuredStatementCount = storageMeasurement.pageStatementCount;
const committedStatementCount =
  committedArtifact.storageMeasurement?.pageStatementCount;
if (typeof measuredStatementCount !== "number" || !Number.isFinite(measuredStatementCount)) {
  throw new Error("provider source statement count measurement invalid");
}
if (
  typeof committedStatementCount === "number" &&
  Number.isFinite(committedStatementCount)
) {
  storageMeasurement.pageStatementCount = Math.max(
    measuredStatementCount,
    committedStatementCount,
  );
}

const memoryMeasurement = JSON.parse(
  await commandOutput(process.execPath, [
    "--expose-gc",
    "--import",
    "tsx",
    "scripts/local/measure-provider-source-page-memory.mts",
  ]),
) as Record<string, unknown>;

const forecastInput = {
  baselineRecordCount: 14_526_877,
  // The dated full-history evidence was collected at 250 records per page.
  pageRecordLimit: providerSourceLaunchBounds.pageTargetRecords,
  sourceCount: 4,
  pollIntervalSeconds: 60,
  rawRetentionDays: 7,
  operationalRetentionDays: 30,
  incrementalGrowthDays: 365,
  // No observed steady-state delivery rate is available yet. Fail closed by
  // Ongoing capacity must independently cover the largest legal configured
  // page on every possible 60-second poll for the complete one-year horizon.
  incrementalRecordsPerPollAttempt: providerSourceRecordsPerRequest.maximum,
  measuredStructuredPhysicalBytesPerRecord:
    storageMeasurement.structuredPhysicalBytesPerRecord as number,
  conservativeRawHistoryBytes: 98_700_000_000,
  measuredAverageRawPageBytes: 642_434,
  measuredAverageRawRecordBytes: 2_570,
  measuredPreExpiryNormalizedPayloadPhysicalBytesPerRecord:
    storageMeasurement.normalizedPayloadPhysicalBytesPerRecord as number,
  measuredImportPagePhysicalBytes:
    storageMeasurement.importPagePhysicalBytes as number,
  measuredQuarantinePhysicalBytes:
    storageMeasurement.quarantinePhysicalBytes as number,
  measuredQuarantineEvidencePhysicalBytes:
    storageMeasurement.quarantineEvidencePhysicalBytes as number,
  representativeQuarantineBasisPoints: 2_500,
  measuredDiagnosticPhysicalBytesPerPage:
    storageMeasurement.diagnosticPhysicalBytesPerPage as number,
  measuredTerminalAttemptPhysicalBytes:
    storageMeasurement.terminalAttemptPhysicalBytes as number,
  measuredCompactAttemptPhysicalBytes:
    storageMeasurement.compactAttemptPhysicalBytes as number,
  freeHeadroomBasisPoints: 2_500,
  abortThresholdBasisPoints: 8_000,
};
const forecast = buildProviderSourceCapacityForecast(forecastInput);
const fileSystem = await statfs(process.cwd(), { bigint: true });
const task010Input = {
  volumeCapacityBytes: Number(fileSystem.blocks * fileSystem.bsize),
  volumeAvailableBytes: Number(fileSystem.bavail * fileSystem.bsize),
  unreconciledNonterminalAttemptCount: 0,
};
const artifact = {
  version: "provider-source-capacity-measurement-v1",
  measuredAt: new Date().toISOString(),
  reproduction: {
    generatorCommand:
      "node --import tsx scripts/local/generate-provider-source-capacity-artifact.mts",
    storageCommand:
      "PACKSCOUT_PRINT_PROVIDER_SOURCE_CAPACITY=1 node --import tsx --test --test-name-pattern='representative mixed commit measures' packages/services/src/provider-source-atomic-page.integration.test.ts",
    storageInvariantTest:
      "node --import tsx --test --test-name-pattern='representative mixed commit measures' packages/services/src/provider-source-atomic-page.integration.test.ts",
    memoryCommand: "npm run measure:provider-source-page-memory:local",
    forecastInvariantTest:
      "node --import tsx --test packages/services/src/provider-source-capacity-preflight.test.ts",
    liveVolumePreflightCommand:
      "npm run preflight:provider-source-backfill:local -- --database-path <postgres-data-volume-path> --unreconciled-attempts <count>",
  },
  evidence: {
    liveEvidenceWindow: "2026-08-20 21:36-21:38 America/Los_Angeles",
    source: "docs/dataforest-events-v1-live-evidence.md",
    baselineRecordCount: 14_526_877,
    reviewedPageCount: 8,
    reviewedAveragePageBytes: 642_434,
    reviewedAverageRecordBytes: 2_570,
    conservativeRawHistoryBytes: 98_700_000_000,
    incrementalGrowthAssumption: {
      horizonDays: forecastInput.incrementalGrowthDays,
      recordsPerPollAttempt: forecastInput.incrementalRecordsPerPollAttempt,
      basis:
        "split bound: the dated initial backfill uses 250-record pages; ongoing growth assumes every source returns the full 5,000-record configured page on every 60-second poll",
    },
  },
  storageMeasurement: {
    environment: {
      postgresVersionMajor: 16,
      schemaMigration: "20260826010000_provider_source_records_per_request",
    },
    ...storageMeasurement,
  },
  memoryMeasurement,
  forecastInput,
  forecast,
  task010AdmissionPreflight: {
    input: task010Input,
    decision: evaluateProviderSourceCapacityPreflight(forecast, task010Input),
  },
};

process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
