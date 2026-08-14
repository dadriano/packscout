import {
  providerRecordKindV2,
  providerStreamOrderingTimestampV2,
  type ProviderConnectionRecordCounts,
  type ProviderStreamRecordV2,
  type ProviderStreamValidatedPageV2,
} from "@packscout/contracts";

export type ProviderRecordKind = "catalog" | "pull" | "trade";
export type AdapterCandidateKind =
  | "catalog_asset"
  | "ev_input"
  | "pack"
  | "pull"
  | "trade";

export interface ProviderConfigurationIdentity {
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly platform: string;
  readonly adapterKey: string;
}

export interface ProviderSourceIdentity {
  readonly platform: string;
  readonly recordKind: ProviderRecordKind;
  readonly recordIndex: number;
  readonly externalId: string;
  readonly collectedAt: string;
  readonly sourceTimestamp: string;
}

export interface ProviderRelationshipKey {
  readonly entityKind: "catalog_asset" | "pack";
  readonly platform: string;
  readonly externalId: string;
  readonly relationship: "asset" | "parent" | "source" | "subject";
}

export interface ProviderDataQualityEvidence {
  readonly code: string;
  readonly severity: "info" | "warning";
  readonly fieldPath?: string;
}

export interface PseudonymousActorInput {
  readonly role: "actor" | "buyer" | "from" | "owner" | "seller" | "to";
  readonly namespace: string;
  readonly sourceIdentifier: string;
}

export interface AdapterMoney {
  /** Provider amount in major currency units; canonical projection stores minor units. */
  readonly amount: number;
  readonly currency: string;
}

export interface ProviderAdapterCandidateBase {
  readonly candidateKind: AdapterCandidateKind;
  readonly source: ProviderSourceIdentity;
  readonly relationships: readonly ProviderRelationshipKey[];
  readonly dataQualityEvidence: readonly ProviderDataQualityEvidence[];
}

export interface CanonicalPackCandidate extends ProviderAdapterCandidateBase {
  readonly candidateKind: "pack";
  readonly externalId: string;
  readonly parentExternalId: string | null;
  readonly name: string;
  readonly description?: string | null;
  readonly category?: string | null;
  readonly availability: "active" | "disabled" | "sold_out" | "unknown";
  readonly sourceStatus?: string | null;
  readonly price?: AdapterMoney | null;
  readonly imageUrls?: readonly string[];
  readonly providerReportedEv?: AdapterMoney | null;
  readonly buybackPercent?: number | null;
  readonly drawCount?: number | null;
}

export interface CatalogAssetCandidate extends ProviderAdapterCandidateBase {
  readonly candidateKind: "catalog_asset";
  readonly externalId: string;
  readonly assetType?: string | null;
  readonly relatedPackExternalId?: string | null;
  readonly parentExternalId?: string | null;
  readonly name?: string | null;
  readonly category?: string | null;
  readonly availability?: "active" | "disabled" | "sold_out" | "unknown";
  readonly sourceStatus?: string | null;
  readonly estimatedValue?: AdapterMoney | null;
  readonly valueSource?: string | null;
  readonly imageUrls?: readonly string[];
}

export interface PullCandidate extends ProviderAdapterCandidateBase {
  readonly candidateKind: "pull";
  readonly packExternalId: string | null;
  readonly assetExternalId: string | null;
  readonly occurredAt: string;
  readonly value?: AdapterMoney | null;
  readonly valueSource?: string | null;
  readonly buybackStatus?: string | null;
  readonly buybackRefund?: AdapterMoney | null;
  readonly pseudonymizationInputs: readonly PseudonymousActorInput[];
}

export interface TradeCandidate extends ProviderAdapterCandidateBase {
  readonly candidateKind: "trade";
  readonly eventType: string;
  readonly transactionKey: string;
  readonly assetExternalId: string | null;
  readonly packExternalId?: string | null;
  readonly occurredAt: string;
  readonly amount: AdapterMoney | null;
  readonly paymentMethod: string | null;
  readonly pseudonymizationInputs: readonly PseudonymousActorInput[];
}

export interface ProbabilityBucketInput {
  readonly bucketId: string;
  readonly evidenceKind: "probability_bucket" | "top_chase";
  readonly label?: string | null;
  readonly probability: number | null;
  readonly lowerValue: number | null;
  readonly upperValue: number | null;
}

export interface EvInputCandidate extends ProviderAdapterCandidateBase {
  readonly candidateKind: "ev_input";
  readonly externalId: string;
  readonly packExternalId: string;
  readonly currency: string | null;
  readonly unitBasis: "per_draw" | "per_pack" | null;
  readonly drawCount: number | null;
  readonly declaredCoverage: number | null;
  readonly evidenceCompleteness: "complete" | "partial" | "unknown";
  readonly buckets: readonly ProbabilityBucketInput[];
}

export type ProviderAdapterCandidate =
  | CanonicalPackCandidate
  | CatalogAssetCandidate
  | PullCandidate
  | TradeCandidate
  | EvInputCandidate;

export interface ProviderRecordMappingFailure {
  readonly reasonCode: string;
  readonly fieldPath: string;
}

export type ProviderRecordMappingOutcome =
  | {
      readonly status: "mapped";
      readonly source: ProviderSourceIdentity;
      readonly candidates: readonly ProviderAdapterCandidate[];
    }
  | {
      readonly status: "invalid";
      readonly source: ProviderSourceIdentity;
      readonly failure: ProviderRecordMappingFailure;
    };

