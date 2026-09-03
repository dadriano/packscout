import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionPermitCoordinator } from "./connection-permit-coordinator.ts";
import {
  SourceRequestLeaseAuthority,
  SourceRequestLeaseError,
  sourceRequestOperationPinsEqual,
  type ConnectionTestRequestPins,
  type PageReadRequestPins,
  type SourceTestRequestPins,
} from "./source-request-lease.ts";

const commonPins = {
  organizationId: "organization-fixture",
  sourceTypeKey: "fixture-source-v1",
  adapterVersion: "fixture-adapter-v1",
  singletonFencingEpoch: 7,
  connectionProfileId: "profile-fixture",
  connectionProfileRevisionId: "profile-revision-fixture",
  connectionHealthGeneration: 11,
} as const;

const connectionTestPins: ConnectionTestRequestPins = {
  ...commonPins,
  requestAttemptId: "request-attempt-connection",
  requestLeaseId: "request-lease-connection",
  operationKind: "connection_test",
  connectionTestJobId: "connection-test-job",
  jobClaimLeaseId: "job-claim",
  recoveryEpisodeId: null,
};

const sourceTestPins: SourceTestRequestPins = {
  ...commonPins,
  requestAttemptId: "request-attempt-source",
  requestLeaseId: "request-lease-source",
  operationKind: "source_test",
  provider: "courtyard",
  providerId: "courtyard-provider-fixture",
  sourceInstanceId: "source-fixture",
  sourceRevisionId: "source-revision-fixture",
  normalizedContractVersion: "packscout.provider-observation.v1",
  identityNamespaceKey: "fixture-courtyard-records-v1",
  sourceTestJobId: "source-test-job",
  jobClaimLeaseId: "job-claim",
};

const pageReadPins: PageReadRequestPins = {
  ...commonPins,
  requestAttemptId: "request-attempt-page",
  requestLeaseId: "request-lease-page",
  operationKind: "page_read",
  provider: "courtyard",
  providerId: "courtyard-provider-fixture",
  sourceInstanceId: "source-fixture",
  sourceRevisionId: "source-revision-fixture",
  normalizedContractVersion: "packscout.provider-observation.v1",
  identityNamespaceKey: "fixture-courtyard-records-v1",
  importRunId: "run-fixture",
  runClaimLeaseId: "run-claim",
  pageAttemptId: "page-attempt-fixture",
  pageNumber: 1,
  pageLimit: 250,
  cursorGeneration: 3,
  requestedCursorFingerprint: "a".repeat(64),
};

const pageRequestedCursor = {
  sourceInstanceId: pageReadPins.sourceInstanceId,
  sourceRevisionId: pageReadPins.sourceRevisionId,
  sourceTypeKey: pageReadPins.sourceTypeKey,
  adapterVersion: pageReadPins.adapterVersion,
  cursorCodecKey: "fixture-cursor-v1",
  cursorGeneration: pageReadPins.cursorGeneration,
  value: "opaque-fixture-cursor",
} as const;

function setup(): Readonly<{
  coordinator: ConnectionPermitCoordinator;
  authority: SourceRequestLeaseAuthority;
}> {
  const coordinator = new ConnectionPermitCoordinator();
  coordinator.configureRequestPermitLane({
    organizationId: commonPins.organizationId,
    connectionProfileId: commonPins.connectionProfileId,
    scope: "platform",
    providerId: sourceTestPins.providerId,
    approvedRequestCap: 2,
  });
  coordinator.configureRequestPermitLane({
    organizationId: commonPins.organizationId,
    connectionProfileId: commonPins.connectionProfileId,
    scope: "connection_test",
    providerId: null,
    approvedRequestCap: 2,
  });
  return {
    coordinator,
    authority: new SourceRequestLeaseAuthority(coordinator),
  };
}

function releaseTerminalizedRequest(
  authority: SourceRequestLeaseAuthority,
  lease: Awaited<ReturnType<SourceRequestLeaseAuthority["admit"]>>,
) {
  authority.releaseTerminalizedRequestPermit(
    lease,
    {
      requestAttemptId: lease.pins.requestAttemptId,
      requestLeaseId: lease.pins.requestLeaseId,
    },
  );
}

test("paired grant precedes the authoritative guard and exactly one request", async () => {
  const { authority, coordinator } = setup();
  const order: string[] = [];
  let upstreamCalls = 0;
  const lease = await authority.admit({
    pins: pageReadPins,
    requestedCursor: pageRequestedCursor,
    guard: () => {
      const snapshot = coordinator.snapshot();
      assert.equal(snapshot.activeExecutionSlots, 1);
      assert.equal(snapshot.requestPermitLanes[0]?.activeRequestPermits, 1);
      order.push("guard-after-paired-grant");
      return true;
    },
  });

  const invocation = lease.consume(pageReadPins, pageRequestedCursor);
  order.push("request");
  upstreamCalls += 1;
  assert.equal(invocation.signal.aborted, false);
  assert.equal(invocation.pins.operationKind, "page_read");
  assert.deepEqual(order, ["guard-after-paired-grant", "request"]);
  assert.equal(upstreamCalls, 1);

  assert.throws(
    () => lease.consume(pageReadPins, pageRequestedCursor),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "already_consumed",
  );
  assert.throws(
    () => lease.close(),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "terminalization_required",
  );
  releaseTerminalizedRequest(authority, lease);
  lease.close();
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
});

