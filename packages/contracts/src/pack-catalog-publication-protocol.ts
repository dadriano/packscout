import { z } from "zod";
import {
  PACK_CATALOG_V1,
  hashPackCatalogValue,
  packCatalogSequenceSchema,
  packCatalogSha256Schema,
  packCatalogTextSchema,
  packCatalogTimestampSchema,
  packCatalogUuidSchema,
} from "./pack-catalog-v1.ts";
import {
  publicPackSnapshotBatchSchema,
  publicPackSnapshotDescriptorSchema,
  publicPackSnapshotHeaderSchema,
  publicPackSnapshotIdSchema,
  publicPackSnapshotIdentitySchema,
  publicProfileSnapshotBatchSchema,
  publicProfileSnapshotDescriptorSchema,
  publicProfileSnapshotIdSchema,
  publicProfileSnapshotIdentitySchema,
  type PublicPackSnapshotPayload,
} from "./pack-catalog-domain.ts";
import {
  packActivationIntentSchema,
  packSnapshotEvidenceSchema,
  profileActivationIntentSchema,
  publicationOperationResultSchema,
  publicationReasonCodeSchema,
} from "./pack-publication.ts";
import {
  packCatalogEnvironments,
  packCatalogOperationEntitySchema,
  packCatalogOperationScopeSchema,
  trustedPackCatalogServiceIdentitySchema,
  type PackCatalogOperationEntity,
  type PackCatalogServiceOperation,
} from "./pack-catalog-operations.ts";

/**
 * Wire protocol between the pack publisher (P06) and the authenticated
 * `pack_catalog_v1` public store (P05). Every operation is one signed HTTP
 * request carrying one envelope, and every answer is one bounded receipt.
 * Nothing here is browser behavior; it lives in contracts so the Convex store
 * and the services client validate the exact same bytes.
 */

export const PRODUCTION_PACK_CATALOG_V1_PATHS = Object.freeze({
  packStart: "/internal/pack-catalog-v1/pack/start",
  packBatch: "/internal/pack-catalog-v1/pack/batch",
  packFinalize: "/internal/pack-catalog-v1/pack/finalize",
  packActivate: "/internal/pack-catalog-v1/pack/activate",
  packStatus: "/internal/pack-catalog-v1/pack/status",
  packBlock: "/internal/pack-catalog-v1/pack/block",
  packHold: "/internal/pack-catalog-v1/pack/hold",
  packActivateRetained: "/internal/pack-catalog-v1/pack/activate-retained",
  packResume: "/internal/pack-catalog-v1/pack/resume",
  profileStart: "/internal/pack-catalog-v1/profile/start",
  profileBatch: "/internal/pack-catalog-v1/profile/batch",
  profileFinalize: "/internal/pack-catalog-v1/profile/finalize",
  profileActivate: "/internal/pack-catalog-v1/profile/activate",
  profileStatus: "/internal/pack-catalog-v1/profile/status",
  profileBlock: "/internal/pack-catalog-v1/profile/block",
} as const);

/** Matches the shared signed-HTTP client ceiling; a maximum P01 batch fits. */
export const MAX_PACK_CATALOG_HTTP_BODY_BYTES = 512 * 1_024;
export const PACK_CATALOG_RECEIPT_HASH_DOMAIN = "packscout.pack-catalog-receipt.v1" as const;
export const PACK_CATALOG_KEY_AUTHORITY_HASH_DOMAIN = "packscout.pack-catalog-key-authority.v1" as const;

export const packCatalogPublicationOperationKinds = [
  "start_pack_snapshot",
  "apply_pack_snapshot_batch",
  "finalize_pack_snapshot",
  "activate_pack_snapshot",
  "pack_publication_status",
  "block_pack_snapshot",
  "hold_pack_head",
  "activate_retained_pack_snapshot",
  "resume_pack_head",
  "start_profile_snapshot",
  "apply_profile_snapshot_batch",
  "finalize_profile_snapshot",
  "activate_profile_snapshot",
  "profile_publication_status",
  "block_profile_snapshot",
] as const;
export type PackCatalogPublicationOperationKind = (typeof packCatalogPublicationOperationKinds)[number];

