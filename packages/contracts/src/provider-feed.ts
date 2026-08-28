import { z } from "zod";

const validationMarkers = {
  emptyString: "provider_feed.empty_string",
  finiteNumber: "provider_feed.finite_number",
  timestamp: "provider_feed.timestamp",
} as const;

const nonBlankStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: validationMarkers.emptyString,
});

const opaqueCursorSchema = z.string().min(1, {
  message: validationMarkers.emptyString,
});

const timestampSchema = z.iso.datetime({
  offset: true,
  message: validationMarkers.timestamp,
});

const finiteNumberSchema = z.custom<number>(
  (value) => typeof value === "number" && Number.isFinite(value),
  { message: validationMarkers.finiteNumber },
);

const opaqueDataSchema = z.record(z.string(), z.json());

export const catalogEnvelopeV1Schema = z.object({
  platform: nonBlankStringSchema,
  external_id: nonBlankStringSchema,
  updated_at: timestampSchema,
  collected_at: timestampSchema,
  data: opaqueDataSchema,
});

export const pullEnvelopeV1Schema = z.object({
  platform: nonBlankStringSchema,
  external_id: nonBlankStringSchema,
  pack_external_id: nonBlankStringSchema.nullable(),
  occurred_at: timestampSchema,
  collected_at: timestampSchema,
  data: opaqueDataSchema,
});

export const tradeEnvelopeV1Schema = z.object({
  platform: nonBlankStringSchema,
  external_id: nonBlankStringSchema,
  event_type: nonBlankStringSchema,
  tx_hash: nonBlankStringSchema,
  amount: finiteNumberSchema.nullable(),
  currency: nonBlankStringSchema.nullable(),
  occurred_at: timestampSchema,
  collected_at: timestampSchema,
  data: opaqueDataSchema,
});

export const providerFeedPageV1Schema = z.object({
  catalog: z.array(catalogEnvelopeV1Schema),
  pulls: z.array(pullEnvelopeV1Schema),
  trades: z.array(tradeEnvelopeV1Schema),
  next_cursor: opaqueCursorSchema,
  has_more: z.boolean(),
});

export const providerFeedPageStructureV1Schema = z
  .object({
    catalog: z.array(z.unknown()),
    pulls: z.array(z.unknown()),
    trades: z.array(z.unknown()),
    next_cursor: opaqueCursorSchema,
    has_more: z.boolean(),
  })
  .passthrough();

export type CatalogEnvelopeV1 = z.infer<typeof catalogEnvelopeV1Schema>;
export type PullEnvelopeV1 = z.infer<typeof pullEnvelopeV1Schema>;
export type TradeEnvelopeV1 = z.infer<typeof tradeEnvelopeV1Schema>;
export type ProviderFeedPageV1 = z.infer<typeof providerFeedPageV1Schema>;
export type ProviderFeedPageStructureV1 = z.infer<
  typeof providerFeedPageStructureV1Schema
>;
export type ProviderFeedEnvelopeV1 =
  | CatalogEnvelopeV1
  | PullEnvelopeV1
  | TradeEnvelopeV1;
export type ProviderFeedRecordKind = "catalog" | "pull" | "trade";

export type ProviderFeedValidationIssueCode =
  | "cursor_cycle"
  | "cursor_not_advanced"
  | "empty_continuing_page"
  | "empty_string"
  | "invalid_number"
  | "invalid_timestamp"
  | "invalid_type"
  | "platform_mismatch"
  | "unrecognized_value";

export interface ProviderFeedValidationIssue {
  readonly code: ProviderFeedValidationIssueCode;
  readonly path: string;
}

export interface ProviderFeedValidationContext {
  readonly requestedPlatform: string;
  readonly requestedCursor?: string | null;
  readonly seenCursors?: ReadonlySet<string>;
}

export interface ProviderFeedValidRecordOutcomeV1 {
  readonly status: "valid";
  readonly recordKind: ProviderFeedRecordKind;
  readonly recordIndex: number;
  readonly envelope: ProviderFeedEnvelopeV1;
}

