import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const scriptPath = "scripts/local/run-service-with-log.mjs";

function runWrapper(argumentsList) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, ...argumentsList],
      { cwd: repositoryRoot, env: { ...process.env, NODE_ENV: "development" } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the wrapper requires a service name", async () => {
  const result = await runWrapper([]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /A service name is required/);
  assert.match(result.stderr, /frontend, admin, worker, ops-panel/);
});

test("the wrapper refuses an unknown service name", async () => {
  const result = await runWrapper(["not-a-service"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown PackScout service: not-a-service/);
});

test("the wrapper refuses a service name that is not a safe file name", async () => {
  const result = await runWrapper(["../escape"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown PackScout service/);
});

test("the wrapper never accepts a caller-supplied command", async () => {
  const source = await readFile(
    new URL("run-service-with-log.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /const SERVICE_COMMANDS = new Map\(/);
  assert.doesNotMatch(source, /shell:\s*true/);
  assert.doesNotMatch(source, /process\.argv\.slice\(2\)\.join/);
});
