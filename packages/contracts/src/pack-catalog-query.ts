import { z } from "zod";
import {
  PACK_CATALOG_CURSOR_LIFETIME_MS,
  PACK_CATALOG_LIST_MAX_ITEMS,
  PACK_CATALOG_V1,
  PACK_CONTENT_PAGE_MAX_ITEMS,
  SAVED_CATALOG_ITEM_LIMIT,
  compareCanonicalStrings,
  derivePublicPackSnapshotId,
  isCanonicalAscending,
  normalizePackCatalogSearchText,
  packCatalogCanonicalJson,
  packCatalogSha256Schema,
  packCatalogTextSchema,
  packCatalogTimestampSchema,
  packCatalogUuidSchema,
} from "./pack-catalog-v1.ts";
import {
  publicCollectibleProfileSchema,
  packCatalogPublicPackAvailabilitySchema,
  publicPackActionSchema,
  publicPackContentSchema,
  publicPackRetirementSchema,
  publicPackSnapshotIdSchema,
  publicPackSnapshotIdentitySchema,
  publicPackSummaryCoreSchema,
  publicPackSearchProjectionSchema,
  publicProfileSnapshotIdSchema,
} from "./pack-catalog-domain.ts";

export const packCatalogQueryNames = [
  "getPublicShellStatus",
  "getDashboardBundle",
  "listPublicPacks",
  "getPublicPack",
  "searchPublicCollectibles",
  "findPacksByDesiredCollectible",
] as const;
export const packCatalogQueryNameSchema = z.enum(packCatalogQueryNames);

const searchSchema = z.string().max(1_024).transform(normalizePackCatalogSearchText)
  .refine((value) => value.length <= 120, "pack_catalog.query_too_long");
const requiredSearchSchema = searchSchema.refine((value) => value.length > 0, "pack_catalog.query_required");
const canonicalUuidSelection = z.array(packCatalogUuidSchema).max(100)
  .transform((values) => [...new Set(values)].sort(compareCanonicalStrings));
export const packCatalogLifecycleFilterSchema = z.object({
  retirements: z.array(publicPackRetirementSchema).min(1).max(2)
    .transform((values) => [...new Set(values)].sort(compareCanonicalStrings))
    .default(["active"]),
  availabilities: z.array(packCatalogPublicPackAvailabilitySchema).min(1).max(4)
    .transform((values) => [...new Set(values)].sort(compareCanonicalStrings))
    .default(["available"]),
}).strict();

const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u).max(4_096);
const listPageSizeSchema = z.number().int().safe().min(1).max(PACK_CATALOG_LIST_MAX_ITEMS).default(25);
const listBase = {
  lifecycle: packCatalogLifecycleFilterSchema.default({
    retirements: ["active"],
    availabilities: ["available"],
  }),
  cursor: cursorSchema.nullable().default(null),
  pageSize: listPageSizeSchema,
};

