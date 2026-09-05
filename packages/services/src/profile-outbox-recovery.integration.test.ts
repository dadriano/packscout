import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { packCatalogCanonicalJson, packCatalogPublicationRequestSchema, packCatalogReceiptDigest, type PackCatalogPublicationRequest } from "@packscout/contracts";
import { CentralProfilePublicationContext, CentralProfilePublicationOutboxRepository, ProviderProfileSnapshotRepository,
  CollectibleProfileSnapshotRepository, SharedPackFanoutRepository, type ProfileWorkClaim } from "@packscout/database";
import { createMigratedCentralTestDatabase } from "@packscout/database/test-support";
import { faultCentralClient, fixtureProfiles, makeProfileEnvelope, profileRequest, seedCentralScope, successfulProfileReceipt } from "./shared-profile-publication.test-support.ts";
import { assemblePublicProfileSnapshot } from "./public-profile-snapshot-assembler.ts";

test("Profile artifacts and exact operation journals survive faults and ownership changes", async suite => {
  const harness = await createMigratedCentralTestDatabase();
  try {
    const providerId = randomUUID(), organizationId = await seedCentralScope(harness.client, [providerId]);
    const context = new CentralProfilePublicationContext(harness.client, organizationId, "local");
    const snapshots = new ProviderProfileSnapshotRepository(context), outbox = new CentralProfilePublicationOutboxRepository(context);
    const { provider, collectible, fixture } = await fixtureProfiles(providerId);
    const fault = (target: string) => new CentralProfilePublicationOutboxRepository(new CentralProfilePublicationContext(
      faultCentralClient(harness.client, target), organizationId, "local"));
    await suite.test("canonical permutations reuse bytes, while every new request creates its own intent", async () => {
      const profile = structuredClone(fixture.collectibles[0]!.profile);
      profile.aliases = ["Zulu", "Alpha"];
      const one = await assemblePublicProfileSnapshot(profile);
      profile.aliases.reverse();
      assert.equal(packCatalogCanonicalJson(await assemblePublicProfileSnapshot(profile)), packCatalogCanonicalJson(one));
      assert.equal((await snapshots.sealAndEnqueueActivation(provider)).artifact, "created");
      assert.equal((await snapshots.sealAndEnqueueActivation(provider)).artifact, "reused");
      const later = await makeProfileEnvelope(provider.profile, 1);
      assert.equal((await snapshots.sealAndEnqueueActivation(later)).artifact, "reused");
      assert.equal(await harness.client.profile_snapshot_artifacts.count(), 1);
      assert.equal(await harness.client.profile_activation_intents.count(), 2);
      await new CollectibleProfileSnapshotRepository(context).sealAndEnqueueActivation(collectible);
      const changed = structuredClone(provider); changed.profile.displayName = "Changed bytes";
      await assert.rejects(snapshots.sealAndEnqueueActivation(changed), { code: "SHARED_INPUT_INVALID" });
      await assert.rejects(harness.client.profile_snapshot_artifacts.updateMany({ data: { content_sha256: "f".repeat(64) } }));
      await assert.rejects(harness.client.profile_snapshot_batches.updateMany({ data: { batch_json: {} } }));
    });
    let claim: ProfileWorkClaim, operation: PackCatalogPublicationRequest, digest: string;
    await suite.test("claims serialize one profile and remain independent of other profiles", async () => {
      const [first, second] = await Promise.all([outbox.claim(randomUUID(), 1), outbox.claim(randomUUID(), 1)]);
      const claims = [...first, ...second]; assert.equal(claims.length, 2);
      assert.equal(new Set(claims.map(value => value.entityId)).size, 2);
      claim = claims.find(value => value.profileKind === "provider")!;
      assert.equal((await outbox.claim(randomUUID())).length, 0);
      const otherClaim = claims.find(value => value.profileKind === "collectible")!;
      await outbox.scheduleRetry(otherClaim, "TRANSPORT_TIMEOUT", 60);
    });
    await suite.test("invalid authorization, browser input, stale identity and changed scope are refused before send", async () => {
      const valid = profileRequest(claim, provider, "start_profile_snapshot");
      const variants: unknown[] = [{ ...valid, browserOrigin: "https://example.com" },
        { ...valid, serviceIdentity: { ...valid.serviceIdentity, organizationId: randomUUID() } },
        { ...valid, serviceIdentity: { ...valid.serviceIdentity, environment: "live" } },
        { ...valid, serviceIdentity: { ...valid.serviceIdentity, expiresAt: new Date(Date.now() - 100).toISOString() } },
        { ...valid, serviceIdentity: { ...valid.serviceIdentity, authorizationSha256: "f".repeat(64) } }];
      for (const value of variants) await assert.rejects(outbox.recordOperation(claim, value as PackCatalogPublicationRequest));
      const foreign = new CentralProfilePublicationOutboxRepository(new CentralProfilePublicationContext(harness.client, randomUUID(), "local"));
      for (const run of [() => foreign.load(claim), () => foreign.renew(claim), () => foreign.recordOperation(claim, valid)])
        await assert.rejects(run(), { code: "SHARED_SCOPE_MISMATCH" });
      assert.equal(await harness.client.profile_publication_operations.count(), 0);
    });
    await suite.test("crash before send leaves either no command or the exact durable original", async () => {
      operation = profileRequest(claim, provider);
      await assert.rejects(fault("profile_publication_operations.create").recordOperation(claim, operation), { code: "SHARED_PERSISTENCE_FAILED" });
      assert.equal(await harness.client.profile_publication_operations.count(), 0);
      digest = await outbox.recordOperation(claim, operation);
      assert.equal(await outbox.recordOperation(claim, operation), digest);
      await assert.rejects(outbox.recordOperation(claim, { ...operation, requestedAt: new Date(Date.now() + 100).toISOString() }), { code: "SHARED_STATE_CONFLICT" });
      await assert.rejects(outbox.supersede(claim), { code: "SHARED_STATE_CONFLICT" });
      assert.equal((await outbox.readOperation(claim, operation.operationId))!.receipt, null);
    });
    await suite.test("reclaimed fence loads original operation and rejects all expired-owner writes", async () => {
      const stale = claim;
      await harness.client.$executeRaw`UPDATE profile_publication_heads SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE organization_id = ${organizationId}::uuid AND entity_id = ${providerId}::uuid`;
      const independent = await harness.createIndependentLifecycle();
      const recovered = new CentralProfilePublicationOutboxRepository(new CentralProfilePublicationContext(independent.client, organizationId, "local"));
      claim = (await recovered.claim(randomUUID()))[0]!;
      assert.equal(claim.intentId, stale.intentId); assert.ok(BigInt(claim.fence) > BigInt(stale.fence));
      assert.deepEqual((await recovered.readOperation(claim, operation.operationId))!.request, operation);
      const receipt = await successfulProfileReceipt(operation, digest, provider);
      for (const run of [() => outbox.renew(stale), () => outbox.scheduleRetry(stale, "TRANSPORT_TIMEOUT"),
        () => outbox.block(stale, "INVALID_DOMAIN_DATA"), () => outbox.supersede(stale),
        () => outbox.recordOperation(stale, operation), () => outbox.recordReceipt(stale, receipt), () => outbox.complete(stale, operation.operationId)])
        await assert.rejects(run(), { code: "SHARED_LEASE_LOST" });
      assert.equal((await recovered.listOperations(claim)).length, 1);
    });
    await suite.test("receipt forgery, response loss and completion interruption converge to one activation", async () => {
      const receipt = await successfulProfileReceipt(operation, digest, provider);
      for (const changed of [{ ...receipt, requestSha256: "f".repeat(64) }, { ...receipt, entity: { entityKind: "provider_profile" as const, providerId: randomUUID() } },
        { ...receipt, snapshotId: `ppfs_${"f".repeat(64)}` }, { ...receipt, operationKind: "start_profile_snapshot" as const }]) {
        await assert.rejects(outbox.recordReceipt(claim, { ...changed, receiptDigest: await packCatalogReceiptDigest(changed) }), { code: "SHARED_INPUT_INVALID" });
      }
      await assert.rejects(fault("profile_publication_receipts.create").recordReceipt(claim, receipt), { code: "SHARED_PERSISTENCE_FAILED" });
      assert.equal(await harness.client.profile_publication_receipts.count(), 0);
      await outbox.recordReceipt(claim, receipt); await outbox.recordReceipt(claim, receipt);
      await assert.rejects(outbox.supersede(claim), { code: "SHARED_STATE_CONFLICT" });
      await assert.rejects(fault("profile_activation_intents.update").complete(claim, operation.operationId), { code: "SHARED_PERSISTENCE_FAILED" });
      assert.equal((await harness.client.profile_publication_heads.findFirstOrThrow({ where: { entity_id: providerId } })).generation, 0n);
      await outbox.complete(claim, operation.operationId);
      assert.equal((await harness.client.profile_publication_heads.findFirstOrThrow({ where: { entity_id: providerId } })).generation, 1n);
      assert.equal(await harness.client.profile_publication_receipts.count(), 1);
      const [next] = await outbox.claim(randomUUID()); assert.ok(next); assert.notEqual(next.intentId, claim.intentId);
      assert.equal((await outbox.load(next)).intent.expectedGeneration, 1);
      await outbox.supersede(next);
    });
    await suite.test("source captures and profile evidence reject unbounded or executable objects before parsing", async () => {
      let invoked = false;
      const hostile = Object.defineProperty({}, "profiles", { enumerable: true, get() { invoked = true; throw new Error("private"); } });
      await assert.rejects(new SharedPackFanoutRepository(context).recordChangeAndAdvance(hostile as never), { code: "SHARED_INPUT_INVALID" });
      assert.equal(invoked, false);
      assert.throws(() => snapshots.sealAndEnqueueActivation({ ...provider, excess: "x".repeat(1_500_001) } as never), { code: "SHARED_LIMIT_EXCEEDED" });
      const derived = structuredClone(fixture.collectibles[0]!.profile);
      derived.displayName = "Bearer"; derived.aliases = ["12345678901234567890"];
      await assert.rejects(assemblePublicProfileSnapshot(derived), TypeError);
      const unsafe = structuredClone(provider); unsafe.profile.displayName = "postgresql://private";
      await assert.rejects(snapshots.sealAndEnqueueActivation(unsafe), { code: "SHARED_INPUT_INVALID" });
      assert.throws(() => new CentralProfilePublicationContext(harness.client, "invalid", "local"), { code: "SHARED_INPUT_INVALID" });
      assert.throws(() => outbox.claim("invalid"), { code: "SHARED_INPUT_INVALID" });
    });
    await suite.test("an expired original response remains ambiguous until exact signed status evidence reconciles it", async () => {
      const changed = structuredClone(provider.profile); changed.displayName = "Updated profile";
      const envelope = await makeProfileEnvelope(changed, 1);
      await snapshots.sealAndEnqueueActivation(envelope);
      const current = (await outbox.claim(randomUUID()))[0]!;
      const activation = profileRequest(current, envelope), activationDigest = await outbox.recordOperation(current, activation);
      const expired = { ...await successfulProfileReceipt(activation, activationDigest, envelope),
        result: { outcome: "operation_expired" as const, state: "ready" as const, reasonCode: "OPERATION_EXPIRED" as const }, profileHead: null };
      await outbox.recordReceipt(current, { ...expired, receiptDigest: await packCatalogReceiptDigest(expired) });
      await assert.rejects(outbox.supersede(current), { code: "SHARED_STATE_CONFLICT" });
      const status = packCatalogPublicationRequestSchema.parse({ ...profileRequest(current, envelope), operationKind: "profile_publication_status",
        serviceIdentity: { ...profileRequest(current, envelope).serviceIdentity, operations: ["read_receipt"] },
        body: { profile: { profileKind: "provider", providerId }, publicProfileSnapshotId: envelope.profile.identity.publicProfileSnapshotId,
          operation: { operationId: activation.operationId, requestSha256: activationDigest } } });
      const statusDigest = await outbox.recordOperation(current, status);
      const response = { ...await successfulProfileReceipt(status, statusDigest, envelope),
        statusOperation: { found: true, result: { outcome: "already_applied" as const, state: "published" as const, reasonCode: null } } };
      await outbox.recordReceipt(current, { ...response, receiptDigest: await packCatalogReceiptDigest(response) });
      await outbox.complete(current, status.operationId);
      assert.equal((await harness.client.profile_publication_heads.findFirstOrThrow({ where: { entity_id: providerId } })).generation, 2n);
      assert.equal((await harness.client.profile_publication_operations.findFirstOrThrow({ where: { id: activation.operationId } })).request_sha256, activationDigest);
    });
    await suite.test("missing and expired status cannot retire work; exact definitive refusal can", async () => {
      const envelope = await makeProfileEnvelope(provider.profile, 2);
      await snapshots.sealAndEnqueueActivation(envelope);
      const current = (await outbox.claim(randomUUID()))[0]!;
      const activation = profileRequest(current, envelope), activationDigest = await outbox.recordOperation(current, activation);
      for (const outcome of ["missing", "operation_expired", "refused"] as const) {
        const status = packCatalogPublicationRequestSchema.parse({ ...profileRequest(current, envelope), operationKind: "profile_publication_status",
          serviceIdentity: { ...profileRequest(current, envelope).serviceIdentity, operations: ["read_receipt"] },
          body: { profile: { profileKind: "provider", providerId }, publicProfileSnapshotId: envelope.profile.identity.publicProfileSnapshotId,
            operation: { operationId: activation.operationId, requestSha256: activationDigest } } });
        const response = { ...await successfulProfileReceipt(status, await outbox.recordOperation(current, status), envelope),
          profileHead: null, statusOperation: { found: outcome !== "missing", result: outcome === "missing" ? null : {
            outcome, state: "ready" as const, reasonCode: outcome === "refused" ? "AUTHORIZATION_REFUSED" as const : "OPERATION_EXPIRED" as const } } };
        await outbox.recordReceipt(current, { ...response, receiptDigest: await packCatalogReceiptDigest(response) });
        if (outcome === "refused") await outbox.supersede(current);
        else await assert.rejects(outbox.supersede(current), { code: "SHARED_STATE_CONFLICT" });
      }
    });
    await suite.test("lease expiry during a database operation rolls back the command before handoff", async () => {
      const envelope = await makeProfileEnvelope(provider.profile, 2);
      await snapshots.sealAndEnqueueActivation(envelope);
      const current = (await outbox.claim(randomUUID(), 1, 1))[0]!;
      const delayed = harness.client.$extends({ query: { profile_publication_operations: { async create({ args, query }) {
        const result = await query(args); await harness.client.$executeRaw`SELECT pg_sleep(1.1)`; return result;
      } } } });
      const slow = new CentralProfilePublicationOutboxRepository(new CentralProfilePublicationContext(delayed as unknown as typeof harness.client, organizationId, "local"));
      const request = profileRequest(current, envelope);
      await assert.rejects(slow.recordOperation(current, request), { code: "SHARED_LEASE_LOST" });
      assert.equal(await harness.client.profile_publication_operations.count({ where: { id: request.operationId } }), 0);
    });
    await suite.test("attempt exhaustion blocks only that profile while a different profile remains claimable", async () => {
      await harness.client.profile_activation_intents.updateMany({ where: { organization_id: organizationId,
        entity_id: providerId, state: "publishing" }, data: { attempts: 100 } });
      await harness.client.profile_activation_intents.updateMany({ where: { organization_id: organizationId,
        profile_kind: "collectible", state: "retry_scheduled" }, data: { available_at: new Date(0) } });
      const claims = await outbox.claim(randomUUID(), 2);
      assert.equal(claims.length, 1); assert.equal(claims[0]!.profileKind, "collectible");
      assert.equal((await outbox.claim(randomUUID(), 2)).length, 0);
      assert.equal(await harness.client.profile_activation_intents.count({ where: { entity_id: providerId, state: "blocked" } }), 1);
    });
  } finally { await harness.close(); }
});
