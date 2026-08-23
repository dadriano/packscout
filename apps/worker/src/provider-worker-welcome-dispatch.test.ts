import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ClaimedWelcome,
  EnqueueEmailMessageCommand,
  WelcomeDispatchDirectoryPort,
} from "@packscout/services";
import {
  createProviderWorkerWelcomeDispatchProcessor,
  type ProviderWorkerWelcomeDispatchInput,
} from "./provider-worker-welcome-dispatch.ts";
import {
  ProviderWorkerRuntime,
  type ProviderWorkerLogEvent,
} from "./provider-worker-runtime.ts";

const start = new Date("2026-08-23T12:00:00.000Z");

const CONFIGURED_ENV = {
  PACKSCOUT_ADMIN_DIRECTORY_URL: "https://backend.example.com",
  PACKSCOUT_ADMIN_DIRECTORY_TOKEN: "welcome-dispatch-integration-token-0001",
};

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
  leaseMilliseconds: 60_000,
  pollIntervalMilliseconds: 5_000,
};

function fakeDirectory(batches: ClaimedWelcome[][]) {
  const claimCalls: { limit: number; leaseMilliseconds: number }[] = [];
  const settleCalls: { subject: string; outcome: string }[] = [];
  let batch = 0;
  const port: WelcomeDispatchDirectoryPort = {
    async claimDueWelcomes(input) {
      claimCalls.push(input);
      const claims = batches[batch] ?? [];
      batch += 1;
      return claims;
    },
    async settleWelcome(input) {
      settleCalls.push(input);
      return "settled";
    },
  };
  return { port, claimCalls, settleCalls };
}

function fakeOutbox() {
  const commands: EnqueueEmailMessageCommand[] = [];
  return {
    commands,
    outbox: {
      async enqueueEmailMessage(command: EnqueueEmailMessageCommand) {
        commands.push(command);
        return {
          status: "enqueued" as const,
          intentId: "11111111-1111-4111-8111-111111111111",
          deduplicated: false,
        };
      },
    },
  };
}

function processor(
  input: Partial<ProviderWorkerWelcomeDispatchInput> & {
    directory?: WelcomeDispatchDirectoryPort;
  },
  clock: { now: () => Date },
) {
  const { outbox } = fakeOutbox();
  return createProviderWorkerWelcomeDispatchProcessor({
    env: CONFIGURED_ENV,
    outbox,
    clock,
    settings,
    ...input,
  });
}

test("dispatcher passes run on their own cadence between worker cycles", async () => {
  const { clock, advance } = manualClock();
  const directory = fakeDirectory([[], [], []]);
  const job = processor({ directory: directory.port }, clock);

  const first = await job.runCycle();
  assert.equal(first.outcome, "dispatched");
  assert.equal(directory.claimCalls.length, 1);

  // The worker polls far faster than the dispatch cadence; in-between
  // cycles wait without touching the directory.
  advance(1_000);
  assert.deepEqual(await job.runCycle(), { outcome: "waiting" });
  assert.equal(directory.claimCalls.length, 1);

  advance(4_000);
  const second = await job.runCycle();
  assert.equal(second.outcome, "dispatched");
  assert.equal(directory.claimCalls.length, 2);
});

test("a full batch opens the gate immediately so a backlog dispatches at cycle speed", async () => {
  const { clock, advance } = manualClock();
  const full: ClaimedWelcome[] = [
    { subject: "privy.io|did:privy:one", email: "one@example.com" },
    { subject: "privy.io|did:privy:two", email: "two@example.com" },
  ];
  const directory = fakeDirectory([full, [], []]);
  const job = processor({ directory: directory.port }, clock);

  const first = await job.runCycle();
  assert.equal(first.outcome, "dispatched");
  assert.equal("capReached" in first && first.capReached, true);

  // No clock advance: the next cycle still runs because the batch was full,
  // then the empty batch restores the normal cadence.
  const followUp = await job.runCycle();
  assert.equal(followUp.outcome, "dispatched");
  assert.equal(directory.claimCalls.length, 2);
  advance(1_000);
  assert.deepEqual(await job.runCycle(), { outcome: "waiting" });
});

test("the off switch idles the welcome kind without touching the directory or the outbox", async () => {
  const { clock, advance } = manualClock();
  const directory = fakeDirectory([[]]);
  const { commands, outbox } = fakeOutbox();
  const job = createProviderWorkerWelcomeDispatchProcessor({
    env: { ...CONFIGURED_ENV, PACKSCOUT_WELCOME_EMAIL_ENABLED: "off" },
    outbox,
    clock,
    settings,
    directory: directory.port,
  });

  assert.deepEqual(await job.runCycle(), { outcome: "disabled" });
  advance(5_000);
  assert.deepEqual(await job.runCycle(), { outcome: "disabled" });
  assert.equal(directory.claimCalls.length, 0);
  assert.equal(commands.length, 0);
});

