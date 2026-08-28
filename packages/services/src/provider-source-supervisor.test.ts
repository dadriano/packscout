import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ControlPlaneTransactionError,
  RuntimeLocallyFencedError,
} from "./control-plane-retry.ts";
import {
  ProviderSourceSupervisor,
  type SourceSupervisorCapacityAdmissionHook,
  type SourceSupervisorDiagnosticPort,
  type SourceSupervisorEpoch,
  type SourceSupervisorExecutionContext,
  type SourceSupervisorExecutionResult,
  type SourceSupervisorOwnershipPort,
  type SourceSupervisorRecoverableClaim,
  type SourceSupervisorClaimCommand,
  type SourceSupervisorSnapshotPort,
  type SourceSupervisorWorkDisposition,
  type SourceSupervisorWorkExecutor,
  type SourceSupervisorWorkItem,
  type SourceSupervisorWorkQueue,
  type SourceSupervisorUnstartedWaitReason,
} from "./provider-source-supervisor.ts";

interface FixtureWork extends SourceSupervisorWorkItem {
  readonly kind: "connection_test" | "source_test" | "page_read";
  readonly fixtureProvider:
    | "courtyard"
    | "collector_crypt"
    | "clutchpacks"
    | "phygitals"
    | null;
  readonly fixtureProviderId: string | null;
}

const epoch: SourceSupervisorEpoch = {
  epochId: "55000000-0000-4000-8000-000000000001",
  epochNumber: 1,
  ownerKey: "fixture-owner",
  leaseToken: "55000000-0000-4000-8000-000000000002",
  leaseExpiresAt: new Date("2026-08-21T12:00:30.000Z"),
};

class FixtureOwnership implements SourceSupervisorOwnershipPort {
  readonly calls: string[] = [];
  readonly fenceReasons: string[] = [];

  async acquire(): Promise<SourceSupervisorEpoch> {
    this.calls.push("acquire");
    return epoch;
  }

  async renew(): Promise<Date> {
    this.calls.push("renew");
    return epoch.leaseExpiresAt;
  }

  async fence(_epoch: SourceSupervisorEpoch, safeReasonCode: string): Promise<void> {
    this.calls.push("fence");
    this.fenceReasons.push(safeReasonCode);
  }

  async release(): Promise<void> {
    this.calls.push("release");
  }

  async listReconcilablePredecessorAttempts(): Promise<readonly []> {
    this.calls.push("reconcile");
    return [];
  }

  async reconcilePredecessorAttempt(): Promise<void> {}
}

class ContendedRenewalOwnership extends FixtureOwnership {
  renewalCalls = 0;

  override async renew(): Promise<Date> {
    this.calls.push("renew");
    this.renewalCalls += 1;
    if (this.renewalCalls <= 3) {
      throw new ControlPlaneTransactionError("timeout");
    }
    return epoch.leaseExpiresAt;
  }
}

class IndeterminateRenewalOwnership extends FixtureOwnership {
  renewalCalls = 0;

  override async renew(): Promise<Date> {
    this.calls.push("renew");
    this.renewalCalls += 1;
    if (this.renewalCalls === 1) throw new Error("indeterminate renewal failure");
    return epoch.leaseExpiresAt;
  }
}

class GatedAcquireOwnership extends FixtureOwnership {
  readonly #gate: Promise<void>;
  #releaseGate: (() => void) | null = null;

  constructor() {
    super();
    this.#gate = new Promise((resolve) => {
      this.#releaseGate = resolve;
    });
  }

  override async acquire(): Promise<SourceSupervisorEpoch> {
    this.calls.push("acquire");
    await this.#gate;
    return epoch;
  }

  releaseAcquire(): void {
    this.#releaseGate?.();
    this.#releaseGate = null;
  }
}

class FailingReconcileOwnership extends FixtureOwnership {
  override async listReconcilablePredecessorAttempts(): Promise<readonly []> {
    this.calls.push("reconcile");
    throw new Error("reconciliation failed");
  }
}

class GatedFenceOwnership extends FailingReconcileOwnership {
  readonly #gate: Promise<void>;
  #releaseGate: (() => void) | null = null;

  constructor() {
    super();
    this.#gate = new Promise((resolve) => {
      this.#releaseGate = resolve;
    });
  }

  override async fence(): Promise<void> {
    this.calls.push("fence");
    await this.#gate;
  }

  releaseFence(): void {
    this.#releaseGate?.();
    this.#releaseGate = null;
  }
}

class ReplacedEpochOwnership extends FailingReconcileOwnership {
  override async fence(): Promise<void> {
    this.calls.push("fence");
    throw new Error("epoch replaced");
  }
}

class FixtureQueue implements SourceSupervisorWorkQueue<FixtureWork> {
  readonly completed: Array<{
    id: string;
    disposition: SourceSupervisorWorkDisposition;
  }> = [];
  readonly released: Array<{
    id: string;
    reason: SourceSupervisorUnstartedWaitReason;
  }> = [];
  readonly admissionStates: Array<{
    id: string;
    state: "waiting" | "granted";
    reason?: "request_lane_capacity" | "execution_capacity";
  }> = [];
  protected works: FixtureWork[];
  readonly #delayedAdmissionWorkId: string | null;
  readonly #delayedAdmissionGate: Promise<void>;
  #releaseDelayedAdmission: (() => void) | null = null;

