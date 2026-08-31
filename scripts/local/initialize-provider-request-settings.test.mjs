import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { assertNoRequestSettingsWriter, assertRequestSettingsInitialization,
  requestSettingsBoundaryDigest, requestSettingsInitializationSchema } = await tsImport(
  "./initialize-provider-request-settings-policy.mts", import.meta.url);
const { parseRequestSettingsInitializationArguments } = await tsImport(
  "./initialize-provider-request-settings-local.mts", import.meta.url);
const id = suffix => `337fdac5-d49d-4565-a5cb-af8d9333b60${suffix}`;
const review = {
  pins: { organizationId: id(1), providerId: id(2), providerKey: "phygitals", configId: id(3),
    initialRunId: id(4), operationId: id(5), operatorId: id(6) },
  recordsPerRequest: 1000, expectedCheckpointHash: "a".repeat(64), expectedGeneration: "15", expectedImportFence: "9",
};
function snapshot() {
  return { now: new Date(), providerId: id(2), providerKey: "phygitals", configId: id(3), configNumber: 4n,
    configurationMatches: true, state: "error", generation: 15n, checkpointHash: review.expectedCheckpointHash,
    checkpointValid: true, activeRunIds: [], actionableCommands: [], lease: { owner: null, fence: 9n, expiresAt: null },
    run: { id: id(4), configId: id(3), configNumber: 4n, state: "failed", fence: 9n,
      requestedHash: "b".repeat(64), requestedMatches: true, finalHash: review.expectedCheckpointHash,
      finalMatches: true, reachedHead: false, pageCount: 10272, accepted: 1027199,
      failureCode: "PROVIDER_IMPORT_EXECUTION_FAILED", finishedAt: new Date("2026-08-31T00:08:17.949Z"),
      committedPageCount: 10272 },
    lastPage: { number: 10272, continuation: "more", hash: review.expectedCheckpointHash, matches: true } };
}

test("initialization requires the exact stopped checkpoint, config, run and unowned lease", () => {
  assert.doesNotThrow(() => assertRequestSettingsInitialization(review, snapshot(), 4n));
  for (const change of [s => { s.state = "paused"; }, s => { s.state = "running"; },
    s => { s.generation++; }, s => { s.configId = id(7); }, s => { s.configurationMatches = false; },
    s => { s.checkpointValid = false; }, s => { s.run.finalMatches = false; },
    s => { s.lease.owner = "foreign"; }, s => { s.lease.fence++; },
    s => { s.activeRunIds.push(id(8)); }, s => { s.actionableCommands.push({id:id(8),runId:null}); },
    s => { s.lastPage.matches = false; }, s => { s.run.id = id(8); }, s => { s.run.reachedHead = true; }]) {
    const s = snapshot(); change(s);
    assert.throws(() => assertRequestSettingsInitialization(review, s, 4n));
  }
});

test("review digest ignores observation clock but detects durable boundary changes", () => {
  const a = snapshot(), b = snapshot(); b.now = new Date("2030-01-01Z");
  assert.equal(requestSettingsBoundaryDigest(a), requestSettingsBoundaryDigest(b));
  b.run.accepted++;
  assert.notEqual(requestSettingsBoundaryDigest(a), requestSettingsBoundaryDigest(b));
});

test("review validates request range, exact fields and explicit bounded apply arguments", () => {
  for (const count of [1, 1000, 5000]) assert.equal(requestSettingsInitializationSchema.safeParse({...review,recordsPerRequest:count}).success,true);
  for (const count of [0, 1.5, 5001, "1000"]) assert.equal(requestSettingsInitializationSchema.safeParse({...review,recordsPerRequest:count}).success,false);
  assert.equal(requestSettingsInitializationSchema.safeParse({...review,sourceCursor:"forbidden"}).success,false);
  assert.deepEqual(parseRequestSettingsInitializationArguments(["--review-file","/tmp/review.json","--check-only"]), {file:"/tmp/review.json",digest:null});
  assert.equal(parseRequestSettingsInitializationArguments(["--review-file","/tmp/review.json","--apply","--review-digest","b".repeat(64)]).digest,"b".repeat(64));
  for (const args of [[], ["--review-file","relative.json","--check-only"], ["--review-file","/tmp/review.json","--apply"]]) {
    assert.throws(() => parseRequestSettingsInitializationArguments(args));
  }
});

test("process check blocks matching resident/backfill writers and unknown orphans", () => {
  assert.doesNotThrow(() => assertNoRequestSettingsWriter("10 1 unrelated\n", id(2), "phygitals", 999));
  const other = "10 1 node run-provider-backfill-supervisor.mts --run --provider-key courtyard\n11 10 node provider-manual-import-local.ts\n";
  assert.doesNotThrow(() => assertNoRequestSettingsWriter(other, id(2), "phygitals", 999));
  for (const text of ["10 1 node run-provider-backfill-supervisor.mts --run --provider-key phygitals\n",
    `10 1 node run-provider-continuous-poller.mts --run --provider-id ${id(2)}\n`,
    "11 1 node provider-manual-import-local.ts\n", "malformed"]) {
    assert.throws(() => assertNoRequestSettingsWriter(text, id(2), "phygitals", 999));
  }
});
