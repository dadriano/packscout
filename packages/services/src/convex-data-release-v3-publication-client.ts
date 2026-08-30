import { createHash } from "node:crypto";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  MAX_DATA_RELEASE_V3_HTTP_BODY_BYTES,
  PRODUCTION_DATA_RELEASE_V3_PATHS,
  DATA_RELEASE_V3_RETAINED_EV_WITNESS_HASH_DOMAIN,
  MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_BYTES,
  dataReleaseV3RetainedEvWitnessRequestSchema,
  dataReleaseV3RetainedEvWitnessSchema,
  dataReleaseV3RetainedEvWitnessWithinByteLimit,
  dataReleaseV3RetainedEvWitnessReadinessRequestSchema,
  dataReleaseV3RetainedEvWitnessReadinessSchema,
  type DataReleaseV3RetainedEvWitnessReadinessRequest,
  type DataReleaseV3RetainedEvWitnessReadiness,
  type DataReleaseV3RetainedEvWitnessRequest,
  type DataReleaseV3RetainedEvWitness,
  canonicalJson,
  sha256CanonicalJson,
  type ProductionDataReleaseV3Path,
} from "@packscout/contracts";
import { z } from "zod";
import {
  PublicationClientError,
  SignedConvexPublicationHttpClient,
  ambiguousPublicationResponse,
  type SignedConvexPublicationHttpClientOptions,
} from "./convex-publication-http-client.ts";
import {
  DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
  DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
  DataReleaseV3PublicationPortError,
  type DataReleaseV3ActivateRequest,
  type DataReleaseV3ActiveState,
  type DataReleaseV3ApplyBatchRequest,
  type DataReleaseV3FinalizeRequest,
  type DataReleaseV3PublicationPort,
  type DataReleaseV3ProviderObservationPort,
  type DataReleaseV3Receipt,
  type DataReleaseV3RefreshProviderObservationRequest,
  type DataReleaseV3ReleaseStatus,
  type DataReleaseV3RollbackRequest,
  type DataReleaseV3StartRequest,
} from "./buyback-adjusted-ev-release-types.ts";

/**
 * Signed Convex transport for the data_release_v3 publication lifecycle
 * (task buyback-adjusted-ev/008).
 *
 * Rides the shared publication HTTP boundary: the same HMAC request signing,
 * nonce, timestamp window, byte limits, timeout, and signed-response
 * verification as every v2 family. On top of that boundary it verifies each
 * receipt's own `DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN` digest and binds every
 * receipt to the exact operation identity and request bytes it answered.
 * Request bodies are canonical JSON, so an identical replay of the same plan
 * sends byte-identical requests and converges on the stored server receipts.
 */

export type SignedConvexDataReleaseV3PublicationClientOptions =
  SignedConvexPublicationHttpClientOptions;

const ACTIVE_STATE_OPERATION_ID = "data-release-v3-active-state";

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const operationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u);
const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u);

const receiptSchema = z
  .object({
    schemaVersion: z.literal(DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION),
    operationKind: z.string().min(1).max(64),
    operationId: operationIdSchema,
    idempotencyKey: z.string().min(1).max(256),
    publicReleaseId: z.uuid().nullable(),
    result: z.string().min(1).max(64),
    serverTime: z.string().min(1).max(64),
    requestDigest: sha256HexSchema,
    details: z.record(z.string(), z.unknown()),
    receiptDigest: sha256HexSchema,
  })
  .strict();

const releaseCountsSchema = z
  .object({
    categories: z.number().int().min(0),
    collectibles: z.number().int().min(0),
    repacks: z.number().int().min(0),
    chases: z.number().int().min(0),
    searchShards: z.number().int().min(0),
  })
  .strict();

const releasePointerSchema = z
  .object({
    publicReleaseId: z.uuid(),
    releaseFingerprint: sha256HexSchema,
    methodVersion: z.literal(PACKSCOUT_BUYBACK_EV_METHOD_VERSION),
    confidencePolicyVersion: z.literal(
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    ),
    // Exact retained pre-policy pointer compatibility. Only absence is
    // accepted; a present marker must still be the current literal, and the
    // strict object rejects every other legacy drift. Remove with the
    // RetainedDataReleaseV3Pointer type after its audited migration condition.
    publicEvPolicyVersion: z
      .literal(PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3)
      .optional(),
    dataAsOf: z.string().min(1).max(64),
    completedAt: z.string().min(1).max(64),
    counts: releaseCountsSchema,
  })
  .strict();

