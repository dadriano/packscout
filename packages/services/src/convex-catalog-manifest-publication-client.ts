import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  MAX_CATALOG_MANIFEST_PUBLICATION_BODY_BYTES,
  MAX_CATALOG_MANIFEST_RECEIPT_BYTES,
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestActivationReceiptSchema,
  catalogManifestActiveStateReceiptSchema,
  catalogManifestActiveStateRequestSchema,
  catalogManifestBlockReceiptSchema,
  catalogManifestBlockRequestSchema,
  catalogManifestErrorEnvelopeSchema,
  catalogManifestPublicationRequestDigest,
  catalogManifestReceiptDigest,
  catalogManifestReceiptSchema,
  catalogManifestRefreshActiveStateRequestSchema,
  catalogManifestRefreshReceiptSchema,
  catalogManifestRollbackRequestSchema,
  catalogManifestStatusNotFoundReceiptSchema,
  catalogManifestStatusRequestSchema,
  classifyCatalogManifestError,
  parseCatalogManifestPublicationJson,
  type CatalogManifestActivateRequest,
  type CatalogManifestActivationReceipt,
  type CatalogManifestActiveStateReceipt,
  type CatalogManifestBlockReceipt,
  type CatalogManifestBlockRequest,
  type CatalogManifestClearReceipt,
  type CatalogManifestErrorCode,
  type CatalogManifestReceipt,
  type CatalogManifestRefreshActiveStateRequest,
  type CatalogManifestRefreshReceipt,
  type CatalogManifestRollbackReceipt,
  type CatalogManifestRollbackRequest,
  type CatalogManifestStatusRequest,
  type CatalogManifestStatusNotFoundReceipt,
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

export { PublicationClientError as CatalogManifestPublicationClientError };
export type CatalogManifestPublicationClientFailureCode =
  PublicationClientFailureCode;
export type SignedConvexCatalogManifestPublicationClientOptions = Omit<
  SignedConvexPublicationHttpClientOptions,
  "errorResponseBoundary"
>;

export type CatalogManifestMutationKind =
  | "activateManifest"
  | "refreshActiveState"
  | "rollback"
  | "block";

export type CatalogManifestMutationRequestByKind = Readonly<{
  activateManifest: CatalogManifestActivateRequest;
  refreshActiveState: CatalogManifestRefreshActiveStateRequest;
  rollback: CatalogManifestRollbackRequest;
  block: CatalogManifestBlockRequest;
}>;

export type CatalogManifestMutationReceiptByKind = Readonly<{
  activateManifest: CatalogManifestActivationReceipt;
  refreshActiveState: CatalogManifestRefreshReceipt;
  rollback: CatalogManifestRollbackReceipt | CatalogManifestClearReceipt;
  block: CatalogManifestBlockReceipt;
}>;

export interface ExactCatalogManifestMutation<
  Kind extends CatalogManifestMutationKind = CatalogManifestMutationKind,
> {
  readonly kind: Kind;
  readonly canonicalRequestBody: string;
}

const manifestErrorResponseBoundary: PublicationErrorResponseBoundary = {
  parse(value) {
    const parsed = catalogManifestErrorEnvelopeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  classify(code) {
    return classifyCatalogManifestError(code as CatalogManifestErrorCode);
  },
};

const definitions = {
  activateManifest: {
    path: PRODUCTION_CATALOG_MANIFEST_PATHS.activateManifest,
    receiptSchema: catalogManifestActivationReceiptSchema,
  },
  refreshActiveState: {
    path: PRODUCTION_CATALOG_MANIFEST_PATHS.refreshActiveState,
    receiptSchema: catalogManifestRefreshReceiptSchema,
  },
  rollback: {
    path: PRODUCTION_CATALOG_MANIFEST_PATHS.rollback,
    receiptSchema: catalogManifestReceiptSchema,
  },
  block: {
    path: PRODUCTION_CATALOG_MANIFEST_PATHS.block,
    receiptSchema: catalogManifestBlockReceiptSchema,
  },
} as const;

function invalidRequest(code: CatalogManifestErrorCode): PublicationClientError {
  return new PublicationClientError(code, "terminal", false);
}

function canonicalRequestBody(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    throw invalidRequest("CATALOG_MANIFEST_REQUEST_INVALID");
  }
}

