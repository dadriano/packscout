import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { packPublicationLimits, type ActivePackHead, type ProviderPackPublicationOperation } from "@packscout/contracts";
import {
  ProviderPackPublicationContext, ProviderPackBuildRequestRepository, ProviderPackSnapshotRepository,
  ProviderPackPublicationOutboxRepository, appendPromotionRange, type PackWorkClaim, type ProviderPrismaClient,
} from "@packscout/database";
import { createProviderHarness } from "@packscout/database/test-support";
import { ProviderPackReadinessEvaluator } from "./provider-pack-readiness-evaluator.ts";
import { freshPublicationFixture, publicationHash } from "./provider-pack-publication.test-support.ts";

test("Time-dependent readiness advances immutable episodes without resetting blocked attempts", async suite => {
  const harness = await createProviderHarness();
  try {
    const client = harness.client;
    const { provider_id: providerId } = await client.database_identity.findUniqueOrThrow({ where: { singleton_key: true } });
    const context = new ProviderPackPublicationContext(client, { organizationId: randomUUID(), providerId });
    await context.initialize();
    const databaseNow = context.now.bind(context);
    let clockOffset = 0;
    context.now = async tx => new Date((await databaseNow(tx)).getTime() + clockOffset);
    const requests = new ProviderPackBuildRequestRepository(context), evaluator = new ProviderPackReadinessEvaluator();
    const prepare = async () => {
      const id = randomUUID();
      await client.$transaction(async tx => {
        await tx.packs.create({ data: { id, pack_key: id, display_name: id, pack_format: "repack",
          availability: "available", content_evidence: "complete", packscout_ev_model_version: "weighted-value",
          packscout_ev_confidence_policy_version: "packscout-ev-policy", source_updated_at: new Date() } });
        await appendPromotionRange(tx, [{ entityType: "pack", entityId: id, entityVersion: 1n, operation: "upsert" }]);
      });
      return freshPublicationFixture(providerId, id);
    };
    const enqueue = async (fixture: Awaited<ReturnType<typeof freshPublicationFixture>>, representedDigest?: string) => {
      const evaluatedAt = await context.transaction(async tx => (await context.now(tx)).toISOString());
      const value = await evaluator.evaluate({ candidate: fixture.inputs, evaluatedAt, representedDigest });
      const work = await context.transaction(tx => requests.enqueueInTransaction(tx, { ...value, boundaryIdentity: randomUUID() }));
      return { value, work };
    };
    for (const representedHint of [false, true]) await suite.test(`future EV becomes claimable with identical bytes; represented hint ${representedHint}`, async () => {
      const fixture = await prepare(), id = fixture.inputs.publicRepackId;
      clockOffset = -120_000; // Evidence is ahead of the database clock, without a wall-clock sleep.
      const initial = await enqueue(fixture);
      assert.equal(initial.value.readiness.outcome, "waiting");
      const waiting = await client.pack_build_requests.findUniqueOrThrow({ where: { id: initial.work.requestId } });
      assert.equal(waiting.request_json, null);
      assert.equal((await enqueue(fixture)).work.outcome, "no_change");
      assert.deepEqual(await requests.claim(randomUUID()), []);
      clockOffset = 0;
      const advanced = await enqueue(fixture, representedHint ? initial.value.readiness.desiredStateSha256 : undefined);
      assert.equal(advanced.value.readiness.outcome, representedHint ? "no_change" : "ready");
      assert.equal(advanced.work.outcome, "change");
      assert.notEqual(advanced.work.requestId, initial.work.requestId);
      assert.ok(BigInt(advanced.work.sequence) > BigInt(initial.work.sequence));
      const ready = await client.pack_build_requests.findUniqueOrThrow({ where: { id: advanced.work.requestId } });
      assert.equal(ready.state, "ready"); assert.ok(ready.request_json);
      assert.equal(ready.desired_state_sha256, waiting.desired_state_sha256);
      assert.deepEqual(ready.inputs_json, waiting.inputs_json);
      assert.equal((await client.pack_build_requests.findUniqueOrThrow({ where: { id: waiting.id } })).state, "superseded");
      assert.equal((await enqueue(fixture)).work.requestId, ready.id);
      const [claim] = await requests.claim(randomUUID()); assert.equal(claim?.workId, ready.id);
      assert.equal((await requests.load(claim!)).request.requestId, ready.id);
      await client.pack_build_requests.update({ where: { id: ready.id }, data: { attempts: packPublicationLimits.maximumAttempts } });
      await context.defer(claim!, "blocked", "OPERATION_EXPIRED");
      assert.equal((await enqueue(fixture)).work.requestId, ready.id, "same inputs do not reset exhausted attempts");
      assert.deepEqual(await requests.claim(randomUUID()), []);
      assert.equal(await client.pack_build_requests.count({ where: { public_repack_id: id } }), 2);
      assert.equal((await client.pack_build_requests.findUniqueOrThrow({ where: { id: ready.id } })).attempts, packPublicationLimits.maximumAttempts);
      assert.equal((await client.pack_publication_heads.findUniqueOrThrow({ where: { public_repack_id: id } })).active_snapshot_id, null);
    });
    await suite.test("expired readiness records a waiting episode once and leaves other packs independent", async () => {
      clockOffset = 0;
      const fixture = await prepare(), initial = await enqueue(fixture);
      assert.equal(initial.value.readiness.outcome, "ready");
      clockOffset = 2 * 3_600_000;
      const expired = await enqueue(fixture);
      assert.equal(expired.value.readiness.outcome, "waiting"); assert.equal(expired.work.outcome, "change");
      assert.equal((await enqueue(fixture)).work.outcome, "no_change");
      const row = await client.pack_build_requests.findUniqueOrThrow({ where: { id: expired.work.requestId } });
      assert.equal(row.request_json, null); assert.equal(row.reason_code, "EV_INPUTS_PENDING");
      assert.equal((await client.pack_build_requests.findUniqueOrThrow({ where: { id: initial.work.requestId } })).state, "superseded");
      clockOffset = 0;
      const independent = await prepare(), next = await enqueue(independent);
      const [claim] = await requests.claim(randomUUID()); assert.equal(claim?.workId, next.work.requestId);
      await context.defer(claim!, "superseded", "ACTIVATION_CONFLICT");
    });
  } finally { await harness.close(); }
});

