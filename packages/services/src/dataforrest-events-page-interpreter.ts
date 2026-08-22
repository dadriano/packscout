import type { ZodError } from "zod";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestContinuation,
  dataforrestEventRecordV1Schema,
  dataforrestEventsPageV1Schema,
  dataforrestEventsSourceConfigurationV1Schema,
  dataforrestNextCursor,
  dataforrestEventsV1SourceAdapterManifest,
  normalizeDataforrestEventRecord,
  sourceAdapterFailureSchema,
  type DataforrestEventsPageV1,
  type LaunchProviderKey,
  type NormalizedObservationOutcome,
  type SourceAdapterFailure,
  type SourceAdapterSafeDiagnostic,
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

type PageParseResult =
  | Readonly<{ ok: true; page: DataforrestEventsPageV1 }>
  | Readonly<{ ok: false }>;

const knownStreams = new Set(["catalog", "pulls", "trades"]);
const timestampFields = new Set([
  "occurred_at",
  "collected_at",
  "first_seen_at",
]);
const maximumJsonNestingDepth = 64;
const maximumJsonNodeCount = 100_000;
const maximumJsonObjectKeys = 256;
const maximumJsonArrayItems = 5_000;
const reservedJsonObjectKeys = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

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
): PageParseResult {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      request.value.protectedRawResponse,
    );
  } catch {
    return { ok: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoded) as unknown;
  } catch {
    return { ok: false };
  }
  if (!hasBoundedJsonShape(raw)) return { ok: false };
  try {
    const parsed = dataforrestEventsPageV1Schema.safeParse(raw);
    if (!parsed.success || parsed.data.records.length > pageLimit) {
      return { ok: false };
    }
    return { ok: true, page: parsed.data };
  } catch {
    return { ok: false };
  }
}

function sourceContextIsValid(
  context: SourceTestInterpretationContext | PageReadInterpretationContext,
): boolean {
  const declaration = dataforrestEventsV1SourceAdapterManifest
    .supportedProviders.find(({ provider }) => provider === context.provider);
  const configuration = dataforrestEventsSourceConfigurationV1Schema.safeParse(
    context.sourceConfiguration,
  );
  if (
    declaration === undefined ||
    !configuration.success ||
    configuration.data.platform !== context.provider ||
    context.normalizedContractVersion !==
      PROVIDER_OBSERVATION_CONTRACT_VERSION ||
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
      observation: normalizeDataforrestEventRecord(
        parsed.data,
        provider,
        evidenceReference,
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
): readonly NormalizedObservationOutcome[] {
  return page.records.map((record, recordIndex) =>
    interpretRecord(record, provider, recordIndex)
  );
}

async function interpretDataforrestConnectionTestUnsafe(
  context: ConnectionTestInterpretationContext,
  request: SuccessfulSourceAdapterRequest,
): Promise<SourceAdapterInterpretationResult<ConnectionTestValue>> {
  const parsed = parsePage(request, context.bounds.pageLimit);
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
  const parsed = parsePage(request, context.bounds.pageLimit);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: failure("invalid_response"),
      recordCount: 0,
      diagnostics: [diagnostic("source_response_invalid")],
    };
  }
  const outcomes = interpretRecords(parsed.page, context.provider);
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
  const parsed = parsePage(request, context.pageLimit);
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
  const outcomes = interpretRecords(parsed.page, context.provider);
  const invalidRecords = outcomes.filter(({ status }) => status === "invalid")
    .length;
  return {
    ok: true,
    value: {
      protectedNativeEvidence: parsed.page.records.flatMap(
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
      normalizedPage: {
        normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
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
