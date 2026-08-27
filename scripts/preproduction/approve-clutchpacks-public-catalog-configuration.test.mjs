import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  ClutchpacksCatalogApprovalError,
  computeCatalogApprovalDatabaseTargetDigest,
  parseClutchpacksCatalogApprovalCommand,
  runClutchpacksCatalogApproval,
} from "./approve-clutchpacks-public-catalog-configuration.mjs";

const scriptPath = fileURLToPath(new URL(
  "./approve-clutchpacks-public-catalog-configuration.mjs",
  import.meta.url,
));
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const CONFIGURATION_PATH = "/private/operator/approved-clutchpacks.json";
const CONFIGURATION_HASH = "a".repeat(64);

function validEnvironment(overrides = {}) {
  return {
    PACKSCOUT_RUNTIME_ENVIRONMENT: "preproduction",
    PACKSCOUT_PUBLIC_ORGANIZATION_ID: ORGANIZATION_ID,
    PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "preproduction-west",
    PACKSCOUT_DATABASE_URL:
      "postgresql://approval:database-secret@preproduction-db.example.test/packscout_preproduction?sslmode=require",
    ...overrides,
  };
}

function configuration(platformKey = "clutchpacks") {
  const publicCategoryId = "81222222-2222-5222-8222-222222222222";
  return {
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: "configuration-key-must-not-be-emitted",
    revision: 1,
    approvedAt: "2026-08-27T12:00:00.000Z",
    staleAfterSeconds: 900,
    confidencePolicy: {
      version: "policy-content-must-not-be-emitted",
      completeScoreBasisPoints: 9_000,
      partialScoreBasisPoints: 6_000,
      unknownScoreBasisPoints: 3_000,
      limitationPenaltyBasisPoints: 500,
    },
    publicAssetOrigins: [`https://${platformKey}.example.test`],
    verifiedUsdStablecoins: [],
    categories: [{
      publicCategoryId,
      parentPublicCategoryId: null,
      categoryKey: "cards",
      name: "Cards",
      kind: "vertical",
      depth: 0,
      pathPublicCategoryIds: [publicCategoryId],
      displayOrder: 0,
    }],
    platforms: [{
      platformKey,
      vendor: {
        publicVendorId: "81111111-1111-5111-8111-111111111111",
        vendorKey: platformKey,
        displayName: "Sensitive Vendor Display Name",
        logoUrl: null,
        websiteUrl: `https://${platformKey}.example.test`,
        listingHosts: [`${platformKey}.example.test`],
        imageOrigins: [`https://${platformKey}.example.test`],
        referralParameters: [],
        publicPromo: null,
      },
      format: "repack",
      defaultPublicCategoryIds: [publicCategoryId],
      categoryMappings: [],
      collectibleTypeMappings: [],
    }],
    repacks: [{
      platformKey,
      packExternalId: "sensitive-pack-external-id",
      publicRepackId: "81333333-3333-5333-8333-333333333333",
    }],
    collectibles: [],
  };
}

function passingPreflight(config = configuration()) {
  return {
    migrationReady: true,
    readOnly: true,
    organizationCount: 1,
    registeredProviderCount: 1,
    currentV1SourceCount: 1,
    canonicalPackCount: config.repacks.length,
    configuredRepackCount: config.repacks.length,
    unconfiguredCanonicalPackCount: 0,
    unmatchedConfiguredRepackCount: 0,
    canonicalCollectibleCount: config.collectibles.length,
    associatedCanonicalCollectibleCount: 0,
    unnamedAssociatedCanonicalCollectibleCount: 0,
    configuredCollectibleCount: config.collectibles.length,
    unconfiguredCanonicalCollectibleCount: 0,
    unmatchedConfiguredCollectibleCount: 0,
  };
}

function fakeDependencies({
  approvedSequence = 7n,
  configurationValue = configuration(),
  preflightError = null,
  preflightResult = null,
  persistenceError = null,
  state = { approvalCalls: [], preflightCalls: [], timeline: [] },
  validationResult = configurationValue,
} = {}) {
  const expectedConfiguration = validationResult ?? configurationValue;
  const resolvedPreflight = preflightResult ?? passingPreflight(
    expectedConfiguration,
  );
  return {
    state,
    dependencies: {
      async readConfiguration() {
        return configurationValue;
      },
      validateConfiguration() {
        return validationResult;
      },
      async hashConfiguration() {
        return CONFIGURATION_HASH;
      },
      async preflightConfiguration(input) {
        state.preflightCalls.push(input);
        state.timeline.push("preflight");
        if (preflightError) throw preflightError;
        return resolvedPreflight;
      },
      async approveConfiguration(input) {
        state.approvalCalls.push(input);
        state.timeline.push("approve");
        if (persistenceError) throw persistenceError;
        return {
          configurationHash: CONFIGURATION_HASH,
          publicChangeSequence: approvedSequence,
        };
      },
    },
  };
}

