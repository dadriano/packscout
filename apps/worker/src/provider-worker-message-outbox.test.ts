import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  EmailDeliveryResult,
  WorkerActivity,
} from "@packscout/contracts";
import type {
  EmailDeliveryResolution,
  MessageOutboxDrainCycleResult,
} from "@packscout/services";
import {
  createProviderWorkerMessageOutboxProcessor,
  type ProviderWorkerMessageOutboxInput,
} from "./provider-worker-message-outbox.ts";
import {
  ProviderWorkerRuntime,
  type ProviderWorkerLogEvent,
} from "./provider-worker-runtime.ts";

const start = new Date("2026-08-22T12:00:00.000Z");

function manualClock() {
  let at = start.getTime();
  return {
    clock: { now: () => new Date(at) },
    advance(milliseconds: number) {
      at += milliseconds;
    },
  };
}

const settings = {
  batchSize: 2,
  perRecipientLimit: 2,
  leaseMilliseconds: 30_000,
  maximumAttempts: 4,
  backoffBaseMilliseconds: 1_000,
  backoffCapMilliseconds: 60_000,
  pollIntervalMilliseconds: 5_000,
};

function readyDelivery() {
  return {
    resolve(): EmailDeliveryResolution {
      return {
        mode: { kind: "auto" },
        adapter: null,
        productionLike: false,
        readiness: { ready: true },
      };
    },
    async send(): Promise<EmailDeliveryResult> {
      return { status: "skipped", reason: "missing_configuration" };
    },
  };
}

function claimableQueue(claimBatches: number[][]) {
  const claimCalls: Date[] = [];
  let batch = 0;
  return {
    claimCalls,
    queue: {
      async claimDueBatch(input: { now: Date }) {
        claimCalls.push(input.now);
        const size = claimBatches[batch] ?? [];
        batch += 1;
        return size.map((index) => ({
          intentId: `00000000-0000-4000-8000-00000000000${index}`,
          kind: "welcome",
          input: {},
          recipient: `person-${index}@example.test`,
          claimToken: `10000000-0000-4000-8000-00000000000${index}`,
          attemptNumber: 1,
        }));
      },
      async recordAttemptOutcome() {
        return "skipped" as const;
      },
    } satisfies ProviderWorkerMessageOutboxInput["queue"],
  };
}

test("drain passes run on their own cadence between worker cycles", async () => {
  const { clock, advance } = manualClock();
  const { queue, claimCalls } = claimableQueue([[], [], []]);
  const processor = createProviderWorkerMessageOutboxProcessor({
    queue,
    delivery: readyDelivery(),
    origins: { productOrigin: "https://packscout.example", adminOrigin: null },
    clock,
    workerId: "worker:outbox:1",
    settings,
  });

  const first = await processor.runCycle();
  assert.equal(first.outcome, "drained");
  assert.equal(claimCalls.length, 1);

  // The worker polls far faster than the outbox cadence; in-between cycles
  // wait without touching the queue.
  advance(1_000);
  assert.deepEqual(await processor.runCycle(), { outcome: "waiting" });
  assert.equal(claimCalls.length, 1);

  advance(4_000);
  const second = await processor.runCycle();
  assert.equal(second.outcome, "drained");
  assert.equal(claimCalls.length, 2);
});

test("a full batch opens the gate immediately so a backlog drains at cycle speed", async () => {
  const { clock, advance } = manualClock();
  const { queue, claimCalls } = claimableQueue([[1, 2], [1], []]);
  const processor = createProviderWorkerMessageOutboxProcessor({
    queue,
    delivery: readyDelivery(),
    origins: { productOrigin: "https://packscout.example", adminOrigin: null },
    clock,
    workerId: "worker:outbox:1",
    settings,
  });

  const full = await processor.runCycle();
  assert.equal(full.outcome, "drained");
  assert.equal((full as MessageOutboxDrainCycleResult).capReached, true);

  // No clock advance: the next cycle still drains because the last batch
  // was full, then the partial batch restores the normal cadence.
  const followUp = await processor.runCycle();
  assert.equal(followUp.outcome, "drained");
  assert.equal(claimCalls.length, 2);
  advance(1_000);
  assert.deepEqual(await processor.runCycle(), { outcome: "waiting" });
  assert.equal(claimCalls.length, 2);
});

