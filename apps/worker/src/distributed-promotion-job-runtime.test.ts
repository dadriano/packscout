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
}> = {}): PromotionJobSchedule {
  const lifecycle = input.lifecycle ?? "pending_activation";
  const active = lifecycle === "active";
  const paused = lifecycle === "paused";
  const baselineAt = active || paused
    ? new Date(base.getTime() - 60_000)
    : null;
  return {
    authority: input.authority ?? "provider_publication",
    lifecycle,
    scheduleEpoch: active || paused ? 1n : 0n,
    cadenceSeconds: 60,
    baselineAt,
    activatedAt: baselineAt,
    pausedAt: paused ? base : null,
    lastAdmittedWindowIndex: null,
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

  recordWakeDelivery(input: {
    generation: bigint;
    state: "accepted" | "delivered" | "retry_wait";
  }) {
    this.deliveries.push(`${input.generation}:${input.state}`);
    return Promise.resolve(this.currentWake);
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
