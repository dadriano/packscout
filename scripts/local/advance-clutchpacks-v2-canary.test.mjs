import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  ClutchpacksV2CanaryDriverError,
  assertClutchpacksV2CanaryOneSlotSupervisor,
  assertClutchpacksV2CanaryExpectedStage,
  assertClutchpacksV2CanaryTargetIsExact,
  assertClutchpacksV2CanaryTargetIsPristine,
  assertOriginalClutchpacksV1IsExact,
  assertOriginalClutchpacksV1PausedAndDrained,
  clutchpacksV2CanaryDriverConfirmations,
  clutchpacksV2CanaryDriverUsage,
  clutchpacksV2CanaryLineageCount,
  determineClutchpacksV2CanaryQualificationStage,
  parseClutchpacksV2CanaryDriverCommand,
  safeClutchpacksV2CanaryDriverFailure,
} = await tsImport(
  "./advance-clutchpacks-v2-canary.mts",
  import.meta.url,
);

const scriptPath = fileURLToPath(new URL(
  "./advance-clutchpacks-v2-canary.mts",
  import.meta.url,
));
const organizationId = "22222222-2222-4222-8222-222222222222";
const providerId = "33333333-3333-4333-8333-333333333333";
const profileId = "44444444-4444-4444-8444-444444444444";
const connectionRevisionId = "55555555-5555-4555-8555-555555555555";
const sourceId = "66666666-6666-4666-8666-666666666666";
const sourceRevisionId = "77777777-7777-4777-8777-777777777777";
const environment = Object.freeze({
  targetOrganizationId: organizationId,
  providerId,
  profileId,
  connectionRevisionId,
});

function hasCode(code) {
  return (error) =>
    error instanceof ClutchpacksV2CanaryDriverError && error.code === code;
}

function successfulTest() {
  return { state: "succeeded", hasSuccessfulResult: true };
}

function targetSnapshot(overrides = {}) {
  return {
    organizationCount: 1,
    organization: {
      id: organizationId,
      slug: "packscout-clutchpacks-v2-canary",
      name: "PackScout ClutchPacks V2 Canary",
    },
    providers: [{
      id: providerId,
      organizationId,
      platformKey: "clutchpacks",
      state: "active",
      activeRevisionId: null,
      nextRunAt: null,
    }],
    profiles: [{
      id: profileId,
      organizationId,
      sourceTypeKey: "dataforrest-events-v1",
      state: "draft",
      requestLimit: 2,
      activeRevisionId: null,
    }],
    connectionRevisions: [{
      id: connectionRevisionId,
      organizationId,
      profileId,
      sourceTypeKey: "dataforrest-events-v1",
      adapterVersion: "dataforrest-events-adapter-v2",
      state: "candidate",
      healthGeneration: 0n,
    }],
    sources: [{
      id: sourceId,
      organizationId,
      providerId,
      profileId,
      sourceTypeKey: "dataforrest-events-v1",
      state: "draft",
      activeRevisionId: sourceRevisionId,
    }],
    sourceRevisions: [{
      id: sourceRevisionId,
      organizationId,
      providerId,
      sourceInstanceId: sourceId,
      profileId,
      sourceTypeKey: "dataforrest-events-v1",
      adapterVersion: "dataforrest-events-adapter-v2",
      configuration: { platform: "clutchpacks" },
    }],
    cursors: [{
      sourceInstanceId: sourceId,
      sourceRevisionId,
      generation: 1n,
      adapterVersion: "dataforrest-events-adapter-v2",
      fingerprint: null,
      advancedByRunId: null,
      advancedByPageId: null,
    }],
    importRunCount: 0,
    importPageCount: 0,
    pageReadAttemptCount: 0,
    sourceRecordIdentityCount: 0,
    semanticObservationCount: 0,
    deliveryOccurrenceCount: 0,
    canonicalEntityCount: 0,
    legacyProviderConfigRevisionCount: 0,
    legacyProviderSecretVersionCount: 0,
    legacyProviderCursorCheckpointCount: 0,
    connectionTest: null,
    sourceTest: null,
    ...overrides,
  };
}

