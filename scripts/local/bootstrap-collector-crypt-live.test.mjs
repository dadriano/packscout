import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CollectorCryptLiveBootstrapError,
  collectorCryptLiveHelpText,
  collectorCryptLiveSummaryJson,
  executeCollectorCryptLiveCommand,
  parseCollectorCryptLiveMode,
  readCollectorCryptLiveEnvironment,
  validateCollectorCryptDatabaseUrl,
  validateCollectorCryptBootstrapRecoveryEvidence,
  validateExistingCollectorCryptLiveConfiguration,
} from "./bootstrap-collector-crypt-live.ts";

const credentialKey = Buffer.alloc(32, 7).toString("base64");
const actorKey = Buffer.alloc(32, 9).toString("base64");
const bearerToken = "provider-bearer-secret";

function environment(overrides = {}) {
  return {
    PACKSCOUT_DATABASE_URL:
      "postgresql://lains@127.0.0.1:5432/packscout_dev",
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: credentialKey,
    PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: actorKey,
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "1",
    PACKSCOUT_COLLECTOR_CRYPT_BEARER_TOKEN: bearerToken,
    ...overrides,
  };
}

function providerSummary(state = "draft") {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    platformKey: "collector_crypt",
    displayName: "Collector Crypt",
    state,
    latestRevision: {
      id: "00000000-0000-4000-8000-000000000003",
      version: 1,
      adapterKey: "http-cursor-v2",
      endpoint: "https://198.204.245.26.sslip.io/v1/events",
      endpointHost: "198.204.245.26.sslip.io",
      authMode: "bearer",
      hasBearerSecret: true,
      scheduleSeconds: 300,
      staleAfterSeconds: 900,
      testedAt: state === "draft" ? null : "2026-08-19T00:00:00.000Z",
      createdAt: "2026-08-19T00:00:00.000Z",
      lastConnectionTest: null,
    },
    activeRevisionId:
      state === "active"
        ? "00000000-0000-4000-8000-000000000003"
        : null,
    nextRunAt: null,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}

function bootstrapRuntime(overrides = {}) {
  const calls = [];
  const runtime = {
    async prepareBootstrap() {
      calls.push("prepare");
      return { kind: "empty" };
    },
    async createOrganization() {
      calls.push("organization");
      return "00000000-0000-4000-8000-000000000001";
    },
    async createProvider(organizationId, token) {
      calls.push(["provider", organizationId, token]);
      return providerSummary();
    },
    async testConnection(organizationId, providerId, revisionId) {
      calls.push(["test", organizationId, providerId, revisionId]);
      return { verdict: "success" };
    },
    async activateProvider(organizationId, providerId, revisionId) {
      calls.push(["activate", organizationId, providerId, revisionId]);
      return providerSummary("active");
    },
    async requireExistingConfiguration() {
      calls.push("existing");
      return {
        organizationId: "00000000-0000-4000-8000-000000000001",
        providerId: "00000000-0000-4000-8000-000000000002",
        revisionId: "00000000-0000-4000-8000-000000000003",
        existingRunId: null,
      };
    },
    async requestImport(
      organizationId,
      providerId,
      revisionId,
      expectedExistingRunId,
    ) {
      calls.push([
        "request",
        organizationId,
        providerId,
        revisionId,
        expectedExistingRunId,
      ]);
      return {
        runId: "00000000-0000-4000-8000-000000000004",
        runState: "queued",
        coalesced: false,
      };
    },
    ...overrides,
  };
  return { calls, runtime };
}

function existingEvidence(overrides = {}) {
  return {
    organizationCount: 1,
    organizationId: "00000000-0000-4000-8000-000000000001",
    organizationSlug: "packscout",
    organizationName: "PackScout",
    providerCount: 1,
    providerId: "00000000-0000-4000-8000-000000000002",
    providerPlatformKey: "collector_crypt",
    providerDisplayName: "Collector Crypt",
    providerState: "active",
    activeRevisionId: "00000000-0000-4000-8000-000000000003",
    revisionCount: 1,
    revisionId: "00000000-0000-4000-8000-000000000003",
    revisionVersion: 1,
    revisionSourceMode: "http",
    revisionAdapterKey: "http-cursor-v2",
    revisionEndpoint: "https://198.204.245.26.sslip.io/v1/events",
    revisionAuthMode: "bearer",
    revisionScheduleSeconds: 300,
    revisionStaleAfterSeconds: 900,
    revisionTested: true,
    secretCount: 1,
    secretKeyVersion: 1,
    secretRetired: false,
    secretDecryptable: true,
    checkpointCount: 1,
    ...overrides,
  };
}