export interface ProviderMappingRecordInput {
  readonly configuration: ProviderConfigurationIdentity;
  readonly record: ProviderStreamRecordV2;
  readonly recordIndex: number;
}

export interface ProviderAdapterIdentity {
  readonly key: string;
}

export interface ProviderMappingAdapter extends ProviderAdapterIdentity {
  readonly platformKey: string;
  mapRecord(
    input: ProviderMappingRecordInput,
  ): ProviderRecordMappingOutcome | Promise<ProviderRecordMappingOutcome>;
}

export type ProviderAuth =
  | { readonly mode: "none" }
  | { readonly mode: "bearer"; readonly token: string };

export interface ProviderTransportPageInput {
  readonly endpoint: string;
  readonly allowedHosts: readonly string[];
  readonly platform: string;
  readonly cursor: string | null;
  readonly auth: ProviderAuth;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly seenCursors?: ReadonlySet<string>;
  readonly allowLocalHttp?: boolean;
  readonly signal?: AbortSignal;
}

export type ProviderTransportConnectionInput = Omit<
  ProviderTransportPageInput,
  "cursor" | "seenCursors"
>;

export interface ProviderHttpResponseDecoderInputV2 {
  /** Bounded response text. The common transport does not interpret its format. */
  readonly bodyText: string;
  readonly contentType: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly requestedPlatform: string;
  readonly requestedCursor: string | null;
}

export interface ProviderHttpDecodedPageV2 {
  /** Exact protected response evidence in a JSON-compatible decoder-owned form. */
  readonly rawPage: unknown;
  readonly records: unknown;
  readonly nextCursor: unknown;
  readonly hasMore: unknown;
}

export type ProviderHttpResponseDecodeResultV2 =
  | {
      readonly ok: true;
      readonly page: ProviderHttpDecodedPageV2;
    }
  | {
      readonly ok: false;
      readonly code: "invalid_json" | "invalid_response";
      readonly fieldPaths?: readonly string[];
      readonly issueCodes?: readonly string[];
    };

/**
 * Provider-local response boundary. Implementations own serialization and raw
 * wrapper interpretation; the common HTTP transport owns neither.
 */
export interface ProviderHttpResponseDecoderV2 {
  decode(
    input: ProviderHttpResponseDecoderInputV2,
  ):
    | ProviderHttpResponseDecodeResultV2
    | Promise<ProviderHttpResponseDecodeResultV2>;
}

export type ProviderTransportFailureCode =
  | "destination_not_allowed"
  | "destination_resolution_failed"
  | "http_error"
  | "invalid_configuration"
  | "invalid_json"
  | "invalid_response"
  | "network_error"
  | "response_too_large"
  | "timeout";

export interface NormalizedProviderTransportFailure {
  readonly code: ProviderTransportFailureCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly fieldPaths?: readonly string[];
  readonly issueCodes?: readonly string[];
}

const failureMessages: Readonly<Record<ProviderTransportFailureCode, string>> = {
  destination_not_allowed: "Provider destination is not allowed.",
  destination_resolution_failed: "Provider destination could not be verified.",
  http_error: "Provider returned an unsuccessful response.",
  invalid_configuration: "Provider request configuration is invalid.",
  invalid_json: "Provider response is not valid JSON.",
  invalid_response: "Provider response failed contract validation.",
  network_error: "Provider request could not be completed.",
  response_too_large: "Provider response exceeded the allowed size.",
  timeout: "Provider request timed out.",
};

export class ProviderTransportRequestError extends Error {
  readonly failure: NormalizedProviderTransportFailure;

  constructor(failure: NormalizedProviderTransportFailure) {
    super(failureMessages[failure.code]);
    this.name = "ProviderTransportRequestError";
    this.failure = Object.freeze({
      code: failure.code,
      retryable: failure.retryable,
      ...(failure.httpStatus === undefined
        ? {}
        : { httpStatus: failure.httpStatus }),
      ...(failure.fieldPaths === undefined
        ? {}
        : { fieldPaths: Object.freeze([...failure.fieldPaths]) }),
      ...(failure.issueCodes === undefined
        ? {}
        : { issueCodes: Object.freeze([...failure.issueCodes]) }),
    });
  }
}

export type ProviderConnectionTestResult =
  | {
      readonly ok: true;
      readonly latencyMs: number;
      readonly responseStatus: number;
      readonly recordCounts: ProviderConnectionRecordCounts;
      readonly hasMore: boolean;
      readonly nextCursorPresent: boolean;
    }
  | {
      readonly ok: false;
      readonly latencyMs: number;
      readonly failure: NormalizedProviderTransportFailure;
    };

export interface ProviderTransportAdapter extends ProviderAdapterIdentity {
  supportsPlatform(platform: string): boolean;
  testConnection(
    input: ProviderTransportConnectionInput,
  ): Promise<ProviderConnectionTestResult>;
  fetchPage(
    input: ProviderTransportPageInput,
  ): Promise<ProviderStreamValidatedPageV2>;
}

export function sourceIdentityForRecord(
  input: Pick<ProviderMappingRecordInput, "record" | "recordIndex">,
): ProviderSourceIdentity {
  return {
    platform: input.record.platform,
    recordKind: providerRecordKindV2(input.record),
    recordIndex: input.recordIndex,
    externalId: input.record.record_id,
    collectedAt: input.record.collected_at,
    sourceTimestamp: providerStreamOrderingTimestampV2(input.record),
  };
}
