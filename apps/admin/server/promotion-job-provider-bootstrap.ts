import { createHash, timingSafeEqual } from "node:crypto";
import type { PinnedProviderReleaseInputs } from "@packscout/database";
import {
  PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAMES,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES,
  PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS,
  PROVIDER_PROMOTION_BOOTSTRAP_STREAM_VERSION,
  providerPromotionBootstrapCatalogSectionsWithinByteBudget,
  providerPromotionBootstrapSnapshotFingerprint,
  type ProviderPromotionBootstrapCounts,
  type ProviderPromotionBootstrapSection,
} from "@packscout/contracts";

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
  pin(input: Readonly<{
    providerId: string;
    signal: AbortSignal;
    deadlineAt: number;
  }>): Promise<PinnedProviderReleaseInputs>;
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

export type SerializedProviderPromotionBootstrapPin = Omit<
  SerializedPinnedProviderReleaseInputs,
  ProviderPromotionBootstrapSection
>;

export type ProviderPromotionBootstrapStreamFrame =
  | Readonly<{
      kind: "header";
      version: typeof PROVIDER_PROMOTION_BOOTSTRAP_STREAM_VERSION;
      snapshotFingerprint: string;
      counts: ProviderPromotionBootstrapCounts;
      pin: SerializedProviderPromotionBootstrapPin;
    }>
  | Readonly<{
      kind: "page";
      section: ProviderPromotionBootstrapSection;
      offset: number;
      records: readonly unknown[];
    }>
  | Readonly<{
      kind: "complete";
      snapshotFingerprint: string;
    }>;

function fail(code: ProviderPromotionBootstrapFailureCode): never {
  throw new ProviderPromotionBootstrapError(code);
}

function assertAvailable(signal: AbortSignal, deadlineAt?: number): void {
  if (
    signal.aborted ||
    (deadlineAt !== undefined && Date.now() >= deadlineAt)
  ) fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
}

async function awaitWhileAvailable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<T> {
  assertAvailable(signal, deadlineAt);
  let cancel!: () => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new ProviderPromotionBootstrapError(
      "PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE",
    ));
  });
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const deadlineTimer = setTimeout(
    cancel,
    Math.max(0, deadlineAt - Date.now()),
  );
  try {
    const result = await Promise.race([operation, cancellation]);
    assertAvailable(signal, deadlineAt);
    return result;
  } finally {
    clearTimeout(deadlineTimer);
    signal.removeEventListener("abort", cancel);
  }
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

function pinMetadata(
  pin: PinnedProviderReleaseInputs,
): SerializedProviderPromotionBootstrapPin {
  const metadata = {
    ...pin,
    providerConfigExpiresAt: pin.providerConfigExpiresAt?.toISOString() ?? null,
    catalogThroughChangeSequence: pin.catalogThroughChangeSequence.toString(),
    correlationEventSequence: pin.correlationEventSequence.toString(),
  } as Record<string, unknown>;
  for (const section of PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS) {
    delete metadata[section];
  }
  return metadata as SerializedProviderPromotionBootstrapPin;
}

function streamCounts(
  pin: PinnedProviderReleaseInputs,
): ProviderPromotionBootstrapCounts {
  const counts = Object.fromEntries(
    PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS.map((section) => [
      section,
      pin[section].length,
    ]),
  ) as unknown as ProviderPromotionBootstrapCounts;
  for (const section of PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS) {
    if (counts[section] > PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS[section]) {
      fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
    }
  }
  return Object.freeze(counts);
}

function frameByteLength(frame: ProviderPromotionBootstrapStreamFrame): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8") + 1;
}

