import { createHash } from "node:crypto";
import {
  PROVIDER_OBSERVATION_HASH_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  canonicalKindByLaunchScope,
  normalizedObservationSemanticContent,
  normalizedObservationSemanticContentSchema,
  normalizedObservationSemanticCanonicalJson,
  normalizedProviderObservationSchema,
  normalizedProviderObservationPageSchema,
  providerSourceExpectedCanonicalRelationships,
  providerSourceCanonicalContentV1Schemas,
  type LaunchProviderKey,
  type ProviderSourceCanonicalProjectionPlan,
  type ProviderSourceCanonicalRelationshipPlan,
  type NormalizedObservationSemanticContent,
  type NormalizedProviderObservation,
  type NormalizedProviderObservationPage,
  type ProviderSourcePagePlan,
  type ProviderSourcePlannedOutcome,
} from "@packscout/contracts";
import type {
  CanonicalEvInputCandidate,
  CanonicalProviderCandidate,
  ProviderObservationMapper,
  ProviderObservationMappingOutcome,
} from "./provider-observation-mapper.ts";
import { fingerprintCanonicalProviderCandidate } from "./provider-observation-mapper.ts";
import { canonicalProviderObservationContent } from "./provider-observation-canonical-content.ts";
import { isCompletedNormalizedProviderObservationPage } from
  "./source-adapter-completed-page-capability.ts";

export type ProviderSourcePagePlanningErrorCode =
  | "mapper_descriptor_mismatch"
  | "normalized_page_mismatch"
  | "normalized_page_invalid";

export class ProviderSourcePagePlanningError extends Error {
  constructor(readonly code: ProviderSourcePagePlanningErrorCode) {
    super(`provider_source_page_planner.${code}`);
    this.name = "ProviderSourcePagePlanningError";
  }
}

export interface ProviderObservationMapperResolver {
  resolve(input: {
    readonly mapperKey: string;
    readonly mapperVersion: string;
    readonly provider: LaunchProviderKey;
    readonly normalizedContractVersion: string;
    readonly identityNamespaceKey: string;
  }): ProviderObservationMapper;
}

const mapperQuarantineReasons = new Set([
  "availability_contradiction",
  "mapper_input_incompatible",
  "pack_display_name_required",
  "platform_mismatch",
]);
const mapperWarningCodes = new Set([
  "future_event_code",
  "malformed_authoritative_availability",
  "malformed_buyback_percent",
  "malformed_category",
  "malformed_description",
  "malformed_display_name",
  "malformed_draw_count",
  "malformed_estimated_value",
  "malformed_ev_input",
  "malformed_image_references",
  "malformed_price",
  "malformed_provider_reported_ev",
  "malformed_value",
  "malformed_value_source",
  "ev_input_unavailable",
]);
const primaryCandidateKinds = new Set([
  "pack",
  "catalog_asset",
  "pull",
  "market_event",
]);
const sha256Pattern = /^[a-f0-9]{64}$/u;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function hasExactRuntimeKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isMapperRuntimeOutput(
  value: unknown,
): value is ProviderObservationMappingOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const mapped = value as Record<string, unknown>;
  if (
    !Array.isArray(mapped.warnings) ||
    mapped.warnings.some(
      (warning) =>
        typeof warning !== "object" ||
        warning === null ||
        Array.isArray(warning) ||
        !hasExactRuntimeKeys(
          warning as Record<string, unknown>,
          ["code", "fieldPath"],
        ) ||
        typeof (warning as Record<string, unknown>).code !== "string" ||
        !mapperWarningCodes.has(
          (warning as Record<string, unknown>).code as string,
        ) ||
        typeof (warning as Record<string, unknown>).fieldPath !== "string",
    )
  ) return false;
  if (mapped.status === "quarantined") {
    return hasExactRuntimeKeys(
      mapped,
      ["protectedNativeEvidenceRef", "reasonCode", "status", "warnings"],
    ) &&
      typeof mapped.protectedNativeEvidenceRef === "string" &&
      mapped.protectedNativeEvidenceRef.length > 0 &&
      typeof mapped.reasonCode === "string" &&
      mapperQuarantineReasons.has(mapped.reasonCode);
  }
  if (mapped.status !== "mapped") return false;
  if (
    !hasExactRuntimeKeys(mapped, [
      "candidate",
      "evInputCandidate",
      "evInputStatus",
      "evRecomputationImpact",
      "protectedNativeEvidenceRef",
      "protectedTransactionEvidenceRef",
      "status",
      "warnings",
    ]) ||
    typeof mapped.protectedNativeEvidenceRef !== "string" ||
    mapped.protectedNativeEvidenceRef.length === 0 ||
    (mapped.protectedTransactionEvidenceRef !== null &&
      typeof mapped.protectedTransactionEvidenceRef !== "string") ||
    (mapped.evRecomputationImpact !== null &&
      (typeof mapped.evRecomputationImpact !== "object" ||
        Array.isArray(mapped.evRecomputationImpact)))
  ) return false;
  const candidate = mapped.candidate;
  const candidateKind = typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>).candidateKind
    : null;
  if (typeof candidateKind !== "string" || !primaryCandidateKinds.has(candidateKind)) {
    return false;
  }
  const evInputCandidate = mapped.evInputCandidate;
  const validEvInputCandidate = evInputCandidate === null ||
    (typeof evInputCandidate === "object" &&
      evInputCandidate !== null &&
      !Array.isArray(evInputCandidate) &&
      (evInputCandidate as Record<string, unknown>).candidateKind === "ev_input");
  if (!validEvInputCandidate) return false;
  return candidateKind === "pack"
    ? (mapped.evInputStatus === "ready") === (evInputCandidate !== null)
    : mapped.evInputStatus === "not_applicable" && evInputCandidate === null;
}

