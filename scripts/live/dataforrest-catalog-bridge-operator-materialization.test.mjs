import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const contracts = await tsImport("@packscout/contracts", import.meta.url);
const database = await tsImport("@packscout/database", import.meta.url);
const plan = await tsImport("./dataforrest-catalog-bridge-plan.mts", import.meta.url);
const operatorFiles = await tsImport("./dataforrest-catalog-bridge-operator-files.mts", import.meta.url);
const drainCapture = await tsImport("./capture-dataforrest-catalog-bridge-drain-policy.mts", import.meta.url);
const drainPolicy = await tsImport("./dataforrest-catalog-bridge-drain-live-policy.mts", import.meta.url);
const preparation = await tsImport("./capture-dataforrest-catalog-bridge-preparation.mts", import.meta.url);
const materializer = await tsImport("./materialize-dataforrest-catalog-bridge-live-policy.mts", import.meta.url);
const liveDatabase = await tsImport("./dataforrest-catalog-bridge-drain-live-database.mts", import.meta.url);
const drainRunner = await tsImport("./run-dataforrest-catalog-bridge-drain.mts", import.meta.url);

const operationId = "efe5b7b2-3fc6-42ad-8a1c-dfcabc9f593d";
const operatorId = "7236e1b0-eb72-58cb-a3fb-3ae3dc7bb9de";
const commit = "a".repeat(40);
const hash = letter => letter.repeat(64);
const sha256 = value => createHash("sha256").update(value).digest("hex");

function drainArguments(root = "/private/catalog-bridge", providerKey = "collector_crypt") {
  return ["--capture", "--provider-key", providerKey, "--operation-id", operationId,
    "--operator-id", operatorId, "--executor-checkout", root, "--executor-commit", commit,
    "--receipt-path", `${root}/drain-receipt.json`, "--output", `${root}/drain-policy.json`];
}

test("producer parsers require one explicit mode and exact canonical private paths", () => {
  assert.deepEqual(drainCapture.parseCatalogBridgeDrainPolicyCaptureArguments(drainArguments()), {
    providerKey: "collector_crypt", operationId, operatorId,
    executorCheckout: "/private/catalog-bridge", executorCommit: commit,
    receiptPath: "/private/catalog-bridge/drain-receipt.json",
    outputPath: "/private/catalog-bridge/drain-policy.json",
  });
  const preparationArguments = ["--capture", "--drain-policy-file", "/private/drain-policy.json",
    "--drain-policy-sha256", hash("b"), "--source-census-file", "/private/source-census.json",
    "--source-census-sha256", hash("c"), "--output", "/private/preparation.json"];
  assert.deepEqual(preparation.parseCatalogBridgePreparationCaptureArguments(preparationArguments), {
    drainPolicyPath: "/private/drain-policy.json", drainPolicySha256: hash("b"),
    sourceCensusPath: "/private/source-census.json", sourceCensusSha256: hash("c"),
    outputPath: "/private/preparation.json",
  });
  const materializationArguments = ["--materialize", "--journal-directory", "/private/journal",
    "--capability-proof", "/private/capability.json", "--node-path", "/private/node",
    "--log-path", "/private/provider.log", "--staged-plist-path", "/private/staged/agent.plist",
    "--installed-plist-path", "/private/installed/agent.plist",
    "--output-policy", "/private/catalog-policy.json"];
  assert.equal(materializer.parseCatalogBridgeLivePolicyMaterializationArguments(
    materializationArguments).nodePath, "/private/node");

  for (const invalid of [drainArguments().slice(1), [...drainArguments(), "--output", "/private/x"],
    drainArguments().map(value => value === "/private/catalog-bridge" ? "relative" : value),
    drainArguments().map(value => value.endsWith("drain-receipt.json")
      ? "/private/catalog-bridge/drain-policy.json" : value)]) {
    assert.throws(() => drainCapture.parseCatalogBridgeDrainPolicyCaptureArguments(invalid));
  }
  for (const invalid of [preparationArguments.slice(0, -2),
    preparationArguments.map(value => value === hash("c") ? "invalid" : value),
    preparationArguments.map(value => value === "/private/preparation.json"
      ? "/private/source-census.json" : value),
    [...preparationArguments, "--source-head-card-count", "190000"]]) {
    assert.throws(() => preparation.parseCatalogBridgePreparationCaptureArguments(invalid));
  }
  const crossed = [...materializationArguments];
  crossed[crossed.indexOf("/private/catalog-policy.json")] = "/private/installed/agent.plist";
  assert.throws(() => materializer.parseCatalogBridgeLivePolicyMaterializationArguments(crossed));
});

