import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStudioSupervisor,
  isLoopbackAnnouncement,
  readAnnouncedStudioUrl,
  type StudioSpawnRequest,
  type StudioState,
} from "./studio-supervisor.ts";

interface Harness {
  supervisor: ReturnType<typeof createStudioSupervisor>;
  states: StudioState[];
  spawned: StudioSpawnRequest[];
  kills: number;
  runTimer(): void;
  hasTimer(): boolean;
  child(): StudioSpawnRequest;
}

function harness(
  options: {
    permit?: () => { allowed: true } | { allowed: false; message: string };
    spawnThrows?: Error;
  } = {},
): Harness {
  const spawned: StudioSpawnRequest[] = [];
  const states: StudioState[] = [];
  let timer: (() => void) | undefined;
  const harnessState = { kills: 0 };

  const supervisor = createStudioSupervisor({
    port: 5112,
    hostname: "127.0.0.1",
    startupTimeoutMs: 5_000,
    permit: options.permit ?? (() => ({ allowed: true })),
    now: () => new Date("2026-08-20T00:00:00.000Z"),
    setTimer: (handler) => {
      timer = handler;
      return "timer";
    },
    clearTimer: () => {
      timer = undefined;
    },
    spawn: (request) => {
      if (options.spawnThrows) throw options.spawnThrows;
      spawned.push(request);
      return {
        kill: () => {
          harnessState.kills += 1;
        },
      };
    },
  });
  supervisor.subscribe((state) => states.push(state));

  return {
    supervisor,
    states,
    spawned,
    get kills() {
      return harnessState.kills;
    },
    runTimer: () => timer?.(),
    hasTimer: () => timer !== undefined,
    child: () => {
      const request = spawned.at(-1);
      assert.ok(request, "expected a spawned child");
      return request;
    },
  };
}

test("readiness is detected from the child's announcement and embeds a panel-built URL", () => {
  const panel = harness();
  panel.supervisor.start();
  assert.equal(panel.supervisor.state().phase, "starting");
  assert.equal(panel.spawned.length, 1);
  assert.deepEqual(
    { port: panel.child().port, hostname: panel.child().hostname },
    { port: 5112, hostname: "127.0.0.1" },
  );

  panel.child().onOutput("Prisma schema loaded\n");
  assert.equal(panel.supervisor.state().phase, "starting");
  panel.child().onOutput("Prisma Studio is up on http://localhost:5112\n");

  const state = panel.supervisor.state();
  assert.equal(state.phase, "ready");
  // Built from the panel's own loopback bind, not from what the child said.
  assert.equal(state.embedUrl, "http://127.0.0.1:5112");
  assert.equal(state.readyAt, "2026-08-20T00:00:00.000Z");
  assert.equal(panel.hasTimer(), false, "the startup timer is cleared once ready");
});

test("readiness split across chunks still resolves", () => {
  const panel = harness();
  panel.supervisor.start();
  panel.child().onOutput("Prisma Studio is up on ht");
  assert.equal(panel.supervisor.state().phase, "starting");
  panel.child().onOutput("tp://127.0.0.1:5112\n");
  assert.equal(panel.supervisor.state().phase, "ready");
});

test("a non-loopback announcement is killed rather than embedded", () => {
  const panel = harness();
  panel.supervisor.start();
  panel.child().onOutput("Prisma Studio is up on http://10.0.0.7:5112\n");

  const state = panel.supervisor.state();
  assert.equal(state.phase, "failed");
  assert.equal(state.embedUrl, null);
  assert.match(state.message ?? "", /cannot prove is loopback/u);
  assert.equal(panel.kills, 1);
});

test("a startup that never reports readiness times out and stops the child", () => {
  const panel = harness();
  panel.supervisor.start();
  panel.runTimer();

  const state = panel.supervisor.state();
  assert.equal(state.phase, "failed");
  assert.match(state.message ?? "", /did not report readiness within 5s/u);
  assert.equal(panel.kills, 1);
  assert.equal(state.embedUrl, null);
});

test("a crash before readiness is reflected with its exit status", () => {
  const panel = harness();
  panel.supervisor.start();
  panel.child().onExit({ code: 1, signal: null });

  const state = panel.supervisor.state();
  assert.equal(state.phase, "failed");
  assert.match(state.message ?? "", /before it was ready \(exit code 1\)/u);
});