test("the worker runtime drains the outbox each cycle, reports its activity, and logs the outcome", async () => {
  const events: ProviderWorkerLogEvent[] = [];
  const activities: WorkerActivity[] = [];
  const outboxCalls: number[] = [];
  const runtime = new ProviderWorkerRuntime({
    scheduler: { async runOnce() { return { kind: "idle" as const }; } },
    imports: {
      async executeImport() {
        throw new Error("no imports in this test");
      },
      async executeNextImport() {
        return { kind: "idle" as const };
      },
    },
    retention: {
      async runCycle() {
        return {
          cutoffAt: start.toISOString(),
          discoveredOrganizations: 0,
          attemptedOrganizations: 0,
          batchesRun: 0,
          expired: 0,
          failed: 0,
          knownRemaining: 0,
          deferredOrganizations: 0,
          capReached: false,
          prunedRecords: 0,
          prunedFailures: 0,
        };
      },
    },
    messageOutbox: {
      async runCycle() {
        outboxCalls.push(1);
        return {
          outcome: "drained" as const,
          claimed: 3,
          sent: 1,
          skipped: 1,
          retrying: 1,
          failed: 0,
          lost: 0,
          errors: 0,
          capReached: false,
        };
      },
    },
    presence: {
      async start() {},
      activity(activity) {
        activities.push(activity);
      },
      async stop() {},
    },
    logger: { write: (event) => void events.push(event) },
    workerId: "worker:runtime:1",
  });

  await runtime.runCycle();

  assert.equal(outboxCalls.length, 1);
  assert.ok(
    activities.some((activity) => activity.kind === "message_outbox"),
    "the drain publishes its own activity kind",
  );
  const finished = events.find(
    ({ event }) => event === "provider_message_outbox_cycle_finished",
  );
  assert.ok(finished, "the drain reports the same cycle facts other jobs report");
  assert.equal(finished.level, "info");
  assert.equal(finished.outcome, "succeeded");
  assert.equal(finished.outboxClaimed, 3);
  assert.equal(finished.outboxSent, 1);
  assert.equal(finished.outboxSkipped, 1);
  assert.equal(finished.outboxRetrying, 1);
});

test("waiting outbox cycles stay silent and a failing drain never breaks the worker cycle", async () => {
  const events: ProviderWorkerLogEvent[] = [];
  const behavior = { mode: "waiting" as "waiting" | "throw" | "deferred" };
  const runtime = new ProviderWorkerRuntime({
    scheduler: { async runOnce() { return { kind: "idle" as const }; } },
    imports: {
      async executeImport() {
        throw new Error("no imports in this test");
      },
      async executeNextImport() {
        return { kind: "idle" as const };
      },
    },
    retention: {
      async runCycle() {
        return {
          cutoffAt: start.toISOString(),
          discoveredOrganizations: 0,
          attemptedOrganizations: 0,
          batchesRun: 0,
          expired: 0,
          failed: 0,
          knownRemaining: 0,
          deferredOrganizations: 0,
          capReached: false,
          prunedRecords: 0,
          prunedFailures: 0,
        };
      },
    },
    messageOutbox: {
      async runCycle() {
        if (behavior.mode === "throw") throw new Error("drain broke");
        if (behavior.mode === "deferred") {
          return {
            outcome: "deferred" as const,
            claimed: 0,
            sent: 0,
            skipped: 0,
            retrying: 0,
            failed: 0,
            lost: 0,
            errors: 0,
            capReached: false,
          };
        }
        return { outcome: "waiting" as const };
      },
    },
    logger: { write: (event) => void events.push(event) },
    workerId: "worker:runtime:2",
  });

  await runtime.runCycle();
  assert.equal(
    events.some(({ event }) => event.startsWith("provider_message_outbox")),
    false,
    "a gated pass is not an observable cycle",
  );

  behavior.mode = "deferred";
  await runtime.runCycle();
  const deferred = events.find(
    ({ event }) => event === "provider_message_outbox_cycle_finished",
  );
  assert.equal(deferred?.outcome, "deferred");
  assert.equal(deferred?.level, "info");

  behavior.mode = "throw";
  const result = await runtime.runCycle();
  assert.equal(result.reason, "idle", "the worker cycle survives a broken drain");
  assert.equal(
    events.some(
      ({ event }) => event === "provider_message_outbox_cycle_failed",
    ),
    true,
  );
});
