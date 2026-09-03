import { constants as fileConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  safeValidateProviderFeedPageV1,
  type ProviderFeedPageV1,
} from "@packscout/contracts";
import {
  PROVIDER_CAPTURE_MAXIMUM_BYTES,
  ProviderCaptureSourceError,
} from "./provider-capture-source-contract.ts";

const captureEnvelopeFields = Object.freeze({
  catalog: Object.freeze([
    "platform",
    "external_id",
    "updated_at",
    "collected_at",
    "data",
  ]),
  pulls: Object.freeze([
    "platform",
    "external_id",
    "pack_external_id",
    "occurred_at",
    "collected_at",
    "data",
  ]),
  sales: Object.freeze([
    "platform",
    "external_id",
    "event_type",
    "tx_hash",
    "amount",
    "currency",
    "occurred_at",
    "collected_at",
    "data",
  ]),
} as const);

function plainObject(value: unknown): Record<string, unknown> | null {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function hasExactFields(
  value: unknown,
  expectedFields: readonly string[],
): value is Record<string, unknown> {
  const object = plainObject(value);
  if (object === null) return false;
  const actual = Object.keys(object).sort();
  const expected = [...expectedFields].sort();
  return actual.length === expected.length && actual.every(
    (field, index) => field === expected[index],
  );
}

function validateCaptureShape(value: unknown): {
  readonly catalog: readonly unknown[];
  readonly pulls: readonly unknown[];
  readonly sales: readonly unknown[];
} {
  if (!hasExactFields(value, ["catalog", "pulls", "sales"])) {
    throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_FILE_INVALID");
  }
  const catalog = value.catalog;
  const pulls = value.pulls;
  const sales = value.sales;
  if (!Array.isArray(catalog) || !Array.isArray(pulls) || !Array.isArray(sales)) {
    throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_FILE_INVALID");
  }
  if (
    catalog.some((record) => !hasExactFields(record, captureEnvelopeFields.catalog))
    || pulls.some((record) => !hasExactFields(record, captureEnvelopeFields.pulls))
    || sales.some((record) => !hasExactFields(record, captureEnvelopeFields.sales))
  ) {
    throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_FILE_INVALID");
  }
  return { catalog, pulls, sales };
}

async function boundedRead(
  captureRoot: string,
  fileName: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (signal.aborted) {
    throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_ABORTED");
  }
  if (
    !path.isAbsolute(captureRoot)
    || path.basename(fileName) !== fileName
    || fileName === "."
    || fileName === ".."
  ) {
    throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_ROOT_INVALID");
  }
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(captureRoot);
  } catch {
    throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_ROOT_INVALID");
  }
  const target = path.resolve(resolvedRoot, fileName);
  if (path.dirname(target) !== resolvedRoot) {
    throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_ROOT_INVALID");
  }

  let handle;
  try {
    handle = await open(
      target,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    );
  } catch {
    throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_FILE_UNAVAILABLE");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) {
      throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_FILE_INVALID");
    }
    const output = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset <= maximumBytes) {
      if (signal.aborted) {
        throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_ABORTED");
      }
      const read = await handle.read(
        output,
        offset,
        Math.min(64 * 1_024, output.byteLength - offset),
        null,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > maximumBytes) {
      throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_FILE_INVALID");
    }
    return output.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readValidatedProviderCapture(input: {
  readonly captureRoot: string;
  readonly fileName: string;
  readonly expectedSha256: string;
  readonly providerKey: string;
  readonly signal: AbortSignal;
  readonly maximumBytes?: number;
}): Promise<ProviderFeedPageV1> {
  const bytes = await boundedRead(
    input.captureRoot,
    input.fileName,
    input.maximumBytes ?? PROVIDER_CAPTURE_MAXIMUM_BYTES,
    input.signal,
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== input.expectedSha256) {
    throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_HASH_MISMATCH");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_FILE_INVALID");
  }
  const capture = validateCaptureShape(parsed);
  const result = safeValidateProviderFeedPageV1(
    {
      catalog: capture.catalog,
      pulls: capture.pulls,
      trades: capture.sales,
      next_cursor: `capture-${digest}`,
      has_more: false,
    },
    { requestedPlatform: input.providerKey },
  );
  if (!result.success || result.data.invalidRecords.length > 0) {
    throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_RECORD_INVALID");
  }
  return result.data.validPage;
}
