import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EV_INPUT_COVERAGE_TOLERANCE,
  type CanonicalEvInputProjectionContent,
} from "./catalog-projection-contracts.ts";
import { CatalogProjectionService } from "./catalog-projection-service.ts";
import type {
  CanonicalPackCandidate,
  CatalogAssetCandidate,
  EvInputCandidate,
  ProviderAdapterCandidate,
  ProviderConfigurationIdentity,
  ProviderSourceIdentity,
} from "./provider-adapter.ts";

const source: ProviderSourceIdentity = {
  platform: "synthetic-platform",
  recordKind: "catalog",
  recordIndex: 7,
  externalId: "source-catalog-7",
  collectedAt: "2026-07-02T03:04:05.000Z",
  sourceTimestamp: "2026-07-01T01:02:03.000Z",
};

const configuration: ProviderConfigurationIdentity = {
  providerId: "provider-1",
  configurationRevisionId: "config-revision-3",
  platform: source.platform,
  adapterKey: "synthetic-mapper-v1",
};

function pack(
  externalId = "pack-standard",
  overrides: Partial<CanonicalPackCandidate> = {},
): CanonicalPackCandidate {
  return {
    candidateKind: "pack",
    source,
    externalId,
    parentExternalId: null,
    name: "Standard Pack",
    description: null,
    category: null,
    availability: "available",
    relationships: [],
    dataQualityEvidence: [],
    ...overrides,
  };
}

function asset(
  externalId = "asset-card-1",
  overrides: Partial<CatalogAssetCandidate> = {},
): CatalogAssetCandidate {
  return {
    candidateKind: "catalog_asset",
    source,
    externalId,
    assetType: "card",
    relatedPackExternalId: null,
    parentExternalId: null,
    relationships: [],
    dataQualityEvidence: [],
    ...overrides,
  };
}

function evInput(overrides: Partial<EvInputCandidate> = {}): EvInputCandidate {
  return {
    candidateKind: "ev_input",
    source,
    externalId: "pack-standard:odds-v1",
    packExternalId: "pack-standard",
    currency: "usd",
    unitBasis: "per_pack",
    drawCount: 1,
    declaredCoverage: 1,
    evidenceCompleteness: "complete",
    buckets: [
      {
        bucketId: "common",
        evidenceKind: "probability_bucket",
        label: "Common",
        probability: 0.75,
        lowerValue: 1,
        upperValue: 2,
      },
      {
        bucketId: "rare",
        evidenceKind: "probability_bucket",
        label: "Rare",
        probability: 0.25,
        lowerValue: 5,
        upperValue: 15,
      },
      {
        bucketId: "chase",
        evidenceKind: "top_chase",
        label: "Named chase",
        probability: null,
        lowerValue: 100,
        upperValue: null,
      },
    ],
    relationships: [],
    dataQualityEvidence: [],
    ...overrides,
  };
}

function project(candidates: readonly ProviderAdapterCandidate[]) {
  return new CatalogProjectionService().project({
    configuration,
    source,
    candidates,
  });
}

function accepted(candidates: readonly ProviderAdapterCandidate[]) {
  const result = project(candidates);
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") throw new Error("Expected accepted projection.");
  return result.projections;
}

test("pack projection normalizes money and keeps provider EV separate with explicit nullable fields", () => {
  const [projection] = accepted([
    pack("pack-priced", {
      category: " Sports ",
      sourceStatus: "published",
      price: { amount: 24.995, currency: "usd" },
      providerReportedEv: { amount: 18.5, currency: "usdc" },
      buybackPercent: 70,
      drawCount: 3,
      imageUrls: ["https://images.example/b.png", "https://images.example/a.png"],
      dataQualityEvidence: [
        { code: "PARTIAL_SUPPLY", severity: "warning", fieldPath: "inventory" },
      ],
    }),
  ]);

  assert.deepEqual(projection?.content, {
    schemaVersion: "catalog-projection-v1",
    entityType: "pack",
    parentExternalId: null,
    firstSeenAt: source.sourceTimestamp,
    name: "Standard Pack",
    category: "Sports",
    description: null,
    availability: "available",
    availabilityProvenance: {
      kind: "canonical_provider_observation",
      observedAvailability: "available",
    },
    sourceStatus: "published",
    priceValueMinor: 2500,
    priceCurrency: "USD",
    providerReportedEvValueMinor: 1850,
    providerReportedEvCurrency: "USDC",
    buybackPercent: 70,
    drawCount: 3,
    imageUrls: ["https://images.example/a.png", "https://images.example/b.png"],
    dataQualityEvidence: [
      { code: "PARTIAL_SUPPLY", severity: "warning", fieldPath: "inventory" },
    ],
  });
  assert.deepEqual(projection?.provenance, {
    projectionVersion: "catalog-projection-v1",
    providerId: configuration.providerId,
    configurationRevisionId: configuration.configurationRevisionId,
    adapterKey: configuration.adapterKey,
    sourceRecordKind: "catalog",
    sourceRecordIndex: 7,
    sourceExternalId: source.externalId,
  });
  assert.equal(projection?.sourceUpdatedAt.toISOString(), source.sourceTimestamp);
  assert.equal(projection?.sourceCollectedAt.toISOString(), source.collectedAt);
});

