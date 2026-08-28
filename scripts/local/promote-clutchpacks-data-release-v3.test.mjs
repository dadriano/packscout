import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";
import {
  CLUTCHPACKS_CONVEX_PUBLICATION_URL,
  CLUTCHPACKS_CONVEX_QUERY_URL,
  ClutchpacksDataReleaseV3PromotionError,
  assertClutchpacksBackfill,
  assertClutchpacksCatalogScope,
  assertClutchpacksPlanCompleteness,
  assertClutchpacksPublicReadBack,
  assertNoPositiveClutchpacksEv,
  bindClutchpacksDataReleaseV3DatabaseIdentity,
  buildClutchpacksProviderObservationRequest,
  buildClutchpacksV3ActivationConfirmation,
  clutchpacksCatalogSourceWithEmptyShellOmissions,
  clutchpacksCollectibleReadbackProbes,
  clutchpacksConvexHttpClientAddress,
  exactDataReleaseV3StagingPort,
  operatorBoundDataReleaseV3ActivationPort,
  parseClutchpacksDataReleaseV3Command,
  readClutchpacksPublicReleaseWithClient,
  runClutchpacksDataReleaseV3Promotion,
} from "./promote-clutchpacks-data-release-v3.mjs";

const {
  clutchpacksAssetHasPublicName,
  clutchpacksAssetIsOmittablePublicShell,
} = await tsImport(
  "./generate-clutchpacks-v3-public-catalog-candidate.mts",
  import.meta.url,
);
const {
  PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
  approvedPublicCatalogConfigurationV1Schema,
  safePresentPackScoutPublicEvV3,
} = await tsImport(
  "@packscout/contracts",
  import.meta.url,
);
const { DataReleaseV3CanonicalCatalogAdapter } = await tsImport(
  "@packscout/services",
  import.meta.url,
);

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const READ_AT = "2026-08-27T19:20:44.000Z";
const RELEASE_ID = "22222222-2222-4222-8222-222222222222";
const PRIOR_RELEASE_ID = "22222222-2222-4222-8222-222222222221";
const RACING_RELEASE_ID = "22222222-2222-4222-8222-222222222223";
const FINGERPRINT = "a".repeat(64);
const HASH = "b".repeat(64);
const PUBLIC_VENDOR_ID = "60000000-0000-4000-8000-000000000001";
const PUBLICATION_SECRET = Buffer.alloc(32, 7).toString("base64");
const DATABASE_IDENTITY = Object.freeze({
  databaseName: "packscout_clutchpacks_v3_canary",
  databaseOid: "16432",
  systemIdentifier: "7541020403012209001",
});
const scriptPath = fileURLToPath(new URL(
  "./promote-clutchpacks-data-release-v3.mjs",
  import.meta.url,
));

test("Convex public readback uses a single-slash API address", () => {
  const address = clutchpacksConvexHttpClientAddress(
    CLUTCHPACKS_CONVEX_QUERY_URL,
  );
  assert.equal(address, "https://shiny-newt-310.convex.cloud");
  assert.equal(
    `${address}/api/query`,
    "https://shiny-newt-310.convex.cloud/api/query",
  );
  assert.throws(
    () => clutchpacksConvexHttpClientAddress(
      "https://different-newt-999.convex.cloud/",
    ),
    (error) => assertPromotionError(error, "CLUTCHPACKS_V3_TARGET_INVALID"),
  );
});

function baseEnvironment(overrides = {}) {
  return {
    PACKSCOUT_RUNTIME_ENVIRONMENT: "local",
    PACKSCOUT_PUBLIC_ORGANIZATION_ID: ORGANIZATION_ID,
    PACKSCOUT_CLUTCHPACKS_V3_READ_AT: READ_AT,
    PACKSCOUT_DATABASE_URL:
      "postgresql://packscout:database-secret@127.0.0.1:5432/packscout_clutchpacks_v3_canary",
    PACKSCOUT_CONVEX_PUBLICATION_BASE_URL:
      CLUTCHPACKS_CONVEX_PUBLICATION_URL,
    PACKSCOUT_CONVEX_URL: CLUTCHPACKS_CONVEX_QUERY_URL,
    PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_ID:
      "data-release-v3-publisher.v1",
    ...overrides,
  };
}

function dryCommand(environment = baseEnvironment()) {
  return bindClutchpacksDataReleaseV3DatabaseIdentity(
    parseClutchpacksDataReleaseV3Command({ argv: [], environment }),
    DATABASE_IDENTITY,
  );
}

function stageEnvironment(overrides = {}) {
  const environment = baseEnvironment(overrides);
  const command = dryCommand(environment);
  return {
    ...environment,
    PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_SECRET_BASE64: PUBLICATION_SECRET,
    PACKSCOUT_CLUTCHPACKS_V3_CONFIRMATION: command.stageConfirmation,
  };
}

function activationEnvironment(expectedActivePublicReleaseId = null) {
  const environment = baseEnvironment();
  const command = dryCommand(environment);
  return {
    ...environment,
    PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_SECRET_BASE64: PUBLICATION_SECRET,
    PACKSCOUT_CLUTCHPACKS_V3_CONFIRMATION:
      buildClutchpacksV3ActivationConfirmation({
        targetDigest: command.targetDigest,
        releaseFingerprint: FINGERPRINT,
        expectedActivePublicReleaseId,
      }),
  };
}

