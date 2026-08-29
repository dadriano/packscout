import { createHash } from "node:crypto";
import {
  PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
  PROVIDER_MIXED_PAGE_MAX_BYTES,
  PROVIDER_MIXED_PAGE_MAX_RECORD_BYTES,
  PROVIDER_MIXED_PAGE_MAX_RECORDS,
  providerMixedCursorFingerprint,
  providerMixedPageCanonicalBytes,
  providerMixedPageDigest,
  validateProviderMixedPage,
  type CanonicalJsonObject,
} from "@packscout/database";
import { readValidatedProviderCapture } from "./provider-capture-file.ts";
import {
  CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
  CLUTCHPACKS_CAPTURE_FILE_NAME,
  CLUTCHPACKS_CAPTURE_SHA256,
  ProviderCaptureSourceError,
  type ProviderCapturePageSourceInput,
  type ProviderCaptureTranslation,
  type ProviderMixedPageRecordDraft,
} from "./provider-capture-source-contract.ts";
import { translateClutchpacksCapture } from
  "./providers/clutchpacks-capture-integration.ts";

const DEFAULT_PAGE_RECORD_LIMIT = 200;
const PAGE_DRAFT_BYTE_LIMIT = PROVIDER_MIXED_PAGE_MAX_BYTES - 128 * 1_024;

interface CaptureIntegration {
  readonly adapterKey: string;
  readonly providerKey: string;
  readonly fileName: string;
  readonly sha256: string;
  translate(input: {
    readonly page: Awaited<ReturnType<typeof readValidatedProviderCapture>>;
    readonly providerId: string;
    readonly actorHmacKey: Uint8Array;
  }): ProviderCaptureTranslation;
}

const clutchpacksCaptureIntegration: CaptureIntegration = Object.freeze({
  adapterKey: CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
  providerKey: "clutchpacks",
  fileName: CLUTCHPACKS_CAPTURE_FILE_NAME,
  sha256: CLUTCHPACKS_CAPTURE_SHA256,
  translate: translateClutchpacksCapture,
});

class CaptureIntegrationRegistry {
  readonly #byAdapterKey = new Map<string, CaptureIntegration>();

  constructor(integrations: Iterable<CaptureIntegration>) {
    for (const integration of integrations) {
      if (this.#byAdapterKey.has(integration.adapterKey)) {
        throw new TypeError("Provider capture integration is duplicated.");
      }
      this.#byAdapterKey.set(integration.adapterKey, integration);
    }
  }

  supports(adapterKey: string, providerKey: string): boolean {
    const integration = this.#byAdapterKey.get(adapterKey);
    return integration?.providerKey === providerKey;
  }

  resolve(adapterKey: string, providerKey: string): CaptureIntegration {
    const integration = this.#byAdapterKey.get(adapterKey);
    if (integration?.providerKey !== providerKey) {
      throw new ProviderCaptureSourceError(
        "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
      );
    }
    return integration;
  }