test("private operator artifacts are exact, owner-only, durable retries and conflict refusing", async () => {
  const temporaryBase = await realpath(tmpdir());
  const root = await mkdtemp(path.join(temporaryBase, "packscout-catalog-operator-"));
  await chmod(root, 0o700);
  const file = path.join(root, "artifact.json");
  const bytes = operatorFiles.catalogBridgePrivateJsonBytes({ privateCursor: "never-stdout" });
  try {
    const first = await operatorFiles.persistCatalogBridgePrivateBytes(file, bytes);
    assert.deepEqual(first, { fileSha256: sha256(bytes), exactRetry: false });
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await operatorFiles.persistCatalogBridgePrivateBytes(file, bytes), {
      fileSha256: sha256(bytes), exactRetry: true,
    });
    await assert.rejects(operatorFiles.persistCatalogBridgePrivateBytes(file,
      Buffer.from("different\n")), { code: "CATALOG_BRIDGE_OPERATOR_OUTPUT_CONFLICT" });

    const unsafe = path.join(root, "unsafe");
    await chmod(root, 0o755);
    await assert.rejects(operatorFiles.persistCatalogBridgePrivateBytes(unsafe, bytes),
      { code: "CATALOG_BRIDGE_OPERATOR_OUTPUT_DIRECTORY_UNSAFE" });
    await chmod(root, 0o700);
    const link = `${root}-link`;
    await symlink(root, link);
    try {
      await assert.rejects(operatorFiles.persistCatalogBridgePrivateBytes(path.join(link, "linked.json"), bytes),
        { code: "CATALOG_BRIDGE_OPERATOR_OUTPUT_DIRECTORY_UNSAFE" });
    } finally {
      await rm(link, { force: true });
    }
  } finally {
    bytes.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("checkout observation pins exact root, commit, clean tree and module bytes", async () => {
  const root = "/private/reviewed/catalog-bridge";
  const calls = [];
  const observed = await operatorFiles.observeCatalogBridgeCheckout({ checkout: root,
    expectedCommit: commit, executingRoot: root,
    modules: { runner: "scripts/live/runner.mts", plan: "scripts/live/plan.mts" },
    runGit: (_checkout, args) => { calls.push(args); return args[0] === "rev-parse" ? `${commit}\n` : ""; },
    readModule: async file => Buffer.from(path.basename(file), "utf8") });
  assert.equal(observed.clean, true);
  assert.equal(observed.moduleSha256.runner, sha256(Buffer.from("runner.mts")));
  assert.deepEqual(calls, [["rev-parse", "HEAD"],
    ["status", "--porcelain=v1", "--untracked-files=normal"]]);
  await assert.rejects(operatorFiles.observeCatalogBridgeCheckout({ checkout: root,
    expectedCommit: commit, executingRoot: root, modules: { runner: "../runner.mts" },
    runGit: () => "", readModule: async () => Buffer.from("x") }),
  { code: "CATALOG_BRIDGE_EXECUTOR_PINS_INVALID" });
  await assert.rejects(operatorFiles.observeCatalogBridgeCheckout({ checkout: root,
    expectedCommit: commit, executingRoot: root, modules: { runner: "scripts/runner.mts" },
    runGit: (_checkout, args) => args[0] === "rev-parse" ? commit : " M private-secret\n",
    readModule: async () => Buffer.from("x") }), { code: "CATALOG_BRIDGE_EXECUTOR_DRIFT" });
});

function runningBoundary(providerKey = "collector_crypt") {
  const definition = plan.catalogBridgeProvider(providerKey);
  const cursor = { sourceInstanceId: definition.providerId,
    sourceRevisionId: definition.currentConfigId,
    sourceTypeKey: definition.currentEventManifest.sourceTypeKey,
    adapterVersion: definition.currentEventManifest.adapterVersion,
    cursorCodecKey: definition.currentEventManifest.cursorCodecKey,
    cursorGeneration: 1, value: "private-saved-event-cursor" };
  const cursorHash = database.providerMixedCursorFingerprint(cursor);
  return { definition, cursor, cursorHash, boundary: {
    observedAt: "2026-09-01T03:00:00.000Z", databaseNow: "2026-09-01T03:00:00.000Z",
    central: { organizationId: definition.organizationId, providerId: definition.providerId,
      providerKey: definition.providerKey, providerRowVersion: "20",
      activeConfigId: definition.currentConfigId, activeConfigNumber: definition.currentConfigNumber,
      maximumConfigNumber: definition.currentConfigNumber,
      activeAdapterVersion: definition.currentEventManifest.adapterVersion,
      configuration: { platform: definition.providerKey },
      configurationDigest: plan.catalogBridgeDigest({ platform: definition.providerKey }),
      authorityDigest: hash("b") },
    runtime: { providerId: definition.providerId, providerKey: definition.providerKey,
      databaseName: definition.databaseName, databasePort: definition.databasePort,
      databaseRole: "provider", schemaVersion: "distributed-provider-v1", state: "running",
      generation: "30", rowVersion: "40", cachedConfigId: definition.currentConfigId,
      cachedConfigNumber: definition.currentConfigNumber,
      cachedConfiguration: { adapterKey: definition.currentEventManifest.adapterVersion,
        settings: { platform: definition.providerKey } },
      sourceCursor: cursor, sourceCursorHash: cursorHash, activeRunCount: 1,
      actionableCommandCount: 0, otherOwnedLeaseCount: 0, otherActiveTransactionCount: 0 },
    importLease: { owner: `provider-import:${providerKey}`, fence: "14",
      expiresAt: "2026-09-01T03:02:00.000Z" },
    run: { id: "40000000-0000-4000-8000-000000000003", state: "running",
      configId: definition.currentConfigId, configNumber: definition.currentConfigNumber,
      workerFence: "14", pageCount: 3, reachedSourceHead: false, finishedAt: null,
      failureCode: null, finalCursor: cursor, finalCursorHash: cursorHash, runDigest: hash("c") },
    lastPage: { id: "40000000-0000-4000-8000-000000000004", pageNumber: 3,
      nextCursor: cursor, nextCursorHash: cursorHash, continuation: "more", lastPageDigest: hash("d") },
    headProof: null,
    process: { launchdLabel: definition.launchdLabel, launchdLoaded: true, processCount: 1,
      pids: [99123], processIdentitySha256: hash("e"), residencyPort: definition.residencyPort,
      residencyPortListening: true },
  } };
}

test("drain policy captures executor pins without persisting the source cursor", async () => {
  const value = runningBoundary();
  const args = drainCapture.parseCatalogBridgeDrainPolicyCaptureArguments(drainArguments());
  const policy = drainCapture.buildCatalogBridgeLiveDrainPolicy({ args, boundary: value.boundary,
    authority: { boundary: value.boundary.central, route: {}, routeDigest: hash("f") },
    executorRunnerModuleSha256: hash("9") });
  assert.deepEqual(policy.executor, { checkout: args.executorCheckout, commit,
    runnerModuleSha256: hash("9") });
  assert.equal(JSON.stringify(policy).includes(value.cursor.value), false);
  await drainRunner.assertCatalogBridgeLiveDrainExecutor(policy, async input => {
    assert.equal(input.checkout, args.executorCheckout);
    assert.deepEqual(input.modules, { runner: "scripts/live/run-dataforrest-catalog-bridge-drain.mts" });
    return { checkout: input.checkout, commit, clean: true,
      moduleSha256: { runner: hash("9") } };
  });
  await assert.rejects(drainRunner.assertCatalogBridgeLiveDrainExecutor(policy, async input => ({
    checkout: input.checkout, commit, clean: true, moduleSha256: { runner: hash("8") },
  })), { code: "CATALOG_BRIDGE_LIVE_DRAIN_EXECUTOR_CHANGED" });
});

test("preparation refuses non-Collector policy before checkout or dependency access", async () => {
  const temporaryBase = await realpath(tmpdir());
  const root = await mkdtemp(path.join(temporaryBase, "packscout-unsupported-preparation-"));
  await chmod(root, 0o700);
  const value = runningBoundary("courtyard");
  const args = drainCapture.parseCatalogBridgeDrainPolicyCaptureArguments(
    drainArguments(root, "courtyard"),
  );
  const policy = drainCapture.buildCatalogBridgeLiveDrainPolicy({
    args,
    boundary: value.boundary,
    authority: { boundary: value.boundary.central, route: {}, routeDigest: hash("f") },
    executorRunnerModuleSha256: hash("9"),
  });
  const bytes = operatorFiles.catalogBridgePrivateJsonBytes(policy);
  try {
    await operatorFiles.persistCatalogBridgePrivateBytes(args.outputPath, bytes);
    await assert.rejects(preparation.captureCatalogBridgePreparation({
      args: {
        drainPolicyPath: args.outputPath,
        drainPolicySha256: drainPolicy.catalogBridgeLiveDrainPolicyDigest(policy),
        sourceCensusPath: path.join(root, "missing-source-census.json"),
        sourceCensusSha256: hash("c"),
        outputPath: path.join(root, "preparation.json"),
      },
      environment: {},
    }), { code: "CATALOG_BRIDGE_SOURCE_CENSUS_PROVIDER_UNSUPPORTED" });
  } finally {
    bytes.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});

test("central freshness refuses deterministic descendants and prior operation correlations", async () => {
  const observed = [];
  const central = {
    provider_config_versions: { count: async input => { observed.push(input); return 0; } },
    audit_events: { count: async input => { observed.push(input); return 0; } },
    provider_connection_tests: { count: async input => { observed.push(input); return 0; } },
    $queryRawUnsafe: async () => [{ use_count: 0n }],
  };
  await liveDatabase.assertCatalogBridgeLiveCentralOperationFresh({ central,
    operationId, providerKey: "collector_crypt" });
  assert.equal(observed.length, 3);
  await assert.rejects(liveDatabase.assertCatalogBridgeLiveCentralOperationFresh({
    central: { ...central, audit_events: { count: async () => 1 } },
    operationId, providerKey: "collector_crypt",
  }), { code: "CATALOG_BRIDGE_OPERATION_ID_ALREADY_USED" });
});

test("source canaries hash outputs, inspect exact streams and zero every protected body", async () => {
  const { definition, cursor, cursorHash } = runningBoundary();
  const bearerToken = "private-bearer-token-never-persist";
  const returnedCursor = "private-returned-cursor-never-persist";
  const catalogBody = new TextEncoder().encode(JSON.stringify({ records: [{ stream: "catalog",
    entity: "card", platform: definition.providerKey, record_id: "card-1",
    occurred_at: "2026-09-01T02:00:00Z", collected_at: "2026-09-01T02:00:01Z",
    first_seen_at: "2026-09-01T02:00:00Z", available: true,
    data: { asset: { title: "Reviewed card" } } }], next_cursor: returnedCursor,
  poll_after_seconds: 0 }));
  const eventBody = new TextEncoder().encode(JSON.stringify({ records: [{
    stream: "catalog", entity: "pack", platform: definition.providerKey,
    record_id: "pack-without-outer-availability",
    occurred_at: "2026-09-01T02:01:00Z",
    collected_at: "2026-09-01T02:01:01Z",
    first_seen_at: "2026-09-01T02:01:00Z",
    data: { name: "Retained Collector pack" },
  }],
    next_cursor: `${returnedCursor}-event`, poll_after_seconds: 60 }));
  const protectedBodies = [];
  const requests = [];
  const captureResponse = async input => {
    requests.push(input);
    const protectedBody = (requests.length === 1 ? catalogBody : eventBody).slice();
    protectedBodies.push(protectedBody);
    return { status: 200, protectedBody, durationMilliseconds: requests.length * 10,
      responseBytes: protectedBody.byteLength };
  };
  let tick = 0;
  const canaries = await preparation.captureCatalogBridgeSourceCanaries({
    authority: { organizationId: definition.organizationId, providerId: definition.providerId,
      providerKey: definition.providerKey, configVersionId: definition.currentConfigId,
      configVersionNumber: BigInt(definition.currentConfigNumber),
      adapterKey: definition.currentEventManifest.adapterVersion,
      sourceTypeKey: definition.currentEventManifest.sourceTypeKey,
      sourceAdapterVersion: definition.currentEventManifest.adapterVersion,
      sourceCredentialVersionId: "40000000-0000-4000-8000-000000000009",
      sourceCredentialVersionNumber: 3n, expiresAt: null,
      connectionConfiguration: { endpoint: contracts.DATAFORREST_EVENTS_V1_ENDPOINT, bearerToken },
      sourceConfiguration: { platform: definition.providerKey } },
    savedEventCursor: cursor, savedEventCursorHash: cursorHash, captureResponse,
    now: () => new Date(Date.parse("2026-09-01T03:00:00.000Z") + tick++ * 1_000),
  });
  assert.equal(canaries.catalogOrigin.cardCount, 1);
  assert.equal(canaries.catalogOrigin.packCount, 0);
  assert.equal(canaries.savedEventCursor.recordCount, 1);
  assert.equal(
    canaries.savedEventCursor.adapterVersion,
    definition.eventSuccessorManifest.adapterVersion,
  );
  assert.equal(requests[0].url.searchParams.get("stream"), "catalog");
  assert.equal(requests[0].url.searchParams.has("cursor"), false);
  assert.equal(requests[1].url.searchParams.get("cursor"), cursor.value);
  assert.equal(protectedBodies.every(body => body.every(byte => byte === 0)), true);
  const publicShape = JSON.stringify(canaries);
  for (const secret of [bearerToken, cursor.value, returnedCursor]) {
    assert.equal(publicShape.includes(secret), false);
  }
});

function capabilityProof() {
  const at = "2026-09-01T03:00:00.000Z";
  return { schemaVersion: "dataforrest_catalog_bridge_capability_proof_v1", capturedAt: at,
    authorization: "operator_requested_read_only_catalog_capability_probe",
    databaseWritesPerformed: false, sourceRequestsPerformed: false,
    providers: plan.catalogBridgeProviderDefinitions.map(definition => ({
      providerId: definition.providerId, providerKey: definition.providerKey,
      databaseName: definition.databaseName, databasePort: definition.databasePort,
      observedAt: at, databaseNow: at, serverVersionNumber: 170000,
      sha256ByteaAvailable: true, runtimeState: "idle", runtimeGeneration: "10",
      runtimeRowVersion: "20", activeRunCount: 0, actionableCommandCount: 0,
      importLeaseOwnerPresent: false, importLeaseLive: false,
      estimatedRows: { collectibles: "1", packs: "1", pulls: "1", marketEvents: "1" },
    })),
  };
}

test("materializer emits awaited successor arguments and binds policy to raw plist bytes", () => {
  const definition = plan.catalogBridgeProvider("collector_crypt");
  const ids = plan.catalogBridgeOperationIds({ operationId, providerKey: definition.providerKey });
  const state = { schemaVersion: "dataforrest_catalog_bridge_private_v1", operationId,
    providerKey: definition.providerKey, planDigest: hash("1"), preparedAt: "2026-09-01T03:00:00.000Z",
    ...ids, preflight: {
      repository: { checkout: "/private/reviewed/catalog-bridge", expectedCommit: commit,
        observedCommit: commit, clean: true, utilityModuleSha256: hash("2") },
      central: { providerRowVersion: "20", authorityDigest: hash("3"), databaseRouteDigest: hash("4") },
      runtime: { generation: "30", rowVersion: "40", sourceCursorHash: hash("5"),
        pauseProvenance: { requestedByOperatorId: operatorId,
          commandId: "40000000-0000-4000-8000-000000000010", commandDigest: hash("6") },
        latestTerminalRun: { runId: "40000000-0000-4000-8000-000000000011", runDigest: hash("7") } },
      worker: { gracefulStopReceiptSha256: hash("8") },
      sourceCanaries: { catalogOrigin: { responseSha256: hash("9") },
        savedEventCursor: { responseSha256: hash("a") } },
      baseline: { cards: 1, packs: 1, pulls: 1, marketEvents: 1,
        pullsDigest: hash("b"), marketEventsDigest: hash("c") },
    } };
  const expectedPins = { operationId, providerKey: definition.providerKey, operatorId,
    residentCheckout: state.preflight.repository.checkout,
    residentCommit: state.preflight.repository.expectedCommit,
    utilityModuleSha256: state.preflight.repository.utilityModuleSha256,
    sourceHeadCountProvenance: "two_pass_read_only_catalog_census_v1",
    sourceHeadCounts: { ...definition.documentedCatalogFloor },
    sourceHeadCensusFileSha256: hash("d"), sourceHeadCensusProofDigest: hash("e"),
    sourceHeadIdentityMultisetDigest: hash("f") };
  state.planDigest = plan.catalogBridgeDigest(expectedPins);
  const successor = materializer.buildCatalogBridgeSuccessorPlist({ state,
    nodePath: "/private/node/bin/node", logPath: "/private/log/provider.log" });
  assert.equal(successor.arguments.includes("--await-initial-run"), true);
  assert.equal(successor.arguments.includes("--bootstrap-backfill"), true);
  assert.equal(/TOKEN|PASSWORD|SECRET|DATABASE_URL/u.test(successor.plist.toString("utf8")), false);
  const plistSha256 = sha256(successor.plist);
  const receipt = { schemaVersion: "dataforrest_catalog_bridge_receipt_v1", phase: "prepared",
    operationId, providerKey: definition.providerKey, planDigest: state.planDigest,
    observedAt: state.preparedAt, previousReceiptHash: null,
    evidence: { sourceHeadCountProvenance: "two_pass_read_only_catalog_census_v1",
      sourceHeadCardCount: definition.documentedCatalogFloor.card,
      sourceHeadPackCount: definition.documentedCatalogFloor.pack,
      sourceHeadCensusFileSha256: hash("d"), sourceHeadCensusProofDigest: hash("e"),
      sourceHeadIdentityMultisetDigest: hash("f") } };
  const journal = { schemaVersion: "dataforrest_catalog_bridge_journal_v1", operationId,
    providerKey: definition.providerKey, planDigest: state.planDigest, phase: "prepared",
    receipts: [receipt], headReceiptHash: hash("d") };
  const prepared = { privateState: state, journal,
    commit: { schemaVersion: "dataforrest_catalog_bridge_commit_v1", operationId,
      providerKey: definition.providerKey, privateStateSha256: plan.catalogBridgeDigest(state),
      publicJournalSha256: plan.catalogBridgeDigest(journal) } };
  const args = { journalDirectory: "/private/journal", capabilityProofPath: "/private/capability.json",
    nodePath: "/private/node/bin/node", logPath: "/private/log/provider.log",
    stagedPlistPath: `/private/staged/${definition.launchdLabel}.plist`,
    installedPlistPath: `/private/installed/${definition.launchdLabel}.plist`,
    outputPolicyPath: "/private/catalog-policy.json" };
  const policy = materializer.buildCatalogBridgeCatalogLivePolicy({ args, prepared,
    capabilityProof: capabilityProof(), capabilityProofFileSha256: hash("e"),
    stagedPlistFileSha256: plistSha256, oneShotModuleSha256: hash("f"),
    residentModuleSha256: hash("0") });
  assert.equal(policy.successorLaunchAgent.fileSha256, plistSha256);
  assert.equal(policy.pins.sourceHeadIdentityMultisetDigest,
    expectedPins.sourceHeadIdentityMultisetDigest);
  assert.equal(policy.utility.executionTimeoutMilliseconds,
    8 * 60 * 60_000 + 30 * 60_000);
  assert.notEqual(policy.successorLaunchAgent.fileSha256,
    sha256(Buffer.concat([successor.plist, Buffer.from("tampered")])));
});