export const PACK_CATALOG_OPERATION_PATHS = Object.freeze({
  start_pack_snapshot: PRODUCTION_PACK_CATALOG_V1_PATHS.packStart,
  apply_pack_snapshot_batch: PRODUCTION_PACK_CATALOG_V1_PATHS.packBatch,
  finalize_pack_snapshot: PRODUCTION_PACK_CATALOG_V1_PATHS.packFinalize,
  activate_pack_snapshot: PRODUCTION_PACK_CATALOG_V1_PATHS.packActivate,
  pack_publication_status: PRODUCTION_PACK_CATALOG_V1_PATHS.packStatus,
  block_pack_snapshot: PRODUCTION_PACK_CATALOG_V1_PATHS.packBlock,
  hold_pack_head: PRODUCTION_PACK_CATALOG_V1_PATHS.packHold,
  activate_retained_pack_snapshot: PRODUCTION_PACK_CATALOG_V1_PATHS.packActivateRetained,
  resume_pack_head: PRODUCTION_PACK_CATALOG_V1_PATHS.packResume,
  start_profile_snapshot: PRODUCTION_PACK_CATALOG_V1_PATHS.profileStart,
  apply_profile_snapshot_batch: PRODUCTION_PACK_CATALOG_V1_PATHS.profileBatch,
  finalize_profile_snapshot: PRODUCTION_PACK_CATALOG_V1_PATHS.profileFinalize,
  activate_profile_snapshot: PRODUCTION_PACK_CATALOG_V1_PATHS.profileActivate,
  profile_publication_status: PRODUCTION_PACK_CATALOG_V1_PATHS.profileStatus,
  block_profile_snapshot: PRODUCTION_PACK_CATALOG_V1_PATHS.profileBlock,
} satisfies Readonly<Record<PackCatalogPublicationOperationKind, string>>);

/** The P01 service operation each wire operation must be authorized for. */
export const PACK_CATALOG_OPERATION_AUTHORITY = Object.freeze({
  start_pack_snapshot: "stage_snapshot",
  apply_pack_snapshot_batch: "stage_snapshot",
  finalize_pack_snapshot: "finalize_snapshot",
  activate_pack_snapshot: "activate_head",
  pack_publication_status: "read_receipt",
  block_pack_snapshot: "stage_snapshot",
  hold_pack_head: "recover_pack",
  activate_retained_pack_snapshot: "recover_pack",
  resume_pack_head: "recover_pack",
  start_profile_snapshot: "stage_snapshot",
  apply_profile_snapshot_batch: "stage_snapshot",
  finalize_profile_snapshot: "finalize_snapshot",
  activate_profile_snapshot: "activate_head",
  profile_publication_status: "read_receipt",
  block_profile_snapshot: "stage_snapshot",
} satisfies Readonly<Record<PackCatalogPublicationOperationKind, PackCatalogServiceOperation>>);

const headExpectationSchema = z.object({
  publicRepackId: packCatalogUuidSchema,
  expectedGeneration: z.number().int().safe().positive(),
  expectedPublicationEpoch: z.number().int().safe().nonnegative(),
}).strict();
const operationLookupSchema = z.object({
  operationId: packCatalogUuidSchema,
  requestSha256: packCatalogSha256Schema,
}).strict().nullable();
const profileReferenceSchema = z.discriminatedUnion("profileKind", [
  z.object({ profileKind: z.literal("provider"), providerId: packCatalogUuidSchema }).strict(),
  z.object({ profileKind: z.literal("collectible"), publicCollectibleId: packCatalogUuidSchema }).strict(),
]);