test("nested purchasable variants remain distinct, sorted, and related to their parent", () => {
  const projections = accepted([
    pack("variant-z", { parentExternalId: "parent-pack", name: "Variant Z" }),
    pack("parent-pack", { name: "Parent Pack" }),
    pack("variant-a", { parentExternalId: "parent-pack", name: "Variant A" }),
  ]);

  assert.deepEqual(
    projections.map((projection) => projection.externalId),
    ["parent-pack", "variant-a", "variant-z"],
  );
  for (const variant of projections.slice(1)) {
    assert.deepEqual(variant.relationships, [
      {
        relationshipKind: "variant_of",
        targetPlatformKey: source.platform,
        targetRecordKind: "pack",
        targetExternalId: "parent-pack",
      },
    ]);
  }
});

test("supporting assets retain explicit unknown availability and late-resolvable relationships", () => {
  const [projection] = accepted([
    asset("inventory-card", {
      relatedPackExternalId: "pack-arrives-later",
      name: null,
      category: null,
      estimatedValue: { amount: 12.345, currency: "Usd" },
      valueSource: "provider_floor",
      imageUrls: undefined,
    }),
  ]);

  assert.equal(projection?.recordKind, "catalog_asset");
  assert.deepEqual(projection?.relationships, [
    {
      relationshipKind: "associated_with_pack",
      targetPlatformKey: source.platform,
      targetRecordKind: "pack",
      targetExternalId: "pack-arrives-later",
    },
  ]);
  assert.deepEqual(projection?.content, {
    schemaVersion: "catalog-projection-v1",
    entityType: "catalog_asset",
    assetType: "card",
    relatedPackExternalId: "pack-arrives-later",
    parentExternalId: null,
    firstSeenAt: source.sourceTimestamp,
    name: null,
    description: null,
    category: null,
    availability: "unknown",
    sourceStatus: null,
    providerValueMinor: 1235,
    providerValueCurrency: "USD",
    valueSource: "provider_floor",
    imageUrls: [],
    dataQualityEvidence: [
      {
        code: "MISSING_EXPLICIT_AVAILABILITY",
        severity: "warning",
        fieldPath: "availability",
      },
    ],
  });
});

test("EV input keeps probability evidence and top chases separate with readiness provenance", () => {
  const [projection] = accepted([evInput()]);
  const content = projection?.content as unknown as CanonicalEvInputProjectionContent;

  assert.equal(projection?.recordKind, "ev_input");
  assert.deepEqual(projection?.relationships, [
    {
      relationshipKind: "supports_pack",
      targetPlatformKey: source.platform,
      targetRecordKind: "pack",
      targetExternalId: "pack-standard",
    },
  ]);
  assert.equal(content.currency, "USD");
  assert.deepEqual(content.coverage, {
    declaredCoverage: 1,
    calculatedCoverage: 1,
    tolerance: EV_INPUT_COVERAGE_TOLERANCE,
    probabilityBucketCount: 2,
    topChaseCount: 1,
  });
  assert.deepEqual(
    content.probabilityBuckets.map((bucket) => [
      bucket.bucketId,
      bucket.lowerValueMinor,
      bucket.upperValueMinor,
    ]),
    [
      ["common", 100, 200],
      ["rare", 500, 1500],
    ],
  );
  assert.deepEqual(content.topChases, [
    {
      bucketId: "chase",
      label: "Named chase",
      probability: null,
      lowerValueMinor: 10_000,
      upperValueMinor: null,
    },
  ]);
  assert.deepEqual(content.readiness, { status: "ready", reasons: [] });
});

