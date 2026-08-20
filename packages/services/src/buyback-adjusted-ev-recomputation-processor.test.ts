import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BuybackAdjustedEvRecomputationProcessor,
  type BuybackAdjustedEvRecomputationPort,
} from "./buyback-adjusted-ev-recomputation-processor.ts";
import { PackScoutBuybackAdjustedEvRecomputationService } from "./buyback-adjusted-ev-recomputation-service.ts";
import {
  InMemoryBuybackEvRecomputationQueue,
  InMemoryBuybackEvRevisionPort,
  completeEvidenceOutcome,
  recomputationCommand,
  unavailableEvidenceOutcome,
} from "./buyback-adjusted-ev-recomputation.test-support.ts";
import { PackScoutBuybackEvRevisionStore } from "./buyback-adjusted-ev-revision-store.ts";
import type {
  OperationalLog,
  OperationalMetric,
} from "./operational-events.ts";

const CALCULATED_AT = "2026-08-19T18:05:00.000Z";

function mutableClock(initial: string) {
  let now = new Date(initial);
  return {
    clock: { now: () => new Date(now) },
    set(value: string) {
      now = new Date(value);
    },
  };
}

function harness() {
  const port = new InMemoryBuybackEvRevisionPort();
  const store = new PackScoutBuybackEvRevisionStore(port);
  const service = new PackScoutBuybackAdjustedEvRecomputationService(store);
  const queue = new InMemoryBuybackEvRecomputationQueue();
  const metrics: OperationalMetric[] = [];
  const logs: OperationalLog[] = [];
  const observability = {
    metric: (metric: OperationalMetric) => metrics.push(metric),
    log: (entry: OperationalLog) => logs.push(entry),
  };
  return { port, store, service, queue, metrics, logs, observability };
}

function processorFor(
  context: ReturnType<typeof harness>,
  clock: ReturnType<typeof mutableClock>["clock"],
  recomputations: BuybackAdjustedEvRecomputationPort = context.service,
  options: Partial<
    ConstructorParameters<typeof BuybackAdjustedEvRecomputationProcessor>[3]
  > = {},
) {
  return new BuybackAdjustedEvRecomputationProcessor(
    context.queue,
    recomputations,
    clock,
    {
      workerId: "buyback-ev-worker-1",
      maximumRequestsPerCycle: 25,
      leaseMilliseconds: 1_000,
      retryDelayMilliseconds: 1_000,
      maximumAttempts: 3,
      ...options,
    },
    context.observability,
  );
}

test("processor options and worker identity are bounded", () => {
  const context = harness();
  const clock = mutableClock("2026-08-19T18:06:00.000Z").clock;
  assert.throws(
    () => processorFor(context, clock, context.service, { workerId: "" }),
    RangeError,
  );
  assert.throws(
    () =>
      processorFor(context, clock, context.service, {
        maximumRequestsPerCycle: 0,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      processorFor(context, clock, context.service, {
        maximumRequestsPerCycle: 101,
      }),
    RangeError,
  );
  assert.throws(
    () => processorFor(context, clock, context.service, { leaseMilliseconds: 1 }),
    RangeError,
  );
  assert.throws(
    () => processorFor(context, clock, context.service, { maximumAttempts: 0 }),
    RangeError,
  );
  assert.throws(
    () =>
      processorFor(context, clock, context.service, {
        retryDelayMilliseconds: 16 * 60_000,
      }),
    RangeError,
  );
});

test("a cycle resolves claims into bounded outcome counts with queue-lag telemetry", async () => {
  const context = harness();
  const time = mutableClock("2026-08-19T18:06:00.000Z");
  context.queue.enqueue(
    recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT),
    "2026-08-19T18:05:30.000Z",
  );
  context.queue.enqueue(
    recomputationCommand(
      unavailableEvidenceOutcome({
        internalReasons: ["MISSING_PROVENANCE", "MISSING_SOURCE_TIME"],
        observationPresent: false,
        observedAt: null,
      }),
      CALCULATED_AT,
    ),
    "2026-08-19T18:05:30.000Z",
  );
  const cycle = await processorFor(context, time.clock).runCycle();
  assert.deepEqual(cycle, {
    claimed: 2,
    completed: 2,
    created: 1,
    unchanged: 0,
    superseded: 0,
    rejected: 0,
    unbindable: 1,
    unavailable: 0,
    retrying: 0,
    failed: 0,
    lost: 0,
    capReached: false,
  });
  assert.equal(context.port.rows.length, 1);
  const [first, second] = context.queue.requests;
  assert.equal(first?.state, "completed");
  assert.equal(first?.resultStatus, "created");
  assert.equal(first?.revisionId, context.port.rows[0]!.revisionId);
  assert.equal(second?.state, "completed");
  assert.equal(second?.resultStatus, "unbindable");
  assert.equal(second?.outcomeReasonCode, "UNBINDABLE_RESULT");
  const lag = context.metrics.filter(({ name }) => name === "cursor_lag_proxy");
  assert.equal(lag.length, 2);
  assert.ok(lag.every(({ value }) => value === 30));
  assert.ok(
    lag.every(
      ({ outcomeCode }) => outcomeCode === "BUYBACK_EV_RECOMPUTATION_QUEUE",
    ),
  );

  // Same-evidence redelivery completes as unchanged with the same revision.
  context.queue.enqueue(
    recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT),
    "2026-08-19T18:06:00.000Z",
  );
  const replay = await processorFor(context, time.clock).runCycle();
  assert.deepEqual(
    { completed: replay.completed, unchanged: replay.unchanged },
    { completed: 1, unchanged: 1 },
  );
  assert.equal(context.port.rows.length, 1);
});

