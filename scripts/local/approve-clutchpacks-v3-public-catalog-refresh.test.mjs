import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const contracts = await tsImport("@packscout/contracts", import.meta.url);
const database = await tsImport("@packscout/database", import.meta.url);
const candidateModule = await tsImport(
  "./generate-clutchpacks-v3-public-catalog-candidate.mts",
  import.meta.url,
);
const {
  ClutchpacksCatalogRefreshError,
  assertClutchpacksCatalogGrowthOnly,
  parseClutchpacksCatalogRefreshCommand,
  runClutchpacksCatalogRefresh,
} = await tsImport(
  "./approve-clutchpacks-v3-public-catalog-refresh.mts",
  import.meta.url,
);

const ORGANIZATION_ID = "21c1540e-9471-49a3-9d3c-a0e5f5ea606e";
const PACK_ID = "e5f7565e-664c-416f-87b4-26dba7efde2b";
const SOURCE_INSTANCE_ID = "80624779-8fb1-4694-a49f-ada136fccab2";
const SOURCE_REVISION_ID = "179e9aa7-cc76-4ce2-aece-6818957c1e11";
const RUN_ID = "8c574cd1-e63d-48a6-ac24-1c1152fd52a9";
const NOW = new Date("2026-08-28T06:41:00.000Z");
const FIRST_SEEN_AT = "2026-08-27T15:00:00.000Z";
const DATABASE_IDENTITY = Object.freeze({
  databaseName: "packscout_clutchpacks_v3_canary",
  databaseOid: "16432",
  systemIdentifier: "7541020403012209001",
});

function packContent(overrides = {}) {
  return {
    schemaVersion: "catalog-projection-v1",
    firstSeenAt: FIRST_SEEN_AT,
    imageUrls: [],
    dataQualityEvidence: [],
    entityType: "pack",
    evInputStatus: "ready",
    parentExternalId: null,
    name: "ClutchPacks pack",
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
    buybackPercent: null,
    drawCount: 1,
    ...overrides,
  };
}

function assetContent(overrides = {}) {
  return {
    schemaVersion: "catalog-projection-v1",
    firstSeenAt: FIRST_SEEN_AT,
    imageUrls: [],
    dataQualityEvidence: [],
    entityType: "catalog_asset",
    assetType: "card",
    relatedPackExternalId: null,
    parentExternalId: null,
    name: "ClutchPacks card",
    description: null,
    category: null,
    availability: "available",
    sourceStatus: null,
    providerValueMinor: null,
    providerValueCurrency: null,
    valueSource: null,
    ...overrides,
  };
}

function environment(overrides = {}) {
  return {
    NODE_ENV: "development",
    PACKSCOUT_RUNTIME_ENVIRONMENT: "local",
    PACKSCOUT_DATABASE_URL:
      "postgresql://operator@127.0.0.1:5432/packscout_clutchpacks_v3_canary",
    PACKSCOUT_CLUTCHPACKS_V3_CANARY_ORGANIZATION_ID: ORGANIZATION_ID,
    PACKSCOUT_CLUTCHPACKS_V3_TARGET_ACK:
      "I_UNDERSTAND_THE_TARGET_MUST_BE_A_FRESH_LOCAL_DATABASE",
    PACKSCOUT_CLUTCHPACKS_CATALOG_NAMESPACE_UUID:
      "0d033a4b-4d66-5725-b253-8b9e1b7a94bf",
    PACKSCOUT_CLUTCHPACKS_CATALOG_CONFIGURATION_KEY:
      "clutchpacks-v3-canary-v2",
    PACKSCOUT_CLUTCHPACKS_CATALOG_REVISION: "2",
    PACKSCOUT_CLUTCHPACKS_CATALOG_APPROVED_AT:
      "2026-08-27T19:20:44.000Z",
    PACKSCOUT_CLUTCHPACKS_CATALOG_STALE_AFTER_SECONDS: "900",
    PACKSCOUT_CLUTCHPACKS_CATALOG_CONFIDENCE_POLICY_VERSION:
      "clutchpacks-canary-confidence-v1",
    PACKSCOUT_CLUTCHPACKS_CATALOG_COMPLETE_SCORE_BPS: "9000",
    PACKSCOUT_CLUTCHPACKS_CATALOG_PARTIAL_SCORE_BPS: "6000",
    PACKSCOUT_CLUTCHPACKS_CATALOG_UNKNOWN_SCORE_BPS: "3000",
    PACKSCOUT_CLUTCHPACKS_CATALOG_LIMITATION_PENALTY_BPS: "500",
    PACKSCOUT_CLUTCHPACKS_CATALOG_PUBLIC_ASSET_ORIGINS_JSON:
      '["https://cdn.example.test"]',
    PACKSCOUT_CLUTCHPACKS_CATALOG_VENDOR_DISPLAY_NAME: "ClutchPacks",
    PACKSCOUT_CLUTCHPACKS_CATALOG_FORMAT: "repack",
    ...overrides,
  };
}

