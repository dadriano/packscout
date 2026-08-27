import type { ZodError } from "zod";
import { isUtf8 } from "node:buffer";
import { JSONParser, TokenType } from "@streamparser/json";
import {
  dataforrestContinuation,
  dataforrestEventRecordV1Schema,
  dataforrestEventsPageV1Schema,
  dataforrestEventsSourceConfigurationV1Schema,
  dataforrestNextCursor,
  dataforrestEventsV1SourceAdapterManifests,
  normalizeDataforrestEventRecordForAdapter,
  sourceAdapterFailureSchema,
  type DataforrestEventsPageV1,
  type DataforrestEventRecordV1,
  type LaunchProviderKey,
  type SourceAdapterFailure,
  type SourceAdapterSafeDiagnostic,
  type NormalizedObservationOutcome,
} from "@packscout/contracts";
import type {
  ConnectionTestInterpretationContext,
  ConnectionTestValue,
  PageReadInterpretationContext,
  SourceAdapterInterpretationResult,
  SourceAdapterPageInterpretationResult,
  SourceTestInterpretationContext,
  SourceTestValue,
  SuccessfulSourceAdapterRequest,
} from "./source-adapter.ts";
import { sealTrustedProtectedNativeEvidence } from "./trusted-protected-native-evidence.ts";

type PageParseResult =
  | Readonly<{
      ok: true;
      page: DataforrestEventsPageV1;
    }>
  | Readonly<{ ok: false }>;

function dataforrestManifest(adapterVersion: string) {
  return dataforrestEventsV1SourceAdapterManifests.find(
    (manifest) => manifest.adapterVersion === adapterVersion,
  ) ?? null;
}

const knownStreams = new Set(["catalog", "pulls", "trades"]);
const timestampFields = new Set([
  "occurred_at",
  "collected_at",
  "first_seen_at",
]);
const maximumJsonNestingDepth = 64;
// The transport manifest caps raw responses at no more than 8 MiB.
// Data-rich catalog records can contain hundreds of bounded native facts, so
// a full 250-record page needs a higher aggregate traversal allowance while
// the independent depth, object-key, and array-item limits remain enforced.
// The cap is above both observed 183,215- and 214,914-node Phygitals pages and
// the reviewed 250 x 945 native-fact page while keeping the heaviest accepted
// object graph inside the unchanged single-page memory gate.
const maximumJsonNodeCount = 240_000;
const maximumJsonObjectKeys = 256;
const maximumJsonArrayItems = 5_000;
const jsonParserInputChunkBytes = 64 * 1024;
const reservedJsonObjectKeys = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const jsonQuotationMark = 0x22;
const jsonReverseSolidus = 0x5c;
const jsonUnicodeEscape = 0x75;

function hexadecimalNibble(value: number): number | null {
  if (value >= 0x30 && value <= 0x39) return value - 0x30;
  if (value >= 0x41 && value <= 0x46) return value - 0x41 + 10;
  if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10;
  return null;
}

function unicodeEscapeCodeUnit(
  bytes: Uint8Array,
  firstHexadecimalIndex: number,
): number | null {
  let codeUnit = 0;
  for (let offset = 0; offset < 4; offset += 1) {
    const nibble = hexadecimalNibble(bytes[firstHexadecimalIndex + offset]!);
    if (nibble === null) return null;
    codeUnit = codeUnit * 16 + nibble;
  }
  return codeUnit;
}

/** Rejects lone surrogate escapes before the byte parser can replace them. */
function hasOnlyScalarUnicodeEscapes(bytes: Uint8Array): boolean {
  let inString = false;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const value = bytes[index];
    if (!inString) {
      if (value === jsonQuotationMark) {
        inString = true;
      }
      continue;
    }
    if (value === jsonQuotationMark) {
      inString = false;
      continue;
    }
    if (value !== jsonReverseSolidus) continue;
    index += 1;
    if (bytes[index] !== jsonUnicodeEscape) continue;
    const codeUnit = unicodeEscapeCodeUnit(bytes, index + 1);
    if (codeUnit === null) return false;
    index += 4;
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
    if (codeUnit < 0xd800 || codeUnit > 0xdbff) continue;
    if (
      bytes[index + 1] !== jsonReverseSolidus ||
      bytes[index + 2] !== jsonUnicodeEscape
    ) {
      return false;
    }
    const lowSurrogate = unicodeEscapeCodeUnit(bytes, index + 3);
    if (
      lowSurrogate === null ||
      lowSurrogate < 0xdc00 ||
      lowSurrogate > 0xdfff
    ) {
      return false;
    }
    index += 6;
  }
  return true;
}

