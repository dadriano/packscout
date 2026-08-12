import assert from "node:assert/strict";
import { test } from "node:test";
import { DrizzleImportRunRepository } from "./import-run-repository.ts";
import {
  importRuns,
  organizations,
  providerConfigRevisions,
  providerSources,
} from "./schema/index.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

test("queued manual runs have one durable owner and recover after lease expiry", async () => {
  const context = await createMigratedTestDatabase();
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const providerId = "20000000-0000-4000-8000-000000000001";
  const revisionId = "30000000-0000-4000-8000-000000000001";
  const runId = "40000000-0000-4000-8000-000000000001";
  const requestedAt = new Date("2026-08-06T12:00:00.000Z");
  try {
    await context.database.insert(organizations).values({
      id: organizationId,
      slug: "manual-queue-test",
      name: "Manual queue test",
    });
    await context.database.insert(providerSources).values({
      id: providerId,
      organizationId,
      platformKey: "manual-queue-platform",
      displayName: "Manual queue provider",
    });
    await context.database.insert(providerConfigRevisions).values({
      id: revisionId,
      organizationId,
      providerId,
      version: 1,
      adapterKey: "http-cursor-v1",
      endpointUrl: "https://provider.example/feed",
      authMode: "none",
      scheduleSeconds: 300,
      staleAfterSeconds: 900,
      createdByActorKey: "actor:test",
    });
    await context.database.insert(importRuns).values({
      id: runId,
      organizationId,
      providerId,
      configRevisionId: revisionId,
      trigger: "manual",
      requestedByActorKey: "actor:manual-request",
      state: "queued",
      createdAt: requestedAt,
    });
    const repository = new DrizzleImportRunRepository(context.database);
    const claimedAt = new Date("2026-08-06T12:00:01.000Z");
    const leaseExpiresAt = new Date("2026-08-06T12:02:01.000Z");
    const raced = await Promise.all([
      repository.claimNextRun({
        workerId: "worker-a",
        claimedAt,
        leaseExpiresAt,
      }),
      repository.claimNextRun({
        workerId: "worker-b",
        claimedAt,
        leaseExpiresAt,
      }),
    ]);

    const claimed = raced.find((result) => result.kind === "claimed");
    assert.equal(
      raced.filter((result) => result.kind === "claimed").length,
      1,
    );
    assert.equal(raced.filter((result) => result.kind === "idle").length, 1);
    assert.equal(claimed?.kind, "claimed");
    if (claimed?.kind !== "claimed") throw new Error("Run was not claimed.");
    assert.equal(claimed.run.id, runId);
    assert.equal(claimed.run.organizationId, organizationId);
    assert.equal(claimed.run.trigger, "manual");

    const recovered = await repository.claimNextRun({
      workerId: "worker-recovery",
      claimedAt: leaseExpiresAt,
      leaseExpiresAt: new Date("2026-08-06T12:04:01.000Z"),
    });
    assert.equal(recovered.kind, "claimed");
    if (recovered.kind === "claimed") {
      assert.equal(recovered.run.id, runId);
      assert.equal(recovered.run.workerId, "worker-recovery");
    }
  } finally {
    await context.close();
  }
});