  constructor(
    works: readonly FixtureWork[],
    delayedAdmissionWorkId: string | null = null,
  ) {
    this.works = [...works];
    this.#delayedAdmissionWorkId = delayedAdmissionWorkId;
    this.#delayedAdmissionGate = new Promise((resolve) => {
      this.#releaseDelayedAdmission = resolve;
    });
  }

  async listDue(): Promise<readonly []> { return []; }

  async materializeDue(): Promise<"unavailable"> { return "unavailable"; }

  async listRecoverableClaims(): Promise<
    readonly SourceSupervisorRecoverableClaim[]
  > { return []; }

  async recoverClaim(
    claimEpoch: SourceSupervisorEpoch,
    claim: SourceSupervisorRecoverableClaim,
  ): Promise<void> {
    void claimEpoch;
    void claim;
  }

  async claimNext(
    _epoch: SourceSupervisorEpoch,
    command: SourceSupervisorClaimCommand,
  ): Promise<FixtureWork | null> {
    const index = this.works.findIndex((work) =>
      !(command.skipPageReads && work.kind === "page_read") &&
      !command.excludedRequestLanes?.some((lane) =>
        lane.organizationId === work.organizationId &&
        lane.connectionProfileId === work.connectionProfileId &&
        lane.scope === (work.kind === "connection_test"
          ? "connection_test"
          : "platform") &&
        lane.providerId === (work.kind === "connection_test"
          ? null
          : work.fixtureProviderId)
      ) &&
      (!work.sourceInstanceId ||
        !command.excludedSourceInstanceIds?.includes(work.sourceInstanceId))
    );
    return index < 0 ? null : this.works.splice(index, 1)[0] ?? null;
  }

  async renewClaim(): Promise<Date | null> {
    return epoch.leaseExpiresAt;
  }

  async releaseUnstarted(
    _epoch: SourceSupervisorEpoch,
    work: FixtureWork,
    reason: SourceSupervisorUnstartedWaitReason,
  ): Promise<void> {
    this.released.push({ id: work.id, reason });
  }

  async markAdmissionWaiting(
    _epoch: SourceSupervisorEpoch,
    work: FixtureWork,
    reason: "request_lane_capacity" | "execution_capacity",
  ): Promise<void> {
    this.admissionStates.push({ id: work.id, state: "waiting", reason });
    if (work.id === this.#delayedAdmissionWorkId) {
      await this.#delayedAdmissionGate;
    }
  }

  async markAdmissionGranted(
    _epoch: SourceSupervisorEpoch,
    work: FixtureWork,
  ): Promise<void> {
    this.admissionStates.push({ id: work.id, state: "granted" });
  }

  releaseDelayedAdmission(): void {
    this.#releaseDelayedAdmission?.();
    this.#releaseDelayedAdmission = null;
  }

  async complete(
    _epoch: SourceSupervisorEpoch,
    work: FixtureWork,
    disposition: SourceSupervisorWorkDisposition,
  ): Promise<void> {
    this.completed.push({ id: work.id, disposition });
  }
}

class RequeuingCapacityQueue extends FixtureQueue {
  pageClaims = 0;
  skippedPageScans = 0;

  override async claimNext(
    claimEpoch: SourceSupervisorEpoch,
    command: Parameters<FixtureQueue["claimNext"]>[1],
  ): Promise<FixtureWork | null> {
    if (command.skipPageReads) this.skippedPageScans += 1;
    const work = await super.claimNext(claimEpoch, command);
    if (work?.kind === "page_read") this.pageClaims += 1;
    return work;
  }

  override async releaseUnstarted(
    releaseEpoch: SourceSupervisorEpoch,
    work: FixtureWork,
    reason: SourceSupervisorUnstartedWaitReason,
  ): Promise<void> {
    await super.releaseUnstarted(releaseEpoch, work, reason);
    if (work.kind === "page_read" && reason === "capacity_blocked") {
      this.works.push(work);
    }
  }
}

class LostRenewalQueue extends FixtureQueue {
  override async renewClaim(): Promise<null> {
    return null;
  }
}

class ContendedRenewalQueue extends FixtureQueue {
  renewalCalls = 0;

  override async renewClaim(): Promise<Date | null> {
    this.renewalCalls += 1;
    if (this.renewalCalls <= 3) {
      throw new ControlPlaneTransactionError("timeout");
    }
    return epoch.leaseExpiresAt;
  }
}

class GatedClaimQueue extends FixtureQueue {
  readonly entered: Promise<void>;
  #signalEntered: (() => void) | null = null;
  #releaseGate: (() => void) | null = null;
  readonly #gate: Promise<void>;

  constructor(works: readonly FixtureWork[]) {
    super(works);
    this.entered = new Promise((resolve) => {
      this.#signalEntered = resolve;
    });
    this.#gate = new Promise((resolve) => {
      this.#releaseGate = resolve;
    });
  }

  override async claimNext(
    claimEpoch: SourceSupervisorEpoch,
    command: Parameters<FixtureQueue["claimNext"]>[1],
  ): Promise<FixtureWork | null> {
    this.#signalEntered?.();
    this.#signalEntered = null;
    await this.#gate;
    return super.claimNext(claimEpoch, command);
  }

  releaseClaim(): void {
    this.#releaseGate?.();
    this.#releaseGate = null;
  }
}

class RecoveryUnitQueue extends FixtureQueue {
  readonly calls: string[] = [];
  readonly #claims: SourceSupervisorRecoverableClaim[] = [
    { kind: "source_test", id: "expired-test" },
    { kind: "page_read", id: "expired-run" },
  ];

  override async listRecoverableClaims(): Promise<
    readonly SourceSupervisorRecoverableClaim[]
  > {
    this.calls.push("list");
    return [...this.#claims];
  }

  override async recoverClaim(
    _epoch: SourceSupervisorEpoch,
    claim: SourceSupervisorRecoverableClaim,
  ): Promise<void> {
    this.calls.push(`recover:${claim.kind}:${claim.id}`);
    const index = this.#claims.findIndex((candidate) =>
      candidate.kind === claim.kind && candidate.id === claim.id
    );
    if (index >= 0) this.#claims.splice(index, 1);
  }
}

