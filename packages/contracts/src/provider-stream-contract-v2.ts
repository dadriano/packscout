import { z } from "zod";

const validationMarkers = {
  emptyString: "provider_stream_v2.empty_string",
  finiteNumber: "provider_stream_v2.finite_number",
  invalidJson: "provider_stream_v2.invalid_json",
  invalidString: "provider_stream_v2.invalid_string",
  timestamp: "provider_stream_v2.timestamp",
} as const;

function hasUnsafeProviderCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 31 ||
      codePoint === 127 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    );
  });
}

function boundedProviderStringSchema(maximumLength: number) {
  return z
    .string()
    .refine((value) => value.trim().length > 0, {
      message: validationMarkers.emptyString,
    })
    .refine(
      (value) =>
        value.length <= maximumLength &&
        !hasUnsafeProviderCharacter(value),
      { message: validationMarkers.invalidString },
    );
}

const maximumOpaqueDataDepth = 64;
const maximumOpaqueDataNodes = 250_000;
const maximumOpaqueStringLength = 2 * 1024 * 1024;

function hasDatabaseUnsafeJsonText(value: string): boolean {
  return value.includes("\u0000") || [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0xd800 && codePoint <= 0xdfff;
  });
}

function opaqueJsonValidationMarker(value: unknown): string | null {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let visitedNodes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    visitedNodes += 1;
    if (
      visitedNodes > maximumOpaqueDataNodes ||
      current.depth > maximumOpaqueDataDepth
    ) {
      return validationMarkers.invalidJson;
    }
    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "string") {
      if (
        current.value.length > maximumOpaqueStringLength ||
        hasDatabaseUnsafeJsonText(current.value)
      ) {
        return validationMarkers.invalidString;
      }
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return validationMarkers.invalidJson;
      continue;
    }
    if (typeof current.value !== "object") return validationMarkers.invalidJson;
    if (seen.has(current.value)) return validationMarkers.invalidJson;
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      return validationMarkers.invalidJson;
    }
    let entries: [string, unknown][];
    try {
      entries = Object.entries(current.value);
    } catch {
      return validationMarkers.invalidJson;
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      if (
        key.length > maximumOpaqueStringLength ||
        hasDatabaseUnsafeJsonText(key)
      ) {
        return validationMarkers.invalidString;
      }
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return null;
}

const platformKeySchema = boundedProviderStringSchema(128);
const providerIdentitySchema = boundedProviderStringSchema(512);
const providerVocabularySchema = boundedProviderStringSchema(128);
const opaqueCursorValueSchema = boundedProviderStringSchema(2_048);
const requestedCursorSchema = opaqueCursorValueSchema.nullable();

const timestampSchema = z.iso.datetime({
  offset: true,
  message: validationMarkers.timestamp,
});

const finiteNumberSchema = z.custom<number>(
  (value) => typeof value === "number" && Number.isFinite(value),
  { message: validationMarkers.finiteNumber },
);

const opaqueDataSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    const marker = opaqueJsonValidationMarker(value);
    if (marker !== null) {
      context.addIssue({ code: "custom", message: marker });
    }
  });

const providerRecordV2BaseShape = {
  platform: platformKeySchema,
  record_id: providerIdentitySchema,
  occurred_at: timestampSchema.nullable(),
  collected_at: timestampSchema,
  data: opaqueDataSchema,
} as const;

export const catalogRecordV2Schema = z
  .object({
    ...providerRecordV2BaseShape,
    stream: z.literal("catalog"),
    entity: z.enum(["pack", "card"]),
    first_seen_at: timestampSchema,
    /**
     * The live API always supplies this field. It remains optional only so the
     * digest-pinned August 13 archive can still be replayed and audited.
     */
    available: z.boolean().nullable().optional(),
  })
  .strict();

export const pullRecordV2Schema = z
  .object({
    ...providerRecordV2BaseShape,
    stream: z.literal("pulls"),
    pack_id: providerIdentitySchema,
    card_id: providerIdentitySchema.nullable(),
  })
  .strict();

export const tradeRecordV2Schema = z
  .object({
    ...providerRecordV2BaseShape,
    stream: z.literal("trades"),
    card_id: providerIdentitySchema,
    event_type: providerVocabularySchema,
    amount: finiteNumberSchema.nullable(),
    currency: providerVocabularySchema.nullable(),
    /** Provider-agreed optional metadata; it is absent from the Aug-13 archive. */
    payment_method: providerVocabularySchema.nullable().optional(),
    tx_hash: providerIdentitySchema,
  })
  .strict();

export const providerStreamRecordV2Schema = z.discriminatedUnion("stream", [
  catalogRecordV2Schema,
  pullRecordV2Schema,
  tradeRecordV2Schema,
]);

