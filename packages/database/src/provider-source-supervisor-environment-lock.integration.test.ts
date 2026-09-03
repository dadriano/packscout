import assert from "node:assert/strict";
import { test } from "node:test";
import { PersistenceError } from "./persistence-error.ts";
import { lockProviderSourceSupervisorEpochEnvironmentShared } from
  "./provider-source-supervisor-environment-lock.ts";
import { ProviderSourceSupervisorRepository } from
  "./provider-source-supervisor-repository.ts";
import { ProviderSourceSupervisorSnapshotRepository } from
  "./provider-source-supervisor-snapshot-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("operation did not complete while page guard was held")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function nextTurn(milliseconds = 100): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

test("page epoch guard permits heartbeats while serializing supervisor transitions", async () => {
  const fixture = await createMigratedTestDatabase();
  const supervisors = new ProviderSourceSupervisorRepository(fixture.database);
  const snapshots = new ProviderSourceSupervisorSnapshotRepository(
    fixture.database,
  );
  const environmentKey = "page-heartbeat-lock-separation";
  const ownerKey = "page-heartbeat-owner";
  const leaseToken = "00000000-0000-4000-8000-000000000801";
  const epoch = await supervisors.acquire({
    environmentKey,
    ownerKey,
    leaseToken,
    now: new Date(0),
  });
  const pageClient = await fixture.createIndependentClient();
  let releasePageGuard: (() => void) | undefined;
  let pageGuardAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => {
    pageGuardAcquired = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releasePageGuard = resolve;
  });
  const pageTransaction = pageClient.$transaction(async (transaction) => {
    assert.equal(
      await lockProviderSourceSupervisorEpochEnvironmentShared(
        transaction,
        epoch.epochId,
      ),
      true,
    );
    pageGuardAcquired();
    await hold;
  });

  try {
    await acquired;
    const [renewedLease] = await within(Promise.all([
      supervisors.renew({
        epochId: epoch.epochId,
        ownerKey,
        leaseToken,
        now: new Date(0),
      }),
      snapshots.publish({
        epochId: epoch.epochId,
        ownerKey,
        leaseToken,
        capacity: {
          maximumExecutionSlots: 4,
          activeExecutionSlots: 4,
          requestPermitLanes: [],
        },
        admission: { state: "available", safeCode: null },
      }),
    ]), 3_000);
    assert.ok(renewedLease > epoch.leaseExpiresAt);
    assert.equal((await fixture.database.source_supervisor_epochs
      .findUniqueOrThrow({ where: { id: epoch.epochId } }))
      .maximum_execution_slots, 4);

    let competingAcquireSettled = false;
    const competingAcquire = supervisors.acquire({
      environmentKey,
      ownerKey: "competing-owner",
      leaseToken: "00000000-0000-4000-8000-000000000802",
      now: new Date(0),
    });
    const observedAcquire = competingAcquire.then(
      () => {
        competingAcquireSettled = true;
      },
      () => {
        competingAcquireSettled = true;
      },
    );
    await nextTurn();
    assert.equal(
      competingAcquireSettled,
      false,
      "takeover must wait until the admitted page transaction releases its guard",
    );

    releasePageGuard?.();
    await pageTransaction;
    await assert.rejects(
      competingAcquire,
      (error: unknown) => error instanceof PersistenceError &&
        error.code === "SUPERVISOR_OWNERSHIP_LOST",
    );
    await observedAcquire;
  } finally {
    releasePageGuard?.();
    await Promise.allSettled([pageTransaction]);
    await fixture.close();
  }
});

test("acquire cannot expire an epoch whose concurrent renewal commits after its read", async () => {
  const fixture = await createMigratedTestDatabase();
  const supervisors = new ProviderSourceSupervisorRepository(fixture.database);
  const environmentKey = "late-renewal-acquire-race";
  const ownerKey = "late-renewal-owner";
  const leaseToken = "00000000-0000-4000-8000-000000000811";
  const epoch = await supervisors.acquire({
    environmentKey,
    ownerKey,
    leaseToken,
    now: new Date(0),
  });
  const databaseNow = (await fixture.database.$queryRaw<Array<{ now: Date }>>`
    select clock_timestamp() as "now"
  `)[0]!.now;
  await fixture.database.source_supervisor_epochs.update({
    where: { id: epoch.epochId },
    data: {
      acquired_at: new Date(databaseNow.getTime() - 60_000),
      last_renewed_at: new Date(databaseNow.getTime() - 60_000),
      lease_expires_at: new Date(databaseNow.getTime() - 30_000),
      takeover_not_before: new Date(databaseNow.getTime() - 15_000),
    },
  });

  const renewalClient = await fixture.createIndependentClient();
  let commitRenewal: (() => void) | undefined;
  let renewalUpdated!: () => void;
  const updated = new Promise<void>((resolve) => {
    renewalUpdated = resolve;
  });
  const holdRenewal = new Promise<void>((resolve) => {
    commitRenewal = resolve;
  });
  const renewal = renewalClient.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      update public.source_supervisor_epochs
      set last_renewed_at = clock_timestamp(),
          lease_expires_at = clock_timestamp() + interval '60 seconds',
          takeover_not_before = clock_timestamp() + interval '75 seconds'
      where id = ${epoch.epochId}::uuid
        and owner_key = ${ownerKey}
        and lease_token = ${leaseToken}::uuid
        and state = 'active'::public.supervisor_epoch_state
    `;
    renewalUpdated();
    await holdRenewal;
  });

  try {
    await updated;
    let acquireSettled = false;
    const competingAcquire = supervisors.acquire({
      environmentKey,
      ownerKey: "late-renewal-competitor",
      leaseToken: "00000000-0000-4000-8000-000000000812",
      now: new Date(0),
    });
    const observedAcquire = competingAcquire.then(
      () => {
        acquireSettled = true;
      },
      () => {
        acquireSettled = true;
      },
    );
    await nextTurn();
    assert.equal(
      acquireSettled,
      false,
      "acquire must be waiting on the uncommitted renewal row version",
    );

    commitRenewal?.();
    await renewal;
    await assert.rejects(
      competingAcquire,
      (error: unknown) => error instanceof PersistenceError &&
        error.code === "SUPERVISOR_OWNERSHIP_LOST",
    );
    await observedAcquire;
    const epochs = await fixture.database.source_supervisor_epochs.findMany({
      where: { environment_key: environmentKey },
      orderBy: { epoch_number: "asc" },
    });
    assert.equal(epochs.length, 1);
    assert.equal(epochs[0]!.id, epoch.epochId);
    assert.equal(epochs[0]!.state, "active");
    assert.ok(epochs[0]!.takeover_not_before > new Date());
  } finally {
    commitRenewal?.();
    await Promise.allSettled([renewal]);
    await fixture.close();
  }
});