function assertApprovalError(error, expectedCode) {
  assert.ok(error instanceof ClutchpacksCatalogApprovalError);
  assert.equal(error.code, expectedCode);
  assert.doesNotMatch(error.message, /database-secret|sensitive-pack/u);
  return true;
}

function validateWithProductionContract(config) {
  const moduleUrl = pathToFileURL(scriptPath).href;
  const source = `
    import { createProductionDependencies } from ${JSON.stringify(moduleUrl)};
    const dependencies = await createProductionDependencies();
    const input = JSON.parse(process.env.PACKSCOUT_TEST_CONFIGURATION);
    process.stdout.write(JSON.stringify({
      valid: dependencies.validateConfiguration(input) !== null,
    }));
  `;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: path.dirname(scriptPath),
      encoding: "utf8",
      env: {
        ...process.env,
        PACKSCOUT_TEST_CONFIGURATION: JSON.stringify(config),
      },
      timeout: 20_000,
    },
  );
}

test("command defaults to dry-run and requires explicit preproduction bindings", () => {
  const parsed = parseClutchpacksCatalogApprovalCommand({
    argv: [CONFIGURATION_PATH],
    environment: validEnvironment(),
  });
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.organizationId, ORGANIZATION_ID);
  assert.equal(parsed.deploymentKey, "preproduction-west");
  assert.match(parsed.databaseTargetDigest, /^[0-9a-f]{64}$/u);

  for (const [overrides, expectedCode] of [
    [{ PACKSCOUT_RUNTIME_ENVIRONMENT: "production" },
      "CATALOG_APPROVAL_ENVIRONMENT_FORBIDDEN"],
    [{ PACKSCOUT_PUBLIC_ORGANIZATION_ID: "not-a-uuid" },
      "CATALOG_APPROVAL_ORGANIZATION_INVALID"],
    [{ PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "production-west" },
      "CATALOG_APPROVAL_DEPLOYMENT_INVALID"],
    [{ PACKSCOUT_DATABASE_URL: "not-postgres" },
      "CATALOG_APPROVAL_DATABASE_TARGET_INVALID"],
  ]) {
    assert.throws(
      () => parseClutchpacksCatalogApprovalCommand({
        argv: [CONFIGURATION_PATH],
        environment: validEnvironment(overrides),
      }),
      (error) => assertApprovalError(error, expectedCode),
    );
  }
});

test("command rejects ambiguous modes, relative files, and execute without confirmation", () => {
  for (const [argv, expectedCode] of [
    [["relative.json"], "CATALOG_APPROVAL_ARGUMENT_INVALID"],
    [[CONFIGURATION_PATH, "--dry-run", "--execute"],
      "CATALOG_APPROVAL_ARGUMENT_INVALID"],
    [[CONFIGURATION_PATH, "--confirmation", "unused"],
      "CATALOG_APPROVAL_ARGUMENT_INVALID"],
    [[CONFIGURATION_PATH, "--execute"],
      "CATALOG_APPROVAL_CONFIRMATION_REQUIRED"],
  ]) {
    assert.throws(
      () => parseClutchpacksCatalogApprovalCommand({
        argv,
        environment: validEnvironment(),
      }),
      (error) => assertApprovalError(error, expectedCode),
    );
  }
});

test("database binding ignores the password but changes with the actual target", () => {
  const first = computeCatalogApprovalDatabaseTargetDigest(
    "postgresql://operator:first-secret@preproduction-db.example.test/catalog?sslmode=require",
  );
  const rotated = computeCatalogApprovalDatabaseTargetDigest(
    "postgresql://operator:second-secret@preproduction-db.example.test/catalog?sslmode=require",
  );
  const otherTarget = computeCatalogApprovalDatabaseTargetDigest(
    "postgresql://operator:second-secret@other-preproduction-db.example.test/catalog?sslmode=require",
  );
  assert.equal(first, rotated);
  assert.notEqual(first, otherTarget);
});

test("production dependencies validate configuration with the existing contract", () => {
  const result = validateWithProductionContract(configuration());
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), { valid: true });
  assert.equal(result.stderr, "");
});

