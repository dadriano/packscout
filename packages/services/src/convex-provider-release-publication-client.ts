import {
  MAX_PROVIDER_RELEASE_PUBLICATION_BODY_BYTES,
  MAX_PROVIDER_RELEASE_RECEIPT_BYTES,
  PRODUCTION_PROVIDER_RELEASE_PATHS,
  canonicalJson,
  classifyProviderReleaseError,
  parseProviderReleasePublicationJson,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseBatchReceiptSchema,
  providerReleaseBlockReceiptSchema,
  providerReleaseBlockRequestSchema,
  providerReleaseCleanupReceiptSchema,
  providerReleaseCleanupRequestSchema,
  providerReleaseCompletedHeadReceiptSchema,
  providerReleaseCompletedHeadRequestSchema,
  providerReleaseCompletionReceiptSchema,
  providerReleaseConfirmReuseRequestSchema,
  providerReleaseErrorEnvelopeSchema,
  providerReleaseFinalizeRequestSchema,
  providerReleasePublicationRequestDigest,
  providerReleaseReceiptDigest,
  providerReleaseReuseReceiptSchema,
  providerReleaseStartReceiptSchema,
  providerReleaseStartRequestSchema,
  providerReleaseStatusNotFoundReceiptSchema,
  providerReleaseStatusRequestSchema,
  type ProviderReleaseApplyBatchRequest,
  type ProviderReleaseBatchReceipt,
  type ProviderReleaseBlockReceipt,
  type ProviderReleaseBlockRequest,
  type ProviderReleaseCleanupReceipt,
  type ProviderReleaseCleanupRequest,
  type ProviderReleaseCompletedHeadReceipt,
  type ProviderReleaseCompletedHeadRequest,
  type ProviderReleaseCompletionReceipt,
  type ProviderReleaseConfirmReuseRequest,
  type ProviderReleaseErrorCode,
  type ProviderReleaseFinalizeRequest,
  type ProviderReleaseReceipt,
  type ProviderReleaseReuseReceipt,
  type ProviderReleaseStartReceipt,
  type ProviderReleaseStartRequest,
  type ProviderReleaseStatusNotFoundReceipt,
  type ProviderReleaseStatusRequest,
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

export { PublicationClientError as ProviderReleasePublicationClientError };
export type ProviderReleasePublicationClientFailureCode =
  PublicationClientFailureCode;
export type SignedConvexProviderReleasePublicationClientOptions = Omit<
  SignedConvexPublicationHttpClientOptions,
  "errorResponseBoundary"
>;

export type ProviderReleaseMutationKind =
  | "start"
  | "applyBatch"
  | "finalize"
  | "confirmReuse"
  | "block"
  | "cleanup";

export type ProviderReleaseMutationRequestByKind = Readonly<{
  start: ProviderReleaseStartRequest;
  applyBatch: ProviderReleaseApplyBatchRequest;
  finalize: ProviderReleaseFinalizeRequest;
  confirmReuse: ProviderReleaseConfirmReuseRequest;
  block: ProviderReleaseBlockRequest;
  cleanup: ProviderReleaseCleanupRequest;
}>;

export type ProviderReleaseMutationReceiptByKind = Readonly<{
  start: ProviderReleaseStartReceipt;
  applyBatch: ProviderReleaseBatchReceipt;
  finalize: ProviderReleaseCompletionReceipt;
  confirmReuse: ProviderReleaseReuseReceipt;
  block: ProviderReleaseBlockReceipt;
  cleanup: ProviderReleaseCleanupReceipt;
}>;

export interface ExactProviderReleaseMutation<
  Kind extends ProviderReleaseMutationKind = ProviderReleaseMutationKind,
> {
  readonly kind: Kind;
  readonly canonicalRequestBody: string;
}

const providerErrorResponseBoundary: PublicationErrorResponseBoundary = {
  parse(value) {
    const parsed = providerReleaseErrorEnvelopeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  classify(code) {
    return classifyProviderReleaseError(code as ProviderReleaseErrorCode);
  },
};

const definitions = {
  start: {
    path: PRODUCTION_PROVIDER_RELEASE_PATHS.start,
    receiptSchema: providerReleaseStartReceiptSchema,
  },
  applyBatch: {
    path: PRODUCTION_PROVIDER_RELEASE_PATHS.applyBatch,
    receiptSchema: providerReleaseBatchReceiptSchema,
  },
  finalize: {
    path: PRODUCTION_PROVIDER_RELEASE_PATHS.finalize,
    receiptSchema: providerReleaseCompletionReceiptSchema,
  },
  confirmReuse: {
    path: PRODUCTION_PROVIDER_RELEASE_PATHS.confirmReuse,
    receiptSchema: providerReleaseReuseReceiptSchema,
  },
  block: {
    path: PRODUCTION_PROVIDER_RELEASE_PATHS.block,
    receiptSchema: providerReleaseBlockReceiptSchema,
  },
  cleanup: {
    path: PRODUCTION_PROVIDER_RELEASE_PATHS.cleanup,
    receiptSchema: providerReleaseCleanupReceiptSchema,
  },
} as const;

function invalidRequest(code: ProviderReleaseErrorCode): PublicationClientError {
  return new PublicationClientError(code, "terminal", false);
}

function canonicalRequestBody(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    throw invalidRequest("PROVIDER_RELEASE_REQUEST_INVALID");
  }
}

function parseMutationRequest(
  kind: ProviderReleaseMutationKind,
  bodyJson: string,
): ProviderReleaseMutationRequestByKind[ProviderReleaseMutationKind] | null {
  switch (kind) {
    case "start":
      return parseProviderReleasePublicationJson(
        bodyJson,
        providerReleaseStartRequestSchema,
      );
    case "applyBatch":
      return parseProviderReleasePublicationJson(
        bodyJson,
        providerReleaseApplyBatchRequestSchema,
      );
    case "finalize":
      return parseProviderReleasePublicationJson(
        bodyJson,
        providerReleaseFinalizeRequestSchema,
      );
    case "confirmReuse":
      return parseProviderReleasePublicationJson(
        bodyJson,
        providerReleaseConfirmReuseRequestSchema,
      );
    case "block":
      return parseProviderReleasePublicationJson(
        bodyJson,
        providerReleaseBlockRequestSchema,
      );
    case "cleanup":
      return parseProviderReleasePublicationJson(
        bodyJson,
        providerReleaseCleanupRequestSchema,
      );
  }
}

function mutationIdentityMatches(
  kind: ProviderReleaseMutationKind,
  request: ProviderReleaseMutationRequestByKind[ProviderReleaseMutationKind],
  receipt: ProviderReleaseReceipt,
  requestDigest: string,
): boolean {
  if (receipt.operationKind === "completedHead") return false;
  const platformKey = "release" in request
    ? request.release.platformKey
    : request.platformKey;
  const publicProviderReleaseId = "release" in request
    ? request.release.publicProviderReleaseId
    : null;
  return receipt.operationKind === kind &&
    receipt.operationId === request.operationId &&
    receipt.idempotencyKey === request.idempotencyKey &&
    receipt.platformKey === platformKey &&
    receipt.publicProviderReleaseId === publicProviderReleaseId &&
    receipt.requestDigest === requestDigest;
}

function withReceipt<T>(
  result: SignedPublicationResult<unknown>,
  receipt: T,
): SignedPublicationResult<T> {
  return { ...result, receipt };
}

/** Typed provider-release transport with an exact persisted-byte replay entrypoint. */
export class SignedConvexProviderReleasePublicationClient {
  readonly #http: SignedConvexPublicationHttpClient;

  constructor(options: SignedConvexProviderReleasePublicationClientOptions) {
    this.#http = new SignedConvexPublicationHttpClient({
      ...options,
      maximumResponseBytes: options.maximumResponseBytes ??
        MAX_PROVIDER_RELEASE_RECEIPT_BYTES + 4_096,
      errorResponseBoundary: providerErrorResponseBoundary,
    });
  }

  async completedHead(
    request: ProviderReleaseCompletedHeadRequest,
    signal?: AbortSignal,
  ): Promise<SignedPublicationResult<ProviderReleaseCompletedHeadReceipt>> {
    const bodyJson = canonicalRequestBody(request);
    const parsedRequest = parseProviderReleasePublicationJson(
      bodyJson,
      providerReleaseCompletedHeadRequestSchema,
    );
    if (parsedRequest === null) {
      throw invalidRequest("PROVIDER_RELEASE_REQUEST_INVALID");
    }
    const requestDigest = await providerReleasePublicationRequestDigest(
      parsedRequest,
    );
    const result = await this.#http.requestSigned(
      PRODUCTION_PROVIDER_RELEASE_PATHS.completedHead,
      bodyJson,
      providerReleaseReceiptDigest,
      signal,
      providerReleaseReceiptDigest,
    );
    const receipt = providerReleaseCompletedHeadReceiptSchema.safeParse(
      result.receipt,
    );
    if (
      !receipt.success ||
      receipt.data.operationId !== parsedRequest.operationId ||
      receipt.data.platformKey !== parsedRequest.platformKey ||
      receipt.data.requestDigest !== requestDigest
    ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    return withReceipt(result, receipt.data);
  }

  async sendExact<Kind extends ProviderReleaseMutationKind>(
    operation: ExactProviderReleaseMutation<Kind>,
    signal?: AbortSignal,
  ): Promise<SignedPublicationResult<ProviderReleaseMutationReceiptByKind[Kind]>> {
    if (
      Buffer.byteLength(operation.canonicalRequestBody, "utf8") >
        MAX_PROVIDER_RELEASE_PUBLICATION_BODY_BYTES
    ) throw invalidRequest("PROVIDER_RELEASE_BODY_TOO_LARGE");
    const definition = definitions[operation.kind];
    const request = parseMutationRequest(
      operation.kind,
      operation.canonicalRequestBody,
    ) as ProviderReleaseMutationRequestByKind[Kind] | null;
    if (request === null) {
      throw invalidRequest("PROVIDER_RELEASE_REQUEST_INVALID");
    }
    const requestDigest = await providerReleasePublicationRequestDigest(request);
    const result = await this.#http.requestSigned(
      definition.path,
      operation.canonicalRequestBody,
      providerReleaseReceiptDigest,
      signal,
      providerReleaseReceiptDigest,
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
      parsedReceipt.data as ProviderReleaseMutationReceiptByKind[Kind],
    );
  }

  start(request: ProviderReleaseStartRequest, signal?: AbortSignal) {
    return this.sendExact({
      kind: "start",
      canonicalRequestBody: canonicalRequestBody(request),
    }, signal);
  }

  applyBatch(request: ProviderReleaseApplyBatchRequest, signal?: AbortSignal) {
    return this.sendExact({
      kind: "applyBatch",
      canonicalRequestBody: canonicalRequestBody(request),
    }, signal);
  }

  finalize(request: ProviderReleaseFinalizeRequest, signal?: AbortSignal) {
    return this.sendExact({
      kind: "finalize",
      canonicalRequestBody: canonicalRequestBody(request),
    }, signal);
  }

  confirmReuse(
    request: ProviderReleaseConfirmReuseRequest,
    signal?: AbortSignal,
  ) {
    return this.sendExact({
      kind: "confirmReuse",
      canonicalRequestBody: canonicalRequestBody(request),
    }, signal);
  }

  block(request: ProviderReleaseBlockRequest, signal?: AbortSignal) {
    return this.sendExact({
      kind: "block",
      canonicalRequestBody: canonicalRequestBody(request),
    }, signal);
  }

  cleanup(request: ProviderReleaseCleanupRequest, signal?: AbortSignal) {
    return this.sendExact({
      kind: "cleanup",
      canonicalRequestBody: canonicalRequestBody(request),
    }, signal);
  }

  async status(
    request: ProviderReleaseStatusRequest,
    signal?: AbortSignal,
  ): Promise<SignedPublicationResult<
    ProviderReleaseReceipt | ProviderReleaseStatusNotFoundReceipt
  >> {
    const bodyJson = canonicalRequestBody(request);
    const parsedRequest = parseProviderReleasePublicationJson(
      bodyJson,
      providerReleaseStatusRequestSchema,
    );
    if (parsedRequest === null) {
      throw invalidRequest("PROVIDER_RELEASE_REQUEST_INVALID");
    }
    const result = await this.#http.requestSigned(
      PRODUCTION_PROVIDER_RELEASE_PATHS.status,
      bodyJson,
      providerReleaseReceiptDigest,
      signal,
      providerReleaseReceiptDigest,
    );
    const notFound = providerReleaseStatusNotFoundReceiptSchema.safeParse(
      result.receipt,
    );
    if (notFound.success) {
      if (
        canonicalJson(notFound.data.target) !==
          canonicalJson(parsedRequest.target)
      ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
      return withReceipt(result, notFound.data);
    }
    const receipt = definitions[parsedRequest.target.operationKind]
      .receiptSchema.safeParse(result.receipt);
    if (
      !receipt.success ||
      receipt.data.operationId !== parsedRequest.target.operationId ||
      receipt.data.idempotencyKey !== parsedRequest.target.idempotencyKey ||
      receipt.data.platformKey !== parsedRequest.target.platformKey ||
      receipt.data.publicProviderReleaseId !==
        parsedRequest.target.publicProviderReleaseId ||
      receipt.data.requestDigest !== parsedRequest.target.requestDigest
    ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    return withReceipt(result, receipt.data);
  }
}
