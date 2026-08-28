import {
  CanonicalProjectionValidationError,
  normalizeCanonicalIdentity,
  normalizeCanonicalMoney,
  normalizeCanonicalTimestamp,
  normalizeOptionalText,
} from "./canonical-projection-validation.ts";
import {
  CATALOG_PROJECTION_VERSION,
  type CanonicalCatalogAssetProjectionContent,
  type CanonicalCatalogProjectionProvenance,
  type CanonicalAvailability,
  type CanonicalDataQualityEvidence,
  type CanonicalPackProjectionContent,
} from "./catalog-projection-contracts.ts";
import {
  EvInputProjectionValidationError,
  projectEvInputContent,
} from "./catalog-ev-input-projection.ts";
import type {
  CatalogAssetCandidate,
  CanonicalPackCandidate,
  ProviderAdapterCandidate,
  ProviderDataQualityEvidence,
  ProviderRelationshipKey,
  ProviderSourceIdentity,
} from "./provider-adapter.ts";
import type {
  ProviderCanonicalProjectionCommand,
  ProviderProjectionOutcome,
  ProviderProjectionPort,
} from "./provider-import-types.ts";

const qualityCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;

class CatalogCandidateError extends Error {
  constructor(
    readonly code: string,
    readonly fieldPath?: string,
  ) {
    super("Catalog candidate failed canonical projection.");
    this.name = "CatalogCandidateError";
  }
}

function optionalIdentity(value: string | null | undefined, path: string): string | null {
  return value === null || value === undefined
    ? null
    : normalizeCanonicalIdentity(value, path);
}

function normalizedImages(values: readonly string[] | undefined, path: string): string[] {
  const images = (values ?? []).map((value, index) => {
    const image = normalizeOptionalText(value, `${path}[${index}]`, 2_048);
    if (image === null) throw new CatalogCandidateError("INVALID_IMAGE_REFERENCE", `${path}[${index}]`);
    return image;
  });
  return [...new Set(images)].sort();
}

function normalizedQualityEvidence(
  values: readonly ProviderDataQualityEvidence[],
  additions: readonly CanonicalDataQualityEvidence[] = [],
): CanonicalDataQualityEvidence[] {
  const evidence = values.map((value, index) => {
    if (!qualityCodePattern.test(value.code)) {
      throw new CatalogCandidateError(
        "INVALID_DATA_QUALITY_EVIDENCE",
        `candidates.dataQualityEvidence[${index}].code`,
      );
    }
    if (value.severity !== "info" && value.severity !== "warning") {
      throw new CatalogCandidateError(
        "INVALID_DATA_QUALITY_EVIDENCE",
        `candidates.dataQualityEvidence[${index}].severity`,
      );
    }
    return {
      code: value.code,
      severity: value.severity,
      fieldPath: normalizeOptionalText(
        value.fieldPath,
        `candidates.dataQualityEvidence[${index}].fieldPath`,
        256,
      ),
    };
  });
  return [...evidence, ...additions].sort((left, right) =>
    `${left.code}:${left.severity}:${left.fieldPath ?? ""}`.localeCompare(
      `${right.code}:${right.severity}:${right.fieldPath ?? ""}`,
    ),
  );
}

function normalizedNullablePercentage(value: number | null | undefined, path: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new CatalogCandidateError("INVALID_PERCENTAGE", path);
  }
  return value;
}

function normalizedNullableCount(value: number | null | undefined, path: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CatalogCandidateError("INVALID_COUNT", path);
  }
  return value;
}

function normalizedAvailability(
  value: CanonicalAvailability | undefined,
  path: string,
): CanonicalAvailability {
  if (
    value === "available" ||
    value === "unavailable" ||
    value === "sold_out" ||
    value === "unknown"
  ) {
    return value;
  }
  if (value === undefined) return "unknown";
  throw new CatalogCandidateError("INVALID_AVAILABILITY", path);
}