export function providerObservationMappingOutcomeFromRuntime(
  value: unknown,
): ProviderObservationMappingOutcome {
  if (!isMapperRuntimeOutput(value)) {
    throw new TypeError("provider_source.mapper_output_invalid");
  }
  return value;
}

export interface ProviderSourceMappingValidationContext {
  readonly organizationId: string;
  readonly providerId: string;
  readonly provider: LaunchProviderKey;
  readonly normalizedContractVersion: string;
  readonly observation: NormalizedProviderObservation;
}

function assertExactCanonicalIdentity(
  value: unknown,
  input: ProviderSourceMappingValidationContext,
  canonicalKind: string,
  providerRecordId: string,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasExactRuntimeKeys(value as Record<string, unknown>, [
      "canonicalKind",
      "organizationId",
      "provider",
      "providerId",
      "providerRecordId",
    ])
  ) {
    throw new TypeError("provider_source.mapper_identity_invalid");
  }
  const identity = value as Record<string, unknown>;
  if (
    identity.organizationId !== input.organizationId ||
    identity.providerId !== input.providerId ||
    identity.provider !== input.provider ||
    identity.canonicalKind !== canonicalKind ||
    identity.providerRecordId !== providerRecordId
  ) {
    throw new TypeError("provider_source.mapper_identity_invalid");
  }
}

