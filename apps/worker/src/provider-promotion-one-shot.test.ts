import assert from "node:assert/strict";
import test from "node:test";
import type {
  BeginPromotionJobInvocationInput,
  PromotionJobAdmission,
  PromotionJobInvocation,
  PromotionWakeIntent,
  ReconcileInterruptedPromotionJobInvocationInput,
  RecordPromotionJobProgressInput,
  TerminalizePromotionJobInvocationInput,
} from "@packscout/database";
import { promotionJobSha256 } from "@packscout/database";
import {
  PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_ATTEMPTS,
  PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS,
  PROVIDER_PROMOTION_OWNERSHIP_GRACE_MILLISECONDS,
  ProviderPromotionOneShot,
  type ProviderPromotionAttemptObservation,
  type ProviderPromotionBoundary,
  type ProviderPromotionJobLedgerPort,
  type ProviderPromotionJobWorkPort,
} from "./provider-promotion-one-shot.ts";

const providerId = "00000000-0000-4000-8000-000000000101";
const base = new Date("2026-09-01T20:00:00.000Z");

function uuid(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function invocationFrom(
  input: BeginPromotionJobInvocationInput,
): PromotionJobInvocation {
  const observedWakeGeneration = input.trigger.kind === "change_wake"
      || input.trigger.kind === "continuation"
    ? input.trigger.observedWakeGeneration
    : null;
  const trigger = input.trigger.kind === "reconciliation_cron"
    ? { ...input.trigger, observedWakeGeneration }
    : input.trigger.kind === "manual"
      ? { kind: "manual" as const, observedWakeGeneration }
      : input.trigger;
  return {
    runId: uuid(99),
    authority: "provider_publication",
    deliveryKeyDigest: promotionJobSha256(input.delivery.opaqueKey),
    trigger,
    lifecycleState: "running",
    outcome: null,
    requestedAt: input.requestedAt,
    startedAt: input.startedAt,
    finishedAt: null,
    ownershipExpiresAt: input.ownershipExpiresAt,
    scheduledCheckinAt: input.trigger.kind === "reconciliation_cron"
      ? input.startedAt
      : null,
    progress: {
      beforeLanePosition: null,
      afterLanePosition: null,
      beforeSettledPosition: null,
      afterSettledPosition: null,
      cycleCount: 0,
      promotionAttemptCount: 0,
      publicationCount: 0,
      operationCount: 0,
    },
    safeFailureCode: null,
    continuationGeneration: null,
    resultActiveGeneration: null,
    resultPublicReleaseId: null,
    resultReleaseFingerprint: null,
    relatedAttemptCount: 0,
    relatedAttemptSetDigest: promotionJobSha256("[]"),
    retentionProtected: false,
  };
}

class MemoryLedger implements ProviderPromotionJobLedgerPort {
  readonly begins: BeginPromotionJobInvocationInput[] = [];
  readonly beginDeadlines: number[] = [];
  readonly progress: RecordPromotionJobProgressInput[] = [];
  readonly progressDeadlines: number[] = [];
  readonly terminals: TerminalizePromotionJobInvocationInput[] = [];
  readonly terminalDeadlines: number[] = [];
  readonly reconciliations: ReconcileInterruptedPromotionJobInvocationInput[] = [];
  readonly reconciliationDeadlines: number[] = [];
  admissionDisposition: PromotionJobAdmission["disposition"] = "started";
  forceExpiredOwnership = false;
  wake: PromotionWakeIntent = {
    authority: "provider_publication",
    requestedGeneration: 1n,
    acknowledgedGeneration: 0n,
    latestCause: "canonical_settlement",
    latestRequestedAt: base,
    pending: true,
    latestDeliveryGeneration: null,
    latestDeliveryState: null,
    lastDeliveryAttemptAt: null,
    latestDeliveryFailureCode: null,
  };
  #invocation: PromotionJobInvocation | null = null;

  beginOrRecoverInvocation(
    input: BeginPromotionJobInvocationInput,
    deadline?: Readonly<{ deadlineAt: number }>,
  ) {
    this.begins.push(input);
    if (deadline !== undefined) this.beginDeadlines.push(deadline.deadlineAt);
    this.#invocation ??= invocationFrom(input);
    if (this.forceExpiredOwnership) {
      this.#invocation = {
        ...this.#invocation,
        ownershipExpiresAt: new Date(input.now.getTime() - 1),
      };
    }
    return Promise.resolve({
      disposition: this.admissionDisposition,
      invocation: this.admissionDisposition === "existing_pruned"
        ? null
        : this.#invocation,
      scheduledCheckinAt: this.#invocation.scheduledCheckinAt,
    });
  }

  loadWakeIntent() {
    return Promise.resolve(this.wake);
  }

  recordProgress(
    input: RecordPromotionJobProgressInput,
    deadline?: Readonly<{ deadlineAt: number }>,
  ) {
    this.progress.push(input);
    if (deadline !== undefined) this.progressDeadlines.push(deadline.deadlineAt);
    this.#invocation = {
      ...this.#invocation!,
      progress: input.progress,
      relatedAttemptCount: input.attempts.length,
    };
    return Promise.resolve(this.#invocation);
  }

  terminalize(
    input: TerminalizePromotionJobInvocationInput,
    deadline?: Readonly<{ deadlineAt: number }>,
  ) {
    this.terminals.push(input);
    if (deadline !== undefined) this.terminalDeadlines.push(deadline.deadlineAt);
    this.#invocation = {
      ...this.#invocation!,
      lifecycleState: "terminal",
      outcome: input.outcome,
      finishedAt: input.finishedAt,
      ownershipExpiresAt: null,
      safeFailureCode: input.safeFailureCode ?? null,
      continuationGeneration:
        input.continuation?.requestedGeneration ?? null,
    };
    return Promise.resolve(this.#invocation);
  }

  reconcileInterrupted(
    input: ReconcileInterruptedPromotionJobInvocationInput,
    deadline?: Readonly<{ deadlineAt: number }>,
  ) {
    this.reconciliations.push(input);
    if (deadline !== undefined) {
      this.reconciliationDeadlines.push(deadline.deadlineAt);
    }
    this.#invocation = {
      ...this.#invocation!,
      lifecycleState: "terminal",
      outcome: input.resolution,
      finishedAt: input.reconciledAt,
      ownershipExpiresAt: null,
      safeFailureCode: input.safeFailureCode,
      continuationGeneration:
        input.continuation?.requestedGeneration ?? null,
    };
    return Promise.resolve(this.#invocation);
  }
}

