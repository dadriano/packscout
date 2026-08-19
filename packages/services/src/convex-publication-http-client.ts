import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  canonicalJson,
  type CatalogManifestErrorCode,
  type CatalogRetentionErrorCode,
  MAX_PRODUCTION_AUTH_SECRET_BYTES,
  MAX_PRODUCTION_HTTP_BODY_BYTES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES,
  PRODUCTION_AUTH_HEADER_NAMES,
  PRODUCTION_AUTH_KEY_ID_PATTERN,
  PRODUCTION_AUTH_NONCE_PATTERN,
  PRODUCTION_AUTH_SIGNATURE_VERSION,
  PRODUCTION_AUTH_TIMESTAMP_PATTERN,
  classifyProductionDataReleaseError,
  productionErrorEnvelopeSchema,
  productionPublicationReceiptSigningValue,
  productionPublicationRequestSigningValue,
  productionReceiptHash,
  type ProviderReleaseErrorCode,
  type ProductionDataReleaseErrorCode,
  type ProductionPublicationPath,
} from "@packscout/contracts";

export type PublicationServerErrorCode =
  | ProductionDataReleaseErrorCode
  | ProviderReleaseErrorCode
  | CatalogManifestErrorCode
  | CatalogRetentionErrorCode;

export type PublicationClientFailureCode =
  | PublicationServerErrorCode
  | "PUBLICATION_CANCELLED"
  | "PUBLICATION_NETWORK_ERROR"
  | "PUBLICATION_TIMEOUT"
  | "PUBLICATION_RESPONSE_INVALID"
  | "PUBLICATION_RESPONSE_AUTH_INVALID";

export class PublicationClientError extends Error {
  constructor(
    readonly code: PublicationClientFailureCode,
    readonly disposition: "retryable" | "terminal",
    readonly ambiguous: boolean,
    readonly retryAfterMilliseconds: number | null = null,
    readonly canonicalErrorResponseBody: string | null = null,
    readonly errorResponseSha256: string | null = null,
  ) {
    super("Convex publication request failed safely.");
    // Preserve the established public error identity used by the catalog lane.
    this.name = "CatalogPublicationClientError";
  }
}

export interface PublicationErrorResponseBoundary {
  readonly parse: (
    value: unknown,
  ) => Readonly<{ error: string; code: PublicationServerErrorCode }> | null;
  readonly classify: (
    code: PublicationServerErrorCode,
  ) => "bounded_retry" | "authentication" | "terminal";
}

export interface SignedPublicationResult<T> {
  readonly receipt: T;
  readonly canonicalReceiptBody: string;
  readonly receiptSha256: string;
  readonly exactResponseBody: string;
  readonly exactResponseSha256: string;
}

export interface SignedConvexPublicationHttpClientOptions {
  readonly baseUrl: string;
  readonly keyId: string;
  readonly secret: Uint8Array;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly nonce?: () => string;
  readonly timeoutMilliseconds?: number;
  readonly maximumRequestBytes?: number;
  readonly maximumResponseBytes?: number;
  readonly errorResponseBoundary?: PublicationErrorResponseBoundary;
}

type ReceiptHash = (value: unknown) => Promise<string>;

const MAX_SIGNED_PUBLICATION_RESPONSE_BYTES = 512 * 1_024;

const legacyErrorResponseBoundary: PublicationErrorResponseBoundary = {
  parse(value) {
    const parsed = productionErrorEnvelopeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  classify(code) {
    return classifyProductionDataReleaseError(
      code as ProductionDataReleaseErrorCode,
    );
  },
};

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

function sha256(value: string): string {
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

export function ambiguousPublicationResponse(
  code: Extract<
    PublicationClientFailureCode,
    "PUBLICATION_RESPONSE_INVALID" | "PUBLICATION_RESPONSE_AUTH_INVALID"
  >,
  retryAfterMilliseconds: number | null = null,
): PublicationClientError {
  return new PublicationClientError(
    code,
    "retryable",
    true,
    retryAfterMilliseconds,
  );
}

function cancelledError(): PublicationClientError {
  return new PublicationClientError(
    "PUBLICATION_CANCELLED",
    "retryable",
    true,
  );
}

function refuseIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledError();
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
    throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
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
      throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
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
    throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
  }
}

