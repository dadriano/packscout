import { createHash } from "node:crypto";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestEventsV2SourceAdapterManifest,
  providerIdentityNamespaceByLaunchProvider,
  providerSourceLaunchBounds,
  type ProviderSourcePageCommitPins,
} from "@packscout/contracts";
import {
  DataforrestEventsSourceAdapter,
  OpaqueCursorGuard,
  ProviderSourcePageImportService,
  ProviderSourcePagePlanner,
  SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
  createProviderObservationMapperRegistryFromManifest,
  providerMapperManifest,
  type SourceAdapterCaptureInvocation,
  type SourceAdapterOperation,
  type UnboundSourceAdapterRequestResult,
} from "@packscout/services";
import { completeAuthenticPageReadForTest } from
  "../../packages/services/src/source-adapter-page-result.test-support.ts";

const benchmarkVersion = "provider-source-page-memory-v2";
const warmupPageCount = 10;
const trialCount = 5;
const pagesPerTrial = 20;
const pageCount = trialCount * pagesPerTrial;
const recordsPerPage = providerSourceLaunchBounds.pageTargetRecords;
const maximumResponseBytes = providerSourceLaunchBounds.maximumResponseBytes;
const mebibyte = 1024 * 1024;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
    : sorted[midpoint]!;
}

function managedBytes(): number {
  const memory = process.memoryUsage();
  return memory.heapUsed + memory.external;
}

async function collectGarbage(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  globalThis.gc?.();
  globalThis.gc?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function maximumSizeSanitizedPage(): Uint8Array {
  const records = Array.from({ length: recordsPerPage }, (_, index) => ({
    stream: "catalog",
    platform: "courtyard",
    record_id: `capacity-pack-${String(index).padStart(3, "0")}`,
    occurred_at: "2026-08-21T12:00:00.000Z",
    collected_at: "2026-08-21T12:00:01.000Z",
    data: {
      provider_label: `Capacity pack ${index}`,
      sanitized_padding: "",
    },
    entity: "pack",
    first_seen_at: "2026-08-21T12:00:00.000Z",
    available: true,
  }));
  let serialized = JSON.stringify({
    records,
    next_cursor: "capacity-cursor-001",
    poll_after_seconds: 60,
  });
  const remainingBytes = maximumResponseBytes - Buffer.byteLength(serialized);
  if (remainingBytes < 0) throw new Error("capacity page fixture exceeds bound");
  records[0]!.data.sanitized_padding = "x".repeat(remainingBytes);
  serialized = JSON.stringify({
    records,
    next_cursor: "capacity-cursor-001",
    poll_after_seconds: 60,
  });
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.byteLength !== maximumResponseBytes) {
    throw new Error("capacity page fixture does not reach the response bound");
  }
  return bytes;
}

class InMemoryDataforrestEventsSourceAdapter
  extends DataforrestEventsSourceAdapter {
  constructor(private readonly rawResponse: Uint8Array) {
    super({}, dataforrestEventsV2SourceAdapterManifest);
  }

  override async captureUnboundRequest(
    operation: SourceAdapterOperation,
    invocation: SourceAdapterCaptureInvocation,
  ): Promise<UnboundSourceAdapterRequestResult> {
    invocation.consume(operation);
    const protectedRawResponse = new Uint8Array(this.rawResponse);
    return Object.freeze({
      ok: true as const,
      value: Object.freeze({
        captureVersion: SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
        protectedRawResponse,
        protectedRawResponseSha256: createHash("sha256")
          .update(protectedRawResponse)
          .digest("hex"),
      }),
      measurements: Object.freeze({
        durationMilliseconds: 1,
        responseBytes: protectedRawResponse.byteLength,
      }),
      diagnostics: Object.freeze([]),
    });
  }
}

if (typeof globalThis.gc !== "function") {
  throw new Error("Run the memory measurement with Node --expose-gc.");
}

const provider = "courtyard" as const;
const declaration = dataforrestEventsV2SourceAdapterManifest.supportedProviders
  .find((candidate) => candidate.provider === provider);
const mapper = providerMapperManifest.find(
  (candidate) => candidate.descriptor.provider === provider,
);
if (!declaration || !mapper) throw new Error("capacity descriptor unavailable");

