import { z } from "zod";
import { PACK_SNAPSHOT_HASH_DOMAIN, compareCanonicalStrings, hashPackCatalogValue, normalizePackCatalogSearchText, packCatalogCanonicalJson, packCatalogSha256Schema, packCatalogTextSchema, packCatalogTimestampSchema, packCatalogUuidSchema } from "./pack-catalog-v1.ts";
import { publicPackContentSchema, publicPackSearchProjectionSchema, publicPackSnapshotIdentitySchema, publicPackSnapshotPayloadSchema, publicPackSnapshotSchema, publicProfileSnapshotIdSchema, type PublicPackSnapshot } from "./pack-catalog-domain.ts";
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

/** The only allowed capture normalization: schema values, canonical ordering,
 * and the baseline supplied by the stored active artifact. No pack data changes. */
export function normalizeProviderPackBuildInputs(candidate: ProviderPackBuildInputs, previousSnapshot: PublicPackSnapshot | null = null): ProviderPackBuildInputs {
  const inputs = providerPackBuildInputsSchema.parse(candidate);
  if (inputs.snapshotKind === "lifecycle_only") inputs.lifecycleBaseline = previousSnapshot;
  inputs.contents.sort((a, b) => compareCanonicalStrings(a.publicCollectibleId, b.publicCollectibleId));
  inputs.aliases.sort(compareCanonicalStrings);
  inputs.actions.sort((a, b) => compareCanonicalStrings(a.actionId, b.actionId));
  return inputs;
}

export function deriveProviderPackProfilePrerequisites(inputs: ProviderPackBuildInputs): string[] {
  return [...new Set([inputs.providerProfileSnapshotId, ...inputs.contents.map(row => row.collectibleProfileSnapshotId)]
    .filter((id): id is string => id !== null))].sort(compareCanonicalStrings);
}

/** Derive evidence from captured bytes, never from a caller's declared digests.
 * Readiness evaluation and durable admission share this V1 hash definition. */
export async function deriveProviderPackInputDigests(inputs: ProviderPackBuildInputs) {
  const hash = (value: unknown) => hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, value);
  const probabilityInputsSha256 = await hash(inputs.contents.map(({ publicCollectibleId, probabilityMicros }) => ({ publicCollectibleId, probabilityMicros })));
  const valuationInputsSha256 = await hash(inputs.contents.map(({ publicCollectibleId, valuation }) => ({ publicCollectibleId, valuation })));
  return { desiredStateSha256: await hash(inputs), contentsSha256: await hash(inputs.contents),
    probabilityInputsSha256, valuationInputsSha256,
    evInputsSha256: await hash({ price: inputs.price, probabilityInputsSha256, valuationsSha256: valuationInputsSha256,
      evMethodIdentity: inputs.evMethodIdentity, evPolicyIdentity: inputs.evPolicyIdentity }) };
}

/** Pure readiness rules shared by evaluation and independent durable admission.
 * Inputs are normalized captured bytes; the clock and derived EV digest are explicit. */
export async function deriveProviderPackReadinessDecision(inputs: ProviderPackBuildInputs, evInputsSha256: string,
  evaluatedAt: string): Promise<Pick<ProviderPackReadiness, "outcome" | "reasonCode">> {
  const now = Date.parse(packCatalogTimestampSchema.parse(evaluatedAt));
  const result = (outcome: ProviderPackReadiness["outcome"], reasonCode: ProviderPackReadiness["reasonCode"]) => ({ outcome, reasonCode });
  if (inputs.evFailure === "invalid_domain") return result("blocked", "INVALID_DOMAIN_DATA");
  if (inputs.snapshotKind === "lifecycle_only") {
    if (!inputs.lifecycleBaseline) return result("waiting", "INCOMPLETE_CONTENTS");
    const previous = await publicPackSnapshotSchema.parseAsync(inputs.lifecycleBaseline);
    if (!preservesPackLifecycleBaseline(inputs, previous)) return result("blocked", "INVALID_DOMAIN_DATA");
  }
  if (!inputs.contentsComplete || inputs.contents.length === 0) return result("waiting", "INCOMPLETE_CONTENTS");
  if (new Set(inputs.contents.map(row => row.publicCollectibleId)).size !== inputs.contents.length ||
    inputs.contents.reduce((total, row) => total + row.probabilityMicros, 0) !== 1_000_000) return result("blocked", "INVALID_PROBABILITIES");
  if (!inputs.providerProfileSnapshotId || inputs.contents.some(row => !row.collectibleProfileSnapshotId)) return result("waiting", "PROFILE_HEAD_MISSING");
  if (inputs.contents.some(row => !publicPackContentSchema.safeParse(row).success)) return result("blocked", "INVALID_DOMAIN_DATA");
  // Complete projections must fit the public contract; never truncate captured members.
  if (!publicPackSearchProjectionSchema.safeParse({ publicRepackId: inputs.publicRepackId, aliases: inputs.aliases,
    normalizedText: normalizePackCatalogSearchText([inputs.title, ...inputs.contents.map(row => row.displayName), ...inputs.aliases].join(" ")),
    categoryIds: [...new Set([inputs.category.publicCategoryId, ...inputs.contents.map(row => row.category.publicCategoryId)])].sort(compareCanonicalStrings),
  }).success) return result("blocked", "INVALID_DOMAIN_DATA");
  // These identities become canonical-unique arrays in the sealed payload.
  const profileIds = inputs.contents.map(row => row.collectibleProfileSnapshotId);
  const valuationIds = inputs.contents.filter(row => row.eligibleForChase).map(row => row.valuation.valuationIdentity);
  if (new Set(inputs.actions.map(action => action.actionId)).size !== inputs.actions.length ||
    new Set(profileIds).size !== profileIds.length || new Set(valuationIds).size !== valuationIds.length) return result("blocked", "INVALID_DOMAIN_DATA");
  const actionable = inputs.lifecycle.availability === "available" && inputs.lifecycle.retirement === "active";
  const disabledReason = inputs.lifecycle.retirement === "retired" ? "PACK_RETIRED" : actionable ? null : "PACK_UNAVAILABLE";
  if (inputs.actions.some(action => action.enabled !== actionable || action.disabledReason !== disabledReason) ||
    inputs.contents.some(row => row.valuation.status === "available" && row.valuation.amount.currency !== inputs.price.currency) ||
    (inputs.ev?.status === "available" && inputs.ev.amount.currency !== inputs.price.currency)) return result("blocked", "INVALID_DOMAIN_DATA");
  if (packCatalogCanonicalJson(inputs.expectedDependencies) !== packCatalogCanonicalJson(inputs.observedDependencies)) return result("waiting", "EV_INPUTS_PENDING");
  if (inputs.evFailure === "technical") return result("waiting", "EV_TECHNICAL_RETRY");
  if (!inputs.ev || inputs.evFailure === "pending" || inputs.evInputsSha256 !== evInputsSha256 ||
    Date.parse(inputs.ev.evaluatedAt) > now || Date.parse(inputs.ev.validUntil) <= now) return result("waiting", "EV_INPUTS_PENDING");
  return result("ready", null);
}

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