const activeStateDetailsSchema = z
  .object({
    generation: z.number().int().min(0),
    activeRelease: releasePointerSchema.nullable(),
    previousRelease: releasePointerSchema.nullable(),
  })
  .strict();

const releaseStatusSchema = z
  .object({
    publicReleaseId: z.uuid(),
    releaseFingerprint: sha256HexSchema,
    lifecycle: z.enum(["staging", "complete", "failed"]),
    acceptedCounts: releaseCountsSchema,
    acceptedBatchCount: z.number().int().min(0),
    acceptedBatchChainHash: sha256HexSchema,
    acceptedEntityChainHashes: z
      .object({
        categories: sha256HexSchema,
        collectibles: sha256HexSchema,
        repacks: sha256HexSchema,
        chases: sha256HexSchema,
      })
      .strict(),
    acceptedSearchRowCount: z.number().int().min(0),
    acceptedSearchRowSetHash: sha256HexSchema,
    acceptedTopChaseCount: z.number().int().min(0),
    // Optional so a deployment predating the verified top-chase counter still
    // parses. An absent value means "this server does not report it", which is
    // deliberately distinct from a reported 0.
    acceptedVerifiedTopChaseCount: z.number().int().min(0).optional(),
    completedAt: z.string().min(1).max(64).nullable(),
  })
  .strict();

const statusDetailsSchema = z
  .object({ status: releaseStatusSchema })
  .strict();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The v3 receipt digest: the receipt body without its own digest field. */
export async function dataReleaseV3ReceiptHash(
  value: unknown,
): Promise<string> {
  const body =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (() => {
          const { receiptDigest: _receiptDigest, ...rest } = value as Record<
            string,
            unknown
          >;
          void _receiptDigest;
          return rest;
        })()
      : value;
  return sha256CanonicalJson(DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN, body);
}

function refuseInvalidRequest(): never {
  throw new DataReleaseV3PublicationPortError(
    "PUBLICATION_REQUEST_INVALID",
    false,
  );
}

function invalidResponse(): DataReleaseV3PublicationPortError {
  const ambiguous = ambiguousPublicationResponse("PUBLICATION_RESPONSE_INVALID");
  return new DataReleaseV3PublicationPortError(
    ambiguous.code,
    true,
    ambiguous.message,
  );
}

function asPortError(error: unknown): never {
  if (error instanceof DataReleaseV3PublicationPortError) throw error;
  if (error instanceof PublicationClientError) {
    throw new DataReleaseV3PublicationPortError(
      error.code,
      error.disposition === "retryable",
      error.message,
    );
  }
  throw error;
}

type WriteOperationBinding = Readonly<{
  path: ProductionDataReleaseV3Path;
  operationKind: string;
  publicReleaseId: string;
}>;

