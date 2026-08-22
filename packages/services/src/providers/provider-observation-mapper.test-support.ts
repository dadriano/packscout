import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  emptyNormalizedProviderFacts,
  normalizedProviderObservationSchema,
  providerIdentityNamespaceByLaunchProvider,
  type LaunchProviderKey,
  type NormalizedPackProviderFacts,
  type NormalizedProviderObservation,
} from "@packscout/contracts";
import type { ProviderObservationMapperInput } from "../provider-observation-mapper.ts";
import { launchSourceMapperDescriptors } from "../source-mapper-descriptors.ts";

export const observedAt = "2026-08-20T12:00:00.000Z";

export function descriptorFor(provider: LaunchProviderKey) {
  return launchSourceMapperDescriptors.find(
    (descriptor) => descriptor.provider === provider,
  )!;
}

export function mapperInput(
  provider: LaunchProviderKey,
  observation: NormalizedProviderObservation,
  overrides: Partial<ProviderObservationMapperInput> = {},
): ProviderObservationMapperInput {
  const descriptor = descriptorFor(provider);
  return {
    organizationId: "org-task-005",
    providerId: `provider-${provider}`,
    provider,
    mapperKey: descriptor.mapperKey,
    mapperVersion: descriptor.mapperVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider[provider],
    observation,
    ...overrides,
  };
}

export function packFacts(
  overrides: Partial<NormalizedPackProviderFacts> = {},
): NormalizedPackProviderFacts {
  return {
    ...(emptyNormalizedProviderFacts("pack") as NormalizedPackProviderFacts),
    displayName: { state: "present", value: "Launch Pack" },
    ...overrides,
    kind: "pack",
  };
}

export function packObservation(
  overrides: Readonly<Record<string, unknown>> = {},
): NormalizedProviderObservation {
  return normalizedProviderObservationSchema.parse({
    kind: "catalog",
    entity: "pack",
    providerRecordIdentity: {
      recordIdScopeKey: "catalog-pack-v1",
      providerRecordId: "pack-1",
    },
    effectiveAt: observedAt,
    collectedAt: "2026-08-20T12:00:01.000Z",
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    availability: "available",
    providerFacts: packFacts(),
    relationships: [],
    protectedNativeEvidenceRef: "evidence:pack-1",
    ...overrides,
  });
}

export function cardObservation(
  overrides: Readonly<Record<string, unknown>> = {},
): NormalizedProviderObservation {
  return normalizedProviderObservationSchema.parse({
    kind: "catalog",
    entity: "card",
    providerRecordIdentity: {
      recordIdScopeKey: "catalog-card-v1",
      providerRecordId: "card-1",
    },
    effectiveAt: observedAt,
    collectedAt: "2026-08-20T12:00:01.000Z",
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    availability: "unknown",
    providerFacts: {
      ...emptyNormalizedProviderFacts("card"),
      displayName: { state: "present", value: "Card One" },
    },
    relationships: [],
    protectedNativeEvidenceRef: "evidence:card-1",
    ...overrides,
  });
}

export function pullObservation(
  overrides: Readonly<Record<string, unknown>> = {},
): NormalizedProviderObservation {
  return normalizedProviderObservationSchema.parse({
    kind: "pull",
    providerRecordIdentity: {
      recordIdScopeKey: "pull-v1",
      providerRecordId: "pull-1",
    },
    effectiveAt: observedAt,
    collectedAt: "2026-08-20T12:00:01.000Z",
    providerFacts: emptyNormalizedProviderFacts("pull"),
    relationships: [
      {
        relationship: "pack",
        target: {
          recordIdScopeKey: "catalog-pack-v1",
          providerRecordId: "shared-raw-id",
        },
      },
      {
        relationship: "card",
        target: {
          recordIdScopeKey: "catalog-card-v1",
          providerRecordId: "shared-raw-id",
        },
      },
    ],
    protectedNativeEvidenceRef: "evidence:pull-1",
    ...overrides,
  });
}

export function tradeObservation(
  overrides: Readonly<Record<string, unknown>> = {},
): NormalizedProviderObservation {
  return normalizedProviderObservationSchema.parse({
    kind: "trade",
    providerRecordIdentity: {
      recordIdScopeKey: "trade-v1",
      providerRecordId: "trade-1",
    },
    effectiveAt: observedAt,
    collectedAt: "2026-08-20T12:00:01.000Z",
    eventType: "sale",
    amount: null,
    currency: null,
    paymentMethod: null,
    relationships: [
      {
        relationship: "card",
        target: {
          recordIdScopeKey: "catalog-card-v1",
          providerRecordId: "card-1",
        },
      },
    ],
    providerFacts: emptyNormalizedProviderFacts("trade"),
    protectedNativeEvidenceRef: "evidence:trade-1",
    protectedTransactionEvidenceRef: null,
    ...overrides,
  });
}
