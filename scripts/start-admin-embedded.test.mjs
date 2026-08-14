import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";

const repositoryRoot = new URL("..", import.meta.url);
const sessionSecret = "embedded-session-secret-at-least-32-characters";
const password = "embedded-password-123";

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function reservePorts() {
  const admin = createServer();
  const hmr = createServer();
  const ports = await Promise.all([listen(admin), listen(hmr)]);
  await Promise.all([close(admin), close(hmr)]);
  return ports;
}

function startEmbedded(adminPort, hmrPort) {
  return spawn(
    process.execPath,
    ["--import", "tsx", "scripts/local/start-admin-embedded.ts"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PACKSCOUT_ADMIN_PORT: String(adminPort),
        PACKSCOUT_ADMIN_HMR_PORT: String(hmrPort),
        PACKSCOUT_SESSION_HASHING_SECRET: sessionSecret,
        PACKSCOUT_BOOTSTRAP_ADMIN_EMAIL: "local-admin@example.com",
        PACKSCOUT_BOOTSTRAP_ADMIN_PASSWORD: password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function captureOutput(child) {
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return () => output;
}

function waitForOutput(child, readOutput, marker) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Embedded admin did not report startup."));
    }, 45_000);
    const check = () => {
      if (!readOutput().includes(marker)) return;
      clearTimeout(timeout);
      child.stdout.removeListener("data", check);
      child.stderr.removeListener("data", check);
      resolve();
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.once("exit", () => {
      clearTimeout(timeout);
      if (!readOutput().includes(marker)) {
        reject(new Error("Embedded admin exited before startup."));
      }
    });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Embedded admin did not exit after cleanup."));
    }, 45_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function assertPortReleased(port) {
  const server = createServer();
  await listen(server, port);
  await close(server);
}

test("embedded admin closes HTTP, Vite, and Prisma resources on SIGTERM", async () => {
  const [adminPort, hmrPort] = await reservePorts();
  const child = startEmbedded(adminPort, hmrPort);
  const readOutput = captureOutput(child);
  try {
    await waitForOutput(
      child,
      readOutput,
      `PackScout local admin is available at http://127.0.0.1:${adminPort}`,
    );
    const exitPromise = waitForExit(child);
    assert.equal(child.kill("SIGTERM"), true);
    assert.deepEqual(await exitPromise, { code: 0, signal: null });
    assert.doesNotMatch(readOutput(), new RegExp(`${sessionSecret}|${password}`));
    await assertPortReleased(adminPort);
    await assertPortReleased(hmrPort);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("embedded admin cleans migrated resources after a startup bind failure", async () => {
  const [adminPort, hmrPort] = await reservePorts();
  const blocker = createServer();
  await listen(blocker, adminPort);
  const child = startEmbedded(adminPort, hmrPort);
  const readOutput = captureOutput(child);
  try {
    assert.deepEqual(await waitForExit(child), { code: 1, signal: null });
    assert.match(readOutput(), /PackScout local admin startup failed\./);
    assert.doesNotMatch(readOutput(), new RegExp(`${sessionSecret}|${password}`));
    await assertPortReleased(hmrPort);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await close(blocker);
  }
  await assertPortReleased(adminPort);
});