function delivery(name: string) {
  return {
    opaqueKey: name,
    issuedAt: base,
    expiresAt: new Date(base.getTime() + 30 * 24 * 60 * 60 * 1_000),
  };
}

function complete(
  confirmedPosition: bigint,
): ProviderPromotionAttemptObservation {
  return {
    disposition: "completed",
    observedState: "complete",
    confirmedPosition,
    safeFailureCode: null,
    publicReleaseId: uuid(Number(confirmedPosition) + 200),
    releaseFingerprint: promotionJobSha256(`release:${confirmedPosition}`),
    totalOperationCount: 1,
    orderedOperationDigest: promotionJobSha256(`operations:${confirmedPosition}`),
    recentOperations: [{
      operationIndex: 0,
      operationKind: "finalize",
      state: "acknowledged",
      sendCount: 1,
      sentAt: base,
      acknowledgedAt: base,
      operationIdDigest: promotionJobSha256(`operation:${confirmedPosition}`),
      requestDigest: promotionJobSha256(`request:${confirmedPosition}`),
      receiptDigest: promotionJobSha256(`receipt:${confirmedPosition}`),
    }],
  };
}

function retryableFailure(): ProviderPromotionAttemptObservation {
  return {
    disposition: "retryable_failure",
    observedState: "retry_wait",
    confirmedPosition: null,
    safeFailureCode: "PROVIDER_PUBLICATION_AMBIGUOUS",
    publicReleaseId: null,
    releaseFingerprint: null,
    totalOperationCount: 0,
    orderedOperationDigest: promotionJobSha256(""),
    recentOperations: [],
  };
}

