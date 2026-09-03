import assert from "node:assert/strict";
import { test } from "node:test";
import { DATABASE_OPERATIONS } from "./database-operations.ts";
import {
  DATABASE_URL_VARIABLE,
  requireLocalDatabaseTarget,
} from "./database-target.ts";
import type { OperationOutputLine } from "./operation-output.ts";
import {
  createDatabaseOperationRunner,
  parseOperationMarker,
  type OperationEvent,
  type OperationMarker,
  type OperationRunSnapshot,
  type OperationSpawnRequest,
} from "./operation-supervisor.ts";

const LOCAL = "postgresql://packscout:hunter2@127.0.0.1:5432/packscout_dev";
const REMOTE = "postgresql://packscout:hunter2@db.example.com:5432/packscout_dev";

interface FakeTimer {
  handler: () => void;
  milliseconds: number;
  cleared: boolean;
}

interface FakeChild {
  request: OperationSpawnRequest;
  killed: number;
  markersWhenSpawned: number;
}

function harness(
  options: {
    url?: string | undefined;
    timeoutMs?: number;
    lineLimit?: number;
    marker?: unknown;
    sanitize?: (text: string) => string;
    /** Hold every termination open until the test releases it. */
    holdTermination?: boolean;
  } = {},
) {
  const env: Record<string, string | undefined> = {
    [DATABASE_URL_VARIABLE]: options.url === undefined ? LOCAL : options.url,
  };
  const children: FakeChild[] = [];
  const saved: (OperationMarker | null)[] = [];
  const settled: OperationRunSnapshot[] = [];
  const timers: FakeTimer[] = [];
  const events: OperationEvent[] = [];
  const releases: Array<() => void> = [];
  const terminations: Array<Promise<void>> = [];
  let clock = Date.parse("2026-08-20T09:00:00.000Z");

  const runner = createDatabaseOperationRunner({
    permit: () => requireLocalDatabaseTarget(env),
    markerStore: {
      load: async () => options.marker ?? null,
      save: async (marker) => {
        saved.push(marker);
      },
    },
    spawn: (request) => {
      const child: FakeChild = {
        request,
        killed: 0,
        markersWhenSpawned: saved.length,
      };
      children.push(child);
      return {
        kill: () => {
          child.killed += 1;
          if (!options.holdTermination) return Promise.resolve();
          const held = new Promise<void>((resolve) => releases.push(resolve));
          terminations.push(held);
          return held;
        },
      };
    },
    timeoutMs: options.timeoutMs ?? 300_000,
    lineLimit: options.lineLimit ?? 2_000,
    sanitize: options.sanitize,
    onSettled: (run) => settled.push(run),
    now: () => new Date((clock += 1_000)),
    createId: () => `run-${children.length + 1}`,
    setTimer: (handler, milliseconds) => {
      const timer: FakeTimer = { handler, milliseconds, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as FakeTimer).cleared = true;
    },
  });

  runner.subscribe((event) => events.push(event));

  return {
    env,
    runner,
    children,
    saved,
    settled,
    timers,
    events,
    outputLines(): OperationOutputLine[] {
      return events.flatMap((event) =>
        event.type === "output" ? [...event.lines] : [],
      );
    },
    repointTo(url: string | undefined) {
      env[DATABASE_URL_VARIABLE] = url;
    },
    /**
     * Marker writes are queued, so a store that resolves immediately still
     * lands a turn later. One macrotask drains every pending promise job.
     */
    markersSettled: () => new Promise<void>((resolve) => setImmediate(resolve)),
    /** Let every held termination finish, and wait for the lock to be released. */
    async releaseTermination() {
      for (const release of releases.splice(0)) release();
      terminations.splice(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

test("each available operation spawns exactly its own workspace script", async () => {
  for (const definition of DATABASE_OPERATIONS) {
    if (definition.unavailableReason !== undefined) continue;
    const panel = harness();
    const result = await panel.runner.start({
      operation: definition.id,
      acknowledgement: "packscout_dev",
    });
    assert.equal(result.ok, true);
    assert.equal(panel.children.length, 1);
    assert.equal(panel.children[0]?.request.script, definition.workspaceScript);
  }
});

test("nothing outside the registry can be invoked", async () => {
  const panel = harness();
  for (const impostor of [
    "drop",
    "psql",
    "db:reset:local",
    "../../seed",
    "migrate;rm -rf /",
    "",
    null,
    undefined,
    7,
    { operation: "migrate" },
  ]) {
    const result = await panel.runner.start({
      operation: impostor,
      acknowledgement: "packscout_dev",
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.ok === false ? result.code : "",
      "ops_panel_operation_unknown",
    );
  }
  assert.equal(panel.children.length, 0, "no child was spawned for an impostor");
});

test("retired migration refuses without a marker, timer, event, or child", async () => {
  const panel = harness();
  const result = await panel.runner.start({ operation: "migrate" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "ops_panel_operation_unavailable");
  assert.deepEqual(panel.saved, []);
  assert.deepEqual(panel.timers, []);
  assert.deepEqual(panel.events, []);
  assert.deepEqual(panel.children, []);
  assert.equal(panel.runner.running(), null);
  assert.equal(panel.runner.last(), null);
});

test("one operation at a time: a second request names what is running", async () => {
  const panel = harness();
  assert.equal((await panel.runner.start({ operation: "seed" })).ok, true);

  for (const id of ["seed", "reset"] as const) {
    const refusal = await panel.runner.start({
      operation: id,
      acknowledgement: "packscout_dev",
    });
    assert.equal(refusal.ok, false);
    if (refusal.ok) continue;
    assert.equal(refusal.code, "ops_panel_operation_busy");
    assert.match(refusal.message, /Run the seed is already running/u);
  }
  assert.equal(panel.children.length, 1);

  panel.children[0]?.request.onExit({ code: 0, signal: null });
  assert.equal((await panel.runner.start({ operation: "seed" })).ok, true);
  assert.equal(panel.children.length, 2);
});

test("locality is re-read at execution time, not cached from construction", async () => {
  const panel = harness();
  assert.equal((await panel.runner.start({ operation: "seed" })).ok, true);
  panel.children[0]?.request.onExit({ code: 0, signal: null });

  // The developer repoints their environment at a shared database.
  panel.repointTo(REMOTE);
  const refusal = await panel.runner.start({ operation: "seed" });
  assert.equal(refusal.ok, false);
  assert.equal(
    refusal.ok === false ? refusal.code : "",
    "ops_panel_database_not_local",
  );
  assert.equal(panel.children.length, 1, "no child ran against the remote target");
});

test("a target that drifted after the dialog opened refuses before spawning", async () => {
  const panel = harness();
  panel.repointTo("postgresql://packscout:hunter2@127.0.0.1:5432/packscout_other");
  const refusal = await panel.runner.start({
    operation: "reset",
    acknowledgement: "packscout_dev",
    expectedDatabase: "packscout_dev",
  });
  assert.equal(refusal.ok, false);
  assert.equal(
    refusal.ok === false ? refusal.code : "",
    "ops_panel_operation_target_drifted",
  );
  assert.equal(panel.children.length, 0);
  assert.deepEqual(panel.saved, [], "a refused attempt writes no in-flight marker");
});

test("a mismatched acknowledgement refuses before spawning", async () => {
  const panel = harness();
  const refusal = await panel.runner.start({
    operation: "reset",
    acknowledgement: "packscout-dev",
  });
  assert.equal(refusal.ok, false);
  assert.equal(
    refusal.ok === false ? refusal.code : "",
    "ops_panel_operation_acknowledgement_mismatch",
  );
  assert.equal(panel.children.length, 0);
});

test("the in-flight marker is written before the child starts", async () => {
  const panel = harness();
  await panel.runner.start({ operation: "seed" });
  assert.equal(panel.children[0]?.markersWhenSpawned, 1);
  const marker = panel.saved[0];
  assert.ok(marker);
  assert.equal(marker.operation, "seed");
  assert.equal(marker.database, "packscout_dev");
});

test("a successful run settles, clears its marker and reports the outcome", async () => {
  const panel = harness();
  await panel.runner.start({ operation: "seed" });
  panel.children[0]?.request.onOutput("seeding\ndone\n");
  panel.children[0]?.request.onExit({ code: 0, signal: null });
  await panel.markersSettled();

  assert.equal(panel.runner.running(), null);
  const last = panel.runner.last();
  assert.equal(last?.outcome, "succeeded");
  assert.equal(last?.outputLineCount, 2);
  assert.equal(panel.saved.at(-1), null, "the marker was cleared");
  assert.equal(panel.settled.length, 1);
  assert.equal(panel.settled[0]?.outcome, "succeeded");
  assert.equal(panel.timers[0]?.cleared, true, "the timeout was cancelled");
});

test("a failing run reports the exit code without inventing a cause", async () => {
  const panel = harness();
  await panel.runner.start({ operation: "seed" });
  panel.children[0]?.request.onExit({ code: 3, signal: null });

  const last = panel.runner.last();
  assert.equal(last?.outcome, "failed");
  assert.match(last?.message ?? "", /db:seed:local/u);
  assert.match(last?.message ?? "", /exit code 3/u);
});

test("output streams to subscribers and is capped at the configured limit", async () => {
  const panel = harness({ lineLimit: 3 });
  await panel.runner.start({ operation: "seed" });
  panel.children[0]?.request.onOutput("one\ntwo\nthree\nfour\nfive\n");

  assert.deepEqual(
    panel.outputLines().map((line) => line.text),
    ["one", "two", "three"],
  );
  const running = panel.runner.running();
  assert.equal(running?.outputLineCount, 3);
  assert.equal(running?.outputProduced, 5);
  assert.equal(running?.outputTruncated, true);
  assert.match(running?.truncationNotice ?? "", /after 3 lines/u);

  panel.children[0]?.request.onExit({ code: 0, signal: null });
  const last = panel.runner.last();
  assert.equal(last?.outputTruncated, true);
  assert.equal(last?.outcome, "succeeded", "the cap does not abort the operation");
});

test("output events name the run they belong to", async () => {
  const panel = harness();
  const result = await panel.runner.start({ operation: "seed" });
  assert.equal(result.ok, true);
  panel.children[0]?.request.onOutput("line\n");
  const [event] = panel.events.filter((item) => item.type === "output");
  assert.equal(event?.type === "output" ? event.runId : "", "run-1");
});

test("the overall timeout stops the run, kills the child and says so", async () => {
  const panel = harness({ timeoutMs: 60_000 });
  await panel.runner.start({
    operation: "reset",
    acknowledgement: "packscout_dev",
  });
  assert.equal(panel.timers[0]?.milliseconds, 60_000);

  panel.timers[0]?.handler();
  await panel.markersSettled();

  const last = panel.runner.last();
  assert.equal(last?.outcome, "timed_out");
  assert.match(last?.message ?? "", /stopped after 60s/u);
  assert.equal(panel.children[0]?.killed, 1, "the child was terminated");
  assert.match(
    panel.runner
      .output()
      .map((line) => line.text)
      .join("\n"),
    /stopped waiting after 60s/u,
  );
  assert.equal(panel.saved.at(-1), null, "a timed-out run is no longer in doubt");
});

test("a child that never starts settles the run as failed", async () => {
  const panel = harness();
  await panel.runner.start({ operation: "seed" });
  panel.children[0]?.request.onError(new Error("spawn npm ENOENT"));
  assert.equal(panel.runner.last()?.outcome, "failed");
  assert.match(panel.runner.last()?.message ?? "", /spawn npm ENOENT/u);
});

test("messages and output are sanitised before they leave the runner", async () => {
  const secret = LOCAL;
  const panel = harness({
    sanitize: (text) => text.replaceAll(secret, "[redacted]"),
  });
  await panel.runner.start({ operation: "seed" });
  panel.children[0]?.request.onOutput(`could not reach ${secret}\n`);
  panel.children[0]?.request.onError(new Error(`failed for ${secret}`));

  assert.ok(!panel.outputLines().some((line) => line.text.includes("hunter2")));
  assert.ok(!(panel.runner.last()?.message ?? "").includes("hunter2"));
});

/**
 * The restart case. The previous process left a marker behind, so the run's
 * outcome is genuinely unknown — and saying so is the whole point.
 */
test("an interrupted run is adopted as an unknown outcome", async () => {
  const panel = harness({
    marker: {
      runId: "run-earlier",
      operation: "reset",
      database: "packscout_dev",
      startedAt: "2026-08-20T08:59:00.000Z",
    },
  });
  await panel.runner.restore();
  await panel.markersSettled();

  const last = panel.runner.last();
  assert.equal(last?.outcome, "unknown");
  assert.equal(last?.interrupted, true);
  assert.equal(last?.operation, "reset");
  assert.match(last?.message ?? "", /restarted while/u);
  assert.match(last?.message ?? "", /packscout_dev/u);
  assert.equal(panel.settled.length, 1, "the unknown outcome is reported once");
  assert.equal(panel.saved.at(-1), null, "the adopted marker is cleared");
});

test("a marker the panel cannot trust is ignored rather than invented from", async () => {
  for (const marker of [
    null,
    undefined,
    "reset",
    {},
    { runId: "x", operation: "vacuum", startedAt: "2026-08-20T08:59:00.000Z" },
    { runId: "", operation: "reset", startedAt: "2026-08-20T08:59:00.000Z" },
    { runId: "x", operation: "reset", startedAt: "not a date" },
  ]) {
    const panel = harness({ marker });
    await panel.runner.restore();
    assert.equal(panel.runner.last(), null, `${JSON.stringify(marker)} was adopted`);
    assert.equal(panel.settled.length, 0);
  }
});

test("shutdown terminates the child but leaves the marker for the next start", async () => {
  const panel = harness();
  await panel.runner.start({
    operation: "reset",
    acknowledgement: "packscout_dev",
  });
  panel.runner.shutdown();
  await panel.markersSettled();

  assert.equal(panel.children[0]?.killed, 1);
  assert.equal(
    panel.saved.filter((entry) => entry === null).length,
    0,
    "the in-flight marker survives so the outcome is reported as unknown",
  );
  const marker = parseOperationMarker(panel.saved[0]);
  assert.equal(marker?.operation, "reset");
});

/**
 * The lock is about the database, not about the record. A timed-out script is
 * still inside its termination grace period — still connected, still able to
 * write — so admitting a second operation against the same database while the
 * first is dying would race work no one can observe.
 */
test("the lock is held until a timed-out run's process tree has actually exited", async () => {
  const panel = harness({ timeoutMs: 60_000, holdTermination: true });
  await panel.runner.start({ operation: "seed" });
  panel.timers[0]?.handler();

  assert.equal(panel.runner.last()?.outcome, "timed_out");
  assert.equal(panel.children[0]?.killed, 1, "termination was requested");

  const refusal = await panel.runner.start({
    operation: "reset",
    acknowledgement: "packscout_dev",
  });
  assert.equal(refusal.ok, false);
  assert.equal(
    refusal.ok === false ? refusal.code : "",
    "ops_panel_operation_busy",
  );
  assert.match(
    refusal.ok === false ? refusal.message : "",
    /still being stopped/u,
  );
  assert.equal(
    panel.children.length,
    1,
    "no second child ran alongside a script that had not exited",
  );

  await panel.releaseTermination();
  assert.equal((await panel.runner.start({ operation: "seed" })).ok, true);
  assert.equal(panel.children.length, 2);
});

/**
 * The marker is the panel's only evidence that a run happened at all. A store
 * that writes slowly — a busy disk, a slow filesystem — must not let the child
 * start first, and must not let a fast exit clear a marker that has not landed.
 */
test("a delayed marker store still lands the in-flight marker before the child starts", async () => {
  const calls: (OperationMarker | null)[] = [];
  const completions: string[] = [];
  let releaseFirstWrite: (() => void) | undefined;
  let markerCleared: (() => void) | undefined;
  const cleared = new Promise<void>((resolve) => {
    markerCleared = resolve;
  });
  const children: OperationSpawnRequest[] = [];

  const runner = createDatabaseOperationRunner({
    permit: () => requireLocalDatabaseTarget({ [DATABASE_URL_VARIABLE]: LOCAL }),
    markerStore: {
      load: async () => null,
      save: async (marker) => {
        calls.push(marker);
        if (marker !== null) {
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
          completions.push("marker");
          return;
        }
        completions.push("clear");
        markerCleared?.();
      },
    },
    spawn: (request) => {
      children.push(request);
      return { kill: () => Promise.resolve() };
    },
    setTimer: () => "timer",
    clearTimer: () => undefined,
  });

  const started = runner.start({ operation: "seed" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    children.length,
    0,
    "the child must not start before its marker is durable",
  );

  releaseFirstWrite?.();
  const result = await started;
  assert.equal(result.ok, true);
  assert.equal(children.length, 1);

  children[0]?.onExit({ code: 0, signal: null });
  await cleared;
  assert.deepEqual(
    completions,
    ["marker", "clear"],
    "the clear was ordered behind the write it clears",
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1], null);
});

test("a marker parses back into the operation it named", () => {
  const marker = parseOperationMarker({
    runId: "run-1",
    operation: "migrate",
    database: "packscout_dev",
    startedAt: "2026-08-20T08:59:00.000Z",
    label: "ignored",
    workspaceScript: "ignored",
  });
  // Label and script are re-read from the registry, so a hand-edited marker
  // cannot name a script the panel would then run.
  assert.equal(marker?.label, "Apply migrations");
  assert.equal(marker?.workspaceScript, "db:prisma:migrate:deploy");
});
