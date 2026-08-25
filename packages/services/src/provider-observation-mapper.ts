import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  canonicalKindByLaunchScope,
  normalizedProviderObservationSchema,
  normalizedProviderObservationV2Schema,
  providerEventCodes,
  type LaunchProviderKey,
  type LaunchRecordIdScopeKey,
  type NormalizedProviderFacts,
  type NormalizedRelationshipIdentity,
  type ProviderCanonicalKind,
  type VersionedNormalizedProviderObservation,
} from "@packscout/contracts";
import { fingerprintCanonicalProviderContent } from "./provider-observation-canonical-content.ts";
import type { SourceMapperCompatibilityDescriptor } from "./source-mapper-descriptors.ts";

export type CanonicalCatalogAvailability =
  | "available"
  | "unavailable"
  | "unknown"
  | "sold_out";

export interface CanonicalProviderIdentity {
  readonly organizationId: string;
  readonly providerId: string;
  readonly provider: LaunchProviderKey;
  readonly canonicalKind: ProviderCanonicalKind;
  readonly providerRecordId: string;
}

export interface ProviderObservationMoney {
  readonly amount: number;
  readonly currency: string;
}

export interface MapperWarning {
  readonly code:
    | "future_event_code"
    | "malformed_authoritative_availability"
    | "malformed_buyback_percent"
    | "malformed_category"
    | "malformed_description"
    | "malformed_display_name"
    | "malformed_draw_count"
    | "malformed_estimated_value"
    | "malformed_ev_input"
    | "malformed_image_references"
    | "malformed_price"
    | "malformed_provider_reported_ev"
    | "malformed_value"
    | "malformed_value_source"
    | "ev_input_unavailable";
  readonly fieldPath: string;
}

export interface CanonicalRelationshipKey {
  readonly relationship: "pack" | "card";
  readonly targetRecordIdScopeKey: LaunchRecordIdScopeKey;
  readonly targetCanonicalKind: "pack" | "catalog_asset";
  readonly targetProviderRecordId: string;
}

interface CanonicalCandidateBase {
  readonly identity: CanonicalProviderIdentity;
  readonly recordIdScopeKey: LaunchRecordIdScopeKey;
  readonly effectiveAt: string;
}

export interface CanonicalObservationPackCandidate extends CanonicalCandidateBase {
  readonly candidateKind: "pack";
  readonly evInputStatus: "ready" | "unavailable";
  readonly firstSeenAt: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly imageReferences: readonly string[];
  readonly availability: CanonicalCatalogAvailability;
  readonly price: ProviderObservationMoney | null;
  readonly providerReportedEv: ProviderObservationMoney | null;
  readonly buybackPercent: number | null;
  readonly drawCount: number | null;
}

export interface CanonicalCatalogAssetCandidate extends CanonicalCandidateBase {
  readonly candidateKind: "catalog_asset";
  readonly assetType: "card";
  readonly firstSeenAt: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly category: string | null;
  readonly imageReferences: readonly string[];
  readonly availability: "available" | "unavailable" | "unknown";
  readonly estimatedValue: ProviderObservationMoney | null;
  readonly valueSource: string | null;
}

export interface CanonicalPullCandidate extends CanonicalCandidateBase {
  readonly candidateKind: "pull";
  readonly displayName: string | null;
  readonly imageReferences: readonly string[];
  readonly value: ProviderObservationMoney | null;
  readonly valueSource: string | null;
  readonly relationships: readonly CanonicalRelationshipKey[];
}

export interface CanonicalMarketEventCandidate extends CanonicalCandidateBase {
  readonly candidateKind: "market_event";
  readonly eventType: string;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly paymentMethod: string | null;
  readonly displayName: string | null;
  readonly imageReferences: readonly string[];
  readonly relationships: readonly CanonicalRelationshipKey[];
}

