import type { PinnedProviderReleaseInputs } from "@packscout/database";
import {
  PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAMES,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES,
  PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS,
  PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE,
  PROVIDER_PROMOTION_BOOTSTRAP_STREAM_VERSION,
  PROVIDER_CORRELATION_SNAPSHOT_HASH_DOMAIN,
  PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
  PROVIDER_RELEASE_CATALOG_PIN_HASH_DOMAIN,
  providerPromotionBootstrapSnapshotFingerprint,
  publicCatalogAliasSchema,
  publicCatalogCategorySchema,
  publicCatalogCollectibleSchema,
  publicVendorSchema,
  type ProviderPromotionBootstrapCounts,
  type ProviderPromotionBootstrapSection,
} from "@packscout/contracts";
import { DistributedPromotionGatewayResponseError } from
  "./distributed-promotion-gateway-errors.ts";
import { interruptibleSha256CanonicalJson } from
  "./interruptible-canonical-sha256.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const RECORDS_PER_EVENT_LOOP_TURN = 4_096;
const STREAM_BYTES_PER_EVENT_LOOP_TURN = 64 * 1_024;

function invalid(): never {
  throw new DistributedPromotionGatewayResponseError();
}

function requireActiveRequest(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid();
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
  ) invalid();
}

function bigint(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
    invalid();
  }
  return BigInt(value);
}

function date(value: unknown): Date {
  if (typeof value !== "string") invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalid();
  }
  return parsed;
}

function validateCorrelationRecord(
  value: unknown,
  localIdKey: "localCategoryId" | "localCollectibleId",
  publicIdKey: "publicCategoryId" | "publicCollectibleId",
): void {
  const item = record(value);
  exactKeys(item, [localIdKey, "localEntityVersion", publicIdKey]);
  if (
    typeof item[localIdKey] !== "string" ||
    !UUID_PATTERN.test(item[localIdKey]) ||
    typeof item[publicIdKey] !== "string" ||
    !UUID_PATTERN.test(item[publicIdKey])
  ) invalid();
  bigint(item.localEntityVersion);
}

function validateSerializedPin(value: unknown): Record<string, unknown> {
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
    !HASH_PATTERN.test(source.catalogContentHash) ||
    typeof source.catalogArtifactVerificationHash !== "string" ||
    !HASH_PATTERN.test(source.catalogArtifactVerificationHash) ||
    typeof source.correlationSnapshotHash !== "string" ||
    !HASH_PATTERN.test(source.correlationSnapshotHash) ||
    typeof source.publicProfileHash !== "string" ||
    !HASH_PATTERN.test(source.publicProfileHash) ||
    !Array.isArray(source.categoryCorrelations) ||
    !Array.isArray(source.collectibleCorrelations) ||
    !Array.isArray(source.catalogCategories) ||
    !Array.isArray(source.catalogCollectibles) ||
    !Array.isArray(source.catalogAliases) ||
    !publicVendorSchema.safeParse(source.publicProvider).success
  ) invalid();
  bigint(source.catalogThroughChangeSequence);
  bigint(source.correlationEventSequence);
  if (source.providerConfigExpiresAt !== null) {
    date(source.providerConfigExpiresAt);
  }
  return source;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function decodeCorrelationVersions(
  values: Record<string, unknown>[],
  signal: AbortSignal,
): Promise<void> {
  for (let index = 0; index < values.length; index += 1) {
    if (index % RECORDS_PER_EVENT_LOOP_TURN === 0) {
      requireActiveRequest(signal);
      await yieldToEventLoop();
    }
    const item = values[index]!;
    item.localEntityVersion = bigint(item.localEntityVersion);
  }
  requireActiveRequest(signal);
}

async function decodePin(
  source: Record<string, unknown>,
  signal: AbortSignal,
): Promise<PinnedProviderReleaseInputs> {
  const categoryCorrelations = source.categoryCorrelations as
    Record<string, unknown>[];
  const collectibleCorrelations = source.collectibleCorrelations as
    Record<string, unknown>[];
  await decodeCorrelationVersions(categoryCorrelations, signal);
  await decodeCorrelationVersions(collectibleCorrelations, signal);
  return {
    ...source,
    providerConfigExpiresAt: source.providerConfigExpiresAt === null
      ? null
      : date(source.providerConfigExpiresAt),
    catalogThroughChangeSequence: bigint(source.catalogThroughChangeSequence),
    correlationEventSequence: bigint(source.correlationEventSequence),
    categoryCorrelations,
    collectibleCorrelations,
  } as unknown as PinnedProviderReleaseInputs;
}

type BootstrapRecordSections = {
  [Section in ProviderPromotionBootstrapSection]: unknown[];
};

