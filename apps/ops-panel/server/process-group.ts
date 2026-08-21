import { spawn, type ChildProcess } from "node:child_process";

/**
 * Terminating a workspace script means terminating everything it started.
 *
 * `npm run <script>` is a leader, not the work. Underneath it are a shell, a
 * second Node process, and — for the operations this panel runs — Prisma
 * talking to the database. Signalling the leader alone leaves that tree alive:
 * the panel reports a run as stopped while the migration it started keeps
 * writing. So the child is spawned into its own POSIX process group and the
 * whole group is signalled by negative pid, which is the same pattern the
 * repository's local runner uses (`scripts/local/process-group.mjs`). Windows
 * has no negative-pid groups, so it falls back to signalling the child itself.
 *
 * Termination is bounded rather than hopeful. `SIGTERM` is sent first so a
 * script can close its connections, but the wait for it is raced against a
 * grace period, and `SIGKILL` follows either way — a leader's exit is not proof
 * that its descendants exited, and a descendant that ignores `SIGTERM` is
 * exactly the case this exists for. The returned promise settles only once exit
 * is observed or the escalation has been issued and given its own grace, which
 * is what lets a caller hold a lock until the tree is genuinely gone.
 */

/** How long a signalled group has to exit before it is killed outright. */
export const PROCESS_GROUP_GRACE_MS = 5_000;

/** How long the panel waits for the kill it can no longer escalate past. */
export const PROCESS_GROUP_FORCE_GRACE_MS = 1_000;

export interface ProcessGroupSignalOptions {
  readonly platform?: NodeJS.Platform;
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface ProcessGroupTerminationOptions extends ProcessGroupSignalOptions {
  readonly graceMs?: number;
  readonly forceGraceMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export function processIsRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function hasPosixGroup(child: ChildProcess, platform: NodeJS.Platform): boolean {
  return (
    platform !== "win32" &&
    Number.isSafeInteger(child.pid) &&
    (child.pid ?? 0) > 0
  );
}

/**
 * Start a child in its own process group so terminating it also reaches the
 * shell, Node and database client it starts underneath itself.
 */
export function spawnProcessGroup(
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
  spawnImplementation: typeof spawn = spawn,
): ChildProcess {
  return spawnImplementation(command, [...args], {
    ...options,
    detached: process.platform !== "win32",
    shell: false,
  });
}

export function signalProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  {
    platform = process.platform,
    killProcess = process.kill,
  }: ProcessGroupSignalOptions = {},
): boolean {
  const grouped = hasPosixGroup(child, platform);
  if (!grouped && !processIsRunning(child)) return false;
  try {
    if (grouped) killProcess(-(child.pid as number), signal);
    else child.kill(signal);
    return true;
  } catch {
    // The group may have exited between the liveness check and the signal.
    return false;
  }
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

/** True when `exited` settled first, false when the grace period ran out. */
async function raceExit(
  exited: Promise<void>,
  milliseconds: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  return Promise.race([
    exited.then(() => true),
    wait(milliseconds).then(() => false),
  ]);
}

/**
 * Signal a group, wait a bounded grace period, then force-kill the same group.
 * `exited` resolves when the leader exits; it is raced rather than trusted,
 * because the leader is not the last process in the group.
 */
export async function terminateProcessGroup(
  child: ChildProcess,
  exited: Promise<void>,
  {
    graceMs = PROCESS_GROUP_GRACE_MS,
    forceGraceMs = PROCESS_GROUP_FORCE_GRACE_MS,
    wait = defaultWait,
    platform = process.platform,
    killProcess = process.kill,
  }: ProcessGroupTerminationOptions = {},
): Promise<void> {
  const signalOptions = { platform, killProcess };
  if (!processIsRunning(child)) {
    // Leader exit is not proof that every process in its group exited, so the
    // group still gets one kill — it costs nothing when nothing is left.
    signalProcessGroup(child, "SIGKILL", signalOptions);
    return;
  }

  signalProcessGroup(child, "SIGTERM", signalOptions);
  const leaderExited = await raceExit(exited, graceMs, wait);
  signalProcessGroup(child, "SIGKILL", signalOptions);
  if (leaderExited) return;
  await raceExit(exited, forceGraceMs, wait);
}
