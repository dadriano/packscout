import assert from "node:assert/strict";
import test from "node:test";
import {
  promotionJobSha256,
  type PromotionInvocationTriggerRequest,
  type PromotionJobSchedule,
  type PromotionWakeIntent,
} from "@packscout/database";
import {
  DistributedPromotionJobRuntime,
  type DistributedPromotionJobRuntimeLogger,
  type DistributedPromotionTriggerLedgerPort,
} from "./distributed-promotion-job-runtime.ts";

const base = new Date("2026-09-01T22:00:00.000Z");

function wake(input: Readonly<{
  pending?: boolean;
  cause?: PromotionWakeIntent["latestCause"];
  generation?: bigint;
  authority?: PromotionWakeIntent["authority"];
}> = {}): PromotionWakeIntent {
  const pending = input.pending ?? false;
  const generation = input.generation ?? (pending ? 1n : 0n);
  return {
    authority: input.authority ?? "provider_publication",
    requestedGeneration: generation,
    acknowledgedGeneration: pending ? generation - 1n : generation,
    latestCause: input.cause ?? (generation > 0n ? "canonical_settlement" : null),
    latestRequestedAt: generation > 0n ? base : null,
    pending,
    latestDeliveryGeneration: null,
    latestDeliveryState: null,
    lastDeliveryAttemptAt: null,
    latestDeliveryFailureCode: null,
  };
}

function schedule(input: Readonly<{
  lifecycle?: PromotionJobSchedule["lifecycle"];
  authority?: PromotionJobSchedule["authority"];
  baselineAt?: Date;
  lastAdmittedWindowIndex?: bigint | null;
}> = {}): PromotionJobSchedule {
  const lifecycle = input.lifecycle ?? "pending_activation";
  const active = lifecycle === "active";
  const paused = lifecycle === "paused";
  const baselineAt = active || paused
    ? input.baselineAt ?? new Date(base.getTime() - 60_000)
    : null;
  return {
    authority: input.authority ?? "provider_publication",
    lifecycle,
    scheduleEpoch: active || paused ? 1n : 0n,
    cadenceSeconds: 60,
    baselineAt,
    activatedAt: baselineAt,
    pausedAt: paused ? base : null,
    lastAdmittedWindowIndex: input.lastAdmittedWindowIndex ?? null,
    lastScheduledCheckinAt: null,
    nextExpectedCheckinAt: active ? base : null,
  };
}

class MemoryLedger implements DistributedPromotionTriggerLedgerPort {
  readonly deliveries: string[] = [];

  constructor(
    readonly currentWake: PromotionWakeIntent,
    readonly currentSchedule: PromotionJobSchedule,
  ) {}

  loadWakeIntent() {
    return Promise.resolve(this.currentWake);
  }

  loadSchedule() {
    return Promise.resolve(this.currentSchedule);
  }

  reconcileExpiredInvocations(input: {
    reconciledAt: Date;
    maximumRows?: number;
  }) {
    void input;
    return Promise.resolve({ reconciled: 0, moreEligible: false });
  }

  recordWakeDelivery(input: {
    generation: bigint;
    state: "accepted" | "delivered" | "retry_wait";
  }) {
    this.deliveries.push(`${input.generation}:${input.state}`);
    return Promise.resolve(this.currentWake);
  }
}

class RecoveringLedger extends MemoryLedger {
  readonly reconciliationTimes: Date[] = [];
  #recovered = false;

  override loadWakeIntent(): Promise<PromotionWakeIntent> {
    return Promise.resolve(this.#recovered
      ? wake({ pending: true, cause: "continuation", generation: 1n })
      : this.currentWake);
  }

  override reconcileExpiredInvocations(input: {
    reconciledAt: Date;
    maximumRows?: number;
  }) {
    this.reconciliationTimes.push(input.reconciledAt);
    this.#recovered = true;
    return Promise.resolve({ reconciled: 1, moreEligible: false });
  }
}

class FailingReadLedger extends MemoryLedger {
  override loadWakeIntent(): Promise<PromotionWakeIntent> {
    return Promise.reject(Object.assign(new Error("wake unavailable"), {
      code: "PROMOTION_WAKE_UNAVAILABLE",
    }));
  }

  override loadSchedule(): Promise<PromotionJobSchedule> {
    return Promise.reject(Object.assign(new Error("schedule unavailable"), {
      code: "PROMOTION_SCHEDULE_UNAVAILABLE",
    }));
  }
}