interface BootstrapStreamState {
  frameCount: number;
  complete: boolean;
  headerPin: Record<string, unknown> | null;
  counts: ProviderPromotionBootstrapCounts | null;
  snapshotFingerprint: string | null;
  readonly records: BootstrapRecordSections;
}

function decodeCounts(value: unknown): ProviderPromotionBootstrapCounts {
  const source = record(value);
  exactKeys(source, PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS);
  return Object.fromEntries(
    PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS.map((section) => {
      const count = source[section];
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > PROVIDER_PROMOTION_BOOTSTRAP_COUNT_LIMITS[section]
      ) invalid();
      return [section, count];
    }),
  ) as unknown as ProviderPromotionBootstrapCounts;
}

function nextSection(state: BootstrapStreamState):
ProviderPromotionBootstrapSection | null {
  if (state.counts === null) return null;
  return PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS.find(
    (section) => state.records[section].length < state.counts![section],
  ) ?? null;
}

function validatePageRecords(
  section: ProviderPromotionBootstrapSection,
  records: readonly unknown[],
): void {
  const schema = section === "catalogCategories"
    ? publicCatalogCategorySchema
    : section === "catalogCollectibles"
      ? publicCatalogCollectibleSchema
      : section === "catalogAliases"
        ? publicCatalogAliasSchema
        : null;
  if (schema !== null && records.some((value) => !schema.safeParse(value).success)) {
    invalid();
  }
  if (section === "categoryCorrelations") {
    for (const value of records) {
      validateCorrelationRecord(
        value,
        "localCategoryId",
        "publicCategoryId",
      );
    }
  }
  if (section === "collectibleCorrelations") {
    for (const value of records) {
      validateCorrelationRecord(
        value,
        "localCollectibleId",
        "publicCollectibleId",
      );
    }
  }
}

async function consumeFrame(
  value: unknown,
  state: BootstrapStreamState,
  signal: AbortSignal,
): Promise<void> {
  requireActiveRequest(signal);
  state.frameCount += 1;
  if (
    state.frameCount > PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAMES ||
    state.complete
  ) invalid();
  const frame = record(value);
  if (frame.kind === "header") {
    exactKeys(frame, [
      "kind", "version", "snapshotFingerprint", "counts", "pin",
    ]);
    if (
      state.frameCount !== 1 ||
      frame.version !== PROVIDER_PROMOTION_BOOTSTRAP_STREAM_VERSION ||
      typeof frame.snapshotFingerprint !== "string" ||
      !HASH_PATTERN.test(frame.snapshotFingerprint)
    ) invalid();
    const pin = record(frame.pin);
    const counts = decodeCounts(frame.counts);
    requireActiveRequest(signal);
    const fingerprint = await providerPromotionBootstrapSnapshotFingerprint({
      pin,
      counts,
    });
    requireActiveRequest(signal);
    if (fingerprint !== frame.snapshotFingerprint) invalid();
    state.headerPin = pin;
    state.counts = counts;
    state.snapshotFingerprint = fingerprint;
    return;
  }
  if (state.headerPin === null || state.counts === null) invalid();
  if (frame.kind === "page") {
    exactKeys(frame, ["kind", "section", "offset", "records"]);
    const section = PROVIDER_PROMOTION_BOOTSTRAP_SECTIONS.find(
      (candidate) => candidate === frame.section,
    );
    if (
      section === undefined ||
      nextSection(state) !== section ||
      typeof frame.offset !== "number" ||
      !Number.isSafeInteger(frame.offset) ||
      frame.offset !== state.records[section].length ||
      !Array.isArray(frame.records) ||
      frame.records.length < 1 ||
      frame.records.length >
        PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_RECORDS_PER_FRAME ||
      frame.offset + frame.records.length > state.counts[section]
    ) invalid();
    validatePageRecords(section, frame.records);
    requireActiveRequest(signal);
    state.records[section].push(...frame.records);
    return;
  }
  if (frame.kind === "complete") {
    exactKeys(frame, ["kind", "snapshotFingerprint"]);
    if (
      typeof frame.snapshotFingerprint !== "string" ||
      frame.snapshotFingerprint !== state.snapshotFingerprint ||
      nextSection(state) !== null
    ) invalid();
    state.complete = true;
    return;
  }
  invalid();
}

function streamState(): BootstrapStreamState {
  return {
    frameCount: 0,
    complete: false,
    headerPin: null,
    counts: null,
    snapshotFingerprint: null,
    records: {
      catalogCategories: [],
      catalogCollectibles: [],
      catalogAliases: [],
      categoryCorrelations: [],
      collectibleCorrelations: [],
    },
  };
}

