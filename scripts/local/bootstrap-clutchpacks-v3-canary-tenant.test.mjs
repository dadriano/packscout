import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  CLUTCHPACKS_V3_CANARY_SOURCE_PINS,
  ClutchpacksV3CanaryBootstrapError,
  assessClutchpacksV3ReplayCapacity,
  assertClutchpacksV3ActiveSourceMigrationReadiness,
  assertClutchpacksV3CanaryTargetIsSafe,
  assertClutchpacksV3TargetCompositeMigrations,
  parseClutchpacksV3CanaryBootstrapCommand,
  readClutchpacksV3CanaryBootstrapEnvironment,
  safeClutchpacksV3CanaryBootstrapFailure,
} = await tsImport(
  "./bootstrap-clutchpacks-v3-canary-tenant.mts",
  import.meta.url,
);

const scriptPath = fileURLToPath(new URL(
  "./bootstrap-clutchpacks-v3-canary-tenant.mts",
  import.meta.url,
));
const sourceOrganizationId = "11111111-1111-4111-8111-111111111111";
const targetOrganizationId = "22222222-2222-4222-8222-222222222222";
const connectionKey = Buffer.alloc(32, 7).toString("base64");
const validEnvironment = Object.freeze({
  NODE_ENV: "development",
  PACKSCOUT_RUNTIME_ENVIRONMENT: "local",
  PACKSCOUT_CLUTCHPACKS_V1_DATABASE_URL:
    "postgresql://packscout:source-db-secret@127.0.0.1:5432/packscout_dev",
  PACKSCOUT_DATABASE_URL:
    "postgresql://packscout:target-db-secret@127.0.0.1:5432/packscout_clutch_v3",
  PACKSCOUT_CLUTCHPACKS_V1_ORGANIZATION_ID: sourceOrganizationId,
  PACKSCOUT_CLUTCHPACKS_V3_CANARY_ORGANIZATION_ID: targetOrganizationId,
  PACKSCOUT_CLUTCHPACKS_V3_TARGET_ACK:
    "I_UNDERSTAND_THE_TARGET_MUST_BE_A_FRESH_LOCAL_DATABASE",
  PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64: connectionKey,
  PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION: "1",
});

function hasCode(code) {
  return (error) =>
    error instanceof ClutchpacksV3CanaryBootstrapError && error.code === code;
}

function emptySnapshot(overrides = {}) {
  return {
    organizationCount: 0,
    organization: null,
    providers: [],
    profiles: [],
    connectionRevisions: [],
    sources: [],
    sourceRevisions: [],
    cursors: [],
    importRunCount: 0,
    importPageCount: 0,
    canonicalEntityCount: 0,
    legacyProviderConfigurationCount: 0,
    legacyProviderSecretCount: 0,
    legacyProviderConnectionTestCount: 0,
    legacyProviderCursorCount: 0,
    ...overrides,
  };
}

test("source and target bindings are separate, stable, and credential-free", () => {
  const parsed = readClutchpacksV3CanaryBootstrapEnvironment(validEnvironment);
  assert.equal(parsed.sourceDatabaseName, "packscout_dev");
  assert.equal(parsed.targetDatabaseName, "packscout_clutch_v3");
  assert.equal(parsed.sourceOrganizationId, sourceOrganizationId);
  assert.equal(parsed.targetOrganizationId, targetOrganizationId);
  assert.equal(parsed.connectionKeyVersion, 1);
  assert.match(parsed.targetDigest, /^[0-9a-f]{64}$/u);
  assert.equal(
    parsed.confirmation,
    `BOOTSTRAP CLUTCHPACKS V3 LOCAL ${parsed.targetDigest.slice(0, 16)}`,
  );
  const identities = [
    parsed.providerId,
    parsed.profileId,
    parsed.connectionRevisionId,
  ];
  assert.equal(new Set(identities).size, identities.length);
  assert.ok(identities.every((identity) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(identity)
  ));
  const publicPlan = JSON.stringify({
    sourceDatabase: parsed.sourceDatabaseName,
    targetDatabase: parsed.targetDatabaseName,
    targetDigest: parsed.targetDigest,
    confirmation: parsed.confirmation,
  });
  assert.doesNotMatch(
    publicPlan,
    /source-db-secret|target-db-secret|BwcHBwcHBwcH/iu,
  );
});

