import { createHash } from "node:crypto";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  dataforrestEventRecordV1Schema,
  dataforrestEventsPageV1Schema,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
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
  const bytes = createHash("sha256").update(`packscout.local.phygitals.card-replay-v4:${label}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const phygitalsV4ReplayPins = Object.freeze({
  providerId: "5034af05-8976-5da8-85bb-2d6eac02515c",
  organizationId: "3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a",
  providerKey: "phygitals",
  previousConfigId: "1359d83b-6c95-57cf-9a60-06bad470b3b4",
  sourceCredentialId: "f7d8f26a-1a07-4ada-a05e-5617a2893645",
  databaseCredentialId: "01a85d79-7d69-5f8d-8879-1a13ccebf09c",
  nodeId: "046bb731-8a8e-5d7a-9b57-9f91d27bd725",
  stoppedRunId: "d5f84568-9a2c-4fdc-a11f-b5858e97e278",
  stoppedCommandId: "c8d886fe-242a-45dd-8e9a-2ca0e41cc977",
  stoppedAt: "2026-08-30T01:24:22.377Z",
  cursorHash: "e0ec8b27a3e68d70e77190d7ea948a855f137ad07dddaf76e88db476ed848eeb",
  configId: deterministicId("config"),
  activationTestId: deterministicId("activation"),
  auditId: deterministicId("central-audit"),
  correlationId: deterministicId("local-replay-preparation"),
  owner: "local:phygitals:card-replay-v4",
  canonicalIdentityDigest: "51baf5602a77735eea2b4180af76e0873f3af28d91be3f46fe4d46feb311cb35",
  firstRunId: "b3f721f8-37fb-4961-8756-ee11819a66ec",
});

export class PhygitalsCardV4ReplayError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PhygitalsCardV4ReplayError";
  }
}

export function refusePhygitalsV4Replay(code: string): never {
  throw new PhygitalsCardV4ReplayError(code);
}

export interface PhygitalsV4ReplaySnapshot {
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
  readonly canonicalIdentityDigest: string;
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
    workerFence: string;
  }> | null;
}

/** Exact one-time recovery envelope. It deliberately refuses subsequent imports. */
export function assertPhygitalsV4ReplaySnapshot(snapshot: PhygitalsV4ReplaySnapshot): "previous" | "prepared" {
  const pins = phygitalsV4ReplayPins;
  const run = snapshot.run;
  const previous = snapshot.cachedConfigId === pins.previousConfigId &&
    snapshot.cachedConfigNumber === "3" && snapshot.cursorHash === pins.cursorHash && snapshot.cursorPresent;
  const prepared = snapshot.cachedConfigId === pins.configId &&
    snapshot.cachedConfigNumber === "4" && snapshot.cursorHash === null && !snapshot.cursorPresent;
  if (
    snapshot.providerId !== pins.providerId || snapshot.providerKey !== pins.providerKey ||
    snapshot.databaseRole !== "provider" || snapshot.schemaVersion !== "distributed-provider-v1" ||
    snapshot.runtimeState !== "idle" || snapshot.generation !== "4" ||
    (!previous && !prepared) || !snapshot.cursorFingerprintMatches || snapshot.activeRunCount !== 0 ||
    snapshot.actionableCommandCount !== 0 || snapshot.runCount !== 2 ||
    snapshot.commandCount !== 2 || snapshot.canonicalCount !== 741 ||
    snapshot.canonicalIdentityDigest !== pins.canonicalIdentityDigest ||
    snapshot.promotionChangeCount !== 741 || snapshot.pageCount !== 284 ||
    snapshot.quarantineCount !== 15_092 || snapshot.exactHistoricalQuarantineCount !== 15_092 ||
    run === null || run.id !== pins.stoppedRunId || run.state !== "incomplete" ||
    run.configId !== pins.previousConfigId || run.configNumber !== "3" ||
    run.commandId !== pins.stoppedCommandId || run.pageCount !== 151 ||
    run.catalogCount !== 15_100 || run.pullCount !== 0 || run.marketCount !== 0 ||
    run.acceptedCount !== 741 || run.duplicateCount !== 12_567 ||
    run.quarantinedCount !== 1_792 || run.materialChangeCount !== 741 ||
    run.finalCursorHash !== pins.cursorHash || run.reachedHead ||
    run.failureCode !== "SOURCE_RECORD_MAPPING_INVALID" || run.finishedAt !== pins.stoppedAt ||
    run.workerFence !== "3"
  ) refusePhygitalsV4Replay("PHYGITALS_REPLAY_CHECKPOINT_UNEXPECTED");
  return previous ? "previous" : "prepared";
}

export interface PhygitalsV4MappingAdmission {
  readonly checkKind: "bounded_phygitals_native_card_mapping";
  readonly adapterVersion: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly recordCount: number;
  readonly collectibleCount: number;
  readonly quarantineCount: 0;
  readonly chaseCount: number;
  readonly assetCount: number;
  readonly inventoryCount: number;
  readonly nftCount: number;
}

/** Applies the exact production normalizer, mapper, projection and mixed-record validator. */
export function validatePhygitalsV4MappingAdmission(value: unknown): PhygitalsV4MappingAdmission {
  const integration = createProviderDataforrestLiveIntegration(
    "phygitals", dataforrestPhygitalsDistributedV2SourceAdapterManifest,
  );
  const page = dataforrestEventsPageV1Schema.safeParse(value);
  if (!page.success || page.data.records.length !== 100) {
    return refusePhygitalsV4Replay("PHYGITALS_MAPPING_PROBE_SHAPE_INVALID");
  }
  const mapper = createProviderObservationMapperRegistryFromManifest().resolve(integration.mapper);
  let chaseCount = 0;
  let assetCount = 0;
  let inventoryCount = 0;
  let nftCount = 0;
  try {
    for (const [position, raw] of page.data.records.entries()) {
      const record = dataforrestEventRecordV1Schema.parse(raw);
      if (record.platform !== "phygitals" || record.stream !== "catalog" || record.entity !== "card") {
        refusePhygitalsV4Replay("PHYGITALS_MAPPING_PROBE_SHAPE_INVALID");
      }
      const observation = normalizeDataforrestEventRecordForAdapter(
        record, "phygitals", `admission_record:${position}`, integration.manifest.adapterVersion,
      );
      const context = {
        organizationId: phygitalsV4ReplayPins.organizationId,
        providerId: phygitalsV4ReplayPins.providerId,
        ...integration.mapper,
        observation,
      };
      const mapped = mapper.map(context);
      if (mapped.status !== "mapped" || mapped.candidate.candidateKind !== "catalog_asset") {
        refusePhygitalsV4Replay("PHYGITALS_MAPPING_PROBE_REJECTED");
      }
      providerSourceCanonicalProjectionsForValidatedMapping(mapped, context);
      const draft = collectibleDraft(mapped.candidate);
      const validated = validateProviderMixedPageRecord({
        ...draft, position, providerId: phygitalsV4ReplayPins.providerId,
      }, { providerId: phygitalsV4ReplayPins.providerId, position });
      if (
        validated.disposition === "quarantine" ||
        validated.candidate.collectibleKey !== `card:${record.record_id}` ||
        validated.candidate.valuationAmount !== null ||
        validated.candidate.valuationCurrency !== null
      ) refusePhygitalsV4Replay("PHYGITALS_MAPPING_PROBE_REJECTED");
      if (Object.hasOwn(record.data, "chase")) chaseCount += 1;
      else if (Object.hasOwn(record.data, "asset")) assetCount += 1;
      else if (Object.hasOwn(record.data, "inventory")) inventoryCount += 1;
      else if (Object.hasOwn(record.data, "nft")) nftCount += 1;
    }
  } catch {
    return refusePhygitalsV4Replay("PHYGITALS_MAPPING_PROBE_REJECTED");
  }
  if (chaseCount + assetCount + inventoryCount + nftCount !== 100) {
    refusePhygitalsV4Replay("PHYGITALS_MAPPING_PROBE_WRAPPER_COVERAGE_INVALID");
  }
  return Object.freeze({
    checkKind: "bounded_phygitals_native_card_mapping",
    adapterVersion: integration.manifest.adapterVersion,
    mapperKey: integration.mapper.mapperKey,
    mapperVersion: integration.mapper.mapperVersion,
    recordCount: 100, collectibleCount: 100, quarantineCount: 0,
    chaseCount, assetCount, inventoryCount, nftCount,
  });
}

export async function probePhygitalsV4CardMapping(
  token: string,
  cursor: string | null,
  captureResponse: typeof captureHardenedProviderResponse = captureHardenedProviderResponse,
) {
  const manifest = dataforrestPhygitalsDistributedV2SourceAdapterManifest;
  const endpoint = new URL(DATAFORREST_EVENTS_V1_ENDPOINT);
  endpoint.searchParams.set("platform", "phygitals");
  endpoint.searchParams.set("limit", "100");
  if (cursor !== null) endpoint.searchParams.set("cursor", cursor);
  const response = await captureResponse({
    url: endpoint, allowedHosts: [endpoint.hostname],
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    timeoutMilliseconds: manifest.requestBounds.timeoutMilliseconds,
    maximumResponseBytes: manifest.requestBounds.maximumResponseBytes,
    signal: new AbortController().signal,
  });
  try {
    if (response.status !== 200) refusePhygitalsV4Replay("PHYGITALS_MAPPING_PROBE_STATUS_INVALID");
    const proof = validatePhygitalsV4MappingAdmission(JSON.parse(
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
export async function executeGuardedPhygitalsV4Replay(input: Readonly<{
  readCheckpoint: () => Promise<PhygitalsV4ReplaySnapshot>;
  activate: () => Promise<void>;
  synchronize: () => Promise<void>;
}>): Promise<PhygitalsV4ReplaySnapshot> {
  const phase = assertPhygitalsV4ReplaySnapshot(await input.readCheckpoint());
  await input.activate();
  if (assertPhygitalsV4ReplaySnapshot(await input.readCheckpoint()) !== phase) {
    refusePhygitalsV4Replay("PHYGITALS_REPLAY_CHECKPOINT_CHANGED");
  }
  await input.synchronize();
  const after = await input.readCheckpoint();
  if (assertPhygitalsV4ReplaySnapshot(after) !== "prepared") {
    refusePhygitalsV4Replay("PHYGITALS_REPLAY_PREPARATION_FAILED");
  }
  return after;
}