function activeProfile(snapshot, overrides = {}) {
  return {
    ...snapshot,
    profiles: [{
      ...snapshot.profiles[0],
      state: "active",
      activeRevisionId: connectionRevisionId,
    }],
    connectionRevisions: [{
      ...snapshot.connectionRevisions[0],
      state: "active",
    }],
    connectionTest: successfulTest(),
    ...overrides,
  };
}

test("commands require action-specific digest-bound confirmations", () => {
  const digest = "a".repeat(64);
  const confirmations = clutchpacksV2CanaryDriverConfirmations(digest);
  assert.deepEqual(confirmations, {
    advance: "ADVANCE CLUTCHPACKS V2 LOCAL aaaaaaaaaaaaaaaa",
    pauseOriginal: "PAUSE ORIGINAL CLUTCHPACKS V1 LOCAL aaaaaaaaaaaaaaaa",
    resume: "RESUME CLUTCHPACKS V2 LOCAL aaaaaaaaaaaaaaaa",
  });
  assert.deepEqual(parseClutchpacksV2CanaryDriverCommand([], confirmations), {
    action: "status",
    confirmation: null,
  });
  assert.deepEqual(
    parseClutchpacksV2CanaryDriverCommand(["--plan"], confirmations),
    { action: "plan", confirmation: null },
  );
  assert.deepEqual(parseClutchpacksV2CanaryDriverCommand(
    [
      "--advance",
      "--expected-stage",
      "queue_connection_test",
      "--confirmation",
      confirmations.advance,
    ],
    confirmations,
  ), {
    action: "advance",
    confirmation: confirmations.advance,
    expectedStage: "queue_connection_test",
  });
  for (const [flag, action, confirmation] of [
    ["--pause-original", "pause_original", confirmations.pauseOriginal],
    ["--resume", "resume", confirmations.resume],
  ]) {
    assert.deepEqual(parseClutchpacksV2CanaryDriverCommand(
      [flag, "--confirmation", confirmation],
      confirmations,
    ), { action, confirmation });
  }
  for (const argv of [
    ["--advance"],
    ["--advance", "--confirmation", confirmations.advance],
    [
      "--advance",
      "--expected-stage",
      "",
      "--confirmation",
      confirmations.advance,
    ],
    [
      "--advance",
      "--expected-stage",
      "queue_connection_test",
      "--confirmation",
      confirmations.resume,
    ],
    ["--resume", "--confirmation", "RESUME CLUTCHPACKS V2 LOCAL wrong"],
    ["--status", "--confirmation", confirmations.advance],
  ]) {
    assert.throws(
      () => parseClutchpacksV2CanaryDriverCommand(argv, confirmations),
      hasCode("CONFIRMATION_INVALID"),
    );
  }
});

test("the original proof selects one exact active adapter-v1 Clutch source", () => {
  const exact = Object.freeze({
    providerId: "11111111-1111-4111-8111-111111111111",
    sourceInstanceId: "12111111-1111-4111-8111-111111111111",
    sourceRevisionId: "13111111-1111-4111-8111-111111111111",
    sourceState: "paused",
    pauseRequested: false,
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: "dataforrest-events-adapter-v1",
    connectionProfileState: "active",
    connectionRevisionState: "active",
    connectionAdapterVersion: "dataforrest-events-adapter-v1",
    activeRunCount: 0,
  });
  assert.equal(assertOriginalClutchpacksV1IsExact([exact]), exact);
  assert.doesNotThrow(() =>
    assertOriginalClutchpacksV1PausedAndDrained(exact)
  );
  for (const [rows, code] of [
    [[], "ORIGINAL_CLUTCHPACKS_V1_NOT_EXACT"],
    [[exact, exact], "ORIGINAL_CLUTCHPACKS_V1_NOT_EXACT"],
    [[{ ...exact, sourceAdapterVersion: "dataforrest-events-adapter-v2" }],
      "ORIGINAL_CLUTCHPACKS_V1_NOT_EXACT"],
    [[{ ...exact, connectionAdapterVersion: "dataforrest-events-adapter-v2" }],
      "ORIGINAL_CLUTCHPACKS_V1_NOT_EXACT"],
  ]) {
    assert.throws(() => assertOriginalClutchpacksV1IsExact(rows), hasCode(code));
  }
  for (const [candidate, code] of [
    [{ ...exact, sourceState: "active" },
      "ORIGINAL_CLUTCHPACKS_V1_NOT_PAUSED"],
    [{ ...exact, pauseRequested: true },
      "ORIGINAL_CLUTCHPACKS_V1_NOT_PAUSED"],
    [{ ...exact, activeRunCount: 1 },
      "ORIGINAL_CLUTCHPACKS_V1_NOT_DRAINED"],
  ]) {
    assert.throws(
      () => assertOriginalClutchpacksV1PausedAndDrained(candidate),
      hasCode(code),
    );
  }
});

