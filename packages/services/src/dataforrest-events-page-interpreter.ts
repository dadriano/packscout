import type { ZodError } from "zod";
import { isUtf8 } from "node:buffer";
import { JSONParser, TokenType } from "@streamparser/json";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  adaptDataforrestEventRecordForAdapter,
  dataforrestEventsCatalogSourceConfigurationV1Schema,
  dataforrestEventsJsonNodeBudget,
  dataforrestContinuation,
  dataforrestEventRecordV1Schema,
  dataforrestEventsPageV1Schema,
  dataforrestEventsSourceConfigurationSchemaForAdapter,
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
  type NormalizedContinuation,
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

function dataforrestSourceConfigurationSchema(adapterVersion: string) {
  try {
    return dataforrestEventsSourceConfigurationSchemaForAdapter(adapterVersion);
  } catch (error) {
    if (
      error instanceof RangeError &&
      error.message === "dataforrest_events.adapter_version_unsupported"
    ) {
      return null;
    }
    throw error;
  }
}

const knownStreams = new Set(["catalog", "pulls", "trades"]);
const timestampFields = new Set([
  "occurred_at",
  "collected_at",
  "first_seen_at",
]);
const maximumJsonNestingDepth = 64;
// Byte and whole-page value-node admission come from the exact immutable
// adapter profile. Historical profiles retain 8 MiB/480,000 values; the separately
// capacity-tested Courtyard-v2 revision admits 32 MiB/640,000 values.
const maximumJsonObjectKeys = 256;
const maximumJsonArrayItems = 5_000;
// Native arrays share the existing whole-page value-node budget, rather than
// an observed-shape guess: a 24,005-item sales array fits a 214,945-node page.
// Every item consumes a node before materialization. This does not increase
// total work/memory admission or change envelope/manifest record-count limits.
const jsonParserInputChunkBytes = 64 * 1024;
const reservedJsonObjectKeys = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const jsonQuotationMark = 0x22;
const jsonReverseSolidus = 0x5c;
const jsonUnicodeEscape = 0x75;

type JsonShapeLocation = "root" | "records" | "record" | "native" | "other";

function childJsonShapeLocation(
  parent: JsonShapeLocation,
  key: string | number | null,
): JsonShapeLocation {
  if (parent === "native") return "native";
  if (parent === "root" && key === "records") return "records";
  if (parent === "records" && typeof key === "number") return "record";
  if (parent === "record" && key === "data") return "native";
  return "other";
}

function jsonArrayItemLimit(location: JsonShapeLocation, maximumJsonNodeCount: number): number {
  return location === "native" ? maximumJsonNodeCount : maximumJsonArrayItems;
}

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