const draftBootstrapTables = [
  "audit_events",
  "organizations",
  "provider_config_revisions",
  "provider_secret_versions",
  "provider_sources",
];

const activeBootstrapTables = [
  "audit_events",
  "catalog_manifest_lifecycle_checkpoints",
  "organizations",
  "provider_catalog_checkpoints",
  "provider_config_revisions",
  "provider_connection_tests",
  "provider_cursor_checkpoints",
  "provider_secret_versions",
  "provider_sources",
  "public_change_catalog_impacts",
  "public_change_causes",
  "settled_public_watermarks",
];

function recoveryEvidence(overrides = {}) {
  return {
    organizationCount: 1,
    organizationId: "00000000-0000-4000-8000-000000000001",
    organizationSlug: "packscout",
    organizationName: "PackScout",
    providerCount: 1,
    providerId: "00000000-0000-4000-8000-000000000002",
    providerPlatformKey: "collector_crypt",
    providerDisplayName: "Collector Crypt",
    providerState: "draft",
    providerActiveRevisionId: null,
    providerNextRunPresent: false,
    revisionCount: 1,
    revisionId: "00000000-0000-4000-8000-000000000003",
    revisionScopeMatches: true,
    revisionCreatedActorMatches: true,
    revisionVersion: 1,
    revisionSourceMode: "http",
    revisionAdapterKey: "http-cursor-v2",
    revisionEndpoint: "https://198.204.245.26.sslip.io/v1/events",
    revisionAuthMode: "bearer",
    revisionScheduleSeconds: 300,
    revisionStaleAfterSeconds: 900,
    revisionTested: false,
    revisionTestActorMatches: false,
    secretCount: 1,
    secretScopeMatches: true,
    secretKeyVersion: 1,
    secretRetired: false,
    secretMatchesBearerToken: true,
    connectionTests: [],
    createAuditMatches: true,
    activationAuditMatches: false,
    importAuditMatches: false,
    checkpointMatches: false,
    lifecycleEvidenceMatches: false,
    importRun: null,
    nonEmptyTables: draftBootstrapTables,
    ...overrides,
  };
}

function activeRecoveryEvidence(overrides = {}) {
  return recoveryEvidence({
    providerState: "active",
    providerActiveRevisionId: "00000000-0000-4000-8000-000000000003",
    providerNextRunPresent: true,
    revisionTested: true,
    revisionTestActorMatches: true,
    connectionTests: [{
      verdict: "success",
      responseStatus: 200,
      sanitizedCode: null,
      detailsMatch: true,
      actorMatches: true,
      auditMatches: true,
    }],
    activationAuditMatches: true,
    checkpointMatches: true,
    lifecycleEvidenceMatches: true,
    nonEmptyTables: activeBootstrapTables,
    ...overrides,
  });
}

function hasCode(code) {
  return (error) => {
    assert.ok(error instanceof CollectorCryptLiveBootstrapError);
    assert.equal(error.code, code);
    return true;
  };
}

test("Collector Crypt live CLI exposes only bootstrap, resume, and request-only modes", () => {
  assert.equal(parseCollectorCryptLiveMode([]), "bootstrap");
  assert.equal(
    parseCollectorCryptLiveMode(["--resume-bootstrap"]),
    "resume-bootstrap",
  );
  assert.equal(parseCollectorCryptLiveMode(["--request-only"]), "request-only");
  for (const argumentsList of [
    ["--request-only", "extra"],
    ["--resume-bootstrap", "extra"],
    ["--provider", "collector_crypt"],
    ["request-only"],
  ]) {
    assert.throws(
      () => parseCollectorCryptLiveMode(argumentsList),
      hasCode("ARGUMENTS_INVALID"),
    );
  }
});

test("Collector Crypt live CLI accepts only the exact loopback development database", () => {
  for (const value of [
    "postgresql://lains@127.0.0.1:5432/packscout_dev",
    "postgres://lains@localhost/packscout_dev",
    "postgresql://lains@[::1]:5432/packscout_dev",
  ]) {
    assert.equal(validateCollectorCryptDatabaseUrl(value), value);
  }
  for (const value of [
    undefined,
    "postgresql://db.example/packscout_dev",
    "postgresql://lains@127.0.0.1/packscout_sample",
    "postgresql://lains@127.0.0.1:5433/packscout_dev",
    "postgresql://lains@127.0.0.1/packscout_dev?schema=other",
    "postgresql://lains@127.0.0.1/packscout_dev/",
  ]) {
    assert.throws(
      () => validateCollectorCryptDatabaseUrl(value),
      hasCode("DATABASE_TARGET_INVALID"),
    );
  }
});

