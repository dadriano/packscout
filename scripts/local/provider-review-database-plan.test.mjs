import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const planModule = await tsImport(
  "./provider-review-database-plan.mts",
  import.meta.url,
);
const registrationModule = await tsImport(
  "./provider-review-central-registration.mts",
  import.meta.url,
);
const verificationModule = await tsImport(
  "./provider-review-database-verification.mts",
  import.meta.url,
);
const sourceLiveCheckModule = await tsImport(
  "./provider-review-source-live-check.mts",
  import.meta.url,
);
const clusterRuntimeModule = await tsImport(
  "./clutchpacks-review-cluster-runtime.mts",
  import.meta.url,
);
const contracts = await tsImport("@packscout/contracts", import.meta.url);

const {
  ADDITIONAL_PROVIDER_REVIEW_DATABASES,
  ALL_PROVIDER_REVIEW_DATABASES,
  DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_KEY,
  PROVIDER_REVIEW_ENVIRONMENT_KEYS,
  assertAdditionalProviderDescriptors,
  assertAdditionalProviderRuntimeSelection,
  assertDistinctProviderReviewClusterProofs,
  buildAdditionalProviderProvisionPlan,
  buildSanitizedProviderReviewIsolationProof,
  readProviderReviewProvisionEnvironment,
  safeProviderReviewProvisionFailure,
} = planModule;
const {
  classifyProviderReviewRegistration,
  createProviderReviewRegistrationIds,
} = registrationModule;
const { assertFreshProviderSeedSnapshot } = verificationModule;
const { runBoundedProviderReviewSourceLiveCheck } = sourceLiveCheckModule;
const { assertConnectedClusterProofAdmission } = clusterRuntimeModule;

const secrets = Object.freeze({
  centralApp: "control-app-password-unique-100",
  clutchpacksApp: "clutchpacks-app-password-unique-200",
  courtyardAdmin: "courtyard-admin-password-unique-300",
  courtyardApp: "courtyard-app-password-unique-400",
  collectorAdmin: "collector-admin-password-unique-500",
  collectorApp: "collector-app-password-unique-600",
  phygitalsAdmin: "phygitals-admin-password-unique-700",
  phygitalsApp: "phygitals-app-password-unique-800",
  cipherKey: Buffer.alloc(32, 19).toString("base64"),
});

function descriptor(providerKey) {
  return ADDITIONAL_PROVIDER_REVIEW_DATABASES.find(
    (provider) => provider.providerKey === providerKey,
  );
}

function provisionEnvironment() {
  const values = {
    NODE_ENV: "development",
    [PROVIDER_REVIEW_ENVIRONMENT_KEYS.action]: "provision",
    [PROVIDER_REVIEW_ENVIRONMENT_KEYS.target]: "all",
    [PROVIDER_REVIEW_ENVIRONMENT_KEYS.centralAppPassword]: secrets.centralApp,
    [PROVIDER_REVIEW_ENVIRONMENT_KEYS.clutchpacksAppPassword]:
      secrets.clutchpacksApp,
    [PROVIDER_REVIEW_ENVIRONMENT_KEYS.adminEmail]: "Admin@Example.test",
    [PROVIDER_REVIEW_ENVIRONMENT_KEYS.credentialKey]: secrets.cipherKey,
    [PROVIDER_REVIEW_ENVIRONMENT_KEYS.credentialKeyVersion]: "1",
  };
  const passwords = {
    courtyard: [secrets.courtyardAdmin, secrets.courtyardApp],
    collector_crypt: [secrets.collectorAdmin, secrets.collectorApp],
    phygitals: [secrets.phygitalsAdmin, secrets.phygitalsApp],
  };
  for (const provider of ADDITIONAL_PROVIDER_REVIEW_DATABASES) {
    const [adminPassword, appPassword] = passwords[provider.providerKey];
    values[provider.environmentKeys.clusterAdminPassword] = adminPassword;
    values[provider.environmentKeys.appPassword] = appPassword;
  }
  return values;
}

function hasCode(code) {
  return (error) => error instanceof Error && error.code === code;
}