test("environment admission refuses nonlocal, ambiguous, or nonfresh targets", () => {
  const refusals = [
    [{ ...validEnvironment, NODE_ENV: "production" },
      "LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED"],
    [{ ...validEnvironment, PACKSCOUT_RUNTIME_ENVIRONMENT: "preproduction" },
      "LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED"],
    [{
      ...validEnvironment,
      PACKSCOUT_DATABASE_URL:
        "postgresql://packscout@database.example.test/packscout_clutch_v3",
    }, "DATABASE_TARGET_NOT_LOCAL"],
    [{
      ...validEnvironment,
      PACKSCOUT_DATABASE_URL:
        "postgresql://packscout@127.0.0.1/packscout_clutch_v3?schema=public",
    }, "DATABASE_TARGET_AMBIGUOUS"],
    [{
      ...validEnvironment,
      PACKSCOUT_DATABASE_URL:
        "postgresql://packscout@127.0.0.1/postgres",
    }, "DATABASE_TARGET_AMBIGUOUS"],
    [{
      ...validEnvironment,
      PACKSCOUT_DATABASE_URL:
        validEnvironment.PACKSCOUT_CLUTCHPACKS_V1_DATABASE_URL,
    }, "SEPARATE_TARGET_DATABASE_REQUIRED"],
    [{
      ...validEnvironment,
      PACKSCOUT_DATABASE_URL:
        "postgresql://other@localhost:5433/packscout_dev",
    }, "SEPARATE_TARGET_DATABASE_REQUIRED"],
    [{
      ...validEnvironment,
      PACKSCOUT_CLUTCHPACKS_V3_CANARY_ORGANIZATION_ID: sourceOrganizationId,
    }, "ORGANIZATION_BINDING_INVALID"],
    [{
      ...validEnvironment,
      PACKSCOUT_CLUTCHPACKS_V3_TARGET_ACK: "not acknowledged",
    }, "FRESH_TARGET_ACKNOWLEDGEMENT_REQUIRED"],
    [{
      ...validEnvironment,
      PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64: "not-a-key",
    }, "CONNECTION_KEY_INVALID"],
  ];
  for (const [environment, code] of refusals) {
    assert.throws(
      () => readClutchpacksV3CanaryBootstrapEnvironment(environment),
      hasCode(code),
    );
  }
});

test("execute requires the exact digest-bound confirmation", () => {
  const parsed = readClutchpacksV3CanaryBootstrapEnvironment(validEnvironment);
  assert.deepEqual(
    parseClutchpacksV3CanaryBootstrapCommand([], parsed.confirmation),
    { execute: false, confirmation: parsed.confirmation },
  );
  assert.deepEqual(
    parseClutchpacksV3CanaryBootstrapCommand(["--dry-run"], parsed.confirmation),
    { execute: false, confirmation: parsed.confirmation },
  );
  assert.deepEqual(
    parseClutchpacksV3CanaryBootstrapCommand(
      ["--execute", "--confirmation", parsed.confirmation],
      parsed.confirmation,
    ),
    { execute: true, confirmation: parsed.confirmation },
  );
  for (const argv of [
    ["--execute"],
    ["--execute", "--confirmation", "BOOTSTRAP CLUTCHPACKS V3 LOCAL wrong"],
    ["--dry-run", "--execute"],
  ]) {
    assert.throws(
      () => parseClutchpacksV3CanaryBootstrapCommand(argv, parsed.confirmation),
      hasCode("CONFIRMATION_INVALID"),
    );
  }
});