class LateRecoveryUnitQueue extends FixtureQueue {
  readonly recovered: SourceSupervisorRecoverableClaim[] = [];
  #claim: SourceSupervisorRecoverableClaim | null = null;

  makeRecoverable(): void {
    this.#claim = { kind: "page_read", id: "late-expired-run" };
  }

  override async listRecoverableClaims(): Promise<
    readonly SourceSupervisorRecoverableClaim[]
  > {
    return this.#claim ? [this.#claim] : [];
  }

  override async recoverClaim(
    _epoch: SourceSupervisorEpoch,
    claim: SourceSupervisorRecoverableClaim,
  ): Promise<void> {
    this.recovered.push(claim);
    this.#claim = null;
  }
}

class ContendedLateRecoveryUnitQueue extends LateRecoveryUnitQueue {
  listCalls = 0;
  dueCalls = 0;
  claimCalls = 0;
  #remainingContention = 0;

  contendUntilNextPoll(): void {
    this.makeRecoverable();
    this.#remainingContention = 3;
  }

  override async listRecoverableClaims(): Promise<
    readonly SourceSupervisorRecoverableClaim[]
  > {
    this.listCalls += 1;
    if (this.#remainingContention > 0) {
      this.#remainingContention -= 1;
      throw new ControlPlaneTransactionError("timeout");
    }
    return super.listRecoverableClaims();
  }

  override async listDue(): Promise<readonly []> {
    this.dueCalls += 1;
    return [];
  }

  override async claimNext(
    claimEpoch: SourceSupervisorEpoch,
    command: Parameters<FixtureQueue["claimNext"]>[1],
  ): Promise<FixtureWork | null> {
    this.claimCalls += 1;
    return super.claimNext(claimEpoch, command);
  }
}

class ContendedRecoverClaimQueue extends ContendedLateRecoveryUnitQueue {
  #remainingRecoveryContention = 0;

  contendOnRecoveryUntilNextPoll(): void {
    this.makeRecoverable();
    this.#remainingRecoveryContention = 3;
  }

  override async recoverClaim(
    claimEpoch: SourceSupervisorEpoch,
    claim: SourceSupervisorRecoverableClaim,
  ): Promise<void> {
    if (this.#remainingRecoveryContention > 0) {
      this.#remainingRecoveryContention -= 1;
      throw new ControlPlaneTransactionError("timeout");
    }
    await super.recoverClaim(claimEpoch, claim);
  }
}

function fixtureWork(
  id: string,
  profile: "slow-profile" | "independent-profile",
  queuedOffset: number,
): FixtureWork {
  return {
    id,
    kind: "connection_test",
    queuedAt: new Date(1_700_000_000_000 + queuedOffset),
    organizationId: "fixture-organization",
    connectionProfileId: profile,
    connectionRevisionId: `${profile}-revision`,
    platformRequestLimit: 2,
    fixtureProvider: null,
    fixtureProviderId: null,
  };
}

function fixturePlatformWork(
  id: string,
  provider:
    | "courtyard"
    | "collector_crypt"
    | "clutchpacks"
    | "phygitals",
  queuedOffset: number,
  profile: "slow-profile" | "independent-profile" = "slow-profile",
): FixtureWork {
  return {
    ...fixtureWork(id, profile, queuedOffset),
    kind: "source_test",
    sourceInstanceId: `${id}-source`,
    sourceRevisionId: `${id}-revision`,
    providerId: `${provider}-provider`,
    fixtureProvider: provider,
    fixtureProviderId: `${provider}-provider`,
  };
}

function fixturePageWork(id: string, queuedOffset: number): FixtureWork {
  return {
    ...fixtureWork(id, "slow-profile", queuedOffset),
    kind: "page_read",
    sourceInstanceId: `${id}-source`,
    sourceRevisionId: `${id}-revision`,
    providerId: "courtyard-provider",
    runStartedAt: new Date(1_700_000_000_000),
    committedPages: 0,
    committedRecords: 0,
    retryAttempt: 0,
    sourceIntervalSeconds: 60,
    fixtureProvider: "courtyard",
    fixtureProviderId: "courtyard-provider",
  };
}

class MeteredExecutor implements SourceSupervisorWorkExecutor<FixtureWork> {
  readonly starts: string[] = [];
  readonly abortReasons: string[] = [];
  readonly maximumByRequestLane = new Map<string, number>();
  maximumActive = 0;
  #active = 0;
  readonly #inFlightByRequestLane = new Map<string, number>();

  constructor(private readonly holdMilliseconds = 15) {}

  registeredRequestPermitLane(work: FixtureWork) {
    if (work.kind === "connection_test") {
      return {
        organizationId: work.organizationId,
        connectionProfileId: work.connectionProfileId,
        scope: "connection_test" as const,
        providerId: null,
        approvedRequestCap: 1,
      };
    }
    if (!work.fixtureProviderId) {
      throw new Error("fixture provider lane missing");
    }
    return {
      organizationId: work.organizationId,
      connectionProfileId: work.connectionProfileId,
      scope: "platform" as const,
      providerId: work.fixtureProviderId,
      approvedRequestCap: 1,
    };
  }

