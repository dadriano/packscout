import assert from "node:assert/strict";
import { test } from "node:test";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { createProviderWorkerRuntime } from "./provider-worker-composition.ts";
import type { ProviderWorkerLogEvent } from "./provider-worker-runtime.ts";

test("worker composition runs an idle cycle against one Prisma client", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const events: ProviderWorkerLogEvent[] = [];
    const runtime = createProviderWorkerRuntime({
      configuration: {
        actorPseudonymKey: new Uint8Array(32).fill(1),
        credentialKey: new Uint8Array(32).fill(2),
        credentialKeyVersion: 1,
        environment: "test",
        estimatedEvVerifiedUsdStablecoins: [],
        maximumClaimsPerCycle: 5,
        pollIntervalMilliseconds: 100,
        retentionBatchSize: 10,
        retentionMaximumBatchesPerCycle: 2,
        retentionOrganizationDiscoveryLimit: 10,
        workerId: "prisma-composition-worker",
      },
      database: harness.client,
      logger: { write: (event) => void events.push(event) },
      observability: { metric() {}, log() {} },
    });

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
      ],
    );
  } finally {
    await harness.close();
  }
});