export interface CanonicalEvInputCandidate extends CanonicalCandidateBase {
  readonly candidateKind: "ev_input";
  readonly affectedPack: CanonicalProviderIdentity;
  readonly approved: true;
  readonly currency: string;
  readonly unitBasis: "per_draw" | "per_pack";
  readonly drawCount: number;
  readonly buybackPercent: number;
  readonly totalQuantity: number;
  readonly buckets: readonly {
    readonly bucketId: string;
    readonly label: string | null;
    readonly probability: number;
    readonly quantity: number;
    readonly lowerValue: number;
    readonly upperValue: number;
  }[];
}

export type CanonicalProviderCandidate =
  | CanonicalObservationPackCandidate
  | CanonicalCatalogAssetCandidate
  | CanonicalPullCandidate
  | CanonicalMarketEventCandidate;

export type EvRecomputationImpact =
  | {
      readonly kind: "pack";
      readonly affectedPack: CanonicalProviderIdentity;
    }
  | {
      readonly kind: "catalog_asset";
      readonly affectedCatalogAsset: CanonicalProviderIdentity;
    };

export type ProviderObservationMappingOutcome =
  | {
      readonly status: "mapped";
      readonly candidate: CanonicalProviderCandidate;
      readonly evInputCandidate: CanonicalEvInputCandidate | null;
      readonly evInputStatus: "ready" | "unavailable" | "not_applicable";
      readonly evRecomputationImpact: EvRecomputationImpact | null;
      readonly warnings: readonly MapperWarning[];
      /** Protected locator only. It is never part of canonical identity/content. */
      readonly protectedNativeEvidenceRef: string;
      /** Protected locator only. It is never part of market-event identity/content. */
      readonly protectedTransactionEvidenceRef: string | null;
    }
  | {
      readonly status: "quarantined";
      readonly reasonCode:
        | "availability_contradiction"
        | "mapper_input_incompatible"
        | "pack_display_name_required"
        | "platform_mismatch";
      readonly warnings: readonly MapperWarning[];
      readonly protectedNativeEvidenceRef: string;
    };

export interface ProviderObservationMapperInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly provider: LaunchProviderKey;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly normalizedContractVersion: string;
  readonly identityNamespaceKey: string;
  readonly observation: VersionedNormalizedProviderObservation;
}

export interface ProviderObservationMapper {
  readonly descriptor: SourceMapperCompatibilityDescriptor;
  map(input: ProviderObservationMapperInput): ProviderObservationMappingOutcome;
}

const knownEventCodes = new Set<string>(providerEventCodes);
const currencyTickerPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/u;

function canonicalIdentity(
  input: ProviderObservationMapperInput,
  canonicalKind: ProviderCanonicalKind,
  providerRecordId: string,
): CanonicalProviderIdentity {
  return Object.freeze({
    organizationId: input.organizationId,
    providerId: input.providerId,
    provider: input.provider,
    canonicalKind,
    providerRecordId,
  });
}

function warningForMalformedFact(
  state: string,
  code: MapperWarning["code"],
  fieldPath: string,
  warnings: MapperWarning[],
): void {
  if (state === "malformed") warnings.push(Object.freeze({ code, fieldPath }));
}

function textFact(
  fact: { readonly state: string; readonly value?: string },
  code: MapperWarning["code"],
  fieldPath: string,
  warnings: MapperWarning[],
): string | null {
  warningForMalformedFact(fact.state, code, fieldPath, warnings);
  return fact.state === "present" ? (fact.value ?? null) : null;
}

function imagesFact(
  fact: { readonly state: string; readonly value?: readonly string[] },
  warnings: MapperWarning[],
): readonly string[] {
  warningForMalformedFact(
    fact.state,
    "malformed_image_references",
    "providerFacts.imageReferences",
    warnings,
  );
  return fact.state === "present" ? Object.freeze([...(fact.value ?? [])]) : [];
}

