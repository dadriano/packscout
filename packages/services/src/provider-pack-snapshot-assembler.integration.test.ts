import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ProviderPackPublicationContext, ProviderPackBuildRequestRepository, ProviderPackSnapshotRepository, appendPromotionRange } from "@packscout/database";
import { createProviderHarness } from "@packscout/database/test-support";
import { ProviderPackSnapshotAssembler } from "./provider-pack-snapshot-assembler.ts";
import { ProviderPackReadinessEvaluator } from "./provider-pack-readiness-evaluator.ts";
import { freshPublicationFixture } from "./provider-pack-publication.test-support.ts";

test("P02 captured request → P03 assembler → durable artifact and intent, without activation", async () => {
  const harness = await createProviderHarness();
  try {
    const client = harness.client;
    const identity = await client.database_identity.findUniqueOrThrow({ where: { singleton_key: true } });
    const scope = { organizationId: randomUUID(), providerId: identity.provider_id };
    const context = new ProviderPackPublicationContext(client, scope);
    await context.initialize();
    const { inputs } = await freshPublicationFixture(scope.providerId, randomUUID());
    await client.$transaction(async tx => {
      await tx.packs.create({ data: { id: inputs.publicRepackId, pack_key: inputs.publicRepackId, display_name: inputs.title,
        pack_format: "repack", availability: "available", content_evidence: "complete", packscout_ev_model_version: "weighted-value",
        packscout_ev_confidence_policy_version: "packscout-ev-policy", source_updated_at: new Date() } });
      await appendPromotionRange(tx, [{ entityType: "pack", entityId: inputs.publicRepackId, entityVersion: 1n, operation: "upsert" }]);
    });
    const evaluatedAt = new Date().toISOString();
    inputs.dataAsOf = evaluatedAt;
    for (const row of inputs.contents) if (row.valuation.status === "available") row.valuation.observedAt = evaluatedAt;
    // The capture owns the exact EV-input digest, including pinned valuation timestamps.
    const evaluator = new ProviderPackReadinessEvaluator();
    inputs.evInputsSha256 = (await evaluator.evaluate({ candidate: inputs, evaluatedAt })).readiness.evInputsSha256;
    const evaluated = await evaluator.evaluate({ candidate: inputs, evaluatedAt });
    assert.equal(evaluated.readiness.outcome, "ready");
    const requests = new ProviderPackBuildRequestRepository(context);
    await context.transaction(tx => requests.enqueueInTransaction(tx, { ...evaluated, boundaryIdentity: "assembler-seam:1" }));
    const [claim] = await requests.claim(randomUUID()); assert.ok(claim);
    const captured = await requests.load(claim);
    const assembler = new ProviderPackSnapshotAssembler();
    await assert.rejects(assembler.assemble({ ...captured, inputs: { ...captured.inputs, contentsComplete: false } }));
    assert.equal(await client.pack_snapshot_artifacts.count(), 0);
    assert.equal(await client.pack_activation_intents.count(), 0);
    const built = await assembler.assemble(captured);
    assert.equal(await client.pack_snapshot_artifacts.count(), 0); // assembly itself never persists
    // P06 passes only public artifacts to P02's strict envelope; evidence/diagnostics stay separate.
    const { snapshot, descriptor, batches } = built;
    const sealed = await new ProviderPackSnapshotRepository(context).sealAndEnqueueActivation(claim, { snapshot, descriptor, batches });
    assert.equal(sealed.artifact, "created");
    assert.deepEqual(sealed.intent.snapshot, snapshot.identity);
    assert.deepEqual(sealed.intent.evidence, built.evidence);
    assert.equal(await client.pack_snapshot_artifacts.count(), 1);
    assert.equal(await client.pack_snapshot_batches.count(), batches.length);
    assert.equal(await client.pack_activation_intents.count(), 1);
    assert.equal(await client.pack_publication_operations.count(), 0);
    assert.equal(await client.pack_publication_receipts.count(), 0);
    const head = await client.pack_publication_heads.findUniqueOrThrow({ where: { public_repack_id: inputs.publicRepackId } });
    assert.equal(head.active_snapshot_id, null); assert.equal(head.generation, 0n);
  } finally { await harness.close(); }
});