const ids = Object.freeze({
  organizationId: "00000000-0000-4000-8000-000000000001",
  connectionProfileId: "00000000-0000-4000-8000-000000000002",
  connectionRevisionId: "00000000-0000-4000-8000-000000000003",
  sourceInstanceId: "00000000-0000-4000-8000-000000000004",
  sourceRevisionId: "00000000-0000-4000-8000-000000000005",
  providerId: "00000000-0000-4000-8000-000000000006",
  runId: "00000000-0000-4000-8000-000000000007",
  pageId: "00000000-0000-4000-8000-000000000008",
  requestAttemptId: "00000000-0000-4000-8000-000000000009",
  requestLeaseId: "00000000-0000-4000-8000-000000000010",
  supervisorEpochId: "00000000-0000-4000-8000-000000000011",
  runClaimLeaseId: "00000000-0000-4000-8000-000000000012",
});
const requestedCursor = Object.freeze({
  sourceInstanceId: ids.sourceInstanceId,
  sourceRevisionId: ids.sourceRevisionId,
  sourceTypeKey: dataforrestEventsV2SourceAdapterManifest.sourceTypeKey,
  adapterVersion: dataforrestEventsV2SourceAdapterManifest.adapterVersion,
  cursorCodecKey:
    dataforrestEventsV2SourceAdapterManifest.cursorCodecKey,
  cursorGeneration: 1,
  value: null,
});
const pins: ProviderSourcePageCommitPins = Object.freeze({
  organizationId: ids.organizationId,
  providerId: ids.providerId,
  provider,
  sourceInstanceId: ids.sourceInstanceId,
  sourceRevisionId: ids.sourceRevisionId,
  sourceTypeKey: dataforrestEventsV2SourceAdapterManifest.sourceTypeKey,
  sourceAdapterVersion:
    dataforrestEventsV2SourceAdapterManifest.adapterVersion,
  normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
  mapperKey: mapper.descriptor.mapperKey,
  mapperVersion: mapper.descriptor.mapperVersion,
  identityNamespaceKey: providerIdentityNamespaceByLaunchProvider[provider],
  connectionProfileId: ids.connectionProfileId,
  connectionRevisionId: ids.connectionRevisionId,
  connectionHealthGeneration: 0n,
  requestAttemptId: ids.requestAttemptId,
  requestLeaseId: ids.requestLeaseId,
  supervisorEpochId: ids.supervisorEpochId,
  singletonFencingEpoch: 1,
  supervisorOwnerKey: "capacity-supervisor",
  supervisorLeaseToken: "capacity-supervisor-lease",
  runId: ids.runId,
  runTrigger: "manual",
  runLeaseOwner: "capacity-worker",
  runLeaseToken: "capacity-worker-lease",
  runClaimLeaseId: ids.runClaimLeaseId,
  pageId: ids.pageId,
  pageNumber: 1,
  cursorCodecVersion:
    dataforrestEventsV2SourceAdapterManifest.cursorCodecKey,
  cursorGeneration: 1n,
  requestedCursor,
  requestedCursorFingerprint: null,
});
const requestPins = Object.freeze({
  operationKind: "page_read" as const,
  requestAttemptId: pins.requestAttemptId,
  requestLeaseId: pins.requestLeaseId,
  organizationId: pins.organizationId,
  sourceTypeKey: pins.sourceTypeKey,
  adapterVersion: pins.sourceAdapterVersion,
  singletonFencingEpoch: pins.singletonFencingEpoch,
  connectionProfileId: pins.connectionProfileId,
  connectionProfileRevisionId: pins.connectionRevisionId,
  connectionHealthGeneration: Number(pins.connectionHealthGeneration),
  provider: pins.provider,
  sourceInstanceId: pins.sourceInstanceId,
  sourceRevisionId: pins.sourceRevisionId,
  normalizedContractVersion: pins.normalizedContractVersion,
  identityNamespaceKey: pins.identityNamespaceKey,
  importRunId: pins.runId,
  runClaimLeaseId: pins.runClaimLeaseId,
  pageAttemptId: pins.pageId,
  pageNumber: pins.pageNumber,
  pageLimit: recordsPerPage,
  cursorGeneration: Number(pins.cursorGeneration),
  requestedCursorFingerprint: null,
});
const adapter = new InMemoryDataforrestEventsSourceAdapter(
  maximumSizeSanitizedPage(),
);
const importService = new ProviderSourcePageImportService(
  new ProviderSourcePagePlanner(
    createProviderObservationMapperRegistryFromManifest(),
  ),
  new OpaqueCursorGuard(new Uint8Array(32).fill(7)),
  {
    async commitPage(input) {
      return {
        kind: "committed" as const,
        pageId: input.pins.pageId,
        cursorFingerprint: input.nextCursorFingerprint,
        continuation: input.plan.normalizedPage.continuation,
        counts: {
          inserted: input.plan.outcomes.length,
          revised: 0,
          duplicate: 0,
          quarantined: 0,
          warnings: input.plan.counts.warnings,
          unresolvedRelationships: 0,
          canonicalRevisions: input.plan.outcomes.length,
          evRequests: 0,
        },
      };
    },
  },
);

