import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConnectionPermitCoordinator,
  ConnectionPermitCoordinatorError,
  type ConnectionProfilePermitIdentity,
  type PairedConnectionPermit,
} from "./connection-permit-coordinator.ts";

const organizationId = "organization-fixture";

function profile(connectionProfileId: string): ConnectionProfilePermitIdentity {
  return { organizationId, connectionProfileId };
}

function configure(
  coordinator: ConnectionPermitCoordinator,
  connectionProfileId: string,
  approvedAggregateRequestCap: number,
): ConnectionProfilePermitIdentity {
  const identity = profile(connectionProfileId);
  coordinator.configureProfile({
    ...identity,
    approvedAggregateRequestCap,
  });
  return identity;
}

async function settleMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("a configured execution-slot cap bounds independent profiles", async () => {
  const coordinator = new ConnectionPermitCoordinator(1);
  const firstProfile = configure(coordinator, "profile-a", 2);
  const secondProfile = configure(coordinator, "profile-b", 1);
  const first = await coordinator.acquire({ profile: firstProfile });
  let secondGranted = false;
  const secondPromise = coordinator.acquire({ profile: secondProfile }).then(
    (permit) => {
      secondGranted = true;
      return permit;
    },
  );

  await settleMicrotasks();
  assert.equal(secondGranted, false);
  assert.equal(coordinator.snapshot().maximumExecutionSlots, 1);

  first.releaseAll();
  const second = await secondPromise;
  assert.equal(secondGranted, true);
  second.releaseAll();
});

test("a stable profile cap is shared while independent profiles can run", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  const shared = configure(coordinator, "shared-data-service", 2);
  const independent = configure(coordinator, "independent-service", 2);

  const sharedOne = await coordinator.acquire({ profile: shared });
  const sharedTwo = await coordinator.acquire({ profile: shared });
  let sharedThreeGranted = false;
  const sharedThreePromise = coordinator.acquire({ profile: shared }).then(
    (permit) => {
      sharedThreeGranted = true;
      return permit;
    },
  );
  const independentOne = await coordinator.acquire({ profile: independent });

  await settleMicrotasks();
  assert.equal(sharedThreeGranted, false);
  assert.deepEqual(coordinator.snapshot(), {
    maximumExecutionSlots: 4,
    activeExecutionSlots: 3,
    queuedOperations: 1,
    profiles: [
      {
        ...shared,
        approvedAggregateRequestCap: 2,
        activeRequestPermits: 2,
        queuedOperations: 1,
      },
      {
        ...independent,
        approvedAggregateRequestCap: 2,
        activeRequestPermits: 1,
        queuedOperations: 0,
      },
    ],
  });

  sharedOne.releaseAll();
  const sharedThree = await sharedThreePromise;
  assert.equal(sharedThreeGranted, true);

  sharedTwo.releaseAll();
  sharedThree.releaseAll();
  independentOne.releaseAll();
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
});

test("the oldest eligible waiter bypasses an older profile-blocked waiter", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  const blockedProfile = configure(coordinator, "profile-a", 1);
  const eligibleProfile = configure(coordinator, "profile-b", 1);
  const first = await coordinator.acquire({ profile: blockedProfile });
  const grants: string[] = [];

  const blockedPromise = coordinator.acquire({ profile: blockedProfile }).then(
    (permit) => {
      grants.push("blocked-profile");
      return permit;
    },
  );
  const eligible = await coordinator.acquire({ profile: eligibleProfile }).then(
    (permit) => {
      grants.push("eligible-profile");
      return permit;
    },
  );
  assert.deepEqual(grants, ["eligible-profile"]);

  first.releaseRequestPermit();
  const formerlyBlocked = await blockedPromise;
  assert.deepEqual(grants, ["eligible-profile", "blocked-profile"]);

  first.releaseExecutionSlot();
  eligible.releaseAll();
  formerlyBlocked.releaseAll();
});

test("a queued operation holds neither of the paired resources", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  const identity = configure(coordinator, "single-request-profile", 1);
  const first = await coordinator.acquire({ profile: identity });
  let second: PairedConnectionPermit | undefined;
  const pending = coordinator.acquire({ profile: identity }).then((permit) => {
    second = permit;
    return permit;
  });

  await settleMicrotasks();
  assert.equal(second, undefined);
  assert.equal(coordinator.snapshot().activeExecutionSlots, 1);
  assert.equal(
    coordinator.snapshot().profiles[0]?.activeRequestPermits,
    1,
  );

  first.releaseAll();
  (await pending).releaseAll();
});

