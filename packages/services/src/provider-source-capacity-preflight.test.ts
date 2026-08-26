import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  dataforrestEventsV1SourceAdapterManifest,
} from "@packscout/contracts";
import {
  ProviderSourceCapacityInputError,
  buildProviderSourceCapacityForecast,
  evaluateProviderSourceCapacityPreflight,
  type ProviderSourceCapacityForecast,
  type ProviderSourceCapacityModelInput,
  type ProviderSourceCapacityPreflightDecision,
  type ProviderSourceCapacityPreflightInput,
} from "./provider-source-capacity-preflight.ts";

interface MemoryMeasurement {
  readonly version: "provider-source-page-memory-v1";
  readonly path: "authentic-capture-terminalize-interpret-complete-import-plan";
  readonly sourceAdapterVersion: typeof DATAFORREST_EVENTS_V1_ADAPTER_VERSION;
  readonly trialCount: number;
  readonly pagesPerTrial: number;
  readonly pageCount: number;
  readonly recordsPerPage: number;
  readonly responseBytesPerPage: number;
  readonly jsonNodesPerPage: number;
  readonly emptyObjectFactsPerRecord: number;
  readonly totalRecordsProcessed: number;
  readonly peakDeltaBytes: number;
  readonly retainedMetric: "theil-sen-managed-bytes-per-page";
  readonly theilSenBytesPerPage: number;
  readonly retainedGrowthBytes: number;
  readonly limits: Readonly<{
    peakDeltaBytes: number;
    retainedGrowthBytes: number;
  }>;
  readonly passes: boolean;
}

