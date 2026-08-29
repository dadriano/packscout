import {
  decodePublicCursorStack,
  type ListPublicRepacksInput,
} from "@packscout/contracts";
import { env } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { loadDataReleaseV3ByPublicReleaseId } from "./dataReleaseV3Lifecycle";

/**
 * data_release_v3 pagination binds the first page's confidence evaluation
 * clock to every later page. This keeps dynamic confidence ordering stable as
 * wall time advances without changing the immutable release search rows.
 */

export const DATA_RELEASE_V3_CURSOR_VERSION = 3 as const;
export const MAX_DATA_RELEASE_V3_CURSOR_AGE_MILLISECONDS = 15 * 60_000;

type DataReleaseV3UnsignedCursorEnvelope = Readonly<{
  version: typeof DATA_RELEASE_V3_CURSOR_VERSION;
  publicReleaseId: string;
  queryFingerprint: string;
  offset: number;
  confidenceEvaluatedAtMillis: number;
}>;

export type DataReleaseV3CursorEnvelope =
  DataReleaseV3UnsignedCursorEnvelope & Readonly<{ signature: string }>;

type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OPAQUE_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const CURSOR_HMAC_DOMAIN = "packscout:data-release-v3:cursor:v3\n";
const MINIMUM_CURSOR_HMAC_KEY_LENGTH = 32;
const MAXIMUM_CURSOR_HMAC_KEY_LENGTH = 512;

/**
 * Cursor signing is deployment-held and independent of beta mode. Falling
 * back to the existing catalog credential keeps rotating deployments usable,
 * but a dedicated key avoids coupling cursor and read authorization secrets.
 */
export function configuredDataReleaseV3CursorSigningKey(): string | null {
  const configured = env as typeof env & {
    readonly PACKSCOUT_PUBLIC_CURSOR_HMAC_KEY?: string;
    readonly PACKSCOUT_CATALOG_READ_TOKEN?: string;
  };
  for (const candidate of [
    configured.PACKSCOUT_PUBLIC_CURSOR_HMAC_KEY,
    configured.PACKSCOUT_CATALOG_READ_TOKEN,
  ]) {
    const value = candidate?.trim() ?? "";
    if (
      value.length >= MINIMUM_CURSOR_HMAC_KEY_LENGTH &&
      value.length <= MAXIMUM_CURSOR_HMAC_KEY_LENGTH
    ) {
      return value;
    }
  }
  return null;
}

function unsignedCursor(
  cursor: DataReleaseV3UnsignedCursorEnvelope,
): DataReleaseV3UnsignedCursorEnvelope {
  return {
    version: cursor.version,
    publicReleaseId: cursor.publicReleaseId,
    queryFingerprint: cursor.queryFingerprint,
    offset: cursor.offset,
    confidenceEvaluatedAtMillis: cursor.confidenceEvaluatedAtMillis,
  };
}

async function cursorSignature(
  cursor: DataReleaseV3UnsignedCursorEnvelope,
  signingKey: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      CURSOR_HMAC_DOMAIN + JSON.stringify(unsignedCursor(cursor)),
    ),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function signaturesMatch(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string | null {
  if (!OPAQUE_CURSOR_PATTERN.test(value)) return null;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function isDataReleaseV3EvaluationTime(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DATE_MILLISECONDS
  );
}

function isCursorEnvelope(value: unknown): value is DataReleaseV3CursorEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 6 &&
    record.version === DATA_RELEASE_V3_CURSOR_VERSION &&
    typeof record.publicReleaseId === "string" &&
    UUID_PATTERN.test(record.publicReleaseId) &&
    typeof record.queryFingerprint === "string" &&
    SHA256_PATTERN.test(record.queryFingerprint) &&
    typeof record.offset === "number" &&
    Number.isSafeInteger(record.offset) &&
    record.offset >= 0 &&
    typeof record.confidenceEvaluatedAtMillis === "number" &&
    isDataReleaseV3EvaluationTime(record.confidenceEvaluatedAtMillis) &&
    typeof record.signature === "string" &&
    SHA256_PATTERN.test(record.signature)
  );
}