function serializablePageValue(
  section: ProviderPromotionBootstrapSection,
  value: unknown,
): unknown {
  if (
    section !== "categoryCorrelations" &&
    section !== "collectibleCorrelations"
  ) return value;
  const correlation = value as Readonly<{
    localEntityVersion: bigint;
  }> & Record<string, unknown>;
  const { localEntityVersion, ...serialized } = correlation;
  return { ...serialized, localEntityVersion: localEntityVersion.toString() };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function* pageFrames(
  pin: PinnedProviderReleaseInputs,
  signal: AbortSignal,
  deadlineAt: number,
): AsyncGenerator<ProviderPromotionBootstrapStreamFrame> {
  for (const section of PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS) {
    await yieldToEventLoop();
    assertAvailable(signal, deadlineAt);
    const source = pin[section] as readonly unknown[];
    let offset = 0;
    let records: unknown[] = [];
    let bytes = frameByteLength({
      kind: "page",
      section,
      offset,
      records,
    });
    const flush = (): ProviderPromotionBootstrapStreamFrame | null => {
      if (records.length === 0) return null;
      const frame = Object.freeze({
        kind: "page" as const,
        section,
        offset,
        records: Object.freeze(records),
      });
      if (frameByteLength(frame) > PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES) {
        fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
      }
      offset += records.length;
      records = [];
      bytes = frameByteLength({
        kind: "page",
        section,
        offset,
        records,
      });
      return frame;
    };
    for (const value of source) {
      assertAvailable(signal, deadlineAt);
      const pageValue = serializablePageValue(section, value);
      const serialized = JSON.stringify(pageValue);
      if (serialized === undefined) {
        fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
      }
      const additionalBytes = Buffer.byteLength(serialized, "utf8") +
        (records.length === 0 ? 0 : 1);
      if (
        records.length > 0 &&
        (records.length ===
          PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME ||
          bytes + additionalBytes >
            PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES)
      ) {
        const frame = flush();
        if (frame !== null) {
          yield frame;
          await yieldToEventLoop();
          assertAvailable(signal, deadlineAt);
        }
      }
      if (
        records.length === 0 &&
        bytes + additionalBytes >
          PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES
      ) fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
      records.push(pageValue);
      bytes += additionalBytes;
      if (
        records.length ===
          PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME
      ) {
        const frame = flush();
        if (frame !== null) {
          yield frame;
          await yieldToEventLoop();
          assertAvailable(signal, deadlineAt);
        }
      }
    }
    const frame = flush();
    if (frame !== null) {
      yield frame;
      await yieldToEventLoop();
      assertAvailable(signal, deadlineAt);
    }
  }
}

async function streamFrames(
  pin: PinnedProviderReleaseInputs,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<AsyncIterable<ProviderPromotionBootstrapStreamFrame>> {
  assertAvailable(signal, deadlineAt);
  const metadata = pinMetadata(pin);
  const counts = streamCounts(pin);
  if (!providerPromotionBootstrapCatalogSectionsWithinByteBudget(pin)) {
    fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
  }
  assertAvailable(signal, deadlineAt);
  const snapshotFingerprint = await awaitWhileAvailable(
    providerPromotionBootstrapSnapshotFingerprint({
      pin: metadata,
      counts,
    }),
    signal,
    deadlineAt,
  );
  assertAvailable(signal, deadlineAt);
  const header = Object.freeze({
    kind: "header" as const,
    version: PROVIDER_PROMOTION_BOOTSTRAP_STREAM_VERSION,
    snapshotFingerprint,
    counts,
    pin: metadata,
  });
  const complete = Object.freeze({
    kind: "complete" as const,
    snapshotFingerprint,
  });
  if (
    frameByteLength(header) > PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES ||
    frameByteLength(complete) > PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES
  ) fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
  return Object.freeze({
    async *[Symbol.asyncIterator]() {
      assertAvailable(signal, deadlineAt);
      let emitted = 1;
      let emittedBytes = frameByteLength(header);
      yield header;
      for await (const frame of pageFrames(pin, signal, deadlineAt)) {
        assertAvailable(signal, deadlineAt);
        const bytes = frameByteLength(frame);
        if (
          emitted >= PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAMES - 1 ||
          emittedBytes + bytes + frameByteLength(complete) >
            PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES
        ) {
          fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
        }
        emitted += 1;
        emittedBytes += bytes;
        yield frame;
      }
      yield complete;
    },
  });
}

/** Provider-bound, read-only central bootstrap service. */
export class ProviderPromotionBootstrapService {
  constructor(private readonly dependencies: Readonly<{
    credentials: ProviderPromotionBootstrapCredentialSet;
    repository: ProviderPromotionBootstrapRepository;
  }>) {}

  async stream(input: Readonly<{
    providerId: string;
    bearerTokenBase64: string;
    signal: AbortSignal;
    deadlineAt: number;
  }>): Promise<AsyncIterable<ProviderPromotionBootstrapStreamFrame>> {
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
    const remainingMilliseconds = input.deadlineAt - Date.now();
    if (
      !Number.isSafeInteger(input.deadlineAt) ||
      remainingMilliseconds <= 0 ||
      remainingMilliseconds > 30_000
    ) {
      fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
    }
    try {
      assertAvailable(input.signal, input.deadlineAt);
      const pin = await awaitWhileAvailable(
        this.dependencies.repository.pin({
          providerId,
          signal: input.signal,
          deadlineAt: input.deadlineAt,
        }),
        input.signal,
        input.deadlineAt,
      );
      if (pin.providerId.toLowerCase() !== providerId) {
        fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
      }
      return await streamFrames(pin, input.signal, input.deadlineAt);
    } catch (error) {
      if (error instanceof ProviderPromotionBootstrapError) throw error;
      fail("PROVIDER_PROMOTION_BOOTSTRAP_UNAVAILABLE");
    }
  }
}