test("replay capacity requires only the original Clutch lane paused and drained", () => {
  assert.deepEqual(
    assessClutchpacksV3ReplayCapacity({
      clutchSourceState: "active",
      clutchActiveRunCount: 0,
    }),
    { ready: false, reason: "clutch_not_paused" },
  );
  assert.deepEqual(
    assessClutchpacksV3ReplayCapacity({
      clutchSourceState: "paused",
      clutchActiveRunCount: 1,
    }),
    { ready: false, reason: "clutch_work_not_drained" },
  );
  assert.deepEqual(
    assessClutchpacksV3ReplayCapacity({
      clutchSourceState: "paused",
      clutchActiveRunCount: 0,
      activeSiblingSourceCount: 3,
    }),
    { ready: true, reason: "ready" },
  );
});

test("the active source requires the exact 84-table migration subset", () => {
  const valid = Object.freeze({
    migrationName: "20260827010000_provider_source_platform_request_lanes",
    checksum:
      "e1832b7d15630efe544dc2d282aa5b221aac52be9fa648fa4b66b856ac84dbb7",
    finishedAt: new Date("2026-08-27T08:00:00.000Z"),
    rolledBackAt: null,
    tableCount: 84,
  });
  assert.doesNotThrow(() =>
    assertClutchpacksV3ActiveSourceMigrationReadiness([valid])
  );
  for (const evidence of [
    [],
    [{ ...valid, checksum: "0".repeat(64) }],
    [{ ...valid, finishedAt: null }],
    [{ ...valid, rolledBackAt: new Date("2026-08-27T09:00:00.000Z") }],
    [{ ...valid, tableCount: 83 }],
    [{ ...valid, tableCount: 88 }],
    [valid, valid],
  ]) {
    assert.throws(
      () => assertClutchpacksV3ActiveSourceMigrationReadiness(evidence),
      hasCode("ACTIVE_SOURCE_MIGRATION_READINESS_REQUIRED"),
    );
  }
});

test("the target requires all composite migrations and 91 application tables", () => {
  const migrations = [
    {
      migrationName: "20260819010000_buyback_ev_revisions",
      checksum:
        "71afde6ae913c32a5c7f017da5035775ed5f1fba7d1b48e0b7be4a86e4d825b0",
    },
    {
      migrationName: "20260826005000_source_relationship_confirmations",
      checksum:
        "19cfc4cdae5fc3615159c5ead740fdc3e3e83945bf6c9ec2176ce36067ce9a21",
    },
    {
      migrationName: "20260826010000_heat_relationship_causality",
      checksum:
        "5ac08e4eb77bc83838d94796ace095c93dbdfab2344a2658cb87b46e3397193d",
    },
    {
      migrationName: "20260827010000_provider_source_platform_request_lanes",
      checksum:
        "e1832b7d15630efe544dc2d282aa5b221aac52be9fa648fa4b66b856ac84dbb7",
    },
    {
      migrationName: "20260827020000_buyback_ev_provider_source_origin",
      checksum:
        "10ae3670f6fbafb0ed529154ac7aad227b60bab735630e1079e805ddf8e7b24e",
    },
  ].map((migration) => Object.freeze({
    ...migration,
    finishedAt: new Date("2026-08-27T08:00:00.000Z"),
    rolledBackAt: null,
    tableCount: 91,
  }));
  assert.doesNotThrow(() =>
    assertClutchpacksV3TargetCompositeMigrations(migrations)
  );
  for (const evidence of [
    migrations.slice(1),
    migrations.map((row, index) =>
      index === 0 ? { ...row, checksum: "0".repeat(64) } : row
    ),
    migrations.map((row, index) =>
      index === 1 ? { ...row, tableCount: 90 } : row
    ),
    migrations.map((row, index) =>
      index === 2 ? { ...row, finishedAt: null } : row
    ),
  ]) {
    assert.throws(
      () => assertClutchpacksV3TargetCompositeMigrations(evidence),
      hasCode("TARGET_COMPOSITE_MIGRATIONS_REQUIRED"),
    );
  }
});