class FailingRecoveryLedger extends MemoryLedger {
  override reconcileExpiredInvocations(): Promise<never> {
    return Promise.reject(Object.assign(new Error("database target is secret"), {
      code: "PROMOTION_RECOVERY_UNAVAILABLE",
    }));
  }
}

function logger() {
  const records: Parameters<DistributedPromotionJobRuntimeLogger["log"]>[0][] = [];
  return {
    records,
    value: { log: (record: typeof records[number]) => void records.push(record) },
  };
}

function runtime(input: Readonly<{
  ledger: MemoryLedger;
  triggers: PromotionInvocationTriggerRequest[];
  fail?: boolean;
  logs?: ReturnType<typeof logger>;
  deliveries?: Array<Readonly<{
    opaqueKey: string;
    issuedAt: Date;
    expiresAt: Date;
  }>>;
  retention?: Readonly<{
    runCycle(now: Date): Promise<Readonly<{ moreEligible: boolean }>>;
  }>;
  now?: () => Date;
}>) {
  return new DistributedPromotionJobRuntime({
    authority: input.ledger.currentWake.authority,
    scopeIdentitySha256: promotionJobSha256(
      `${input.ledger.currentWake.authority}:fixture`,
    ),
    ledger: input.ledger,
    oneShot: {
      async run(request) {
        input.triggers.push(request.trigger);
        input.deliveries?.push(request.delivery);
        if (input.fail) throw Object.assign(new Error("secret URL"), {
          code: "PROVIDER_DATABASE_UNAVAILABLE",
        });
        return {
          state: "terminal",
          invocation: { outcome: "no_change" },
        };
      },
    },
    manualCommands: {
      async verify(input) {
        return { state: "verified", deliveryIdentity: input.protectedCommandIdentity };
      },
    },
    logger: input.logs?.value ?? logger().value,
    ...(input.retention === undefined ? {} : { retention: input.retention }),
    now: input.now ?? (() => base),
  });
}

test("wake, cron, manual, and continuation enter the same one-shot", async () => {
  const triggers: PromotionInvocationTriggerRequest[] = [];
  const ledger = new MemoryLedger(
    wake({ pending: true, generation: 4n }),
    schedule({ lifecycle: "active" }),
  );
  const host = runtime({ ledger, triggers });

  const cycle = await host.runCycle();
  await host.runManual("operator-command:approved:1");
  await host.runContinuation(5n);

  assert.equal(cycle.invocations.length, 2);
  assert.deepEqual(triggers.map(({ kind }) => kind), [
    "change_wake",
    "reconciliation_cron",
    "manual",
    "continuation",
  ]);
  assert.deepEqual(ledger.deliveries, ["4:accepted", "4:delivered"]);
  assert.deepEqual(triggers[1], {
    kind: "reconciliation_cron",
    scheduleEpoch: 1n,
    scheduleWindowIndex: 1n,
    scheduledDueAt: base,
  });
});

test("expired invocation recovery creates continuation while later windows progress", async () => {
  const current = new Date(base.getTime() + 60_000);
  const triggers: PromotionInvocationTriggerRequest[] = [];
  const logs = logger();
  const ledger = new RecoveringLedger(
    wake(),
    schedule({
      lifecycle: "active",
      baselineAt: new Date(base.getTime() - 60_000),
      lastAdmittedWindowIndex: 1n,
    }),
  );

  const result = await runtime({
    ledger,
    triggers,
    logs,
    now: () => current,
  }).runCycle();

  assert.deepEqual(ledger.reconciliationTimes, [current]);
  assert.equal(result.reconciledInvocations, 1);
  assert.equal(result.reconciliationFailures, 0);
  assert.deepEqual(triggers.map(({ kind }) => kind), [
    "continuation",
    "reconciliation_cron",
  ]);
  assert.deepEqual(triggers[1], {
    kind: "reconciliation_cron",
    scheduleEpoch: 1n,
    scheduleWindowIndex: 2n,
    scheduledDueAt: current,
  });
  assert.deepEqual(
    logs.records.find(({ phase }) => phase === "reconciliation"),
    {
      level: "info",
      event: "distributed_promotion_job_runtime",
      authority: "provider_publication",
      scopeIdentitySha256: promotionJobSha256(
        "provider_publication:fixture",
      ),
      phase: "reconciliation",
      triggerKind: null,
      outcome: "continuation_required",
      failureCode: null,
    },
  );
});