function runner(input: Readonly<{
  ledger: MemoryLedger;
  work: ProviderPromotionJobWorkPort;
  maximumAttempts?: number;
  maximumMilliseconds?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  nowMilliseconds?: () => number;
}>) {
  let nextUuid = 1;
  return new ProviderPromotionOneShot({
    providerId,
    workerId: "provider-publication:test",
    ledger: input.ledger,
    work: input.work,
    now: () => base,
    randomUuid: () => uuid(nextUuid++),
    ...(input.maximumAttempts === undefined
      ? {}
      : { maximumAttempts: input.maximumAttempts }),
    ...(input.maximumMilliseconds === undefined
      ? {}
      : { maximumMilliseconds: input.maximumMilliseconds }),
    ...(input.setTimer === undefined ? {} : { setTimer: input.setTimer }),
    ...(input.clearTimer === undefined
      ? {}
      : { clearTimer: input.clearTimer }),
    ...(input.nowMilliseconds === undefined
      ? {}
      : { nowMilliseconds: input.nowMilliseconds }),
  });
}

test("all four triggers enter one admission path and no-delta cron mutates no Convex state", async () => {
  const triggers = [
    { kind: "change_wake" as const, observedWakeGeneration: 1n },
    {
      kind: "reconciliation_cron" as const,
      scheduleEpoch: 2n,
      scheduleWindowIndex: 3n,
      scheduledDueAt: base,
    },
    { kind: "manual" as const },
    { kind: "continuation" as const, observedWakeGeneration: 1n },
  ];
  for (const [index, trigger] of triggers.entries()) {
    const ledger = new MemoryLedger();
    let publications = 0;
    const work: ProviderPromotionJobWorkPort = {
      async readBoundary() {
        return {
          providerId,
          providerKey: "courtyard",
          lanePosition: 7n,
          settledPosition: 7n,
        };
      },
      async attempt() {
        publications += 1;
        return complete(7n);
      },
    };
    const result = await runner({ ledger, work }).run({
      delivery: delivery(`trigger-${index}`),
      trigger,
      requestedAt: base,
    });
    assert.equal(result.state, "terminal");
    assert.deepEqual(ledger.begins[0]?.trigger, trigger);
    assert.equal(publications, 0);
    assert.equal(
      ledger.terminals[0]?.outcome,
      trigger.kind === "reconciliation_cron" ? "no_change" : "caught_up",
    );
  }
});

test("drains target drift to the newest provider head and persists every receipt-gated step", async () => {
  const ledger = new MemoryLedger();
  const wallClock = 1_000;
  const boundaries: ProviderPromotionBoundary[] = [
    { providerId, providerKey: "courtyard", lanePosition: 5n, settledPosition: 0n },
    { providerId, providerKey: "courtyard", lanePosition: 8n, settledPosition: 5n },
    { providerId, providerKey: "courtyard", lanePosition: 8n, settledPosition: 8n },
  ];
  const targets: bigint[] = [];
  const deadlines: number[] = [];
  const cleanupDeadlines: number[] = [];
  const work: ProviderPromotionJobWorkPort = {
    async readBoundary() {
      return boundaries.shift()!;
    },
    async attempt(input) {
      targets.push(input.targetPosition);
      deadlines.push(input.deadlineAt);
      cleanupDeadlines.push(input.cleanupDeadlineAt);
      return complete(input.targetPosition);
    },
  };
  const result = await runner({
    ledger,
    work,
    nowMilliseconds: () => wallClock,
  }).run({
    delivery: delivery("target-drift"),
    trigger: { kind: "change_wake", observedWakeGeneration: 1n },
    requestedAt: base,
  });
  assert.equal(result.state, "terminal");
  assert.deepEqual(targets, [5n, 8n]);
  assert.deepEqual(deadlines, [
    wallClock + PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS - 10_000,
    wallClock + PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS - 10_000,
  ]);
  assert.deepEqual(cleanupDeadlines, [
    wallClock + PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS - 5_000,
    wallClock + PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS - 5_000,
  ]);
  assert.equal(ledger.terminals[0]?.outcome, "caught_up");
  assert.equal(ledger.terminals[0]?.acknowledgeObservedWake, true);
  assert.deepEqual(ledger.progress.at(-1)?.progress, {
    beforeLanePosition: 5n,
    afterLanePosition: 8n,
    beforeSettledPosition: 0n,
    afterSettledPosition: 8n,
    cycleCount: 2,
    promotionAttemptCount: 2,
    publicationCount: 2,
    operationCount: 2,
  });
  assert.equal(ledger.progress.at(-1)?.attempts.length, 2);
});