function parseMutationRequest(
  kind: CatalogManifestMutationKind,
  bodyJson: string,
): CatalogManifestMutationRequestByKind[CatalogManifestMutationKind] | null {
  switch (kind) {
    case "activateManifest":
      return parseCatalogManifestPublicationJson(
        bodyJson,
        catalogManifestActivateRequestSchema,
      );
    case "refreshActiveState":
      return parseCatalogManifestPublicationJson(
        bodyJson,
        catalogManifestRefreshActiveStateRequestSchema,
      );
    case "rollback":
      return parseCatalogManifestPublicationJson(
        bodyJson,
        catalogManifestRollbackRequestSchema,
      );
    case "block":
      return parseCatalogManifestPublicationJson(
        bodyJson,
        catalogManifestBlockRequestSchema,
      );
  }
}

function expectedManifestIdentity(
  kind: CatalogManifestMutationKind,
  request: CatalogManifestMutationRequestByKind[CatalogManifestMutationKind],
): Readonly<{
  publicReleaseId: string | null;
  manifestFingerprint: string | null;
}> {
  if (kind === "activateManifest" || kind === "refreshActiveState") {
    const manifest = (request as CatalogManifestActivateRequest).manifest;
    return {
      publicReleaseId: manifest.publicReleaseId,
      manifestFingerprint: manifest.manifestFingerprint,
    };
  }
  if (kind === "block") {
    const block = request as CatalogManifestBlockRequest;
    return {
      publicReleaseId: block.publicReleaseId,
      manifestFingerprint: block.manifestFingerprint,
    };
  }
  const rollback = request as CatalogManifestRollbackRequest;
  return rollback.rollbackKind === "manifest"
    ? {
      publicReleaseId: rollback.targetManifest.publicReleaseId,
      manifestFingerprint: rollback.targetManifest.manifestFingerprint,
    }
    : { publicReleaseId: null, manifestFingerprint: null };
}

function mutationIdentityMatches(
  kind: CatalogManifestMutationKind,
  request: CatalogManifestMutationRequestByKind[CatalogManifestMutationKind],
  receipt: CatalogManifestReceipt,
  requestDigest: string,
): boolean {
  if (receipt.operationKind === "activeState") return false;
  const identity = expectedManifestIdentity(kind, request);
  if (
    receipt.operationKind !== kind ||
    receipt.operationId !== request.operationId ||
    receipt.idempotencyKey !== request.idempotencyKey ||
    receipt.publicReleaseId !== identity.publicReleaseId ||
    receipt.manifestFingerprint !== identity.manifestFingerprint ||
    receipt.requestDigest !== requestDigest
  ) return false;
  if (kind === "rollback") {
    const rollbackRequest = request as CatalogManifestRollbackRequest;
    if (
      receipt.operationKind !== "rollback" ||
      receipt.rollbackKind !== rollbackRequest.rollbackKind
    ) return false;
  }
  if (
    kind !== "block" &&
    "expectedActiveState" in request &&
    "expectedActiveState" in receipt.details &&
    canonicalJson(receipt.details.expectedActiveState) !==
      canonicalJson(request.expectedActiveState)
  ) return false;
  return true;
}

function withReceipt<T>(
  result: SignedPublicationResult<unknown>,
  receipt: T,
): SignedPublicationResult<T> {
  return { ...result, receipt };
}

/** Typed catalog-manifest transport with an exact persisted-byte replay entrypoint. */
export class SignedConvexCatalogManifestPublicationClient {
  readonly #http: SignedConvexPublicationHttpClient;

