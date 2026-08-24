import assert from "node:assert/strict";
import { test } from "node:test";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { createProviderWorkerRuntime } from "./provider-worker-composition.ts";
import type { ProviderWorkerLogEvent } from "./provider-worker-runtime.ts";

const configuration = Object.freeze({
  actorPseudonymKey: new Uint8Array(32).fill(1),
  credentialKey: new Uint8Array(32).fill(2),
  credentialKeyVersion: 1,
  environment: "test" as const,
  estimatedEvVerifiedUsdStablecoins: [],
  heartbeatIntervalMilliseconds: 15_000,
  importRunLeaseMilliseconds: 120_000,
  maximumClaimsPerCycle: 5,
  messageOutboxBackoffBaseMilliseconds: 1_000,
  messageOutboxBackoffCapMilliseconds: 60_000,
  messageOutboxBatchSize: 10,
  messageOutboxLeaseMilliseconds: 30_000,
  messageOutboxMaximumAttempts: 4,
  messageOutboxPerRecipientLimit: 3,
  messageOutboxPollMilliseconds: 1_000,
  messageOutboxRetentionDays: 30,
  pollIntervalMilliseconds: 100,
  presenceRetentionDays: 14,
  presenceStaleAfterMilliseconds: 60_000,
  retentionBatchSize: 10,
  retentionMaximumBatchesPerCycle: 2,
  retentionOrganizationDiscoveryLimit: 10,
  runHeartbeatStaleAfterMilliseconds: 300_000,
  scheduleClaimLeaseMilliseconds: 30_000,
  welcomeDispatchBatchSize: 10,
  welcomeDispatchLeaseMilliseconds: 300_000,
  welcomeDispatchPollMilliseconds: 60_000,
  workerHost: "composition-host",
  workerId: "prisma-composition-worker",
  workerVersion: "0.0.0-test",
});

test("worker composition runs an idle cycle against one Prisma client", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const events: ProviderWorkerLogEvent[] = [];
    const runtime = createProviderWorkerRuntime({
      configuration,
      database: harness.client,
      // A hermetic environment: no delivery mode, credentials, or origins
      // leak in from the developer machine running this test.
      env: {},
      logger: { write: (event) => void events.push(event) },
      observability: { metric() {}, log() {} },
    });

    assert.deepEqual(runtime.sourceImports.sourceAdapters.keys(), [
      "dataforrest-events-v1",
    ]);
    assert.deepEqual(
      runtime.sourceImports.mappers.descriptors().map((descriptor) => ({
        provider: descriptor.provider,
        mapperKey: descriptor.mapperKey,
        mapperVersion: descriptor.mapperVersion,
      })),
      [
        {
          provider: "courtyard",
          mapperKey: "courtyard-provider-observation",
          mapperVersion: "1",
        },
        {
          provider: "collector_crypt",
          mapperKey: "collector-crypt-provider-observation",
          mapperVersion: "1",
        },
        {
          provider: "phygitals",
          mapperKey: "phygitals-provider-observation",
          mapperVersion: "1",
        },
        {
          provider: "clutchpacks",
          mapperKey: "clutchpacks-provider-observation",
          mapperVersion: "1",
        },
      ],
    );

    const result = await runtime.runCycle();

    assert.deepEqual(result, {
      claims: 0,
      executions: 0,
      contentions: 0,
      failures: 0,
      reason: "idle",
    });
    assert.deepEqual(
      events.map(({ event }) => event),
      [
        "provider_estimated_ev_cycle_finished",
        "provider_retention_cycle_finished",
        "provider_message_outbox_cycle_finished",
      ],
    );
  } finally {
    await harness.close();
  }
});

test("the identity an instance publishes is the identity it claims and leases with", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const events: ProviderWorkerLogEvent[] = [];
    const build = () =>
      createProviderWorkerRuntime({
        configuration,
        database: harness.client,
        logger: { write: (event) => void events.push(event) },
        observability: { metric() {}, log() {} },
      });
    const runtime = build();
    const replica = build();

    // Two replicas of one deployment read the same PACKSCOUT_WORKER_ID, so the
    // configured value alone cannot identify either of them.
    assert.notEqual(runtime.workerId, replica.workerId);
    assert.match(
      runtime.workerId,
      /^prisma-composition-worker:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    );

    // Registration happens before the first cycle, so stopping immediately still
    // leaves the presence record this instance published.
    const started = runtime.start();
    runtime.stop();
    await started;

    const instances = await harness.database.worker_instances.findMany({
      select: { instance_id: true },
    });
    // The presence row, the schedule claim owner, and the import-run lease owner
    // are one string: the fleet view joins a held run back to a live worker
    // through it, so they cannot be allowed to drift apart.
    assert.deepEqual(
      instances.map((row) => row.instance_id),
      [runtime.workerId],
    );
  } finally {
    await harness.close();
  }
});
