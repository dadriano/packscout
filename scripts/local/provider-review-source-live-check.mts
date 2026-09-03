import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  dataforrestEventRecordV1Schema,
  dataforrestEventsPageV1Schema,
  dataforrestLaunchDistributedSourceAdapterManifest,
} from "@packscout/contracts";
import {
  DataforrestEventsSourceAdapter,
  HardenedProviderRequestError,
  captureHardenedProviderResponse,
} from "@packscout/services";
import { isBoundedDataforrestEventsPageV1 } from
  "../../packages/services/src/dataforrest-events-page-interpreter.ts";
import {
  ProviderReviewProvisionError,
  type AdditionalProviderKey,
} from "./provider-review-database-plan.mts";

export interface ProviderReviewSourceLiveCheckResult {
  readonly durationMilliseconds: number;
  readonly recordCount: number;
  readonly responseBytes: number;
  readonly responseStatus: number;
}

type CaptureProviderResponse = typeof captureHardenedProviderResponse;

function refuse(code: string): never {
  throw new ProviderReviewProvisionError(code);
}

function safeTransportFailure(error: HardenedProviderRequestError): never {
  if (error.code === "http_status") {
    if (error.safeStatus === 401) refuse("SOURCE_LIVE_CHECK_AUTHENTICATION_FAILED");
    if (error.safeStatus === 403) refuse("SOURCE_LIVE_CHECK_AUTHORIZATION_FAILED");
    if (error.safeStatus === 429) refuse("SOURCE_LIVE_CHECK_RATE_LIMITED");
  }
  const normalized = error.code.toUpperCase().replaceAll(/[^A-Z0-9_]/gu, "_");
  return refuse(`SOURCE_LIVE_CHECK_${normalized}`);
}

/**
 * Reads one bounded record through the hardened transport. The protected body
 * is zeroed after validation and neither the token nor response body is
 * returned to the provisioning caller.
 */
export async function runBoundedProviderReviewSourceLiveCheck(input: Readonly<{
  providerKey: AdditionalProviderKey;
  token: string;
  captureResponse?: CaptureProviderResponse;
}>): Promise<Readonly<ProviderReviewSourceLiveCheckResult>> {
  const manifest = dataforrestLaunchDistributedSourceAdapterManifest;
  const adapter = new DataforrestEventsSourceAdapter({}, manifest);
  if (
    !adapter.validateConnectionConfiguration({
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerToken: input.token,
    }).ok ||
    !adapter.validateSourceConfiguration(
      input.providerKey,
      { platform: input.providerKey },
    ).ok
  ) {
    refuse("SOURCE_LIVE_CHECK_CONFIGURATION_INVALID");
  }
  const endpoint = new URL(DATAFORREST_EVENTS_V1_ENDPOINT);
  endpoint.searchParams.set("platform", input.providerKey);
  endpoint.searchParams.set("limit", "1");
  let capture: Awaited<ReturnType<CaptureProviderResponse>>;
  try {
    capture = await (input.captureResponse ?? captureHardenedProviderResponse)({
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
    return refuse("SOURCE_LIVE_CHECK_NETWORK_INTERRUPTION");
  }
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(capture.protectedBody),
      );
    } catch {
      return refuse("SOURCE_LIVE_CHECK_RESPONSE_INVALID");
    }
    if (!isBoundedDataforrestEventsPageV1(parsed, 1)) {
      refuse("SOURCE_LIVE_CHECK_RESPONSE_INVALID");
    }
    const page = dataforrestEventsPageV1Schema.safeParse(parsed);
    if (
      !page.success || page.data.records.length !== 1 ||
      page.data.records.some((record) => {
        const parsedRecord = dataforrestEventRecordV1Schema.safeParse(record);
        return !parsedRecord.success ||
          parsedRecord.data.platform !== input.providerKey;
      })
    ) {
      refuse(page.success && page.data.records.length === 0
        ? "SOURCE_LIVE_CHECK_EMPTY"
        : "SOURCE_LIVE_CHECK_RESPONSE_INVALID");
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
