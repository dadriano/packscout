import { createHash } from "node:crypto";
import {
  DATA_RELEASE_SCHEMA_VERSION,
  PRODUCTION_DATA_RELEASE_PATHS,
  canonicalJson,
  productionActiveStateReceiptSchema,
  productionReceiptHash,
  productionStatusNotFoundReceiptSchema,
  type ProductionReceipt,
} from "@packscout/contracts";
import {
  PublicationClientError,
  SignedConvexPublicationHttpClient,
  ambiguousPublicationResponse,
  type PublicationClientFailureCode,
  type SignedConvexPublicationHttpClientOptions,
} from "./convex-publication-http-client.ts";
import {
  validateCatalogPromotionOperation,
  validateCatalogPromotionReceipt,
} from "./catalog-promotion-operations.ts";
import type {
  CatalogPromotionOperation,
  CatalogPublicationActiveState,
  CatalogPublicationActiveStateTransport,
  CatalogPublicationStatusInput,
  CatalogPublicationTransport,
} from "./catalog-promotion-types.ts";

export { PublicationClientError as CatalogPublicationClientError };
export type CatalogPublicationClientFailureCode = PublicationClientFailureCode;
export type SignedConvexCatalogPublicationClientOptions =
  SignedConvexPublicationHttpClientOptions;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class SignedConvexCatalogPublicationClient
  implements CatalogPublicationTransport, CatalogPublicationActiveStateTransport
{
  readonly #http: SignedConvexPublicationHttpClient;

  constructor(options: SignedConvexCatalogPublicationClientOptions) {
    this.#http = new SignedConvexPublicationHttpClient(options);
  }

  async send(
    operation: CatalogPromotionOperation,
    signal?: AbortSignal,
  ): Promise<ProductionReceipt> {
    try {
      validateCatalogPromotionOperation(operation);
    } catch {
      throw new PublicationClientError(
        "PUBLICATION_REQUEST_INVALID", "terminal", false,
      );
    }
    const receipt = await this.#http.request(
      operation.path,
      operation.bodyJson,
      productionReceiptHash,
      signal,
    );
    try {
      return validateCatalogPromotionReceipt(receipt, {
        operationId: operation.operationId,
        publicationId: operation.publicationId,
        requestDigest: operation.bodyDigest,
        kind: operation.kind,
        bodyJson: operation.bodyJson,
      });
    } catch {
      throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    }
  }

  async activeState(signal?: AbortSignal): Promise<CatalogPublicationActiveState> {
    const bodyJson = canonicalJson({
      schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
      operationId: "catalog-active-state",
    });
    const receipt = productionActiveStateReceiptSchema.safeParse(
      await this.#http.request(
        PRODUCTION_DATA_RELEASE_PATHS.activeState,
        bodyJson,
        productionReceiptHash,
        signal,
      ),
    );
    if (
      !receipt.success ||
      receipt.data.operationId !== "catalog-active-state" ||
      receipt.data.requestDigest !== sha256(bodyJson) ||
      receipt.data.publicationId !== receipt.data.details.activePublicReleaseId
    ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    return {
      activePublicReleaseId: receipt.data.details.activePublicReleaseId,
      observationSequence: receipt.data.details.observationSequence,
      terminalReceiptSha256: receipt.data.details.terminalReceiptSha256,
    };
  }

  async status(
    input: CatalogPublicationStatusInput,
    signal?: AbortSignal,
  ): Promise<ProductionReceipt | null> {
    const bodyJson = canonicalJson({
      schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
      operationId: input.operationId,
      publicationId: input.publicationId,
    });
    const raw = await this.#http.request(
      PRODUCTION_DATA_RELEASE_PATHS.status,
      bodyJson,
      productionReceiptHash,
      signal,
    );
    const notFound = productionStatusNotFoundReceiptSchema.safeParse(raw);
    if (notFound.success) {
      if (
        notFound.data.operationId !== input.operationId ||
        notFound.data.publicationId !== input.publicationId ||
        notFound.data.requestDigest !== sha256(bodyJson)
      ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
      return null;
    }
    try {
      return validateCatalogPromotionReceipt(raw, {
        operationId: input.operationId,
        publicationId: input.publicationId,
        requestDigest: input.expectedRequestDigest,
        kind: input.expectedKind,
      });
    } catch {
      throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    }
  }
}