export const packCatalogGetPublicShellStatusInputSchema = z.object({}).strict();
export const packCatalogGetDashboardBundleInputSchema = z.object({
  lifecycle: listBase.lifecycle,
}).strict();
export const packCatalogListPublicPacksInputSchema = z.object({
  query: searchSchema.default(""),
  providerIds: canonicalUuidSelection.default([]),
  categoryIds: canonicalUuidSelection.default([]),
  sort: z.enum(["title", "price", "ev", "top_chase"]).default("ev"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  ...listBase,
}).strict();
export const packCatalogGetPublicPackInputSchema = z.object({
  publicRepackId: packCatalogUuidSchema,
  contentsCursor: cursorSchema.nullable().default(null),
  contentPageSize: z.number().int().safe().min(1).max(PACK_CONTENT_PAGE_MAX_ITEMS).default(50),
}).strict();
export const packCatalogSearchPublicCollectiblesInputSchema = z.object({
  query: requiredSearchSchema,
  categoryIds: canonicalUuidSelection.default([]),
  ...listBase,
}).strict();
export const packCatalogFindPacksByDesiredCollectibleInputSchema = z.object({
  publicCollectibleId: packCatalogUuidSchema,
  sort: z.enum(["title", "price", "ev", "top_chase"]).default("ev"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  ...listBase,
}).strict();

export const publicPackSummarySchema = publicPackSummaryCoreSchema.extend({
  publicPackSnapshotId: publicPackSnapshotIdSchema,
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  headGeneration: z.number().int().safe().positive(),
}).strict().refine(
  ({ publicPackSnapshotId, contentSha256 }) =>
    publicPackSnapshotId === derivePublicPackSnapshotId(contentSha256),
  "Pack summary must bind one snapshot hash.",
);
const nullableCursor = cursorSchema.nullable();
export const packCatalogPublicShellStatusResultSchema = z.object({
  schemaVersion: z.literal(PACK_CATALOG_V1),
  evaluatedAt: packCatalogTimestampSchema,
  catalogAvailable: z.boolean(),
  activeAvailablePackCount: z.number().int().safe().nonnegative(),
}).strict();
export const packCatalogDashboardBundleResultSchema = z.object({
  evaluatedAt: packCatalogTimestampSchema,
  packs: z.array(publicPackSummarySchema).max(PACK_CATALOG_LIST_MAX_ITEMS),
  totalMatchingPacks: z.number().int().safe().nonnegative(),
}).strict();
export const packCatalogListPublicPacksResultSchema = z.object({
  evaluatedAt: packCatalogTimestampSchema,
  items: z.array(publicPackSummarySchema).max(PACK_CATALOG_LIST_MAX_ITEMS),
  nextCursor: nullableCursor,
}).strict();
export const packCatalogGetPublicPackResultSchema = z.object({
  evaluatedAt: packCatalogTimestampSchema,
  snapshot: publicPackSnapshotIdentitySchema,
  summary: publicPackSummaryCoreSchema,
  detail: z.object({
    providerProfileSnapshotId: publicProfileSnapshotIdSchema,
    dataAsOf: packCatalogTimestampSchema,
    actions: z.array(publicPackActionSchema).max(50),
    probabilityInputsSha256: packCatalogSha256Schema,
    valuationDependencyIdentities: z.array(packCatalogSha256Schema).max(8_000)
      .refine(isCanonicalAscending, "Valuation dependencies must be unique and sorted."),
    valuationsSha256: packCatalogSha256Schema,
    evMethodIdentity: packCatalogTextSchema(120),
    evPolicyIdentity: packCatalogTextSchema(120),
    evInputsSha256: packCatalogSha256Schema,
    economicsSha256: packCatalogSha256Schema,
    searchProjection: publicPackSearchProjectionSchema,
  }).strict(),
  contents: z.array(publicPackContentSchema).max(PACK_CONTENT_PAGE_MAX_ITEMS),
  contentCount: z.number().int().safe().min(1),
  nextContentsCursor: nullableCursor,
}).strict().refine(
  ({ snapshot, summary }) => snapshot.publicRepackId === summary.publicRepackId,
  "Pack detail must resolve through one snapshot.",
);
export const packCatalogSearchPublicCollectiblesResultSchema = z.object({
  evaluatedAt: packCatalogTimestampSchema,
  items: z.array(publicCollectibleProfileSchema).max(PACK_CATALOG_LIST_MAX_ITEMS),
  nextCursor: nullableCursor,
}).strict();
export const packCatalogFindPacksByDesiredCollectibleResultSchema = z.object({
  evaluatedAt: packCatalogTimestampSchema,
  publicCollectibleId: packCatalogUuidSchema,
  items: z.array(publicPackSummarySchema).max(PACK_CATALOG_LIST_MAX_ITEMS),
  nextCursor: nullableCursor,
}).strict();

export const packCatalogReadErrorCodes = [
  "INVALID_QUERY",
  "CURSOR_EXPIRED",
  "CATALOG_UNAVAILABLE",
  "PACK_NOT_FOUND",
  "COLLECTIBLE_NOT_FOUND",
  "AUTH_REQUIRED",
  "UNAUTHORIZED",
] as const;
export const packCatalogReadErrorSchema = z.object({
  ok: z.literal(false),
  code: z.enum(packCatalogReadErrorCodes),
  error: packCatalogTextSchema(160),
  retryable: z.boolean(),
}).strict();
const result = <T extends z.ZodType>(schema: T) => z.union([
  z.object({ ok: z.literal(true), data: schema }).strict(),
  packCatalogReadErrorSchema,
]);
export const packCatalogV1QueryContracts = Object.freeze({
  getPublicShellStatus: { input: packCatalogGetPublicShellStatusInputSchema, output: result(packCatalogPublicShellStatusResultSchema) },
  getDashboardBundle: { input: packCatalogGetDashboardBundleInputSchema, output: result(packCatalogDashboardBundleResultSchema) },
  listPublicPacks: { input: packCatalogListPublicPacksInputSchema, output: result(packCatalogListPublicPacksResultSchema) },
  getPublicPack: { input: packCatalogGetPublicPackInputSchema, output: result(packCatalogGetPublicPackResultSchema) },
  searchPublicCollectibles: { input: packCatalogSearchPublicCollectiblesInputSchema, output: result(packCatalogSearchPublicCollectiblesResultSchema) },
  findPacksByDesiredCollectible: { input: packCatalogFindPacksByDesiredCollectibleInputSchema, output: result(packCatalogFindPacksByDesiredCollectibleResultSchema) },
});

const cursorFilterValueSchema = z.union([
  z.string().max(1_024),
  z.boolean(),
  z.number().int().safe(),
  z.array(z.string().max(200)).max(100)
    .refine(isCanonicalAscending, "Cursor filter arrays must be unique and sorted."),
]);
export const packCatalogCursorBindingSchema = z.object({
  operation: z.enum(["listPublicPacks", "getPublicPack", "searchPublicCollectibles", "findPacksByDesiredCollectible"]),
  filters: z.record(z.string().max(64), cursorFilterValueSchema),
  sort: z.string().min(1).max(50),
  direction: z.enum(["asc", "desc"]),
  pageSize: z.number().int().safe().min(1).max(PACK_CONTENT_PAGE_MAX_ITEMS),
  publicPackSnapshotId: publicPackSnapshotIdSchema.nullable(),
}).strict();
export const packCatalogCursorPayloadSchema = packCatalogCursorBindingSchema.extend({
  schemaVersion: z.literal(PACK_CATALOG_V1),
  lastSortKey: z.string().min(1).max(500),
  lastStableId: packCatalogUuidSchema,
  issuedAt: packCatalogTimestampSchema,
  expiresAt: packCatalogTimestampSchema,
}).strict().superRefine((value, context) => {
  const duration = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
  if (duration !== PACK_CATALOG_CURSOR_LIFETIME_MS) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "pack_catalog.cursor_lifetime_invalid" });
  }
  if ((value.operation === "getPublicPack") !== (value.publicPackSnapshotId !== null)) {
    context.addIssue({ code: "custom", path: ["publicPackSnapshotId"], message: "pack_catalog.cursor_snapshot_binding_invalid" });
  }
});

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}
function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function cryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
async function hmac(keyBytes: Uint8Array, bytes: Uint8Array) {
  if (keyBytes.byteLength < 32) throw new TypeError("Cursor signing keys must be at least 32 bytes.");
  const key = await crypto.subtle.importKey("raw", cryptoBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, cryptoBuffer(bytes)));
}
async function verifyHmac(keyBytes: Uint8Array, bytes: Uint8Array, signature: Uint8Array) {
  if (keyBytes.byteLength < 32) throw new TypeError("Cursor signing keys must be at least 32 bytes.");
  const key = await crypto.subtle.importKey("raw", cryptoBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, cryptoBuffer(signature), cryptoBuffer(bytes));
}

