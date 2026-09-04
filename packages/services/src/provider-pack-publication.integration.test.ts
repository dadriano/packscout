import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  ProviderPackPublicationContext, ProviderPackBuildRequestRepository, ProviderPackImpactRepository,
  ProviderPackSnapshotRepository, ProviderPackPublicationOutboxRepository, appendPromotionRange,
  type PackInputCapture, type ProviderPrismaClient, type ProviderTransactionClient,
} from "@packscout/database";
import { createProviderHarness } from "@packscout/database/test-support";
import { derivePublicPackSnapshotId, packBuildRequestSchema, packPublicationEnvelopeSchema, providerPackBuildInputsSchema, publicPackSummaryCore, normalizePackCatalogSearchText, type ActivePackHead, type SharedProviderChangeDelivery } from "@packscout/contracts";
import { sealFixturePack } from "@packscout/contracts/test-fixtures/pack-catalog";
import { ProviderPackReadinessEvaluator } from "./provider-pack-readiness-evaluator.ts";
import { freshPublicationFixture, publicationHash } from "./provider-pack-publication.test-support.ts";

async function seedPacks(client: ProviderPrismaClient, ids: string[]) {
  await client.$transaction(async tx => {
    await tx.packs.createMany({ data: ids.map(id => ({ id, pack_key: id, display_name: id, pack_format: "repack" as const,
      availability: "available" as const, content_evidence: "complete" as const, packscout_ev_model_version: "weighted-value",
      packscout_ev_confidence_policy_version: "packscout-ev-policy", source_updated_at: new Date() })) });
    await appendPromotionRange(tx, ids.map(id => ({ entityType: "pack" as const, entityId: id, entityVersion: 1n, operation: "upsert" as const })));
  });
}
async function scopeFor(client: ProviderPrismaClient) {
  const identity = await client.database_identity.findUniqueOrThrow({ where: { singleton_key: true } });
  return { organizationId: randomUUID(), providerId: identity.provider_id };
}
function faultClient(client: ProviderPrismaClient, target: string): ProviderPrismaClient {
  return client.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
    const result = await query(args);
    if (`${model}.${operation}` === target) throw new Error("injected crash; database-target-and-credential-must-not-escape");
    return result;
  } } } }) as unknown as ProviderPrismaClient;
}