test("a contract-valid non-Clutch configuration is refused before DB access", async () => {
  const contractResult = validateWithProductionContract(
    configuration("courtyard"),
  );
  assert.equal(
    contractResult.status,
    0,
    `${contractResult.stdout}\n${contractResult.stderr}`,
  );
  assert.deepEqual(JSON.parse(contractResult.stdout), { valid: true });

  const fake = fakeDependencies({
    configurationValue: configuration("courtyard"),
  });
  await assert.rejects(
    runClutchpacksCatalogApproval({
      argv: [CONFIGURATION_PATH],
      environment: validEnvironment(),
      dependencies: fake.dependencies,
      writeOutput() {},
    }),
    (error) => assertApprovalError(
      error,
      "CATALOG_APPROVAL_PLATFORM_FORBIDDEN",
    ),
  );
  assert.equal(fake.state.preflightCalls.length, 0);
  assert.equal(fake.state.approvalCalls.length, 0);
});

test("dry-run preflights read-only and execute repeats preflight before one write", async () => {
  const fake = fakeDependencies();
  const dryRunOutput = [];
  const dryRun = await runClutchpacksCatalogApproval({
    argv: [CONFIGURATION_PATH],
    environment: validEnvironment(),
    dependencies: fake.dependencies,
    writeOutput(value) {
      dryRunOutput.push(value);
    },
  });
  assert.equal(fake.state.approvalCalls.length, 0);
  assert.equal(fake.state.preflightCalls.length, 1);
  assert.deepEqual(dryRun.preflight, {
    migrationReady: true,
    readOnly: true,
    counts: {
      organizations: 1,
      registeredProviders: 1,
      currentV1Sources: 1,
      canonicalPacks: 1,
      configuredRepacks: 1,
      canonicalCollectibles: 0,
      associatedCanonicalCollectibles: 0,
      unnamedAssociatedCanonicalCollectibles: 0,
      configuredCollectibles: 0,
    },
  });

  await assert.rejects(
    runClutchpacksCatalogApproval({
      argv: [
        CONFIGURATION_PATH,
        "--execute",
        "--confirmation",
        "APPROVE CLUTCHPACKS PREPRODUCTION 0000000000000000",
      ],
      environment: validEnvironment(),
      dependencies: fake.dependencies,
      writeOutput() {},
    }),
    (error) => assertApprovalError(
      error,
      "CATALOG_APPROVAL_CONFIRMATION_MISMATCH",
    ),
  );
  assert.equal(fake.state.approvalCalls.length, 0);
  assert.equal(fake.state.preflightCalls.length, 1);

  const executionOutput = [];
  const approved = await runClutchpacksCatalogApproval({
    argv: [
      CONFIGURATION_PATH,
      "--execute",
      "--confirmation",
      dryRun.executeConfirmation,
    ],
    environment: validEnvironment(),
    dependencies: fake.dependencies,
    writeOutput(value) {
      executionOutput.push(value);
    },
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.publicChangeSequence, "7");
  assert.equal(fake.state.preflightCalls.length, 2);
  assert.equal(fake.state.approvalCalls.length, 1);
  assert.deepEqual(fake.state.timeline, ["preflight", "preflight", "approve"]);
  assert.equal(
    fake.state.preflightCalls[1].organizationId,
    ORGANIZATION_ID,
  );
  assert.equal(
    fake.state.preflightCalls[1].deploymentKey,
    "preproduction-west",
  );
  assert.equal(
    fake.state.approvalCalls[0].organizationId,
    ORGANIZATION_ID,
  );
  assert.equal(
    fake.state.approvalCalls[0].deploymentKey,
    "preproduction-west",
  );
  assert.equal(dryRunOutput.length, 1);
  assert.equal(executionOutput.length, 1);
  assert.doesNotMatch(
    `${dryRunOutput.join("\n")}\n${executionOutput.join("\n")}`,
    new RegExp(
      `database-secret|sensitive-pack-external-id|${ORGANIZATION_ID}|preproduction-west`,
      "u",
    ),
  );
});

test("database preflight failures are fail-closed before approval", async () => {
  const cases = [
    {
      expectedCode: "CATALOG_APPROVAL_DATABASE_PREFLIGHT_FAILED",
      preflightResult: {
        ...passingPreflight(),
        readOnly: false,
      },
    },
    {
      expectedCode: "CATALOG_APPROVAL_ORGANIZATION_NOT_FOUND",
      preflightResult: {
        ...passingPreflight(),
        organizationCount: 0,
      },
    },
    {
      expectedCode: "CATALOG_APPROVAL_SOURCE_NOT_READY",
      preflightResult: {
        ...passingPreflight(),
        currentV1SourceCount: 0,
      },
    },
    {
      expectedCode: "CATALOG_APPROVAL_MAPPING_COVERAGE_MISMATCH",
      preflightResult: {
        ...passingPreflight(),
        unconfiguredCanonicalPackCount: 1,
      },
    },
  ];

  for (const { expectedCode, preflightResult } of cases) {
    const fake = fakeDependencies({ preflightResult });
    await assert.rejects(
      runClutchpacksCatalogApproval({
        argv: [CONFIGURATION_PATH],
        environment: validEnvironment(),
        dependencies: fake.dependencies,
        writeOutput() {},
      }),
      (error) => assertApprovalError(error, expectedCode),
    );
    assert.equal(fake.state.preflightCalls.length, 1);
    assert.equal(fake.state.approvalCalls.length, 0);
  }

  const failed = fakeDependencies({
    preflightError: new Error(
      "database-secret sensitive-pack-external-id",
    ),
  });
  await assert.rejects(
    runClutchpacksCatalogApproval({
      argv: [CONFIGURATION_PATH],
      environment: validEnvironment(),
      dependencies: failed.dependencies,
      writeOutput() {},
    }),
    (error) => assertApprovalError(
      error,
      "CATALOG_APPROVAL_DATABASE_PREFLIGHT_FAILED",
    ),
  );
  assert.equal(failed.state.approvalCalls.length, 0);
});

test("associated catalog assets without a public name are refused and sanitized", async () => {
  const config = configuration();
  config.collectibles.push({
    platformKey: "clutchpacks",
    externalId: "sensitive-card-external-id",
    publicCollectibleId: "81444444-4444-5444-8444-444444444444",
    aliases: [],
    collectibleType: "card",
    publicCategoryIds: [config.categories[0].publicCategoryId],
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
    chaseEvidenceKinds: ["vendor_inventory"],
  });
  const fake = fakeDependencies({
    configurationValue: config,
    preflightResult: {
      ...passingPreflight(config),
      associatedCanonicalCollectibleCount: 1,
      unnamedAssociatedCanonicalCollectibleCount: 1,
    },
  });

  await assert.rejects(
    runClutchpacksCatalogApproval({
      argv: [CONFIGURATION_PATH],
      environment: validEnvironment(),
      dependencies: fake.dependencies,
      writeOutput() {},
    }),
    (error) => {
      assertApprovalError(
        error,
        "CATALOG_APPROVAL_PUBLIC_PROJECTION_NOT_READY",
      );
      assert.doesNotMatch(error.message, /sensitive-card/u);
      return true;
    },
  );
  assert.equal(fake.state.preflightCalls.length, 1);
  assert.equal(fake.state.approvalCalls.length, 0);
});

test("invalid configuration and persistence failures stay stable and sanitized", async () => {
  const invalid = fakeDependencies({ validationResult: null });
  await assert.rejects(
    runClutchpacksCatalogApproval({
      argv: [CONFIGURATION_PATH],
      environment: validEnvironment(),
      dependencies: invalid.dependencies,
      writeOutput() {},
    }),
    (error) => assertApprovalError(
      error,
      "CATALOG_APPROVAL_CONFIGURATION_INVALID",
    ),
  );
  assert.equal(invalid.state.approvalCalls.length, 0);

  const failed = fakeDependencies({
    persistenceError: {
      code: "PUBLIC_CONFIGURATION_PROMOTION_RECOVERY_REQUIRED",
      message: "raw database-secret sensitive-pack-external-id",
    },
  });
  const plan = await runClutchpacksCatalogApproval({
    argv: [CONFIGURATION_PATH],
    environment: validEnvironment(),
    dependencies: failed.dependencies,
    writeOutput() {},
  });
  await assert.rejects(
    runClutchpacksCatalogApproval({
      argv: [
        CONFIGURATION_PATH,
        "--execute",
        "--confirmation",
        plan.executeConfirmation,
      ],
      environment: validEnvironment(),
      dependencies: failed.dependencies,
      writeOutput() {},
    }),
    (error) => assertApprovalError(
      error,
      "CATALOG_APPROVAL_PROMOTION_RECOVERY_REQUIRED",
    ),
  );
  assert.equal(failed.state.approvalCalls.length, 1);
});