test("lost ownership after paired grant releases both and makes no request", async () => {
  const { authority, coordinator } = setup();
  const upstreamCalls = 0;
  await assert.rejects(
    authority.admit({
      pins: pageReadPins,
      requestedCursor: pageRequestedCursor,
      guard: () => false,
    }),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "lost_ownership",
  );
  assert.equal(upstreamCalls, 0);
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
  assert.equal(
    coordinator.snapshot().requestPermitLanes[0]?.activeRequestPermits,
    0,
  );
});

test("a guard error releases both resources and exposes only a stable error", async () => {
  const { authority, coordinator } = setup();
  await assert.rejects(
    authority.admit({
      pins: sourceTestPins,
      guard: () => {
        throw new Error("protected database detail");
      },
    }),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "guard_failed" &&
      !error.message.includes("protected database detail"),
  );
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
  assert.equal(
    coordinator.snapshot().requestPermitLanes[0]?.activeRequestPermits,
    0,
  );
});

test("cancellation during the post-grant guard releases both and makes no request", async () => {
  const { authority, coordinator } = setup();
  const abortController = new AbortController();
  let allowGuardToFinish: (() => void) | undefined;
  const guardCanFinish = new Promise<void>((resolve) => {
    allowGuardToFinish = resolve;
  });
  let guardStarted: (() => void) | undefined;
  const guardDidStart = new Promise<void>((resolve) => {
    guardStarted = resolve;
  });
  const upstreamCalls = 0;
  const admission = authority.admit({
    pins: pageReadPins,
    requestedCursor: pageRequestedCursor,
    signal: abortController.signal,
    guard: async () => {
      guardStarted?.();
      await guardCanFinish;
      return true;
    },
  });

  await guardDidStart;
  assert.equal(coordinator.snapshot().activeExecutionSlots, 1);
  abortController.abort();
  allowGuardToFinish?.();
  await assert.rejects(
    admission,
    (error) =>
      error instanceof SourceRequestLeaseError && error.code === "cancelled",
  );
  assert.equal(upstreamCalls, 0);
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
  assert.equal(
    coordinator.snapshot().requestPermitLanes[0]?.activeRequestPermits,
    0,
  );
});

test("the one-use lease rejects pin changes and cross-operation scope", async () => {
  const { authority } = setup();
  const lease = await authority.admit({
    pins: pageReadPins,
    requestedCursor: pageRequestedCursor,
    guard: () => true,
  });
  assert.throws(
    () =>
      lease.consume(
        { ...pageReadPins, runClaimLeaseId: "stale-claim" },
        pageRequestedCursor,
      ),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "pin_mismatch",
  );
  assert.throws(
    () =>
      lease.consume(
        { ...pageReadPins, pageLimit: 500 },
        pageRequestedCursor,
      ),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "pin_mismatch",
  );
  assert.throws(
    () => lease.consume({ ...pageReadPins, pageNumber: 2 }, pageRequestedCursor),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "pin_mismatch",
  );
  assert.throws(
    () =>
      lease.consume(
        {
          ...pageReadPins,
          normalizedContractVersion: "packscout.provider-observation.v2",
        },
        pageRequestedCursor,
      ),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "pin_mismatch",
  );
  assert.throws(
    () =>
      lease.consume(pageReadPins, {
        ...pageRequestedCursor,
        value: "different-opaque-cursor",
      }),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "pin_mismatch",
  );
  assert.throws(
    () => lease.consume(sourceTestPins),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "pin_mismatch",
  );
  assert.equal(lease.state, "available");
  lease.close();
});

test("strict operation pins reject fabricated correlation fields", async () => {
  const { authority, coordinator } = setup();
  const fabricated = {
    ...connectionTestPins,
    sourceInstanceId: "a-connection-test-must-not-carry-source-state",
  } as unknown as ConnectionTestRequestPins;
  await assert.rejects(
    authority.admit({ pins: fabricated, guard: () => true }),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "invalid_pins",
  );
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
});

test("cancelling an unused lease releases capacity and prevents a request", async () => {
  const { authority, coordinator } = setup();
  const lease = await authority.admit({
    pins: connectionTestPins,
    guard: () => true,
  });
  lease.cancel();
  assert.equal(lease.signal.aborted, true);
  assert.equal(lease.requestPermitHeld, false);
  assert.equal(lease.executionSlotHeld, false);
  assert.throws(
    () => lease.consume(connectionTestPins),
    (error) =>
      error instanceof SourceRequestLeaseError && error.code === "cancelled",
  );
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
});

