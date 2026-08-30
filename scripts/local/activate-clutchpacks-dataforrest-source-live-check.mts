import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestEventRecordV1Schema,
  dataforrestEventsPageV1Schema,
} from "@packscout/contracts";
import {
  DataforrestEventsSourceAdapter,
  HardenedProviderRequestError,
  captureHardenedProviderResponse,
} from "@packscout/services";
import { isBoundedDataforrestEventsPageV1 } from
  "../../packages/services/src/dataforrest-events-page-interpreter.ts";
import { ClutchpacksDataforrestActivationError } from
  "./activate-clutchpacks-dataforrest-source-plan.mjs";

export interface ClutchpacksDataforrestLiveCheckResult {
  readonly durationMilliseconds: number;
  readonly recordCount: number;
  readonly responseBytes: number;
  readonly responseStatus: number;
}

function refuse(code: string): never {
  throw new ClutchpacksDataforrestActivationError(code);
}

function safeTransportFailure(error: HardenedProviderRequestError): never {
  if (error.code === "http_status") {
    if (error.safeStatus === 401) {
      refuse("DATAFORREST_LIVE_CHECK_AUTHENTICATION_FAILED");
    }
    if (error.safeStatus === 403) {
      refuse("DATAFORREST_LIVE_CHECK_AUTHORIZATION_FAILED");
    }
    if (error.safeStatus === 429) {
      refuse("DATAFORREST_LIVE_CHECK_RATE_LIMITED");
    }
  }
  const normalized = error.code.toUpperCase().replaceAll(/[^A-Z0-9_]/gu, "_");
  return refuse(`DATAFORREST_LIVE_CHECK_${normalized}`);
}

/**
 * Makes one bounded, provider-specific request through the hardened provider
 * transport. Protected response bytes remain process-local and are cleared as
 * soon as the canonical DataForrest contract has been checked.
 */
export async function runBoundedClutchpacksDataforrestLiveCheck(input: Readonly<{
  token: string;
}>): Promise<ClutchpacksDataforrestLiveCheckResult> {
  const manifest = dataforrestClutchpacksDistributedSourceAdapterManifest;
  const adapter = new DataforrestEventsSourceAdapter({}, manifest);
  if (
    !adapter.validateConnectionConfiguration({
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerToken: input.token,
    }).ok ||
    !adapter.validateSourceConfiguration(
      "clutchpacks",
      { platform: "clutchpacks" },
    ).ok
  ) {
    refuse("DATAFORREST_LIVE_CHECK_CONFIGURATION_INVALID");
  }
  const endpoint = new URL(DATAFORREST_EVENTS_V1_ENDPOINT);
  endpoint.searchParams.set("platform", "clutchpacks");
  endpoint.searchParams.set("limit", "1");
  let capture: Awaited<ReturnType<typeof captureHardenedProviderResponse>>;
  try {
    capture = await captureHardenedProviderResponse({
      url: endpoint,
      allowedHosts: [endpoint.hostname],
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.token}`,
      },
      timeoutMilliseconds: manifest.requestBounds.timeoutMilliseconds,
      maximumResponseBytes: manifest.requestBounds.maximumResponseBytes,
      signal: new AbortController().signal,
    });
  } catch (error) {
    if (error instanceof HardenedProviderRequestError) {
      return safeTransportFailure(error);
    }
    return refuse("DATAFORREST_LIVE_CHECK_NETWORK_INTERRUPTION");
  }
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(capture.protectedBody),
      );
    } catch {
      return refuse("DATAFORREST_LIVE_CHECK_RESPONSE_INVALID");
    }
    if (!isBoundedDataforrestEventsPageV1(parsed, 1)) {
      refuse("DATAFORREST_LIVE_CHECK_RESPONSE_INVALID");
    }
    const page = dataforrestEventsPageV1Schema.safeParse(parsed);
    if (
      !page.success || page.data.records.length < 1 ||
      page.data.records.some((record) => {
        const parsedRecord = dataforrestEventRecordV1Schema.safeParse(record);
        return !parsedRecord.success || parsedRecord.data.platform !== "clutchpacks";
      })
    ) {
      refuse(page.success && page.data.records.length === 0
        ? "DATAFORREST_LIVE_CHECK_EMPTY"
        : "DATAFORREST_LIVE_CHECK_RESPONSE_INVALID");
    }
    return Object.freeze({
      durationMilliseconds: capture.durationMilliseconds,
      recordCount: page.data.records.length,
      responseBytes: capture.responseBytes,
      responseStatus: capture.status,
    });
  } finally {
    capture.protectedBody.fill(0);
  }
}
