import assert from "node:assert/strict";
import test from "node:test";
import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import {
  providerActivityEventDigest,
  type ProviderActivityEvent,
  type ProviderLocalHealthObservation,
} from "./provider-activity-contract.ts";
import { PrismaManifestGateIntentRepository } from
  "./manifest-gate-intent-repository.ts";
import { CentralProviderObservationRepository } from
  "./provider-observation-repository.ts";
import type { ProviderCompletedPublishPlanRelayProof } from
  "./provider-completion-plan-contract.ts";
import { buildProviderCompletionPlanProofFixture } from
  "./provider-completion-plan-test-support.ts";
import { PrismaProviderCompletionPublishPlanRepository } from
  "./provider-completion-publish-plan-repository.ts";
import { createMigratedCentralTestDatabase } from "./test-support.ts";

const organizationId = "72000000-0000-4000-8000-000000000001";
const providerA = "72000000-0000-4000-8000-000000000002";
const providerB = "72000000-0000-4000-8000-000000000003";
const catalogVersionId = "72000000-0000-4000-8000-000000000010";
const catalogContentHash = "a".repeat(64);
const base = new Date("2026-09-01T20:00:00.000Z");

function health(
  providerId: string,
  observedAt = base,
): ProviderLocalHealthObservation {
  return {
    providerId,
    observedState: "idle",
    freshnessState: "fresh",
    qualityState: "healthy",
    consecutiveFailures: 0,
    openQuarantineCount: 0,
    lastAttemptedAt: null,
    lastHeadReachedAt: observedAt,
    recoveredAt: null,
    lastRunnerHeartbeatAt: observedAt,
    latestFailureCode: null,
    recoveryHint: "No recovery action required.",
    publicationLag: 0n,
    observedAt,
  };
}

function completion(input: Readonly<{
  id: string;
  proof: ProviderCompletedPublishPlanRelayProof;
  eventAt: Date;
  state?: "complete" | "reused";
}>): ProviderActivityEvent {
  const state = input.state ?? "complete";
  const sequence = input.proof.completedThroughChangeSequence.toString();
  const identity = {
    id: input.id,
    eventType: "provider_release_completed",
    severity: "info" as const,
    dedupeKey:
      `provider-release-completed:${input.proof.providerReleaseId}:${sequence}`,
    recoveryKey: `provider-release:${input.proof.providerReleaseId}`,
    localRunId: null,
    localQuarantineId: null,
    title: "Provider release publication completed",
    summary: state === "complete"
      ? "An immutable provider release completed publication."
      : "An unchanged immutable provider release confirmed a newer boundary.",
    evidence: {
      state,
      providerReleaseId: input.proof.providerReleaseId,
      publicProviderReleaseId: input.proof.publicProviderReleaseId,
      catalogVersionId: input.proof.catalogVersionId,
      catalogContentHash: input.proof.catalogContentHash,
      providerReleaseContentHash: input.proof.providerReleaseContentHash,
      providerReleaseFingerprint: input.proof.providerReleaseFingerprint,
      completedThroughChangeSequence: sequence,
      terminalReceiptSha256: input.proof.terminalReceiptSha256,
    },
    eventAt: input.eventAt,
  } as const;
  return {
    ...identity,
    eventDigest: providerActivityEventDigest(identity),
    deliveryAttemptCount: 0,
    lastFailureCode: null,
  };
}

async function proof(input: Readonly<{
  providerId: string;
  providerKey: string;
  providerReleaseId: string;
  artifactAttemptId: string;
  sequence: bigint;
}>): Promise<ProviderCompletedPublishPlanRelayProof> {
  return buildProviderCompletionPlanProofFixture({
    providerId: input.providerId,
    providerKey: input.providerKey,
    providerReleaseId: input.providerReleaseId,
    catalogVersionId,
    catalogContentHash,
    artifactAttemptId: input.artifactAttemptId,
    releaseSequence: input.sequence,
  });
}

