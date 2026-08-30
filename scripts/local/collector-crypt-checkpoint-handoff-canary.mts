import {
  dataforrestCollectorCryptDistributedSourceAdapterManifest as manifest,
  dataforrestEventRecordV1Schema,
  dataforrestEventsConnectionConfigurationV1Schema,
  dataforrestEventsPageV1Schema,
} from "@packscout/contracts";
import { captureHardenedProviderResponse } from "@packscout/services";
import { collectorHandoff, handoffDigest, refuseHandoff } from "./collector-crypt-checkpoint-handoff-plan.mts";

export interface CollectorHandoffCanary {
  readonly checkKind: "collector_saved_cursor_1000_record_canary";
  readonly adapterKey: string;
  readonly previousConfigId: string;
  readonly nextConfigId: string;
  readonly opaqueValueHash: string;
  readonly responseStatus: number;
  readonly responseBytes: number;
  readonly durationMilliseconds: number;
  readonly requestedRecords: 1000;
  readonly recordCount: number;
  readonly checkedAt: string;
}

/** Inspection only: the body is erased; no cursor or canonical state is advanced. */
export async function probeCollectorHandoff(input: Readonly<{
  token: string; opaqueCursor: string; previousConfigId: string; nextConfigId: string;
  captureResponse?: typeof captureHardenedProviderResponse;
}>): Promise<CollectorHandoffCanary> {
  if (!dataforrestEventsConnectionConfigurationV1Schema.safeParse({
    endpoint: collectorHandoff.endpoint, bearerToken: input.token,
  }).success || input.opaqueCursor.length === 0 || input.opaqueCursor.length > 16_384) {
    refuseHandoff("HANDOFF_CANARY_AUTHORITY_INVALID");
  }
  const url = new URL(collectorHandoff.endpoint);
  url.searchParams.set("platform", collectorHandoff.providerKey);
  url.searchParams.set("limit", "1000");
  url.searchParams.set("cursor", input.opaqueCursor);
  let response;
  try {
    response = await (input.captureResponse ?? captureHardenedProviderResponse)({
      url, allowedHosts: [url.hostname], headers: { Accept: "application/json", Authorization: `Bearer ${input.token}` },
      timeoutMilliseconds: manifest.requestBounds.timeoutMilliseconds,
      maximumResponseBytes: manifest.requestBounds.maximumResponseBytes,
      signal: new AbortController().signal,
    });
  } catch { return refuseHandoff("HANDOFF_CANARY_TRANSPORT_FAILED"); }
  try {
    if (response.status !== 200) refuseHandoff("HANDOFF_CANARY_STATUS_INVALID");
    if (response.responseBytes > manifest.requestBounds.maximumResponseBytes ||
      response.protectedBody.byteLength > manifest.requestBounds.maximumResponseBytes) {
      refuseHandoff("HANDOFF_CANARY_BYTE_LIMIT");
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.protectedBody)); }
    catch { return refuseHandoff("HANDOFF_CANARY_JSON_INVALID"); }
    const page = dataforrestEventsPageV1Schema.safeParse(value);
    if (!page.success || page.data.records.length !== 1_000 || page.data.next_cursor === null ||
      page.data.poll_after_seconds !== 0 || page.data.records.some((raw) => {
        const record = dataforrestEventRecordV1Schema.safeParse(raw);
        return !record.success || record.data.platform !== collectorHandoff.providerKey;
      })) refuseHandoff("HANDOFF_CANARY_PAGE_INVALID");
    return { checkKind: "collector_saved_cursor_1000_record_canary", adapterKey: manifest.adapterVersion,
      previousConfigId: input.previousConfigId, nextConfigId: input.nextConfigId,
      opaqueValueHash: handoffDigest(input.opaqueCursor), responseStatus: response.status,
      responseBytes: response.responseBytes, durationMilliseconds: response.durationMilliseconds,
      requestedRecords: 1000, recordCount: page.data.records.length, checkedAt: new Date().toISOString() };
  } finally { response.protectedBody.fill(0); }
}