export interface ProviderFeedInvalidRecordOutcomeV1 {
  readonly status: "invalid";
  readonly recordKind: ProviderFeedRecordKind;
  readonly recordIndex: number;
  readonly rawRecord: unknown;
  readonly issues: readonly ProviderFeedValidationIssue[];
}

export type ProviderFeedRecordValidationOutcomeV1 =
  | ProviderFeedValidRecordOutcomeV1
  | ProviderFeedInvalidRecordOutcomeV1;

export interface ProviderFeedValidatedPageV1 {
  /** Server-only source evidence. Browser-facing callers must not expose it. */
  readonly rawPage: ProviderFeedPageStructureV1;
  readonly validPage: ProviderFeedPageV1;
  readonly recordOutcomes: readonly ProviderFeedRecordValidationOutcomeV1[];
  readonly invalidRecords: readonly ProviderFeedInvalidRecordOutcomeV1[];
}

export class ProviderFeedValidationError extends Error {
  readonly code = "PROVIDER_FEED_VALIDATION_FAILED";
  readonly issues: readonly ProviderFeedValidationIssue[];

  constructor(issues: readonly ProviderFeedValidationIssue[]) {
    super("Provider feed validation failed.");
    this.name = "ProviderFeedValidationError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
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

function normalizeSchemaIssue(issue: z.core.$ZodIssue): ProviderFeedValidationIssue {
  let code: ProviderFeedValidationIssueCode = "unrecognized_value";
  if (issue.message === validationMarkers.emptyString) code = "empty_string";
  else if (issue.message === validationMarkers.finiteNumber) code = "invalid_number";
  else if (issue.message === validationMarkers.timestamp) code = "invalid_timestamp";
  else if (issue.code === "invalid_type") code = "invalid_type";
  return Object.freeze({ code, path: formatFieldPath(issue.path) });
}

function prefixRecordIssue(
  issue: ProviderFeedValidationIssue,
  recordKind: ProviderFeedRecordKind,
  recordIndex: number,
): ProviderFeedValidationIssue {
  const groupName =
    recordKind === "catalog"
      ? "catalog"
      : recordKind === "pull"
        ? "pulls"
        : "trades";
  const recordPath = `${groupName}[${recordIndex}]`;
  return Object.freeze({
    code: issue.code,
    path: issue.path === "$" ? recordPath : `${recordPath}.${issue.path}`,
  });
}

function paginationIssues(
  page: ProviderFeedPageStructureV1,
  context: ProviderFeedValidationContext,
): ProviderFeedValidationIssue[] {
  if (!page.has_more) return [];
  const issues: ProviderFeedValidationIssue[] = [];
  const recordCount = page.catalog.length + page.pulls.length + page.trades.length;
  if (recordCount === 0) {
    issues.push({ code: "empty_continuing_page", path: "has_more" });
  }
  if (context.requestedCursor === page.next_cursor) {
    issues.push({ code: "cursor_not_advanced", path: "next_cursor" });
  } else if (context.seenCursors?.has(page.next_cursor)) {
    issues.push({ code: "cursor_cycle", path: "next_cursor" });
  }
  return issues;
}

type SchemaForEnvelope<TEnvelope extends ProviderFeedEnvelopeV1> = z.ZodType<
  TEnvelope,
  unknown,
  z.core.$ZodTypeInternals<TEnvelope, unknown>
>;

function validateRecordGroup<TEnvelope extends ProviderFeedEnvelopeV1>(
  recordKind: ProviderFeedRecordKind,
  records: readonly unknown[],
  schema: SchemaForEnvelope<TEnvelope>,
  requestedPlatform: string,
): {
  readonly validRecords: TEnvelope[];
  readonly outcomes: ProviderFeedRecordValidationOutcomeV1[];
} {
  const validRecords: TEnvelope[] = [];
  const outcomes: ProviderFeedRecordValidationOutcomeV1[] = [];
  records.forEach((rawRecord, recordIndex) => {
    const parsed = schema.safeParse(rawRecord);
    const issues = parsed.success
      ? parsed.data.platform === requestedPlatform
        ? []
        : [{ code: "platform_mismatch", path: "platform" } as const]
      : parsed.error.issues.map(normalizeSchemaIssue);
    if (!parsed.success || issues.length > 0) {
      outcomes.push({
        status: "invalid",
        recordKind,
        recordIndex,
        rawRecord,
        issues: Object.freeze(
          issues.map((issue) => prefixRecordIssue(issue, recordKind, recordIndex)),
        ),
      });
      return;
    }
    validRecords.push(parsed.data);
    outcomes.push({
      status: "valid",
      recordKind,
      recordIndex,
      envelope: parsed.data,
    });
  });
  return { validRecords, outcomes };
}

export function safeParseProviderFeedPageStructureV1(
  input: unknown,
  context: ProviderFeedValidationContext,
):
  | { readonly success: true; readonly data: ProviderFeedPageStructureV1 }
  | { readonly success: false; readonly error: ProviderFeedValidationError } {
  const parsed = providerFeedPageStructureV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: new ProviderFeedValidationError(
        parsed.error.issues.map(normalizeSchemaIssue),
      ),
    };
  }
  const issues: ProviderFeedValidationIssue[] = [];
  if (context.requestedPlatform.trim().length === 0) {
    issues.push({ code: "empty_string", path: "requested_platform" });
  }
  if (context.requestedCursor === "") {
    issues.push({ code: "empty_string", path: "requested_cursor" });
  }
  issues.push(...paginationIssues(parsed.data, context));
  return issues.length > 0
    ? { success: false, error: new ProviderFeedValidationError(issues) }
    : { success: true, data: parsed.data };
}

