import { z } from "zod";
import { packCatalogCanonicalJson, packCatalogSha256Schema, packCatalogTextSchema, packCatalogUuidSchema } from "./pack-catalog-v1.ts";
import { publicPackContentSchema, publicPackSearchProjectionSchema, publicPackSnapshotIdentitySchema, publicPackSnapshotPayloadSchema, publicProfileSnapshotIdSchema, type PublicPackSnapshot } from "./pack-catalog-domain.ts";
import { packBuildRequestSchema, packSnapshotEvidenceSchema, publicationReasonCodeSchema } from "./pack-publication.ts";

const payload = publicPackSnapshotPayloadSchema.shape;

/** Immutable, allowlisted input capture; projections and artifact assembly belong to P03. */
export const providerPackBuildInputsSchema = z.object({
  providerId: packCatalogUuidSchema,
  publicRepackId: packCatalogUuidSchema,
  sourceRevisionIdentity: packCatalogTextSchema(200),
  snapshotKind: payload.snapshotKind,
  dataAsOf: payload.dataAsOf,
  title: payload.title,
  imageUrl: payload.imageUrl,
  category: payload.category,
  price: payload.price,
  lifecycle: payload.lifecycle,
  providerProfileSnapshotId: publicProfileSnapshotIdSchema.nullable(),
  contents: z.array(z.object({ ...publicPackContentSchema.shape,
    collectibleProfileSnapshotId: publicProfileSnapshotIdSchema.nullable(),
  }).strict()).max(8_000),
  contentsComplete: z.boolean(),
  actions: payload.actions,
  aliases: z.array(publicPackSearchProjectionSchema.shape.aliases.element).max(100)
    .refine(values => new Set(values).size === values.length, "pack.aliases_must_be_unique"),
  evMethodIdentity: payload.evMethodIdentity,
  evPolicyIdentity: payload.evPolicyIdentity,
  evInputsSha256: packCatalogSha256Schema.nullable(),
  ev: payload.ev.nullable(),
  evFailure: z.enum(["pending", "technical", "invalid_domain"]).nullable(),
  expectedDependencies: packSnapshotEvidenceSchema.shape.sharedDependencies,
  observedDependencies: packSnapshotEvidenceSchema.shape.sharedDependencies,
  lifecycleProvenanceIdentity: packCatalogTextSchema(200).nullable(),
  lifecycleBaseline: z.object({ identity: publicPackSnapshotIdentitySchema, payload: publicPackSnapshotPayloadSchema }).strict().nullable(),
}).strict().refine(value => value.snapshotKind !== "full" || value.lifecycleBaseline === null, "pack.full_baseline_invalid");

export const providerPackReadinessSchema = z.object({
  outcome: z.enum(["ready", "waiting", "blocked", "no_change", "superseded"]),
  reasonCode: publicationReasonCodeSchema.nullable(),
  desiredStateSha256: packCatalogSha256Schema,
  contentsSha256: packCatalogSha256Schema,
  probabilityInputsSha256: packCatalogSha256Schema,
  valuationInputsSha256: packCatalogSha256Schema,
  evInputsSha256: packCatalogSha256Schema,
  requiredProfileSnapshotIds: packBuildRequestSchema.shape.requiredProfileSnapshotIds,
}).strict();

export const packPublicationScopeSchema = z.object({
  organizationId: packCatalogUuidSchema,
  providerId: packCatalogUuidSchema,
}).strict();

export const packPublicationLimits = Object.freeze({
  changePage: 100,
  affectedPacks: 250,
  claimBatch: 25,
  leaseSeconds: 60,
  maximumLeaseSeconds: 300,
  maximumAttempts: 20,
  maximumOperations: 100,
  maximumRetrySeconds: 86_400,
  maximumInputBytes: 16_000_000,
});

export type ProviderPackBuildInputs = z.infer<typeof providerPackBuildInputsSchema>;
export type ProviderPackReadiness = z.infer<typeof providerPackReadinessSchema>;
export type PackPublicationScope = z.infer<typeof packPublicationScopeSchema>;

/** Lifecycle revisions may change availability/provenance and action eligibility,
 * never the baseline's metadata, profiles, display or numeric economics. */
export function preservesPackLifecycleBaseline(inputs: ProviderPackBuildInputs, previous: PublicPackSnapshot): boolean {
  const equal = (left: unknown, right: unknown) => packCatalogCanonicalJson(left) === packCatalogCanonicalJson(right);
  const fields = ["providerId", "publicRepackId", "title", "imageUrl", "category", "price", "contents",
    "providerProfileSnapshotId", "evMethodIdentity", "evPolicyIdentity", "evInputsSha256", "ev"] as const;
  const actionDefinitions = (actions: ProviderPackBuildInputs["actions"]) => actions.map(({ actionId, kind, label, url }) => ({ actionId, kind, label, url }));
  return inputs.lifecycleProvenanceIdentity !== null && fields.every(key => equal(inputs[key], previous.payload[key])) &&
    equal(inputs.aliases, previous.payload.searchProjection.aliases) &&
    equal(actionDefinitions(inputs.actions), actionDefinitions(previous.payload.actions));
}
