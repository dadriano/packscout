import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const policy = await tsImport("./provider-operator-continuation-policy.mts", import.meta.url);
const state = await tsImport("./provider-operator-continuation-state.mts", import.meta.url);
const cli = await tsImport("./provider-operator-continuation.mts", import.meta.url);
const db = await tsImport("@packscout/database", import.meta.url);
const { DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION } =
  await tsImport("@packscout/contracts", import.meta.url);
const { providerDataforrestLiveIntegrationRegistry: registry } = await tsImport(
  "../../apps/worker/src/provider-dataforrest-live-integration.ts", import.meta.url);
function fixture() {
  const pins = { organizationId: crypto.randomUUID(), providerId: crypto.randomUUID(), providerKey: "phygitals",
    configId: crypto.randomUUID(), initialRunId: crypto.randomUUID(), operationId: crypto.randomUUID(), operatorId: crypto.randomUUID() };
  const integration = registry.resolve(
    pins.providerKey,
    DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
  );
  const manifest = integration.manifest;
  const cursor = value => ({ sourceInstanceId: pins.providerId, sourceRevisionId: pins.configId,
    sourceTypeKey: manifest.sourceTypeKey, adapterVersion: manifest.adapterVersion,
    cursorCodecKey: manifest.cursorCodecKey, cursorGeneration: 1, value });
  const final = cursor("protected-synthetic-final"), prior = cursor("protected-synthetic-prior");
  const finalHash = db.providerMixedCursorFingerprint(final), priorHash = db.providerMixedCursorFingerprint(prior);
  const review = policy.continuationReviewSchema.parse({ pins, sourceCommit: "a".repeat(40),
    authorization: "operator_requested_one_time_continuation", expectedGeneration: "15", expectedImportFence: "9",
    expectedCheckpointHash: finalHash, expectedFailureCode: "PROVIDER_IMPORT_EXECUTION_FAILED",
    expectedFinishedAt: "2026-08-31T00:08:17.949Z", expectedPageCount: 2 });
  const authority = { integration, configNumber: 4n, digest: "b".repeat(64), cachedConfiguration: {
    adapterKey: manifest.adapterVersion, settings: { platform: pins.providerKey } }, expiresAt: null, scheduleSeconds: 3600,
    route: { organizationId: pins.organizationId, configVersionId: pins.configId,
      node: { host: "127.0.0.1", port: 55435, sslMode: "disable" },
      target: { providerId: pins.providerId, providerKey: pins.providerKey, databaseName: "packscout_phygitals" } } };
  const page = (number, requested, next, quarantines) => ({ page_number: number, continuation: "more",
    requested_cursor_hash: requested, next_cursor_hash: next, record_count: 100,
    accepted_count: 100 - quarantines, duplicate_count: 0, quarantined_count: quarantines,
    catalog_record_count: 0, pull_record_count: 100, market_event_record_count: 0, material_change_count: 0 });
  const pages = [page(1, null, priorHash, 1), page(2, priorHash, finalHash, 0)];
  const parent = { id: pins.initialRunId, config_version_id: pins.configId, config_version_number: 4n, state: "failed",
    failure_code: review.expectedFailureCode, finished_at: new Date(review.expectedFinishedAt), reached_source_head: false,
    requested_cursor: null, requested_cursor_hash: null, final_cursor: final, final_cursor_hash: finalHash,
    page_count: 2, catalog_record_count: 0, pull_record_count: 200, market_event_record_count: 0,
    accepted_count: 199, duplicate_count: 0, quarantined_count: 1, material_change_count: 0 };
  const snapshot = { parent, pages, lastCursor: structuredClone(final) };
  return { review, authority, snapshot, final };
}
test("Phygitals continuation accepts a real origin only as historical input and preserves 100-record pages with quarantine", () => {
  const f = fixture(); state.assertContinuationParent(f.snapshot, f.review, f.authority);
  assert.equal(f.authority.integration.manifest.requestBounds.pageLimit, 100);
  const before = structuredClone(f.snapshot);
  for (const mutate of [s => { s.parent.final_cursor = null; }, s => { s.parent.final_cursor.value = null; },
    s => { s.parent.reached_source_head = true; }, s => { s.lastCursor.value = "tampered"; },
    s => { s.parent.final_cursor.sourceRevisionId = crypto.randomUUID(); }, s => { s.pages[0].continuation = "head"; },
    s => { s.pages[1].requested_cursor_hash = "f".repeat(64); }, s => { s.parent.quarantined_count = 0; },
    s => { s.parent.page_count = 3; }, s => { s.parent.failure_code = "OTHER_FAILURE"; }]) {
    const s = structuredClone(before); mutate(s);
    assert.throws(() => state.assertContinuationParent(s, f.review, f.authority), /CONTINUATION_PARENT_CHECKPOINT_DRIFT/);
  }
  assert.deepEqual(f.snapshot, before);
});
test("review is explicit, strictly scoped, bounded and never relaxes automatic retry policy", async () => {
  const f = fixture(), { transientBackfillCodes } = await tsImport("./provider-backfill-supervisor-policy.mts", import.meta.url);
  assert.equal(transientBackfillCodes.has(f.review.expectedFailureCode), false);
  for (const patch of [{ authorization: "automatic" }, { expectedCheckpointHash: null }, { expectedPageCount: 0 },
    { expectedPageCount: 50001 }, { rawCursor: "secret" }]) assert.equal(policy.continuationReviewSchema.safeParse({ ...f.review, ...patch }).success, false);
  assert.deepEqual(policy.continuationIds(f.review), policy.continuationIds(structuredClone(f.review)));
  assert.notEqual(policy.continuationIds(f.review).run, f.review.pins.initialRunId);
  assert.deepEqual(cli.parseOperatorContinuationArguments(["--review-file", "/tmp/review.json", "--check-only"]), { file: "/tmp/review.json", digest: null });
  for (const args of [[], ["--apply"], ["--review-file", "relative", "--check-only"],
    ["--review-file", "/tmp/x", "--apply", "--review-digest", "protected-value"]]) {
    assert.throws(() => cli.parseOperatorContinuationArguments(args), error => !error.message.includes("protected-value"));
  }
});
test("authority rejects organization, destination, source configuration and provider substitutions", () => {
  const f = fixture(); state.assertContinuationAuthority(f.review, f.authority);
  for (const mutate of [a => { a.route.organizationId = crypto.randomUUID(); }, a => { a.route.node.port = 5432; },
    a => { a.route.target.providerKey = "courtyard"; }, a => { a.route.configVersionId = crypto.randomUUID(); },
    a => { a.route.target.databaseName = "packscout"; }, a => { a.cachedConfiguration.adapterKey = "old"; }]) {
    const a = structuredClone(f.authority); mutate(a); assert.throws(() => state.assertContinuationAuthority(f.review, a));
  }
  assert.throws(() => state.assertContinuationAuthority(f.review, f.authority, "c".repeat(64)));
});
test("process inventory refuses target and orphan writers but leaves independently scoped providers alone", () => {
  const { review } = fixture();
  const other = "10 1 node run-provider-backfill-supervisor.mts --run --provider-key courtyard\n11 10 node provider-manual-import-local.ts";
  assert.doesNotThrow(() => policy.assertNoContinuationWriter(other, review, 99));
  for (const text of [other.replaceAll("courtyard", "phygitals"), "11 1 node provider-manual-import-local.ts", "not-process-data"]) {
    assert.throws(() => policy.assertNoContinuationWriter(text, review, 99));
  }
});
test("deadline drains an in-flight callback and rejects the following write phase", async () => {
  let done, writes = 0, settled = false;
  const blocker = new Promise(resolve => { done = resolve; });
  const operation = cli.withContinuationDeadline(async active => { await blocker; active(); writes++; }, 1)
    .finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false); done();
  await assert.rejects(operation, /CONTINUATION_OPERATION_DEADLINE/); assert.equal(writes, 0);
});
test("gateway rejection translation preserves only typed continuation refusals, without serializing unknown errors", async () => {
  // tsImport isolates each import graph; obtain the refusal type from the CLI graph under test.
  let Refusal;
  try { cli.parseOperatorContinuationArguments([]); } catch (error) { Refusal = error.constructor; }
  // Cached gateway deliberately maps rejected callbacks to unavailable; policy refusals must cross as values.
  const gateway = async callback => {
    try { return { state: "reachable", value: await callback() }; }
    catch { return { state: "unreachable", failureCode: "database_unreachable" }; }
  };
  for (const code of ["CONTINUATION_PARENT_CHECKPOINT_DRIFT", "CONTINUATION_REVIEW_STALE", "CONTINUATION_WRITER_PRESENT"]) {
    const result = await gateway(() => cli.captureOperatorContinuationResult(async () => { throw new Refusal(code); }));
    assert.deepEqual(result, { state: "reachable", value: { ok: false, code } });
  }
  const unknown = new Error("private SQL, cursor or credential detail");
  unknown.code = "CONTINUATION_REVIEW_STALE";
  assert.deepEqual(await gateway(() => cli.captureOperatorContinuationResult(async () => { throw unknown; })),
    { state: "unreachable", failureCode: "database_unreachable" });
  assert.deepEqual(await gateway(() => cli.captureOperatorContinuationResult(async () => ({ phase: "check_only" }))),
    { state: "reachable", value: { ok: true, value: { phase: "check_only" } } });
});