function publicRepackId(index) {
  return `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function product(index) {
  return {
    platformKey: "clutchpacks",
    productKey: `clutchpacks:pack-${index + 1}`,
    publicRepackId: publicRepackId(index),
    publicVendorId: PUBLIC_VENDOR_ID,
    vendorKey: "clutchpacks",
    availability: "available",
    categories: [{ publicCategoryId: publicCategoryId(index % 2) }],
  };
}

function publicCategoryId(index) {
  return `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function category(index) {
  return {
    publicCategoryId: publicCategoryId(index),
    name: `Category ${index + 1}`,
  };
}

function publicCollectibleId(index) {
  return `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function collectible(index) {
  return {
    publicCollectibleId: publicCollectibleId(index),
    name: `Collectible ${index + 1}`,
    normalizedName: `collectible ${index + 1}`,
    aliases: [],
    normalizedAliases: [],
    collectibleType: "card",
    publicCategoryIds: [publicCategoryId(index % 2)],
    primaryImage: null,
    valuation: null,
  };
}

function chase(index) {
  const item = collectible(index);
  return {
    publicRepackId: publicRepackId(index),
    publicCollectibleId: item.publicCollectibleId,
    role: "top_chase",
    evidenceKinds: ["catalog_relationship"],
    probabilityBasisPoints: null,
    collectible: collectibleDisplay(item),
    matchConfidence: { scoreBasisPoints: 9_000, band: "high" },
    observedAt: READ_AT,
    displayOrder: 0,
  };
}

function detail(index, overrides = {}) {
  return {
    publicRepackId: publicRepackId(index),
    publicVendorId: PUBLIC_VENDOR_ID,
    vendorKey: "clutchpacks",
    availability: "available",
    topChase: null,
    evEstimates: {
      packScout: {
        status: "current",
        metrics: {
          grossEvMoney: { minorUnits: 9_000, currency: "USD" },
          grossReturnBasisPoints: 9_000,
          evDollars: { minorUnits: -1_000, currency: "USD" },
          evPercentBasisPoints: -1_000,
        },
        methodVersion: "packscout-buyback-adjusted-ev-v1",
        confidencePolicyVersion:
          "packscout-buyback-adjusted-ev-confidence-v1",
        confidence: {
          policyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
          scoreBasisPoints: 10_000,
          band: "high",
          limitationCodes: [],
        },
        calculatedAt: READ_AT,
        dataAsOf: { state: "known", observedAt: READ_AT },
        sourceAge: {
          milliseconds: 0,
          state: "fresh_within_15_minutes",
        },
        expiresAt: new Date(
          new Date(READ_AT).getTime() + 60 * 60_000,
        ).toISOString(),
      },
    },
    ...overrides,
  };
}

function plan(overrides = {}) {
  const records = Array.from({ length: 17 }, (_, index) => detail(index));
  const categories = Array.from({ length: 2 }, (_, index) => category(index));
  const collectibles = Array.from(
    { length: 20 },
    (_, index) => collectible(index),
  );
  return {
    classification: "publish",
    publicReleaseId: RELEASE_ID,
    releaseFingerprint: FINGERPRINT,
    manifest: {
      methodVersion: "packscout-buyback-adjusted-ev-v1",
      confidencePolicyVersion:
        "packscout-buyback-adjusted-ev-confidence-v1",
      publicEvPolicyVersion: "packscout-public-ev-nonpositive-v1",
      dataAsOf: READ_AT,
      counts: {
        categories: 2,
        collectibles: 20,
        repacks: 17,
        chases: 0,
        searchShards: 1,
      },
      batchCount: 3,
      batchChainHash: HASH,
      topChaseCount: 0,
      entityChainHashes: {
        categories: HASH,
        collectibles: HASH,
        repacks: HASH,
        chases: HASH,
      },
    },
    batches: [
      { batchIndex: 0, kind: "categories", batchHash: HASH, records: categories },
      { batchIndex: 1, kind: "collectibles", batchHash: HASH, records: collectibles },
      { batchIndex: 2, kind: "repacks", batchHash: HASH, records },
    ],
    ...overrides,
  };
}

function snapshot() {
  return {
    organizationId: ORGANIZATION_ID,
    products: Array.from({ length: 17 }, (_, index) => product(index)),
    categories: Array.from({ length: 2 }, (_, index) => category(index)),
    collectibles: Array.from({ length: 20 }, (_, index) => collectible(index)),
    chases: [],
  };
}

function scope() {
  return assertClutchpacksCatalogScope(snapshot());
}

function canonicalAssetContent(overrides = {}) {
  return {
    schemaVersion: "catalog-projection-v1",
    firstSeenAt: READ_AT,
    imageUrls: [],
    dataQualityEvidence: [],
    entityType: "catalog_asset",
    assetType: "card",
    relatedPackExternalId: null,
    parentExternalId: null,
    name: null,
    description: null,
    category: null,
    availability: "unknown",
    sourceStatus: null,
    providerValueMinor: null,
    providerValueCurrency: null,
    valueSource: null,
    ...overrides,
  };
}

function stableIdHash(values) {
  return createHash("sha256").update(
    JSON.stringify([...values].sort()),
  ).digest("hex");
}

test("ClutchPacks source omits two associated empty shells while retaining all 21 named mappings", async () => {
  const namedExternalIds = Array.from(
    { length: 21 },
    (_, index) => `named-asset-${index.toString().padStart(2, "0")}`,
  );
  const shellExternalIds = ["associated-shell-a", "associated-shell-b"];
  const configuration = {
    collectibles: namedExternalIds.map((externalId) => ({
      platformKey: "clutchpacks",
      externalId,
    })),
  };
  const revisions = [{
    platformKey: "clutchpacks",
    recordKind: "pack",
    externalId: "pack-1",
    content: {},
  }, ...namedExternalIds.map((externalId) => ({
    platformKey: "clutchpacks",
    recordKind: "catalog_asset",
    externalId,
    content: canonicalAssetContent({ name: `Named ${externalId}` }),
  })), ...shellExternalIds.map((externalId) => ({
    platformKey: "clutchpacks",
    recordKind: "catalog_asset",
    externalId,
    content: canonicalAssetContent(),
  }))];
  const assetPackAssociations = [...namedExternalIds, ...shellExternalIds]
    .map((assetExternalId, index) => ({
      platformKey: "clutchpacks",
      assetExternalId,
      packExternalId: "pack-1",
      sourceEntityId: `association-${index}`,
      publicChangeSequence: BigInt(index + 1),
      associatedAt: new Date(READ_AT),
    }));
  const rawSnapshot = {
    readAt: new Date(READ_AT),
    configuration: { configuration },
    revisions,
    assetPackAssociations,
  };
  const source = clutchpacksCatalogSourceWithEmptyShellOmissions({
    async loadSourceSnapshot() {
      return rawSnapshot;
    },
  }, {
    parseConfiguration: (value) => ({ success: true, data: value }),
    hasPublicName: clutchpacksAssetHasPublicName,
    isOmittablePublicShell: clutchpacksAssetIsOmittablePublicShell,
  });

  const filtered = await source.loadSourceSnapshot({ readAt: READ_AT });
  const retainedAssets = filtered.revisions.filter(({ recordKind }) =>
    recordKind === "catalog_asset");
  const retainedAssetIds = retainedAssets.map(({ externalId }) => externalId);
  const retainedAssociationIds = filtered.assetPackAssociations.map(
    ({ assetExternalId }) => assetExternalId,
  );
  assert.equal(retainedAssets.length, 21);
  assert.equal(filtered.assetPackAssociations.length, 21);
  assert.ok(shellExternalIds.every((externalId) =>
    !retainedAssetIds.includes(externalId)));
  assert.equal(stableIdHash(retainedAssetIds), stableIdHash(namedExternalIds));
  assert.equal(
    stableIdHash(retainedAssociationIds),
    stableIdHash(namedExternalIds),
  );
  assert.equal(
    stableIdHash(configuration.collectibles.map(({ externalId }) => externalId)),
    stableIdHash(namedExternalIds),
  );

  const oneNamedMappingMissing = structuredClone(rawSnapshot);
  oneNamedMappingMissing.configuration.configuration.collectibles.pop();
  const failClosedSource = clutchpacksCatalogSourceWithEmptyShellOmissions({
    async loadSourceSnapshot() {
      return oneNamedMappingMissing;
    },
  }, {
    parseConfiguration: (value) => ({ success: true, data: value }),
    hasPublicName: clutchpacksAssetHasPublicName,
    isOmittablePublicShell: clutchpacksAssetIsOmittablePublicShell,
  });
  await assert.rejects(
    failClosedSource.loadSourceSnapshot({ readAt: READ_AT }),
    (error) => assertPromotionError(error, "CLUTCHPACKS_V3_SCOPE_INVALID"),
  );
});

function oneShellSourceSnapshot({ configured = false, associations } = {}) {
  const shellExternalId = "associated-empty-shell";
  return {
    readAt: new Date(READ_AT),
    configuration: {
      configuration: {
        collectibles: configured
          ? [{ platformKey: "clutchpacks", externalId: shellExternalId }]
          : [],
      },
    },
    revisions: [{
      platformKey: "clutchpacks",
      recordKind: "pack",
      externalId: "pack-1",
      content: {},
    }, {
      platformKey: "clutchpacks",
      recordKind: "catalog_asset",
      externalId: shellExternalId,
      content: canonicalAssetContent(),
    }],
    assetPackAssociations: associations ?? [{
      platformKey: "clutchpacks",
      assetExternalId: shellExternalId,
      packExternalId: "pack-1",
      sourceEntityId: "association-1",
      publicChangeSequence: 1n,
      associatedAt: new Date(READ_AT),
    }],
  };
}

function filteredShellSource(snapshotValue) {
  return clutchpacksCatalogSourceWithEmptyShellOmissions({
    async loadSourceSnapshot() {
      return snapshotValue;
    },
  }, {
    parseConfiguration: (value) => ({ success: true, data: value }),
    hasPublicName: clutchpacksAssetHasPublicName,
    isOmittablePublicShell: clutchpacksAssetIsOmittablePublicShell,
  });
}

test("ClutchPacks source refuses an already configured empty shell", async () => {
  const rawSnapshot = oneShellSourceSnapshot({ configured: true });
  await assert.rejects(
    filteredShellSource(rawSnapshot).loadSourceSnapshot({ readAt: READ_AT }),
    (error) => assertPromotionError(error, "CLUTCHPACKS_V3_SCOPE_INVALID"),
  );
});

test("ClutchPacks source refuses every unmapped or unnamed non-shell regardless of association or availability", async () => {
  for (const { configured, associations, content } of [{
    configured: false,
    associations: [],
    content: canonicalAssetContent({ availability: "available" }),
  }, {
    configured: true,
    associations: undefined,
    content: canonicalAssetContent({ availability: "unavailable" }),
  }, {
    configured: false,
    associations: [],
    content: canonicalAssetContent({
      name: "Unavailable but still requires an approved mapping",
      availability: "unavailable",
    }),
  }]) {
    const rawSnapshot = oneShellSourceSnapshot({ configured, associations });
    rawSnapshot.revisions[1].content = content;
    await assert.rejects(
      filteredShellSource(rawSnapshot).loadSourceSnapshot({ readAt: READ_AT }),
      (error) => assertPromotionError(error, "CLUTCHPACKS_V3_SCOPE_INVALID"),
    );
  }
});

test("ClutchPacks source leaves invalid relationship snapshots untouched for generic validation", async () => {
  const validAssociation = oneShellSourceSnapshot().assetPackAssociations[0];
  const invalidAssociationSets = [[{
    ...validAssociation,
    sourceEntityId: "",
  }], [{
    ...validAssociation,
    associatedAt: new Date(new Date(READ_AT).getTime() + 1),
  }], [validAssociation, {
    ...validAssociation,
    sourceEntityId: "association-2",
  }], [{
    ...validAssociation,
    assetExternalId: "missing-asset",
  }]];
  for (const assetPackAssociations of invalidAssociationSets) {
    const rawSnapshot = oneShellSourceSnapshot({
      associations: assetPackAssociations,
    });
    const filtered = await filteredShellSource(rawSnapshot).loadSourceSnapshot({
      readAt: READ_AT,
    });
    assert.equal(filtered, rawSnapshot);
  }
});

test("real V3 adapter projects every retained mapping and no omitted associated shell", async () => {
  const publicRepackId = "22222222-2222-5222-8222-222222222222";
  const associatedCollectibleId = "33333333-3333-5333-8333-333333333333";
  const standaloneCollectibleId = "44444444-4444-5444-8444-444444444444";
  const configuration = {
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: "clutchpacks-adapter-shell-proof-v1",
    revision: 1,
    approvedAt: READ_AT,
    staleAfterSeconds: 900,
    confidencePolicy: {
      version: "clutchpacks-shell-proof-v1",
      completeScoreBasisPoints: 9_000,
      partialScoreBasisPoints: 6_000,
      unknownScoreBasisPoints: 3_000,
      limitationPenaltyBasisPoints: 500,
    },
    publicAssetOrigins: [],
    verifiedUsdStablecoins: [],
    categories: [],
    platforms: [{
      platformKey: "clutchpacks",
      vendor: {
        publicVendorId: "11111111-1111-5111-8111-111111111111",
        vendorKey: "clutchpacks",
        displayName: "ClutchPacks",
        logoUrl: null,
        websiteUrl: "https://clutchpacks.io/",
        listingHosts: ["clutchpacks.io"],
        imageOrigins: [],
        referralParameters: [],
        publicPromo: null,
      },
      format: "repack",
      defaultPublicCategoryIds: [],
      categoryMappings: [],
      collectibleTypeMappings: [],
    }],
    repacks: [{
      platformKey: "clutchpacks",
      packExternalId: "pack-1",
      publicRepackId,
      listingUrl: "https://clutchpacks.io/checkout/pack-1/",
    }],
    collectibles: [{
      platformKey: "clutchpacks",
      externalId: "mapped-associated",
      publicCollectibleId: associatedCollectibleId,
      aliases: [],
      collectibleType: "card",
      publicCategoryIds: [],
      year: null,
      brand: null,
      setOrSeries: null,
      cardNumber: null,
      referenceNumber: null,
      subject: null,
      grade: null,
      grader: null,
      probabilityBucketId: null,
      matchConfidenceBasisPoints: 10_000,
      chaseEvidenceKinds: [
        "historical_pull_inference",
        "packscout_resolved",
      ],
    }, {
      platformKey: "clutchpacks",
      externalId: "mapped-standalone",
      publicCollectibleId: standaloneCollectibleId,
      aliases: [],
      collectibleType: "card",
      publicCategoryIds: [],
      year: null,
      brand: null,
      setOrSeries: null,
      cardNumber: null,
      referenceNumber: null,
      subject: null,
      grade: null,
      grader: null,
      probabilityBucketId: null,
      matchConfidenceBasisPoints: 10_000,
      chaseEvidenceKinds: ["packscout_resolved"],
    }],
  };
  assert.equal(
    approvedPublicCatalogConfigurationV1Schema.safeParse(configuration).success,
    true,
  );
  const revision = (recordKind, externalId, content, sequence) => ({
    entityId: `entity-${externalId}`,
    platformKey: "clutchpacks",
    recordKind,
    externalId,
    content,
    sourceUpdatedAt: new Date(READ_AT),
    sourceCollectedAt: new Date(READ_AT),
    acceptedAt: new Date(READ_AT),
    publicChangeSequence: BigInt(sequence),
  });
  const sourceSnapshot = {
    organizationId: ORGANIZATION_ID,
    readAt: new Date(READ_AT),
    configuration: {
      id: "configuration-1",
      configuration,
      configurationHash: HASH,
      publicChangeSequence: 1n,
    },
    providers: [{
      platformKey: "clutchpacks",
      state: "active",
      lifecycleSequence: 1n,
      providerId: "55555555-5555-4555-8555-555555555555",
      sourceInstanceId: "66666666-6666-4666-8666-666666666666",
      sourceRevisionId: "77777777-7777-4777-8777-777777777777",
      completedBackfillAt: new Date(READ_AT),
    }],
    revisions: [
      revision("pack", "pack-1", {
        schemaVersion: "catalog-projection-v1",
        firstSeenAt: READ_AT,
        imageUrls: [],
        dataQualityEvidence: [],
        entityType: "pack",
        evInputStatus: "unavailable",
        parentExternalId: null,
        name: "ClutchPacks adapter proof",
        category: null,
        description: null,
        availability: "available",
        availabilityProvenance: {
          kind: "canonical_provider_observation",
          observedAvailability: "available",
        },
        sourceStatus: null,
        priceValueMinor: 10_000,
        priceCurrency: "USD",
        providerReportedEvValueMinor: null,
        providerReportedEvCurrency: null,
        buybackPercent: 90,
        drawCount: 1,
      }, 1),
      revision("catalog_asset", "mapped-associated", canonicalAssetContent({
        name: "Mapped associated card",
      }), 2),
      revision("catalog_asset", "mapped-standalone", canonicalAssetContent({
        name: "Mapped standalone card",
      }), 3),
      revision("catalog_asset", "omitted-associated-shell",
        canonicalAssetContent(), 4),
    ],
    repackIdentities: [{
      platformKey: "clutchpacks",
      packExternalId: "pack-1",
      publicRepackId,
      approvedConfigurationKey: configuration.configurationKey,
      publicChangeSequence: 1n,
      approvedAt: new Date(READ_AT),
    }],
    assetPackAssociations: [{
      platformKey: "clutchpacks",
      assetExternalId: "mapped-associated",
      packExternalId: "pack-1",
      sourceEntityId: "pull-mapped",
      publicChangeSequence: 2n,
      associatedAt: new Date(READ_AT),
    }, {
      platformKey: "clutchpacks",
      assetExternalId: "omitted-associated-shell",
      packExternalId: "pack-1",
      sourceEntityId: "pull-shell",
      publicChangeSequence: 4n,
      associatedAt: new Date(READ_AT),
    }],
    soldOutTransitions: [],
  };
  const source = clutchpacksCatalogSourceWithEmptyShellOmissions({
    async loadSourceSnapshot() {
      return sourceSnapshot;
    },
  }, {
    parseConfiguration: (value) =>
      approvedPublicCatalogConfigurationV1Schema.safeParse(value),
    hasPublicName: clutchpacksAssetHasPublicName,
    isOmittablePublicShell: clutchpacksAssetIsOmittablePublicShell,
  });
  const projected = await new DataReleaseV3CanonicalCatalogAdapter(source)
    .loadCatalogSnapshot({ readAt: READ_AT });

  assert.equal(projected.products.length, 1);
  assert.deepEqual(
    projected.collectibles.map(({ publicCollectibleId }) => publicCollectibleId),
    [associatedCollectibleId, standaloneCollectibleId],
  );
  assert.equal(projected.chases.length, 1);
  assert.equal(projected.chases[0].publicCollectibleId, associatedCollectibleId);
  assert.equal(projected.products[0].topChase.publicCollectibleId,
    associatedCollectibleId);
  assert.equal(projected.products[0].contentSummary.knownCollectibleCount, 1);
  assert.equal(projected.products[0].contentSummary.chaseCount, 1);
  assert.deepEqual(projected.products[0].collectibleTypes, ["card"]);
});

function planRecords(candidate, kind) {
  return candidate.batches
    .filter((batch) => batch.kind === kind)
    .flatMap((batch) => batch.records);
}

function collectibleDisplay(item) {
  return {
    publicCollectibleId: item.publicCollectibleId,
    name: item.name,
    collectibleType: item.collectibleType,
    publicCategoryIds: item.publicCategoryIds,
    primaryImage: item.primaryImage,
    valuation: item.valuation,
  };
}

function backfill({
  staged = false,
  staleIndex = null,
  unknownSourceIndex = null,
} = {}) {
  return {
    classification: "ready",
    ledger: {
      classification: "ready",
      counts: {
        total: 17,
        recomputedAvailable: 16,
        deterministicUnavailable: 1,
        soldOutHistorical: 0,
      },
      recomputation: {
        created: 0,
        unchanged: 17,
        superseded: 0,
        rejected: 0,
        unbindable: 0,
        skippedNoEvidence: 0,
      },
      staging: staged
        ? {
            staged: true,
            lifecycle: "complete",
            activePointerMoved: false,
          }
        : null,
      rows: Array.from({ length: 17 }, (_, index) => ({
        platformKey: "clutchpacks",
        publicRepackId: publicRepackId(index),
        sourceAgeBucket: index === unknownSourceIndex
          ? "unknown_source_time"
          : index === staleIndex
            ? "stale_or_expired"
            : "fresh_within_15_minutes",
      })),
    },
  };
}

test("backfill requires one current non-superseded outcome per ClutchPacks pack", () => {
  const expectedPublicRepackIds = Array.from(
    { length: 17 },
    (_, index) => publicRepackId(index),
  );
  const staleLineage = backfill();
  staleLineage.ledger.recomputation.created = 1;
  staleLineage.ledger.recomputation.unchanged = 15;
  staleLineage.ledger.recomputation.superseded = 1;

  assert.throws(
    () => assertClutchpacksBackfill(staleLineage, expectedPublicRepackIds),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_BACKFILL_BLOCKED",
    ),
  );
});

function activeState(publicReleaseId = null, generation = 0) {
  return {
    generation,
    activeRelease: publicReleaseId === null
      ? null
      : { publicReleaseId, releaseFingerprint: "c".repeat(64) },
    previousRelease: null,
  };
}

function status(candidate = plan()) {
  return {
    publicReleaseId: candidate.publicReleaseId,
    releaseFingerprint: candidate.releaseFingerprint,
    lifecycle: "complete",
    acceptedCounts: candidate.manifest.counts,
    acceptedBatchCount: candidate.manifest.batchCount,
    acceptedBatchChainHash: candidate.manifest.batchChainHash,
    acceptedEntityChainHashes: candidate.manifest.entityChainHashes,
    acceptedSearchRowCount: 17,
    acceptedSearchRowSetHash: HASH,
    acceptedTopChaseCount: candidate.manifest.topChaseCount,
    completedAt: "2026-08-27T19:21:00.000Z",
  };
}

const DEFAULT_CURRENT_TIME = new Date(READ_AT).getTime() + 15 * 60_000;

function providerObservationFacts(overrides = {}) {
  return {
    sourceLifecycle: "paused",
    connectionState: "healthy",
    qualityState: "healthy",
    lastHeadReachedAt: new Date(READ_AT),
    freshnessHorizonMilliseconds: 30 * 60_000,
    ...overrides,
  };
}

function settledWatermark(overrides = {}) {
  return {
    organizationId: ORGANIZATION_ID,
    settledSequence: 148_290n,
    settledAt: new Date(READ_AT),
    sourceHeadSequence: 148_290n,
    sourceHeadAt: new Date(READ_AT),
    sourceHeads: [{ settled: true }],
    ...overrides,
  };
}

function observationRequest(
  candidate = plan(),
  currentTime = DEFAULT_CURRENT_TIME,
  facts = providerObservationFacts(),
  watermark = settledWatermark(),
) {
  return buildClutchpacksProviderObservationRequest({
    plan: candidate,
    watermark,
    facts,
    currentTimeMilliseconds: currentTime,
  });
}

function readBackVerification(candidate = plan(), currentTime = DEFAULT_CURRENT_TIME) {
  return {
    currentTime,
    providerObservation: observationRequest(candidate, currentTime),
    presentPackScoutPublicEv: safePresentPackScoutPublicEvV3,
    publicFreshnessPolicyVersion:
      PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
  };
}

function publicHealth(observation, currentTime) {
  const observedAt = Date.parse(observation.observedAt);
  const freshThrough = Date.parse(observation.freshThrough);
  const reason = freshThrough < observedAt || currentTime < observedAt
    ? "PROVIDER_UNHEALTHY"
    : observation.sourceLifecycle !== "active"
    ? "PROVIDER_PAUSED"
    : observation.connectionState !== "healthy" ||
        observation.qualityState !== "healthy"
      ? "PROVIDER_UNHEALTHY"
      : observation.releaseAlignment !== "aligned" ||
          observation.lastHeadReachedAt === null ||
          observation.sourceHeadSequence !== observation.settledSequence
        ? "PROVIDER_BEHIND"
        : currentTime >= freshThrough
          ? "PROVIDER_OBSERVATION_STALE"
          : null;
  return reason === null
    ? {
        state: "healthy",
        observedAt: observation.observedAt,
        rankingEligible: true,
        rankingIneligibilityReason: null,
      }
    : {
        state: "delayed",
        observedAt: observation.observedAt,
        rankingEligible: false,
        rankingIneligibilityReason: reason,
      };
}

function publicReadBack(
  candidate = plan(),
  count = 17,
  governedScope = scope(),
  options = {},
) {
  const currentTime = options.currentTime ?? DEFAULT_CURRENT_TIME;
  const surfaceTimes = options.surfaceTimes ?? {};
  const shellTime = surfaceTimes.shell ?? currentTime;
  const listTime = surfaceTimes.list ?? currentTime;
  const dashboardTime = surfaceTimes.dashboard ?? currentTime;
  const observation = options.providerObservation ??
    observationRequest(candidate, currentTime);
  const healthSummary = (health) => ({
    state: health.state,
    observedAt: observation.observedAt,
    freshThrough: observation.freshThrough,
    nextHealthEvaluationAt: health.rankingEligible
      ? observation.freshThrough
      : null,
    totalProviderCount: 1,
    delayedProviderCount: health.rankingEligible ? 0 : 1,
  });
  const plannedDetails = planRecords(candidate, "repacks").slice(0, count);
  const plannedById = new Map(
    plannedDetails.map((entry) => [entry.publicRepackId, entry]),
  );
  const detailAt = (entry, evaluationTime) => {
    const confidenceEvaluatedAt = new Date(evaluationTime).toISOString();
    const presented = safePresentPackScoutPublicEvV3(
      entry.evEstimates.packScout,
      confidenceEvaluatedAt,
    );
    assert.equal(presented.success, true);
    return {
      ok: true,
      data: {
        ...structuredClone(entry),
        heat: { status: "unavailable" },
        packScoutEvPresentation: presented.presentation,
        providerHealth: publicHealth(observation, evaluationTime),
      },
    };
  };
  const summaryFromDetail = (data) => {
    const { description: _description, actions: _actions, ...summary } =
      structuredClone(data);
    return summary;
  };
  const listDetails = plannedDetails.map((entry) =>
    detailAt(entry, listTime).data);
  const rows = listDetails.map(summaryFromDetail);
  const details = plannedDetails.map((entry, index) =>
    detailAt(entry, surfaceTimes.details?.[index] ?? currentTime));
  const dashboardHealth = publicHealth(observation, dashboardTime);
  const opportunityCandidates = plannedDetails.map((entry) =>
    detailAt(entry, dashboardTime)).filter(({ data }) =>
    data.availability === "available" &&
    ["current", "last_known"].includes(data.packScoutEvPresentation.status));
  const dashboardDetails = dashboardHealth.rankingEligible
    ? opportunityCandidates.slice(0, 6).map(({ data }) => structuredClone(data))
    : [];
  const dashboardRows = dashboardDetails.map(summaryFromDetail);
  const probes = clutchpacksCollectibleReadbackProbes(governedScope);
  const collectibleReads = probes.direct.map((item, index) => {
    const collectibleTime = surfaceTimes.collectibleReads?.[index] ??
      currentTime;
    const confidenceEvaluatedAt = new Date(collectibleTime).toISOString();
    const matches = governedScope.entities.chases
      .filter((entry) =>
        entry.publicCollectibleId === item.publicCollectibleId)
      .map((entry) => ({
        chase: structuredClone(entry),
        repack: summaryFromDetail(
          detailAt(plannedById.get(entry.publicRepackId), collectibleTime).data,
        ),
      }));
    return {
      publicCollectibleId: item.publicCollectibleId,
      result: {
        ok: true,
        data: {
          release: { publicReleaseId: candidate.publicReleaseId },
          publicFreshnessPolicyVersion:
            PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
          confidenceEvaluatedAt,
          providerHealthEvaluatedAt: confidenceEvaluatedAt,
          desiredCollectible: collectibleDisplay(item),
          matches,
          total: matches.length,
        },
      },
    };
  });
  const collectibleSearches = probes.search.map((item) => ({
    publicCollectibleId: item.publicCollectibleId,
    search: item.normalizedName,
    result: {
      ok: true,
      data: {
        release: { publicReleaseId: candidate.publicReleaseId },
        matches: [structuredClone(item)],
      },
    },
  }));
  return {
    shell: {
      ok: true,
      data: {
        release: {
          publicReleaseId: candidate.publicReleaseId,
          dataAsOf: candidate.manifest.dataAsOf,
          methodVersion: candidate.manifest.methodVersion,
          confidencePolicyVersion: candidate.manifest.confidencePolicyVersion,
          publicEvPolicyVersion: candidate.manifest.publicEvPolicyVersion,
        },
        publicFreshnessPolicyVersion:
          PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
        confidenceEvaluatedAt: new Date(shellTime).toISOString(),
        providerHealthEvaluatedAt: new Date(shellTime).toISOString(),
        providerHealthSummary: healthSummary(
          publicHealth(observation, shellTime),
        ),
      },
    },
    list: {
      ok: true,
      data: {
        release: { publicReleaseId: candidate.publicReleaseId },
        publicFreshnessPolicyVersion:
          PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
        confidenceEvaluatedAt: new Date(listTime).toISOString(),
        providerHealthEvaluatedAt: new Date(listTime).toISOString(),
        providerHealthSummary: healthSummary(
          publicHealth(observation, listTime),
        ),
        rows,
        details: listDetails.map((detail) => structuredClone(detail)),
        range: { start: 1, end: count, total: count },
        nextCursor: null,
      },
    },
    details,
    dashboard: {
      ok: true,
      data: {
        release: { publicReleaseId: candidate.publicReleaseId },
        publicFreshnessPolicyVersion:
          PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
        confidenceEvaluatedAt: new Date(dashboardTime).toISOString(),
        providerHealthEvaluatedAt: new Date(dashboardTime).toISOString(),
        providerHealthSummary: healthSummary(dashboardHealth),
        opportunityEligibility: {
          rankingEligibleRepackCount: dashboardHealth.rankingEligible
            ? opportunityCandidates.length
            : 0,
          providerIneligibleRepackCount: dashboardHealth.rankingEligible
            ? 0
            : opportunityCandidates.length,
        },
        opportunities: dashboardRows,
        details: dashboardDetails,
        selectedRepack: dashboardDetails[0] ?? null,
        facets: {
          categories: [...new Set(governedScope.entities.products.flatMap(
            (entry) => entry.categories.map((category) =>
              category.publicCategoryId),
          ))].sort().map((key) => ({ key })),
        },
      },
    },
    collectibleReads,
    collectibleSearches,
  };
}

test("Convex readback uses server-clock actions and keeps search as a query", async () => {
  const candidate = plan();
  const governedScope = scope();
  const expected = publicReadBack(candidate, 17, governedScope);
  const refs = {
    getPublicShellStatusV3: "shell",
    listPublicRepacksV3: "list",
    getPublicRepackV3: "detail",
    getDashboardBundleV3: "dashboard",
    findRepacksByDesiredCollectibleV3: "desired",
    searchPublicCollectiblesV3: "search",
  };
  const api = { publicRepacksV3: refs };
  const detailById = new Map(expected.details.map((result) => [
    result.data.publicRepackId,
    result,
  ]));
  const desiredById = new Map(expected.collectibleReads.map((read) => [
    read.publicCollectibleId,
    read.result,
  ]));
  const searchByName = new Map(expected.collectibleSearches.map((search) => [
    search.search,
    search.result,
  ]));
  const calls = [];
  const client = {
    async action(reference, args) {
      calls.push({ kind: "action", reference, args });
      if (reference === refs.getPublicShellStatusV3) return expected.shell;
      if (reference === refs.listPublicRepacksV3) return expected.list;
      if (reference === refs.getPublicRepackV3) {
        return detailById.get(args.publicRepackId);
      }
      if (reference === refs.getDashboardBundleV3) return expected.dashboard;
      if (reference === refs.findRepacksByDesiredCollectibleV3) {
        return desiredById.get(args.publicCollectibleId);
      }
      assert.fail(`unexpected action ${reference}`);
    },
    async query(reference, args) {
      calls.push({ kind: "query", reference, args });
      assert.equal(reference, refs.searchPublicCollectiblesV3);
      return searchByName.get(args.search);
    },
  };

  const actual = await readClutchpacksPublicReleaseWithClient(
    client,
    api,
    { catalogReadToken: "catalog-read-token" },
    {
      plan: candidate,
      scope: governedScope,
      currentTime: DEFAULT_CURRENT_TIME,
    },
  );

  assert.deepEqual(actual, expected);
  assert.equal(calls.filter(({ kind }) => kind === "action").length, 23);
  assert.equal(calls.filter(({ kind }) => kind === "query").length, 3);
  assert.equal(calls.every(({ args }) => !("currentTime" in args)), true);
  assert.equal(
    calls.every(({ args }) => args.catalogReadToken === "catalog-read-token"),
    true,
  );
});

function fakeDependencies({
  candidate = plan(),
  catalogSnapshot = snapshot(),
  catalogError = null,
  active = activeState(),
  stagedStatus = status(candidate),
  readBack = null,
  rollbackFails = false,
  staleIndex = null,
  unknownSourceIndex = null,
  providerFacts = providerObservationFacts(),
  refreshFails = false,
  refreshResult = "provider_observation_created",
  databaseIdentities = [DATABASE_IDENTITY],
  watermark = settledWatermark(),
  localCurrentTime = DEFAULT_CURRENT_TIME,
  activationServerTime = new Date(DEFAULT_CURRENT_TIME).toISOString(),
  activationOutcome = "activated",
} = {}) {
  const timeline = [];
  const activationInputs = [];
  const publicReadInputs = [];
  const providerFactTimes = [];
  const providerObservationInputs = [];
  let assemblyCount = 0;
  let currentActive = active;
  let databaseIdentityReadCount = 0;
  const readDatabaseIdentity = async () => {
    const identity = databaseIdentities[Math.min(
      databaseIdentityReadCount,
      databaseIdentities.length - 1,
    )];
    databaseIdentityReadCount += 1;
    return identity;
  };
  return {
    timeline,
    activationInputs,
    publicReadInputs,
    providerFactTimes,
    providerObservationInputs,
    getDatabaseIdentityReadCount: () => databaseIdentityReadCount,
    getActiveState: () => currentActive,
    setActiveState: (value) => {
      currentActive = value;
    },
    dependencies: {
      now: () => localCurrentTime,
      readDatabaseIdentity,
      async open() {
        timeline.push("open");
        return {
          presentPackScoutPublicEv: safePresentPackScoutPublicEvV3,
          publicFreshnessPolicyVersion:
            PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
          readDatabaseIdentity,
          catalog: {
            async loadCatalogSnapshot() {
              timeline.push("catalog");
              if (catalogError !== null) throw catalogError;
              return catalogSnapshot;
            },
          },
          async loadSettledWatermark() {
            timeline.push("watermark");
            return watermark;
          },
          assembler: {
            async assemble() {
              timeline.push(`assemble:${++assemblyCount}`);
              return candidate;
            },
          },
          publication: {
            async activeState() {
              timeline.push("active-state");
              return currentActive;
            },
            async status() {
              timeline.push("status");
              return stagedStatus;
            },
          },
          async runBackfill() {
            timeline.push("backfill:preflight");
            return backfill({ staleIndex, unknownSourceIndex });
          },
          async stagePlan(receivedPlan) {
            timeline.push("backfill:stage");
            assert.equal(receivedPlan, candidate);
            return backfill({ staged: true, staleIndex, unknownSourceIndex });
          },
          async activate(receivedPlan, expectedActivePublicReleaseId) {
            timeline.push("activate");
            activationInputs.push({
              publicReleaseId: receivedPlan.publicReleaseId,
              expectedActivePublicReleaseId,
            });
            if (
              (currentActive.activeRelease?.publicReleaseId ?? null) !==
                expectedActivePublicReleaseId
            ) {
              throw new ClutchpacksDataReleaseV3PromotionError(
                "CLUTCHPACKS_V3_ACTIVE_POINTER_MOVED",
              );
            }
            if (activationOutcome === "unchanged") {
              return {
                outcome: "unchanged",
                publicReleaseId: receivedPlan.publicReleaseId,
                releaseFingerprint: receivedPlan.releaseFingerprint,
              };
            }
            const previousRelease = currentActive.activeRelease;
            currentActive = {
              generation: currentActive.generation + 1,
              activeRelease: {
                publicReleaseId: receivedPlan.publicReleaseId,
                releaseFingerprint: receivedPlan.releaseFingerprint,
              },
              previousRelease,
            };
            return {
              outcome: "activated",
              previousPublicReleaseId:
                previousRelease?.publicReleaseId ?? null,
              receipts: {
                activate: { serverTime: activationServerTime },
              },
            };
          },
          async rollback(input) {
            timeline.push("rollback");
            if (rollbackFails) throw new Error("rollback unavailable");
            if (
              currentActive.activeRelease?.publicReleaseId !==
                input.expectedActivePublicReleaseId ||
              currentActive.previousRelease?.publicReleaseId !==
                input.targetPublicReleaseId
            ) {
              throw new Error("rollback predecessor mismatch");
            }
            const previousRelease = currentActive.activeRelease;
            currentActive = {
              generation: currentActive.generation + 1,
              activeRelease: currentActive.previousRelease,
              previousRelease,
            };
          },
          async loadProviderObservationFacts({ currentTime }) {
            timeline.push("provider-observation-facts");
            providerFactTimes.push(currentTime);
            return providerFacts;
          },
          async refreshProviderObservation(request) {
            timeline.push("provider-observation-refresh");
            providerObservationInputs.push(request);
            if (refreshFails) throw new Error("provider observation unavailable");
            return {
              operationKind: "refreshProviderObservation",
              operationId: request.operationId,
              idempotencyKey: request.idempotencyKey,
              publicReleaseId: request.publicReleaseId,
              result: refreshResult,
              details: {
                publicVendorId: request.publicVendorId,
                vendorKey: request.vendorKey,
                observationSequence: request.observationSequence,
                observedAt: request.observedAt,
                freshThrough: request.freshThrough,
              },
            };
          },
          async readPublicServerTime() {
            timeline.push("public-server-time");
            return activationServerTime;
          },
          async readPublicRelease(input) {
            timeline.push("public-read");
            publicReadInputs.push(input);
            const observation = providerObservationInputs.at(-1);
            return readBack ?? publicReadBack(candidate, 17, scope(), {
              currentTime: Date.parse(observation.observedAt),
              providerObservation: observation,
            });
          },
          async close() {
            timeline.push("close");
          },
        };
      },
    },
  };
}

function advanceWatermarkAfterFirstRead(fake) {
  const initialOpen = fake.dependencies.open;
  fake.dependencies.open = async (...args) => {
    const opened = await initialOpen(...args);
    const initialLoad = opened.loadSettledWatermark;
    let readCount = 0;
    opened.loadSettledWatermark = async () => {
      const current = await initialLoad();
      readCount += 1;
      return readCount === 1
        ? current
        : {
            ...current,
            settledSequence: current.settledSequence + 1n,
            settledAt: new Date(new Date(READ_AT).getTime() + 1_000),
            sourceHeadSequence: current.sourceHeadSequence + 1n,
            sourceHeadAt: new Date(new Date(READ_AT).getTime() + 1_000),
          };
    };
    return opened;
  };
}

function assertPromotionError(error, expectedCode) {
  assert.ok(error instanceof ClutchpacksDataReleaseV3PromotionError);
  assert.equal(error.code, expectedCode);
  assert.doesNotMatch(error.message, /database-secret|data-release-v3-publisher/iu);
  return true;
}

test("dry run binds the connected local canary identity without opening write resources", async () => {
  const fake = fakeDependencies();
  const outputs = [];
  const result = await runClutchpacksDataReleaseV3Promotion({
    argv: [],
    environment: baseEnvironment(),
    dependencies: fake.dependencies,
    writeOutput: (value) => outputs.push(value),
  });
  assert.equal(result.status, "planned");
  assert.equal(result.expectedRepackCount, 17);
  assert.match(result.requiredStageConfirmation,
    /^STAGE CLUTCHPACKS DATA RELEASE V3 [0-9a-f]{16}$/u);
  assert.deepEqual(result.databaseIdentity, DATABASE_IDENTITY);
  assert.equal(fake.getDatabaseIdentityReadCount(), 1);
  assert.deepEqual(fake.timeline, []);
  assert.deepEqual(outputs, [result]);
});

test("promotion confirmation changes with database OID or cluster identity", async () => {
  const baseline = fakeDependencies();
  const baselineResult = await runClutchpacksDataReleaseV3Promotion({
    argv: [],
    environment: baseEnvironment(),
    dependencies: baseline.dependencies,
    writeOutput() {},
  });
  for (const replacementIdentity of [{
    ...DATABASE_IDENTITY,
    databaseOid: "16433",
  }, {
    ...DATABASE_IDENTITY,
    systemIdentifier: "7541020403012209002",
  }]) {
    const replacement = fakeDependencies({
      databaseIdentities: [replacementIdentity],
    });
    const replacementResult = await runClutchpacksDataReleaseV3Promotion({
      argv: [],
      environment: baseEnvironment(),
      dependencies: replacement.dependencies,
      writeOutput() {},
    });
    assert.notEqual(
      replacementResult.requiredStageConfirmation,
      baselineResult.requiredStageConfirmation,
    );
  }
});

test("promotion reverifies the opened database immediately before mutation", async () => {
  const replacementIdentity = {
    ...DATABASE_IDENTITY,
    systemIdentifier: "7541020403012209002",
  };
  const fake = fakeDependencies({
    databaseIdentities: [
      DATABASE_IDENTITY,
      DATABASE_IDENTITY,
      replacementIdentity,
    ],
  });
  await assert.rejects(
    runClutchpacksDataReleaseV3Promotion({
      argv: ["--stage"],
      environment: stageEnvironment(),
      dependencies: fake.dependencies,
      writeOutput() {},
    }),
    (error) => assertPromotionError(error, "CLUTCHPACKS_V3_TARGET_INVALID"),
  );
  assert.equal(fake.getDatabaseIdentityReadCount(), 3);
  assert.deepEqual(fake.timeline, ["open", "watermark", "catalog", "close"]);
  assert.equal(fake.timeline.includes("backfill:preflight"), false);
  assert.equal(fake.timeline.includes("backfill:stage"), false);
  assert.equal(fake.timeline.includes("activate"), false);
});

test("command rejects the wrong database, Convex deployment, runtime, secret, and confirmation", async () => {
  const invalidEnvironments = [
    baseEnvironment({ PACKSCOUT_RUNTIME_ENVIRONMENT: "preproduction" }),
    baseEnvironment({
      PACKSCOUT_DATABASE_URL:
        "postgresql://packscout:secret@neon.example.test/packscout_clutchpacks_v3_canary",
    }),
    baseEnvironment({
      PACKSCOUT_DATABASE_URL:
        "postgresql://packscout:secret@127.0.0.1:5432/packscout_dev",
    }),
    baseEnvironment({
      PACKSCOUT_DATABASE_URL:
        "postgresql://packscout:secret@127.0.0.1:5432/packscout_clutchpacks_v3_canary?host=remote.example",
    }),
    baseEnvironment({
      PACKSCOUT_CONVEX_PUBLICATION_BASE_URL:
        "https://different.convex.site/",
    }),
    baseEnvironment({
      PACKSCOUT_CONVEX_URL: "https://different.convex.cloud/",
    }),
  ];
  for (const environment of invalidEnvironments) {
    assert.throws(
      () => parseClutchpacksDataReleaseV3Command({ argv: [], environment }),
      (error) => assertPromotionError(error, "CLUTCHPACKS_V3_TARGET_INVALID"),
    );
  }
  const fake = fakeDependencies();
  await assert.rejects(
    runClutchpacksDataReleaseV3Promotion({
      argv: ["--stage"],
      environment: {
        ...stageEnvironment(),
        PACKSCOUT_CLUTCHPACKS_V3_CONFIRMATION: "wrong",
      },
      dependencies: fake.dependencies,
      writeOutput() {},
    }),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_CONFIRMATION_REQUIRED",
    ),
  );
  assert.deepEqual(fake.timeline, []);
  assert.throws(
    () => parseClutchpacksDataReleaseV3Command({
      argv: ["--stage"],
      environment: {
        ...stageEnvironment(),
        PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_SECRET_BASE64:
          Buffer.alloc(16, 1).toString("base64"),
      },
    }),
    (error) => assertPromotionError(error, "CLUTCHPACKS_V3_TARGET_INVALID"),
  );
});

test("catalog and plan completeness accept exact standalone collectibles with zero chases", () => {
  const governedScope = scope();
  const candidate = plan();
  assert.deepEqual(governedScope.entityCounts, {
    categories: 2,
    collectibles: 20,
    repacks: 17,
    chases: 0,
  });
  assert.deepEqual(assertClutchpacksPlanCompleteness(candidate, governedScope), {
    categories: 2,
    collectibles: 20,
    repacks: 17,
    chases: 0,
    searchShards: 1,
  });
  const probes = clutchpacksCollectibleReadbackProbes(governedScope);
  assert.equal(probes.direct.length, 3);
  assert.equal(probes.search.length, 3);

  candidate.batches.find((batch) => batch.kind === "collectibles").records.pop();
  assert.throws(
    () => assertClutchpacksPlanCompleteness(candidate, governedScope),
    (error) => assertPromotionError(error, "CLUTCHPACKS_V3_SCOPE_INVALID"),
  );
});

test("search probes skip duplicate normalized names while direct probes keep exact IDs", () => {
  const governedSnapshot = snapshot();
  for (const index of [0, 9, 19]) {
    governedSnapshot.collectibles[index].name = "Duplicate Card";
    governedSnapshot.collectibles[index].normalizedName = "duplicate card";
  }
  const probes = clutchpacksCollectibleReadbackProbes(
    assertClutchpacksCatalogScope(governedSnapshot),
  );
  assert.deepEqual(
    probes.direct.map((item) => item.publicCollectibleId),
    [0, 9, 19].map(publicCollectibleId),
  );
  assert.equal(
    probes.search.some((item) => item.normalizedName === "duplicate card"),
    false,
  );
  assert.equal(probes.search.length, 3);
});

test("an unprobeable collectible surface blocks before any Convex state read or write", async () => {
  const catalogSnapshot = snapshot();
  for (const item of catalogSnapshot.collectibles) {
    item.name = "Duplicate Card";
    item.normalizedName = "duplicate card";
  }
  const fake = fakeDependencies({ catalogSnapshot });
  await assert.rejects(
    runClutchpacksDataReleaseV3Promotion({
      argv: ["--stage"],
      environment: stageEnvironment(),
      dependencies: fake.dependencies,
      writeOutput() {},
    }),
    (error) => assertPromotionError(error, "CLUTCHPACKS_V3_SCOPE_INVALID"),
  );
  assert.deepEqual(fake.timeline, ["open", "watermark", "catalog", "close"]);
  assert.equal(fake.timeline.includes("active-state"), false);
  assert.equal(fake.timeline.includes("activate"), false);
});

test("a missing canonical public identity is reported as catalog incompleteness", async () => {
  const catalogError = Object.assign(new Error("mapped asset has no name"), {
    code: "PUBLIC_IDENTITY_MAPPING_MISSING",
  });
  const fake = fakeDependencies({ catalogError });
  await assert.rejects(
    runClutchpacksDataReleaseV3Promotion({
      argv: ["--stage"],
      environment: stageEnvironment(),
      dependencies: fake.dependencies,
      writeOutput() {},
    }),
    (error) => assertPromotionError(error, "CLUTCHPACKS_V3_SCOPE_INVALID"),
  );
  assert.deepEqual(fake.timeline, ["open", "watermark", "catalog", "close"]);
});

test("a bounded nonzero chase set is exhaustively reconciled through its collectible lookup", async () => {
  const relation = chase(0);
  const governedSnapshot = snapshot();
  governedSnapshot.chases.push(relation);
  const governedScope = assertClutchpacksCatalogScope(governedSnapshot);
  const candidate = plan();
  candidate.manifest.counts.chases = 1;
  candidate.manifest.batchCount = 4;
  candidate.manifest.topChaseCount = 1;
  planRecords(candidate, "repacks")[0].topChase = relation;
  candidate.batches.push({
    batchIndex: 3,
    kind: "chases",
    batchHash: HASH,
    records: [relation],
  });
  assert.doesNotThrow(() =>
    assertClutchpacksPlanCompleteness(candidate, governedScope));
  await assert.doesNotReject(() => assertClutchpacksPublicReadBack(
    publicReadBack(candidate, 17, governedScope),
    candidate,
    governedScope,
    readBackVerification(candidate),
  ));

  const divergent = publicReadBack(candidate, 17, governedScope);
  divergent.collectibleReads.find((read) =>
    read.publicCollectibleId === relation.publicCollectibleId)
    .result.data.matches = [];
  await assert.rejects(
    () => assertClutchpacksPublicReadBack(
      divergent,
      candidate,
      governedScope,
      readBackVerification(candidate),
    ),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT",
    ),
  );
});

test("a large chase surface uses deterministic bounded relationship probes", async () => {
  const governedSnapshot = snapshot();
  governedSnapshot.collectibles = Array.from(
    { length: 100 },
    (_, index) => collectible(index),
  );
  governedSnapshot.chases = governedSnapshot.collectibles.map((item, index) => ({
    ...chase(index % 17),
    publicCollectibleId: item.publicCollectibleId,
    collectible: collectibleDisplay(item),
    role: "possible_outcome",
    displayOrder: Math.floor(index / 17),
  }));
  const governedScope = assertClutchpacksCatalogScope(governedSnapshot);
  const probes = clutchpacksCollectibleReadbackProbes(governedScope);
  const directIds = probes.direct.map((item) => item.publicCollectibleId);

  assert.equal(probes.direct.length, 64);
  assert.deepEqual(
    directIds,
    clutchpacksCollectibleReadbackProbes(governedScope).direct.map((item) =>
      item.publicCollectibleId),
  );
  for (const index of [0, 49, 99]) {
    assert.equal(directIds.includes(publicCollectibleId(index)), true);
  }

  const candidate = plan();
  candidate.manifest.counts.collectibles = governedSnapshot.collectibles.length;
  candidate.manifest.counts.chases = governedSnapshot.chases.length;
  candidate.manifest.batchCount = 4;
  candidate.batches.find((batch) => batch.kind === "collectibles").records =
    governedSnapshot.collectibles;
  candidate.batches.push({
    batchIndex: 3,
    kind: "chases",
    batchHash: HASH,
    records: governedSnapshot.chases,
  });

  assert.doesNotThrow(() =>
    assertClutchpacksPlanCompleteness(candidate, governedScope));
  await assert.doesNotReject(() => assertClutchpacksPublicReadBack(
    publicReadBack(candidate, 17, governedScope),
    candidate,
    governedScope,
    readBackVerification(candidate),
  ));
});

test("public readback verifies each server-minted response clock independently", async () => {
  const candidate = plan();
  const currentTime = DEFAULT_CURRENT_TIME;
  const providerObservation = observationRequest(
    candidate,
    currentTime,
    providerObservationFacts({ sourceLifecycle: "active" }),
  );
  const readBack = publicReadBack(candidate, 17, scope(), {
    currentTime,
    providerObservation,
    surfaceTimes: {
      shell: currentTime + 1_000,
      list: currentTime + 2_000,
      details: Array.from(
        { length: 17 },
        (_, index) => currentTime + 3_000 + index,
      ),
      dashboard: currentTime + 31 * 60_000,
      collectibleReads: [
        currentTime + 4_000,
        currentTime + 5_000,
        currentTime + 6_000,
      ],
    },
  });

  assert.equal(readBack.list.data.providerHealthSummary.state, "healthy");
  assert.equal(readBack.dashboard.data.providerHealthSummary.state, "delayed");
  assert.equal(
    readBack.list.data.providerHealthSummary.nextHealthEvaluationAt,
    providerObservation.freshThrough,
  );
  assert.equal(
    readBack.dashboard.data.providerHealthSummary.nextHealthEvaluationAt,
    null,
  );
  assert.equal(readBack.dashboard.data.opportunities.length, 0);
  await assert.doesNotReject(() => assertClutchpacksPublicReadBack(
    readBack,
    candidate,
    scope(),
    {
      ...readBackVerification(candidate, currentTime),
      providerObservation,
    },
  ));
});

test("public readback rejects a response clock that does not govern its presentations", async () => {
  const candidate = plan();
  const readBack = publicReadBack(candidate);
  readBack.list.data.confidenceEvaluatedAt = new Date(
    DEFAULT_CURRENT_TIME + 1_000,
  ).toISOString();

  await assert.rejects(
    () => assertClutchpacksPublicReadBack(
      readBack,
      candidate,
      scope(),
      readBackVerification(candidate),
    ),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT",
    ),
  );
});

test("public readback rejects a health clock that does not govern provider eligibility", async () => {
  const candidate = plan();
  const providerObservation = observationRequest(
    candidate,
    DEFAULT_CURRENT_TIME,
    providerObservationFacts({ sourceLifecycle: "active" }),
  );
  const readBack = publicReadBack(candidate, 17, scope(), {
    providerObservation,
  });
  readBack.list.data.providerHealthEvaluatedAt = new Date(
    DEFAULT_CURRENT_TIME + 31 * 60_000,
  ).toISOString();

  await assert.rejects(
    () => assertClutchpacksPublicReadBack(
      readBack,
      candidate,
      scope(),
      {
        ...readBackVerification(candidate),
        providerObservation,
      },
    ),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT",
    ),
  );
});

test("historical detail readback validates health without inventing an action clock", async () => {
  const candidate = plan();
  const historical = planRecords(candidate, "repacks")[0];
  historical.availability = "sold_out";
  historical.evEstimates.packScout = {
    ...historical.evEstimates.packScout,
    status: "sold_out_historical",
    soldOutAt: new Date(
      new Date(READ_AT).getTime() + 10 * 60_000,
    ).toISOString(),
    expiresAt: null,
  };
  const currentTime = DEFAULT_CURRENT_TIME;
  const providerObservation = observationRequest(
    candidate,
    currentTime,
    providerObservationFacts({ sourceLifecycle: "active" }),
  );
  const readBack = publicReadBack(candidate, 17, scope(), {
    currentTime,
    providerObservation,
    surfaceTimes: {
      details: [
        currentTime + 31 * 60_000,
        ...Array.from({ length: 16 }, () => currentTime),
      ],
    },
  });

  assert.equal(
    readBack.details[0].data.packScoutEvPresentation.status,
    "historical",
  );
  assert.equal(readBack.details[0].data.providerHealth.state, "delayed");
  await assert.doesNotReject(() => assertClutchpacksPublicReadBack(
    readBack,
    candidate,
    scope(),
    {
      ...readBackVerification(candidate, currentTime),
      providerObservation,
    },
  ));
});

test("known EV remains last-known after its legacy deadline", async () => {
  const candidate = plan();
  planRecords(candidate, "repacks")[1].evEstimates.packScout = {
    status: "unavailable",
    methodVersion: "packscout-buyback-adjusted-ev-v1",
    confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
    metrics: null,
    confidence: null,
    calculatedAt: READ_AT,
    dataAsOf: { state: "known", observedAt: READ_AT },
    reason: "BUYBACK_UNAVAILABLE",
  };
  const currentTime = new Date(READ_AT).getTime() + 7 * 24 * 60 * 60_000;
  const verification = readBackVerification(candidate, currentTime);
  const readBack = publicReadBack(candidate, 17, scope(), {
    currentTime,
    providerObservation: verification.providerObservation,
  });
  assert.equal(
    readBack.list.data.rows[0].packScoutEvPresentation.status,
    "last_known",
  );
  assert.equal(
    readBack.list.data.rows[1].packScoutEvPresentation.status,
    "unavailable",
  );
  await assert.doesNotReject(() => assertClutchpacksPublicReadBack(
    readBack,
    candidate,
    scope(),
    verification,
  ));
});

test("healthy source health admits known EV to Top Opportunities", async () => {
  const candidate = plan();
  const facts = providerObservationFacts({ sourceLifecycle: "active" });
  const providerObservation = observationRequest(
    candidate,
    DEFAULT_CURRENT_TIME,
    facts,
  );
  const readBack = publicReadBack(candidate, 17, scope(), {
    providerObservation,
  });
  assert.deepEqual(readBack.dashboard.data.opportunityEligibility, {
    rankingEligibleRepackCount: 17,
    providerIneligibleRepackCount: 0,
  });
  assert.equal(readBack.dashboard.data.opportunities.length, 6);
  await assert.doesNotReject(() => assertClutchpacksPublicReadBack(
    readBack,
    candidate,
    scope(),
    { ...readBackVerification(candidate), providerObservation },
  ));
});

test("stage recomputes, rejects positive EV before publication, then reads exact status without activation", async () => {
  const fake = fakeDependencies();
  const outputs = [];
  const result = await runClutchpacksDataReleaseV3Promotion({
    argv: ["--stage"],
    environment: stageEnvironment(),
    dependencies: fake.dependencies,
    writeOutput: (value) => outputs.push(value),
  });
  assert.equal(result.status, "staged");
  assert.equal(
    result.schemaVersion,
    "packscout.clutchpacks-data-release-v3-result.v2",
  );
  assert.equal(result.acceptedRepackCount, 17);
  assert.deepEqual(result.canonicalEntityCounts, {
    categories: 2,
    collectibles: 20,
    repacks: 17,
    chases: 0,
    searchShards: 1,
  });
  assert.deepEqual(result.acceptedEntityCounts, result.canonicalEntityCounts);
  assert.equal("minimumRemainingLifetimeMilliseconds" in result, false);
  assert.equal(result.activePointerMoved, false);
  assert.match(result.requiredActivationConfirmation,
    /^ACTIVATE CLUTCHPACKS DATA RELEASE V3 [0-9a-f]{16}$/u);
  assert.deepEqual(fake.timeline, [
    "open",
    "watermark",
    "catalog",
    "backfill:preflight",
    "assemble:1",
    "active-state",
    "watermark",
    "backfill:stage",
    "assemble:2",
    "status",
    "active-state",
    "close",
  ]);
  assert.equal(fake.timeline.includes("activate"), false);
  assert.equal(fake.timeline.includes("public-read"), false);
  assert.deepEqual(outputs, [result]);
});

test("a newer settled head blocks the stale read clock before the first Convex write", async () => {
  const fake = fakeDependencies();
  advanceWatermarkAfterFirstRead(fake);
  await assert.rejects(
    runClutchpacksDataReleaseV3Promotion({
      argv: ["--stage"],
      environment: stageEnvironment(),
      dependencies: fake.dependencies,
      writeOutput() {},
    }),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_CANONICAL_UNSETTLED",
    ),
  );
  assert.deepEqual(fake.timeline, [
    "open",
    "watermark",
    "catalog",
    "backfill:preflight",
    "assemble:1",
    "active-state",
    "watermark",
    "close",
  ]);
});

test("a newer settled head also blocks before activation", async () => {
  const fake = fakeDependencies();
  advanceWatermarkAfterFirstRead(fake);
  await assert.rejects(
    runClutchpacksDataReleaseV3Promotion({
      argv: [
        "--activate",
        "--expected-release-fingerprint",
        FINGERPRINT,
        "--expected-active-release",
        "genesis",
      ],
      environment: activationEnvironment(),
      dependencies: fake.dependencies,
      writeOutput() {},
    }),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_CANONICAL_UNSETTLED",
    ),
  );
  assert.deepEqual(fake.timeline, [
    "open",
    "watermark",
    "catalog",
    "backfill:preflight",
    "assemble:1",
    "status",
    "active-state",
    "watermark",
    "close",
  ]);
  assert.equal(fake.timeline.includes("activate"), false);
});

test("stage requires the requested clock to equal a fully settled source head", async () => {
  for (const watermark of [
    {
      organizationId: ORGANIZATION_ID,
      settledSequence: 148_289n,
      settledAt: new Date(READ_AT),
      sourceHeadSequence: 148_290n,
      sourceHeadAt: new Date(READ_AT),
      sourceHeads: [{ settled: false }],
    },
    {
      organizationId: ORGANIZATION_ID,
      settledSequence: 148_290n,
      settledAt: new Date("2026-08-27T19:19:44.000Z"),
      sourceHeadSequence: 148_290n,
      sourceHeadAt: new Date(READ_AT),
      sourceHeads: [{ settled: true }],
    },
  ]) {
    const fake = fakeDependencies({ watermark });
    await assert.rejects(
      runClutchpacksDataReleaseV3Promotion({
        argv: ["--stage"],
        environment: stageEnvironment(),
        dependencies: fake.dependencies,
        writeOutput() {},
      }),
      (error) => assertPromotionError(
        error,
        "CLUTCHPACKS_V3_CANONICAL_UNSETTLED",
      ),
    );
    assert.deepEqual(fake.timeline, ["open", "watermark", "close"]);
  }
});

test("an aged settled watermark and stale age bucket still stage known EV", async () => {
  const fake = fakeDependencies({ staleIndex: 5 });
  fake.dependencies.now = () =>
    new Date(READ_AT).getTime() + 7 * 24 * 60 * 60_000;
  const result = await runClutchpacksDataReleaseV3Promotion({
    argv: ["--stage"],
    environment: stageEnvironment(),
    dependencies: fake.dependencies,
    writeOutput() {},
  });
  assert.equal(result.status, "staged");
});

test("an unknown source clock still blocks before assembly", async () => {
  const fake = fakeDependencies({ unknownSourceIndex: 5 });
  await assert.rejects(runClutchpacksDataReleaseV3Promotion({
    argv: ["--stage"],
    environment: stageEnvironment(),
    dependencies: fake.dependencies,
    writeOutput() {},
  }), (error) => assertPromotionError(
    error,
    "CLUTCHPACKS_V3_EVIDENCE_STALE",
  ));
  assert.deepEqual(fake.timeline, [
    "open", "watermark", "catalog", "backfill:preflight", "close",
  ]);
});

test("a future settled watermark is still rejected", async () => {
  const fake = fakeDependencies();
  fake.dependencies.now = () => new Date(READ_AT).getTime() - 1;
  await assert.rejects(runClutchpacksDataReleaseV3Promotion({
    argv: ["--stage"],
    environment: stageEnvironment(),
    dependencies: fake.dependencies,
    writeOutput() {},
  }), (error) => assertPromotionError(
    error,
    "CLUTCHPACKS_V3_SETTLEMENT_STALE",
  ));
  assert.deepEqual(fake.timeline, ["open", "watermark", "close"]);
});

test("the exact-plan staging port refuses a changed reread before the first write", async () => {
  const candidate = plan();
  const writes = [];
  const publication = {
    activeState: async () => activeState(),
    status: async () => null,
    async start(request) {
      writes.push(request);
      return { result: "started" };
    },
    async applyBatch(request) {
      writes.push(request);
      return {};
    },
    async finalize(request) {
      writes.push(request);
      return {};
    },
  };
  const guarded = exactDataReleaseV3StagingPort(publication, candidate);
  await assert.rejects(
    guarded.start({
      schemaVersion: "data_release_v3",
      operationId: `${RELEASE_ID}:start`,
      idempotencyKey: `${RELEASE_ID}:start`,
      publicReleaseId: RELEASE_ID,
      releaseFingerprint: "f".repeat(64),
      manifest: candidate.manifest,
    }),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_STAGING_DIVERGENT",
    ),
  );
  assert.deepEqual(writes, []);
  assert.throws(
    () => guarded.activate(),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_STAGING_DIVERGENT",
    ),
  );

  const accepted = exactDataReleaseV3StagingPort(publication, candidate);
  await accepted.start({
    schemaVersion: "data_release_v3",
    operationId: `${RELEASE_ID}:start`,
    idempotencyKey: `${RELEASE_ID}:start`,
    publicReleaseId: RELEASE_ID,
    releaseFingerprint: FINGERPRINT,
    manifest: candidate.manifest,
  });
  for (const batch of candidate.batches) {
    await accepted.applyBatch({
      schemaVersion: "data_release_v3",
      operationId: `${RELEASE_ID}:batch:${batch.batchIndex}`,
      idempotencyKey: `${RELEASE_ID}:batch:${batch.batchIndex}`,
      publicReleaseId: RELEASE_ID,
      batchIndex: batch.batchIndex,
      kind: batch.kind,
      batchHash: batch.batchHash,
      records: batch.records,
    });
  }
  await accepted.finalize({
    schemaVersion: "data_release_v3",
    operationId: `${RELEASE_ID}:finalize`,
    idempotencyKey: `${RELEASE_ID}:finalize`,
    publicReleaseId: RELEASE_ID,
    releaseFingerprint: FINGERPRINT,
    expectedCounts: candidate.manifest.counts,
    expectedEntityChainHashes: candidate.manifest.entityChainHashes,
    expectedTopChaseCount: candidate.manifest.topChaseCount,
    expectedBatchCount: candidate.manifest.batchCount,
    expectedBatchChainHash: candidate.manifest.batchChainHash,
  });
  assert.equal(writes.length, candidate.batches.length + 2);
});

test("the activation port keeps the operator predecessor in the actual CAS request", async () => {
  const candidate = plan();
  let current = activeState(PRIOR_RELEASE_ID, 4);
  const requests = [];
  const publication = {
    async activeState() {
      return current;
    },
    async activate(request) {
      requests.push(request);
      current = {
        generation: 5,
        activeRelease: {
          publicReleaseId: candidate.publicReleaseId,
          releaseFingerprint: candidate.releaseFingerprint,
        },
        previousRelease: activeState(PRIOR_RELEASE_ID).activeRelease,
      };
      return { result: "activated" };
    },
  };
  const guarded = operatorBoundDataReleaseV3ActivationPort(
    publication,
    candidate,
    PRIOR_RELEASE_ID,
  );
  await guarded.activeState();
  current = activeState(RACING_RELEASE_ID, 5);
  await assert.rejects(
    guarded.activeState(),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_ACTIVE_POINTER_MOVED",
    ),
  );
  assert.deepEqual(requests, []);

  current = activeState(PRIOR_RELEASE_ID, 4);
  await assert.rejects(
    guarded.activate({
      publicReleaseId: candidate.publicReleaseId,
      releaseFingerprint: candidate.releaseFingerprint,
      expectedActivePublicReleaseId: RACING_RELEASE_ID,
    }),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_ACTIVE_POINTER_MOVED",
    ),
  );
  assert.deepEqual(requests, []);
  await guarded.activate({
    publicReleaseId: candidate.publicReleaseId,
    releaseFingerprint: candidate.releaseFingerprint,
    expectedActivePublicReleaseId: PRIOR_RELEASE_ID,
  });
  assert.equal(requests[0].expectedActivePublicReleaseId, PRIOR_RELEASE_ID);
  await guarded.activeState();
});

test("any positive signed PackScout EV blocks before the first Convex write", async () => {
  const positive = plan();
  planRecords(positive, "repacks")[4].evEstimates.packScout.metrics.evDollars
    .minorUnits = 1;
  planRecords(positive, "repacks")[4].evEstimates.packScout.metrics
    .evPercentBasisPoints = 1;
  planRecords(positive, "repacks")[4].evEstimates.packScout.metrics
    .grossReturnBasisPoints = 10_001;
  const fake = fakeDependencies({ candidate: positive });
  await assert.rejects(
    runClutchpacksDataReleaseV3Promotion({
      argv: ["--stage"],
      environment: stageEnvironment(),
      dependencies: fake.dependencies,
      writeOutput() {},
    }),
    (error) => assertPromotionError(error, "CLUTCHPACKS_V3_POSITIVE_EV"),
  );
  assert.deepEqual(fake.timeline, [
    "open",
    "watermark",
    "catalog",
    "backfill:preflight",
    "assemble:1",
    "close",
  ]);

  for (const field of ["evDollars", "evPercent", "grossReturn"]) {
    const candidate = plan();
    const metrics = planRecords(candidate, "repacks")[0]
      .evEstimates.packScout.metrics;
    if (field === "evDollars") metrics.evDollars.minorUnits = 1;
    if (field === "evPercent") metrics.evPercentBasisPoints = 1;
    if (field === "grossReturn") metrics.grossReturnBasisPoints = 10_001;
    assert.throws(
      () => assertNoPositiveClutchpacksEv(
        candidate,
        snapshot().products.map((entry) => entry.publicRepackId).sort(),
      ),
      (error) => assertPromotionError(error, "CLUTCHPACKS_V3_POSITIVE_EV"),
    );
  }
});

test("activation requires the already-staged fingerprint and expected active pointer, then reads all 17 publicly", async () => {
  const fake = fakeDependencies();
  const result = await runClutchpacksDataReleaseV3Promotion({
    argv: [
      "--activate",
      "--expected-release-fingerprint",
      FINGERPRINT,
      "--expected-active-release",
      "genesis",
    ],
    environment: activationEnvironment(),
    dependencies: fake.dependencies,
    writeOutput() {},
  });
  assert.equal(result.status, "activated");
  assert.equal(result.publicReadBackCount, 17);
  assert.deepEqual(result.publicEntityReadBackCounts, {
    categories: 2,
    collectibles: 20,
    repacks: 17,
    chases: 0,
    searchShards: 1,
  });
  assert.deepEqual(result.publicProbeCounts, {
    repackDetails: 17,
    collectibleDirect: 3,
    collectibleSearch: 3,
  });
  assert.deepEqual(result.providerObservation, {
    operationId:
      `${RELEASE_ID}:provider-observation:${DEFAULT_CURRENT_TIME}`,
    observationSequence: DEFAULT_CURRENT_TIME,
    observedAt: new Date(DEFAULT_CURRENT_TIME).toISOString(),
    sourceLifecycle: "paused",
    publicHealth: {
      state: "delayed",
      observedAt: new Date(DEFAULT_CURRENT_TIME).toISOString(),
      rankingEligible: false,
      rankingIneligibilityReason: "PROVIDER_PAUSED",
    },
    result: "provider_observation_created",
  });
  assert.equal(fake.providerObservationInputs[0].publicVendorId, PUBLIC_VENDOR_ID);
  assert.equal(fake.providerObservationInputs[0].releaseAlignment, "aligned");
  assert.equal(fake.activationInputs[0].expectedActivePublicReleaseId, null);
  assert.equal(fake.providerFactTimes[0], DEFAULT_CURRENT_TIME);
  assert.equal("currentTime" in fake.publicReadInputs[0], false);
  assert.deepEqual(fake.timeline, [
    "open",
    "watermark",
    "catalog",
    "backfill:preflight",
    "assemble:1",
    "status",
    "active-state",
    "watermark",
    "activate",
    "watermark",
    "provider-observation-facts",
    "provider-observation-refresh",
    "public-read",
    "close",
  ]);
  assert.equal(fake.timeline.includes("backfill:stage"), false);
});

test("provider observation uses signed activation server time under local clock skew", async () => {
  const fake = fakeDependencies({
    localCurrentTime: DEFAULT_CURRENT_TIME + 6 * 60 * 60_000,
    activationServerTime: new Date(DEFAULT_CURRENT_TIME).toISOString(),
  });

  await runClutchpacksDataReleaseV3Promotion({
    argv: [
      "--activate",
      "--expected-release-fingerprint",
      FINGERPRINT,
      "--expected-active-release",
      "genesis",
    ],
    environment: activationEnvironment(),
    dependencies: fake.dependencies,
    writeOutput() {},
  });

  assert.equal(
    fake.providerObservationInputs[0].observedAt,
    new Date(DEFAULT_CURRENT_TIME).toISOString(),
  );
  assert.equal(
    fake.providerObservationInputs[0].freshThrough,
    new Date(DEFAULT_CURRENT_TIME + 30 * 60_000).toISOString(),
  );
  assert.equal(fake.providerFactTimes[0], DEFAULT_CURRENT_TIME);
});

test("unchanged activation uses a server-minted shell clock for observation refresh", async () => {
  const fake = fakeDependencies({
    active: activeState(RELEASE_ID, 4),
    activationOutcome: "unchanged",
  });

  const result = await runClutchpacksDataReleaseV3Promotion({
    argv: [
      "--activate",
      "--expected-release-fingerprint",
      FINGERPRINT,
      "--expected-active-release",
      RELEASE_ID,
    ],
    environment: activationEnvironment(RELEASE_ID),
    dependencies: fake.dependencies,
    writeOutput() {},
  });

  assert.equal(result.status, "already_active");
  assert.equal(fake.timeline.includes("public-server-time"), true);
  assert.equal(
    fake.providerObservationInputs[0].observedAt,
    new Date(DEFAULT_CURRENT_TIME).toISOString(),
  );
});

test("an activation CAS race cannot replace the operator-approved predecessor", async () => {
  const fake = fakeDependencies();
  const initialOpen = fake.dependencies.open;
  fake.dependencies.open = async (...args) => {
    const opened = await initialOpen(...args);
    const initialLoad = opened.loadSettledWatermark;
    let readCount = 0;
    opened.loadSettledWatermark = async () => {
      const current = await initialLoad();
      readCount += 1;
      if (readCount === 2) {
        fake.setActiveState(activeState(RACING_RELEASE_ID, 1));
      }
      return current;
    };
    return opened;
  };
  await assert.rejects(
    runClutchpacksDataReleaseV3Promotion({
      argv: [
        "--activate",
        "--expected-release-fingerprint",
        FINGERPRINT,
        "--expected-active-release",
        "genesis",
      ],
      environment: activationEnvironment(),
      dependencies: fake.dependencies,
      writeOutput() {},
    }),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_ACTIVE_POINTER_MOVED",
    ),
  );
  assert.equal(
    fake.activationInputs[0].expectedActivePublicReleaseId,
    null,
  );
  assert.equal(
    fake.getActiveState().activeRelease.publicReleaseId,
    RACING_RELEASE_ID,
  );
  assert.equal(fake.timeline.includes("public-read"), false);
});

test("failed public verification rolls activation back to the guarded predecessor", async () => {
  const fake = fakeDependencies({
    active: activeState(PRIOR_RELEASE_ID, 4),
    readBack: publicReadBack(plan(), 16),
  });
  await assert.rejects(
    runClutchpacksDataReleaseV3Promotion({
      argv: [
        "--activate",
        "--expected-release-fingerprint",
        FINGERPRINT,
        "--expected-active-release",
        PRIOR_RELEASE_ID,
      ],
      environment: activationEnvironment(PRIOR_RELEASE_ID),
      dependencies: fake.dependencies,
      writeOutput() {},
    }),
    (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_ACTIVATION_ROLLED_BACK",
    ),
  );
  assert.equal(
    fake.getActiveState().activeRelease.publicReleaseId,
    PRIOR_RELEASE_ID,
  );
  assert.deepEqual(fake.timeline.slice(-8), [
    "activate",
    "watermark",
    "provider-observation-facts",
    "provider-observation-refresh",
    "public-read",
    "active-state",
    "rollback",
    "close",
  ]);
});

test("a failed or invalid provider observation receipt rolls activation back", async () => {
  for (const refresh of [
    { refreshFails: true },
    { refreshResult: "unexpected_observation_result" },
  ]) {
    const fake = fakeDependencies({
      active: activeState(PRIOR_RELEASE_ID, 4),
      ...refresh,
    });
    await assert.rejects(runClutchpacksDataReleaseV3Promotion({
      argv: [
        "--activate",
        "--expected-release-fingerprint",
        FINGERPRINT,
        "--expected-active-release",
        PRIOR_RELEASE_ID,
      ],
      environment: activationEnvironment(PRIOR_RELEASE_ID),
      dependencies: fake.dependencies,
      writeOutput() {},
    }), (error) => assertPromotionError(
      error,
      "CLUTCHPACKS_V3_ACTIVATION_ROLLED_BACK",
    ));
    assert.equal(fake.timeline.includes("public-read"), false);
    assert.equal(fake.timeline.includes("provider-observation-refresh"), true);
    assert.equal(
      fake.getActiveState().activeRelease.publicReleaseId,
      PRIOR_RELEASE_ID,
    );
  }
});

test("genesis activation reports explicit recovery when public verification fails", async () => {
  const fake = fakeDependencies({ readBack: publicReadBack(plan(), 16) });
  const outputs = [];
  const result = await runClutchpacksDataReleaseV3Promotion({
    argv: [
      "--activate",
      "--expected-release-fingerprint",
      FINGERPRINT,
      "--expected-active-release",
      "genesis",
    ],
    environment: activationEnvironment(),
    dependencies: fake.dependencies,
    writeOutput: (value) => outputs.push(value),
  });
  assert.equal(result.status, "activated_but_unverified_recovery_required");
  assert.equal(result.expectedPriorPublicReleaseId, null);
  assert.equal(
    fake.getActiveState().activeRelease.publicReleaseId,
    RELEASE_ID,
  );
  assert.equal(fake.timeline.includes("rollback"), false);
  assert.deepEqual(outputs, [result]);
});

test("public readback rejects wrong negative EV bytes in list and detail views", async () => {
  for (const surface of ["list", "detail"]) {
    const candidate = plan();
    const readBack = publicReadBack(candidate);
    const target = surface === "list"
      ? readBack.list.data.details[0]
      : readBack.details[0].data;
    target.evEstimates.packScout.metrics.evDollars.minorUnits = -999;
    await assert.rejects(
      () => assertClutchpacksPublicReadBack(
        readBack,
        candidate,
        scope(),
        readBackVerification(candidate),
      ),
      (error) => assertPromotionError(
        error,
        "CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT",
      ),
    );
  }
});

test("public readback byte-matches every stored list summary and detail field", async () => {
  const mutations = [
    (readBack) => {
      readBack.list.data.rows[0].name = "Wrong summary name";
    },
    (readBack) => {
      readBack.list.data.details[0].price = { display: "$9,999" };
    },
    (readBack) => {
      readBack.list.data.details[0].availability = "unknown";
    },
    (readBack) => {
      readBack.details[0].data.buyback = { kind: "not_documented" };
    },
    (readBack) => {
      readBack.details[0].data.categories = [];
    },
    (readBack) => {
      readBack.details[0].data.actions = {};
    },
    (readBack) => {
      readBack.list.data.rows[0].packScoutEvPresentation.confidence
        .scoreBasisPoints -= 1;
    },
    (readBack) => {
      readBack.details[0].data.providerHealth.rankingIneligibilityReason =
        "PROVIDER_UNHEALTHY";
    },
    (readBack) => {
      readBack.shell.data.providerHealthSummary.delayedProviderCount = 0;
    },
  ];
  for (const mutate of mutations) {
    const candidate = plan();
    const readBack = publicReadBack(candidate);
    mutate(readBack);
    await assert.rejects(
      () => assertClutchpacksPublicReadBack(
        readBack,
        candidate,
        scope(),
        readBackVerification(candidate),
      ),
      (error) => assertPromotionError(
        error,
        "CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT",
      ),
    );
  }
});

test("public readback rejects category, standalone collectible, and search divergence", async () => {
  const mutations = [
    (readBack) => readBack.dashboard.data.facets.categories.pop(),
    (readBack) => {
      readBack.collectibleReads[0].result.data.desiredCollectible.name =
        "Wrong collectible";
    },
    (readBack) => {
      readBack.collectibleSearches[1].result.data.matches = [];
    },
  ];
  for (const mutate of mutations) {
    const candidate = plan();
    const readBack = publicReadBack(candidate);
    mutate(readBack);
    await assert.rejects(
      () => assertClutchpacksPublicReadBack(
        readBack,
        candidate,
        scope(),
        readBackVerification(candidate),
      ),
      (error) => assertPromotionError(
        error,
        "CLUTCHPACKS_V3_PUBLIC_READBACK_DIVERGENT",
      ),
    );
  }
});

test("activation fails closed on fingerprint, active-pointer, or staged-status divergence", async () => {
  const cases = [
    {
      fake: fakeDependencies({ candidate: plan({ releaseFingerprint: HASH }) }),
      code: "CLUTCHPACKS_V3_RELEASE_MISMATCH",
    },
    {
      fake: fakeDependencies({ active: activeState(RELEASE_ID, 4) }),
      code: "CLUTCHPACKS_V3_ACTIVE_POINTER_MOVED",
    },
    {
      fake: fakeDependencies({
        stagedStatus: { ...status(), acceptedSearchRowCount: 16 },
      }),
      code: "CLUTCHPACKS_V3_STAGING_DIVERGENT",
    },
    {
      fake: fakeDependencies({
        stagedStatus: {
          ...status(),
          acceptedCounts: { ...status().acceptedCounts, collectibles: 19 },
        },
      }),
      code: "CLUTCHPACKS_V3_STAGING_DIVERGENT",
    },
  ];
  for (const { fake, code } of cases) {
    await assert.rejects(
      runClutchpacksDataReleaseV3Promotion({
        argv: [
          "--activate",
          "--expected-release-fingerprint",
          FINGERPRINT,
          "--expected-active-release",
          "genesis",
        ],
        environment: activationEnvironment(),
        dependencies: fake.dependencies,
        writeOutput() {},
      }),
      (error) => assertPromotionError(error, code),
    );
  }
});

test("CLI failures never print database or publication secrets", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--stage"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...stageEnvironment(),
        PACKSCOUT_CLUTCHPACKS_V3_CONFIRMATION: "wrong",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /CLUTCHPACKS_V3_(?:TARGET_INVALID|CONFIRMATION_REQUIRED)/u,
  );
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /database-secret|BwcHBwcH|data-release-v3-publisher/iu,
  );
});
