import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  DATA_RELEASE_SCHEMA_VERSION,
  MAX_PRODUCTION_AUTH_SECRET_BYTES,
  MAX_PRODUCTION_HTTP_BODY_BYTES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES,
  PRODUCTION_AUTH_HEADER_NAMES,
  PRODUCTION_AUTH_KEY_ID_PATTERN,
  PRODUCTION_AUTH_NONCE_PATTERN,
  PRODUCTION_AUTH_SIGNATURE_VERSION,
  PRODUCTION_AUTH_TIMESTAMP_PATTERN,
  PRODUCTION_DATA_RELEASE_PATHS,
  canonicalJson,
  classifyProductionDataReleaseError,
  productionErrorEnvelopeSchema,
  productionPublicationReceiptSigningValue,
  productionPublicationRequestSigningValue,
  productionReceiptHash,
  productionSignedReceiptEnvelopeSchema,
  type ProductionDataReleaseErrorCode,
  type ProductionDataReleasePath,
  type ProductionReceipt,
  type ProductionStatusNotFoundReceipt,
} from "@packscout/contracts";
import {
  validateCatalogPromotionOperation,
  validateCatalogPromotionReceipt,
} from "./catalog-promotion-operations.ts";
import type {
  CatalogPromotionOperation,
  CatalogPublicationStatusInput,
  CatalogPublicationTransport,
} from "./catalog-promotion-types.ts";


export type CatalogPublicationClientFailureCode =
  | ProductionDataReleaseErrorCode
  | "PUBLICATION_NETWORK_ERROR"
  | "PUBLICATION_TIMEOUT"
  | "PUBLICATION_RESPONSE_INVALID"
  | "PUBLICATION_RESPONSE_AUTH_INVALID";

export class CatalogPublicationClientError extends Error {
  constructor(
    readonly code: CatalogPublicationClientFailureCode,
    readonly disposition: "retryable" | "terminal",
    readonly ambiguous: boolean,
    readonly retryAfterMilliseconds: number | null = null,
  ) {
    super("Convex publication request failed safely.");
    this.name = "CatalogPublicationClientError";
  }
}

export interface SignedConvexCatalogPublicationClientOptions {
  readonly baseUrl: string;
  readonly keyId: string;
  readonly secret: Uint8Array;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly nonce?: () => string;
  readonly timeoutMilliseconds?: number;
  readonly maximumResponseBytes?: number;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError("Convex publication client limit is invalid.");
  }
  return resolved;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secureNonce(): string {
  return randomBytes(18).toString("base64url");
}

function equalHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function retryAfterMilliseconds(response: Response, now: Date): number | null {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  if (/^[0-9]{1,5}$/u.test(value)) {
    return Math.min(Number(value) * 1_000, 60_000);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, at - now.getTime()), 60_000);
}

async function boundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new CatalogPublicationClientError(
      "PUBLICATION_RESPONSE_INVALID", "terminal", false,
    );
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new CatalogPublicationClientError(
        "PUBLICATION_RESPONSE_INVALID", "terminal", false,
      );
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CatalogPublicationClientError(
      "PUBLICATION_RESPONSE_INVALID", "terminal", false,
    );
  }
}

