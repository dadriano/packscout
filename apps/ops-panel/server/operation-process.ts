import type { OperationSpawn } from "./core/operation-supervisor.ts";
import {
  PROCESS_GROUP_GRACE_MS,
  spawnProcessGroup,
  terminateProcessGroup,
} from "./process-group.ts";

/**
 * The Node adapter that actually runs a workspace script. It is the only module
 * in the operations surface that touches `child_process`; the supervisor above
 * it is framework-free and therefore fully testable.
 *
 * Four properties matter more than anything else here:
 *
 *  - **Nothing on the command line comes from a caller.** The argument list is
 *    `run <script>`, and the script name is read from the panel's own registry.
 *    There is no shell, so nothing in it can be interpreted as one.
 *  - **The connection string travels in the environment, never in `argv`.** An
 *    argument list is world-readable in a process table; an environment is not.
 *    It is read at spawn time, so a repointed environment is honoured rather
 *    than a value cached at startup.
 *  - **Termination reaches the whole tree.** `npm run` is a leader with a
 *    shell, a Node process and a database client beneath it, so the child owns
 *    a process group and the group is what gets signalled. `kill` resolves only
 *    once that tree is observed gone or the force-kill has been issued, which
 *    is what lets the supervisor keep its lock until then.
 *  - **Colour is suppressed at the source.** The pane strips escapes as well,
 *    but a child told plainly not to colour its output produces a cleaner
 *    record than one whose escapes are unpicked afterwards.
 */

/** How long a terminated script has to exit before it is killed outright. */
export const OPERATION_TERMINATION_GRACE_MS = PROCESS_GROUP_GRACE_MS;

export interface WorkspaceCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Resolve the package manager that is running this panel. Reusing the very npm
 * that started the process keeps the panel's operations identical to the ones a
 * developer runs at a terminal; a bare `npm` is the fallback when the panel was
 * started some other way.
 */
export function resolveWorkspaceCommand(
  env: Readonly<Record<string, string | undefined>>,
): WorkspaceCommand {
  const executable = env.npm_execpath?.trim() ?? "";
  if (/\.[cm]?js$/u.test(executable)) {
    return { command: process.execPath, args: [executable] };
  }
  return { command: "npm", args: [] };
}

export interface OperationProcessOptions {
  readonly workspaceRoot: string;
  /** Read at spawn time; only ever placed in the child's environment. */
  readonly readConnectionString: () => string | undefined;
  readonly databaseUrlVariable: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly graceMs?: number;
}

export function createOperationSpawn({
  workspaceRoot,
  readConnectionString,
  databaseUrlVariable,
  env = process.env,
  graceMs = OPERATION_TERMINATION_GRACE_MS,
}: OperationProcessOptions): OperationSpawn {
  return ({ script, onOutput, onExit, onError }) => {
    const { command, args } = resolveWorkspaceCommand(env);
    const child = spawnProcessGroup(command, [...args, "run", script], {
      cwd: workspaceRoot,
      env: {
        ...env,
        [databaseUrlVariable]: readConnectionString() ?? "",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => onOutput(chunk));
    child.stderr?.on("data", (chunk: string) => onOutput(chunk));
    child.on("error", (error) => onError(error));
    child.on("exit", (code, signal) => onExit({ code, signal }));

    // Resolved rather than rejected: a child that never started still counts as
    // gone, and the group signal below is harmless in that case.
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });

    let termination: Promise<void> | undefined;
    return {
      kill() {
        // One termination per child: a second request joins the first rather
        // than restarting the grace period.
        termination ??= terminateProcessGroup(child, exited, { graceMs });
        return termination;
      },
    };
  };
}