test("completion relay atomically caches exact proofs across replay and isolation", async () => {
  const harness = await createMigratedCentralTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "provider-completion-relay",
        name: "Provider completion relay",
      },
    });
    await harness.client.providers.createMany({
      data: [{
        id: providerA,
        organization_id: organizationId,
        provider_key: "relay_provider_a",
        display_name: "Relay provider A",
      }, {
        id: providerB,
        organization_id: organizationId,
        provider_key: "relay_provider_b",
        display_name: "Relay provider B",
      }],
    });
    await harness.client.$transaction(async (transaction) => {
      await transaction.$executeRaw(CentralPrisma.sql`
        insert into catalog_versions (
          id, through_change_sequence, schema_version, lifecycle,
          category_count, collectible_count, alias_count, content_hash
        ) values (
          ${catalogVersionId}::uuid, 1, 'catalog-v1', 'building',
          0, 0, 0, ${catalogContentHash}
        )
      `);
      for (const kind of ["categories", "collectibles", "aliases"] as const) {
        await transaction.$executeRaw(CentralPrisma.sql`
          insert into catalog_version_batches (
            catalog_version_id, batch_kind, batch_index, payload,
            record_count, byte_count, body_hash
          ) values (
            ${catalogVersionId}::uuid, ${kind}, 0, '[]'::jsonb,
            0, 2, ${catalogContentHash}
          )
        `);
      }
      await transaction.$executeRaw(CentralPrisma.sql`
        update catalog_versions
        set lifecycle = 'assembled', assembled_at = ${base}
        where id = ${catalogVersionId}::uuid
      `);
      await transaction.$executeRaw(CentralPrisma.sql`
        update catalog_versions set lifecycle = 'publishing'
        where id = ${catalogVersionId}::uuid
      `);
      await transaction.$executeRaw(CentralPrisma.sql`
        insert into catalog_publication_operations (
          id, catalog_version_id, operation_kind, idempotency_key,
          request_digest, request_bytes, lease_fence, state,
          convex_receipt_id, receipt_hash, receipt, requested_at, completed_at
        ) values (
          '72000000-0000-4000-8000-000000000011'::uuid,
          ${catalogVersionId}::uuid, 'finalize', 'completion-relay:catalog',
          encode(digest(convert_to('{"catalog":"relay"}', 'UTF8'), 'sha256'), 'hex'),
          convert_to('{"catalog":"relay"}', 'UTF8'), 1, 'accepted',
          'completion-relay-catalog-receipt',
          encode(digest(convert_to('{"accepted":true}'::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
          '{"accepted":true}'::jsonb, ${base}, ${base}
        )
      `);
      await transaction.$executeRaw(CentralPrisma.sql`
        update catalog_versions
        set lifecycle = 'complete', completed_at = ${base}
        where id = ${catalogVersionId}::uuid
      `);
    });

    const observations = new CentralProviderObservationRepository(
      harness.client,
    );
    const gates = new PrismaManifestGateIntentRepository(harness.client);
    const cache = new PrismaProviderCompletionPublishPlanRepository(
      harness.client,
    );
    const newestAProof = await proof({
      providerId: providerA,
      providerKey: "relay_provider_a",
      providerReleaseId: "72000000-0000-5000-8000-000000000021",
      artifactAttemptId: "72000000-0000-4000-8000-000000000041",
      sequence: 21n,
    });
    const newestA = completion({
      id: "72000000-0000-4000-8000-000000000020",
      proof: newestAProof,
      eventAt: base,
    });

    const accepted = await observations.acceptProviderActivity({
      organizationId,
      providerId: providerA,
      event: newestA,
      health: health(providerA),
      receivedAt: new Date(base.getTime() + 1_000),
      completionProof: newestAProof,
    });
    assert.equal(accepted.state, "accepted");
    assert.deepEqual(accepted.completionGate, {
      providerId: providerA,
      observedCompletionGeneration: 21n,
      requestedGeneration: 1n,
      acknowledgedGeneration: 0n,
      manifestWakeGeneration: 1n,
      evidenceDigest: newestA.eventDigest,
      pending: true,
    });
    assert.equal(
      await harness.client.provider_activity_events.count({
        where: { provider_id: providerA },
      }),
      1,
    );
    assert.equal(
      (await harness.client.manifest_reconciliation_job_wake
        .findUniqueOrThrow({ where: { singleton_key: true } }))
        .requested_generation,
      1n,
    );

    const conflictingProof = await proof({
      providerId: providerA,
      providerKey: "relay_provider_a",
      providerReleaseId: "72000000-0000-5000-8000-000000000031",
      artifactAttemptId: "72000000-0000-4000-8000-000000000042",
      sequence: 21n,
    });
    const conflictingGeneration = completion({
      id: "72000000-0000-4000-8000-000000000030",
      proof: conflictingProof,
      eventAt: new Date(base.getTime() + 500),
    });
    await assert.rejects(
      observations.acceptProviderActivity({
        organizationId,
        providerId: providerA,
        event: conflictingGeneration,
        health: health(providerA),
        receivedAt: new Date(base.getTime() + 1_500),
        completionProof: conflictingProof,
      }),
      /completion generation is inconsistent/u,
    );
    assert.equal(
      await harness.client.provider_activity_events.count({
        where: { provider_id: providerA },
      }),
      1,
    );
    assert.equal((await gates.load(providerA))?.requestedGeneration, 1n);
    assert.deepEqual(
      await harness.client.manifest_gate_intents.findUniqueOrThrow({
        where: { provider_id: providerA },
        select: {
          provider_source_generation: true,
          provider_source_gate_generation: true,
          provider_source_evidence_digest: true,
        },
      }),
      {
        provider_source_generation: 21n,
        provider_source_gate_generation: 1n,
        provider_source_evidence_digest: newestA.eventDigest,
      },
    );

    const restartedLifecycle = await harness.createIndependentLifecycle();
    const restarted = new CentralProviderObservationRepository(
      restartedLifecycle.client,
    );
    const replay = await restarted.acceptProviderActivity({
      organizationId,
      providerId: providerA,
      event: newestA,
      health: health(providerA),
      receivedAt: new Date(base.getTime() + 60_000),
      completionProof: newestAProof,
    });
    assert.equal(replay.state, "deduplicated");
    assert.equal(replay.completionGate?.requestedGeneration, 1n);
    assert.equal(replay.completionGate?.manifestWakeGeneration, 1n);
    assert.equal(
      (await harness.client.manifest_reconciliation_job_wake
        .findUniqueOrThrow({ where: { singleton_key: true } }))
        .requested_generation,
      1n,
      "exact replay does not allocate another manifest wake",
    );
    assert.equal(
      (await harness.client.manifest_gate_intents.findUniqueOrThrow({
        where: { provider_id: providerA },
      })).row_version,
      1n,
    );

    const changedLocalHashProof = {
      ...newestAProof,
      providerReleaseContentHash: "6".repeat(64),
    };
    await assert.rejects(
      restarted.acceptProviderActivity({
        organizationId,
        providerId: providerA,
        event: completion({
          id: newestA.id,
          proof: changedLocalHashProof,
          eventAt: newestA.eventAt,
        }),
        health: health(providerA),
        receivedAt: new Date(base.getTime() + 60_500),
        completionProof: changedLocalHashProof,
      }),
      /completion generation is inconsistent/u,
    );

    await assert.rejects(
      restarted.acceptProviderActivity({
        organizationId,
        providerId: providerB,
        event: newestA,
        health: health(providerB),
        receivedAt: new Date(base.getTime() + 61_000),
        completionProof: newestAProof,
      }),
      /publish-plan proof is inconsistent/u,
    );
    assert.equal(await gates.load(providerB), null);

    const invalidEnvelope = {
      ...newestA,
      id: "72000000-0000-4000-8000-000000000023",
      summary: "A generic completion occurred.",
    };
    await assert.rejects(
      observations.acceptProviderActivity({
        organizationId,
        providerId: providerA,
        event: {
          ...invalidEnvelope,
          eventDigest: providerActivityEventDigest(invalidEnvelope),
        },
        health: health(providerA),
        receivedAt: new Date(base.getTime() + 62_000),
        completionProof: newestAProof,
      }),
      /completion envelope is invalid/u,
    );

    const delayedAProof = await proof({
      providerId: providerA,
      providerKey: "relay_provider_a",
      providerReleaseId: "72000000-0000-5000-8000-000000000025",
      artifactAttemptId: "72000000-0000-4000-8000-000000000043",
      sequence: 20n,
    });
    const delayedA = completion({
      id: "72000000-0000-4000-8000-000000000024",
      proof: delayedAProof,
      eventAt: new Date(base.getTime() - 1_000),
    });
    const delayed = await observations.acceptProviderActivity({
      organizationId,
      providerId: providerA,
      event: delayedA,
      health: health(providerA),
      receivedAt: new Date(base.getTime() + 63_000),
      completionProof: delayedAProof,
    });
    assert.equal(delayed.state, "accepted");
    assert.deepEqual(
      [
        delayed.completionGate?.observedCompletionGeneration,
        delayed.completionGate?.requestedGeneration,
        delayed.completionGate?.evidenceDigest,
      ],
      [20n, 1n, newestA.eventDigest],
    );
    assert.equal(
      (await harness.client.manifest_reconciliation_job_wake
        .findUniqueOrThrow({ where: { singleton_key: true } }))
        .requested_generation,
      1n,
      "a delayed source sequence neither rewinds the gate nor wakes it again",
    );
    const claimedAOne = await gates.claimNext({
      owner: "manifest-overlap-test",
      now: new Date(base.getTime() + 63_500),
      claimMilliseconds: 60_000,
    });
    assert.equal(claimedAOne?.providerId, providerA);
    assert.equal(claimedAOne?.observedGeneration, 1n);
    assert.equal(claimedAOne?.latestEvidenceDigest, newestA.eventDigest);

    const providerBProof = await proof({
      providerId: providerB,
      providerKey: "relay_provider_b",
      providerReleaseId: "72000000-0000-5000-8000-000000000028",
      artifactAttemptId: "72000000-0000-4000-8000-000000000044",
      sequence: 8n,
    });
    const providerBEvent = completion({
      id: "72000000-0000-4000-8000-000000000027",
      proof: providerBProof,
      eventAt: new Date(base.getTime() + 2_000),
    });
    await harness.client.$executeRawUnsafe(`
      create function packscout_test_reject_completion_gate()
      returns trigger language plpgsql as $$
      begin
        raise exception using errcode = '55000',
          message = 'test_completion_gate_rejected';
      end;
      $$
    `);
    await harness.client.$executeRawUnsafe(`
      create trigger packscout_test_reject_completion_gate_trigger
      before insert on manifest_gate_intents
      for each row execute function packscout_test_reject_completion_gate()
    `);
    await assert.rejects(
      observations.acceptProviderActivity({
        organizationId,
        providerId: providerB,
        event: providerBEvent,
        health: health(providerB),
        receivedAt: new Date(base.getTime() + 64_000),
        completionProof: providerBProof,
      }),
      /test_completion_gate_rejected/u,
    );
    assert.equal(
      await harness.client.provider_activity_events.count({
        where: { provider_id: providerB },
      }),
      0,
      "the inbox insert rolls back when gate coalescing fails",
    );
    const [{ count: rolledBackPlans } = { count: -1n }] =
      await harness.client.$queryRaw<Array<{ count: bigint }>>`
        select count(*)::bigint as count
        from provider_completion_publish_plans
        where provider_id = ${providerB}::uuid
      `;
    assert.equal(rolledBackPlans, 0n, "the plan cache rolls back with the gate");
    await harness.client.$executeRawUnsafe(`
      drop trigger packscout_test_reject_completion_gate_trigger
        on manifest_gate_intents
    `);
    await harness.client.$executeRawUnsafe(`
      drop function packscout_test_reject_completion_gate()
    `);

    await harness.client.$executeRawUnsafe(`
      create function packscout_test_reject_manifest_wake()
      returns trigger language plpgsql as $$
      begin
        raise exception using errcode = '55000',
          message = 'test_manifest_wake_rejected';
      end;
      $$
    `);
    await harness.client.$executeRawUnsafe(`
      create trigger packscout_test_reject_manifest_wake_trigger
      before update on manifest_reconciliation_job_wake
      for each row execute function packscout_test_reject_manifest_wake()
    `);
    await assert.rejects(
      observations.acceptProviderActivity({
        organizationId,
        providerId: providerB,
        event: providerBEvent,
        health: health(providerB),
        receivedAt: new Date(base.getTime() + 64_500),
        completionProof: providerBProof,
      }),
      /test_manifest_wake_rejected/u,
    );
    assert.equal(
      await harness.client.provider_activity_events.count({
        where: { provider_id: providerB },
      }),
      0,
      "the inbox rolls back when the atomic manifest wake fails",
    );
    assert.equal(await gates.load(providerB), null);
    assert.equal(
      (await harness.client.manifest_reconciliation_job_wake
        .findUniqueOrThrow({ where: { singleton_key: true } }))
        .requested_generation,
      1n,
    );
    await harness.client.$executeRawUnsafe(`
      drop trigger packscout_test_reject_manifest_wake_trigger
        on manifest_reconciliation_job_wake
    `);
    await harness.client.$executeRawUnsafe(`
      drop function packscout_test_reject_manifest_wake()
    `);

    const acceptedB = await observations.acceptProviderActivity({
      organizationId,
      providerId: providerB,
      event: providerBEvent,
      health: health(providerB, new Date(base.getTime() + 2_000)),
      receivedAt: new Date(base.getTime() + 65_000),
      completionProof: providerBProof,
    });
    assert.equal((await gates.load(providerB))?.requestedGeneration, 1n);
    assert.equal(acceptedB.completionGate?.manifestWakeGeneration, 2n);

    const reusedAProof = await buildProviderCompletionPlanProofFixture({
      providerId: providerA,
      providerKey: "relay_provider_a",
      providerReleaseId: newestAProof.providerReleaseId,
      catalogVersionId,
      catalogContentHash,
      artifactAttemptId: "72000000-0000-4000-8000-000000000045",
      releaseSequence: 21n,
      completionSequence: 22n,
      terminalOperationKind: "confirmReuse",
      terminalReceiptSha256: "7".repeat(64),
    });
    const reusedA = completion({
      id: "72000000-0000-4000-8000-000000000046",
      proof: reusedAProof,
      state: "reused",
      eventAt: new Date(base.getTime() + 3_000),
    });
    const reusedAcceptance = await observations.acceptProviderActivity({
      organizationId,
      providerId: providerA,
      event: reusedA,
      health: health(providerA, new Date(base.getTime() + 3_000)),
      receivedAt: new Date(base.getTime() + 65_250),
      completionProof: reusedAProof,
    });
    assert.equal((await gates.load(providerA))?.requestedGeneration, 2n);
    assert.equal(reusedAcceptance.completionGate?.manifestWakeGeneration, 3n);
    const revalidatedAOne = await gates.verifyActiveClaim(
      claimedAOne!,
      new Date(base.getTime() + 65_300),
    );
    assert.deepEqual(
      [revalidatedAOne.observedGeneration,
        revalidatedAOne.requestedGeneration,
        revalidatedAOne.latestEvidenceDigest],
      [1n, 2n, newestA.eventDigest],
      "a later source retains the exact evidence of an active older claim",
    );
    const afterOldClaim = await gates.acknowledgeClaim({
      providerId: claimedAOne!.providerId,
      claimToken: claimedAOne!.claimToken,
      observedGeneration: claimedAOne!.observedGeneration,
      acknowledgedAt: new Date(base.getTime() + 65_350),
    });
    assert.deepEqual(
      [afterOldClaim.requestedGeneration,
        afterOldClaim.acknowledgedGeneration, afterOldClaim.pending],
      [2n, 1n, true],
      "the later provider completion remains pending after the old claim closes",
    );

    const ambiguousAProof = await buildProviderCompletionPlanProofFixture({
      providerId: providerA,
      providerKey: "relay_provider_a",
      providerReleaseId: newestAProof.providerReleaseId,
      catalogVersionId,
      catalogContentHash,
      artifactAttemptId: "72000000-0000-4000-8000-000000000047",
      releaseSequence: 23n,
    });
    const ambiguousA = completion({
      id: "72000000-0000-4000-8000-000000000048",
      proof: ambiguousAProof,
      eventAt: new Date(base.getTime() + 4_000),
    });
    await assert.rejects(
      observations.acceptProviderActivity({
        organizationId,
        providerId: providerA,
        event: ambiguousA,
        health: health(providerA, new Date(base.getTime() + 4_000)),
        receivedAt: new Date(base.getTime() + 65_500),
        completionProof: ambiguousAProof,
      }),
      /cache is inconsistent/u,
    );
    assert.equal((await gates.load(providerA))?.requestedGeneration, 2n);
    assert.deepEqual(
      (await gates.listPending({ limit: 10 })).map((gate) => [
        gate.providerId,
        gate.requestedGeneration,
      ]),
      [[providerA, 2n], [providerB, 1n]],
    );

    const byEvidence = await cache.loadByEvidence({
      providerId: providerA,
      evidenceDigest: newestA.eventDigest,
    });
    assert.equal(byEvidence?.planSha256.length, 64);
    assert.equal(
      byEvidence?.completedHead.terminalReceiptSha256,
      newestAProof.terminalReceiptSha256,
    );
    assert.equal(
      byEvidence?.activeObservation.terminalOperationId,
      newestAProof.terminalOperationId,
    );
    assert.equal((await cache.loadExact({
      providerId: providerA,
      providerReleaseId: newestAProof.providerReleaseId,
      publicProviderReleaseId: newestAProof.publicProviderReleaseId,
      providerReleaseFingerprint: newestAProof.providerReleaseFingerprint,
      artifactAttemptId: newestAProof.artifactAttemptId,
      evidenceDigest: newestA.eventDigest,
    }))?.eventId, newestA.id);
    assert.deepEqual(
      (await cache.loadForManifestReferences([{
        providerKey: newestAProof.providerKey,
        publicProviderReleaseId: newestAProof.publicProviderReleaseId,
        providerReleaseFingerprint: newestAProof.providerReleaseFingerprint,
      }, {
        providerKey: providerBProof.providerKey,
        publicProviderReleaseId: providerBProof.publicProviderReleaseId,
        providerReleaseFingerprint: providerBProof.providerReleaseFingerprint,
      }]))?.map(({ providerKey }) => providerKey),
      ["relay_provider_a", "relay_provider_b"],
    );
    assert.equal((await cache.loadExplicitTarget({
      providerId: providerA,
      providerReleaseId: newestAProof.providerReleaseId,
      catalogVersionId,
    })).eventId, reusedA.id);
    await assert.rejects(
      cache.loadExplicitTarget({
        providerId: providerA,
        providerReleaseId: "72000000-0000-5000-8000-000000000099",
        catalogVersionId,
      }),
      /cache is inconsistent/u,
    );
    assert.equal((await cache.listRetentionMetadata({
      providerId: providerA,
      limit: 10,
    })).length, 3);

    const claimNow = new Date(base.getTime() + 66_000);
    const claim = await gates.claimNext({
      owner: "manifest-proof-test",
      now: claimNow,
      claimMilliseconds: 60_000,
    });
    assert.ok(claim);
    assert.deepEqual(
      await gates.verifyActiveClaim(claim, new Date(claimNow.getTime() + 1)),
      claim,
    );
    await assert.rejects(
      gates.verifyActiveClaim({
        ...claim,
        providerRowVersion: claim.providerRowVersion + 1n,
      }, new Date(claimNow.getTime() + 1)),
      /persistence state is invalid/u,
    );
    await assert.rejects(
      gates.verifyActiveClaim(claim, claim.claimExpiresAt),
      /persistence state is invalid/u,
    );
  } finally {
    await harness.close();
  }
});
