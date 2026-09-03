import { createHash } from "node:crypto";
import {
  PROVIDER_PACK_EV_EVIDENCE_SCHEMA_VERSION,
  providerPackEvEvidenceV1Schema,
  packMembershipSnapshotV1,
  type ProviderPackEvEvidenceV1,
  type LaunchRecordIdScopeKey,
  type NormalizedProviderObservation,
  type NormalizedProviderObservationPage,
} from "@packscout/contracts";
import {
  createProviderObservationMapperRegistryFromManifest,
  providerSourceCanonicalProjectionsForValidatedMapping,
  type CanonicalCatalogAssetCandidate,
  type CanonicalMarketEventCandidate,
  type CanonicalObservationPackCandidate,
  type CanonicalPullCandidate,
  type ProductionProviderObservationMapperRegistry,
  type ProviderObservationMappingOutcome,
} from "@packscout/services";
import type { ProviderDataforrestLiveIntegration } from
  "./provider-dataforrest-live-integration.ts";
import {
  ProviderCaptureSourceError,
  type ProviderCaptureTranslation,
  type ProviderMixedPageRecordDraft,
} from "./provider-capture-source-contract.ts";
import {
  categoryDrafts,
  collectibleDraft,
  marketEventDraft,
  packDraft,
  pullDraft,
} from "./provider-observation-mixed-page-drafts.ts";

const sourceScopeByRecordScope = Object.freeze({
  "catalog-pack-v1": "catalog:pack",
  "catalog-card-v1": "catalog:card",
  "pull-v1": "pulls",
  "trade-v1": "trades",
} as const satisfies Readonly<Record<LaunchRecordIdScopeKey, string>>);

const kindByRecordScope = Object.freeze({
  "catalog-pack-v1": "catalog",
  "catalog-card-v1": "catalog",
  "pull-v1": "pull",
  "trade-v1": "market_event",
} as const satisfies Readonly<
  Record<LaunchRecordIdScopeKey, ProviderMixedPageRecordDraft["kind"]>
>);

const orderByRecordScope = Object.freeze({
  "catalog-pack-v1": 0,
  "catalog-card-v1": 1,
  "pull-v1": 2,
  "trade-v1": 3,
} as const satisfies Readonly<Record<LaunchRecordIdScopeKey, number>>);

function sourceRecordKey(
  providerId: string,
  observation: NormalizedProviderObservation,
): string {
  return `source:${createHash("sha256")
    .update("packscout.provider-source-record-identity.v1\u0000")
    .update(JSON.stringify([
      providerId,
      sourceScopeByRecordScope[
        observation.providerRecordIdentity.recordIdScopeKey
      ],
      observation.providerRecordIdentity.providerRecordId,
    ]))
    .digest("hex")}`;
}

type MapperRejection = Extract<
  ProviderObservationMappingOutcome,
  { status: "quarantined" }
>;

interface QuarantineFailure {
  readonly reasonCode: string;
  readonly fieldPath: string | null;
}

const unrecognizedMappingFailure: QuarantineFailure = Object.freeze({
  reasonCode: "SOURCE_RECORD_MAPPING_INVALID",
  fieldPath: null,
});

/**
 * Exact public-safe failures. A mapper reason is translated through this table
 * rather than reformatted, so neither mapper text nor provider-native evidence
 * can reach the quarantine record. A new mapper reason fails this file's build
 * until it declares its own public-safe failure.
 */
const failureByMapperReason = Object.freeze({
  availability_contradiction: Object.freeze({
    reasonCode: "SOURCE_RECORD_AVAILABILITY_CONTRADICTION",
    fieldPath: "providerFacts.authoritativeAvailability",
  }),
  mapper_input_incompatible: Object.freeze({
    reasonCode: "SOURCE_RECORD_MAPPER_INPUT_INCOMPATIBLE",
    fieldPath: null,
  }),
  pack_display_name_required: Object.freeze({
    reasonCode: "SOURCE_RECORD_PACK_DISPLAY_NAME_REQUIRED",
    fieldPath: "providerFacts.displayName",
  }),
  platform_mismatch: Object.freeze({
    reasonCode: "SOURCE_RECORD_PLATFORM_MISMATCH",
    fieldPath: null,
  }),
} as const satisfies Readonly<
  Record<MapperRejection["reasonCode"], QuarantineFailure>
>);