function signedEnvelope(value: unknown): Readonly<{
  ok: true;
  receipt: Readonly<Record<string, unknown>>;
  responseAuth: Readonly<{
    signatureVersion: typeof PRODUCTION_AUTH_SIGNATURE_VERSION;
    keyId: string;
    receiptDigest: string;
    signature: string;
  }>;
}> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  const receipt = envelope.receipt;
  const auth = envelope.responseAuth;
  if (
    envelope.ok !== true ||
    Object.keys(envelope).sort().join(",") !== "ok,receipt,responseAuth" ||
    typeof receipt !== "object" || receipt === null || Array.isArray(receipt) ||
    typeof auth !== "object" || auth === null || Array.isArray(auth) ||
    Object.keys(auth).sort().join(",") !==
      "keyId,receiptDigest,signature,signatureVersion"
  ) return null;
  const responseAuth = auth as Record<string, unknown>;
  if (
    responseAuth.signatureVersion !== PRODUCTION_AUTH_SIGNATURE_VERSION ||
    typeof responseAuth.keyId !== "string" ||
    typeof responseAuth.receiptDigest !== "string" ||
    typeof responseAuth.signature !== "string"
  ) return null;
  return {
    ok: true,
    receipt: receipt as Readonly<Record<string, unknown>>,
    responseAuth: {
      signatureVersion: PRODUCTION_AUTH_SIGNATURE_VERSION,
      keyId: responseAuth.keyId,
      receiptDigest: responseAuth.receiptDigest,
      signature: responseAuth.signature,
    },
  };
}

/** Shared byte, timeout, cancellation, request-HMAC, and response-HMAC boundary. */
export class SignedConvexPublicationHttpClient {
  readonly #baseUrl: URL;
  readonly #errorResponseBoundary: PublicationErrorResponseBoundary;
  readonly #fetch: typeof fetch;
  readonly #keyId: string;
  readonly #maximumRequestBytes: number;
  readonly #maximumResponseBytes: number;
  readonly #nonce: () => string;
  readonly #now: () => Date;
  readonly #secret: Buffer;
  readonly #timeoutMilliseconds: number;