test("three typed descriptors pin isolated PG16 provider targets", () => {
  const expectedRoot = path.join(
    os.homedir(),
    "Library/Application Support/PackScout/postgres-review",
  );
  assert.deepEqual(
    ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider) => ({
      key: provider.providerKey,
      port: provider.port,
      database: provider.databaseName,
      dataDirectory: provider.dataDirectory,
      adapterKey: provider.adapterKey,
      sourceConfiguration: provider.sourceConfiguration,
    })),
    [
      {
        key: "courtyard",
        port: 55_433,
        database: "packscout_courtyard",
        dataDirectory: path.join(expectedRoot, "courtyard"),
        adapterKey: "dataforrest-launch-distributed-adapter-v1",
        sourceConfiguration: { platform: "courtyard" },
      },
      {
        key: "collector_crypt",
        port: 55_434,
        database: "packscout_collector_crypt",
        dataDirectory: path.join(expectedRoot, "collector_crypt"),
        adapterKey: "dataforrest-launch-distributed-adapter-v1",
        sourceConfiguration: { platform: "collector_crypt" },
      },
      {
        key: "phygitals",
        port: 55_435,
        database: "packscout_phygitals",
        dataDirectory: path.join(expectedRoot, "phygitals"),
        adapterKey: "dataforrest-launch-distributed-adapter-v1",
        sourceConfiguration: { platform: "phygitals" },
      },
    ],
  );
  assert.equal(
    DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_KEY,
    "dataforrest-launch-distributed-adapter-v1",
  );
  assert.ok(ADDITIONAL_PROVIDER_REVIEW_DATABASES.every(
    (provider) => provider.endpointUrl === contracts.DATAFORREST_EVENTS_V1_ENDPOINT,
  ));
  assert.deepEqual(
    ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider) => ({
      providerKey: provider.providerKey,
      executionCapability: provider.executionCapability,
      connectionTestKind: provider.connectionTestKind,
      clonesSourceCredentialFrom:
        provider.cloneExistingSourceCredentialFromProviderKey,
    })),
    [
      { providerKey: "courtyard", executionCapability: "installed",
        connectionTestKind: "activation",
        clonesSourceCredentialFrom: "clutchpacks" },
      { providerKey: "collector_crypt", executionCapability: "uninstalled",
        connectionTestKind: "database",
        clonesSourceCredentialFrom: null },
      { providerKey: "phygitals", executionCapability: "uninstalled",
        connectionTestKind: "database",
        clonesSourceCredentialFrom: null },
    ],
  );
  assert.doesNotThrow(() =>
    assertAdditionalProviderDescriptors(ADDITIONAL_PROVIDER_REVIEW_DATABASES)
  );
  assert.throws(
    () => assertAdditionalProviderDescriptors([
      ...ADDITIONAL_PROVIDER_REVIEW_DATABASES.slice(0, 2),
      { ...descriptor("phygitals"), port: 55_434 },
    ]),
    hasCode("PROVIDER_DESCRIPTOR_COLLISION"),
  );
});

test("provision inputs are process-only, distinct, and descriptor-owned", () => {
  const environment = provisionEnvironment();
  const parsed = readProviderReviewProvisionEnvironment(environment);
  assert.equal(parsed.action, "provision");
  assert.equal(parsed.selected.length, 3);
  assert.equal(parsed.adminEmail, "admin@example.test");
  assert.equal(parsed.credentialKey.bytes.byteLength, 32);

  const duplicate = provisionEnvironment();
  duplicate[descriptor("phygitals").environmentKeys.appPassword] =
    secrets.centralApp;
  assert.throws(
    () => readProviderReviewProvisionEnvironment(duplicate),
    hasCode("CLUSTER_CREDENTIALS_NOT_DISTINCT"),
  );
  assert.equal("PACKSCOUT_DATA_API_TOKEN" in provisionEnvironment(), false);
});