  keys(): readonly string[] {
    return Object.freeze([...this.#byAdapterKey.keys()].sort());
  }
}

function adapterKey(configuration: Readonly<Record<string, unknown>>): string {
  const value = configuration.adapterKey;
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new ProviderCaptureSourceError(
      "PROVIDER_CAPTURE_CONFIGURATION_INVALID",
    );
  }
  return value;
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function chunkRecords(
  records: readonly ProviderMixedPageRecordDraft[],
  recordLimit: number,
): readonly (readonly ProviderMixedPageRecordDraft[])[] {
  const chunks: ProviderMixedPageRecordDraft[][] = [];
  let current: ProviderMixedPageRecordDraft[] = [];
  let currentBytes = 0;
  for (const record of records) {
    const recordBytes = providerMixedPageCanonicalBytes(record).byteLength;
    if (recordBytes > PROVIDER_MIXED_PAGE_MAX_RECORD_BYTES) {
      throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_RECORD_INVALID");
    }
    if (
      current.length > 0
      && (current.length >= recordLimit
        || currentBytes + recordBytes > PAGE_DRAFT_BYTE_LIMIT)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(record);
    currentBytes += recordBytes;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

function cursor(sha256: string, nextPageNumber: number): CanonicalJsonObject {
  return Object.freeze({ captureSha256: sha256, pageNumber: nextPageNumber });
}

function buildPages(input: {
  readonly adapterKey: string;
  readonly captureSha256: string;
  readonly providerId: string;
  readonly runId: string;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly workerFence: bigint;
  readonly records: readonly ProviderMixedPageRecordDraft[];
  readonly pageRecordLimit: number;
}): readonly CanonicalJsonObject[] {
  const chunks = chunkRecords(input.records, input.pageRecordLimit);
  return Object.freeze(chunks.map((chunk, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const inputCursor = pageIndex === 0
      ? null
      : cursor(input.captureSha256, pageNumber);
    const nextCursor = pageIndex === chunks.length - 1
      ? null
      : cursor(input.captureSha256, pageNumber + 1);
    const records = chunk.map((record, position) => ({
      position,
      providerId: input.providerId,
      ...record,
    }));
    const body: CanonicalJsonObject = {
      contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
      providerId: input.providerId,
      runId: input.runId,
      configVersionId: input.configVersionId,
      configVersionNumber: input.configVersionNumber.toString(),
      leaseFence: input.workerFence.toString(),
      pageId: deterministicUuid([
        "packscout.provider-capture-page.v1",
        input.adapterKey,
        input.captureSha256,
        input.providerId,
        input.runId,
        input.configVersionId,
        input.configVersionNumber.toString(),
        input.workerFence.toString(),
        pageNumber.toString(),
        providerMixedPageDigest(records),
      ].join("\u0000")),
      pageNumber,
      inputCursor,
      inputCursorFingerprint: providerMixedCursorFingerprint(inputCursor),
      nextCursor,
      nextCursorFingerprint: providerMixedCursorFingerprint(nextCursor),
      continuation: nextCursor === null ? "head" : "more",
      records,
    };
    const page: CanonicalJsonObject = {
      ...body,
      responseDigest: providerMixedPageDigest(body),
    };
    validateProviderMixedPage(page);
    if (providerMixedPageCanonicalBytes(page).byteLength > PROVIDER_MIXED_PAGE_MAX_BYTES) {
      throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_RECORD_INVALID");
    }
    return Object.freeze(page);
  }));
}

/**
 * Server-owned, capture-backed implementation of the Task-007 source-neutral
 * page seam. The capture root and actor HMAC key are process configuration;
 * provider configuration can select only an explicitly installed adapter key.
 */
export class ProviderCaptureMixedPageSource {
  readonly #actorHmacKey: Uint8Array;
  readonly #captureRoot: string;
  readonly #pageRecordLimit: number;
  readonly #registry: CaptureIntegrationRegistry;

  constructor(input: {
    readonly captureRoot: string;
    readonly actorHmacKey: Uint8Array;
    readonly pageRecordLimit?: number;
  }) {
    if (input.actorHmacKey.byteLength < 32) {
      throw new ProviderCaptureSourceError(
        "PROVIDER_CAPTURE_CONFIGURATION_INVALID",
      );
    }
    const recordLimit = input.pageRecordLimit ?? DEFAULT_PAGE_RECORD_LIMIT;
    if (
      !Number.isInteger(recordLimit)
      || recordLimit < 1
      || recordLimit > PROVIDER_MIXED_PAGE_MAX_RECORDS
    ) {
      throw new ProviderCaptureSourceError(
        "PROVIDER_CAPTURE_CONFIGURATION_INVALID",
      );
    }
    this.#captureRoot = input.captureRoot;
    this.#actorHmacKey = new Uint8Array(input.actorHmacKey);
    this.#pageRecordLimit = recordLimit;
    this.#registry = new CaptureIntegrationRegistry([
      clutchpacksCaptureIntegration,
    ]);
  }

  supports(adapterKeyValue: string, providerKey: string): boolean {
    return this.#registry.supports(adapterKeyValue, providerKey);
  }

  adapterKeys(): readonly string[] {
    return this.#registry.keys();
  }

  async nextPage(input: ProviderCapturePageSourceInput): Promise<unknown> {
    if (input.signal.aborted) {
      throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_ABORTED");
    }
    const selectedAdapterKey = adapterKey(input.authority.configuration);
    const integration = this.#registry.resolve(
      selectedAdapterKey,
      input.authority.providerKey,
    );
    const capture = await readValidatedProviderCapture({
      captureRoot: this.#captureRoot,
      fileName: integration.fileName,
      expectedSha256: integration.sha256,
      providerKey: integration.providerKey,
      signal: input.signal,
    });
    const translated = integration.translate({
      page: capture,
      providerId: input.authority.providerId,
      actorHmacKey: this.#actorHmacKey,
    });
    if (input.signal.aborted) {
      throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_ABORTED");
    }
    const pages = buildPages({
      adapterKey: integration.adapterKey,
      captureSha256: integration.sha256,
      providerId: input.authority.providerId,
      runId: input.runId,
      configVersionId: input.authority.configVersionId,
      configVersionNumber: input.authority.configVersionNumber,
      workerFence: input.workerFence,
      records: translated.records,
      pageRecordLimit: this.#pageRecordLimit,
    });
    const page = input.sourceCheckpointFingerprint === null
      ? pages[0]
      : pages.find((candidate) => (
          candidate.inputCursorFingerprint === input.sourceCheckpointFingerprint
        ));
    if (page === undefined) {
      throw new ProviderCaptureSourceError(
        "PROVIDER_CAPTURE_SOURCE_CHECKPOINT_INVALID",
      );
    }
    return page;
  }
}