test("target guard permits only empty or exact v3-only Clutch topology", () => {
  assert.deepEqual(CLUTCHPACKS_V3_CANARY_SOURCE_PINS, {
    sourceTypeKey: "dataforrest-events-v1",
    adapterVersion: "dataforrest-events-adapter-v3",
    normalizedContractVersion: "packscout.provider-observation.v1",
    mapperKey: "clutchpacks-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
    cursorCodecVersion: "dataforrest-cursor-v1",
  });
  const environment = readClutchpacksV3CanaryBootstrapEnvironment(
    validEnvironment,
  );
  assert.doesNotThrow(() =>
    assertClutchpacksV3CanaryTargetIsSafe(emptySnapshot(), environment)
  );
  const sourceId = "33333333-3333-4333-8333-333333333333";
  const staged = emptySnapshot({
    organizationCount: 1,
    organization: {
      id: environment.targetOrganizationId,
      slug: "packscout-clutchpacks-v3-canary",
      name: "PackScout ClutchPacks V3 Canary",
    },
    providers: [{
      id: environment.providerId,
      platformKey: "clutchpacks",
      state: "active",
      activeRevisionId: null,
      nextRunAt: null,
    }],
    profiles: [{
      id: environment.profileId,
      sourceTypeKey: "dataforrest-events-v1",
      state: "draft",
      requestLimit: 2,
    }],
    connectionRevisions: [{
      id: environment.connectionRevisionId,
      profileId: environment.profileId,
      adapterVersion: "dataforrest-events-adapter-v3",
    }],
    sources: [{
      id: sourceId,
      providerId: environment.providerId,
      profileId: environment.profileId,
      sourceTypeKey: "dataforrest-events-v1",
      state: "draft",
    }],
    sourceRevisions: [{
      sourceInstanceId: sourceId,
      adapterVersion: CLUTCHPACKS_V3_CANARY_SOURCE_PINS.adapterVersion,
      normalizedContractVersion:
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.normalizedContractVersion,
      mapperKey: CLUTCHPACKS_V3_CANARY_SOURCE_PINS.mapperKey,
      mapperVersion: CLUTCHPACKS_V3_CANARY_SOURCE_PINS.mapperVersion,
      identityNamespaceKey:
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.identityNamespaceKey,
      cursorCodecVersion:
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.cursorCodecVersion,
    }],
    cursors: [{ sourceInstanceId: sourceId, generation: 1n, fingerprint: null }],
  });
  assert.doesNotThrow(() =>
    assertClutchpacksV3CanaryTargetIsSafe(staged, environment)
  );

  for (const [snapshot, code] of [
    [{ ...staged, organizationCount: 2 }, "FRESH_TARGET_DATABASE_REQUIRED"],
    [{ ...staged, organization: {
      ...staged.organization,
      slug: "not-the-canary",
    } }, "FRESH_TARGET_DATABASE_REQUIRED"],
    [{ ...staged, providers: [
      ...staged.providers,
      {
        id: sourceOrganizationId,
        platformKey: "courtyard",
        state: "active",
        activeRevisionId: null,
        nextRunAt: null,
      },
    ] }, "TARGET_TOPOLOGY_INVALID"],
    [{ ...staged, providers: [{
      ...staged.providers[0],
      state: "disabled",
    }] }, "TARGET_TOPOLOGY_INVALID"],
    [{ ...staged, providers: [{
      ...staged.providers[0],
      activeRevisionId: sourceOrganizationId,
    }] }, "TARGET_TOPOLOGY_INVALID"],
    [{ ...staged, profiles: [{
      ...staged.profiles[0],
      requestLimit: 1,
    }] }, "TARGET_TOPOLOGY_INVALID"],
    [{ ...staged, connectionRevisions: [{
      ...staged.connectionRevisions[0],
      adapterVersion: "dataforrest-events-adapter-v1",
    }] }, "TARGET_TOPOLOGY_INVALID"],
    [{ ...staged, sourceRevisions: [{
      ...staged.sourceRevisions[0],
      adapterVersion: "dataforrest-events-adapter-v1",
    }] }, "TARGET_TOPOLOGY_INVALID"],
    [{ ...staged, sourceRevisions: [{
      ...staged.sourceRevisions[0],
      normalizedContractVersion: "packscout.provider-observation.v0",
    }] }, "TARGET_TOPOLOGY_INVALID"],
    [{ ...staged, sourceRevisions: [{
      ...staged.sourceRevisions[0],
      mapperKey: "courtyard-provider-observation",
    }] }, "TARGET_TOPOLOGY_INVALID"],
    [{ ...staged, sourceRevisions: [{
      ...staged.sourceRevisions[0],
      mapperVersion: "2",
    }] }, "TARGET_TOPOLOGY_INVALID"],
    [{ ...staged, sourceRevisions: [{
      ...staged.sourceRevisions[0],
      identityNamespaceKey: "dataforrest-clutchpacks-records-v0",
    }] }, "TARGET_TOPOLOGY_INVALID"],
    [{ ...staged, sourceRevisions: [{
      ...staged.sourceRevisions[0],
      cursorCodecVersion: "dataforrest-cursor-v0",
    }] }, "TARGET_TOPOLOGY_INVALID"],
    [{ ...staged, cursors: [{
      sourceInstanceId: sourceId,
      generation: 2n,
      fingerprint: "a".repeat(64),
    }] }, "TARGET_TOPOLOGY_INVALID"],
    [{ ...staged, importRunCount: 1 }, "TARGET_ALREADY_CONTAINS_LINEAGE"],
    [{ ...staged, importPageCount: 1 }, "TARGET_ALREADY_CONTAINS_LINEAGE"],
    [{ ...staged, canonicalEntityCount: 1 }, "TARGET_ALREADY_CONTAINS_LINEAGE"],
    [{ ...staged, legacyProviderConfigurationCount: 1 },
      "TARGET_ALREADY_CONTAINS_LINEAGE"],
    [{ ...staged, legacyProviderSecretCount: 1 },
      "TARGET_ALREADY_CONTAINS_LINEAGE"],
    [{ ...staged, legacyProviderConnectionTestCount: 1 },
      "TARGET_ALREADY_CONTAINS_LINEAGE"],
    [{ ...staged, legacyProviderCursorCount: 1 },
      "TARGET_ALREADY_CONTAINS_LINEAGE"],
  ]) {
    assert.throws(
      () => assertClutchpacksV3CanaryTargetIsSafe(snapshot, environment),
      hasCode(code),
    );
  }
});

test("safe failures and help never expose credentials or require an admin", () => {
  const failure = safeClutchpacksV3CanaryBootstrapFailure(
    new Error("source-db-secret target-db-secret bearer-secret"),
  );
  assert.deepEqual(failure, {
    ok: false,
    operation: "bootstrap_clutchpacks_v3_canary_tenant",
    code: "UNEXPECTED_BOOTSTRAP_FAILURE",
  });
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--help"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--dry-run/u);
  assert.match(result.stdout, /PACKSCOUT_CLUTCHPACKS_V1_DATABASE_URL/u);
  assert.match(result.stdout, /PACKSCOUT_DATABASE_URL/u);
  assert.match(result.stdout, /84-table active-source migration subset/u);
  assert.match(result.stdout, /91-table composite schema/u);
  assert.match(result.stdout, /does not queue tests,/u);
  assert.match(result.stdout, /call DataForrest/u);
  assert.doesNotMatch(
    result.stdout,
    /source-db-secret|target-db-secret|bearer-secret|admin|password/iu,
  );
});