function evidence(overrides = {}) {
  const mapper = {
    mapperKey: "clutchpacks-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey:
      contracts.providerIdentityNamespaceByLaunchProvider.clutchpacks,
  };
  return {
    databaseIdentity: DATABASE_IDENTITY,
    organizationCount: 1,
    providerCount: 1,
    providerPlatformKey: "clutchpacks",
    providerState: "active",
    sourceCount: 1,
    sourceInstanceId: SOURCE_INSTANCE_ID,
    sourceState: "paused",
    sourcePauseRequested: false,
    sourceRevisionCount: 1,
    sourceRevisionId: SOURCE_REVISION_ID,
    sourceAdapterVersion: contracts.DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    normalizedContractVersion: contracts.PROVIDER_OBSERVATION_CONTRACT_VERSION,
    mapperKey: mapper.mapperKey,
    mapperVersion: mapper.mapperVersion,
    identityNamespaceKey: mapper.identityNamespaceKey,
    cursorCodecVersion: contracts.DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
    currentCursorCount: 1,
    currentCursorSourceInstanceId: SOURCE_INSTANCE_ID,
    currentCursorSourceRevisionId: SOURCE_REVISION_ID,
    currentCursorGeneration: 2n,
    latestRunCount: 1,
    latestRunId: RUN_ID,
    latestRunState: "succeeded",
    latestRunReachedProviderHead: true,
    latestRunFinished: true,
    latestRunFailureCode: null,
    latestRunSourceInstanceId: SOURCE_INSTANCE_ID,
    latestRunSourceRevisionId: SOURCE_REVISION_ID,
    latestRunCursorGeneration: 2n,
    latestRunAdapterVersion: contracts.DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    latestRunNormalizedContractVersion:
      contracts.PROVIDER_OBSERVATION_CONTRACT_VERSION,
    latestRunMapperKey: mapper.mapperKey,
    latestRunMapperVersion: mapper.mapperVersion,
    latestRunIdentityNamespaceKey: mapper.identityNamespaceKey,
    latestRunCursorCodecVersion:
      contracts.DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
    activeRunCount: 0,
    liveSupervisorCount: 0,
    wrongDeliveryLineageCount: 0,
    deliveryCount: 2,
    quarantineCount: 0,
    unresolvedCurrentGenerationDiagnosticCount: 0,
    unresolvedCurrentGenerationOperationalEventCount: 0,
    unresolvedProviderHealthCount: 0,
    unresolvedSourceHealthCount: 0,
    openConnectionHealthEpisodeCount: 0,
    canonicalPackCount: 1,
    canonicalAssetCount: 2,
    canonicalPullCount: 1,
    canonicalMarketEventCount: 1,
    confirmationSetCount: 1,
    coveredCurrentPullCount: 1,
    confirmationItemCount: 2,
    declaredConfirmationItemCount: 2,
    confirmationSetSizeMismatchCount: 0,
    unresolvedConfirmationItemCount: 0,
    backfillCount: 1,
    completeBackfillCount: 1,
    globalSettledSequence: 152158n,
    globalSourceHeadSequence: 152158n,
    globalNextSequence: 152159n,
    globalSettledAt: new Date("2026-08-28T06:40:11.136Z"),
    globalSourceHeadAt: new Date("2026-08-28T06:40:11.136Z"),
    providerSettledSequence: 152158n,
    providerSourceHeadSequence: 152158n,
    providerSettledAt: new Date("2026-08-28T06:40:11.136Z"),
    providerSourceHeadAt: new Date("2026-08-28T06:40:11.136Z"),
    pendingObligationCount: 0,
    legacyProviderConfigurationCount: 0,
    legacyProviderSecretCount: 0,
    legacyProviderCursorCount: 0,
    packs: [{
      externalId: PACK_ID,
      content: packContent({ category: "Sports" }),
    }],
    assets: [
      {
        externalId: "card-1",
        content: assetContent({ name: "One", category: "Basketball" }),
        associated: false,
      },
      {
        externalId: "card-2",
        content: assetContent({
          name: "Two",
          category: "Basketball",
          imageUrls: ["https://cdn.example.test/card-2.jpg"],
        }),
        associated: false,
      },
    ],
    ...overrides,
  };
}

