import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MachineryAlertCycleError,
  MachineryAlertService,
  type MachineryAlertFactsSource,
  type OperationalEventService,
} from "@packscout/services";
import {
  createAdminMachineryAlertObserver,
  startMachineryAlertLoop,
  type MachineryAlertReport,
} from "./machinery-alert-runtime.ts";

/**
 * The bounded evaluation loop the admin server hosts. It has to keep running
 * through a failing cycle — the conditions it detects are exactly the ones that
 * make reads fail — and it must never let cycles pile up or hold shutdown open.
 */

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Publication is never reached in these cases; a refusal would hide that. */
const unusedEvents = {
  machineryConditionRaised: () => {
    throw new Error("no condition should have been published");
  },
  machineryConditionCleared: () => {
    throw new Error("no condition should have been cleared");
  },
} as unknown as Pick<
  OperationalEventService,
  "machineryConditionRaised" | "machineryConditionCleared"
>;

function unreadableSource(
  organizations: readonly string[] | null,
): MachineryAlertFactsSource {
  return {
    listOrganizations: async () => {
      if (organizations === null) throw new Error("presence store unreadable");
      return organizations;
    },
    readFacts: async (organizationId: string) => {
      throw new Error(`workspace ${organizationId} is unreadable`);
    },
  };
}

/**
 * Machinery alerting that reads nothing publishes nothing, which from the
 * outside is indistinguishable from a healthy pipeline. A cycle that evaluated
 * nothing must therefore reach the admin's failure path rather than report a
 * quiet, all-zero cycle.
 */
test("a facts store that cannot be read reaches the loop's failure path", async () => {
  const completed: unknown[] = [];
  const service = new MachineryAlertService(unreadableSource(null), unusedEvents, {
    cycleCompleted: (result) => completed.push(result),
  });

  await assert.rejects(
    () => service.runCycle(),
    (error: unknown) =>
      error instanceof MachineryAlertCycleError &&
      error.code === "MACHINERY_ALERT_CYCLE_UNREADABLE",
  );
  // Nothing reported a completed cycle, so no all-zero result can be mistaken
  // for a pipeline with no conditions to report.
  assert.deepEqual(completed, []);

  const failures: unknown[] = [];
  const loop = startMachineryAlertLoop({
    intervalMs: 1_000,
    cycle: () => service.runCycle(),
    onFailure: (error) => failures.push(error),
  });
  const { setTimeout: wait } = await import("node:timers/promises");
  try {
    await wait(1_300);
  } finally {
    await loop.stop();
  }
  assert.equal(failures.length, 1, "the unreadable cycle is surfaced, not lost");
  assert.ok(failures[0] instanceof MachineryAlertCycleError);
});

test("every workspace failing is reported per workspace and rejects the cycle", async () => {
  const reports: MachineryAlertReport[] = [];
  const service = new MachineryAlertService(
    unreadableSource(["9c000000-0000-4000-8000-000000000001", "9c000000-0000-4000-8000-000000000002"]),
    unusedEvents,
    createAdminMachineryAlertObserver((report) => reports.push(report)),
  );

  await assert.rejects(() => service.runCycle(), MachineryAlertCycleError);
  // Each unreadable workspace is named as a failed capability, and nothing
  // about the workspace or the underlying reason travels with it.
  assert.deepEqual(reports, [
    { event: "admin_machinery_alert_workspace_unreadable" },
    { event: "admin_machinery_alert_workspace_unreadable" },
  ]);
});

test("the admin reports a degraded cycle and stays quiet about a healthy one", () => {
  const reports: MachineryAlertReport[] = [];
  const observer = createAdminMachineryAlertObserver((report) =>
    reports.push(report),
  );

  observer.cycleCompleted({
    organizations: 4,
    raised: 2,
    cleared: 1,
    failedOrganizations: 0,
    failedPublications: 0,
  });
  // A line every cadence would bury the one line that matters.
  assert.deepEqual(reports, []);

  observer.cycleCompleted({
    organizations: 4,
    raised: 1,
    cleared: 0,
    failedOrganizations: 1,
    failedPublications: 2,
  });
  assert.deepEqual(reports, [
    {
      event: "admin_machinery_alert_cycle_degraded",
      organizations: 4,
      failedOrganizations: 1,
      failedPublications: 2,
    },
  ]);
});

test("the loop refuses a cadence outside its bounds", () => {
  assert.throws(
    () => startMachineryAlertLoop({ cycle: () => Promise.resolve(), intervalMs: 999 }),
    RangeError,
  );
});

test("cycles never overlap, a failing cycle is reported, and stopping drains the one in flight", async () => {
  const gate = deferred();
  const started: number[] = [];
  const failures: unknown[] = [];
  let cycles = 0;
  const loop = startMachineryAlertLoop({
    intervalMs: 1_000,
    cycle: async () => {
      cycles += 1;
      started.push(cycles);
      if (cycles === 1) {
        await gate.promise;
        throw new Error("evidence unavailable");
      }
    },
    onFailure: (error) => failures.push(error),
  });

  // Two ticks arrive while the first cycle is still in flight; the second must
  // wait rather than run concurrently against the same evidence.
  const { setTimeout: wait } = await import("node:timers/promises");
  await wait(2_100);
  assert.deepEqual(started, [1], "only one cycle runs at a time");

  gate.resolve();
  await loop.stop();
  assert.equal(failures.length, 1, "the failing cycle is reported, not thrown");
  // A cycle queued behind the stop is abandoned rather than run afterwards.
  assert.deepEqual(started, [1]);
  // Stopping is idempotent and stays settled.
  await loop.stop();
});

/**
 * A slow cycle must cost one delayed cycle, not a growing queue of callbacks
 * and a burst of catch-up cycles reading the same evidence back-to-back the
 * moment it finishes.
 */
test("ticks missed during a slow cycle are coalesced instead of stacking up", async () => {
  const gate = deferred();
  const started: number[] = [];
  let cycles = 0;
  const loop = startMachineryAlertLoop({
    intervalMs: 1_000,
    cycle: async () => {
      cycles += 1;
      started.push(cycles);
      if (cycles === 1) await gate.promise;
    },
  });

  const { setTimeout: wait } = await import("node:timers/promises");
  try {
    // Three cadences pass while the first cycle is still in flight.
    await wait(3_300);
    assert.deepEqual(started, [1], "only one cycle runs at a time");

    gate.resolve();
    await wait(200);
    // Nothing was owed by those missed cadences, so no burst follows.
    assert.deepEqual(started, [1], "missed cadences do not run back-to-back");

    // The cadence resumes, timed from the end of the slow cycle.
    await wait(1_200);
    assert.deepEqual(started, [1, 2]);
  } finally {
    await loop.stop();
  }
});