test("the wall-clock budget reserves time for durable continuation and ownership", async () => {
  const ledger = new MemoryLedger();
  let wallClock = 10_000;
  let attempts = 0;
  const maximumMilliseconds = 100;
  const result = await runner({
    ledger,
    maximumMilliseconds,
    nowMilliseconds: () => wallClock,
    work: {
      async readBoundary() {
        wallClock += 91;
        return {
          providerId,
          providerKey: "courtyard",
          lanePosition: 1n,
          settledPosition: 0n,
        };
      },
      async attempt() {
        attempts += 1;
        return retryableFailure();
      },
    },
  }).run({
    delivery: delivery("completion-reserve"),
    trigger: { kind: "manual" },
    requestedAt: base,
  });
  assert.equal(result.state, "terminal");
  assert.equal(attempts, 0);
  assert.equal(ledger.terminals[0]?.outcome, "continuation_required");
  assert.equal(
    ledger.terminals[0]?.safeFailureCode,
    "PROVIDER_PROMOTION_DEADLINE",
  );
  assert.equal(
    ledger.begins[0]?.ownershipExpiresAt.getTime(),
    base.getTime()
      + maximumMilliseconds
      + PROVIDER_PROMOTION_OWNERSHIP_GRACE_MILLISECONDS,
  );
});