test("the target guard requires the exact one-tenant adapter-v2 topology", () => {
  const staged = targetSnapshot();
  assert.doesNotThrow(() =>
    assertClutchpacksV2CanaryTargetIsExact(staged, environment)
  );
  const activated = activeProfile(staged, {
    sources: [{ ...staged.sources[0], state: "paused" }],
    sourceTest: successfulTest(),
  });
  assert.doesNotThrow(() =>
    assertClutchpacksV2CanaryTargetIsExact(activated, environment)
  );
  const invalid = [
    { ...staged, organizationCount: 2 },
    { ...staged, providers: [...staged.providers, staged.providers[0]] },
    { ...staged, providers: [{
      ...staged.providers[0],
      activeRevisionId: connectionRevisionId,
    }] },
    { ...staged, providers: [{
      ...staged.providers[0],
      nextRunAt: new Date("2026-08-27T12:00:00.000Z"),
    }] },
    { ...staged, profiles: [{ ...staged.profiles[0], requestLimit: 1 }] },
    { ...staged, connectionRevisions: [{
      ...staged.connectionRevisions[0],
      adapterVersion: "dataforrest-events-adapter-v1",
    }] },
    { ...staged, sourceRevisions: [{
      ...staged.sourceRevisions[0],
      configuration: { platform: "courtyard" },
    }] },
    { ...staged, cursors: [{ ...staged.cursors[0], generation: 2n }] },
    { ...staged, legacyProviderConfigRevisionCount: 1 },
    { ...staged, legacyProviderSecretVersionCount: 1 },
    { ...staged, legacyProviderCursorCheckpointCount: 1 },
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => assertClutchpacksV2CanaryTargetIsExact(candidate, environment),
      hasCode("TARGET_V2_TOPOLOGY_NOT_EXACT"),
    );
  }
  assert.throws(
    () => assertClutchpacksV2CanaryTargetIsExact({
      ...staged,
      profiles: [{ ...staged.profiles[0], state: "active" }],
    }, environment),
    hasCode("TARGET_V2_LIFECYCLE_NOT_EXACT"),
  );
});

test("pre-resume evidence must remain at Feed start with no import lineage", () => {
  const pristine = targetSnapshot();
  assert.equal(clutchpacksV2CanaryLineageCount(pristine), 0);
  assert.doesNotThrow(() => assertClutchpacksV2CanaryTargetIsPristine(pristine));
  for (const candidate of [
    { ...pristine, importRunCount: 1 },
    { ...pristine, pageReadAttemptCount: 1 },
    { ...pristine, deliveryOccurrenceCount: 1 },
    { ...pristine, canonicalEntityCount: 1 },
    { ...pristine, cursors: [{
      ...pristine.cursors[0],
      fingerprint: "a".repeat(64),
    }] },
    { ...pristine, cursors: [{
      ...pristine.cursors[0],
      advancedByRunId: "88888888-8888-4888-8888-888888888888",
    }] },
  ]) {
    assert.throws(
      () => assertClutchpacksV2CanaryTargetIsPristine(candidate),
      hasCode("TARGET_NOT_PRISTINE_FOR_RESUME"),
    );
  }
});