test("an unconfigured integration idles instead of failing the worker", async () => {
  const { clock } = manualClock();
  const directory = fakeDirectory([[]]);
  const job = createProviderWorkerWelcomeDispatchProcessor({
    env: {},
    outbox: fakeOutbox().outbox,
    clock,
    settings,
    directory: directory.port,
  });

  assert.deepEqual(await job.runCycle(), { outcome: "unconfigured" });
  assert.equal(directory.claimCalls.length, 0);
});

test("a pass claims, enqueues through the durable outbox, and settles after the enqueue", async () => {
  const { clock } = manualClock();
  const directory = fakeDirectory([
    [{ subject: "privy.io|did:privy:one", email: "one@example.com" }],
  ]);
  const { commands, outbox } = fakeOutbox();
  const job = createProviderWorkerWelcomeDispatchProcessor({
    env: CONFIGURED_ENV,
    outbox,
    clock,
    settings,
    directory: directory.port,
  });

  const result = await job.runCycle();
  assert.equal(result.outcome, "dispatched");
  assert.equal("enqueued" in result && result.enqueued, 1);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.kind, "welcome");
  assert.equal(commands[0]?.source, "closed_beta_welcome");
  assert.deepEqual(directory.settleCalls, [
    { subject: "privy.io|did:privy:one", outcome: "sent" },
  ]);
});

test("the poll interval bound is refused at composition", () => {
  const { clock } = manualClock();
  for (const pollIntervalMilliseconds of [99, 300_001, 2.5]) {
    assert.throws(
      () =>
        createProviderWorkerWelcomeDispatchProcessor({
          env: CONFIGURED_ENV,
          outbox: fakeOutbox().outbox,
          clock,
          settings: { ...settings, pollIntervalMilliseconds },
        }),
      RangeError,
    );
  }
});

function runtimeHarness(welcomeDispatch: {
  runCycle(): Promise<
    Awaited<
      ReturnType<
        ReturnType<
          typeof createProviderWorkerWelcomeDispatchProcessor
        >["runCycle"]
      >
    >
  >;
}) {
  const events: ProviderWorkerLogEvent[] = [];
  const runtime = new ProviderWorkerRuntime({
    scheduler: {
      async runOnce() {
        return { kind: "idle" as const };
      },
    },
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
    welcomeDispatch,
    logger: { write: (event) => void events.push(event) },
    workerId: "worker:runtime:welcome",
  });
  return { runtime, events };
}

test("the worker runtime runs the dispatcher each cycle and reports the same cycle facts as its siblings", async () => {
  const { runtime, events } = runtimeHarness({
    async runCycle() {
      return {
        outcome: "dispatched" as const,
        claimed: 3,
        enqueued: 2,
        deduplicated: 1,
        skipped: 1,
        errors: 0,
        capReached: false,
      };
    },
  });

  await runtime.runCycle();

  const finished = events.find(
    ({ event }) => event === "provider_welcome_dispatch_cycle_finished",
  );
  assert.ok(finished, "the dispatcher reports liveness like sibling jobs");
  assert.equal(finished.level, "info");
  assert.equal(finished.outcome, "succeeded");
  assert.equal(finished.welcomeClaimed, 3);
  assert.equal(finished.welcomeEnqueued, 2);
  assert.equal(finished.welcomeDeduplicated, 1);
  assert.equal(finished.welcomeSkipped, 1);
  assert.equal(finished.welcomeErrors, 0);
});

test("waiting, disabled, and unconfigured passes stay silent; errors degrade the cycle visibly", async () => {
  for (const outcome of ["waiting", "disabled", "unconfigured"] as const) {
    const { runtime, events } = runtimeHarness({
      async runCycle() {
        return { outcome };
      },
    });
    await runtime.runCycle();
    assert.equal(
      events.some(({ event }) => event.startsWith("provider_welcome")),
      false,
      `${outcome} passes are not observable cycles`,
    );
  }

  const { runtime, events } = runtimeHarness({
    async runCycle() {
      return {
        outcome: "dispatched" as const,
        claimed: 2,
        enqueued: 1,
        deduplicated: 0,
        skipped: 0,
        errors: 1,
        capReached: false,
      };
    },
  });
  await runtime.runCycle();
  const finished = events.find(
    ({ event }) => event === "provider_welcome_dispatch_cycle_finished",
  );
  assert.ok(finished);
  assert.equal(finished.level, "error");
  assert.equal(finished.outcome, "degraded");
  assert.equal(finished.failureCode, "WELCOME_DISPATCH_FAILED");
});

test("a throwing dispatcher is logged and never breaks the worker cycle", async () => {
  const { runtime, events } = runtimeHarness({
    async runCycle() {
      throw new Error("directory unreachable");
    },
  });

  // The cycle itself completes; the failure is a bounded log event.
  await runtime.runCycle();
  const failed = events.find(
    ({ event }) => event === "provider_welcome_dispatch_cycle_failed",
  );
  assert.ok(failed);
  assert.equal(failed.level, "error");
  assert.equal(failed.failureCode, "WELCOME_DISPATCH_CYCLE_ERROR");
});
