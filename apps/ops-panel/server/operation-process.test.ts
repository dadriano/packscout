import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOperationSpawn,
  resolveWorkspaceCommand,
} from "./operation-process.ts";

test("the panel reuses the package manager that started it", () => {
  const resolved = resolveWorkspaceCommand({
    npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  });
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.args, [
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  ]);
});

test("a panel started some other way falls back to npm on the path", () => {
  for (const env of [
    {},
    { npm_execpath: "" },
    { npm_execpath: "   " },
    { npm_execpath: "/opt/homebrew/bin/pnpm" },
  ]) {
    const resolved = resolveWorkspaceCommand(env);
    assert.equal(resolved.command, "npm");
    assert.deepEqual(resolved.args, []);
  }
});

/**
 * The whole argument list is asserted rather than sampled: this is the boundary
 * where a caller-supplied string would become a command, and the guarantee is
 * that nothing but a registry script name ever reaches it.
 */
test("a spawned operation runs `npm run <script>` and nothing else", async () => {
  const secret = "postgresql://packscout:hunter2@127.0.0.1:5432/packscout_dev";
  const spawn = createOperationSpawn({
    workspaceRoot: process.cwd(),
    readConnectionString: () => secret,
    databaseUrlVariable: "PACKSCOUT_DATABASE_URL",
    env: {
      PATH: process.env.PATH,
      npm_execpath: "",
    },
  });

  const output: string[] = [];
  const exit = await new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      const child = spawn({
        // `npm run` with no such script exits non-zero without running
        // anything; the point of the test is the argument list and the
        // environment, not the script.
        script: "packscout-ops-panel-nonexistent-script",
        onOutput: (chunk) => output.push(chunk),
        onExit: resolve,
        onError: reject,
      });
      assert.equal(typeof child.kill, "function");
    },
  );

  assert.notEqual(exit.code, 0);
  const combined = output.join("");
  assert.ok(
    !combined.includes("hunter2"),
    "the connection string must never appear in child output the panel relays raw",
  );
});

test("the connection string is read at spawn time, never captured at construction", () => {
  let current: string | undefined = "postgresql://127.0.0.1:5432/first";
  const reads: (string | undefined)[] = [];
  const spawn = createOperationSpawn({
    workspaceRoot: process.cwd(),
    readConnectionString: () => {
      reads.push(current);
      return current;
    },
    databaseUrlVariable: "PACKSCOUT_DATABASE_URL",
    env: { PATH: process.env.PATH, npm_execpath: "" },
  });
  assert.deepEqual(reads, [], "nothing is read until an operation actually runs");

  const first = spawn({
    script: "packscout-ops-panel-nonexistent-script",
    onOutput: () => undefined,
    onExit: () => undefined,
    onError: () => undefined,
  });
  first.kill();
  current = "postgresql://127.0.0.1:5432/second";
  const second = spawn({
    script: "packscout-ops-panel-nonexistent-script",
    onOutput: () => undefined,
    onExit: () => undefined,
    onError: () => undefined,
  });
  second.kill();

  assert.deepEqual(reads, [
    "postgresql://127.0.0.1:5432/first",
    "postgresql://127.0.0.1:5432/second",
  ]);
});