function mapperRejectionFailure(outcome: MapperRejection): QuarantineFailure {
  return failureByMapperReason[outcome.reasonCode];
}

/** Draft and projection rejections already carry a public-safe failure code. */
function thrownRejectionFailure(error: unknown): QuarantineFailure {
  return error instanceof ProviderCaptureSourceError
    ? Object.freeze({ reasonCode: error.code, fieldPath: null })
    : unrecognizedMappingFailure;
}

function mappingQuarantine(
  providerId: string,
  observation: NormalizedProviderObservation,
  failure: QuarantineFailure,
): ProviderMixedPageRecordDraft {
  return Object.freeze({
    kind:
      kindByRecordScope[observation.providerRecordIdentity.recordIdScopeKey],
    disposition: "quarantine" as const,
    candidate: Object.freeze({}),
    sourceRecordKey: sourceRecordKey(providerId, observation),
    reasonCode: failure.reasonCode,
    fieldPath: failure.fieldPath,
    sanitizedSummary:
      "The validated source record could not be mapped; no retry artifact is retained.",
  });
}

function orderedValidObservations(
  page: NormalizedProviderObservationPage,
): readonly NormalizedProviderObservation[] {
  return page.outcomes
    .filter((outcome) => outcome.status === "valid")
    .map((outcome) => outcome.observation)
    .sort((left, right) => {
      const scope = orderByRecordScope[
        left.providerRecordIdentity.recordIdScopeKey
      ] - orderByRecordScope[right.providerRecordIdentity.recordIdScopeKey];
      return scope !== 0
        ? scope
        : left.providerRecordIdentity.providerRecordId.localeCompare(
          right.providerRecordIdentity.providerRecordId,
        );
    });
}