export class SignedConvexCatalogPublicationClient
  implements CatalogPublicationTransport
{
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #keyId: string;
  readonly #maximumResponseBytes: number;
  readonly #nonce: () => string;
  readonly #now: () => Date;
  readonly #secret: Buffer;
  readonly #timeoutMilliseconds: number;

  constructor(options: SignedConvexCatalogPublicationClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password ||
        baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
      throw new RangeError("Convex publication base URL is invalid.");
    }
    if (!PRODUCTION_AUTH_KEY_ID_PATTERN.test(options.keyId)) {
      throw new RangeError("Convex publication key ID is invalid.");
    }
    if (options.secret.byteLength < MIN_PRODUCTION_AUTH_SECRET_BYTES ||
        options.secret.byteLength > MAX_PRODUCTION_AUTH_SECRET_BYTES) {
      throw new RangeError("Convex publication secret is invalid.");
    }
    this.#baseUrl = baseUrl;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#keyId = options.keyId;
    this.#secret = Buffer.from(options.secret);
    this.#now = options.now ?? (() => new Date());
    this.#nonce = options.nonce ?? secureNonce;
    this.#timeoutMilliseconds = boundedInteger(
      options.timeoutMilliseconds, 10_000, 100, 30_000,
    );
    this.#maximumResponseBytes = boundedInteger(
      options.maximumResponseBytes,
      MAX_PRODUCTION_HTTP_BODY_BYTES,
      1_024,
      MAX_PRODUCTION_HTTP_BODY_BYTES,
    );
  }

  async send(operation: CatalogPromotionOperation): Promise<ProductionReceipt> {
    try {
      validateCatalogPromotionOperation(operation);
    } catch {
      throw new CatalogPublicationClientError(
        "PUBLICATION_REQUEST_INVALID", "terminal", false,
      );
    }
    const receipt = await this.request(
      operation.path,
      operation.bodyJson,
    );
    return validateCatalogPromotionReceipt(receipt, {
      operationId: operation.operationId,
      publicationId: operation.publicationId,
      requestDigest: operation.bodyDigest,
      kind: operation.kind,
      bodyJson: operation.bodyJson,
    });
  }

  async status(input: CatalogPublicationStatusInput): Promise<ProductionReceipt | null> {
    const bodyJson = canonicalJson({
      schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
      operationId: input.operationId,
      publicationId: input.publicationId,
    });
    const receipt = await this.request(PRODUCTION_DATA_RELEASE_PATHS.status, bodyJson);
    if (!("operationKind" in receipt)) {
      if (receipt.operationId !== input.operationId ||
          receipt.publicationId !== input.publicationId ||
          receipt.requestDigest !== sha256Utf8(bodyJson)) {
        throw new CatalogPublicationClientError(
          "PUBLICATION_RESPONSE_INVALID", "terminal", false,
        );
      }
      return null;
    }
    return validateCatalogPromotionReceipt(receipt, {
      operationId: input.operationId,
      publicationId: input.publicationId,
      requestDigest: input.expectedRequestDigest,
      kind: input.expectedKind,
    });
  }

  private async request(
    path: ProductionDataReleasePath,
    bodyJson: string,
  ): Promise<ProductionReceipt | ProductionStatusNotFoundReceipt> {
    if (Buffer.byteLength(bodyJson, "utf8") > MAX_PRODUCTION_HTTP_BODY_BYTES) {
      throw new CatalogPublicationClientError(
        "PUBLICATION_BODY_TOO_LARGE", "terminal", false,
      );
    }
    const now = this.#now();
    const timestamp = String(now.getTime());
    const nonce = this.#nonce();
    if (!Number.isFinite(now.getTime()) ||
        !PRODUCTION_AUTH_TIMESTAMP_PATTERN.test(timestamp) ||
        !PRODUCTION_AUTH_NONCE_PATTERN.test(nonce)) {
      throw new CatalogPublicationClientError(
        "PUBLICATION_AUTH_INVALID", "terminal", false,
      );
    }
    const bodyDigest = sha256Utf8(bodyJson);
    const signature = createHmac("sha256", this.#secret)
      .update(productionPublicationRequestSigningValue({
        method: "POST", path, bodyDigest, timestamp, nonce,
      }))
      .digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMilliseconds);
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          [PRODUCTION_AUTH_HEADER_NAMES.signatureVersion]:
            PRODUCTION_AUTH_SIGNATURE_VERSION,
          [PRODUCTION_AUTH_HEADER_NAMES.keyId]: this.#keyId,
          [PRODUCTION_AUTH_HEADER_NAMES.timestamp]: timestamp,
          [PRODUCTION_AUTH_HEADER_NAMES.nonce]: nonce,
          [PRODUCTION_AUTH_HEADER_NAMES.contentSha256]: bodyDigest,
          [PRODUCTION_AUTH_HEADER_NAMES.signature]: signature,
        },
        body: bodyJson,
        signal: controller.signal,
      });
      text = await boundedResponseText(response, this.#maximumResponseBytes);
    } catch (error) {
      if (error instanceof CatalogPublicationClientError) throw error;
      const timeout = controller.signal.aborted;
      throw new CatalogPublicationClientError(
        timeout ? "PUBLICATION_TIMEOUT" : "PUBLICATION_NETWORK_ERROR",
        "retryable",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new CatalogPublicationClientError(
          "PUBLICATION_NETWORK_ERROR", "retryable", true,
          retryAfterMilliseconds(response, now),
        );
      }
      throw new CatalogPublicationClientError(
        "PUBLICATION_RESPONSE_INVALID", "terminal", false,
      );
    }
    if (!response.ok) {
      const error = productionErrorEnvelopeSchema.safeParse(json);
      if (!error.success) {
        const retryable = response.status === 408 || response.status === 429 ||
          response.status >= 500;
        throw new CatalogPublicationClientError(
          "PUBLICATION_RESPONSE_INVALID",
          retryable ? "retryable" : "terminal",
          retryable,
          retryAfterMilliseconds(response, now),
        );
      }
      const retryable = response.status === 408 || response.status === 429 ||
        response.status >= 500 ||
        classifyProductionDataReleaseError(error.data.code) === "bounded_retry";
      throw new CatalogPublicationClientError(
        error.data.code,
        retryable ? "retryable" : "terminal",
        retryable,
        retryAfterMilliseconds(response, now),
      );
    }
    const envelope = productionSignedReceiptEnvelopeSchema.safeParse(json);
    if (!envelope.success || envelope.data.responseAuth.keyId !== this.#keyId) {
      throw new CatalogPublicationClientError(
        "PUBLICATION_RESPONSE_INVALID", "terminal", false,
      );
    }
    const outerDigest = await productionReceiptHash(envelope.data.receipt);
    const expectedSignature = createHmac("sha256", this.#secret)
      .update(productionPublicationReceiptSigningValue(outerDigest))
      .digest("hex");
    if (!equalHex(outerDigest, envelope.data.responseAuth.receiptDigest) ||
        !equalHex(expectedSignature, envelope.data.responseAuth.signature)) {
      throw new CatalogPublicationClientError(
        "PUBLICATION_RESPONSE_AUTH_INVALID", "terminal", false,
      );
    }
    const receipt = envelope.data.receipt;
    if (receipt.receiptDigest !== null) {
      const { receiptDigest, ...withoutDigest } = receipt;
      const innerDigest = await productionReceiptHash(withoutDigest);
      if (!equalHex(innerDigest, receiptDigest)) {
        throw new CatalogPublicationClientError(
          "PUBLICATION_RESPONSE_AUTH_INVALID", "terminal", false,
        );
      }
    }
    return receipt;
  }
}