export function validateProviderFeedRecordsV1(
  rawPage: ProviderFeedPageStructureV1,
  context: ProviderFeedValidationContext,
): ProviderFeedValidatedPageV1 {
  const catalog = validateRecordGroup(
    "catalog",
    rawPage.catalog,
    catalogEnvelopeV1Schema,
    context.requestedPlatform,
  );
  const pulls = validateRecordGroup(
    "pull",
    rawPage.pulls,
    pullEnvelopeV1Schema,
    context.requestedPlatform,
  );
  const trades = validateRecordGroup(
    "trade",
    rawPage.trades,
    tradeEnvelopeV1Schema,
    context.requestedPlatform,
  );
  const recordOutcomes = [
    ...catalog.outcomes,
    ...pulls.outcomes,
    ...trades.outcomes,
  ];
  const invalidRecords = recordOutcomes.filter(
    (outcome): outcome is ProviderFeedInvalidRecordOutcomeV1 =>
      outcome.status === "invalid",
  );
  return {
    rawPage,
    validPage: {
      catalog: catalog.validRecords,
      pulls: pulls.validRecords,
      trades: trades.validRecords,
      next_cursor: rawPage.next_cursor,
      has_more: rawPage.has_more,
    },
    recordOutcomes: Object.freeze(recordOutcomes),
    invalidRecords: Object.freeze(invalidRecords),
  };
}

export function safeValidateProviderFeedPageV1(
  input: unknown,
  context: ProviderFeedValidationContext,
):
  | { readonly success: true; readonly data: ProviderFeedValidatedPageV1 }
  | { readonly success: false; readonly error: ProviderFeedValidationError } {
  const structure = safeParseProviderFeedPageStructureV1(input, context);
  return structure.success
    ? {
        success: true,
        data: validateProviderFeedRecordsV1(structure.data, context),
      }
    : structure;
}

export function safeParseProviderFeedPageV1(
  input: unknown,
  context: ProviderFeedValidationContext,
):
  | { readonly success: true; readonly data: ProviderFeedPageV1 }
  | { readonly success: false; readonly error: ProviderFeedValidationError } {
  const validated = safeValidateProviderFeedPageV1(input, context);
  if (!validated.success) return validated;
  if (validated.data.invalidRecords.length > 0) {
    return {
      success: false,
      error: new ProviderFeedValidationError(
        validated.data.invalidRecords.flatMap((record) => record.issues),
      ),
    };
  }
  return { success: true, data: validated.data.validPage };
}

export function parseProviderFeedPageV1(
  input: unknown,
  context: ProviderFeedValidationContext,
): ProviderFeedPageV1 {
  const result = safeParseProviderFeedPageV1(input, context);
  if (!result.success) throw result.error;
  return result.data;
}
