import { z } from "zod";
import {
  canonicalJson,
} from "./data-release-v2-canonical.ts";
import {
  dataReleaseMetadataSchema,
  type DataReleaseMetadata,
} from "./data-release-v2-manifest.ts";
import {
  sha256Schema,
  timestampSchema,
} from "./data-release-v2-values.ts";
import {
  GLOBAL_CATALOG_MANIFEST_SCHEMA_VERSION,
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  type GlobalCatalogManifestV1,
  globalCatalogManifestV1Schema,
} from "./global-catalog-manifest-v1.ts";
import {
  containsProtectedProviderCatalogReleaseField,
  providerCatalogPlatformKeyV1Schema,
  providerCatalogReleaseCheckpointV1Schema,
  providerCatalogSequenceV1Schema,
  providerCatalogSharedConfigurationEpochV1Schema,
  publicProviderReleaseIdV1Schema,
} from "./provider-catalog-release-v1.ts";
import {
  providerReleaseOperationIdSchema,
} from "./provider-release-publication-v1.ts";

export const CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION =
  "catalog_manifest_publication_v1" as const;
export const MAX_CATALOG_MANIFEST_PUBLICATION_BODY_BYTES = 128 * 1_024;
export const MAX_CATALOG_MANIFEST_BLOCK_REASON_LENGTH = 128;

export const PRODUCTION_CATALOG_MANIFEST_PATHS = Object.freeze({
  activeState: "/internal/catalog-manifest/v1/active-state",
  activateManifest: "/internal/catalog-manifest/v1/activate-manifest",
  status: "/internal/catalog-manifest/v1/status",
  refreshActiveState: "/internal/catalog-manifest/v1/refresh-active-state",
  rollback: "/internal/catalog-manifest/v1/rollback",
  block: "/internal/catalog-manifest/v1/block",
});

export const catalogManifestOperationIdSchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u);
export const catalogManifestIdempotencyKeySchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u);
const nonNegativeSafeIntegerSchema = z.number().int().safe().min(0);
const positiveSafeIntegerSchema = z.number().int().safe().positive();

export const globalCatalogManifestIdentityV1Schema = z.object({
  publicReleaseId: publicProviderReleaseIdV1Schema,
  manifestFingerprint: sha256Schema,
  sharedConfigurationEpoch: providerCatalogSharedConfigurationEpochV1Schema,
  providerReferenceSetHash: sha256Schema,
}).strict();

export const globalCatalogManifestPointerV1Schema =
  globalCatalogManifestIdentityV1Schema.extend({
    createdAt: timestampSchema,
    completedAt: timestampSchema,
  }).strict().refine(
    ({ createdAt, completedAt }) =>
      Date.parse(completedAt) >= Date.parse(createdAt),
    {
      path: ["completedAt"],
      message: "catalog_manifest_publication.completed_before_created",
    },
  );

const completedCheckpointSchema = providerCatalogReleaseCheckpointV1Schema
  .refine(({ settledSequence }) => settledSequence !== "0", {
    path: ["settledSequence"],
    message: "catalog_manifest_publication.completed_checkpoint_required",
  });