test("bootstrap requires canonical runtime keys and a bounded bearer token", () => {
  const parsed = readCollectorCryptLiveEnvironment(environment(), []);
  assert.equal(parsed.mode, "bootstrap");
  assert.equal(parsed.credentialKey.byteLength, 32);
  assert.equal(parsed.actorPseudonymKey.byteLength, 32);
  assert.equal(parsed.credentialKeyVersion, 1);
  assert.equal(parsed.bearerToken, bearerToken);
  assert.equal(
    readCollectorCryptLiveEnvironment(
      environment(),
      ["--resume-bootstrap"],
    ).bearerToken,
    bearerToken,
  );

  for (const overrides of [
    { PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: "short" },
    { PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: `${actorKey}\n` },
    { PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: undefined },
    { PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "0" },
    { PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "2" },
    { PACKSCOUT_COLLECTOR_CRYPT_BEARER_TOKEN: "" },
    { PACKSCOUT_COLLECTOR_CRYPT_BEARER_TOKEN: "secret\nvalue" },
  ]) {
    assert.throws(
      () => readCollectorCryptLiveEnvironment(environment(overrides), []),
      hasCode("ENVIRONMENT_INVALID"),
    );
  }
});

test("request-only requires encryption keys but never reads the provider bearer token", () => {
  const parsed = readCollectorCryptLiveEnvironment(
    environment({ PACKSCOUT_COLLECTOR_CRYPT_BEARER_TOKEN: undefined }),
    ["--request-only"],
  );
  assert.equal(parsed.mode, "request-only");
  assert.equal(parsed.bearerToken, null);
});

test("bootstrap uses the empty database, encrypted provider workflow, and controlled queue in order", async () => {
  const { calls, runtime } = bootstrapRuntime();
  const configuration = readCollectorCryptLiveEnvironment(environment(), []);
  const summary = await executeCollectorCryptLiveCommand(configuration, runtime);

  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
    "prepare",
    "organization",
    "provider",
    "test",
    "activate",
    "request",
  ]);
  assert.equal(calls[2][2], bearerToken);
  assert.equal(summary.mode, "bootstrap");
  assert.equal(summary.providerState, "active");
  assert.equal(summary.runState, "queued");
});

test("bootstrap fails closed before activation when connection testing fails", async () => {
  const { calls, runtime } = bootstrapRuntime({
    async testConnection() {
      calls.push("test-failed");
      return { verdict: "authentication_failure" };
    },
  });
  await assert.rejects(
    executeCollectorCryptLiveCommand(
      readCollectorCryptLiveEnvironment(environment(), []),
      runtime,
    ),
    hasCode("CONNECTION_TEST_FAILED"),
  );
  assert.equal(calls.includes("activate"), false);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "request"), false);
});

test("default bootstrap recovers the exact draft left by a transient first attempt", async () => {
  const calls = [];
  let preparation = { kind: "empty" };
  let connectionAttempts = 0;
  const runtime = {
    async prepareBootstrap() {
      calls.push("prepare");
      return preparation;
    },
    async createOrganization() {
      calls.push("organization");
      return "00000000-0000-4000-8000-000000000001";
    },
    async createProvider() {
      calls.push("provider");
      preparation = {
        kind: "draft",
        organizationId: "00000000-0000-4000-8000-000000000001",
        providerId: "00000000-0000-4000-8000-000000000002",
        revisionId: "00000000-0000-4000-8000-000000000003",
        connectionAlreadyTested: false,
      };
      return providerSummary();
    },
    async testConnection() {
      calls.push("test");
      connectionAttempts += 1;
      return {
        verdict: connectionAttempts === 1 ? "timeout" : "success",
      };
    },
    async activateProvider() {
      calls.push("activate");
      preparation = {
        kind: "active",
        organizationId: "00000000-0000-4000-8000-000000000001",
        providerId: "00000000-0000-4000-8000-000000000002",
        revisionId: "00000000-0000-4000-8000-000000000003",
        existingRunId: null,
      };
      return providerSummary("active");
    },
    async requireExistingConfiguration() {
      throw new Error("not used");
    },
    async requestImport() {
      calls.push("request");
      return {
        runId: "00000000-0000-4000-8000-000000000004",
        runState: "queued",
        coalesced: false,
      };
    },
  };

  await assert.rejects(
    executeCollectorCryptLiveCommand(
      readCollectorCryptLiveEnvironment(environment(), []),
      runtime,
    ),
    hasCode("CONNECTION_TEST_FAILED"),
  );
  const recovered = await executeCollectorCryptLiveCommand(
    readCollectorCryptLiveEnvironment(environment(), []),
    runtime,
  );

  assert.deepEqual(calls, [
    "prepare",
    "organization",
    "provider",
    "test",
    "prepare",
    "test",
    "activate",
    "request",
  ]);
  assert.equal(recovered.bootstrapDisposition, "recovered");
  assert.equal(recovered.importExecution, "queued-only");
});

