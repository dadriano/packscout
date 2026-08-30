import { provisionalCollectiblePublicId } from "@packscout/contracts";
import type {
  CorrelateProviderCollectibleRequest,
  GlobalCollectiblePublicIdentity,
} from "./global-catalog-contract.ts";

export const CATALOG_FIXTURE_IDS = Object.freeze({
  organization: "30000000-0000-4000-8000-000000000001",
  secondOrganization: "30000000-0000-4000-8000-000000000002",
  provider: "10000000-0000-4000-8000-000000000001",
  secondProvider: "10000000-0000-4000-8000-000000000002",
  unmatchedLocalCollectible: "20000000-0000-4000-8000-000000000001",
  uniqueLocalCollectible: "20000000-0000-4000-8000-000000000002",
  ambiguousLocalCollectible: "20000000-0000-4000-8000-000000000003",
  firstCanonicalCollectible: "40000000-0000-4000-8000-000000000001",
  secondCanonicalCollectible: "40000000-0000-4000-8000-000000000002",
  mergeAliasCollectible: "40000000-0000-4000-8000-000000000003",
} as const);

export const CATALOG_FIXTURE_TIME = new Date("2026-08-29T20:00:00.000Z");

export function catalogFixtureIdentity(
  displayName: string,
): GlobalCollectiblePublicIdentity {
  return {
    displayName,
    normalizedName: displayName.toLowerCase(),
    year: 2026,
    brand: "PackScout Fixture",
    setOrSeries: null,
    cardNumber: null,
    referenceNumber: null,
    subject: null,
    grade: null,
    grader: null,
    primaryImageUrl: null,
    primaryImageAlt: null,
    valuationAmount: null,
    valuationCurrency: null,
    valuationUsdAmount: null,
    valuationUnavailableReason: "VALUATION_UNAVAILABLE",
    valuationType: null,
    valuationObservedAt: null,
    dataAsOf: CATALOG_FIXTURE_TIME,
  };
}

function evidence(
  request: Pick<
    CorrelateProviderCollectibleRequest,
    "providerId" | "localCollectibleId" | "localEntityVersion" | "collectibleType"
  >,
  globalCollectibleId: string,
) {
  return {
    providerId: request.providerId,
    localCollectibleId: request.localCollectibleId,
    localEntityVersion: request.localEntityVersion,
    globalCollectibleId,
    collectibleType: request.collectibleType,
    confidenceBasisPoints: 10_000,
  } as const;
}

function baseRequest(
  localCollectibleId: string,
  providerChangeSequence: bigint,
): CorrelateProviderCollectibleRequest {
  return {
    providerId: CATALOG_FIXTURE_IDS.provider,
    localCollectibleId,
    localEntityVersion: 1n,
    collectibleType: "card",
    publicIdentity: catalogFixtureIdentity(`Fixture ${localCollectibleId.slice(-4)}`),
    deterministicEvidence: [],
    ruleVersion: "fixture-v1",
    providerChangeSequence,
    observedAt: CATALOG_FIXTURE_TIME,
  };
}

const unmatchedRequest = baseRequest(
  CATALOG_FIXTURE_IDS.unmatchedLocalCollectible,
  1n,
);
const uniqueRequestBase = baseRequest(
  CATALOG_FIXTURE_IDS.uniqueLocalCollectible,
  2n,
);
const ambiguousRequestBase = baseRequest(
  CATALOG_FIXTURE_IDS.ambiguousLocalCollectible,
  3n,
);

export const GLOBAL_CATALOG_CANONICAL_FIXTURES = Object.freeze({
  deterministicUniqueMatch: {
    request: {
      ...uniqueRequestBase,
      deterministicEvidence: [evidence(
        uniqueRequestBase,
        CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
      )],
    },
    expectedOutcome: "linked",
    expectedGlobalCollectibleId: CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
  },
  unmatchedProvisional: {
    request: unmatchedRequest,
    expectedOutcome: "provisional_created",
    expectedGlobalCollectibleId: "40a85f64-ad56-5575-b21b-8024ee216651",
  },
  ambiguousSuggestion: {
    request: {
      ...ambiguousRequestBase,
      deterministicEvidence: [
        evidence(ambiguousRequestBase, CATALOG_FIXTURE_IDS.secondCanonicalCollectible),
        evidence(ambiguousRequestBase, CATALOG_FIXTURE_IDS.firstCanonicalCollectible),
      ],
    },
    expectedOutcome: "suggested",
    expectedGlobalCollectibleId: provisionalCollectiblePublicId({
      providerId: CATALOG_FIXTURE_IDS.provider,
      localCollectibleId: CATALOG_FIXTURE_IDS.ambiguousLocalCollectible,
    }),
  },
  exactReplay: {
    request: unmatchedRequest,
    expectedOutcome: "unchanged",
    expectedGlobalCollectibleId: "40a85f64-ad56-5575-b21b-8024ee216651",
  },
  mergeAlias: {
    aliasCollectibleId: CATALOG_FIXTURE_IDS.mergeAliasCollectible,
    canonicalCollectibleId: CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
    expectedResolvedCollectibleId: CATALOG_FIXTURE_IDS.firstCanonicalCollectible,
  },
} as const);
