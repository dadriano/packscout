import {
  MAX_CATALOG_RETENTION_HTTP_BODY_BYTES,
  MAX_CATALOG_RETENTION_HTTP_RESPONSE_BYTES,
  PRODUCTION_CATALOG_RETENTION_PATHS,
  canonicalJson,
  catalogRetentionErrorEnvelopeSchema,
  catalogRetentionManifestReceiptSchema,
  catalogRetentionManifestRequestSchema,
  catalogRetentionProviderReceiptSchema,
  catalogRetentionProviderRequestSchema,
  catalogRetentionPublicationRequestDigest,
  catalogRetentionReceiptDigest,
  catalogRetentionReceiptSchema,
  catalogRetentionStatusNotFoundReceiptSchema,
  catalogRetentionStatusRequestSchema,
  classifyCatalogRetentionError,
  parseCatalogRetentionPublicationJson,
  type CatalogRetentionErrorCode,
  type CatalogRetentionManifestReceipt,
  type CatalogRetentionManifestRequest,
  type CatalogRetentionProviderReceipt,
  type CatalogRetentionProviderRequest,
  type CatalogRetentionReceipt,
  type CatalogRetentionStatusNotFoundReceipt,
  type CatalogRetentionStatusRequest,
} from "@packscout/contracts";
import {
  PublicationClientError,
  SignedConvexPublicationHttpClient,
  ambiguousPublicationResponse,
  type PublicationClientFailureCode,
  type PublicationErrorResponseBoundary,
  type SignedConvexPublicationHttpClientOptions,
  type SignedPublicationResult,
} from "./convex-publication-http-client.ts";

export { PublicationClientError as CatalogRetentionPublicationClientError };
export type CatalogRetentionPublicationClientFailureCode =
  PublicationClientFailureCode;
export type SignedConvexCatalogRetentionClientOptions = Omit<
  SignedConvexPublicationHttpClientOptions,
  "errorResponseBoundary"
>;

export type CatalogRetentionMutationKind =
  | "retainManifests"
  | "retainProviderReleases";

export type CatalogRetentionMutationRequestByKind = Readonly<{
  retainManifests: CatalogRetentionManifestRequest;
  retainProviderReleases: CatalogRetentionProviderRequest;
}>;

export type CatalogRetentionMutationReceiptByKind = Readonly<{
  retainManifests: CatalogRetentionManifestReceipt;
  retainProviderReleases: CatalogRetentionProviderReceipt;
}>;

export interface ExactCatalogRetentionMutation<
  Kind extends CatalogRetentionMutationKind = CatalogRetentionMutationKind,
> {
  readonly kind: Kind;
  readonly canonicalRequestBody: string;
}

const retentionErrorResponseBoundary: PublicationErrorResponseBoundary = {
  parse(value) {
    const parsed = catalogRetentionErrorEnvelopeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  classify(code) {
    return classifyCatalogRetentionError(code as CatalogRetentionErrorCode);
  },
};

const definitions = {
  retainManifests: {
    path: PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests,
    requestSchema: catalogRetentionManifestRequestSchema,
    receiptSchema: catalogRetentionManifestReceiptSchema,
  },
  retainProviderReleases: {
    path: PRODUCTION_CATALOG_RETENTION_PATHS.retainProviderReleases,
    requestSchema: catalogRetentionProviderRequestSchema,
    receiptSchema: catalogRetentionProviderReceiptSchema,
  },
} as const;

function invalidRequest(code: CatalogRetentionErrorCode): PublicationClientError {
  return new PublicationClientError(code, "terminal", false);
}

function canonicalRequestBody(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    throw invalidRequest("CATALOG_RETENTION_REQUEST_INVALID");
  }
}

function parseMutationRequest<Kind extends CatalogRetentionMutationKind>(
  kind: Kind,
  bodyJson: string,
): CatalogRetentionMutationRequestByKind[Kind] | null {
  const parsed = kind === "retainManifests"
    ? parseCatalogRetentionPublicationJson(
        bodyJson,
        catalogRetentionManifestRequestSchema,
      )
    : parseCatalogRetentionPublicationJson(
        bodyJson,
        catalogRetentionProviderRequestSchema,
      );
  return parsed as CatalogRetentionMutationRequestByKind[Kind] | null;
}

function mutationIdentityMatches(
  kind: CatalogRetentionMutationKind,
  request: CatalogRetentionManifestRequest | CatalogRetentionProviderRequest,
  receipt: CatalogRetentionReceipt,
  requestDigest: string,
): boolean {
  const expectedKind = kind;
  const expectedPlatform = request.phase === "manifests"
    ? null
    : request.platformKey;
  const protection = receipt.details.protectionSet;
  return receipt.operationKind === expectedKind &&
    receipt.operationId === request.operationId &&
    receipt.idempotencyKey === request.idempotencyKey &&
    receipt.phase === request.phase &&
    receipt.platformKey === expectedPlatform &&
    receipt.requestDigest === requestDigest &&
    receipt.expectedRetentionGeneration ===
      request.expectedRetentionGeneration &&
    receipt.details.maximumDocuments === request.maximumDocuments &&
    protection.postgresProofSnapshotId === request.postgresProof.snapshotId &&
    protection.postgresProofSnapshotSequence ===
      request.postgresProof.snapshotSequence &&
    protection.postgresProofSnapshotDigest ===
      request.postgresProof.snapshotDigest;
}