function parseUtf8Json(bytes: Uint8Array): unknown {
  if (!isUtf8(bytes) || !hasOnlyScalarUnicodeEscapes(bytes)) {
    throw new SyntaxError("dataforrest_events.utf8_invalid");
  }
  const parser = new JSONParser({
    paths: ["$"],
    stringBufferSize: 64 * 1024,
    numberBufferSize: 64,
  });
  const containers: Array<
    | { kind: "array"; itemCount: number }
    | { kind: "object"; expectingKey: boolean; keyCount: number }
  > = [];
  let nodeCount = 0;
  let parsed = false;
  let root: unknown;
  const registerValue = () => {
    nodeCount += 1;
    if (nodeCount > maximumJsonNodeCount) {
      throw new SyntaxError("dataforrest_events.json_node_limit");
    }
    const parent = containers.at(-1);
    if (parent?.kind === "array") {
      parent.itemCount += 1;
      if (parent.itemCount > maximumJsonArrayItems) {
        throw new SyntaxError("dataforrest_events.json_array_limit");
      }
    }
  };
  parser.onToken = ({ token, value }) => {
    if (token === TokenType.LEFT_BRACE) {
      registerValue();
      if (containers.length >= maximumJsonNestingDepth) {
        throw new SyntaxError("dataforrest_events.json_depth_limit");
      }
      containers.push({ kind: "object", expectingKey: true, keyCount: 0 });
      return;
    }
    if (token === TokenType.LEFT_BRACKET) {
      registerValue();
      if (containers.length >= maximumJsonNestingDepth) {
        throw new SyntaxError("dataforrest_events.json_depth_limit");
      }
      containers.push({ kind: "array", itemCount: 0 });
      return;
    }
    if (token === TokenType.RIGHT_BRACE) {
      if (containers.at(-1)?.kind !== "object") {
        throw new SyntaxError("dataforrest_events.json_container_mismatch");
      }
      containers.pop();
      return;
    }
    if (token === TokenType.RIGHT_BRACKET) {
      if (containers.at(-1)?.kind !== "array") {
        throw new SyntaxError("dataforrest_events.json_container_mismatch");
      }
      containers.pop();
      return;
    }
    const container = containers.at(-1);
    if (
      token === TokenType.STRING &&
      container?.kind === "object" &&
      container.expectingKey
    ) {
      if (reservedJsonObjectKeys.has(value as string)) {
        throw new SyntaxError("dataforrest_events.reserved_json_key");
      }
      // This is a parser-work bound: repeated member names still consume input
      // and parser work even though JSON's last-write semantics retain one key.
      container.keyCount += 1;
      if (container.keyCount > maximumJsonObjectKeys) {
        throw new SyntaxError("dataforrest_events.json_object_key_limit");
      }
      container.expectingKey = false;
      return;
    }
    if (
      token === TokenType.STRING ||
      token === TokenType.NUMBER ||
      token === TokenType.TRUE ||
      token === TokenType.FALSE ||
      token === TokenType.NULL
    ) {
      registerValue();
      return;
    }
    if (token === TokenType.COMMA && container?.kind === "object") {
      container.expectingKey = true;
    }
  };
  parser.onValue = ({ value, parent }) => {
    if (parent === undefined) {
      if (parsed) throw new SyntaxError("dataforrest_events.multiple_roots");
      parsed = true;
      root = value;
    }
  };
  // Keep each tokenizer append at or below its fixed string buffer. Passing an
  // entire 8 MiB response lets an individual provider string bypass that
  // buffer and creates a second page-sized contiguous decode allocation.
  for (let offset = 0; offset < bytes.byteLength; offset += jsonParserInputChunkBytes) {
    parser.write(bytes.subarray(offset, offset + jsonParserInputChunkBytes));
  }
  if (!parser.isEnded) parser.end();
  if (!parsed || containers.length !== 0) {
    throw new SyntaxError("dataforrest_events.incomplete_json");
  }
  return root;
}

