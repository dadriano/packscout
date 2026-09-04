import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { deriveProviderPackInputDigests, packCatalogCanonicalByteCount, packPublicationLimits, publicPackSummaryCore } from "@packscout/contracts";
import { sealFixturePack } from "@packscout/contracts/test-fixtures/pack-catalog-v1";
import { ProviderPackPublicationContext, ProviderPackBuildRequestRepository, ProviderPackImpactRepository,
  ProviderPackSnapshotRepository, ProviderPackPublicationOutboxRepository, appendPromotionRange } from "@packscout/database";
import { createProviderHarness } from "@packscout/database/test-support";
import { ProviderPackReadinessEvaluator } from "./provider-pack-readiness-evaluator.ts";
import { freshPublicationFixture, inputsFromPayload, publicationHash } from "./provider-pack-publication.test-support.ts";

test("Large lifecycle captures retain full baselines and leave independent packs pageable", async () => {
  const harness = await createProviderHarness();
  try {
    const client = harness.client;
    const { provider_id: providerId } = await client.database_identity.findUniqueOrThrow({ where: { singleton_key: true } });
    const ids = [randomUUID(), randomUUID()].sort();
    await client.$transaction(async tx => {
      await tx.packs.createMany({ data: ids.map(id => ({ id, pack_key: id, display_name: id, pack_format: "repack" as const,
        availability: "available" as const, content_evidence: "complete" as const, packscout_ev_model_version: "weighted-value",
        packscout_ev_confidence_policy_version: "packscout-ev-policy", source_updated_at: new Date() })) });
      await appendPromotionRange(tx, ids.map(entityId => ({ entityType: "pack" as const,
        entityId, entityVersion: 1n, operation: "upsert" as const })));
    });
    const context = new ProviderPackPublicationContext(client, { organizationId: randomUUID(), providerId });
    await context.initialize();
    const requests = new ProviderPackBuildRequestRepository(context), snapshots = new ProviderPackSnapshotRepository(context);
    const evaluator = new ProviderPackReadinessEvaluator();
    const small = await freshPublicationFixture(providerId, ids[1]);
    const payload = (await freshPublicationFixture(providerId, ids[0])).built.snapshot.payload;
    payload.contents = Array.from({ length: 6_000 }, (_, index) => ({ ...structuredClone(payload.contents[0]!),
      publicCollectibleId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      collectibleProfileSnapshotId: `ppfs_${(index + 1).toString(16).padStart(64, "0")}`,
      imageUrl: `https://example.com/${"a".repeat(1_000)}`, eligibleForChase: false,
      probabilityMicros: 166 + (index < 4_000 ? 1 : 0) }));
    payload.contentCount = payload.contents.length;
    payload.collectibleProfileSnapshotIds = payload.contents.map(row => row.collectibleProfileSnapshotId).sort();
    payload.valuationDependencyIdentities = []; payload.topChase = null;
    const digests = await deriveProviderPackInputDigests(inputsFromPayload(payload));
    payload.probabilityInputsSha256 = digests.probabilityInputsSha256;
    payload.valuationsSha256 = digests.valuationInputsSha256; payload.evInputsSha256 = digests.evInputsSha256;
    payload.economicsSha256 = await publicationHash({ price: payload.price, records: payload.contents,
      probabilityInputsSha256: payload.probabilityInputsSha256, valuationsSha256: payload.valuationsSha256,
      topChase: payload.topChase, evInputsSha256: payload.evInputsSha256, ev: payload.ev });
    payload.summaryProjection = publicPackSummaryCore(payload);
    const { snapshot, descriptor, batches } = await sealFixturePack(payload);
    const built = { snapshot, descriptor, batches };
    const inputs = inputsFromPayload(payload);
    assert.ok(packCatalogCanonicalByteCount(inputs) < packPublicationLimits.maximumInputBytes);
    assert.ok(packCatalogCanonicalByteCount(built.snapshot) < packPublicationLimits.maximumInputBytes);
    const evaluated = await evaluator.evaluate({ candidate: inputs, evaluatedAt: new Date().toISOString() });
    assert.equal(evaluated.readiness.outcome, "ready");
    const first = await context.transaction(tx => requests.enqueueInTransaction(tx, { ...evaluated, boundaryIdentity: "initial:large" }));
    await snapshots.sealAndEnqueueActivation((await requests.claim(randomUUID()))[0]!, built);
    await new ProviderPackPublicationOutboxRepository(context).observeHead({ providerId, publicRepackId: ids[0]!,
      generation: 1, publicationEpoch: 0, held: false, holdReason: null, latestAcceptedPackPublicationSequence: first.sequence,
      activeSnapshot: built.snapshot.identity, previousSnapshot: null, indexableSummary: payload.summaryProjection,
      activatedAt: new Date().toISOString() });
    const lifecycle = { ...inputs, snapshotKind: "lifecycle_only" as const, lifecycleProvenanceIdentity: "large:sold-out",
      lifecycle: { ...inputs.lifecycle, availability: "sold_out" as const,
        availabilityEvidence: { kind: "explicit_sold_out" as const, sourceIdentity: "large:sold-out" } },
      actions: inputs.actions.map(action => ({ ...action, enabled: false, disabledReason: "PACK_UNAVAILABLE" as const })) };
    const lifecycleReadiness = await evaluator.evaluate({ candidate: lifecycle, previousSnapshot: built.snapshot,
      evaluatedAt: new Date().toISOString() });
    assert.equal(lifecycleReadiness.readiness.outcome, "ready");
    // Neither half can borrow the other's unused allowance, even at direct admission.
    const oversizedContents = Array.from({ length: 8_000 }, (_, index) => ({ ...structuredClone(inputs.contents[0]!),
      publicCollectibleId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      collectibleProfileSnapshotId: `ppfs_${(index + 1).toString(16).padStart(64, "0")}`,
      imageUrl: `https://example.com/${"a".repeat(2_000)}`, probabilityMicros: 125 }));
    const oversizedBaseline = { ...built.snapshot, payload: { ...payload, contents: oversizedContents,
      contentCount: 8_000, collectibleProfileSnapshotIds: oversizedContents.map(row => row.collectibleProfileSnapshotId!) } };
    assert.ok(packCatalogCanonicalByteCount(oversizedBaseline) > packPublicationLimits.maximumInputBytes);
    for (const candidate of [{ ...lifecycleReadiness.inputs, contents: oversizedContents },
      { ...lifecycleReadiness.inputs, lifecycleBaseline: oversizedBaseline }]) {
      await assert.rejects(evaluator.evaluate({ candidate, previousSnapshot: candidate.lifecycleBaseline,
        evaluatedAt: new Date().toISOString() }), { message: "pack.inputs_too_large" });
      await assert.rejects(context.transaction(tx => requests.enqueueInTransaction(tx, {
        inputs: candidate, readiness: lifecycleReadiness.readiness, boundaryIdentity: "oversized:refused" })), { code: "PACK_LIMIT_EXCEEDED" });
    }
    await assert.rejects(evaluator.evaluate({ candidate: { ...inputs, contents: oversizedContents },
      evaluatedAt: new Date().toISOString() }), { message: "pack.inputs_too_large" });
    const planner = new ProviderPackImpactRepository(context, {
      async capture(_tx, input) { return { ...structuredClone(input.publicRepackId === ids[0] ? lifecycle : small.inputs),
        sourceRevisionIdentity: input.sourceRevisionIdentity }; },
      evaluate: input => evaluator.evaluate(input),
    });
    const page = await planner.plan({ kind: "provider" });
    assert.equal(page?.complete, false); assert.deepEqual(page?.outcomes.map(row => row.publicRepackId), [ids[0]]);
    const claim = (await requests.claim(randomUUID()))[0]!;
    const loaded = await requests.load(claim);
    assert.equal(loaded.inputs.contents.length, 6_000);
    assert.equal(await publicationHash(loaded.inputs.lifecycleBaseline), await publicationHash(built.snapshot));
    assert.ok(packCatalogCanonicalByteCount(loaded.inputs) > 18_000_000, "exercises the former JSONB storage ceiling too");
    const updatedPayload = { ...payload, snapshotKind: lifecycle.snapshotKind, lifecycle: lifecycle.lifecycle, actions: lifecycle.actions,
      lifecycleFreeze: { previousSnapshotId: built.snapshot.identity.publicPackSnapshotId,
        retainedEconomicsSha256: payload.economicsSha256, provenanceIdentity: lifecycle.lifecycleProvenanceIdentity } };
    updatedPayload.summaryProjection = publicPackSummaryCore(updatedPayload);
    const updated = await sealFixturePack(updatedPayload);
    await snapshots.sealAndEnqueueActivation(claim, { snapshot: updated.snapshot, descriptor: updated.descriptor, batches: updated.batches });
    const next = await planner.plan({ kind: "provider" });
    assert.equal(next?.complete, true); assert.deepEqual(next?.outcomes.map(row => row.publicRepackId), [ids[1]]);
    assert.equal((await requests.load((await requests.claim(randomUUID()))[0]!)).inputs.publicRepackId, ids[1]);
  } finally { await harness.close(); }
});