export const globalCatalogProviderActiveObservationV1Schema = z.object({
  platformKey: providerCatalogPlatformKeyV1Schema,
  publicProviderReleaseId: publicProviderReleaseIdV1Schema,
  terminalOperationKind: z.enum(["finalize", "confirmReuse"]),
  terminalOperationId: providerReleaseOperationIdSchema,
  terminalReceiptSha256: sha256Schema,
  selectedProviderCheckpoint: completedCheckpointSchema,
  selectedDataAsOf: timestampSchema,
  latestAffectedSettledSequence: providerCatalogSequenceV1Schema,
  latestAffectedSourceHeadSequence: providerCatalogSequenceV1Schema,
  initialBackfillComplete: z.boolean(),
  affectedDerivationsSettled: z.boolean(),
  settledSourceFreshness: z.enum(["fresh", "delayed"]),
  lastSuccessfulObservationAt: timestampSchema,
  staleAt: timestampSchema,
}).strict().superRefine((observation, context) => {
  if (
    BigInt(observation.selectedProviderCheckpoint.settledSequence) >
      BigInt(observation.latestAffectedSettledSequence) ||
    BigInt(observation.latestAffectedSettledSequence) >
      BigInt(observation.latestAffectedSourceHeadSequence)
  ) {
    context.addIssue({
      code: "custom",
      path: ["selectedProviderCheckpoint", "settledSequence"],
      message: "catalog_manifest_publication.affected_sequence_order_invalid",
    });
  }
  const checkpointTime = observation.selectedProviderCheckpoint.settledAt;
  if (
    checkpointTime === null ||
    Date.parse(observation.selectedDataAsOf) > Date.parse(checkpointTime)
  ) {
    context.addIssue({
      code: "custom",
      path: ["selectedDataAsOf"],
      message: "catalog_manifest_publication.data_after_checkpoint",
    });
  }
  if (
    Date.parse(observation.selectedDataAsOf) >
      Date.parse(observation.lastSuccessfulObservationAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["selectedDataAsOf"],
      message: "catalog_manifest_publication.data_after_observation",
    });
  }
  if (
    Date.parse(observation.staleAt) <=
      Date.parse(observation.lastSuccessfulObservationAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["staleAt"],
      message: "catalog_manifest_publication.stale_deadline_invalid",
    });
  }
});

const providerSelectionsSchema = z.array(
  globalCatalogProviderActiveObservationV1Schema,
).min(1).max(MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES).refine(
  (observations) => observations.every(
    ({ platformKey }, index) =>
      index === 0 || observations[index - 1]!.platformKey < platformKey,
  ),
  { message: "catalog_manifest_publication.observations_not_canonical" },
);

export const globalCatalogAggregateObservationV1Schema = z.object({
  observationSequence: positiveSafeIntegerSchema,
  publicReleaseId: publicProviderReleaseIdV1Schema,
  providerReferenceSetHash: sha256Schema,
  sourceWatermark: z.string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u),
  providerSelections: providerSelectionsSchema,
  dataAsOf: timestampSchema,
  lastSuccessfulObservationAt: timestampSchema,
  staleAt: timestampSchema,
  freshness: z.enum(["fresh", "delayed"]),
  delayedProviderCount: nonNegativeSafeIntegerSchema.max(
    MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  ),
}).strict().superRefine((observation, context) => {
  const derived = deriveGlobalCatalogAggregateObservationFieldsV1(
    observation.providerSelections,
  );
  if (
    observation.sourceWatermark !== buildGlobalCatalogManifestSourceWatermarkV1(
      observation.publicReleaseId,
      observation.observationSequence,
    ) ||
    observation.dataAsOf !== derived.dataAsOf ||
    observation.lastSuccessfulObservationAt !==
      derived.lastSuccessfulObservationAt ||
    observation.staleAt !== derived.staleAt ||
    observation.freshness !== derived.freshness ||
    observation.delayedProviderCount !== derived.delayedProviderCount
  ) {
    context.addIssue({
      code: "custom",
      message: "catalog_manifest_publication.aggregate_observation_mismatch",
    });
  }
});

export type GlobalCatalogProviderActiveObservationV1 = z.infer<
  typeof globalCatalogProviderActiveObservationV1Schema
>;
export type GlobalCatalogAggregateObservationV1 = z.infer<
  typeof globalCatalogAggregateObservationV1Schema
>;

function oldestTimestamp(
  values: readonly string[],
): string {
  return values.reduce((oldest, value) =>
    Date.parse(value) < Date.parse(oldest) ? value : oldest
  );
}

export function isGlobalCatalogProviderDelayedV1(
  observation: GlobalCatalogProviderActiveObservationV1,
): boolean {
  const selectedSequence = BigInt(
    observation.selectedProviderCheckpoint.settledSequence,
  );
  return observation.settledSourceFreshness === "delayed" ||
    !observation.affectedDerivationsSettled ||
    selectedSequence < BigInt(observation.latestAffectedSettledSequence) ||
    selectedSequence < BigInt(observation.latestAffectedSourceHeadSequence);
}