function hasBoundedJsonShape(root: unknown): boolean {
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [{
    value: root,
    depth: 0,
  }];
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodeCount += 1;
    if (nodeCount > maximumJsonNodeCount) return false;
    const value = current.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== "object" || current.depth >= maximumJsonNestingDepth) {
      return false;
    }
    if (Array.isArray(value)) {
      if (value.length > maximumJsonArrayItems) return false;
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: value[index], depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > maximumJsonObjectKeys ||
      keys.some((key) =>
        typeof key !== "string" || reservedJsonObjectKeys.has(key)
      )
    ) {
      return false;
    }
    for (const key of keys as string[]) {
      pending.push({
        value: (value as Record<string, unknown>)[key],
        depth: current.depth + 1,
      });
    }
  }
  return true;
}

function pageEnvelopeShapeCandidate(root: unknown): unknown {
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    return null;
  }
  const candidate: Record<string, unknown> = {};
  for (const key of Object.keys(root)) {
    const value = (root as Record<string, unknown>)[key];
    if (key === "records") {
      candidate[key] = Array.isArray(value)
        ? value.map((record) => {
          if (
            record === null ||
            typeof record !== "object" ||
            Array.isArray(record)
          ) {
            return null;
          }
          return Object.fromEntries(
            Object.keys(record).map((recordKey) => [recordKey, null]),
          );
        })
        : null;
      continue;
    }
    if (
      (key === "next_cursor" && typeof value === "string") ||
      (key === "poll_after_seconds" && typeof value === "number")
    ) {
      candidate[key] = value;
    } else {
      candidate[key] = null;
    }
  }
  return candidate;
}

/**
 * Validates an already-JSON-parsed V1 envelope without cloning its complete
 * native evidence tree. The lightweight candidate delegates exact wrapper,
 * cursor, poll, record-count, and record-key rules to the canonical Zod
 * schema; the bounded traversal validates every original JSON value.
 */
export function isBoundedDataforrestEventsPageV1(
  value: unknown,
  pageLimit: number,
): value is DataforrestEventsPageV1 {
  if (!hasBoundedJsonShape(value)) return false;
  const parsedShape = dataforrestEventsPageV1Schema.safeParse(
    pageEnvelopeShapeCandidate(value),
  );
  return parsedShape.success &&
    (value as DataforrestEventsPageV1).records.length <= pageLimit;
}

function failure(
  code: SourceAdapterFailure["code"],
  disposition: SourceAdapterFailure["disposition"] = "source_action_required",
): SourceAdapterFailure {
  return Object.freeze(sourceAdapterFailureSchema.parse({ disposition, code }));
}

function diagnostic(
  code: string,
  severity: SourceAdapterSafeDiagnostic["severity"] = "warning",
  counters?: Readonly<Record<string, number>>,
): SourceAdapterSafeDiagnostic {
  return Object.freeze({
    severity,
    phase: "response_interpretation",
    code,
    ...(counters === undefined ? {} : { counters: { ...counters } }),
  });
}

function parsePage(
  request: SuccessfulSourceAdapterRequest,
  pageLimit: number,
  adapterVersion: string,
): PageParseResult {
  let raw: unknown;
  try {
    raw = parseUtf8Json(request.value.protectedRawResponse);
  } catch {
    return { ok: false };
  }
  try {
    if (dataforrestManifest(adapterVersion) === null) {
      return { ok: false };
    }
    if (!isBoundedDataforrestEventsPageV1(raw, pageLimit)) {
      return { ok: false };
    }
    return { ok: true, page: raw };
  } catch {
    return { ok: false };
  }
}

