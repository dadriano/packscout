import { spawn } from "node:child_process";
import type { OperationSpawn } from "./core/operation-supervisor.ts";

/**
 * The Node adapter that actually runs a workspace script. It is the only module
 * in the operations surface that touches `child_process`; the supervisor above
 * it is framework-free and therefore fully testable.
 *
 * Three properties matter more than anything else here:
 *
 *  - **Nothing on the command line comes from a caller.** The argument list is
 *    `run <script>`, and the script name is read from the panel's own registry.
 *    There is no shell, so nothing in it can be interpreted as one.
 *  - **The connection string travels in the environment, never in `argv`.** An
 *    argument list is world-readable in a process table; an environment is not.
 *    It is read at spawn time, so a repointed environment is honoured rather
 *    than a value cached at startup.
 *  - **Colour is suppressed at the source.** The pane strips escapes as well,
 *    but a child told plainly not to colour its output produces a cleaner
 *    record than one whose escapes are unpicked afterwards.
 */

/** How long a terminated script has to exit before it is killed outright. */
export const OPERATION_TERMINATION_GRACE_MS = 5_000;

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
    const child = spawn(command, [...args, "run", script], {
      cwd: workspaceRoot,
      env: {
        ...env,
        [databaseUrlVariable]: readConnectionString() ?? "",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => onOutput(chunk));
    child.stderr?.on("data", (chunk: string) => onOutput(chunk));
    child.on("error", (error) => onError(error));
    child.on("exit", (code, signal) => onExit({ code, signal }));

    let force: ReturnType<typeof setTimeout> | undefined;
    child.once("exit", () => {
      if (force !== undefined) clearTimeout(force);
    });

    return {
      kill() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        force ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, graceMs);
        force.unref?.();
      },
    };
  };
}