  constructor(options: SignedConvexPublicationHttpClientOptions) {
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
    this.#errorResponseBoundary = options.errorResponseBoundary ??
      legacyErrorResponseBoundary;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#keyId = options.keyId;
    this.#secret = Buffer.from(options.secret);
    this.#now = options.now ?? (() => new Date());
    this.#nonce = options.nonce ?? secureNonce;
    this.#timeoutMilliseconds = boundedInteger(
      options.timeoutMilliseconds, 10_000, 100, 30_000,
    );
    this.#maximumRequestBytes = boundedInteger(
      options.maximumRequestBytes,
      MAX_PRODUCTION_HTTP_BODY_BYTES,
      1_024,
      MAX_SIGNED_PUBLICATION_RESPONSE_BYTES,
    );
    this.#maximumResponseBytes = boundedInteger(
      options.maximumResponseBytes,
      MAX_PRODUCTION_HTTP_BODY_BYTES,
      1_024,
      MAX_SIGNED_PUBLICATION_RESPONSE_BYTES,
    );
  }

  async request(
    path: ProductionPublicationPath,
    bodyJson: string,
    innerReceiptHash: ReceiptHash,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return (await this.requestSigned(
      path,
      bodyJson,
      innerReceiptHash,
      signal,
    )).receipt;
  }

  async requestSigned(
    path: ProductionPublicationPath,
    bodyJson: string,
    innerReceiptHash: ReceiptHash,
    signal?: AbortSignal,
    responseReceiptHash: ReceiptHash = productionReceiptHash,
  ): Promise<SignedPublicationResult<unknown>> {
    if (Buffer.byteLength(bodyJson, "utf8") > this.#maximumRequestBytes) {
      throw new PublicationClientError(
        "PUBLICATION_BODY_TOO_LARGE", "terminal", false,
      );
    }
    refuseIfCancelled(signal);
    const now = this.#now();
    const timestamp = String(now.getTime());
    const nonce = this.#nonce();
    if (!Number.isFinite(now.getTime()) ||
        !PRODUCTION_AUTH_TIMESTAMP_PATTERN.test(timestamp) ||
        !PRODUCTION_AUTH_NONCE_PATTERN.test(nonce)) {
      throw new PublicationClientError(
        "PUBLICATION_AUTH_INVALID", "terminal", false,
      );
    }
    const bodyDigest = sha256(bodyJson);
    const signature = createHmac("sha256", this.#secret)
      .update(productionPublicationRequestSigningValue({
        method: "POST", path, bodyDigest, timestamp, nonce,
      }))
      .digest("hex");
    const controller = new AbortController();
    let timedOut = false;
    const cancelRequest = () => controller.abort();
    signal?.addEventListener("abort", cancelRequest, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMilliseconds);
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
      if (signal?.aborted === true) throw cancelledError();
      if (error instanceof PublicationClientError) throw error;
      throw new PublicationClientError(
        timedOut ? "PUBLICATION_TIMEOUT" : "PUBLICATION_NETWORK_ERROR",
        "retryable",
        true,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelRequest);
    }
    refuseIfCancelled(signal);
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw ambiguousPublicationResponse(
        "PUBLICATION_RESPONSE_INVALID",
        retryAfterMilliseconds(response, now),
      );
    }
    if (!response.ok) {
      const error = this.#errorResponseBoundary.parse(json);
      if (error === null) {
        throw ambiguousPublicationResponse(
          "PUBLICATION_RESPONSE_INVALID",
          retryAfterMilliseconds(response, now),
        );
      }
      const canonicalErrorResponseBody = canonicalJson(error);
      const retryable = response.status === 408 || response.status === 429 ||
        response.status >= 500 ||
        this.#errorResponseBoundary.classify(error.code) === "bounded_retry";
      throw new PublicationClientError(
        error.code,
        retryable ? "retryable" : "terminal",
        retryable,
        retryAfterMilliseconds(response, now),
        canonicalErrorResponseBody,
        sha256(canonicalErrorResponseBody),
      );
    }
    const envelope = signedEnvelope(json);
    if (envelope === null || envelope.responseAuth.keyId !== this.#keyId) {
      throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
    }
    const outerDigest = await responseReceiptHash(envelope.receipt);
    refuseIfCancelled(signal);
    const expectedSignature = createHmac("sha256", this.#secret)
      .update(productionPublicationReceiptSigningValue(outerDigest))
      .digest("hex");
    if (!equalHex(outerDigest, envelope.responseAuth.receiptDigest) ||
        !equalHex(expectedSignature, envelope.responseAuth.signature)) {
      throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_AUTH_INVALID");
    }
    const receiptDigest = envelope.receipt.receiptDigest;
    if (receiptDigest !== null) {
      if (typeof receiptDigest !== "string") {
        throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_AUTH_INVALID");
      }
      const { receiptDigest: _receiptDigest, ...withoutDigest } = envelope.receipt;
      void _receiptDigest;
      const innerDigest = await innerReceiptHash(withoutDigest);
      refuseIfCancelled(signal);
      if (!equalHex(innerDigest, receiptDigest)) {
        throw ambiguousPublicationResponse("PUBLICATION_RESPONSE_AUTH_INVALID");
      }
    }
    refuseIfCancelled(signal);
    const canonicalReceiptBody = canonicalJson(envelope.receipt);
    return {
      receipt: envelope.receipt,
      canonicalReceiptBody,
      receiptSha256: sha256(canonicalReceiptBody),
      exactResponseBody: text,
      exactResponseSha256: sha256(text),
    };
  }
}