test("inspect and lifecycle actions select fixed targets without DSNs", () => {
  const inspected = readProviderReviewProvisionEnvironment({
    NODE_ENV: "development",
  });
  assert.equal(inspected.action, "inspect");
  assert.deepEqual(
    inspected.selected.map(({ providerKey }) => providerKey),
    ["courtyard", "collector_crypt", "phygitals"],
  );
  const courtyard = descriptor("courtyard");
  assert.deepEqual(
    readProviderReviewProvisionEnvironment({
      NODE_ENV: "development",
      [PROVIDER_REVIEW_ENVIRONMENT_KEYS.action]: "start",
      [PROVIDER_REVIEW_ENVIRONMENT_KEYS.target]: "courtyard",
      [courtyard.environmentKeys.appPassword]: secrets.courtyardApp,
    }).selected,
    [courtyard],
  );
  assert.throws(
    () => readProviderReviewProvisionEnvironment({
      NODE_ENV: "development",
      [PROVIDER_REVIEW_ENVIRONMENT_KEYS.action]: "stop",
      [PROVIDER_REVIEW_ENVIRONMENT_KEYS.target]: "all",
    }),
    hasCode("CLUSTER_LIFECYCLE_TARGET_MUST_BE_INDIVIDUAL"),
  );
  for (const key of [
    "PACKSCOUT_LOCAL_REVIEW_CLUSTER_ROOT",
    "PACKSCOUT_LOCAL_COURTYARD_PORT",
    "PACKSCOUT_LOCAL_COLLECTOR_CRYPT_DATA_DIRECTORY",
    "PACKSCOUT_LOCAL_PHYGITALS_DATABASE_NAME",
  ]) {
    assert.throws(
      () => readProviderReviewProvisionEnvironment({
        NODE_ENV: "development",
        [key]: "browser-selected-target",
      }),
      hasCode("CLUSTER_REDIRECT_FORBIDDEN"),
    );
  }
});

test("five-cluster isolation proof rejects every identity collision", () => {
  const proofs = ALL_PROVIDER_REVIEW_DATABASES.map((cluster, index) => ({
    ...cluster,
    systemIdentifier: String(7_532_189_705_087_112_001n + BigInt(index)),
  }));
  assert.doesNotThrow(() => assertDistinctProviderReviewClusterProofs(proofs));
  for (const field of ["port", "dataDirectory", "systemIdentifier"]) {
    const drift = proofs.map((proof) => ({ ...proof }));
    drift[4][field] = drift[3][field];
    assert.throws(
      () => assertDistinctProviderReviewClusterProofs(drift),
      hasCode("CLUSTER_ISOLATION_PROOF_FAILED"),
    );
  }
});

test("sanitized proof exposes distinct provider-local topology and state ownership", () => {
  const providerDatabases = ALL_PROVIDER_REVIEW_DATABASES.filter(
    (cluster) => cluster.clusterKey !== "control",
  );
  const inputs = providerDatabases.map((cluster, index) => ({
    providerKey: cluster.clusterKey,
    providerId: `2000000${index}-0000-5000-8000-000000000001`,
    dataDirectory: cluster.dataDirectory,
    databaseName: cluster.databaseName,
    port: cluster.port,
    schemaVersion: "distributed-provider-v1",
    systemIdentifier: String(7_532_189_705_087_113_001n + BigInt(index)),
    databaseNodeId: `3000000${index}-0000-5000-8000-000000000001`,
    databaseCredentialVersionId:
      `4000000${index}-0000-5000-8000-000000000001`,
  }));
  const proof = buildSanitizedProviderReviewIsolationProof(inputs);
  assert.deepEqual(proof.map((fact) => fact.providerKey), [
    "clutchpacks",
    "courtyard",
    "collector_crypt",
    "phygitals",
  ]);
  assert.ok(proof.every((fact) =>
    fact.stateOwnership.databaseName === fact.databaseName &&
    fact.stateOwnership.runtimeTable === "provider_runtime" &&
    fact.stateOwnership.leaseTable === "provider_worker_states" &&
    fact.stateOwnership.commandTable === "control_commands" &&
    fact.stateOwnership.cursorTable === "provider_runtime" &&
    /^[0-9a-f]{64}$/u.test(fact.dataDirectoryHash) &&
    !("dataDirectory" in fact)
  ));
  for (const field of [
    "providerId",
    "databaseNodeId",
    "databaseCredentialVersionId",
  ]) {
    const drift = inputs.map((input) => ({ ...input }));
    drift[3][field] = drift[2][field];
    assert.throws(
      () => buildSanitizedProviderReviewIsolationProof(drift),
      hasCode("PROVIDER_ISOLATION_PROOF_FAILED"),
    );
  }
});