export function deriveGlobalCatalogAggregateObservationFieldsV1(
  providerSelections: readonly GlobalCatalogProviderActiveObservationV1[],
): Readonly<{
  dataAsOf: string;
  lastSuccessfulObservationAt: string;
  staleAt: string;
  freshness: "fresh" | "delayed";
  delayedProviderCount: number;
}> {
  if (providerSelections.length === 0) {
    throw new TypeError("Global catalog observation requires a provider.");
  }
  const delayedProviderCount = providerSelections.filter(
    isGlobalCatalogProviderDelayedV1,
  ).length;
  return {
    dataAsOf: oldestTimestamp(
      providerSelections.map(({ selectedDataAsOf }) => selectedDataAsOf),
    ),
    lastSuccessfulObservationAt: oldestTimestamp(
      providerSelections.map(
        ({ lastSuccessfulObservationAt }) => lastSuccessfulObservationAt,
      ),
    ),
    staleAt: oldestTimestamp(
      providerSelections.map(({ staleAt }) => staleAt),
    ),
    freshness: delayedProviderCount === 0 ? "fresh" : "delayed",
    delayedProviderCount,
  };
}

export function buildGlobalCatalogAggregateObservationV1(input: Readonly<{
  observationSequence: number;
  publicReleaseId: string;
  providerReferenceSetHash: string;
  providerSelections: readonly GlobalCatalogProviderActiveObservationV1[];
}>): GlobalCatalogAggregateObservationV1 {
  return globalCatalogAggregateObservationV1Schema.parse({
    ...input,
    sourceWatermark: buildGlobalCatalogManifestSourceWatermarkV1(
      input.publicReleaseId,
      input.observationSequence,
    ),
    providerSelections: [...input.providerSelections],
    ...deriveGlobalCatalogAggregateObservationFieldsV1(
      input.providerSelections,
    ),
  });
}

export function buildGlobalCatalogManifestSourceWatermarkV1(
  publicReleaseId: string,
  observationSequence: number,
): string {
  return `catalog-manifest:${publicReleaseId}:${observationSequence}`;
}

export const activeCatalogManifestStateCoreV1Schema = z.union([
  z.object({
    generation: nonNegativeSafeIntegerSchema,
    activeManifest: z.null(),
    previousManifest: z.null(),
    observation: z.null(),
  }).strict(),
  z.object({
    generation: positiveSafeIntegerSchema,
    activeManifest: globalCatalogManifestPointerV1Schema,
    previousManifest: globalCatalogManifestPointerV1Schema.nullable(),
    observation: globalCatalogAggregateObservationV1Schema,
  }).strict().superRefine((state, context) => {
    if (
      state.activeManifest.providerReferenceSetHash !==
        state.observation.providerReferenceSetHash ||
      state.activeManifest.publicReleaseId !==
        state.observation.publicReleaseId
    ) {
      context.addIssue({
        code: "custom",
        path: ["observation", "providerReferenceSetHash"],
        message: "catalog_manifest_publication.active_observation_mismatch",
      });
    }
    if (
      state.previousManifest?.publicReleaseId ===
        state.activeManifest.publicReleaseId
    ) {
      context.addIssue({
        code: "custom",
        path: ["previousManifest"],
        message: "catalog_manifest_publication.previous_matches_active",
      });
    }
  }),
]);

