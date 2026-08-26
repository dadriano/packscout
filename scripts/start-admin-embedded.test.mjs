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

const email = "local-admin@example.com";
const directEmail = "local-direct-operator@example.com";
const directPassword = "local-direct-password-123";

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
        PACKSCOUT_BOOTSTRAP_ADMIN_EMAIL: email,
        PACKSCOUT_BOOTSTRAP_ADMIN_PASSWORD: password,
        // The local flow this harness reproduces has no product backend, which
        // is the state the users page must degrade through.
        PACKSCOUT_ADMIN_DIRECTORY_URL: "",
        PACKSCOUT_ADMIN_DIRECTORY_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/** Signs in as the bootstrap administrator and returns its session headers. */
async function signIn(origin) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.notEqual(cookie, "");
  return {
    "Content-Type": "application/json",
    Origin: origin,
    Cookie: cookie,
    "X-CSRF-Token": session.csrfToken,
  };
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

/**
 * The harness shows a Users navigation item, so its product-user routes have to
 * be mounted. With no product backend configured the page must reach the
 * documented bounded "not connected" state rather than an unmounted endpoint,
 * which reads as "this user is not in the directory" and is simply untrue.
 */
test("embedded admin mounts preview integrations and exercises direct operator creation", async () => {
  const [adminPort, hmrPort] = await reservePorts();
  const child = startEmbedded(adminPort, hmrPort);
  const readOutput = captureOutput(child);
  const origin = `http://127.0.0.1:${adminPort}`;
  try {
    await waitForOutput(
      child,
      readOutput,
      `PackScout local admin is available at ${origin}`,
    );
    const headers = await signIn(origin);

    for (const [path, body] of [
      ["/api/product-users/list", { limit: 20 }],
      ["/api/product-users/detail", { subject: "https://auth.local/|local" }],
    ]) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      assert.notEqual(
        payload.code,
        "API_ROUTE_NOT_FOUND",
        `${path} is not mounted in the embedded harness`,
      );
      assert.equal(response.status, 503);
      assert.equal(payload.code, "PRODUCT_USER_DIRECTORY_UNCONFIGURED");
      // The bounded state names the missing capability, never a setting value.
      assert.doesNotMatch(JSON.stringify(payload), /Bearer|token|convex/i);
    }

    const created = await fetch(`${origin}/api/operators/direct`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: directEmail,
        displayName: "Local Direct Operator",
        password: directPassword,
        role: "data_operator",
      }),
    });
    assert.equal(created.status, 201);
    const createdPayload = await created.json();
    assert.equal(createdPayload.operator.state, "active");
    assert.deepEqual(createdPayload.notification, {
      status: "enqueued",
      deduplicated: false,
    });
    assert.doesNotMatch(
      JSON.stringify(createdPayload),
      /local-direct-password|passwordHash|"password"/i,
    );

    // The local preview mounts the real queue read model, so browser evidence
    // can prove the account-created intent exists without running a worker or
    // contacting an email provider.
    const messages = await fetch(`${origin}/api/messages/list`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "operator_account_created" }),
    });
    assert.equal(messages.status, 200);
    const messagePayload = await messages.json();
    assert.equal(messagePayload.items.length, 1);
    assert.equal(messagePayload.items[0].kind, "operator_account_created");
    assert.equal(messagePayload.items[0].recipient, directEmail);
    assert.equal(messagePayload.items[0].state, "pending");
    assert.doesNotMatch(
      JSON.stringify(messagePayload),
      /local-direct-password|passwordHash|"password"/i,
    );

    // The same embedded database and Argon2id path prove the directly created
    // account is usable immediately.
    const directLogin = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ email: directEmail, password: directPassword }),
    });
    assert.equal(directLogin.status, 200);
    const directSession = await directLogin.json();
    assert.equal(directSession.operator.email, directEmail);
    assert.equal(directSession.operator.state, "active");
    assert.equal(directSession.membership.role, "data_operator");

    const exitPromise = waitForExit(child);
    assert.equal(child.kill("SIGTERM"), true);
    assert.deepEqual(await exitPromise, { code: 0, signal: null });
    assert.doesNotMatch(
      readOutput(),
      new RegExp(`${sessionSecret}|${password}|${directPassword}`),
    );
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