  async execute(
    work: FixtureWork,
    context: SourceSupervisorExecutionContext,
  ): Promise<SourceSupervisorExecutionResult> {
    const commonPins = {
      requestAttemptId: `${work.id}-attempt`,
      requestLeaseId: `${work.id}-request-lease`,
      organizationId: work.organizationId,
      sourceTypeKey: "fixture-source-v1",
      adapterVersion: "v1",
      singletonFencingEpoch: context.epoch.epochNumber,
      connectionProfileId: work.connectionProfileId,
      connectionProfileRevisionId: work.connectionRevisionId,
      connectionHealthGeneration: 0,
    };
    if (work.kind === "page_read") {
      throw new Error("metered page fixture is not supported");
    }
    const pins = work.kind === "connection_test"
      ? {
          ...commonPins,
          operationKind: "connection_test" as const,
          connectionTestJobId: work.id,
          jobClaimLeaseId: `${work.id}-claim`,
          recoveryEpisodeId: null,
        }
      : {
          ...commonPins,
          operationKind: "source_test" as const,
          provider: work.fixtureProvider!,
          providerId: work.fixtureProviderId!,
          sourceInstanceId: work.sourceInstanceId!,
          sourceRevisionId: work.sourceRevisionId!,
          normalizedContractVersion: "v1",
          identityNamespaceKey: `fixture:${work.fixtureProvider}`,
          sourceTestJobId: work.id,
          jobClaimLeaseId: `${work.id}-claim`,
        };
    const requestLane = this.registeredRequestPermitLane(work);
    const waitReason = context.requestLeases.admissionWaitReason(requestLane);
    const pendingLease = context.requestLeases.admit({
      pins,
      guard: () => true,
      signal: context.signal,
    });
    if (waitReason) await context.admissionWaiting(waitReason);
    await context.capacityChanged();
    const lease = await pendingLease;
    await context.admissionGranted();
    await context.capacityChanged();
    lease.consume(pins);
    const requestLaneKey = JSON.stringify([
      requestLane.organizationId,
      requestLane.connectionProfileId,
      requestLane.scope,
      requestLane.providerId,
    ]);
    const laneActive =
      (this.#inFlightByRequestLane.get(requestLaneKey) ?? 0) + 1;
    this.#inFlightByRequestLane.set(requestLaneKey, laneActive);
    this.maximumByRequestLane.set(
      requestLaneKey,
      Math.max(this.maximumByRequestLane.get(requestLaneKey) ?? 0, laneActive),
    );
    this.#active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.#active);
    this.starts.push(work.id);
    await new Promise<void>((resolve) =>
      setTimeout(resolve, this.holdMilliseconds)
    );
    this.#inFlightByRequestLane.set(requestLaneKey, laneActive - 1);
    this.#active -= 1;
    context.requestLeases.releaseTerminalizedRequestPermit(lease, {
      requestAttemptId: pins.requestAttemptId,
      requestLeaseId: pins.requestLeaseId,
    });
    await context.capacityChanged();
    context.retainExecutionSlot(() => {
      lease.releaseExecutionSlot();
      lease.close();
    });
    return { kind: "test_terminal" };
  }

  abortAll(reason: "capacity" | "claim_lost" | "ownership_lost" | "shutdown"): void {
    this.abortReasons.push(reason);
  }
}

class GatedDrainExecutor implements SourceSupervisorWorkExecutor<FixtureWork> {
  readonly entered: Promise<void>;
  #signalEntered: (() => void) | null = null;
  #releaseGate: (() => void) | null = null;
  readonly #gate: Promise<void>;

  constructor() {
    this.entered = new Promise((resolve) => {
      this.#signalEntered = resolve;
    });
    this.#gate = new Promise((resolve) => {
      this.#releaseGate = resolve;
    });
  }

  registeredRequestPermitLane(work: FixtureWork) {
    return new MeteredExecutor().registeredRequestPermitLane(work);
  }

  async execute(): Promise<SourceSupervisorExecutionResult> {
    this.#signalEntered?.();
    this.#signalEntered = null;
    await this.#gate;
    return { kind: "test_terminal" };
  }

  abortAll(): void {}

  release(): void {
    this.#releaseGate?.();
    this.#releaseGate = null;
  }
}

const capacity: SourceSupervisorCapacityAdmissionHook<FixtureWork> = {
  async probe() {
    return { admitted: true };
  },
};

const snapshot: SourceSupervisorSnapshotPort = {
  async publish() {},
};

class RecordingSnapshot implements SourceSupervisorSnapshotPort {
  readonly publications: Array<
    Parameters<SourceSupervisorSnapshotPort["publish"]>[0]
  > = [];

  async publish(input: Parameters<SourceSupervisorSnapshotPort["publish"]>[0]) {
    this.publications.push(input);
  }
}

class StopFailingSnapshot implements SourceSupervisorSnapshotPort {
  calls = 0;

  async publish(): Promise<void> {
    this.calls += 1;
    if (this.calls > 1) throw new ControlPlaneTransactionError("connection");
  }
}

class GatedRenewalSnapshot implements SourceSupervisorSnapshotPort {
  calls = 0;
  readonly #gate: Promise<void>;
  #releaseGate: (() => void) | null = null;

  constructor() {
    this.#gate = new Promise((resolve) => {
      this.#releaseGate = resolve;
    });
  }

  async publish(): Promise<void> {
    this.calls += 1;
    if (this.calls > 1) await this.#gate;
  }

  release(): void {
    this.#releaseGate?.();
    this.#releaseGate = null;
  }
}

class ContendedSnapshot implements SourceSupervisorSnapshotPort {
  calls = 0;

  async publish(): Promise<void> {
    this.calls += 1;
    throw new ControlPlaneTransactionError("timeout");
  }
}

class StaleSnapshot implements SourceSupervisorSnapshotPort {
  async publish(): Promise<void> {
    throw new ControlPlaneTransactionError("lost_ownership");
  }
}

const diagnostics: SourceSupervisorDiagnosticPort<FixtureWork> = {
  async record() {},
};