async function state(overrides = {}) {
  const parsedEnvironment =
    candidateModule.readClutchpacksCatalogCandidateEnvironment(environment());
  const priorEvidence = evidence({
    canonicalAssetCount: 1,
    assets: [evidence().assets[0]],
  });
  const previous = candidateModule.buildClutchpacksCatalogCandidate(
    priorEvidence,
    parsedEnvironment.policy,
  );
  const configurationHash = await contracts.sha256CanonicalJson(
    database.PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
    previous,
  );
  return {
    evidence: evidence(),
    context: {
      configurationCount: 2,
      latest: {
        configuration: previous,
        configurationHash,
        publicChangeSequence: 148290n,
      },
      activePromotionWorkCount: 0,
    },
    ...overrides,
  };
}

function assertCode(code) {
  return (error) => {
    assert.ok(error instanceof ClutchpacksCatalogRefreshError);
    assert.equal(error.code, code);
    return true;
  };
}

test("command requires approvedAt and exact confirmation only for execute", () => {
  assert.deepEqual(parseClutchpacksCatalogRefreshCommand([]), {
    execute: false,
    approvedAt: null,
    confirmation: null,
  });
  assert.throws(
    () => parseClutchpacksCatalogRefreshCommand(["--execute"]),
    assertCode("ARGUMENT_INVALID"),
  );
  assert.throws(
    () => parseClutchpacksCatalogRefreshCommand([
      "--dry-run", "--confirmation", "unsafe",
    ]),
    assertCode("ARGUMENT_INVALID"),
  );
});

test("dry-run derives v3 and execute persists only its bound snapshot", async () => {
  const current = await state();
  const outputs = [];
  const approved = [];
  const common = {
    environment: environment(),
    clock: () => NOW,
    readState: async () => current,
    readDatabaseIdentity: async () => DATABASE_IDENTITY,
    approveConfiguration: async (input) => {
      approved.push(input);
      return {
        id: "approved-v3",
        configuration: input.configuration,
        configurationHash: await contracts.sha256CanonicalJson(
          database.PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
          input.configuration,
        ),
        publicChangeSequence: 152159n,
      };
    },
    writeOutput: (value) => outputs.push(JSON.parse(value)),
  };
  const dryRun = await runClutchpacksCatalogRefresh({
    ...common,
    argv: ["--dry-run"],
  });
  assert.equal(dryRun.configurationKey, "clutchpacks-v3-canary-v3");
  assert.equal(dryRun.revision, 3);
  assert.equal(dryRun.approvedAt, NOW.toISOString());
  assert.equal(dryRun.cursorGeneration, "2");
  assert.deepEqual(dryRun.databaseIdentity, DATABASE_IDENTITY);
  assert.equal(dryRun.addedCollectibleMappingCount, 1);
  assert.equal(dryRun.removedCollectibleMappingCount, 0);
  assert.equal(dryRun.collectibleMappingCount, 2);
  assert.deepEqual(dryRun.addedPublicAssetOrigins, [
    "https://cdn.example.test",
  ]);
  assert.deepEqual(dryRun.removedPublicAssetOrigins, []);
  assert.match(
    dryRun.requiredConfirmation,
    /^APPROVE CLUTCHPACKS V3 CATALOG LOCAL [0-9a-f]{16}$/u,
  );

  const executed = await runClutchpacksCatalogRefresh({
    ...common,
    argv: [
      "--execute",
      "--approved-at", dryRun.approvedAt,
      "--confirmation", dryRun.requiredConfirmation,
    ],
  });
  assert.equal(executed.publicChangeSequence, "152159");
  assert.equal(executed.requiredConfirmation, null);
  assert.equal(approved.length, 1);
  assert.deepEqual(approved[0].expectedDatabaseIdentity, DATABASE_IDENTITY);
  assert.deepEqual(approved[0].expectedPrevious, {
    configurationKey: "clutchpacks-v3-canary-v2",
    revision: 2,
    configurationHash: current.context.latest.configurationHash,
    publicChangeSequence: 148290n,
  });
  assert.deepEqual(approved[0].expectedSource, {
    platformKey: "clutchpacks",
    sourceInstanceId: SOURCE_INSTANCE_ID,
    sourceRevisionId: SOURCE_REVISION_ID,
    cursorGeneration: 2n,
    latestRunId: RUN_ID,
    settledSequence: 152158n,
    sourceHeadSequence: 152158n,
    nextSequence: 152159n,
    providerSettledSequence: 152158n,
    providerSourceHeadSequence: 152158n,
  });
  assert.equal(outputs.length, 2);
});

