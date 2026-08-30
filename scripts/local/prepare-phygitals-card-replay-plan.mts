import { createHash } from "node:crypto";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  dataforrestEventRecordV1Schema,
  dataforrestEventsPageV1Schema,
  dataforrestPhygitalsDistributedSourceAdapterManifest,
  normalizeDataforrestEventRecordForAdapter,
} from "@packscout/contracts";
import { validateProviderMixedPageRecord } from "@packscout/database";
import {
  captureHardenedProviderResponse,
  createProviderObservationMapperRegistryFromManifest,
  providerSourceCanonicalProjectionsForValidatedMapping,
} from "@packscout/services";
import { createProviderDataforrestLiveIntegration } from
  "../../apps/worker/src/provider-dataforrest-live-integration.ts";
import { collectibleDraft } from
  "../../apps/worker/src/provider-observation-mixed-page-drafts.ts";

function deterministicId(label: string): string {
  const bytes = createHash("sha256").update(`packscout.local.phygitals.card-replay-v3:${label}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const phygitalsReplayPins = Object.freeze({
  providerId: "5034af05-8976-5da8-85bb-2d6eac02515c",
  organizationId: "3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a",
  providerKey: "phygitals",
  previousConfigId: "72719d40-80b3-4fee-aa06-6df1ffbcafad",
  sourceCredentialId: "f7d8f26a-1a07-4ada-a05e-5617a2893645",
  databaseCredentialId: "01a85d79-7d69-5f8d-8879-1a13ccebf09c",
  nodeId: "046bb731-8a8e-5d7a-9b57-9f91d27bd725",
  stoppedRunId: "b3f721f8-37fb-4961-8756-ee11819a66ec",
  stoppedCommandId: "3be8ea96-d342-4da5-8cba-c0bf383ecb90",
  stoppedAt: "2026-08-30T01:08:36.882Z",
  cursorHash: "26dafbeaea75906df5a56d9f6bcf51816c771ce0237991b23ed832c3d8741f0a",
  configId: deterministicId("config"),
  activationTestId: deterministicId("activation"),
  auditId: deterministicId("central-audit"),
  correlationId: deterministicId("local-replay-preparation"),
  owner: "local:phygitals:card-replay-v3",
});

export class PhygitalsCardReplayError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PhygitalsCardReplayError";
  }
}

export function refusePhygitalsReplay(code: string): never {
  throw new PhygitalsCardReplayError(code);
}

export interface PhygitalsReplaySnapshot {
  readonly providerId: string;
  readonly providerKey: string;
  readonly databaseRole: string;
  readonly schemaVersion: string;
  readonly runtimeState: string;
  readonly generation: string;
  readonly cachedConfigId: string | null;
  readonly cachedConfigNumber: string | null;
  readonly cursorHash: string | null;
  readonly cursorPresent: boolean;
  readonly cursorFingerprintMatches: boolean;
  readonly activeRunCount: number;
  readonly actionableCommandCount: number;
  readonly runCount: number;
  readonly commandCount: number;
  readonly canonicalCount: number;
  readonly promotionChangeCount: number;
  readonly pageCount: number;
  readonly quarantineCount: number;
  readonly exactHistoricalQuarantineCount: number;
  readonly run: Readonly<{
    id: string; state: string; configId: string; configNumber: string;
    commandId: string | null; pageCount: number; catalogCount: number;
    pullCount: number; marketCount: number; acceptedCount: number;
    duplicateCount: number; quarantinedCount: number; materialChangeCount: number;
    finalCursorHash: string | null; reachedHead: boolean; failureCode: string | null;
    finishedAt: string | null;
  }> | null;
}

/** Exact one-time recovery envelope. It deliberately refuses subsequent imports. */
export function assertPhygitalsReplaySnapshot(snapshot: PhygitalsReplaySnapshot): "previous" | "prepared" {
  const pins = phygitalsReplayPins;
  const run = snapshot.run;
  const previous = snapshot.cachedConfigId === pins.previousConfigId &&
    snapshot.cachedConfigNumber === "2" && snapshot.cursorHash === pins.cursorHash && snapshot.cursorPresent;
  const prepared = snapshot.cachedConfigId === pins.configId &&
    snapshot.cachedConfigNumber === "3" && snapshot.cursorHash === null && !snapshot.cursorPresent;
  if (
    snapshot.providerId !== pins.providerId || snapshot.providerKey !== pins.providerKey ||
    snapshot.databaseRole !== "provider" || snapshot.schemaVersion !== "distributed-provider-v1" ||
    snapshot.runtimeState !== "idle" || snapshot.generation !== "2" ||
    (!previous && !prepared) || !snapshot.cursorFingerprintMatches || snapshot.activeRunCount !== 0 ||
    snapshot.actionableCommandCount !== 0 || snapshot.runCount !== 1 ||
    snapshot.commandCount !== 1 || snapshot.canonicalCount !== 0 ||
    snapshot.promotionChangeCount !== 0 || snapshot.pageCount !== 133 ||
    snapshot.quarantineCount !== 13_300 || snapshot.exactHistoricalQuarantineCount !== 13_300 ||
    run === null || run.id !== pins.stoppedRunId || run.state !== "incomplete" ||
    run.configId !== pins.previousConfigId || run.configNumber !== "2" ||
    run.commandId !== pins.stoppedCommandId || run.pageCount !== 133 ||
    run.catalogCount !== 13_300 || run.pullCount !== 0 || run.marketCount !== 0 ||
    run.acceptedCount !== 0 || run.duplicateCount !== 0 ||
    run.quarantinedCount !== 13_300 || run.materialChangeCount !== 0 ||
    run.finalCursorHash !== pins.cursorHash || run.reachedHead ||
    run.failureCode !== "SOURCE_RECORD_MAPPING_INVALID" || run.finishedAt !== pins.stoppedAt
  ) refusePhygitalsReplay("PHYGITALS_REPLAY_CHECKPOINT_UNEXPECTED");
  return previous ? "previous" : "prepared";
}

export interface PhygitalsMappingAdmission {
  readonly checkKind: "bounded_phygitals_native_card_mapping";
  readonly adapterVersion: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly recordCount: number;
  readonly collectibleCount: number;
  readonly quarantineCount: 0;
  readonly chaseCount: number;
  readonly assetCount: number;
}

/** Applies the exact production normalizer, mapper, projection and mixed-record validator. */
export function validatePhygitalsMappingAdmission(value: unknown): PhygitalsMappingAdmission {
  const integration = createProviderDataforrestLiveIntegration(
    "phygitals", dataforrestPhygitalsDistributedSourceAdapterManifest,
  );
  const page = dataforrestEventsPageV1Schema.safeParse(value);
  if (!page.success || page.data.records.length !== 100) {
    return refusePhygitalsReplay("PHYGITALS_MAPPING_PROBE_SHAPE_INVALID");
  }
  const mapper = createProviderObservationMapperRegistryFromManifest().resolve(integration.mapper);
  let chaseCount = 0;
  let assetCount = 0;
  try {
    for (const [position, raw] of page.data.records.entries()) {
      const record = dataforrestEventRecordV1Schema.parse(raw);
      if (record.platform !== "phygitals" || record.stream !== "catalog" || record.entity !== "card") {
        refusePhygitalsReplay("PHYGITALS_MAPPING_PROBE_SHAPE_INVALID");
      }
      const observation = normalizeDataforrestEventRecordForAdapter(
        record, "phygitals", `admission_record:${position}`, integration.manifest.adapterVersion,
      );
      const context = {
        organizationId: phygitalsReplayPins.organizationId,
        providerId: phygitalsReplayPins.providerId,
        ...integration.mapper,
        observation,
      };
      const mapped = mapper.map(context);
      if (mapped.status !== "mapped" || mapped.candidate.candidateKind !== "catalog_asset") {
        refusePhygitalsReplay("PHYGITALS_MAPPING_PROBE_REJECTED");
      }
      providerSourceCanonicalProjectionsForValidatedMapping(mapped, context);
      const draft = collectibleDraft(mapped.candidate);
      const validated = validateProviderMixedPageRecord({
        ...draft, position, providerId: phygitalsReplayPins.providerId,
      }, { providerId: phygitalsReplayPins.providerId, position });
      if (
        validated.disposition === "quarantine" ||
        validated.candidate.collectibleKey !== `card:${record.record_id}` ||
        validated.candidate.valuationAmount !== null ||
        validated.candidate.valuationCurrency !== null
      ) refusePhygitalsReplay("PHYGITALS_MAPPING_PROBE_REJECTED");
      if (Object.hasOwn(record.data, "chase")) chaseCount += 1;
      if (Object.hasOwn(record.data, "asset")) assetCount += 1;
    }
  } catch {
    return refusePhygitalsReplay("PHYGITALS_MAPPING_PROBE_REJECTED");
  }
  if (chaseCount < 1 || assetCount < 1 || chaseCount + assetCount !== 100) {
    refusePhygitalsReplay("PHYGITALS_MAPPING_PROBE_WRAPPER_COVERAGE_INVALID");
  }
  return Object.freeze({
    checkKind: "bounded_phygitals_native_card_mapping",
    adapterVersion: integration.manifest.adapterVersion,
    mapperKey: integration.mapper.mapperKey,
    mapperVersion: integration.mapper.mapperVersion,
    recordCount: 100, collectibleCount: 100, quarantineCount: 0,
    chaseCount, assetCount,
  });
}

export async function probePhygitalsCardMapping(
  token: string,
  captureResponse: typeof captureHardenedProviderResponse = captureHardenedProviderResponse,
) {
  const manifest = dataforrestPhygitalsDistributedSourceAdapterManifest;
  const endpoint = new URL(DATAFORREST_EVENTS_V1_ENDPOINT);
  endpoint.searchParams.set("platform", "phygitals");
  endpoint.searchParams.set("limit", "100");
  const response = await captureResponse({
    url: endpoint, allowedHosts: [endpoint.hostname],
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    timeoutMilliseconds: manifest.requestBounds.timeoutMilliseconds,
    maximumResponseBytes: manifest.requestBounds.maximumResponseBytes,
    signal: new AbortController().signal,
  });
  try {
    if (response.status !== 200) refusePhygitalsReplay("PHYGITALS_MAPPING_PROBE_STATUS_INVALID");
    const proof = validatePhygitalsMappingAdmission(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(response.protectedBody),
    ));
    return Object.freeze({ ...proof,
      responseStatus: response.status, responseBytes: response.responseBytes,
      durationMilliseconds: response.durationMilliseconds, checkedAt: new Date().toISOString(),
    });
  } finally {
    response.protectedBody.fill(0);
  }
}

/** Called only while the replay utility owns the exact provider import lease. */
export async function executeGuardedPhygitalsReplay(input: Readonly<{
  readCheckpoint: () => Promise<PhygitalsReplaySnapshot>;
  activate: () => Promise<void>;
  synchronize: () => Promise<void>;
}>): Promise<PhygitalsReplaySnapshot> {
  const phase = assertPhygitalsReplaySnapshot(await input.readCheckpoint());
  await input.activate();
  if (assertPhygitalsReplaySnapshot(await input.readCheckpoint()) !== phase) {
    refusePhygitalsReplay("PHYGITALS_REPLAY_CHECKPOINT_CHANGED");
  }
  await input.synchronize();
  const after = await input.readCheckpoint();
  if (assertPhygitalsReplaySnapshot(after) !== "prepared") {
    refusePhygitalsReplay("PHYGITALS_REPLAY_PREPARATION_FAILED");
  }
  return after;
}