interface CapacityArtifact {
  readonly storageMeasurement: Readonly<{
    sample: Readonly<{ inputRecords: number }>;
    allocationPageBytes: number;
    structuredPhysicalBytesPerRecord: number;
    normalizedPayloadPhysicalBytesPerRecord: number;
    importPagePhysicalBytes: number;
    quarantinePhysicalBytes: number;
    quarantineEvidencePhysicalBytes: number;
    diagnosticPhysicalBytesPerPage: number;
    terminalAttemptPhysicalBytes: number;
    compactAttemptPhysicalBytes: number;
    windows: readonly Readonly<{
      structuredPhysicalBytes: number;
      structuredPhysicalBytesPerRecord: number;
      normalizedPayloadPhysicalBytesPerRecord: number;
      importPagePhysicalBytes: number;
      quarantinePhysicalBytes: number;
      quarantineEvidencePhysicalBytes: number;
      diagnosticPhysicalBytesPerPage: number;
      terminalAttemptPhysicalBytes: number;
      compactAttemptPhysicalBytes: number;
    }>[];
    relations: readonly Readonly<{
      relation: string;
      rows: number;
      logicalRowBytes: number;
      tableBytes: number;
      indexBytes: number;
      toastAndAuxiliaryBytes: number;
      totalBytes: number;
    }>[];
  }>;
  readonly memoryMeasurement: MemoryMeasurement;
  readonly forecastInput: ProviderSourceCapacityModelInput;
  readonly forecast: ProviderSourceCapacityForecast;
  readonly task010AdmissionPreflight: Readonly<{
    input: ProviderSourceCapacityPreflightInput;
    decision: ProviderSourceCapacityPreflightDecision;
  }>;
}

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function freshMemoryMeasurement(): Promise<MemoryMeasurement> {
  const script = fileURLToPath(
    new URL(
      "../../../scripts/local/measure-provider-source-page-memory.mts",
      import.meta.url,
    ),
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", script],
    { cwd: repositoryRoot, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout) as MemoryMeasurement;
}

async function capacityArtifact(): Promise<CapacityArtifact> {
  const contents = await readFile(
    new URL(
      "../../../docs/provider-source-capacity-measurement-v1.json",
      import.meta.url,
    ),
    "utf8",
  );
  return JSON.parse(contents) as CapacityArtifact;
}

test("capacity artifact is derived from measured relations and exact retention volume", async () => {
  const artifact = await capacityArtifact();
  assert.equal(
    artifact.forecastInput.measuredStructuredPhysicalBytesPerRecord,
    artifact.storageMeasurement.structuredPhysicalBytesPerRecord,
  );
  assert.equal(
    artifact.storageMeasurement.structuredPhysicalBytesPerRecord,
    Math.max(
      ...artifact.storageMeasurement.windows.map(
        ({ structuredPhysicalBytesPerRecord }) =>
          structuredPhysicalBytesPerRecord,
      ),
    ) + Math.ceil(
      9 * artifact.storageMeasurement.allocationPageBytes / 96,
    ),
  );
  for (const [key, denominator] of [
    ["normalizedPayloadPhysicalBytesPerRecord", 96],
    ["importPagePhysicalBytes", 24],
    ["quarantinePhysicalBytes", 24],
    ["quarantineEvidencePhysicalBytes", 24],
    ["diagnosticPhysicalBytesPerPage", 24],
    ["terminalAttemptPhysicalBytes", 24],
    ["compactAttemptPhysicalBytes", 24],
  ] as const) {
    assert.equal(
      artifact.storageMeasurement[key],
      Math.max(...artifact.storageMeasurement.windows.map(
        (window) => window[key],
      )) + Math.ceil(
        artifact.storageMeasurement.allocationPageBytes / denominator,
      ),
    );
  }
  assert.equal(
    artifact.forecastInput
      .measuredPreExpiryNormalizedPayloadPhysicalBytesPerRecord,
    artifact.storageMeasurement.normalizedPayloadPhysicalBytesPerRecord,
  );
  assert.equal(
    artifact.forecastInput.measuredImportPagePhysicalBytes,
    artifact.storageMeasurement.importPagePhysicalBytes,
  );
  assert.equal(
    artifact.forecastInput.measuredQuarantineEvidencePhysicalBytes,
    artifact.storageMeasurement.quarantineEvidencePhysicalBytes,
  );
  assert.equal(
    artifact.forecastInput.measuredQuarantinePhysicalBytes,
    artifact.storageMeasurement.quarantinePhysicalBytes,
  );
  assert.equal(
    artifact.forecastInput.measuredDiagnosticPhysicalBytesPerPage,
    artifact.storageMeasurement.diagnosticPhysicalBytesPerPage,
  );
  assert.equal(
    artifact.forecastInput.measuredTerminalAttemptPhysicalBytes,
    artifact.storageMeasurement.terminalAttemptPhysicalBytes,
  );
  assert.equal(
    artifact.forecastInput.measuredCompactAttemptPhysicalBytes,
    artifact.storageMeasurement.compactAttemptPhysicalBytes,
  );
  for (const measurement of artifact.storageMeasurement.relations) {
    assert.ok(measurement.rows > 0);
    assert.ok(measurement.logicalRowBytes > 0);
    assert.equal(
      measurement.totalBytes,
      measurement.tableBytes +
        measurement.indexBytes +
        measurement.toastAndAuxiliaryBytes,
    );
  }
  assert.deepEqual(
    buildProviderSourceCapacityForecast(artifact.forecastInput),
    artifact.forecast,
  );
  assert.equal(
    artifact.forecastInput.incrementalRecordsPerPollAttempt,
    artifact.forecastInput.pageRecordLimit,
  );
  assert.equal(artifact.forecast.initialPageCount, 58_108);
  assert.equal(artifact.forecast.thirtyDayPollAttempts, 172_800);
  assert.equal(artifact.forecast.firstWindowAttempts, 230_908);
  assert.equal(artifact.forecast.incrementalPollAttempts, 2_102_400);
  assert.equal(artifact.forecast.incrementalRecordCount, 525_600_000);
  assert.equal(artifact.forecast.sevenDayIncrementalRecordCount, 10_080_000);
  assert.equal(
    artifact.forecast.thirtyDayIncrementalRecordCount,
    43_200_000,
  );
  assert.equal(
    artifact.forecast.projectedBytes.structuredAndCanonical,
    (artifact.forecast.baselineRecordCount +
      artifact.forecast.incrementalRecordCount) *
      artifact.forecast.structuredBytesPerRecord,
  );
});

test("fresh authentic 100-page import planning stays within measured memory limits", async () => {
  const { memoryMeasurement: memory } = await capacityArtifact();
  const fresh = await freshMemoryMeasurement();
  assert.ok(memory.pageCount >= 100);
  assert.equal(memory.version, "provider-source-page-memory-v1");
  assert.equal(
    memory.path,
    "authentic-capture-terminalize-interpret-complete-import-plan",
  );
  assert.equal(
    memory.sourceAdapterVersion,
    DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  );
  assert.equal(memory.retainedMetric, "theil-sen-managed-bytes-per-page");
  assert.ok(memory.trialCount >= 3);
  assert.equal(memory.trialCount * memory.pagesPerTrial, memory.pageCount);
  assert.equal(memory.recordsPerPage, 250);
  assert.equal(
    memory.responseBytesPerPage,
    dataforrestEventsV1SourceAdapterManifest.requestBounds.maximumResponseBytes,
  );
  assert.equal(memory.jsonNodesPerPage, 239_504);
  assert.equal(memory.emptyObjectFactsPerRecord, 945);
  assert.equal(
    memory.totalRecordsProcessed,
    memory.pageCount * memory.recordsPerPage,
  );
  assert.ok(memory.peakDeltaBytes <= memory.limits.peakDeltaBytes);
  assert.ok(memory.retainedGrowthBytes <= memory.limits.retainedGrowthBytes);
  assert.equal(memory.passes, true);
  assert.equal(fresh.version, memory.version);
  assert.equal(fresh.path, memory.path);
  assert.equal(fresh.sourceAdapterVersion, memory.sourceAdapterVersion);
  assert.equal(fresh.pageCount, memory.pageCount);
  assert.equal(fresh.recordsPerPage, memory.recordsPerPage);
  assert.equal(fresh.responseBytesPerPage, memory.responseBytesPerPage);
  assert.equal(fresh.jsonNodesPerPage, memory.jsonNodesPerPage);
  assert.equal(
    fresh.emptyObjectFactsPerRecord,
    memory.emptyObjectFactsPerRecord,
  );
  assert.ok(fresh.peakDeltaBytes <= fresh.limits.peakDeltaBytes);
  assert.ok(fresh.retainedGrowthBytes <= fresh.limits.retainedGrowthBytes);
  assert.equal(fresh.passes, true);
});

test("task 010 preflight rejects this host and approves a sufficiently empty dedicated volume", async () => {
  const artifact = await capacityArtifact();
  assert.deepEqual(
    evaluateProviderSourceCapacityPreflight(
      artifact.forecast,
      artifact.task010AdmissionPreflight.input,
    ),
    artifact.task010AdmissionPreflight.decision,
  );
  assert.equal(artifact.task010AdmissionPreflight.decision.decision, "rejected");
  assert.deepEqual(artifact.task010AdmissionPreflight.decision.reasons, [
    "insufficient_free_bytes",
    "volume_above_abort_threshold",
    "projected_abort_threshold_exceeded",
  ]);

  const dedicatedCapacityBytes = Math.ceil(
    artifact.forecast.requiredFreeBytesWithHeadroom * 1.25,
  );
  const approved = evaluateProviderSourceCapacityPreflight(
    artifact.forecast,
    {
      volumeCapacityBytes: dedicatedCapacityBytes,
      volumeAvailableBytes: dedicatedCapacityBytes,
      unreconciledNonterminalAttemptCount: 0,
    },
  );
  assert.equal(approved.decision, "approved");
  assert.deepEqual(approved.reasons, []);
  assert.throws(
    () => evaluateProviderSourceCapacityPreflight(artifact.forecast, {
      volumeCapacityBytes: 1,
      volumeAvailableBytes: 2,
      unreconciledNonterminalAttemptCount: 0,
    }),
    ProviderSourceCapacityInputError,
  );
});
