import { spawn } from "node:child_process";
import { DistributedClutchpacksPublicationError } from "./distributed-clutchpacks-publication-plan.mts";

export interface LocalConvexPublicationAuthorityCommands {
  readEnvironment(): Promise<Readonly<Record<string, string>>>;
  setEnvironmentValue(name: string, value: string): Promise<void>;
  removeEnvironmentValue(name: string): Promise<void>;
}

/** Values are written through stdin, never through argv or command diagnostics. */
export function runLocalConvexPublicationCommand(input: {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly capture?: boolean;
  readonly standardInput?: string;
  readonly spawnProcess?: typeof spawn;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = (input.spawnProcess ?? spawn)(
      "npx",
      ["--no-install", "convex", ...input.args],
      {
        cwd: input.cwd,
        env: input.environment,
        stdio: [
          input.standardInput === undefined ? "ignore" : "pipe",
          input.capture === true ? "pipe" : "ignore",
          input.capture === true ? "pipe" : "ignore",
        ],
        shell: false,
      },
    );
    const commandFailure = () => reject(new Error("Local Convex command failed."));
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    // Drain captured stderr without retaining or forwarding possible secret values.
    child.stderr?.on("data", () => undefined);
    child.once("error", commandFailure);
    // `exit` can precede stdout/stderr drain; readback must use complete output.
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else commandFailure();
    });
    child.stdin?.once("error", commandFailure);
    if (input.standardInput !== undefined) child.stdin?.end(input.standardInput);
  });
}

/**
 * Installs authority only into a pristine authority namespace. Every attempted
 * authority write is owned even when its command acknowledgement is lost.
 * Persistent configuration is deliberately not included in cleanup ownership.
 */
export async function installOwnedLocalConvexPublicationAuthorities(input: {
  readonly commands: LocalConvexPublicationAuthorityCommands;
  readonly authorityEnvironmentKeys: readonly string[];
  readonly persistentEnvironmentKeys: ReadonlySet<string>;
  readonly configure: (input: {
    readonly initialEnvironment: Readonly<Record<string, string>>;
    readonly set: (name: string, value: string) => Promise<void>;
  }) => Promise<void>;
}): Promise<() => Promise<void>> {
  const initialEnvironment = await input.commands.readEnvironment();
  if (input.authorityEnvironmentKeys.some((name) => initialEnvironment[name]?.trim())) {
    throw new DistributedClutchpacksPublicationError(
      "LOCAL_CONVEX_PUBLICATION_AUTHORITY_NOT_PRISTINE",
    );
  }
  const authorityKeys = new Set(input.authorityEnvironmentKeys);
  const ownedValues = new Map<string, string>();
  const cleanup = async () => {
    if (ownedValues.size === 0) return;
    for (const [name, expectedValue] of [...ownedValues.entries()].reverse()) {
      try {
        const current = await input.commands.readEnvironment();
        // A different value is not ours to remove, even after a partial install.
        if (current[name] === expectedValue) {
          await input.commands.removeEnvironmentValue(name);
        }
      } catch {
        // Continue to every owned key. Final readback, not an acknowledgement,
        // establishes whether authority is absent after an uncertain command.
      }
    }
    let verifiedAbsent = false;
    try {
      const finalEnvironment = await input.commands.readEnvironment();
      verifiedAbsent = [...ownedValues.keys()].every(
        (name) => !Object.hasOwn(finalEnvironment, name),
      );
    } catch {
      // Unverifiable cleanup must not turn into successful publication output.
    }
    if (!verifiedAbsent) {
      throw new DistributedClutchpacksPublicationError(
        "LOCAL_CONVEX_PUBLICATION_AUTHORITY_CLEANUP_FAILED",
      );
    }
  };
  try {
    await input.configure({
      initialEnvironment,
      set: async (name, value) => {
        if (authorityKeys.has(name)) ownedValues.set(name, value);
        else if (!input.persistentEnvironmentKeys.has(name)) {
          throw new DistributedClutchpacksPublicationError(
            "LOCAL_CONVEX_PUBLICATION_ENVIRONMENT_KEY_INVALID",
          );
        }
        await input.commands.setEnvironmentValue(name, value);
      },
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return cleanup;
}

/** The publication result is not observable until owned authority is absent. */
export async function withVerifiedLocalConvexPublicationAuthorityCleanup<T>(input: {
  readonly install: () => Promise<() => Promise<void>>;
  readonly publish: () => Promise<T>;
}): Promise<T> {
  const cleanup = await input.install();
  try {
    return await input.publish();
  } finally {
    await cleanup();
  }
}