function packContent(candidate: CanonicalPackCandidate): CanonicalPackProjectionContent {
  const name = normalizeOptionalText(candidate.name, "candidates.pack.name", 500);
  if (name === null) throw new CatalogCandidateError("MISSING_PACK_NAME", "candidates.pack.name");
  const price = normalizeCanonicalMoney(candidate.price, "candidates.pack.price");
  const providerEv = normalizeCanonicalMoney(
    candidate.providerReportedEv,
    "candidates.pack.providerReportedEv",
  );
  return {
    schemaVersion: CATALOG_PROJECTION_VERSION,
    entityType: "pack",
    parentExternalId: optionalIdentity(candidate.parentExternalId, "candidates.pack.parentExternalId"),
    firstSeenAt: normalizeCanonicalTimestamp(
      candidate.source.sourceTimestamp,
      "candidates.pack.source.sourceTimestamp",
    ).toISOString(),
    name,
    category: normalizeOptionalText(candidate.category, "candidates.pack.category", 500),
    description: normalizeOptionalText(candidate.description, "candidates.pack.description", 10_000),
    availability: normalizedAvailability(candidate.availability, "candidates.pack.availability"),
    availabilityProvenance: candidate.availability === "sold_out"
      ? {
          kind: "explicit_authoritative_sold_out",
          authority: "provider_explicit_sold_out",
        }
      : {
          kind: "canonical_provider_observation",
          observedAvailability: candidate.availability,
        },
    sourceStatus: normalizeOptionalText(candidate.sourceStatus, "candidates.pack.sourceStatus", 256),
    priceValueMinor: price?.amountMinor ?? null,
    priceCurrency: price?.currency ?? null,
    providerReportedEvValueMinor: providerEv?.amountMinor ?? null,
    providerReportedEvCurrency: providerEv?.currency ?? null,
    buybackPercent: normalizedNullablePercentage(candidate.buybackPercent, "candidates.pack.buybackPercent"),
    drawCount: normalizedNullableCount(candidate.drawCount, "candidates.pack.drawCount"),
    imageUrls: normalizedImages(candidate.imageUrls, "candidates.pack.imageUrls"),
    dataQualityEvidence: normalizedQualityEvidence(candidate.dataQualityEvidence),
  };
}

function assetContent(candidate: CatalogAssetCandidate): CanonicalCatalogAssetProjectionContent {
  const availabilityEvidence: CanonicalDataQualityEvidence[] = candidate.availability
    ? []
    : [{ code: "MISSING_EXPLICIT_AVAILABILITY", severity: "warning", fieldPath: "availability" }];
  const value = normalizeCanonicalMoney(candidate.estimatedValue, "candidates.catalogAsset.estimatedValue");
  return {
    schemaVersion: CATALOG_PROJECTION_VERSION,
    entityType: "catalog_asset",
    assetType: normalizeOptionalText(candidate.assetType, "candidates.catalogAsset.assetType", 256),
    relatedPackExternalId: optionalIdentity(
      candidate.relatedPackExternalId,
      "candidates.catalogAsset.relatedPackExternalId",
    ),
    parentExternalId: optionalIdentity(
      candidate.parentExternalId,
      "candidates.catalogAsset.parentExternalId",
    ),
    firstSeenAt: normalizeCanonicalTimestamp(
      candidate.source.sourceTimestamp,
      "candidates.catalogAsset.source.sourceTimestamp",
    ).toISOString(),
    name: normalizeOptionalText(candidate.name, "candidates.catalogAsset.name", 500),
    description: null,
    category: normalizeOptionalText(candidate.category, "candidates.catalogAsset.category", 500),
    availability: normalizedAvailability(
      candidate.availability,
      "candidates.catalogAsset.availability",
    ),
    sourceStatus: normalizeOptionalText(candidate.sourceStatus, "candidates.catalogAsset.sourceStatus", 256),
    providerValueMinor: value?.amountMinor ?? null,
    providerValueCurrency: value?.currency ?? null,
    valueSource: normalizeOptionalText(candidate.valueSource, "candidates.catalogAsset.valueSource", 500),
    imageUrls: normalizedImages(candidate.imageUrls, "candidates.catalogAsset.imageUrls"),
    dataQualityEvidence: normalizedQualityEvidence(
      candidate.dataQualityEvidence,
      availabilityEvidence,
    ),
  };
}

function sameSource(left: ProviderSourceIdentity, right: ProviderSourceIdentity): boolean {
  return (
    left.platform === right.platform &&
    left.recordKind === right.recordKind &&
    left.recordIndex === right.recordIndex &&
    left.externalId === right.externalId &&
    left.collectedAt === right.collectedAt &&
    left.sourceTimestamp === right.sourceTimestamp
  );
}

function relationshipsFor(
  candidate: ProviderAdapterCandidate,
  platformKey: string,
): ProviderCanonicalProjectionCommand["relationships"] {
  const declared = candidate.relationships.map((relationship: ProviderRelationshipKey) => ({
    relationshipKind: relationship.relationship,
    targetPlatformKey: normalizeCanonicalIdentity(
      relationship.platform,
      "candidates.relationships.platform",
    ),
    targetRecordKind: relationship.entityKind,
    targetExternalId: normalizeCanonicalIdentity(
      relationship.externalId,
      "candidates.relationships.externalId",
    ),
  }));
  const derived = candidate.candidateKind === "pack" && candidate.parentExternalId
    ? [{ relationshipKind: "variant_of", targetPlatformKey: platformKey, targetRecordKind: "pack" as const, targetExternalId: candidate.parentExternalId }]
    : candidate.candidateKind === "catalog_asset" && candidate.relatedPackExternalId
      ? [{ relationshipKind: "associated_with_pack", targetPlatformKey: platformKey, targetRecordKind: "pack" as const, targetExternalId: candidate.relatedPackExternalId }]
      : candidate.candidateKind === "ev_input"
        ? [{ relationshipKind: "supports_pack", targetPlatformKey: platformKey, targetRecordKind: "pack" as const, targetExternalId: candidate.packExternalId }]
        : [];
  const unique = new Map(
    [...declared, ...derived].map((relationship) => {
      const normalized = {
        ...relationship,
        targetExternalId: normalizeCanonicalIdentity(
          relationship.targetExternalId,
          "candidates.relationships.externalId",
        ),
      };
      return [
        `${normalized.relationshipKind}:${normalized.targetPlatformKey}:${normalized.targetRecordKind}:${normalized.targetExternalId}`,
        normalized,
      ] as const;
    }),
  );
  return [...unique.values()].sort((left, right) =>
    `${left.relationshipKind}:${left.targetRecordKind}:${left.targetExternalId}`.localeCompare(
      `${right.relationshipKind}:${right.targetRecordKind}:${right.targetExternalId}`,
    ),
  );
}

