import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { compareCanonicalStrings, deriveProviderPackInputDigests, packCatalogCanonicalByteCount, packPublicationLimits, type ProviderPackBuildInputs } from "@packscout/contracts";
import {
  ProviderPackPublicationContext, ProviderPackBuildRequestRepository, ProviderPackImpactRepository,
  ProviderPackSnapshotRepository, ProviderPackPublicationOutboxRepository, appendPromotionRange,
  type PackInputCapture, type ProviderPrismaClient,
} from "@packscout/database";
import { createProviderHarness } from "@packscout/database/test-support";
import { ProviderPackReadinessEvaluator } from "./provider-pack-readiness-evaluator.ts";
import { freshPublicationFixture, publicationHash } from "./provider-pack-publication.test-support.ts";

test("Pack publication preserves captured authority and maximum dependency evidence", async suite => {
  const harness = await createProviderHarness();
  try {
    const client = harness.client;
    const { provider_id: providerId } = await client.database_identity.findUniqueOrThrow({ where: { singleton_key: true } });
    const scope = { organizationId: randomUUID(), providerId };
    const context = new ProviderPackPublicationContext(client, scope);
    await context.initialize();
    const ids = [randomUUID(), randomUUID()].sort();
    await client.$transaction(async tx => {
      await tx.packs.createMany({ data: ids.map(id => ({ id, pack_key: id, display_name: id, pack_format: "repack" as const,
        availability: "available" as const, content_evidence: "complete" as const, packscout_ev_model_version: "weighted-value",
        packscout_ev_confidence_policy_version: "packscout-ev-policy", source_updated_at: new Date() })) });
      await appendPromotionRange(tx, ids.map(entityId => ({ entityType: "pack" as const, entityId, entityVersion: 1n, operation: "upsert" as const })));
    });
    const fixture = await freshPublicationFixture(providerId, ids[0]);
    const evaluator = new ProviderPackReadinessEvaluator();
    const requests = new ProviderPackBuildRequestRepository(context);
    const capture: PackInputCapture = {
      async capture(_tx, input) { const candidate = structuredClone(fixture.inputs);
        candidate.contents.reverse(); candidate.actions.reverse(); candidate.aliases.reverse();
        return { ...candidate, publicRepackId: input.publicRepackId, sourceRevisionIdentity: input.sourceRevisionIdentity,
          expectedDependencies: input.sharedDependencies, observedDependencies: input.sharedDependencies }; },
      evaluate: input => evaluator.evaluate(input),
    };
    await suite.test("evaluators cannot replace any transaction-captured pack data", async () => {
      // Roll back unexpected acceptance too, so each red case starts at the same boundary.
      const guardedClient = client.$extends({ query: { pack_publication_change_receipts: { async create() {
        throw new Error("test expected evaluated boundary refusal");
      } } } }) as unknown as ProviderPrismaClient;
      const mutations: Array<[string, (inputs: ProviderPackBuildInputs) => void, string]> = [
        ["pack", inputs => { inputs.publicRepackId = ids[1]!; }, "PACK_SCOPE_MISMATCH"],
        ["provider", inputs => { inputs.providerId = randomUUID(); }, "PACK_SCOPE_MISMATCH"],
        ["source", inputs => { inputs.sourceRevisionIdentity = "another:source"; }, "PACK_SCOPE_MISMATCH"],
        ["dependencies", inputs => { inputs.expectedDependencies.length = 0; inputs.observedDependencies.length = 0; }, "PACK_INPUT_INVALID"],
        ["title", inputs => { inputs.title = "Not the captured title"; }, "PACK_INPUT_INVALID"],
        ["price", inputs => { inputs.price.minorUnits += 1; }, "PACK_INPUT_INVALID"],
        ["contents", inputs => { inputs.contents[0]!.displayName = "Not the captured member"; }, "PACK_INPUT_INVALID"],
        ["profiles", inputs => { inputs.providerProfileSnapshotId = `ppfs_${"e".repeat(64)}`; }, "PACK_INPUT_INVALID"],
        ["ev", inputs => { if (inputs.ev?.status === "available") inputs.ev.amount.minorUnits += 1; }, "PACK_INPUT_INVALID"],
      ];
      for (const [name, mutate, code] of mutations) {
        const planner = new ProviderPackImpactRepository(new ProviderPackPublicationContext(guardedClient, scope), {
          ...capture, async evaluate(input) { mutate(input.candidate);
            input.candidate.contents.sort((a, b) => compareCanonicalStrings(a.publicCollectibleId, b.publicCollectibleId));
            input.candidate.evInputsSha256 = (await deriveProviderPackInputDigests(input.candidate)).evInputsSha256;
            return evaluator.evaluate(input); },
        });
        await assert.rejects(planner.plan({ kind: "shared", delivery: { ...scope, centralChangeIdentity: `mutated:${name}`,
          providerChangeSequence: "1", sharedDependencies: [{ kind: "ev_policy", identity: "policy:1", contentSha256: "a".repeat(64) }],
          payloadSha256: "b".repeat(64), leaseIdentity: randomUUID(), acknowledgmentIdentity: null } }), { code });
      }
      assert.equal(await client.pack_build_requests.count(), 0);
      assert.equal(await client.pack_publication_impact_progress.count(), 0);
      assert.equal(await client.pack_publication_change_receipts.count(), 0);
      assert.equal((await client.pack_publication_scopes.findUniqueOrThrow({ where: { provider_id: providerId } })).shared_change_sequence, 0n);
    });
    await suite.test("admission independently verifies readiness outcomes and reasons", async () => {
      const mutations: Array<[string, (inputs: ProviderPackBuildInputs) => void]> = [
        ["dependencies", inputs => { inputs.observedDependencies = [{ kind: "ev_policy", identity: "other", contentSha256: "a".repeat(64) }]; }],
        ["contents", inputs => { inputs.contentsComplete = false; }],
        ["pending EV", inputs => { inputs.evFailure = "pending"; }],
        ["technical EV", inputs => { inputs.evFailure = "technical"; }],
        ["invalid EV", inputs => { inputs.evFailure = "invalid_domain"; }],
        ["duplicate actions", inputs => { inputs.actions.push({ ...inputs.actions[0]! }); }],
      ];
      const guardedClient = client.$extends({ query: { pack_publication_change_receipts: { async create() {
        throw new Error("rollback unexpected forged readiness acceptance");
      } } } }) as unknown as ProviderPrismaClient;
      for (const [name, mutate] of mutations) {
        const planner = new ProviderPackImpactRepository(new ProviderPackPublicationContext(guardedClient, scope), {
          async capture(tx, input) { const candidate = await capture.capture(tx, input); mutate(candidate); return candidate; },
          async evaluate(input) { const result = await evaluator.evaluate(input);
            assert.notEqual(result.readiness.outcome, "ready", name);
            return { ...result, readiness: { ...result.readiness, outcome: "ready", reasonCode: null } }; },
        });
        await assert.rejects(planner.plan({ kind: "provider" }), { code: "PACK_INPUT_INVALID" }, name);
      }
      const valid = await evaluator.evaluate({ candidate: fixture.inputs, evaluatedAt: new Date().toISOString() });
      await assert.rejects(context.transaction(tx => requests.enqueueInTransaction(tx, { ...valid, boundaryIdentity: "forged:reason",
        readiness: { ...valid.readiness, reasonCode: "EV_TECHNICAL_RETRY" } })), { code: "PACK_INPUT_INVALID" });
      assert.equal(await client.pack_build_requests.count(), 0);
      assert.equal(await client.pack_publication_heads.count(), 0);
      assert.equal(await client.pack_publication_change_receipts.count(), 0);
    });
    await suite.test("later mutation of evaluator-owned objects cannot change admitted capture bytes", async () => {
      let returnedInputs: ProviderPackBuildInputs | null = null;
      let writes = 0;
      const isolatedClient = client.$extends({ query: {
        pack_publication_scopes: {
          async findUnique({ args, query }) { const row = await query(args);
            if (returnedInputs) { returnedInputs.title = "Changed during admission await"; returnedInputs = null; }
            return row; },
          async update() { throw new Error("rollback test after observing both captured requests"); },
        },
        pack_build_requests: { async create({ args, query }) {
          assert.equal((args.data.inputs_json as unknown as ProviderPackBuildInputs).title, fixture.inputs.title);
          writes += 1; return query(args);
        } },
      } }) as unknown as ProviderPrismaClient;
      const planner = new ProviderPackImpactRepository(new ProviderPackPublicationContext(isolatedClient, scope), { ...capture,
        async evaluate(input) { const result = await evaluator.evaluate(input); returnedInputs = result.inputs; return result; },
      });
      await assert.rejects(planner.plan({ kind: "provider" }), { code: "PACK_PERSISTENCE_FAILED" });
      assert.equal(writes, 2);
      assert.equal(await client.pack_build_requests.count(), 0);
      assert.equal(await client.pack_publication_impact_progress.count(), 0);
    });
    await suite.test("caller-supplied lifecycle baseline without a stored active head remains unclaimable", async () => {
      const planner = new ProviderPackImpactRepository(context, { ...capture, async capture(tx, input) {
        return { ...await capture.capture(tx, input), snapshotKind: "lifecycle_only", lifecycleBaseline: fixture.built.snapshot,
          lifecycleProvenanceIdentity: "sold-out:1" };
      } });
      await planner.plan({ kind: "provider" });
      const rows = await client.pack_build_requests.findMany();
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.state === "waiting" && row.reason_code === "INCOMPLETE_CONTENTS"));
      assert.deepEqual(await requests.claim(randomUUID()), []);
    });
    await suite.test("maximum shared delivery persists progress, request, intent and immutable operation replay", async () => {
      const inputs = structuredClone(fixture.inputs);
      inputs.expectedDependencies = Array.from({ length: 10_000 }, (_, index) => ({ kind: "ev_policy" as const,
        identity: `${String(index).padStart(5, "0")}:${"界".repeat(194)}`, contentSha256: "c".repeat(64) }));
      inputs.observedDependencies = inputs.expectedDependencies;
      assert.ok(packCatalogCanonicalByteCount(inputs) < packPublicationLimits.maximumInputBytes);
      const result = await evaluator.evaluate({ candidate: inputs, evaluatedAt: new Date().toISOString() });
      assert.equal(result.readiness.outcome, "ready");
      const planner = new ProviderPackImpactRepository(context, capture);
      const delivery = { ...scope, centralChangeIdentity: "maximum:dependencies", providerChangeSequence: "1",
        sharedDependencies: inputs.expectedDependencies, payloadSha256: "d".repeat(64), leaseIdentity: randomUUID(), acknowledgmentIdentity: null };
      const firstPage = await planner.plan({ kind: "shared", delivery });
      assert.equal(firstPage?.complete, false); assert.equal(firstPage?.outcomes.length, 1);
      assert.equal(firstPage?.acknowledgmentDigest, null);
      const progress = await client.pack_publication_impact_progress.findFirstOrThrow({ where: { shared_sequence: 1n } });
      assert.ok(packCatalogCanonicalByteCount(progress.references_json) > 4_000_000);
      const secondPage = await planner.plan({ kind: "shared", delivery });
      assert.equal(secondPage?.complete, true); assert.equal(secondPage?.outcomes.length, 1);
      assert.ok(secondPage?.acknowledgmentDigest);
      assert.deepEqual((await planner.plan({ kind: "shared", delivery }))?.outcomes, []);
      const claim = (await requests.claim(randomUUID()))[0]!;
      const { request } = await requests.load(claim);
      assert.ok(packCatalogCanonicalByteCount(request) > 2_000_000);
      const snapshots = new ProviderPackSnapshotRepository(context);
      await snapshots.sealAndEnqueueActivation(claim, fixture.built);
      const outbox = new ProviderPackPublicationOutboxRepository(context);
      const activation = (await outbox.claim(randomUUID()))[0]!;
      const intent = await outbox.load(activation);
      assert.ok(packCatalogCanonicalByteCount(intent) > 2_000_000);
      const operation = { operationId: randomUUID(), organizationId: scope.organizationId, intent,
        idempotencyKey: intent.idempotencyKey, kind: "activate_head" as const, batchIndex: null, payloadSha256: await publicationHash(intent) };
      assert.ok(packCatalogCanonicalByteCount(operation) > 100_000);
      const digest = await outbox.recordOperation(activation, operation);
      assert.equal(await outbox.recordOperation(activation, operation), digest);
      assert.deepEqual((await outbox.readOperation(activation, operation.operationId))?.operation, operation);
      assert.equal(await client.pack_publication_operations.count(), 1);
    });
    await suite.test("duplicate action identities become durable blocked work, never claimable builds", async () => {
      await client.$transaction(async tx => {
        const changed = await Promise.all(ids.map(id => tx.packs.update({ where: { id }, data: { display_name: `${id}:changed`, row_version: { increment: 1 } },
          select: { id: true, row_version: true } })));
        await appendPromotionRange(tx, changed.map(row => ({ entityType: "pack" as const,
          entityId: row.id, entityVersion: row.row_version, operation: "upsert" as const })));
      });
      const planner = new ProviderPackImpactRepository(context, { ...capture, async capture(tx, input) {
        const candidate = await capture.capture(tx, input);
        candidate.actions = [candidate.actions[0]!, { ...candidate.actions[0]! }];
        return candidate;
      } });
      const planned = await planner.plan({ kind: "provider" });
      assert.equal(planned?.complete, true);
      const rows = await client.pack_build_requests.findMany({ where: { id: { in: planned!.outcomes.map(row => row.requestId) } } });
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.state === "blocked" && row.reason_code === "INVALID_DOMAIN_DATA" && row.request_json === null));
      assert.deepEqual(await requests.claim(randomUUID()), []);
    });
  } finally { await harness.close(); }
});

