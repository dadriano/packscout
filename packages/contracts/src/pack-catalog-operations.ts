import { z } from "zod";
import {
  PACK_CATALOG_V1,
  isCanonicalAscending,
  packCatalogSequenceSchema,
  packCatalogSha256Schema,
  packCatalogTextSchema,
  packCatalogTimestampSchema,
  packCatalogUuidSchema,
} from "./pack-catalog-v1.ts";
import {
  publicPackSnapshotIdSchema,
  publicProfileSnapshotIdSchema,
} from "./pack-catalog-domain.ts";
import {
  publicationOperationResultSchema,
  publicationReasonCodeSchema,
  publicationWorkStateSchema,
} from "./pack-publication.ts";

export const packCatalogAdminPermissions = [
  "pack_publication:recover",
  "pack_catalog:launch",
  "pack_catalog:prune",
] as const;
export const packCatalogStatusPermission = "providers:view" as const;
export const packCatalogEnvironments = ["local", "preproduction", "live"] as const;
export const packCatalogServiceOperations = [
  "stage_snapshot",
  "finalize_snapshot",
  "activate_head",
  "read_receipt",
  "recover_pack",
  "launch_catalog",
  "prune_snapshots",
] as const;

export const packCatalogOperationScopeSchema = z.discriminatedUnion("scopeKind", [
  z.object({ scopeKind: z.literal("provider"), providerId: packCatalogUuidSchema }).strict(),
  z.object({ scopeKind: z.literal("catalog"), catalog: z.literal(PACK_CATALOG_V1) }).strict(),
]);
export const packCatalogOperationEntitySchema = z.discriminatedUnion("entityKind", [
  z.object({ entityKind: z.literal("pack"), publicRepackId: packCatalogUuidSchema }).strict(),
  z.object({ entityKind: z.literal("provider_profile"), providerId: packCatalogUuidSchema }).strict(),
  z.object({ entityKind: z.literal("collectible_profile"), publicCollectibleId: packCatalogUuidSchema }).strict(),
  z.object({ entityKind: z.literal("catalog"), catalog: z.literal(PACK_CATALOG_V1) }).strict(),
]);

export const trustedPackCatalogServiceIdentitySchema = z.object({
  serviceIdentityId: packCatalogUuidSchema,
  environment: z.enum(packCatalogEnvironments),
  organizationId: packCatalogUuidSchema,
  scope: packCatalogOperationScopeSchema,
  entity: packCatalogOperationEntitySchema,
  operations: z.array(z.enum(packCatalogServiceOperations)).min(1).max(packCatalogServiceOperations.length)
    .refine(isCanonicalAscending, "Service operations must be unique and sorted."),
  issuedAt: packCatalogTimestampSchema,
  expiresAt: packCatalogTimestampSchema,
  authorizationSha256: packCatalogSha256Schema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "service_identity.expiry_invalid" });
  }
  const providerEntity = value.entity.entityKind === "pack" || value.entity.entityKind === "provider_profile";
  if ((value.scope.scopeKind === "provider") !== providerEntity) {
    context.addIssue({ code: "custom", path: ["entity"], message: "service_identity.scope_mismatch" });
  }
  if (value.scope.scopeKind === "provider" && value.entity.entityKind === "provider_profile" &&
    value.scope.providerId !== value.entity.providerId) {
    context.addIssue({ code: "custom", path: ["entity"], message: "service_identity.provider_mismatch" });
  }
});

export function trustedPackCatalogServiceIdentityAllows(input: {
  readonly identity: unknown;
  readonly environment: PackCatalogEnvironment;
  readonly organizationId: string;
  readonly providerId?: string;
  readonly entity: PackCatalogOperationEntity;
  readonly operation: PackCatalogServiceOperation;
  readonly now: string;
}): boolean {
  const parsed = trustedPackCatalogServiceIdentitySchema.safeParse(input.identity);
  if (!parsed.success) return false;
  const identity = parsed.data;
  const organizationId = packCatalogUuidSchema.safeParse(input.organizationId);
  if (!organizationId.success) return false;
  const now = packCatalogTimestampSchema.safeParse(input.now);
  const entity = packCatalogOperationEntitySchema.safeParse(input.entity);
  if (!now.success || !entity.success) return false;
  if (identity.environment !== input.environment ||
    identity.organizationId !== organizationId.data ||
    !identity.operations.includes(input.operation) ||
    Date.parse(now.data) < Date.parse(identity.issuedAt) ||
    Date.parse(now.data) >= Date.parse(identity.expiresAt)) return false;
  if (identity.scope.scopeKind === "provider" && identity.scope.providerId !== input.providerId) return false;
  return JSON.stringify(identity.entity) === JSON.stringify(entity.data);
}

