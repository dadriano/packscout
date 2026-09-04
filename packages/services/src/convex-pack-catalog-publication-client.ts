import { createHash } from "node:crypto";
import {
  MAX_PACK_CATALOG_HTTP_BODY_BYTES,
  PACK_CATALOG_OPERATION_PATHS,
  PACK_CATALOG_V1,
  classifyPackCatalogError,
  packCatalogCanonicalJson,
  packCatalogErrorEnvelopeSchema,
  packCatalogPublicationReceiptSchema,
  packCatalogPublicationRequestSchema,
  packCatalogReceiptDigest,
  type PackCatalogPublicationOperationKind,
  type PackCatalogPublicationReceipt,
  type PackCatalogPublicationRequest,
  type TrustedPackCatalogServiceIdentity,
} from "@packscout/contracts";
import {
  PublicationClientError,
  SignedConvexPublicationHttpClient,
  ambiguousPublicationResponse,
  type PublicationErrorResponseBoundary,
  type SignedConvexPublicationHttpClientOptions,
} from "./convex-publication-http-client.ts";

/**
 * Signed transport for the `pack_catalog_v1` public store
 * (pack-version-publication/005). Rides the shared publication HTTP boundary
 * (HMAC request signing, nonce, timestamp window, byte limits, timeout, and
 * signed-response verification) and binds every receipt to the exact
 * operation identity and canonical request bytes it answered. Request bodies
 * are P01-canonical JSON, so an exact retry sends byte-identical bytes and
 * converges on the stored receipt.
 */

export type SignedConvexPackCatalogPublicationClientOptions =
  SignedConvexPublicationHttpClientOptions;

export interface PackCatalogOperationEnvelope {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly serviceIdentity: TrustedPackCatalogServiceIdentity;
  readonly requestedAt: string;
}

type BodyOf<K extends PackCatalogPublicationOperationKind> =
  Extract<PackCatalogPublicationRequest, { operationKind: K }>["body"];

const packCatalogErrorResponseBoundary: PublicationErrorResponseBoundary = {
  parse(value) {
    const parsed = packCatalogErrorEnvelopeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  classify(code) {
    const parsed = packCatalogErrorEnvelopeSchema.shape.code.safeParse(code);
    return parsed.success ? classifyPackCatalogError(parsed.data) : "terminal";
  },
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface PackCatalogPublicationTransport {
  send(request: PackCatalogPublicationRequest, signal?: AbortSignal): Promise<PackCatalogPublicationReceipt>;
}

/** Generic signed sender: validates, canonicalizes, posts, and verifies the receipt binding. */
export class SignedConvexPackCatalogPublicationClient implements PackCatalogPublicationTransport {
  readonly #http: SignedConvexPublicationHttpClient;

  constructor(options: SignedConvexPackCatalogPublicationClientOptions) {
    this.#http = new SignedConvexPublicationHttpClient({
      maximumRequestBytes: MAX_PACK_CATALOG_HTTP_BODY_BYTES,
      maximumResponseBytes: MAX_PACK_CATALOG_HTTP_BODY_BYTES,
      ...options,
      errorResponseBoundary: options.errorResponseBoundary ?? packCatalogErrorResponseBoundary,
    });
  }

  async send(
    request: PackCatalogPublicationRequest,
    signal?: AbortSignal,
  ): Promise<PackCatalogPublicationReceipt> {
    const parsed = packCatalogPublicationRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new PublicationClientError("PUBLICATION_REQUEST_INVALID", "terminal", false);
    }
    const bodyJson = packCatalogCanonicalJson(parsed.data);
    const raw = await this.#http.requestSigned(
      PACK_CATALOG_OPERATION_PATHS[parsed.data.operationKind],
      bodyJson,
      packCatalogReceiptDigest,
      signal,
      packCatalogReceiptDigest,
    );
    const receipt = packCatalogPublicationReceiptSchema.safeParse(raw.receipt);
    if (
      !receipt.success ||
      receipt.data.operationKind !== parsed.data.operationKind ||
      receipt.data.operationId !== parsed.data.operationId ||
      receipt.data.idempotencyKey !== parsed.data.idempotencyKey ||
      receipt.data.requestSha256 !== sha256(bodyJson)
    ) {
      throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    }
    return receipt.data;
  }
}