test("resume rejects a different bearer token before any mutation", async () => {
  const { calls, runtime } = bootstrapRuntime({
    async prepareBootstrap() {
      calls.push("prepare-token-check");
      return validateCollectorCryptBootstrapRecoveryEvidence(
        recoveryEvidence({ secretMatchesBearerToken: false }),
        1,
      );
    },
  });

  await assert.rejects(
    executeCollectorCryptLiveCommand(
      readCollectorCryptLiveEnvironment(environment(), ["--resume-bootstrap"]),
      runtime,
    ),
    hasCode("CONFIGURATION_MISMATCH"),
  );
  assert.deepEqual(calls, ["prepare-token-check"]);
});

test("completed bootstrap recovery is idempotent and only coalesces its queued run", async () => {
  const { calls, runtime } = bootstrapRuntime({
    async prepareBootstrap() {
      calls.push("prepare-active");
      return {
        kind: "active",
        organizationId: "00000000-0000-4000-8000-000000000001",
        providerId: "00000000-0000-4000-8000-000000000002",
        revisionId: "00000000-0000-4000-8000-000000000003",
        existingRunId: "00000000-0000-4000-8000-000000000004",
      };
    },
    async requestImport(
      organizationId,
      providerId,
      revisionId,
      expectedExistingRunId,
    ) {
      calls.push([
        "request",
        organizationId,
        providerId,
        revisionId,
        expectedExistingRunId,
      ]);
      return {
        runId: "00000000-0000-4000-8000-000000000004",
        runState: "queued",
        coalesced: true,
      };
    },
  });

  const summary = await executeCollectorCryptLiveCommand(
    readCollectorCryptLiveEnvironment(environment(), ["--resume-bootstrap"]),
    runtime,
  );
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
    "prepare-active",
    "request",
  ]);
  assert.equal(summary.bootstrapDisposition, "already-ready");
  assert.equal(summary.coalesced, true);
  assert.equal(
    calls[1][4],
    "00000000-0000-4000-8000-000000000004",
  );
});

test("completed recovery fails closed if its exact queued run terminalizes before reuse", async () => {
  const runId = "00000000-0000-4000-8000-000000000004";
  let createdRuns = 0;
  const { calls, runtime } = bootstrapRuntime({
    async prepareBootstrap() {
      calls.push("prepare-active");
      return {
        kind: "active",
        organizationId: "00000000-0000-4000-8000-000000000001",
        providerId: "00000000-0000-4000-8000-000000000002",
        revisionId: "00000000-0000-4000-8000-000000000003",
        existingRunId: runId,
      };
    },
    async requestImport(_organizationId, _providerId, _revisionId, expectedRunId) {
      calls.push(["revalidate-run", expectedRunId]);
      assert.equal(expectedRunId, runId);
      throw new CollectorCryptLiveBootstrapError("CONFIGURATION_MISMATCH");
    },
    async createProvider() {
      createdRuns += 1;
      return providerSummary();
    },
  });

  await assert.rejects(
    executeCollectorCryptLiveCommand(
      readCollectorCryptLiveEnvironment(environment(), ["--resume-bootstrap"]),
      runtime,
    ),
    hasCode("CONFIGURATION_MISMATCH"),
  );
  assert.deepEqual(calls, ["prepare-active", ["revalidate-run", runId]]);
  assert.equal(createdRuns, 0);
});

test("request-only validates the exact existing revision and never rewrites configuration", async () => {
  const { calls, runtime } = bootstrapRuntime({
    async requestImport(organizationId, providerId, revisionId) {
      calls.push(["request", organizationId, providerId, revisionId]);
      return {
        runId: "00000000-0000-4000-8000-000000000004",
        runState: "running",
        coalesced: true,
      };
    },
  });
  const summary = await executeCollectorCryptLiveCommand(
    readCollectorCryptLiveEnvironment(environment(), ["--request-only"]),
    runtime,
  );
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), [
    "existing",
    "request",
  ]);
  assert.equal(summary.mode, "request-only");
  assert.equal(summary.runState, "running");
  assert.equal(summary.coalesced, true);
});