export async function encodeDataReleaseV3Cursor(
  cursor: DataReleaseV3UnsignedCursorEnvelope,
  signingKey: string,
): Promise<string> {
  const signed = {
    ...unsignedCursor(cursor),
    signature: await cursorSignature(cursor, signingKey),
  };
  if (!isCursorEnvelope(signed)) {
    throw new Error("Invalid data_release_v3 cursor envelope.");
  }
  return encodeBase64Url(JSON.stringify(signed));
}

export async function decodeDataReleaseV3Cursor(
  value: string,
  signingKey: string,
): Promise<DataReleaseV3CursorEnvelope | null> {
  const decoded = decodeBase64Url(value);
  if (decoded === null) return null;
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (!isCursorEnvelope(parsed)) return null;
    const expected = await cursorSignature(parsed, signingKey);
    return signaturesMatch(parsed.signature, expected) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalFingerprintInput(
  publicReleaseId: string,
  input: ListPublicRepacksInput,
): string {
  return JSON.stringify({
    cursorVersion: DATA_RELEASE_V3_CURSOR_VERSION,
    publicReleaseId,
    search: input.search,
    filters: input.filters,
    sort: input.sort,
    direction: input.direction,
    pageSize: input.pageSize,
    desiredPublicCollectibleId: input.desiredPublicCollectibleId,
  });
}

export async function createDataReleaseV3QueryFingerprint(
  publicReleaseId: string,
  input: ListPublicRepacksInput,
  confidenceEvaluatedAtMillis: number,
): Promise<string> {
  if (!isDataReleaseV3EvaluationTime(confidenceEvaluatedAtMillis)) {
    throw new Error("Invalid data_release_v3 confidence evaluation time.");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      canonicalFingerprintInput(
        publicReleaseId,
        input,
      ),
    ),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function validateDataReleaseV3CursorSet(input: {
  readonly cursor: string | null;
  readonly cursorStack: string | null;
  readonly signingKey: string | null;
  readonly expectedFingerprint: string;
  readonly expectedReleaseId: string;
  readonly expectedConfidenceEvaluatedAtMillis: number;
  readonly pageSize: number;
}): Promise<ValidationResult<{
  readonly cursor: DataReleaseV3CursorEnvelope | null;
  readonly stack: readonly DataReleaseV3CursorEnvelope[];
}>> {
  if (
    input.signingKey === null &&
    (input.cursor !== null || input.cursorStack !== null)
  ) {
    return { ok: false };
  }
  const cursor = input.cursor === null || input.signingKey === null
    ? null
    : await decodeDataReleaseV3Cursor(input.cursor, input.signingKey);
  if (input.cursor !== null && cursor === null) return { ok: false };
  const encodedStack = input.cursorStack === null
    ? []
    : decodePublicCursorStack(input.cursorStack);
  if (encodedStack === null) return { ok: false };
  const stack = input.signingKey === null
    ? []
    : await Promise.all(
        encodedStack.map((entry) =>
          decodeDataReleaseV3Cursor(entry, input.signingKey!),
        ),
      );
  if (stack.some((entry) => entry === null)) return { ok: false };
  const envelopes = stack as DataReleaseV3CursorEnvelope[];
  const validEnvelope = (entry: DataReleaseV3CursorEnvelope) =>
    entry.publicReleaseId === input.expectedReleaseId &&
    entry.queryFingerprint === input.expectedFingerprint &&
    entry.confidenceEvaluatedAtMillis ===
      input.expectedConfidenceEvaluatedAtMillis &&
    entry.offset % input.pageSize === 0;
  if (
    (cursor !== null && !validEnvelope(cursor)) ||
    !envelopes.every(validEnvelope)
  ) {
    return { ok: false };
  }
  if (
    cursor !== null &&
    envelopes.some((entry) => entry.offset >= cursor.offset)
  ) {
    return { ok: false };
  }
  return { ok: true, value: { cursor, stack: envelopes } };
}

export async function resolveDataReleaseV3Pagination(
  ctx: QueryCtx,
  input: ListPublicRepacksInput,
  activePublicReleaseId: string,
  trustedNow: number,
): Promise<
  | { readonly ok: false; readonly code: "INVALID_QUERY" | "CURSOR_EXPIRED" }
  | {
      readonly ok: true;
      readonly offset: number;
      readonly paginationReset: "release_changed" | null;
      readonly confidenceEvaluatedAtMillis: number;
      readonly queryFingerprint: string;
      readonly cursorSigningKey: string | null;
    }
> {
  const cursorSigningKey = configuredDataReleaseV3CursorSigningKey();
  if (input.cursor === null) {
    const queryFingerprint = await createDataReleaseV3QueryFingerprint(
      activePublicReleaseId,
      input,
      trustedNow,
    );
    const stack = await validateDataReleaseV3CursorSet({
      cursor: null,
      cursorStack: input.cursorStack,
      signingKey: cursorSigningKey,
      expectedFingerprint: queryFingerprint,
      expectedReleaseId: activePublicReleaseId,
      expectedConfidenceEvaluatedAtMillis: trustedNow,
      pageSize: input.pageSize,
    });
    if (!stack.ok || stack.value.stack.length > 0) {
      return { ok: false, code: "INVALID_QUERY" };
    }
    return {
      ok: true,
      offset: 0,
      confidenceEvaluatedAtMillis: trustedNow,
      queryFingerprint,
      cursorSigningKey,
      paginationReset:
        input.queryFingerprint !== null &&
        input.queryFingerprint !== queryFingerprint
          ? "release_changed"
          : null,
    };
  }
  if (cursorSigningKey === null) {
    return { ok: false, code: "CURSOR_EXPIRED" };
  }
  const cursor = await decodeDataReleaseV3Cursor(
    input.cursor,
    cursorSigningKey,
  );
  if (cursor === null || input.queryFingerprint !== cursor.queryFingerprint) {
    return { ok: false, code: "INVALID_QUERY" };
  }
  if (
    trustedNow < cursor.confidenceEvaluatedAtMillis ||
    trustedNow - cursor.confidenceEvaluatedAtMillis >
      MAX_DATA_RELEASE_V3_CURSOR_AGE_MILLISECONDS
  ) {
    return { ok: false, code: "CURSOR_EXPIRED" };
  }
  const expectedFingerprint = await createDataReleaseV3QueryFingerprint(
    cursor.publicReleaseId,
    input,
    cursor.confidenceEvaluatedAtMillis,
  );
  if (expectedFingerprint !== cursor.queryFingerprint) {
    return { ok: false, code: "INVALID_QUERY" };
  }
  const cursorSet = await validateDataReleaseV3CursorSet({
    cursor: input.cursor,
    cursorStack: input.cursorStack,
    signingKey: cursorSigningKey,
    expectedFingerprint,
    expectedReleaseId: cursor.publicReleaseId,
    expectedConfidenceEvaluatedAtMillis: cursor.confidenceEvaluatedAtMillis,
    pageSize: input.pageSize,
  });
  if (!cursorSet.ok) return { ok: false, code: "INVALID_QUERY" };
  if (cursor.publicReleaseId === activePublicReleaseId) {
    return {
      ok: true,
      offset: cursor.offset,
      paginationReset: null,
      confidenceEvaluatedAtMillis: cursor.confidenceEvaluatedAtMillis,
      queryFingerprint: expectedFingerprint,
      cursorSigningKey,
    };
  }
  const retained = await loadDataReleaseV3ByPublicReleaseId(
    ctx,
    cursor.publicReleaseId,
  ).catch(() => null);
  if (retained === null || retained.lifecycle !== "complete") {
    return { ok: false, code: "CURSOR_EXPIRED" };
  }
  return {
    ok: true,
    offset: 0,
    paginationReset: "release_changed",
    confidenceEvaluatedAtMillis: trustedNow,
    cursorSigningKey,
    queryFingerprint: await createDataReleaseV3QueryFingerprint(
      activePublicReleaseId,
      input,
      trustedNow,
    ),
  };
}