function envelope<K extends PackCatalogPublicationOperationKind>(
  kind: K,
  operation: PackCatalogOperationEnvelope,
  body: BodyOf<K>,
): PackCatalogPublicationRequest {
  return { schemaVersion: PACK_CATALOG_V1, operationKind: kind, ...operation, body } as PackCatalogPublicationRequest;
}

/** The nine authenticated pack operations of the P05 write boundary. */
export class ConvexPublicPackPublicationClient {
  constructor(private readonly transport: PackCatalogPublicationTransport) {}

  startPublicPackSnapshot(operation: PackCatalogOperationEnvelope, body: BodyOf<"start_pack_snapshot">, signal?: AbortSignal) {
    return this.transport.send(envelope("start_pack_snapshot", operation, body), signal);
  }
  applyPublicPackSnapshotBatch(operation: PackCatalogOperationEnvelope, body: BodyOf<"apply_pack_snapshot_batch">, signal?: AbortSignal) {
    return this.transport.send(envelope("apply_pack_snapshot_batch", operation, body), signal);
  }
  finalizePublicPackSnapshot(operation: PackCatalogOperationEnvelope, body: BodyOf<"finalize_pack_snapshot">, signal?: AbortSignal) {
    return this.transport.send(envelope("finalize_pack_snapshot", operation, body), signal);
  }
  activatePublicPackSnapshot(operation: PackCatalogOperationEnvelope, body: BodyOf<"activate_pack_snapshot">, signal?: AbortSignal) {
    return this.transport.send(envelope("activate_pack_snapshot", operation, body), signal);
  }
  getPublicPackPublicationStatus(operation: PackCatalogOperationEnvelope, body: BodyOf<"pack_publication_status">, signal?: AbortSignal) {
    return this.transport.send(envelope("pack_publication_status", operation, body), signal);
  }
  blockPublicPackSnapshot(operation: PackCatalogOperationEnvelope, body: BodyOf<"block_pack_snapshot">, signal?: AbortSignal) {
    return this.transport.send(envelope("block_pack_snapshot", operation, body), signal);
  }
  holdPublicPackHead(operation: PackCatalogOperationEnvelope, body: BodyOf<"hold_pack_head">, signal?: AbortSignal) {
    return this.transport.send(envelope("hold_pack_head", operation, body), signal);
  }
  activateRetainedPublicPackSnapshot(operation: PackCatalogOperationEnvelope, body: BodyOf<"activate_retained_pack_snapshot">, signal?: AbortSignal) {
    return this.transport.send(envelope("activate_retained_pack_snapshot", operation, body), signal);
  }
  resumePublicPackHead(operation: PackCatalogOperationEnvelope, body: BodyOf<"resume_pack_head">, signal?: AbortSignal) {
    return this.transport.send(envelope("resume_pack_head", operation, body), signal);
  }
}

/** The six authenticated profile operations of the P05 write boundary. */
export class ConvexPublicProfilePublicationClient {
  constructor(private readonly transport: PackCatalogPublicationTransport) {}

  startPublicProfileSnapshot(operation: PackCatalogOperationEnvelope, body: BodyOf<"start_profile_snapshot">, signal?: AbortSignal) {
    return this.transport.send(envelope("start_profile_snapshot", operation, body), signal);
  }
  applyPublicProfileSnapshotBatch(operation: PackCatalogOperationEnvelope, body: BodyOf<"apply_profile_snapshot_batch">, signal?: AbortSignal) {
    return this.transport.send(envelope("apply_profile_snapshot_batch", operation, body), signal);
  }
  finalizePublicProfileSnapshot(operation: PackCatalogOperationEnvelope, body: BodyOf<"finalize_profile_snapshot">, signal?: AbortSignal) {
    return this.transport.send(envelope("finalize_profile_snapshot", operation, body), signal);
  }
  activatePublicProfileSnapshot(operation: PackCatalogOperationEnvelope, body: BodyOf<"activate_profile_snapshot">, signal?: AbortSignal) {
    return this.transport.send(envelope("activate_profile_snapshot", operation, body), signal);
  }
  getPublicProfilePublicationStatus(operation: PackCatalogOperationEnvelope, body: BodyOf<"profile_publication_status">, signal?: AbortSignal) {
    return this.transport.send(envelope("profile_publication_status", operation, body), signal);
  }
  blockPublicProfileSnapshot(operation: PackCatalogOperationEnvelope, body: BodyOf<"block_profile_snapshot">, signal?: AbortSignal) {
    return this.transport.send(envelope("block_profile_snapshot", operation, body), signal);
  }
}