test("request-only rejects every material Collector Crypt configuration drift", () => {
  assert.deepEqual(validateExistingCollectorCryptLiveConfiguration(existingEvidence(), 1), {
    organizationId: "00000000-0000-4000-8000-000000000001",
    providerId: "00000000-0000-4000-8000-000000000002",
    revisionId: "00000000-0000-4000-8000-000000000003",
  });
  for (const override of [
    { organizationCount: 2 },
    { organizationSlug: "another-organization" },
    { organizationName: "Another Organization" },
    { providerCount: 2 },
    { providerPlatformKey: "courtyard" },
    { providerDisplayName: "Collector Crypt Staging" },
    { providerState: "disabled" },
    { activeRevisionId: null },
    { revisionCount: 2 },
    { revisionVersion: 2 },
    { revisionSourceMode: "archive" },
    { revisionAdapterKey: "provider-archive-v2" },
    { revisionEndpoint: "https://example.invalid/v1/events" },
    { revisionAuthMode: "none" },
    { revisionScheduleSeconds: 60 },
    { revisionStaleAfterSeconds: 600 },
    { revisionTested: false },
    { secretCount: 0 },
    { secretKeyVersion: 2 },
    { secretRetired: true },
    { secretDecryptable: false },
    { checkpointCount: 0 },
  ]) {
    assert.throws(
      () => validateExistingCollectorCryptLiveConfiguration(
        existingEvidence(override),
        1,
      ),
      hasCode("CONFIGURATION_MISMATCH"),
    );
  }
});

test("bootstrap recovery accepts only exact retryable or completed states", () => {
  assert.deepEqual(
    validateCollectorCryptBootstrapRecoveryEvidence(recoveryEvidence(), 1),
    {
      kind: "draft",
      organizationId: "00000000-0000-4000-8000-000000000001",
      providerId: "00000000-0000-4000-8000-000000000002",
      revisionId: "00000000-0000-4000-8000-000000000003",
      connectionAlreadyTested: false,
    },
  );
  assert.deepEqual(
    validateCollectorCryptBootstrapRecoveryEvidence(
      recoveryEvidence({
        connectionTests: [{
          verdict: "timeout",
          responseStatus: null,
          sanitizedCode: "timeout",
          detailsMatch: true,
          actorMatches: true,
          auditMatches: true,
        }],
        nonEmptyTables: [
          ...draftBootstrapTables,
          "provider_connection_tests",
        ],
      }),
      1,
    ).kind,
    "draft",
  );
  const transientConnection = Object.freeze({
    verdict: "timeout",
    responseStatus: null,
    sanitizedCode: "timeout",
    detailsMatch: true,
    actorMatches: true,
    auditMatches: true,
  });
  assert.equal(
    validateCollectorCryptBootstrapRecoveryEvidence(
      recoveryEvidence({
        connectionTests: Array.from({ length: 7 }, () => transientConnection),
        nonEmptyTables: [
          ...draftBootstrapTables,
          "provider_connection_tests",
        ],
      }),
      1,
    ).kind,
    "draft",
  );
  assert.throws(
    () => validateCollectorCryptBootstrapRecoveryEvidence(
      recoveryEvidence({
        connectionTests: Array.from({ length: 8 }, () => transientConnection),
        nonEmptyTables: [
          ...draftBootstrapTables,
          "provider_connection_tests",
        ],
      }),
      1,
    ),
    hasCode("CONFIGURATION_MISMATCH"),
  );
  assert.deepEqual(
    validateCollectorCryptBootstrapRecoveryEvidence(activeRecoveryEvidence(), 1),
    {
      kind: "active",
      organizationId: "00000000-0000-4000-8000-000000000001",
      providerId: "00000000-0000-4000-8000-000000000002",
      revisionId: "00000000-0000-4000-8000-000000000003",
      existingRunId: null,
    },
  );
  assert.equal(
    validateCollectorCryptBootstrapRecoveryEvidence(
      activeRecoveryEvidence({
        importRun: {
          id: "00000000-0000-4000-8000-000000000004",
          exactQueuedControlledRun: true,
        },
        importAuditMatches: true,
        nonEmptyTables: [...activeBootstrapTables, "import_runs"],
      }),
      1,
    ).kind,
    "active",
  );

  const invalidStates = [
    recoveryEvidence({ organizationCount: 2 }),
    recoveryEvidence({ providerPlatformKey: "courtyard" }),
    recoveryEvidence({ revisionAdapterKey: "provider-archive-v2" }),
    recoveryEvidence({
      revisionEndpoint: "https://example.invalid/v1/events",
    }),
    recoveryEvidence({ revisionVersion: 2 }),
    recoveryEvidence({ secretKeyVersion: 2 }),
    recoveryEvidence({ secretScopeMatches: false }),
    recoveryEvidence({ secretMatchesBearerToken: false }),
    recoveryEvidence({ createAuditMatches: false }),
    recoveryEvidence({
      nonEmptyTables: [...draftBootstrapTables, "source_records"],
    }),
    recoveryEvidence({
      connectionTests: [{
        verdict: "authentication_failure",
        responseStatus: 401,
        sanitizedCode: "http_error",
        detailsMatch: true,
        actorMatches: true,
        auditMatches: true,
      }],
      nonEmptyTables: [
        ...draftBootstrapTables,
        "provider_connection_tests",
      ],
    }),
    activeRecoveryEvidence({
      providerActiveRevisionId: "00000000-0000-4000-8000-000000000099",
    }),
    activeRecoveryEvidence({ activationAuditMatches: false }),
    activeRecoveryEvidence({ lifecycleEvidenceMatches: false }),
    activeRecoveryEvidence({
      importRun: {
        id: "00000000-0000-4000-8000-000000000004",
        exactQueuedControlledRun: true,
      },
      importAuditMatches: false,
      nonEmptyTables: [...activeBootstrapTables, "import_runs"],
    }),
    activeRecoveryEvidence({
      importRun: {
        id: "00000000-0000-4000-8000-000000000004",
        exactQueuedControlledRun: false,
      },
      importAuditMatches: true,
      nonEmptyTables: [...activeBootstrapTables, "import_runs"],
    }),
  ];
  for (const evidence of invalidStates) {
    assert.throws(
      () => validateCollectorCryptBootstrapRecoveryEvidence(evidence, 1),
      hasCode("CONFIGURATION_MISMATCH"),
    );
  }
});