test("cancelling a consumed request aborts it but retains resources for terminalization", async () => {
  const { authority, coordinator } = setup();
  const abortController = new AbortController();
  const lease = await authority.admit({
    pins: sourceTestPins,
    guard: () => true,
    signal: abortController.signal,
  });
  const invocation = lease.consume(sourceTestPins);

  abortController.abort();
  assert.equal(invocation.signal.aborted, true);
  assert.equal(lease.requestPermitHeld, true);
  assert.equal(lease.executionSlotHeld, true);
  assert.equal(coordinator.snapshot().activeExecutionSlots, 1);

  assert.throws(
    () => lease.releaseExecutionSlot(),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "terminalization_required",
  );
  assert.equal(lease.executionSlotHeld, true);

  assert.equal("releaseRequestPermit" in lease, false);
  const foreignAuthority = new SourceRequestLeaseAuthority(coordinator);
  assert.throws(
    () =>
      foreignAuthority.releaseTerminalizedRequestPermit(lease, {
        requestAttemptId: lease.pins.requestAttemptId,
        requestLeaseId: lease.pins.requestLeaseId,
      }),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "terminalization_receipt_mismatch",
  );
  const hiddenProofKey = Symbol("hidden-terminalization-proof-key");
  assert.throws(
    () =>
      authority.releaseTerminalizedRequestPermit(lease, {
        requestAttemptId: lease.pins.requestAttemptId,
        requestLeaseId: lease.pins.requestLeaseId,
        [hiddenProofKey]: true,
      } as never),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "terminalization_receipt_mismatch",
  );
  assert.equal(lease.requestPermitHeld, true);
  releaseTerminalizedRequest(authority, lease);
  assert.throws(
    () => releaseTerminalizedRequest(authority, lease),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "terminalization_receipt_mismatch",
  );
  assert.equal(lease.executionSlotHeld, true);
  assert.equal(coordinator.snapshot().activeExecutionSlots, 1);
  lease.releaseExecutionSlot();
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
  lease.close();
});

test("each explicit operation scope can be admitted and consumed", async () => {
  const { authority } = setup();
  for (const pins of [connectionTestPins, sourceTestPins]) {
    const lease = await authority.admit({ pins, guard: () => true });
    assert.equal(lease.consume(pins).pins.operationKind, pins.operationKind);
    releaseTerminalizedRequest(authority, lease);
    lease.close();
  }
  const pageLease = await authority.admit({
    pins: pageReadPins,
    requestedCursor: pageRequestedCursor,
    guard: (_pins, requestedCursor) => {
      assert.deepEqual(requestedCursor, pageRequestedCursor);
      return true;
    },
  });
  assert.equal(
    pageLease.consume(pageReadPins, pageRequestedCursor).pins.operationKind,
    "page_read",
  );
  releaseTerminalizedRequest(authority, pageLease);
  pageLease.close();
});

test("request leases derive platform and connection-test permit lanes from durable pins", async () => {
  const { authority, coordinator } = setup();
  const pageLease = await authority.admit({
    pins: pageReadPins,
    requestedCursor: pageRequestedCursor,
    guard: () => true,
  });
  const connectionLease = await authority.admit({
    pins: connectionTestPins,
    guard: () => true,
  });

  assert.deepEqual(
    coordinator.snapshot().requestPermitLanes.map((lane) => ({
      scope: lane.scope,
      providerId: lane.providerId,
      activeRequestPermits: lane.activeRequestPermits,
    })),
    [
      {
        scope: "platform",
        providerId: pageReadPins.providerId,
        activeRequestPermits: 1,
      },
      {
        scope: "connection_test",
        providerId: null,
        activeRequestPermits: 1,
      },
    ],
  );

  pageLease.cancel();
  connectionLease.cancel();
});

test("source-scoped pins require a durable provider id", async () => {
  const { authority, coordinator } = setup();
  await assert.rejects(
    authority.admit({
      pins: {
        ...sourceTestPins,
        providerId: undefined,
      } as unknown as SourceTestRequestPins,
      guard: () => true,
    }),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "invalid_pins",
  );
  assert.equal(coordinator.snapshot().activeExecutionSlots, 0);
});

test("pin equality is value-based but remains scope-sensitive", () => {
  assert.equal(
    sourceRequestOperationPinsEqual(pageReadPins, { ...pageReadPins }),
    true,
  );
  assert.equal(
    sourceRequestOperationPinsEqual(pageReadPins, {
      ...pageReadPins,
      cursorGeneration: pageReadPins.cursorGeneration + 1,
    }),
    false,
  );
  assert.equal(
    sourceRequestOperationPinsEqual(pageReadPins, {
      ...pageReadPins,
      providerId: "different-durable-provider",
    }),
    false,
  );
});

test("the direct lease module exposes no receipt issuer or lease-level request release", async () => {
  const leaseModule = await import("./source-request-lease.ts");
  assert.equal(
    "issueSourceRequestTerminalizationReceipt" in leaseModule,
    false,
  );
  const { authority } = setup();
  const lease = await authority.admit({
    pins: connectionTestPins,
    guard: () => true,
  });
  assert.equal("releaseRequestPermit" in lease, false);
  lease.close();
});