export const activeCatalogManifestStateV1Schema = z.union([
  z.object({
    generation: z.literal(0),
    activeManifest: z.null(),
    previousManifest: z.null(),
    observation: z.null(),
    terminalReceiptSha256: z.null(),
  }).strict(),
  z.object({
    generation: positiveSafeIntegerSchema,
    activeManifest: z.null(),
    previousManifest: z.null(),
    observation: z.null(),
    terminalReceiptSha256: sha256Schema,
  }).strict(),
  z.object({
    generation: positiveSafeIntegerSchema,
    activeManifest: globalCatalogManifestPointerV1Schema,
    previousManifest: globalCatalogManifestPointerV1Schema.nullable(),
    observation: globalCatalogAggregateObservationV1Schema,
    terminalReceiptSha256: sha256Schema,
  }).strict().superRefine((state, context) => {
    if (
      state.activeManifest.providerReferenceSetHash !==
        state.observation.providerReferenceSetHash ||
      state.activeManifest.publicReleaseId !==
        state.observation.publicReleaseId
    ) {
      context.addIssue({
        code: "custom",
        path: ["observation", "providerReferenceSetHash"],
        message: "catalog_manifest_publication.active_observation_mismatch",
      });
    }
    if (
      state.previousManifest?.publicReleaseId ===
        state.activeManifest.publicReleaseId
    ) {
      context.addIssue({
        code: "custom",
        path: ["previousManifest"],
        message: "catalog_manifest_publication.previous_matches_active",
      });
    }
  }),
]);

export const expectedActiveCatalogManifestStateV1Schema =
  activeCatalogManifestStateV1Schema;

export type GlobalCatalogManifestIdentityV1 = z.infer<
  typeof globalCatalogManifestIdentityV1Schema
>;
export type GlobalCatalogManifestPointerV1 = z.infer<
  typeof globalCatalogManifestPointerV1Schema
>;
export type ActiveCatalogManifestStateCoreV1 = z.infer<
  typeof activeCatalogManifestStateCoreV1Schema
>;
export type ActiveCatalogManifestStateV1 = z.infer<
  typeof activeCatalogManifestStateV1Schema
>;
export type ExpectedActiveCatalogManifestStateV1 = z.infer<
  typeof expectedActiveCatalogManifestStateV1Schema
>;

const operationEnvelopeShape = {
  schemaVersion: z.literal(CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION),
  operationId: catalogManifestOperationIdSchema,
  idempotencyKey: catalogManifestIdempotencyKeySchema,
} as const;

export const catalogManifestActiveStateRequestSchema = z.object({
  schemaVersion: z.literal(CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION),
  operationId: catalogManifestOperationIdSchema,
}).strict();

function validateManifestObservationBinding(
  manifest: GlobalCatalogManifestV1,
  observation: GlobalCatalogAggregateObservationV1,
  context: z.RefinementCtx,
): void {
  if (
    manifest.providerReferenceSetHash !==
      observation.providerReferenceSetHash ||
    manifest.publicReleaseId !== observation.publicReleaseId ||
    manifest.providerReferences.length !==
      observation.providerSelections.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["observation"],
      message: "catalog_manifest_publication.manifest_observation_mismatch",
    });
    return;
  }
  manifest.providerReferences.forEach((reference, index) => {
    const provider = observation.providerSelections[index];
    if (
      provider === undefined ||
      provider.platformKey !== reference.platformKey ||
      provider.publicProviderReleaseId !==
        reference.publicProviderReleaseId ||
      provider.selectedDataAsOf !== reference.dataAsOf ||
      BigInt(reference.sharedConfigurationEpoch.publicChangeSequence) >
        BigInt(provider.selectedProviderCheckpoint.settledSequence)
    ) {
      context.addIssue({
        code: "custom",
        path: ["observation", "providerSelections", index],
        message: "catalog_manifest_publication.provider_observation_mismatch",
      });
    }
  });
}

function validateObservationAdvance(
  expected: ActiveCatalogManifestStateV1,
  observation: GlobalCatalogAggregateObservationV1,
  context: z.RefinementCtx,
): void {
  const previousSequence = expected.observation?.observationSequence ?? 0;
  if (observation.observationSequence <= previousSequence) {
    context.addIssue({
      code: "custom",
      path: ["observation", "observationSequence"],
      message: "catalog_manifest_publication.observation_not_advanced",
    });
  }
}

function validateProtectedFields(
  value: unknown,
  context: z.RefinementCtx,
): void {
  if (containsProtectedCatalogManifestPublicationField(value)) {
    context.addIssue({
      code: "custom",
      message: "catalog_manifest_publication.protected_field",
    });
  }
}

