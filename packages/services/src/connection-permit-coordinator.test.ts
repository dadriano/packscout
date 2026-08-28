import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConnectionPermitCoordinator,
  ConnectionPermitCoordinatorError,
  type ConnectionPermitLaneIdentity,
  type PairedConnectionPermit,
} from "./connection-permit-coordinator.ts";

const organizationId = "organization-fixture";
const connectionProfileId = "profile-fixture";

function platformLane(providerId: string): ConnectionPermitLaneIdentity {
  return {
    organizationId,
    connectionProfileId,
    scope: "platform",
    providerId,
  };
}

function connectionTestLane(): ConnectionPermitLaneIdentity {
  return {
    organizationId,
    connectionProfileId,
    scope: "connection_test",
    providerId: null,
  };
}

function configure(
  coordinator: ConnectionPermitCoordinator,
  identity: ConnectionPermitLaneIdentity,
  approvedRequestCap = 2,
): ConnectionPermitLaneIdentity {
  coordinator.configureRequestPermitLane({
    ...identity,
    approvedRequestCap,
  });
  return identity;
}

async function settleMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("four platform lanes sharing one profile can hold permits concurrently", async () => {
  const coordinator = new ConnectionPermitCoordinator(4);
  const lanes = [
    platformLane("collector-crypt-provider"),
    platformLane("courtyard-provider"),
    platformLane("clutchpacks-provider"),
    platformLane("phygitals-provider"),
  ].map((lane) => configure(coordinator, lane));

  const permits: PairedConnectionPermit[] = [];
  for (const lane of lanes) {
    permits.push(await coordinator.acquire({ requestPermitLane: lane }));
  }

  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.maximumExecutionSlots, 4);
  assert.equal(snapshot.activeExecutionSlots, 4);
  assert.equal(snapshot.queuedOperations, 0);
  assert.deepEqual(
    snapshot.requestPermitLanes.map((lane) => ({
      providerId: lane.providerId,
      approvedRequestCap: lane.approvedRequestCap,
      activeRequestPermits: lane.activeRequestPermits,
    })),
    lanes.map((lane) => ({
      providerId: lane.providerId,
      approvedRequestCap: 2,
      activeRequestPermits: 1,
    })),
  );

  for (const permit of permits) permit.releaseAll();
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
});

test("each platform lane is independently capped at two and a third waits", async () => {
  const coordinator = new ConnectionPermitCoordinator(4);
  const lane = configure(coordinator, platformLane("courtyard-provider"));
  const first = await coordinator.acquire({ requestPermitLane: lane });
  const second = await coordinator.acquire({ requestPermitLane: lane });
  let thirdGranted = false;
  const thirdPromise = coordinator.acquire({ requestPermitLane: lane }).then(
    (permit) => {
      thirdGranted = true;
      return permit;
    },
  );

  await settleMicrotasks();
  assert.equal(thirdGranted, false);
  assert.equal(coordinator.waitReasonFor(lane), "request_lane_capacity");
  assert.deepEqual(coordinator.snapshot().requestPermitLanes[0], {
    ...lane,
    approvedRequestCap: 2,
    activeRequestPermits: 2,
    queuedOperations: 1,
  });

  first.releaseAll();
  const third = await thirdPromise;
  assert.equal(thirdGranted, true);
  second.releaseAll();
  third.releaseAll();
});

test("one saturated platform lane does not block another lane on the same profile", async () => {
  const coordinator = new ConnectionPermitCoordinator(4);
  const saturatedLane = configure(
    coordinator,
    platformLane("collector-crypt-provider"),
    1,
  );
  const independentLane = configure(
    coordinator,
    platformLane("phygitals-provider"),
    1,
  );
  const active = await coordinator.acquire({
    requestPermitLane: saturatedLane,
  });
  let blockedGranted = false;
  const blockedPromise = coordinator
    .acquire({ requestPermitLane: saturatedLane })
    .then((permit) => {
      blockedGranted = true;
      return permit;
    });

  const independent = await coordinator.acquire({
    requestPermitLane: independentLane,
  });
  assert.equal(blockedGranted, false);
  assert.equal(independent.requestPermitLane.providerId, "phygitals-provider");
  assert.equal(coordinator.snapshot().activeExecutionSlots, 2);

  active.releaseAll();
  const formerlyBlocked = await blockedPromise;
  independent.releaseAll();
  formerlyBlocked.releaseAll();
});

test("the connection-test lane is separately capped from every platform lane", async () => {
  const coordinator = new ConnectionPermitCoordinator(4);
  const testLane = configure(coordinator, connectionTestLane(), 1);
  const sourceLane = configure(
    coordinator,
    platformLane("courtyard-provider"),
    2,
  );
  const connectionTest = await coordinator.acquire({
    requestPermitLane: testLane,
  });
  let secondTestGranted = false;
  const secondTestPromise = coordinator
    .acquire({ requestPermitLane: testLane })
    .then((permit) => {
      secondTestGranted = true;
      return permit;
    });

  const pageRead = await coordinator.acquire({ requestPermitLane: sourceLane });
  await settleMicrotasks();
  assert.equal(secondTestGranted, false);
  assert.equal(coordinator.waitReasonFor(testLane), "request_lane_capacity");
  assert.equal(coordinator.waitReasonFor(sourceLane), null);
  assert.equal(coordinator.snapshot().activeExecutionSlots, 2);

  connectionTest.releaseAll();
  const secondTest = await secondTestPromise;
  pageRead.releaseAll();
  secondTest.releaseAll();
});