test("an execution slot cannot release before its request permit", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  const identity = configure(coordinator, "ordered-release-profile", 1);
  const permit = await coordinator.acquire({ profile: identity });

  assert.throws(
    () => permit.releaseExecutionSlot(),
    (error) =>
      error instanceof ConnectionPermitCoordinatorError &&
      error.code === "request_permit_still_held",
  );
  assert.equal(coordinator.snapshot().activeExecutionSlots, 1);
  assert.equal(
    coordinator.snapshot().profiles[0]?.activeRequestPermits,
    1,
  );

  permit.releaseRequestPermit();
  permit.releaseExecutionSlot();
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
});

test("the process coordinator never admits more than four execution slots", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  const identities = Array.from({ length: 5 }, (_, index) =>
    configure(coordinator, `profile-${index}`, 1));
  const granted: PairedConnectionPermit[] = [];
  for (const identity of identities.slice(0, 4)) {
    granted.push(await coordinator.acquire({ profile: identity }));
  }
  let fifthGranted = false;
  const fifthPromise = coordinator.acquire({ profile: identities[4]! }).then(
    (permit) => {
      fifthGranted = true;
      return permit;
    },
  );
  await settleMicrotasks();
  assert.equal(fifthGranted, false);
  assert.equal(coordinator.snapshot().activeExecutionSlots, 4);

  granted[0]!.releaseRequestPermit();
  await settleMicrotasks();
  assert.equal(fifthGranted, false, "a request permit is not an execution slot");
  granted[0]!.releaseExecutionSlot();
  const fifth = await fifthPromise;
  assert.equal(fifthGranted, true);
  assert.equal(coordinator.snapshot().activeExecutionSlots, 4);

  for (const permit of granted) {
    permit.releaseAll();
  }
  fifth.releaseAll();
});

test("aborting a queued waiter removes it without consuming capacity", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  const identity = configure(coordinator, "cancel-profile", 1);
  const first = await coordinator.acquire({ profile: identity });
  const abortController = new AbortController();
  const cancelled = coordinator.acquire({
    profile: identity,
    signal: abortController.signal,
  });
  assert.equal(coordinator.snapshot().queuedOperations, 1);

  abortController.abort();
  await assert.rejects(
    cancelled,
    (error) =>
      error instanceof ConnectionPermitCoordinatorError &&
      error.code === "cancelled",
  );
  assert.equal(coordinator.snapshot().queuedOperations, 0);
  assert.equal(coordinator.snapshot().activeExecutionSlots, 1);

  first.releaseAll();
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
});

test("profile cap changes fail closed while a profile is active or queued", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  const identity = configure(coordinator, "stable-profile", 1);
  const permit = await coordinator.acquire({ profile: identity });
  assert.throws(
    () => coordinator.configureProfile({ ...identity, approvedAggregateRequestCap: 2 }),
    (error) =>
      error instanceof ConnectionPermitCoordinatorError &&
      error.code === "profile_cap_change_while_in_use",
  );
  permit.releaseAll();
  coordinator.configureProfile({ ...identity, approvedAggregateRequestCap: 2 });
  assert.equal(
    coordinator.snapshot().profiles[0]?.approvedAggregateRequestCap,
    2,
  );
});

test("queue cancellation and irreversible drain never revoke active permits", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  const identity = configure(coordinator, "draining-profile", 1);
  const active = await coordinator.acquire({ profile: identity });
  const queued = coordinator.acquire({ profile: identity });

  coordinator.cancelQueued();
  await assert.rejects(
    queued,
    (error) =>
      error instanceof ConnectionPermitCoordinatorError &&
      error.code === "cancelled",
  );
  assert.equal(active.requestPermitHeld, true);
  assert.equal(active.executionSlotHeld, true);

  coordinator.stopAdmission();
  await assert.rejects(
    coordinator.acquire({ profile: identity }),
    (error) =>
      error instanceof ConnectionPermitCoordinatorError &&
      error.code === "admission_stopped",
  );
  active.releaseAll();
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
});