/**
 * The normalized internal page produced by a provider-local transport decoder.
 * A provider has one cursor and a page may contain records from any stream.
 * This deliberately is not a schema for the provider's as-yet-unobserved raw
 * page wrapper.
 */
export const providerStreamPageV2Schema = z
  .object({
    requestedCursor: requestedCursorSchema,
    nextCursor: opaqueCursorValueSchema,
    hasMore: z.boolean(),
    records: z.array(providerStreamRecordV2Schema),
  })
  .strict();

const providerStreamPageStructureV2Schema = z
  .object({
    requestedCursor: requestedCursorSchema,
    nextCursor: opaqueCursorValueSchema,
    hasMore: z.boolean(),
    records: z.array(z.unknown()),
  })
  .strict();

export type CatalogRecordV2 = z.infer<typeof catalogRecordV2Schema>;
export type PullRecordV2 = z.infer<typeof pullRecordV2Schema>;
export type TradeRecordV2 = z.infer<typeof tradeRecordV2Schema>;
export type ProviderStreamRecordV2 = z.infer<
  typeof providerStreamRecordV2Schema
>;
export type ProviderStreamKind = ProviderStreamRecordV2["stream"];
export type ProviderRecordKindV2 = "catalog" | "pull" | "trade";
export type ProviderStreamPageV2 = Readonly<
  Omit<z.infer<typeof providerStreamPageV2Schema>, "records"> & {
    readonly records: readonly ProviderStreamRecordV2[];
  }
>;
export type ProviderStreamPageStructureV2 = z.infer<
  typeof providerStreamPageStructureV2Schema
>;

export type ProviderStreamValidationIssueCode =
  | "cursor_cycle"
  | "cursor_not_advanced"
  | "empty_continuing_page"
  | "empty_string"
  | "invalid_json"
  | "invalid_number"
  | "invalid_string"
  | "invalid_timestamp"
  | "invalid_type"
  | "platform_mismatch"
  | "unrecognized_value";

export interface ProviderStreamValidationIssue {
  readonly code: ProviderStreamValidationIssueCode;
  readonly path: string;
}

export interface ProviderStreamValidationContext {
  readonly requestedPlatform: string;
  readonly requestedCursor: string | null;
  readonly seenCursors?: ReadonlySet<string>;
}

export interface ProviderStreamValidRecordOutcomeV2 {
  readonly status: "valid";
  readonly recordIndex: number;
  readonly record: ProviderStreamRecordV2;
}

export interface ProviderStreamInvalidRecordOutcomeV2 {
  readonly status: "invalid";
  readonly recordIndex: number;
  readonly rawRecord: unknown;
  readonly issues: readonly ProviderStreamValidationIssue[];
}

export type ProviderStreamRecordValidationOutcomeV2 =
  | ProviderStreamValidRecordOutcomeV2
  | ProviderStreamInvalidRecordOutcomeV2;

export interface ProviderStreamValidatedPageV2 {
  /** Protected source evidence; it must never be copied into a public snapshot. */
  readonly rawPage: unknown;
  readonly page: ProviderStreamPageV2;
  readonly recordOutcomes: readonly ProviderStreamRecordValidationOutcomeV2[];
  readonly invalidRecords: readonly ProviderStreamInvalidRecordOutcomeV2[];
}

export class ProviderStreamValidationError extends Error {
  readonly code = "PROVIDER_STREAM_V2_VALIDATION_FAILED";
  readonly issues: readonly ProviderStreamValidationIssue[];

  constructor(issues: readonly ProviderStreamValidationIssue[]) {
    super("Provider stream failed V2 validation.");
    this.name = "ProviderStreamValidationError";
    this.issues = Object.freeze(
      issues.map((issue) => Object.freeze({ ...issue })),
    );
  }
}

function formatFieldPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "$";
  return path.reduce<string>((result, segment) => {
    if (typeof segment === "number") return `${result}[${segment}]`;
    const key = String(segment);
    return result.length === 0 ? key : `${result}.${key}`;
  }, "");
}

function normalizeSchemaIssue(
  issue: z.core.$ZodIssue,
): ProviderStreamValidationIssue {
  let code: ProviderStreamValidationIssueCode = "unrecognized_value";
  if (issue.message === validationMarkers.emptyString) code = "empty_string";
  else if (issue.message === validationMarkers.invalidJson) code = "invalid_json";
  else if (issue.message === validationMarkers.finiteNumber) {
    code = "invalid_number";
  } else if (issue.message === validationMarkers.invalidString) {
    code = "invalid_string";
  } else if (issue.message === validationMarkers.timestamp) {
    code = "invalid_timestamp";
  } else if (issue.code === "invalid_type") code = "invalid_type";
  return Object.freeze({ code, path: formatFieldPath(issue.path) });
}

