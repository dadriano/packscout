import { createHash } from "node:crypto";
import type {
  CanonicalJsonObject,
  CanonicalJsonValue,
} from "./provider-canonical-contract.ts";
import {
  assertRecordShape,
  rejectUnknownFields,
  requirePlainObject,
  type ProviderMixedCatalogEntityType,
} from "./provider-mixed-page-shape.ts";

export const PROVIDER_MIXED_PAGE_CONTRACT_VERSION = "packscout.provider-mixed-page.v1";
// A 2,000-record ClutchPacks source page can yield one canonical record and
// one deduplicated category record per source record. Keep the normalized
// envelope bounded at that proven 2x translation maximum.
export const PROVIDER_MIXED_PAGE_MAX_RECORDS = 4_000;
export const PROVIDER_MIXED_PAGE_MAX_BYTES = 8 * 1_024 * 1_024;
export const PROVIDER_MIXED_PAGE_MAX_RECORD_BYTES = 262_144;
export const PROVIDER_MIXED_PAGE_MAX_CURSOR_BYTES = 16_384;
// One legal source page can contain 2,000 record-local mapping failures. Valid
// unresolved relationships are stored as facts and do not consume this bound.
// The byte and normalized-record caps remain independent fail-closed bounds.
export const PROVIDER_MIXED_PAGE_MAX_QUARANTINES = 2_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_RECORD_KEY_PATTERN = /^source:[0-9a-f]{64}$/;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const MAXIMUM_BIGINT = 9_223_372_036_854_775_807n;
const MAXIMUM_JSON_DEPTH = 64;
const PROTECTED_CANDIDATE_KEYS = new Set([
  "accesstoken", "apikey", "apisecret", "authtoken", "authorization",
  "bearertoken", "clientsecret", "connectionstring", "credential", "credentials",
  "databasecredential", "databasedsn", "databaseurl", "dsn", "password", "passwords",
  "privatekey", "privatekeys", "raw", "rawbody", "rawdata", "rawpayload", "rawrecord",
  "rawrequest", "rawresponse", "refreshtoken", "secret", "secrets", "sourcecredential",
  "token",
]);
const TOP_LEVEL_FIELDS = [
  "contractVersion", "providerId", "runId", "configVersionId", "configVersionNumber",
  "leaseFence", "pageId", "pageNumber", "inputCursor", "inputCursorFingerprint",
  "nextCursor", "nextCursorFingerprint", "continuation", "responseDigest", "records",
] as const;

export type ProviderMixedPageRecordKind = "catalog" | "pull" | "market_event";

export interface ProviderMixedPageRecord {
  readonly position: number;
  readonly providerId: string;
  readonly kind: ProviderMixedPageRecordKind;
  readonly disposition?: "quarantine";
  readonly operation?: "upsert" | "retire";
  readonly entityType?: ProviderMixedCatalogEntityType;
  readonly candidate: CanonicalJsonObject;
  readonly sourceRecordKey?: string;
  readonly reasonCode?: string;
  readonly fieldPath?: string | null;
  readonly sanitizedSummary?: string;
}

export interface ValidatedProviderMixedPage {
  readonly contractVersion: typeof PROVIDER_MIXED_PAGE_CONTRACT_VERSION;
  readonly providerId: string;
  readonly runId: string;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly leaseFence: bigint;
  readonly pageId: string;
  readonly pageNumber: number;
  readonly inputCursor: CanonicalJsonValue | null;
  readonly inputCursorFingerprint: string | null;
  readonly nextCursor: CanonicalJsonValue | null;
  readonly nextCursorFingerprint: string | null;
  readonly continuation: "more" | "head";
  readonly responseDigest: string;
  readonly records: readonly ProviderMixedPageRecord[];
}

