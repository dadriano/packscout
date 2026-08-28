import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  providerIdentityNamespaceByLaunchProvider,
  approvedPublicCatalogConfigurationV1Schema,
} = await tsImport("@packscout/contracts", import.meta.url);
const {
  CLUTCHPACKS_CATALOG_QUALIFICATION_TRANSACTION_TIMEOUT_MS,
  ClutchpacksCatalogCandidateError,
  applyClutchpacksCatalogQualificationTransactionGuards,
  assertClutchpacksCatalogCandidateTargetQualified,
  attachClutchpacksCatalogAssetAssociationEvidence,
  buildClutchpacksCatalogCandidate,
  parseClutchpacksCatalogCandidateCommand,
  readClutchpacksCatalogCandidateEnvironment,
  runClutchpacksCatalogCandidate,
  uuidV5,
} = await tsImport(
  "./generate-clutchpacks-v3-public-catalog-candidate.mts",
  import.meta.url,
);

const ORGANIZATION_ID = "39137605-0b90-563e-a40e-01d6062f4d85";
const NAMESPACE_ID = "0d033a4b-4d66-5725-b253-8b9e1b7a94bf";
const PACK_EXTERNAL_ID = "e5f7565e-664c-416f-87b4-26dba7efde2b";
const DATABASE_IDENTITY = Object.freeze({
  databaseName: "packscout_clutchpacks_v3_canary",
  databaseOid: "16432",
  systemIdentifier: "7541020403012209001",
});
const mapper = {
  mapperKey: "clutchpacks-provider-observation",
  mapperVersion: "1",
  identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.clutchpacks,
};
const FIRST_SEEN_AT = "2026-08-27T15:00:00.000Z";

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
    PACKSCOUT_CLUTCHPACKS_CATALOG_NAMESPACE_UUID: NAMESPACE_ID,
    PACKSCOUT_CLUTCHPACKS_CATALOG_CONFIGURATION_KEY:
      "clutchpacks-v3-canary-v1",
    PACKSCOUT_CLUTCHPACKS_CATALOG_REVISION: "1",
    PACKSCOUT_CLUTCHPACKS_CATALOG_APPROVED_AT:
      "2026-08-27T15:43:26.000Z",
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
  const sourceInstanceId = "00000000-0000-4000-8000-000000000001";
  const sourceRevisionId = "11111111-1111-4111-8111-111111111111";
  return {
    databaseIdentity: DATABASE_IDENTITY,
    organizationCount: 1,
    providerCount: 1,
    providerPlatformKey: "clutchpacks",
    providerState: "active",
    sourceCount: 1,
    sourceInstanceId,
    sourceState: "paused",
    sourcePauseRequested: false,
    sourceRevisionCount: 1,
    sourceRevisionId,
    sourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    mapperKey: mapper.mapperKey,
    mapperVersion: mapper.mapperVersion,
    identityNamespaceKey: mapper.identityNamespaceKey,
    cursorCodecVersion: DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
    currentCursorCount: 1,
    currentCursorSourceInstanceId: sourceInstanceId,
    currentCursorSourceRevisionId: sourceRevisionId,
    currentCursorGeneration: 1n,
    latestRunCount: 1,
    latestRunId: "22222222-2222-4222-8222-222222222222",
    latestRunState: "succeeded",
    latestRunReachedProviderHead: true,
    latestRunFinished: true,
    latestRunFailureCode: null,
    latestRunSourceInstanceId: sourceInstanceId,
    latestRunSourceRevisionId: sourceRevisionId,
    latestRunCursorGeneration: 1n,
    latestRunAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    latestRunNormalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    latestRunMapperKey: mapper.mapperKey,
    latestRunMapperVersion: mapper.mapperVersion,
    latestRunIdentityNamespaceKey: mapper.identityNamespaceKey,
    latestRunCursorCodecVersion: DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
    activeRunCount: 0,
    liveSupervisorCount: 0,
    wrongDeliveryLineageCount: 0,
    deliveryCount: 5,
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
    globalSettledSequence: 10n,
    globalSourceHeadSequence: 10n,
    globalNextSequence: 11n,
    globalSettledAt: new Date("2026-08-27T15:43:25.000Z"),
    globalSourceHeadAt: new Date("2026-08-27T15:43:25.000Z"),
    providerSettledSequence: 10n,
    providerSourceHeadSequence: 10n,
    providerSettledAt: new Date("2026-08-27T15:43:25.000Z"),
    providerSourceHeadAt: new Date("2026-08-27T15:43:25.000Z"),
    pendingObligationCount: 0,
    legacyProviderConfigurationCount: 0,
    legacyProviderSecretCount: 0,
    legacyProviderCursorCount: 0,
    packs: [{
      externalId: PACK_EXTERNAL_ID,
      content: packContent({
        imageUrls: ["https://cdn.example.test/pack.jpg"],
      }),
    }],
    assets: [{
      externalId: "card-2",
      content: assetContent({
        name: "Card Two",
        imageUrls: ["https://cdn.example.test/2.jpg"],
      }),
      associated: true,
    }, {
      externalId: "card-1",
      content: assetContent({ name: null }),
      associated: false,
    }],
    ...overrides,
  };
}