function prefixRecordIssue(
  issue: ProviderStreamValidationIssue,
  recordIndex: number,
): ProviderStreamValidationIssue {
  const recordPath = `records[${recordIndex}]`;
  return Object.freeze({
    code: issue.code,
    path: issue.path === "$" ? recordPath : `${recordPath}.${issue.path}`,
  });
}

function pageIssues(
  page: ProviderStreamPageStructureV2,
  context: ProviderStreamValidationContext,
): ProviderStreamValidationIssue[] {
  const issues: ProviderStreamValidationIssue[] = [];
  if (context.requestedPlatform.trim().length === 0) {
    issues.push({ code: "empty_string", path: "requestedPlatform" });
  }
  if (context.requestedCursor === "") {
    issues.push({ code: "empty_string", path: "requestedCursor" });
  }
  if (page.requestedCursor !== context.requestedCursor) {
    issues.push({ code: "unrecognized_value", path: "requestedCursor" });
  }
  if (page.hasMore && page.records.length === 0) {
    issues.push({ code: "empty_continuing_page", path: "hasMore" });
  }
  if (
    page.nextCursor === context.requestedCursor &&
    (page.hasMore || page.records.length > 0)
  ) {
    issues.push({ code: "cursor_not_advanced", path: "nextCursor" });
  } else if (
    page.nextCursor !== context.requestedCursor &&
    context.seenCursors?.has(page.nextCursor)
  ) {
    issues.push({ code: "cursor_cycle", path: "nextCursor" });
  }
  return issues;
}

function validateRecords(
  page: ProviderStreamPageStructureV2,
  context: ProviderStreamValidationContext,
): ProviderStreamRecordValidationOutcomeV2[] {
  return page.records.map((rawRecord, recordIndex) => {
    const parsed = providerStreamRecordV2Schema.safeParse(rawRecord);
    const issues = parsed.success
      ? parsed.data.platform === context.requestedPlatform
        ? []
        : [{ code: "platform_mismatch", path: "platform" } as const]
      : parsed.error.issues.map(normalizeSchemaIssue);
    if (!parsed.success || issues.length > 0) {
      return Object.freeze({
        status: "invalid" as const,
        recordIndex,
        rawRecord,
        issues: Object.freeze(
          issues.map((issue) => prefixRecordIssue(issue, recordIndex)),
        ),
      });
    }
    return Object.freeze({
      status: "valid" as const,
      recordIndex,
      record: parsed.data,
    });
  });
}

export function safeValidateProviderStreamPageV2(input: {
  readonly rawPage: unknown;
  readonly normalizedPage: unknown;
  readonly context: ProviderStreamValidationContext;
}):
  | { readonly success: true; readonly data: ProviderStreamValidatedPageV2 }
  | { readonly success: false; readonly error: ProviderStreamValidationError } {
  const structure = providerStreamPageStructureV2Schema.safeParse(
    input.normalizedPage,
  );
  if (!structure.success) {
    return {
      success: false,
      error: new ProviderStreamValidationError(
        structure.error.issues.map(normalizeSchemaIssue),
      ),
    };
  }
  const structuralIssues = pageIssues(structure.data, input.context);
  if (structuralIssues.length > 0) {
    return {
      success: false,
      error: new ProviderStreamValidationError(structuralIssues),
    };
  }
  const recordOutcomes = validateRecords(structure.data, input.context);
  const validRecords = recordOutcomes.flatMap((outcome) =>
    outcome.status === "valid" ? [outcome.record] : [],
  );
  const invalidRecords = recordOutcomes.filter(
    (outcome): outcome is ProviderStreamInvalidRecordOutcomeV2 =>
      outcome.status === "invalid",
  );
  return {
    success: true,
    data: Object.freeze({
      rawPage: input.rawPage,
      page: Object.freeze({
        ...structure.data,
        records: Object.freeze(validRecords),
      }),
      recordOutcomes: Object.freeze(recordOutcomes),
      invalidRecords: Object.freeze(invalidRecords),
    }),
  };
}

export function parseProviderStreamRecordV2(
  input: unknown,
): ProviderStreamRecordV2 {
  return providerStreamRecordV2Schema.parse(input);
}

/** Returns an ordering value without fabricating a missing provider event time. */
export function providerStreamOrderingTimestampV2(
  record: ProviderStreamRecordV2,
): string {
  return record.occurred_at ?? record.collected_at;
}

export function providerRecordKindV2(
  record: ProviderStreamRecordV2,
): ProviderRecordKindV2 {
  return record.stream === "catalog"
    ? "catalog"
    : record.stream === "pulls"
      ? "pull"
      : "trade";
}