function assertProjection(
  projection: ProviderSourceCanonicalProjectionPlan,
  input: ProviderSourceMappingValidationContext,
  observation: NormalizedProviderObservation,
  projectionKind: "primary" | "derived_ev_input",
): void {
  if (!hasExactRuntimeKeys(projection as unknown as Record<string, unknown>, [
    "affectedPackProviderRecordId",
    "content",
    "contentFingerprint",
    "effectiveAt",
    "evInputStatus",
    "platformKey",
    "projectionKind",
    "providerRecordId",
    "recordIdScopeKey",
    "recordKind",
    "relationships",
  ])) {
    throw new TypeError("provider_source.mapper_projection_invalid");
  }
  const expectedPrimaryKind =
    canonicalKindByLaunchScope[
      observation.providerRecordIdentity.recordIdScopeKey
    ];
  const expectedKind = projectionKind === "primary"
    ? expectedPrimaryKind
    : "ev_input";
  const expectedScope = observation.providerRecordIdentity.recordIdScopeKey;
  if (
    projection.projectionKind !== projectionKind ||
    projection.platformKey !== input.provider ||
    projection.recordKind !== expectedKind ||
    projection.providerRecordId !==
      observation.providerRecordIdentity.providerRecordId ||
    projection.recordIdScopeKey !== expectedScope ||
    projection.effectiveAt !== observation.effectiveAt ||
    !sha256Pattern.test(projection.contentFingerprint) ||
    !Array.isArray(projection.relationships)
  ) {
    throw new TypeError("provider_source.mapper_projection_invalid");
  }
  const schema = providerSourceCanonicalContentV1Schemas[expectedKind];
  schema.parse(projection.content);
  for (const relationship of projection.relationships) {
    if (!hasExactRuntimeKeys(
      relationship as unknown as Record<string, unknown>,
      [
        "relationship",
        "targetCanonicalKind",
        "targetProviderRecordId",
        "targetRecordIdScopeKey",
      ],
    )) {
      throw new TypeError("provider_source.mapper_relationship_invalid");
    }
    const expectedRelationshipKind = relationship.relationship === "pack"
      ? "pack"
      : relationship.relationship === "card"
        ? "catalog_asset"
        : projectionKind === "derived_ev_input" &&
            relationship.relationship === "supports_pack"
          ? "pack"
          : null;
    const expectedRelationshipScope = expectedRelationshipKind === "pack"
      ? "catalog-pack-v1"
      : expectedRelationshipKind === "catalog_asset"
        ? "catalog-card-v1"
        : null;
    if (
      expectedRelationshipKind === null ||
      relationship.targetCanonicalKind !== expectedRelationshipKind ||
      relationship.targetRecordIdScopeKey !== expectedRelationshipScope ||
      typeof relationship.targetProviderRecordId !== "string" ||
      relationship.targetProviderRecordId.trim().length === 0
    ) {
      throw new TypeError("provider_source.mapper_relationship_invalid");
    }
  }
  const semanticContent = normalizedSemanticContentForVersion(
    observation,
    input.normalizedContractVersion,
  );
  if (
    input.normalizedContractVersion !== PROVIDER_OBSERVATION_CONTRACT_VERSION
  ) {
    throw new TypeError("provider_source.normalized_contract_invalid");
  }
  const expectedRelationships = providerSourceExpectedCanonicalRelationships({
    semanticContent:
      normalizedObservationSemanticContentSchema.parse(semanticContent),
    projectionKind,
  });
  const relationshipKey = (
    relationship: ProviderSourceCanonicalRelationshipPlan,
  ) => JSON.stringify([
    relationship.relationship,
    relationship.targetRecordIdScopeKey,
    relationship.targetCanonicalKind,
    relationship.targetProviderRecordId,
  ]);
  const actualKeys = projection.relationships.map(relationshipKey).sort();
  const expectedKeys = expectedRelationships.map(relationshipKey).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError("provider_source.mapper_relationship_lineage_invalid");
  }
}