function assertCode(code) {
  return (error) => {
    assert.ok(error instanceof ClutchpacksCatalogCandidateError);
    assert.equal(error.code, code);
    return true;
  };
}

test("environment and command bind one exact query-free loopback target", () => {
  assert.equal(
    CLUTCHPACKS_CATALOG_QUALIFICATION_TRANSACTION_TIMEOUT_MS,
    120_000,
  );
  const parsed = readClutchpacksCatalogCandidateEnvironment(environment());
  assert.equal(parsed.organizationId, ORGANIZATION_ID);
  assert.equal(parsed.databaseTarget,
    "postgresql://127.0.0.1:5432/packscout_clutchpacks_v3_canary");
  assert.deepEqual(parsed.policy.publicAssetOriginAllowlist, [
    "https://cdn.example.test",
  ]);
  assert.deepEqual(
    parseClutchpacksCatalogCandidateCommand(["--output", "/private/candidate.json"]),
    { execute: false, outputPath: "/private/candidate.json", confirmation: null },
  );
  assert.throws(
    () => readClutchpacksCatalogCandidateEnvironment(environment({
      PACKSCOUT_DATABASE_URL:
        "postgresql://operator@127.0.0.1:5432/packscout_clutchpacks_v3_canary?schema=public",
    })),
    assertCode("ENVIRONMENT_INVALID"),
  );
  for (const publicAssetOriginAllowlist of [
    undefined,
    '["https://z.example.test","https://a.example.test"]',
    '["https://cdn.example.test","https://cdn.example.test"]',
    '["http://cdn.example.test"]',
    '["https://cdn.example.test/path"]',
    '[ "https://cdn.example.test" ]',
    ' ["https://cdn.example.test"]',
  ]) {
    assert.throws(
      () => readClutchpacksCatalogCandidateEnvironment(environment({
        PACKSCOUT_CLUTCHPACKS_CATALOG_PUBLIC_ASSET_ORIGINS_JSON:
          publicAssetOriginAllowlist,
      })),
      assertCode("ENVIRONMENT_INVALID"),
    );
  }
  assert.throws(
    () => parseClutchpacksCatalogCandidateCommand([
      "--execute", "--output", "/private/candidate.json",
    ]),
    assertCode("ARGUMENT_INVALID"),
  );
});

test("qualification installs a database-side statement timeout", async () => {
  const executed = [];
  const queried = [];
  await applyClutchpacksCatalogQualificationTransactionGuards({
    $executeRaw: async (statement) => {
      executed.push(statement);
      return 0;
    },
    $queryRaw: async (statement) => {
      queried.push(statement);
      return [{ set_config: "120000ms" }];
    },
  });
  assert.equal(executed.length, 1);
  assert.match(executed[0].sql, /set transaction read only/u);
  assert.equal(queried.length, 1);
  assert.match(queried[0].sql, /set_config/u);
  assert.deepEqual(queried[0].values, ["120000ms"]);
});

