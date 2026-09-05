import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { packCatalogCanonicalJson } from "@packscout/contracts";
import {
  CentralProfilePublicationContext, CentralProfilePublicationOutboxRepository, SharedPackFanoutRepository,
  ProviderPackPublicationContext, ProviderPackImpactRepository, type SharedChangeInput,
  appendPromotionRange,
  CollectibleProfileSnapshotRepository,
} from "@packscout/database";
import { createMigratedCentralTestDatabase, createProviderHarness } from "@packscout/database/test-support";
import { ProviderPackReadinessEvaluator } from "./provider-pack-readiness-evaluator.ts";
import { freshPublicationFixture } from "./provider-pack-publication.test-support.ts";
import { faultCentralClient, fixtureProfiles, makeProfileEnvelope, profileRequest, seedCentralScope, successfulProfileReceipt } from "./shared-profile-publication.test-support.ts";

test("Offline-provider fan-out and initial-profile recovery", async suite => {
  const central = await createMigratedCentralTestDatabase();
  const healthy = await createProviderHarness(), offline = await createProviderHarness();
  try {
    const providerId = (await healthy.client.database_identity.findUniqueOrThrow({ where: { singleton_key: true } })).provider_id;
    const offlineId = (await offline.client.database_identity.findUniqueOrThrow({ where: { singleton_key: true } })).provider_id;
    const organizationId = await seedCentralScope(central.client, [providerId, offlineId]);
    const context = new CentralProfilePublicationContext(central.client, organizationId, "local");
    const fanout = new SharedPackFanoutRepository(context), deliveries = fanout.forProvider(providerId), offlineDeliveries = fanout.forProvider(offlineId);
    const outbox = new CentralProfilePublicationOutboxRepository(context);
    const { fixture, provider, collectible } = await fixtureProfiles(providerId);
    const collectibleId = fixture.collectibles[0]!.profile.identity.publicCollectibleId;
    const change: SharedChangeInput = { sourceKey: "catalog", sourceIdentity: "catalog:1", sourceSequence: "1", expectedSequence: "0",
      payloadSha256: "b".repeat(64), providerAudience: [providerId, offlineId].sort(), profiles: [provider, collectible],
      sharedDependencies: [{ kind: "valuation", identity: collectibleId, contentSha256: "c".repeat(64) }] };

    await suite.test("every source, shard, profile and checkpoint failure rolls back all work", async () => {
      for (const target of ["shared_catalog_changes.create", "shared_change_deliveries.create", "profile_snapshot_artifacts.create",
        "profile_snapshot_batches.create", "profile_activation_intents.create", "shared_change_checkpoints.update"]) {
        for (const before of [true, false]) {
          const faulty = new SharedPackFanoutRepository(new CentralProfilePublicationContext(faultCentralClient(central.client, target, before), organizationId, "local"));
          await assert.rejects(faulty.recordChangeAndAdvance(change), { code: "SHARED_PERSISTENCE_FAILED", message: "SHARED_PERSISTENCE_FAILED" });
          for (const count of await Promise.all([central.client.shared_catalog_changes.count(), central.client.shared_change_deliveries.count(),
            central.client.profile_snapshot_artifacts.count(), central.client.profile_activation_intents.count(), central.client.shared_change_checkpoints.count()])) assert.equal(count, 0, target);
        }
      }
    });
    await suite.test("missing, foreign, duplicate and oversized audience never advances source progress", async () => {
      for (const providerAudience of [[providerId], [providerId, randomUUID()], [providerId, providerId], Array.from({ length: 1001 }, () => randomUUID())]) {
        await assert.rejects(fanout.recordChangeAndAdvance({ ...change, providerAudience }));
      }
      assert.equal(await central.client.shared_change_checkpoints.count(), 0);
    });
    await suite.test("checkpoint and exact immutable audience survive new client and lost response", async () => {
      const first = await fanout.recordChangeAndAdvance(change);
      const independent = await central.createIndependentLifecycle();
      const restarted = new SharedPackFanoutRepository(new CentralProfilePublicationContext(independent.client, organizationId, "local"));
      assert.deepEqual(await restarted.recordChangeAndAdvance(change), first);
      assert.equal(await central.client.shared_change_deliveries.count(), 2);
      assert.equal(await central.client.profile_activation_intents.count(), 2);
      assert.equal((await central.client.shared_change_checkpoints.findFirstOrThrow()).through_sequence, 1n);
      await assert.rejects(restarted.recordChangeAndAdvance({ ...change, payloadSha256: "f".repeat(64) }), { code: "SHARED_STATE_CONFLICT" });
      const missing = randomUUID();
      await assert.rejects(central.client.$transaction(async tx => {
        await tx.$executeRaw`INSERT INTO shared_catalog_changes (organization_id, id, source_key, source_sequence, source_identity,
          request_sha256, payload_sha256, dependencies_json, audience_json, audience_sha256, profile_intent_ids, receipt_sha256)
          SELECT organization_id, ${missing}::uuid, 'incomplete', 99, 'incomplete', request_sha256, payload_sha256,
            dependencies_json, audience_json, audience_sha256, profile_intent_ids, receipt_sha256 FROM shared_catalog_changes WHERE id = ${first.changeId}::uuid`;
        await tx.shared_change_checkpoints.create({ data: { organization_id: organizationId, source_key: "incomplete",
          through_sequence: 99, change_id: missing, receipt_sha256: first.receiptSha256 } });
      }));
      assert.equal(await central.client.shared_catalog_changes.count(), 1);
    });
    const claim = (await deliveries.claimDelivery(randomUUID()))!;
    const offlineClaim = (await offlineDeliveries.claimDelivery(randomUUID()))!;
    await suite.test("provider and organization bindings reject foreign claims and changed delivery bytes", async () => {
      await assert.rejects(offlineDeliveries.renewDelivery(claim), { code: "SHARED_SCOPE_MISMATCH" });
      const foreign = new SharedPackFanoutRepository(new CentralProfilePublicationContext(central.client, randomUUID(), "local")).forProvider(providerId);
      assert.equal(await foreign.claimDelivery(randomUUID()), null);
      await assert.rejects(foreign.recordDeliveryFailure(claim, "PROVIDER_UNREACHABLE"), { code: "SHARED_SCOPE_MISMATCH" });
      await assert.rejects(deliveries.renewDelivery({ ...claim, delivery: { ...claim.delivery, payloadSha256: "f".repeat(64) } }), { code: "SHARED_LEASE_LOST" });
      await assert.rejects(deliveries.acknowledgeDelivery(claim, { complete: false, boundaryIdentity: "invented", acknowledgmentDigest: null }), { code: "SHARED_INPUT_INVALID" });
    });
    await suite.test("offline provider remains retryable while healthy membership expansion durably converges", async () => {
      await offline.client.$disconnect(); // Real provider becomes unreachable; central never opens its database.
      await offlineDeliveries.recordDeliveryFailure(offlineClaim, "PROVIDER_UNREACHABLE", 60);
      const providerContext = new ProviderPackPublicationContext(healthy.client, { organizationId, providerId });
      await providerContext.initialize();
      const ids: string[] = [randomUUID(), randomUUID()].sort();
      const captured = await Promise.all(ids.map(id => freshPublicationFixture(providerId, id)));
      // The unchanged second collectible is an initial prerequisite alongside the two changed profiles.
      await new CollectibleProfileSnapshotRepository(context).sealAndEnqueueActivation(await makeProfileEnvelope(fixture.collectibles[1]!.profile));
      for (const value of captured) value.inputs.providerProfileSnapshotId = provider.profile.identity.publicProfileSnapshotId;
      await healthy.client.$transaction(async tx => {
      await tx.collectibles.create({ data: { id: collectibleId, collectible_key: "shared-card", display_name: "Shared card",
        collectible_type: "card", normalized_name: "shared card", data_as_of: new Date() } });
      await appendPromotionRange(tx, [{ entityType: "collectible", entityId: collectibleId, entityVersion: 1n, operation: "upsert" }]);
      for (const id of ids) {
        await tx.packs.create({ data: { id, pack_key: id, display_name: id, pack_format: "repack", availability: "available",
          content_evidence: "complete", packscout_ev_model_version: "weighted-value", packscout_ev_confidence_policy_version: "packscout-ev-policy", source_updated_at: new Date() } });
        const content = await tx.pack_contents.create({ data: { pack_id: id, collectible_id: collectibleId, total_quantity: 1n,
          content_role: "possible_outcome", evidence_kinds: ["vendor_odds"], match_confidence_basis_points: 10000, match_confidence_band: "high",
          observed_at: new Date(), display_order: 0 } });
        await appendPromotionRange(tx, [{ entityType: "pack", entityId: id, entityVersion: 1n, operation: "upsert" },
          { entityType: "pack_content", entityId: content.id, entityVersion: 1n, operation: "upsert" }]);
      }
      });
      const evaluator = new ProviderPackReadinessEvaluator();
      const planner = new ProviderPackImpactRepository(providerContext, {
        async capture(_tx, value) { return { ...structuredClone(captured[ids.indexOf(value.publicRepackId)]!.inputs),
          sourceRevisionIdentity: value.sourceRevisionIdentity, expectedDependencies: value.sharedDependencies, observedDependencies: value.sharedDependencies }; },
        evaluate: value => evaluator.evaluate(value),
      });
      await assert.rejects(planner.plan({ kind: "shared", delivery: offlineClaim.delivery }), { code: "PACK_SCOPE_MISMATCH" });
      const result = (await planner.plan({ kind: "shared", delivery: claim.delivery }))!;
      assert.equal(result.complete, true); assert.deepEqual(result.outcomes.map(row => row.publicRepackId), ids);
      assert.equal(await healthy.client.pack_build_requests.count(), 2);
      const replay = (await planner.plan({ kind: "shared", delivery: claim.delivery }))!;
      assert.equal(replay.acknowledgmentDigest, result.acknowledgmentDigest);
      await deliveries.acknowledgeDelivery(claim, replay);
      await deliveries.acknowledgeDelivery(claim, replay); // Lost acknowledgment response, exact retry.
      await assert.rejects(deliveries.acknowledgeDelivery(claim, { ...replay, acknowledgmentDigest: "f".repeat(64) }), { code: "SHARED_STATE_CONFLICT" });
      assert.equal(await deliveries.claimDelivery(randomUUID()), null);
      assert.equal((await central.client.shared_change_deliveries.findFirstOrThrow({ where: { provider_id: offlineId } })).state, "retry_scheduled");
      for (const request of await healthy.client.pack_build_requests.findMany()) {
        const prerequisites = (request.request_json as { requiredProfileSnapshotIds: string[] }).requiredProfileSnapshotIds;
        assert.equal(prerequisites.length, 3);
        assert.equal(await central.client.profile_snapshot_artifacts.count({ where: { organization_id: organizationId,
          snapshot_id: { in: prerequisites } } }), prerequisites.length);
      }
    });
    await suite.test("both profiles publish independently while offline delivery remains pending", async () => {
      const sealedPackBytes = packCatalogCanonicalJson(fixture.packs.packA.snapshot);
      const claims = await outbox.claim(randomUUID(), 3); assert.equal(claims.length, 3);
      for (const profileClaim of claims) {
        const envelope = await outbox.load(profileClaim), operation = profileRequest(profileClaim, envelope);
        const digest = await outbox.recordOperation(profileClaim, operation);
        const receipt = await successfulProfileReceipt(operation, digest, envelope);
        await outbox.recordReceipt(profileClaim, receipt); await outbox.complete(profileClaim, operation.operationId);
      }
      assert.equal(await central.client.profile_activation_intents.count({ where: { state: "published" } }), 3);
      assert.equal(await central.client.profile_publication_heads.count({ where: { generation: 1 } }), 3);
      assert.equal((await central.client.shared_change_deliveries.findFirstOrThrow({ where: { provider_id: offlineId } })).state, "retry_scheduled");
      assert.equal(packCatalogCanonicalJson(fixture.packs.packA.snapshot), sealedPackBytes);
    });
    await suite.test("new provider registration changes the next full audience but never changes accepted evidence", async () => {
      const receipt = await fanout.recordChangeAndAdvance(change), added = randomUUID();
      await central.client.providers.create({ data: { id: added, organization_id: organizationId,
        provider_key: `added_${added.replaceAll("-", "")}`, display_name: "Added provider" } });
      assert.deepEqual(await fanout.recordChangeAndAdvance(change), receipt);
      const second = { ...change, profiles: [], sourceIdentity: "catalog:2", sourceSequence: "2", expectedSequence: "1" };
      await assert.rejects(fanout.recordChangeAndAdvance(second), { code: "SHARED_SCOPE_MISMATCH" });
      const expanded = { ...second, providerAudience: [...change.providerAudience, added].sort() };
      await fanout.recordChangeAndAdvance(expanded);
      await fanout.recordChangeAndAdvance({ ...expanded, sourceIdentity: "catalog:3", sourceSequence: "3", expectedSequence: "2" });
      assert.equal(await offlineDeliveries.claimDelivery(randomUUID()), null);
      const active = (await deliveries.claimDelivery(randomUUID()))!;
      assert.equal(active.delivery.centralChangeIdentity, "catalog:2");
      await central.client.$executeRaw`UPDATE shared_change_deliveries SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE organization_id = ${organizationId}::uuid AND provider_id = ${providerId}::uuid AND id = ${active.delivery.leaseIdentity}::uuid`;
      const recovered = (await deliveries.claimDelivery(randomUUID()))!;
      assert.equal(recovered.delivery.leaseIdentity, active.delivery.leaseIdentity);
      assert.ok(BigInt(recovered.fence) > BigInt(active.fence));
      for (const run of [() => deliveries.renewDelivery(active), () => deliveries.recordDeliveryFailure(active, "PROVIDER_UNREACHABLE")])
        await assert.rejects(run(), { code: "SHARED_LEASE_LOST" });
      await central.client.$executeRaw`UPDATE shared_change_deliveries SET attempts = 100,
        lease_expires_at = clock_timestamp() - interval '1 second' WHERE organization_id = ${organizationId}::uuid
        AND provider_id = ${providerId}::uuid AND id = ${active.delivery.leaseIdentity}::uuid`;
      assert.equal(await deliveries.claimDelivery(randomUUID()), null);
      assert.equal(await deliveries.claimDelivery(randomUUID()), null); // blocked catalog:2 must not allow catalog:3.
      assert.equal((await fanout.forProvider(added).claimDelivery(randomUUID()))!.delivery.centralChangeIdentity, "catalog:2");
      assert.equal((await central.client.shared_change_checkpoints.findFirstOrThrow()).through_sequence, 3n);
    });
  } finally { await Promise.allSettled([central.close(), healthy.close(), offline.close()]); }
});