test("runtime selection leaves every database reachable while only Courtyard has execution capability", () => {
  const expected = [
    { providerKey: "courtyard", running: true },
    { providerKey: "collector_crypt", running: true },
    { providerKey: "phygitals", running: true },
  ];
  assert.doesNotThrow(() => assertAdditionalProviderRuntimeSelection(expected));
  for (const providerKey of ["courtyard", "collector_crypt", "phygitals"]) {
    assert.throws(
      () => assertAdditionalProviderRuntimeSelection(expected.map((fact) =>
        fact.providerKey === providerKey
          ? { ...fact, running: !fact.running }
          : fact
      )),
      hasCode("PROVIDER_RUNTIME_SELECTION_FAILED"),
    );
  }
});

test("fresh-cluster orchestration proves initialized clusters before atomic registration and only then promotes markers", () => {
  assert.doesNotThrow(() => assertConnectedClusterProofAdmission({
    admission: "provisioning",
    markerState: "initialized",
    running: true,
  }));
  assert.doesNotThrow(() => assertConnectedClusterProofAdmission({
    admission: "provisioning",
    markerState: "provisioned",
    running: true,
  }));
  assert.doesNotThrow(() => assertConnectedClusterProofAdmission({
    admission: "runtime",
    markerState: "provisioned",
    running: true,
  }));
  for (const rejected of [
    { admission: "runtime", markerState: "initialized", running: true },
    { admission: "runtime", markerState: null, running: true },
    { admission: "provisioning", markerState: null, running: true },
    { admission: "provisioning", markerState: "initialized", running: false },
  ]) {
    assert.throws(
      () => assertConnectedClusterProofAdmission(rejected),
      (error) => error?.code === "CLUSTER_NOT_READY",
    );
  }

  const executor = readFileSync(fileURLToPath(new URL(
    "./provision-provider-review-databases.mts",
    import.meta.url,
  )), "utf8");
  const proofStart = executor.indexOf("const additionalProofs =");
  const provisioningProof = executor.indexOf(
    "readProvisioningConnectedClusterProof({",
    proofStart,
  );
  const freshDatabaseProof = executor.indexOf(
    "verifyFreshProviderReviewDatabase({",
    provisioningProof,
  );
  const atomicCentralRegistration = executor.indexOf(
    "registerProviderReviewMetadataBatch({",
    freshDatabaseProof,
  );
  const markerPromotion = executor.indexOf(
    "markFixedClusterProvisioned(provider)",
    atomicCentralRegistration,
  );
  assert.ok(proofStart >= 0);
  assert.ok(provisioningProof > proofStart);
  assert.ok(freshDatabaseProof > provisioningProof);
  assert.ok(atomicCentralRegistration > freshDatabaseProof);
  assert.ok(markerPromotion > atomicCentralRegistration);
});

