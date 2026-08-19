import { createHash } from "node:crypto";
import {
  HttpCursorAdapter,
  type HttpCursorAdapterDependencies,
} from "../../http-cursor-adapter.ts";
import { ProviderTransportAdapterRegistry } from "../../provider-adapter-registry.ts";
import type {
  ProviderHttpResponseDecodeResultV2,
  ProviderHttpResponseDecoderInputV2,
  ProviderHttpResponseDecoderV2,
} from "../../provider-adapter.ts";

export const DATA_FORREST_PLATFORM_KEYS = Object.freeze([
  "clutchpacks",
  "collector_crypt",
  "courtyard",
  "phygitals",
] as const);

type DataForrestPlatformKey = (typeof DATA_FORREST_PLATFORM_KEYS)[number];

const expectedWrapperKeys = Object.freeze([
  "next_cursor",
  "poll_after_seconds",
  "records",
]);
const maximumPageRecords = 5_000;
const supportedPlatforms = new Set<string>(DATA_FORREST_PLATFORM_KEYS);

function pageManifest(input: {
  bodyText: string;
  nextCursor: string;
  pollAfterSeconds: number;
  recordCount: number;
}) {
  return Object.freeze({
    encoding: "data-forrest-page-manifest-v1",
    bodySha256: createHash("sha256").update(input.bodyText).digest("hex"),
    recordCount: input.recordCount,
    nextCursor: input.nextCursor,
    pollAfterSeconds: input.pollAfterSeconds,
  });
}

function invalidResponse(
  fieldPath: string,
  issueCode: string,
): ProviderHttpResponseDecodeResultV2 {
  return {
    ok: false,
    code: "invalid_response",
    fieldPaths: [fieldPath],
    issueCodes: [issueCode],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactWrapperKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedWrapperKeys.length &&
    keys.every((key, index) => key === expectedWrapperKeys[index])
  );
}

function isJsonContentType(value: string | null): boolean {
  return (
    value !== null &&
    /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(value)
  );
}

function liveRecordExtensionIssue(
  records: readonly unknown[],
): { fieldPath: string; issueCode: string } | null {
  for (const [index, record] of records.entries()) {
    if (!isPlainObject(record)) continue;
    if (record.stream === "catalog") {
      if (!Object.hasOwn(record, "available")) {
        return {
          fieldPath: `records[${index}].available`,
          issueCode: "missing_catalog_availability",
        };
      }
      if (record.entity === "pack" && typeof record.available !== "boolean") {
        return {
          fieldPath: `records[${index}].available`,
          issueCode: "invalid_pack_availability",
        };
      }
      if (record.entity === "card" && record.available !== null) {
        return {
          fieldPath: `records[${index}].available`,
          issueCode: "invalid_card_availability",
        };
      }
      if (
        record.entity !== "pack" &&
        record.entity !== "card" &&
        record.available !== null &&
        typeof record.available !== "boolean"
      ) {
        return {
          fieldPath: `records[${index}].available`,
          issueCode: "invalid_catalog_availability",
        };
      }
    }
    if (record.stream === "trades") {
      if (!Object.hasOwn(record, "payment_method")) {
        return {
          fieldPath: `records[${index}].payment_method`,
          issueCode: "missing_trade_payment_method",
        };
      }
      if (
        record.payment_method !== null &&
        typeof record.payment_method !== "string"
      ) {
        return {
          fieldPath: `records[${index}].payment_method`,
          issueCode: "invalid_trade_payment_method",
        };
      }
    }
  }
  return null;
}

export class DataForrestResponseDecoderV2
  implements ProviderHttpResponseDecoderV2
{
  decode(
    input: ProviderHttpResponseDecoderInputV2,
  ): ProviderHttpResponseDecodeResultV2 {
    if (!isJsonContentType(input.contentType)) {
      return invalidResponse("$", "unexpected_content_type");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.bodyText);
    } catch {
      return { ok: false, code: "invalid_json" };
    }
    if (!isPlainObject(parsed) || !hasExactWrapperKeys(parsed)) {
      return invalidResponse("$", "invalid_wrapper_shape");
    }
    if (!Array.isArray(parsed.records)) {
      return invalidResponse("records", "records_not_array");
    }
    if (parsed.records.length > maximumPageRecords) {
      return invalidResponse("records", "record_count_exceeded");
    }
    const extensionIssue = liveRecordExtensionIssue(parsed.records);
    if (extensionIssue !== null) {
      return invalidResponse(
        extensionIssue.fieldPath,
        extensionIssue.issueCode,
      );
    }
    if (
      typeof parsed.next_cursor !== "string" ||
      parsed.next_cursor.trim().length === 0
    ) {
      return invalidResponse("nextCursor", "next_cursor_invalid");
    }
    if (
      !Number.isSafeInteger(parsed.poll_after_seconds) ||
      (parsed.poll_after_seconds as number) < 0
    ) {
      return invalidResponse("hasMore", "poll_after_seconds_invalid");
    }
    return {
      ok: true,
      page: {
        rawPage: pageManifest({
          bodyText: input.bodyText,
          nextCursor: parsed.next_cursor,
          pollAfterSeconds: parsed.poll_after_seconds as number,
          recordCount: parsed.records.length,
        }),
        records: parsed.records,
        nextCursor: parsed.next_cursor,
        hasMore: parsed.poll_after_seconds === 0,
      },
    };
  }
}

export class DataForrestHttpCursorAdapter extends HttpCursorAdapter {
  constructor(
    dependencies: Omit<HttpCursorAdapterDependencies, "decoder"> = {},
  ) {
    super({ ...dependencies, decoder: new DataForrestResponseDecoderV2() });
  }

  override supportsPlatform(platform: string): boolean {
    return supportedPlatforms.has(platform);
  }
}

export function createDataForrestProviderTransportRegistry(
  dependencies: Omit<HttpCursorAdapterDependencies, "decoder"> = {},
): ProviderTransportAdapterRegistry {
  return new ProviderTransportAdapterRegistry([
    new DataForrestHttpCursorAdapter(dependencies),
  ]);
}

export function isDataForrestPlatformKey(
  value: string,
): value is DataForrestPlatformKey {
  return supportedPlatforms.has(value);
}