test("Persisted publication operations survive crashes and expire only with reconciliation evidence", async suite => {
  const harness = await createProviderHarness();
  try {
    const client = harness.client;
    const { provider_id: providerId } = await client.database_identity.findUniqueOrThrow({ where: { singleton_key: true } });
    const context = new ProviderPackPublicationContext(client, { organizationId: randomUUID(), providerId });
    await context.initialize();
    const future = new ProviderPackPublicationContext(client, context.scope);
    future.now = async tx => new Date((await context.now(tx)).getTime() + 25 * 3_600_000);
    const requests = new ProviderPackBuildRequestRepository(context), evaluator = new ProviderPackReadinessEvaluator();
    const snapshots = new ProviderPackSnapshotRepository(context), outbox = new ProviderPackPublicationOutboxRepository(context);
    const expiredOutbox = new ProviderPackPublicationOutboxRepository(future);
    const enqueue = async (inputs: Awaited<ReturnType<typeof freshPublicationFixture>>["inputs"]) => {
      const value = await evaluator.evaluate({ candidate: inputs, evaluatedAt: new Date().toISOString() });
      return context.transaction(tx => requests.enqueueInTransaction(tx, { ...value, boundaryIdentity: randomUUID() }));
    };
    const prepare = async (lifetime = 72 * 3_600_000) => {
      const id = randomUUID(), fixture = await freshPublicationFixture(providerId, id, lifetime);
      await client.$transaction(async tx => {
        await tx.packs.create({ data: { id, pack_key: id, display_name: id, pack_format: "repack",
          availability: "available", content_evidence: "complete", packscout_ev_model_version: "weighted-value",
          packscout_ev_confidence_policy_version: "packscout-ev-policy", source_updated_at: new Date() } });
        await appendPromotionRange(tx, [{ entityType: "pack", entityId: id, entityVersion: 1n, operation: "upsert" }]);
      });
      await enqueue(fixture.inputs);
      const build = (await requests.claim(randomUUID(), 25)).find(claim => claim.publicRepackId === id)!;
      await snapshots.sealAndEnqueueActivation(build, fixture.built);
      const claim = (await outbox.claim(randomUUID(), 25)).find(claim => claim.publicRepackId === id)!;
      const intent = await outbox.load(claim);
      const operation = async (kind: ProviderPackPublicationOperation["kind"]) => ({
        operationId: randomUUID(), organizationId: context.scope.organizationId, intent, idempotencyKey: `${intent.intentId}:${kind}`,
        kind, batchIndex: kind === "stage_batch" ? 0 : null,
        payloadSha256: await publicationHash(kind === "activate_head" ? intent : kind === "stage_batch" ? fixture.built.batches[0] : fixture.built.descriptor),
      });
      return { fixture, id, claim, intent, operation };
    };
    const receive = async (claim: PackWorkClaim, operation: ProviderPackPublicationOperation,
      result = { outcome: "applied", state: "publishing", reasonCode: null } as const) => {
      const stored = await outbox.readOperation(claim, operation.operationId); assert.ok(stored);
      await outbox.recordReceipt(claim, { operationId: operation.operationId, requestSha256: stored.requestSha256,
        result, completedAt: new Date().toISOString() });
    };
    await suite.test("crash before receipt or ambiguity marker preserves N ahead of N+1 without delaying other packs", async () => {
      const { fixture, id, claim, intent, operation } = await prepare();
      const activation = await operation("activate_head");
      await outbox.recordOperation(claim, activation);
      const newer = await enqueue({ ...fixture.inputs, title: "New desired pack" });
      await client.pack_publication_heads.update({ where: { public_repack_id: id }, data: { lease_expires_at: new Date(0) } });
      // No defer call: the process vanished immediately after its persisted command.
      assert.deepEqual(await requests.claim(randomUUID()), []);
      const resumed = (await outbox.claim(randomUUID()))[0]!; assert.equal(resumed?.workId, claim.workId);
      await assert.rejects(outbox.readOperation(claim, activation.operationId), { code: "PACK_LEASE_LOST" });
      await assert.rejects(outbox.listOperations(claim), { code: "PACK_LEASE_LOST" });
      const discovered = await outbox.listOperations(resumed);
      assert.equal(discovered.length, 1);
      // A new process has only its reclaimed lease, not the vanished process's random operation UUID.
      const recovered = await outbox.readOperation(resumed, discovered[0]!.operationId);
      assert.deepEqual(recovered?.operation, activation);
      assert.equal(recovered?.requestSha256, discovered[0]!.requestSha256);
      assert.equal(discovered[0]!.receiptRecorded, false);
      assert.equal(await outbox.recordOperation(resumed, recovered!.operation), discovered[0]!.requestSha256);
      const independent = await prepare();
      await context.defer(independent.claim, "superseded", "ACTIVATION_CONFLICT");
      const requestSha256 = (await outbox.readOperation(resumed, activation.operationId))!.requestSha256;
      await outbox.recordReceipt(resumed, { operationId: activation.operationId, requestSha256,
        result: { outcome: "applied", state: "published", reasonCode: null }, completedAt: new Date().toISOString() });
      assert.equal((await outbox.listOperations(resumed))[0]!.receiptRecorded, true);
      await outbox.complete(resumed, activation.operationId, { providerId, publicRepackId: id, generation: 1,
        publicationEpoch: 0, held: false, holdReason: null, latestAcceptedPackPublicationSequence: claim.sequence,
        activeSnapshot: intent.snapshot, previousSnapshot: null, indexableSummary: fixture.built.snapshot.payload.summaryProjection,
        activatedAt: new Date().toISOString() });
      const next = (await requests.claim(randomUUID()))[0]!; assert.equal(next.workId, newer.requestId);
      await context.defer(next, "superseded", "ACTIVATION_CONFLICT");
    });
    await suite.test("authenticated receipt timestamps tolerate bounded remote clock skew without weakening identity or replay", async () => {
      const { id, claim, operation } = await prepare();
      let fixedNow = await context.transaction(tx => context.now(tx));
      const boundedContext = new ProviderPackPublicationContext(client, context.scope);
      boundedContext.now = async () => fixedNow;
      const boundedOutbox = new ProviderPackPublicationOutboxRepository(boundedContext);
      const skew = 60_000;
      for (const [kind, offset] of [["start_snapshot", -skew], ["stage_batch", skew]] as const) {
        const command = await operation(kind), requestSha256 = await outbox.recordOperation(claim, command);
        fixedNow = (await client.pack_publication_operations.findUniqueOrThrow({ where: { id: command.operationId } })).created_at;
        const receipt = { operationId: command.operationId, requestSha256,
          result: { outcome: "applied", state: "publishing", reasonCode: null } as const,
          completedAt: new Date(fixedNow.getTime() + offset).toISOString() };
        for (const invalidOffset of [-skew - 1, skew + 1]) await assert.rejects(boundedOutbox.recordReceipt(claim,
          { ...receipt, completedAt: new Date(fixedNow.getTime() + invalidOffset).toISOString() }), { code: "PACK_INPUT_INVALID" });
        await assert.rejects(boundedOutbox.recordReceipt(claim, { ...receipt, requestSha256: "f".repeat(64) }), { code: "PACK_INPUT_INVALID" });
        await boundedOutbox.recordReceipt(claim, receipt);
        await boundedOutbox.recordReceipt(claim, receipt);
        assert.deepEqual((await outbox.readOperation(claim, command.operationId))?.receipt, receipt);
        await assert.rejects(boundedOutbox.recordReceipt(claim, { ...receipt, completedAt: fixedNow.toISOString() }), { code: "PACK_STATE_CONFLICT" });
      }
      assert.equal(await client.pack_publication_receipts.count({ where: { public_repack_id: id } }), 2);
      const independent = await prepare();
      assert.deepEqual(await outbox.listOperations(independent.claim), []);
      const foreign = new ProviderPackPublicationOutboxRepository(new ProviderPackPublicationContext(client,
        { ...context.scope, organizationId: randomUUID() }));
      await assert.rejects(foreign.listOperations(claim), { code: "PACK_SCOPE_MISMATCH" });
      await context.defer(independent.claim, "superseded", "ACTIVATION_CONFLICT");
      await context.defer(claim, "superseded", "ACTIVATION_CONFLICT");
    });
    await suite.test("operation discovery is deterministic metadata only at the durable operation limit", async () => {
      const { claim, operation } = await prepare();
      const ids: string[] = [];
      for (let index = 0; index < packPublicationLimits.maximumOperations; index++) {
        const command = { ...await operation("start_snapshot"), idempotencyKey: `${claim.workId}:${index}` };
        await outbox.recordOperation(claim, command); ids.push(command.operationId);
      }
      const records = await outbox.listOperations(claim);
      assert.deepEqual(records.map(row => row.operationId), ids.sort());
      assert.ok(records.every(row => Object.keys(row).sort().join() === "operationId,receiptRecorded,requestSha256"));
      assert.ok(Buffer.byteLength(JSON.stringify(records)) < 25_000);
      await assert.rejects(outbox.recordOperation(claim, { ...await operation("start_snapshot"),
        idempotencyKey: `${claim.workId}:overflow` }), { code: "PACK_LIMIT_EXCEEDED" });
      await context.defer(claim, "blocked", "TRANSPORT_TIMEOUT");
    });
    for (const state of ["waiting", "retry_scheduled", "blocked"] as const) await suite.test(`new input preserves operation-bearing ${state} work`, async () => {
      const { fixture, id, claim, operation } = await prepare();
      const start = await operation("start_snapshot"); await outbox.recordOperation(claim, start);
      await context.defer(claim, state, "TRANSPORT_TIMEOUT");
      const newer = await enqueue({ ...fixture.inputs, title: `Later than ${state}` });
      assert.equal((await client.pack_activation_intents.findUniqueOrThrow({ where: { id: claim.workId } })).state, state);
      assert.deepEqual(await requests.claim(randomUUID()), []);
      if (state === "blocked") return; // Bounded retries require explicit recovery; newer input cannot bypass them.
      await client.pack_activation_intents.update({ where: { id: claim.workId }, data: { available_at: new Date(0) } });
      const resumed = (await outbox.claim(randomUUID()))[0]!; assert.equal(resumed.workId, claim.workId);
      await assert.rejects(context.defer(resumed, "superseded", "ACTIVATION_CONFLICT"), { code: "PACK_STATE_CONFLICT" });
      await assert.rejects(outbox.retireReconciled(resumed), { code: "PACK_STATE_CONFLICT" });
      await receive(resumed, start);
      await outbox.retireReconciled(resumed);
      await assert.rejects(outbox.renew(resumed), { code: "PACK_LEASE_LOST" });
      const next = (await requests.claim(randomUUID()))[0]!; assert.equal(next.workId, newer.requestId);
      await context.defer(next, "superseded", "ACTIVATION_CONFLICT");
      assert.equal(await client.pack_publication_operations.count({ where: { public_repack_id: id } }), 1);
      assert.equal(await client.pack_publication_receipts.count({ where: { public_repack_id: id } }), 1);
    });
    await suite.test("exhausted crash-recovery attempts pause only this pack and cannot be superseded by new input", async () => {
      const { fixture, id, claim, operation } = await prepare();
      await outbox.recordOperation(claim, await operation("activate_head"));
      await client.pack_activation_intents.update({ where: { id: claim.workId }, data: { attempts: packPublicationLimits.maximumAttempts } });
      await client.pack_publication_heads.update({ where: { public_repack_id: id }, data: { lease_expires_at: new Date(0) } });
      assert.deepEqual(await outbox.claim(randomUUID()), []);
      await enqueue({ ...fixture.inputs, title: "After retry cap" });
      assert.deepEqual(await requests.claim(randomUUID()), []);
      assert.deepEqual(await outbox.claim(randomUUID()), []);
      assert.equal((await client.pack_activation_intents.findUniqueOrThrow({ where: { id: claim.workId } })).state, "blocked");
    });
    await suite.test("a definitive refusal does not strand a later source correction behind blocked history", async () => {
      const { fixture, id, claim, operation } = await prepare();
      const activation = await operation("activate_head");
      const requestSha256 = await outbox.recordOperation(claim, activation);
      await outbox.recordReceipt(claim, { operationId: activation.operationId, requestSha256, completedAt: new Date().toISOString(),
        result: { outcome: "refused", state: "blocked", reasonCode: "INVALID_DOMAIN_DATA" } });
      await context.defer(claim, "blocked", "INVALID_DOMAIN_DATA");
      const next = await enqueue({ ...fixture.inputs, title: "Corrected source input" });
      assert.equal((await client.pack_activation_intents.findUniqueOrThrow({ where: { id: claim.workId } })).state, "superseded");
      const build = (await requests.claim(randomUUID()))[0]!; assert.equal(build.workId, next.requestId);
      await context.defer(build, "superseded", "ACTIVATION_CONFLICT");
      assert.equal(await client.pack_publication_receipts.count({ where: { public_repack_id: id } }), 1);
    });
    for (const [lifetime, newerDesired] of [[72 * 3_600_000, false], [3_600_000, false], [72 * 3_600_000, true]] as const) {
      await suite.test(`partial expiry reconciles all operations before replacement: EV ${lifetime}, newer ${newerDesired}`, async () => {
        const { fixture, id, claim, intent, operation } = await prepare(lifetime);
        const operations = await Promise.all(["start_snapshot", "stage_batch", "finalize_snapshot"].map(kind => operation(kind as ProviderPackPublicationOperation["kind"])));
        for (const command of operations) await outbox.recordOperation(claim, command);
        const activation = await operation("activate_head");
        await assert.rejects(outbox.retireReconciled(claim), { code: "PACK_STATE_CONFLICT" }, "current unexpired work is not disposable");
        const newer = newerDesired ? await enqueue({ ...fixture.inputs, title: "New desired state wins renewal" }) : null;
        await assert.rejects(expiredOutbox.recordOperation(claim, activation), { code: "PACK_STATE_CONFLICT" });
        await assert.rejects(expiredOutbox.retireReconciled(claim), { code: "PACK_STATE_CONFLICT" });
        for (const command of operations.slice(0, 2)) await receive(claim, command);
        await assert.rejects(expiredOutbox.retireReconciled(claim), { code: "PACK_STATE_CONFLICT" });
        assert.equal((await client.pack_activation_intents.findUniqueOrThrow({ where: { id: claim.workId } })).state, "publishing");
        await receive(claim, operations[2]!);
        // Attempting the next command commits safe retirement before returning its expiry refusal.
        await assert.rejects(expiredOutbox.recordOperation(claim, activation), { code: "PACK_STATE_CONFLICT" });
        assert.equal((await client.pack_activation_intents.findUniqueOrThrow({ where: { id: claim.workId } })).state, "superseded");
        await assert.rejects(expiredOutbox.retireReconciled(claim), { code: "PACK_LEASE_LOST" });
        assert.equal(await client.pack_publication_operations.count({ where: { intent_id: intent.intentId } }), 3);
        assert.equal(await client.pack_publication_receipts.count({ where: { intent_id: intent.intentId } }), 3);
        assert.equal(await client.pack_build_requests.count({ where: { public_repack_id: id } }), 2);
        const replacement = await client.pack_build_requests.findFirstOrThrow({ where: { public_repack_id: id }, orderBy: { pack_publication_sequence: "desc" } });
        assert.equal(replacement.state, lifetime === 3_600_000 ? "waiting" : "ready");
        if (newer) assert.equal(replacement.id, newer.requestId);
        if (replacement.state === "ready") {
          const build = (await requests.claim(randomUUID()))[0]!; assert.equal(build.workId, replacement.id);
          if (newer) await context.defer(build, "superseded", "ACTIVATION_CONFLICT");
          else {
            const renewed = await new ProviderPackSnapshotRepository(future).sealAndEnqueueActivation(build, fixture.built);
            assert.equal(renewed.artifact, "reused"); assert.notEqual(renewed.intent.intentId, intent.intentId);
            assert.ok(Date.parse(renewed.intent.createdAt) > Date.parse(intent.expiresAt));
            await context.defer((await outbox.claim(randomUUID()))[0]!, "superseded", "ACTIVATION_CONFLICT");
          }
        } else assert.equal(replacement.reason_code, "EV_INPUTS_PENDING");
        assert.equal((await client.pack_publication_heads.findUniqueOrThrow({ where: { public_repack_id: id } })).active_snapshot_id, null);
      });
    }
    await suite.test("replacement failure rolls back retirement and lease release with all evidence intact", async () => {
      const { id, claim, operation } = await prepare();
      const start = await operation("start_snapshot"); await outbox.recordOperation(claim, start); await receive(claim, start);
      await assert.rejects(outbox.retireReconciled(claim), { code: "PACK_STATE_CONFLICT" });
      const brokenClient = client.$extends({ query: { pack_build_requests: { async create() {
        throw new Error("injected replacement persistence failure");
      } } } }) as unknown as ProviderPrismaClient;
      const broken = new ProviderPackPublicationContext(brokenClient, context.scope); broken.now = future.now;
      await assert.rejects(new ProviderPackPublicationOutboxRepository(broken).retireReconciled(claim), { code: "PACK_PERSISTENCE_FAILED" });
      assert.equal((await client.pack_activation_intents.findUniqueOrThrow({ where: { id: claim.workId } })).state, "publishing");
      assert.equal(await client.pack_build_requests.count({ where: { public_repack_id: id } }), 1);
      assert.ok((await outbox.readOperation(claim, start.operationId))?.receipt);
      await expiredOutbox.retireReconciled(claim);
      await context.defer((await requests.claim(randomUUID()))[0]!, "superseded", "ACTIVATION_CONFLICT");
    });
    for (const mode of ["direct", "observed", "resume_observed"] as const) {
      await suite.test(`public-store already_active completes at the same generation: ${mode}`, async () => {
        const { fixture, id, claim, intent, operation } = await prepare();
        const first = await operation("activate_head"), firstDigest = await outbox.recordOperation(claim, first);
        await outbox.recordReceipt(claim, { operationId: first.operationId, requestSha256: firstDigest,
          result: { outcome: "applied", state: "published", reasonCode: null }, completedAt: new Date().toISOString() });
        const head: ActivePackHead = { providerId, publicRepackId: id, generation: 1, publicationEpoch: 0,
          held: false, holdReason: null, latestAcceptedPackPublicationSequence: claim.sequence, activeSnapshot: intent.snapshot,
          previousSnapshot: null, indexableSummary: fixture.built.snapshot.payload.summaryProjection, activatedAt: new Date().toISOString() };
        await outbox.complete(claim, first.operationId, head);
        const resumed = { ...head, publicationEpoch: 1 };
        if (mode === "resume_observed") await outbox.observeHead({ ...resumed, held: true, holdReason: "OPERATOR_HOLD" });
        await outbox.observeHead(resumed);
        await assert.rejects(outbox.observeHead({ ...resumed, held: true, holdReason: "OPERATOR_HOLD" }), { code: "PACK_STATE_CONFLICT" });
        const next = await enqueue(fixture.inputs);
        const build = (await requests.claim(randomUUID(), 25)).find(value => value.workId === next.requestId)!;
        assert.equal((await snapshots.sealAndEnqueueActivation(build, fixture.built)).artifact, "reused");
        let current = (await outbox.claim(randomUUID(), 25)).find(value => value.publicRepackId === id)!;
        const nextIntent = await outbox.load(current);
        const command = { ...await operation("activate_head"), intent: nextIntent, idempotencyKey: `${nextIntent.intentId}:activate`,
          payloadSha256: await publicationHash(nextIntent) };
        const digest = await outbox.recordOperation(current, command);
        const accepted = { ...resumed, latestAcceptedPackPublicationSequence: current.sequence };
        if (mode === "direct") {
          const bad = { ...command, operationId: randomUUID(), idempotencyKey: `${nextIntent.intentId}:bad-generation` };
          const badDigest = await outbox.recordOperation(current, bad);
          await outbox.recordReceipt(current, { operationId: bad.operationId, requestSha256: badDigest,
            result: { outcome: "applied", state: "published", reasonCode: null }, completedAt: new Date().toISOString() });
          await assert.rejects(outbox.complete(current, bad.operationId, accepted), { code: "PACK_INPUT_INVALID" });
        } else {
          // The remote write succeeded but the worker lost its response. Status advances only the sequence.
          await outbox.observeHead(accepted);
          await assert.rejects(outbox.load(current), { code: "PACK_LEASE_LOST" });
          current = (await outbox.claim(randomUUID(), 25)).find(value => value.workId === nextIntent.intentId)!;
          assert.deepEqual((await outbox.readOperation(current, command.operationId))?.operation, command);
        }
        // Exact result shape from packCatalogStore.test.ts's signed already-active response.
        const receipt = { operationId: command.operationId, requestSha256: digest,
          result: { outcome: "already_active", state: "published", reasonCode: null }, completedAt: new Date().toISOString() };
        await outbox.recordReceipt(current, receipt);
        await outbox.complete(current, command.operationId, accepted);
        const mirror = await client.pack_publication_heads.findUniqueOrThrow({ where: { public_repack_id: id } });
        assert.equal(mirror.generation, 1n); assert.equal(mirror.publication_epoch, 1n);
        assert.equal(mirror.accepted_sequence, BigInt(current.sequence)); assert.equal(mirror.held, false);
        assert.equal(mirror.active_snapshot_id, intent.snapshot.publicPackSnapshotId);
        assert.equal((await client.pack_activation_intents.findUniqueOrThrow({ where: { id: current.workId } })).state, "published");
        assert.equal(await client.pack_snapshot_artifacts.count({ where: { public_repack_id: id } }), 1);
        await outbox.observeHead(accepted);
        await assert.rejects(outbox.observeHead(resumed), { code: "PACK_STATE_CONFLICT" });
      });
    }
    for (const state of ["ready", "published"] as const) {
      await suite.test(`public-store CAS conflict in snapshot state ${state} releases newer desired work`, async () => {
        const { fixture, id, claim, operation } = await prepare();
        const start = await operation("start_snapshot"), startDigest = await outbox.recordOperation(claim, start);
        // Redeclaring already-active bytes returns applied/published, without activating this intent.
        await outbox.recordReceipt(claim, { operationId: start.operationId, requestSha256: startDigest,
          result: { outcome: "applied", state, reasonCode: null }, completedAt: new Date().toISOString() });
        const activation = await operation("activate_head"), digest = await outbox.recordOperation(claim, activation);
        const receipt = { operationId: activation.operationId, requestSha256: digest,
          result: { outcome: "conflict", state, reasonCode: "ACTIVATION_CONFLICT" }, completedAt: new Date().toISOString() };
        await outbox.recordReceipt(claim, receipt);
        assert.equal(await context.transaction(tx => context.operationsNeedReconciliation(tx, claim.workId)), false);
        await context.defer(claim, "blocked", "ACTIVATION_CONFLICT");
        const newer = await enqueue({ ...fixture.inputs, title: `Corrected after ${state} conflict` });
        const build = (await requests.claim(randomUUID(), 25)).find(value => value.workId === newer.requestId);
        assert.ok(build);
        assert.equal((await client.pack_activation_intents.findUniqueOrThrow({ where: { id: claim.workId } })).state, "superseded");
        assert.equal((await client.pack_publication_heads.findUniqueOrThrow({ where: { public_repack_id: id } })).active_snapshot_id, null);
        assert.deepEqual((await client.pack_publication_receipts.findUniqueOrThrow({ where: { operation_id: activation.operationId } })).receipt_json, receipt);
        assert.equal(await client.pack_publication_operations.count({ where: { intent_id: claim.workId } }), 2);
        await context.defer(build, "superseded", "ACTIVATION_CONFLICT");
      });
    }
    for (const outcome of ["applied", "already_applied", "already_active", "operation_expired", "conflict", "refused"] as const) {
      await suite.test(`activation receipt ${outcome} ${["conflict", "refused"].includes(outcome) ? "permits" : "prevents"} safe expiry retirement`, async () => {
        const { id, claim, operation } = await prepare();
        const activation = await operation("activate_head");
        const requestSha256 = await outbox.recordOperation(claim, activation);
        await assert.rejects(expiredOutbox.retireReconciled(claim), { code: "PACK_STATE_CONFLICT" });
        const refused = ["conflict", "refused"].includes(outcome);
        await outbox.recordReceipt(claim, { operationId: activation.operationId, requestSha256, completedAt: new Date().toISOString(),
          result: { outcome, state: outcome === "conflict" ? "ready" : outcome === "refused" ? "waiting" : outcome === "operation_expired" ? "blocked" : "published",
            reasonCode: outcome === "operation_expired" ? "OPERATION_EXPIRED" : outcome === "refused" ? "PROFILE_HEAD_MISSING" : refused ? "ACTIVATION_CONFLICT" : null } });
        if (refused) {
          await expiredOutbox.retireReconciled(claim);
          const build = (await requests.claim(randomUUID()))[0]!;
          await context.defer(build, "superseded", "ACTIVATION_CONFLICT");
        } else {
          await assert.rejects(expiredOutbox.retireReconciled(claim), { code: "PACK_STATE_CONFLICT" });
          assert.equal((await client.pack_activation_intents.findUniqueOrThrow({ where: { id: claim.workId } })).state, "publishing");
        }
        assert.equal(await client.pack_publication_operations.count({ where: { public_repack_id: id } }), 1);
        assert.equal(await client.pack_publication_receipts.count({ where: { public_repack_id: id } }), 1);
      });
    }
  } finally { await harness.close(); }
});