test("a publication blocked at its work deadline persists continuation before ownership expires", async () => {
  const ledger = new MemoryLedger();
  let expire: (() => void) | undefined;
  let cleared = false;
  let timerDelay: number | undefined;
  let publicationDeadlineAt: number | undefined;
  let publicationCleanupDeadlineAt: number | undefined;
  const setTimer = ((callback: () => void, delay?: number) => {
    expire = callback;
    timerDelay = delay;
    return 17 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimer = ((timer: ReturnType<typeof setTimeout>) => {
    assert.equal(timer, 17);
    cleared = true;
  }) as typeof clearTimeout;
  const work: ProviderPromotionJobWorkPort = {
    async readBoundary() {
      return {
        providerId,
        providerKey: "courtyard",
        lanePosition: 4n,
        settledPosition: 0n,
      };
    },
    async attempt(input) {
      publicationDeadlineAt = input.deadlineAt;
      publicationCleanupDeadlineAt = input.cleanupDeadlineAt;
      expire!();
      return {
        ...retryableFailure(),
        safeFailureCode: "PROVIDER_PUBLICATION_DEADLINE",
      };
    },
  };
  const result = await runner({
    ledger,
    work,
    setTimer,
    clearTimer,
    nowMilliseconds: () => base.getTime(),
  }).run({
    delivery: delivery("deadline"),
    trigger: { kind: "change_wake", observedWakeGeneration: 1n },
    requestedAt: base,
  });
  assert.equal(result.state, "terminal");
  assert.equal(ledger.progress.at(-1)?.attempts.length, 1);
  assert.equal(ledger.terminals[0]?.outcome, "continuation_required");
  assert.equal(
    ledger.terminals[0]?.safeFailureCode,
    "PROVIDER_PROMOTION_DEADLINE",
  );
  assert.equal(ledger.terminals[0]?.continuation?.requestedGeneration, 2n);
  assert.equal(timerDelay, 40_000);
  assert.equal(publicationDeadlineAt, base.getTime() + 40_000);
  assert.equal(publicationCleanupDeadlineAt, base.getTime() + 45_000);
  assert.deepEqual(ledger.beginDeadlines, [base.getTime() + 40_000]);
  assert.ok(ledger.progressDeadlines.every(
    (deadlineAt) => deadlineAt === base.getTime() + 45_000,
  ));
  assert.deepEqual(ledger.terminalDeadlines, [base.getTime() + 50_000]);
  assert.ok(
    ledger.terminalDeadlines[0]! <
      ledger.begins[0]!.ownershipExpiresAt.getTime(),
  );
  assert.equal(cleared, true);
});

test("attempt exhaustion is bounded and overlap coalesces without acknowledging work", async () => {
  const exhaustedLedger = new MemoryLedger();
  let attempts = 0;
  const retryWork: ProviderPromotionJobWorkPort = {
    async readBoundary() {
      return {
        providerId,
        providerKey: "courtyard",
        lanePosition: 2n,
        settledPosition: 0n,
      };
    },
    async attempt() {
      attempts += 1;
      return retryableFailure();
    },
  };
  await runner({
    ledger: exhaustedLedger,
    work: retryWork,
    maximumAttempts: 2,
  }).run({
    delivery: delivery("attempt-limit"),
    trigger: { kind: "manual" },
    requestedAt: base,
  });
  assert.equal(attempts, 2);
  assert.equal(
    exhaustedLedger.terminals[0]?.safeFailureCode,
    "PROVIDER_PROMOTION_ATTEMPT_LIMIT",
  );

  const overlapLedger = new MemoryLedger();
  await runner({
    ledger: overlapLedger,
    work: {
      readBoundary: retryWork.readBoundary,
      async attempt() {
        return {
          ...retryableFailure(),
          disposition: "overlap",
          observedState: "coalesced",
          safeFailureCode: "PROVIDER_PUBLICATION_LEASE_HELD",
        };
      },
    },
  }).run({
    delivery: delivery("overlap"),
    trigger: { kind: "manual" },
    requestedAt: base,
  });
  assert.equal(overlapLedger.terminals[0]?.outcome, "coalesced");
  assert.equal(overlapLedger.terminals[0]?.acknowledgeObservedWake, false);
});

test("same-key replay performs no provider read and hard bounds cannot be raised", async () => {
  const ledger = new MemoryLedger();
  ledger.admissionDisposition = "existing";
  let reads = 0;
  const work: ProviderPromotionJobWorkPort = {
    async readBoundary() {
      reads += 1;
      throw new Error("must not read");
    },
    async attempt() {
      throw new Error("must not publish");
    },
  };
  const result = await runner({ ledger, work }).run({
    delivery: delivery("duplicate"),
    trigger: { kind: "manual" },
    requestedAt: base,
  });
  assert.equal(result.state, "existing");
  assert.equal(reads, 0);
  assert.throws(() => new ProviderPromotionOneShot({
    providerId,
    workerId: "test",
    ledger,
    work,
    maximumMilliseconds:
      PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_MILLISECONDS + 1,
  }), RangeError);
  assert.throws(() => new ProviderPromotionOneShot({
    providerId,
    workerId: "test",
    ledger,
    work,
    maximumAttempts: PROVIDER_PROMOTION_ONE_SHOT_MAXIMUM_ATTEMPTS + 1,
  }), RangeError);
});

test("an expired replay is terminally reconciled to a durable continuation", async () => {
  const ledger = new MemoryLedger();
  ledger.admissionDisposition = "existing";
  ledger.forceExpiredOwnership = true;
  let providerReads = 0;
  const result = await runner({
    ledger,
    work: {
      async readBoundary() {
        providerReads += 1;
        throw new Error("must not read before interruption reconciliation");
      },
      async attempt() {
        throw new Error("must not publish");
      },
    },
  }).run({
    delivery: delivery("expired-replay"),
    trigger: { kind: "change_wake", observedWakeGeneration: 1n },
    requestedAt: base,
  });
  assert.equal(result.state, "reconciled_interruption");
  assert.equal(providerReads, 0);
  assert.equal(ledger.reconciliations[0]?.resolution, "continuation_required");
  assert.equal(
    ledger.reconciliations[0]?.continuation?.requestedGeneration,
    2n,
  );
});