test("Courtyard activation performs one bounded authenticated source check", async () => {
  const token = "source-token-held-only-in-test-memory";
  const body = new TextEncoder().encode(JSON.stringify({
    records: [{
      platform: "courtyard",
      record_id: "pack-1",
      occurred_at: "2026-08-29T12:00:00.000Z",
      collected_at: "2026-08-29T12:00:01.000Z",
      data: {},
      stream: "catalog",
      entity: "pack",
      first_seen_at: "2026-08-29T12:00:00.000Z",
      available: true,
    }],
    next_cursor: "source-checkpoint",
    poll_after_seconds: 0,
  }));
  let request;
  const result = await runBoundedProviderReviewSourceLiveCheck({
    providerKey: "courtyard",
    token,
    captureResponse: async (input) => {
      request = input;
      return {
        status: 200,
        protectedBody: body,
        durationMilliseconds: 17,
        responseBytes: body.byteLength,
      };
    },
  });
  assert.equal(request.url.searchParams.get("platform"), "courtyard");
  assert.equal(request.url.searchParams.get("limit"), "1");
  assert.equal(request.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(result, {
    durationMilliseconds: 17,
    recordCount: 1,
    responseBytes: result.responseBytes,
    responseStatus: 200,
  });
  assert.ok(body.every((byte) => byte === 0));
});

test("central registration is all-or-none per provider and IDs are stable", () => {
  assert.equal(classifyProviderReviewRegistration({
    counts: Array(9).fill(0),
    sourceCredentialExpected: true,
    databaseOnlyActivationExpected: false,
  }), "absent");
  assert.equal(classifyProviderReviewRegistration({
    counts: [1, 1, 1, 1, 1, 1, 1, 0, 1],
    sourceCredentialExpected: true,
    databaseOnlyActivationExpected: false,
  }), "present");
  assert.equal(classifyProviderReviewRegistration({
    counts: [1, 1, 1, 1, 0, 1, 1, 1, 1],
    sourceCredentialExpected: false,
    databaseOnlyActivationExpected: true,
  }), "present");
  for (const invalid of [
    {
      counts: [1, 0, 0, 0, 0, 0, 0, 0, 0],
      sourceCredentialExpected: true,
      databaseOnlyActivationExpected: false,
    },
    {
      counts: [1, 1, 1, 1, 0, 1, 1, 0, 1],
      sourceCredentialExpected: false,
      databaseOnlyActivationExpected: true,
    },
    {
      counts: [1, 1, 1, 1, 1, 1, 1, 1, 1],
      sourceCredentialExpected: true,
      databaseOnlyActivationExpected: false,
    },
    {
      counts: [1, 1, 1, 1, 2, 1, 1, 0, 1],
      sourceCredentialExpected: true,
      databaseOnlyActivationExpected: false,
    },
  ]) {
    assert.throws(
      () => classifyProviderReviewRegistration(invalid),
      hasCode("CENTRAL_REGISTRATION_STATE_UNEXPECTED"),
    );
  }
  const input = {
    centralSystemIdentifier: "7532189705087112001",
    providerSystemIdentifier: "7532189705087112003",
    providerKey: "courtyard",
  };
  assert.deepEqual(
    createProviderReviewRegistrationIds(input),
    createProviderReviewRegistrationIds(input),
  );
  assert.notDeepEqual(
    createProviderReviewRegistrationIds(input),
    createProviderReviewRegistrationIds({
      ...input,
      providerKey: "phygitals",
    }),
  );
});

test("provision plan is additive and contains no destructive stage", () => {
  const identities = Object.fromEntries(
    ADDITIONAL_PROVIDER_REVIEW_DATABASES.map((provider, providerIndex) => {
      const ids = Object.fromEntries(
        ["providerId", "profileId", "configId"].map((name, idIndex) => [
          name,
          `1000000${providerIndex}-0000-5000-8000-00000000000${idIndex}`,
        ]),
      );
      return [provider.providerKey, ids];
    }),
  );
  const plan = buildAdditionalProviderProvisionPlan(identities);
  assert.equal(
    plan.stages[0],
    "verify_existing_control_and_clutchpacks_read_only",
  );
  assert.match(
    plan.stages.join(" "),
    /zero_runs_commands_cursors_and_canonical_mutations/u,
  );
  assert.match(
    plan.stages.join(" "),
    /keep_all_provider_databases_reachable_and_only_run_installed_courtyard/u,
  );
  assert.ok(
    plan.stages.indexOf(
      "verify_zero_runs_commands_cursors_and_canonical_mutations",
    ) < plan.stages.indexOf(
      "register_provider_profile_config_credentials_node_tests_and_audit",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(plan),
    /drop|rebuild|reset|recreate|truncate|delete/iu,
  );
});

test("fresh provider proof requires idle and completely empty work state", () => {
  const provider = descriptor("collector_crypt");
  const providerId = "10000000-0000-5000-8000-000000000001";
  const snapshot = {
    providerId,
    providerKey: provider.providerKey,
    databaseRole: "provider",
    schemaVersion: "distributed-provider-v1",
    operatingState: "idle",
    stateGeneration: "0",
    cachedConfigCount: 0,
    cursorCount: 0,
    nextDueCount: 0,
    runtimeFailureCount: 0,
    leasedWorkerCount: 0,
    workerRoles: ["import", "promotion"],
    promotionSequence: "0",
    canonicalCount: "0",
    commandCount: "0",
    runCount: "0",
    runPageCount: "0",
    quarantineCount: "0",
  };
  assert.doesNotThrow(() => assertFreshProviderSeedSnapshot({
    snapshot,
    descriptor: provider,
    providerId,
  }));
  for (const drift of [
    { ...snapshot, operatingState: "running" },
    { ...snapshot, runCount: "1" },
    { ...snapshot, cursorCount: 1 },
    { ...snapshot, canonicalCount: "1" },
  ]) {
    assert.throws(
      () => assertFreshProviderSeedSnapshot({
        snapshot: drift,
        descriptor: provider,
        providerId,
      }),
      hasCode("PROVIDER_FRESH_SEED_PROOF_FAILED"),
    );
  }
});

test("executor registers central authority and never writes provider DSNs to env", () => {
  const files = [
    "./provider-review-database-plan.mts",
    "./provider-review-central-registration.mts",
    "./provider-review-database-verification.mts",
    "./provider-review-source-live-check.mts",
    "./provision-provider-review-databases.mts",
  ].map((relative) => readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  ));
  const [plan, registration, verification, sourceLiveCheck, executor] = files;
  assert.match(registration, /provider_public_profile_versions/u);
  assert.match(registration, /provider_config_versions/u);
  assert.match(registration, /provider_credential_versions/u);
  assert.match(registration, /provider_database_nodes/u);
  assert.match(registration, /provider_connection_tests/u);
  assert.match(registration, /audit_events/u);
  assert.match(executor, /migrateReviewDatabase/u);
  assert.match(executor, /initializeReviewProviderIdentity/u);
  assert.match(executor, /verifyFreshProviderReviewDatabase/u);
  assert.match(executor, /existingClustersMutated: false/u);
  assert.match(registration, /readSourceCredentialClone/u);
  assert.match(registration, /runBoundedProviderReviewSourceLiveCheck/u);
  assert.match(registration, /config\.adapter_key = \$2/u);
  assert.match(registration, /config\.expires_at is null/u);
  assert.match(registration, /sourceCredentialPlaintext = null/u);
  assert.match(executor, /sanitizeConnectedClusterProof/u);
  assert.match(executor, /sanitizeFilesystemProof/u);
  assert.doesNotMatch(executor, /clusters:\s*additionalProofs[,\n]/u);
  assert.doesNotMatch(
    `${plan}\n${registration}\n${verification}\n${sourceLiveCheck}\n${executor}`,
    /dotenv|writeFile|appendFile|PACKSCOUT_(?:COURTYARD|COLLECTOR_CRYPT|PHYGITALS)_DATABASE_URL/u);
  assert.doesNotMatch(`${registration}\n${executor}`,
    /drop database|drop role|truncate table|delete from|rebuild|reset/iu);
  assert.doesNotMatch(executor, /providerKey\s*===\s*["'](?:courtyard|collector_crypt|phygitals)/u);
});

test("package scripts expose additive and independent lifecycle commands", () => {
  const packageDocument = JSON.parse(readFileSync(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
    "utf8",
  ));
  assert.equal(
    typeof packageDocument.scripts["db:provision:additional-providers-review:local"],
    "string",
  );
  for (const cluster of [
    "packscout-courtyard",
    "packscout-collector-crypt",
    "packscout-phygitals",
  ]) {
    for (const action of ["inspect", "start", "stop"]) {
      assert.equal(
        typeof packageDocument.scripts[`db:${action}:${cluster}:local`],
        "string",
      );
    }
  }
  assert.doesNotMatch(
    JSON.stringify(packageDocument.scripts),
    /PACKSCOUT_(?:COURTYARD|COLLECTOR_CRYPT|PHYGITALS)_DATABASE_URL/u,
  );
});

test("failures and forbidden argv never emit secret values", () => {
  const serialized = JSON.stringify(safeProviderReviewProvisionFailure(
    new Error(Object.values(secrets).join("|")),
  ));
  for (const secret of Object.values(secrets)) {
    assert.equal(serialized.includes(secret), false);
  }
  const script = fileURLToPath(new URL(
    "./provision-provider-review-databases.mts",
    import.meta.url,
  ));
  const argvSecret = "provider-password-that-must-not-echo";
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, `--password=${argvSecret}`],
    {
      cwd: path.resolve(path.dirname(script), "..", ".."),
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "development" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"code":"ARGUMENTS_FORBIDDEN"/u);
  assert.equal(`${result.stdout}${result.stderr}`.includes(argvSecret), false);
});