function projectionsForValidatedMapping(
  mapped: Extract<ProviderObservationMappingOutcome, { status: "mapped" }>,
  input: ProviderSourceMappingValidationContext,
): readonly ProviderSourceCanonicalProjectionPlan[] {
  const { observation } = input;
  const candidate = mapped.candidate;
  const providerRecordId = observation.providerRecordIdentity.providerRecordId;
  const expectedKind =
    canonicalKindByLaunchScope[
      observation.providerRecordIdentity.recordIdScopeKey
    ];
  if (
    candidate.candidateKind !== expectedKind ||
    candidate.recordIdScopeKey !==
      observation.providerRecordIdentity.recordIdScopeKey ||
    candidate.effectiveAt !== observation.effectiveAt
  ) {
    throw new TypeError("provider_source.mapper_candidate_invalid");
  }
  if (
    candidate.candidateKind === "pack" &&
    candidate.evInputStatus !== mapped.evInputStatus
  ) {
    throw new TypeError("provider_source.mapper_ev_input_invalid");
  }
  assertExactCanonicalIdentity(
    candidate.identity,
    input,
    expectedKind,
    providerRecordId,
  );
  if (
    mapped.protectedNativeEvidenceRef !==
      observation.protectedNativeEvidenceRef ||
    mapped.protectedTransactionEvidenceRef !==
      (observation.kind === "trade"
        ? observation.protectedTransactionEvidenceRef
        : null)
  ) {
    throw new TypeError("provider_source.mapper_evidence_binding_invalid");
  }

  if (candidate.candidateKind === "pack") {
    const impact = mapped.evRecomputationImpact;
    if (
      !impact ||
      impact.kind !== "pack" ||
      !hasExactRuntimeKeys(impact as unknown as Record<string, unknown>, [
        "affectedPack",
        "kind",
      ])
    ) {
      throw new TypeError("provider_source.mapper_impact_invalid");
    }
    assertExactCanonicalIdentity(
      impact.affectedPack,
      input,
      "pack",
      providerRecordId,
    );
  } else if (candidate.candidateKind === "catalog_asset") {
    const impact = mapped.evRecomputationImpact;
    if (
      !impact ||
      impact.kind !== "catalog_asset" ||
      !hasExactRuntimeKeys(impact as unknown as Record<string, unknown>, [
        "affectedCatalogAsset",
        "kind",
      ])
    ) {
      throw new TypeError("provider_source.mapper_impact_invalid");
    }
    assertExactCanonicalIdentity(
      impact.affectedCatalogAsset,
      input,
      "catalog_asset",
      providerRecordId,
    );
  } else if (mapped.evRecomputationImpact !== null) {
    throw new TypeError("provider_source.mapper_impact_invalid");
  }

  if (mapped.evInputCandidate) {
    const evInput = mapped.evInputCandidate;
    if (
      candidate.candidateKind !== "pack" ||
      evInput.recordIdScopeKey !== "catalog-pack-v1" ||
      evInput.effectiveAt !== observation.effectiveAt
    ) {
      throw new TypeError("provider_source.mapper_ev_input_invalid");
    }
    assertExactCanonicalIdentity(
      evInput.identity,
      input,
      "ev_input",
      providerRecordId,
    );
    assertExactCanonicalIdentity(
      evInput.affectedPack,
      input,
      "pack",
      providerRecordId,
    );
  }

  const projections = providerSourceCanonicalProjectionsForMapping(mapped);
  if (projections.length !== (mapped.evInputCandidate ? 2 : 1)) {
    throw new TypeError("provider_source.mapper_projection_invalid");
  }
  assertProjection(projections[0]!, input, observation, "primary");
  if (projections[1]) {
    assertProjection(projections[1], input, observation, "derived_ev_input");
  }
  return projections;
}

export interface ProviderSourcePagePlanningInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly provider: LaunchProviderKey;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly normalizedContractVersion: string;
  readonly identityNamespaceKey: string;
  readonly page: NormalizedProviderObservationPage;
}

function normalizedSemanticContentForVersion(
  observation: NormalizedProviderObservation,
  normalizedContractVersion: string,
): NormalizedObservationSemanticContent {
  if (normalizedContractVersion === PROVIDER_OBSERVATION_CONTRACT_VERSION) {
    return normalizedObservationSemanticContent(
      normalizedProviderObservationSchema.parse(observation),
    );
  }
  throw new TypeError("provider_source.normalized_contract_invalid");
}

function semanticHash(
  content: NormalizedObservationSemanticContent,
  normalizedContractVersion: string,
): string {
  if (normalizedContractVersion !== PROVIDER_OBSERVATION_CONTRACT_VERSION) {
    throw new TypeError("provider_source.normalized_contract_invalid");
  }
  const canonicalJson = normalizedObservationSemanticCanonicalJson(content);
  return createHash("sha256")
    .update(canonicalJson)
    .digest("hex");
}