export const startPackSnapshotBodySchema = z.object({
  descriptor: publicPackSnapshotDescriptorSchema,
  header: publicPackSnapshotHeaderSchema,
  packPublicationSequence: packCatalogSequenceSchema,
  evidence: packSnapshotEvidenceSchema,
}).strict().superRefine((value, context) => {
  const identity = value.descriptor.identity;
  const header = value.header;
  if (identity.providerId !== header.providerId || identity.publicRepackId !== header.publicRepackId ||
    identity.dataAsOf !== header.dataAsOf || identity.evMethodIdentity !== header.evMethodIdentity ||
    identity.evPolicyIdentity !== header.evPolicyIdentity) {
    context.addIssue({ code: "custom", path: ["header"], message: "pack.start_identity_mismatch" });
  }
  if (JSON.stringify(value.descriptor.lifecycle) !== JSON.stringify(header.lifecycle) ||
    value.descriptor.contentCount !== header.contentCount ||
    (["probabilityInputsSha256", "valuationsSha256", "evInputsSha256", "economicsSha256"] as const)
      .some((key) => value.descriptor[key] !== header[key])) {
    context.addIssue({ code: "custom", path: ["descriptor"], message: "pack.start_descriptor_mismatch" });
  }
  if (value.evidence.providerId !== header.providerId || value.evidence.publicRepackId !== header.publicRepackId ||
    value.evidence.packPublicationSequence !== value.packPublicationSequence) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "pack.start_evidence_mismatch" });
  }
});
export const applyPackSnapshotBatchBodySchema = z.object({
  publicRepackId: packCatalogUuidSchema,
  publicPackSnapshotId: publicPackSnapshotIdSchema,
  batch: publicPackSnapshotBatchSchema,
}).strict().refine(
  (value) => value.batch.publicPackSnapshotId === value.publicPackSnapshotId,
  "Pack batch must name its snapshot.",
);
export const finalizePackSnapshotBodySchema = z.object({ snapshot: publicPackSnapshotIdentitySchema }).strict();
export const activatePackSnapshotBodySchema = z.object({ intent: packActivationIntentSchema }).strict();
export const packPublicationStatusBodySchema = z.object({
  publicRepackId: packCatalogUuidSchema,
  publicPackSnapshotId: publicPackSnapshotIdSchema.nullable(),
  operation: operationLookupSchema,
}).strict();
export const blockPackSnapshotBodySchema = z.object({
  publicRepackId: packCatalogUuidSchema,
  publicPackSnapshotId: publicPackSnapshotIdSchema,
  reasonCode: publicationReasonCodeSchema,
}).strict();
export const holdPackHeadBodySchema = headExpectationSchema;
export const resumePackHeadBodySchema = headExpectationSchema;
export const activateRetainedPackSnapshotBodySchema = headExpectationSchema.extend({
  targetSnapshotId: publicPackSnapshotIdSchema,
}).strict();
export const startProfileSnapshotBodySchema = z.object({ descriptor: publicProfileSnapshotDescriptorSchema }).strict();
export const applyProfileSnapshotBatchBodySchema = z.object({
  publicProfileSnapshotId: publicProfileSnapshotIdSchema,
  batch: publicProfileSnapshotBatchSchema,
}).strict().refine(
  (value) => value.batch.publicProfileSnapshotId === value.publicProfileSnapshotId,
  "Profile batch must name its snapshot.",
);
export const finalizeProfileSnapshotBodySchema = z.object({ profile: publicProfileSnapshotIdentitySchema }).strict();
export const activateProfileSnapshotBodySchema = z.object({ intent: profileActivationIntentSchema }).strict();
export const profilePublicationStatusBodySchema = z.object({
  profile: profileReferenceSchema,
  publicProfileSnapshotId: publicProfileSnapshotIdSchema.nullable(),
  operation: operationLookupSchema,
}).strict();
export const blockProfileSnapshotBodySchema = z.object({
  profile: profileReferenceSchema,
  publicProfileSnapshotId: publicProfileSnapshotIdSchema,
  reasonCode: publicationReasonCodeSchema,
}).strict();

