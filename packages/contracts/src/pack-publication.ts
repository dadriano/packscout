import { z } from "zod";
import {
  PACK_CATALOG_V1,
  PACK_PUBLICATION_REPLAY_LIFETIME_MS,
  isCanonicalAscending,
  packCatalogSequenceSchema,
  packCatalogSha256Schema,
  packCatalogTextSchema,
  packCatalogTimestampSchema,
  packCatalogUuidSchema,
} from "./pack-catalog-v1.ts";
import {
  publicPackSnapshotDescriptorSchema,
  publicPackSnapshotBatchSchema,
  publicPackSnapshotIdSchema,
  publicPackSnapshotIdentitySchema,
  publicPackSnapshotSchema,
  publicPackSummaryCoreSchema,
  publicProfileSnapshotBatchSchema,
  publicProfileSnapshotDescriptorSchema,
  publicProfileSnapshotIdSchema,
  publicProfileSnapshotIdentitySchema,
  publicCollectibleProfileSchema,
  publicProviderProfileSchema,
} from "./pack-catalog-domain.ts";

export const publicationWorkStates = [
  "waiting",
  "ready",
  "publishing",
  "retry_scheduled",
  "blocked",
  "published",
  "superseded",
  "rolled_back",
] as const;
export const publicationOperationOutcomes = [
  "applied",
  "already_applied",
  "already_active",
  "conflict",
  "refused",
  "operation_expired",
] as const;
export const publicationReasonCodes = [
  "INCOMPLETE_CONTENTS",
  "INVALID_PROBABILITIES",
  "EV_INPUTS_PENDING",
  "EV_TECHNICAL_RETRY",
  "INVALID_DOMAIN_DATA",
  "PROFILE_HEAD_MISSING",
  "PROVIDER_UNREACHABLE",
  "TRANSPORT_TIMEOUT",
  "RECEIPT_AMBIGUOUS",
  "LEASE_LOST",
  "ACTIVATION_CONFLICT",
  "OPERATOR_HOLD",
  "AUTHORIZATION_REFUSED",
  "OPERATION_EXPIRED",
] as const;
export const publicationWorkStateSchema = z.enum(publicationWorkStates);
export const publicationOperationOutcomeSchema = z.enum(publicationOperationOutcomes);
export const publicationReasonCodeSchema = z.enum(publicationReasonCodes);
export const publicationPlannerOutcomeSchema = z.enum(["change", "no_change"]);
export const terminalPublicationWorkStates = ["published", "superseded", "rolled_back"] as const;
export const alertablePublicationWorkStates = ["waiting", "ready", "publishing", "retry_scheduled"] as const;
export const publicationReasonDefaultState = Object.freeze({
  INCOMPLETE_CONTENTS: "blocked",
  INVALID_PROBABILITIES: "blocked",
  EV_INPUTS_PENDING: "waiting",
  EV_TECHNICAL_RETRY: "retry_scheduled",
  INVALID_DOMAIN_DATA: "blocked",
  PROFILE_HEAD_MISSING: "waiting",
  PROVIDER_UNREACHABLE: "retry_scheduled",
  TRANSPORT_TIMEOUT: "retry_scheduled",
  RECEIPT_AMBIGUOUS: "publishing",
  LEASE_LOST: "retry_scheduled",
  ACTIVATION_CONFLICT: "blocked",
  OPERATOR_HOLD: "waiting",
  AUTHORIZATION_REFUSED: "blocked",
  OPERATION_EXPIRED: "blocked",
} satisfies Readonly<Record<PublicationReasonCode, PublicationWorkState>>);

export function isPublicationAlertAgeEligible(state: PublicationWorkState, held: boolean): boolean {
  return !held && (alertablePublicationWorkStates as readonly string[]).includes(state);
}

export function isTerminalPublicationWork(state: PublicationWorkState, permanentlyInvalid: boolean): boolean {
  return (terminalPublicationWorkStates as readonly string[]).includes(state) ||
    (state === "blocked" && permanentlyInvalid);
}

const dependencySchema = z.object({
  kind: z.enum(["provider_profile", "collectible_profile", "category", "valuation", "ev_policy"]),
  identity: packCatalogTextSchema(200),
  contentSha256: packCatalogSha256Schema,
}).strict();
const dependenciesSchema = z.array(dependencySchema).max(10_000).refine(
  (values) => isCanonicalAscending(values.map(({ kind, identity }) => `${kind}:${identity}`)),
  "Dependencies must be unique and sorted.",
);

export const packSnapshotEvidenceSchema = z.object({
  providerId: packCatalogUuidSchema,
  publicRepackId: packCatalogUuidSchema,
  packPublicationSequence: packCatalogSequenceSchema,
  providerChangeIdentity: packCatalogTextSchema(200),
  sourceRevisionIdentity: packCatalogTextSchema(200),
  sharedDependencies: dependenciesSchema,
}).strict();