test("startup retries each expired claim as one control-plane unit", async () => {
  const queue = new RecoveryUnitQueue([]);
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership: new FixtureOwnership(),
    queue,
    executor: new MeteredExecutor(),
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
  });

  await supervisor.initialize();
  assert.deepEqual(queue.calls, [
    "list",
    "recover:source_test:expired-test",
    "recover:page_read:expired-run",
    "list",
  ]);
  await supervisor.stop();
});

test("a claim expiring after takeover is recovered by a later poll", async () => {
  const queue = new LateRecoveryUnitQueue([]);
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership: new FixtureOwnership(),
    queue,
    executor: new MeteredExecutor(),
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
  });

  await supervisor.initialize();
  queue.makeRecoverable();
  await supervisor.runCycle();

  assert.deepEqual(queue.recovered, [
    { kind: "page_read", id: "late-expired-run" },
  ]);
  await supervisor.stop();
});

test("transient late-claim recovery contention retries on the next poll", async () => {
  const ownership = new FixtureOwnership();
  const queue = new ContendedLateRecoveryUnitQueue([]);
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue,
    executor: new MeteredExecutor(),
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: (error) =>
      error instanceof ControlPlaneTransactionError ? error.code : "invariant",
    ids: { id: () => "unused-continuation-id" },
    sleep: async () => undefined,
  });

  await supervisor.initialize();
  queue.contendUntilNextPoll();
  await supervisor.runCycle();

  assert.equal(ownership.calls.includes("fence"), false);
  assert.deepEqual(queue.recovered, []);
  assert.equal(queue.dueCalls, 0);
  assert.equal(queue.claimCalls, 0);

  await supervisor.runCycle();
  assert.deepEqual(queue.recovered, [
    { kind: "page_read", id: "late-expired-run" },
  ]);
  assert.equal(queue.dueCalls, 1);
  assert.equal(queue.claimCalls, 1);
  await supervisor.stop();
});

test("deferred claim recovery prevents new admission until the next poll", async () => {
  const ownership = new FixtureOwnership();
  const queue = new ContendedRecoverClaimQueue([]);
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue,
    executor: new MeteredExecutor(),
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: (error) =>
      error instanceof ControlPlaneTransactionError ? error.code : "invariant",
    ids: { id: () => "unused-continuation-id" },
    sleep: async () => undefined,
  });

  await supervisor.initialize();
  queue.contendOnRecoveryUntilNextPoll();
  await supervisor.runCycle();

  assert.equal(ownership.calls.includes("fence"), false);
  assert.deepEqual(queue.recovered, []);
  assert.equal(queue.dueCalls, 0);
  assert.equal(queue.claimCalls, 0);

  await supervisor.runCycle();
  assert.deepEqual(queue.recovered, [
    { kind: "page_read", id: "late-expired-run" },
  ]);
  assert.equal(queue.dueCalls, 1);
  assert.equal(queue.claimCalls, 1);
  await supervisor.stop();
});

test("ownership renewals continue while snapshot publication is delayed", async () => {
  const ownership = new FixtureOwnership();
  const renewalSnapshot = new GatedRenewalSnapshot();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue: new FixtureQueue([]),
    executor: new MeteredExecutor(),
    capacity,
    snapshot: renewalSnapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
    ownershipRenewalIntervalMilliseconds: 1,
  });

  await supervisor.initialize();
  while (ownership.calls.filter((call) => call === "renew").length < 2) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(renewalSnapshot.calls, 2);
  renewalSnapshot.release();
  await supervisor.stop();
  assert.equal(ownership.calls.at(-1), "release");
});

test("graceful drain keeps renewing singleton ownership until active turns settle", async () => {
  const ownership = new FixtureOwnership();
  const executor = new GatedDrainExecutor();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue: new FixtureQueue([
      fixtureWork("draining-turn", "slow-profile", 1),
    ]),
    executor,
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "draining-turn-command" },
    ownershipRenewalIntervalMilliseconds: 1,
  });

  await supervisor.initialize();
  await supervisor.runCycle();
  await executor.entered;
  const renewalsBeforeStop = ownership.calls.filter(
    (call) => call === "renew",
  ).length;
  let stopped = false;
  const stopping = supervisor.stop().then(() => {
    stopped = true;
  });
  while (
    ownership.calls.filter((call) => call === "renew").length <=
      renewalsBeforeStop
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(stopped, false);
  executor.release();
  await stopping;
  assert.equal(ownership.calls.at(-1), "release");
});

test("transient ownership-renewal contention retries on the next heartbeat", async () => {
  const ownership = new ContendedRenewalOwnership();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue: new FixtureQueue([]),
    executor: new MeteredExecutor(),
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: (error) =>
      error instanceof ControlPlaneTransactionError ? error.code : "invariant",
    ids: { id: () => "unused-continuation-id" },
    sleep: async () => undefined,
    ownershipRenewalIntervalMilliseconds: 5,
  });

  await supervisor.initialize();
  while (ownership.renewalCalls < 4) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(ownership.calls.includes("fence"), false);
  await supervisor.stop();
});

test("an indeterminate renewal failure waits for durable ownership proof", async () => {
  const ownership = new IndeterminateRenewalOwnership();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue: new FixtureQueue([]),
    executor: new MeteredExecutor(),
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
    ownershipRenewalIntervalMilliseconds: 5,
  });

  await supervisor.initialize();
  while (ownership.renewalCalls < 2) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(ownership.calls.includes("fence"), false);
  await supervisor.stop();
});

