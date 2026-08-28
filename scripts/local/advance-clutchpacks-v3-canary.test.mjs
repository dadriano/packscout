import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  ClutchpacksV3CanaryDriverError,
  assertClutchpacksV3CanaryOneSlotSupervisor,
  assertClutchpacksV3CanaryExpectedStage,
  assertClutchpacksV3CanarySupervisorStopped,
  assertClutchpacksV3CanaryResetGenerationAtFeedStart,
  assertClutchpacksV3CanaryTargetCanPause,
  assertClutchpacksV3CanaryTargetIsExact,
  assertClutchpacksV3CanaryTargetIsPristine,
  assertOriginalClutchpacksV1DatabaseReady,
  assertOriginalClutchpacksV1IsExact,
  assertOriginalClutchpacksV1PausedAndDrained,
  clutchpacksV3CanaryDriverConfirmations,
  clutchpacksV3CanaryDriverUsage,
  clutchpacksV3CanaryHasExactSucceededHeadRun,
  clutchpacksV3CanaryLineageCount,
  clutchpacksV3CanaryResumeMode,
  clutchpacksV3CanaryTargetWideSafetyEvidence,
  determineClutchpacksV3CanaryQualificationStage,
  parseClutchpacksV3CanaryDriverCommand,
  pauseClutchpacksV3CanaryTarget,
  resetClutchpacksV3CanaryTargetCursor,
  safeClutchpacksV3CanaryDriverFailure,
} = await tsImport(
  "./advance-clutchpacks-v3-canary.mts",
  import.meta.url,
);

