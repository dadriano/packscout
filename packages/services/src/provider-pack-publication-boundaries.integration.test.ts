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
  } finally { await harness.close(); }
});