export const catalogManifestActivateRequestSchema = z.object({
  ...operationEnvelopeShape,
  manifest: globalCatalogManifestV1Schema,
  observation: globalCatalogAggregateObservationV1Schema,
  expectedActiveState: expectedActiveCatalogManifestStateV1Schema,
}).strict().superRefine((request, context) => {
  if (
    request.expectedActiveState.activeManifest?.publicReleaseId ===
      request.manifest.publicReleaseId
  ) {
    context.addIssue({
      code: "custom",
      path: ["manifest", "publicReleaseId"],
      message: "catalog_manifest_publication.reference_set_unchanged",
    });
  }
  validateManifestObservationBinding(
    request.manifest,
    request.observation,
    context,
  );
  validateObservationAdvance(
    request.expectedActiveState,
    request.observation,
    context,
  );
  validateProtectedFields(request, context);
});

export const catalogManifestRefreshActiveStateRequestSchema = z.object({
  ...operationEnvelopeShape,
  manifest: globalCatalogManifestIdentityV1Schema,
  observation: globalCatalogAggregateObservationV1Schema,
  expectedActiveState: expectedActiveCatalogManifestStateV1Schema,
}).strict().superRefine((request, context) => {
  const active = request.expectedActiveState.activeManifest;
  if (
    active === null ||
    canonicalJson(request.manifest) !== canonicalJson({
      publicReleaseId: active.publicReleaseId,
      manifestFingerprint: active.manifestFingerprint,
      sharedConfigurationEpoch: active.sharedConfigurationEpoch,
      providerReferenceSetHash: active.providerReferenceSetHash,
    }) ||
    request.observation.providerReferenceSetHash !==
      request.manifest.providerReferenceSetHash ||
    request.observation.publicReleaseId !== request.manifest.publicReleaseId
  ) {
    context.addIssue({
      code: "custom",
      path: ["manifest"],
      message: "catalog_manifest_publication.refresh_manifest_mismatch",
    });
  }
  validateObservationAdvance(
    request.expectedActiveState,
    request.observation,
    context,
  );
  validateProtectedFields(request, context);
});

export const catalogManifestRollbackTargetV1Schema =
  globalCatalogManifestIdentityV1Schema;

const rollbackBaseShape = {
  ...operationEnvelopeShape,
  expectedActiveState: expectedActiveCatalogManifestStateV1Schema,
} as const;

export const catalogManifestRollbackToManifestRequestSchema = z.object({
  ...rollbackBaseShape,
  rollbackKind: z.literal("manifest"),
  targetManifest: catalogManifestRollbackTargetV1Schema,
  observation: globalCatalogAggregateObservationV1Schema,
}).strict().superRefine((request, context) => {
  if (
    request.expectedActiveState.activeManifest === null ||
    request.targetManifest.publicReleaseId ===
      request.expectedActiveState.activeManifest.publicReleaseId ||
    request.observation.providerReferenceSetHash !==
      request.targetManifest.providerReferenceSetHash ||
    request.observation.publicReleaseId !==
      request.targetManifest.publicReleaseId
  ) {
    context.addIssue({
      code: "custom",
      path: ["targetManifest"],
      message: "catalog_manifest_publication.rollback_target_invalid",
    });
  }
  validateObservationAdvance(
    request.expectedActiveState,
    request.observation,
    context,
  );
  validateProtectedFields(request, context);
});

export const catalogManifestAuthorizedClearRequestSchema = z.object({
  ...rollbackBaseShape,
  rollbackKind: z.literal("clear"),
  clearAuthorization: z.literal("clear_catalog_manifest_v1"),
}).strict().superRefine((request, context) => {
  if (request.expectedActiveState.activeManifest === null) {
    context.addIssue({
      code: "custom",
      path: ["expectedActiveState", "activeManifest"],
      message: "catalog_manifest_publication.clear_requires_active_manifest",
    });
  }
  validateProtectedFields(request, context);
});

export const catalogManifestRollbackRequestSchema = z.discriminatedUnion(
  "rollbackKind",
  [
    catalogManifestRollbackToManifestRequestSchema,
    catalogManifestAuthorizedClearRequestSchema,
  ],
);