test("recovery failure is visible without blocking a later cron window", async () => {
  const triggers: PromotionInvocationTriggerRequest[] = [];
  const logs = logger();
  const result = await runtime({
    ledger: new FailingRecoveryLedger(
      wake(),
      schedule({ lifecycle: "active" }),
    ),
    triggers,
    logs,
  }).runCycle();

  assert.equal(result.reconciledInvocations, 0);
  assert.equal(result.reconciliationFailures, 1);
  assert.deepEqual(triggers.map(({ kind }) => kind), ["reconciliation_cron"]);
  assert.deepEqual(
    logs.records.find(({ phase }) => phase === "reconciliation"),
    {
      level: "warning",
      event: "distributed_promotion_job_runtime",
      authority: "provider_publication",
      scopeIdentitySha256: promotionJobSha256(
        "provider_publication:fixture",
      ),
      phase: "reconciliation",
      triggerKind: null,
      outcome: "unavailable",
      failureCode: "PROMOTION_RECOVERY_UNAVAILABLE",
    },
  );
  assert.doesNotMatch(JSON.stringify(logs.records), /database target is secret/u);
});

test("retention runs once per UTC minute with a paused schedule and pending wake", async () => {
  const calls: string[] = [];
  const logs = logger();
  const triggers: PromotionInvocationTriggerRequest[] = [];
  let current = base;
  const host = runtime({
    ledger: new MemoryLedger(
      wake({ pending: true, generation: 4n }),
      schedule({ lifecycle: "paused" }),
    ),
    triggers,
    logs,
    retention: {
      async runCycle(now) {
        calls.push(now.toISOString());
        return { moreEligible: true };
      },
    },
    now: () => current,
  });

  await host.runCycle();
  current = new Date(base.getTime() + 30_000);
  await host.runCycle();
  current = new Date(base.getTime() + 60_000);
  await host.runCycle();

  assert.deepEqual(calls, [
    base.toISOString(),
    new Date(base.getTime() + 60_000).toISOString(),
  ]);
  assert.deepEqual(
    [...new Set(triggers.map(({ kind }) => kind))],
    ["change_wake"],
  );
  assert.deepEqual(
    logs.records.filter(({ phase }) => phase === "retention").map((record) => ({
      level: record.level,
      outcome: record.outcome,
      triggerKind: record.triggerKind,
    })),
    [
      { level: "info", outcome: "bounded", triggerKind: null },
      { level: "info", outcome: "bounded", triggerKind: null },
    ],
  );
});

test("retention still runs when both promotion state reads fail", async () => {
  const calls: string[] = [];
  const logs = logger();
  const host = runtime({
    ledger: new FailingReadLedger(wake(), schedule()),
    triggers: [],
    logs,
    retention: {
      async runCycle(now) {
        calls.push(now.toISOString());
        return { moreEligible: false };
      },
    },
  });

  const first = await host.runCycle();
  const replay = await host.runCycle();

  assert.equal(first.stateReadFailures, 2);
  assert.equal(replay.stateReadFailures, 2);
  assert.deepEqual(first.invocations, []);
  assert.deepEqual(calls, [base.toISOString()]);
  assert.equal(
    logs.records.filter(({ phase }) => phase === "state_read").length,
    4,
  );
  assert.equal(
    logs.records.filter(({ phase }) => phase === "retention").length,
    1,
  );
});

test("retention failure is isolated from promotion work", async () => {
  const logs = logger();
  const host = runtime({
    ledger: new MemoryLedger(wake(), schedule({ lifecycle: "active" })),
    triggers: [],
    logs,
    retention: {
      async runCycle() {
        throw Object.assign(new Error("database URL is secret"), {
          code: "PROMOTION_RETENTION_DATABASE_UNAVAILABLE",
        });
      },
    },
  });

  const result = await host.runCycle();

  assert.equal(result.invocations[0]?.state, "completed");
  assert.deepEqual(
    logs.records.find(({ phase }) => phase === "retention"),
    {
      level: "warning",
      event: "distributed_promotion_job_runtime",
      authority: "provider_publication",
      scopeIdentitySha256: promotionJobSha256(
        "provider_publication:fixture",
      ),
      phase: "retention",
      triggerKind: null,
      outcome: "unavailable",
      failureCode: "PROMOTION_RETENTION_DATABASE_UNAVAILABLE",
    },
  );
  assert.doesNotMatch(JSON.stringify(logs.records), /database URL is secret/u);
});