const envelopeFields = {
  schemaVersion: z.literal(PACK_CATALOG_V1),
  operationId: packCatalogUuidSchema,
  idempotencyKey: packCatalogTextSchema(200),
  serviceIdentity: trustedPackCatalogServiceIdentitySchema,
  requestedAt: packCatalogTimestampSchema,
};
function operation<K extends PackCatalogPublicationOperationKind, B extends z.ZodType>(kind: K, body: B) {
  return z.object({ ...envelopeFields, operationKind: z.literal(kind), body }).strict();
}
export const packCatalogPublicationRequestSchema = z.discriminatedUnion("operationKind", [
  operation("start_pack_snapshot", startPackSnapshotBodySchema),
  operation("apply_pack_snapshot_batch", applyPackSnapshotBatchBodySchema),
  operation("finalize_pack_snapshot", finalizePackSnapshotBodySchema),
  operation("activate_pack_snapshot", activatePackSnapshotBodySchema),
  operation("pack_publication_status", packPublicationStatusBodySchema),
  operation("block_pack_snapshot", blockPackSnapshotBodySchema),
  operation("hold_pack_head", holdPackHeadBodySchema),
  operation("activate_retained_pack_snapshot", activateRetainedPackSnapshotBodySchema),
  operation("resume_pack_head", resumePackHeadBodySchema),
  operation("start_profile_snapshot", startProfileSnapshotBodySchema),
  operation("apply_profile_snapshot_batch", applyProfileSnapshotBatchBodySchema),
  operation("finalize_profile_snapshot", finalizeProfileSnapshotBodySchema),
  operation("activate_profile_snapshot", activateProfileSnapshotBodySchema),
  operation("profile_publication_status", profilePublicationStatusBodySchema),
  operation("block_profile_snapshot", blockProfileSnapshotBodySchema),
]);
export type PackCatalogPublicationRequest = z.infer<typeof packCatalogPublicationRequestSchema>;

/** The P01 entity a request addresses; the service identity must name exactly it. */
export function packCatalogRequestEntity(request: PackCatalogPublicationRequest): PackCatalogOperationEntity {
  switch (request.operationKind) {
    case "start_pack_snapshot":
      return { entityKind: "pack", publicRepackId: request.body.header.publicRepackId };
    case "apply_pack_snapshot_batch":
      return { entityKind: "pack", publicRepackId: request.body.publicRepackId };
    case "finalize_pack_snapshot":
      return { entityKind: "pack", publicRepackId: request.body.snapshot.publicRepackId };
    case "activate_pack_snapshot":
      return { entityKind: "pack", publicRepackId: request.body.intent.snapshot.publicRepackId };
    case "pack_publication_status":
    case "block_pack_snapshot":
    case "hold_pack_head":
    case "activate_retained_pack_snapshot":
    case "resume_pack_head":
      return { entityKind: "pack", publicRepackId: request.body.publicRepackId };
    case "start_profile_snapshot":
      return profileEntity(request.body.descriptor.identity);
    case "apply_profile_snapshot_batch":
      return profileEntity(request.body.batch.profile.identity);
    case "finalize_profile_snapshot":
      return profileEntity(request.body.profile);
    case "activate_profile_snapshot":
      return profileEntity(request.body.intent.profile);
    case "profile_publication_status":
    case "block_profile_snapshot":
      return profileEntity(request.body.profile);
  }
}
function profileEntity(
  profile: { profileKind: "provider"; providerId: string } | { profileKind: "collectible"; publicCollectibleId: string },
): PackCatalogOperationEntity {
  return profile.profileKind === "provider"
    ? { entityKind: "provider_profile", providerId: profile.providerId }
    : { entityKind: "collectible_profile", publicCollectibleId: profile.publicCollectibleId };
}

export const packCatalogSnapshotStates = ["staging", "complete", "blocked"] as const;
export const packCatalogHeadEvidenceSchema = z.object({
  generation: z.number().int().safe().positive(),
  publicationEpoch: z.number().int().safe().nonnegative(),
  held: z.boolean(),
  activeSnapshotId: publicPackSnapshotIdSchema,
  previousSnapshotId: publicPackSnapshotIdSchema.nullable(),
  latestAcceptedPackPublicationSequence: packCatalogSequenceSchema,
  activatedAt: packCatalogTimestampSchema,
}).strict();
export const packCatalogProfileHeadEvidenceSchema = z.object({
  generation: z.number().int().safe().positive(),
  activeProfileSnapshotId: publicProfileSnapshotIdSchema,
  previousProfileSnapshotId: publicProfileSnapshotIdSchema.nullable(),
  activatedAt: packCatalogTimestampSchema,
}).strict();
export const packCatalogPublicationReceiptSchema = z.object({
  schemaVersion: z.literal(PACK_CATALOG_V1),
  operationKind: z.enum(packCatalogPublicationOperationKinds),
  operationId: packCatalogUuidSchema,
  idempotencyKey: packCatalogTextSchema(200),
  requestSha256: packCatalogSha256Schema,
  result: publicationOperationResultSchema,
  entity: packCatalogOperationEntitySchema,
  snapshotId: z.union([publicPackSnapshotIdSchema, publicProfileSnapshotIdSchema]).nullable(),
  snapshotState: z.enum(packCatalogSnapshotStates).nullable(),
  packHead: packCatalogHeadEvidenceSchema.nullable(),
  profileHead: packCatalogProfileHeadEvidenceSchema.nullable(),
  statusOperation: z.object({
    found: z.boolean(),
    result: publicationOperationResultSchema.nullable(),
  }).strict().nullable(),
  completedAt: packCatalogTimestampSchema,
  expiresAt: packCatalogTimestampSchema,
  receiptDigest: packCatalogSha256Schema,
}).strict();
export type PackCatalogPublicationReceipt = z.infer<typeof packCatalogPublicationReceiptSchema>;

