import { createHash } from "node:crypto";
import {
  PRODUCTION_REPACK_HEAT_PATHS,
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  productionHeatActiveStateReceiptSchema,
  productionHeatActiveStateRequestSchema,
  productionHeatReceiptHash,
  productionHeatReceiptSchema,
  productionHeatStatusNotFoundReceiptSchema,
  type ProductionHeatReceipt,
} from "@packscout/contracts";
import {
  PublicationClientError,
  SignedConvexPublicationHttpClient,
  ambiguousPublicationResponse,
  type SignedConvexPublicationHttpClientOptions,
} from "./convex-publication-http-client.ts";
import {
  validateHeatPromotionOperation,
  validateHeatPromotionReceipt,
} from "./heat-promotion-operations.ts";
import type {
  HeatPromotionOperation,
  HeatPublicationActiveState,
  HeatPublicationActiveStateTransport,
  HeatPublicationStatusInput,
  HeatPublicationTransport,
} from "./heat-promotion-types.ts";

export type SignedConvexHeatPublicationClientOptions =
  SignedConvexPublicationHttpClientOptions;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class SignedConvexHeatPublicationClient
  implements HeatPublicationTransport, HeatPublicationActiveStateTransport
{
  readonly #http: SignedConvexPublicationHttpClient;

  constructor(options: SignedConvexHeatPublicationClientOptions) {
    this.#http = new SignedConvexPublicationHttpClient(options);
  }

  async send(
    operation: HeatPromotionOperation,
    signal?: AbortSignal,
  ): Promise<ProductionHeatReceipt> {
    try {
      validateHeatPromotionOperation(operation);
    } catch {
      throw new PublicationClientError(
        "PUBLICATION_REQUEST_INVALID", "terminal", false,
      );
    }
    const raw = await this.#http.request(
      operation.requestPath,
      operation.canonicalRequestBody,
      productionHeatReceiptHash,
      signal,
    );
    try {
      return validateHeatPromotionReceipt(raw, { operation });
    } catch {
      throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    }
  }

  async status(
    input: HeatPublicationStatusInput,
    signal?: AbortSignal,
  ): Promise<ProductionHeatReceipt | null> {
    const bodyJson = canonicalJson({
      schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
      operationId: input.operationId,
      publicationId: input.publicationId,
    });
    const raw = await this.#http.request(
      PRODUCTION_REPACK_HEAT_PATHS.status,
      bodyJson,
      productionHeatReceiptHash,
      signal,
    );
    const notFound = productionHeatStatusNotFoundReceiptSchema.safeParse(raw);
    if (notFound.success) {
      if (
        notFound.data.operationId !== input.operationId ||
        notFound.data.publicationId !== input.publicationId ||
        notFound.data.requestDigest !== sha256(bodyJson)
      ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
      return null;
    }
    const receipt = productionHeatReceiptSchema.safeParse(raw);
    if (
      !receipt.success ||
      receipt.data.operationId !== input.operationId ||
      receipt.data.publicationId !== input.publicationId ||
      receipt.data.requestDigest !== input.expectedRequestDigest ||
      receipt.data.operationKind !== input.expectedKind
    ) {
      throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    }
    return receipt.data;
  }

  async activeState(signal?: AbortSignal): Promise<HeatPublicationActiveState> {
    const request = productionHeatActiveStateRequestSchema.parse({
      schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
      operationId: "heat-active-state",
    });
    const bodyJson = canonicalJson(request);
    const receipt = productionHeatActiveStateReceiptSchema.safeParse(
      await this.#http.request(
        PRODUCTION_REPACK_HEAT_PATHS.activeState,
        bodyJson,
        productionHeatReceiptHash,
        signal,
      ),
    );
    if (
      !receipt.success ||
      receipt.data.operationId !== request.operationId ||
      receipt.data.requestDigest !== sha256(bodyJson) ||
      receipt.data.publicationId !==
        receipt.data.details.activePublicHeatFrameId
    ) throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    return {
      activePublicHeatFrameId: receipt.data.details.activePublicHeatFrameId,
      catalogPublicReleaseId: receipt.data.details.catalogPublicReleaseId,
      sourceWatermark: receipt.data.details.sourceWatermark === null
        ? null : BigInt(receipt.data.details.sourceWatermark),
      frameSequence: receipt.data.details.frameSequence,
      terminalReceiptSha256: receipt.data.details.terminalReceiptSha256,
    };
  }
}