test("Provider-local planning and persistence crash matrix", async suite => {
  const [first, second] = await Promise.all([createProviderHarness(), createProviderHarness()]);
  try {
    const client = first.client;
    const scope = await scopeFor(client), otherScope = await scopeFor(second.client);
    const context = new ProviderPackPublicationContext(client, scope);
    const other = new ProviderPackPublicationContext(second.client, otherScope);
    await Promise.all([context.initialize(), other.initialize()]);
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    await seedPacks(client, ids.slice(0, 2)); await seedPacks(second.client, [ids[0]!]);
    const fixtures = await Promise.all(ids.map(id => freshPublicationFixture(scope.providerId, id)));
    const captures = new Map<string, (typeof fixtures)[number]["inputs"]>(ids.map((id, index) => [id, fixtures[index]!.inputs]));
    const evaluator = new ProviderPackReadinessEvaluator();
    const capture: PackInputCapture = {
      async capture(_tx, input) {
        const value = structuredClone(captures.get(input.publicRepackId)!);
        return { ...value, sourceRevisionIdentity: input.sourceRevisionIdentity,
          expectedDependencies: input.sharedDependencies, observedDependencies: input.sharedDependencies };
      },
      evaluate: input => evaluator.evaluate(input),
    };
    const planner = new ProviderPackImpactRepository(context, capture);
    const requests = new ProviderPackBuildRequestRepository(context);
    const snapshots = new ProviderPackSnapshotRepository(context);
    const outbox = new ProviderPackPublicationOutboxRepository(context);
    const change = async (tx: ProviderTransactionClient, id: string, version = 1n) => appendPromotionRange(tx,
      [{ entityType: "pack", entityId: id, entityVersion: version, operation: "upsert" }]);

    await suite.test("shared input representation mismatches refuse before progress or acknowledgment", async () => {
      const delivery: SharedProviderChangeDelivery = { ...scope, centralChangeIdentity: "invalid:boundary", providerChangeSequence: "1",
        sharedDependencies: [], payloadSha256: "a".repeat(64), leaseIdentity: randomUUID(), acknowledgmentIdentity: null };
      for (const kind of ["category", "collectible_profile", "valuation"] as const) {
        await assert.rejects(planner.plan({ kind: "shared", delivery: { ...delivery,
          sharedDependencies: [{ kind, identity: "not-a-native-id", contentSha256: "b".repeat(64) }] } }), { code: "PACK_INPUT_INVALID" });
      }
      for (const providerChangeSequence of ["9223372036854775808", "9".repeat(30)]) {
        await assert.rejects(planner.plan({ kind: "shared", delivery: { ...delivery, providerChangeSequence } }), { code: "PACK_INPUT_INVALID" });
      }
      assert.equal(await client.pack_publication_impact_progress.count(), 0);
      assert.equal(await client.pack_publication_change_receipts.count(), 0);
      assert.equal(await client.pack_build_requests.count(), 0);
      assert.equal((await client.pack_publication_scopes.findUniqueOrThrow({ where: { provider_id: scope.providerId } })).shared_change_sequence, 0n);
    });
    await suite.test("capture recomputes every readiness digest before allocating a request", async () => {
      const value = await evaluator.evaluate({ candidate: fixtures[0]!.inputs, evaluatedAt: new Date().toISOString() });
      for (const key of ["contentsSha256", "probabilityInputsSha256", "valuationInputsSha256", "evInputsSha256"] as const) {
        const forged = structuredClone(value); forged.readiness[key] = "f".repeat(64);
        await assert.rejects(context.transaction(async tx => {
          await requests.enqueueInTransaction(tx, { ...forged, boundaryIdentity: `forged:${key}` });
          // Keep the red regression isolated even if an invalid request is accepted.
          throw new Error("test expected forged readiness refusal");
        }), { code: "PACK_INPUT_INVALID" });
        assert.equal(await client.pack_build_requests.count(), 0);
        assert.equal(await client.pack_publication_heads.count(), 0);
      }
    });
    await suite.test("profile prerequisites are derived from the captured provider and members", async () => {
      const value = await evaluator.evaluate({ candidate: fixtures[0]!.inputs, evaluatedAt: new Date().toISOString() });
      const wrong = `ppfs_${"f".repeat(64)}`;
      for (const requiredProfileSnapshotIds of [[wrong], [], value.readiness.requiredProfileSnapshotIds.slice(1),
        [...value.readiness.requiredProfileSnapshotIds, wrong].sort()]) {
        await assert.rejects(context.transaction(async tx => {
          await requests.enqueueInTransaction(tx, { ...value, boundaryIdentity: "forged:profiles",
            readiness: { ...value.readiness, requiredProfileSnapshotIds } });
          throw new Error("test expected profile prerequisite refusal");
        }), { code: "PACK_INPUT_INVALID" });
        assert.equal(await client.pack_build_requests.count(), 0);
        assert.equal(await client.pack_publication_heads.count(), 0);
      }
    });
    await suite.test("planning crash before/after enqueue or checkpoint never loses a boundary", async () => {
      for (const failure of ["pack_build_requests.create", "pack_publication_change_receipts.create", "pack_publication_scopes.update"]) {
        const broken = new ProviderPackImpactRepository(new ProviderPackPublicationContext(faultClient(client, failure), scope), capture);
        await assert.rejects(broken.plan({ kind: "provider" }), { message: "PACK_PERSISTENCE_FAILED" });
        assert.equal(await client.pack_build_requests.count(), 0);
        assert.equal(await client.pack_publication_impact_progress.count(), 0);
        assert.equal((await client.pack_publication_scopes.findUniqueOrThrow({ where: { provider_id: scope.providerId } })).change_sequence, 0n);
      }
      const result = await planner.plan({ kind: "provider" });
      assert.deepEqual(result?.outcomes.map(row => row.publicRepackId), ids.slice(0, 2));
      assert.equal(result?.complete, true); assert.ok(result?.acknowledgmentDigest);
      assert.equal(await planner.plan({ kind: "provider" }), null);
      assert.equal(await client.pack_build_requests.count(), 2);
      // Sequence gaps after rollback are expected; committed desired states are strictly ordered.
      assert.ok(BigInt(result!.outcomes[0]!.sequence) < BigInt(result!.outcomes[1]!.sequence));
    });
    await suite.test("duplicate source observations coalesce and irrelevant facts produce no work", async () => {
      const recorded = await client.pack_build_requests.findFirstOrThrow({ where: { public_repack_id: ids[0] } });
      const value = await evaluator.evaluate({ candidate: providerPackBuildInputsSchema.parse(recorded.inputs_json), evaluatedAt: new Date().toISOString() });
      const noChange = await context.transaction(tx => requests.enqueueInTransaction(tx, { ...value, boundaryIdentity: "repeat:1" }));
      assert.equal(noChange.outcome, "no_change");
      await client.$transaction(async tx => {
        const id = randomUUID();
        await tx.pulls.create({ data: { id, pull_key: id, fact_digest: "a".repeat(64), pack_id: ids[0], pack_key: ids[0],
          item_count: 1, occurred_at: new Date() } });
        const item = await tx.pull_items.create({ data: { pull_id: id, ordinal: 1, quantity: 1n } });
        await appendPromotionRange(tx, [{ entityType: "pull", entityId: id, entityVersion: 1n, operation: "upsert" },
          { entityType: "pull_item", entityId: item.id, entityVersion: 1n, operation: "upsert" }]);
      });
      const result = await planner.plan({ kind: "provider" });
      assert.equal(result?.outcomes.length, 0);
      assert.equal(await client.pack_build_requests.count(), 2);
    });
    await suite.test("organization/provider mismatches fail before leasing or checkpointing", async () => {
      const badOrg = new ProviderPackPublicationContext(client, { ...scope, organizationId: randomUUID() });
      const badProvider = new ProviderPackPublicationContext(client, otherScope);
      for (const invalid of [badOrg, badProvider]) {
        await assert.rejects(invalid.initialize(), { code: "PACK_SCOPE_MISMATCH" });
        await assert.rejects(invalid.claim("build", randomUUID()), { code: "PACK_SCOPE_MISMATCH" });
      }
      assert.equal(await client.pack_publication_scopes.count(), 1);
      assert.equal(await second.client.pack_build_requests.count(), 0);
    });
    const claims = (await Promise.all([requests.claim(randomUUID()), requests.claim(randomUUID())])).flat();
    assert.equal(claims.length, 2); assert.equal(new Set(claims.map(claim => claim.publicRepackId)).size, 2);
    let build = claims.find(claim => claim.publicRepackId === ids[0])!;
    await suite.test("same-pack claims serialize while unrelated packs progress; stale fences cannot mutate", async () => {
      assert.deepEqual(await requests.claim(randomUUID()), []);
      await client.pack_publication_heads.update({ where: { public_repack_id: ids[0] }, data: { lease_expires_at: new Date(0) } });
      const [replacement] = await requests.claim(randomUUID()); assert.ok(replacement);
      await assert.rejects(context.renew(build), { code: "PACK_LEASE_LOST" });
      await assert.rejects(context.defer(build, "blocked", "INVALID_DOMAIN_DATA"), { code: "PACK_LEASE_LOST" });
      await assert.rejects(snapshots.sealAndEnqueueActivation(build, fixtures[0]!.built), { code: "PACK_LEASE_LOST" });
      build = replacement;
    });
    await suite.test("seal rejects coherently rehashed forged economics without writing or consuming the lease", async () => {
      const built = structuredClone(fixtures[0]!.built);
      built.snapshot.payload.economicsSha256 = "f".repeat(64);
      built.descriptor.economicsSha256 = built.snapshot.payload.economicsSha256;
      const { contents, ...header } = built.snapshot.payload;
      assert.deepEqual(contents, built.batches.flatMap(batch => batch.records));
      const contentSha256 = await publicationHash({ kind: "complete_pack", header,
        batches: built.batches.map(({ batchIndex, recordCount, byteCount, batchSha256 }) => ({ batchIndex, recordCount, byteCount, batchSha256 })) });
      const publicPackSnapshotId = derivePublicPackSnapshotId(contentSha256);
      built.snapshot.identity = { ...built.snapshot.identity, contentSha256, publicPackSnapshotId };
      built.descriptor.identity = built.snapshot.identity;
      for (const batch of [...built.batches, ...built.descriptor.batches]) batch.publicPackSnapshotId = publicPackSnapshotId;
      const { request } = await requests.load(build);
      // All declared digests, identities and batch proofs agree; only the
      // economics digest is untrue. The persistence boundary must detect that.
      await packPublicationEnvelopeSchema.parseAsync({ ...built,
        payloadSha256: await publicationHash(built.snapshot.payload), authorizationScopeSha256: await publicationHash(scope),
        intent: { intentId: randomUUID(), idempotencyKey: `activate:${request.requestId}`, snapshot: built.snapshot.identity,
          packPublicationSequence: request.packPublicationSequence, evidence: request.evidence,
          expectedHead: { generation: 0, publicationEpoch: 0, activeSnapshotId: null }, operationDigest: "a".repeat(64),
          createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
      await assert.rejects(snapshots.sealAndEnqueueActivation(build, built), { code: "PACK_INPUT_INVALID" });
      assert.equal(await client.pack_snapshot_artifacts.count(), 0);
      assert.equal(await client.pack_snapshot_batches.count(), 0);
      assert.equal(await client.pack_activation_intents.count(), 0);
      assert.equal(await client.pack_publication_operations.count(), 0);
      assert.equal(await client.pack_publication_receipts.count(), 0);
      assert.equal((await requests.load(build)).request.requestId, request.requestId);
      assert.equal((await client.pack_publication_heads.findUniqueOrThrow({ where: { public_repack_id: ids[0] } })).active_snapshot_id, null);
    });
    await suite.test("seal/artifact/batch/intent failures roll back all writes and retain the lease", async () => {
      for (const failure of ["pack_snapshot_artifacts.create", "pack_snapshot_batches.createMany", "pack_activation_intents.create", "pack_build_requests.update"]) {
        const broken = new ProviderPackSnapshotRepository(new ProviderPackPublicationContext(faultClient(client, failure), scope));
        await assert.rejects(broken.sealAndEnqueueActivation(build, fixtures[0]!.built), { message: "PACK_PERSISTENCE_FAILED" });
        assert.equal(await client.pack_snapshot_artifacts.count(), 0); assert.equal(await client.pack_activation_intents.count(), 0);
        assert.equal((await requests.load(build)).request.requestId, build.workId);
      }
      await snapshots.sealAndEnqueueActivation(build, fixtures[0]!.built);
      assert.ok(await snapshots.findActivationForRequest(build.workId));
      await assert.rejects(snapshots.sealAndEnqueueActivation(build, fixtures[0]!.built), { code: "PACK_LEASE_LOST" });
      assert.equal(await client.pack_activation_intents.count(), 1);
    });
    let activation = (await outbox.claim(randomUUID()))[0]!;
    const intent = await outbox.load(activation);
    const operation = { operationId: randomUUID(), organizationId: scope.organizationId, intent,
      idempotencyKey: intent.idempotencyKey, kind: "activate_head" as const, batchIndex: null, payloadSha256: await publicationHash(intent) };
    let requestSha256 = "";
    await suite.test("operation bytes and scope are immutable and bounded", async () => {
      await assert.rejects(outbox.recordOperation(activation, { ...operation, organizationId: otherScope.organizationId }), { code: "PACK_SCOPE_MISMATCH" });
      await assert.rejects(outbox.recordOperation(activation, { ...operation, payloadSha256: "f".repeat(64) }), { code: "PACK_INPUT_INVALID" });
      requestSha256 = await outbox.recordOperation(activation, operation);
      assert.equal(await outbox.recordOperation(activation, operation), requestSha256);
      await assert.rejects(outbox.recordOperation(activation, { ...operation, operationId: randomUUID() }), { code: "PACK_STATE_CONFLICT" });
      assert.equal(await client.pack_publication_operations.count(), 1);
    });
    const receipt = { operationId: operation.operationId, requestSha256,
      result: { outcome: "applied", state: "published", reasonCode: null }, completedAt: new Date().toISOString() };
    const head: ActivePackHead = { providerId: scope.providerId, publicRepackId: ids[0]!, generation: 1, publicationEpoch: 0,
      held: false, holdReason: null, latestAcceptedPackPublicationSequence: activation.sequence, activeSnapshot: intent.snapshot,
      previousSnapshot: null, indexableSummary: fixtures[0]!.built.snapshot.payload.summaryProjection, activatedAt: receipt.completedAt };
    await suite.test("receipt-before-completion recovery does not duplicate logical publication", async () => {
      const broken = new ProviderPackPublicationOutboxRepository(new ProviderPackPublicationContext(faultClient(client, "pack_publication_receipts.create"), scope));
      await assert.rejects(broken.recordReceipt(activation, receipt), { message: "PACK_PERSISTENCE_FAILED" });
      assert.equal(await client.pack_publication_receipts.count(), 0);
      await outbox.recordReceipt(activation, receipt);
      await outbox.recordReceipt(activation, receipt);
      await assert.rejects(outbox.recordReceipt(activation, { ...receipt, requestSha256: "f".repeat(64) }), { code: "PACK_INPUT_INVALID" });
      await client.pack_publication_heads.update({ where: { public_repack_id: ids[0] }, data: { lease_expires_at: new Date(0) } });
      const expired = activation; activation = (await outbox.claim(randomUUID()))[0]!;
      await assert.rejects(outbox.recordReceipt(expired, receipt), { code: "PACK_LEASE_LOST" });
      await assert.rejects(outbox.complete(expired, operation.operationId, head), { code: "PACK_LEASE_LOST" });
      assert.deepEqual((await outbox.readOperation(activation, operation.operationId))?.receipt, receipt);
      const brokenComplete = new ProviderPackPublicationOutboxRepository(new ProviderPackPublicationContext(faultClient(client, "pack_publication_heads.update"), scope));
      await assert.rejects(brokenComplete.complete(activation, operation.operationId, head), { message: "PACK_PERSISTENCE_FAILED" });
      assert.equal((await client.pack_activation_intents.findUniqueOrThrow({ where: { id: activation.workId } })).state, "publishing");
      await outbox.complete(activation, operation.operationId, head);
      assert.equal((await client.pack_publication_heads.findUniqueOrThrow({ where: { public_repack_id: ids[0] } })).generation, 1n);
    });
    await suite.test("later identical bytes reuse an artifact but create a new immutable activation episode", async () => {
      await client.$transaction(async tx => {
        await tx.packs.update({ where: { id: ids[0] }, data: { source_updated_at: new Date(), row_version: { increment: 1 } } });
        await change(tx, ids[0]!, 2n);
      });
      const result = await planner.plan({ kind: "provider" });
      assert.equal(result?.outcomes[0]?.outcome, "change");
      const [next] = await requests.claim(randomUUID()); assert.ok(next);
      const sealed = await snapshots.sealAndEnqueueActivation(next, fixtures[0]!.built);
      assert.equal(sealed.artifact, "reused"); assert.notEqual(sealed.intent.intentId, intent.intentId);
      assert.ok(BigInt(sealed.intent.packPublicationSequence) > BigInt(intent.packPublicationSequence));
      assert.equal(await client.pack_snapshot_artifacts.count(), 1); assert.equal(await client.pack_activation_intents.count(), 2);
      await assert.rejects(client.pack_activation_intents.update({ where: { id: intent.intentId }, data: { state: "ready" } }));
    });
    await suite.test("one unreachable provider leaves source delivery pending and cannot stop a healthy provider", async () => {
      const delivery: SharedProviderChangeDelivery = { ...scope, centralChangeIdentity: "shared-policy:1", providerChangeSequence: "1",
        sharedDependencies: [{ kind: "ev_policy", identity: "policy", contentSha256: "a".repeat(64) }],
        payloadSha256: "b".repeat(64), leaseIdentity: randomUUID(), acknowledgmentIdentity: null };
      const unavailable = new ProviderPackImpactRepository(new ProviderPackPublicationContext(faultClient(client, "pack_publication_scopes.findUnique"), scope), capture);
      let acknowledged = false;
      await assert.rejects(unavailable.plan({ kind: "shared", delivery }).then(() => { acknowledged = true; }), { code: "PACK_PERSISTENCE_FAILED" });
      assert.equal(acknowledged, false); assert.equal(delivery.acknowledgmentIdentity, null);
      const otherFixture = await freshPublicationFixture(otherScope.providerId, ids[0]);
      const healthy = new ProviderPackImpactRepository(other, {
        capture: async (_tx, input) => ({ ...otherFixture.inputs, sourceRevisionIdentity: input.sourceRevisionIdentity,
          expectedDependencies: input.sharedDependencies, observedDependencies: input.sharedDependencies }), evaluate: capture.evaluate,
      });
      const healthyDelivery = { ...delivery, ...otherScope };
      const result = await healthy.plan({ kind: "shared", delivery: healthyDelivery });
      assert.equal(result?.outcomes.length, 1); assert.ok(result?.acknowledgmentDigest);
      const replay = await healthy.plan({ kind: "shared", delivery: { ...healthyDelivery, leaseIdentity: randomUUID() } });
      assert.equal(replay?.acknowledgmentDigest, result?.acknowledgmentDigest);
      await assert.rejects(healthy.plan({ kind: "shared", delivery: { ...healthyDelivery, payloadSha256: "c".repeat(64) } }), { code: "PACK_STATE_CONFLICT" });
      await assert.rejects(healthy.plan({ kind: "shared", delivery }), { code: "PACK_SCOPE_MISMATCH" });
    });
    await suite.test("hold fences owners and a new epoch creates a new episode without reopening history", async () => {
      const [owned] = await outbox.claim(randomUUID()); assert.ok(owned);
      const held: ActivePackHead = { ...head, generation: 2, publicationEpoch: 1, held: true, holdReason: "OPERATOR_HOLD" };
      await outbox.observeHead(held); await outbox.observeHead(held);
      await assert.rejects(context.renew(owned), { code: "PACK_LEASE_LOST" });
      assert.deepEqual(await outbox.claim(randomUUID()), []);
      await assert.rejects(outbox.observeHead(head), { code: "PACK_STATE_CONFLICT" });
      const previous = await client.pack_build_requests.findFirstOrThrow({ where: { public_repack_id: ids[0] }, orderBy: { pack_publication_sequence: "desc" } });
      const value = await evaluator.evaluate({ candidate: providerPackBuildInputsSchema.parse(previous.inputs_json), evaluatedAt: new Date().toISOString() });
      const replacement = await context.transaction(tx => requests.enqueueInTransaction(tx, { ...value, boundaryIdentity: "resume:1" }));
      assert.equal(replacement.outcome, "change"); assert.notEqual(replacement.requestId, previous.id);
      assert.deepEqual(await requests.claim(randomUUID()), []);
      await outbox.observeHead({ ...held, generation: 3, held: false, holdReason: null });
      const [claim] = await requests.claim(randomUUID()); assert.ok(claim);
      const sealed = await snapshots.sealAndEnqueueActivation(claim, fixtures[0]!.built);
      assert.equal(sealed.intent.expectedHead.publicationEpoch, 1); assert.equal(sealed.artifact, "reused");
      assert.equal((await client.pack_activation_intents.findUniqueOrThrow({ where: { id: intent.intentId } })).state, "published");
      await client.pack_activation_intents.update({ where: { id: sealed.intent.intentId }, data: { attempts: 20 } });
      assert.deepEqual(await outbox.claim(randomUUID()), []);
      assert.equal((await client.pack_activation_intents.findUniqueOrThrow({ where: { id: sealed.intent.intentId } })).state, "blocked");
      assert.equal((await client.pack_publication_heads.findUniqueOrThrow({ where: { public_repack_id: ids[0] } })).lease_work_id, null);
    });
    await suite.test("admission and seal independently reject forged ready lifecycle metadata", async () => {
      const fixture = fixtures[0]!;
      const value = await evaluator.evaluate({ candidate: { ...fixture.inputs, title: "Changed metadata" }, evaluatedAt: new Date().toISOString() });
      value.inputs.snapshotKind = "lifecycle_only";
      value.inputs.lifecycleBaseline = fixture.built.snapshot;
      value.inputs.lifecycleProvenanceIdentity = "lifecycle:forged";
      value.readiness.desiredStateSha256 = await publicationHash(value.inputs);
      const beforeRequests = await client.pack_build_requests.count();
      await assert.rejects(context.transaction(tx => requests.enqueueInTransaction(tx, { ...value, boundaryIdentity: "lifecycle:forged" })), { code: "PACK_INPUT_INVALID" });
      assert.equal(await client.pack_build_requests.count(), beforeRequests);
      // Deliberately seed a corrupt ready row through the test database, bypassing
      // repository admission (not database constraints), to retain the seal's independent regression.
      const previous = await client.pack_build_requests.findFirstOrThrow({ where: { public_repack_id: ids[0] }, orderBy: { pack_publication_sequence: "desc" } });
      const priorRequest = packBuildRequestSchema.parse(previous.request_json);
      await context.transaction(async tx => {
        const [allocated] = await tx.$queryRaw<Array<{ sequence: bigint }>>`SELECT nextval('pack_build_requests_pack_publication_sequence_seq') AS sequence`;
        const sequence = allocated!.sequence, id = randomUUID();
        const request = packBuildRequestSchema.parse({ ...priorRequest, requestId: id, packPublicationSequence: sequence.toString(),
          desiredStateSha256: value.readiness.desiredStateSha256, evidence: { ...priorRequest.evidence, packPublicationSequence: sequence.toString() } });
        await tx.pack_build_requests.create({ data: { ...context.where, id, public_repack_id: ids[0]!,
          pack_publication_sequence: sequence, desired_state_sha256: value.readiness.desiredStateSha256,
          expected_publication_epoch: previous.expected_publication_epoch, inputs_json: value.inputs, request_json: request, state: "ready" } });
        await tx.pack_publication_heads.update({ where: { public_repack_id: ids[0] }, data: { latest_sequence: sequence } });
      });
      const claim = (await requests.claim(randomUUID(), 25)).find(item => item.publicRepackId === ids[0]);
      assert.ok(claim);
      const payload = structuredClone(fixture.built.snapshot.payload);
      payload.snapshotKind = "lifecycle_only"; payload.title = value.inputs.title;
      payload.lifecycleFreeze = { previousSnapshotId: fixture.built.snapshot.identity.publicPackSnapshotId,
        retainedEconomicsSha256: payload.economicsSha256, provenanceIdentity: "lifecycle:forged" };
      payload.summaryProjection = publicPackSummaryCore(payload);
      payload.searchProjection.normalizedText = normalizePackCatalogSearchText([payload.title,
        ...payload.contents.map(item => item.displayName), ...payload.searchProjection.aliases].join(" "));
      const { snapshot, descriptor, batches } = await sealFixturePack(payload);
      const before = await client.pack_snapshot_artifacts.count();
      await assert.rejects(snapshots.sealAndEnqueueActivation(claim, { snapshot, descriptor, batches }), { code: "PACK_INPUT_INVALID" });
      assert.equal(await client.pack_snapshot_artifacts.count(), before);
      assert.equal(await snapshots.findActivationForRequest(claim.workId), null);
    });
    await suite.test("the greatest valid shared sequence is durably acknowledged and replayable", async () => {
      const delivery: SharedProviderChangeDelivery = { ...scope, centralChangeIdentity: "boundary:max-int64",
        providerChangeSequence: "9223372036854775807", sharedDependencies: [], payloadSha256: "a".repeat(64),
        leaseIdentity: randomUUID(), acknowledgmentIdentity: null };
      const result = await planner.plan({ kind: "shared", delivery });
      assert.equal(result?.complete, true); assert.ok(result?.acknowledgmentDigest);
      assert.equal((await planner.plan({ kind: "shared", delivery }))?.acknowledgmentDigest, result?.acknowledgmentDigest);
      assert.equal((await client.pack_publication_scopes.findUniqueOrThrow({ where: { provider_id: scope.providerId } })).shared_change_sequence, 9223372036854775807n);
    });
  } finally { await Promise.all([first.close(), second.close()]); }
});

test("Provider-local planning and persistence crash matrix: bounded fan-out and poison isolation", async () => {
  const harness = await createProviderHarness();
  try {
    const client = harness.client, scope = await scopeFor(client);
    const context = new ProviderPackPublicationContext(client, scope); await context.initialize();
    const ids = Array.from({ length: 251 }, (_, index) => `31000000-0000-4000-8000-${index.toString().padStart(12, "0")}`);
    await seedPacks(client, ids);
    const fixture = await freshPublicationFixture(scope.providerId, ids[0]);
    const evaluator = new ProviderPackReadinessEvaluator();
    const capture: PackInputCapture = {
      async capture(_tx, input) {
        const value = structuredClone(fixture.inputs);
        value.publicRepackId = input.publicRepackId; value.sourceRevisionIdentity = input.sourceRevisionIdentity;
        value.expectedDependencies = input.sharedDependencies; value.observedDependencies = input.sharedDependencies;
        if (value.publicRepackId === ids[0]) value.contents[0]!.probabilityMicros = 0;
        if (value.publicRepackId === ids[1]) value.providerProfileSnapshotId = null;
        return value;
      }, evaluate: input => evaluator.evaluate(input),
    };
    const planner = new ProviderPackImpactRepository(context, capture);
    const delivery: SharedProviderChangeDelivery = { ...scope, centralChangeIdentity: "s".repeat(200), providerChangeSequence: "9",
      sharedDependencies: [{ kind: "ev_policy", identity: "policy", contentSha256: "a".repeat(64) }],
      payloadSha256: "b".repeat(64), leaseIdentity: randomUUID(), acknowledgmentIdentity: null };
    const first = await planner.plan({ kind: "shared", delivery });
    assert.equal(first?.outcomes.length, 250); assert.equal(first?.complete, false); assert.equal(first?.acknowledgmentDigest, null);
    assert.equal(await client.pack_build_requests.count(), 250);
    const broken = new ProviderPackImpactRepository(new ProviderPackPublicationContext(faultClient(client, "pack_publication_impact_progress.update"), scope), capture);
    await assert.rejects(broken.plan({ kind: "shared", delivery }), { code: "PACK_PERSISTENCE_FAILED" });
    assert.equal(await client.pack_build_requests.count(), 250);
    const last = await planner.plan({ kind: "shared", delivery });
    assert.equal(last?.outcomes.length, 1); assert.equal(last?.complete, true); assert.ok(last?.acknowledgmentDigest);
    const replay = await planner.plan({ kind: "shared", delivery });
    assert.equal(replay?.acknowledgmentDigest, last?.acknowledgmentDigest);
    assert.ok(replay!.boundaryIdentity.length <= 200);
    await assert.rejects(planner.plan({ kind: "shared", delivery: { ...delivery, payloadSha256: "c".repeat(64) } }), { code: "PACK_STATE_CONFLICT" });
    assert.equal(await client.pack_build_requests.count(), 251);
    const rejected = await client.pack_build_requests.findFirstOrThrow({ where: { public_repack_id: ids[0] } });
    assert.equal(rejected.state, "blocked"); assert.equal(rejected.request_json, null);
    assert.deepEqual(Object.keys(rejected.inputs_json as object).sort(), ["boundaryIdentity", "providerId", "publicRepackId", "rejection", "sourceRevisionIdentity"]);
    assert.equal(await client.pack_build_requests.count({ where: { state: "waiting" } }), 1);
    const claims = await context.claim("build", randomUUID(), 25);
    assert.equal(claims.length, 25); assert.ok(claims.every(claim => claim.publicRepackId !== ids[0] && claim.publicRepackId !== ids[1]));
    await assert.rejects(context.claim("build", randomUUID(), 26), { code: "PACK_INPUT_INVALID" });
    await assert.rejects(context.claim("build", randomUUID(), 1, 301), { code: "PACK_INPUT_INVALID" });
    // Neither partial nor complete shared expansion advances the independent native ledger checkpoint.
    assert.equal((await client.pack_publication_scopes.findUniqueOrThrow({ where: { provider_id: scope.providerId } })).change_sequence, 0n);
  } finally { await harness.close(); }
});

test("Provider-local planning and persistence crash matrix: exact local membership and shared identities", async () => {
  const harness = await createProviderHarness();
  try {
    const client = harness.client, scope = await scopeFor(client);
    const context = new ProviderPackPublicationContext(client, scope); await context.initialize();
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort(); await seedPacks(client, ids);
    const fixture = await freshPublicationFixture(scope.providerId, ids[0]);
    const collectibleId = fixture.inputs.contents[1]!.publicCollectibleId;
    const categoryId = fixture.inputs.contents[1]!.category.publicCategoryId;
    const aliasId = randomUUID(), memberIds = [randomUUID(), randomUUID()];
    await client.$transaction(async tx => {
      await tx.categories.create({ data: { id: categoryId, category_key: categoryId, display_name: "Cards" } });
      await tx.collectibles.create({ data: { id: collectibleId, category_id: categoryId, collectible_key: collectibleId,
        collectible_type: "card", display_name: "Initially non-top", normalized_name: "initially non-top", data_as_of: new Date() } });
      await tx.collectible_name_aliases.create({ data: { id: aliasId, collectible_id: collectibleId, display_name: "Alias", normalized_name: "alias" } });
      await tx.pack_contents.createMany({ data: memberIds.map((id, index) => ({ id, pack_id: ids[index]!, collectible_id: collectibleId,
        content_role: "possible_outcome" as const, probability: "0.5", evidence_kinds: ["vendor_odds"], match_confidence_basis_points: 10000,
        match_confidence_band: "high", observed_at: new Date(), display_order: 0 })) });
      await appendPromotionRange(tx, [{ entityType: "category", entityId: categoryId, entityVersion: 1n, operation: "upsert" },
        { entityType: "collectible", entityId: collectibleId, entityVersion: 1n, operation: "upsert" },
        { entityType: "collectible_name_alias", entityId: aliasId, entityVersion: 1n, operation: "upsert" },
        ...memberIds.map(id => ({ entityType: "pack_content" as const, entityId: id, entityVersion: 1n, operation: "upsert" as const }))]);
    });
    const evaluator = new ProviderPackReadinessEvaluator();
    const capture: PackInputCapture = { capture: async (_tx, input) => ({ ...fixture.inputs, publicRepackId: input.publicRepackId,
      sourceRevisionIdentity: input.sourceRevisionIdentity, expectedDependencies: input.sharedDependencies, observedDependencies: input.sharedDependencies }),
      evaluate: input => evaluator.evaluate(input) };
    const planner = new ProviderPackImpactRepository(context, capture);
    await planner.plan({ kind: "provider" });
    let sharedSequence = 0;
    for (const kind of ["valuation", "collectible_profile", "category"] as const) {
      const delivery: SharedProviderChangeDelivery = { ...scope, centralChangeIdentity: `shared:${kind}`, providerChangeSequence: String(++sharedSequence),
        sharedDependencies: [{ kind, identity: kind === "category" ? categoryId : collectibleId, contentSha256: "a".repeat(64) }],
        payloadSha256: "b".repeat(64), leaseIdentity: randomUUID(), acknowledgmentIdentity: null };
      assert.deepEqual((await planner.plan({ kind: "shared", delivery }))?.outcomes.map(row => row.publicRepackId), ids.slice(0, 2));
    }
    const independentProfile: SharedProviderChangeDelivery = { ...scope, centralChangeIdentity: "provider-promotion-copy:1", providerChangeSequence: "4",
      sharedDependencies: [{ kind: "provider_profile", identity: scope.providerId, contentSha256: "a".repeat(64) }],
      payloadSha256: "b".repeat(64), leaseIdentity: randomUUID(), acknowledgmentIdentity: null };
    assert.deepEqual((await planner.plan({ kind: "shared", delivery: independentProfile }))?.outcomes, []);
    await assert.rejects(planner.plan({ kind: "shared", delivery: { ...independentProfile,
      centralChangeIdentity: "stale-shared:1", providerChangeSequence: "2" } }), { code: "PACK_STATE_CONFLICT" });
    await client.$transaction(async tx => {
      await tx.collectible_name_aliases.update({ where: { id: aliasId }, data: { display_name: "Changed alias", row_version: 2n } });
      await appendPromotionRange(tx, [{ entityType: "collectible_name_alias", entityId: aliasId, entityVersion: 2n, operation: "upsert" }]);
    });
    assert.deepEqual((await planner.plan({ kind: "provider" }))?.outcomes.map(row => row.publicRepackId), ids.slice(0, 2));
    await client.$transaction(async tx => {
      await tx.pack_contents.update({ where: { id: memberIds[0] }, data: { probability: "0.75", row_version: 2n } });
      await appendPromotionRange(tx, [{ entityType: "pack_content", entityId: memberIds[0]!, entityVersion: 2n, operation: "upsert" }]);
    });
    assert.deepEqual((await planner.plan({ kind: "provider" }))?.outcomes.map(row => row.publicRepackId), [ids[0]]);
    await client.$transaction(async tx => {
      const id = randomUUID(), now = new Date();
      await tx.pack_content_snapshots.create({ data: { id, pack_id: ids[1]!, source_key: "membership:2",
        effective_at: now, collected_at: now, effective_at_basis: "provider_updated_at", snapshot_digest: "a".repeat(64),
        completeness: "partial", normalized_snapshot: { sourceAdapterVersion: "fixture", mapperVersion: "fixture", items: [],
          privateSource: "private-source-marker" } } });
      await appendPromotionRange(tx, [{ entityType: "pack_content_snapshot", entityId: id, entityVersion: 1n, operation: "upsert" }]);
    });
    assert.deepEqual((await planner.plan({ kind: "provider" }))?.outcomes.map(row => row.publicRepackId), [ids[1]]);
    const retainedInputs = await client.pack_build_requests.findMany({ select: { inputs_json: true, request_json: true } });
    assert.equal(JSON.stringify(retainedInputs).includes("private-source-marker"), false);
    assert.ok(await client.pack_build_requests.count({ where: { state: "superseded" } }) > 0);
    const poisoned = new ProviderPackImpactRepository(context, { ...capture, capture: async (tx, input) => {
      const candidate = await capture.capture(tx, input);
      return { ...candidate, providerId: randomUUID() };
    } });
    const checkpoint = (await client.pack_publication_scopes.findUniqueOrThrow({ where: { provider_id: scope.providerId } })).change_sequence;
    await assert.rejects(poisoned.plan({ kind: "shared", delivery: { ...independentProfile, centralChangeIdentity: "wrong-scope:1",
      providerChangeSequence: "5",
      sharedDependencies: [{ kind: "valuation", identity: collectibleId, contentSha256: "b".repeat(64) }] } }), { code: "PACK_SCOPE_MISMATCH" });
    assert.equal((await client.pack_publication_scopes.findUniqueOrThrow({ where: { provider_id: scope.providerId } })).change_sequence, checkpoint);
  } finally { await harness.close(); }
});