function asRecord(value: object): Record<string, unknown> {
  return { ...value };
}

export class CatalogProjectionService implements ProviderProjectionPort {
  project(input: Parameters<ProviderProjectionPort["project"]>[0]): ProviderProjectionOutcome {
    try {
      if (input.source.recordKind !== "catalog") {
        throw new CatalogCandidateError("UNSUPPORTED_SOURCE_RECORD_KIND", "source.recordKind");
      }
      if (input.configuration.platform !== input.source.platform) {
        throw new CatalogCandidateError("CONFIGURATION_PLATFORM_MISMATCH", "configuration.platform");
      }
      if (input.candidates.length === 0) {
        throw new CatalogCandidateError("UNCLASSIFIABLE_CATALOG", "candidates");
      }
      const platformKey = normalizeCanonicalIdentity(input.source.platform, "source.platform");
      const sourceUpdatedAt = normalizeCanonicalTimestamp(
        input.source.sourceTimestamp,
        "source.sourceTimestamp",
      );
      const sourceCollectedAt = normalizeCanonicalTimestamp(
        input.source.collectedAt,
        "source.collectedAt",
      );
      const provenance: CanonicalCatalogProjectionProvenance = {
        projectionVersion: CATALOG_PROJECTION_VERSION,
        providerId: normalizeCanonicalIdentity(input.configuration.providerId, "configuration.providerId"),
        configurationRevisionId: normalizeCanonicalIdentity(
          input.configuration.configurationRevisionId,
          "configuration.configurationRevisionId",
        ),
        adapterKey: normalizeCanonicalIdentity(input.configuration.adapterKey, "configuration.adapterKey"),
        sourceRecordKind: input.source.recordKind,
        sourceRecordIndex: input.source.recordIndex,
        sourceExternalId: normalizeCanonicalIdentity(input.source.externalId, "source.externalId"),
      };
      const projections = input.candidates.map((candidate) => {
        if (!sameSource(candidate.source, input.source)) {
          throw new CatalogCandidateError("CANDIDATE_SOURCE_MISMATCH", "candidates.source");
        }
        if (
          candidate.candidateKind !== "pack" &&
          candidate.candidateKind !== "catalog_asset" &&
          candidate.candidateKind !== "ev_input"
        ) {
          throw new CatalogCandidateError("UNSUPPORTED_CANDIDATE_KIND", "candidates.candidateKind");
        }
        const externalId = normalizeCanonicalIdentity(candidate.externalId, "candidates.externalId");
        const content = candidate.candidateKind === "pack"
          ? packContent(candidate)
          : candidate.candidateKind === "catalog_asset"
            ? assetContent(candidate)
            : projectEvInputContent(
                candidate,
                normalizedQualityEvidence(candidate.dataQualityEvidence),
              );
        return {
          platformKey,
          recordKind: candidate.candidateKind,
          externalId,
          content: asRecord(content),
          provenance: asRecord(provenance),
          sourceUpdatedAt,
          sourceCollectedAt,
          relationships: relationshipsFor(candidate, platformKey),
        } satisfies ProviderCanonicalProjectionCommand;
      }).sort((left, right) =>
        `${left.recordKind}:${left.externalId}`.localeCompare(`${right.recordKind}:${right.externalId}`),
      );
      const identities = projections.map((projection) => `${projection.recordKind}:${projection.externalId}`);
      if (new Set(identities).size !== identities.length) {
        throw new CatalogCandidateError("DUPLICATE_PROJECTION_IDENTITY", "candidates.externalId");
      }
      return { status: "accepted", projections };
    } catch (error) {
      if (error instanceof CanonicalProjectionValidationError) {
        return { status: "invalid", reasonCode: error.code, fieldPath: error.fieldPath };
      }
      if (error instanceof CatalogCandidateError) {
        return {
          status: "invalid",
          reasonCode: error.code,
          ...(error.fieldPath ? { fieldPath: error.fieldPath } : {}),
        };
      }
      if (error instanceof EvInputProjectionValidationError) {
        return {
          status: "invalid",
          reasonCode: error.code,
          fieldPath: error.fieldPath,
        };
      }
      return { status: "invalid", reasonCode: "INVALID_CATALOG_CANDIDATE" };
    }
  }
}