export const CATALOG_MANIFEST_BLOCK_REASONS = [
  "MANIFEST_ASSEMBLY_INVALID",
  "MANIFEST_PLATFORM_SET_INVALID",
  "MANIFEST_PROVIDER_RELEASE_INVALID",
  "MANIFEST_CONFIGURATION_EPOCH_INVALID",
  "MANIFEST_AGGREGATE_LIMIT_EXCEEDED",
  "MANIFEST_CONTENT_INVALID",
  "MANIFEST_SEARCH_INVALID",
  "MANIFEST_REFERENCE_INVALID",
  "MANIFEST_OWNERSHIP_INVALID",
  "MANIFEST_PREDECESSOR_CONFLICT",
  "MANIFEST_RECONCILIATION_FAILED",
  "MANIFEST_SECURITY_INVALID",
] as const;

export const catalogManifestBlockReasonV1Schema = z.enum(
  CATALOG_MANIFEST_BLOCK_REASONS,
).refine((reason) => reason.length <= MAX_CATALOG_MANIFEST_BLOCK_REASON_LENGTH, {
  message: "catalog_manifest_publication.block_reason_too_long",
});

export const catalogManifestBlockRequestSchema = z.object({
  ...operationEnvelopeShape,
  publicReleaseId: publicProviderReleaseIdV1Schema,
  manifestFingerprint: sha256Schema,
  blockSequence: providerCatalogSequenceV1Schema,
  reason: catalogManifestBlockReasonV1Schema,
}).strict().superRefine(validateProtectedFields);

export const catalogManifestStatusOperationKindSchema = z.enum([
  "activateManifest",
  "refreshActiveState",
  "rollback",
  "block",
]);

const statusTargetBaseShape = {
  operationKind: catalogManifestStatusOperationKindSchema,
  operationId: catalogManifestOperationIdSchema,
  idempotencyKey: catalogManifestIdempotencyKeySchema,
  requestDigest: sha256Schema,
} as const;

export const catalogManifestStatusTargetSchema = z.union([
  z.object({
    ...statusTargetBaseShape,
    operationKind: z.enum([
      "activateManifest", "refreshActiveState", "block",
    ]),
    publicReleaseId: publicProviderReleaseIdV1Schema,
    manifestFingerprint: sha256Schema,
  }).strict(),
  z.object({
    ...statusTargetBaseShape,
    operationKind: z.literal("rollback"),
    rollbackKind: z.literal("manifest"),
    publicReleaseId: publicProviderReleaseIdV1Schema,
    manifestFingerprint: sha256Schema,
  }).strict(),
  z.object({
    ...statusTargetBaseShape,
    operationKind: z.literal("rollback"),
    rollbackKind: z.literal("clear"),
    publicReleaseId: z.null(),
    manifestFingerprint: z.null(),
  }).strict(),
]);

export const catalogManifestStatusRequestSchema = z.object({
  schemaVersion: z.literal(CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION),
  target: catalogManifestStatusTargetSchema,
}).strict();

export const catalogManifestMutationRequestSchema = z.union([
  catalogManifestActivateRequestSchema,
  catalogManifestRefreshActiveStateRequestSchema,
  catalogManifestRollbackRequestSchema,
  catalogManifestBlockRequestSchema,
]);

export const catalogManifestRequestSchema = z.union([
  catalogManifestActiveStateRequestSchema,
  catalogManifestStatusRequestSchema,
  catalogManifestMutationRequestSchema,
]);

export type CatalogManifestActivateRequest = z.infer<
  typeof catalogManifestActivateRequestSchema
>;
export type CatalogManifestActiveStateRequest = z.infer<
  typeof catalogManifestActiveStateRequestSchema
>;
export type CatalogManifestRefreshActiveStateRequest = z.infer<
  typeof catalogManifestRefreshActiveStateRequestSchema
>;
export type CatalogManifestRollbackToManifestRequest = z.infer<
  typeof catalogManifestRollbackToManifestRequestSchema