test("snapshot contention preserves ownership and retries on a later publication", async () => {
  const ownership = new FixtureOwnership();
  const contendedSnapshot = new ContendedSnapshot();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue: new FixtureQueue([]),
    executor: new MeteredExecutor(),
    capacity,
    snapshot: contendedSnapshot,
    diagnostics,
    classifyControlPlaneFailure: (error) =>
      error instanceof ControlPlaneTransactionError ? error.code : "invariant",
    ids: { id: () => "unused-continuation-id" },
    sleep: async () => undefined,
  });

  await supervisor.initialize();

  assert.equal(supervisor.state, "active");
  assert.equal(contendedSnapshot.calls, 3);
  assert.ok(!ownership.calls.includes("fence"));
  await supervisor.stop();
  assert.equal(ownership.calls.at(-1), "release");
});

test("a snapshot that proves ownership loss fences the owner immediately", async () => {
  const ownership = new FixtureOwnership();
  const executor = new MeteredExecutor();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
      ownership,
      queue: new FixtureQueue([]),
    executor,
    capacity,
    snapshot: new StaleSnapshot(),
    diagnostics,
    classifyControlPlaneFailure: (error) =>
      error instanceof ControlPlaneTransactionError ? error.code : "invariant",
    ids: { id: () => "unused-continuation-id" },
  });

  await assert.rejects(
    supervisor.initialize(),
    (error: unknown) => error instanceof RuntimeLocallyFencedError,
  );

  assert.equal(supervisor.state, "fenced_draining");
  assert.deepEqual(ownership.fenceReasons, ["SNAPSHOT_PUBLISH_FAILED"]);
  assert.deepEqual(executor.abortReasons, ["ownership_lost"]);
  await supervisor.stop();
});

test("one platform lane cannot throttle another behind the same profile", async () => {
  const queue = new FixtureQueue([
    fixturePlatformWork("courtyard-1", "courtyard", 1),
    fixturePlatformWork("courtyard-2", "courtyard", 2),
    fixturePlatformWork("courtyard-3", "courtyard", 3),
    fixturePlatformWork("phygitals-1", "phygitals", 4),
  ]);
  const executor = new MeteredExecutor(30);
  const ownership = new FixtureOwnership();
  const recordingSnapshot = new RecordingSnapshot();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue,
    executor,
    capacity,
    snapshot: recordingSnapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
    executionSlots: 3,
  });

  await supervisor.initialize();
  await supervisor.runCycle();
  while (queue.completed.length < 4) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  const courtyardLane = JSON.stringify([
    "fixture-organization",
    "slow-profile",
    "platform",
    "courtyard-provider",
  ]);
  const phygitalsLane = JSON.stringify([
    "fixture-organization",
    "slow-profile",
    "platform",
    "phygitals-provider",
  ]);
  assert.equal(executor.maximumByRequestLane.get(courtyardLane), 1);
  assert.equal(executor.maximumByRequestLane.get(phygitalsLane), 1);
  assert.equal(executor.maximumActive, 2);
  assert.ok(
    executor.starts.indexOf("phygitals-1") <
      executor.starts.indexOf("courtyard-3"),
    `independent platform was starved: ${executor.starts.join(",")}`,
  );
  assert.equal(queue.completed.length, 4);
  assert.deepEqual(queue.released, []);
  assert.ok(queue.admissionStates.some((state) =>
    state.id === "courtyard-3" && state.state === "waiting" &&
    state.reason === "request_lane_capacity"
  ));
  assert.ok(!queue.admissionStates.some((state) =>
    state.id === "phygitals-1" && state.state === "waiting"
  ));
  assert.ok(recordingSnapshot.publications.some(({ capacity }) => {
    const courtyard = capacity.requestPermitLanes.find((lane) =>
      lane.connectionProfileId === "slow-profile" &&
      lane.providerId === "courtyard-provider"
    );
    const phygitals = capacity.requestPermitLanes.find((lane) =>
      lane.connectionProfileId === "slow-profile" &&
      lane.providerId === "phygitals-provider"
    );
    return capacity.activeExecutionSlots === 2 &&
      (courtyard?.activeRequestPermits ?? 0) === 1 &&
      (courtyard?.queuedOperations ?? 0) >= 1 &&
      (phygitals?.activeRequestPermits ?? 0) === 1;
  }), "live snapshots never exposed independent platform occupancy");
  assert.deepEqual(ownership.calls.slice(0, 2), ["acquire", "reconcile"]);

  await supervisor.stop();
  assert.equal(ownership.calls.at(-1), "release");
});

test("four provider lanes can occupy four execution slots", async () => {
  const queue = new FixtureQueue([
    fixturePlatformWork("courtyard", "courtyard", 1),
    fixturePlatformWork("collector-crypt", "collector_crypt", 2),
    fixturePlatformWork("clutchpacks", "clutchpacks", 3),
    fixturePlatformWork("phygitals", "phygitals", 4),
  ]);
  const executor = new MeteredExecutor(40);
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership: new FixtureOwnership(),
    queue,
    executor,
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
    executionSlots: 4,
  });

  await supervisor.initialize();
  await supervisor.runCycle();
  while (queue.completed.length < 4) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(executor.maximumActive, 4);
  assert.equal(executor.maximumByRequestLane.size, 4);
  assert.ok(
    [...executor.maximumByRequestLane.values()].every((maximum) => maximum === 1),
  );
  await supervisor.stop();
});