test("UUIDv5 identities use the standard namespace algorithm", () => {
  assert.equal(
    uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "example.com"),
    "cfbff0d1-9375-5685-968c-48ce8b15ae17",
  );
});

test("candidate is deterministic, canonical, complete, and does not infer metadata", () => {
  const parsedEnvironment = readClutchpacksCatalogCandidateEnvironment(environment());
  const first = buildClutchpacksCatalogCandidate(evidence(), parsedEnvironment.policy);
  const second = buildClutchpacksCatalogCandidate(evidence(), parsedEnvironment.policy);
  assert.deepEqual(first, second);
  assert.equal(approvedPublicCatalogConfigurationV1Schema.safeParse(first).success, true);
  assert.deepEqual(first.publicAssetOrigins, ["https://cdn.example.test"]);
  assert.deepEqual(first.collectibles.map(({ externalId }) => externalId), [
    "card-2",
  ]);
  assert.deepEqual(first.collectibles[0].chaseEvidenceKinds, [
    "historical_pull_inference", "packscout_resolved",
  ]);
  assert.equal(first.collectibles[0].year, null);
  assert.equal(first.categories.length, 0);
  assert.equal(first.platforms[0].vendor.websiteUrl, "https://clutchpacks.io/");
  assert.deepEqual(first.platforms[0].vendor.listingHosts, ["clutchpacks.io"]);
  assert.equal(
    first.repacks[0].listingUrl,
    `https://clutchpacks.io/checkout/${PACK_EXTERNAL_ID}/`,
  );
});

test("candidate maps the exact ClutchPacks taxonomy and collectible categories", () => {
  const parsedEnvironment = readClutchpacksCatalogCandidateEnvironment(environment());
  const candidate = buildClutchpacksCatalogCandidate(evidence({
    packs: [{
      externalId: PACK_EXTERNAL_ID,
      content: packContent({
        category: "Sports",
        imageUrls: ["https://cdn.example.test/pack.jpg"],
      }),
    }],
    assets: [{
      externalId: "card-2",
      content: assetContent({
        name: "Card Two",
        category: "Basketball",
        imageUrls: ["https://cdn.example.test/2.jpg"],
      }),
      associated: true,
    }, {
      externalId: "card-1",
      content: assetContent({ name: "Card One", category: "Pokemon" }),
      associated: false,
    }],
  }), parsedEnvironment.policy);
  const byKey = new Map(candidate.categories.map((category) => [
    category.categoryKey,
    category,
  ]));
  assert.deepEqual([...byKey.keys()].sort(), [
    "basketball",
    "pokemon",
    "sports",
    "trading-card-games",
  ]);
  assert.deepEqual(byKey.get("basketball").pathPublicCategoryIds, [
    byKey.get("sports").publicCategoryId,
    byKey.get("basketball").publicCategoryId,
  ]);
  assert.deepEqual(byKey.get("pokemon").pathPublicCategoryIds, [
    byKey.get("trading-card-games").publicCategoryId,
    byKey.get("pokemon").publicCategoryId,
  ]);
  assert.deepEqual(
    candidate.platforms[0].categoryMappings.map(({ sourceValue }) => sourceValue),
    ["Basketball", "Pokemon", "Sports"],
  );
  assert.deepEqual(
    candidate.collectibles.find(({ externalId }) => externalId === "card-2")
      .publicCategoryIds,
    [
      byKey.get("sports").publicCategoryId,
      byKey.get("basketball").publicCategoryId,
    ].sort(),
  );
  assert.deepEqual(
    candidate.collectibles.find(({ externalId }) => externalId === "card-1")
      .publicCategoryIds,
    [
      byKey.get("trading-card-games").publicCategoryId,
      byKey.get("pokemon").publicCategoryId,
    ].sort(),
  );
});