export class PackCatalogCursorError extends Error {
  readonly code = "CURSOR_EXPIRED" as const;
  constructor() {
    super("Pack catalog cursor is invalid or expired.");
    this.name = "PackCatalogCursorError";
  }
}

export async function issuePackCatalogCursor(input: {
  readonly binding: PackCatalogCursorBinding;
  readonly lastSortKey: string;
  readonly lastStableId: string;
  readonly issuedAt: string;
  readonly signingKey: Uint8Array;
}): Promise<string> {
  const issuedAt = packCatalogTimestampSchema.parse(input.issuedAt);
  const payload = packCatalogCursorPayloadSchema.parse({
    ...packCatalogCursorBindingSchema.parse(input.binding),
    schemaVersion: PACK_CATALOG_V1,
    lastSortKey: input.lastSortKey,
    lastStableId: input.lastStableId,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + PACK_CATALOG_CURSOR_LIFETIME_MS).toISOString(),
  });
  const bytes = new TextEncoder().encode(packCatalogCanonicalJson(payload));
  return cursorSchema.parse(`${base64UrlEncode(bytes)}.${base64UrlEncode(await hmac(input.signingKey, bytes))}`);
}

export async function readPackCatalogCursor(input: {
  readonly cursor: string;
  readonly binding: PackCatalogCursorBinding;
  readonly now: string;
  readonly signingKey: Uint8Array;
}): Promise<PackCatalogCursorPayload> {
  try {
    const [body, signature, extra] = cursorSchema.parse(input.cursor).split(".");
    if (!body || !signature || extra !== undefined) throw new PackCatalogCursorError();
    const bytes = base64UrlDecode(body);
    const received = base64UrlDecode(signature);
    if (!await verifyHmac(input.signingKey, bytes, received)) {
      throw new PackCatalogCursorError();
    }
    const payload = packCatalogCursorPayloadSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (base64UrlEncode(new TextEncoder().encode(packCatalogCanonicalJson(payload))) !== body) {
      throw new PackCatalogCursorError();
    }
    const actualBinding = packCatalogCursorBindingSchema.parse({
      operation: payload.operation,
      filters: payload.filters,
      sort: payload.sort,
      direction: payload.direction,
      pageSize: payload.pageSize,
      publicPackSnapshotId: payload.publicPackSnapshotId,
    });
    if (packCatalogCanonicalJson(actualBinding) !== packCatalogCanonicalJson(packCatalogCursorBindingSchema.parse(input.binding))) {
      throw new PackCatalogCursorError();
    }
    const now = Date.parse(packCatalogTimestampSchema.parse(input.now));
    if (now < Date.parse(payload.issuedAt) || now >= Date.parse(payload.expiresAt)) {
      throw new PackCatalogCursorError();
    }
    return payload;
  } catch (error) {
    if (error instanceof PackCatalogCursorError) throw error;
    throw new PackCatalogCursorError();
  }
}