async function validatePinHashes(
  pin: Record<string, unknown>,
  signal: AbortSignal,
): Promise<void> {
  requireActiveRequest(signal);
  const catalogHash = await interruptibleSha256CanonicalJson(
    PROVIDER_RELEASE_CATALOG_PIN_HASH_DOMAIN,
    {
      catalogVersionId: pin.catalogVersionId,
      catalogSchemaVersion: pin.catalogSchemaVersion,
      catalogContentHash: pin.catalogContentHash,
      catalogThroughChangeSequence: pin.catalogThroughChangeSequence,
      categories: pin.catalogCategories,
      collectibles: pin.catalogCollectibles,
      aliases: pin.catalogAliases,
    },
    signal,
  );
  requireActiveRequest(signal);
  if (catalogHash !== pin.catalogArtifactVerificationHash) invalid();
  const correlationHash = await interruptibleSha256CanonicalJson(
    PROVIDER_CORRELATION_SNAPSHOT_HASH_DOMAIN,
    {
      providerId: pin.providerId,
      correlationEventSequence: pin.correlationEventSequence,
      categories: pin.categoryCorrelations,
      collectibles: pin.collectibleCorrelations,
    },
    signal,
  );
  requireActiveRequest(signal);
  if (correlationHash !== pin.correlationSnapshotHash) invalid();
  const profileHash = await interruptibleSha256CanonicalJson(
    PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
    pin.publicProvider,
    signal,
  );
  requireActiveRequest(signal);
  if (profileHash !== pin.publicProfileHash) invalid();
}

async function decodedPin(
  state: BootstrapStreamState,
  providerId: string,
  signal: AbortSignal,
): Promise<PinnedProviderReleaseInputs> {
  requireActiveRequest(signal);
  if (!state.complete || state.headerPin === null) invalid();
  const serialized = validateSerializedPin({
    ...state.headerPin,
    ...state.records,
  });
  requireActiveRequest(signal);
  if (
    String(serialized.providerId).toLowerCase() !== providerId.toLowerCase()
  ) invalid();
  requireActiveRequest(signal);
  await validatePinHashes(serialized, signal);
  requireActiveRequest(signal);
  return await decodePin(serialized, signal);
}

export async function readProviderPromotionBootstrapStream(
  response: Response,
  providerId: string,
  signal: AbortSignal,
): Promise<PinnedProviderReleaseInputs> {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]?.trim().toLowerCase();
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    contentType !== PROVIDER_PROMOTION_BOOTSTRAP_STREAM_CONTENT_TYPE ||
    response.body === null ||
    (Number.isFinite(declaredLength) &&
      declaredLength > PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES)
  ) invalid();
  const reader = response.body.getReader();
  let cancellation: Promise<void> | null = null;
  const cancelReader = () => {
    cancellation ??= reader.cancel().then(() => {}, () => {});
    return cancellation;
  };
  const cancelReaderAfterAbort = () => { void cancelReader(); };
  signal.addEventListener("abort", cancelReaderAfterAbort, { once: true });
  const state = streamState();
  let parts: Uint8Array[] = [];
  let pendingBytes = 0;
  let streamedBytes = 0;
  const append = (part: Uint8Array) => {
    if (part.byteLength === 0) return;
    pendingBytes += part.byteLength;
    if (pendingBytes + 1 > PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_FRAME_BYTES) {
      invalid();
    }
    parts.push(part);
  };
  const finishFrame = async (part: Uint8Array) => {
    append(part);
    const bytes = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const value of parts) {
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    parts = [];
    pendingBytes = 0;
    let frame: unknown;
    try {
      frame = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      invalid();
    }
    await consumeFrame(frame, state, signal);
  };
  try {
    requireActiveRequest(signal);
    while (true) {
      requireActiveRequest(signal);
      const next = await reader.read();
      requireActiveRequest(signal);
      if (next.done) break;
      streamedBytes += next.value.byteLength;
      if (streamedBytes > PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_STREAM_BYTES) {
        invalid();
      }
      let start = 0;
      for (let index = 0; index < next.value.byteLength; index += 1) {
        if (
          index > 0 &&
          index % STREAM_BYTES_PER_EVENT_LOOP_TURN === 0
        ) {
          await yieldToEventLoop();
          requireActiveRequest(signal);
        }
        if (next.value[index] !== 0x0a) continue;
        await finishFrame(next.value.subarray(start, index));
        start = index + 1;
      }
      append(next.value.subarray(start));
    }
    if (pendingBytes !== 0) invalid();
    requireActiveRequest(signal);
    return await decodedPin(state, providerId, signal);
  } catch (error) {
    await cancelReader();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelReaderAfterAbort);
  }
}
