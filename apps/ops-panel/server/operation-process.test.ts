import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

function isAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

/**
 * `npm run <script>` is a leader, not the work. Underneath it are a shell and a
 * Node process, and for the panel's own operations, a database client. This is
 * the case that proves signalling the leader is not enough: the grandchild
 * ignores SIGTERM entirely, so only a group-wide escalation reaches it.
 */
test("terminating an operation reaches a descendant that ignores SIGTERM", async (t) => {
  if (process.platform === "win32") return;

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "packscout-ops-kill-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const pidFile = path.join(workspaceRoot, "descendant.pid");

  await writeFile(
    path.join(workspaceRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "packscout-ops-panel-termination-fixture",
        private: true,
        version: "0.0.0",
        scripts: { stubborn: "node stubborn.mjs" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(workspaceRoot, "stubborn.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      '// Deliberately unkillable by SIGTERM: this is the descendant a leader-only',
      '// signal leaves behind, still holding whatever it had open.',
      'process.on("SIGTERM", () => {});',
      'writeFileSync(new URL("descendant.pid", import.meta.url), String(process.pid));',
      "setInterval(() => {}, 1_000);",
      "",
    ].join("\n"),
  );

  const spawn = createOperationSpawn({
    workspaceRoot,
    readConnectionString: () => undefined,
    databaseUrlVariable: "PACKSCOUT_DATABASE_URL",
    env: { PATH: process.env.PATH, npm_execpath: "" },
    graceMs: 250,
  });

  let exited = false;
  const child = spawn({
    script: "stubborn",
    onOutput: () => undefined,
    onExit: () => {
      exited = true;
    },
    onError: () => undefined,
  });

  await waitUntil(
    async () => {
      const written = await readFile(pidFile, "utf8").catch(() => "");
      return written.trim().length > 0;
    },
    "the descendant to report its pid",
  );
  const descendant = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
  t.after(() => {
    if (isAlive(descendant)) process.kill(descendant, "SIGKILL");
  });
  assert.equal(isAlive(descendant), true, "the descendant is running");

  await child.kill();

  // SIGKILL is delivered synchronously but reaping is not: under load the
  // descendant can still answer signal 0 for a moment after it is doomed.
  // Waiting bounded keeps the guarantee — a descendant that actually survives
  // never stops answering, so this still fails without the process-group kill —
  // while not depending on how busy the machine is.
  await waitUntil(
    () => !isAlive(descendant),
    "a descendant that ignores SIGTERM must not survive the operation being stopped",
  );
  assert.equal(exited, true, "the leader exited too");
});

test("the connection string is read at spawn time, never captured at construction", async () => {
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
  await first.kill();
  current = "postgresql://127.0.0.1:5432/second";
  const second = spawn({
    script: "packscout-ops-panel-nonexistent-script",
    onOutput: () => undefined,
    onExit: () => undefined,
    onError: () => undefined,
  });
  await second.kill();

  assert.deepEqual(reads, [
    "postgresql://127.0.0.1:5432/first",
    "postgresql://127.0.0.1:5432/second",
  ]);
});