/** Maps only reviewed normalized observations; protected evidence is absent. */
export function translateProviderNormalizedObservations(input: Readonly<{
  organizationId: string;
  providerId: string;
  integration: ProviderDataforrestLiveIntegration;
  page: NormalizedProviderObservationPage;
  mappers?: ProductionProviderObservationMapperRegistry;
}>): ProviderCaptureTranslation {
  if (
    input.page.provider !== input.integration.providerKey
    || input.page.normalizedContractVersion !==
      input.integration.mapper.normalizedContractVersion
  ) {
    throw new TypeError("Provider normalized page does not match integration.");
  }
  const mappers = input.mappers
    ?? createProviderObservationMapperRegistryFromManifest();
  const mapper = mappers.resolve({
    provider: input.integration.providerKey,
    mapperKey: input.integration.mapper.mapperKey,
    mapperVersion: input.integration.mapper.mapperVersion,
    normalizedContractVersion:
      input.integration.mapper.normalizedContractVersion,
    identityNamespaceKey: input.integration.mapper.identityNamespaceKey,
  });
  const packs: CanonicalObservationPackCandidate[] = [];
  const membershipRecords: ProviderMixedPageRecordDraft[] = [];
  const packEvidence = new Map<
    CanonicalObservationPackCandidate,
    ProviderPackEvEvidenceV1
  >();
  const cards: CanonicalCatalogAssetCandidate[] = [];
  const pulls: CanonicalPullCandidate[] = [];
  const events: CanonicalMarketEventCandidate[] = [];
  const quarantines: ProviderMixedPageRecordDraft[] = [];

  for (const observation of orderedValidObservations(input.page)) {
    try {
      const mapped = mapper.map({
        organizationId: input.organizationId,
        providerId: input.providerId,
        provider: input.integration.providerKey,
        mapperKey: input.integration.mapper.mapperKey,
        mapperVersion: input.integration.mapper.mapperVersion,
        normalizedContractVersion:
          input.integration.mapper.normalizedContractVersion,
        identityNamespaceKey: input.integration.mapper.identityNamespaceKey,
        observation,
      });
      if (mapped.status !== "mapped") {
        quarantines.push(mappingQuarantine(
          input.providerId,
          observation,
          mapperRejectionFailure(mapped),
        ));
        continue;
      }
      providerSourceCanonicalProjectionsForValidatedMapping(mapped, {
        organizationId: input.organizationId,
        providerId: input.providerId,
        provider: input.integration.providerKey,
        normalizedContractVersion:
          input.integration.mapper.normalizedContractVersion,
        observation,
      });
      const candidate = mapped.candidate;
      switch (candidate.candidateKind) {
        case "pack":
          packDraft(candidate);
          if (
            observation.kind !== "catalog" ||
            observation.entity !== "pack" ||
            observation.providerFacts.kind !== "pack"
          ) throw new TypeError("pack evidence scope mismatch");
          packEvidence.set(candidate,
            providerPackEvEvidenceV1Schema.parse({
              schemaVersion: PROVIDER_PACK_EV_EVIDENCE_SCHEMA_VERSION,
              organizationId: input.organizationId,
              providerId: input.providerId,
              providerKey: input.integration.providerKey,
              providerRecordId: candidate.identity.providerRecordId,
              recordIdScopeKey: observation.providerRecordIdentity.recordIdScopeKey,
              sourceTypeKey: input.integration.manifest.sourceTypeKey,
              sourceAdapterVersion: input.integration.manifest.adapterVersion,
              normalizedContractVersion:
                input.integration.mapper.normalizedContractVersion,
              mapperKey: input.integration.mapper.mapperKey,
              mapperVersion: input.integration.mapper.mapperVersion,
              identityNamespaceKey: input.integration.mapper.identityNamespaceKey,
              effectiveAt: observation.effectiveAt,
              collectedAt: observation.collectedAt,
              price: observation.providerFacts.price,
              buybackPercent: observation.providerFacts.buybackPercent,
              drawCount: observation.providerFacts.drawCount,
              evInput: observation.providerFacts.evInput,
            }));
          if (observation.providerFacts.packMembership?.state === "present") {
            membershipRecords.push({
              kind: "catalog", entityType: "pack_content_snapshot", operation: "upsert",
              candidate: packMembershipSnapshotV1({
                providerId: input.providerId, providerRecordId: candidate.identity.providerRecordId,
                sourceAdapterVersion: input.integration.manifest.adapterVersion,
                mapperVersion: input.integration.mapper.mapperVersion,
                effectiveAt: observation.effectiveAt, effectiveAtBasis: "provider_updated_at",
                collectedAt: observation.collectedAt, membership: observation.providerFacts.packMembership.value,
              }),
            });
          }
          packs.push(candidate);
          break;
        case "catalog_asset":
          collectibleDraft(candidate);
          cards.push(candidate);
          break;
        case "pull":
          pullDraft({
            candidate,
            accountKey: null,
            providerId: input.providerId,
          });
          pulls.push(candidate);
          break;
        case "market_event":
          marketEventDraft({
            candidate,
            fromAccountKey: null,
            toAccountKey: null,
            providerId: input.providerId,
          });
          events.push(candidate);
          break;
      }
    } catch (error) {
      quarantines.push(mappingQuarantine(
        input.providerId,
        observation,
        thrownRejectionFailure(error),
      ));
    }
  }

  const categories = categoryDrafts(packs, cards);
  const pullRecords = pulls.map((candidate) => pullDraft({
    candidate,
    accountKey: null,
    providerId: input.providerId,
  }));
  const marketEvents = events.map((candidate) => marketEventDraft({
    candidate,
    fromAccountKey: null,
    toAccountKey: null,
    providerId: input.providerId,
  }));
  return Object.freeze({
    records: Object.freeze([
      ...categories,
      ...packs.map((candidate) => packDraft(candidate, {
        evInputEvidence: packEvidence.get(candidate)!,
      })),
      ...cards.map(collectibleDraft),
      ...membershipRecords,
      ...pullRecords,
      ...marketEvents,
      ...quarantines,
    ]),
    counts: Object.freeze({
      categories: categories.length,
      packs: packs.length,
      collectibles: cards.length,
      providerAccounts: 0,
      pulls: pullRecords.length,
      pullsWithoutPackKey: pullRecords.filter(
        ({ candidate }) => candidate.packKey === null,
      ).length,
      marketEvents: marketEvents.length,
      packContents: membershipRecords.length,
    }),
  });
}