test("qualification advances exactly one explicit lifecycle transition", () => {
  const initial = targetSnapshot();
  const connectionQueued = {
    ...initial,
    connectionTest: { state: "queued", hasSuccessfulResult: false },
  };
  const connectionRunning = {
    ...initial,
    connectionTest: { state: "running", hasSuccessfulResult: false },
  };
  const connectionSucceeded = {
    ...initial,
    connectionTest: successfulTest(),
  };
  const connectionActive = activeProfile(initial);
  const sourceQueued = {
    ...connectionActive,
    sourceTest: { state: "queued", hasSuccessfulResult: false },
  };
  const sourceRunning = {
    ...connectionActive,
    sourceTest: { state: "running", hasSuccessfulResult: false },
  };
  const sourceSucceeded = {
    ...connectionActive,
    sourceTest: successfulTest(),
  };
  const paused = {
    ...sourceSucceeded,
    sources: [{ ...sourceSucceeded.sources[0], state: "paused" }],
  };
  const active = {
    ...paused,
    sources: [{ ...paused.sources[0], state: "active" }],
  };
  for (const [snapshot, stage] of [
    [initial, "queue_connection_test"],
    [connectionQueued, "wait_connection_test"],
    [connectionRunning, "wait_connection_test"],
    [connectionSucceeded, "activate_connection"],
    [connectionActive, "queue_source_test"],
    [sourceQueued, "wait_source_test"],
    [sourceRunning, "wait_source_test"],
    [sourceSucceeded, "activate_source_paused"],
    [paused, "ready_to_resume"],
    [active, "replay_active"],
    [{
      ...initial,
      connectionTest: { state: "failed", hasSuccessfulResult: false },
    }, "connection_test_failed"],
    [{
      ...connectionActive,
      sourceTest: { state: "fenced", hasSuccessfulResult: false },
    }, "source_test_failed"],
  ]) {
    assert.equal(determineClutchpacksV2CanaryQualificationStage(snapshot), stage);
  }
  assert.throws(
    () => determineClutchpacksV2CanaryQualificationStage({
      ...initial,
      connectionTest: { state: "succeeded", hasSuccessfulResult: false },
    }),
    hasCode("TARGET_TEST_EVIDENCE_INVALID"),
  );
  assert.throws(
    () => determineClutchpacksV2CanaryQualificationStage({
      ...connectionActive,
      sources: [{ ...connectionActive.sources[0], state: "paused" }],
    }),
    hasCode("TARGET_QUALIFICATION_EVIDENCE_INVALID"),
  );
  assert.doesNotThrow(() =>
    assertClutchpacksV2CanaryExpectedStage(
      "queue_connection_test",
      "queue_connection_test",
    )
  );
  assert.throws(
    () => assertClutchpacksV2CanaryExpectedStage(
      "queue_connection_test",
      "activate_connection",
    ),
    hasCode("TARGET_STAGE_CHANGED"),
  );
});

test("provider-capable commands require one live, available execution slot", () => {
  const ready = Object.freeze({
    liveEpochCount: 1,
    maximumExecutionSlots: 1,
    capacityState: "available",
    snapshotPublished: true,
  });
  assert.doesNotThrow(() =>
    assertClutchpacksV2CanaryOneSlotSupervisor(ready)
  );
  for (const evidence of [
    { ...ready, liveEpochCount: 0 },
    { ...ready, maximumExecutionSlots: 2 },
    { ...ready, capacityState: "unavailable" },
    { ...ready, snapshotPublished: false },
  ]) {
    assert.throws(
      () => assertClutchpacksV2CanaryOneSlotSupervisor(evidence),
      hasCode("TARGET_ONE_SLOT_SUPERVISOR_REQUIRED"),
    );
  }
});

test("failures and help output are stable and credential-free", () => {
  assert.deepEqual(
    safeClutchpacksV2CanaryDriverFailure(
      new ClutchpacksV2CanaryDriverError("TARGET_SOURCE_TEST_FAILED"),
    ),
    {
      ok: false,
      operation: "advance_clutchpacks_v2_canary",
      code: "TARGET_SOURCE_TEST_FAILED",
    },
  );
  assert.deepEqual(safeClutchpacksV2CanaryDriverFailure(
    new Error("postgresql://operator:do-not-print@example.test/secret"),
  ), {
    ok: false,
    operation: "advance_clutchpacks_v2_canary",
    code: "UNEXPECTED_CANARY_DRIVER_FAILURE",
  });
  const usage = clutchpacksV2CanaryDriverUsage();
  assert.match(usage, /PACKSCOUT_SOURCE_EXECUTION_SLOTS=1/u);
  assert.match(usage, /requestLimit of 2/u);
  assert.match(usage, /never calls DataForrest directly/u);
  const help = spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--help"],
    { encoding: "utf8" },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /--pause-original/u);
  assert.match(help.stdout, /--resume/u);
  assert.doesNotMatch(help.stdout, /postgresql:\/\//u);
});