const scriptPath = fileURLToPath(new URL(
  "./advance-clutchpacks-v3-canary.mts",
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
    error instanceof ClutchpacksV3CanaryDriverError && error.code === code;
}

function successfulTest() {
  return { state: "succeeded", hasSuccessfulResult: true };
}

function targetSnapshot(overrides = {}) {
  return {
    organizationCount: 1,
    organization: {
      id: organizationId,
      slug: "packscout-clutchpacks-v3-canary",
      name: "PackScout ClutchPacks V3 Canary",
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
      adapterVersion: "dataforrest-events-adapter-v3",
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
      pauseRequested: false,
      activeRevisionId: sourceRevisionId,
    }],
    sourceRevisions: [{
      id: sourceRevisionId,
      organizationId,
      providerId,
      sourceInstanceId: sourceId,
      profileId,
      sourceTypeKey: "dataforrest-events-v1",
      adapterVersion: "dataforrest-events-adapter-v3",
      normalizedContractVersion: "packscout.provider-observation.v1",
      mapperKey: "clutchpacks-provider-observation",
      mapperVersion: "1",
      identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
      cursorCodecVersion: "dataforrest-cursor-v1",
      configuration: { platform: "clutchpacks" },
    }],
    cursors: [{
      sourceInstanceId: sourceId,
      sourceRevisionId,
      generation: 1n,
      adapterVersion: "dataforrest-events-adapter-v3",
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
    quarantineRecordCount: 0,
    warningErrorCriticalDiagnosticCount: 0,
    unresolvedCurrentCursorGenerationDiagnosticCount: 0,
    legacyProviderConfigRevisionCount: 0,
    legacyProviderSecretVersionCount: 0,
    legacyProviderCursorCheckpointCount: 0,
    queuedOrRunningRunCount: 0,
    currentCursorGenerationImportRunCount: 0,
    latestRun: null,
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

function completedReplay(snapshot = targetSnapshot(), overrides = {}) {
  const active = activeProfile(snapshot, {
    sources: [{ ...snapshot.sources[0], state: "active" }],
    sourceTest: successfulTest(),
  });
  const source = active.sources[0];
  const revision = active.sourceRevisions[0];
  return {
    ...active,
    importRunCount: 1,
    currentCursorGenerationImportRunCount: 1,
    latestRun: {
      id: "88888888-8888-4888-8888-888888888888",
      organizationId,
      providerId,
      sourceInstanceId: source.id,
      sourceRevisionId: revision.id,
      sourceTypeKey: revision.sourceTypeKey,
      adapterVersion: revision.adapterVersion,
      normalizedContractVersion: revision.normalizedContractVersion,
      mapperKey: revision.mapperKey,
      mapperVersion: revision.mapperVersion,
      identityNamespaceKey: revision.identityNamespaceKey,
      connectionProfileId: profileId,
      connectionRevisionId,
      cursorCodecVersion: revision.cursorCodecVersion,
      cursorGeneration: active.cursors[0]?.generation ?? 1n,
      configRevisionId: null,
      state: "succeeded",
      reachedProviderHead: true,
      finishedAt: new Date("2026-08-27T14:00:00.000Z"),
      failureCode: null,
    },
    ...overrides,
  };
}

function resetGeneration(overrides = {}) {
  const completed = completedReplay();
  return {
    ...completed,
    sources: [{ ...completed.sources[0], state: "paused" }],
    cursors: [{
      ...completed.cursors[0],
      generation: 2n,
      fingerprint: null,
      advancedByRunId: null,
      advancedByPageId: null,
    }],
    currentCursorGenerationImportRunCount: 0,
    warningErrorCriticalDiagnosticCount: 1,
    unresolvedCurrentCursorGenerationDiagnosticCount: 0,
    ...overrides,
  };
}

test("commands require action-specific digest-bound confirmations", () => {
  const digest = "a".repeat(64);
  const confirmations = clutchpacksV3CanaryDriverConfirmations(digest);
  assert.deepEqual(confirmations, {
    advance: "ADVANCE CLUTCHPACKS V3 LOCAL aaaaaaaaaaaaaaaa",
    pauseOriginal: "PAUSE ORIGINAL CLUTCHPACKS V1 LOCAL aaaaaaaaaaaaaaaa",
    pauseTarget: "PAUSE CLUTCHPACKS V3 TARGET LOCAL aaaaaaaaaaaaaaaa",
    resume: "RESUME CLUTCHPACKS V3 LOCAL aaaaaaaaaaaaaaaa",
    resetTargetCursor:
      "RESET CLUTCHPACKS V3 TARGET CURSOR LOCAL aaaaaaaaaaaaaaaa",
  });
  assert.deepEqual(parseClutchpacksV3CanaryDriverCommand([], confirmations), {
    action: "status",
    confirmation: null,
  });
  assert.deepEqual(
    parseClutchpacksV3CanaryDriverCommand(["--plan"], confirmations),
    { action: "plan", confirmation: null },
  );
  assert.deepEqual(parseClutchpacksV3CanaryDriverCommand(
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
    ["--pause-target", "pause_target", confirmations.pauseTarget],
    ["--resume", "resume", confirmations.resume],
    [
      "--reset-target-cursor",
      "reset_target_cursor",
      confirmations.resetTargetCursor,
    ],
  ]) {
    assert.deepEqual(parseClutchpacksV3CanaryDriverCommand(
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
    ["--resume", "--confirmation", "RESUME CLUTCHPACKS V3 LOCAL wrong"],
    ["--pause-target", "--confirmation", confirmations.pauseOriginal],
    ["--reset-target-cursor", "--confirmation", confirmations.pauseTarget],
    ["--status", "--confirmation", confirmations.advance],
  ]) {
    assert.throws(
      () => parseClutchpacksV3CanaryDriverCommand(argv, confirmations),
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
    [[{ ...exact, sourceAdapterVersion: "dataforrest-events-adapter-v3" }],
      "ORIGINAL_CLUTCHPACKS_V1_NOT_EXACT"],
    [[{ ...exact, connectionAdapterVersion: "dataforrest-events-adapter-v3" }],
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

test("every driver action requires the exact active-source migration subset", async () => {
  const valid = [
    {
      migrationName: "20260819010000_buyback_ev_revisions",
      checksum:
        "71afde6ae913c32a5c7f017da5035775ed5f1fba7d1b48e0b7be4a86e4d825b0",
    },
    {
      migrationName: "20260827010000_provider_source_platform_request_lanes",
      checksum:
        "e1832b7d15630efe544dc2d282aa5b221aac52be9fa648fa4b66b856ac84dbb7",
    },
  ].map((migration) => Object.freeze({
    ...migration,
    finishedAt: new Date("2026-08-27T08:00:00.000Z"),
    rolledBackAt: null,
    tableCount: 87,
  }));
  await assert.doesNotReject(
    assertOriginalClutchpacksV1DatabaseReady(async () => valid),
  );
  for (const readEvidence of [
    async () => valid.slice(1),
    async () => valid.map((row, index) =>
      index === 0 ? { ...row, checksum: "0".repeat(64) } : row
    ),
    async () => valid.map((row, index) =>
      index === 1 ? { ...row, tableCount: 88 } : row
    ),
    async () => {
      throw new Error("database details must remain private");
    },
  ]) {
    await assert.rejects(
      assertOriginalClutchpacksV1DatabaseReady(readEvidence),
      hasCode("ORIGINAL_DATABASE_SCHEMA_NOT_READY"),
    );
  }
});

test("the target guard requires the exact one-tenant adapter-v3 topology", () => {
  const staged = targetSnapshot();
  assert.doesNotThrow(() =>
    assertClutchpacksV3CanaryTargetIsExact(staged, environment)
  );
  const activated = activeProfile(staged, {
    sources: [{ ...staged.sources[0], state: "paused" }],
    sourceTest: successfulTest(),
  });
  assert.doesNotThrow(() =>
    assertClutchpacksV3CanaryTargetIsExact(activated, environment)
  );
  assert.doesNotThrow(() =>
    assertClutchpacksV3CanaryTargetIsExact({
      ...activated,
      cursors: [{ ...activated.cursors[0], generation: 2n }],
    }, environment)
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
    { ...staged, sourceRevisions: [{
      ...staged.sourceRevisions[0],
      normalizedContractVersion: "packscout.provider-observation.v0",
    }] },
    { ...staged, sourceRevisions: [{
      ...staged.sourceRevisions[0],
      mapperKey: "courtyard-provider-observation",
    }] },
    { ...staged, sourceRevisions: [{
      ...staged.sourceRevisions[0],
      mapperVersion: "2",
    }] },
    { ...staged, sourceRevisions: [{
      ...staged.sourceRevisions[0],
      identityNamespaceKey: "dataforrest-clutchpacks-records-v0",
    }] },
    { ...staged, sourceRevisions: [{
      ...staged.sourceRevisions[0],
      cursorCodecVersion: "dataforrest-cursor-v0",
    }] },
    { ...staged, cursors: [{ ...staged.cursors[0], generation: 0n }] },
    { ...staged, legacyProviderConfigRevisionCount: 1 },
    { ...staged, legacyProviderSecretVersionCount: 1 },
    { ...staged, legacyProviderCursorCheckpointCount: 1 },
    { ...staged, sources: [{
      ...staged.sources[0],
      state: "paused",
      pauseRequested: true,
    }] },
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => assertClutchpacksV3CanaryTargetIsExact(candidate, environment),
      hasCode("TARGET_V3_TOPOLOGY_NOT_EXACT"),
    );
  }
  assert.throws(
    () => assertClutchpacksV3CanaryTargetIsExact({
      ...staged,
      profiles: [{ ...staged.profiles[0], state: "active" }],
    }, environment),
    hasCode("TARGET_V3_LIFECYCLE_NOT_EXACT"),
  );
});

test("pre-resume evidence must remain at Feed start with no import lineage", () => {
  const pristine = targetSnapshot();
  assert.equal(clutchpacksV3CanaryLineageCount(pristine), 0);
  assert.doesNotThrow(() => assertClutchpacksV3CanaryTargetIsPristine(pristine));
  for (const candidate of [
    { ...pristine, importRunCount: 1 },
    { ...pristine, pageReadAttemptCount: 1 },
    { ...pristine, deliveryOccurrenceCount: 1 },
    { ...pristine, canonicalEntityCount: 1 },
    { ...pristine, currentCursorGenerationImportRunCount: 1 },
    { ...pristine, queuedOrRunningRunCount: 1 },
    { ...pristine, quarantineRecordCount: 1 },
    { ...pristine, unresolvedCurrentCursorGenerationDiagnosticCount: 1 },
    { ...pristine, cursors: [{ ...pristine.cursors[0], generation: 2n }] },
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
      () => assertClutchpacksV3CanaryTargetIsPristine(candidate),
      hasCode("TARGET_NOT_PRISTINE_FOR_RESUME"),
    );
  }
});

test("a reset generation resumes only from its current Feed start", () => {
  const reset = resetGeneration();
  assert.doesNotThrow(() =>
    assertClutchpacksV3CanaryResetGenerationAtFeedStart(reset)
  );
  assert.equal(
    determineClutchpacksV3CanaryQualificationStage(reset),
    "ready_to_resume",
  );
  assert.equal(clutchpacksV3CanaryResumeMode(reset), "reset");
  for (const candidate of [
    { ...reset, currentCursorGenerationImportRunCount: 1 },
    { ...reset, queuedOrRunningRunCount: 1 },
    { ...reset, quarantineRecordCount: 1 },
    { ...reset, unresolvedCurrentCursorGenerationDiagnosticCount: 1 },
    { ...reset, cursors: [{ ...reset.cursors[0], generation: 1n }] },
    { ...reset, cursors: [{
      ...reset.cursors[0],
      fingerprint: "a".repeat(64),
    }] },
    { ...reset, cursors: [{
      ...reset.cursors[0],
      advancedByRunId: "88888888-8888-4888-8888-888888888888",
    }] },
  ]) {
    assert.throws(
      () => assertClutchpacksV3CanaryResetGenerationAtFeedStart(candidate),
      hasCode("TARGET_RESET_GENERATION_NOT_AT_FEED_START"),
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
  const replayAtHead = completedReplay();
  const replayPaused = {
    ...replayAtHead,
    sources: [{ ...replayAtHead.sources[0], state: "paused" }],
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
    [replayAtHead, "replay_active"],
    [replayPaused, "replay_paused"],
    [{
      ...initial,
      connectionTest: { state: "failed", hasSuccessfulResult: false },
    }, "connection_test_failed"],
    [{
      ...connectionActive,
      sourceTest: { state: "fenced", hasSuccessfulResult: false },
    }, "source_test_failed"],
  ]) {
    assert.equal(determineClutchpacksV3CanaryQualificationStage(snapshot), stage);
  }
  assert.throws(
    () => determineClutchpacksV3CanaryQualificationStage({
      ...initial,
      connectionTest: { state: "succeeded", hasSuccessfulResult: false },
    }),
    hasCode("TARGET_TEST_EVIDENCE_INVALID"),
  );
  assert.throws(
    () => determineClutchpacksV3CanaryQualificationStage({
      ...connectionActive,
      sources: [{ ...connectionActive.sources[0], state: "paused" }],
    }),
    hasCode("TARGET_QUALIFICATION_EVIDENCE_INVALID"),
  );
  assert.doesNotThrow(() =>
    assertClutchpacksV3CanaryExpectedStage(
      "queue_connection_test",
      "queue_connection_test",
    )
  );
  assert.throws(
    () => assertClutchpacksV3CanaryExpectedStage(
      "queue_connection_test",
      "activate_connection",
    ),
    hasCode("TARGET_STAGE_CHANGED"),
  );
});

test("provider-capable commands require one live, available execution slot", () => {
  const ready = Object.freeze({
    liveEpochCount: 1,
    epochState: "active",
    maximumExecutionSlots: 1,
    capacityState: "available",
    snapshotPublished: true,
  });
  assert.doesNotThrow(() =>
    assertClutchpacksV3CanaryOneSlotSupervisor(ready)
  );
  for (const evidence of [
    { ...ready, liveEpochCount: 0 },
    { ...ready, epochState: "fenced_draining" },
    { ...ready, maximumExecutionSlots: 2 },
    { ...ready, capacityState: "unavailable" },
    { ...ready, snapshotPublished: false },
  ]) {
    assert.throws(
      () => assertClutchpacksV3CanaryOneSlotSupervisor(evidence),
      hasCode("TARGET_ONE_SLOT_SUPERVISOR_REQUIRED"),
    );
  }
});

test("target pause requires the exact latest succeeded head run and a stopped supervisor", () => {
  const complete = completedReplay();
  assert.deepEqual(clutchpacksV3CanaryTargetWideSafetyEvidence(complete), {
    quarantineRecords: 0,
    warningErrorCriticalDiagnostics: 0,
    unresolvedCurrentCursorGenerationDiagnostics: 0,
    targetWideEvidenceClean: true,
    protectiveActionEvidenceClear: true,
  });
  assert.deepEqual(clutchpacksV3CanaryTargetWideSafetyEvidence({
    ...complete,
    quarantineRecordCount: 1,
    warningErrorCriticalDiagnosticCount: 2,
  }), {
    quarantineRecords: 1,
    warningErrorCriticalDiagnostics: 2,
    unresolvedCurrentCursorGenerationDiagnostics: 0,
    targetWideEvidenceClean: false,
    protectiveActionEvidenceClear: false,
  });
  assert.equal(clutchpacksV3CanaryHasExactSucceededHeadRun(complete), true);
  assert.doesNotThrow(() => assertClutchpacksV3CanaryTargetCanPause(complete));
  const generationTwo = completedReplay({
    ...targetSnapshot(),
    cursors: [{ ...targetSnapshot().cursors[0], generation: 2n }],
  });
  assert.equal(
    clutchpacksV3CanaryHasExactSucceededHeadRun(generationTwo),
    true,
  );
  const alreadyPaused = {
    ...complete,
    sources: [{ ...complete.sources[0], state: "paused" }],
  };
  assert.doesNotThrow(() =>
    assertClutchpacksV3CanaryTargetCanPause(alreadyPaused)
  );
  for (const candidate of [
    { ...complete, latestRun: null },
    { ...complete, latestRun: { ...complete.latestRun, state: "running" } },
    { ...complete, latestRun: {
      ...complete.latestRun,
      reachedProviderHead: false,
    } },
    { ...complete, latestRun: {
      ...complete.latestRun,
      sourceRevisionId: "99999999-9999-4999-8999-999999999999",
    } },
    { ...complete, latestRun: {
      ...complete.latestRun,
      adapterVersion: "dataforrest-events-adapter-v1",
    } },
    { ...complete, latestRun: {
      ...complete.latestRun,
      mapperVersion: "2",
    } },
    { ...complete, latestRun: {
      ...complete.latestRun,
      connectionRevisionId: "99999999-9999-4999-8999-999999999999",
    } },
    { ...complete, latestRun: {
      ...complete.latestRun,
      cursorGeneration: 2n,
    } },
    { ...complete, latestRun: {
      ...complete.latestRun,
      configRevisionId: "99999999-9999-4999-8999-999999999999",
    } },
    { ...complete, latestRun: { ...complete.latestRun, finishedAt: null } },
    { ...complete, latestRun: {
      ...complete.latestRun,
      failureCode: "SOURCE_UPSTREAM_UNAVAILABLE",
    } },
  ]) {
    assert.equal(clutchpacksV3CanaryHasExactSucceededHeadRun(candidate), false);
    assert.throws(
      () => assertClutchpacksV3CanaryTargetCanPause(candidate),
      hasCode("TARGET_SUCCEEDED_HEAD_RUN_REQUIRED"),
    );
  }
  assert.throws(
    () => assertClutchpacksV3CanaryTargetCanPause({
      ...complete,
      queuedOrRunningRunCount: 1,
    }),
    hasCode("TARGET_RUNS_NOT_DRAINED"),
  );
  assert.throws(
    () => assertClutchpacksV3CanaryTargetCanPause({
      ...complete,
      quarantineRecordCount: 1,
    }),
    hasCode("TARGET_QUARANTINE_NOT_EMPTY"),
  );
  assert.doesNotThrow(() => assertClutchpacksV3CanaryTargetCanPause({
    ...complete,
    warningErrorCriticalDiagnosticCount: 1,
  }));
  assert.throws(
    () => assertClutchpacksV3CanaryTargetCanPause({
      ...complete,
      warningErrorCriticalDiagnosticCount: 1,
      unresolvedCurrentCursorGenerationDiagnosticCount: 1,
    }),
    hasCode("TARGET_CURRENT_GENERATION_DIAGNOSTICS_UNRESOLVED"),
  );

  const stopped = Object.freeze({
    liveEpochCount: 0,
    epochState: null,
    maximumExecutionSlots: null,
    capacityState: null,
    snapshotPublished: false,
  });
  assert.doesNotThrow(() =>
    assertClutchpacksV3CanarySupervisorStopped(stopped)
  );
  assert.throws(
    () => assertClutchpacksV3CanarySupervisorStopped({
      ...stopped,
      liveEpochCount: 1,
    }),
    hasCode("TARGET_SUPERVISOR_MUST_BE_STOPPED"),
  );
});

test("a paused completed replay remains eligible for a bounded provider-head refresh", () => {
  const completed = completedReplay();
  const paused = {
    ...completed,
    sources: [{ ...completed.sources[0], state: "paused" }],
  };
  assert.equal(
    determineClutchpacksV3CanaryQualificationStage(paused),
    "replay_paused",
  );
  assert.equal(clutchpacksV3CanaryResumeMode(paused), "refresh");
  assert.doesNotThrow(() => assertClutchpacksV3CanaryTargetCanPause(paused));

  const initial = activeProfile(targetSnapshot(), {
    sources: [{ ...targetSnapshot().sources[0], state: "paused" }],
    sourceTest: successfulTest(),
  });
  assert.equal(clutchpacksV3CanaryResumeMode(initial), "initial");
  assert.equal(clutchpacksV3CanaryResumeMode(completed), "already_active");
  assert.equal(clutchpacksV3CanaryResumeMode({
    ...paused,
    warningErrorCriticalDiagnosticCount: 1,
  }), "refresh");

  for (const candidate of [
    { ...paused, queuedOrRunningRunCount: 1 },
    { ...paused, quarantineRecordCount: 1 },
    { ...paused, unresolvedCurrentCursorGenerationDiagnosticCount: 1 },
    {
      ...paused,
      latestRun: { ...paused.latestRun, reachedProviderHead: false },
    },
  ]) {
    assert.throws(
      () => clutchpacksV3CanaryResumeMode(candidate),
      (error) => error instanceof ClutchpacksV3CanaryDriverError,
    );
  }
});

test("target pause delegates exact pins and proves the service transition idempotently", async () => {
  const complete = completedReplay();
  const paused = {
    ...complete,
    sources: [{ ...complete.sources[0], state: "paused" }],
  };
  const stopped = {
    liveEpochCount: 0,
    epochState: null,
    maximumExecutionSlots: null,
    capacityState: null,
    snapshotPublished: false,
  };
  const driverEnvironment = {
    ...environment,
    sourceDatabaseName: "packscout_dev",
    targetDatabaseName: "packscout_clutch_v3",
    targetDigest: "a".repeat(64),
  };
  let pauseInput = null;
  const dependencies = {
    async pauseSource(input) {
      pauseInput = input;
    },
    async readTarget() {
      return { snapshot: paused, supervisor: stopped };
    },
  };
  const result = await pauseClutchpacksV3CanaryTarget(
    null,
    driverEnvironment,
    complete,
    stopped,
    dependencies,
  );
  assert.deepEqual(pauseInput, {
    organizationId,
    providerId,
    sourceInstanceId: sourceId,
    sourceRevisionId,
  });
  assert.equal(result.outcome, "paused");
  assert.deepEqual(result.target, {
    state: "paused",
    queuedOrRunningRuns: 0,
    latestRunState: "succeeded",
    latestRunReachedProviderHead: true,
    latestRunExactSucceededHead: true,
    quarantineRecords: 0,
    warningErrorCriticalDiagnostics: 0,
    unresolvedCurrentCursorGenerationDiagnostics: 0,
    targetWideEvidenceClean: true,
    protectiveActionEvidenceClear: true,
  });
  assert.equal(result.supervisorLiveEpochCount, 0);
  assert.equal(result.providerCallMadeDirectly, false);

  const retried = await pauseClutchpacksV3CanaryTarget(
    null,
    driverEnvironment,
    paused,
    stopped,
    dependencies,
  );
  assert.equal(retried.outcome, "already_paused");
  await assert.rejects(
    pauseClutchpacksV3CanaryTarget(
      null,
      driverEnvironment,
      complete,
      stopped,
      {
        async pauseSource() {
          throw new Error("secret service failure");
        },
        async readTarget() {
          throw new Error("must not read");
        },
      },
    ),
    hasCode("TARGET_PAUSE_FAILED"),
  );
  await assert.rejects(
    pauseClutchpacksV3CanaryTarget(
      null,
      driverEnvironment,
      complete,
      stopped,
      {
        async pauseSource() {},
        async readTarget() {
          return { snapshot: complete, supervisor: stopped };
        },
      },
    ),
    hasCode("TARGET_PAUSE_PROOF_FAILED"),
  );
});

test("target cursor reset binds the service preview CAS and proves the next Feed start", async () => {
  const completed = completedReplay();
  const paused = {
    ...completed,
    sources: [{ ...completed.sources[0], state: "paused" }],
    warningErrorCriticalDiagnosticCount: 1,
  };
  const afterReset = resetGeneration();
  const stopped = {
    liveEpochCount: 0,
    epochState: null,
    maximumExecutionSlots: null,
    capacityState: null,
    snapshotPublished: false,
  };
  const driverEnvironment = {
    ...environment,
    sourceDatabaseName: "packscout_dev",
    targetDatabaseName: "packscout_clutch_v3",
    targetDigest: "a".repeat(64),
  };
  let previewInput = null;
  let resetInput = null;
  const preview = {
    providerId,
    provider: "clutchpacks",
    sourceInstanceId: sourceId,
    sourceRevisionId,
    sourceState: "paused",
    cursorGeneration: "1",
    cursorFingerprint: null,
    confirmation: "RESET CLUTCHPACKS",
  };
  const result = await resetClutchpacksV3CanaryTargetCursor(
    null,
    driverEnvironment,
    paused,
    stopped,
    {
      async previewCursorReset(input) {
        previewInput = input;
        return preview;
      },
      async resetCursor(input) {
        resetInput = input;
        return { cursorGeneration: "2", cursorFingerprint: null };
      },
      async readTarget() {
        return { snapshot: afterReset, supervisor: stopped };
      },
    },
  );
  assert.deepEqual(previewInput, {
    organizationId,
    providerId,
    sourceInstanceId: sourceId,
    sourceRevisionId,
  });
  assert.deepEqual(resetInput, {
    ...previewInput,
    expectedCursorGeneration: "1",
    expectedCursorFingerprint: null,
    confirmation: "RESET CLUTCHPACKS",
  });
  assert.deepEqual(result.target, {
    state: "paused",
    previousCursorGeneration: "1",
    cursorGeneration: "2",
    cursorAtFeedStart: true,
    currentCursorGenerationImportRuns: 0,
    queuedOrRunningRuns: 0,
    quarantineRecords: 0,
    warningErrorCriticalDiagnostics: 1,
    unresolvedCurrentCursorGenerationDiagnostics: 0,
  });
  assert.equal(result.outcome, "cursor_reset");
  assert.equal(result.supervisorLiveEpochCount, 0);

  await assert.rejects(
    resetClutchpacksV3CanaryTargetCursor(
      null,
      driverEnvironment,
      paused,
      stopped,
      {
        async previewCursorReset() {
          return { ...preview, cursorGeneration: "2" };
        },
        async resetCursor() {
          throw new Error("must not reset");
        },
        async readTarget() {
          throw new Error("must not read");
        },
      },
    ),
    hasCode("TARGET_CURSOR_RESET_PREVIEW_CHANGED"),
  );
  await assert.rejects(
    resetClutchpacksV3CanaryTargetCursor(
      null,
      driverEnvironment,
      paused,
      stopped,
      {
        async previewCursorReset() {
          return preview;
        },
        async resetCursor() {
          return { cursorGeneration: "3", cursorFingerprint: null };
        },
        async readTarget() {
          throw new Error("must not read");
        },
      },
    ),
    hasCode("TARGET_CURSOR_RESET_RECEIPT_INVALID"),
  );
  await assert.rejects(
    resetClutchpacksV3CanaryTargetCursor(
      null,
      driverEnvironment,
      { ...paused, sources: [{ ...paused.sources[0], state: "active" }] },
      stopped,
      {
        async previewCursorReset() {
          throw new Error("must not preview");
        },
        async resetCursor() {
          throw new Error("must not reset");
        },
        async readTarget() {
          throw new Error("must not read");
        },
      },
    ),
    hasCode("TARGET_CURSOR_RESET_REQUIRES_PAUSED_SOURCE"),
  );
});

test("failures and help output are stable and credential-free", () => {
  assert.deepEqual(
    safeClutchpacksV3CanaryDriverFailure(
      new ClutchpacksV3CanaryDriverError("TARGET_SOURCE_TEST_FAILED"),
    ),
    {
      ok: false,
      operation: "advance_clutchpacks_v3_canary",
      code: "TARGET_SOURCE_TEST_FAILED",
    },
  );
  assert.deepEqual(safeClutchpacksV3CanaryDriverFailure(
    new Error("postgresql://operator:do-not-print@example.test/secret"),
  ), {
    ok: false,
    operation: "advance_clutchpacks_v3_canary",
    code: "UNEXPECTED_CANARY_DRIVER_FAILURE",
  });
  const usage = clutchpacksV3CanaryDriverUsage();
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
  assert.match(help.stdout, /--pause-target/u);
  assert.match(help.stdout, /--resume/u);
  assert.match(help.stdout, /--reset-target-cursor/u);
  assert.doesNotMatch(help.stdout, /postgresql:\/\//u);
});