test("a crash after readiness is reflected live rather than leaving a stale embed", () => {
  const panel = harness();
  panel.supervisor.start();
  panel.child().onOutput("Prisma Studio is up on http://127.0.0.1:5112\n");
  panel.child().onExit({ code: null, signal: "SIGSEGV" });

  const state = panel.supervisor.state();
  assert.equal(state.phase, "failed");
  assert.equal(state.embedUrl, null);
  assert.match(state.message ?? "", /exited \(signal SIGSEGV\)/u);
  assert.deepEqual(
    panel.states.map((entry) => entry.phase),
    ["starting", "ready", "failed"],
  );
});

test("a spawn error is reported instead of leaving the panel stuck starting", () => {
  const panel = harness({ spawnThrows: new Error("prisma is not installed") });
  const result = panel.supervisor.start();
  assert.equal(result.started, false);
  assert.equal(panel.supervisor.state().phase, "failed");
  assert.match(panel.supervisor.state().message ?? "", /prisma is not installed/u);
});

test("stopping asks the child to exit and settles on stopped", () => {
  const panel = harness();
  panel.supervisor.start();
  panel.child().onOutput("Prisma Studio is up on http://127.0.0.1:5112\n");
  panel.supervisor.stop();
  assert.equal(panel.supervisor.state().phase, "stopping");
  assert.equal(panel.kills, 1);

  panel.child().onExit({ code: 0, signal: null });
  assert.equal(panel.supervisor.state().phase, "stopped");
  assert.equal(panel.supervisor.state().embedUrl, null);
});

test("shutdown terminates a running child and clears the startup timer", () => {
  const panel = harness();
  panel.supervisor.start();
  panel.supervisor.shutdown();
  assert.equal(panel.kills, 1);
  assert.equal(panel.hasTimer(), false);
  assert.equal(panel.supervisor.state().phase, "stopped");
});

test("a refused permit never spawns anything and explains itself", () => {
  const panel = harness({
    permit: () => ({ allowed: false, message: "The database is not local." }),
  });
  const result = panel.supervisor.start();
  assert.equal(result.started, false);
  assert.equal(result.message, "The database is not local.");
  assert.equal(panel.spawned.length, 0);
  assert.equal(panel.supervisor.state().phase, "failed");
  assert.equal(panel.supervisor.state().message, "The database is not local.");
});

test("the permit is re-evaluated on every start, not cached from the first", () => {
  const answers = [
    { allowed: true } as const,
    { allowed: false, message: "The target moved." } as const,
  ];
  let call = 0;
  const panel = harness({ permit: () => answers[call++] ?? answers[1] });
  panel.supervisor.start();
  panel.child().onExit({ code: 0, signal: null });
  const second = panel.supervisor.start();
  assert.equal(second.started, false);
  assert.equal(second.message, "The target moved.");
});

test("starting twice does not spawn a second child", () => {
  const panel = harness();
  panel.supervisor.start();
  const again = panel.supervisor.start();
  assert.equal(again.started, false);
  assert.equal(panel.spawned.length, 1);
  assert.match(again.message ?? "", /already running/u);
});

test("the supervisor refuses to be built on a routable address", () => {
  assert.throws(
    () =>
      createStudioSupervisor({
        port: 5112,
        hostname: "0.0.0.0",
        permit: () => ({ allowed: true }),
        spawn: () => ({ kill: () => undefined }),
      }),
    /loopback/u,
  );
});

test("announcement parsing keeps unreadable output from counting as readiness", () => {
  assert.equal(readAnnouncedStudioUrl("nothing useful here\n"), null);
  assert.equal(readAnnouncedStudioUrl("http://127.0.0.1:5112 without the phrase"), null);
  assert.equal(
    readAnnouncedStudioUrl("Prisma Studio is up on http://127.0.0.1:5112."),
    "http://127.0.0.1:5112",
  );
  assert.equal(isLoopbackAnnouncement(null), false);
  assert.equal(isLoopbackAnnouncement("not-a-url"), false);
  assert.equal(isLoopbackAnnouncement("http://[::1]:5112"), true);
  assert.equal(isLoopbackAnnouncement("http://packscout.example.com"), false);
});
