import type {
  PinnedProviderReleaseInputs,
} from "@packscout/database";
import {
  publicVendorSchema,
} from "@packscout/contracts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const MAXIMUM_GATEWAY_RESPONSE_BYTES = 16 * 1_024 * 1_024;

export class DistributedPromotionGatewayError extends Error {
  readonly code = "DISTRIBUTED_PROMOTION_GATEWAY_UNAVAILABLE";

  constructor() {
    super("Distributed promotion gateway is unavailable.");
    this.name = "DistributedPromotionGatewayError";
  }
}

export class DistributedPromotionGatewayResponseError extends Error {
  readonly code = "DISTRIBUTED_PROMOTION_GATEWAY_RESPONSE_INVALID";

  constructor() {
    super("Distributed promotion gateway response is invalid.");
    this.name = "DistributedPromotionGatewayResponseError";
  }
}

export class DistributedPromotionGatewayAbortedError extends Error {
  readonly code = "DISTRIBUTED_PROMOTION_GATEWAY_ABORTED";

  constructor() {
    super("Distributed promotion gateway request was aborted.");
    this.name = "DistributedPromotionGatewayAbortedError";
  }
}

export interface DistributedPromotionGatewayOptions {
  readonly baseUrl: string;
  readonly bearerToken: Uint8Array;
  readonly timeoutMilliseconds: number;
  readonly fetch?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DistributedPromotionGatewayResponseError();
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) throw new DistributedPromotionGatewayResponseError();
}

function bigint(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
    throw new DistributedPromotionGatewayResponseError();
  }
  return BigInt(value);
}

function date(value: unknown): Date {
  if (typeof value !== "string") {
    throw new DistributedPromotionGatewayResponseError();
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new DistributedPromotionGatewayResponseError();
  }
  return parsed;
}