function parseUtf8Json(bytes: Uint8Array, maximumJsonNodeCount: number): unknown {
  if (!isUtf8(bytes) || !hasOnlyScalarUnicodeEscapes(bytes)) {
    throw new SyntaxError("dataforrest_events.utf8_invalid");
  }
  const parser = new JSONParser({
    paths: ["$"],
    stringBufferSize: 64 * 1024,
    numberBufferSize: 64,
  });
  const containers: Array<{ location: JsonShapeLocation } & (
    | { kind: "array"; itemCount: number }
    | { kind: "object"; expectingKey: boolean; keyCount: number; key: string | null }
  )> = [];
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
      if (parent.itemCount > jsonArrayItemLimit(parent.location, maximumJsonNodeCount)) {
        throw new SyntaxError("dataforrest_events.json_array_limit");
      }
    }
    return parent === undefined
      ? "root"
      : childJsonShapeLocation(
        parent.location,
        parent.kind === "array" ? parent.itemCount - 1 : parent.key,
      );
  };
  parser.onToken = ({ token, value }) => {
    if (token === TokenType.LEFT_BRACE) {
      const location = registerValue();
      if (containers.length >= maximumJsonNestingDepth) {
        throw new SyntaxError("dataforrest_events.json_depth_limit");
      }
      containers.push({ kind: "object", expectingKey: true, keyCount: 0, key: null, location });
      return;
    }
    if (token === TokenType.LEFT_BRACKET) {
      const location = registerValue();
      if (containers.length >= maximumJsonNestingDepth) {
        throw new SyntaxError("dataforrest_events.json_depth_limit");
      }
      containers.push({ kind: "array", itemCount: 0, location });
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
      container.key = value as string;
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

function hasBoundedJsonShape(root: unknown, maximumJsonNodeCount: number): boolean {
  type ValueFrame = Readonly<{
    kind: "value";
    value: unknown;
    depth: number;
    location: JsonShapeLocation;
  }>;
  type ChildrenFrame = {
    kind: "children";
    value: readonly unknown[] | Readonly<Record<string, unknown>>;
    keys: readonly string[] | null;
    childCount: number;
    nextIndex: number;
    depth: number;
    location: JsonShapeLocation;
  };
  // One iterator per container keeps metadata bounded by nesting depth, even
  // when one native array consumes nearly the entire page's node budget.
  const pending: Array<ValueFrame | ChildrenFrame> = [{
    kind: "value",
    value: root,
    depth: 0,
    location: "root",
  }];
  let nodeCount = 0;
  let pendingValueCount = 1;
  while (pending.length > 0) {
    const current = pending.at(-1)!;
    if (current.kind === "children") {
      if (current.nextIndex === current.childCount) {
        pending.pop();
        continue;
      }
      const index = current.nextIndex++;
      const key = current.keys === null ? index : current.keys[index]!;
      pending.push({
        kind: "value",
        value: current.keys === null
          ? (current.value as readonly unknown[])[index]
          : (current.value as Readonly<Record<string, unknown>>)[key],
        depth: current.depth + 1,
        location: childJsonShapeLocation(current.location, key),
      });
      continue;
    }
    pending.pop();
    pendingValueCount -= 1;
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
      if (value.length > jsonArrayItemLimit(current.location, maximumJsonNodeCount)) return false;
      if (nodeCount + pendingValueCount + value.length > maximumJsonNodeCount) return false;
      pendingValueCount += value.length;
      pending.push({ kind: "children", value, keys: null, childCount: value.length,
        nextIndex: 0, depth: current.depth, location: current.location });
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
    if (nodeCount + pendingValueCount + keys.length > maximumJsonNodeCount) return false;
    pendingValueCount += keys.length;
    pending.push({ kind: "children", value: value as Readonly<Record<string, unknown>>,
      keys: keys as string[], childCount: keys.length, nextIndex: 0,
      depth: current.depth, location: current.location });
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
  adapterVersion: string = DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
): value is DataforrestEventsPageV1 {
  const maximumJsonNodeCount = dataforrestEventsJsonNodeBudget(adapterVersion);
  if (maximumJsonNodeCount === null || !hasBoundedJsonShape(value, maximumJsonNodeCount)) return false;
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
  return parseRawPage(request.value.protectedRawResponse, pageLimit, adapterVersion);
}

/** Shared byte parser only; it creates neither request nor completion authority. */
function parseRawPage(
  bytes: Uint8Array,
  pageLimit: number,
  adapterVersion: string,
): PageParseResult {
  const maximumJsonNodeCount = dataforrestEventsJsonNodeBudget(adapterVersion);
  if (dataforrestManifest(adapterVersion) === null || maximumJsonNodeCount === null) {
    return { ok: false };
  }
  let raw: unknown;
  try {
    raw = parseUtf8Json(bytes, maximumJsonNodeCount);
  } catch {
    return { ok: false };
  }
  try {
    if (!isBoundedDataforrestEventsPageV1(raw, pageLimit, adapterVersion)) {
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
  const configurationSchema = dataforrestSourceConfigurationSchema(
    context.adapterVersion,
  );
  const configuration = configurationSchema?.safeParse(
    context.sourceConfiguration,
  );
  if (
    manifest === null ||
    declaration === undefined ||
    configuration === undefined ||
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

function pageMatchesAdapterStreamFilter(
  page: DataforrestEventsPageV1,
  adapterVersion: string,
): boolean {
  const configurationSchema = dataforrestSourceConfigurationSchema(adapterVersion);
  if (configurationSchema === null) return false;
  if (configurationSchema !== dataforrestEventsCatalogSourceConfigurationV1Schema) {
    return true;
  }
  return page.records.every((record) => record.stream === "catalog");
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
  const adaptedRecord = adaptDataforrestEventRecordForAdapter(
    record,
    adapterVersion,
  );
  const missingFields = requiredFieldsForStream(record.stream).filter(
    (field) => !(field in adaptedRecord),
  );
  if (missingFields.length > 0) {
    return invalidOutcome(
      recordIndex,
      "missing_required_fields",
      missingFields,
      evidenceReference,
    );
  }
  const parsed = dataforrestEventRecordV1Schema.safeParse(adaptedRecord);
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

export interface DataforrestRawResponseInspectionInput {
  readonly provider: LaunchProviderKey;
  readonly sourceTypeKey: string;
  readonly adapterVersion: string;
  readonly pageLimit: number;
  readonly protectedRawResponse: Uint8Array;
}

export type DataforrestRawResponseInspectionResult = Readonly<{
  kind: "untrusted_inspection";
}> & (Readonly<{
  ok: true;
  recordCount: number;
  outcomes: readonly NormalizedObservationOutcome[];
  continuation: NormalizedContinuation;
}> | Readonly<{
  ok: false;
  code: "inspection_pins_invalid" | "inspection_response_invalid";
}>);

/**
 * Pure inspection for bounded canaries. Outcomes are untrusted data, not a
 * completed page, request receipt, native-evidence seal, or commit capability.
 * No raw evidence or returned cursor is exposed, and no caller bytes are changed.
 */
export function inspectDataforrestRawResponse(
  input: DataforrestRawResponseInspectionInput,
): DataforrestRawResponseInspectionResult {
  const kind = "untrusted_inspection" as const;
  const manifest = dataforrestManifest(input.adapterVersion);
  if (manifest === null || input.sourceTypeKey !== manifest.sourceTypeKey ||
    !manifest.supportedProviders.some(({ provider }) => provider === input.provider) ||
    !Number.isSafeInteger(input.pageLimit) || input.pageLimit < 1 || input.pageLimit > manifest.requestBounds.pageLimit) {
    return Object.freeze({ kind, ok: false, code: "inspection_pins_invalid" });
  }
  if (!(input.protectedRawResponse instanceof Uint8Array) ||
    input.protectedRawResponse.byteLength > manifest.requestBounds.maximumResponseBytes) {
    return Object.freeze({ kind, ok: false, code: "inspection_response_invalid" });
  }
  try {
    const parsed = parseRawPage(input.protectedRawResponse, input.pageLimit, input.adapterVersion);
    if (!parsed.ok || !pageMatchesAdapterStreamFilter(parsed.page, input.adapterVersion)) {
      return Object.freeze({ kind, ok: false, code: "inspection_response_invalid" });
    }
    return Object.freeze({ kind, ok: true, recordCount: parsed.page.records.length,
      outcomes: interpretRecords(parsed.page, input.provider, input.adapterVersion),
      continuation: dataforrestContinuation(parsed.page) });
  } catch {
    return Object.freeze({ kind, ok: false, code: "inspection_response_invalid" });
  }
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
  if (!pageMatchesAdapterStreamFilter(parsed.page, context.adapterVersion)) {
    return {
      ok: false,
      failure: failure("invalid_response"),
      recordCount: parsed.page.records.length,
      diagnostics: [diagnostic("catalog_stream_filter_violated")],
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
  if (!pageMatchesAdapterStreamFilter(parsed.page, context.adapterVersion)) {
    return {
      ok: false,
      failure: failure("invalid_response"),
      diagnostics: [diagnostic("catalog_stream_filter_violated")],
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