test("Authoritative pack heads retire stale episodes without losing valid prepared builds", async suite => {
  const harness = await createProviderHarness();
  try {
    const client = harness.client;
    const { provider_id: providerId } = await client.database_identity.findUniqueOrThrow({ where: { singleton_key: true } });
    const context = new ProviderPackPublicationContext(client, { organizationId: randomUUID(), providerId });
    await context.initialize();
    const requests = new ProviderPackBuildRequestRepository(context);
    const snapshots = new ProviderPackSnapshotRepository(context);
    const outbox = new ProviderPackPublicationOutboxRepository(context);
    const evaluator = new ProviderPackReadinessEvaluator();
    for (const kind of ["build", "activation"] as const) for (const change of ["generation", "epoch"] as const) {
      for (const state of ["ready", "publishing", "retry_scheduled"] as const) {
        await suite.test(`${change} change fences ${state} ${kind} work`, async () => {
          const id = randomUUID();
          await client.$transaction(async tx => {
            await tx.packs.create({ data: { id, pack_key: id, display_name: id, pack_format: "repack",
              availability: "available", content_evidence: "complete", packscout_ev_model_version: "weighted-value",
              packscout_ev_confidence_policy_version: "packscout-ev-policy", source_updated_at: new Date() } });
            await appendPromotionRange(tx, [{ entityType: "pack", entityId: id, entityVersion: 1n, operation: "upsert" }]);
          });
          const fixture = await freshPublicationFixture(providerId, id);
          const value = await evaluator.evaluate({ candidate: fixture.inputs, evaluatedAt: new Date().toISOString() });
          const planned = await context.transaction(tx => requests.enqueueInTransaction(tx, { ...value, boundaryIdentity: id }));
          let workId = planned.requestId;
          if (kind === "activation") {
            const claim = (await requests.claim(randomUUID()))[0]!;
            workId = (await snapshots.sealAndEnqueueActivation(claim, fixture.built)).intent.intentId;
          }
          const repository = kind === "build" ? requests : outbox;
          const owned = state === "ready" ? null : (await repository.claim(randomUUID()))[0]!;
          if (state === "retry_scheduled") await context.defer(owned!, "retry_scheduled", "TRANSPORT_TIMEOUT");
          const head = { providerId, publicRepackId: id, generation: 1, publicationEpoch: change === "epoch" ? 1 : 0,
            held: false, holdReason: null, latestAcceptedPackPublicationSequence: planned.sequence,
            activeSnapshot: fixture.built.snapshot.identity, previousSnapshot: null,
            indexableSummary: fixture.built.snapshot.payload.summaryProjection, activatedAt: new Date().toISOString() };
          await outbox.observeHead(head);
          await outbox.observeHead(head);
          if (owned) await assert.rejects(context.renew(owned), { code: "PACK_LEASE_LOST" });
          const row = kind === "build" ? await client.pack_build_requests.findUniqueOrThrow({ where: { id: workId } }) :
            await client.pack_activation_intents.findUniqueOrThrow({ where: { id: workId } });
          if (kind === "build" && change === "generation") {
            assert.equal(row.state, state);
            await client.pack_build_requests.update({ where: { id: workId }, data: { available_at: new Date(0) } });
            const replacement = (await requests.claim(randomUUID()))[0]!;
            assert.equal(replacement.workId, workId);
            await context.defer(replacement, "superseded", "ACTIVATION_CONFLICT");
          } else {
            assert.equal(row.state, "superseded");
            assert.equal(row.reason_code, "ACTIVATION_CONFLICT");
            assert.deepEqual(await repository.claim(randomUUID()), []);
          }
          assert.equal((await client.pack_publication_heads.findUniqueOrThrow({ where: { public_repack_id: id } })).generation, 1n);
        });
      }
    }
    for (const changedBaseline of [false, true]) await suite.test(`lifecycle capture survives only an unchanged baseline: ${changedBaseline}`, async () => {
      const id = randomUUID();
      await client.$transaction(async tx => {
        await tx.packs.create({ data: { id, pack_key: id, display_name: id, pack_format: "repack", availability: "available",
          content_evidence: "complete", packscout_ev_model_version: "weighted-value",
          packscout_ev_confidence_policy_version: "packscout-ev-policy", source_updated_at: new Date() } });
        await appendPromotionRange(tx, [{ entityType: "pack", entityId: id, entityVersion: 1n, operation: "upsert" }]);
      });
      const fixture = await freshPublicationFixture(providerId, id);
      const value = await evaluator.evaluate({ candidate: fixture.inputs, evaluatedAt: new Date().toISOString() });
      const first = await context.transaction(tx => requests.enqueueInTransaction(tx, { ...value, boundaryIdentity: id }));
      await snapshots.sealAndEnqueueActivation((await requests.claim(randomUUID()))[0]!, fixture.built);
      const head = { providerId, publicRepackId: id, generation: 1, publicationEpoch: 0, held: false, holdReason: null,
        latestAcceptedPackPublicationSequence: first.sequence, activeSnapshot: fixture.built.snapshot.identity, previousSnapshot: null,
        indexableSummary: fixture.built.snapshot.payload.summaryProjection, activatedAt: new Date().toISOString() };
      await outbox.observeHead(head);
      const lifecycle = await evaluator.evaluate({ candidate: { ...fixture.inputs, snapshotKind: "lifecycle_only",
        lifecycleProvenanceIdentity: "lifecycle:head-test" }, previousSnapshot: fixture.built.snapshot, evaluatedAt: new Date().toISOString() });
      assert.equal(lifecycle.readiness.outcome, "ready");
      const pending = await context.transaction(tx => requests.enqueueInTransaction(tx, { ...lifecycle, boundaryIdentity: `${id}:lifecycle` }));
      const owned = (await requests.claim(randomUUID()))[0]!;
      const replacement = changedBaseline ? await freshPublicationFixture(providerId, id) : fixture;
      if (changedBaseline) assert.notEqual(replacement.built.snapshot.identity.publicPackSnapshotId, fixture.built.snapshot.identity.publicPackSnapshotId);
      await outbox.observeHead({ ...head, generation: 2, activeSnapshot: replacement.built.snapshot.identity,
        indexableSummary: replacement.built.snapshot.payload.summaryProjection });
      await assert.rejects(requests.renew(owned), { code: "PACK_LEASE_LOST" });
      const row = await client.pack_build_requests.findUniqueOrThrow({ where: { id: pending.requestId } });
      assert.equal(row.state, changedBaseline ? "superseded" : "publishing");
      const claims = await requests.claim(randomUUID());
      if (changedBaseline) assert.deepEqual(claims, []);
      else { assert.equal(claims[0]?.workId, pending.requestId); await context.defer(claims[0]!, "superseded", "ACTIVATION_CONFLICT"); }
      assert.equal((await client.pack_build_requests.findUniqueOrThrow({ where: { id: first.requestId } })).state, "published");
    });
  } finally { await harness.close(); }
});
