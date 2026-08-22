import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";
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
  pageRecordLimit: 250,
  sourceCount: 4,
  pollIntervalSeconds: 60,
  rawRetentionDays: 7,
  operationalRetentionDays: 30,
  incrementalGrowthDays: 365,
  // No observed steady-state delivery rate is available yet. Fail closed by
  // budgeting a full 250-record page on every possible 60-second poll for the
  // complete one-year growth horizon; Task 010 may replace this only with new
  // reviewed evidence and a versioned artifact.
  incrementalRecordsPerPollAttempt: 250,
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
        "fail-closed maximum: every source returns the full 250-record launch page on every 60-second poll",
    },
  },
  storageMeasurement: {
    environment: {
      postgresVersionMajor: 16,
      schemaMigration: "20260821040000_provider_source_page_plan_digest",
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
