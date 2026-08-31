import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { db, digest, failedHeadPostgresFixture, failedHeadResumeGuard, postgresBinDirectory } from "./provider-failed-head-chain-postgres-fixture.mjs";

function auditView(client, transform) {
  return new Proxy(client, { get(target, key, receiver) {
    if (key !== "local_audit_events") return Reflect.get(target, key, receiver);
    return new Proxy(target.local_audit_events, { get(delegate, operation, innerReceiver) {
      if (operation !== "findMany") return Reflect.get(delegate, operation, innerReceiver);
      return async args => transform(structuredClone(await delegate.findMany(args)), args);
    } });
  } });
}
async function history(client) {
  return { runs: await client.provider_runs.findMany({ orderBy: { id: "asc" } }),
    commands: await client.control_commands.findMany({ orderBy: { id: "asc" } }),
    pages: await client.provider_run_pages.findMany({ orderBy: { id: "asc" } }),
    audits: await client.local_audit_events.findMany({ orderBy: { sequence: "asc" } }) };
}

test("real queued-run startup and no-page failure admit exactly the reviewed continuation lifecycle", async context => {
  const bin = await postgresBinDirectory();
  if (!bin) { context.skip("PostgreSQL is required for an owned socket-only fixture."); return; }
  const f = await failedHeadPostgresFixture(bin), { client } = f;
  const guard = failedHeadResumeGuard(f.review, f.cursor, { owner: "fixture:next", fence: BigInt(f.review.importFence) });
  const proof = database => db.readProviderFailedHeadChainProof(database, guard, f.review.pins.operatorId,
    f.review.pins.operationId, BigInt(f.review.generation));
  try {
    const before = await history(client), runtime = await f.runtime();
    const started = f.audits.find(row => row.action === "provider.run.started");
    const transition = f.audits.find(row => row.action === "provider.runtime.transition" && row.details.toState === "running");
    const terminal = f.audits.find(row => row.action === "provider.command.terminal" && row.command_id === f.ids.command);
    assert.ok(started); assert.ok(transition); assert.ok(terminal);
    assert.equal(started.actor_operator_id, f.review.pins.operatorId);
    assert.equal(transition.actor_operator_id, null);
    assert.deepEqual(started.details, { runId: f.leaf.id, leaseFence: f.leaf.worker_fence.toString() });
    assert.equal(started.occurred_at.toISOString(), f.leaf.started_at.toISOString());
    assert.equal(f.leaf.state, "failed"); assert.equal(f.leaf.page_count, 0); assert.equal(f.leaf.accepted_count, 0);
    assert.equal(f.leaf.final_cursor_hash, f.hash);
    assert.deepEqual(before.pages.map(row => row.provider_run_id), [f.prior.id]);
    const accepted = await proof(client);
    assert.match(accepted ?? "", /^[a-f0-9]{64}$/u, "Actual queued-start operator and runner audits must be accepted.");
    assert.equal(await proof(client), accepted, "Read-only proof is stable.");

    const cases = [
      ["started wrong operator", started, row => { row.actor_operator_id = randomUUID(); }],
      ["started missing operator", started, row => { row.actor_operator_id = null; }],
      ["runner impersonates operator", transition, row => { row.actor_operator_id = f.review.pins.operatorId; }],
      ["started wrong command", started, row => { row.command_id = f.root.control_command_id; }],
      ["started wrong run target", started, row => { row.target_id = f.root.id; }],
      ["started wrong run detail", started, row => { row.details.runId = f.root.id; }],
      ["started wrong fence", started, row => { row.details.leaseFence = (f.leaf.worker_fence + 1n).toString(); }],
      ["started wrong timestamp", started, row => { row.occurred_at = new Date(row.occurred_at.getTime() + 1); }],
      ["started unknown detail", started, row => { row.details.unreviewed = true; }],
      ["runner wrong generation", transition, row => { row.details.stateGeneration = (BigInt(f.review.generation) + 1n).toString(); }],
      ["runner wrong target", transition, row => { row.target_id = randomUUID(); }],
      ["runner wrong prior state", transition, row => { row.details.fromState = "error"; }],
      ["runner wrong command binding", transition, row => { row.command_id = f.ids.command; }],
      ["terminal wrong command", terminal, row => { row.command_id = f.ids.resume; }],
      ["terminal wrong generation", terminal, row => { row.details.stateGeneration = "999"; }],
      ["terminal wrong outcome", terminal, row => { row.outcome = "failure"; }],
      ["started before queued", started, row => { row.sequence = 0n; }],
    ];
    for (const [name, selected, mutate] of cases) await context.test(name, async () => {
      const changed = auditView(client, (rows, args) => {
        if (args.where.correlation_id === f.previousReview.pins.operationId) {
          const row = rows.find(value => value.sequence === selected.sequence); assert.ok(row); mutate(row);
        }
        return rows;
      });
      assert.equal(await proof(changed), null, name);
    });
    for (const [name, transform] of [
      ["missing startup", rows => rows.filter(row => row.sequence !== started.sequence)],
      ["duplicate startup", rows => [...rows, { ...structuredClone(started), sequence: rows.at(-1).sequence + 1n }]],
      ["unknown correlated action", rows => [...rows, { ...structuredClone(started), sequence: rows.at(-1).sequence + 1n, action: "provider.unreviewed" }]],
    ]) await context.test(name, async () => {
      assert.equal(await proof(auditView(client, (rows, args) => args.where.correlation_id === f.previousReview.pins.operationId ? transform(rows) : rows)), null);
    });
    assert.deepEqual(await history(client), before, "Tamper views cannot rewrite immutable PostgreSQL history.");
    assert.deepEqual(await f.runtime(), runtime);

    await context.test("public guarded Resume admits once and preserves both failures and all prior receipts", async () => {
      const ids = db.providerFailedHeadOperationIds(f.review.pins.operationId), held = await f.acquire(ids.owner);
      try {
        const input = { commandId: ids.resume, commandType: "resume", expectedGeneration: BigInt(f.review.generation),
          targetRunId: null, targetQuarantineId: null, idempotencyKey: ids.resumeKey, requestedByOperatorId: f.review.pins.operatorId,
          correlationId: f.review.pins.operationId, reason: null, requestedAt: new Date(),
          expectedRuntimeGuard: failedHeadResumeGuard(f.review, f.cursor, { owner: held.owner, fence: held.fence }) };
        const repository = new db.PrismaProviderCommandRepository(client);
        assert.equal((await repository.submit(input)).outcome, "accepted");
        assert.equal((await repository.submit(input)).outcome, "deduplicated");
        const after = await history(client);
        assert.deepEqual(after.runs, before.runs); assert.deepEqual(after.pages, before.pages);
        assert.deepEqual(after.audits.slice(0, before.audits.length), before.audits);
        assert.deepEqual(after.commands.filter(row => row.id !== ids.resume), before.commands);
        assert.equal(after.commands.length, before.commands.length + 1);
        assert.equal((await f.runtime()).state_generation, runtime.state_generation + 1n);
        assert.equal((await f.runtime()).source_cursor_hash, f.hash);
        context.diagnostic(JSON.stringify({ lifecycle: "real_queued_start_and_zero_page_failure", startupAudits: 3,
          immutableRuns: before.runs.length, proofDigest: digest(accepted), sourceRequests: 0 }));
      } finally { await f.release(held); }
    });
  } finally { await f.close(); }
});