test("candidate governs both branches needed for a Liftoff-style mixed projection", () => {
  const parsedEnvironment = readClutchpacksCatalogCandidateEnvironment(environment());
  const candidate = buildClutchpacksCatalogCandidate(evidence({
    packs: [{
      externalId: PACK_EXTERNAL_ID,
      content: packContent({
        category: "Multisport",
        imageUrls: ["https://cdn.example.test/pack.jpg"],
      }),
    }],
    assets: [{
      externalId: "marvel-card",
      content: assetContent({
        name: "Marvel Card",
        category: "Marvel",
        imageUrls: ["https://cdn.example.test/marvel.jpg"],
      }),
      associated: true,
    }, {
      externalId: "blank-card",
      content: assetContent({ name: null }),
      associated: false,
    }],
  }), parsedEnvironment.policy);
  const byKey = new Map(candidate.categories.map((category) => [
    category.categoryKey,
    category,
  ]));
  assert.deepEqual([...byKey.keys()].sort(), [
    "marvel",
    "multi-sport",
    "sports",
    "trading-card-games",
  ]);
  assert.deepEqual(
    candidate.platforms[0].categoryMappings.map(({ sourceValue }) => sourceValue),
    ["Marvel", "Multisport"],
  );
  assert.deepEqual(
    candidate.collectibles.find(({ externalId }) =>
      externalId === "marvel-card").publicCategoryIds,
    [
      byKey.get("trading-card-games").publicCategoryId,
      byKey.get("marvel").publicCategoryId,
    ].sort(),
  );
});

test("candidate refuses an unapproved source category", () => {
  const parsedEnvironment = readClutchpacksCatalogCandidateEnvironment(environment());
  assert.throws(
    () => buildClutchpacksCatalogCandidate(evidence({
      packs: [{
        externalId: PACK_EXTERNAL_ID,
        content: packContent({ category: "Mystery" }),
      }],
    }), parsedEnvironment.policy),
    assertCode("TARGET_NOT_QUALIFIED"),
  );
});

test("candidate omits only unassociated assets that cannot satisfy the public name contract", () => {
  const parsedEnvironment = readClutchpacksCatalogCandidateEnvironment(environment());
  const candidate = buildClutchpacksCatalogCandidate(evidence({
    canonicalAssetCount: 4,
    assets: [{
      externalId: "first-null-unassociated",
      content: assetContent({ name: null }),
      associated: false,
    }, {
      externalId: "second-null-unassociated",
      content: assetContent({ name: null }),
      associated: false,
    }, {
      externalId: "named-unassociated",
      content: assetContent({ name: "Searchable standalone" }),
      associated: false,
    }, {
      externalId: "named-associated",
      content: assetContent({ name: "Known chase" }),
      associated: true,
    }],
  }), parsedEnvironment.policy);
  assert.deepEqual(candidate.collectibles.map(({ externalId }) => externalId), [
    "named-associated",
    "named-unassociated",
  ]);
});