export class SignedConvexDataReleaseV3PublicationClient
  implements DataReleaseV3PublicationPort, DataReleaseV3ProviderObservationPort
{
  readonly #http: SignedConvexPublicationHttpClient;
  readonly #witnessHttp: SignedConvexPublicationHttpClient;

  constructor(options: SignedConvexDataReleaseV3PublicationClientOptions) {
    this.#http = new SignedConvexPublicationHttpClient({
      maximumRequestBytes: MAX_DATA_RELEASE_V3_HTTP_BODY_BYTES,
      ...options,
    });
    this.#witnessHttp = new SignedConvexPublicationHttpClient({
      ...options,
      maximumRequestBytes: Math.min(options.maximumRequestBytes ?? MAX_DATA_RELEASE_V3_HTTP_BODY_BYTES,
        MAX_DATA_RELEASE_V3_HTTP_BODY_BYTES),
      maximumResponseBytes: Math.min(options.maximumResponseBytes ?? MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_BYTES,
        MAX_DATA_RELEASE_V3_RETAINED_EV_WITNESS_BYTES),
    });
  }

  async #requestReceipt(
    path: ProductionDataReleaseV3Path,
    bodyJson: string,
    signal?: AbortSignal,
    http = this.#http,
  ): Promise<z.infer<typeof receiptSchema>> {
    let raw: unknown;
    try {
      raw = await http.request(
        path,
        bodyJson,
        dataReleaseV3ReceiptHash,
        signal,
      );
    } catch (error) {
      asPortError(error);
    }
    const receipt = receiptSchema.safeParse(raw);
    if (!receipt.success || receipt.data.requestDigest !== sha256(bodyJson)) {
      throw invalidResponse();
    }
    return receipt.data;
  }

  async #write(
    request:
      | DataReleaseV3StartRequest
      | DataReleaseV3ApplyBatchRequest
      | DataReleaseV3FinalizeRequest
      | DataReleaseV3ActivateRequest
      | DataReleaseV3RefreshProviderObservationRequest
      | DataReleaseV3RollbackRequest,
    binding: WriteOperationBinding,
    signal?: AbortSignal,
  ): Promise<DataReleaseV3Receipt> {
    if (
      request.schemaVersion !== DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION ||
      !operationIdSchema.safeParse(request.operationId).success ||
      !idempotencyKeySchema.safeParse(request.idempotencyKey).success
    ) {
      refuseInvalidRequest();
    }
    const receipt = await this.#requestReceipt(
      binding.path,
      canonicalJson(request),
      signal,
    );
    if (
      receipt.operationKind !== binding.operationKind ||
      receipt.operationId !== request.operationId ||
      receipt.idempotencyKey !== request.idempotencyKey ||
      receipt.publicReleaseId !== binding.publicReleaseId
    ) {
      throw invalidResponse();
    }
    return receipt;
  }

  async activeState(signal?: AbortSignal): Promise<DataReleaseV3ActiveState> {
    const bodyJson = canonicalJson({
      schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
      operationId: ACTIVE_STATE_OPERATION_ID,
    });
    const receipt = await this.#requestReceipt(
      PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
      bodyJson,
      signal,
    );
    const details = activeStateDetailsSchema.safeParse(receipt.details);
    if (
      !details.success ||
      receipt.operationKind !== "activeState" ||
      receipt.operationId !== ACTIVE_STATE_OPERATION_ID ||
      receipt.result !== "active_state" ||
      receipt.publicReleaseId !==
        (details.data.activeRelease?.publicReleaseId ?? null)
    ) {
      throw invalidResponse();
    }
    return details.data;
  }

  async status(
    publicReleaseId: string,
    signal?: AbortSignal,
  ): Promise<DataReleaseV3ReleaseStatus | null> {
    if (!z.uuid().safeParse(publicReleaseId).success) refuseInvalidRequest();
    const operationId = `data-release-v3-status:${publicReleaseId}`;
    const bodyJson = canonicalJson({
      schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
      operationId,
      publicReleaseId,
    });
    const receipt = await this.#requestReceipt(
      PRODUCTION_DATA_RELEASE_V3_PATHS.status,
      bodyJson,
      signal,
    );
    if (
      receipt.operationKind !== "status" ||
      receipt.operationId !== operationId ||
      receipt.publicReleaseId !== publicReleaseId
    ) {
      throw invalidResponse();
    }
    if (receipt.result === "not_found") {
      if (Object.keys(receipt.details).length !== 0) throw invalidResponse();
      return null;
    }
    const details = statusDetailsSchema.safeParse(receipt.details);
    if (
      !details.success ||
      receipt.result !== "status" ||
      details.data.status.publicReleaseId !== publicReleaseId
    ) {
      throw invalidResponse();
    }
    return details.data.status;
  }

  /** Scoped raw retention evidence, authenticated independently of public projections. */
  async retainedEvWitnessReadiness(request: DataReleaseV3RetainedEvWitnessReadinessRequest,
    signal?: AbortSignal): Promise<DataReleaseV3RetainedEvWitnessReadiness> {
    const parsedRequest = dataReleaseV3RetainedEvWitnessReadinessRequestSchema.safeParse(request);
    if (!parsedRequest.success) return refuseInvalidRequest();
    const operationId = "data-release-v3-retained-ev-readiness";
    const receipt = await this.#requestReceipt(PRODUCTION_DATA_RELEASE_V3_PATHS.retainedEvWitness,
      canonicalJson({ schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION, operationId,
        mode: "readiness", ...parsedRequest.data }), signal, this.#witnessHttp);
    const parsed = dataReleaseV3RetainedEvWitnessReadinessSchema.safeParse(receipt.details);
    if (!parsed.success || receipt.operationKind !== "retainedEvWitnessReadiness" ||
        receipt.result !== "retained_ev_witness_ready" || receipt.operationId !== operationId ||
        receipt.idempotencyKey !== operationId || receipt.publicReleaseId !== request.expectedActivePublicReleaseId ||
        parsed.data.generation !== request.expectedGeneration ||
        parsed.data.activePublicReleaseId !== request.expectedActivePublicReleaseId ||
        parsed.data.activeReleaseFingerprint !== request.expectedActiveReleaseFingerprint) throw invalidResponse();
    return parsed.data;
  }

  /** A real witness always requests at least one exact repack scope. */
  async retainedEvWitness(request: DataReleaseV3RetainedEvWitnessRequest,
    signal?: AbortSignal): Promise<DataReleaseV3RetainedEvWitness> {
    const parsedRequest = dataReleaseV3RetainedEvWitnessRequestSchema.safeParse(request);
    if (!parsedRequest.success) return refuseInvalidRequest();
    const operationId = `data-release-v3-retained-ev:${request.expectedActivePublicReleaseId}`;
    const receipt = await this.#requestReceipt(PRODUCTION_DATA_RELEASE_V3_PATHS.retainedEvWitness,
      canonicalJson({ schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION, operationId,
        ...parsedRequest.data }), signal, this.#witnessHttp);
    const parsed = dataReleaseV3RetainedEvWitnessSchema.safeParse(receipt.details);
    if (!parsed.success || !dataReleaseV3RetainedEvWitnessWithinByteLimit(receipt) ||
        receipt.operationKind !== "retainedEvWitness" || receipt.result !== "retained_ev_witness" ||
        receipt.operationId !== operationId || receipt.idempotencyKey !== operationId ||
        receipt.publicReleaseId !== request.expectedActivePublicReleaseId) throw invalidResponse();
    const { witnessSha256, ...witness } = parsed.data;
    const responseScopes = witness.entries.map(({ vendorKey, publicVendorId, publicRepackId }) =>
      ({ vendorKey, publicVendorId, publicRepackId }));
    if (witness.generation !== request.expectedGeneration ||
        witness.activePublicReleaseId !== request.expectedActivePublicReleaseId ||
        witness.activeReleaseFingerprint !== request.expectedActiveReleaseFingerprint ||
        canonicalJson(responseScopes) !== canonicalJson(request.scopes) ||
        await sha256CanonicalJson(DATA_RELEASE_V3_RETAINED_EV_WITNESS_HASH_DOMAIN, witness) !== witnessSha256) {
      throw invalidResponse();
    }
    return parsed.data;
  }

  async start(
    request: DataReleaseV3StartRequest,
    signal?: AbortSignal,
  ): Promise<DataReleaseV3Receipt> {
    return this.#write(request, {
      path: PRODUCTION_DATA_RELEASE_V3_PATHS.start,
      operationKind: "start",
      publicReleaseId: request.publicReleaseId,
    }, signal);
  }

  async applyBatch(
    request: DataReleaseV3ApplyBatchRequest,
    signal?: AbortSignal,
  ): Promise<DataReleaseV3Receipt> {
    return this.#write(request, {
      path: PRODUCTION_DATA_RELEASE_V3_PATHS.applyBatch,
      operationKind: "applyBatch",
      publicReleaseId: request.publicReleaseId,
    }, signal);
  }

  async finalize(
    request: DataReleaseV3FinalizeRequest,
    signal?: AbortSignal,
  ): Promise<DataReleaseV3Receipt> {
    return this.#write(request, {
      path: PRODUCTION_DATA_RELEASE_V3_PATHS.finalize,
      operationKind: "finalize",
      publicReleaseId: request.publicReleaseId,
    }, signal);
  }

  async activate(
    request: DataReleaseV3ActivateRequest,
    signal?: AbortSignal,
  ): Promise<DataReleaseV3Receipt> {
    return this.#write(request, {
      path: PRODUCTION_DATA_RELEASE_V3_PATHS.activate,
      operationKind: "activate",
      publicReleaseId: request.publicReleaseId,
    }, signal);
  }

  async rollback(
    request: DataReleaseV3RollbackRequest,
    signal?: AbortSignal,
  ): Promise<DataReleaseV3Receipt> {
    return this.#write(request, {
      path: PRODUCTION_DATA_RELEASE_V3_PATHS.rollback,
      operationKind: "rollback",
      publicReleaseId: request.targetPublicReleaseId,
    }, signal);
  }

  async refreshProviderObservation(
    request: DataReleaseV3RefreshProviderObservationRequest,
    signal?: AbortSignal,
  ): Promise<DataReleaseV3Receipt> {
    return this.#write(request, {
      path: PRODUCTION_DATA_RELEASE_V3_PATHS.refreshProviderObservation,
      operationKind: "refreshProviderObservation",
      publicReleaseId: request.publicReleaseId,
    }, signal);
  }
}