async function requestJson(
  options: DistributedPromotionGatewayOptions,
  path: string,
  body: unknown,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMilliseconds);
  try {
    const response = await (options.fetch ?? fetch)(
      new URL(path, options.baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${Buffer.from(options.bearerToken)
            .toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      },
    );
    const declaredLength = Number(response.headers.get("content-length"));
    if (!response.ok) {
      if (response.status >= 500) throw new DistributedPromotionGatewayError();
      throw new DistributedPromotionGatewayResponseError();
    }
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAXIMUM_GATEWAY_RESPONSE_BYTES
    ) throw new DistributedPromotionGatewayResponseError();
    if (response.body === null) {
      throw new DistributedPromotionGatewayResponseError();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > MAXIMUM_GATEWAY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new DistributedPromotionGatewayResponseError();
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (bytes.byteLength > MAXIMUM_GATEWAY_RESPONSE_BYTES) {
      throw new DistributedPromotionGatewayResponseError();
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new DistributedPromotionGatewayResponseError();
    }
  } catch (error) {
    if (callerSignal?.aborted) {
      throw new DistributedPromotionGatewayAbortedError();
    }
    if (
      error instanceof DistributedPromotionGatewayError ||
      error instanceof DistributedPromotionGatewayResponseError
    ) throw error;
    throw new DistributedPromotionGatewayError();
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function decodePin(value: unknown): PinnedProviderReleaseInputs {
  const source = record(value);
  exactKeys(source, [
    "providerId",
    "providerKey",
    "providerConfigVersionId",
    "providerConfigExpiresAt",
    "staleAfterSeconds",
    "centralSchemaVersion",
    "catalogVersionId",
    "catalogSchemaVersion",
    "catalogContentHash",
    "catalogThroughChangeSequence",
    "catalogCategories",
    "catalogCollectibles",
    "catalogAliases",
    "catalogArtifactVerificationHash",
    "correlationEventSequence",
    "correlationSnapshotHash",
    "categoryCorrelations",
    "collectibleCorrelations",
    "publicProfileVersionId",
    "publicProfileHash",
    "publicProvider",
  ]);
  if (
    typeof source.providerId !== "string" ||
    !UUID_PATTERN.test(source.providerId) ||
    typeof source.providerKey !== "string" ||
    !PROVIDER_KEY_PATTERN.test(source.providerKey) ||
    typeof source.providerConfigVersionId !== "string" ||
    !UUID_PATTERN.test(source.providerConfigVersionId) ||
    typeof source.catalogVersionId !== "string" ||
    !UUID_PATTERN.test(source.catalogVersionId) ||
    typeof source.publicProfileVersionId !== "string" ||
    !UUID_PATTERN.test(source.publicProfileVersionId) ||
    (source.providerConfigExpiresAt !== null &&
      typeof source.providerConfigExpiresAt !== "string") ||
    typeof source.staleAfterSeconds !== "number" ||
    !Number.isSafeInteger(source.staleAfterSeconds) ||
    source.staleAfterSeconds < 1 || source.staleAfterSeconds > 604_800 ||
    typeof source.centralSchemaVersion !== "string" ||
    typeof source.catalogSchemaVersion !== "string" ||
    typeof source.catalogContentHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(source.catalogContentHash) ||
    typeof source.catalogArtifactVerificationHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(source.catalogArtifactVerificationHash) ||
    typeof source.correlationSnapshotHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(source.correlationSnapshotHash) ||
    typeof source.publicProfileHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(source.publicProfileHash) ||
    !Array.isArray(source.categoryCorrelations) ||
    !Array.isArray(source.collectibleCorrelations) ||
    !Array.isArray(source.catalogCategories) ||
    !Array.isArray(source.catalogCollectibles) ||
    !Array.isArray(source.catalogAliases) ||
    source.catalogCategories.some((item) =>
      item === null || typeof item !== "object" || Array.isArray(item)) ||
    source.catalogCollectibles.some((item) =>
      item === null || typeof item !== "object" || Array.isArray(item)) ||
    source.catalogAliases.some((item) =>
      item === null || typeof item !== "object" || Array.isArray(item)) ||
    !publicVendorSchema.safeParse(source.publicProvider).success
  ) throw new DistributedPromotionGatewayResponseError();
  const categoryCorrelations = source.categoryCorrelations.map((value) => {
    const item = record(value);
    exactKeys(item, [
      "localCategoryId",
      "localEntityVersion",
      "publicCategoryId",
    ]);
    if (
      typeof item.localCategoryId !== "string" ||
      !UUID_PATTERN.test(item.localCategoryId) ||
      typeof item.publicCategoryId !== "string" ||
      !UUID_PATTERN.test(item.publicCategoryId)
    ) throw new DistributedPromotionGatewayResponseError();
    return { ...item, localEntityVersion: bigint(item.localEntityVersion) };
  });
  const collectibleCorrelations = source.collectibleCorrelations.map((value) => {
    const item = record(value);
    exactKeys(item, [
      "localCollectibleId",
      "localEntityVersion",
      "publicCollectibleId",
    ]);
    if (
      typeof item.localCollectibleId !== "string" ||
      !UUID_PATTERN.test(item.localCollectibleId) ||
      typeof item.publicCollectibleId !== "string" ||
      !UUID_PATTERN.test(item.publicCollectibleId)
    ) throw new DistributedPromotionGatewayResponseError();
    return { ...item, localEntityVersion: bigint(item.localEntityVersion) };
  });
  return {
    ...source,
    providerConfigExpiresAt: source.providerConfigExpiresAt === null
      ? null
      : date(source.providerConfigExpiresAt),
    catalogThroughChangeSequence: bigint(
      source.catalogThroughChangeSequence,
    ),
    correlationEventSequence: bigint(source.correlationEventSequence),
    categoryCorrelations,
    collectibleCorrelations,
  } as unknown as PinnedProviderReleaseInputs;
}

export class ProviderPromotionBootstrapGatewayClient {
  constructor(private readonly options: DistributedPromotionGatewayOptions) {}

  async load(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<PinnedProviderReleaseInputs> {
    if (!UUID_PATTERN.test(providerId)) {
      throw new TypeError("Provider promotion bootstrap scope is invalid.");
    }
    const response = record(await requestJson(
      this.options,
      "/api/internal/promotion-jobs/provider-bootstrap",
      { providerId: providerId.toLowerCase() },
      signal,
    ));
    exactKeys(response, ["pin"]);
    const pin = decodePin(response.pin);
    if (pin.providerId.toLowerCase() !== providerId.toLowerCase()) {
      throw new DistributedPromotionGatewayResponseError();
    }
    return pin;
  }
}