export const publicationStatusViewerSchema = z.object({
  operatorId: packCatalogUuidSchema,
  organizationId: packCatalogUuidSchema,
  state: z.literal("active"),
  role: z.enum(["admin", "data_operator"]),
  permission: z.literal(packCatalogStatusPermission),
}).strict();
export const sanitizedPackPublicationStatusSchema = z.object({
  providerId: packCatalogUuidSchema,
  publicRepackId: packCatalogUuidSchema,
  packPublicationSequence: packCatalogSequenceSchema,
  state: publicationWorkStateSchema,
  reasonCode: publicationReasonCodeSchema.nullable(),
  held: z.boolean(),
  attemptCount: z.number().int().safe().nonnegative(),
  oldestPendingAt: packCatalogTimestampSchema.nullable(),
  activeSnapshotId: publicPackSnapshotIdSchema.nullable(),
}).strict();
export const packPublicationStatusResponseSchema = z.object({
  organizationId: packCatalogUuidSchema,
  statuses: z.array(sanitizedPackPublicationStatusSchema).max(10_000),
  evaluatedAt: packCatalogTimestampSchema,
}).strict();

export function canReadPackPublicationStatus(
  viewer: unknown,
  response: unknown,
): boolean {
  const parsedViewer = publicationStatusViewerSchema.safeParse(viewer);
  const parsedResponse = packPublicationStatusResponseSchema.safeParse(response);
  return parsedViewer.success && parsedResponse.success &&
    parsedViewer.data.organizationId === parsedResponse.data.organizationId;
}

const operatorAuthorizationSchema = z.object({
  operatorId: packCatalogUuidSchema,
  organizationId: packCatalogUuidSchema,
  state: z.literal("active"),
  role: z.literal("admin"),
  permission: z.enum(packCatalogAdminPermissions),
  authorizedAt: packCatalogTimestampSchema,
}).strict();
const outOfBandOperationFields = {
  operationId: packCatalogUuidSchema,
  channel: z.literal("out_of_band"),
  idempotencyKey: packCatalogTextSchema(200),
  requestSha256: packCatalogSha256Schema,
  expiresAt: packCatalogTimestampSchema,
};
export const packRecoveryOperationSchema = z.object({
  ...outOfBandOperationFields,
  authorization: operatorAuthorizationSchema.extend({ permission: z.literal("pack_publication:recover") }).strict(),
  providerId: packCatalogUuidSchema,
  publicRepackId: packCatalogUuidSchema,
  action: z.enum(["retry", "rollback", "resume"]),
  targetSnapshotId: publicPackSnapshotIdSchema.nullable(),
}).strict();
export const packCatalogLaunchOperationSchema = z.object({
  ...outOfBandOperationFields,
  authorization: operatorAuthorizationSchema.extend({ permission: z.literal("pack_catalog:launch") }).strict(),
  certifiedCommitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  certifiedPlanSha256: packCatalogSha256Schema,
}).strict();
export const packCatalogPruneOperationSchema = z.object({
  ...outOfBandOperationFields,
  authorization: operatorAuthorizationSchema.extend({ permission: z.literal("pack_catalog:prune") }).strict(),
  dryRunSha256: packCatalogSha256Schema,
  snapshotIds: z.array(z.union([publicPackSnapshotIdSchema, publicProfileSnapshotIdSchema])).max(10_000)
    .refine(isCanonicalAscending, "Prune snapshot IDs must be unique and sorted."),
}).strict();
export const packCatalogOperationReceiptSchema = z.object({
  operationId: packCatalogUuidSchema,
  requestSha256: packCatalogSha256Schema,
  result: publicationOperationResultSchema,
  completedAt: packCatalogTimestampSchema,
}).strict();

export type PackCatalogEnvironment = (typeof packCatalogEnvironments)[number];
export type PackCatalogServiceOperation = (typeof packCatalogServiceOperations)[number];
export type PackCatalogOperationEntity = z.infer<typeof packCatalogOperationEntitySchema>;
export type TrustedPackCatalogServiceIdentity = z.infer<typeof trustedPackCatalogServiceIdentitySchema>;