function moneyFact(
  fact: {
    readonly state: string;
    readonly value?: { readonly amount: number; readonly currency: string };
  },
  code: MapperWarning["code"],
  fieldPath: string,
  warnings: MapperWarning[],
): ProviderObservationMoney | null {
  warningForMalformedFact(fact.state, code, fieldPath, warnings);
  if (
    fact.state !== "present" ||
    !fact.value ||
    fact.value.amount < 0 ||
    !currencyTickerPattern.test(fact.value.currency)
  ) {
    if (fact.state === "present") warnings.push(Object.freeze({ code, fieldPath }));
    return null;
  }
  return Object.freeze({ ...fact.value });
}

function numberFact(
  fact: { readonly state: string; readonly value?: number },
  code: MapperWarning["code"],
  fieldPath: string,
  warnings: MapperWarning[],
  valid: (value: number) => boolean,
): number | null {
  warningForMalformedFact(fact.state, code, fieldPath, warnings);
  if (fact.state !== "present" || fact.value === undefined) return null;
  if (!valid(fact.value)) {
    warnings.push(Object.freeze({ code, fieldPath }));
    return null;
  }
  return fact.value;
}

function relationshipKey(
  relationship: NormalizedRelationshipIdentity,
): CanonicalRelationshipKey {
  const targetCanonicalKind =
    canonicalKindByLaunchScope[relationship.target.recordIdScopeKey];
  if (targetCanonicalKind !== "pack" && targetCanonicalKind !== "catalog_asset") {
    throw new Error("provider_mapper.relationship_scope_invalid");
  }
  return Object.freeze({
    relationship: relationship.relationship,
    targetRecordIdScopeKey: relationship.target.recordIdScopeKey,
    targetCanonicalKind,
    targetProviderRecordId: relationship.target.providerRecordId,
  });
}

function relationshipKeys(
  relationships: readonly NormalizedRelationshipIdentity[],
): readonly CanonicalRelationshipKey[] {
  return Object.freeze(
    relationships
      .map(relationshipKey)
      .sort((left, right) => {
        const relationshipOrder =
          (left.relationship === "pack" ? 0 : 1) -
          (right.relationship === "pack" ? 0 : 1);
        return relationshipOrder !== 0
          ? relationshipOrder
          : left.targetProviderRecordId.localeCompare(
              right.targetProviderRecordId,
            );
      }),
  );
}

function evInputFromFacts(
  input: ProviderObservationMapperInput,
  facts: Extract<NormalizedProviderFacts, { kind: "pack" }>,
  warnings: MapperWarning[],
): CanonicalEvInputCandidate | null {
  warningForMalformedFact(
    facts.evInput.state,
    "malformed_ev_input",
    "providerFacts.evInput",
    warnings,
  );
  if (facts.evInput.state !== "present") return null;
  const evidence = facts.evInput.value;
  const complete =
    evidence.approved === true &&
    evidence.currency !== null &&
    currencyTickerPattern.test(evidence.currency) &&
    evidence.unitBasis !== null &&
    Number.isSafeInteger(evidence.drawCount) &&
    (evidence.drawCount ?? 0) > 0 &&
    evidence.buybackPercent !== null &&
    evidence.buybackPercent >= 0 &&
    evidence.buybackPercent <= 100 &&
    Number.isSafeInteger(evidence.totalQuantity) &&
    (evidence.totalQuantity ?? 0) > 0 &&
    evidence.buckets.length > 0 &&
    new Set(evidence.buckets.map(({ bucketId }) => bucketId)).size ===
      evidence.buckets.length &&
    evidence.buckets.every(
      (bucket) =>
        bucket.probability !== null &&
        bucket.probability >= 0 &&
        bucket.probability <= 1 &&
        bucket.quantity !== null &&
        Number.isSafeInteger(bucket.quantity) &&
        bucket.quantity > 0 &&
        bucket.lowerValue !== null &&
        bucket.lowerValue >= 0 &&
        bucket.upperValue !== null &&
        bucket.upperValue >= bucket.lowerValue,
    ) &&
    Math.abs(
      evidence.buckets.reduce(
        (sum, bucket) => sum + (bucket.probability ?? 0),
        0,
      ) - 1,
    ) <= 0.000_001 &&
    evidence.buckets.reduce((sum, bucket) => sum + (bucket.quantity ?? 0), 0) ===
      evidence.totalQuantity;
  if (!complete) {
    warnings.push(
      Object.freeze({
        code: "ev_input_unavailable",
        fieldPath: "providerFacts.evInput",
      }),
    );
    return null;
  }
  const affectedPack = canonicalIdentity(
    input,
    "pack",
    input.observation.providerRecordIdentity.providerRecordId,
  );
  return Object.freeze({
    candidateKind: "ev_input",
    identity: canonicalIdentity(
      input,
      "ev_input",
      input.observation.providerRecordIdentity.providerRecordId,
    ),
    recordIdScopeKey: "catalog-pack-v1",
    effectiveAt: input.observation.effectiveAt,
    affectedPack,
    approved: true,
    currency: evidence.currency!,
    unitBasis: evidence.unitBasis!,
    drawCount: evidence.drawCount!,
    buybackPercent: evidence.buybackPercent!,
    totalQuantity: evidence.totalQuantity!,
    buckets: Object.freeze(
      evidence.buckets
        .map((bucket) =>
          Object.freeze({
            bucketId: bucket.bucketId,
            label: bucket.label,
            probability: bucket.probability!,
            quantity: bucket.quantity!,
            lowerValue: bucket.lowerValue!,
            upperValue: bucket.upperValue!,
          }),
        )
        .sort((left, right) => left.bucketId.localeCompare(right.bucketId)),
    ),
  });
}