  constructor(options: SignedConvexCatalogManifestPublicationClientOptions) {
    this.#http = new SignedConvexPublicationHttpClient({
      ...options,
      maximumResponseBytes: options.maximumResponseBytes ??
        MAX_CATALOG_MANIFEST_RECEIPT_BYTES + 4_096,
      errorResponseBoundary: manifestErrorResponseBoundary,
    });
  }

  async activeState(
    signal?: AbortSignal,
  ): Promise<SignedPublicationResult<CatalogManifestActiveStateReceipt>> {
    const request = {
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationId: "catalog-manifest-active-state",
    } as const;
    const bodyJson = canonicalRequestBody(request);
    const parsedRequest = parseCatalogManifestPublicationJson(
      bodyJson,
      catalogManifestActiveStateRequestSchema,
    );
    if (parsedRequest === null) {
      throw invalidRequest("CATALOG_MANIFEST_REQUEST_INVALID");
    }
    const requestDigest = await catalogManifestPublicationRequestDigest(
      parsedRequest,
    );
    const result = await this.#http.requestSigned(
      PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
      bodyJson,
      catalogManifestReceiptDigest,
      signal,
      catalogManifestReceiptDigest,
    );
    const receipt = catalogManifestActiveStateReceiptSchema.safeParse(
      result.receipt,
    );
    if (
      !receipt.success ||
      receipt.data.operationId !== parsedRequest.operationId ||
      receipt.data.requestDigest !== requestDigest
    ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    return withReceipt(result, receipt.data);
  }

  async sendExact<Kind extends CatalogManifestMutationKind>(
    operation: ExactCatalogManifestMutation<Kind>,
    signal?: AbortSignal,
  ): Promise<SignedPublicationResult<CatalogManifestMutationReceiptByKind[Kind]>> {
    if (
      Buffer.byteLength(operation.canonicalRequestBody, "utf8") >
        MAX_CATALOG_MANIFEST_PUBLICATION_BODY_BYTES
    ) throw invalidRequest("CATALOG_MANIFEST_BODY_TOO_LARGE");
    const definition = definitions[operation.kind];
    const request = parseMutationRequest(
      operation.kind,
      operation.canonicalRequestBody,
    ) as CatalogManifestMutationRequestByKind[Kind] | null;
    if (request === null) {
      throw invalidRequest("CATALOG_MANIFEST_REQUEST_INVALID");
    }
    const requestDigest = await catalogManifestPublicationRequestDigest(request);
    const result = await this.#http.requestSigned(
      definition.path,
      operation.canonicalRequestBody,
      catalogManifestReceiptDigest,
      signal,
      catalogManifestReceiptDigest,
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
      parsedReceipt.data as CatalogManifestMutationReceiptByKind[Kind],
    );
  }

  activateManifest(
    request: CatalogManifestActivateRequest,
    signal?: AbortSignal,
  ) {
    return this.sendExact({
      kind: "activateManifest",
      canonicalRequestBody: canonicalRequestBody(request),
    }, signal);
  }

  refreshActiveState(
    request: CatalogManifestRefreshActiveStateRequest,
    signal?: AbortSignal,
  ) {
    return this.sendExact({
      kind: "refreshActiveState",
      canonicalRequestBody: canonicalRequestBody(request),
    }, signal);
  }

  rollback(request: CatalogManifestRollbackRequest, signal?: AbortSignal) {
    return this.sendExact({
      kind: "rollback",
      canonicalRequestBody: canonicalRequestBody(request),
    }, signal);
  }

  block(request: CatalogManifestBlockRequest, signal?: AbortSignal) {
    return this.sendExact({
      kind: "block",
      canonicalRequestBody: canonicalRequestBody(request),
    }, signal);
  }

  async status(
    request: CatalogManifestStatusRequest,
    signal?: AbortSignal,
  ): Promise<SignedPublicationResult<
    CatalogManifestReceipt | CatalogManifestStatusNotFoundReceipt
  >> {
    const bodyJson = canonicalRequestBody(request);
    const parsedRequest = parseCatalogManifestPublicationJson(
      bodyJson,
      catalogManifestStatusRequestSchema,
    );
    if (parsedRequest === null) {
      throw invalidRequest("CATALOG_MANIFEST_REQUEST_INVALID");
    }
    const result = await this.#http.requestSigned(
      PRODUCTION_CATALOG_MANIFEST_PATHS.status,
      bodyJson,
      catalogManifestReceiptDigest,
      signal,
      catalogManifestReceiptDigest,
    );
    const notFound = catalogManifestStatusNotFoundReceiptSchema.safeParse(
      result.receipt,
    );
    if (notFound.success) {
      if (
        canonicalJson(notFound.data.target) !==
          canonicalJson(parsedRequest.target)
      ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
      return withReceipt(result, notFound.data);
    }
    const receipt = catalogManifestReceiptSchema.safeParse(result.receipt);
    const target = parsedRequest.target;
    if (
      !receipt.success ||
      receipt.data.operationKind === "activeState" ||
      receipt.data.operationKind !== target.operationKind ||
      receipt.data.operationId !== target.operationId ||
      receipt.data.idempotencyKey !== target.idempotencyKey ||
      receipt.data.publicReleaseId !== target.publicReleaseId ||
      receipt.data.manifestFingerprint !== target.manifestFingerprint ||
      receipt.data.requestDigest !== target.requestDigest ||
      (target.operationKind === "rollback" &&
        (receipt.data.operationKind !== "rollback" ||
          receipt.data.rollbackKind !== target.rollbackKind))
    ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    return withReceipt(result, receipt.data);
  }
}