test("a forged manual command is rejected before the one-shot", async () => {
  const triggers: PromotionInvocationTriggerRequest[] = [];
  let verificationCalls = 0;
  const host = new DistributedPromotionJobRuntime({
    authority: "provider_publication",
    scopeIdentitySha256: promotionJobSha256("provider:manual-security"),
    ledger: new MemoryLedger(wake(), schedule()),
    manualCommands: {
      async verify() {
        verificationCalls += 1;
        return { state: "rejected", failureCode: "MANUAL_COMMAND_FORGED" };
      },
    },
    oneShot: {
      async run(request) {
        triggers.push(request.trigger);
        return { state: "terminal" };
      },
    },
    logger: logger().value,
    now: () => base,
  });

  await assert.rejects(
    host.runManual("forged-command"),
    { code: "DISTRIBUTED_PROMOTION_MANUAL_UNAUTHORIZED" },
  );
  assert.equal(verificationCalls, 1);
  assert.deepEqual(triggers, []);
});

test("one paused or failing provider does not pause or fail another provider", async () => {
  const pausedTriggers: PromotionInvocationTriggerRequest[] = [];
  const healthyTriggers: PromotionInvocationTriggerRequest[] = [];
  const paused = runtime({
    ledger: new MemoryLedger(
      wake(),
      schedule({ lifecycle: "paused" }),
    ),
    triggers: pausedTriggers,
  });
  const healthy = runtime({
    ledger: new MemoryLedger(
      wake(),
      schedule({ lifecycle: "active" }),
    ),
    triggers: healthyTriggers,
  });

  await Promise.all([paused.runCycle(), healthy.runCycle()]);
  assert.deepEqual(pausedTriggers, []);
  assert.deepEqual(healthyTriggers.map(({ kind }) => kind), [
    "reconciliation_cron",
  ]);
  await paused.runManual("paused-provider-manual-command");
  assert.deepEqual(pausedTriggers.map(({ kind }) => kind), ["manual"]);

  const badTriggers: PromotionInvocationTriggerRequest[] = [];
  const goodTriggers: PromotionInvocationTriggerRequest[] = [];
  const bad = runtime({
    ledger: new MemoryLedger(
      wake({ pending: true, generation: 2n }),
      schedule(),
    ),
    triggers: badTriggers,
    fail: true,
  });
  const good = runtime({
    ledger: new MemoryLedger(
      wake({ pending: true, generation: 3n }),
      schedule(),
    ),
    triggers: goodTriggers,
  });
  const [badResult, goodResult] = await Promise.all([
    bad.runCycle(),
    good.runCycle(),
  ]);
  assert.equal(badResult.invocations[0]?.state, "failed");
  assert.equal(goodResult.invocations[0]?.state, "completed");
  assert.deepEqual(goodTriggers.map(({ kind }) => kind), ["change_wake"]);
});

test("automatic delivery identities survive retries and process restarts", async () => {
  const firstDeliveries: Array<Readonly<{
    opaqueKey: string;
    issuedAt: Date;
    expiresAt: Date;
  }>> = [];
  const replayDeliveries: typeof firstDeliveries = [];
  const firstLedger = new MemoryLedger(
    wake({ pending: true, generation: 9n }),
    schedule({ lifecycle: "active" }),
  );
  const replayLedger = new MemoryLedger(
    wake({ pending: true, generation: 9n }),
    schedule({ lifecycle: "active" }),
  );
  await runtime({
    ledger: firstLedger,
    triggers: [],
    deliveries: firstDeliveries,
    now: () => base,
  }).runCycle();
  await runtime({
    ledger: replayLedger,
    triggers: [],
    deliveries: replayDeliveries,
    now: () => new Date(base.getTime() + 5_000),
  }).runCycle();

  assert.deepEqual(
    firstDeliveries.map(({ opaqueKey }) => opaqueKey),
    replayDeliveries.map(({ opaqueKey }) => opaqueKey),
  );
  assert.notEqual(
    firstDeliveries[0]?.issuedAt.getTime(),
    replayDeliveries[0]?.issuedAt.getTime(),
    "the stable key does not depend on the reconstructed envelope time",
  );
});

test("daemon lifecycle stops cleanly and logs only bounded scope evidence", async () => {
  const logs = logger();
  const host = runtime({
    ledger: new MemoryLedger(wake(), schedule()),
    triggers: [],
    logs,
  });
  const running = host.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  host.stop();
  await running;

  assert.deepEqual(logs.records.map(({ phase }) => phase), [
    "started",
    "stopped",
  ]);
  const rendered = JSON.stringify(logs.records);
  assert.doesNotMatch(rendered, /postgres(?:ql)?:\/\/|secret|provider-id/iu);
  assert.match(rendered, /"scopeIdentitySha256":"[0-9a-f]{64}"/u);
});