test("the generic execution-slot cap remains process-wide", async () => {
  const coordinator = new ConnectionPermitCoordinator(1);
  const firstLane = configure(coordinator, platformLane("provider-a"));
  const secondLane = configure(coordinator, platformLane("provider-b"));
  const first = await coordinator.acquire({ requestPermitLane: firstLane });
  let secondGranted = false;
  const secondPromise = coordinator.acquire({ requestPermitLane: secondLane }).then(
    (permit) => {
      secondGranted = true;
      return permit;
    },
  );

  await settleMicrotasks();
  assert.equal(secondGranted, false);
  assert.equal(coordinator.waitReasonFor(secondLane), "execution_capacity");
  first.releaseAll();
  const second = await secondPromise;
  second.releaseAll();
});

test("a queued operation holds neither paired resource", async () => {
  const coordinator = new ConnectionPermitCoordinator(4);
  const lane = configure(coordinator, platformLane("single-request-provider"), 1);
  const first = await coordinator.acquire({ requestPermitLane: lane });
  let second: PairedConnectionPermit | undefined;
  const pending = coordinator.acquire({ requestPermitLane: lane }).then((permit) => {
    second = permit;
    return permit;
  });

  await settleMicrotasks();
  assert.equal(second, undefined);
  assert.equal(coordinator.snapshot().activeExecutionSlots, 1);
  assert.equal(
    coordinator.snapshot().requestPermitLanes[0]?.activeRequestPermits,
    1,
  );

  first.releaseAll();
  (await pending).releaseAll();
});

test("an execution slot cannot release before its request permit", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  const lane = configure(coordinator, platformLane("ordered-release-provider"), 1);
  const permit = await coordinator.acquire({ requestPermitLane: lane });

  assert.throws(
    () => permit.releaseExecutionSlot(),
    (error) =>
      error instanceof ConnectionPermitCoordinatorError &&
      error.code === "request_permit_still_held",
  );
  assert.equal(coordinator.snapshot().activeExecutionSlots, 1);

  permit.releaseRequestPermit();
  permit.releaseExecutionSlot();
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
});

test("aborting a queued waiter removes it without consuming capacity", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  const lane = configure(coordinator, platformLane("cancel-provider"), 1);
  const first = await coordinator.acquire({ requestPermitLane: lane });
  const abortController = new AbortController();
  const cancelled = coordinator.acquire({
    requestPermitLane: lane,
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
});

test("request-cap changes fail closed while a lane is active or queued", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  const lane = configure(coordinator, platformLane("stable-provider"), 1);
  const permit = await coordinator.acquire({ requestPermitLane: lane });
  assert.throws(
    () =>
      coordinator.configureRequestPermitLane({
        ...lane,
        approvedRequestCap: 2,
      }),
    (error) =>
      error instanceof ConnectionPermitCoordinatorError &&
      error.code === "request_cap_change_while_in_use",
  );
  permit.releaseAll();
  coordinator.configureRequestPermitLane({ ...lane, approvedRequestCap: 2 });
  assert.equal(
    coordinator.snapshot().requestPermitLanes[0]?.approvedRequestCap,
    2,
  );
});

test("profile cancellation removes queued work from all exact-profile lanes only", async () => {
  const coordinator = new ConnectionPermitCoordinator(4);
  const platform = configure(coordinator, platformLane("provider-a"), 1);
  const testLane = configure(coordinator, connectionTestLane(), 1);
  const otherProfileLane = configure(
    coordinator,
    {
      organizationId,
      connectionProfileId: "other-profile",
      scope: "platform",
      providerId: "provider-b",
    },
    1,
  );
  const activePlatform = await coordinator.acquire({ requestPermitLane: platform });
  const activeTest = await coordinator.acquire({ requestPermitLane: testLane });
  const activeOther = await coordinator.acquire({
    requestPermitLane: otherProfileLane,
  });
  const queuedPlatform = coordinator.acquire({ requestPermitLane: platform });
  const queuedTest = coordinator.acquire({ requestPermitLane: testLane });
  const queuedOther = coordinator.acquire({ requestPermitLane: otherProfileLane });

  coordinator.cancelQueuedForProfile({ organizationId, connectionProfileId });
  await assert.rejects(queuedPlatform, { code: "cancelled" });
  await assert.rejects(queuedTest, { code: "cancelled" });
  assert.equal(coordinator.snapshot().queuedOperations, 1);

  activeOther.releaseAll();
  (await queuedOther).releaseAll();
  activePlatform.releaseAll();
  activeTest.releaseAll();
});

test("lane discriminants and provider identities are validated exactly", () => {
  const coordinator = new ConnectionPermitCoordinator();
  for (const invalid of [
    { ...platformLane("provider-a"), providerId: " " },
    { ...platformLane("provider-a"), providerId: null },
    { ...connectionTestLane(), providerId: "provider-a" },
    { ...connectionTestLane(), scope: "unknown" },
  ]) {
    assert.throws(
      () =>
        coordinator.configureRequestPermitLane({
          ...invalid,
          approvedRequestCap: 2,
        } as never),
      (error) =>
        error instanceof ConnectionPermitCoordinatorError &&
        error.code === "invalid_request_lane_identity",
    );
  }
});

test("irreversible drain rejects future admission without revoking active permits", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  const lane = configure(coordinator, platformLane("draining-provider"), 1);
  const active = await coordinator.acquire({ requestPermitLane: lane });
  const queued = coordinator.acquire({ requestPermitLane: lane });

  coordinator.stopAdmission();
  await assert.rejects(queued, { code: "cancelled" });
  await assert.rejects(
    coordinator.acquire({ requestPermitLane: lane }),
    { code: "admission_stopped" },
  );
  assert.equal(active.requestPermitHeld, true);
  assert.equal(active.executionSlotHeld, true);
  active.releaseAll();
});
