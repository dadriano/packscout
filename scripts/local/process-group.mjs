import { spawn } from "node:child_process";

export const PROCESS_GROUP_GRACE_MILLISECONDS = 5_000;
export const PROCESS_GROUP_FORCE_GRACE_MILLISECONDS = 1_000;

export function processIsRunning(child) {
  return (
    child !== null &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

/**
 * Start a POSIX process group so terminating npx/npm also reaches descendants.
 * Windows falls back to a normal child because negative-PID groups are POSIX-only.
 */
export function spawnLocalProcessGroup(
  command,
  args,
  options,
  spawnImplementation = spawn,
) {
  return spawnImplementation(command, args, {
    ...options,
    detached: process.platform !== "win32",
    shell: false,
  });
}

export function signalLocalProcessGroup(
  child,
  signal,
  {
    platform = process.platform,
    killProcess = process.kill,
  } = {},
) {
  if (child === null) return false;
  const hasPosixGroup =
    platform !== "win32" &&
    Number.isSafeInteger(child.pid) &&
    child.pid > 0;
  if (!hasPosixGroup && !processIsRunning(child)) return false;
  try {
    if (hasPosixGroup) {
      killProcess(-child.pid, signal);
    } else {
      child.kill(signal);
    }
    return true;
  } catch {
    // The process group may have exited after the liveness check.
    return false;
  }
}

function boundedOutcome(outcome, milliseconds, wait) {
  if (outcome === null) return Promise.resolve({ timedOut: true });
  return Promise.race([
    outcome.then((value) => ({ timedOut: false, value })),
    wait(milliseconds).then(() => ({ timedOut: true })),
  ]);
}

async function boundedGrace(milliseconds, wait) {
  await wait(milliseconds);
}

/** Signal a group, wait a bounded grace period, then force-kill the same group. */
export async function terminateLocalProcessGroup(
  child,
  outcome,
  {
    signal = "SIGTERM",
    graceMilliseconds = PROCESS_GROUP_GRACE_MILLISECONDS,
    forceGraceMilliseconds = PROCESS_GROUP_FORCE_GRACE_MILLISECONDS,
    wait = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    signalGroup = signalLocalProcessGroup,
  } = {},
) {
  const hasPosixGroup =
    process.platform !== "win32" &&
    child !== null &&
    Number.isSafeInteger(child.pid) &&
    child.pid > 0;
  if (!hasPosixGroup && !processIsRunning(child)) {
    return outcome === null ? null : await outcome;
  }
  signalGroup(child, signal);
  // Leader exit is not proof that every process in its POSIX group exited.
  await boundedGrace(graceMilliseconds, wait);
  signalGroup(child, "SIGKILL");
  const forced = await boundedOutcome(
    outcome,
    forceGraceMilliseconds,
    wait,
  );
  return forced.timedOut ? null : forced.value;
}

/**
 * Begin bounded shutdown from a synchronous AbortSignal callback. The returned
 * completion hook force-kills the group even if the npm/npx leader exits first.
 */
export function beginLocalProcessGroupTermination(
  child,
  {
    signal = "SIGTERM",
    graceMilliseconds = PROCESS_GROUP_GRACE_MILLISECONDS,
    signalGroup = signalLocalProcessGroup,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  signalGroup(child, signal);
  const timer = setTimer(() => {
    signalGroup(child, "SIGKILL");
  }, graceMilliseconds);
  timer.unref?.();
  return () => {
    clearTimer(timer);
    // Leader exit is not proof that every process in its POSIX group exited.
    signalGroup(child, "SIGKILL");
  };
}