async function processMaximumSizePage(): Promise<Readonly<{
  activeRssBytes: number;
  recordCount: number;
}>> {
  const adapterResult = await completeAuthenticPageReadForTest(
    {
      manifest: dataforrestEventsV2SourceAdapterManifest,
      pins: requestPins,
      requestedCursor,
      connectionConfiguration: {
        endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
        bearerToken: "capacity-fixture-token",
      },
      sourceConfiguration: { platform: provider },
    },
    adapter,
  );
  const imported = await importService.importPage({
    pins,
    adapterResult,
    committedAt: new Date("2026-08-21T12:00:00.000Z"),
  });
  return {
    activeRssBytes: process.memoryUsage().rss,
    recordCount: imported.counts.inserted,
  };
}

for (let pageIndex = 0; pageIndex < warmupPageCount; pageIndex += 1) {
  await processMaximumSizePage();
  await collectGarbage();
}
await collectGarbage();
const idleRssBytes = process.memoryUsage().rss;
let peakRssBytes = idleRssBytes;
let checksum = 0;
const settledManagedBytes = [managedBytes()];
const startedAt = performance.now();

for (let trialIndex = 0; trialIndex < trialCount; trialIndex += 1) {
  for (let pageIndex = 0; pageIndex < pagesPerTrial; pageIndex += 1) {
    const measured = await processMaximumSizePage();
    checksum += measured.recordCount;
    peakRssBytes = Math.max(peakRssBytes, measured.activeRssBytes);
    await collectGarbage();
  }
  settledManagedBytes.push(managedBytes());
}

const slopes: number[] = [];
for (let left = 0; left < settledManagedBytes.length - 1; left += 1) {
  for (let right = left + 1; right < settledManagedBytes.length; right += 1) {
    slopes.push(
      (settledManagedBytes[right]! - settledManagedBytes[left]!) /
        ((right - left) * pagesPerTrial),
    );
  }
}
const theilSenBytesPerPage = median(slopes);
const retainedGrowthBytes = Math.max(
  0,
  Math.ceil(theilSenBytesPerPage * pageCount),
);
const peakDeltaBytes = Math.max(0, peakRssBytes - idleRssBytes);
const result = {
  version: benchmarkVersion,
  measuredAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  path: "authentic-capture-terminalize-interpret-complete-import-plan",
  sourceAdapterVersion: dataforrestEventsV2SourceAdapterManifest.adapterVersion,
  warmupPageCount,
  trialCount,
  pagesPerTrial,
  pageCount,
  recordsPerPage,
  responseBytesPerPage: maximumResponseBytes,
  totalRecordsProcessed: checksum,
  elapsedMilliseconds: Number((performance.now() - startedAt).toFixed(3)),
  idleRssBytes,
  peakRssBytes,
  peakDeltaBytes,
  settledManagedBytes,
  retainedMetric: "theil-sen-managed-bytes-per-page" as const,
  theilSenBytesPerPage: Number(theilSenBytesPerPage.toFixed(3)),
  retainedGrowthBytes,
  limits: {
    peakDeltaBytes: 64 * mebibyte,
    retainedGrowthBytes: 8 * mebibyte,
  },
  passes:
    checksum === pageCount * recordsPerPage &&
    peakDeltaBytes <= 64 * mebibyte &&
    retainedGrowthBytes <= 8 * mebibyte,
};

process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.passes) process.exitCode = 1;
