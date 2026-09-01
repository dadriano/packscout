import assert from "node:assert/strict";
import test from "node:test";
import {
  providerActivityEventDigest,
  type ProviderActivityEvent,
  type ProviderLocalHealthObservation,
} from "./provider-activity-contract.ts";
import { PrismaManifestGateIntentRepository } from
  "./manifest-gate-intent-repository.ts";
import { CentralProviderObservationRepository } from
  "./provider-observation-repository.ts";
import { createMigratedCentralTestDatabase } from "./test-support.ts";

const organizationId = "72000000-0000-4000-8000-000000000001";
const providerA = "72000000-0000-4000-8000-000000000002";
const providerB = "72000000-0000-4000-8000-000000000003";
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
  providerReleaseId: string;
  publicProviderReleaseId: string;
  sequence: string;
  eventAt: Date;
  state?: "complete" | "reused";
}>): ProviderActivityEvent {
  const state = input.state ?? "complete";
  const identity = {
    id: input.id,
    eventType: "provider_release_completed",
    severity: "info" as const,
    dedupeKey:
      `provider-release-completed:${input.providerReleaseId}:${input.sequence}`,
    recoveryKey: `provider-release:${input.providerReleaseId}`,
    localRunId: null,
    localQuarantineId: null,
    title: "Provider release publication completed",
    summary: state === "complete"
      ? "An immutable provider release completed publication."
      : "An unchanged immutable provider release confirmed a newer boundary.",
    evidence: {
      state,
      providerReleaseId: input.providerReleaseId,
      publicProviderReleaseId: input.publicProviderReleaseId,
      catalogVersionId: "72000000-0000-4000-8000-000000000010",
      catalogContentHash: "a".repeat(64),
      providerReleaseContentHash: "b".repeat(64),
      providerReleaseFingerprint: "c".repeat(64),
      completedThroughChangeSequence: input.sequence,
      terminalReceiptSha256: "d".repeat(64),
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

test("completion relay converges across duplicate, delay, restart, and provider isolation", async () => {
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
    const observations = new CentralProviderObservationRepository(
      harness.client,
    );
    const gates = new PrismaManifestGateIntentRepository(harness.client);
    const newestA = completion({
      id: "72000000-0000-4000-8000-000000000020",
      providerReleaseId: "72000000-0000-5000-8000-000000000021",
      publicProviderReleaseId: "72000000-0000-5000-8000-000000000022",
      sequence: "21",
      eventAt: base,
    });

    const accepted = await observations.acceptProviderActivity({
      organizationId,
      providerId: providerA,
      event: newestA,
      health: health(providerA),
      receivedAt: new Date(base.getTime() + 1_000),
    });
    assert.equal(accepted.state, "accepted");
    assert.deepEqual(accepted.completionGate, {
      providerId: providerA,
      observedCompletionGeneration: 21n,
      requestedGeneration: 21n,
      acknowledgedGeneration: 0n,
      evidenceDigest: newestA.eventDigest,
      pending: true,
    });
    assert.equal(
      await harness.client.provider_activity_events.count({
        where: { provider_id: providerA },
      }),
      1,
    );

    const conflictingGeneration = completion({
      id: "72000000-0000-4000-8000-000000000030",
      providerReleaseId: "72000000-0000-5000-8000-000000000031",
      publicProviderReleaseId: "72000000-0000-5000-8000-000000000032",
      sequence: "21",
      eventAt: new Date(base.getTime() + 500),
    });
    await assert.rejects(
      observations.acceptProviderActivity({
        organizationId,
        providerId: providerA,
        event: conflictingGeneration,
        health: health(providerA),
        receivedAt: new Date(base.getTime() + 1_500),
      }),
      /completion generation is inconsistent/u,
    );
    assert.equal(
      await harness.client.provider_activity_events.count({
        where: { provider_id: providerA },
      }),
      1,
    );
    assert.equal((await gates.load(providerA))?.requestedGeneration, 21n);

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
    });
    assert.equal(replay.state, "deduplicated");
    assert.equal(replay.completionGate?.requestedGeneration, 21n);
    assert.equal(
      await harness.client.provider_activity_events.count({
        where: { provider_id: providerA },
      }),
      1,
    );
    assert.equal(
      (await harness.client.manifest_gate_intents.findUniqueOrThrow({
        where: { provider_id: providerA },
      })).row_version,
      1n,
    );

    await assert.rejects(
      restarted.acceptProviderActivity({
        organizationId,
        providerId: providerB,
        event: newestA,
        health: health(providerB),
        receivedAt: new Date(base.getTime() + 61_000),
      }),
      /immutable identity conflict/u,
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
      }),
      /completion envelope is invalid/u,
    );
    assert.equal(
      await harness.client.provider_activity_events.count({
        where: { provider_id: providerA },
      }),
      1,
    );

    const delayedA = completion({
      id: "72000000-0000-4000-8000-000000000024",
      providerReleaseId: "72000000-0000-5000-8000-000000000025",
      publicProviderReleaseId: "72000000-0000-5000-8000-000000000026",
      sequence: "20",
      eventAt: new Date(base.getTime() - 1_000),
    });
    const delayed = await observations.acceptProviderActivity({
      organizationId,
      providerId: providerA,
      event: delayedA,
      health: health(providerA),
      receivedAt: new Date(base.getTime() + 63_000),
    });
    assert.equal(delayed.state, "accepted");
    assert.deepEqual(
      [
        delayed.completionGate?.observedCompletionGeneration,
        delayed.completionGate?.requestedGeneration,
        delayed.completionGate?.evidenceDigest,
      ],
      [20n, 21n, newestA.eventDigest],
    );

    const providerBEvent = completion({
      id: "72000000-0000-4000-8000-000000000027",
      providerReleaseId: "72000000-0000-5000-8000-000000000028",
      publicProviderReleaseId: "72000000-0000-5000-8000-000000000029",
      sequence: "8",
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
    await harness.client.$executeRawUnsafe(`
      drop trigger packscout_test_reject_completion_gate_trigger
        on manifest_gate_intents
    `);
    await harness.client.$executeRawUnsafe(`
      drop function packscout_test_reject_completion_gate()
    `);

    await observations.acceptProviderActivity({
      organizationId,
      providerId: providerB,
      event: providerBEvent,
      health: health(providerB, new Date(base.getTime() + 2_000)),
      receivedAt: new Date(base.getTime() + 65_000),
    });
    assert.equal((await gates.load(providerB))?.requestedGeneration, 8n);
    assert.deepEqual(
      (await gates.listPending({ limit: 10 })).map((gate) => [
        gate.providerId,
        gate.requestedGeneration,
      ]),
      [[providerA, 21n], [providerB, 8n]],
    );
    assert.deepEqual(
      [
        (await gates.load(providerA))?.requestedGeneration,
        (await gates.load(providerA))?.latestEvidenceDigest,
      ],
      [21n, newestA.eventDigest],
      "provider B acceptance preserves provider A exactly",
    );
  } finally {
    await harness.close();
  }
});
