import { spawn } from "node:child_process";
import path from "node:path";
import type { StudioSpawn } from "./core/studio-supervisor.ts";

/**
 * The Node adapter that actually runs the ORM's row browser. It is the only
 * module that touches `child_process`; the supervisor above it is framework-free
 * and therefore fully testable.
 *
 * Two properties matter more than anything else here:
 *
 *  - **The connection string travels in the environment, never in `argv`.** An
 *    argument list is world-readable in a process table; an environment is not.
 *    Nothing on the command line is a secret, and nothing on it comes from a
 *    caller: the schema path is derived from the workspace root, and the port
 *    and hostname come from the panel's own validated configuration.
 *  - **The child binds a loopback address**, passed explicitly rather than left
 *    to the tool's default, so the second listener cannot answer the network.
 */

/** How long a terminated child has to exit before it is killed outright. */
export const STUDIO_TERMINATION_GRACE_MS = 5_000;

export interface StudioProcessOptions {
  readonly workspaceRoot: string;
  readonly schemaFile: string;
  /** Resolved server-side; only ever placed in the child's environment. */
  readonly connectionString: string;
  readonly databaseUrlVariable: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly graceMs?: number;
}

export function studioExecutablePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, "node_modules", ".bin", "prisma");
}

export function createStudioSpawn({
  workspaceRoot,
  schemaFile,
  connectionString,
  databaseUrlVariable,
  env = process.env,
  graceMs = STUDIO_TERMINATION_GRACE_MS,
}: StudioProcessOptions): StudioSpawn {
  return ({ port, hostname, onOutput, onExit, onError }) => {
    const child = spawn(
      studioExecutablePath(workspaceRoot),
      [
        "studio",
        "--schema",
        schemaFile,
        "--port",
        String(port),
        "--hostname",
        hostname,
        "--browser",
        "none",
      ],
      {
        cwd: workspaceRoot,
        env: {
          ...env,
          [databaseUrlVariable]: connectionString,
          // Belt and braces: the tool opens a browser unless told twice not to.
          BROWSER: "none",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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