export const packBuildRequestSchema = z.object({
  requestId: packCatalogUuidSchema,
  schemaVersion: z.literal(PACK_CATALOG_V1),
  providerId: packCatalogUuidSchema,
  publicRepackId: packCatalogUuidSchema,
  packPublicationSequence: packCatalogSequenceSchema,
  desiredStateSha256: packCatalogSha256Schema,
  contentsSha256: packCatalogSha256Schema,
  probabilityInputsSha256: packCatalogSha256Schema,
  valuationInputsSha256: packCatalogSha256Schema,
  evInputsSha256: packCatalogSha256Schema,
  profilePrerequisiteMode: z.enum(["initial_heads_required", "existing_heads_accepted"]),
  requiredProfileSnapshotIds: z.array(publicProfileSnapshotIdSchema).max(10_000)
    .refine(isCanonicalAscending, "Profile prerequisites must be unique and sorted."),
  expectedPublicationEpoch: z.number().int().safe().nonnegative(),
  evidence: packSnapshotEvidenceSchema,
  requestedAt: packCatalogTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.providerId !== value.evidence.providerId ||
    value.publicRepackId !== value.evidence.publicRepackId ||
    value.packPublicationSequence !== value.evidence.packPublicationSequence) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "pack.build_evidence_mismatch" });
  }
  if (value.profilePrerequisiteMode === "initial_heads_required" &&
    value.requiredProfileSnapshotIds.length === 0) {
    context.addIssue({ code: "custom", path: ["requiredProfileSnapshotIds"], message: "pack.initial_profile_heads_required" });
  }
});

const expectedPackHeadSchema = z.object({
  generation: z.number().int().safe().nonnegative(),
  publicationEpoch: z.number().int().safe().nonnegative(),
  activeSnapshotId: publicPackSnapshotIdSchema.nullable(),
}).strict();
export const packActivationIntentSchema = z.object({
  intentId: packCatalogUuidSchema,
  idempotencyKey: packCatalogTextSchema(200),
  snapshot: publicPackSnapshotIdentitySchema,
  packPublicationSequence: packCatalogSequenceSchema,
  evidence: packSnapshotEvidenceSchema,
  expectedHead: expectedPackHeadSchema,
  operationDigest: packCatalogSha256Schema,
  createdAt: packCatalogTimestampSchema,
  expiresAt: packCatalogTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.snapshot.providerId !== value.evidence.providerId ||
    value.snapshot.publicRepackId !== value.evidence.publicRepackId ||
    value.packPublicationSequence !== value.evidence.packPublicationSequence) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "pack.activation_evidence_mismatch" });
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "pack.activation_expiry_invalid" });
  }
});

export const activePackHeadSchema = z.object({
  providerId: packCatalogUuidSchema,
  publicRepackId: packCatalogUuidSchema,
  generation: z.number().int().safe().positive(),
  publicationEpoch: z.number().int().safe().nonnegative(),
  held: z.boolean(),
  holdReason: z.literal("OPERATOR_HOLD").nullable(),
  latestAcceptedPackPublicationSequence: packCatalogSequenceSchema,
  activeSnapshot: publicPackSnapshotIdentitySchema,
  previousSnapshot: publicPackSnapshotIdentitySchema.nullable(),
  indexableSummary: publicPackSummaryCoreSchema,
  activatedAt: packCatalogTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.held !== (value.holdReason !== null)) {
    context.addIssue({ code: "custom", path: ["holdReason"], message: "pack.head_hold_invalid" });
  }
  if (value.providerId !== value.activeSnapshot.providerId ||
    value.publicRepackId !== value.activeSnapshot.publicRepackId ||
    value.publicRepackId !== value.indexableSummary.publicRepackId) {
    context.addIssue({ code: "custom", path: ["activeSnapshot"], message: "pack.head_identity_mismatch" });
  }
  if (value.previousSnapshot !== null &&
    (value.previousSnapshot.providerId !== value.providerId ||
      value.previousSnapshot.publicRepackId !== value.publicRepackId ||
      value.previousSnapshot.publicPackSnapshotId === value.activeSnapshot.publicPackSnapshotId)) {
    context.addIssue({ code: "custom", path: ["previousSnapshot"], message: "pack.previous_head_invalid" });
  }
});

export const profileActivationIntentSchema = z.object({
  intentId: packCatalogUuidSchema,
  idempotencyKey: packCatalogTextSchema(200),
  profile: publicProfileSnapshotIdentitySchema,
  expectedGeneration: z.number().int().safe().nonnegative(),
  operationDigest: packCatalogSha256Schema,
  createdAt: packCatalogTimestampSchema,
  expiresAt: packCatalogTimestampSchema,
}).strict().refine(
  ({ createdAt, expiresAt }) => Date.parse(expiresAt) > Date.parse(createdAt),
  "Profile activation intent must expire after creation.",
);
export const profilePublicationEnvelopeSchema = z.object({
  intent: profileActivationIntentSchema,
  descriptor: publicProfileSnapshotDescriptorSchema,
  batch: publicProfileSnapshotBatchSchema,
  profile: z.union([publicProviderProfileSchema, publicCollectibleProfileSchema]),
  payloadSha256: packCatalogSha256Schema,
  authorizationScopeSha256: packCatalogSha256Schema,
}).strict().refine(
  ({ intent, descriptor, batch, profile }) => {
    const snapshotId = intent.profile.publicProfileSnapshotId;
    return descriptor.identity.publicProfileSnapshotId === snapshotId &&
      batch.publicProfileSnapshotId === snapshotId &&
      profile.identity.publicProfileSnapshotId === snapshotId;
  },
  "Profile publication envelope identities must match.",
);