test("a saturated platform backlog is excluded without a fixed claim horizon", async () => {
  const oldPlatform = Array.from({ length: 129 }, (_, index) =>
    fixturePlatformWork(`backlog-${index + 1}`, "courtyard", index + 1)
  );
  const queue = new FixtureQueue([
    ...oldPlatform,
    fixturePlatformWork("beyond-lookahead", "phygitals", 130),
  ]);
  const executor = new MeteredExecutor(150);
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership: new FixtureOwnership(),
    queue,
    executor,
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
  });

  await supervisor.initialize();
  await supervisor.runCycle();
  while (executor.starts.length === 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  while (!executor.starts.includes("beyond-lookahead")) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(queue.completed.length, 0);
  assert.equal(executor.starts[0], "backlog-1");
  const thirdBacklogStart = executor.starts.indexOf("backlog-3");
  assert.ok(
    thirdBacklogStart === -1 ||
      executor.starts.indexOf("beyond-lookahead") < thirdBacklogStart,
  );
  assert.deepEqual(queue.released, []);
  await supervisor.stop();
});

test("a delayed durable wait-state write cannot reorder coordinator FIFO", async () => {
  const queue = new FixtureQueue([
    fixturePlatformWork("fifo-1", "courtyard", 1),
    fixturePlatformWork("fifo-2", "courtyard", 2),
    fixturePlatformWork("fifo-3", "courtyard", 3),
  ], "fifo-2");
  const executor = new MeteredExecutor(40);
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership: new FixtureOwnership(),
    queue,
    executor,
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
    claimLookahead: 8,
  });

  await supervisor.initialize();
  await supervisor.runCycle();
  while (!queue.admissionStates.some((state) => state.id === "fifo-3")) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  queue.releaseDelayedAdmission();
  while (queue.completed.length < 3) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  assert.deepEqual(executor.starts, ["fifo-1", "fifo-2", "fifo-3"]);
  await supervisor.stop();
});

test("a mutable stored cap cannot exceed the exact registered platform cap", async () => {
  const queue = new FixtureQueue([{
    ...fixturePlatformWork("cap-mismatch", "courtyard", 1),
    platformRequestLimit: 4,
  }]);
  const executor = new MeteredExecutor();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership: new FixtureOwnership(),
    queue,
    executor,
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
  });

  await supervisor.initialize();
  await supervisor.runCycle();
  assert.deepEqual(executor.starts, []);
  assert.deepEqual(queue.completed, [{
    id: "cap-mismatch",
    disposition: {
      kind: "action_required",
      safeCode: "PLATFORM_REQUEST_LIMIT_MISMATCH",
    },
  }]);
  await supervisor.stop();
});

test("a registered request lane must match the claimed operation scope and provider", async () => {
  for (const mismatch of ["scope", "provider"] as const) {
    const work = fixturePlatformWork(`lane-${mismatch}`, "courtyard", 1);
    class MismatchedLaneExecutor extends MeteredExecutor {
      override registeredRequestPermitLane(candidate: FixtureWork) {
        const lane = super.registeredRequestPermitLane(candidate);
        if (candidate.kind === "connection_test") return lane;
        return mismatch === "scope"
          ? {
              organizationId: lane.organizationId,
              connectionProfileId: lane.connectionProfileId,
              scope: "connection_test" as const,
              providerId: null,
              approvedRequestCap: lane.approvedRequestCap,
            }
          : {
              ...lane,
              scope: "platform" as const,
              providerId: "different-provider",
            };
      }
    }
    const queue = new FixtureQueue([work]);
    const executor = new MismatchedLaneExecutor();
    const supervisor = new ProviderSourceSupervisor({
      environmentKey: "test",
      ownerKey: epoch.ownerKey,
      leaseToken: epoch.leaseToken,
      ownership: new FixtureOwnership(),
      queue,
      executor,
      capacity,
      snapshot,
      diagnostics,
      classifyControlPlaneFailure: () => "invariant",
      ids: { id: () => "unused-continuation-id" },
    });

    await supervisor.initialize();
    await supervisor.runCycle();
    assert.deepEqual(executor.starts, []);
    assert.deepEqual(queue.completed, [{
      id: work.id,
      disposition: {
        kind: "action_required",
        safeCode: "REQUEST_LANE_CONFIGURATION_INVALID",
      },
    }]);
    await supervisor.stop();
  }
});

test("a blocked volume cools down page claims while connection tests continue", async () => {
  const queue = new RequeuingCapacityQueue([
    fixturePageWork("capacity-page", 1),
    fixtureWork("capacity-test", "independent-profile", 2),
  ]);
  const executor = new MeteredExecutor(1);
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership: new FixtureOwnership(),
    queue,
    executor,
    capacity: {
      async probe({ work }) {
        return work.kind === "page_read"
          ? { admitted: false, state: "blocked", safeCode: "CAPACITY_BLOCKED" }
          : { admitted: true };
      },
    },
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
    pollIntervalMilliseconds: 1,
  });

  await supervisor.initialize();
  await supervisor.runCycle();
  while (
    queue.released.length < 1 ||
    !queue.completed.some(({ id }) => id === "capacity-test")
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  await supervisor.runCycle();

  assert.equal(queue.pageClaims, 1);
  assert.ok(queue.skippedPageScans >= 1);
  assert.deepEqual(executor.starts, ["capacity-test"]);
  assert.deepEqual(queue.released, [{
    id: "capacity-page",
    reason: "capacity_blocked",
  }]);
  await supervisor.stop();
});

