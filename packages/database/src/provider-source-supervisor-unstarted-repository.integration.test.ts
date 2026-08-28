import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  activateAcceptanceRuntime,
  createAcceptanceProviderSource,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { ProviderSourceImportRunRepository } from
  "./provider-source-import-run-repository.ts";
import { ProviderSourceSupervisorRepository } from
  "./provider-source-supervisor-repository.ts";
import { ProviderSourceSupervisorWorkRepository } from
  "./provider-source-supervisor-work-repository.ts";
import { SourceConnectionAdminRepository } from
  "./source-connection-admin-repository.ts";

async function databaseNow(
  database: Awaited<ReturnType<typeof createProviderSourceAcceptanceFixture>>["database"],
): Promise<Date> {
  const rows = await database.$queryRaw<Array<{ now: Date }>>`
    select clock_timestamp() as "now"
  `;
  return rows[0]!.now;
}

test("a capacity wait preserves the page retry budget and next backoff", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "unstarted-capacity-retry",
  );
  try {
    const source = await createAcceptanceProviderSource(fixture, {
      platformKey: "phygitals",
      displayName: "Phygitals",
      mapperKey: "gamestop-phygitals-provider-observation",
      identityNamespaceKey: "dataforrest-phygitals-records-v1",
      intervalSeconds: 60,
      hashCharacter: "d",
    });
    const now = await databaseNow(fixture.database);
    await activateAcceptanceRuntime(fixture.database, fixture, source, now);

    const ownerKey = "unstarted-capacity-retry-owner";
    const leaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(fixture.database)
      .acquire({
        environmentKey: "unstarted-capacity-retry-environment",
        ownerKey,
        leaseToken,
        now,
      });
    const requested = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: now,
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    assert.equal(requested.kind, "created");
    if (requested.kind !== "created") throw new Error("Expected queued run.");

    await fixture.database.provider_source_runtime_states.update({
      where: { source_instance_id: source.sourceInstanceId },
      data: {
        phase: "queued",
        activity: "queued",
        current_run_id: requested.run.id,
        retry_attempt: 1,
        retry_not_before: null,
        queued_at: now,
        updated_at: now,
      },
    });

    const work = new ProviderSourceSupervisorWorkRepository(fixture.database);
    const firstClaim = await work.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(firstClaim?.kind, "page_read");
    if (!firstClaim || firstClaim.kind !== "page_read") {
      throw new Error("Expected first page claim.");
    }
    assert.equal(firstClaim.retryAttempt, 1);

    await work.releaseUnstartedClaim({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: firstClaim,
      waitReason: "capacity_blocked",
      releasedAt: now,
    });
    const waitingLane = await fixture.database.provider_source_runtime_states
      .findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      });
    assert.equal(waitingLane.wait_reason, "capacity_blocked");
    assert.equal(waitingLane.retry_attempt, 1);

    const secondClaim = await work.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(secondClaim?.kind, "page_read");
    if (!secondClaim || secondClaim.kind !== "page_read") {
      throw new Error("Expected second page claim.");
    }
    assert.equal(secondClaim.retryAttempt, 1);

    await work.finishPageTurn({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: secondClaim,
      decision: {
        kind: "retrying",
        retryAttempt: 2,
        retryDelayMilliseconds: 5_000,
        safeCode: "REQUEST_TIMEOUT",
      },
    });
    const retryLane = await fixture.database.provider_source_runtime_states
      .findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      });
    assert.equal(retryLane.phase, "retry_wait");
    assert.equal(retryLane.wait_reason, "retry_backoff");
    assert.equal(retryLane.retry_attempt, 2);
    assert.ok(retryLane.retry_not_before);

    const retryEvent = await fixture.database
      .source_processor_diagnostic_events.findFirstOrThrow({
        where: {
          source_instance_id: source.sourceInstanceId,
          phase: "retry_scheduled",
        },
        orderBy: { occurred_at: "desc" },
      });
    assert.equal(retryEvent.retry_delay_ms, 5_000);
  } finally {
    await fixture.close();
  }
});

test("saturated request lanes exclude only the exact platform or connection-test lane", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "request-lane-exclusion",
  );
  try {
    const [courtyard, phygitals] = await Promise.all([
      createAcceptanceProviderSource(fixture, {
        platformKey: "courtyard",
        displayName: "Courtyard",
        mapperKey: "courtyard-provider-observation",
        identityNamespaceKey: "dataforrest-courtyard-records-v1",
        intervalSeconds: 60,
        hashCharacter: "b",
      }),
      createAcceptanceProviderSource(fixture, {
        platformKey: "phygitals",
        displayName: "Phygitals",
        mapperKey: "phygitals-provider-observation",
        identityNamespaceKey: "dataforrest-phygitals-records-v1",
        intervalSeconds: 60,
        hashCharacter: "d",
      }),
    ]);
    const now = await databaseNow(fixture.database);
    await activateAcceptanceRuntime(fixture.database, fixture, courtyard, now);
    await activateAcceptanceRuntime(fixture.database, fixture, phygitals, now);

    await new SourceConnectionAdminRepository(fixture.database)
      .requestConnectionTest({
        organizationId: fixture.organizationId,
        connectionProfileId: fixture.connectionProfileId,
        connectionRevisionId: fixture.connectionRevisionId,
        expectedHealthGeneration: 0n,
        requestedByActorKey: "operator-admin",
        requestedAt: new Date(now.getTime() - 2_000),
      });
    const runs = new ProviderSourceImportRunRepository(fixture.database);
    const courtyardRun = await runs.requestRun({
      organizationId: fixture.organizationId,
      providerId: courtyard.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: new Date(now.getTime() - 1_000),
      expectedSourceRevisionId: courtyard.sourceRevisionId,
    });
    const phygitalsRun = await runs.requestRun({
      organizationId: fixture.organizationId,
      providerId: phygitals.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: now,
      expectedSourceRevisionId: phygitals.sourceRevisionId,
    });
    assert.equal(courtyardRun.kind, "created");
    assert.equal(phygitalsRun.kind, "created");

    const ownerKey = "request-lane-exclusion-owner";
    const leaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(
      fixture.database,
    ).acquire({
      environmentKey: "request-lane-exclusion-environment",
      ownerKey,
      leaseToken,
      now,
    });
    const claimed = await new ProviderSourceSupervisorWorkRepository(
      fixture.database,
    ).claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
      excludedRequestLanes: [
        {
          scope: "connection_test",
          organizationId: fixture.organizationId,
          connectionProfileId: fixture.connectionProfileId,
          providerId: null,
        },
        {
          scope: "platform",
          organizationId: fixture.organizationId,
          connectionProfileId: fixture.connectionProfileId,
          providerId: courtyard.providerId,
        },
      ],
    });

    assert.equal(claimed?.kind, "page_read");
    assert.equal(
      claimed?.kind === "page_read" ? claimed.providerId : null,
      phygitals.providerId,
    );
  } finally {
    await fixture.close();
  }
});