test("dry-run reports an exact public asset origin removal", async () => {
  const current = await state();
  const previous = structuredClone(current.context.latest.configuration);
  previous.publicAssetOrigins = ["https://cdn.example.test"];
  previous.platforms[0].vendor.imageOrigins = ["https://cdn.example.test"];
  const configurationHash = await contracts.sha256CanonicalJson(
    database.PUBLIC_CATALOG_CONFIGURATION_HASH_DOMAIN,
    previous,
  );
  const evidenceWithoutImages = evidence({
    assets: evidence().assets.map((asset) => ({
      ...asset,
      content: assetContent({
        name: asset.content.name,
        category: asset.content.category,
      }),
    })),
  });
  const dryRun = await runClutchpacksCatalogRefresh({
    argv: ["--dry-run"],
    environment: environment(),
    clock: () => NOW,
    readState: async () => ({
      evidence: evidenceWithoutImages,
      context: {
        ...current.context,
        latest: {
          ...current.context.latest,
          configuration: previous,
          configurationHash,
        },
      },
    }),
    writeOutput() {},
  });
  assert.deepEqual(dryRun.addedPublicAssetOrigins, []);
  assert.deepEqual(dryRun.removedPublicAssetOrigins, [
    "https://cdn.example.test",
  ]);
});

test("refresh confirmation binds connected identity and drift blocks persistence", async () => {
  const current = await state();
  const approved = [];
  const common = {
    environment: environment(),
    clock: () => NOW,
    approveConfiguration: async (input) => {
      approved.push(input);
      throw new Error("must not persist");
    },
    writeOutput() {},
  };
  const dryRun = await runClutchpacksCatalogRefresh({
    ...common,
    argv: ["--dry-run"],
    readState: async () => current,
  });
  const replacementIdentity = {
    ...DATABASE_IDENTITY,
    databaseOid: "16433",
  };
  const replacementDryRun = await runClutchpacksCatalogRefresh({
    ...common,
    argv: ["--dry-run"],
    readState: async () => ({
      ...current,
      evidence: {
        ...current.evidence,
        databaseIdentity: replacementIdentity,
      },
    }),
  });
  assert.notEqual(
    replacementDryRun.requiredConfirmation,
    dryRun.requiredConfirmation,
  );
  await assert.rejects(
    runClutchpacksCatalogRefresh({
      ...common,
      argv: [
        "--execute",
        "--approved-at", dryRun.approvedAt,
        "--confirmation", dryRun.requiredConfirmation,
      ],
      readState: async () => current,
      readDatabaseIdentity: async () => replacementIdentity,
    }),
    assertCode("PERSISTENCE_FAILED"),
  );
  assert.deepEqual(approved, []);
});

test("execute refuses stale approval time, changed snapshot, and active promotion", async () => {
  const current = await state();
  await assert.rejects(
    runClutchpacksCatalogRefresh({
      argv: [
        "--execute",
        "--approved-at", "2026-08-28T05:00:00.000Z",
        "--confirmation", "APPROVE CLUTCHPACKS V3 CATALOG LOCAL deadbeefdeadbeef",
      ],
      environment: environment(),
      clock: () => NOW,
      readState: async () => current,
    }),
    assertCode("APPROVAL_TIME_INVALID"),
  );
  await assert.rejects(
    runClutchpacksCatalogRefresh({
      argv: ["--dry-run"],
      environment: environment(),
      clock: () => NOW,
      readState: async () => ({
        ...current,
        context: { ...current.context, activePromotionWorkCount: 1 },
      }),
    }),
    assertCode("PROMOTION_WORK_ACTIVE"),
  );
  const dryRun = await runClutchpacksCatalogRefresh({
    argv: ["--dry-run"],
    environment: environment(),
    clock: () => NOW,
    readState: async () => current,
    writeOutput: () => undefined,
  });
  await assert.rejects(
    runClutchpacksCatalogRefresh({
      argv: [
        "--execute", "--approved-at", dryRun.approvedAt,
        "--confirmation", dryRun.requiredConfirmation,
      ],
      environment: environment(),
      clock: () => NOW,
      readState: async () => ({
        ...current,
        evidence: {
          ...current.evidence,
          latestRunId: "11111111-1111-4111-8111-111111111111",
        },
      }),
    }),
    assertCode("CONFIRMATION_INVALID"),
  );
  await assert.rejects(
    runClutchpacksCatalogRefresh({
      argv: [
        "--execute", "--approved-at", dryRun.approvedAt,
        "--confirmation", dryRun.requiredConfirmation,
      ],
      environment: environment(),
      clock: () => NOW,
      readState: async () => ({
        ...current,
        evidence: {
          ...current.evidence,
          currentCursorGeneration: 3n,
          latestRunCursorGeneration: 3n,
        },
      }),
    }),
    assertCode("CONFIRMATION_INVALID"),
  );
});