test("a durable claim-loss event is mirrored before the owner fences", async () => {
  const order: string[] = [];
  const ownership = new class extends FixtureOwnership {
    override async fence(
      fenceEpoch: SourceSupervisorEpoch,
      safeReasonCode: string,
    ): Promise<void> {
      order.push("fence");
      await super.fence(fenceEpoch, safeReasonCode);
    }
  }();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue: new LostRenewalQueue([
      fixtureWork("lost-renewal", "slow-profile", 1),
    ]),
    executor: new MeteredExecutor(30),
    capacity,
    snapshot,
    diagnostics: {
      async record(input) {
        if (input.transition === "lease_lost") order.push("lease_lost");
      },
    },
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "lost-renewal-command" },
    claimRenewalIntervalMilliseconds: 1,
  });

  await supervisor.initialize();
  await supervisor.runCycle();
  while (!ownership.calls.includes("release")) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.deepEqual(order, ["lease_lost", "fence"]);
  assert.equal(supervisor.state, "fenced_draining");
  await supervisor.stop();
});

test("transient claim-renewal contention retries without fencing the owner", async () => {
  const ownership = new FixtureOwnership();
  const queue = new ContendedRenewalQueue([
    fixtureWork("contended-renewal", "slow-profile", 1),
  ]);
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue,
    executor: new MeteredExecutor(30),
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: (error) =>
      error instanceof ControlPlaneTransactionError ? error.code : "invariant",
    ids: { id: () => "contended-renewal-command" },
    sleep: async () => undefined,
    claimRenewalIntervalMilliseconds: 1,
  });

  await supervisor.initialize();
  await supervisor.runCycle();
  while (queue.completed.length < 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }

  assert.ok(queue.renewalCalls >= 4);
  assert.ok(!ownership.calls.includes("fence"));
  await supervisor.stop();
  assert.equal(ownership.calls.at(-1), "release");
});

test("stop joins an in-progress acquire and releases without starting work", async () => {
  const ownership = new GatedAcquireOwnership();
  const queue = new FixtureQueue([]);
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue,
    executor: new MeteredExecutor(),
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
    sleep: async () => undefined,
  });

  const start = supervisor.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  let stopped = false;
  const stop = supervisor.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped, false);
  ownership.releaseAcquire();
  await Promise.all([start, stop]);

  assert.deepEqual(ownership.calls, ["acquire", "release"]);
  assert.equal(supervisor.state, "stopped");
});

test("stop joins a committed claim and releases it before owner release", async () => {
  const ownership = new FixtureOwnership();
  const queue = new GatedClaimQueue([
    fixtureWork("stop-claim", "slow-profile", 1),
  ]);
  const executor = new MeteredExecutor();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue,
    executor,
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "stop-claim-command" },
  });

  await supervisor.initialize();
  const cycle = supervisor.runCycle();
  await queue.entered;
  let stopped = false;
  const stopping = supervisor.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped, false);
  queue.releaseClaim();
  await Promise.all([cycle, stopping]);

  assert.deepEqual(executor.starts, []);
  assert.deepEqual(queue.released, [{
    id: "stop-claim",
    reason: "graceful_shutdown",
  }]);
  assert.equal(ownership.calls.at(-1), "release");
});

test("a contended final snapshot preserves the clean owner release path", async () => {
  const ownership = new FixtureOwnership();
  const stopSnapshot = new StopFailingSnapshot();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue: new FixtureQueue([]),
    executor: new MeteredExecutor(),
    capacity,
    snapshot: stopSnapshot,
    diagnostics,
    classifyControlPlaneFailure: (error) =>
      error instanceof ControlPlaneTransactionError ? error.code : "invariant",
    ids: { id: () => "unused-continuation-id" },
    sleep: async () => undefined,
  });

  await supervisor.initialize();
  await supervisor.stop();

  assert.equal(ownership.calls.filter((call) => call === "fence").length, 0);
  assert.equal(ownership.calls.filter((call) => call === "release").length, 1);
  assert.equal(ownership.calls.at(-1), "release");
});

test("a fenced epoch releases after its zero-request drain", async () => {
  const ownership = new FailingReconcileOwnership();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue: new FixtureQueue([]),
    executor: new MeteredExecutor(),
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
  });

  await assert.rejects(supervisor.initialize(), /reconciliation failed/u);
  while (!ownership.calls.includes("release")) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.deepEqual(ownership.calls, [
    "acquire",
    "reconcile",
    "fence",
    "release",
  ]);
  assert.equal(supervisor.state, "fenced_draining");
});

test("stop joins a gated durable fence before releasing and settling", async () => {
  const ownership = new GatedFenceOwnership();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue: new FixtureQueue([]),
    executor: new MeteredExecutor(),
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: () => "invariant",
    ids: { id: () => "unused-continuation-id" },
  });

  const initialization = supervisor.initialize();
  while (!ownership.calls.includes("fence")) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  let stopped = false;
  const stopping = supervisor.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped, false);
  ownership.releaseFence();
  await assert.rejects(initialization, /reconciliation failed/u);
  await stopping;

  assert.deepEqual(ownership.calls, [
    "acquire",
    "reconcile",
    "fence",
    "release",
  ]);
  assert.equal(supervisor.state, "fenced_draining");
});

test("a replaced epoch ends local fencing without retrying its successor", async () => {
  const ownership = new ReplacedEpochOwnership();
  const supervisor = new ProviderSourceSupervisor({
    environmentKey: "test",
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
    ownership,
    queue: new FixtureQueue([]),
    executor: new MeteredExecutor(),
    capacity,
    snapshot,
    diagnostics,
    classifyControlPlaneFailure: (error) =>
      error instanceof Error && error.message === "epoch replaced"
        ? "lost_ownership"
        : "invariant",
    ids: { id: () => "unused-continuation-id" },
    sleep: async () => {
      throw new Error("permanent ownership loss must not retry");
    },
  });

  await assert.rejects(supervisor.initialize(), /reconciliation failed/u);
  await supervisor.stop();
  assert.deepEqual(ownership.calls, ["acquire", "reconcile", "fence"]);
  assert.equal(supervisor.state, "fenced_draining");
});
