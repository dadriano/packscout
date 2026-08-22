import { createHash } from "node:crypto";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_SOURCE_CONTRACT_VERSION,
  dataforrestIdentityNamespaceByProvider,
  emptyNormalizedProviderFacts,
  launchRecordIdScopeDeclarations,
  sourceAdapterManifestV1Schema,
  type LaunchProviderKey,
} from "@packscout/contracts";
import {
  SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
  type ConnectionTestInterpretationContext,
  type PageReadInterpretationContext,
  type SourceAdapter,
  type SourceAdapterCaptureInvocation,
  type SourceAdapterInterpretationResult,
  type SourceAdapterOperation,
  type SourceAdapterPageInterpretationResult,
  type SourceTestInterpretationContext,
  type SuccessfulSourceAdapterRequest,
  type UnboundSourceAdapterRequestResult,
} from "./source-adapter.ts";
import type { SourceRequestLease } from "./source-request-lease.ts";

export const alternateBookmarkSourceManifest = sourceAdapterManifestV1Schema.parse({
  providerSourceContractVersion: PROVIDER_SOURCE_CONTRACT_VERSION,
  sourceTypeKey: "alternate-bookmark-v1",
  adapterVersion: "alternate-bookmark-adapter-v1",
  normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
  compatibleConnectionTypeKey: "alternate-connection-v1",
  checkpointCodecKey: "alternate-bookmark-codec-v1",
  operatorLabel: "Alternate bookmark fixture",
  requestBounds: {
    pageLimit: 250,
    maximumResponseBytes: 2_097_152,
    timeoutMilliseconds: 10_000,
  },
  maximumConnectionRequestCap: 2,
  capabilities: {
    connectionTest: true,
    sourceTest: true,
    pageRead: true,
    cancellation: true,
  },
  supportedProviders: [{
    provider: "courtyard",
    identityNamespaceKey: dataforrestIdentityNamespaceByProvider.courtyard,
    recordIdScopes: [...launchRecordIdScopeDeclarations],
  }],
});

export function alternateBookmarkWrapper(
  bookmark = "alternate-bookmark-001",
  key = "alternate-pack-001",
) {
  return Object.freeze({
    items: [{
      category: "pack" as const,
      key,
      effective: "2026-01-01T00:00:00.000Z",
      observed: "2026-01-01T00:00:01.000Z",
      firstSeen: "2026-01-01T00:00:00.000Z",
      inStock: null,
    }],
    continuation: {
      bookmark,
      signal: "sleep" as const,
      delaySeconds: 60 as const,
    },
  });
}

export const defaultAlternateBookmarkWrapper = alternateBookmarkWrapper();

interface AlternateWrapper {
  readonly items: readonly Readonly<{
    category: "pack";
    key: string;
    effective: string;
    observed: string;
    firstSeen: string;
    inStock: boolean | null;
  }>[];
  readonly continuation: Readonly<{
    bookmark: string;
    signal: "sleep";
    delaySeconds: 60;
  }>;
}

function hasExactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function decodeAlternate(
  request: SuccessfulSourceAdapterRequest,
): AlternateWrapper | null {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      request.value.protectedRawResponse,
    )) as unknown;
    if (
      !hasExactObjectKeys(value, ["continuation", "items"]) ||
      !Array.isArray(value.items) ||
      value.items.length !== 1 ||
      !hasExactObjectKeys(value.continuation, [
        "bookmark",
        "delaySeconds",
        "signal",
      ]) ||
      typeof value.continuation.bookmark !== "string" ||
      !/^alternate-bookmark-[0-9]{3}$/u.test(value.continuation.bookmark) ||
      value.continuation.signal !== "sleep" ||
      value.continuation.delaySeconds !== 60
    ) return null;
    for (const item of value.items) {
      if (
        !hasExactObjectKeys(item, [
          "category",
          "effective",
          "firstSeen",
          "inStock",
          "key",
          "observed",
        ]) ||
        item.category !== "pack" ||
        typeof item.key !== "string" ||
        !item.key.startsWith("alternate-") ||
        typeof item.effective !== "string" ||
        typeof item.observed !== "string" ||
        typeof item.firstSeen !== "string" ||
        (item.inStock !== null && typeof item.inStock !== "boolean")
      ) return null;
    }
    return value as unknown as AlternateWrapper;
  } catch {
    return null;
  }
}

export class AlternateBookmarkSourceAdapter implements SourceAdapter {
  readonly manifest = alternateBookmarkSourceManifest;
  readonly #payload: unknown;
  captureCount = 0;

  constructor(payload: unknown = defaultAlternateBookmarkWrapper) {
    this.#payload = payload;
  }