test("candidate observes only canonical imageUrls and rejects unapproved image origins", () => {
  const parsedEnvironment = readClutchpacksCatalogCandidateEnvironment(environment());
  const harmlessTextUrls = buildClutchpacksCatalogCandidate(evidence({
    packs: [{
      externalId: PACK_EXTERNAL_ID,
      content: packContent({
        name: "https://name.example.test/is-not-an-image",
        description: "See https://description.example.test/not-an-image",
        imageUrls: [],
      }),
    }],
    assets: [{
      externalId: "card-2",
      content: assetContent({
        name: "https://asset-name.example.test/not-an-image",
        description: "https://asset-description.example.test/not-an-image",
        imageUrls: ["https://cdn.example.test/card.jpg"],
      }),
      associated: true,
    }, {
      externalId: "card-1",
      content: assetContent({ name: null }),
      associated: false,
    }],
  }), parsedEnvironment.policy);
  assert.deepEqual(harmlessTextUrls.publicAssetOrigins, [
    "https://cdn.example.test",
  ]);

  for (const unapprovedImageEvidence of [
    evidence({
      packs: [{
        externalId: PACK_EXTERNAL_ID,
        content: packContent({
          imageUrls: ["https://unapproved.example.test/pack.jpg"],
        }),
      }],
    }),
    evidence({
      assets: [{
        externalId: "card-2",
        content: assetContent({
          name: "Card Two",
          imageUrls: ["https://unapproved.example.test/card.jpg"],
        }),
        associated: true,
      }, {
        externalId: "card-1",
        content: assetContent({ name: null }),
        associated: false,
      }],
    }),
  ]) {
    assert.throws(
      () => buildClutchpacksCatalogCandidate(
        unapprovedImageEvidence,
        parsedEnvironment.policy,
      ),
      assertCode("TARGET_NOT_QUALIFIED"),
    );
  }

  assert.throws(
    () => buildClutchpacksCatalogCandidate(evidence({
      packs: [{
        externalId: PACK_EXTERNAL_ID,
        content: { ...packContent(), unexpectedField: true },
      }],
    }), parsedEnvironment.policy),
    assertCode("TARGET_NOT_QUALIFIED"),
  );
});

test("association membership is set-oriented and consumes relationship evidence once", () => {
  const assetCount = 6_367;
  const associationCount = 19_927;
  const assets = Array.from({ length: assetCount }, (_, index) => ({
    externalId: `asset-${index}`,
    content: { name: `Asset ${index}` },
  }));
  let yieldedAssociationCount = 0;
  function* associations() {
    for (let index = 0; index < associationCount; index += 1) {
      yieldedAssociationCount += 1;
      yield { assetExternalId: `asset-${index % assetCount}` };
    }
  }
  const marked = attachClutchpacksCatalogAssetAssociationEvidence(
    assets,
    associations(),
  );
  assert.equal(yieldedAssociationCount, associationCount);
  assert.equal(marked.length, assetCount);
  assert.ok(marked.every(({ associated }) => associated === true));
});

test("qualification fails closed on lineage, anomalies, settlement, or unnamed associated data", () => {
  const bad = [
    evidence({ mapperVersion: "2" }),
    evidence({ quarantineCount: 1 }),
    evidence({ unresolvedCurrentGenerationDiagnosticCount: 1 }),
    evidence({ unresolvedCurrentGenerationOperationalEventCount: 1 }),
    evidence({ unresolvedProviderHealthCount: 1 }),
    evidence({ unresolvedSourceHealthCount: 1 }),
    evidence({ openConnectionHealthEpisodeCount: 1 }),
    evidence({ providerSourceHeadSequence: 11n }),
    evidence({ confirmationSetSizeMismatchCount: 1 }),
    evidence({
      assets: [{
        externalId: "card-1",
        content: assetContent({ name: null }),
        associated: true,
      }],
      canonicalAssetCount: 1,
    }),
  ];
  for (const candidate of bad) {
    assert.throws(
      () => assertClutchpacksCatalogCandidateTargetQualified(candidate),
      assertCode("TARGET_NOT_QUALIFIED"),
    );
  }
});

test("qualification ignores recovered run warnings but fails unresolved source state", () => {
  assert.doesNotThrow(() =>
    assertClutchpacksCatalogCandidateTargetQualified(evidence()),
  );
  assert.throws(
    () => assertClutchpacksCatalogCandidateTargetQualified(evidence({
      unresolvedCurrentGenerationOperationalEventCount: 1,
    })),
    assertCode("TARGET_NOT_QUALIFIED"),
  );
});

test("qualification requires a succeeded head run in the exact current cursor generation", () => {
  assert.throws(
    () => assertClutchpacksCatalogCandidateTargetQualified(evidence({
      currentCursorGeneration: 2n,
      latestRunCursorGeneration: 1n,
    })),
    assertCode("TARGET_NOT_QUALIFIED"),
  );
  assert.throws(
    () => assertClutchpacksCatalogCandidateTargetQualified(evidence({
      currentCursorGeneration: 2n,
      latestRunCount: 0,
      latestRunId: null,
      latestRunState: null,
      latestRunReachedProviderHead: null,
      latestRunFinished: false,
      latestRunSourceInstanceId: null,
      latestRunSourceRevisionId: null,
      latestRunCursorGeneration: null,
    })),
    assertCode("TARGET_NOT_QUALIFIED"),
  );
});