function incompatible(
  input: ProviderObservationMapperInput,
  descriptor: SourceMapperCompatibilityDescriptor,
): ProviderObservationMappingOutcome | null {
  if (input.provider !== descriptor.provider) {
    return {
      status: "quarantined",
      reasonCode: "platform_mismatch",
      warnings: [],
      protectedNativeEvidenceRef: input.observation.protectedNativeEvidenceRef,
    };
  }
  if (
    input.mapperKey !== descriptor.mapperKey ||
    input.mapperVersion !== descriptor.mapperVersion ||
    input.normalizedContractVersion !== descriptor.normalizedContractVersion ||
    input.identityNamespaceKey !== descriptor.identityNamespaceKey
  ) {
    return {
      status: "quarantined",
      reasonCode: "mapper_input_incompatible",
      warnings: [],
      protectedNativeEvidenceRef: input.observation.protectedNativeEvidenceRef,
    };
  }
  return null;
}

function mapNormalizedObservation(
  input: ProviderObservationMapperInput,
  descriptor: SourceMapperCompatibilityDescriptor,
): ProviderObservationMappingOutcome {
  const mismatch = incompatible(input, descriptor);
  if (mismatch) return mismatch;
  const observation = descriptor.normalizedContractVersion ===
      PROVIDER_OBSERVATION_CONTRACT_VERSION
    ? normalizedProviderObservationSchema.parse(input.observation)
    : descriptor.normalizedContractVersion ===
        PROVIDER_OBSERVATION_CONTRACT_VERSION_V2
      ? normalizedProviderObservationV2Schema.parse(input.observation)
      : (() => {
          throw new Error("provider_mapper.normalized_contract_mismatch");
        })();
  const warnings: MapperWarning[] = [];
  const recordId = observation.providerRecordIdentity.providerRecordId;
  const scope = observation.providerRecordIdentity.recordIdScopeKey;
  const canonicalKind = canonicalKindByLaunchScope[scope];

  if (
    observation.kind === "catalog" &&
    observation.entity === "pack" &&
    observation.providerFacts.kind === "pack"
  ) {
    const facts = observation.providerFacts;
    const displayName = textFact(
      facts.displayName,
      "malformed_display_name",
      "providerFacts.displayName",
      warnings,
    );
    if (displayName === null) {
      return {
        status: "quarantined",
        reasonCode: "pack_display_name_required",
        warnings: Object.freeze(warnings),
        protectedNativeEvidenceRef: observation.protectedNativeEvidenceRef,
      };
    }
    warningForMalformedFact(
      facts.authoritativeAvailability.state,
      "malformed_authoritative_availability",
      "providerFacts.authoritativeAvailability",
      warnings,
    );
    const explicitSoldOut = facts.authoritativeAvailability.state === "present";
    if (explicitSoldOut && observation.availability === "available") {
      return {
        status: "quarantined",
        reasonCode: "availability_contradiction",
        warnings: Object.freeze(warnings),
        protectedNativeEvidenceRef: observation.protectedNativeEvidenceRef,
      };
    }
    const identity = canonicalIdentity(input, canonicalKind, recordId);
    const description = textFact(
      facts.description,
      "malformed_description",
      "providerFacts.description",
      warnings,
    );
    const category = textFact(
      facts.category,
      "malformed_category",
      "providerFacts.category",
      warnings,
    );
    const imageReferences = imagesFact(facts.imageReferences, warnings);
    const price = moneyFact(
      facts.price,
      "malformed_price",
      "providerFacts.price",
      warnings,
    );
    const providerReportedEv = moneyFact(
      facts.providerReportedEv,
      "malformed_provider_reported_ev",
      "providerFacts.providerReportedEv",
      warnings,
    );
    const buybackPercent = numberFact(
      facts.buybackPercent,
      "malformed_buyback_percent",
      "providerFacts.buybackPercent",
      warnings,
      (value) => value >= 0 && value <= 100,
    );
    const drawCount = numberFact(
      facts.drawCount,
      "malformed_draw_count",
      "providerFacts.drawCount",
      warnings,
      (value) => Number.isSafeInteger(value) && value > 0,
    );
    const evInputCandidate = evInputFromFacts(input, facts, warnings);
    const evInputStatus = evInputCandidate ? "ready" : "unavailable";
    const candidate: CanonicalObservationPackCandidate = Object.freeze({
      candidateKind: "pack",
      evInputStatus,
      identity: identity as CanonicalProviderIdentity & { canonicalKind: "pack" },
      recordIdScopeKey: scope,
      effectiveAt: observation.effectiveAt,
      firstSeenAt: observation.firstSeenAt,
      displayName,
      description,
      category,
      imageReferences,
      availability: explicitSoldOut ? "sold_out" : observation.availability,
      price,
      providerReportedEv,
      buybackPercent,
      drawCount,
    });
    return {
      status: "mapped",
      candidate,
      evInputCandidate,
      evInputStatus,
      evRecomputationImpact: { kind: "pack", affectedPack: identity },
      warnings: Object.freeze(warnings),
      protectedNativeEvidenceRef: observation.protectedNativeEvidenceRef,
      protectedTransactionEvidenceRef: null,
    };
  }

  if (
    observation.kind === "catalog" &&
    observation.providerFacts.kind === "card"
  ) {
    const facts = observation.providerFacts;
    const identity = canonicalIdentity(input, canonicalKind, recordId);
    const candidate: CanonicalCatalogAssetCandidate = Object.freeze({
      candidateKind: "catalog_asset",
      identity:
        identity as CanonicalProviderIdentity & { canonicalKind: "catalog_asset" },
      recordIdScopeKey: scope,
      effectiveAt: observation.effectiveAt,
      firstSeenAt: observation.firstSeenAt,
      assetType: "card",
      displayName: textFact(
        facts.displayName,
        "malformed_display_name",
        "providerFacts.displayName",
        warnings,
      ),
      description: textFact(
        facts.description,
        "malformed_description",
        "providerFacts.description",
        warnings,
      ),
      category: textFact(
        facts.category,
        "malformed_category",
        "providerFacts.category",
        warnings,
      ),
      imageReferences: imagesFact(facts.imageReferences, warnings),
      availability: observation.availability,
      estimatedValue: moneyFact(
        facts.estimatedValue,
        "malformed_estimated_value",
        "providerFacts.estimatedValue",
        warnings,
      ),
      valueSource: textFact(
        facts.valueSource,
        "malformed_value_source",
        "providerFacts.valueSource",
        warnings,
      ),
    });
    return {
      status: "mapped",
      candidate,
      evInputCandidate: null,
      evInputStatus: "not_applicable",
      evRecomputationImpact: {
        kind: "catalog_asset",
        affectedCatalogAsset: identity,
      },
      warnings: Object.freeze(warnings),
      protectedNativeEvidenceRef: observation.protectedNativeEvidenceRef,
      protectedTransactionEvidenceRef: null,
    };
  }

  if (observation.kind === "catalog") {
    throw new Error("provider_mapper.catalog_facts_mismatch");
  }

  if (observation.kind === "pull") {
    const facts = observation.providerFacts;
    const candidate: CanonicalPullCandidate = Object.freeze({
      candidateKind: "pull",
      identity: canonicalIdentity(input, canonicalKind, recordId) as
        CanonicalProviderIdentity & { canonicalKind: "pull" },
      recordIdScopeKey: scope,
      effectiveAt: observation.effectiveAt,
      displayName: textFact(
        facts.displayName,
        "malformed_display_name",
        "providerFacts.displayName",
        warnings,
      ),
      imageReferences: imagesFact(facts.imageReferences, warnings),
      value: moneyFact(
        facts.value,
        "malformed_value",
        "providerFacts.value",
        warnings,
      ),
      valueSource: textFact(
        facts.valueSource,
        "malformed_value_source",
        "providerFacts.valueSource",
        warnings,
      ),
      relationships: relationshipKeys(observation.relationships),
    });
    return {
      status: "mapped",
      candidate,
      evInputCandidate: null,
      evInputStatus: "not_applicable",
      evRecomputationImpact: null,
      warnings: Object.freeze(warnings),
      protectedNativeEvidenceRef: observation.protectedNativeEvidenceRef,
      protectedTransactionEvidenceRef: null,
    };
  }

  const facts = observation.providerFacts;
  if (!knownEventCodes.has(observation.eventType)) {
    warnings.push(
      Object.freeze({ code: "future_event_code", fieldPath: "eventType" }),
    );
  }
  const candidate: CanonicalMarketEventCandidate = Object.freeze({
    candidateKind: "market_event",
    identity: canonicalIdentity(input, canonicalKind, recordId) as
      CanonicalProviderIdentity & { canonicalKind: "market_event" },
    recordIdScopeKey: scope,
    effectiveAt: observation.effectiveAt,
    eventType: observation.eventType,
    amount: observation.amount,
    currency: observation.currency,
    paymentMethod: observation.paymentMethod,
    displayName: textFact(
      facts.displayName,
      "malformed_display_name",
      "providerFacts.displayName",
      warnings,
    ),
    imageReferences: imagesFact(facts.imageReferences, warnings),
    relationships: relationshipKeys(observation.relationships),
  });
  return {
    status: "mapped",
    candidate,
    evInputCandidate: null,
    evInputStatus: "not_applicable",
    evRecomputationImpact: null,
    warnings: Object.freeze(warnings),
    protectedNativeEvidenceRef: observation.protectedNativeEvidenceRef,
    protectedTransactionEvidenceRef:
      observation.protectedTransactionEvidenceRef,
  };
}

export function createLaunchProviderObservationMapper(
  descriptor: SourceMapperCompatibilityDescriptor,
): ProviderObservationMapper {
  if (
    descriptor.normalizedContractVersion !==
      PROVIDER_OBSERVATION_CONTRACT_VERSION &&
    descriptor.normalizedContractVersion !==
      PROVIDER_OBSERVATION_CONTRACT_VERSION_V2
  ) {
    throw new Error("provider_mapper.normalized_contract_mismatch");
  }
  return Object.freeze({
    descriptor,
    map(input: ProviderObservationMapperInput) {
      return mapNormalizedObservation(input, descriptor);
    },
  });
}

export function fingerprintCanonicalProviderCandidate(
  candidate: CanonicalProviderCandidate | CanonicalEvInputCandidate,
): string {
  return fingerprintCanonicalProviderContent(candidate);
}