function relationshipsFor(
  candidate: CanonicalProviderCandidate | CanonicalEvInputCandidate,
): readonly ProviderSourceCanonicalRelationshipPlan[] {
  if (candidate.candidateKind === "ev_input") {
    return Object.freeze([
      Object.freeze({
        relationship: "supports_pack" as const,
        targetRecordIdScopeKey: "catalog-pack-v1" as const,
        targetCanonicalKind: "pack" as const,
        targetProviderRecordId: candidate.affectedPack.providerRecordId,
      }),
    ]);
  }
  if (
    candidate.candidateKind !== "pull" &&
    candidate.candidateKind !== "market_event"
  ) {
    return Object.freeze([]);
  }
  return Object.freeze(
    candidate.relationships.map((relationship) =>
      Object.freeze({ ...relationship }),
    ),
  );
}

function projectionFor(
  candidate: CanonicalProviderCandidate | CanonicalEvInputCandidate,
  projectionKind: ProviderSourceCanonicalProjectionPlan["projectionKind"],
  evInputStatus: ProviderSourceCanonicalProjectionPlan["evInputStatus"],
): ProviderSourceCanonicalProjectionPlan {
  return Object.freeze({
    projectionKind,
    platformKey: candidate.identity.provider,
    recordKind: candidate.candidateKind,
    providerRecordId: candidate.identity.providerRecordId,
    recordIdScopeKey: candidate.recordIdScopeKey,
    effectiveAt: candidate.effectiveAt,
    contentFingerprint: fingerprintCanonicalProviderCandidate(candidate),
    content: canonicalProviderObservationContent(candidate),
    relationships: relationshipsFor(candidate),
    affectedPackProviderRecordId:
      candidate.candidateKind === "pack"
        ? candidate.identity.providerRecordId
        : candidate.candidateKind === "ev_input"
          ? candidate.affectedPack.providerRecordId
          : null,
    evInputStatus,
  });
}

export function providerSourceCanonicalProjectionsForMapping(
  outcome: Extract<ProviderObservationMappingOutcome, { status: "mapped" }>,
): readonly ProviderSourceCanonicalProjectionPlan[] {
  const projections = [
    projectionFor(outcome.candidate, "primary", outcome.evInputStatus),
  ];
  if (outcome.evInputCandidate) {
    projections.push(
      projectionFor(outcome.evInputCandidate, "derived_ev_input", "ready"),
    );
  }
  return Object.freeze(projections);
}

export function providerSourceCanonicalProjectionsForValidatedMapping(
  value: unknown,
  input: ProviderSourceMappingValidationContext,
): readonly ProviderSourceCanonicalProjectionPlan[] {
  const mapped = providerObservationMappingOutcomeFromRuntime(value);
  if (mapped.status !== "mapped") {
    throw new TypeError("provider_source.mapper_output_not_mapped");
  }
  return projectionsForValidatedMapping(mapped, input);
}

function sourceKindCounts(page: NormalizedProviderObservationPage) {
  let catalog = 0;
  let pulls = 0;
  let trades = 0;
  for (const outcome of page.outcomes) {
    if (outcome.status !== "valid") continue;
    if (outcome.observation.kind === "catalog") catalog += 1;
    else if (outcome.observation.kind === "pull") pulls += 1;
    else trades += 1;
  }
  return { catalog, pulls, trades };
}

/**
 * Maps only normalized observations. Protected native evidence and transport
 * fields are intentionally absent from the mapper input.
 */
export class ProviderSourcePagePlanner {
  constructor(private readonly mappers: ProviderObservationMapperResolver) {}