export function packCatalogReceiptDigest(value: unknown): Promise<string> {
  const body = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (() => {
      const { receiptDigest: _receiptDigest, ...rest } = value as Record<string, unknown>;
      void _receiptDigest;
      return rest;
    })()
    : value;
  return hashPackCatalogValue(PACK_CATALOG_RECEIPT_HASH_DOMAIN, body);
}

/** Deployment-side binding of one signing key to one environment, organization, and scope. */
export const packCatalogKeyAuthoritySchema = z.object({
  environment: z.enum(packCatalogEnvironments),
  organizationId: packCatalogUuidSchema,
  scope: packCatalogOperationScopeSchema,
}).strict();
export type PackCatalogKeyAuthority = z.infer<typeof packCatalogKeyAuthoritySchema>;

export function packCatalogKeyAuthoritySha256(keyId: string, authority: PackCatalogKeyAuthority): Promise<string> {
  return hashPackCatalogValue(PACK_CATALOG_KEY_AUTHORITY_HASH_DOMAIN, {
    keyId,
    ...packCatalogKeyAuthoritySchema.parse(authority),
  });
}

/** Splits a complete payload into the wire header and the two contents-derived vectors. */
export function packSnapshotHeaderFromPayload(payload: PublicPackSnapshotPayload) {
  const { contents, collectibleProfileSnapshotIds, valuationDependencyIdentities, ...header } = payload;
  return { header: publicPackSnapshotHeaderSchema.parse(header), contents, collectibleProfileSnapshotIds, valuationDependencyIdentities };
}

export const packCatalogErrorCodes = [
  "PACK_CATALOG_AUTH_MISSING",
  "PACK_CATALOG_AUTH_KEY_UNKNOWN",
  "PACK_CATALOG_AUTH_INVALID",
  "PACK_CATALOG_AUTH_STALE",
  "PACK_CATALOG_AUTH_REPLAYED",
  "PACK_CATALOG_AUTH_FORBIDDEN",
  "PACK_CATALOG_BODY_TOO_LARGE",
  "PACK_CATALOG_SCHEMA_UNSUPPORTED",
  "PACK_CATALOG_REQUEST_INVALID",
  "PACK_CATALOG_PROTECTED_FIELD",
  "PACK_CATALOG_OPERATION_CONFLICT",
  "PACK_CATALOG_STATE_CONFLICT",
  "PACK_CATALOG_INTERNAL_ERROR",
] as const;
export const packCatalogErrorCodeSchema = z.enum(packCatalogErrorCodes);
export type PackCatalogErrorCode = z.infer<typeof packCatalogErrorCodeSchema>;
export const packCatalogErrorEnvelopeSchema = z.object({
  error: z.string().min(1).max(256),
  code: packCatalogErrorCodeSchema,
}).strict();

export function classifyPackCatalogError(code: PackCatalogErrorCode): "bounded_retry" | "authentication" | "terminal" {
  if (code === "PACK_CATALOG_AUTH_STALE" || code === "PACK_CATALOG_INTERNAL_ERROR") return "bounded_retry";
  if (code.startsWith("PACK_CATALOG_AUTH_")) return "authentication";
  return "terminal";
}