export const savedCatalogErrorCodes = [
  "AUTH_REQUIRED",
  "AUTH_IDENTITY_INVALID",
  "INVALID_PUBLIC_REPACK_ID",
  "INVALID_PUBLIC_COLLECTIBLE_ID",
  "SAVED_RESOURCE_UNAVAILABLE",
  "SAVED_ITEM_LIMIT_REACHED",
  "SAVED_ITEMS_STATE_CONFLICT",
] as const;
export const savedCatalogErrorSchema = z.object({
  code: z.enum(savedCatalogErrorCodes),
  error: packCatalogTextSchema(160),
}).strict();
export const savedCatalogItemIdsSchema = z.object({
  savedRepackIds: z.array(packCatalogUuidSchema).max(SAVED_CATALOG_ITEM_LIMIT)
    .refine(isCanonicalAscending, "Saved repack IDs must be unique and sorted."),
  savedCollectibleIds: z.array(packCatalogUuidSchema).max(SAVED_CATALOG_ITEM_LIMIT)
    .refine(isCanonicalAscending, "Saved collectible IDs must be unique and sorted."),
}).strict();
const savedSetResultSchema = z.object({ saved: z.boolean(), prunedUnavailable: z.boolean() }).strict();
const savedResult = <T extends z.ZodType>(schema: T) => z.union([schema, savedCatalogErrorSchema]);
export const savedCatalogItemsV1Contract = Object.freeze({
  getSavedItemIds: {
    input: z.object({}).strict(),
    output: savedResult(savedCatalogItemIdsSchema),
  },
  setSavedRepack: {
    input: z.object({ publicRepackId: packCatalogUuidSchema, saved: z.boolean() }).strict(),
    output: savedResult(savedSetResultSchema),
  },
  setSavedCollectible: {
    input: z.object({ publicCollectibleId: packCatalogUuidSchema, saved: z.boolean() }).strict(),
    output: savedResult(savedSetResultSchema),
  },
});

export type PackCatalogCursorBinding = z.infer<typeof packCatalogCursorBindingSchema>;
export type PackCatalogCursorPayload = z.infer<typeof packCatalogCursorPayloadSchema>;
export type PackCatalogCursor = z.infer<typeof cursorSchema>;
export type SavedCatalogItemsV1 = typeof savedCatalogItemsV1Contract;