test("growth-only refresh preserves every previously approved identity", async () => {
  const current = await state();
  const regressed = structuredClone(current.context.latest.configuration);
  regressed.collectibles = [];
  assert.throws(
    () => assertClutchpacksCatalogGrowthOnly(
      current.context.latest.configuration,
      regressed,
    ),
    assertCode("GROWTH_POLICY_VIOLATION"),
  );
});

test("refresh permits only a mapping removal proven by exact current unassociated shell evidence", async () => {
  const current = await state();
  const previous = structuredClone(current.context.latest.configuration);
  const candidate = structuredClone(previous);
  candidate.collectibles = [];
  const exactShellEvidence = evidence({
    canonicalAssetCount: 1,
    assets: [{
      externalId: previous.collectibles[0].externalId,
      content: assetContent({ name: null }),
      associated: false,
    }],
  });
  assert.doesNotThrow(() =>
    assertClutchpacksCatalogGrowthOnly(
      previous,
      candidate,
      exactShellEvidence,
    ),
  );

  for (const changedAsset of [{
    externalId: previous.collectibles[0].externalId,
    content: assetContent({ name: null }),
    associated: true,
  }, {
    externalId: previous.collectibles[0].externalId,
    content: assetContent({ name: "Now publicly representable" }),
    associated: false,
  }]) {
    assert.throws(
      () => assertClutchpacksCatalogGrowthOnly(
        previous,
        candidate,
        evidence({ canonicalAssetCount: 1, assets: [changedAsset] }),
      ),
      assertCode("GROWTH_POLICY_VIOLATION"),
    );
  }
});

test("growth-only refresh allows monotonic collectible metadata enrichment", async () => {
  const current = await state();
  const previous = structuredClone(current.context.latest.configuration);
  const candidate = structuredClone(previous);
  const previousCollectible = previous.collectibles[0];
  const candidateCollectible = candidate.collectibles[0];
  assert.ok(previousCollectible);
  assert.ok(candidateCollectible);
  assert.ok(candidateCollectible.publicCategoryIds.length > 0);
  previousCollectible.publicCategoryIds = [];
  previousCollectible.aliases = ["Original name"];
  candidateCollectible.aliases = ["Original name", "Supplemental name"];
  candidateCollectible.chaseEvidenceKinds = [
    "historical_pull_inference",
    ...previousCollectible.chaseEvidenceKinds,
  ].sort();
  previousCollectible.matchConfidenceBasisPoints = 9_000;
  candidateCollectible.matchConfidenceBasisPoints = 9_500;
  candidateCollectible.year = 2024;
  candidateCollectible.brand = "ClutchPacks";
  candidateCollectible.probabilityBucketId = "observed-chase";

  assert.doesNotThrow(() =>
    assertClutchpacksCatalogGrowthOnly(previous, candidate),
  );
});

test("growth-only refresh rejects collectible identity or fact regression", async () => {
  const current = await state();
  const baseline = current.context.latest.configuration;
  const mutations = [
    (previous, candidate) => {
      candidate.collectibles[0].publicCollectibleId =
        previous.collectibles[0].publicCollectibleId ===
          "11111111-1111-5111-8111-111111111111"
          ? "22222222-2222-5222-8222-222222222222"
          : "11111111-1111-5111-8111-111111111111";
    },
    (previous, candidate) => {
      candidate.collectibles[0].collectibleType =
        previous.collectibles[0].collectibleType === "card"
          ? "memorabilia"
          : "card";
    },
    (previous, candidate) => {
      previous.collectibles[0].aliases = ["Must remain"];
      candidate.collectibles[0].aliases = [];
    },
    (previous, candidate) => {
      previous.collectibles[0].brand = "Original brand";
      candidate.collectibles[0].brand = "Changed brand";
    },
    (previous, candidate) => {
      previous.collectibles[0].probabilityBucketId = "original-bucket";
      candidate.collectibles[0].probabilityBucketId = null;
    },
    (previous, candidate) => {
      previous.collectibles[0].matchConfidenceBasisPoints = 9_000;
      candidate.collectibles[0].matchConfidenceBasisPoints = 8_999;
    },
  ];
  for (const mutate of mutations) {
    const previous = structuredClone(baseline);
    const candidate = structuredClone(baseline);
    mutate(previous, candidate);
    assert.throws(
      () => assertClutchpacksCatalogGrowthOnly(previous, candidate),
      assertCode("GROWTH_POLICY_VIOLATION"),
    );
  }
});
