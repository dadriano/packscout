import type {
  CatalogEnvelopeV1,
  ProviderFeedEnvelopeV1,
  ProviderFeedPageV1,
  ProviderFeedValidatedPageV1,
  PullEnvelopeV1,
  SaleEnvelopeV1,
} from "@packscout/contracts";

export type ProviderRecordKind = "catalog" | "pull" | "sale";
export type AdapterCandidateKind =
  | "catalog_asset"
  | "ev_input"
  | "pack"
  | "pull"
  | "sale";

export interface ProviderConfigurationIdentity {
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly platform: string;
  readonly adapterKey: string;
}

export interface ProviderSourceIdentity {
  readonly platform: string;
  readonly recordKind: ProviderRecordKind;
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
  readonly price?: AdapterMoney | null;
  readonly imageUrls?: readonly string[];
  readonly providerReportedEv?: AdapterMoney | null;
}

export interface CatalogAssetCandidate extends ProviderAdapterCandidateBase {
  readonly candidateKind: "catalog_asset";
  readonly externalId: string;
  readonly name?: string | null;
  readonly category?: string | null;
  readonly estimatedValue?: AdapterMoney | null;
  readonly imageUrls?: readonly string[];
}

export interface PullCandidate extends ProviderAdapterCandidateBase {
  readonly candidateKind: "pull";
  readonly packExternalId: string | null;
  readonly assetExternalId: string | null;
  readonly occurredAt: string;
  readonly value?: AdapterMoney | null;
  readonly pseudonymizationInputs: readonly PseudonymousActorInput[];
}

export interface SaleCandidate extends ProviderAdapterCandidateBase {
  readonly candidateKind: "sale";
  readonly eventType: string;
  readonly transactionKey: string;
  readonly assetExternalId: string | null;
  readonly occurredAt: string;
  readonly amount: AdapterMoney | null;
  readonly pseudonymizationInputs: readonly PseudonymousActorInput[];
}

export interface ProbabilityBucketInput {
  readonly label?: string;
  readonly probabilityMinimum: number;
  readonly probabilityMaximum: number;
  readonly valueMinimum: number;
  readonly valueMaximum: number;
}

export interface EvInputCandidate extends ProviderAdapterCandidateBase {
  readonly candidateKind: "ev_input";
  readonly packExternalId: string;
  readonly currency: string;
  readonly unitBasis: "per_draw" | "per_pack";
  readonly drawCount: number;
  readonly coverage: number;
  readonly buckets: readonly ProbabilityBucketInput[];
}

export type ProviderAdapterCandidate =
  | CanonicalPackCandidate
  | CatalogAssetCandidate
  | PullCandidate
  | SaleCandidate
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

export interface ProviderMappingPageInput {
  readonly configuration: ProviderConfigurationIdentity;
  readonly page: ProviderFeedPageV1;
}

export interface ProviderMappingOutput {
  readonly outcomes: readonly ProviderRecordMappingOutcome[];
}

export interface ProviderAdapterIdentity {
  readonly key: string;
}

export interface ProviderMappingAdapter extends ProviderAdapterIdentity {
  readonly platformKey: string;
  mapPage(
    input: ProviderMappingPageInput,
  ): ProviderMappingOutput | Promise<ProviderMappingOutput>;
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
  readonly signal?: AbortSignal;
}

export type ProviderTransportConnectionInput = Omit<
  ProviderTransportPageInput,
  "cursor" | "seenCursors"
>;

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
    });
  }
}

export interface ProviderConnectionRecordCounts {
  readonly catalog: number;
  readonly pulls: number;
  readonly sales: number;
}

export type ProviderConnectionTestResult =
  | {
      readonly ok: true;
      readonly latencyMs: number;
      readonly recordCounts: ProviderConnectionRecordCounts;
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
  ): Promise<ProviderFeedValidatedPageV1>;
}

export type ProviderEnvelopeWithKind =
  | { readonly recordKind: "catalog"; readonly envelope: CatalogEnvelopeV1 }
  | { readonly recordKind: "pull"; readonly envelope: PullEnvelopeV1 }
  | { readonly recordKind: "sale"; readonly envelope: SaleEnvelopeV1 };

export function sourceIdentityForEnvelope(
  input: ProviderEnvelopeWithKind,
): ProviderSourceIdentity {
  const envelope: ProviderFeedEnvelopeV1 = input.envelope;
  const sourceTimestamp =
    input.recordKind === "catalog"
      ? input.envelope.updated_at
      : input.envelope.occurred_at;

  return {
    platform: envelope.platform,
    recordKind: input.recordKind,
    externalId: envelope.external_id,
    collectedAt: envelope.collected_at,
    sourceTimestamp,
  };
}