test("bootstrap help makes bounded batch execution an explicit separate step", () => {
  const help = collectorCryptLiveHelpText();
  assert.match(help, /does not execute or supervise provider pages/);
  assert.match(help, /npm run import:collector-crypt-live-batch:local/);
  assert.doesNotMatch(help, new RegExp(bearerToken));

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./bootstrap-collector-crypt-live.ts", import.meta.url)),
      "--help",
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, help);

  const resumeHelp = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./bootstrap-collector-crypt-live.ts", import.meta.url)),
      "--resume-bootstrap",
      "--help",
    ],
    { encoding: "utf8", env: process.env },
  );
  assert.equal(resumeHelp.status, 0);
  assert.equal(resumeHelp.stderr, "");
  assert.equal(resumeHelp.stdout, help);
});

test("success output is a strict sanitized summary", async () => {
  const { runtime } = bootstrapRuntime();
  const summary = await executeCollectorCryptLiveCommand(
    readCollectorCryptLiveEnvironment(environment(), []),
    runtime,
  );
  const json = collectorCryptLiveSummaryJson(summary);
  assert.deepEqual(Object.keys(JSON.parse(json)), [
    "mode",
    "bootstrapDisposition",
    "organizationId",
    "providerId",
    "configurationRevisionId",
    "providerState",
    "runId",
    "runState",
    "coalesced",
    "importExecution",
    "nextCommand",
  ]);
  assert.equal(JSON.parse(json).importExecution, "queued-only");
  assert.equal(
    JSON.parse(json).nextCommand,
    "npm run import:collector-crypt-live-batch:local",
  );
  assert.doesNotMatch(json, new RegExp(bearerToken));
  assert.doesNotMatch(json, new RegExp(credentialKey));
  assert.doesNotMatch(json, new RegExp(actorKey));
});

test("CLI failures expose no configured credential material", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./bootstrap-collector-crypt-live.ts", import.meta.url)),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...environment({
          PACKSCOUT_DATABASE_URL:
            "postgresql://sensitive-user:sensitive-password@db.example/packscout_dev",
        }),
      },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Collector Crypt live bootstrap failed.\n");
  for (const secret of [
    bearerToken,
    credentialKey,
    actorKey,
    "sensitive-user",
    "sensitive-password",
  ]) {
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
  }
});
