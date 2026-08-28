import {
  normalizedObservationSemanticContentSchema,
  normalizedProviderObservationSchema,
} from "@packscout/contracts";
import {
  PrismaSourceRelationshipConfirmationBackfillRepository,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  createProviderObservationMapperRegistryFromManifest,
  providerSourceCanonicalProjectionsForValidatedMapping,
} from "@packscout/services";

/** Shares the exact production projection resolver with every repair entrypoint. */
export function createSourceRelationshipConfirmationBackfillRunner(input: {
  readonly database: PackscoutPrismaClient;
  readonly organizationId: string;
  readonly actorPseudonymKey: Uint8Array | string;
  readonly clock?: Readonly<{ now(): Date }>;
  readonly platformKeys?: readonly string[];
}) {
  const mappers = createProviderObservationMapperRegistryFromManifest();
  return new PrismaSourceRelationshipConfirmationBackfillRepository(
    input.database,
    {
      organizationId: input.organizationId,
      actorPseudonymKey: input.actorPseudonymKey,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
      ...(input.platformKeys === undefined
        ? {}
        : { platformKeys: input.platformKeys }),
      resolver: {
        resolvePullProjection(candidate) {
          const semantic = normalizedObservationSemanticContentSchema.parse(
            candidate.normalizedContent,
          );
          if (semantic.kind !== "pull") {
            throw new TypeError(
              "Relationship confirmation backfill semantic is not a pull.",
            );
          }
          const observation = normalizedProviderObservationSchema.parse({
            ...semantic,
            collectedAt: candidate.collectedAt.toISOString(),
            protectedNativeEvidenceRef: candidate.protectedNativeEvidenceRef,
          });
          const mapper = mappers.resolve({
            mapperKey: candidate.mapperKey,
            mapperVersion: candidate.mapperVersion,
            provider: candidate.provider,
            normalizedContractVersion: candidate.normalizedContractVersion,
            identityNamespaceKey: candidate.identityNamespaceKey,
          });
          const projections =
            providerSourceCanonicalProjectionsForValidatedMapping(
              mapper.map({
                organizationId: candidate.organizationId,
                providerId: candidate.providerId,
                provider: candidate.provider,
                mapperKey: candidate.mapperKey,
                mapperVersion: candidate.mapperVersion,
                normalizedContractVersion: candidate.normalizedContractVersion,
                identityNamespaceKey: candidate.identityNamespaceKey,
                observation,
              }),
              {
                organizationId: candidate.organizationId,
                providerId: candidate.providerId,
                provider: candidate.provider,
                normalizedContractVersion: candidate.normalizedContractVersion,
                observation,
              },
            );
          const primary = projections.filter((projection) =>
            projection.projectionKind === "primary"
            && projection.recordKind === "pull"
          );
          if (primary.length !== 1) {
            throw new TypeError(
              "Relationship confirmation backfill projection is ambiguous.",
            );
          }
          return primary[0]!;
        },
      },
    },
  );
}