test("incomplete EV evidence stays accepted and does not change explicit pack availability", () => {
  const projections = accepted([
    pack(),
    evInput({
      declaredCoverage: 0.4,
      evidenceCompleteness: "partial",
      buckets: [
        {
          bucketId: "only-known-tier",
          evidenceKind: "probability_bucket",
          probability: 0.4,
          lowerValue: null,
          upperValue: 9,
        },
      ],
      dataQualityEvidence: [
        { code: "PARTIAL_INVENTORY", severity: "warning", fieldPath: "inventory" },
      ],
    }),
  ]);
  const packProjection = projections.find((projection) => projection.recordKind === "pack");
  const evProjection = projections.find((projection) => projection.recordKind === "ev_input");
  const ev = evProjection?.content as unknown as CanonicalEvInputProjectionContent;

  assert.equal(packProjection?.content.availability, "available");
  assert.deepEqual(ev.readiness, {
    status: "unavailable",
    reasons: [
      "incomplete_probability_coverage",
      "missing_value_bound",
      "incomplete_inventory",
    ],
  });
  assert.deepEqual(ev.dataQualityEvidence, [
    { code: "PARTIAL_INVENTORY", severity: "warning", fieldPath: "inventory" },
  ]);
});

test("top-chase-only input is accepted but explicitly unavailable", () => {
  const [projection] = accepted([
    evInput({
      declaredCoverage: null,
      evidenceCompleteness: "unknown",
      buckets: [
        {
          bucketId: "chase-only",
          evidenceKind: "top_chase",
          label: "Known chase",
          probability: null,
          lowerValue: 20,
          upperValue: null,
        },
      ],
    }),
  ]);
  const content = projection?.content as unknown as CanonicalEvInputProjectionContent;
  assert.deepEqual(content.readiness, {
    status: "unavailable",
    reasons: [
      "missing_probability_buckets",
      "incomplete_probability_coverage",
      "incomplete_inventory",
    ],
  });
  assert.equal(content.topChases.length, 1);
});

test("structurally invalid and unclassifiable candidate sets return stable quarantine outcomes", () => {
  const scenarios: Array<{
    candidates: readonly ProviderAdapterCandidate[];
    expectedReason: string;
  }> = [
    { candidates: [], expectedReason: "UNCLASSIFIABLE_CATALOG" },
    {
      candidates: [pack(" ")],
      expectedReason: "INVALID_IDENTITY",
    },
    {
      candidates: [pack("duplicate"), pack("duplicate")],
      expectedReason: "DUPLICATE_PROJECTION_IDENTITY",
    },
    {
      candidates: [
        {
          candidateKind: "pull",
          source,
          packExternalId: null,
          assetExternalId: null,
          occurredAt: source.sourceTimestamp,
          pseudonymizationInputs: [],
          relationships: [],
          dataQualityEvidence: [],
        },
      ],
      expectedReason: "UNSUPPORTED_CANDIDATE_KIND",
    },
  ];

  for (const scenario of scenarios) {
    const result = project(scenario.candidates);
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") assert.equal(result.reasonCode, scenario.expectedReason);
  }
});

test("projection is provider-neutral, deterministic, and allowlists output instead of leaking raw fields", () => {
  const synthetic = pack("opaque-pack", {
    price: { amount: 1, currency: "usd" },
  }) as CanonicalPackCandidate & { rawPayload: object; providerReportedSecret: string };
  synthetic.rawPayload = { wallet_address: "0xraw", provider_blob: "do-not-copy" };
  synthetic.providerReportedSecret = "secret";

  const first = accepted([synthetic, asset("asset-b")]);
  const second = accepted([asset("asset-b"), synthetic]);
  assert.deepEqual(first, second);
  assert.doesNotMatch(JSON.stringify(first), /wallet|provider_blob|do-not-copy|secret/i);

  const otherSource = { ...source, platform: "another-synthetic-platform" };
  const otherPack = { ...synthetic, source: otherSource };
  const other = new CatalogProjectionService().project({
    configuration: { ...configuration, platform: otherSource.platform },
    source: otherSource,
    candidates: [otherPack],
  });
  assert.equal(other.status, "accepted");
  if (other.status === "accepted") {
    assert.deepEqual(other.projections[0]?.content, first[1]?.content);
  }
});
