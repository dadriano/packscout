import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { test } from "node:test";
import { createAdminRuntime } from "./runtime.ts";

const remoteEnvironment = {
  NODE_ENV: "development",
  PACKSCOUT_DATABASE_MODE: "remote",
  PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: "central.example.test",
  PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: "provider.example.test",
  PACKSCOUT_SESSION_HASHING_SECRET: "synthetic-session-secret-at-least-32-characters",
  PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
};
const centralUrl = "postgresql://synthetic:do-not-log-synthetic-password@central.example.test:5432/packscout";

test("admin startup applies shared central destination and TLS policy before composing providers", async () => {
  const invalidCases = [
    { environment: { ...remoteEnvironment, PACKSCOUT_DATABASE_MODE: "local" },
      databaseUrl: `${centralUrl}?sslmode=verify-full`, expected: /Local central database/u },
    { environment: remoteEnvironment,
      databaseUrl: `${centralUrl.replace("central.example.test", "unlisted.example.test")}?sslmode=verify-full`,
      expected: /Remote central database destination is not allowed/u },
    { environment: remoteEnvironment,
      databaseUrl: `${centralUrl}?sslmode=require`, expected: /TLS must verify/u },
    { environment: remoteEnvironment,
      databaseUrl: `${centralUrl}?sslmode=verify-full&sslaccept=accept_invalid_certs`, expected: /TLS must verify/u },
  ];
  for (const invalid of invalidCases) {
    await assert.rejects(createAdminRuntime({
      environment: { ...invalid.environment, PACKSCOUT_CONTROL_DATABASE_URL: invalid.databaseUrl },
      providerRuntimeFactory() { assert.fail("Rejected database settings must not compose providers."); },
    }), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, invalid.expected);
      assert.equal(error.message.includes("do-not-log-synthetic-password"), false);
      return true;
    });
  }
});

test("admin startup rejects a disallowed central port before opening any socket", { timeout: 10_000 }, async () => {
  let connections = 0;
  const server = createServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    assert.notEqual(port, 5432);
    await assert.rejects(createAdminRuntime({
      environment: {
        ...remoteEnvironment,
        PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: "127.0.0.1",
        PACKSCOUT_CONTROL_DATABASE_URL: `postgresql://synthetic:synthetic@127.0.0.1:${port}/packscout?sslmode=verify-full`,
      },
      providerRuntimeFactory() { assert.fail("A rejected destination must not compose providers."); },
    }), /Remote central database destination is not allowed/u);
    assert.equal(connections, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("admin startup skips the central destination guard when no allowlist is provisioned", async () => {
  // Regression: PR #67 made this guard unconditional, so a deployment without
  // PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS could not boot at all.
  const unconfigured: Record<string, string> = { ...remoteEnvironment };
  delete unconfigured.PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS;
  delete unconfigured.PACKSCOUT_SESSION_HASHING_SECRET;
  await assert.rejects(createAdminRuntime({
    environment: {
      ...unconfigured,
      PACKSCOUT_CONTROL_DATABASE_URL: `${centralUrl.replace("central.example.test", "unlisted.example.test")}?sslmode=verify-full`,
    },
    providerRuntimeFactory() { assert.fail("Startup must not compose providers in this case."); },
  }), (error: unknown) => {
    // It must fail on the NEXT required secret, never on the skipped destination guard.
    assert.match(String((error as Error).message), /PACKSCOUT_SESSION_HASHING_SECRET/u);
    return true;
  });
});
