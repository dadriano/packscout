import assert from "node:assert/strict";
import test from "node:test";
import type {
  BeginPromotionJobInvocationInput,
  ManifestGateClaim,
  ManifestGateIntent,
  PromotionJobAdmission,
  PromotionJobInvocation,
  PromotionWakeIntent,
  ReconcileInterruptedPromotionJobInvocationInput,
  RecordPromotionJobProgressInput,
  TerminalizePromotionJobInvocationInput,
} from "@packscout/database";
import { promotionJobSha256 } from "@packscout/database";
import type {
  IndependentManifestReconciliationResult,
} from "@packscout/services";
import {
  MANIFEST_RECONCILIATION_ONE_SHOT_MAXIMUM_ATTEMPTS,
  MANIFEST_RECONCILIATION_ONE_SHOT_MAXIMUM_MILLISECONDS,
  ManifestReconciliationOneShot,
  type IndependentManifestReconciliationWorkPort,
  type ManifestGateQueuePort,
  type ManifestReconciliationJobLedgerPort,
} from "./manifest-reconciliation-one-shot.ts";

const base = new Date("2026-09-01T20:00:00.000Z");

function uuid(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function invocationFrom(
  input: BeginPromotionJobInvocationInput,
): PromotionJobInvocation {
  const observedWakeGeneration = input.trigger.kind === "change_wake" ||
      input.trigger.kind === "continuation"
    ? input.trigger.observedWakeGeneration
    : null;
  const trigger = input.trigger.kind === "reconciliation_cron"
    ? { ...input.trigger, observedWakeGeneration }
    : input.trigger.kind === "manual"
      ? { kind: "manual" as const, observedWakeGeneration }
      : input.trigger;
  return {
    runId: uuid(900),
    authority: "manifest_reconciliation",
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

class MemoryLedger implements ManifestReconciliationJobLedgerPort {
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
    authority: "manifest_reconciliation",
    requestedGeneration: 1n,
    acknowledgedGeneration: 0n,
    latestCause: "provider_completion",
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
      continuationGeneration: input.continuation?.requestedGeneration ?? null,
      resultActiveGeneration: input.resultActiveGeneration ?? null,
      resultPublicReleaseId: input.resultPublicReleaseId ?? null,
      resultReleaseFingerprint: input.resultReleaseFingerprint ?? null,
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
      continuationGeneration: input.continuation?.requestedGeneration ?? null,
    };
    return Promise.resolve(this.#invocation);
  }
}

function claim(input: Readonly<{
  providerOrdinal: number;
  providerKey: string;
  generation?: bigint;
}>): ManifestGateClaim {
  const generation = input.generation ?? 1n;
  return {
    providerId: uuid(input.providerOrdinal),
    organizationId: uuid(1),
    providerKey: input.providerKey,
    providerLifecycle: "active",
    providerRowVersion: 1n,
    requestedGeneration: generation,
    acknowledgedGeneration: 0n,
    latestCause: "provider_completion",
    latestEvidenceDigest: promotionJobSha256(`proof:${input.providerKey}`),
    latestRequestedAt: base,
    operationGeneration: null,
    requestedOperation: null,
    targetProviderReleaseId: null,
    targetCatalogVersionId: null,
    requestedByOperatorId: null,
    authorizationDigest: null,
    attemptCount: 1,
    lastAttemptedAt: base,
    retryAt: null,
    lastFailureCode: null,
    pending: true,
    observedGeneration: generation,
    claimToken: uuid(input.providerOrdinal + 100),
    claimExpiresAt: new Date(base.getTime() + 60_000),
  };
}

class MemoryGates implements ManifestGateQueuePort {
  readonly acknowledgements: string[] = [];
  readonly acknowledgementDeadlines: number[] = [];
  readonly deferrals: string[] = [];
  readonly deferralDeadlines: number[] = [];
  readonly claimDeadlines: number[] = [];
  readonly pendingDeadlines: number[] = [];
  pending = false;
  staleAcknowledgement = false;

  constructor(readonly claims: ManifestGateClaim[]) {}

  claimNext(
    _input: Parameters<ManifestGateQueuePort["claimNext"]>[0],
    deadline?: Readonly<{ deadlineAt: number }>,
  ) {
    if (deadline !== undefined) this.claimDeadlines.push(deadline.deadlineAt);
    return Promise.resolve(this.claims.shift() ?? null);
  }

  acknowledgeClaim(
    input: Parameters<ManifestGateQueuePort["acknowledgeClaim"]>[0],
    deadline?: Readonly<{ deadlineAt: number }>,
  ) {
    if (this.staleAcknowledgement) {
      throw Object.assign(new Error("stale"), {
        code: "PROMOTION_JOB_GATE_INTENT_INVALID",
      });
    }
    this.acknowledgements.push(input.providerId);
    if (deadline !== undefined) {
      this.acknowledgementDeadlines.push(deadline.deadlineAt);
    }
    return Promise.resolve({} as ManifestGateIntent);
  }

  deferClaim(
    input: Parameters<ManifestGateQueuePort["deferClaim"]>[0],
    deadline?: Readonly<{ deadlineAt: number }>,
  ) {
    this.deferrals.push(input.providerId);
    if (deadline !== undefined) this.deferralDeadlines.push(deadline.deadlineAt);
    this.pending = true;
    return Promise.resolve({} as ManifestGateIntent);
  }

  hasPending(deadline?: Readonly<{ deadlineAt: number }>) {
    if (deadline !== undefined) this.pendingDeadlines.push(deadline.deadlineAt);
    return Promise.resolve(this.pending || this.claims.length > 0);
  }
}

function observation(input: Readonly<{
  disposition: IndependentManifestReconciliationResult["disposition"];
  activeGeneration: bigint;
  failureCode?: string | null;
}>): IndependentManifestReconciliationResult {
  const succeeded = input.disposition === "activated" ||
    input.disposition === "recovered";
  return {
    disposition: input.disposition,
    semanticOperation: "advance",
    operationId: succeeded ? `manifest-gate:${promotionJobSha256("op")}` : null,
    requestDigest: succeeded ? promotionJobSha256("request") : null,
    receiptDigest: succeeded ? promotionJobSha256("receipt") : null,
    activeGeneration: input.activeGeneration,
    publicReleaseId: input.activeGeneration > 0n ? uuid(700) : null,
    manifestFingerprint: input.activeGeneration > 0n
      ? promotionJobSha256("manifest")
      : null,
    failureCode: input.failureCode ?? null,
    publicationCount: succeeded ? 1 : 0,
    operationCount: succeeded ? 1 : 0,
  };
}

function delivery(name: string) {
  return {
    opaqueKey: name,
    issuedAt: base,
    expiresAt: new Date(base.getTime() + 30 * 24 * 60 * 60 * 1_000),
  };
}

function runner(input: Readonly<{
  ledger: MemoryLedger;
  gates: MemoryGates;
  work: IndependentManifestReconciliationWorkPort;
  maximumAttempts?: number;
  maximumMilliseconds?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  nowMilliseconds?: () => number;
}>) {
  let nextUuid = 1_000;
  return new ManifestReconciliationOneShot({
    workerId: "manifest-reconciliation:test",
    ledger: input.ledger,
    gates: input.gates,
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

test("provider A outage is deferred while provider B activates in the same invocation", async () => {
  const providerA = claim({ providerOrdinal: 11, providerKey: "alpha" });
  const providerB = claim({ providerOrdinal: 12, providerKey: "beta" });
  const ledger = new MemoryLedger();
  const gates = new MemoryGates([providerA, providerB]);
  const visited: string[] = [];
  const result = await runner({
    ledger,
    gates,
    work: {
      async reconcile({ claim: current }) {
        visited.push(current.providerKey);
        return current.providerKey === "alpha"
          ? observation({
              disposition: "deferred",
              activeGeneration: 2n,
              failureCode: "PROVIDER_GATEWAY_UNREACHABLE",
            })
          : observation({ disposition: "activated", activeGeneration: 3n });
      },
    },
  }).run({
    delivery: delivery("a-outage-b-success"),
    trigger: { kind: "change_wake", observedWakeGeneration: 1n },
    requestedAt: base,
  });

  assert.equal(result.state, "terminal");
  assert.deepEqual(visited, ["alpha", "beta"]);
  assert.deepEqual(gates.deferrals, [providerA.providerId]);
  assert.deepEqual(gates.acknowledgements, [providerB.providerId]);
  assert.equal(ledger.progress.at(-1)?.attempts.length, 2);
  assert.equal(ledger.progress.at(-1)?.progress.publicationCount, 1);
  assert.equal(ledger.terminals[0]?.outcome, "continuation_required");
  assert.equal(ledger.terminals[0]?.safeFailureCode, "MANIFEST_GATE_RETRY_PENDING");
  assert.equal(ledger.terminals[0]?.resultActiveGeneration, 3n);
});

test("lost gate ownership is persisted as continuation instead of acknowledging stale work", async () => {
  const ledger = new MemoryLedger();
  const gates = new MemoryGates([
    claim({ providerOrdinal: 21, providerKey: "alpha" }),
  ]);
  gates.staleAcknowledgement = true;
  const result = await runner({
    ledger,
    gates,
    work: {
      async reconcile() {
        return observation({ disposition: "activated", activeGeneration: 4n });
      },
    },
  }).run({
    delivery: delivery("stale-claim"),
    trigger: { kind: "manual" },
    requestedAt: base,
  });

  assert.equal(result.state, "terminal");
  assert.equal(ledger.progress.length, 1);
  assert.equal(ledger.terminals[0]?.outcome, "continuation_required");
  assert.equal(
    ledger.terminals[0]?.safeFailureCode,
    "PROMOTION_JOB_GATE_INTENT_INVALID",
  );
});

test("the work deadline preserves time to persist evidence and continuation within ownership", async () => {
  const ledger = new MemoryLedger();
  const gates = new MemoryGates([
    claim({ providerOrdinal: 31, providerKey: "alpha" }),
  ]);
  let expire: (() => void) | undefined;
  let timerDelay: number | undefined;
  let cleared = false;
  const setTimer = ((callback: () => void, delay?: number) => {
    expire = callback;
    timerDelay = delay;
    return 23 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimer = ((timer: ReturnType<typeof setTimeout>) => {
    assert.equal(timer, 23);
    cleared = true;
  }) as typeof clearTimeout;
  const maximumMilliseconds = 100;
  const result = await runner({
    ledger,
    gates,
    maximumMilliseconds,
    setTimer,
    clearTimer,
    nowMilliseconds: () => base.getTime(),
    work: {
      async reconcile({ deadlineAt, signal }) {
        assert.equal(deadlineAt, base.getTime() + 80);
        expire!();
        assert.equal(signal?.aborted, true);
        return observation({
          disposition: "deferred",
          activeGeneration: 2n,
          failureCode: "PROVIDER_GATEWAY_UNREACHABLE",
        });
      },
    },
  }).run({
    delivery: delivery("deadline-reserve"),
    trigger: { kind: "change_wake", observedWakeGeneration: 1n },
    requestedAt: base,
  });

  assert.equal(result.state, "terminal");
  assert.equal(timerDelay, 80);
  assert.equal(cleared, true);
  assert.deepEqual(gates.claimDeadlines, [base.getTime() + 80]);
  assert.deepEqual(gates.acknowledgements, []);
  assert.deepEqual(gates.deferrals, []);
  assert.equal(ledger.progress.at(-1)?.attempts.length, 1);
  assert.deepEqual(ledger.beginDeadlines, [base.getTime() + 80]);
  assert.ok(ledger.progressDeadlines.every(
    (deadlineAt) => deadlineAt === base.getTime() + 90,
  ));
  assert.deepEqual(ledger.terminalDeadlines, [base.getTime() + 100]);
  assert.equal(ledger.terminals[0]?.outcome, "continuation_required");
  assert.equal(
    ledger.terminals[0]?.safeFailureCode,
    "MANIFEST_RECONCILIATION_DEADLINE",
  );
  assert.equal(ledger.terminals[0]?.continuation?.requestedGeneration, 2n);
  assert.ok(
    ledger.terminalDeadlines[0]! <
      ledger.begins[0]!.ownershipExpiresAt.getTime(),
  );
});

test("zero pending gates is a no-mutation terminal and bounds never exceed 50s or 25 attempts", async () => {
  const ledger = new MemoryLedger();
  const gates = new MemoryGates([]);
  let calls = 0;
  const result = await runner({
    ledger,
    gates,
    work: {
      async reconcile() {
        calls += 1;
        return observation({ disposition: "no_change", activeGeneration: 0n });
      },
    },
  }).run({
    delivery: delivery("no-change"),
    trigger: {
      kind: "reconciliation_cron",
      scheduleEpoch: 1n,
      scheduleWindowIndex: 1n,
      scheduledDueAt: base,
    },
    requestedAt: base,
  });
  assert.equal(result.state, "terminal");
  assert.equal(calls, 0);
  assert.equal(ledger.terminals[0]?.outcome, "no_change");
  assert.equal(ledger.terminals[0]?.acknowledgeObservedWake, true);
  assert.equal(MANIFEST_RECONCILIATION_ONE_SHOT_MAXIMUM_MILLISECONDS, 50_000);
  assert.equal(MANIFEST_RECONCILIATION_ONE_SHOT_MAXIMUM_ATTEMPTS, 25);
  assert.throws(() => new ManifestReconciliationOneShot({
    workerId: "manifest-reconciliation:test",
    ledger,
    gates,
    work: { reconcile: async () => observation({
      disposition: "no_change",
      activeGeneration: 0n,
    }) },
    maximumMilliseconds: 50_001,
  }), RangeError);
});
