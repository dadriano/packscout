import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beginLocalProcessGroupTermination,
  signalLocalProcessGroup,
  spawnLocalProcessGroup,
  terminateLocalProcessGroup,
} from "./process-group.mjs";

function runningChild(pid = 321) {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    kill() {},
  };
}

test("local children start in their own POSIX process group", () => {
  let received;
  const child = spawnLocalProcessGroup(
    "npm",
    ["run", "dev"],
    { cwd: "/tmp", env: {}, stdio: "inherit", detached: false },
    (command, args, options) => {
      received = { command, args, options };
      return runningChild();
    },
  );
  assert.equal(child.pid, 321);
  assert.equal(received.command, "npm");
  assert.equal(received.options.shell, false);
  assert.equal(received.options.detached, process.platform !== "win32");
});

test("POSIX shutdown targets the negative process-group id", () => {
  const calls = [];
  assert.equal(
    signalLocalProcessGroup(runningChild(444), "SIGTERM", {
      platform: "darwin",
      killProcess: (...args) => calls.push(args),
    }),
    true,
  );
  assert.deepEqual(calls, [[-444, "SIGTERM"]]);
});

test("POSIX escalation still targets a group after its leader exits", () => {
  const child = runningChild(445);
  child.exitCode = 0;
  const calls = [];
  assert.equal(
    signalLocalProcessGroup(child, "SIGKILL", {
      platform: "darwin",
      killProcess: (...args) => calls.push(args),
    }),
    true,
  );
  assert.deepEqual(calls, [[-445, "SIGKILL"]]);
});

test("bounded shutdown escalates a surviving group to SIGKILL", async () => {
  const signals = [];
  const child = runningChild();
  const result = await terminateLocalProcessGroup(child, new Promise(() => {}), {
    wait: async () => {},
    signalGroup: (_child, signal) => signals.push(signal),
  });
  assert.equal(result, null);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("bounded shutdown escalates descendants after the group leader resolves", async () => {
  const signals = [];
  const child = runningChild();
  await terminateLocalProcessGroup(
    child,
    Promise.resolve({ code: 0 }),
    {
      wait: async () => {
        child.exitCode = 0;
      },
      signalGroup: (_child, signal) => signals.push(signal),
    },
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("abort-time shutdown schedules and cancels force escalation", () => {
  const signals = [];
  let callback;
  let cleared = false;
  const cancel = beginLocalProcessGroupTermination(runningChild(), {
    signalGroup: (_child, signal) => signals.push(signal),
    setTimer: (handler) => {
      callback = handler;
      return { unref() {} };
    },
    clearTimer: () => {
      cleared = true;
    },
  });
  callback();
  cancel();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL", "SIGKILL"]);
  assert.equal(cleared, true);
});