export type ProviderMixedPageFailureCode =
  | "MIXED_PAGE_INVALID"
  | "MIXED_PAGE_UNKNOWN_FIELD"
  | "MIXED_PAGE_OVERSIZED"
  | "MIXED_PAGE_DUPLICATE_POSITION"
  | "MIXED_PAGE_PROVIDER_MISMATCH"
  | "MIXED_PAGE_CURSOR_MISMATCH"
  | "MIXED_PAGE_DIGEST_MISMATCH";

export class ProviderMixedPageContractError extends TypeError {
  constructor(
    readonly code: ProviderMixedPageFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderMixedPageContractError";
  }
}

function invalid(message: string): never {
  throw new ProviderMixedPageContractError("MIXED_PAGE_INVALID", message);
}

function requireContractPlainObject(
  value: unknown,
  path: string,
): CanonicalJsonObject {
  try {
    return requirePlainObject(value, path);
  } catch {
    return invalid(`${path} must be a plain JSON object.`);
  }
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid(`${field} must be a UUID.`);
  return value;
}

function requireBoundedText(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.length > maximumLength
  ) {
    invalid(`${field} must be bounded nonblank text.`);
  }
  return value;
}

function requirePositiveBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !POSITIVE_INTEGER_PATTERN.test(value)) {
    invalid(`${field} must be a positive base-10 integer string.`);
  }
  const parsed = BigInt(value);
  if (parsed > MAXIMUM_BIGINT) invalid(`${field} exceeds the signed bigint range.`);
  return parsed;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(`${field} must be a positive safe integer.`);
  }
  return value as number;
}

