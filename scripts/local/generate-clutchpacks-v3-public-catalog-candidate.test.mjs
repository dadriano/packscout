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
  ClutchpacksCatalogCandidateError,
  assertClutchpacksCatalogCandidateTargetQualified,
  buildClutchpacksCatalogCandidate,
  clutchpacksSourceOperationalEventWhere,
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
const mapper = {
  mapperKey: "clutchpacks-provider-observation",
  mapperVersion: "1",
  identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.clutchpacks,
};

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
    PACKSCOUT_CLUTCHPACKS_CATALOG_VENDOR_DISPLAY_NAME: "ClutchPacks",
    PACKSCOUT_CLUTCHPACKS_CATALOG_FORMAT: "repack",
    ...overrides,
  };
}

function evidence(overrides = {}) {
  const sourceRevisionId = "11111111-1111-4111-8111-111111111111";
  return {
    organizationCount: 1,
    providerCount: 1,
    providerPlatformKey: "clutchpacks",
    providerState: "active",
    sourceCount: 1,
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
    latestRunCount: 1,
    latestRunId: "22222222-2222-4222-8222-222222222222",
    latestRunState: "succeeded",
    latestRunReachedProviderHead: true,
    latestRunFinished: true,
    latestRunFailureCode: null,
    latestRunSourceRevisionId: sourceRevisionId,
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
    nonInfoDiagnosticCount: 0,
    nonInfoSourceOperationalEventCount: 0,
    canonicalPackCount: 1,
    canonicalAssetCount: 2,
    canonicalPullCount: 1,
    canonicalMarketEventCount: 1,
    confirmationSetCount: 1,
    currentPullConfirmationSetCount: 1,
    confirmationItemCount: 2,
    declaredConfirmationItemCount: 2,
    confirmationSetSizeMismatchCount: 0,
    unresolvedConfirmationItemCount: 0,
    backfillCount: 1,
    completeBackfillCount: 1,
    globalSettledSequence: 10n,
    globalSourceHeadSequence: 10n,
    globalNextSequence: 11n,
    providerSettledSequence: 10n,
    providerSourceHeadSequence: 10n,
    pendingObligationCount: 0,
    legacyProviderConfigurationCount: 0,
    legacyProviderSecretCount: 0,
    legacyProviderCursorCount: 0,
    packs: [{
      externalId: PACK_EXTERNAL_ID,
      content: { imageUrls: ["https://cdn.example.test/pack.jpg"] },
    }],
    assets: [{
      externalId: "card-2",
      content: { name: "Card Two", imageUrls: ["https://cdn.example.test/2.jpg"] },
      associated: true,
    }, {
      externalId: "card-1",
      content: { name: null },
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
  const parsed = readClutchpacksCatalogCandidateEnvironment(environment());
  assert.equal(parsed.organizationId, ORGANIZATION_ID);
  assert.equal(parsed.databaseTarget,
    "postgresql://127.0.0.1:5432/packscout_clutchpacks_v3_canary");
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
  assert.throws(
    () => parseClutchpacksCatalogCandidateCommand([
      "--execute", "--output", "/private/candidate.json",
    ]),
    assertCode("ARGUMENT_INVALID"),
  );
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
    "card-1", "card-2",
  ]);
  assert.deepEqual(first.collectibles[0].chaseEvidenceKinds, ["packscout_resolved"]);
  assert.deepEqual(first.collectibles[1].chaseEvidenceKinds, [
    "historical_pull_inference", "packscout_resolved",
  ]);
  assert.equal(first.collectibles[1].year, null);
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
      content: {
        category: "Sports",
        imageUrls: ["https://cdn.example.test/pack.jpg"],
      },
    }],
    assets: [{
      externalId: "card-2",
      content: {
        name: "Card Two",
        category: "Basketball",
        imageUrls: ["https://cdn.example.test/2.jpg"],
      },
      associated: true,
    }, {
      externalId: "card-1",
      content: { name: "Card One", category: "Pokemon" },
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
      content: {
        category: "Multisport",
        imageUrls: ["https://cdn.example.test/pack.jpg"],
      },
    }],
    assets: [{
      externalId: "marvel-card",
      content: {
        name: "Marvel Card",
        category: "Marvel",
        imageUrls: ["https://cdn.example.test/marvel.jpg"],
      },
      associated: true,
    }, {
      externalId: "blank-card",
      content: { name: null },
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
        content: { category: "Mystery", imageUrls: [] },
      }],
    }), parsedEnvironment.policy),
    assertCode("TARGET_NOT_QUALIFIED"),
  );
});

test("qualification fails closed on lineage, anomalies, settlement, or unnamed associated data", () => {
  const bad = [
    evidence({ mapperVersion: "2" }),
    evidence({ quarantineCount: 1 }),
    evidence({ nonInfoDiagnosticCount: 1 }),
    evidence({ nonInfoSourceOperationalEventCount: 1 }),
    evidence({ providerSourceHeadSequence: 11n }),
    evidence({ confirmationSetSizeMismatchCount: 1 }),
    evidence({
      assets: [{ externalId: "card-1", content: { name: " " }, associated: true }],
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

test("qualification excludes downstream promotion events but retains source events", () => {
  assert.deepEqual(
    clutchpacksSourceOperationalEventWhere(ORGANIZATION_ID),
    {
      organization_id: ORGANIZATION_ID,
      provider_id: { not: null },
      severity: { in: ["warning", "critical"] },
    },
  );
  assert.doesNotThrow(() =>
    assertClutchpacksCatalogCandidateTargetQualified(evidence()),
  );
  assert.throws(
    () => assertClutchpacksCatalogCandidateTargetQualified(evidence({
      nonInfoSourceOperationalEventCount: 1,
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
    writeCandidate: async (...write) => writes.push(write),
    writeOutput: (value) => outputs.push(JSON.parse(value)),
  };
  const dryRun = await runClutchpacksCatalogCandidate({
    ...common,
    argv: ["--output", outputPath],
  });
  assert.equal(dryRun.written, false);
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