test("qualification accepts immutable replay confirmation sets with distinct pull coverage", () => {
  assert.doesNotThrow(() =>
    assertClutchpacksCatalogCandidateTargetQualified(evidence({
      confirmationSetCount: 2,
      coveredCurrentPullCount: 1,
      confirmationItemCount: 4,
      declaredConfirmationItemCount: 4,
    })),
  );
  assert.throws(
    () => assertClutchpacksCatalogCandidateTargetQualified(evidence({
      confirmationSetCount: 2,
      coveredCurrentPullCount: 0,
    })),
    assertCode("TARGET_NOT_QUALIFIED"),
  );
});

test("execute repeats qualification and requires the exact candidate-bound confirmation", async () => {
  const outputPath = "/private/candidate.json";
  const outputs = [];
  const writes = [];
  const common = {
    environment: environment(),
    readEvidence: async () => evidence(),
    readDatabaseIdentity: async () => DATABASE_IDENTITY,
    writeCandidate: async (...write) => writes.push(write),
    writeOutput: (value) => outputs.push(JSON.parse(value)),
  };
  const dryRun = await runClutchpacksCatalogCandidate({
    ...common,
    argv: ["--output", outputPath],
  });
  assert.equal(dryRun.written, false);
  assert.deepEqual(dryRun.databaseIdentity, DATABASE_IDENTITY);
  assert.equal(dryRun.collectibleMappingCount, 1);
  assert.deepEqual(dryRun.observedPublicAssetOrigins, [
    "https://cdn.example.test",
  ]);
  assert.equal(writes.length, 0);
  await assert.rejects(
    runClutchpacksCatalogCandidate({
      ...common,
      argv: [
        "--execute", "--output", outputPath,
        "--confirmation", "WRITE CLUTCHPACKS V3 CATALOG LOCAL wrong",
      ],
    }),
    assertCode("CONFIRMATION_INVALID"),
  );
  const executed = await runClutchpacksCatalogCandidate({
    ...common,
    argv: [
      "--execute", "--output", outputPath,
      "--confirmation", dryRun.requiredConfirmation,
    ],
  });
  assert.equal(executed.written, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], outputPath);
  assert.match(writes[0][1], /"schemaVersion":"approved_public_catalog_v1"/u);
  assert.equal(outputs.length, 2);
});

test("candidate confirmation binds the connected identity and rechecks it before writing", async () => {
  const outputPath = "/private/identity-bound-candidate.json";
  const writes = [];
  const common = {
    environment: environment(),
    writeCandidate: async (...write) => writes.push(write),
    writeOutput() {},
  };
  const dryRun = await runClutchpacksCatalogCandidate({
    ...common,
    argv: ["--output", outputPath],
    readEvidence: async () => evidence(),
  });
  const replacementIdentity = {
    ...DATABASE_IDENTITY,
    systemIdentifier: "7541020403012209002",
  };
  const replacementDryRun = await runClutchpacksCatalogCandidate({
    ...common,
    argv: ["--output", outputPath],
    readEvidence: async () => evidence({
      databaseIdentity: replacementIdentity,
    }),
  });
  assert.notEqual(
    replacementDryRun.requiredConfirmation,
    dryRun.requiredConfirmation,
  );
  await assert.rejects(
    runClutchpacksCatalogCandidate({
      ...common,
      argv: [
        "--execute", "--output", outputPath,
        "--confirmation", dryRun.requiredConfirmation,
      ],
      readEvidence: async () => evidence(),
      readDatabaseIdentity: async () => replacementIdentity,
    }),
    assertCode("DATABASE_READ_FAILED"),
  );
  assert.deepEqual(writes, []);
});