function sourceContextIsValid(
  context: SourceTestInterpretationContext | PageReadInterpretationContext,
): boolean {
  const manifest = dataforrestManifest(context.adapterVersion);
  const declaration = manifest?.supportedProviders
    .find(({ provider }) => provider === context.provider);
  const configuration = dataforrestEventsSourceConfigurationV1Schema.safeParse(
    context.sourceConfiguration,
  );
  if (
    manifest === null ||
    declaration === undefined ||
    !configuration.success ||
    configuration.data.platform !== context.provider ||
    context.normalizedContractVersion !== manifest.normalizedContractVersion ||
    context.identityNamespaceKey !== declaration.identityNamespaceKey
  ) {
    return false;
  }
  const actualScopes = [...context.recordIdScopes]
    .sort((left, right) =>
      left.recordIdScopeKey.localeCompare(right.recordIdScopeKey)
    );
  const expectedScopes = [...declaration.recordIdScopes]
    .sort((left, right) =>
      left.recordIdScopeKey.localeCompare(right.recordIdScopeKey)
    );
  return actualScopes.length === expectedScopes.length &&
    actualScopes.every((scope, index) => {
      const candidate = expectedScopes[index];
      return candidate !== undefined &&
        scope.recordIdScopeKey === candidate.recordIdScopeKey &&
        scope.sourceKind === candidate.sourceKind &&
        scope.catalogEntity === candidate.catalogEntity &&
        scope.canonicalKind === candidate.canonicalKind;
    });
}

// Mirrors the outcome contract's safe-reference constraint so record-local
// defect paths always survive normalized-page validation downstream.
const safeFieldPathPattern = /^[a-z0-9](?:[a-z0-9:._-]{0,254}[a-z0-9])?$/u;