test("transient failures retry durably without duplicate revisions and exhaust into failed", async () => {
  const context = harness();
  const time = mutableClock("2026-08-19T18:06:00.000Z");
  context.queue.enqueue(
    recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT),
    "2026-08-19T18:05:30.000Z",
  );
  let calls = 0;
  const transientThenReal: BuybackAdjustedEvRecomputationPort = {
    recompute: async (command) => {
      calls += 1;
      if (calls === 1) throw { code: "TRANSIENT_RECOMPUTATION_FAILURE" };
      return context.service.recompute(command);
    },
  };
  const worker = processorFor(context, time.clock, transientThenReal);
  assert.equal((await worker.runCycle()).retrying, 1);
  let [request] = context.queue.requests;
  assert.deepEqual(
    {
      state: request?.state,
      attempts: request?.attemptCount,
      code: request?.failureCode,
    },
    { state: "queued", attempts: 1, code: "TRANSIENT_RECOMPUTATION_FAILURE" },
  );
  time.set("2026-08-19T18:06:02.000Z");
  const second = await worker.runCycle();
  assert.deepEqual(
    { completed: second.completed, created: second.created },
    { completed: 1, created: 1 },
  );
  [request] = context.queue.requests;
  assert.deepEqual(
    { state: request?.state, attempts: request?.attemptCount },
    { state: "completed", attempts: 2 },
  );
  assert.equal(context.port.rows.length, 1);
  const retryMetrics = context.metrics.filter(
    ({ name }) => name === "retry_outcome_total",
  );
  assert.deepEqual(
    retryMetrics.map(({ outcomeCode }) => outcomeCode),
    ["BUYBACK_EV_RECOMPUTATION_RETRYING"],
  );

  // A deterministically invalid item exhausts its bounded attempts with the
  // typed contract-violation code instead of retrying forever.
  context.queue.enqueue(
    recomputationCommand(
      completeEvidenceOutcome(),
      "2026-08-19T18:05:00.000",
    ),
    "2026-08-19T18:06:02.000Z",
  );
  const alwaysFailing = processorFor(context, time.clock);
  const attempts: number[] = [];
  for (let cycle = 1; cycle <= 4; cycle += 1) {
    const result = await alwaysFailing.runCycle();
    attempts.push(result.retrying + result.failed);
    time.set(`2026-08-19T18:06:${String(2 + cycle * 2).padStart(2, "0")}.000Z`);
  }
  const failedRequest = context.queue.requests[1];
  assert.equal(failedRequest?.state, "failed");
  assert.equal(failedRequest?.attemptCount, 3);
  assert.equal(failedRequest?.failureCode, "CONTRACT_VIOLATION");
  assert.deepEqual(attempts, [1, 1, 1, 0]);
});

test("stale claim tokens report lost work and telemetry failures never break the cycle", async () => {
  const context = harness();
  const time = mutableClock("2026-08-19T18:06:00.000Z");
  context.queue.enqueue(
    recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT),
    "2026-08-19T18:05:30.000Z",
  );
  const stealing: BuybackAdjustedEvRecomputationPort = {
    recompute: async (command) => {
      // Another worker recovers the expired lease before this one finishes.
      const request = context.queue.requests[0]!;
      request.claimToken = "stolen-token";
      return context.service.recompute(command);
    },
  };
  const cycle = await processorFor(context, time.clock, stealing).runCycle();
  assert.deepEqual(
    { completed: cycle.completed, lost: cycle.lost },
    { completed: 0, lost: 1 },
  );
  assert.equal(context.port.rows.length, 1, "the revision itself is durable");

  // Unlabelled crashes fall back to the bounded default failure code.
  context.queue.enqueue(
    recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT),
    "2026-08-19T18:05:30.000Z",
  );
  const crashing: BuybackAdjustedEvRecomputationPort = {
    recompute: async () => {
      throw new Error("unlabelled crash");
    },
  };
  assert.equal(
    (await processorFor(context, time.clock, crashing).runCycle()).retrying,
    1,
  );
  assert.equal(
    context.queue.requests[1]?.failureCode,
    "BUYBACK_EV_RECOMPUTATION_FAILED",
  );

  const throwingTelemetry = {
    metric: () => {
      throw new Error("telemetry offline");
    },
    log: () => {
      throw new Error("telemetry offline");
    },
  };
  const isolated = harness();
  isolated.queue.enqueue(
    recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT),
    "2026-08-19T18:05:30.000Z",
  );
  const worker = new BuybackAdjustedEvRecomputationProcessor(
    isolated.queue,
    isolated.service,
    time.clock,
    { workerId: "buyback-ev-worker-2" },
    throwingTelemetry,
  );
  assert.equal((await worker.runCycle()).completed, 1);
});

test("cycle caps bound the claimed batch and report capReached", async () => {
  const context = harness();
  const time = mutableClock("2026-08-19T18:06:00.000Z");
  for (let index = 0; index < 3; index += 1) {
    context.queue.enqueue(
      recomputationCommand(
        completeEvidenceOutcome(),
        `2026-08-19T18:0${index + 1}:00.000Z`,
      ),
      "2026-08-19T18:00:30.000Z",
    );
  }
  const worker = processorFor(context, time.clock, context.service, {
    maximumRequestsPerCycle: 2,
  });
  const first = await worker.runCycle();
  assert.equal(first.claimed, 2);
  assert.equal(first.capReached, true);
  const second = await worker.runCycle();
  assert.equal(second.claimed, 1);
  assert.equal(second.capReached, false);
});