>;
export type CatalogManifestAuthorizedClearRequest = z.infer<
  typeof catalogManifestAuthorizedClearRequestSchema
>;
export type CatalogManifestRollbackRequest = z.infer<
  typeof catalogManifestRollbackRequestSchema
>;
export type CatalogManifestBlockReasonV1 = z.infer<
  typeof catalogManifestBlockReasonV1Schema
>;
export type CatalogManifestBlockRequest = z.infer<
  typeof catalogManifestBlockRequestSchema
>;
export type CatalogManifestStatusOperationKind = z.infer<
  typeof catalogManifestStatusOperationKindSchema
>;
export type CatalogManifestStatusTarget = z.infer<
  typeof catalogManifestStatusTargetSchema
>;
export type CatalogManifestStatusRequest = z.infer<
  typeof catalogManifestStatusRequestSchema
>;
export type CatalogManifestMutationRequest = z.infer<
  typeof catalogManifestMutationRequestSchema
>;
export type CatalogManifestRequest = z.infer<
  typeof catalogManifestRequestSchema
>;

export function containsProtectedCatalogManifestPublicationField(
  value: unknown,
): boolean {
  return containsProtectedProviderCatalogReleaseField(value);
}

export async function catalogManifestPublicationRequestDigest(
  request: unknown,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(request)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function catalogManifestPublicationCanonicalByteCount(
  value: unknown,
): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

export function parseCatalogManifestPublicationJson<T>(
  bodyJson: string,
  schema: z.ZodType<T>,
): T | null {
  if (
    new TextEncoder().encode(bodyJson).byteLength >
      MAX_CATALOG_MANIFEST_PUBLICATION_BODY_BYTES
  ) {
    return null;
  }
  try {
    const value = JSON.parse(bodyJson) as unknown;
    if (containsProtectedCatalogManifestPublicationField(value)) return null;
    const parsed = schema.parse(value);
    return bodyJson === canonicalJson(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function dataReleaseMetadataFromGlobalCatalogManifestV1(
  manifest: GlobalCatalogManifestV1,
  state: ActiveCatalogManifestStateV1,
): DataReleaseMetadata {
  const active = state.activeManifest;
  const observation = state.observation;
  if (
    active === null || observation === null ||
    active.publicReleaseId !== manifest.publicReleaseId ||
    active.manifestFingerprint !== manifest.manifestFingerprint ||
    active.providerReferenceSetHash !== manifest.providerReferenceSetHash ||
    canonicalJson(active.sharedConfigurationEpoch) !==
      canonicalJson(manifest.sharedConfigurationEpoch)
  ) {
    throw new TypeError("Active catalog manifest state does not match manifest.");
  }
  return dataReleaseMetadataSchema.parse({
    schemaVersion: "data_release_v2",
    dataSource: manifest.dataSource,
    publicReleaseId: manifest.publicReleaseId,
    sourceWatermark: observation.sourceWatermark,
    manifestFingerprint: manifest.manifestFingerprint,
    contentHash: manifest.contentHash,
    publicConfigRevision: manifest.sharedConfigurationEpoch.revision,
    publicConfigHash: manifest.sharedConfigurationEpoch.configurationHash,
    originSetHash: manifest.governingHashes.originSetHash,
    searchAlgorithmVersion: manifest.searchAlgorithmVersion,
    repackSearchIndexHash: manifest.repackSearchIndexHash,
    confidencePolicyVersion: manifest.confidencePolicyVersion,
    createdAt: active.createdAt,
    completedAt: active.completedAt,
    dataAsOf: observation.dataAsOf,
    lastSuccessfulObservationAt: observation.lastSuccessfulObservationAt,
    staleAt: observation.staleAt,
    freshness: observation.freshness,
    delayedVendorCount: observation.delayedProviderCount,
    vendorCount: manifest.counts.vendors,
    categoryCount: manifest.counts.categories,
    repackCount: manifest.counts.repacks,
    collectibleCount: manifest.counts.collectibles,
    repackChaseCount: manifest.counts.repackChases,
  });
}

export { GLOBAL_CATALOG_MANIFEST_SCHEMA_VERSION };