  validateConnectionConfiguration(configuration: unknown) {
    const valid = hasExactObjectKeys(configuration, ["channel"]) &&
      configuration.channel === "fixture";
    return valid
      ? { ok: true as const, value: Object.freeze({ channel: "fixture" }) }
      : {
          ok: false as const,
          failure: {
            disposition: "connection_action_required" as const,
            code: "profile_configuration_invalid" as const,
          },
        };
  }

  validateSourceConfiguration(
    provider: LaunchProviderKey,
    configuration: unknown,
  ) {
    const valid = provider === "courtyard" &&
      hasExactObjectKeys(configuration, ["partition"]) &&
      configuration.partition === "courtyard";
    return valid
      ? { ok: true as const, value: Object.freeze({ partition: "courtyard" }) }
      : {
          ok: false as const,
          failure: {
            disposition: "source_action_required" as const,
            code: "invalid_source_configuration" as const,
          },
        };
  }

  async captureUnboundRequest(
    operation: SourceAdapterOperation,
    invocation: SourceAdapterCaptureInvocation,
  ): Promise<UnboundSourceAdapterRequestResult> {
    invocation.consume(operation);
    this.captureCount += 1;
    const bytes = new TextEncoder().encode(JSON.stringify(this.#payload));
    return {
      ok: true,
      value: {
        captureVersion: SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
        protectedRawResponse: bytes,
        protectedRawResponseSha256: createHash("sha256")
          .update(bytes)
          .digest("hex"),
      },
      measurements: { durationMilliseconds: 1, responseBytes: bytes.byteLength },
      diagnostics: [{
        severity: "info",
        phase: "request_capture",
        code: "response_captured",
      }],
    };
  }

  async interpretConnectionTest(
    _context: ConnectionTestInterpretationContext,
    request: SuccessfulSourceAdapterRequest,
  ): Promise<SourceAdapterInterpretationResult<{ status: "reachable" }>> {
    if (decodeAlternate(request) === null) {
      return {
        ok: false,
        failure: {
          disposition: "connection_action_required",
          code: "profile_configuration_invalid",
        },
        recordCount: 0,
        diagnostics: [],
      };
    }
    return {
      ok: true,
      value: { status: "reachable" },
      recordCount: 0,
      diagnostics: [],
    };
  }

  async interpretSourceTest(
    _context: SourceTestInterpretationContext,
    request: SuccessfulSourceAdapterRequest,
  ): Promise<SourceAdapterInterpretationResult<{
    status: "readable";
    provider: "courtyard";
  }>> {
    const wrapper = decodeAlternate(request);
    if (wrapper === null) {
      return {
        ok: false,
        failure: { disposition: "source_action_required", code: "invalid_response" },
        recordCount: 0,
        diagnostics: [],
      };
    }
    return {
      ok: true,
      value: { status: "readable", provider: "courtyard" },
      recordCount: wrapper.items.length,
      diagnostics: [],
    };
  }

  async interpretPage(
    context: PageReadInterpretationContext,
    request: SuccessfulSourceAdapterRequest,
  ): Promise<SourceAdapterPageInterpretationResult> {
    const wrapper = decodeAlternate(request);
    if (wrapper === null) {
      return {
        ok: false,
        failure: { disposition: "source_action_required", code: "invalid_response" },
        diagnostics: [],
      };
    }
    if (
      context.requestedCheckpoint.value !== null &&
      !/^alternate-bookmark-[0-9]{3}$/u.test(
        context.requestedCheckpoint.value,
      )
    ) {
      return {
        ok: false,
        failure: { disposition: "source_action_required", code: "invalid_checkpoint" },
        diagnostics: [],
      };
    }
    const record = wrapper.items[0]!;
    return {
      ok: true,
      value: {
        protectedNativeEvidence: [{ reference: "source_record:0", value: record }],
        normalizedPage: {
          normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
          provider: context.provider,
          outcomes: [{
            status: "valid",
            recordIndex: 0,
            observation: {
              kind: "catalog",
              entity: "pack",
              providerRecordIdentity: {
                recordIdScopeKey: "catalog-pack-v1",
                providerRecordId: record.key,
              },
              effectiveAt: record.effective,
              collectedAt: record.observed,
              firstSeenAt: record.firstSeen,
              availability: "unknown",
              providerFacts: {
                ...emptyNormalizedProviderFacts("pack"),
                displayName: {
                  state: "present",
                  value: "Alternate bookmark pack",
                },
              },
              relationships: [],
              protectedNativeEvidenceRef: "source_record:0",
            },
          }],
          nextCheckpoint: {
            ...context.requestedCheckpoint,
            value: wrapper.continuation.bookmark,
          },
          continuation: {
            kind: "poll_after",
            minimumDelaySeconds: wrapper.continuation.delaySeconds,
          },
        },
      },
      diagnostics: [{
        severity: "info",
        phase: "response_interpretation",
        code: "page_valid",
      }],
    };
  }

  cancelRequest(lease: SourceRequestLease): void {
    lease.cancel();
  }
}