function canonicalize(
  value: unknown,
  path: string,
  ancestors = new Set<object>(),
  depth = 0,
): CanonicalJsonValue {
  if (depth > MAXIMUM_JSON_DEPTH) invalid(`${path} exceeds the JSON nesting limit.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${path} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) invalid(`${path} contains a cyclic value.`);
    ancestors.add(value);
    try {
      return value.map((item, index) => (
        canonicalize(item, `${path}[${index}]`, ancestors, depth + 1)
      ));
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value !== "object") invalid(`${path} contains a non-JSON value.`);
  const object = requireContractPlainObject(value, path) as Record<string, unknown>;
  if (ancestors.has(object)) invalid(`${path} contains a cyclic value.`);
  ancestors.add(object);
  const normalized: Record<string, CanonicalJsonValue> = {};
  try {
    for (const key of Object.keys(object).sort()) {
      const item = object[key];
      if (item === undefined) invalid(`${path}.${key} must not be undefined.`);
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        value: canonicalize(item, `${path}.${key}`, ancestors, depth + 1),
        writable: true,
      });
    }
  } finally {
    ancestors.delete(object);
  }
  return normalized;
}

function rejectProtectedCandidateKeys(value: CanonicalJsonValue, path: string): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectProtectedCandidateKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (PROTECTED_CANDIDATE_KEYS.has(normalizedKey)) {
      invalid(`${path}.${key} is not allowed in a normalized provider candidate.`);
    }
    rejectProtectedCandidateKeys(item, `${path}.${key}`);
  }
}

export function providerMixedPageCanonicalBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(value, "page")), "utf8");
}

export function providerMixedPageDigest(value: unknown): string {
  return createHash("sha256").update(providerMixedPageCanonicalBytes(value)).digest("hex");
}

export function providerMixedCursorFingerprint(value: CanonicalJsonValue | null): string | null {
  return value === null ? null : providerMixedPageDigest(value);
}

function assertCursor(
  value: unknown,
  fingerprint: unknown,
  field: string,
): CanonicalJsonValue | null {
  const cursor = value === null ? null : canonicalize(value, field);
  const expected = providerMixedCursorFingerprint(cursor);
  if (
    (fingerprint !== null && (typeof fingerprint !== "string" || !DIGEST_PATTERN.test(fingerprint)))
    || fingerprint !== expected
  ) {
    throw new ProviderMixedPageContractError(
      "MIXED_PAGE_CURSOR_MISMATCH",
      `${field} and its fingerprint do not match.`,
    );
  }
  if (cursor !== null && providerMixedPageCanonicalBytes(cursor).byteLength > PROVIDER_MIXED_PAGE_MAX_CURSOR_BYTES) {
    throw new ProviderMixedPageContractError("MIXED_PAGE_OVERSIZED", `${field} is too large.`);
  }
  return cursor;
}

function responseBody(value: CanonicalJsonObject): CanonicalJsonObject {
  const body = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "responseDigest"),
  );
  return body;
}

export function validateProviderMixedPageRecord(
  value: unknown,
  input: { readonly providerId: string; readonly position: number },
): ProviderMixedPageRecord {
  if (!UUID_PATTERN.test(input.providerId)) {
    invalid("providerId must be a UUID.");
  }
  if (!Number.isSafeInteger(input.position) || input.position < 0) {
    invalid("record position must be a nonnegative safe integer.");
  }
  let recordObject: CanonicalJsonObject;
  try {
    recordObject = requirePlainObject(
      canonicalize(value, `records[${input.position}]`),
      `records[${input.position}]`,
    );
    assertRecordShape(recordObject, input.position);
  } catch (error) {
    if (error instanceof TypeError && "code" in error) {
      throw new ProviderMixedPageContractError(
        "MIXED_PAGE_UNKNOWN_FIELD",
        error.message,
      );
    }
    throw new ProviderMixedPageContractError(
      "MIXED_PAGE_INVALID",
      error instanceof Error
        ? error.message
        : `records[${input.position}] is invalid.`,
    );
  }
  if (
    providerMixedPageCanonicalBytes(recordObject).byteLength
      > PROVIDER_MIXED_PAGE_MAX_RECORD_BYTES
  ) {
    throw new ProviderMixedPageContractError(
      "MIXED_PAGE_OVERSIZED",
      `records[${input.position}] is too large.`,
    );
  }
  rejectProtectedCandidateKeys(
    recordObject.candidate as CanonicalJsonValue,
    `records[${input.position}].candidate`,
  );
  if (recordObject.position !== input.position) {
    throw new ProviderMixedPageContractError(
      "MIXED_PAGE_DUPLICATE_POSITION",
      "Provider mixed page record positions must be unique and contiguous.",
    );
  }
  if (recordObject.providerId !== input.providerId) {
    throw new ProviderMixedPageContractError(
      "MIXED_PAGE_PROVIDER_MISMATCH",
      "A provider mixed page record belongs to another provider.",
    );
  }
  if (recordObject.disposition === "quarantine") {
    const sourceRecordKey = requireBoundedText(
      recordObject.sourceRecordKey,
      `records[${input.position}].sourceRecordKey`,
      512,
    );
    if (!SOURCE_RECORD_KEY_PATTERN.test(sourceRecordKey)) {
      invalid(`records[${input.position}].sourceRecordKey is invalid.`);
    }
    const reasonCode = requireBoundedText(
      recordObject.reasonCode,
      `records[${input.position}].reasonCode`,
      128,
    );
    if (!/^[A-Z][A-Z0-9_]*$/u.test(reasonCode)) {
      invalid(`records[${input.position}].reasonCode is invalid.`);
    }
    const fieldPath = recordObject.fieldPath === null
      ? null
      : requireBoundedText(
          recordObject.fieldPath,
          `records[${input.position}].fieldPath`,
          512,
        );
    const sanitizedSummary = requireBoundedText(
      recordObject.sanitizedSummary,
      `records[${input.position}].sanitizedSummary`,
      512,
    );
    return {
      position: input.position,
      providerId: input.providerId,
      kind: recordObject.kind as ProviderMixedPageRecordKind,
      disposition: "quarantine",
      candidate: requirePlainObject(
        recordObject.candidate,
        `records[${input.position}].candidate`,
      ),
      sourceRecordKey,
      reasonCode,
      fieldPath,
      sanitizedSummary,
    };
  }
  return {
    position: input.position,
    providerId: input.providerId,
    kind: recordObject.kind as ProviderMixedPageRecordKind,
    operation: recordObject.operation as "upsert" | "retire" | undefined,
    entityType: recordObject.entityType as ProviderMixedCatalogEntityType | undefined,
    candidate: requirePlainObject(
      recordObject.candidate,
      `records[${input.position}].candidate`,
    ),
  };
}

export function validateProviderMixedPage(value: unknown): ValidatedProviderMixedPage {
  const received = requireContractPlainObject(value, "page");
  try {
    rejectUnknownFields(received, TOP_LEVEL_FIELDS, "page");
  } catch (error) {
    throw new ProviderMixedPageContractError(
      "MIXED_PAGE_UNKNOWN_FIELD",
      error instanceof Error ? error.message : "The provider mixed page contains an unknown field.",
    );
  }
  const object = requireContractPlainObject(canonicalize(received, "page"), "page");
  if (Buffer.byteLength(JSON.stringify(object), "utf8") > PROVIDER_MIXED_PAGE_MAX_BYTES) {
    throw new ProviderMixedPageContractError("MIXED_PAGE_OVERSIZED", "The provider mixed page is too large.");
  }
  if (object.contractVersion !== PROVIDER_MIXED_PAGE_CONTRACT_VERSION) {
    invalid("contractVersion is unsupported.");
  }
  const providerId = requireUuid(object.providerId, "providerId");
  const runId = requireUuid(object.runId, "runId");
  const configVersionId = requireUuid(object.configVersionId, "configVersionId");
  const configVersionNumber = requirePositiveBigInt(object.configVersionNumber, "configVersionNumber");
  const leaseFence = requirePositiveBigInt(object.leaseFence, "leaseFence");
  const pageId = requireUuid(object.pageId, "pageId");
  const pageNumber = requirePositiveInteger(object.pageNumber, "pageNumber");
  const inputCursor = assertCursor(
    object.inputCursor,
    object.inputCursorFingerprint,
    "inputCursor",
  );
  const nextCursor = assertCursor(
    object.nextCursor,
    object.nextCursorFingerprint,
    "nextCursor",
  );
  if (object.continuation !== "more" && object.continuation !== "head") {
    invalid("continuation is unsupported.");
  }
  if (
    (object.continuation === "more" && nextCursor === null)
    || (object.continuation === "more" && nextCursor !== null
      && object.nextCursorFingerprint === object.inputCursorFingerprint)
  ) {
    throw new ProviderMixedPageContractError(
      "MIXED_PAGE_CURSOR_MISMATCH",
      "The provider mixed page continuation and cursors disagree.",
    );
  }
  if (!Array.isArray(object.records) || object.records.length > PROVIDER_MIXED_PAGE_MAX_RECORDS) {
    throw new ProviderMixedPageContractError("MIXED_PAGE_OVERSIZED", "The provider mixed page record count is invalid.");
  }
  const records = object.records.map((record, position) =>
    validateProviderMixedPageRecord(record, { providerId, position }),
  );
  if (typeof object.responseDigest !== "string" || !DIGEST_PATTERN.test(object.responseDigest)) {
    invalid("responseDigest must be a lowercase SHA-256 digest.");
  }
  if (providerMixedPageDigest(responseBody(object)) !== object.responseDigest) {
    throw new ProviderMixedPageContractError(
      "MIXED_PAGE_DIGEST_MISMATCH",
      "The provider mixed page response digest does not match its canonical content.",
    );
  }
  return Object.freeze({
    contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
    providerId,
    runId,
    configVersionId,
    configVersionNumber,
    leaseFence,
    pageId,
    pageNumber,
    inputCursor,
    inputCursorFingerprint: object.inputCursorFingerprint as string | null,
    nextCursor,
    nextCursorFingerprint: object.nextCursorFingerprint as string | null,
    continuation: object.continuation,
    responseDigest: object.responseDigest,
    records: Object.freeze(records),
  });
}

export function requireProviderMixedPageWorkerId(value: string): string {
  if (!OWNER_PATTERN.test(value)) invalid("workerId is invalid.");
  return value;
}