  plan(input: ProviderSourcePagePlanningInput): ProviderSourcePagePlan {
    let page: NormalizedProviderObservationPage;
    try {
      if (
        input.normalizedContractVersion !==
          PROVIDER_OBSERVATION_CONTRACT_VERSION
      ) {
        throw new TypeError("provider_source.normalized_contract_invalid");
      }
      page = isCompletedNormalizedProviderObservationPage(input.page)
        ? input.page
        : deepFreeze(normalizedProviderObservationPageSchema.parse(input.page));
    } catch {
      throw new ProviderSourcePagePlanningError("normalized_page_invalid");
    }
    if (
      page.provider !== input.provider ||
      page.normalizedContractVersion !== input.normalizedContractVersion
    ) {
      throw new ProviderSourcePagePlanningError("normalized_page_mismatch");
    }

    let mapper: ProviderObservationMapper;
    try {
      mapper = this.mappers.resolve({
        mapperKey: input.mapperKey,
        mapperVersion: input.mapperVersion,
        provider: input.provider,
        normalizedContractVersion: input.normalizedContractVersion,
        identityNamespaceKey: input.identityNamespaceKey,
      });
    } catch {
      throw new ProviderSourcePagePlanningError("mapper_descriptor_mismatch");
    }

    let adapterInvalid = 0;
    let mapperQuarantined = 0;
    let warnings = 0;
    const outcomes: ProviderSourcePlannedOutcome[] = page.outcomes.map(
      (outcome): ProviderSourcePlannedOutcome => {
        if (outcome.status === "invalid") {
          adapterInvalid += 1;
          return Object.freeze({
            kind: "adapter_invalid",
            recordIndex: outcome.recordIndex,
            protectedNativeEvidenceRef: outcome.protectedNativeEvidenceRef,
            reasonCode: outcome.reasonCode,
            fieldPaths: Object.freeze([...outcome.fieldPaths]),
          });
        }

        const observation = outcome.observation;
        const semanticContent = normalizedSemanticContentForVersion(
          observation,
          input.normalizedContractVersion,
        );
        try {
          const mapperOutput: unknown = mapper.map({
            organizationId: input.organizationId,
            providerId: input.providerId,
            provider: input.provider,
            mapperKey: input.mapperKey,
            mapperVersion: input.mapperVersion,
            normalizedContractVersion: input.normalizedContractVersion,
            identityNamespaceKey: input.identityNamespaceKey,
            observation,
          });
          const mapped = providerObservationMappingOutcomeFromRuntime(
            mapperOutput,
          );
          const common = {
            kind: "semantic" as const,
            recordIndex: outcome.recordIndex,
            observation,
            semanticContent,
            normalizedContentHash: semanticHash(
              semanticContent,
              input.normalizedContractVersion,
            ),
            protectedNativeEvidenceRef:
              observation.protectedNativeEvidenceRef,
            protectedTransactionEvidenceRef:
              observation.kind === "trade"
                ? observation.protectedTransactionEvidenceRef
                : null,
            warnings: Object.freeze(
              mapped.warnings.map((warning) => Object.freeze({ ...warning })),
            ),
          };
          if (mapped.status === "quarantined") {
            if (
              mapped.protectedNativeEvidenceRef !==
                observation.protectedNativeEvidenceRef
            ) {
              throw new TypeError("provider_source.mapper_evidence_binding_invalid");
            }
            mapperQuarantined += 1;
            warnings += mapped.warnings.length;
            return Object.freeze({
              ...common,
              mapping: Object.freeze({
                status: "quarantined" as const,
                reasonCode: mapped.reasonCode,
              }),
            });
          }
          const projections = providerSourceCanonicalProjectionsForValidatedMapping(
            mapped,
            { ...input, observation },
          );
          warnings += mapped.warnings.length;
          return Object.freeze({
            ...common,
            mapping: Object.freeze({
              status: "mapped" as const,
              projections,
            }),
          });
        } catch {
          mapperQuarantined += 1;
          return Object.freeze({
            kind: "semantic",
            recordIndex: outcome.recordIndex,
            observation,
            semanticContent,
            normalizedContentHash: semanticHash(
              semanticContent,
              input.normalizedContractVersion,
            ),
            protectedNativeEvidenceRef:
              observation.protectedNativeEvidenceRef,
            protectedTransactionEvidenceRef:
              observation.kind === "trade"
                ? observation.protectedTransactionEvidenceRef
                : null,
            warnings: Object.freeze([]),
            mapping: Object.freeze({
              status: "quarantined" as const,
              reasonCode: "mapping_failure",
            }),
          });
        }
      },
    );
    const kinds = sourceKindCounts(page);
    return Object.freeze({
      normalizedPage: page,
      outcomes: Object.freeze(outcomes),
      counts: Object.freeze({
        ...kinds,
        adapterInvalid,
        mapperQuarantined,
        warnings,
      }),
    }) as ProviderSourcePagePlan;
  }
}

export {
  PROVIDER_OBSERVATION_HASH_VERSION,
};