export const packPublicationEnvelopeSchema = z.object({
  intent: packActivationIntentSchema,
  descriptor: publicPackSnapshotDescriptorSchema,
  snapshot: publicPackSnapshotSchema,
  batches: z.array(publicPackSnapshotBatchSchema).min(1).max(32),
  payloadSha256: packCatalogSha256Schema,
  authorizationScopeSha256: packCatalogSha256Schema,
}).strict().superRefine((value, context) => {
  const snapshotId = value.intent.snapshot.publicPackSnapshotId;
  if (value.descriptor.identity.publicPackSnapshotId !== snapshotId ||
    value.snapshot.identity.publicPackSnapshotId !== snapshotId ||
    value.batches.some((batch) => batch.publicPackSnapshotId !== snapshotId)) {
    context.addIssue({ code: "custom", path: ["snapshot"], message: "pack.publication_envelope_mismatch" });
  }
  if (Date.parse(value.intent.createdAt) >= Date.parse(value.snapshot.payload.ev.validUntil)) {
    context.addIssue({ code: "custom", path: ["snapshot", "payload", "ev"], message: "pack.ev_evidence_expired" });
  }
});

export const sharedProviderChangeDeliverySchema = z.object({
  organizationId: packCatalogUuidSchema,
  providerId: packCatalogUuidSchema,
  centralChangeIdentity: packCatalogTextSchema(200),
  providerChangeSequence: packCatalogSequenceSchema,
  sharedDependencies: dependenciesSchema,
  payloadSha256: packCatalogSha256Schema,
  leaseIdentity: packCatalogUuidSchema,
  acknowledgmentIdentity: packCatalogUuidSchema.nullable(),
}).strict();

export const publicationOperationResultSchema = z.object({
  outcome: publicationOperationOutcomeSchema,
  state: publicationWorkStateSchema,
  reasonCode: publicationReasonCodeSchema.nullable(),
}).strict();
export const publicationReplayRecordSchema = z.object({
  operationId: packCatalogUuidSchema,
  idempotencyKey: packCatalogTextSchema(200),
  authorizationScopeSha256: packCatalogSha256Schema,
  entityIdentity: packCatalogTextSchema(200),
  snapshotIdentity: packCatalogTextSchema(200),
  requestSha256: packCatalogSha256Schema,
  state: publicationWorkStateSchema,
  completedAt: packCatalogTimestampSchema,
  expiresAt: packCatalogTimestampSchema,
}).strict().refine(
  ({ completedAt, expiresAt }) =>
    Date.parse(expiresAt) - Date.parse(completedAt) === PACK_PUBLICATION_REPLAY_LIFETIME_MS,
  "Publication replay evidence must expire after exactly 30 days.",
);

export function evaluatePublicationReplay(input: {
  readonly record: PublicationReplayRecord;
  readonly requestSha256: string;
  readonly now: string;
}): PublicationOperationResult {
  const record = publicationReplayRecordSchema.parse(input.record);
  const requestSha256 = packCatalogSha256Schema.parse(input.requestSha256);
  if (Date.parse(packCatalogTimestampSchema.parse(input.now)) >= Date.parse(record.expiresAt)) {
    return { outcome: "operation_expired", state: record.state, reasonCode: "OPERATION_EXPIRED" };
  }
  if (requestSha256 !== record.requestSha256) {
    return { outcome: "conflict", state: record.state, reasonCode: "ACTIVATION_CONFLICT" };
  }
  return { outcome: "already_applied", state: record.state, reasonCode: null };
}

export type PublicationWorkState = z.infer<typeof publicationWorkStateSchema>;
export type PublicationOperationOutcome = z.infer<typeof publicationOperationOutcomeSchema>;
export type PublicationReasonCode = z.infer<typeof publicationReasonCodeSchema>;
export type PackSnapshotEvidence = z.infer<typeof packSnapshotEvidenceSchema>;
export type PackBuildRequest = z.infer<typeof packBuildRequestSchema>;
export type PackActivationIntent = z.infer<typeof packActivationIntentSchema>;
export type ActivePackHead = z.infer<typeof activePackHeadSchema>;
export type ProfileActivationIntent = z.infer<typeof profileActivationIntentSchema>;
export type ProfilePublicationEnvelope = z.infer<typeof profilePublicationEnvelopeSchema>;
export type SharedProviderChangeDelivery = z.infer<typeof sharedProviderChangeDeliverySchema>;
export type PublicationOperationResult = z.infer<typeof publicationOperationResultSchema>;
export type PublicationReplayRecord = z.infer<typeof publicationReplayRecordSchema>;