function withReceipt<T>(
  result: SignedPublicationResult<unknown>,
  receipt: T,
): SignedPublicationResult<T> {
  return { ...result, receipt };
}

/** Signed, typed transport for the two-phase catalog-retention lane. */
export class SignedConvexCatalogRetentionClient {
  readonly #http: SignedConvexPublicationHttpClient;

  constructor(options: SignedConvexCatalogRetentionClientOptions) {
    this.#http = new SignedConvexPublicationHttpClient({
      ...options,
      maximumRequestBytes: options.maximumRequestBytes ??
        MAX_CATALOG_RETENTION_HTTP_BODY_BYTES,
      maximumResponseBytes: options.maximumResponseBytes ??
        MAX_CATALOG_RETENTION_HTTP_RESPONSE_BYTES,
      errorResponseBoundary: retentionErrorResponseBoundary,
    });
  }

  async sendExact<Kind extends CatalogRetentionMutationKind>(
    operation: ExactCatalogRetentionMutation<Kind>,
    signal?: AbortSignal,
  ): Promise<SignedPublicationResult<
    CatalogRetentionMutationReceiptByKind[Kind]
  >> {
    if (
      Buffer.byteLength(operation.canonicalRequestBody, "utf8") >
        MAX_CATALOG_RETENTION_HTTP_BODY_BYTES
    ) throw invalidRequest("CATALOG_RETENTION_BODY_TOO_LARGE");
    const definition = definitions[operation.kind];
    const request = parseMutationRequest(
      operation.kind,
      operation.canonicalRequestBody,
    );
    if (request === null) {
      throw invalidRequest("CATALOG_RETENTION_REQUEST_INVALID");
    }
    const requestDigest = await catalogRetentionPublicationRequestDigest(
      request,
    );
    const result = await this.#http.requestSigned(
      definition.path,
      operation.canonicalRequestBody,
      catalogRetentionReceiptDigest,
      signal,
      catalogRetentionReceiptDigest,
    );
    const parsedReceipt = definition.receiptSchema.safeParse(result.receipt);
    if (
      !parsedReceipt.success ||
      !mutationIdentityMatches(
        operation.kind,
        request,
        parsedReceipt.data,
        requestDigest,
      )
    ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    return withReceipt(
      result,
      parsedReceipt.data as CatalogRetentionMutationReceiptByKind[Kind],
    );
  }

  retainManifests(
    request: CatalogRetentionManifestRequest,
    signal?: AbortSignal,
  ) {
    return this.sendExact({
      kind: "retainManifests",
      canonicalRequestBody: canonicalRequestBody(request),
    }, signal);
  }

  retainProviderReleases(
    request: CatalogRetentionProviderRequest,
    signal?: AbortSignal,
  ) {
    return this.sendExact({
      kind: "retainProviderReleases",
      canonicalRequestBody: canonicalRequestBody(request),
    }, signal);
  }

  async status(
    request: CatalogRetentionStatusRequest,
    signal?: AbortSignal,
  ): Promise<SignedPublicationResult<
    CatalogRetentionReceipt | CatalogRetentionStatusNotFoundReceipt
  >> {
    const bodyJson = canonicalRequestBody(request);
    const parsedRequest = parseCatalogRetentionPublicationJson(
      bodyJson,
      catalogRetentionStatusRequestSchema,
    );
    if (parsedRequest === null) {
      throw invalidRequest("CATALOG_RETENTION_REQUEST_INVALID");
    }
    const result = await this.#http.requestSigned(
      PRODUCTION_CATALOG_RETENTION_PATHS.status,
      bodyJson,
      catalogRetentionReceiptDigest,
      signal,
      catalogRetentionReceiptDigest,
    );
    const notFound = catalogRetentionStatusNotFoundReceiptSchema.safeParse(
      result.receipt,
    );
    if (notFound.success) {
      if (
        canonicalJson(notFound.data.target) !==
          canonicalJson(parsedRequest.target)
      ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
      return withReceipt(result, notFound.data);
    }
    const receipt = catalogRetentionReceiptSchema.safeParse(result.receipt);
    const target = parsedRequest.target;
    if (
      !receipt.success ||
      receipt.data.operationKind !== target.operationKind ||
      receipt.data.operationId !== target.operationId ||
      receipt.data.idempotencyKey !== target.idempotencyKey ||
      receipt.data.phase !== target.phase ||
      receipt.data.platformKey !== target.platformKey ||
      receipt.data.requestDigest !== target.requestDigest
    ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    return withReceipt(result, receipt.data);
  }
}