function fieldPathsFromIssues(
  issues: readonly Readonly<{ path: PropertyKey[] }>[],
): string[] {
  const paths = issues
    .map(({ path }) =>
      path
        .filter((part): part is string | number =>
          typeof part === "string" || typeof part === "number"
        )
        .join(".")
        .replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`)
    )
    .filter((path) => safeFieldPathPattern.test(path))
    .slice(0, 32);
  return [...new Set(paths.length > 0 ? paths : ["record"])] as string[];
}

function invalidOutcome(
  recordIndex: number,
  reasonCode: string,
  fieldPaths: readonly string[],
  protectedNativeEvidenceRef: string,
): NormalizedObservationOutcome {
  return {
    status: "invalid",
    recordIndex,
    reasonCode,
    fieldPaths: [...fieldPaths],
    protectedNativeEvidenceRef,
  };
}

function requiredFieldsForStream(stream: string): readonly string[] {
  const base = [
    "platform",
    "record_id",
    "occurred_at",
    "collected_at",
    "data",
  ];
  if (stream === "catalog") {
    return [...base, "entity", "first_seen_at", "available"];
  }
  if (stream === "pulls") return [...base, "pack_id", "card_id"];
  return [
    ...base,
    "card_id",
    "event_type",
    "amount",
    "currency",
    "payment_method",
    "tx_hash",
  ];
}

function interpretRecord(
  record: Record<string, unknown>,
  provider: LaunchProviderKey,
  recordIndex: number,
  adapterVersion: string,
): NormalizedObservationOutcome {
  const evidenceReference = `page_record:${recordIndex}`;
  if (
    typeof record.record_id !== "string" ||
    record.record_id.trim().length === 0
  ) {
    return invalidOutcome(
      recordIndex,
      "missing_identity",
      ["record_id"],
      evidenceReference,
    );
  }
  if (typeof record.stream !== "string" || !knownStreams.has(record.stream)) {
    return invalidOutcome(
      recordIndex,
      "unknown_stream",
      ["stream"],
      evidenceReference,
    );
  }
  if (record.platform !== provider) {
    return invalidOutcome(
      recordIndex,
      "platform_mismatch",
      ["platform"],
      evidenceReference,
    );
  }
  const missingFields = requiredFieldsForStream(record.stream).filter(
    (field) => !(field in record),
  );
  if (missingFields.length > 0) {
    return invalidOutcome(
      recordIndex,
      "missing_required_fields",
      missingFields,
      evidenceReference,
    );
  }
  const parsed = dataforrestEventRecordV1Schema.safeParse(record);
  if (!parsed.success) {
    const invalidTimestamp = parsed.error.issues.some(({ path }) =>
      timestampFields.has(String(path[0] ?? ""))
    );
    return invalidOutcome(
      recordIndex,
      invalidTimestamp ? "invalid_timestamp" : "missing_required_fields",
      fieldPathsFromIssues(parsed.error.issues),
      evidenceReference,
    );
  }
  try {
    return {
      status: "valid",
      recordIndex,
      observation: normalizeDataforrestEventRecordForAdapter(
        parsed.data as DataforrestEventRecordV1,
        provider,
        evidenceReference,
        adapterVersion,
      ),
    };
  } catch (error) {
    // Normalization defects are record-local: raw-valid values the normalized
    // contract rejects (for example a lowercase trade currency) must quarantine
    // this record instead of failing the entire page.
    if (!(error instanceof Error) || error.name !== "ZodError") throw error;
    return invalidOutcome(
      recordIndex,
      "invalid_field_values",
      fieldPathsFromIssues((error as ZodError).issues),
      evidenceReference,
    );
  }
}

function interpretRecords(
  page: DataforrestEventsPageV1,
  provider: LaunchProviderKey,
  adapterVersion: string,
): readonly NormalizedObservationOutcome[] {
  if (dataforrestManifest(adapterVersion) === null) {
    throw new RangeError("dataforrest_events.adapter_version_unsupported");
  }
  return page.records.map((record, recordIndex) =>
    interpretRecord(record, provider, recordIndex, adapterVersion)
  );
}

async function interpretDataforrestConnectionTestUnsafe(
  context: ConnectionTestInterpretationContext,
  request: SuccessfulSourceAdapterRequest,
): Promise<SourceAdapterInterpretationResult<ConnectionTestValue>> {
  const parsed = parsePage(
    request,
    context.bounds.pageLimit,
    context.adapterVersion,
  );
  if (!parsed.ok) {
    return {
      ok: false,
      failure: failure(
        "profile_configuration_invalid",
        "connection_action_required",
      ),
      recordCount: 0,
      diagnostics: [diagnostic("connection_response_invalid")],
    };
  }
  return {
    ok: true,
    value: { status: "reachable" },
    recordCount: 0,
    diagnostics: [diagnostic("connection_reachable", "info")],
  };
}

async function interpretDataforrestSourceTestUnsafe(
  context: SourceTestInterpretationContext,
  request: SuccessfulSourceAdapterRequest,
): Promise<SourceAdapterInterpretationResult<SourceTestValue>> {
  if (!sourceContextIsValid(context)) {
    return {
      ok: false,
      failure: failure("invalid_source_configuration"),
      recordCount: 0,
      diagnostics: [diagnostic("source_context_invalid")],
    };
  }
  const parsed = parsePage(
    request,
    context.bounds.pageLimit,
    context.adapterVersion,
  );
  if (!parsed.ok) {
    return {
      ok: false,
      failure: failure("invalid_response"),
      recordCount: 0,
      diagnostics: [diagnostic("source_response_invalid")],
    };
  }
  const outcomes = interpretRecords(
    parsed.page,
    context.provider,
    context.adapterVersion,
  );
  const invalidRecords = outcomes.filter(({ status }) => status === "invalid")
    .length;
  if (invalidRecords > 0) {
    return {
      ok: false,
      failure: failure("invalid_response"),
      recordCount: outcomes.length,
      diagnostics: [diagnostic("source_records_invalid", "warning", {
        records: outcomes.length,
        invalid_records: invalidRecords,
      })],
    };
  }
  return {
    ok: true,
    value: { status: "readable", provider: context.provider },
    recordCount: outcomes.length,
    diagnostics: [diagnostic("source_readable", "info", {
      records: outcomes.length,
    })],
  };
}

async function interpretDataforrestPageUnsafe(
  context: PageReadInterpretationContext,
  request: SuccessfulSourceAdapterRequest,
): Promise<SourceAdapterPageInterpretationResult> {
  if (!sourceContextIsValid(context)) {
    return {
      ok: false,
      failure: failure("invalid_source_configuration"),
      diagnostics: [diagnostic("source_context_invalid")],
    };
  }
  const parsed = parsePage(request, context.pageLimit, context.adapterVersion);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: failure("invalid_response"),
      diagnostics: [diagnostic("page_wrapper_invalid")],
    };
  }
  const continuation = dataforrestContinuation(parsed.page);
  if (
    continuation.kind === "continue" &&
    parsed.page.next_cursor === context.requestedCursor.value
  ) {
    return {
      ok: false,
      failure: failure("invalid_cursor"),
      diagnostics: [diagnostic("continuation_did_not_advance")],
    };
  }
  const outcomes = interpretRecords(
    parsed.page,
    context.provider,
    context.adapterVersion,
  );
  const invalidRecords = outcomes.filter(({ status }) => status === "invalid")
    .length;
  const protectedNativeEvidence = sealTrustedProtectedNativeEvidence(
    parsed.page.records.flatMap(
      (value, recordIndex) => {
        const evidence = [{
          reference: `page_record:${recordIndex}`,
          value,
        }];
        const outcome = outcomes[recordIndex];
        if (
          outcome?.status === "valid" &&
          outcome.observation.kind === "trade" &&
          outcome.observation.protectedTransactionEvidenceRef !== null
        ) {
          evidence.push({
            reference:
              outcome.observation.protectedTransactionEvidenceRef,
            value: { tx_hash: value.tx_hash },
          });
        }
        return evidence;
      },
    ),
  );
  return {
    ok: true,
    value: {
      protectedNativeEvidence,
      normalizedPage: {
        normalizedContractVersion: dataforrestManifest(
          context.adapterVersion,
        )!.normalizedContractVersion,
        provider: context.provider,
        outcomes: [...outcomes],
        nextCursor: dataforrestNextCursor(
          context.requestedCursor,
          parsed.page,
        ),
        continuation,
      },
    },
    diagnostics: [diagnostic(
      invalidRecords > 0 ? "page_contains_invalid_records" : "page_valid",
      invalidRecords > 0 ? "warning" : "info",
      { records: outcomes.length, invalid_records: invalidRecords },
    )],
  };
}

export async function interpretDataforrestConnectionTest(
  context: ConnectionTestInterpretationContext,
  request: SuccessfulSourceAdapterRequest,
): Promise<SourceAdapterInterpretationResult<ConnectionTestValue>> {
  try {
    return await interpretDataforrestConnectionTestUnsafe(context, request);
  } catch {
    return {
      ok: false,
      failure: failure(
        "profile_configuration_invalid",
        "connection_action_required",
      ),
      recordCount: 0,
      diagnostics: [diagnostic("connection_response_invalid")],
    };
  }
}

export async function interpretDataforrestSourceTest(
  context: SourceTestInterpretationContext,
  request: SuccessfulSourceAdapterRequest,
): Promise<SourceAdapterInterpretationResult<SourceTestValue>> {
  try {
    return await interpretDataforrestSourceTestUnsafe(context, request);
  } catch {
    return {
      ok: false,
      failure: failure("invalid_response"),
      recordCount: 0,
      diagnostics: [diagnostic("source_response_invalid")],
    };
  }
}

export async function interpretDataforrestPage(
  context: PageReadInterpretationContext,
  request: SuccessfulSourceAdapterRequest,
): Promise<SourceAdapterPageInterpretationResult> {
  try {
    return await interpretDataforrestPageUnsafe(context, request);
  } catch {
    return {
      ok: false,
      failure: failure("invalid_response"),
      diagnostics: [diagnostic("page_wrapper_invalid")],
    };
  }
}
