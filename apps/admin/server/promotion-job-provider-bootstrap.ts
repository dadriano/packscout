import { createHash, timingSafeEqual } from "node:crypto";
import type { PinnedProviderReleaseInputs } from "@packscout/database";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const EMPTY_DIGEST = Buffer.alloc(32);

export type ProviderPromotionBootstrapFailureCode =
  | "PROVIDER_PROMOTION_BOOTSTRAP_UNAUTHORIZED"
  | "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE";

export class ProviderPromotionBootstrapError extends Error {
  constructor(readonly code: ProviderPromotionBootstrapFailureCode) {
    super("Provider promotion bootstrap failed.");
    this.name = "ProviderPromotionBootstrapError";
  }
}

export interface ProviderPromotionBootstrapCredentialSet {
  readonly tokenSha256ByProviderId: ReadonlyMap<string, string>;
}

export interface ProviderPromotionBootstrapRepository {
  pin(input: Readonly<{ providerId: string }>): Promise<PinnedProviderReleaseInputs>;
}

export interface SerializedPinnedProviderReleaseInputs
extends Omit<
  PinnedProviderReleaseInputs,
  | "providerConfigExpiresAt"
  | "catalogThroughChangeSequence"
  | "correlationEventSequence"
  | "categoryCorrelations"
  | "collectibleCorrelations"
> {
  readonly providerConfigExpiresAt: string | null;
  readonly catalogThroughChangeSequence: string;
  readonly correlationEventSequence: string;
  readonly categoryCorrelations: readonly Readonly<{
    localCategoryId: string;
    localEntityVersion: string;
    publicCategoryId: string;
  }>[];
  readonly collectibleCorrelations: readonly Readonly<{
    localCollectibleId: string;
    localEntityVersion: string;
    publicCollectibleId: string;
  }>[];
}

function fail(code: ProviderPromotionBootstrapFailureCode): never {
  throw new ProviderPromotionBootstrapError(code);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Central stores only a digest for each provider-scoped bootstrap credential.
 * The raw credential exists solely in that provider worker's secret store.
 */
export function readProviderPromotionBootstrapCredentials(
  value: string | undefined,
): ProviderPromotionBootstrapCredentialSet | null {
  if (value === undefined) return null;
  if (value.length < 2 || value.length > 16_384 || /[\r\n\0]/u.test(value)) {
    throw new TypeError("Provider promotion bootstrap configuration is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("Provider promotion bootstrap configuration is invalid.");
  }
  const source = record(parsed);
  const entries = source === null ? [] : Object.entries(source);
  if (
    entries.length < 1 || entries.length > 64 ||
    entries.some(([providerId, digest]) =>
      !UUID_PATTERN.test(providerId) ||
      typeof digest !== "string" || !SHA256_PATTERN.test(digest))
  ) throw new TypeError("Provider promotion bootstrap configuration is invalid.");
  const normalized = entries.map(([providerId, digest]) =>
    [providerId.toLowerCase(), String(digest)] as const);
  if (
    new Set(normalized.map(([providerId]) => providerId)).size !==
      normalized.length ||
    new Set(normalized.map(([, digest]) => digest)).size !== normalized.length
  ) throw new TypeError("Provider promotion bootstrap configuration is invalid.");
  return Object.freeze({
    tokenSha256ByProviderId: new Map(normalized),
  });
}

function presentedDigest(value: string): Buffer | null {
  if (!CANONICAL_BASE64_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength < 32 || bytes.byteLength > 128 ||
    bytes.toString("base64") !== value
  ) return null;
  return createHash("sha256").update(bytes).digest();
}

function serializePin(
  pin: PinnedProviderReleaseInputs,
): SerializedPinnedProviderReleaseInputs {
  return {
    ...pin,
    providerConfigExpiresAt: pin.providerConfigExpiresAt?.toISOString() ?? null,
    catalogThroughChangeSequence: pin.catalogThroughChangeSequence.toString(),
    correlationEventSequence: pin.correlationEventSequence.toString(),
    categoryCorrelations: pin.categoryCorrelations.map((correlation) => ({
      ...correlation,
      localEntityVersion: correlation.localEntityVersion.toString(),
    })),
    collectibleCorrelations: pin.collectibleCorrelations.map((correlation) => ({
      ...correlation,
      localEntityVersion: correlation.localEntityVersion.toString(),
    })),
  };
}

/** Provider-bound, read-only central bootstrap service. */
export class ProviderPromotionBootstrapService {
  constructor(private readonly dependencies: Readonly<{
    credentials: ProviderPromotionBootstrapCredentialSet;
    repository: ProviderPromotionBootstrapRepository;
  }>) {}

  async load(input: Readonly<{
    providerId: string;
    bearerTokenBase64: string;
  }>): Promise<Readonly<{ pin: SerializedPinnedProviderReleaseInputs }>> {
    const providerId = input.providerId.toLowerCase();
    const expectedHex = this.dependencies.credentials
      .tokenSha256ByProviderId.get(providerId);
    const actual = presentedDigest(input.bearerTokenBase64);
    const expected = expectedHex === undefined
      ? EMPTY_DIGEST
      : Buffer.from(expectedHex, "hex");
    const accepted = actual !== null && timingSafeEqual(actual, expected) &&
      expectedHex !== undefined;
    if (!accepted) fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAUTHORIZED");
    try {
      const pin = await this.dependencies.repository.pin({ providerId });
      if (pin.providerId.toLowerCase() !== providerId) {
        fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
      }
      return Object.freeze({ pin: serializePin(pin) });
    } catch (error) {
      if (error instanceof ProviderPromotionBootstrapError) throw error;
      fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
    }
  }
}
